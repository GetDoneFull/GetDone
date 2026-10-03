import type { PoolClient, QueryResultRow } from "pg";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  createDeadLetterRecord,
  createDurableJobLease,
  createJobRecoveryRecord,
  createJobRetryScheduleRecord,
  createJobStoreTransactionReceipt,
  renewDurableJobLease,
  type DeadLetterRecord,
  type DurableJobLease,
  type DurableJobStore,
  type JobQueueEnvelope,
  type JobRecoveryRecord,
  type JobRetryScheduleRecord,
  type JobStoreTransactionReceipt
} from "@/lib/execution/job-runtime-contracts";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import {
  createDurableJobExecutionOutcome,
  createDurableJobRuntimeEvent,
  type DurableJobExecutionOutcomeRecord,
  type DurableJobRuntimeEventRecord
} from "@/lib/execution/job-runtime-records";

export interface DurableJobCandidate {
  envelope: JobQueueEnvelope;
  version: number;
  stateHash: string;
  attempt: number;
}

export interface DurableJobRuntimeSnapshot extends DurableJobCandidate {
  state: "queued" | "claimed" | "retry-wait" | "dead-lettered" | "cancelled" | "released";
  scheduledAt: string;
  cancelledReason?: string;
}

export interface DurableJobWorkStore extends DurableJobStore {
  listReady(input: { now: string; limit: number }): Promise<readonly DurableJobCandidate[]>;
  getRuntimeSnapshot(jobId: string): Promise<DurableJobRuntimeSnapshot | null>;
}

interface RuntimeRow extends QueryResultRow {
  job_id: string;
  envelope: JobQueueEnvelope;
  envelope_hash: string;
  runtime_state: DurableJobRuntimeSnapshot["state"];
  version: number;
  state_hash: string;
  attempt: number;
  scheduled_at: Date | string;
  cancelled_reason: string | null;
  updated_at: Date | string;
}

interface LeaseRow extends QueryResultRow {
  payload: DurableJobLease;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function runtimeHash(input: {
  jobId: string;
  envelopeHash: string;
  state: DurableJobRuntimeSnapshot["state"];
  version: number;
  attempt: number;
  scheduledAt: string;
  cancelledReason?: string;
  leaseHash?: string;
}) {
  return sha256Hex(input);
}

function candidate(row: RuntimeRow): DurableJobCandidate {
  return {
    envelope: row.envelope,
    version: row.version,
    stateHash: row.state_hash,
    attempt: row.attempt
  };
}

function snapshot(row: RuntimeRow): DurableJobRuntimeSnapshot {
  return {
    ...candidate(row),
    state: row.runtime_state,
    scheduledAt: iso(row.scheduled_at),
    cancelledReason: row.cancelled_reason ?? undefined
  };
}

async function persistTransaction(
  db: PoolClient,
  receipt: JobStoreTransactionReceipt
) {
  await db.query(
    `INSERT INTO job_runtime_transactions
      (id,job_id,operation,idempotency_key,transaction_hash,payload,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      receipt.id,
      receipt.jobId,
      receipt.operation,
      receipt.idempotencyKey,
      receipt.transactionHash,
      JSON.stringify(receipt),
      receipt.occurredAt
    ]
  );
}

async function loadTransaction(
  db: PoolClient,
  jobId: string,
  idempotencyKey: string
) {
  const result = await db.query<{ payload: JobStoreTransactionReceipt }>(
    `SELECT payload FROM job_runtime_transactions
     WHERE job_id=$1 AND idempotency_key=$2`,
    [jobId, idempotencyKey]
  );
  return result.rows[0]?.payload ?? null;
}

async function persistOutcomeAndEvent(
  db: PoolClient,
  input: {
    jobId: string;
    correlationId?: string;
    kind: DurableJobExecutionOutcomeRecord["kind"];
    runtimeState: string;
    attempt: number;
    reason?: string;
    occurredAt: string;
    transactionHash: string;
    eventType: string;
  }
) {
  const outcome = createDurableJobExecutionOutcome({
    id: crypto.randomUUID(),
    correlationId: input.correlationId,
    jobId: input.jobId,
    kind: input.kind,
    runtimeState: input.runtimeState,
    attempt: input.attempt,
    reason: input.reason,
    occurredAt: input.occurredAt,
    transactionHash: input.transactionHash
  });
  const event = createDurableJobRuntimeEvent({
    id: crypto.randomUUID(),
    jobId: input.jobId,
    eventType: input.eventType,
    attempt: input.attempt,
    occurredAt: input.occurredAt,
    transactionHash: input.transactionHash,
    outcome
  });

  await db.query(
    `INSERT INTO job_execution_outcomes
      (id,job_id,kind,runtime_state,attempt,occurred_at,transaction_hash,record_hash,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (job_id, transaction_hash) DO NOTHING`,
    [
      outcome.id, outcome.jobId, outcome.kind, outcome.runtimeState, outcome.attempt,
      outcome.occurredAt, outcome.transactionHash, outcome.recordHash, JSON.stringify(outcome)
    ]
  );
  await db.query(
    `INSERT INTO job_runtime_events
      (id,job_id,event_type,attempt,occurred_at,transaction_hash,outcome_hash,record_hash,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (job_id, transaction_hash, event_type) DO NOTHING`,
    [
      event.id, event.jobId, event.eventType, event.attempt, event.occurredAt,
      event.transactionHash, event.outcomeHash, event.recordHash, JSON.stringify(event)
    ]
  );
}

async function closeActiveLease(
  db: PoolClient,
  jobId: string,
  state: "released" | "expired" = "released"
) {
  const result = await db.query<LeaseRow>(
    `SELECT payload FROM job_leases
     WHERE job_id=$1 AND state='active'
     FOR UPDATE`,
    [jobId]
  );
  const current = result.rows[0]?.payload;
  if (!current) return null;
  const base = {
    ...current,
    state,
    version: current.version + 1
  };
  delete (base as Partial<DurableJobLease>).leaseHash;
  const next = Object.freeze({
    ...base,
    leaseHash: sha256Hex(base)
  }) as DurableJobLease;
  await db.query(
    `UPDATE job_leases
     SET state=$2,lease_hash=$3,version=$4,payload=$5::jsonb
     WHERE id=$1`,
    [next.id, state, next.leaseHash, next.version, JSON.stringify(next)]
  );
  return next;
}

export class PostgresDurableJobStore implements DurableJobWorkStore {
  readonly descriptor = Object.freeze({
    persistence: "durable-external" as const,
    atomicClaims: true,
    compareAndSwap: true,
    restartSafe: true,
    multiProcessSafe: true,
    productionEligible: true
  });

  constructor(
    private readonly database: PostgresTransactionalDatabase,
    private readonly options: {
      maxAttempts?: number;
      recoveryDelayMs?: number;
      maxQueueDepth?: number;
      maxCompanyQueueDepth?: number;
    } = {}
  ) {
    for (const [label, value] of [
      ["maxQueueDepth", options.maxQueueDepth],
      ["maxCompanyQueueDepth", options.maxCompanyQueueDepth]
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw new ControlPlaneError(
          "VALIDATION_FAILED",
          `Durable Job ${label} must be a positive integer`
        );
      }
    }
    if (
      options.maxQueueDepth !== undefined
      && options.maxCompanyQueueDepth !== undefined
      && options.maxCompanyQueueDepth >= options.maxQueueDepth
    ) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Durable Job company queue depth limit must be lower than the global queue depth limit"
      );
    }
  }

  async listReady(input: { now: string; limit: number }) {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const result = await this.database.query<RuntimeRow>(
      `WITH ready AS (
         SELECT *,
           ROW_NUMBER() OVER (
             PARTITION BY envelope->'scope'->>'companyId'
             ORDER BY scheduled_at, job_id
           ) AS company_rank
         FROM job_runtime_state
         WHERE runtime_state IN ('queued','retry-wait')
           AND scheduled_at <= $1
           AND NOT EXISTS (
             SELECT 1
             FROM job_disaster_recovery_decisions dr
             WHERE dr.job_id=job_runtime_state.job_id
               AND dr.cleared_at IS NULL
               AND dr.decision IN ('reconcile','blocked')
           )
       )
       SELECT * FROM ready
       ORDER BY company_rank, scheduled_at, job_id
       LIMIT $2`,
      [input.now, limit]
    );
    return result.rows.map(candidate);
  }

  async getRuntimeSnapshot(jobId: string) {
    const result = await this.database.query<RuntimeRow>(
      "SELECT * FROM job_runtime_state WHERE job_id=$1",
      [jobId]
    );
    return result.rows[0] ? snapshot(result.rows[0]) : null;
  }

  async listExecutionOutcomes(jobId: string): Promise<readonly DurableJobExecutionOutcomeRecord[]> {
    const result = await this.database.query<{ payload: DurableJobExecutionOutcomeRecord }>(
      "SELECT payload FROM job_execution_outcomes WHERE job_id=$1 ORDER BY occurred_at,id",
      [jobId]
    );
    return result.rows.map((row) => row.payload);
  }

  async listRuntimeEvents(jobId: string): Promise<readonly DurableJobRuntimeEventRecord[]> {
    const result = await this.database.query<{ payload: DurableJobRuntimeEventRecord }>(
      "SELECT payload FROM job_runtime_events WHERE job_id=$1 ORDER BY occurred_at,id",
      [jobId]
    );
    return result.rows.map((row) => row.payload);
  }

  async enqueue(envelope: JobQueueEnvelope) {
    return this.database.transaction(async (db) => {
      const existing = await db.query<RuntimeRow>(
        "SELECT * FROM job_runtime_state WHERE job_id=$1 FOR UPDATE",
        [envelope.jobId]
      );
      if (existing.rows[0]) {
        const prior = await loadTransaction(db, envelope.jobId, envelope.idempotencyKey);
        if (
          prior
          && existing.rows[0].envelope_hash === envelope.envelopeHash
        ) {
          return { status: "idempotent-replay" as const, transaction: prior };
        }
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "Durable Job enqueue conflicts with existing runtime state"
        );
      }

      if (
        this.options.maxQueueDepth !== undefined
        || this.options.maxCompanyQueueDepth !== undefined
      ) {
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          ["getdone:durable-job-queue:admission"]
        );
        const depth = await db.query<{
          global_depth: string | number;
          company_depth: string | number;
        }>(
          `SELECT
             COUNT(*) FILTER (
               WHERE runtime_state IN ('queued','retry-wait')
             ) AS global_depth,
             COUNT(*) FILTER (
               WHERE runtime_state IN ('queued','retry-wait')
                 AND envelope->'scope'->>'companyId'=$1
             ) AS company_depth
           FROM job_runtime_state`,
          [envelope.scope.companyId]
        );
        const globalDepth = Number(depth.rows[0]?.global_depth ?? 0);
        const companyDepth = Number(depth.rows[0]?.company_depth ?? 0);

        if (
          this.options.maxQueueDepth !== undefined
          && globalDepth >= this.options.maxQueueDepth
        ) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Durable Job queue is saturated",
            {
              details: {
                reason: "QUEUE_SATURATED",
                scope: "global",
                depth: globalDepth,
                limit: this.options.maxQueueDepth,
                retryable: true
              }
            }
          );
        }
        if (
          this.options.maxCompanyQueueDepth !== undefined
          && companyDepth >= this.options.maxCompanyQueueDepth
        ) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Company durable Job queue is saturated",
            {
              details: {
                reason: "QUEUE_SATURATED",
                scope: "company",
                companyId: envelope.scope.companyId,
                depth: companyDepth,
                limit: this.options.maxCompanyQueueDepth,
                retryable: true
              }
            }
          );
        }
      }

      const expectedHash = sha256Hex({ jobId: envelope.jobId, state: "absent" });
      const nextVersion = 1;
      const nextHash = runtimeHash({
        jobId: envelope.jobId,
        envelopeHash: envelope.envelopeHash,
        state: "queued",
        version: nextVersion,
        attempt: 0,
        scheduledAt: envelope.scheduledAt
      });
      const receipt = createJobStoreTransactionReceipt({
        id: crypto.randomUUID(),
        operation: "enqueue",
        jobId: envelope.jobId,
        idempotencyKey: envelope.idempotencyKey,
        expectedVersion: 0,
        expectedHash,
        nextVersion,
        nextHash,
        occurredAt: envelope.createdAt
      });

      await db.query(
        `INSERT INTO job_runtime_state
          (job_id,envelope,envelope_hash,runtime_state,version,state_hash,attempt,scheduled_at,updated_at)
         VALUES($1,$2::jsonb,$3,'queued',$4,$5,0,$6,$7)`,
        [
          envelope.jobId,
          JSON.stringify(envelope),
          envelope.envelopeHash,
          nextVersion,
          nextHash,
          envelope.scheduledAt,
          envelope.createdAt
        ]
      );
      await persistTransaction(db, receipt);
      return { status: "enqueued" as const, transaction: receipt };
    });
  }

  async claimAtomic(input: {
    jobId: string;
    workerId: string;
    now: string;
    leaseSeconds: number;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
  }) {
    return this.database.transaction(async (db) => {
      const result = await db.query<RuntimeRow>(
        "SELECT * FROM job_runtime_state WHERE job_id=$1 FOR UPDATE",
        [input.jobId]
      );
      const row = result.rows[0];
      if (
        !row
        || !["queued", "retry-wait"].includes(row.runtime_state)
        || Date.parse(iso(row.scheduled_at)) > Date.parse(input.now)
        || row.version !== input.expectedJobVersion
        || row.state_hash !== input.expectedJobHash
      ) return null;

      const prior = await loadTransaction(db, input.jobId, input.idempotencyKey);
      if (prior) return null;

      const lease = createDurableJobLease({
        id: crypto.randomUUID(),
        jobId: input.jobId,
        workerId: input.workerId,
        attempt: row.attempt + 1,
        leaseIssuedAt: input.now,
        leaseSeconds: input.leaseSeconds
      });
      const nextVersion = row.version + 1;
      const nextHash = runtimeHash({
        jobId: row.job_id,
        envelopeHash: row.envelope_hash,
        state: "claimed",
        version: nextVersion,
        attempt: lease.attempt,
        scheduledAt: iso(row.scheduled_at),
        leaseHash: lease.leaseHash
      });
      const receipt = createJobStoreTransactionReceipt({
        id: crypto.randomUUID(),
        operation: "claim",
        jobId: input.jobId,
        idempotencyKey: input.idempotencyKey,
        expectedVersion: row.version,
        expectedHash: row.state_hash,
        nextVersion,
        nextHash,
        occurredAt: input.now
      });

      await db.query(
        `UPDATE job_runtime_state
         SET runtime_state='claimed', version=$2, state_hash=$3, attempt=$4, updated_at=$5
         WHERE job_id=$1`,
        [input.jobId, nextVersion, nextHash, lease.attempt, input.now]
      );
      await db.query(
        `INSERT INTO job_leases
          (id,job_id,worker_id,state,expires_at,lease_hash,version,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          lease.id, lease.jobId, lease.workerId, lease.state, lease.expiresAt,
          lease.leaseHash, lease.version, JSON.stringify(lease)
        ]
      );
      await persistTransaction(db, receipt);
      return { lease, transaction: receipt };
    });
  }

  async heartbeat(input: {
    lease: DurableJobLease;
    now: string;
    extendSeconds: number;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
  }) {
    return this.database.transaction(async (db) => {
      const runtime = await db.query<RuntimeRow>(
        "SELECT * FROM job_runtime_state WHERE job_id=$1 FOR UPDATE",
        [input.lease.jobId]
      );
      const row = runtime.rows[0];
      if (
        !row
        || row.runtime_state !== "claimed"
        || row.version !== input.expectedJobVersion
        || row.state_hash !== input.expectedJobHash
      ) {
        throw new ControlPlaneError("CONFLICT", "Job heartbeat lost its runtime compare-and-swap");
      }
      const leaseResult = await db.query<LeaseRow>(
        "SELECT payload FROM job_leases WHERE id=$1 FOR UPDATE",
        [input.lease.id]
      );
      const persisted = leaseResult.rows[0]?.payload;
      if (!persisted || persisted.leaseHash !== input.lease.leaseHash) {
        throw new ControlPlaneError("CONFLICT", "Job heartbeat lease is stale");
      }
      const lease = renewDurableJobLease(persisted, {
        now: input.now,
        extendSeconds: input.extendSeconds
      });
      const nextVersion = row.version + 1;
      const nextHash = runtimeHash({
        jobId: row.job_id,
        envelopeHash: row.envelope_hash,
        state: "claimed",
        version: nextVersion,
        attempt: row.attempt,
        scheduledAt: iso(row.scheduled_at),
        leaseHash: lease.leaseHash
      });
      const receipt = createJobStoreTransactionReceipt({
        id: crypto.randomUUID(),
        operation: "heartbeat",
        jobId: row.job_id,
        idempotencyKey: input.idempotencyKey,
        expectedVersion: row.version,
        expectedHash: row.state_hash,
        nextVersion,
        nextHash,
        occurredAt: input.now
      });

      await db.query(
        "UPDATE job_runtime_state SET version=$2,state_hash=$3,updated_at=$4 WHERE job_id=$1",
        [row.job_id, nextVersion, nextHash, input.now]
      );
      await db.query(
        `UPDATE job_leases
         SET expires_at=$2,lease_hash=$3,version=$4,payload=$5::jsonb
         WHERE id=$1`,
        [lease.id, lease.expiresAt, lease.leaseHash, lease.version, JSON.stringify(lease)]
      );
      await persistTransaction(db, receipt);
      return { lease, transaction: receipt };
    });
  }

  async release(input: {
    lease: DurableJobLease;
    now: string;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
    outcomeKind: "provider-completed" | "verified";
  }) {
    return this.database.transaction(async (db) => {
      const runtime = await db.query<RuntimeRow>(
        "SELECT * FROM job_runtime_state WHERE job_id=$1 FOR UPDATE",
        [input.lease.jobId]
      );
      const row = runtime.rows[0];
      if (
        !row
        || row.version !== input.expectedJobVersion
        || row.state_hash !== input.expectedJobHash
      ) {
        throw new ControlPlaneError("CONFLICT", "Job release lost its runtime compare-and-swap");
      }
      const leaseResult = await db.query<LeaseRow>(
        "SELECT payload FROM job_leases WHERE id=$1 FOR UPDATE",
        [input.lease.id]
      );
      const persisted = leaseResult.rows[0]?.payload;
      if (!persisted || persisted.leaseHash !== input.lease.leaseHash) {
        throw new ControlPlaneError("CONFLICT", "Job release lease is stale");
      }
      const leaseBase = {
        ...persisted,
        state: "released" as const,
        version: persisted.version + 1
      };
      delete (leaseBase as Partial<DurableJobLease>).leaseHash;
      const releasedLease = Object.freeze({
        ...leaseBase,
        leaseHash: sha256Hex(leaseBase)
      }) as DurableJobLease;
      const nextVersion = row.version + 1;
      const nextHash = runtimeHash({
        jobId: row.job_id,
        envelopeHash: row.envelope_hash,
        state: "released",
        version: nextVersion,
        attempt: row.attempt,
        scheduledAt: iso(row.scheduled_at),
        leaseHash: releasedLease.leaseHash
      });
      const receipt = createJobStoreTransactionReceipt({
        id: crypto.randomUUID(),
        operation: "release",
        jobId: row.job_id,
        idempotencyKey: input.idempotencyKey,
        expectedVersion: row.version,
        expectedHash: row.state_hash,
        nextVersion,
        nextHash,
        occurredAt: input.now
      });

      await db.query(
        `UPDATE job_runtime_state
         SET runtime_state='released',version=$2,state_hash=$3,updated_at=$4
         WHERE job_id=$1`,
        [row.job_id, nextVersion, nextHash, input.now]
      );
      await db.query(
        `UPDATE job_leases
         SET state='released',lease_hash=$2,version=$3,payload=$4::jsonb
         WHERE id=$1`,
        [releasedLease.id, releasedLease.leaseHash, releasedLease.version, JSON.stringify(releasedLease)]
      );
      await persistTransaction(db, receipt);
      await persistOutcomeAndEvent(db, {
        jobId: row.job_id,
        correlationId: row.envelope.correlationId,
        kind: input.outcomeKind,
        runtimeState: "released",
        attempt: row.attempt,
        occurredAt: input.now,
        transactionHash: receipt.transactionHash,
        eventType: input.outcomeKind === "verified"
          ? "job.verified"
          : "job.provider-completed"
      });
      return receipt;
    });
  }

  async scheduleRetry(record: JobRetryScheduleRecord) {
    return this.database.transaction(async (db) => {
      const runtime = await db.query<RuntimeRow>(
        "SELECT * FROM job_runtime_state WHERE job_id=$1 FOR UPDATE",
        [record.jobId]
      );
      const row = runtime.rows[0];
      if (!row || row.envelope_hash !== record.sourceEnvelopeHash) {
        throw new ControlPlaneError("CONFLICT", "Retry lineage does not match durable Job envelope");
      }
      const nextVersion = row.version + 1;
      const nextHash = runtimeHash({
        jobId: row.job_id,
        envelopeHash: row.envelope_hash,
        state: "retry-wait",
        version: nextVersion,
        attempt: row.attempt,
        scheduledAt: record.runAt
      });
      const receipt = createJobStoreTransactionReceipt({
        id: crypto.randomUUID(),
        operation: "retry",
        jobId: row.job_id,
        idempotencyKey: record.id,
        expectedVersion: row.version,
        expectedHash: row.state_hash,
        nextVersion,
        nextHash,
        occurredAt: new Date().toISOString()
      });

      await db.query(
        `INSERT INTO job_retry_schedule(id,job_id,run_at,record_hash,payload)
         VALUES($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [record.id, record.jobId, record.runAt, record.recordHash, JSON.stringify(record)]
      );
      await closeActiveLease(db, row.job_id);
      await db.query(
        `UPDATE job_runtime_state
         SET runtime_state='retry-wait',version=$2,state_hash=$3,scheduled_at=$4,updated_at=$5
         WHERE job_id=$1`,
        [row.job_id, nextVersion, nextHash, record.runAt, receipt.occurredAt]
      );
      await persistTransaction(db, receipt);
      await persistOutcomeAndEvent(db, {
        jobId: row.job_id,
        correlationId: row.envelope.correlationId,
        kind: "retry-scheduled",
        runtimeState: "retry-wait",
        attempt: row.attempt,
        reason: record.reason,
        occurredAt: receipt.occurredAt,
        transactionHash: receipt.transactionHash,
        eventType: "job.retry-scheduled"
      });
      return receipt;
    });
  }

  async deadLetter(record: DeadLetterRecord) {
    return this.database.transaction(async (db) => {
      const runtime = await db.query<RuntimeRow>(
        "SELECT * FROM job_runtime_state WHERE job_id=$1 FOR UPDATE",
        [record.jobId]
      );
      const row = runtime.rows[0];
      if (!row || row.envelope_hash !== record.sourceEnvelopeHash) {
        throw new ControlPlaneError("CONFLICT", "Dead-letter lineage does not match durable Job envelope");
      }
      const nextVersion = row.version + 1;
      const nextHash = runtimeHash({
        jobId: row.job_id,
        envelopeHash: row.envelope_hash,
        state: "dead-lettered",
        version: nextVersion,
        attempt: row.attempt,
        scheduledAt: iso(row.scheduled_at)
      });
      const receipt = createJobStoreTransactionReceipt({
        id: crypto.randomUUID(),
        operation: "dead-letter",
        jobId: row.job_id,
        idempotencyKey: record.id,
        expectedVersion: row.version,
        expectedHash: row.state_hash,
        nextVersion,
        nextHash,
        occurredAt: record.failedAt
      });
      await db.query(
        `INSERT INTO job_dead_letters(id,job_id,failed_at,record_hash,payload)
         VALUES($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (job_id) DO NOTHING`,
        [record.id, record.jobId, record.failedAt, record.recordHash, JSON.stringify(record)]
      );
      await closeActiveLease(db, row.job_id);
      await db.query(
        `UPDATE job_runtime_state
         SET runtime_state='dead-lettered',version=$2,state_hash=$3,updated_at=$4
         WHERE job_id=$1`,
        [row.job_id, nextVersion, nextHash, record.failedAt]
      );
      await persistTransaction(db, receipt);
      await persistOutcomeAndEvent(db, {
        jobId: row.job_id,
        correlationId: row.envelope.correlationId,
        kind: "dead-lettered",
        runtimeState: "dead-lettered",
        attempt: row.attempt,
        reason: record.reason,
        occurredAt: record.failedAt,
        transactionHash: receipt.transactionHash,
        eventType: "job.dead-lettered"
      });
      return receipt;
    });
  }

  async cancel(input: {
    jobId: string;
    reason: string;
    cancelledAt: string;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
  }) {
    return this.database.transaction(async (db) => {
      const runtime = await db.query<RuntimeRow>(
        "SELECT * FROM job_runtime_state WHERE job_id=$1 FOR UPDATE",
        [input.jobId]
      );
      const row = runtime.rows[0];
      if (
        !row
        || row.version !== input.expectedJobVersion
        || row.state_hash !== input.expectedJobHash
      ) {
        throw new ControlPlaneError("CONFLICT", "Job cancellation lost its runtime compare-and-swap");
      }
      const nextVersion = row.version + 1;
      const nextHash = runtimeHash({
        jobId: row.job_id,
        envelopeHash: row.envelope_hash,
        state: "cancelled",
        version: nextVersion,
        attempt: row.attempt,
        scheduledAt: iso(row.scheduled_at),
        cancelledReason: input.reason
      });
      const receipt = createJobStoreTransactionReceipt({
        id: crypto.randomUUID(),
        operation: "cancel",
        jobId: input.jobId,
        idempotencyKey: input.idempotencyKey,
        expectedVersion: row.version,
        expectedHash: row.state_hash,
        nextVersion,
        nextHash,
        occurredAt: input.cancelledAt
      });

      await db.query(
        `UPDATE job_runtime_state
         SET runtime_state='cancelled',cancelled_reason=$2,version=$3,state_hash=$4,updated_at=$5
         WHERE job_id=$1`,
        [input.jobId, input.reason, nextVersion, nextHash, input.cancelledAt]
      );
      await closeActiveLease(db, input.jobId);
      await persistTransaction(db, receipt);
      await persistOutcomeAndEvent(db, {
        jobId: row.job_id,
        correlationId: row.envelope.correlationId,
        kind: "cancelled",
        runtimeState: "cancelled",
        attempt: row.attempt,
        reason: input.reason,
        occurredAt: input.cancelledAt,
        transactionHash: receipt.transactionHash,
        eventType: "job.execution-cancelled"
      });
      return receipt;
    });
  }

  async recoverExpired(input: { now: string; limit: number }): Promise<readonly JobRecoveryRecord[]> {
    return this.database.transaction(async (db) => {
      const maxAttempts = this.options.maxAttempts ?? 5;
      const recoveryDelayMs = this.options.recoveryDelayMs ?? 5_000;
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
      const result = await db.query<RuntimeRow & { lease_payload: DurableJobLease }>(
        `SELECT r.*, l.payload AS lease_payload
         FROM job_runtime_state r
         JOIN job_leases l ON l.job_id=r.job_id
         WHERE l.state='active' AND l.expires_at <= $1
           AND NOT EXISTS (
             SELECT 1
             FROM job_disaster_recovery_decisions dr
             WHERE dr.job_id=r.job_id
               AND dr.cleared_at IS NULL
               AND dr.decision IN ('reconcile','blocked')
           )
         ORDER BY l.expires_at
         FOR UPDATE OF r,l SKIP LOCKED
         LIMIT $2`,
        [input.now, limit]
      );
      const recovered: JobRecoveryRecord[] = [];

      for (const row of result.rows) {
        const expiredLease = row.lease_payload;
        const outcome: JobRecoveryRecord["outcome"] =
          row.runtime_state === "cancelled"
            ? "cancelled"
            : row.attempt >= maxAttempts
              ? "dead-lettered"
              : "retry-scheduled";
        const nextState: DurableJobRuntimeSnapshot["state"] =
          outcome === "cancelled"
            ? "cancelled"
            : outcome === "dead-lettered"
              ? "dead-lettered"
              : "retry-wait";
        const runAt = new Date(Date.parse(input.now) + recoveryDelayMs).toISOString();
        const nextVersion = row.version + 1;
        const nextHash = runtimeHash({
          jobId: row.job_id,
          envelopeHash: row.envelope_hash,
          state: nextState,
          version: nextVersion,
          attempt: row.attempt,
          scheduledAt: outcome === "retry-scheduled" ? runAt : iso(row.scheduled_at),
          cancelledReason: row.cancelled_reason ?? undefined
        });
        const receipt = createJobStoreTransactionReceipt({
          id: crypto.randomUUID(),
          operation: "recover-expired",
          jobId: row.job_id,
          idempotencyKey: `recovery:${expiredLease.id}`,
          expectedVersion: row.version,
          expectedHash: row.state_hash,
          nextVersion,
          nextHash,
          occurredAt: input.now
        });

        const expiredBase = {
          ...expiredLease,
          state: "expired" as const,
          version: expiredLease.version + 1
        };
        delete (expiredBase as Partial<DurableJobLease>).leaseHash;
        const expired = {
          ...expiredBase,
          leaseHash: sha256Hex(expiredBase)
        } as DurableJobLease;

        await db.query(
          `UPDATE job_leases
           SET state='expired',lease_hash=$2,version=$3,payload=$4::jsonb
           WHERE id=$1`,
          [expired.id, expired.leaseHash, expired.version, JSON.stringify(expired)]
        );
        await db.query(
          `UPDATE job_runtime_state
           SET runtime_state=$2,version=$3,state_hash=$4,scheduled_at=$5,updated_at=$6
           WHERE job_id=$1`,
          [
            row.job_id,
            nextState,
            nextVersion,
            nextHash,
            outcome === "retry-scheduled" ? runAt : row.scheduled_at,
            input.now
          ]
        );
        await persistTransaction(db, receipt);
        await persistOutcomeAndEvent(db, {
          jobId: row.job_id,
          correlationId: row.envelope.correlationId,
          kind: outcome === "retry-scheduled"
            ? "retry-scheduled"
            : outcome === "dead-lettered"
              ? "dead-lettered"
              : "cancelled",
          runtimeState: nextState,
          attempt: row.attempt,
          reason: "expired worker lease recovered",
          occurredAt: input.now,
          transactionHash: receipt.transactionHash,
          eventType: `job.recovered.${outcome}`
        });

        if (outcome === "retry-scheduled") {
          const retry = createJobRetryScheduleRecord({
            id: crypto.randomUUID(),
            jobId: row.job_id,
            nextAttempt: row.attempt + 1,
            runAt,
            reason: "expired worker lease recovered",
            sourceEnvelopeHash: row.envelope_hash,
            transactionHash: receipt.transactionHash
          });
          await db.query(
            `INSERT INTO job_retry_schedule(id,job_id,run_at,record_hash,payload)
             VALUES($1,$2,$3,$4,$5::jsonb)`,
            [retry.id, retry.jobId, retry.runAt, retry.recordHash, JSON.stringify(retry)]
          );
        } else if (outcome === "dead-lettered") {
          const dead = createDeadLetterRecord({
            id: crypto.randomUUID(),
            jobId: row.job_id,
            finalAttempt: row.attempt,
            reason: "maximum attempts reached during expired-lease recovery",
            failedAt: input.now,
            sourceEnvelopeHash: row.envelope_hash,
            transactionHash: receipt.transactionHash
          });
          await db.query(
            `INSERT INTO job_dead_letters(id,job_id,failed_at,record_hash,payload)
             VALUES($1,$2,$3,$4,$5::jsonb)
             ON CONFLICT (job_id) DO NOTHING`,
            [dead.id, dead.jobId, dead.failedAt, dead.recordHash, JSON.stringify(dead)]
          );
        }

        const recovery = createJobRecoveryRecord({
          id: crypto.randomUUID(),
          jobId: row.job_id,
          expiredLeaseHash: expiredLease.leaseHash,
          outcome,
          recoveredAt: input.now,
          transactionHash: receipt.transactionHash
        });
        await db.query(
          `INSERT INTO job_recovery_records(id,job_id,recovered_at,record_hash,payload)
           VALUES($1,$2,$3,$4,$5::jsonb)`,
          [recovery.id, recovery.jobId, recovery.recoveredAt, recovery.recordHash, JSON.stringify(recovery)]
        );
        recovered.push(recovery);
      }
      return recovered;
    });
  }
}
