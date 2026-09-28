import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OrchestrationRunStore } from "@/lib/orchestration/contracts";
import {
  transitionOrchestrationRun,
  type OrchestrationRunRecord
} from "@/lib/orchestration/contracts";
import {
  computeOrchestrationBackoffMs,
  orchestrationClaimIdempotencyKey,
  orchestrationDeferIdempotencyKey,
  orchestrationHeartbeatIdempotencyKey,
  orchestrationReleaseIdempotencyKey,
  orchestrationRetryIdempotencyKey,
  type OrchestrationLease,
  type OrchestrationStageHandler,
  type OrchestrationStageOutcome,
  type OrchestrationWorkCandidate,
  type OrchestrationWorkerStore
} from "@/lib/orchestration/worker-contracts";
import { orchestrationTransitionIdempotencyKey } from "@/lib/persistence/postgres/orchestration-store";
import { getTelemetry, OTEL_SEMANTIC } from "@/lib/observability/telemetry";

export interface DurableOrchestrationWorkerConfig {
  workerId: string;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  batchSize?: number;
  concurrency?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxConsecutiveFailures?: number;
}

export type DurableOrchestrationWorkerResult =
  | { runId: string; outcome: "advanced"; state: string }
  | { runId: string; outcome: "deferred"; state: string }
  | { runId: string; outcome: "retry-scheduled"; state: string }
  | { runId: string; outcome: "failed"; state: "failed" }
  | { runId: string; outcome: "stale"; state: string };

function retryableUnhandled(error: unknown): OrchestrationStageOutcome {
  if (error instanceof ControlPlaneError) {
    const postgresCode = error.details?.postgresCode;
    if (
      error.code === "UNAVAILABLE"
      || error.code === "RATE_LIMITED"
      || (
        error.code === "CONFLICT"
        && (postgresCode === "40001" || postgresCode === "40P01")
      )
    ) {
      return {
        kind: "retry",
        code: error.code,
        reason: error.message
      };
    }
    return {
      kind: "failed",
      code: error.code,
      reason: error.message
    };
  }

  return {
    kind: "retry",
    code: "UNHANDLED_STAGE_ERROR",
    reason: error instanceof Error ? error.message : "Unhandled orchestration stage error"
  };
}

export class DurableOrchestrationWorker {
  private readonly leaseSeconds: number;
  private readonly heartbeatSeconds: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly maxConsecutiveFailures: number;

  constructor(
    private readonly runStore: OrchestrationRunStore,
    private readonly workerStore: OrchestrationWorkerStore,
    private readonly config: DurableOrchestrationWorkerConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!config.workerId.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Durable orchestration workerId is required");
    }

    this.leaseSeconds = config.leaseSeconds ?? 60;
    this.heartbeatSeconds = config.heartbeatSeconds ?? 20;
    this.batchSize = config.batchSize ?? 10;
    this.concurrency = config.concurrency ?? 2;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1_000;
    this.retryMaxDelayMs = config.retryMaxDelayMs ?? 120_000;
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 8;

    if (
      !Number.isInteger(this.leaseSeconds)
      || this.leaseSeconds < 2
      || !Number.isInteger(this.heartbeatSeconds)
      || this.heartbeatSeconds < 1
      || this.heartbeatSeconds >= this.leaseSeconds
      || !Number.isInteger(this.batchSize)
      || this.batchSize < 1
      || !Number.isInteger(this.concurrency)
      || this.concurrency < 1
      || this.concurrency > this.batchSize
      || !Number.isFinite(this.retryBaseDelayMs)
      || this.retryBaseDelayMs < 0
      || !Number.isFinite(this.retryMaxDelayMs)
      || this.retryMaxDelayMs < this.retryBaseDelayMs
      || !Number.isInteger(this.maxConsecutiveFailures)
      || this.maxConsecutiveFailures < 1
    ) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Durable orchestration worker timing, concurrency, retry, or failure limits are invalid"
      );
    }
  }

  async runOnce(
    handler: OrchestrationStageHandler,
    options: { shouldStop?: () => boolean } = {}
  ) {
    const at = this.now().toISOString();

    await this.workerStore.recoverExpired({
      now: at,
      limit: this.batchSize,
      retryBaseDelayMs: this.retryBaseDelayMs,
      retryMaxDelayMs: this.retryMaxDelayMs
    });

    const candidates = await this.workerStore.listReady({
      now: at,
      limit: this.batchSize
    });

    await getTelemetry().gauge("getdone.orchestration.ready.count", candidates.length, "1", {
      [OTEL_SEMANTIC.workerId]: this.config.workerId
    });

    const results = new Array<DurableOrchestrationWorkerResult | null>(
      candidates.length
    ).fill(null);
    let nextIndex = 0;

    const lane = async () => {
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
    await Promise.all(Array.from({ length: lanes }, () => lane()));

    return results.filter(
      (value): value is DurableOrchestrationWorkerResult => value !== null
    );
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

  private async failRun(
    run: OrchestrationRunRecord,
    lease: OrchestrationLease,
    input: { code: string; reason: string }
  ) {
    const next = transitionOrchestrationRun(run, {
      to: "failed",
      now: this.now().toISOString(),
      failure: {
        code: input.code,
        message: input.reason,
        retryable: false,
        failedAt: this.now().toISOString()
      }
    });

    try {
      await this.retrySerializableConflict(() => this.runStore.compareAndSwap(next, {
        expectedVersion: run.version,
        expectedRecordHash: run.recordHash,
        idempotencyKey: orchestrationTransitionIdempotencyKey(run, next.state)
      }));
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === "CONFLICT") {
        await this.safeRelease(lease);
        return {
          runId: run.id,
          outcome: "stale" as const,
          state: run.state
        };
      }
      throw error;
    }

    await this.safeRelease(lease);
    await getTelemetry().counter("getdone.orchestration.failed.total", 1, {
      [OTEL_SEMANTIC.workerId]: this.config.workerId,
      [OTEL_SEMANTIC.companyId]: run.scope.companyId
    });

    return {
      runId: run.id,
      outcome: "failed" as const,
      state: "failed" as const
    };
  }

  private async safeRelease(lease: OrchestrationLease) {
    try {
      await this.retrySerializableConflict(() => this.workerStore.release({
        lease,
        now: this.now().toISOString(),
        idempotencyKey: orchestrationReleaseIdempotencyKey(lease)
      }));
    } catch (error) {
      if (!(error instanceof ControlPlaneError && error.code === "CONFLICT")) throw error;
    }
  }

  private async runCandidate(
    candidate: OrchestrationWorkCandidate,
    handler: OrchestrationStageHandler
  ): Promise<DurableOrchestrationWorkerResult | null> {
    let lease: OrchestrationLease | null;
    try {
      lease = await getTelemetry().withSpan("orchestration.claim", {
        [OTEL_SEMANTIC.workerId]: this.config.workerId,
        [OTEL_SEMANTIC.companyId]: candidate.run.scope.companyId,
        [OTEL_SEMANTIC.environment]: candidate.run.scope.environment,
        [OTEL_SEMANTIC.correlationId]: candidate.run.correlationId
      }, () => this.retrySerializableConflict(() => this.workerStore.claimAtomic({
        runId: candidate.run.id,
        workerId: this.config.workerId,
        now: this.now().toISOString(),
        leaseSeconds: this.leaseSeconds,
        expectedRunVersion: candidate.run.version,
        expectedRecordHash: candidate.run.recordHash,
        idempotencyKey: orchestrationClaimIdempotencyKey({
          runId: candidate.run.id,
          runVersion: candidate.run.version,
          workerId: this.config.workerId
        })
      })));
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === "CONFLICT") return null;
      throw error;
    }

    if (!lease) return null;

    if (lease.consecutiveFailures >= this.maxConsecutiveFailures) {
      return this.failRun(candidate.run, lease, {
        code: "ORCHESTRATION_MAX_RETRIES",
        reason: "Maximum stage retries were already exhausted before this claim"
      });
    }

    let activeLease = lease;
    let heartbeatBusy = false;
    let leaseLost = false;
    let stopped = false;

    const heartbeat = async () => {
      if (stopped || heartbeatBusy || leaseLost) return;
      heartbeatBusy = true;
      try {
        activeLease = await this.retrySerializableConflict(() =>
          this.workerStore.heartbeat({
            lease: activeLease,
            now: this.now().toISOString(),
            extendSeconds: this.leaseSeconds,
            idempotencyKey: orchestrationHeartbeatIdempotencyKey(activeLease)
          })
        );
      } catch {
        leaseLost = true;
      } finally {
        heartbeatBusy = false;
      }
    };

    const timer = setInterval(() => {
      void heartbeat();
    }, this.heartbeatSeconds * 1_000);
    timer.unref?.();

    let outcome: OrchestrationStageOutcome;
    try {
      outcome = await getTelemetry().withSpan("orchestration.stage", {
        [OTEL_SEMANTIC.workerId]: this.config.workerId,
        [OTEL_SEMANTIC.companyId]: candidate.run.scope.companyId,
        [OTEL_SEMANTIC.environment]: candidate.run.scope.environment,
        [OTEL_SEMANTIC.correlationId]: candidate.run.correlationId,
        "getdone.orchestration.state": candidate.run.state,
        "getdone.orchestration.attempt": activeLease.attempt
      }, () => handler.execute({
        run: candidate.run,
        get lease() { return activeLease; },
        heartbeat
      }));
    } catch (error) {
      outcome = retryableUnhandled(error);
    } finally {
      stopped = true;
      clearInterval(timer);
      while (heartbeatBusy) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }

    if (leaseLost) {
      await getTelemetry().counter("getdone.orchestration.lease_lost.total", 1, {
        [OTEL_SEMANTIC.workerId]: this.config.workerId,
        [OTEL_SEMANTIC.companyId]: candidate.run.scope.companyId
      });
      return {
        runId: candidate.run.id,
        outcome: "stale",
        state: candidate.run.state
      };
    }

    if (outcome.kind === "advance") {
      if (
        outcome.next.id !== candidate.run.id
        || outcome.next.version !== candidate.run.version + 1
      ) {
        return this.failRun(candidate.run, activeLease, {
          code: "INVALID_STAGE_ADVANCE",
          reason: "Stage handler returned a run that did not advance exactly one version"
        });
      }

      try {
        await this.retrySerializableConflict(() => this.runStore.compareAndSwap(
          outcome.next,
          {
            expectedVersion: candidate.run.version,
            expectedRecordHash: candidate.run.recordHash,
            idempotencyKey: orchestrationTransitionIdempotencyKey(
              candidate.run,
              outcome.next.state
            )
          }
        ));
      } catch (error) {
        if (error instanceof ControlPlaneError && error.code === "CONFLICT") {
          await this.safeRelease(activeLease);
          return {
            runId: candidate.run.id,
            outcome: "stale",
            state: candidate.run.state
          };
        }
        throw error;
      }

      await this.safeRelease(activeLease);
      await getTelemetry().counter("getdone.orchestration.stage.advanced.total", 1, {
        [OTEL_SEMANTIC.workerId]: this.config.workerId,
        [OTEL_SEMANTIC.companyId]: candidate.run.scope.companyId
      });
      return {
        runId: candidate.run.id,
        outcome: "advanced",
        state: outcome.next.state
      };
    }

    if (outcome.kind === "defer") {
      const delayMs = Math.max(0, Math.min(outcome.delayMs, this.retryMaxDelayMs));
      try {
        await this.retrySerializableConflict(() => this.workerStore.defer({
          lease: activeLease,
          now: this.now().toISOString(),
          readyAt: new Date(this.now().getTime() + delayMs).toISOString(),
          reason: outcome.reason,
          idempotencyKey: orchestrationDeferIdempotencyKey(activeLease)
        }));
      } catch (error) {
        if (error instanceof ControlPlaneError && error.code === "CONFLICT") {
          return {
            runId: candidate.run.id,
            outcome: "stale",
            state: candidate.run.state
          };
        }
        throw error;
      }
      return {
        runId: candidate.run.id,
        outcome: "deferred",
        state: candidate.run.state
      };
    }

    if (outcome.kind === "failed") {
      return this.failRun(candidate.run, activeLease, {
        code: outcome.code,
        reason: outcome.reason
      });
    }

    const nextFailureCount = activeLease.consecutiveFailures + 1;
    if (nextFailureCount >= this.maxConsecutiveFailures) {
      return this.failRun(candidate.run, activeLease, {
        code: "ORCHESTRATION_MAX_RETRIES",
        reason: `Maximum stage retries reached after: ${outcome.reason}`
      });
    }

    const computedDelay = computeOrchestrationBackoffMs({
      runId: candidate.run.id,
      attempt: nextFailureCount,
      baseDelayMs: this.retryBaseDelayMs,
      maxDelayMs: this.retryMaxDelayMs
    });
    const delayMs = outcome.retryAfterMs === undefined
      ? computedDelay
      : Math.max(0, Math.min(outcome.retryAfterMs, this.retryMaxDelayMs));

    try {
      await this.retrySerializableConflict(() => this.workerStore.scheduleRetry({
        lease: activeLease,
        now: this.now().toISOString(),
        readyAt: new Date(this.now().getTime() + delayMs).toISOString(),
        code: outcome.code,
        reason: outcome.reason,
        idempotencyKey: orchestrationRetryIdempotencyKey(activeLease)
      }));
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === "CONFLICT") {
        return {
          runId: candidate.run.id,
          outcome: "stale",
          state: candidate.run.state
        };
      }
      throw error;
    }

    await getTelemetry().counter("getdone.orchestration.retry.total", 1, {
      [OTEL_SEMANTIC.workerId]: this.config.workerId,
      [OTEL_SEMANTIC.companyId]: candidate.run.scope.companyId,
      "getdone.orchestration.failure_count": nextFailureCount
    });

    return {
      runId: candidate.run.id,
      outcome: "retry-scheduled",
      state: candidate.run.state
    };
  }
}
