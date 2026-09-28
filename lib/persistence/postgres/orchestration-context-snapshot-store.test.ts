import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  assembleContext
} from "@/lib/intelligence/context";
import {
  createOwnerIntentContextSnapshot,
  createOwnerIntentOrchestrationRun
} from "@/lib/orchestration/owner-intent-flow";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import { PostgresOrchestrationContextSnapshotStore } from "@/lib/persistence/postgres/orchestration-context-snapshot-store";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface ResponseSpec {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDb implements PostgresTransactionalDatabase {
  readonly calls: string[] = [];
  constructor(private readonly responses: ResponseSpec[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string
  ): Promise<QueryResult<R>> {
    this.calls.push(text.replace(/\s+/g, " ").trim());
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
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

const intent: OwnerIntentRecord = {
  id: "intent-1",
  correlationId: "correlation-1",
  portfolioId: "portfolio-1",
  companyId: "company-1",
  environment: "staging",
  userId: "owner-1",
  message: "do work",
  channel: "chat",
  status: "accepted",
  receivedAt: "2026-09-28T12:00:00.000Z"
};

function snapshot() {
  const run = createOwnerIntentOrchestrationRun(intent);
  const assembledContext = assembleContext([], {
    portfolioId: intent.portfolioId,
    companyId: intent.companyId,
    allowedSensitivity: ["public", "internal"]
  }, {
    now: Date.parse("2026-09-28T12:00:01.000Z")
  });

  return createOwnerIntentContextSnapshot({
    run,
    intent,
    assembledContext,
    createdAt: "2026-09-28T12:00:01.000Z"
  });
}

describe("PostgresOrchestrationContextSnapshotStore", () => {
  it("persists a new immutable snapshot", async () => {
    const current = snapshot();
    const db = new ScriptedDb([{ rowCount: 1 }]);
    const result = await new PostgresOrchestrationContextSnapshotStore(db).create(
      current,
      "orchestration:run-1:v1:context-snapshot"
    );

    expect(result).toEqual({ status: "created", snapshot: current });
    expect(db.calls[0]).toContain("INSERT INTO orchestration_context_snapshots");
  });

  it("returns exact idempotent replay", async () => {
    const current = snapshot();
    const key = "orchestration:run-1:v1:context-snapshot";
    const db = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: current,
          snapshot_hash: current.snapshotHash,
          idempotency_key: key
        }]
      }
    ]);

    const result = await new PostgresOrchestrationContextSnapshotStore(db).create(
      current,
      key
    );
    expect(result).toEqual({
      status: "idempotent-replay",
      snapshot: current
    });
  });

  it("rejects same run/version or key with different frozen content", async () => {
    const current = snapshot();
    const changed = {
      ...current,
      id: "different-id"
    };
    const key = "orchestration:run-1:v1:context-snapshot";
    const db = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: changed,
          snapshot_hash: "b".repeat(64),
          idempotency_key: key
        }]
      }
    ]);

    await expect(
      new PostgresOrchestrationContextSnapshotStore(db).create(current, key)
    ).rejects.toThrow(/ContextSnapshot conflicts/i);
  });

  it("reads snapshot by id and run/version and returns null when missing", async () => {
    const current = snapshot();
    const db = new ScriptedDb([
      { rows: [{ payload: current }] },
      { rows: [{ payload: current }] },
      { rows: [] }
    ]);
    const store = new PostgresOrchestrationContextSnapshotStore(db);

    expect(await store.get(current.id)).toEqual(current);
    expect(await store.getByRunVersion(current.runId, current.runVersion))
      .toEqual(current);
    expect(await store.getByRunVersion("missing", 1)).toBeNull();
  });
});
