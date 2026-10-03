import type { QueryResultRow } from "pg";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import type { IdempotencyClaim, IdempotencyRecord, IdempotencyStore } from "@/lib/domain/idempotency";
import type { TransitionEntity, TransitionEntityStore } from "@/lib/domain/services/transition-service";
import type {
  AuthorizationConsumptionRecord,
  AuthorizationGrant,
  AuthorizationGrantStore
} from "@/lib/authorization/grants";
import type {
  VerificationReceipt,
  VerificationReceiptStore
} from "@/lib/verification/verification";
import type {
  JobExecutionBridgeStore,
  JobVerifiedCompletionFact,
  JobVerifiedStartFact
} from "@/lib/domain/services/job-execution-bridge";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function json<T>(value: unknown): T {
  return value as T;
}

export class PostgresEntityStore<T extends TransitionEntity>
  implements TransitionEntityStore<T> {
  constructor(
    private readonly db: SqlQueryable,
    private readonly entityType: string
  ) {}

  async get(id: string): Promise<T | null> {
    const result = await this.db.query<{ payload: T }>(
      `SELECT payload FROM control_plane_entities
       WHERE entity_type = $1 AND id = $2`,
      [this.entityType, id]
    );
    return result.rows[0]?.payload ?? null;
  }

  async listByScope(portfolioId: string, companyId: string): Promise<readonly T[]> {
    const result = await this.db.query<{ payload: T }>(
      `SELECT payload FROM control_plane_entities
       WHERE entity_type = $1 AND portfolio_id = $2 AND company_id = $3
       ORDER BY updated_at DESC, id`,
      [this.entityType, portfolioId, companyId]
    );
    return result.rows.map((row) => row.payload);
  }

  async create(entity: T): Promise<void> {
    return this.insert(entity);
  }

  async insert(entity: T): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO control_plane_entities
          (entity_type, id, portfolio_id, company_id, version, updated_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          this.entityType,
          entity.id,
          entity.portfolioId,
          entity.companyId,
          entity.version,
          entity.updatedAt,
          JSON.stringify(entity)
        ]
      );
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && "code" in error
        && (error as { code?: string }).code === "23505"
      ) {
        throw new ControlPlaneError("CONFLICT", "Authoritative entity already exists", {
          details: { entityType: this.entityType, entityId: entity.id }
        });
      }
      throw error;
    }
  }

  async save(next: T, expectedVersion: number): Promise<void> {
    if (next.version !== expectedVersion + 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Authoritative entity version must advance exactly once"
      );
    }
    const result = await this.db.query(
      `UPDATE control_plane_entities
       SET portfolio_id=$3, company_id=$4, version=$5, updated_at=$6, payload=$7::jsonb
       WHERE entity_type=$1 AND id=$2 AND version=$8`,
      [
        this.entityType,
        next.id,
        next.portfolioId,
        next.companyId,
        next.version,
        next.updatedAt,
        JSON.stringify(next),
        expectedVersion
      ]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Authoritative entity changed before compare-and-swap persistence"
      );
    }
  }
}

interface IdempotencyRow extends QueryResultRow {
  key: string;
  fingerprint: string;
  status: IdempotencyRecord["status"];
  created_at: Date | string;
  completed_at: Date | string | null;
  failed_at: Date | string | null;
  result: unknown;
  error_code: string | null;
}

function idempotencyRecord<T>(row: IdempotencyRow): IdempotencyRecord<T> {
  return {
    key: row.key,
    fingerprint: row.fingerprint,
    status: row.status,
    createdAt: iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : undefined,
    failedAt: row.failed_at ? iso(row.failed_at) : undefined,
    result: row.result === null ? undefined : json<T>(row.result),
    errorCode: row.error_code ?? undefined
  };
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: SqlQueryable) {}

  async claim<T = unknown>(
    key: string,
    fingerprint: string,
    createdAt: string
  ): Promise<IdempotencyClaim<T>> {
    const inserted = await this.db.query(
      `INSERT INTO idempotency_records(key,fingerprint,status,created_at)
       VALUES($1,$2,'IN_PROGRESS',$3)
       ON CONFLICT (key) DO NOTHING`,
      [key, fingerprint, createdAt]
    );
    const result = await this.db.query<IdempotencyRow>(
      `SELECT * FROM idempotency_records WHERE key=$1 FOR UPDATE`,
      [key]
    );
    const row = result.rows[0];
    if (!row) throw new ControlPlaneError("UNAVAILABLE", "Idempotency record disappeared");
    const record = idempotencyRecord<T>(row);
    if (record.fingerprint !== fingerprint) return { state: "CONFLICT", record };
    return {
      state: inserted.rowCount === 1 ? "CREATED" : record.status,
      record
    };
  }

  async complete<T = unknown>(
    key: string,
    fingerprint: string,
    resultValue: T,
    completedAt: string
  ): Promise<IdempotencyRecord<T>> {
    const result = await this.db.query<IdempotencyRow>(
      `UPDATE idempotency_records
       SET status='COMPLETED', completed_at=$3, result=$4::jsonb, error_code=NULL
       WHERE key=$1 AND fingerprint=$2
       RETURNING *`,
      [key, fingerprint, completedAt, JSON.stringify(resultValue)]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Cannot complete an unclaimed or mismatched idempotency record"
      );
    }
    return idempotencyRecord<T>(row);
  }

  async fail(
    key: string,
    fingerprint: string,
    errorCode: string,
    failedAt: string
  ): Promise<IdempotencyRecord> {
    const result = await this.db.query<IdempotencyRow>(
      `UPDATE idempotency_records
       SET status='FAILED', failed_at=$3, error_code=$4
       WHERE key=$1 AND fingerprint=$2
       RETURNING *`,
      [key, fingerprint, failedAt, errorCode]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Cannot fail an unclaimed or mismatched idempotency record"
      );
    }
    return idempotencyRecord(row);
  }

  async get<T = unknown>(key: string): Promise<IdempotencyRecord<T> | null> {
    const result = await this.db.query<IdempotencyRow>(
      "SELECT * FROM idempotency_records WHERE key=$1",
      [key]
    );
    return result.rows[0] ? idempotencyRecord<T>(result.rows[0]) : null;
  }
}

export class PostgresAuditLedger implements AuditLedger {
  constructor(private readonly db: SqlQueryable) {}

  async append(event: AuditEvent): Promise<void> {
    const result = await this.db.query<{
      chain_sequence: string | number;
      event_hash: string;
    }>(
      `SELECT chain_sequence,event_hash
       FROM getdone_append_audit_event(
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb
       )`,
      [
        event.id,
        event.correlationId,
        event.scope.portfolioId,
        event.scope.companyId,
        event.entityType,
        event.entityId,
        event.occurredAt,
        JSON.stringify(event)
      ]
    );
    if (result.rows.length !== 1) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Audit ledger chain did not advance atomically"
      );
    }
  }

  async listByCorrelationId(correlationId: string): Promise<readonly AuditEvent[]> {
    const result = await this.db.query<{ payload: AuditEvent }>(
      `SELECT payload FROM audit_events
       WHERE correlation_id=$1 ORDER BY chain_sequence`,
      [correlationId]
    );
    return result.rows.map((row) => row.payload);
  }
}

export class PostgresAuthorizationGrantStore implements AuthorizationGrantStore {
  constructor(private readonly db: SqlQueryable) {}

  async insert(grant: AuthorizationGrant): Promise<void> {
    const inserted = await this.db.query(
      `INSERT INTO authorization_grants
        (id, portfolio_id, company_id, status, expires_at, grant_hash, payload)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        grant.id,
        grant.scope.portfolioId,
        grant.scope.companyId,
        grant.status,
        grant.expiresAt,
        grant.grantHash,
        JSON.stringify(grant)
      ]
    );
    if (inserted.rowCount === 1) return;
    const existing = await this.get(grant.id);
    if (existing?.grantHash === grant.grantHash) return;
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Authorization grant ID already exists with different authoritative content"
    );
  }

  async get(id: string): Promise<AuthorizationGrant | null> {
    const result = await this.db.query<{ payload: AuthorizationGrant }>(
      "SELECT payload FROM authorization_grants WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }

  async consume(record: AuthorizationConsumptionRecord): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO authorization_consumptions
          (id, grant_id, consumer_type, consumer_id, consumption_hash, consumed_at, payload)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          record.id,
          record.grantId,
          record.consumerType,
          record.consumerId,
          record.consumptionHash,
          record.consumedAt,
          JSON.stringify(record)
        ]
      );
    } catch {
      const existing = await this.db.query<{ payload: AuthorizationConsumptionRecord }>(
        "SELECT payload FROM authorization_consumptions WHERE grant_id=$1",
        [record.grantId]
      );
      if (existing.rows[0]?.payload.consumptionHash === record.consumptionHash) return;
      throw new ControlPlaneError(
        "CONFLICT",
        "Authorization grant already has a different persisted consumption"
      );
    }
  }

  async listConsumptions(grantId: string): Promise<readonly AuthorizationConsumptionRecord[]> {
    const result = await this.db.query<{ payload: AuthorizationConsumptionRecord }>(
      "SELECT payload FROM authorization_consumptions WHERE grant_id=$1 ORDER BY consumed_at",
      [grantId]
    );
    return result.rows.map((row) => row.payload);
  }

  async revoke(id: string, reason: string, revokedAt: string): Promise<void> {
    const current = await this.get(id);
    if (!current) throw new ControlPlaneError("NOT_FOUND", "Authorization grant was not found");
    const { grantHash: _currentGrantHash, ...currentBase } = current;
    void _currentGrantHash;
    const nextBase = { ...currentBase, status: "revoked" as const };
    const next: AuthorizationGrant = {
      ...nextBase,
      grantHash: sha256Hex(nextBase)
    };
    const result = await this.db.query(
      `UPDATE authorization_grants
       SET status='revoked', revoked_reason=$2, revoked_at=$3, grant_hash=$4, payload=$5::jsonb
       WHERE id=$1 AND status <> 'revoked'`,
      [id, reason, revokedAt, next.grantHash, JSON.stringify(next)]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError("CONFLICT", "Authorization grant is already revoked");
    }
  }
}

export class PostgresVerificationReceiptStore implements VerificationReceiptStore {
  constructor(private readonly db: SqlQueryable) {}

  async insert(receipt: VerificationReceipt): Promise<void> {
    await this.db.query(
      `INSERT INTO verification_receipts
        (id, portfolio_id, company_id, subject_type, subject_id, expires_at, receipt_hash, payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        receipt.id,
        receipt.portfolioId,
        receipt.companyId,
        receipt.subject.type,
        receipt.subject.id,
        receipt.expiresAt,
        receipt.receiptHash,
        JSON.stringify(receipt)
      ]
    );
  }

  async getReceipt(id: string): Promise<VerificationReceipt | null> {
    const result = await this.db.query<{ payload: VerificationReceipt }>(
      "SELECT payload FROM verification_receipts WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }
}

export class PostgresJobExecutionBridgeStore implements JobExecutionBridgeStore {
  constructor(private readonly db: SqlQueryable) {}

  async insertStartFact(fact: JobVerifiedStartFact): Promise<void> {
    await this.db.query(
      `INSERT INTO job_execution_start_facts
        (id,job_id,portfolio_id,company_id,expires_at,fact_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        fact.id,
        fact.jobId,
        fact.portfolioId,
        fact.companyId,
        fact.expiresAt,
        fact.factHash,
        JSON.stringify(fact)
      ]
    );
  }

  async insertCompletionFact(fact: JobVerifiedCompletionFact): Promise<void> {
    await this.db.query(
      `INSERT INTO job_execution_completion_facts
        (id,job_id,portfolio_id,company_id,fact_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        fact.id,
        fact.jobId,
        fact.portfolioId,
        fact.companyId,
        fact.factHash,
        JSON.stringify(fact)
      ]
    );
  }

  async getStartFact(id: string): Promise<JobVerifiedStartFact | null> {
    const result = await this.db.query<{ payload: JobVerifiedStartFact }>(
      "SELECT payload FROM job_execution_start_facts WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }

  async getCompletionFact(id: string): Promise<JobVerifiedCompletionFact | null> {
    const result = await this.db.query<{ payload: JobVerifiedCompletionFact }>(
      "SELECT payload FROM job_execution_completion_facts WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }
}
