import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  createDeadLetterRecord,
  createJobRetryScheduleRecord,
  type DurableJobLease,
  type JobQueueEnvelope,
  type JobStoreTransactionReceipt
} from "@/lib/execution/job-runtime-contracts";
import type {
  DurableJobCandidate,
  DurableJobWorkStore
} from "@/lib/persistence/postgres/job-store";
import { getTelemetry, OTEL_SEMANTIC } from "@/lib/observability/telemetry";

export type JobExecutionOutcome =
  | { kind: "provider-completed" }
  | { kind: "verified" }
  | { kind: "retry"; reason: string; delayMs?: number }
  | { kind: "dead-letter"; reason: string }
  | { kind: "cancelled"; reason: string };

export interface DurableJobExecutionContext {
  envelope: JobQueueEnvelope;
  lease: DurableJobLease;
  heartbeat(): Promise<void>;
  runtimeVersion(): number;
  runtimeHash(): string;
}

export interface DurableJobExecutionHandler {
  execute(context: DurableJobExecutionContext): Promise<JobExecutionOutcome>;
}

export interface DurableJobWorkerConfig {
  workerId: string;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  batchSize?: number;
  concurrency?: number;
  retryBaseDelayMs?: number;
  maxAttempts?: number;
}

export class DurableJobWorker {
  private readonly leaseSeconds: number;
  private readonly heartbeatSeconds: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly store: DurableJobWorkStore,
    private readonly config: DurableJobWorkerConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!config.workerId.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Durable Job workerId is required");
    }
    this.leaseSeconds = config.leaseSeconds ?? 60;
    this.heartbeatSeconds = config.heartbeatSeconds ?? 20;
    this.batchSize = config.batchSize ?? 10;
    this.concurrency = config.concurrency ?? 1;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1_000;
    this.maxAttempts = config.maxAttempts ?? 5;
    if (
      !Number.isInteger(this.leaseSeconds)
      || this.leaseSeconds < 2
      || !Number.isInteger(this.heartbeatSeconds)
      || this.heartbeatSeconds < 1
      || !Number.isInteger(this.batchSize)
      || this.batchSize < 1
      || !Number.isInteger(this.concurrency)
      || this.concurrency < 1
      || this.concurrency > this.batchSize
      || !Number.isInteger(this.maxAttempts)
      || this.maxAttempts < 1
      || !Number.isFinite(this.retryBaseDelayMs)
      || this.retryBaseDelayMs < 0
    ) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Durable Job worker timing, batch size, concurrency, and retry limits are invalid"
      );
    }
    if (this.heartbeatSeconds >= this.leaseSeconds) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Heartbeat interval must be shorter than the Job lease"
      );
    }
  }

  async runOnce(
    handler: DurableJobExecutionHandler,
    options: { shouldStop?: () => boolean } = {}
  ) {
    const at = this.now().toISOString();
    const candidates = await this.store.listReady({ now: at, limit: this.batchSize });
    await getTelemetry().gauge("getdone.job.ready.count", candidates.length, "1", {
      [OTEL_SEMANTIC.workerId]: this.config.workerId
    });
    const results = new Array<{ jobId: string; outcome: JobExecutionOutcome } | null>(
      candidates.length
    ).fill(null);
    let nextIndex = 0;

    const runLane = async () => {
      while (true) {
        if (options.shouldStop?.()) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= candidates.length) return;
        const result = await this.runCandidate(candidates[index], handler);
        if (result) results[index] = result;
      }
    };

    const lanes = Math.min(this.concurrency, candidates.length);
    await Promise.all(Array.from({ length: lanes }, () => runLane()));
    return results.filter(
      (result): result is { jobId: string; outcome: JobExecutionOutcome } => result !== null
    );
  }

  async recoverExpired(limit = this.batchSize) {
    return this.store.recoverExpired({
      now: this.now().toISOString(),
      limit
    });
  }

  async cancel(jobId: string, reason: string) {
    const snapshot = await this.store.getRuntimeSnapshot(jobId);
    if (!snapshot) throw new ControlPlaneError("NOT_FOUND", "Durable Job runtime state was not found");
    return this.retrySerializableConflict(() => this.store.cancel({
      jobId,
      reason,
      cancelledAt: this.now().toISOString(),
      expectedJobVersion: snapshot.version,
      expectedJobHash: snapshot.stateHash,
      idempotencyKey: `cancel:${jobId}:${snapshot.version}`
    }));
  }

  private async retrySerializableConflict<T>(
    operation: () => Promise<T>,
    maxAttempts = 4
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        attempt += 1;
        const postgresCode = error instanceof ControlPlaneError
          ? error.details?.postgresCode
          : undefined;
        const retryable = error instanceof ControlPlaneError
          && error.code === "CONFLICT"
          && (postgresCode === "40001" || postgresCode === "40P01");
        if (!retryable || attempt >= maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 5));
      }
    }
  }

  private async runCandidate(
    candidate: DurableJobCandidate,
    handler: DurableJobExecutionHandler
  ) {
    let claim;
    try {
      claim = await getTelemetry().withSpan("job.claim", {
        [OTEL_SEMANTIC.jobId]: candidate.envelope.jobId,
        [OTEL_SEMANTIC.workerId]: this.config.workerId,
        [OTEL_SEMANTIC.companyId]: candidate.envelope.scope.companyId,
        [OTEL_SEMANTIC.environment]: candidate.envelope.scope.environment,
        [OTEL_SEMANTIC.correlationId]: candidate.envelope.correlationId ?? null
      }, () => this.retrySerializableConflict(() => this.store.claimAtomic({
        jobId: candidate.envelope.jobId,
        workerId: this.config.workerId,
        now: this.now().toISOString(),
        leaseSeconds: this.leaseSeconds,
        expectedJobVersion: candidate.version,
        expectedJobHash: candidate.stateHash,
        idempotencyKey: `claim:${candidate.envelope.jobId}:${candidate.version}:${this.config.workerId}`
      })));
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === "CONFLICT") {
        return null;
      }
      throw error;
    }
    if (!claim) return null;
    await getTelemetry().log("INFO", "job.claimed", {
      [OTEL_SEMANTIC.jobId]: candidate.envelope.jobId,
      [OTEL_SEMANTIC.workerId]: this.config.workerId,
      [OTEL_SEMANTIC.jobAttempt]: claim.lease.attempt
    });

    let lease = claim.lease;
    let version = claim.transaction.nextVersion;
    let stateHash = claim.transaction.nextHash;
    let latestTransaction: JobStoreTransactionReceipt = claim.transaction;
    let heartbeatBusy = false;
    let stopped = false;

    const heartbeat = async () => {
      if (stopped || heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        const renewed = await this.retrySerializableConflict(() => this.store.heartbeat({
          lease,
          now: this.now().toISOString(),
          extendSeconds: this.leaseSeconds,
          expectedJobVersion: version,
          expectedJobHash: stateHash,
          idempotencyKey: `heartbeat:${lease.id}:${lease.version}`
        }));
        lease = renewed.lease;
        version = renewed.transaction.nextVersion;
        stateHash = renewed.transaction.nextHash;
        latestTransaction = renewed.transaction;
        await getTelemetry().gauge(
          "getdone.worker.heartbeat.age",
          Math.max(0, this.now().getTime() - Date.parse(lease.heartbeatAt)),
          "ms",
          { [OTEL_SEMANTIC.workerId]: this.config.workerId }
        );
      } finally {
        heartbeatBusy = false;
      }
    };

    const timer = setInterval(() => {
      void heartbeat().catch(() => {
        stopped = true;
      });
    }, this.heartbeatSeconds * 1_000);
    timer.unref?.();

    let outcome: JobExecutionOutcome;
    try {
      outcome = await getTelemetry().withSpan("job.execute", {
        [OTEL_SEMANTIC.jobId]: candidate.envelope.jobId,
        [OTEL_SEMANTIC.workerId]: this.config.workerId,
        [OTEL_SEMANTIC.jobAttempt]: lease.attempt,
        [OTEL_SEMANTIC.companyId]: candidate.envelope.scope.companyId,
        [OTEL_SEMANTIC.environment]: candidate.envelope.scope.environment,
        [OTEL_SEMANTIC.correlationId]: candidate.envelope.correlationId ?? null
      }, () => handler.execute({
        envelope: candidate.envelope,
        get lease() { return lease; },
        heartbeat,
        runtimeVersion: () => version,
        runtimeHash: () => stateHash
      }));
    } catch (error) {
      outcome = {
        kind: "retry",
        reason: error instanceof Error ? error.message : "Unhandled worker execution failure"
      };
    } finally {
      stopped = true;
      clearInterval(timer);
      while (heartbeatBusy) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }

    const postExecution = await this.store.getRuntimeSnapshot(candidate.envelope.jobId);
    if (postExecution?.state === "cancelled") {
      const cancelledOutcome: JobExecutionOutcome = {
        kind: "cancelled",
        reason: postExecution.cancelledReason ?? "Job was cancelled during execution"
      };
      return {
        jobId: candidate.envelope.jobId,
        outcome: cancelledOutcome
      };
    }

    await getTelemetry().counter("getdone.job.execution.total", 1, {
      outcome: outcome.kind,
      [OTEL_SEMANTIC.jobAttempt]: lease.attempt,
      [OTEL_SEMANTIC.workerId]: this.config.workerId
    });
    await getTelemetry().log(
      outcome.kind === "dead-letter" ? "ERROR" : outcome.kind === "retry" ? "WARN" : "INFO",
      "job.execution.outcome",
      {
        [OTEL_SEMANTIC.jobId]: candidate.envelope.jobId,
        [OTEL_SEMANTIC.workerId]: this.config.workerId,
        [OTEL_SEMANTIC.jobAttempt]: lease.attempt,
        outcome: outcome.kind,
        [OTEL_SEMANTIC.correlationId]: candidate.envelope.correlationId ?? null
      }
    );

    if (outcome.kind === "provider-completed" || outcome.kind === "verified") {
      const receipt = await this.retrySerializableConflict(() => this.store.release({
        lease,
        now: this.now().toISOString(),
        expectedJobVersion: version,
        expectedJobHash: stateHash,
        idempotencyKey: `release:${lease.id}:${lease.version}`,
        outcomeKind: outcome.kind
      }));
      latestTransaction = receipt;
    } else if (outcome.kind === "cancelled") {
      const cancellationReason = outcome.reason;
      const receipt = await this.retrySerializableConflict(() => this.store.cancel({
        jobId: candidate.envelope.jobId,
        reason: cancellationReason,
        cancelledAt: this.now().toISOString(),
        expectedJobVersion: version,
        expectedJobHash: stateHash,
        idempotencyKey: `cancel:${candidate.envelope.jobId}:${version}`
      }));
      latestTransaction = receipt;
    } else if (outcome.kind === "dead-letter") {
      const record = createDeadLetterRecord({
        id: crypto.randomUUID(),
        jobId: candidate.envelope.jobId,
        finalAttempt: lease.attempt,
        reason: outcome.reason,
        failedAt: this.now().toISOString(),
        sourceEnvelopeHash: candidate.envelope.envelopeHash,
        transactionHash: latestTransaction.transactionHash
      });
      latestTransaction = await this.retrySerializableConflict(() => this.store.deadLetter(record));
      await getTelemetry().counter("getdone.job.dead_letter.total", 1, {
        [OTEL_SEMANTIC.workerId]: this.config.workerId
      });
    } else if (lease.attempt >= this.maxAttempts) {
      const record = createDeadLetterRecord({
        id: crypto.randomUUID(),
        jobId: candidate.envelope.jobId,
        finalAttempt: lease.attempt,
        reason: `maximum attempts reached: ${outcome.reason}`,
        failedAt: this.now().toISOString(),
        sourceEnvelopeHash: candidate.envelope.envelopeHash,
        transactionHash: latestTransaction.transactionHash
      });
      latestTransaction = await this.retrySerializableConflict(() => this.store.deadLetter(record));
      await getTelemetry().counter("getdone.job.dead_letter.total", 1, {
        [OTEL_SEMANTIC.workerId]: this.config.workerId
      });
      outcome = { kind: "dead-letter", reason: record.reason };
    } else {
      const delay = outcome.delayMs ?? this.retryBaseDelayMs * 2 ** Math.max(0, lease.attempt - 1);
      const record = createJobRetryScheduleRecord({
        id: crypto.randomUUID(),
        jobId: candidate.envelope.jobId,
        nextAttempt: lease.attempt + 1,
        runAt: new Date(this.now().getTime() + delay).toISOString(),
        reason: outcome.reason,
        sourceEnvelopeHash: candidate.envelope.envelopeHash,
        transactionHash: latestTransaction.transactionHash
      });
      latestTransaction = await this.retrySerializableConflict(() => this.store.scheduleRetry(record));
      await getTelemetry().counter("getdone.job.retry.total", 1, {
        [OTEL_SEMANTIC.workerId]: this.config.workerId,
        [OTEL_SEMANTIC.jobAttempt]: lease.attempt
      });
    }

    return { jobId: candidate.envelope.jobId, outcome };
  }
}
