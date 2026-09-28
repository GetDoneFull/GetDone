import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertOrchestrationContextSnapshot,
  type OrchestrationContextSnapshot,
  type OrchestrationContextSnapshotStore
} from "@/lib/orchestration/owner-intent-flow";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface SnapshotRow {
  payload: OrchestrationContextSnapshot;
  snapshot_hash: string;
  idempotency_key: string;
}

export class PostgresOrchestrationContextSnapshotStore
  implements OrchestrationContextSnapshotStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async create(
    snapshot: OrchestrationContextSnapshot,
    idempotencyKey: string
  ) {
    if (!idempotencyKey.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "ContextSnapshot idempotency key is required"
      );
    }
    assertOrchestrationContextSnapshot(snapshot);

    return this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO orchestration_context_snapshots
          (
            id,run_id,portfolio_id,company_id,source_type,source_id,source_hash,
            run_version,snapshot_hash,idempotency_key,payload,created_at
          )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         ON CONFLICT DO NOTHING`,
        [
          snapshot.id,
          snapshot.runId,
          snapshot.portfolioId,
          snapshot.companyId,
          snapshot.sourceType,
          snapshot.sourceId,
          snapshot.sourceHash,
          snapshot.runVersion,
          snapshot.snapshotHash,
          idempotencyKey,
          JSON.stringify(snapshot),
          snapshot.createdAt
        ]
      );

      if (inserted.rowCount === 1) {
        return {
          status: "created" as const,
          snapshot
        };
      }

      const existing = await client.query<SnapshotRow>(
        `SELECT payload,snapshot_hash,idempotency_key
         FROM orchestration_context_snapshots
         WHERE portfolio_id=$1
           AND company_id=$2
           AND (
             idempotency_key=$3
             OR (run_id=$4 AND run_version=$5)
             OR id=$6
           )
         FOR SHARE`,
        [
          snapshot.portfolioId,
          snapshot.companyId,
          idempotencyKey,
          snapshot.runId,
          snapshot.runVersion,
          snapshot.id
        ]
      );

      const prior = existing.rows[0];
      if (
        prior
        && prior.idempotency_key === idempotencyKey
        && prior.snapshot_hash === snapshot.snapshotHash
        && prior.payload.runId === snapshot.runId
        && prior.payload.runVersion === snapshot.runVersion
      ) {
        assertOrchestrationContextSnapshot(prior.payload);
        return {
          status: "idempotent-replay" as const,
          snapshot: prior.payload
        };
      }

      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "ContextSnapshot conflicts with existing run/version or idempotency key",
        { correlationId: snapshot.correlationId }
      );
    });
  }

  async get(id: string): Promise<OrchestrationContextSnapshot | null> {
    const result = await this.db.query<{ payload: OrchestrationContextSnapshot }>(
      `SELECT payload
       FROM orchestration_context_snapshots
       WHERE id=$1`,
      [id]
    );
    const snapshot = result.rows[0]?.payload ?? null;
    if (snapshot) assertOrchestrationContextSnapshot(snapshot);
    return snapshot;
  }

  async getByRunVersion(
    runId: string,
    runVersion: number
  ): Promise<OrchestrationContextSnapshot | null> {
    const result = await this.db.query<{ payload: OrchestrationContextSnapshot }>(
      `SELECT payload
       FROM orchestration_context_snapshots
       WHERE run_id=$1 AND run_version=$2`,
      [runId, runVersion]
    );
    const snapshot = result.rows[0]?.payload ?? null;
    if (snapshot) assertOrchestrationContextSnapshot(snapshot);
    return snapshot;
  }
}
