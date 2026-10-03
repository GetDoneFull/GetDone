import { describe, expect, it } from "vitest";
import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";

const enabled = process.env.GETDONE_WORKER_CHILD === "true";
const describeChild = enabled ? describe : describe.skip;

describeChild("durable worker OS child process", () => {
  it("attempts exactly one durable claim cycle", async () => {
    const connectionString = process.env.DATABASE_URL?.trim();
    const jobId = process.env.GETDONE_WORKER_CHILD_JOB_ID?.trim();
    const workerId = process.env.GETDONE_WORKER_CHILD_ID?.trim();
    const now = process.env.GETDONE_WORKER_CHILD_NOW?.trim();
    if (!connectionString || !jobId || !workerId || !now) {
      throw new Error("Worker child environment is incomplete");
    }

    const db = new PostgresDatabase({
      connectionString,
      maxConnections: 2,
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });
    try {
      const store = new PostgresDurableJobStore(db);
      const worker = new DurableJobWorker(
        store,
        {
          workerId,
          leaseSeconds: 10,
          heartbeatSeconds: 3,
          batchSize: 1,
          retryBaseDelayMs: 0,
          maxAttempts: 5
        },
        () => new Date(now)
      );
      const results = await worker.runOnce({
        execute: async (context) => {
          expect(context.envelope.jobId).toBe(jobId);
          await context.heartbeat();
          return { kind: "provider-completed" };
        }
      });
      expect(results.length).toBeLessThanOrEqual(1);
    } finally {
      await db.close();
    }
  });
});
