import { describe, expect, it } from "vitest";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import {
  advanceOwnerIntentAcceptedToContextReady,
  createOwnerIntentOrchestrationRun,
  ownerIntentContextSnapshotIdempotencyKey,
  ownerIntentOrchestrationId,
  ownerIntentOrchestrationStartIdempotencyKey,
  type OrchestrationContextSnapshot,
  type OrchestrationContextSnapshotStore
} from "@/lib/orchestration/owner-intent-flow";

const intent: OwnerIntentRecord = {
  id: "intent-1",
  correlationId: "correlation-1",
  portfolioId: "portfolio-1",
  companyId: "company-1",
  environment: "staging",
  userId: "owner-1",
  message: "Work on growth",
  channel: "chat",
  status: "accepted",
  receivedAt: "2026-09-28T11:00:00.000Z"
};

class MemorySnapshotStore implements OrchestrationContextSnapshotStore {
  snapshot: OrchestrationContextSnapshot | null = null;
  creates = 0;

  async create(snapshot: OrchestrationContextSnapshot) {
    this.creates += 1;
    if (this.snapshot) {
      return { status: "idempotent-replay" as const, snapshot: this.snapshot };
    }
    this.snapshot = snapshot;
    return { status: "created" as const, snapshot };
  }

  async get(id: string) {
    return this.snapshot?.id === id ? this.snapshot : null;
  }

  async getByRunVersion(runId: string, runVersion: number) {
    if (
      this.snapshot?.runId === runId
      && this.snapshot.runVersion === runVersion
    ) {
      return this.snapshot;
    }
    return null;
  }
}

describe("OwnerIntent durable orchestration flow", () => {
  it("derives stable orchestration identity and start idempotency from persisted OwnerIntent", () => {
    const run = createOwnerIntentOrchestrationRun(intent);

    expect(run.id).toBe(ownerIntentOrchestrationId(intent.id));
    expect(run.correlationId).toBe(intent.correlationId);
    expect(run.source).toMatchObject({
      type: "owner-intent",
      id: intent.id
    });
    expect(run.scope).toEqual({
      userId: intent.userId,
      portfolioId: intent.portfolioId,
      companyId: intent.companyId,
      environment: intent.environment
    });
    expect(ownerIntentOrchestrationStartIdempotencyKey(intent.id))
      .toBe("orchestration:start:owner-intent:intent-1");
  });

  it("freezes context and returns exactly accepted -> context-ready", async () => {
    const run = createOwnerIntentOrchestrationRun(intent);
    const snapshots = new MemorySnapshotStore();
    let candidateReads = 0;

    const outcome = await advanceOwnerIntentAcceptedToContextReady({
      run,
      ownerIntents: {
        get: async (id) => id === intent.id ? intent : null
      },
      candidates: {
        listForIntent: async () => {
          candidateReads += 1;
          return [{
            id: "fact-1",
            kind: "fact",
            portfolioId: intent.portfolioId,
            companyId: intent.companyId,
            source: "test",
            provenance: "verified:test",
            observedAt: "2026-09-28T10:59:30.000Z",
            freshnessSeconds: 300,
            sensitivity: "internal",
            content: "Recent trial conversion is 11%."
          }];
        }
      },
      policy: {
        resolve: async () => ({
          scope: {
            portfolioId: intent.portfolioId,
            companyId: intent.companyId,
            allowedSensitivity: ["public", "internal"]
          },
          options: { now: Date.parse("2026-09-28T11:00:01.000Z") }
        })
      },
      snapshots,
      now: () => new Date("2026-09-28T11:00:01.000Z")
    });

    expect(outcome.kind).toBe("advance");
    if (outcome.kind !== "advance") throw new Error("advance expected");
    expect(outcome.next.state).toBe("context-ready");
    expect(outcome.next.version).toBe(run.version + 1);
    expect(outcome.next.checkpoints.contextSnapshot).toMatchObject({
      id: snapshots.snapshot?.id,
      hash: snapshots.snapshot?.snapshotHash
    });
    expect(candidateReads).toBe(1);
    expect(snapshots.creates).toBe(1);
    expect(ownerIntentContextSnapshotIdempotencyKey(run.id, run.version))
      .toContain(":context-snapshot");
  });

  it("reuses an already frozen snapshot after crash before orchestration CAS", async () => {
    const run = createOwnerIntentOrchestrationRun(intent);
    const snapshots = new MemorySnapshotStore();
    let candidateReads = 0;

    const deps = {
      ownerIntents: { get: async () => intent },
      candidates: {
        listForIntent: async () => {
          candidateReads += 1;
          return [];
        }
      },
      policy: {
        resolve: async () => ({
          scope: {
            portfolioId: intent.portfolioId,
            companyId: intent.companyId,
            allowedSensitivity: ["public", "internal"] as const
          }
        })
      },
      snapshots,
      now: () => new Date("2026-09-28T11:00:01.000Z")
    };

    const first = await advanceOwnerIntentAcceptedToContextReady({ run, ...deps });
    expect(first.kind).toBe("advance");
    expect(candidateReads).toBe(1);
    expect(snapshots.creates).toBe(1);

    const replay = await advanceOwnerIntentAcceptedToContextReady({
      run,
      ...deps,
      now: () => new Date("2026-09-28T11:05:00.000Z")
    });

    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.checkpoints.contextSnapshot)
      .toEqual(first.next.checkpoints.contextSnapshot);
    expect(candidateReads).toBe(1);
    expect(snapshots.creates).toBe(1);
  });

  it("rejects tenant-scope broadening during context assembly", async () => {
    const run = createOwnerIntentOrchestrationRun(intent);

    await expect(advanceOwnerIntentAcceptedToContextReady({
      run,
      ownerIntents: { get: async () => intent },
      candidates: { listForIntent: async () => [] },
      policy: {
        resolve: async () => ({
          scope: {
            portfolioId: intent.portfolioId,
            companyId: "different-company",
            allowedSensitivity: ["public"]
          }
        })
      },
      snapshots: new MemorySnapshotStore(),
      now: () => new Date("2026-09-28T11:00:01.000Z")
    })).rejects.toThrow(/tenant scope/i);
  });

  it("rejects missing or tampered OwnerIntent lineage", async () => {
    const run = createOwnerIntentOrchestrationRun(intent);

    await expect(advanceOwnerIntentAcceptedToContextReady({
      run,
      ownerIntents: { get: async () => null },
      candidates: { listForIntent: async () => [] },
      policy: {
        resolve: async () => ({
          scope: {
            portfolioId: intent.portfolioId,
            companyId: intent.companyId,
            allowedSensitivity: ["public"]
          }
        })
      },
      snapshots: new MemorySnapshotStore()
    })).rejects.toThrow(/missing OwnerIntent/i);

    await expect(advanceOwnerIntentAcceptedToContextReady({
      run,
      ownerIntents: {
        get: async () => ({ ...intent, message: "tampered" })
      },
      candidates: { listForIntent: async () => [] },
      policy: {
        resolve: async () => ({
          scope: {
            portfolioId: intent.portfolioId,
            companyId: intent.companyId,
            allowedSensitivity: ["public"]
          }
        })
      },
      snapshots: new MemorySnapshotStore()
    })).rejects.toThrow(/lineage/i);
  });
});
