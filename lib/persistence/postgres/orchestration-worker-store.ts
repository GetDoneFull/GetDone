import type { PoolClient, QueryResultRow } from "pg";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { claimIdempotency } from "@/lib/domain/idempotency";
import {
  assertOrchestrationRunIntegrity,
  isOrchestrationWorkerResumable,
  type OrchestrationRunRecord
} from "@/lib/orchestration/contracts";
import {
  assertOrchestrationLease,
  computeOrchestrationBackoffMs,
  createOrchestrationLease,
  renewOrchestrationLease,
  type OrchestrationLease,
  type OrchestrationRecoveryRecord,
  type OrchestrationWorkCandidate,
  type OrchestrationWorkerStore
} from "@/lib/orchestration/worker-contracts";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import { PostgresIdempotencyStore } from "@/lib/persistence/postgres/authority-stores";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

interface WorkerRow extends QueryResultRow {
  run_id: string;
  portfolio_id: string;
  company_id: string;
  run_state: OrchestrationRunRecord["state"];
  stage_run_version: number;
  stage_attempt: number;
  consecutive_failures: number;
  ready_at: Date | string;
  lease_id: string | null;
  lease_worker_id: string | null;
  lease_issued_at: Date | string | null;
  lease_heartbeat_at: Date | string | null;
  lease_expires_at: Date | string | null;
  lease_version: number;
  claimed_run_version: number | null;
  claimed_record_hash: string | null;
  payload?: OrchestrationRunRecord;
}

interface CandidateRow extends WorkerRow {
  payload: OrchestrationRunRecord;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseTimestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a timestamp`);
  }
  return parsed;
}

function deterministicLeaseId(idempotencyKey: string) {
  return `orchestration-lease:${sha256Hex(idempotencyKey).slice(0, 32)}`;
}

function leaseFromRow(row: WorkerRow): OrchestrationLease | null {
  if (
    !row.lease_id
    || !row.lease_worker_id
    || !row.lease_issued_at
    || !row.lease_heartbeat_at
    || !row.lease_expires_at
    || row.claimed_run_version === null
    || !row.claimed_record_hash
    || row.stage_attempt < 1
  ) {
    return null;
  }

  const base = {
    id: row.lease_id,
    runId: row.run_id,
    workerId: row.lease_worker_id,
    claimedRunVersion: row.claimed_run_version,
    claimedRecordHash: row.claimed_record_hash,
    attempt: row.stage_attempt,
    consecutiveFailures: row.consecutive_failures,
    version: row.lease_version,
    issuedAt: iso(row.lease_issued_at),
    heartbeatAt: iso(row.lease_heartbeat_at),
    expiresAt: iso(row.lease_expires_at)
  };

  return Object.freeze({
    ...base,
    leaseHash: sha256Hex(base)
  });
}

function claimFingerprint(input: {
  runId: string;
  workerId: string;
  expectedRunVersion: number;
  expectedRecordHash: string;
  leaseSeconds: number;
}) {
  return sha256Hex(input);
}

async function completeIdempotency<T>(
  client: PoolClient,
  key: string,
  fingerprint: string,
  result: T,
  completedAt: string
) {
  return new PostgresIdempotencyStore(client).complete(
    key,
    fingerprint,
    result,
    completedAt
  );
}

async function claimOperation<T>(
  client: PoolClient,
  input: {
    idempotencyKey: string;
    fingerprint: string;
    now: string;
  }
) {
  const idempotency = new PostgresIdempotencyStore(client);
  const claim = await claimIdempotency<T>(
    idempotency,
    input.idempotencyKey,
    input.fingerprint,
    new Date(input.now)
  );

  if (claim.state === "COMPLETED") {
    return { replay: true as const, result: claim.record.result };
  }
  if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Orchestration worker operation is already in progress or previously failed"
    );
  }
  return { replay: false as const, result: undefined };
}

export class PostgresOrchestrationWorkerStore implements OrchestrationWorkerStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async withCandidateScope<T>(
    candidate: OrchestrationWorkCandidate,
    operation: () => Promise<T>
  ): Promise<T> {
    assertOrchestrationRunIntegrity(candidate.run);
    return runWithPostgresTenantScope(candidate.run.scope, operation);
  }

  async listReady(input: {
    now: string;
    limit: number;
  }): Promise<readonly OrchestrationWorkCandidate[]> {
    parseTimestamp(input.now, "orchestration worker ready time");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Orchestration worker batch limit must be from 1 to 500"
      );
    }

    const routing = await this.db.query<WorkerRow>(
      `SELECT *
       FROM orchestration_worker_state
       WHERE ready_at <= $1
         AND lease_id IS NULL
         AND run_state IN (
           'accepted',
           'context-ready',
           'planning',
           'planned',
           'validated',
           'policy-evaluated',
           'authorized',
           'tasks-created',
           'jobs-enqueued',
           'executing',
           'verifying'
         )
       ORDER BY ready_at,run_id
       LIMIT $2`,
      [input.now, input.limit]
    );

    const candidates: OrchestrationWorkCandidate[] = [];
    for (const row of routing.rows) {
      const authoritative = await runWithPostgresTenantScope(
        { portfolioId: row.portfolio_id, companyId: row.company_id },
        () => this.db.query<{ payload: OrchestrationRunRecord }>(
          "SELECT payload FROM orchestration_runs WHERE id=$1",
          [row.run_id]
        )
      );
      const run = authoritative.rows[0]?.payload;
      if (!run) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Orchestration dispatch row references a missing tenant-scoped run"
        );
      }
      assertOrchestrationRunIntegrity(run);
      if (
        run.scope.portfolioId !== row.portfolio_id
        || run.scope.companyId !== row.company_id
        || run.state !== row.run_state
        || !isOrchestrationWorkerResumable(run)
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Orchestration dispatch metadata drifted from authoritative run"
        );
      }

      const sameStage = row.stage_run_version === run.version;
      candidates.push(Object.freeze({
        run,
        stageRunVersion: run.version,
        stageAttempt: sameStage ? row.stage_attempt : 0,
        consecutiveFailures: sameStage ? row.consecutive_failures : 0,
        readyAt: iso(row.ready_at)
      }));
    }

    return Object.freeze(candidates);
  }

  async claimAtomic(input: {
    runId: string;
    workerId: string;
    now: string;
    leaseSeconds: number;
    expectedRunVersion: number;
    expectedRecordHash: string;
    idempotencyKey: string;
  }): Promise<OrchestrationLease | null> {
    const nowMs = parseTimestamp(input.now, "orchestration claim time");
    if (!input.workerId.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Orchestration workerId is required");
    }
    const fingerprint = claimFingerprint({
      runId: input.runId,
      workerId: input.workerId,
      expectedRunVersion: input.expectedRunVersion,
      expectedRecordHash: input.expectedRecordHash,
      leaseSeconds: input.leaseSeconds
    });

    return this.db.transaction(async (client) => {
      const operation = await claimOperation<OrchestrationLease | null>(client, {
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        now: input.now
      });

      if (operation.replay) {
        const prior = operation.result ?? null;
        if (!prior) return null;
        const current = await client.query<WorkerRow>(
          `SELECT * FROM orchestration_worker_state WHERE run_id=$1 FOR UPDATE`,
          [input.runId]
        );
        const active = current.rows[0] ? leaseFromRow(current.rows[0]) : null;
        if (
          active
          && active.id === prior.id
          && Date.parse(active.expiresAt) > nowMs
        ) {
          return active;
        }
        return null;
      }

      const selected = await client.query<CandidateRow>(
        `SELECT run.payload,worker.*
         FROM orchestration_runs run
         JOIN orchestration_worker_state worker ON worker.run_id=run.id
         WHERE run.id=$1
         FOR UPDATE OF run,worker`,
        [input.runId]
      );
      const row = selected.rows[0];
      if (!row) {
        throw new ControlPlaneError("NOT_FOUND", "Orchestration worker state was not found");
      }

      const run = row.payload;
      assertOrchestrationRunIntegrity(run);

      if (
        !isOrchestrationWorkerResumable(run)
        || run.version !== input.expectedRunVersion
        || run.recordHash !== input.expectedRecordHash
        || Date.parse(iso(row.ready_at)) > nowMs
        || row.lease_id !== null
      ) {
        await completeIdempotency(
          client,
          input.idempotencyKey,
          fingerprint,
          null,
          input.now
        );
        return null;
      }

      const stageChanged = row.stage_run_version !== run.version;
      const stageAttempt = (stageChanged ? 0 : row.stage_attempt) + 1;
      const consecutiveFailures = stageChanged ? 0 : row.consecutive_failures;
      const lease = createOrchestrationLease({
        id: deterministicLeaseId(input.idempotencyKey),
        runId: run.id,
        workerId: input.workerId,
        claimedRunVersion: run.version,
        claimedRecordHash: run.recordHash,
        attempt: stageAttempt,
        consecutiveFailures,
        issuedAt: input.now,
        leaseSeconds: input.leaseSeconds
      });

      await client.query(
        `UPDATE orchestration_worker_state
         SET
           stage_run_version=$2,
           stage_attempt=$3,
           consecutive_failures=$4,
           lease_id=$5,
           lease_worker_id=$6,
           lease_issued_at=$7,
           lease_heartbeat_at=$8,
           lease_expires_at=$9,
           lease_version=$10,
           claimed_run_version=$11,
           claimed_record_hash=$12,
           updated_at=$13
         WHERE run_id=$1`,
        [
          run.id,
          run.version,
          stageAttempt,
          consecutiveFailures,
          lease.id,
          lease.workerId,
          lease.issuedAt,
          lease.heartbeatAt,
          lease.expiresAt,
          lease.version,
          lease.claimedRunVersion,
          lease.claimedRecordHash,
          input.now
        ]
      );

      await completeIdempotency(
        client,
        input.idempotencyKey,
        fingerprint,
        lease,
        input.now
      );
      return lease;
    });
  }

  async heartbeat(input: {
    lease: OrchestrationLease;
    now: string;
    extendSeconds: number;
    idempotencyKey: string;
  }) {
    const nowMs = parseTimestamp(input.now, "orchestration heartbeat time");
    assertOrchestrationLease(input.lease, {
      runId: input.lease.runId,
      workerId: input.lease.workerId,
      now: nowMs
    });
    const fingerprint = sha256Hex({
      leaseHash: input.lease.leaseHash,
      extendSeconds: input.extendSeconds
    });

    return this.db.transaction(async (client) => {
      const operation = await claimOperation<OrchestrationLease>(client, {
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        now: input.now
      });
      if (operation.replay && operation.result) return operation.result;

      const selected = await client.query<CandidateRow>(
        `SELECT run.payload,worker.*
         FROM orchestration_runs run
         JOIN orchestration_worker_state worker ON worker.run_id=run.id
         WHERE run.id=$1
         FOR UPDATE OF run,worker`,
        [input.lease.runId]
      );
      const row = selected.rows[0];
      const current = row ? leaseFromRow(row) : null;
      if (!row || !current) {
        throw new ControlPlaneError("CONFLICT", "Orchestration lease is no longer active");
      }
      if (
        current.id !== input.lease.id
        || current.workerId !== input.lease.workerId
        || current.version !== input.lease.version
        || row.payload.version !== input.lease.claimedRunVersion
        || row.payload.recordHash !== input.lease.claimedRecordHash
      ) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Orchestration heartbeat lost lease or stage lineage"
        );
      }

      const renewed = renewOrchestrationLease(input.lease, {
        now: input.now,
        extendSeconds: input.extendSeconds
      });

      await client.query(
        `UPDATE orchestration_worker_state
         SET
           lease_heartbeat_at=$2,
           lease_expires_at=$3,
           lease_version=$4,
           updated_at=$5
         WHERE run_id=$1 AND lease_id=$6 AND lease_version=$7`,
        [
          input.lease.runId,
          renewed.heartbeatAt,
          renewed.expiresAt,
          renewed.version,
          input.now,
          input.lease.id,
          input.lease.version
        ]
      );

      await completeIdempotency(
        client,
        input.idempotencyKey,
        fingerprint,
        renewed,
        input.now
      );
      return renewed;
    });
  }

  async release(input: {
    lease: OrchestrationLease;
    now: string;
    idempotencyKey: string;
  }) {
    const nowMs = parseTimestamp(input.now, "orchestration release time");
    assertOrchestrationLease(input.lease, {
      runId: input.lease.runId,
      workerId: input.lease.workerId,
      now: nowMs
    });
    const fingerprint = sha256Hex({ leaseHash: input.lease.leaseHash });

    await this.db.transaction(async (client) => {
      const operation = await claimOperation<{ released: true }>(client, {
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        now: input.now
      });
      if (operation.replay) return;

      const selected = await client.query<CandidateRow>(
        `SELECT run.payload,worker.*
         FROM orchestration_runs run
         JOIN orchestration_worker_state worker ON worker.run_id=run.id
         WHERE run.id=$1
         FOR UPDATE OF run,worker`,
        [input.lease.runId]
      );
      const row = selected.rows[0];
      const current = row ? leaseFromRow(row) : null;
      if (!row || !current) {
        await completeIdempotency(
          client,
          input.idempotencyKey,
          fingerprint,
          { released: true },
          input.now
        );
        return;
      }
      if (
        current.id !== input.lease.id
        || current.workerId !== input.lease.workerId
        || current.version !== input.lease.version
        || current.leaseHash !== input.lease.leaseHash
      ) {
        throw new ControlPlaneError("CONFLICT", "Orchestration release lost lease ownership");
      }

      const advanced = row.payload.version > input.lease.claimedRunVersion;
      await client.query(
        `UPDATE orchestration_worker_state
         SET
           stage_run_version=$2,
           stage_attempt=CASE WHEN $3 THEN 0 ELSE stage_attempt END,
           consecutive_failures=CASE WHEN $3 THEN 0 ELSE consecutive_failures END,
           ready_at=$4,
           lease_id=NULL,
           lease_worker_id=NULL,
           lease_issued_at=NULL,
           lease_heartbeat_at=NULL,
           lease_expires_at=NULL,
           lease_version=lease_version+1,
           claimed_run_version=NULL,
           claimed_record_hash=NULL,
           last_error_code=NULL,
           last_error_message=NULL,
           updated_at=$4
         WHERE run_id=$1 AND lease_id=$5`,
        [
          input.lease.runId,
          row.payload.version,
          advanced,
          input.now,
          input.lease.id
        ]
      );

      await completeIdempotency(
        client,
        input.idempotencyKey,
        fingerprint,
        { released: true },
        input.now
      );
    });
  }

  async defer(input: {
    lease: OrchestrationLease;
    now: string;
    readyAt: string;
    reason: string;
    idempotencyKey: string;
  }) {
    const nowMs = parseTimestamp(input.now, "orchestration defer time");
    assertOrchestrationLease(input.lease, {
      runId: input.lease.runId,
      workerId: input.lease.workerId,
      now: nowMs
    });
    const readyAtMs = parseTimestamp(input.readyAt, "orchestration defer readyAt");
    if (readyAtMs < nowMs) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Deferred orchestration readyAt cannot be in the past");
    }
    const fingerprint = sha256Hex({
      leaseHash: input.lease.leaseHash,
      readyAt: new Date(readyAtMs).toISOString(),
      reason: input.reason
    });

    await this.db.transaction(async (client) => {
      const operation = await claimOperation<{ deferred: true }>(client, {
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        now: input.now
      });
      if (operation.replay) return;

      const result = await client.query(
        `UPDATE orchestration_worker_state
         SET
           ready_at=$2,
           lease_id=NULL,
           lease_worker_id=NULL,
           lease_issued_at=NULL,
           lease_heartbeat_at=NULL,
           lease_expires_at=NULL,
           lease_version=lease_version+1,
           claimed_run_version=NULL,
           claimed_record_hash=NULL,
           last_error_code=NULL,
           last_error_message=$3,
           updated_at=$4
         WHERE run_id=$1
           AND lease_id=$5
           AND lease_worker_id=$6
           AND claimed_run_version=$7
           AND claimed_record_hash=$8
           AND lease_version=$9`,
        [
          input.lease.runId,
          new Date(readyAtMs).toISOString(),
          input.reason,
          input.now,
          input.lease.id,
          input.lease.workerId,
          input.lease.claimedRunVersion,
          input.lease.claimedRecordHash,
          input.lease.version
        ]
      );
      if (result.rowCount !== 1) {
        throw new ControlPlaneError("CONFLICT", "Orchestration defer lost lease or stage lineage");
      }

      await completeIdempotency(
        client,
        input.idempotencyKey,
        fingerprint,
        { deferred: true },
        input.now
      );
    });
  }

  async scheduleRetry(input: {
    lease: OrchestrationLease;
    now: string;
    readyAt: string;
    code: string;
    reason: string;
    idempotencyKey: string;
  }) {
    const nowMs = parseTimestamp(input.now, "orchestration retry time");
    assertOrchestrationLease(input.lease, {
      runId: input.lease.runId,
      workerId: input.lease.workerId,
      now: nowMs
    });
    const readyAtMs = parseTimestamp(input.readyAt, "orchestration retry readyAt");
    if (readyAtMs < nowMs) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Retry readyAt cannot be in the past");
    }
    const fingerprint = sha256Hex({
      leaseHash: input.lease.leaseHash,
      readyAt: new Date(readyAtMs).toISOString(),
      code: input.code,
      reason: input.reason
    });

    await this.db.transaction(async (client) => {
      const operation = await claimOperation<{ scheduled: true }>(client, {
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        now: input.now
      });
      if (operation.replay) return;

      const result = await client.query(
        `UPDATE orchestration_worker_state
         SET
           consecutive_failures=consecutive_failures+1,
           ready_at=$2,
           lease_id=NULL,
           lease_worker_id=NULL,
           lease_issued_at=NULL,
           lease_heartbeat_at=NULL,
           lease_expires_at=NULL,
           lease_version=lease_version+1,
           claimed_run_version=NULL,
           claimed_record_hash=NULL,
           last_error_code=$3,
           last_error_message=$4,
           updated_at=$5
         WHERE run_id=$1
           AND lease_id=$6
           AND lease_worker_id=$7
           AND claimed_run_version=$8
           AND claimed_record_hash=$9
           AND lease_version=$10`,
        [
          input.lease.runId,
          new Date(readyAtMs).toISOString(),
          input.code,
          input.reason,
          input.now,
          input.lease.id,
          input.lease.workerId,
          input.lease.claimedRunVersion,
          input.lease.claimedRecordHash,
          input.lease.version
        ]
      );
      if (result.rowCount !== 1) {
        throw new ControlPlaneError("CONFLICT", "Orchestration retry lost lease or stage lineage");
      }

      await completeIdempotency(
        client,
        input.idempotencyKey,
        fingerprint,
        { scheduled: true },
        input.now
      );
    });
  }

  async deadLetter(input: {
    lease: OrchestrationLease;
    now: string;
    code: string;
    reason: string;
    terminalRun: OrchestrationRunRecord;
    recoveryKind?: "explicit-failure" | "expired-lease-recovery";
    idempotencyKey: string;
  }) {
    const nowMs = parseTimestamp(input.now, "orchestration dead-letter time");
    assertOrchestrationLease(input.lease, {
      runId: input.lease.runId,
      workerId: input.lease.workerId,
      now: nowMs
    });
    assertOrchestrationRunIntegrity(input.terminalRun);
    if (input.terminalRun.state !== "failed") {
      throw new ControlPlaneError(
        "CONFLICT",
        "Only failed orchestration runs may be dead-lettered"
      );
    }
    if (!input.code.trim() || !input.reason.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Dead-letter code and reason are required"
      );
    }

    const recoveryKind = input.recoveryKind ?? "explicit-failure";
    const fingerprint = sha256Hex({
      leaseHash: input.lease.leaseHash,
      terminalRecordHash: input.terminalRun.recordHash,
      code: input.code,
      reasonHash: sha256Hex(input.reason),
      recoveryKind
    });

    await this.db.transaction(async (client) => {
      const operation = await claimOperation<{ deadLettered: true }>(client, {
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        now: input.now
      });
      if (operation.replay) return;

      const selected = await client.query<CandidateRow>(
        `SELECT run.payload,worker.*
         FROM orchestration_runs run
         JOIN orchestration_worker_state worker ON worker.run_id=run.id
         WHERE run.id=$1
         FOR UPDATE OF run,worker`,
        [input.lease.runId]
      );
      const row = selected.rows[0];
      const current = row ? leaseFromRow(row) : null;
      if (
        !row
        || !current
        || current.id !== input.lease.id
        || current.workerId !== input.lease.workerId
        || current.version !== input.lease.version
        || row.payload.version !== input.terminalRun.version
        || row.payload.recordHash !== input.terminalRun.recordHash
      ) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Orchestration dead-letter lost lease or terminal run lineage"
        );
      }

      const failureMessageHash = sha256Hex(input.reason);
      const deadLetterBase = {
        runId: input.terminalRun.id,
        portfolioId: input.terminalRun.scope.portfolioId,
        companyId: input.terminalRun.scope.companyId,
        leaseId: input.lease.id,
        workerId: input.lease.workerId,
        claimedRunVersion: input.lease.claimedRunVersion,
        claimedRecordHash: input.lease.claimedRecordHash,
        terminalRunVersion: input.terminalRun.version,
        terminalRecordHash: input.terminalRun.recordHash,
        attempt: input.lease.attempt,
        failureCode: input.code,
        failureMessageHash,
        deadLetteredAt: input.now,
        recoveryKind
      };
      const evidenceHash = sha256Hex(deadLetterBase);
      const id = `orchestration-dead-letter:${sha256Hex({
        runId: input.terminalRun.id,
        leaseId: input.lease.id
      }).slice(0, 40)}`;

      await client.query(
        `INSERT INTO orchestration_worker_dead_letters(
           id,run_id,portfolio_id,company_id,lease_id,worker_id,
           claimed_run_version,claimed_record_hash,terminal_run_version,terminal_record_hash,
           attempt,failure_code,failure_message_hash,dead_lettered_at,recovery_kind,evidence_hash
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT(run_id,lease_id) DO NOTHING`,
        [
          id,
          deadLetterBase.runId,
          deadLetterBase.portfolioId,
          deadLetterBase.companyId,
          deadLetterBase.leaseId,
          deadLetterBase.workerId,
          deadLetterBase.claimedRunVersion,
          deadLetterBase.claimedRecordHash,
          deadLetterBase.terminalRunVersion,
          deadLetterBase.terminalRecordHash,
          deadLetterBase.attempt,
          deadLetterBase.failureCode,
          deadLetterBase.failureMessageHash,
          deadLetterBase.deadLetteredAt,
          deadLetterBase.recoveryKind,
          evidenceHash
        ]
      );

      const cleared = await client.query(
        `UPDATE orchestration_worker_state
         SET
           stage_run_version=$2,
           stage_attempt=0,
           consecutive_failures=0,
           ready_at=$3,
           lease_id=NULL,
           lease_worker_id=NULL,
           lease_issued_at=NULL,
           lease_heartbeat_at=NULL,
           lease_expires_at=NULL,
           lease_version=lease_version+1,
           claimed_run_version=NULL,
           claimed_record_hash=NULL,
           last_error_code=$4,
           last_error_message=$5,
           updated_at=$3
         WHERE run_id=$1 AND lease_id=$6 AND lease_version=$7`,
        [
          input.terminalRun.id,
          input.terminalRun.version,
          input.now,
          input.code,
          input.reason,
          input.lease.id,
          input.lease.version
        ]
      );
      if (cleared.rowCount !== 1) {
        throw new ControlPlaneError("CONFLICT", "Orchestration dead-letter lease cleanup failed");
      }

      await completeIdempotency(
        client,
        input.idempotencyKey,
        fingerprint,
        { deadLettered: true },
        input.now
      );
    });
  }

  async recoverExpired(input: {
    now: string;
    limit: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  }): Promise<readonly OrchestrationRecoveryRecord[]> {
    const nowMs = parseTimestamp(input.now, "orchestration recovery time");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Recovery limit must be from 1 to 500");
    }

    const routing = await this.db.query<WorkerRow>(
      `SELECT *
       FROM orchestration_worker_state
       WHERE lease_id IS NOT NULL
         AND lease_expires_at <= $1
       ORDER BY lease_expires_at,run_id
       LIMIT $2`,
      [input.now, input.limit]
    );

    const recovered: OrchestrationRecoveryRecord[] = [];
    for (const routingRow of routing.rows) {
      const record = await runWithPostgresTenantScope(
        {
          portfolioId: routingRow.portfolio_id,
          companyId: routingRow.company_id
        },
        () => this.db.transaction(async (client) => {
          const selected = await client.query<CandidateRow>(
            `SELECT run.payload,worker.*
             FROM orchestration_worker_state worker
             JOIN orchestration_runs run ON run.id=worker.run_id
             WHERE worker.run_id=$1
               AND worker.lease_id=$2
               AND worker.lease_expires_at <= $3
             FOR UPDATE OF run,worker`,
            [routingRow.run_id, routingRow.lease_id, input.now]
          );
          const row = selected.rows[0];
          if (!row) return null;

          const run = row.payload;
          assertOrchestrationRunIntegrity(run);
          if (
            run.scope.portfolioId !== row.portfolio_id
            || run.scope.companyId !== row.company_id
          ) {
            throw new ControlPlaneError(
              "FORBIDDEN",
              "Expired orchestration lease crossed tenant scope"
            );
          }

          const lease = leaseFromRow(row);
          if (!lease) return null;

          if (run.state === "failed" && run.version > lease.claimedRunVersion) {
            const code = run.failure?.code ?? "ORCHESTRATION_FAILED";
            const reason = run.failure?.message ?? "Orchestration failed before lease cleanup";
            const failureMessageHash = sha256Hex(reason);
            const deadLetterBase = {
              runId: run.id,
              portfolioId: run.scope.portfolioId,
              companyId: run.scope.companyId,
              leaseId: lease.id,
              workerId: lease.workerId,
              claimedRunVersion: lease.claimedRunVersion,
              claimedRecordHash: lease.claimedRecordHash,
              terminalRunVersion: run.version,
              terminalRecordHash: run.recordHash,
              attempt: lease.attempt,
              failureCode: code,
              failureMessageHash,
              deadLetteredAt: input.now,
              recoveryKind: "expired-lease-recovery" as const
            };
            const evidenceHash = sha256Hex(deadLetterBase);
            const id = `orchestration-dead-letter:${sha256Hex({
              runId: run.id,
              leaseId: lease.id
            }).slice(0, 40)}`;

            await client.query(
              `INSERT INTO orchestration_worker_dead_letters(
                 id,run_id,portfolio_id,company_id,lease_id,worker_id,
                 claimed_run_version,claimed_record_hash,terminal_run_version,terminal_record_hash,
                 attempt,failure_code,failure_message_hash,dead_lettered_at,recovery_kind,evidence_hash
               )
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
               ON CONFLICT(run_id,lease_id) DO NOTHING`,
              [
                id,
                deadLetterBase.runId,
                deadLetterBase.portfolioId,
                deadLetterBase.companyId,
                deadLetterBase.leaseId,
                deadLetterBase.workerId,
                deadLetterBase.claimedRunVersion,
                deadLetterBase.claimedRecordHash,
                deadLetterBase.terminalRunVersion,
                deadLetterBase.terminalRecordHash,
                deadLetterBase.attempt,
                deadLetterBase.failureCode,
                deadLetterBase.failureMessageHash,
                deadLetterBase.deadLetteredAt,
                deadLetterBase.recoveryKind,
                evidenceHash
              ]
            );

            await client.query(
              `UPDATE orchestration_worker_state
               SET
                 run_state=$2,
                 stage_run_version=$3,
                 stage_attempt=0,
                 consecutive_failures=0,
                 ready_at=$4,
                 lease_id=NULL,
                 lease_worker_id=NULL,
                 lease_issued_at=NULL,
                 lease_heartbeat_at=NULL,
                 lease_expires_at=NULL,
                 lease_version=lease_version+1,
                 claimed_run_version=NULL,
                 claimed_record_hash=NULL,
                 last_error_code=$5,
                 last_error_message=$6,
                 updated_at=$4
               WHERE run_id=$1 AND lease_id=$7`,
              [run.id, run.state, run.version, input.now, code, reason, lease.id]
            );

            return Object.freeze({
              runId: run.id,
              leaseId: lease.id,
              outcome: "dead-letter-recovered" as const,
              nextReadyAt: input.now,
              attempt: lease.attempt
            });
          }

          const stageAdvanced = run.version > lease.claimedRunVersion;
          const nextFailures = stageAdvanced ? 0 : row.consecutive_failures + 1;
          const delayMs = stageAdvanced
            ? 0
            : computeOrchestrationBackoffMs({
                runId: run.id,
                attempt: Math.max(1, nextFailures),
                baseDelayMs: input.retryBaseDelayMs,
                maxDelayMs: input.retryMaxDelayMs
              });
          const readyAt = new Date(nowMs + delayMs).toISOString();

          await client.query(
            `UPDATE orchestration_worker_state
             SET
               run_state=$2,
               stage_run_version=$3,
               stage_attempt=CASE WHEN $4 THEN 0 ELSE stage_attempt END,
               consecutive_failures=$5,
               ready_at=$6,
               lease_id=NULL,
               lease_worker_id=NULL,
               lease_issued_at=NULL,
               lease_heartbeat_at=NULL,
               lease_expires_at=NULL,
               lease_version=lease_version+1,
               claimed_run_version=NULL,
               claimed_record_hash=NULL,
               last_error_code=$7,
               last_error_message=$8,
               updated_at=$9
             WHERE run_id=$1 AND lease_id=$10`,
            [
              run.id,
              run.state,
              run.version,
              stageAdvanced,
              nextFailures,
              readyAt,
              stageAdvanced ? null : "LEASE_EXPIRED",
              stageAdvanced
                ? null
                : "Worker lease expired before checkpoint commit",
              input.now,
              lease.id
            ]
          );

          return Object.freeze({
            runId: run.id,
            leaseId: lease.id,
            outcome: stageAdvanced
              ? "stage-advanced-before-crash" as const
              : "retry-scheduled" as const,
            nextReadyAt: readyAt,
            attempt: lease.attempt
          });
        })
      );

      if (record) recovered.push(record);
    }

    return Object.freeze(recovered);
  }

}
