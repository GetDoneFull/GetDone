import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { VerificationEvidence } from "@/lib/verification/verification";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

export interface JobWorkerInstanceRecord {
  workerId: string;
  processRole: "job-worker";
  startedAt: string;
  lastPollAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastErrorHash?: string;
  status: "starting" | "running" | "degraded" | "stopped";
  updatedAt: string;
}

export class PostgresJobWorkerInstanceStore {
  constructor(private readonly db: SqlQueryable) {}

  async upsert(record: JobWorkerInstanceRecord) {
    await this.db.query(
      `INSERT INTO job_worker_instances(
        worker_id,process_role,started_at,last_poll_at,last_success_at,
        last_error_at,last_error_hash,status,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (worker_id) DO UPDATE SET
        process_role=EXCLUDED.process_role,
        started_at=LEAST(job_worker_instances.started_at,EXCLUDED.started_at),
        last_poll_at=EXCLUDED.last_poll_at,
        last_success_at=EXCLUDED.last_success_at,
        last_error_at=EXCLUDED.last_error_at,
        last_error_hash=EXCLUDED.last_error_hash,
        status=EXCLUDED.status,
        updated_at=EXCLUDED.updated_at`,
      [
        record.workerId,
        record.processRole,
        record.startedAt,
        record.lastPollAt ?? null,
        record.lastSuccessAt ?? null,
        record.lastErrorAt ?? null,
        record.lastErrorHash ?? null,
        record.status,
        record.updatedAt
      ]
    );
  }

  async get(workerId: string) {
    const result = await this.db.query<{
      worker_id: string;
      process_role: "job-worker";
      started_at: Date | string;
      last_poll_at: Date | string | null;
      last_success_at: Date | string | null;
      last_error_at: Date | string | null;
      last_error_hash: string | null;
      status: JobWorkerInstanceRecord["status"];
      updated_at: Date | string;
    }>(
      `SELECT worker_id,process_role,started_at,last_poll_at,last_success_at,
              last_error_at,last_error_hash,status,updated_at
       FROM job_worker_instances WHERE worker_id=$1`,
      [workerId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const iso = (value: Date | string) =>
      value instanceof Date ? value.toISOString() : String(value);
    return Object.freeze({
      workerId: row.worker_id,
      processRole: row.process_role,
      startedAt: iso(row.started_at),
      lastPollAt: row.last_poll_at ? iso(row.last_poll_at) : undefined,
      lastSuccessAt: row.last_success_at ? iso(row.last_success_at) : undefined,
      lastErrorAt: row.last_error_at ? iso(row.last_error_at) : undefined,
      lastErrorHash: row.last_error_hash ?? undefined,
      status: row.status,
      updatedAt: iso(row.updated_at)
    }) satisfies JobWorkerInstanceRecord;
  }
}

export interface JobVerificationEvidenceStore {
  put(jobId: string, requestId: string, evidence: VerificationEvidence): Promise<void>;
  get?(evidenceId: string): Promise<VerificationEvidence | null>;
  listByJobId?(jobId: string): Promise<readonly VerificationEvidence[]>;
}

export class PostgresJobVerificationEvidenceStore
  implements JobVerificationEvidenceStore {
  constructor(private readonly db: SqlQueryable) {}

  async put(jobId: string, requestId: string, evidence: VerificationEvidence) {
    if (
      evidence.subject.type !== "job"
      || evidence.subject.id !== jobId
      || !evidence.evidenceHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Business verification evidence is not bound to the executing Job"
      );
    }
    const inserted = await this.db.query(
      `INSERT INTO business_action_verification_evidence(
        evidence_id,job_id,request_id,portfolio_id,company_id,
        evidence_hash,payload,observed_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      ON CONFLICT (evidence_id) DO NOTHING`,
      [
        evidence.id,
        jobId,
        requestId,
        evidence.portfolioId,
        evidence.companyId,
        evidence.evidenceHash,
        JSON.stringify(evidence),
        evidence.observedAt
      ]
    );
    if (inserted.rowCount === 1) return;

    const existing = await this.db.query<{ evidence_hash: string }>(
      "SELECT evidence_hash FROM business_action_verification_evidence WHERE evidence_id=$1",
      [evidence.id]
    );
    if (existing.rows[0]?.evidence_hash === evidence.evidenceHash) return;
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Verification evidence id was reused with different content"
    );
  }

  async get(evidenceId: string): Promise<VerificationEvidence | null> {
    const result = await this.db.query<{ payload: VerificationEvidence }>(
      "SELECT payload FROM business_action_verification_evidence WHERE evidence_id=$1",
      [evidenceId]
    );
    return result.rows[0]?.payload ?? null;
  }

  async listByJobId(jobId: string): Promise<readonly VerificationEvidence[]> {
    const result = await this.db.query<{ payload: VerificationEvidence }>(
      `SELECT payload
       FROM business_action_verification_evidence
       WHERE job_id=$1
       ORDER BY observed_at,evidence_id`,
      [jobId]
    );
    return Object.freeze(result.rows.map((row) => row.payload));
  }
}

export function workerErrorHash(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return sha256Hex({ message });
}
