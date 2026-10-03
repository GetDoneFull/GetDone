import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter
} from "@/lib/execution/adapters/business-action";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import { BusinessActionExecutionOrchestrator } from "@/lib/execution/business-action-orchestrator";
import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresBusinessActionExecutionStore } from "@/lib/persistence/postgres/execution-stores";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const describeIntegration = enabled ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";

function database() {
  return new PostgresDatabase({
    connectionString: databaseUrl,
    maxConnections: 4,
    ssl: process.env.GETDONE_DB_SSL !== "false"
  });
}

function envelope(jobId: string, scheduledAt = "2026-09-22T07:00:00.000Z") {
  return createJobQueueEnvelope({
    id: `queue:${jobId}`,
    jobId,
    taskId: `task:${jobId}`,
    scope: {
      userId: "owner",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging"
    },
    authorizationConsumptionHash: `consumption:${jobId}`,
    idempotencyKey: `enqueue:${jobId}`,
    scheduledAt,
    createdAt: scheduledAt
  });
}

function worker(
  store: PostgresDurableJobStore,
  workerId: string,
  now: string,
  maxAttempts = 5
) {
  return new DurableJobWorker(
    store,
    {
      workerId,
      leaseSeconds: 10,
      heartbeatSeconds: 3,
      batchSize: 10,
      retryBaseDelayMs: 0,
      maxAttempts
    },
    () => new Date(now)
  );
}


function runWorkerProcess(jobId: string, workerId: string, now: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "lib/execution/worker-process-child.integration.test.ts",
        "--reporter=dot"
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
          GETDONE_POSTGRES_INTEGRATION: "true",
          GETDONE_WORKER_CHILD: "true",
          GETDONE_WORKER_CHILD_JOB_ID: jobId,
          GETDONE_WORKER_CHILD_ID: workerId,
          GETDONE_WORKER_CHILD_NOW: now
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(
          `worker process ${workerId} failed with code ${code}: ${stdout}\n${stderr}`
        ));
        return;
      }
      resolve();
    });
  });
}

class RestartableAdapter implements BusinessActionAdapter {
  readonly id = "restartable-provider";
  readonly version = "1.0.0";
  executeCalls = 0;
  statusCalls = 0;
  state: "pending" | "completed" = "pending";

  async execute(request: AuthorizedBusinessActionRequest) {
    this.executeCalls += 1;
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId: "provider-op-durable-1",
      retryable: true,
      observedAt: "2026-09-22T07:00:01.000Z"
    });
  }

  async status(input: { requestId: string; providerOperationId: string }) {
    this.statusCalls += 1;
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state: this.state,
      observedAt: this.state === "completed"
        ? "2026-09-22T07:00:03.000Z"
        : "2026-09-22T07:00:02.000Z"
    });
  }
}

describeIntegration("durable worker PostgreSQL multi-worker acceptance", () => {
  const admin = database();

  beforeEach(async () => {
    await admin.query(`TRUNCATE
      business_action_verification_evidence,
      business_action_executions,
      job_worker_instances,
      job_runtime_events,
      job_execution_outcomes,
      job_recovery_records,
      job_dead_letters,
      job_retry_schedule,
      job_runtime_transactions,
      job_leases,
      job_runtime_state
      RESTART IDENTITY CASCADE`);
  }, 30_000);

  afterAll(async () => {
    await admin.close();
  });


  it("uses two real OS worker processes and permits only one claim", async () => {
    const db = database();
    try {
      const store = new PostgresDurableJobStore(db);
      await store.enqueue(envelope("job-os-process-race"));

      await Promise.all([
        runWorkerProcess(
          "job-os-process-race",
          "process-worker-a",
          "2026-09-22T07:00:05.000Z"
        ),
        runWorkerProcess(
          "job-os-process-race",
          "process-worker-b",
          "2026-09-22T07:00:05.000Z"
        )
      ]);
      expect((await store.getRuntimeSnapshot("job-os-process-race"))?.state)
        .toBe("released");

      const lineage = await admin.query<{ operation: string; count: string }>(
        `SELECT operation,count(*)::text AS count
         FROM job_runtime_transactions
         WHERE job_id='job-os-process-race'
           AND operation IN ('claim','heartbeat','release')
         GROUP BY operation
         ORDER BY operation`
      );
      expect(Object.fromEntries(
        lineage.rows.map((row) => [row.operation, Number(row.count)])
      )).toEqual({
        claim: 1,
        heartbeat: 1,
        release: 1
      });
    } finally {
      await db.close();
    }
  });

  it("allows only one of two independent workers to claim and execute the same Job", async () => {
    const dbA = database();
    const dbB = database();
    try {
      const storeA = new PostgresDurableJobStore(dbA);
      const storeB = new PostgresDurableJobStore(dbB);
      await storeA.enqueue(envelope("job-claim-race"));

      let executions = 0;
      const handler = {
        execute: async (context: { heartbeat(): Promise<void> }) => {
          executions += 1;
          await context.heartbeat();
          return { kind: "provider-completed" as const };
        }
      };

      const [left, right] = await Promise.all([
        worker(storeA, "worker-a", "2026-09-22T07:00:05.000Z").runOnce(handler),
        worker(storeB, "worker-b", "2026-09-22T07:00:05.000Z").runOnce(handler)
      ]);

      expect(left.length + right.length).toBe(1);
      expect(executions).toBe(1);
      expect((await storeA.getRuntimeSnapshot("job-claim-race"))?.state).toBe("released");

      const claims = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM job_runtime_transactions
         WHERE job_id='job-claim-race' AND operation='claim'`
      );
      expect(Number(claims.rows[0].count)).toBe(1);
      const heartbeats = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM job_runtime_transactions
         WHERE job_id='job-claim-race' AND operation='heartbeat'`
      );
      expect(Number(heartbeats.rows[0].count)).toBe(1);
    } finally {
      await dbA.close();
      await dbB.close();
    }
  });

  it("recovers a worker that dies after claim/before side effect and lets another worker retry", async () => {
    const dbA = database();
    const dbB = database();
    try {
      const storeA = new PostgresDurableJobStore(dbA, { recoveryDelayMs: 1 });
      const storeB = new PostgresDurableJobStore(dbB, { recoveryDelayMs: 1 });
      const record = envelope("job-crash-before-side-effect");
      await storeA.enqueue(record);
      const candidate = (await storeA.listReady({
        now: "2026-09-22T07:01:00.000Z",
        limit: 1
      }))[0];

      const claim = await storeA.claimAtomic({
        jobId: record.jobId,
        workerId: "worker-died",
        now: "2026-09-22T07:01:00.000Z",
        leaseSeconds: 2,
        expectedJobVersion: candidate.version,
        expectedJobHash: candidate.stateHash,
        idempotencyKey: "claim:crash-before-side-effect"
      });
      expect(claim).not.toBeNull();

      const recovered = await storeB.recoverExpired({
        now: "2026-09-22T07:01:10.000Z",
        limit: 10
      });
      const ownRecovery = recovered.filter((item) => item.jobId === record.jobId);
      expect(ownRecovery).toHaveLength(1);
      expect(ownRecovery[0].outcome).toBe("retry-scheduled");

      let sideEffects = 0;
      const result = await worker(
        storeB,
        "worker-recovery",
        "2026-09-22T07:01:11.000Z"
      ).runOnce({
        execute: async () => {
          sideEffects += 1;
          return { kind: "provider-completed" };
        }
      });
      expect(result).toHaveLength(1);
      expect(sideEffects).toBe(1);
      expect((await storeB.getRuntimeSnapshot(record.jobId))?.state).toBe("released");
    } finally {
      await dbA.close();
      await dbB.close();
    }
  });

  it("resumes an accepted provider operation after restart without repeating the side effect", async () => {
    const dbA = database();
    const adapter = new RestartableAdapter();
    const request: AuthorizedBusinessActionRequest = {
      id: "action-durable-resume",
      jobId: "job-provider-resume",
      scope: {
        userId: "owner",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        environment: "staging"
      },
      capability: "email.send",
      input: { messageRef: "durable-1" },
      inputHash: sha256Hex({ messageRef: "durable-1" }),
      authorizationConsumptionHash: "consumption-provider-resume",
      idempotencyKey: "action-durable-resume",
      timeoutMs: 10_000,
      attempt: 1
    };
    try {
      const registry = new StaticBusinessActionAdapterRegistry([
        { capability: "email.send", adapter }
      ]);
      const first = new BusinessActionExecutionOrchestrator(
        registry,
        new PostgresBusinessActionExecutionStore(dbA),
        { maxStatusPolls: 1, pollIntervalMs: 0 }
      );
      expect((await first.execute(request)).record.state).toBe("pending");
      expect(adapter.executeCalls).toBe(1);
    } finally {
      await dbA.close();
    }

    const dbB = database();
    try {
      adapter.state = "completed";
      const resumed = new BusinessActionExecutionOrchestrator(
        new StaticBusinessActionAdapterRegistry([
          { capability: "email.send", adapter }
        ]),
        new PostgresBusinessActionExecutionStore(dbB),
        { maxStatusPolls: 2, pollIntervalMs: 0 }
      );
      const result = await resumed.execute(request);
      expect(result.record.state).toBe("completed");
      expect(result.verificationEvidence?.result).toBe("pass");
      expect(adapter.executeCalls).toBe(1);
      expect(adapter.statusCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await dbB.close();
    }
  });

  it("moves retry work to another worker and dead-letters exhausted attempts", async () => {
    const dbA = database();
    const dbB = database();
    try {
      const storeA = new PostgresDurableJobStore(dbA);
      const storeB = new PostgresDurableJobStore(dbB);
      await storeA.enqueue(envelope("job-cross-worker-retry"));
      const first = await worker(
        storeA,
        "worker-retry-a",
        "2026-09-22T07:02:01.000Z",
        3
      ).runOnce({
        execute: async () => ({ kind: "retry", reason: "transient", delayMs: 0 })
      });
      expect(first[0]?.outcome.kind).toBe("retry");

      const second = await worker(
        storeB,
        "worker-retry-b",
        "2026-09-22T07:02:02.000Z",
        3
      ).runOnce({
        execute: async () => ({ kind: "provider-completed" })
      });
      expect(second[0]?.outcome.kind).toBe("provider-completed");

      await storeA.enqueue(envelope("job-max-attempts", "2026-09-22T07:03:00.000Z"));
      await worker(
        storeA,
        "worker-max-a",
        "2026-09-22T07:03:01.000Z",
        2
      ).runOnce({
        execute: async () => ({ kind: "retry", reason: "still transient", delayMs: 0 })
      });
      const exhausted = await worker(
        storeB,
        "worker-max-b",
        "2026-09-22T07:03:02.000Z",
        2
      ).runOnce({
        execute: async () => ({ kind: "retry", reason: "still transient", delayMs: 0 })
      });
      expect(exhausted[0]?.outcome.kind).toBe("dead-letter");
      expect((await storeB.getRuntimeSnapshot("job-max-attempts"))?.state)
        .toBe("dead-lettered");
    } finally {
      await dbA.close();
      await dbB.close();
    }
  });

  it("preserves owner cancellation that races worker completion", async () => {
    const db = database();
    try {
      const store = new PostgresDurableJobStore(db);
      await store.enqueue(envelope("job-cancel-race", "2026-09-22T07:04:00.000Z"));
      const result = await worker(
        store,
        "worker-cancel-race",
        "2026-09-22T07:04:01.000Z"
      ).runOnce({
        execute: async (context) => {
          await store.cancel({
            jobId: context.envelope.jobId,
            reason: "owner cancelled",
            cancelledAt: "2026-09-22T07:04:01.500Z",
            expectedJobVersion: context.runtimeVersion(),
            expectedJobHash: context.runtimeHash(),
            idempotencyKey: "cancel:race"
          });
          return { kind: "provider-completed" };
        }
      });
      expect(result[0]?.outcome).toEqual({
        kind: "cancelled",
        reason: "owner cancelled"
      });
      expect((await store.getRuntimeSnapshot("job-cancel-race"))?.state).toBe("cancelled");

      const releases = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM job_runtime_transactions
         WHERE job_id='job-cancel-race' AND operation='release'`
      );
      expect(Number(releases.rows[0].count)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("survives a web/runtime object restart and a terminated PostgreSQL connection", async () => {
    const beforeRestart = database();
    await new PostgresDurableJobStore(beforeRestart).enqueue(
      envelope("job-process-restart", "2026-09-22T07:05:00.000Z")
    );
    await beforeRestart.close();

    const afterRestart = database();
    try {
      const store = new PostgresDurableJobStore(afterRestart);
      const result = await worker(
        store,
        "worker-after-web-restart",
        "2026-09-22T07:05:01.000Z"
      ).runOnce({
        execute: async () => ({ kind: "provider-completed" })
      });
      expect(result[0]?.outcome.kind).toBe("provider-completed");

      const client = await afterRestart.pool.connect();
      try {
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await admin.query("SELECT pg_terminate_backend($1)", [pid.rows[0].pid]);
        await expect(client.query("SELECT 1")).rejects.toBeTruthy();
      } finally {
        client.release(true);
      }
      await expect(afterRestart.query("SELECT 1 AS ok")).resolves.toMatchObject({
        rows: [{ ok: 1 }]
      });
    } finally {
      await afterRestart.close();
    }
  });
});
