import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import { PostgresProviderConcurrencyGate } from "@/lib/execution/provider-concurrency.server";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const connectionString = process.env.DATABASE_URL?.trim() ?? "";

function envelope(jobId: string, companyId: string) {
  const at = "2026-09-23T17:00:00.000Z";
  return createJobQueueEnvelope({
    id: `queue:${jobId}`,
    jobId,
    taskId: `task:${jobId}`,
    scope: {
      userId: "owner",
      portfolioId: "portfolio-backpressure",
      companyId,
      environment: "staging"
    },
    authorizationConsumptionHash: `consumption:${jobId}`,
    idempotencyKey: `enqueue:${jobId}`,
    scheduledAt: at,
    createdAt: at
  });
}

integrationDescribe("queue saturation and backpressure", () => {
  let admin: Pool;
  let database: PostgresDatabase;
  const ids = [
    "bp-noisy-a",
    "bp-noisy-b",
    "bp-noisy-c",
    "bp-quiet-a",
    "bp-worker-a",
    "bp-worker-b",
    "bp-worker-c"
  ];

  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required");
    admin = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-backpressure-acceptance",
      ssl: process.env.GETDONE_DB_SSL === "false"
        ? false
        : { rejectUnauthorized: true }
    });
    database = new PostgresDatabase({
      connectionString,
      maxConnections: 6,
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });

    await admin.query("DELETE FROM job_runtime_transactions WHERE job_id = ANY($1::text[])", [ids]);
    await admin.query("DELETE FROM job_leases WHERE job_id = ANY($1::text[])", [ids]);
    await admin.query("DELETE FROM job_retry_schedule WHERE job_id = ANY($1::text[])", [ids]);
    await admin.query("DELETE FROM job_dead_letters WHERE job_id = ANY($1::text[])", [ids]);
    await admin.query("DELETE FROM job_recovery_records WHERE job_id = ANY($1::text[])", [ids]);
    await admin.query("DELETE FROM job_execution_outcomes WHERE job_id = ANY($1::text[])", [ids]);
    await admin.query("DELETE FROM job_runtime_events WHERE job_id = ANY($1::text[])", [ids]);
    await admin.query("DELETE FROM job_runtime_state WHERE job_id = ANY($1::text[])", [ids]);
    await admin.query("DELETE FROM provider_concurrency_leases WHERE request_id LIKE 'bp-provider-%'");
  });

  afterAll(async () => {
    if (admin) {
      await admin.query("DELETE FROM job_runtime_transactions WHERE job_id = ANY($1::text[])", [ids]);
      await admin.query("DELETE FROM job_leases WHERE job_id = ANY($1::text[])", [ids]);
      await admin.query("DELETE FROM job_retry_schedule WHERE job_id = ANY($1::text[])", [ids]);
      await admin.query("DELETE FROM job_dead_letters WHERE job_id = ANY($1::text[])", [ids]);
      await admin.query("DELETE FROM job_recovery_records WHERE job_id = ANY($1::text[])", [ids]);
      await admin.query("DELETE FROM job_execution_outcomes WHERE job_id = ANY($1::text[])", [ids]);
      await admin.query("DELETE FROM job_runtime_events WHERE job_id = ANY($1::text[])", [ids]);
      await admin.query("DELETE FROM job_runtime_state WHERE job_id = ANY($1::text[])", [ids]);
      await admin.query("DELETE FROM provider_concurrency_leases WHERE request_id LIKE 'bp-provider-%'");
      await admin.end();
    }
    if (database) await database.close();
  });

  it("rejects noisy-company saturation while preserving capacity for another company", async () => {
    const store = new PostgresDurableJobStore(database, {
      maxQueueDepth: 20,
      maxCompanyQueueDepth: 2
    });
    await store.enqueue(envelope("bp-noisy-a", "company-noisy"));
    await store.enqueue(envelope("bp-noisy-b", "company-noisy"));

    await expect(
      store.enqueue(envelope("bp-noisy-c", "company-noisy"))
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: {
        reason: "QUEUE_SATURATED",
        scope: "company",
        limit: 2
      }
    });

    await expect(
      store.enqueue(envelope("bp-quiet-a", "company-quiet"))
    ).resolves.toMatchObject({ status: "enqueued" });

    const ready = await store.listReady({
      now: "2026-09-23T17:00:01.000Z",
      limit: 3
    });
    expect(ready.map((item) => item.envelope.scope.companyId).slice(0, 2).sort())
      .toEqual(["company-noisy", "company-quiet"]);
  });

  it("runs no more than configured worker concurrency", async () => {
    const store = new PostgresDurableJobStore(database);
    for (const id of ["bp-worker-a", "bp-worker-b", "bp-worker-c"]) {
      await store.enqueue(envelope(id, `company-${id}`));
    }
    const worker = new DurableJobWorker(store, {
      workerId: "bp-worker",
      leaseSeconds: 10,
      heartbeatSeconds: 3,
      batchSize: 3,
      concurrency: 2,
      retryBaseDelayMs: 0,
      maxAttempts: 2
    }, () => new Date("2026-09-23T17:00:02.000Z"));

    let active = 0;
    let maxActive = 0;
    let twoStartedResolve!: () => void;
    const twoStarted = new Promise<void>((resolve) => { twoStartedResolve = resolve; });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });

    const running = worker.runOnce({
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 2) twoStartedResolve();
        await release;
        active -= 1;
        return { kind: "provider-completed" };
      }
    });

    await twoStarted;
    expect(maxActive).toBe(2);
    releaseResolve();
    const results = await running;
    expect(results).toHaveLength(3);
    expect(maxActive).toBe(2);
  });

  it("enforces provider-specific concurrency across callers and releases capacity", async () => {
    const gate = new PostgresProviderConcurrencyGate(database, {
      defaultLimit: 1,
      leaseSeconds: 30,
      limits: Object.freeze({ "mail-adapter": 1 })
    }, () => new Date("2026-09-23T17:00:03.000Z"));

    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const inside = new Promise<void>((resolve) => { entered = resolve; });

    const first = gate.withPermit({
      providerKey: "mail-adapter",
      requestId: "bp-provider-1",
      portfolioId: "portfolio-backpressure",
      companyId: "company-a",
      operation: "execute"
    }, async () => {
      entered();
      await hold;
      return "first";
    });

    await inside;

    try {
      await gate.withPermit({
        providerKey: "mail-adapter",
        requestId: "bp-provider-2",
        portfolioId: "portfolio-backpressure",
        companyId: "company-b",
        operation: "execute"
      }, async () => "second");
      throw new Error("expected provider saturation");
    } catch (error) {
      expect(error).toBeInstanceOf(ControlPlaneError);
      expect(error).toMatchObject({
        code: "UNAVAILABLE",
        details: {
          reason: "PROVIDER_CONCURRENCY_SATURATED",
          providerKey: "mail-adapter",
          limit: 1
        }
      });
    }

    release();
    await expect(first).resolves.toBe("first");

    await expect(gate.withPermit({
      providerKey: "mail-adapter",
      requestId: "bp-provider-3",
      portfolioId: "portfolio-backpressure",
      companyId: "company-b",
      operation: "status"
    }, async () => "third")).resolves.toBe("third");
  });
});
