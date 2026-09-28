import { describe, expect, it } from "vitest";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  createDurableJobLease,
  createJobQueueEnvelope,
  createJobStoreTransactionReceipt,
  type DeadLetterRecord,
  type DurableJobLease,
  type JobQueueEnvelope,
  type JobRecoveryRecord,
  type JobRetryScheduleRecord,
  type JobStoreTransactionReceipt
} from "@/lib/execution/job-runtime-contracts";
import {
  DurableJobWorker,
  type DurableJobExecutionHandler
} from "@/lib/execution/job-worker-runtime";
import type {
  DurableJobCandidate,
  DurableJobRuntimeSnapshot,
  DurableJobWorkStore
} from "@/lib/persistence/postgres/job-store";

const envelope = createJobQueueEnvelope({
  id: "queue-1",
  jobId: "job-1",
  taskId: "task-1",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "staging"
  },
  authorizationConsumptionHash: "authorization-consumption-hash",
  idempotencyKey: "queue-job-1",
  scheduledAt: "2026-09-21T04:00:00Z",
  createdAt: "2026-09-21T04:00:00Z"
});

class FakeWorkStore implements DurableJobWorkStore {
  readonly descriptor = {
    persistence: "durable-external" as const,
    atomicClaims: true,
    compareAndSwap: true,
    restartSafe: true,
    multiProcessSafe: true,
    productionEligible: true
  };

  version = 1;
  hash = "runtime-v1";
  attempt = 0;
  state: DurableJobRuntimeSnapshot["state"] = "queued";
  lease: DurableJobLease | null = null;
  retries: JobRetryScheduleRecord[] = [];
  deadLetters: DeadLetterRecord[] = [];
  cancellations: string[] = [];
  heartbeats = 0;
  recoveries: JobRecoveryRecord[] = [];

  private receipt(
    operation: JobStoreTransactionReceipt["operation"],
    idempotencyKey: string,
    now = "2026-09-21T04:00:01Z"
  ) {
    const receipt = createJobStoreTransactionReceipt({
      id: `tx-${operation}-${this.version}`,
      operation,
      jobId: envelope.jobId,
      idempotencyKey,
      expectedVersion: this.version,
      expectedHash: this.hash,
      nextVersion: this.version + 1,
      nextHash: `runtime-v${this.version + 1}:${operation}`,
      occurredAt: now
    });
    this.version = receipt.nextVersion;
    this.hash = receipt.nextHash;
    return receipt;
  }

  async listReady(): Promise<readonly DurableJobCandidate[]> {
    if (!["queued", "retry-wait"].includes(this.state)) return [];
    return [{
      envelope,
      version: this.version,
      stateHash: this.hash,
      attempt: this.attempt
    }];
  }

  async getRuntimeSnapshot(): Promise<DurableJobRuntimeSnapshot | null> {
    return {
      envelope,
      version: this.version,
      stateHash: this.hash,
      attempt: this.attempt,
      state: this.state,
      scheduledAt: envelope.scheduledAt
    };
  }

  async enqueue(input: JobQueueEnvelope) {
    const tx = this.receipt("enqueue", input.idempotencyKey, input.createdAt);
    return { status: "enqueued" as const, transaction: tx };
  }

  async claimAtomic(input: {
    jobId: string;
    workerId: string;
    now: string;
    leaseSeconds: number;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
  }) {
    if (
      input.expectedJobVersion !== this.version
      || input.expectedJobHash !== this.hash
      || !["queued", "retry-wait"].includes(this.state)
    ) return null;
    this.attempt += 1;
    this.state = "claimed";
    this.lease = createDurableJobLease({
      id: `lease-${this.attempt}`,
      jobId: input.jobId,
      workerId: input.workerId,
      attempt: this.attempt,
      leaseIssuedAt: input.now,
      leaseSeconds: input.leaseSeconds
    });
    return {
      lease: this.lease,
      transaction: this.receipt("claim", input.idempotencyKey, input.now)
    };
  }

  async heartbeat(input: {
    lease: DurableJobLease;
    now: string;
    extendSeconds: number;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
  }) {
    this.heartbeats += 1;
    const renewed = {
      ...input.lease,
      heartbeatAt: input.now,
      expiresAt: new Date(Date.parse(input.now) + input.extendSeconds * 1000).toISOString(),
      version: input.lease.version + 1
    };
    const { sha256Hex } = await import("@/lib/control-plane/canonical-hash");
    const base = { ...renewed } as Partial<DurableJobLease>;
    delete base.leaseHash;
    this.lease = {
      ...(base as Omit<DurableJobLease, "leaseHash">),
      leaseHash: sha256Hex(base)
    };
    return {
      lease: this.lease,
      transaction: this.receipt("heartbeat", input.idempotencyKey, input.now)
    };
  }

  async release(input: {
    lease: DurableJobLease;
    now: string;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
    outcomeKind: "provider-completed" | "verified";
  }) {
    this.state = "released";
    return this.receipt("release", input.idempotencyKey, input.now);
  }

  async scheduleRetry(record: JobRetryScheduleRecord) {
    this.retries.push(record);
    this.state = "retry-wait";
    return this.receipt("retry", record.id, record.runAt);
  }

  async deadLetter(record: DeadLetterRecord) {
    this.deadLetters.push(record);
    this.state = "dead-lettered";
    return this.receipt("dead-letter", record.id, record.failedAt);
  }

  async cancel(input: {
    jobId: string;
    reason: string;
    cancelledAt: string;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
  }) {
    this.cancellations.push(input.reason);
    this.state = "cancelled";
    return this.receipt("cancel", input.idempotencyKey, input.cancelledAt);
  }

  async recoverExpired() {
    return this.recoveries;
  }
}

function worker(store: FakeWorkStore, maxAttempts = 5) {
  return new DurableJobWorker(
    store,
    {
      workerId: "worker-a",
      leaseSeconds: 60,
      heartbeatSeconds: 20,
      batchSize: 5,
      retryBaseDelayMs: 100,
      maxAttempts
    },
    () => new Date("2026-09-21T04:00:10Z")
  );
}

describe("DurableJobWorker", () => {
  it("claims and releases a provider-completed Job without declaring it verified", async () => {
    const store = new FakeWorkStore();
    const results = await worker(store).runOnce({
      execute: async () => ({ kind: "provider-completed" })
    });
    expect(results).toEqual([{ jobId: "job-1", outcome: { kind: "provider-completed" } }]);
    expect(store.state).toBe("released");
    expect(store.attempt).toBe(1);
  });

  it("releases a lease for an explicitly verified outcome", async () => {
    const store = new FakeWorkStore();
    const results = await worker(store).runOnce({
      execute: async () => ({ kind: "verified" })
    });
    expect(results).toEqual([{ jobId: "job-1", outcome: { kind: "verified" } }]);
    expect(store.state).toBe("released");
  });

  it("retries PostgreSQL serialization conflicts with the same durable transition", async () => {
    class SerializationConflictStore extends FakeWorkStore {
      releaseAttempts = 0;

      override async release(input: Parameters<FakeWorkStore["release"]>[0]) {
        this.releaseAttempts += 1;
        if (this.releaseAttempts === 1) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Concurrent PostgreSQL transaction conflicted; retry with the same idempotency key",
            { details: { postgresCode: "40001" } }
          );
        }
        return super.release(input);
      }
    }

    const store = new SerializationConflictStore();
    const results = await worker(store).runOnce({
      execute: async () => ({ kind: "provider-completed" })
    });

    expect(store.releaseAttempts).toBe(2);
    expect(store.state).toBe("released");
    expect(results).toEqual([{ jobId: "job-1", outcome: { kind: "provider-completed" } }]);
  });

  it("renews the lease when execution asks for a heartbeat", async () => {
    const store = new FakeWorkStore();
    const handler: DurableJobExecutionHandler = {
      execute: async (context) => {
        await context.heartbeat();
        expect(context.runtimeVersion()).toBeGreaterThan(2);
        return { kind: "provider-completed" };
      }
    };
    await worker(store).runOnce(handler);
    expect(store.heartbeats).toBe(1);
  });

  it("schedules retry with exponential retry lineage", async () => {
    const store = new FakeWorkStore();
    const results = await worker(store).runOnce({
      execute: async () => ({ kind: "retry", reason: "provider timeout" })
    });
    expect(results[0].outcome.kind).toBe("retry");
    expect(store.retries).toHaveLength(1);
    expect(store.retries[0].nextAttempt).toBe(2);
    expect(store.state).toBe("retry-wait");
  });

  it("dead-letters retryable work after max attempts", async () => {
    const store = new FakeWorkStore();
    store.attempt = 1;
    const results = await worker(store, 2).runOnce({
      execute: async () => ({ kind: "retry", reason: "still failing" })
    });
    expect(results[0].outcome.kind).toBe("dead-letter");
    expect(store.deadLetters).toHaveLength(1);
    expect(store.deadLetters[0].finalAttempt).toBe(2);
    expect(store.state).toBe("dead-lettered");
  });

  it("does not release over an owner cancellation that races execution", async () => {
    const store = new FakeWorkStore();
    const results = await worker(store).runOnce({
      execute: async (context) => {
        await store.cancel({
          jobId: context.envelope.jobId,
          reason: "owner cancelled during execution",
          cancelledAt: "2026-09-21T04:00:10Z",
          expectedJobVersion: context.runtimeVersion(),
          expectedJobHash: context.runtimeHash(),
          idempotencyKey: "cancel-race"
        });
        return { kind: "provider-completed" };
      }
    });
    expect(results).toEqual([{
      jobId: "job-1",
      outcome: {
        kind: "cancelled",
        reason: "Job was cancelled during execution"
      }
    }]);
    expect(store.state).toBe("cancelled");
  });

  it("persists cancellation through the durable store", async () => {
    const store = new FakeWorkStore();
    await worker(store).runOnce({
      execute: async () => ({ kind: "cancelled", reason: "owner cancelled" })
    });
    expect(store.cancellations).toEqual(["owner cancelled"]);
    expect(store.state).toBe("cancelled");
  });

  it("stops claiming additional candidates after drain is requested", async () => {
    const store = new FakeWorkStore();
    const first = (await store.listReady())[0]!;
    store.listReady = async () => [first, first];

    let draining = false;
    const results = await worker(store).runOnce({
      execute: async () => {
        draining = true;
        return { kind: "provider-completed" };
      }
    }, {
      shouldStop: () => draining
    });

    expect(results).toHaveLength(1);
    expect(store.attempt).toBe(1);
    expect(store.state).toBe("released");
  });

  it("delegates expired-lease recovery and validates worker configuration", async () => {
    const store = new FakeWorkStore();
    expect(await worker(store).recoverExpired()).toEqual([]);
    expect(() => new DurableJobWorker(store, {
      workerId: "worker",
      leaseSeconds: 10,
      heartbeatSeconds: 10
    })).toThrow(/heartbeat interval/i);
    expect(() => new DurableJobWorker(store, {
      workerId: "worker",
      leaseSeconds: 10,
      heartbeatSeconds: 2,
      batchSize: 2,
      concurrency: 3
    })).toThrow(/concurrency/i);
  });
});
