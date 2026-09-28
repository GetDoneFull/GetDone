import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  OrchestrationCheckpoints,
  OrchestrationRunRecord,
  OrchestrationRunStore,
  OrchestrationRunStoreDescriptor,
  OrchestrationState
} from "@/lib/orchestration/contracts";
import {
  assertOrchestrationRunIntegrity,
  canTransitionOrchestration,
  isOrchestrationWorkerResumable
} from "@/lib/orchestration/contracts";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";

export const POSTGRES_ORCHESTRATION_STORE_VERSION = "1.0.0";

const DEFAULT_RESUMABLE_STATES = Object.freeze<readonly OrchestrationState[]>([
  "accepted",
  "context-ready",
  "planning",
  "planned",
  "validated",
  "policy-evaluated",
  "authorized",
  "tasks-created",
  "jobs-enqueued",
  "executing",
  "verifying"
]);

export interface OrchestrationTransitionReceipt {
  id: string;
  runId: string;
  portfolioId: string;
  companyId: string;
  idempotencyKey: string;
  fromState: OrchestrationState;
  toState: OrchestrationState;
  expectedVersion: number;
  nextVersion: number;
  expectedRecordHash: string;
  nextRecordHash: string;
  checkpointHash: string;
  occurredAt: string;
  result: OrchestrationRunRecord;
  transitionHash: string;
}

function requireKey(value: string, label: string) {
  if (!value.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is required`);
  }
  return value;
}

function checkpointHash(checkpoints: OrchestrationCheckpoints) {
  return sha256Hex(checkpoints);
}

function transitionId(runId: string, version: number) {
  return `orchestration-transition:${runId}:v${version}`;
}

function checkpointId(runId: string, version: number) {
  return `orchestration-checkpoint:${runId}:v${version}`;
}

function receiptBase(input: {
  current: OrchestrationRunRecord;
  next: OrchestrationRunRecord;
  idempotencyKey: string;
}) {
  return {
    id: transitionId(input.next.id, input.next.version),
    runId: input.next.id,
    portfolioId: input.next.scope.portfolioId,
    companyId: input.next.scope.companyId,
    idempotencyKey: input.idempotencyKey,
    fromState: input.current.state,
    toState: input.next.state,
    expectedVersion: input.current.version,
    nextVersion: input.next.version,
    expectedRecordHash: input.current.recordHash,
    nextRecordHash: input.next.recordHash,
    checkpointHash: checkpointHash(input.next.checkpoints),
    occurredAt: input.next.updatedAt,
    result: input.next
  };
}

export function createOrchestrationTransitionReceipt(input: {
  current: OrchestrationRunRecord;
  next: OrchestrationRunRecord;
  idempotencyKey: string;
}): OrchestrationTransitionReceipt {
  requireKey(input.idempotencyKey, "orchestration transition idempotency key");
  assertOrchestrationRunIntegrity(input.current);
  assertOrchestrationRunIntegrity(input.next);

  if (input.current.id !== input.next.id) {
    throw new ControlPlaneError("FORBIDDEN", "Orchestration CAS cannot change run identity");
  }
  if (
    input.current.correlationId !== input.next.correlationId
    || input.current.scope.portfolioId !== input.next.scope.portfolioId
    || input.current.scope.companyId !== input.next.scope.companyId
    || input.current.scope.userId !== input.next.scope.userId
    || input.current.scope.environment !== input.next.scope.environment
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Orchestration CAS cannot change correlation or trusted scope"
    );
  }
  if (input.next.version !== input.current.version + 1) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Orchestration CAS must advance the version exactly once"
    );
  }

  if (!canTransitionOrchestration(input.current.state, input.next.state)) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Invalid orchestration CAS transition: ${input.current.state} -> ${input.next.state}`
    );
  }

  const base = receiptBase(input);
  return Object.freeze({ ...base, transitionHash: sha256Hex(base) });
}

export function orchestrationTransitionIdempotencyKey(
  run: Pick<OrchestrationRunRecord, "id" | "version" | "state">,
  to: OrchestrationState
) {
  return `orchestration:${run.id}:v${run.version}:${run.state}->${to}`;
}

export const POSTGRES_ORCHESTRATION_STORE_DESCRIPTOR:
  OrchestrationRunStoreDescriptor = Object.freeze({
    persistence: "durable-external",
    compareAndSwap: true,
    uniqueCorrelationId: true,
    restartSafe: true,
    multiProcessSafe: true,
    productionEligible: true
  });

interface RunRow {
  payload: OrchestrationRunRecord;
  start_idempotency_key: string;
  record_hash: string;
}

interface ReceiptRow {
  payload: OrchestrationTransitionReceipt;
  expected_record_hash: string;
  next_record_hash: string;
}

export class PostgresOrchestrationRunStore implements OrchestrationRunStore {
  readonly descriptor = POSTGRES_ORCHESTRATION_STORE_DESCRIPTOR;

  constructor(private readonly db: PostgresTransactionalDatabase) {}

  private async insertCheckpoint(
    client: SqlQueryable,
    record: OrchestrationRunRecord
  ) {
    const hash = checkpointHash(record.checkpoints);
    try {
      await client.query(
        `INSERT INTO orchestration_checkpoints
          (id,run_id,portfolio_id,company_id,run_version,state,checkpoint_hash,payload,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [
          checkpointId(record.id, record.version),
          record.id,
          record.scope.portfolioId,
          record.scope.companyId,
          record.version,
          record.state,
          hash,
          JSON.stringify(record.checkpoints),
          record.updatedAt
        ]
      );
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && "code" in error
        && (error as { code?: string }).code === "23505"
      ) {
        const existing = await client.query<{
          checkpoint_hash: string;
          payload: OrchestrationCheckpoints;
        }>(
          `SELECT checkpoint_hash,payload
           FROM orchestration_checkpoints
           WHERE run_id=$1 AND run_version=$2`,
          [record.id, record.version]
        );
        const prior = existing.rows[0];
        if (
          prior?.checkpoint_hash === hash
          && sha256Hex(prior.payload) === hash
        ) {
          return;
        }
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "Orchestration checkpoint version already exists with different content"
        );
      }
      throw error;
    }
  }

  async create(record: OrchestrationRunRecord, idempotencyKey: string) {
    return this.db.transaction((client) =>
      this.createInTransaction(client, record, idempotencyKey)
    );
  }

  async createInTransaction(
    client: SqlQueryable,
    record: OrchestrationRunRecord,
    idempotencyKey: string
  ) {
    requireKey(idempotencyKey, "orchestration start idempotency key");
    assertOrchestrationRunIntegrity(record);

    if (record.state !== "accepted" || record.version !== 1) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "New orchestration runs must start at accepted version 1"
      );
    }

    const inserted = await client.query(
      `INSERT INTO orchestration_runs
        (
          id,correlation_id,portfolio_id,company_id,user_id,environment,
          source_type,source_id,source_hash,state,authority,version,attempt,
          start_idempotency_key,record_hash,checkpoints,payload,created_at,updated_at
        )
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19
       )
       ON CONFLICT DO NOTHING`,
      [
        record.id,
        record.correlationId,
        record.scope.portfolioId,
        record.scope.companyId,
        record.scope.userId,
        record.scope.environment,
        record.source.type,
        record.source.id,
        record.source.sourceHash,
        record.state,
        record.authority,
        record.version,
        record.attempt,
        idempotencyKey,
        record.recordHash,
        JSON.stringify(record.checkpoints),
        JSON.stringify(record),
        record.createdAt,
        record.updatedAt
      ]
    );

    if (inserted.rowCount === 1) {
      await this.insertCheckpoint(client, record);
      await client.query(
        `INSERT INTO orchestration_worker_state
          (
            run_id,portfolio_id,company_id,stage_run_version,stage_attempt,
            consecutive_failures,ready_at,lease_version,updated_at
          )
         VALUES($1,$2,$3,$4,0,0,$5,0,$5)`,
        [
          record.id,
          record.scope.portfolioId,
          record.scope.companyId,
          record.version,
          record.updatedAt
        ]
      );
      return { status: "created" as const, record };
    }

    const existing = await client.query<RunRow>(
      `SELECT payload,start_idempotency_key,record_hash
       FROM orchestration_runs
       WHERE portfolio_id=$1
         AND company_id=$2
         AND (
           start_idempotency_key=$3
           OR correlation_id=$4
           OR id=$5
         )
       FOR UPDATE`,
      [
        record.scope.portfolioId,
        record.scope.companyId,
        idempotencyKey,
        record.correlationId,
        record.id
      ]
    );

    const prior = existing.rows[0];
    if (
      prior
      && prior.start_idempotency_key === idempotencyKey
      && prior.record_hash === record.recordHash
      && prior.payload.correlationId === record.correlationId
    ) {
      assertOrchestrationRunIntegrity(prior.payload);
      return { status: "idempotent-replay" as const, record: prior.payload };
    }

    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Orchestration start conflicts with an existing run, correlation, or idempotency key",
      { correlationId: record.correlationId }
    );
  }

  async get(id: string): Promise<OrchestrationRunRecord | null> {
    const result = await this.db.query<{ payload: OrchestrationRunRecord }>(
      "SELECT payload FROM orchestration_runs WHERE id=$1",
      [id]
    );
    const record = result.rows[0]?.payload ?? null;
    if (record) assertOrchestrationRunIntegrity(record);
    return record;
  }

  async getByCorrelationId(
    correlationId: string
  ): Promise<OrchestrationRunRecord | null> {
    const result = await this.db.query<{ payload: OrchestrationRunRecord }>(
      "SELECT payload FROM orchestration_runs WHERE correlation_id=$1",
      [correlationId]
    );
    const record = result.rows[0]?.payload ?? null;
    if (record) assertOrchestrationRunIntegrity(record);
    return record;
  }

  async compareAndSwap(
    next: OrchestrationRunRecord,
    input: {
      expectedVersion: number;
      expectedRecordHash: string;
      idempotencyKey: string;
    }
  ) {
    requireKey(input.idempotencyKey, "orchestration transition idempotency key");
    assertOrchestrationRunIntegrity(next);

    if (next.version !== input.expectedVersion + 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Orchestration CAS next version must be expected version plus one",
        { correlationId: next.correlationId }
      );
    }

    return this.db.transaction(async (client) => {
      const priorReceipt = await client.query<ReceiptRow>(
        `SELECT payload,expected_record_hash,next_record_hash
         FROM orchestration_transition_receipts
         WHERE run_id=$1 AND idempotency_key=$2
         FOR UPDATE`,
        [next.id, input.idempotencyKey]
      );

      const replay = priorReceipt.rows[0];
      if (replay) {
        if (
          replay.expected_record_hash !== input.expectedRecordHash
          || replay.next_record_hash !== next.recordHash
          || replay.payload.transitionHash !== sha256Hex({
            ...replay.payload,
            transitionHash: undefined
          })
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Orchestration transition idempotency key was reused with different content",
            { correlationId: next.correlationId }
          );
        }
        assertOrchestrationRunIntegrity(replay.payload.result);
        return replay.payload.result;
      }

      const currentResult = await client.query<{ payload: OrchestrationRunRecord }>(
        `SELECT payload
         FROM orchestration_runs
         WHERE id=$1
         FOR UPDATE`,
        [next.id]
      );
      const current = currentResult.rows[0]?.payload;
      if (!current) {
        throw new ControlPlaneError(
          "NOT_FOUND",
          "Orchestration run was not found",
          { correlationId: next.correlationId }
        );
      }
      assertOrchestrationRunIntegrity(current);

      if (
        current.version !== input.expectedVersion
        || current.recordHash !== input.expectedRecordHash
      ) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Orchestration run changed before compare-and-swap persistence",
          {
            correlationId: next.correlationId,
            details: {
              expectedVersion: input.expectedVersion,
              actualVersion: current.version
            }
          }
        );
      }

      const receipt = createOrchestrationTransitionReceipt({
        current,
        next,
        idempotencyKey: input.idempotencyKey
      });

      const updated = await client.query(
        `UPDATE orchestration_runs
         SET
           state=$2,
           version=$3,
           attempt=$4,
           record_hash=$5,
           checkpoints=$6::jsonb,
           payload=$7::jsonb,
           updated_at=$8
         WHERE id=$1
           AND version=$9
           AND record_hash=$10`,
        [
          next.id,
          next.state,
          next.version,
          next.attempt,
          next.recordHash,
          JSON.stringify(next.checkpoints),
          JSON.stringify(next),
          next.updatedAt,
          input.expectedVersion,
          input.expectedRecordHash
        ]
      );

      if (updated.rowCount !== 1) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Orchestration run changed during compare-and-swap persistence",
          { correlationId: next.correlationId }
        );
      }

      await this.insertCheckpoint(client, next);

      await client.query(
        `INSERT INTO orchestration_transition_receipts
          (
            id,run_id,portfolio_id,company_id,idempotency_key,from_state,to_state,
            expected_version,next_version,expected_record_hash,next_record_hash,
            checkpoint_hash,occurred_at,payload
          )
         VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb
         )`,
        [
          receipt.id,
          receipt.runId,
          receipt.portfolioId,
          receipt.companyId,
          receipt.idempotencyKey,
          receipt.fromState,
          receipt.toState,
          receipt.expectedVersion,
          receipt.nextVersion,
          receipt.expectedRecordHash,
          receipt.nextRecordHash,
          receipt.checkpointHash,
          receipt.occurredAt,
          JSON.stringify(receipt)
        ]
      );

      return next;
    });
  }

  async listResumable(input: {
    limit: number;
    states?: readonly OrchestrationState[];
  }): Promise<readonly OrchestrationRunRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Orchestration recovery limit must be an integer from 1 to 500"
      );
    }

    const states = input.states?.length
      ? [...new Set(input.states)]
      : [...DEFAULT_RESUMABLE_STATES];

    if (states.some((state) => state === "awaiting-decision")) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "awaiting-decision is resumed only by an authoritative Decision event"
      );
    }

    const result = await this.db.query<{ payload: OrchestrationRunRecord }>(
      `SELECT payload
       FROM orchestration_runs
       WHERE state = ANY($1::text[])
       ORDER BY updated_at,id
       LIMIT $2`,
      [states, input.limit]
    );

    const records = result.rows.map((row) => {
      assertOrchestrationRunIntegrity(row.payload);
      if (!isOrchestrationWorkerResumable(row.payload)) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "PostgreSQL resumable query returned a non-resumable orchestration state"
        );
      }
      return row.payload;
    });

    return Object.freeze(records);
  }
}
