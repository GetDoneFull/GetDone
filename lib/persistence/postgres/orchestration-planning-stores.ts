import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertPersistedPlanProposal,
  assertPlannerInputEnvelope,
  type OrchestrationPlanProposalStore,
  type PersistedPlanProposal,
  type PlannerInputEnvelope,
  type PlannerInputStore
} from "@/lib/orchestration/planning-flow";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface PlannerInputRow {
  payload: PlannerInputEnvelope;
  input_hash: string;
  idempotency_key: string;
}

interface PlanArtifactRow {
  payload: PersistedPlanProposal;
  plan_hash: string;
  artifact_hash: string;
  idempotency_key: string;
}

export class PostgresPlannerInputStore implements PlannerInputStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async create(input: PlannerInputEnvelope, idempotencyKey: string) {
    if (!idempotencyKey.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Planner input idempotency key is required"
      );
    }
    assertPlannerInputEnvelope(input);

    return this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO orchestration_planner_inputs
          (
            id,run_id,portfolio_id,company_id,source_run_version,
            context_snapshot_id,context_snapshot_hash,input_hash,
            idempotency_key,payload,created_at
          )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
         ON CONFLICT DO NOTHING`,
        [
          input.id,
          input.runId,
          input.scope.portfolioId,
          input.scope.companyId,
          input.sourceRunVersion,
          input.contextSnapshot.id,
          input.contextSnapshot.hash,
          input.inputHash,
          idempotencyKey,
          JSON.stringify(input),
          input.createdAt
        ]
      );

      if (inserted.rowCount === 1) {
        return { status: "created" as const, input };
      }

      const existing = await client.query<PlannerInputRow>(
        `SELECT payload,input_hash,idempotency_key
         FROM orchestration_planner_inputs
         WHERE portfolio_id=$1
           AND company_id=$2
           AND (
             idempotency_key=$3
             OR (run_id=$4 AND source_run_version=$5)
             OR id=$6
           )
         FOR SHARE`,
        [
          input.scope.portfolioId,
          input.scope.companyId,
          idempotencyKey,
          input.runId,
          input.sourceRunVersion,
          input.id
        ]
      );

      const prior = existing.rows[0];
      if (
        prior
        && prior.idempotency_key === idempotencyKey
        && prior.input_hash === input.inputHash
        && prior.payload.runId === input.runId
        && prior.payload.sourceRunVersion === input.sourceRunVersion
      ) {
        assertPlannerInputEnvelope(prior.payload);
        return { status: "idempotent-replay" as const, input: prior.payload };
      }

      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Planner input conflicts with existing run/version or idempotency key",
        { correlationId: input.correlationId }
      );
    });
  }

  async get(id: string): Promise<PlannerInputEnvelope | null> {
    const result = await this.db.query<{ payload: PlannerInputEnvelope }>(
      "SELECT payload FROM orchestration_planner_inputs WHERE id=$1",
      [id]
    );
    const input = result.rows[0]?.payload ?? null;
    if (input) assertPlannerInputEnvelope(input);
    return input;
  }

  async getByRunVersion(
    runId: string,
    sourceRunVersion: number
  ): Promise<PlannerInputEnvelope | null> {
    const result = await this.db.query<{ payload: PlannerInputEnvelope }>(
      `SELECT payload
       FROM orchestration_planner_inputs
       WHERE run_id=$1 AND source_run_version=$2`,
      [runId, sourceRunVersion]
    );
    const input = result.rows[0]?.payload ?? null;
    if (input) assertPlannerInputEnvelope(input);
    return input;
  }
}

export class PostgresOrchestrationPlanProposalStore
  implements OrchestrationPlanProposalStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async create(
    artifact: PersistedPlanProposal,
    idempotencyKey: string
  ) {
    if (!idempotencyKey.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Plan artifact idempotency key is required"
      );
    }
    assertPersistedPlanProposal(artifact);

    return this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO orchestration_plan_proposals
          (
            id,run_id,portfolio_id,company_id,planning_run_version,
            planner_input_id,planner_input_hash,planner_request_id,plan_hash,
            artifact_hash,idempotency_key,payload,created_at
          )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
         ON CONFLICT DO NOTHING`,
        [
          artifact.id,
          artifact.runId,
          artifact.portfolioId,
          artifact.companyId,
          artifact.planningRunVersion,
          artifact.plannerInputId,
          artifact.plannerInputHash,
          artifact.plannerRequestId,
          artifact.planHash,
          artifact.artifactHash,
          idempotencyKey,
          JSON.stringify(artifact),
          artifact.createdAt
        ]
      );

      if (inserted.rowCount === 1) {
        return { status: "created" as const, artifact };
      }

      const existing = await client.query<PlanArtifactRow>(
        `SELECT payload,plan_hash,artifact_hash,idempotency_key
         FROM orchestration_plan_proposals
         WHERE portfolio_id=$1
           AND company_id=$2
           AND (
             idempotency_key=$3
             OR (run_id=$4 AND planning_run_version=$5)
             OR planner_request_id=$6
             OR id=$7
           )
         FOR SHARE`,
        [
          artifact.portfolioId,
          artifact.companyId,
          idempotencyKey,
          artifact.runId,
          artifact.planningRunVersion,
          artifact.plannerRequestId,
          artifact.id
        ]
      );

      const prior = existing.rows[0];
      if (
        prior
        && prior.idempotency_key === idempotencyKey
        && prior.plan_hash === artifact.planHash
        && prior.artifact_hash === artifact.artifactHash
        && prior.payload.plannerInputHash === artifact.plannerInputHash
      ) {
        assertPersistedPlanProposal(prior.payload);
        return { status: "idempotent-replay" as const, artifact: prior.payload };
      }

      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Plan artifact conflicts with existing planner request or run/version",
        { correlationId: artifact.correlationId }
      );
    });
  }

  async get(id: string): Promise<PersistedPlanProposal | null> {
    const result = await this.db.query<{ payload: PersistedPlanProposal }>(
      "SELECT payload FROM orchestration_plan_proposals WHERE id=$1",
      [id]
    );
    const artifact = result.rows[0]?.payload ?? null;
    if (artifact) assertPersistedPlanProposal(artifact);
    return artifact;
  }

  async getByRunVersion(
    runId: string,
    planningRunVersion: number
  ): Promise<PersistedPlanProposal | null> {
    const result = await this.db.query<{ payload: PersistedPlanProposal }>(
      `SELECT payload
       FROM orchestration_plan_proposals
       WHERE run_id=$1 AND planning_run_version=$2`,
      [runId, planningRunVersion]
    );
    const artifact = result.rows[0]?.payload ?? null;
    if (artifact) assertPersistedPlanProposal(artifact);
    return artifact;
  }
}
