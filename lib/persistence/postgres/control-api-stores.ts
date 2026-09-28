import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createAuditEvent } from "@/lib/domain/audit";
import { claimIdempotency } from "@/lib/domain/idempotency";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import {
  createOwnerIntentOrchestrationRun,
  ownerIntentOrchestrationStartIdempotencyKey
} from "@/lib/orchestration/owner-intent-flow";
import type { OwnerIntentStore } from "@/lib/control-api/service-adapter";
import type {
  Resource,
  ResourceCapabilityBinding,
  ResourceCostProfile,
  ResourceHealthRecord,
  ResourceIdentityEvidence,
  ResourceLocation,
  ResourceProviderBinding,
  ResourceTrustEvidence
} from "@/lib/domain/resources";
import type { ResourceEvidenceStore } from "@/lib/domain/services/resource-registry-service";
import type {
  ResourceEnrollmentReadinessRecord,
  ResourceEnrollmentReadinessStore
} from "@/lib/resources/enrollment";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import {
  PostgresAuditLedger,
  PostgresEntityStore,
  PostgresIdempotencyStore
} from "@/lib/persistence/postgres/authority-stores";
import { PostgresOrchestrationRunStore } from "@/lib/persistence/postgres/orchestration-store";

export class PostgresOwnerIntentStore implements OwnerIntentStore {
  private readonly orchestrations: PostgresOrchestrationRunStore;

  constructor(private readonly db: PostgresTransactionalDatabase) {
    this.orchestrations = new PostgresOrchestrationRunStore(db);
  }

  private fingerprint(record: OwnerIntentRecord) {
    return sha256Hex(JSON.stringify({
      portfolioId: record.portfolioId,
      companyId: record.companyId,
      userId: record.userId,
      message: record.message,
      channel: record.channel
    }));
  }

  private idempotencyRecordKey(
    record: OwnerIntentRecord,
    idempotencyKey: string
  ) {
    return `owner-intent:${sha256Hex({
      portfolioId: record.portfolioId,
      companyId: record.companyId,
      idempotencyKey
    })}`;
  }

  private async ensureOrchestration(
    client: SqlQueryable,
    intent: OwnerIntentRecord
  ) {
    const orchestration = createOwnerIntentOrchestrationRun(intent);
    await this.orchestrations.createInTransaction(
      client,
      orchestration,
      ownerIntentOrchestrationStartIdempotencyKey(intent.id)
    );
    return orchestration;
  }

  async create(record: OwnerIntentRecord, idempotencyKey: string) {
    const fingerprint = this.fingerprint(record);
    const idempotencyRecordKey = this.idempotencyRecordKey(
      record,
      idempotencyKey
    );

    return this.db.transaction(async (client) => {
      const idempotency = new PostgresIdempotencyStore(client);
      const claim = await claimIdempotency<OwnerIntentRecord>(
        idempotency,
        idempotencyRecordKey,
        fingerprint,
        new Date(record.receivedAt)
      );

      if (claim.state === "COMPLETED" && claim.record.result) {
        const persisted = claim.record.result;
        await this.ensureOrchestration(client, persisted);
        return persisted;
      }
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Owner intent request is already in progress or previously failed"
        );
      }

      const inserted = await client.query(
        `INSERT INTO owner_intents
          (id,portfolio_id,company_id,user_id,idempotency_key,received_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (portfolio_id,company_id,idempotency_key) DO NOTHING`,
        [
          record.id,
          record.portfolioId,
          record.companyId,
          record.userId,
          idempotencyKey,
          record.receivedAt,
          JSON.stringify(record)
        ]
      );

      let persisted = record;
      if (inserted.rowCount !== 1) {
        const existing = await client.query<{ payload: OwnerIntentRecord }>(
          `SELECT payload FROM owner_intents
           WHERE portfolio_id=$1 AND company_id=$2 AND idempotency_key=$3
           FOR UPDATE`,
          [record.portfolioId, record.companyId, idempotencyKey]
        );
        const prior = existing.rows[0]?.payload;
        if (
          !prior
          || prior.userId !== record.userId
          || prior.message !== record.message
          || prior.channel !== record.channel
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Owner intent idempotency key conflicts with prior content"
          );
        }
        persisted = prior;
      }

      await this.ensureOrchestration(client, persisted);

      await new PostgresAuditLedger(client).append(createAuditEvent({
        correlationId: persisted.correlationId ?? `owner-intent:${persisted.id}`,
        eventType: "owner-intent.accepted",
        actor: { type: "user", id: persisted.userId },
        scope: {
          userId: persisted.userId,
          portfolioId: persisted.portfolioId,
          companyId: persisted.companyId
        },
        environment: persisted.environment,
        entityType: "owner-intent",
        entityId: persisted.id,
        newState: "accepted",
        provenance: "control-api:owner-intent",
        metadata: {
          idempotencyKey,
          orchestrationRunId: createOwnerIntentOrchestrationRun(persisted).id
        }
      }));

      await idempotency.complete(
        idempotencyRecordKey,
        fingerprint,
        persisted,
        persisted.receivedAt
      );

      return persisted;
    });
  }

  async get(id: string): Promise<OwnerIntentRecord | null> {
    const result = await this.db.query<{ payload: OwnerIntentRecord }>(
      "SELECT payload FROM owner_intents WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }
}

type ResourceEvidence =
  | ResourceIdentityEvidence
  | ResourceTrustEvidence
  | ResourceHealthRecord
  | ResourceCapabilityBinding
  | ResourceLocation
  | ResourceCostProfile
  | ResourceProviderBinding;

export class PostgresResourceEvidenceStore<T extends ResourceEvidence>
  implements ResourceEvidenceStore<T> {
  constructor(
    private readonly db: SqlQueryable,
    private readonly evidenceKind: string
  ) {}

  async append(record: T) {
    try {
      await this.db.query(
        `INSERT INTO resource_evidence
          (evidence_kind,id,resource_id,portfolio_id,company_id,observed_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          this.evidenceKind,
          record.id,
          record.resourceId,
          record.portfolioId,
          record.companyId,
          record.observedAt,
          JSON.stringify(record)
        ]
      );
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && "code" in error
        && (error as { code?: string }).code === "23505"
      ) {
        throw new ControlPlaneError("CONFLICT", "Resource evidence already exists");
      }
      throw error;
    }
  }

  async listByResourceId(resourceId: string) {
    const result = await this.db.query<{ payload: T }>(
      `SELECT payload FROM resource_evidence
       WHERE evidence_kind=$1 AND resource_id=$2
       ORDER BY observed_at,id`,
      [this.evidenceKind, resourceId]
    );
    return result.rows.map((row) => row.payload);
  }
}

export class PostgresResourceEnrollmentReadinessStore
  implements ResourceEnrollmentReadinessStore {
  private readonly resources: PostgresEntityStore<Resource>;

  constructor(db: SqlQueryable) {
    this.resources = new PostgresEntityStore<Resource>(db, "resource");
  }

  async get(resourceId: string): Promise<ResourceEnrollmentReadinessRecord | null> {
    const resource = await this.resources.get(resourceId);
    if (!resource) return null;
    const evidenceId = [
      ...resource.providerBindingIds,
      ...resource.healthRecordIds,
      ...resource.trustEvidenceIds,
      ...resource.identityEvidenceIds
    ].at(-1) ?? `resource-ready:${resource.id}:v${resource.version}`;

    return {
      resourceId: resource.id,
      portfolioId: resource.portfolioId,
      companyId: resource.companyId,
      ready: resource.state === "ready",
      evidenceId
    };
  }
}
