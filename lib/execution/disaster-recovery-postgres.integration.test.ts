import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import { createPersistedJobExecutionSpec, type JobExecutionSpec } from "@/lib/execution/job-execution-router";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresDisasterRecoveryPlanner } from "@/lib/persistence/postgres/disaster-recovery-store";
import { PostgresBusinessActionExecutionStore } from "@/lib/persistence/postgres/execution-stores";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const describeIntegration = enabled ? describe.sequential : describe.skip;
const baseConnectionString = process.env.DATABASE_URL?.trim() ?? "";
const ssl = process.env.GETDONE_DB_SSL === "false" ? false : { rejectUnauthorized: true };

function quoteIdentifier(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function databaseUrl(base: string, name: string) {
  const url = new URL(base);
  url.pathname = "/" + name;
  return url.toString();
}

function runNode(script: string, env: Record<string,string>) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 24 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function queueEnvelope(jobId: string) {
  return createJobQueueEnvelope({
    id: `queue:${jobId}`,
    correlationId: "corr-dr",
    jobId,
    taskId: `task:${jobId}`,
    scope: {
      userId: "owner-dr",
      portfolioId: "portfolio-dr",
      companyId: "company-dr",
      environment: "staging"
    },
    authorizationConsumptionHash: `consumption:${jobId}`,
    idempotencyKey: `enqueue:${jobId}`,
    scheduledAt: "2026-09-25T10:00:00.000Z",
    createdAt: "2026-09-25T10:00:00.000Z"
  });
}

function businessSpec(jobId: string) {
  const envelope = queueEnvelope(jobId);
  const request = {
    id: `request:${jobId}`,
    correlationId: "corr-dr",
    jobId,
    scope: envelope.scope,
    capability: "email.send",
    input: { messageRef: jobId },
    inputHash: sha256Hex({ messageRef: jobId }),
    authorizationConsumptionHash: envelope.authorizationConsumptionHash,
    idempotencyKey: `provider:${jobId}`,
    timeoutMs: 10_000,
    attempt: 1
  };
  return createPersistedJobExecutionSpec({
    kind: "business-action",
    jobId,
    authoritativeJobVersion: 1,
    authoritativeJobHash: "b".repeat(64),
    request
  });
}

function providerRecord(jobId: string): BusinessActionExecutionRecord {
  const spec = businessSpec(jobId);
  const request = spec.spec.kind === "business-action" ? spec.spec.request : null;
  if (!request) throw new Error("business request missing");
  const base = {
    requestId: request.id,
    correlationId: request.correlationId,
    jobId,
    requestHash: sha256Hex(request),
    adapterId: "dr-provider",
    adapterVersion: "1.0.0",
    providerOperationId: `provider-operation:${jobId}`,
    state: "accepted" as const,
    adapterResultHash: "c".repeat(64),
    retryable: true,
    updatedAt: "2026-09-25T10:00:01.000Z"
  };
  return { ...base, recordHash: sha256Hex(base) };
}

describeIntegration("disaster recovery from real PostgreSQL backup", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const sourceName = `getdone_dr_source_${suffix}`;
  const restoredName = `getdone_restore_verify_dr_${suffix}`;
  const backupFile = path.join(os.tmpdir(), `getdone-dr-${suffix}.dump`);
  const manifestFile = `${backupFile}.manifest.json`;
  let admin: Pool;

  afterAll(async () => {
    for (const name of [restoredName, sourceName]) {
      try { await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`); } catch {}
    }
    await admin?.end();
    for (const file of [backupFile, manifestFile]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    }
  });

  it("loses the primary, restores, classifies replay safety, and restarts workers without unsafe replay", async () => {
    if (!baseConnectionString) throw new Error("DATABASE_URL is required");
    admin = new Pool({
      connectionString: baseConnectionString,
      max: 2,
      application_name: "getdone-dr-acceptance-admin",
      ssl
    });
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(sourceName)} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(restoredName)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(sourceName)}`);

    const sourceUrl = databaseUrl(baseConnectionString, sourceName);
    runNode("scripts/migrate-postgres.mjs", {
      DATABASE_URL: sourceUrl,
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false"
    });

    const sourceDb = new PostgresDatabase({
      connectionString: sourceUrl,
      maxConnections: 4,
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });
    const sourceJobs = new PostgresDurableJobStore(sourceDb, { recoveryDelayMs: 0 });
    const specs = new PostgresJobExecutionSpecStore(sourceDb);
    const executions = new PostgresBusinessActionExecutionStore(sourceDb);

    const safeQueued = "job-dr-safe-queued";
    const safeProvider = "job-dr-safe-provider";
    const reconcile = "job-dr-reconcile";
    const blocked = "job-dr-blocked-deploy";

    for (const jobId of [safeQueued, safeProvider, reconcile, blocked]) {
      await sourceJobs.enqueue(queueEnvelope(jobId));
    }
    for (const jobId of [safeQueued, safeProvider, reconcile]) {
      await specs.put(businessSpec(jobId));
    }
    await specs.put(createPersistedJobExecutionSpec({
      kind: "software-deploy",
      jobId: blocked,
      plan: {} as never,
      promotion: {} as never
    } as JobExecutionSpec));

    async function claim(jobId: string) {
      const snapshot = await sourceJobs.getRuntimeSnapshot(jobId);
      if (!snapshot) throw new Error(`runtime missing for ${jobId}`);
      const claimed = await sourceJobs.claimAtomic({
        jobId,
        workerId: "worker-primary-lost",
        now: "2026-09-25T10:00:02.000Z",
        leaseSeconds: 2,
        expectedJobVersion: snapshot.version,
        expectedJobHash: snapshot.stateHash,
        idempotencyKey: `claim:${jobId}:primary`
      });
      if (!claimed) throw new Error(`claim failed for ${jobId}`);
    }

    await claim(safeProvider);
    await claim(reconcile);
    await claim(blocked);
    await executions.save(providerRecord(safeProvider));
    await sourceDb.close();

    const backup = JSON.parse(runNode("scripts/create-staging-backup.mjs", {
      GETDONE_RUNTIME_ENV: "staging",
      DATABASE_URL: sourceUrl,
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
      GETDONE_BACKUP_FILE: backupFile,
      GETDONE_BACKUP_MANIFEST: manifestFile,
      GETDONE_BACKUP_OVERWRITE: "true",
      GETDONE_BACKUP_REF: `dr-acceptance:${sourceName}`
    }));

    // Simulate total loss of the authoritative primary database/runtime.
    await admin.query(`DROP DATABASE ${quoteIdentifier(sourceName)} WITH (FORCE)`);
    await expect(admin.query(
      "SELECT 1 FROM pg_database WHERE datname=$1",
      [sourceName]
    )).resolves.toMatchObject({ rowCount: 0 });

    const restored = JSON.parse(runNode("scripts/restore-staging-backup.mjs", {
      GETDONE_RUNTIME_ENV: "staging",
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
      GETDONE_BACKUP_FILE: backupFile,
      GETDONE_BACKUP_MANIFEST: manifestFile,
      GETDONE_RESTORE_ADMIN_DATABASE_URL: baseConnectionString,
      GETDONE_RESTORE_DATABASE_NAME: restoredName,
      GETDONE_RESTORE_KEEP_DATABASE: "true",
      GETDONE_RESTORE_SKIP_BUILD: fs.existsSync(path.join(process.cwd(), ".next", "BUILD_ID"))
        ? "true"
        : "false",
      GETDONE_RESTORE_BOOT_PORT: String(34_000 + (process.pid % 1_000))
    }));
    expect(restored).toMatchObject({
      ok: true,
      applicationBootability: {
        status: "verified",
        persistenceConnected: true,
        authConnected: true
      }
    });

    const restoredUrl = databaseUrl(baseConnectionString, restoredName);
    const restoredDb = new PostgresDatabase({
      connectionString: restoredUrl,
      maxConnections: 4,
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });
    try {
      const incidentId = `dr-incident-${suffix}`;
      const cliPlan = JSON.parse(runNode("scripts/plan-disaster-recovery.mjs", {
        DATABASE_URL: restoredUrl,
        GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
        GETDONE_DR_INCIDENT_ID: incidentId,
        GETDONE_DR_DECLARED_AT: "2026-09-25T10:00:10.000Z",
        GETDONE_DR_LOST_PRIMARY_AT: "2026-09-25T10:00:05.000Z",
        GETDONE_DR_DECIDED_AT: "2026-09-25T10:00:10.000Z",
        GETDONE_DR_BACKUP_SHA256: backup.backupSha256,
        GETDONE_DR_SNAPSHOT_HASH: backup.snapshot.hashes.composite
      }));
      expect(cliPlan.counts).toEqual({ resume: 2, reconcile: 1, blocked: 1 });

      const planner = new PostgresDisasterRecoveryPlanner(restoredDb);
      await planner.declareIncident({
        id: incidentId,
        declaredAt: "2026-09-25T10:00:10.000Z",
        lostPrimaryAt: "2026-09-25T10:00:05.000Z",
        sourceBackupSha256: backup.backupSha256,
        sourceSnapshotHash: backup.snapshot.hashes.composite
      });
      const plan = await planner.planIncident(
        incidentId,
        "2026-09-25T10:00:10.000Z"
      );
      expect(plan.counts).toEqual(cliPlan.counts);
      expect(Object.fromEntries(plan.decisions.map((item) => [item.jobId,item.decision]))).toEqual({
        [safeQueued]: "resume",
        [safeProvider]: "resume",
        [reconcile]: "reconcile",
        [blocked]: "blocked"
      });

      const restoredJobs = new PostgresDurableJobStore(restoredDb, { recoveryDelayMs: 0 });
      const recovered = await restoredJobs.recoverExpired({
        now: "2026-09-25T10:00:10.000Z",
        limit: 10
      });
      expect(recovered.map((item) => item.jobId)).toEqual([safeProvider]);

      const executed: string[] = [];
      const restartedWorker = new DurableJobWorker(
        restoredJobs,
        {
          workerId: "worker-after-disaster",
          leaseSeconds: 10,
          heartbeatSeconds: 3,
          batchSize: 10,
          concurrency: 2,
          retryBaseDelayMs: 0,
          maxAttempts: 5
        },
        () => new Date("2026-09-25T10:00:11.000Z")
      );
      const results = await restartedWorker.runOnce({
        execute: async ({ envelope }) => {
          executed.push(envelope.jobId);
          return { kind: "provider-completed" };
        }
      });
      expect(results.map((item) => item.jobId).sort()).toEqual([safeProvider,safeQueued].sort());
      expect(executed.sort()).toEqual([safeProvider,safeQueued].sort());

      expect((await restoredJobs.getRuntimeSnapshot(reconcile))?.state).toBe("claimed");
      expect((await restoredJobs.getRuntimeSnapshot(blocked))?.state).toBe("claimed");

      const unresolved = await restoredDb.query<{ job_id: string; decision: string }>(
        `SELECT job_id,decision
         FROM job_disaster_recovery_decisions
         WHERE cleared_at IS NULL AND decision IN ('reconcile','blocked')
         ORDER BY job_id`
      );
      expect(unresolved.rows).toEqual([
        { job_id: blocked, decision: "blocked" },
        { job_id: reconcile, decision: "reconcile" }
      ]);

      await planner.clearReconciliation({
        incidentId,
        jobId: reconcile,
        clearedAt: "2026-09-25T10:00:12.000Z",
        evidenceHash: "d".repeat(64)
      });
      const afterReconciliation = await restoredJobs.recoverExpired({
        now: "2026-09-25T10:00:13.000Z",
        limit: 10
      });
      expect(afterReconciliation.map((item) => item.jobId)).toEqual([reconcile]);

      await expect(planner.clearReconciliation({
        incidentId,
        jobId: blocked,
        clearedAt: "2026-09-25T10:00:14.000Z",
        evidenceHash: "e".repeat(64)
      })).rejects.toMatchObject({ code: "CONFLICT" });

      expect((await restoredJobs.getRuntimeSnapshot(blocked))?.state).toBe("claimed");
    } finally {
      await restoredDb.close();
    }
  }, 180_000);
});
