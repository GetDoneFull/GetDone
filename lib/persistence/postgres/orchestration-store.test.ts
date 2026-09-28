import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  createOrchestrationRun,
  createOrchestrationSourceRef,
  transitionOrchestrationRun,
  type OrchestrationRunRecord
} from "@/lib/orchestration/contracts";
import {
  createOrchestrationTransitionReceipt,
  orchestrationTransitionIdempotencyKey,
  PostgresOrchestrationRunStore,
  POSTGRES_ORCHESTRATION_STORE_DESCRIPTOR
} from "@/lib/persistence/postgres/orchestration-store";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface ResponseSpec {
  rows?: QueryResultRow[];
  rowCount?: number;
  error?: Error & { code?: string };
}

class ScriptedDb implements PostgresTransactionalDatabase {
  readonly calls: string[] = [];

  constructor(readonly responses: ResponseSpec[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string
  ): Promise<QueryResult<R>> {
    this.calls.push(text.replace(/\s+/g, " ").trim());
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
    if (response.error) throw response.error;
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    return operation(this as unknown as PoolClient);
  }
}

const scope = {
  userId: "owner-1",
  portfolioId: "portfolio-1",
  companyId: "company-1",
  environment: "staging" as const
};

function acceptedRun(name = "one") {
  const sourceRecord = {
    id: `intent-${name}`,
    message: `work ${name}`,
    companyId: scope.companyId
  };
  return createOrchestrationRun({
    id: `run-${name}`,
    correlationId: `correlation-${name}`,
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

function contextReady(run: OrchestrationRunRecord, hash = "a".repeat(64)) {
  return transitionOrchestrationRun(run, {
    to: "context-ready",
    now: "2026-09-28T10:00:01.000Z",
    checkpointPatch: {
      contextSnapshot: { id: "context-1", hash }
    }
  });
}

describe("PostgresOrchestrationRunStore", () => {
  it("declares a production durable CAS store", () => {
    expect(POSTGRES_ORCHESTRATION_STORE_DESCRIPTOR).toEqual({
      persistence: "durable-external",
      compareAndSwap: true,
      uniqueCorrelationId: true,
      restartSafe: true,
      multiProcessSafe: true,
      productionEligible: true
    });
  });

  it("creates a run and initial immutable checkpoint", async () => {
    const run = acceptedRun();
    const db = new ScriptedDb([
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const result = await new PostgresOrchestrationRunStore(db).create(
      run,
      "orchestration:start:owner-intent:intent-one"
    );

    expect(result).toEqual({ status: "created", record: run });
    expect(db.calls[0]).toContain("INSERT INTO orchestration_runs");
    expect(db.calls[1]).toContain("INSERT INTO orchestration_checkpoints");
    expect(db.calls[2]).toContain("INSERT INTO orchestration_worker_state");
  });

  it("returns an exact idempotent start replay", async () => {
    const run = acceptedRun();
    const key = "orchestration:start:owner-intent:intent-one";
    const db = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: run,
          start_idempotency_key: key,
          record_hash: run.recordHash
        }]
      }
    ]);

    const result = await new PostgresOrchestrationRunStore(db).create(run, key);
    expect(result).toEqual({ status: "idempotent-replay", record: run });
  });

  it("rejects start idempotency reuse with different content", async () => {
    const run = acceptedRun();
    const prior = acceptedRun("prior");
    const key = "orchestration:start:owner-intent:intent-one";
    const db = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: prior,
          start_idempotency_key: key,
          record_hash: prior.recordHash
        }]
      }
    ]);

    await expect(
      new PostgresOrchestrationRunStore(db).create(run, key)
    ).rejects.toThrow(/conflicts with an existing run/i);
  });

  it("persists one CAS update, checkpoint, and transition receipt", async () => {
    const run = acceptedRun("cas");
    const next = contextReady(run);
    const db = new ScriptedDb([
      { rows: [] },
      { rows: [{ payload: run }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const store = new PostgresOrchestrationRunStore(db);

    const result = await store.compareAndSwap(next, {
      expectedVersion: run.version,
      expectedRecordHash: run.recordHash,
      idempotencyKey: orchestrationTransitionIdempotencyKey(run, next.state)
    });

    expect(result).toBe(next);
    expect(db.calls.some((call) => call.includes("UPDATE orchestration_runs"))).toBe(true);
    expect(db.calls.some((call) => call.includes("INSERT INTO orchestration_checkpoints"))).toBe(true);
    expect(db.calls.some((call) => call.includes("INSERT INTO orchestration_transition_receipts"))).toBe(true);
  });

  it("replays a committed CAS from the immutable transition receipt", async () => {
    const run = acceptedRun("replay");
    const next = contextReady(run);
    const idempotencyKey = orchestrationTransitionIdempotencyKey(run, next.state);
    const receipt = createOrchestrationTransitionReceipt({
      current: run,
      next,
      idempotencyKey
    });
    const db = new ScriptedDb([{
      rows: [{
        payload: receipt,
        expected_record_hash: run.recordHash,
        next_record_hash: next.recordHash
      }]
    }]);

    const result = await new PostgresOrchestrationRunStore(db).compareAndSwap(next, {
      expectedVersion: run.version,
      expectedRecordHash: run.recordHash,
      idempotencyKey
    });

    expect(result.recordHash).toBe(next.recordHash);
    expect(db.calls).toHaveLength(1);
  });

  it("rejects transition idempotency reuse with different content", async () => {
    const run = acceptedRun("receipt-conflict");
    const next = contextReady(run);
    const idempotencyKey = orchestrationTransitionIdempotencyKey(run, next.state);
    const receipt = createOrchestrationTransitionReceipt({
      current: run,
      next,
      idempotencyKey
    });
    const db = new ScriptedDb([{
      rows: [{
        payload: receipt,
        expected_record_hash: "b".repeat(64),
        next_record_hash: next.recordHash
      }]
    }]);

    await expect(
      new PostgresOrchestrationRunStore(db).compareAndSwap(next, {
        expectedVersion: run.version,
        expectedRecordHash: run.recordHash,
        idempotencyKey
      })
    ).rejects.toThrow(/idempotency key was reused/i);
  });

  it("rejects stale CAS version/hash", async () => {
    const run = acceptedRun("stale");
    const next = contextReady(run);
    const alreadyAdvanced = contextReady(acceptedRun("different"));
    const db = new ScriptedDb([
      { rows: [] },
      { rows: [{ payload: alreadyAdvanced }] }
    ]);

    await expect(
      new PostgresOrchestrationRunStore(db).compareAndSwap(next, {
        expectedVersion: run.version,
        expectedRecordHash: run.recordHash,
        idempotencyKey: "orchestration:stale"
      })
    ).rejects.toThrow(/changed before compare-and-swap/i);
  });

  it("fails when the guarded UPDATE loses the CAS race", async () => {
    const run = acceptedRun("update-race");
    const next = contextReady(run);
    const db = new ScriptedDb([
      { rows: [] },
      { rows: [{ payload: run }] },
      { rowCount: 0 }
    ]);

    await expect(
      new PostgresOrchestrationRunStore(db).compareAndSwap(next, {
        expectedVersion: run.version,
        expectedRecordHash: run.recordHash,
        idempotencyKey: "orchestration:update-race"
      })
    ).rejects.toThrow(/changed during compare-and-swap/i);
  });

  it("loads by id/correlation and validates recovery candidates", async () => {
    const run = acceptedRun("read");
    const db = new ScriptedDb([
      { rows: [{ payload: run }] },
      { rows: [{ payload: run }] },
      { rows: [{ payload: run }] }
    ]);
    const store = new PostgresOrchestrationRunStore(db);

    expect((await store.get(run.id))?.recordHash).toBe(run.recordHash);
    expect((await store.getByCorrelationId(run.correlationId))?.id).toBe(run.id);
    expect(await store.listResumable({ limit: 10 })).toEqual([run]);
  });

  it("returns null for missing reads", async () => {
    const db = new ScriptedDb([{ rows: [] }, { rows: [] }]);
    const store = new PostgresOrchestrationRunStore(db);
    expect(await store.get("missing")).toBeNull();
    expect(await store.getByCorrelationId("missing")).toBeNull();
  });

  it("rejects invalid recovery limits and owner-waiting recovery requests", async () => {
    const store = new PostgresOrchestrationRunStore(new ScriptedDb([]));
    await expect(store.listResumable({ limit: 0 })).rejects.toThrow(/1 to 500/);
    await expect(
      store.listResumable({ limit: 10, states: ["awaiting-decision"] })
    ).rejects.toThrow(/resumed only by an authoritative Decision/);
  });

  it("rejects invalid CAS identity/state even if a caller constructs records directly", () => {
    const run = acceptedRun("forged");
    const validNext = contextReady(run);
    const forgedBase = {
      ...validNext,
      state: "validated" as const,
      version: run.version + 1
    };
    const forged = {
      ...forgedBase,
      recordHash: validNext.recordHash
    };

    expect(() =>
      createOrchestrationTransitionReceipt({
        current: run,
        next: forged,
        idempotencyKey: "orchestration:forged"
      })
    ).toThrow();
  });

  it("creates deterministic transition idempotency keys", () => {
    const run = acceptedRun("key");
    expect(orchestrationTransitionIdempotencyKey(run, "context-ready"))
      .toBe("orchestration:run-key:v1:accepted->context-ready");
  });
});
