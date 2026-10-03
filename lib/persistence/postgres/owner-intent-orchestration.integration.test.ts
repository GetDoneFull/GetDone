import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import {
  advanceOwnerIntentAcceptedToContextReady,
  createOwnerIntentOrchestrationRun
} from "@/lib/orchestration/owner-intent-flow";
import { PostgresOwnerIntentStore } from "@/lib/persistence/postgres/control-api-stores";
import { PostgresOrchestrationRunStore } from "@/lib/persistence/postgres/orchestration-store";
import { PostgresOrchestrationContextSnapshotStore } from "@/lib/persistence/postgres/orchestration-context-snapshot-store";
import {
  PostgresDatabase,
  readPostgresConfigFromEnv
} from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;

integrationDescribe("PostgreSQL OwnerIntent -> orchestration admission", () => {
  let database: PostgresDatabase | undefined;
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `owner-intent-user-${suffix}`;
  const portfolioId = `owner-intent-portfolio-${suffix}`;
  const companyId = `owner-intent-company-${suffix}`;

  function db() {
    if (!database) throw new Error("PostgreSQL OwnerIntent test database is not initialized");
    return database;
  }

  function scope(company = companyId) {
    return {
      userId,
      portfolioId,
      companyId: company,
      environment: "staging" as const
    };
  }

  function inScope<T>(
    operation: () => T,
    company = companyId
  ) {
    return runWithPostgresTenantScope(scope(company), operation);
  }

  function intent(name: string, company = companyId): OwnerIntentRecord {
    return {
      id: `intent-${name}-${suffix}`,
      correlationId: `correlation-${name}-${suffix}`,
      portfolioId,
      companyId: company,
      environment: "staging",
      userId,
      message: `owner request ${name}`,
      channel: "chat",
      status: "accepted",
      receivedAt: "2026-09-28T11:30:00.000Z"
    };
  }

  beforeAll(async () => {
    database = new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    await db().query(
      `INSERT INTO auth_users(id,status)
       VALUES($1,'active')
       ON CONFLICT (id) DO NOTHING`,
      [userId]
    );
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  it("commits OwnerIntent, accepted run, v1 checkpoint, worker state, audit, and idempotency together", async () => {
    const record = intent("atomic");
    const store = new PostgresOwnerIntentStore(db());

    const persisted = await inScope(() =>
      store.create(record, "same-client-key")
    );
    expect(persisted).toEqual(record);

    const orchestration = createOwnerIntentOrchestrationRun(record);
    const state = await inScope(async () => {
      const [intentRows, runRows, checkpointRows, workerRows, auditRows] = await Promise.all([
        db().query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM owner_intents WHERE id=$1",
          [record.id]
        ),
        db().query<{ payload: unknown }>(
          "SELECT payload FROM orchestration_runs WHERE id=$1",
          [orchestration.id]
        ),
        db().query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM orchestration_checkpoints WHERE run_id=$1",
          [orchestration.id]
        ),
        db().query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM orchestration_worker_state WHERE run_id=$1",
          [orchestration.id]
        ),
        db().query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM audit_events WHERE correlation_id=$1",
          [record.correlationId]
        )
      ]);
      return {
        intentCount: Number(intentRows.rows[0]?.count),
        run: runRows.rows[0]?.payload,
        checkpointCount: Number(checkpointRows.rows[0]?.count),
        workerCount: Number(workerRows.rows[0]?.count),
        auditCount: Number(auditRows.rows[0]?.count)
      };
    });

    expect(state.intentCount).toBe(1);
    expect(state.run).toMatchObject({
      id: orchestration.id,
      state: "accepted",
      correlationId: record.correlationId
    });
    expect(state.checkpointCount).toBe(1);
    expect(state.workerCount).toBe(1);
    expect(state.auditCount).toBeGreaterThanOrEqual(1);

    const replay = await inScope(() =>
      store.create(
        { ...record, id: `different-request-id-${suffix}` },
        "same-client-key"
      )
    );
    expect(replay.id).toBe(record.id);
  });

  it("scopes API idempotency by tenant so the same client key can be used in another company", async () => {
    const otherCompany = `owner-intent-company-b-${suffix}`;
    const first = intent("tenant-a");
    const second = intent("tenant-b", otherCompany);
    const store = new PostgresOwnerIntentStore(db());

    await inScope(() => store.create(first, "shared-key"), first.companyId);
    await inScope(() => store.create(second, "shared-key"), second.companyId);

    const firstRun = createOwnerIntentOrchestrationRun(first);
    const secondRun = createOwnerIntentOrchestrationRun(second);

    expect(await inScope(
      () => new PostgresOrchestrationRunStore(db()).get(firstRun.id),
      first.companyId
    )).not.toBeNull();
    expect(await inScope(
      () => new PostgresOrchestrationRunStore(db()).get(secondRun.id),
      second.companyId
    )).not.toBeNull();
  });

  it("rolls back OwnerIntent acceptance when orchestration admission conflicts", async () => {
    const blocker = intent("blocker");
    const conflicting = {
      ...intent("conflicting"),
      correlationId: blocker.correlationId
    };

    await inScope(() =>
      new PostgresOrchestrationRunStore(db()).create(
        createOwnerIntentOrchestrationRun(blocker),
        `orchestration:start:owner-intent:${blocker.id}`
      )
    );

    await expect(inScope(() =>
      new PostgresOwnerIntentStore(db()).create(
        conflicting,
        "conflicting-owner-intent-key"
      )
    )).rejects.toThrow(/Orchestration start conflicts/i);

    const rolledBack = await inScope(() => db().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM owner_intents WHERE id=$1",
      [conflicting.id]
    ));
    expect(Number(rolledBack.rows[0]?.count)).toBe(0);
  });

  it("freezes ContextSnapshot then advances accepted -> context-ready with exact snapshot hash", async () => {
    const record = intent("context-ready");
    const ownerIntents = new PostgresOwnerIntentStore(db());
    await inScope(() =>
      ownerIntents.create(record, "context-ready-client-key")
    );

    const runStore = new PostgresOrchestrationRunStore(db());
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const run = await inScope(() =>
      runStore.getByCorrelationId(record.correlationId!)
    );
    expect(run?.state).toBe("accepted");
    if (!run) throw new Error("accepted run expected");

    const outcome = await inScope(() =>
      advanceOwnerIntentAcceptedToContextReady({
        run,
        ownerIntents,
        candidates: {
          listForIntent: async () => [{
            id: `fact-context-${suffix}`,
            kind: "fact",
            portfolioId,
            companyId,
            source: "integration-test",
            provenance: "verified:test",
            observedAt: "2026-09-28T11:29:59.000Z",
            freshnessSeconds: 300,
            sensitivity: "internal",
            content: "One bounded verified fact."
          }]
        },
        policy: {
          resolve: async () => ({
            scope: {
              portfolioId,
              companyId,
              allowedSensitivity: ["public", "internal"]
            },
            options: {
              now: Date.parse("2026-09-28T11:30:01.000Z")
            }
          })
        },
        snapshots,
        now: () => new Date("2026-09-28T11:30:01.000Z")
      })
    );

    expect(outcome.kind).toBe("advance");
    if (outcome.kind !== "advance") throw new Error("advance expected");

    const persisted = await inScope(() =>
      runStore.compareAndSwap(outcome.next, {
        expectedVersion: run.version,
        expectedRecordHash: run.recordHash,
        idempotencyKey:
          `orchestration:${run.id}:v${run.version}:accepted->context-ready`
      })
    );

    expect(persisted.state).toBe("context-ready");

    const snapshot = await inScope(() =>
      snapshots.getByRunVersion(run.id, run.version)
    );
    expect(snapshot).not.toBeNull();
    expect(persisted.checkpoints.contextSnapshot).toEqual({
      id: snapshot?.id,
      hash: snapshot?.snapshotHash
    });
  });

  it("reuses a frozen snapshot after crash before accepted -> context-ready CAS", async () => {
    const record = intent("snapshot-replay");
    const ownerIntents = new PostgresOwnerIntentStore(db());
    await inScope(() =>
      ownerIntents.create(record, "snapshot-replay-client-key")
    );

    const runStore = new PostgresOrchestrationRunStore(db());
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const run = await inScope(() =>
      runStore.getByCorrelationId(record.correlationId!)
    );
    if (!run) throw new Error("accepted run expected");

    let candidateReads = 0;
    const execute = () => inScope(() =>
      advanceOwnerIntentAcceptedToContextReady({
        run,
        ownerIntents,
        candidates: {
          listForIntent: async () => {
            candidateReads += 1;
            return [];
          }
        },
        policy: {
          resolve: async () => ({
            scope: {
              portfolioId,
              companyId,
              allowedSensitivity: ["public", "internal"]
            }
          })
        },
        snapshots,
        now: () => new Date(
          candidateReads === 0
            ? "2026-09-28T11:30:01.000Z"
            : "2026-09-28T11:35:00.000Z"
        )
      })
    );

    const beforeCrash = await execute();
    expect(beforeCrash.kind).toBe("advance");
    expect(candidateReads).toBe(1);

    const afterRestart = await execute();
    expect(afterRestart.kind).toBe("advance");
    expect(candidateReads).toBe(1);

    if (beforeCrash.kind !== "advance" || afterRestart.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(afterRestart.next.checkpoints.contextSnapshot)
      .toEqual(beforeCrash.next.checkpoints.contextSnapshot);
  });
});
