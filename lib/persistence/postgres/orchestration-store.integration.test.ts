import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrchestrationRun,
  createOrchestrationSourceRef,
  transitionOrchestrationRun
} from "@/lib/orchestration/contracts";
import {
  PostgresOrchestrationRunStore,
  orchestrationTransitionIdempotencyKey
} from "@/lib/persistence/postgres/orchestration-store";
import {
  PostgresDatabase,
  readPostgresConfigFromEnv
} from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;

integrationDescribe("PostgreSQL UFO orchestration persistence", () => {
  let database: PostgresDatabase | undefined;
  let store: PostgresOrchestrationRunStore;
  const suffix = `${process.pid}-${Date.now()}`;

  const scope = {
    userId: `user-${suffix}`,
    portfolioId: `portfolio-${suffix}`,
    companyId: `company-${suffix}`,
    environment: "staging" as const
  };

  function db() {
    if (!database) throw new Error("PostgreSQL orchestration test database is not initialized");
    return database;
  }

  function acceptedRun(name: string) {
    const sourceRecord = {
      id: `intent-${name}-${suffix}`,
      message: `intent ${name}`,
      companyId: scope.companyId
    };
    return createOrchestrationRun({
      id: `orchestration-${name}-${suffix}`,
      correlationId: `correlation-${name}-${suffix}`,
      source: createOrchestrationSourceRef(
        "owner-intent",
        sourceRecord.id,
        sourceRecord
      ),
      scope,
      createdAt: "2026-09-28T10:00:00.000Z",
      updatedAt: "2026-09-28T10:00:00.000Z"
    });
  }

  function inScope<T>(operation: () => T) {
    return runWithPostgresTenantScope(scope, operation);
  }

  beforeAll(() => {
    database = new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    store = new PostgresOrchestrationRunStore(db());
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  it("creates one run per tenant idempotency key and replays the exact same start", async () => {
    const run = acceptedRun("create");
    const key = `orchestration:start:${run.source.type}:${run.source.id}`;

    const created = await inScope(() => store.create(run, key));
    expect(created).toMatchObject({ status: "created" });

    const replay = await inScope(() => store.create(run, key));
    expect(replay).toMatchObject({ status: "idempotent-replay" });
    expect(replay.record.recordHash).toBe(run.recordHash);

    const conflicting = acceptedRun("create-conflict");
    await expect(
      inScope(() => store.create(conflicting, key))
    ).rejects.toThrow(/idempotency|conflicts/i);
  });

  it("persists CAS transition, immutable receipt, and checkpoint atomically", async () => {
    const run = acceptedRun("cas");
    const startKey = `orchestration:start:${run.source.type}:${run.source.id}`;
    await inScope(() => store.create(run, startKey));

    const next = transitionOrchestrationRun(run, {
      to: "context-ready",
      now: "2026-09-28T10:00:01.000Z",
      checkpointPatch: {
        contextSnapshot: {
          id: `context-${suffix}`,
          hash: "a".repeat(64)
        }
      }
    });
    const transitionKey = orchestrationTransitionIdempotencyKey(run, next.state);

    const persisted = await inScope(() => store.compareAndSwap(next, {
      expectedVersion: run.version,
      expectedRecordHash: run.recordHash,
      idempotencyKey: transitionKey
    }));
    expect(persisted).toMatchObject({
      id: run.id,
      state: "context-ready",
      version: 2
    });

    const [receipts, checkpoints] = await inScope(async () => Promise.all([
      db().query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM orchestration_transition_receipts WHERE run_id=$1",
        [run.id]
      ),
      db().query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM orchestration_checkpoints WHERE run_id=$1",
        [run.id]
      )
    ]));

    expect(Number(receipts.rows[0]?.count)).toBe(1);
    expect(Number(checkpoints.rows[0]?.count)).toBe(2);
  });

  it("turns a worker retry after persistence into an idempotent replay", async () => {
    const run = acceptedRun("restart");
    await inScope(() =>
      store.create(
        run,
        `orchestration:start:${run.source.type}:${run.source.id}`
      )
    );

    const next = transitionOrchestrationRun(run, {
      to: "context-ready",
      now: "2026-09-28T10:01:01.000Z",
      checkpointPatch: {
        contextSnapshot: {
          id: `context-restart-${suffix}`,
          hash: "b".repeat(64)
        }
      }
    });
    const transitionKey = orchestrationTransitionIdempotencyKey(run, next.state);

    const first = await inScope(() => store.compareAndSwap(next, {
      expectedVersion: run.version,
      expectedRecordHash: run.recordHash,
      idempotencyKey: transitionKey
    }));

    const retriedAfterRestart = await inScope(() => store.compareAndSwap(next, {
      expectedVersion: run.version,
      expectedRecordHash: run.recordHash,
      idempotencyKey: transitionKey
    }));

    expect(retriedAfterRestart.recordHash).toBe(first.recordHash);
    expect(retriedAfterRestart.version).toBe(2);

    const receiptCount = await inScope(() => db().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM orchestration_transition_receipts WHERE run_id=$1",
      [run.id]
    ));
    expect(Number(receiptCount.rows[0]?.count)).toBe(1);
  });

  it("rejects stale workers with an old version/hash", async () => {
    const run = acceptedRun("stale");
    await inScope(() =>
      store.create(
        run,
        `orchestration:start:${run.source.type}:${run.source.id}`
      )
    );

    const contextReady = transitionOrchestrationRun(run, {
      to: "context-ready",
      now: "2026-09-28T10:02:01.000Z",
      checkpointPatch: {
        contextSnapshot: {
          id: `context-stale-${suffix}`,
          hash: "c".repeat(64)
        }
      }
    });

    await inScope(() => store.compareAndSwap(contextReady, {
      expectedVersion: run.version,
      expectedRecordHash: run.recordHash,
      idempotencyKey: orchestrationTransitionIdempotencyKey(run, contextReady.state)
    }));

    const conflictingNext = transitionOrchestrationRun(run, {
      to: "context-ready",
      now: "2026-09-28T10:02:02.000Z",
      checkpointPatch: {
        contextSnapshot: {
          id: `different-context-${suffix}`,
          hash: "d".repeat(64)
        }
      }
    });

    await expect(
      inScope(() => store.compareAndSwap(conflictingNext, {
        expectedVersion: run.version,
        expectedRecordHash: run.recordHash,
        idempotencyKey: "orchestration:stale-worker:different"
      }))
    ).rejects.toThrow(/changed before compare-and-swap/);
  });

  it("keeps recovery scans tenant-scoped and excludes owner-waiting runs", async () => {
    const resumable = acceptedRun("resumable");
    await inScope(() =>
      store.create(
        resumable,
        `orchestration:start:${resumable.source.type}:${resumable.source.id}`
      )
    );

    const waitingBase = acceptedRun("waiting");
    await inScope(() =>
      store.create(
        waitingBase,
        `orchestration:start:${waitingBase.source.type}:${waitingBase.source.id}`
      )
    );

    let waiting = transitionOrchestrationRun(waitingBase, {
      to: "context-ready",
      now: "2026-09-28T10:03:01.000Z",
      checkpointPatch: {
        contextSnapshot: { id: `ctx-waiting-${suffix}`, hash: "e".repeat(64) }
      }
    });
    await inScope(() => store.compareAndSwap(waiting, {
      expectedVersion: waitingBase.version,
      expectedRecordHash: waitingBase.recordHash,
      idempotencyKey: orchestrationTransitionIdempotencyKey(waitingBase, waiting.state)
    }));

    let current = waiting;
    const transitions = [
      {
        to: "planning" as const,
        patch: {
          plannerInput: {
            id: `planner-input-waiting-${suffix}`,
            hash: "e".repeat(64)
          }
        }
      },
      {
        to: "planned" as const,
        patch: { plan: { id: `plan-waiting-${suffix}`, hash: "f".repeat(64) } }
      },
      {
        to: "validated" as const,
        patch: {
          validationReceipt: {
            id: `validation-waiting-${suffix}`,
            hash: "1".repeat(64)
          }
        }
      },
      {
        to: "policy-evaluated" as const,
        patch: {
          policySnapshot: {
            id: `policy-waiting-${suffix}`,
            hash: "2".repeat(64)
          }
        }
      },
      {
        to: "awaiting-decision" as const,
        patch: { decisionIds: [`decision-waiting-${suffix}`] }
      }
    ];

    let second = 2;
    for (const item of transitions) {
      const next = transitionOrchestrationRun(current, {
        to: item.to,
        now: `2026-09-28T10:03:0${second}.000Z`,
        checkpointPatch: item.patch
      });
      await inScope(() => store.compareAndSwap(next, {
        expectedVersion: current.version,
        expectedRecordHash: current.recordHash,
        idempotencyKey: orchestrationTransitionIdempotencyKey(current, next.state)
      }));
      current = next;
      second += 1;
    }

    const candidates = await inScope(() => store.listResumable({ limit: 100 }));
    expect(candidates.some((candidate) => candidate.id === resumable.id)).toBe(true);
    expect(candidates.some((candidate) => candidate.id === waitingBase.id)).toBe(false);

    const otherScope = {
      portfolioId: scope.portfolioId,
      companyId: `other-company-${suffix}`
    };
    const hidden = await runWithPostgresTenantScope(otherScope, () =>
      store.get(resumable.id)
    );
    expect(hidden).toBeNull();
  });
});
