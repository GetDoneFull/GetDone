import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertDurablePolicyEvaluationArtifact,
  assertDurablePolicyStepSnapshotArtifact,
  assertDurableValidationArtifact,
  type DurablePolicyEvaluationArtifact,
  type DurablePolicyStepSnapshotArtifact,
  type DurableValidationArtifact,
  type OrchestrationPolicyEvaluationStore,
  type OrchestrationPolicyStepSnapshotStore,
  type OrchestrationValidationArtifactStore
} from "@/lib/orchestration/validation-policy-flow";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface ValidationRow {
  payload: DurableValidationArtifact;
  receipt_hash: string;
  artifact_hash: string;
  idempotency_key: string;
}

interface PolicyStepRow {
  payload: DurablePolicyStepSnapshotArtifact;
  snapshot_hash: string;
  artifact_hash: string;
  idempotency_key: string;
}

interface PolicyRow {
  payload: DurablePolicyEvaluationArtifact;
  artifact_hash: string;
  idempotency_key: string;
}

export class PostgresOrchestrationValidationArtifactStore
  implements OrchestrationValidationArtifactStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async create(
    artifact: DurableValidationArtifact,
    idempotencyKey: string
  ) {
    if (!idempotencyKey.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Validation artifact idempotency key is required"
      );
    }
    assertDurableValidationArtifact(artifact);

    return this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO orchestration_validation_artifacts
          (
            id,run_id,portfolio_id,company_id,planned_run_version,
            plan_artifact_id,plan_artifact_hash,plan_hash,
            validation_policy_hash,receipt_hash,validation_status,
            artifact_hash,idempotency_key,payload,created_at
          )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
         ON CONFLICT DO NOTHING`,
        [
          artifact.id,
          artifact.runId,
          artifact.portfolioId,
          artifact.companyId,
          artifact.plannedRunVersion,
          artifact.planArtifactId,
          artifact.planArtifactHash,
          artifact.planHash,
          artifact.validationPolicyHash,
          artifact.receipt.receiptHash,
          artifact.receipt.status,
          artifact.artifactHash,
          idempotencyKey,
          JSON.stringify(artifact),
          artifact.createdAt
        ]
      );

      if (inserted.rowCount === 1) {
        return { status: "created" as const, artifact };
      }

      const existing = await client.query<ValidationRow>(
        `SELECT payload,receipt_hash,artifact_hash,idempotency_key
         FROM orchestration_validation_artifacts
         WHERE portfolio_id=$1
           AND company_id=$2
           AND (
             idempotency_key=$3
             OR (run_id=$4 AND planned_run_version=$5)
             OR id=$6
           )
         FOR SHARE`,
        [
          artifact.portfolioId,
          artifact.companyId,
          idempotencyKey,
          artifact.runId,
          artifact.plannedRunVersion,
          artifact.id
        ]
      );

      const prior = existing.rows[0];
      if (
        prior
        && prior.idempotency_key === idempotencyKey
        && prior.receipt_hash === artifact.receipt.receiptHash
        && prior.artifact_hash === artifact.artifactHash
      ) {
        assertDurableValidationArtifact(prior.payload);
        return {
          status: "idempotent-replay" as const,
          artifact: prior.payload
        };
      }

      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Validation artifact conflicts with existing run/version or idempotency key",
        { correlationId: artifact.correlationId }
      );
    });
  }

  async get(id: string): Promise<DurableValidationArtifact | null> {
    const result = await this.db.query<{ payload: DurableValidationArtifact }>(
      "SELECT payload FROM orchestration_validation_artifacts WHERE id=$1",
      [id]
    );
    const artifact = result.rows[0]?.payload ?? null;
    if (artifact) assertDurableValidationArtifact(artifact);
    return artifact;
  }

  async getByRunVersion(
    runId: string,
    plannedRunVersion: number
  ): Promise<DurableValidationArtifact | null> {
    const result = await this.db.query<{ payload: DurableValidationArtifact }>(
      `SELECT payload
       FROM orchestration_validation_artifacts
       WHERE run_id=$1 AND planned_run_version=$2`,
      [runId, plannedRunVersion]
    );
    const artifact = result.rows[0]?.payload ?? null;
    if (artifact) assertDurableValidationArtifact(artifact);
    return artifact;
  }
}

export class PostgresOrchestrationPolicyStepSnapshotStore
  implements OrchestrationPolicyStepSnapshotStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async create(
    artifact: DurablePolicyStepSnapshotArtifact,
    idempotencyKey: string
  ) {
    if (!idempotencyKey.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Policy step snapshot idempotency key is required"
      );
    }
    assertDurablePolicyStepSnapshotArtifact(artifact);

    return this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO orchestration_policy_step_snapshots
          (
            id,run_id,portfolio_id,company_id,validated_run_version,
            plan_artifact_id,plan_artifact_hash,
            validation_receipt_id,validation_receipt_hash,
            step_id,step_hash,snapshot_hash,artifact_hash,
            idempotency_key,payload,created_at
          )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
         ON CONFLICT DO NOTHING`,
        [
          artifact.id,
          artifact.runId,
          artifact.portfolioId,
          artifact.companyId,
          artifact.validatedRunVersion,
          artifact.planArtifactId,
          artifact.planArtifactHash,
          artifact.validationReceiptId,
          artifact.validationReceiptHash,
          artifact.stepId,
          artifact.stepHash,
          artifact.snapshot.snapshotHash,
          artifact.artifactHash,
          idempotencyKey,
          JSON.stringify(artifact),
          artifact.createdAt
        ]
      );

      if (inserted.rowCount === 1) {
        return { status: "created" as const, artifact };
      }

      const existing = await client.query<PolicyStepRow>(
        `SELECT payload,snapshot_hash,artifact_hash,idempotency_key
         FROM orchestration_policy_step_snapshots
         WHERE portfolio_id=$1
           AND company_id=$2
           AND (
             idempotency_key=$3
             OR (
               run_id=$4
               AND validated_run_version=$5
               AND step_id=$6
             )
             OR id=$7
           )
         FOR SHARE`,
        [
          artifact.portfolioId,
          artifact.companyId,
          idempotencyKey,
          artifact.runId,
          artifact.validatedRunVersion,
          artifact.stepId,
          artifact.id
        ]
      );

      const prior = existing.rows[0];
      if (
        prior
        && prior.idempotency_key === idempotencyKey
        && prior.snapshot_hash === artifact.snapshot.snapshotHash
        && prior.artifact_hash === artifact.artifactHash
      ) {
        assertDurablePolicyStepSnapshotArtifact(prior.payload);
        return {
          status: "idempotent-replay" as const,
          artifact: prior.payload
        };
      }

      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Policy step snapshot conflicts with existing run/version/step or idempotency key",
        { correlationId: artifact.correlationId }
      );
    });
  }

  async getByRunVersionStep(
    runId: string,
    validatedRunVersion: number,
    stepId: string
  ): Promise<DurablePolicyStepSnapshotArtifact | null> {
    const result = await this.db.query<{ payload: DurablePolicyStepSnapshotArtifact }>(
      `SELECT payload
       FROM orchestration_policy_step_snapshots
       WHERE run_id=$1 AND validated_run_version=$2 AND step_id=$3`,
      [runId, validatedRunVersion, stepId]
    );
    const artifact = result.rows[0]?.payload ?? null;
    if (artifact) assertDurablePolicyStepSnapshotArtifact(artifact);
    return artifact;
  }
}

export class PostgresOrchestrationPolicyEvaluationStore
  implements OrchestrationPolicyEvaluationStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async create(
    artifact: DurablePolicyEvaluationArtifact,
    idempotencyKey: string
  ) {
    if (!idempotencyKey.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Policy evaluation idempotency key is required"
      );
    }
    assertDurablePolicyEvaluationArtifact(artifact);

    return this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO orchestration_policy_evaluations
          (
            id,run_id,portfolio_id,company_id,validated_run_version,
            plan_artifact_id,plan_artifact_hash,plan_hash,
            validation_receipt_id,validation_receipt_hash,
            aggregate_disposition,policy_engine_version,policy_rules_hash,
            artifact_hash,idempotency_key,payload,created_at
          )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
         ON CONFLICT DO NOTHING`,
        [
          artifact.id,
          artifact.runId,
          artifact.portfolioId,
          artifact.companyId,
          artifact.validatedRunVersion,
          artifact.planArtifactId,
          artifact.planArtifactHash,
          artifact.planHash,
          artifact.validationReceiptId,
          artifact.validationReceiptHash,
          artifact.aggregateDisposition,
          artifact.policyEngineVersion,
          artifact.policyRulesHash,
          artifact.artifactHash,
          idempotencyKey,
          JSON.stringify(artifact),
          artifact.createdAt
        ]
      );

      if (inserted.rowCount === 1) {
        return { status: "created" as const, artifact };
      }

      const existing = await client.query<PolicyRow>(
        `SELECT payload,artifact_hash,idempotency_key
         FROM orchestration_policy_evaluations
         WHERE portfolio_id=$1
           AND company_id=$2
           AND (
             idempotency_key=$3
             OR (run_id=$4 AND validated_run_version=$5)
             OR id=$6
           )
         FOR SHARE`,
        [
          artifact.portfolioId,
          artifact.companyId,
          idempotencyKey,
          artifact.runId,
          artifact.validatedRunVersion,
          artifact.id
        ]
      );

      const prior = existing.rows[0];
      if (
        prior
        && prior.idempotency_key === idempotencyKey
        && prior.artifact_hash === artifact.artifactHash
      ) {
        assertDurablePolicyEvaluationArtifact(prior.payload);
        return {
          status: "idempotent-replay" as const,
          artifact: prior.payload
        };
      }

      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Policy evaluation artifact conflicts with existing run/version or idempotency key",
        { correlationId: artifact.correlationId }
      );
    });
  }

  async get(id: string): Promise<DurablePolicyEvaluationArtifact | null> {
    const result = await this.db.query<{ payload: DurablePolicyEvaluationArtifact }>(
      "SELECT payload FROM orchestration_policy_evaluations WHERE id=$1",
      [id]
    );
    const artifact = result.rows[0]?.payload ?? null;
    if (artifact) assertDurablePolicyEvaluationArtifact(artifact);
    return artifact;
  }

  async getByRunVersion(
    runId: string,
    validatedRunVersion: number
  ): Promise<DurablePolicyEvaluationArtifact | null> {
    const result = await this.db.query<{ payload: DurablePolicyEvaluationArtifact }>(
      `SELECT payload
       FROM orchestration_policy_evaluations
       WHERE run_id=$1 AND validated_run_version=$2`,
      [runId, validatedRunVersion]
    );
    const artifact = result.rows[0]?.payload ?? null;
    if (artifact) assertDurablePolicyEvaluationArtifact(artifact);
    return artifact;
  }
}
