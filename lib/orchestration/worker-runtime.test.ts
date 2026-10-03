import { describe, expect, it } from "vitest";
import {
  createOrchestrationRun,
  createOrchestrationSourceRef,
  transitionOrchestrationRun,
  type OrchestrationRunRecord,
  type OrchestrationRunStore
} from "@/lib/orchestration/contracts";
import {
  createOrchestrationLease,
  type OrchestrationLease,
  type OrchestrationRecoveryRecord,
  type OrchestrationWorkCandidate,
  type OrchestrationWorkerStore
} from "@/lib/orchestration/worker-contracts";
import { DurableOrchestrationWorker } from "@/lib/orchestration/worker-runtime";

const scope = {
  userId: "owner",
  portfolioId: "portfolio",
  companyId: "company",
  environment: "staging" as const
};

function acceptedRun(name = "one") {
  const source = { id: `intent-${name}`, message: "do work" };
  return createOrchestrationRun({
    id: `run-${name}`,
    correlationId: `correlation-${name}`,
    source: createOrchestrationSourceRef("owner-intent", source.id, source),
    scope,
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z"
  });
}

class MemoryRunStore implements OrchestrationRunStore {
  readonly descriptor = {
    persistence: "ephemeral-reference" as const,
    compareAndSwap: true,
    uniqueCorrelationId: true,
    restartSafe: false,
    multiProcessSafe: false,
    productionEligible: false
  };
  constructor(public current: OrchestrationRunRecord) {}
  async create(record: OrchestrationRunRecord) {
    this.current = record;
    return { status: "created" as const, record };
  }
  async get(id: string) { return this.current.id === id ? this.current : null; }
  async getByCorrelationId(id: string) {
    return this.current.correlationId === id ? this.current : null;
  }
  async compareAndSwap(
    next: OrchestrationRunRecord,
    input: { expectedVersion: number; expectedRecordHash: string }
  ) {
    if (
      this.current.version !== input.expectedVersion
      || this.current.recordHash !== input.expectedRecordHash
    ) {
      throw new Error("stale");
    }
    this.current = next;
    return next;
  }
  async listResumable() { return [this.current]; }
}

class MemoryWorkerStore implements OrchestrationWorkerStore {
  released = 0;
  deferred = 0;
  retried = 0;
  recovered = 0;
  heartbeats = 0;

  constructor(
    private readonly candidate: OrchestrationWorkCandidate,
    private readonly failureCount = 0
  ) {}

  async listReady() { return [this.candidate]; }

  async claimAtomic(input: {
    runId: string;
    workerId: string;
    now: string;
    leaseSeconds: number;
    expectedRunVersion: number;
    expectedRecordHash: string;
  }) {
    return createOrchestrationLease({
      id: `lease-${input.runId}`,
      runId: input.runId,
      workerId: input.workerId,
      claimedRunVersion: input.expectedRunVersion,
      claimedRecordHash: input.expectedRecordHash,
      attempt: this.candidate.stageAttempt + 1,
      consecutiveFailures: this.failureCount,
      issuedAt: input.now,
      leaseSeconds: input.leaseSeconds
    });
  }

  async heartbeat(input: { lease: OrchestrationLease }) {
    this.heartbeats += 1;
    return input.lease;
  }

  async release() { this.released += 1; }
  async defer() { this.deferred += 1; }
  async scheduleRetry() { this.retried += 1; }

  async recoverExpired(): Promise<readonly OrchestrationRecoveryRecord[]> {
    this.recovered += 1;
    return [];
  }
}

function candidate(run: OrchestrationRunRecord): OrchestrationWorkCandidate {
  return {
    run,
    stageRunVersion: run.version,
    stageAttempt: 0,
    consecutiveFailures: 0,
    readyAt: run.updatedAt
  };
}

describe("DurableOrchestrationWorker", () => {
  it("executes exactly one stage and persists one checkpoint transition", async () => {
    const run = acceptedRun("advance");
    const runStore = new MemoryRunStore(run);
    const workerStore = new MemoryWorkerStore(candidate(run));
    const worker = new DurableOrchestrationWorker(
      runStore,
      workerStore,
      { workerId: "worker-1", concurrency: 1, batchSize: 1 },
      () => new Date("2026-09-28T10:00:01.000Z")
    );

    const results = await worker.runOnce({
      execute: async ({ run: current }) => ({
        kind: "advance",
        next: transitionOrchestrationRun(current, {
          to: "context-ready",
          now: "2026-09-28T10:00:01.000Z",
          checkpointPatch: {
            contextSnapshot: { id: "context-1", hash: "a".repeat(64) }
          }
        })
      })
    });

    expect(results).toEqual([{
      runId: run.id,
      outcome: "advanced",
      state: "context-ready"
    }]);
    expect(runStore.current.state).toBe("context-ready");
    expect(runStore.current.version).toBe(2);
    expect(workerStore.released).toBe(1);
    expect(workerStore.retried).toBe(0);
  });

  it("defers observational waiting without counting it as a failure", async () => {
    const run = acceptedRun("defer");
    const workerStore = new MemoryWorkerStore(candidate(run));
    const worker = new DurableOrchestrationWorker(
      new MemoryRunStore(run),
      workerStore,
      { workerId: "worker-1", concurrency: 1, batchSize: 1 },
      () => new Date("2026-09-28T10:00:01.000Z")
    );

    const results = await worker.runOnce({
      execute: async () => ({
        kind: "defer",
        reason: "waiting for existing Job Engine outcome",
        delayMs: 30_000
      })
    });

    expect(results[0]?.outcome).toBe("deferred");
    expect(workerStore.deferred).toBe(1);
    expect(workerStore.retried).toBe(0);
  });

  it("schedules retry for transient stage failure", async () => {
    const run = acceptedRun("retry");
    const workerStore = new MemoryWorkerStore(candidate(run));
    const worker = new DurableOrchestrationWorker(
      new MemoryRunStore(run),
      workerStore,
      {
        workerId: "worker-1",
        concurrency: 1,
        batchSize: 1,
        retryBaseDelayMs: 1_000,
        retryMaxDelayMs: 10_000
      },
      () => new Date("2026-09-28T10:00:01.000Z")
    );

    const results = await worker.runOnce({
      execute: async () => ({
        kind: "retry",
        code: "UNAVAILABLE",
        reason: "planner temporarily unavailable"
      })
    });

    expect(results[0]?.outcome).toBe("retry-scheduled");
    expect(workerStore.retried).toBe(1);
  });

  it("fails the orchestration after the configured consecutive failure ceiling", async () => {
    const run = acceptedRun("max-retry");
    const workerStore = new MemoryWorkerStore(candidate(run), 2);
    const runStore = new MemoryRunStore(run);
    const worker = new DurableOrchestrationWorker(
      runStore,
      workerStore,
      {
        workerId: "worker-1",
        concurrency: 1,
        batchSize: 1,
        maxConsecutiveFailures: 3
      },
      () => new Date("2026-09-28T10:00:01.000Z")
    );

    const results = await worker.runOnce({
      execute: async () => ({
        kind: "retry",
        code: "UNAVAILABLE",
        reason: "still unavailable"
      })
    });

    expect(results[0]?.outcome).toBe("failed");
    expect(runStore.current.state).toBe("failed");
    expect(runStore.current.failure?.code).toBe("ORCHESTRATION_MAX_RETRIES");
    expect(workerStore.released).toBe(1);
  });

  it("turns non-retryable control-plane errors into terminal orchestration failure", async () => {
    const run = acceptedRun("terminal-error");
    const runStore = new MemoryRunStore(run);
    const workerStore = new MemoryWorkerStore(candidate(run));
    const worker = new DurableOrchestrationWorker(
      runStore,
      workerStore,
      { workerId: "worker-1", concurrency: 1, batchSize: 1 },
      () => new Date("2026-09-28T10:00:01.000Z")
    );

    const { ControlPlaneError } = await import("@/lib/control-plane/errors");
    const results = await worker.runOnce({
      execute: async () => {
        throw new ControlPlaneError("FORBIDDEN", "authority mismatch");
      }
    });

    expect(results[0]?.outcome).toBe("failed");
    expect(runStore.current.failure?.code).toBe("FORBIDDEN");
  });

  it("runs crash recovery before discovering ready work", async () => {
    const run = acceptedRun("recovery");
    const workerStore = new MemoryWorkerStore(candidate(run));
    const worker = new DurableOrchestrationWorker(
      new MemoryRunStore(run),
      workerStore,
      { workerId: "worker-1", concurrency: 1, batchSize: 1 },
      () => new Date("2026-09-28T10:00:01.000Z")
    );

    await worker.runOnce({
      execute: async () => ({
        kind: "defer",
        reason: "wait",
        delayMs: 1_000
      })
    });

    expect(workerStore.recovered).toBe(1);
  });
});
