import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createOrchestrationRun,
  createOrchestrationSourceRef
} from "@/lib/orchestration/contracts";
import {
  orchestrationClaimIdempotencyKey
} from "@/lib/orchestration/worker-contracts";
import { PostgresOrchestrationWorkerStore } from "@/lib/persistence/postgres/orchestration-worker-store";
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

const scope = {
  userId: "owner",
  portfolioId: "portfolio",
  companyId: "company",
  environment: "staging" as const
};

function run() {
  const source = { id: "intent-1", message: "do work" };
  return createOrchestrationRun({
    id: "run-1",
    correlationId: "correlation-1",
    source: createOrchestrationSourceRef("owner-intent", source.id, source),
    scope,
    createdAt: "2026-09-28T11:00:00.000Z",
    updatedAt: "2026-09-28T11:00:00.000Z"
  });
}

function workerRow(payload = run()) {
  return {
    payload,
    run_id: payload.id,
    stage_run_version: payload.version,
    stage_attempt: 0,
    consecutive_failures: 0,
    ready_at: payload.updatedAt,
    lease_id: null,
    lease_worker_id: null,
    lease_issued_at: null,
    lease_heartbeat_at: null,
    lease_expires_at: null,
    lease_version: 0,
    claimed_run_version: null,
    claimed_record_hash: null
  };
}

function idempotencyRow(
  key: string,
  fingerprint: string,
  status: "IN_PROGRESS" | "COMPLETED" = "IN_PROGRESS"
) {
  return {
    key,
    fingerprint,
    status,
    created_at: "2026-09-28T11:00:01.000Z",
    completed_at: status === "COMPLETED" ? "2026-09-28T11:00:01.000Z" : null,
    failed_at: null,
    result: status === "COMPLETED" ? {} : null,
    error_code: null
  };
}

describe("PostgresOrchestrationWorkerStore", () => {
  it("lists only persisted ready candidates and validates batch bounds", async () => {
    const current = run();
    const store = new PostgresOrchestrationWorkerStore(
      new ScriptedDb([{ rows: [workerRow(current)] }])
    );

    const candidates = await store.listReady({
      now: "2026-09-28T11:00:01.000Z",
      limit: 10
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      run: current,
      stageRunVersion: 1,
      stageAttempt: 0,
      consecutiveFailures: 0
    });

    await expect(store.listReady({
      now: "2026-09-28T11:00:01.000Z",
      limit: 0
    })).rejects.toThrow(/batch limit/i);
  });

  it("claims exact run version/hash and writes a durable lease", async () => {
    const current = run();
    const key = orchestrationClaimIdempotencyKey({
      runId: current.id,
      runVersion: current.version,
      workerId: "worker-a"
    });
    const fingerprint = sha256Hex({
      runId: current.id,
      workerId: "worker-a",
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      leaseSeconds: 60
    });

    const db = new ScriptedDb([
      { rowCount: 1 },
      { rows: [idempotencyRow(key, fingerprint)] },
      { rows: [workerRow(current)] },
      { rowCount: 1 },
      { rows: [idempotencyRow(key, fingerprint, "COMPLETED")] }
    ]);
    const store = new PostgresOrchestrationWorkerStore(db);

    const lease = await store.claimAtomic({
      runId: current.id,
      workerId: "worker-a",
      now: "2026-09-28T11:00:01.000Z",
      leaseSeconds: 60,
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: key
    });

    expect(lease).toMatchObject({
      runId: current.id,
      workerId: "worker-a",
      claimedRunVersion: current.version,
      attempt: 1,
      consecutiveFailures: 0
    });
    expect(db.calls.some((call) => call.includes("UPDATE orchestration_worker_state"))).toBe(true);
  });

  it("returns null when exact claim lineage is no longer ready", async () => {
    const current = run();
    const key = "claim-stale";
    const fingerprint = sha256Hex({
      runId: current.id,
      workerId: "worker-a",
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      leaseSeconds: 60
    });
    const stale = {
      ...workerRow(current),
      ready_at: "2026-09-28T12:00:00.000Z"
    };
    const db = new ScriptedDb([
      { rowCount: 1 },
      { rows: [idempotencyRow(key, fingerprint)] },
      { rows: [stale] },
      { rows: [idempotencyRow(key, fingerprint, "COMPLETED")] }
    ]);

    const claimed = await new PostgresOrchestrationWorkerStore(db).claimAtomic({
      runId: current.id,
      workerId: "worker-a",
      now: "2026-09-28T11:00:01.000Z",
      leaseSeconds: 60,
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: key
    });

    expect(claimed).toBeNull();
  });

  it("recovers an expired pre-CAS lease into backoff retry", async () => {
    const current = run();
    const expired = {
      ...workerRow(current),
      stage_attempt: 1,
      lease_id: "lease-1",
      lease_worker_id: "worker-a",
      lease_issued_at: "2026-09-28T11:00:00.000Z",
      lease_heartbeat_at: "2026-09-28T11:00:00.000Z",
      lease_expires_at: "2026-09-28T11:00:02.000Z",
      lease_version: 1,
      claimed_run_version: current.version,
      claimed_record_hash: current.recordHash
    };
    const db = new ScriptedDb([
      { rows: [expired] },
      { rowCount: 1 }
    ]);

    const recovered = await new PostgresOrchestrationWorkerStore(db).recoverExpired({
      now: "2026-09-28T11:00:03.000Z",
      limit: 10,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0].outcome).toBe("retry-scheduled");
    expect(Date.parse(recovered[0].nextReadyAt)).toBeGreaterThan(
      Date.parse("2026-09-28T11:00:03.000Z")
    );
  });
});
