import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AuthoritativeDecision,
  DecisionResumeRequest,
  DecisionResumeRequestStore
} from "@/lib/domain/decision-service";
import type {
  OrchestrationAuthorizationGrantStore,
  OrchestrationDecisionStore
} from "@/lib/orchestration/authorization-flow";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import {
  PostgresAuthorizationGrantStore,
  PostgresIdempotencyStore
} from "@/lib/persistence/postgres/authority-stores";
import { claimIdempotency } from "@/lib/domain/idempotency";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";

export interface DurableDecisionResumeRequest extends DecisionResumeRequest {
  status: "pending" | "processed";
  processedAt?: string;
}

export interface DecisionResumeQueue {
  getByDecisionVersion(
    decisionId: string,
    decisionVersion: number
  ): Promise<DurableDecisionResumeRequest | null>;
  listPending(limit: number): Promise<readonly DurableDecisionResumeRequest[]>;
  markProcessed(id: string, requestHash: string, processedAt: string): Promise<void>;
}

export class PostgresOrchestrationAuthorizationGrantStore
  implements OrchestrationAuthorizationGrantStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async insertMany(
    grants: readonly AuthorizationGrant[],
    idempotencyKey: string
  ) {
    if (grants.length === 0) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Authorization grant batch must not be empty"
      );
    }
    if (!idempotencyKey.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Authorization grant batch idempotency key is required"
      );
    }

    const fingerprint = sha256Hex({
      grants: grants
        .map((grant) => ({
          id: grant.id,
          hash: grant.grantHash
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    });

    await this.db.transaction(async (client) => {
      const idempotency = new PostgresIdempotencyStore(client);
      const claim = await claimIdempotency<{
        grantIds: readonly string[];
        grantHashes: readonly string[];
      }>(
        idempotency,
        idempotencyKey,
        fingerprint,
        new Date(grants[0]!.issuedAt)
      );

      if (claim.state === "COMPLETED") return;
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Authorization grant batch is already in progress or previously failed"
        );
      }

      const store = new PostgresAuthorizationGrantStore(client);
      for (const grant of grants) {
        await store.insert(grant);
      }

      await idempotency.complete(
        idempotencyKey,
        fingerprint,
        {
          grantIds: grants.map((grant) => grant.id),
          grantHashes: grants.map((grant) => grant.grantHash)
        },
        grants[0]!.issuedAt
      );
    });
  }

  get(id: string) {
    return new PostgresAuthorizationGrantStore(this.db).get(id);
  }
}

export class PostgresOrchestrationDecisionStore
  implements OrchestrationDecisionStore {
  constructor(private readonly db: SqlQueryable) {}

  async create(decision: AuthoritativeDecision) {
    const inserted = await this.db.query(
      `INSERT INTO control_plane_entities
        (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
       VALUES('decision',$1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (entity_type,id) DO NOTHING`,
      [
        decision.id,
        decision.portfolioId,
        decision.companyId,
        decision.version,
        decision.updatedAt,
        JSON.stringify(decision)
      ]
    );

    if (inserted.rowCount === 1) {
      return { status: "created" as const, decision };
    }

    const existing = await this.get(decision.id);
    if (
      existing
      && existing.portfolioId === decision.portfolioId
      && existing.companyId === decision.companyId
      && existing.correlationId === decision.correlationId
      && existing.requiresStepUp === decision.requiresStepUp
      && Boolean(existing.approvalBinding) === Boolean(decision.approvalBinding)
      && (
        !decision.approvalBinding
        || sha256Hex(existing.approvalBinding)
          === sha256Hex(decision.approvalBinding)
      )
      && existing.version >= decision.version
    ) {
      // The Decision may have legitimately advanced from pending after the
      // original create committed but before the orchestration CAS. Reuse that
      // evolved authoritative state when its immutable approval binding is
      // identical instead of treating owner resolution as an idempotency clash.
      return {
        status: "idempotent-replay" as const,
        decision: existing
      };
    }

    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Orchestration Decision ID already exists with different immutable authorization lineage",
      { correlationId: decision.correlationId }
    );
  }

  async get(id: string): Promise<AuthoritativeDecision | null> {
    const result = await this.db.query<{ payload: AuthoritativeDecision }>(
      `SELECT payload
       FROM control_plane_entities
       WHERE entity_type='decision' AND id=$1`,
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }
}

export class PostgresDecisionResumeRequestStore
  implements DecisionResumeRequestStore, DecisionResumeQueue {
  constructor(private readonly db: SqlQueryable) {}

  async create(request: DecisionResumeRequest): Promise<void> {
    if (
      sha256Hex({
        id: request.id,
        runId: request.runId,
        decisionId: request.decisionId,
        decisionVersion: request.decisionVersion,
        correlationId: request.correlationId,
        portfolioId: request.portfolioId,
        companyId: request.companyId,
        resolution: request.resolution,
        createdAt: request.createdAt
      }) !== request.requestHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Decision resume request integrity check failed"
      );
    }

    const inserted = await this.db.query(
      `INSERT INTO orchestration_decision_resume_requests
        (
          id,run_id,decision_id,decision_version,portfolio_id,company_id,
          resolution,request_hash,status,created_at,payload
        )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        request.id,
        request.runId,
        request.decisionId,
        request.decisionVersion,
        request.portfolioId,
        request.companyId,
        request.resolution,
        request.requestHash,
        request.createdAt,
        JSON.stringify(request)
      ]
    );

    if (inserted.rowCount === 1) return;

    const existing = await this.getByDecisionVersion(
      request.decisionId,
      request.decisionVersion
    );
    if (existing?.requestHash === request.requestHash) return;

    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Decision resume request conflicts with existing resolution evidence",
      { correlationId: request.correlationId }
    );
  }

  async getByDecisionVersion(
    decisionId: string,
    decisionVersion: number
  ): Promise<DurableDecisionResumeRequest | null> {
    const result = await this.db.query<{
      payload: DecisionResumeRequest;
      status: "pending" | "processed";
      processed_at: Date | string | null;
    }>(
      `SELECT payload,status,processed_at
       FROM orchestration_decision_resume_requests
       WHERE decision_id=$1 AND decision_version=$2`,
      [decisionId, decisionVersion]
    );
    const row = result.rows[0];
    if (!row) return null;
    return Object.freeze({
      ...row.payload,
      status: row.status,
      processedAt: row.processed_at
        ? row.processed_at instanceof Date
          ? row.processed_at.toISOString()
          : String(row.processed_at)
        : undefined
    });
  }

  async listPending(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Decision resume queue limit must be from 1 to 500"
      );
    }
    const result = await this.db.query<{
      payload: DecisionResumeRequest;
      status: "pending";
    }>(
      `SELECT payload,status
       FROM orchestration_decision_resume_requests
       WHERE status='pending'
       ORDER BY created_at,id
       LIMIT $1`,
      [limit]
    );
    return Object.freeze(result.rows.map((row) =>
      Object.freeze({
        ...row.payload,
        status: row.status
      })
    ));
  }

  async markProcessed(
    id: string,
    requestHash: string,
    processedAt: string
  ) {
    const result = await this.db.query(
      `UPDATE orchestration_decision_resume_requests
       SET status='processed',processed_at=$3
       WHERE id=$1 AND request_hash=$2 AND status='pending'`,
      [id, requestHash, processedAt]
    );
    if (result.rowCount === 1) return;

    const existing = await this.db.query<{
      request_hash: string;
      status: "pending" | "processed";
    }>(
      `SELECT request_hash,status
       FROM orchestration_decision_resume_requests
       WHERE id=$1`,
      [id]
    );
    const row = existing.rows[0];
    if (row?.request_hash === requestHash && row.status === "processed") return;

    throw new ControlPlaneError(
      "CONFLICT",
      "Decision resume request changed before completion"
    );
  }
}

export class PostgresDecisionResumeTransactionalStore
  extends PostgresDecisionResumeRequestStore {
  constructor(db: SqlQueryable) {
    super(db);
  }
}
