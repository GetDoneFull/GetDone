import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AuthorizationConsumptionRecord
} from "@/lib/authorization/grants";
import type {
  DurableJobGraphArtifact,
  DurableTaskDagArtifact,
  OrchestrationJobGraphStore,
  OrchestrationJobNode,
  OrchestrationJobNodeState,
  OrchestrationTaskDagStore
} from "@/lib/orchestration/post-authorization-flow";
import type {
  GeneratedTask,
  TaskGenerationDedupeStore
} from "@/lib/planning/task-generator";
import {
  PostgresAuthorizationGrantStore
} from "@/lib/persistence/postgres/authority-stores";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";

export const POSTGRES_ORCHESTRATION_EXECUTION_STORES_VERSION = "1.0.0";

function assertHash(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new ControlPlaneError("FORBIDDEN", `${label} is not a SHA-256 hash`);
  }
}

export class PostgresOrchestrationTaskDedupeStore
  implements TaskGenerationDedupeStore {
  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly runId: string
  ) {}

  async claim(
    task: GeneratedTask,
    consumption: AuthorizationConsumptionRecord
  ) {
    return this.db.transaction(async (client) => {
      const existing = await client.query<{
        payload: GeneratedTask;
        task_hash: string;
        authorization_consumption_hash: string;
      }>(
        `SELECT payload,task_hash,authorization_consumption_hash
         FROM orchestration_task_materializations
         WHERE run_id=$1 AND logical_key=$2
         FOR UPDATE`,
        [this.runId, task.logicalKey]
      );
      const prior = existing.rows[0];
      if (prior) {
        const priorHash = sha256Hex(prior.payload);
        if (
          prior.task_hash !== priorHash
          || prior.authorization_consumption_hash
            !== prior.payload.authorizationConsumption.consumptionHash
        ) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Persisted Task materialization integrity check failed"
          );
        }
        return {
          created: false,
          task: prior.payload,
          consumption: prior.payload.authorizationConsumption
        };
      }

      if (
        consumption.consumerType !== "task"
        || consumption.consumerId !== task.id
        || consumption.grantId !== task.authorizationGrantId
        || consumption.grantHash !== task.authorizationGrantHash
        || consumption.consumptionHash
          !== task.authorizationConsumption.consumptionHash
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Task materialization is not bound to its exact AuthorizationGrant consumption"
        );
      }

      const grants = new PostgresAuthorizationGrantStore(client);
      await grants.consume(consumption);
      const taskHash = sha256Hex(task);
      await client.query(
        `INSERT INTO orchestration_task_materializations(
          id,run_id,logical_key,plan_step_id,portfolio_id,company_id,grant_id,
          authorization_consumption_hash,task_hash,payload,created_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          task.id,
          this.runId,
          task.logicalKey,
          task.planStepId,
          task.scope.portfolioId,
          task.scope.companyId,
          task.authorizationGrantId,
          consumption.consumptionHash,
          taskHash,
          JSON.stringify(task),
          task.createdAt
        ]
      );
      return { created: true, task, consumption };
    });
  }
}

export class PostgresOrchestrationTaskDagStore
  implements OrchestrationTaskDagStore {
  constructor(private readonly db: SqlQueryable) {}

  async create(artifact: DurableTaskDagArtifact, idempotencyKey: string) {
    if (!idempotencyKey.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Task DAG idempotency key is required");
    }
    assertHash(artifact.artifactHash, "Task DAG artifact hash");
    const inserted = await this.db.query(
      `INSERT INTO orchestration_task_dags(
        id,run_id,portfolio_id,company_id,plan_hash,validation_receipt_hash,
        artifact_hash,payload,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
      ON CONFLICT (run_id) DO NOTHING`,
      [
        artifact.id,
        artifact.runId,
        artifact.portfolioId,
        artifact.companyId,
        artifact.planHash,
        artifact.validationReceiptHash,
        artifact.artifactHash,
        JSON.stringify(artifact),
        artifact.createdAt
      ]
    );
    if (inserted.rowCount === 1) {
      return { status: "created" as const, artifact };
    }
    const existing = await this.getByRunId(artifact.runId);
    if (existing?.artifactHash === artifact.artifactHash) {
      return { status: "idempotent-replay" as const, artifact: existing };
    }
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Task DAG already exists with different authoritative content"
    );
  }

  async get(id: string) {
    const result = await this.db.query<{ payload: DurableTaskDagArtifact }>(
      "SELECT payload FROM orchestration_task_dags WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }

  async getByRunId(runId: string) {
    const result = await this.db.query<{ payload: DurableTaskDagArtifact }>(
      "SELECT payload FROM orchestration_task_dags WHERE run_id=$1",
      [runId]
    );
    return result.rows[0]?.payload ?? null;
  }
}

export class PostgresOrchestrationJobGraphStore
  implements OrchestrationJobGraphStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async create(artifact: DurableJobGraphArtifact, idempotencyKey: string) {
    if (!idempotencyKey.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Job graph idempotency key is required");
    }
    assertHash(artifact.artifactHash, "Job graph artifact hash");
    return this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO orchestration_job_graphs(
          id,run_id,portfolio_id,company_id,task_dag_id,task_dag_hash,
          artifact_hash,payload,created_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
        ON CONFLICT (run_id) DO NOTHING`,
        [
          artifact.id,
          artifact.runId,
          artifact.portfolioId,
          artifact.companyId,
          artifact.taskDagId,
          artifact.taskDagHash,
          artifact.artifactHash,
          JSON.stringify(artifact),
          artifact.createdAt
        ]
      );
      if (inserted.rowCount === 0) {
        const existing = await this.getByRunIdWith(client, artifact.runId);
        if (existing?.artifactHash === artifact.artifactHash) {
          return { status: "idempotent-replay" as const, artifact: existing };
        }
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "Job graph already exists with different authoritative content"
        );
      }

      for (const job of artifact.jobs) {
        await client.query(
          `INSERT INTO orchestration_job_nodes(
            id,run_id,node_id,task_id,portfolio_id,company_id,capability,state,
            definition_hash,verification_request_id,verification_receipt_id,
            verification_receipt_hash,payload,created_at,updated_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)`,
          [
            job.id,
            artifact.runId,
            job.nodeId,
            job.taskId,
            artifact.portfolioId,
            artifact.companyId,
            job.capability,
            job.state,
            job.nodeHash,
            job.verificationRequestId ?? null,
            job.verificationReceiptId ?? null,
            job.verificationReceiptHash ?? null,
            JSON.stringify(job),
            job.createdAt,
            job.updatedAt
          ]
        );
      }
      return { status: "created" as const, artifact };
    });
  }

  private async getByRunIdWith(db: SqlQueryable, runId: string) {
    const result = await db.query<{ payload: DurableJobGraphArtifact }>(
      "SELECT payload FROM orchestration_job_graphs WHERE run_id=$1",
      [runId]
    );
    return result.rows[0]?.payload ?? null;
  }

  getByRunId(runId: string) {
    return this.getByRunIdWith(this.db, runId);
  }

  async listNodes(runId: string): Promise<readonly OrchestrationJobNode[]> {
    const result = await this.db.query<{ payload: OrchestrationJobNode }>(
      `SELECT payload
       FROM orchestration_job_nodes
       WHERE run_id=$1
       ORDER BY node_id`,
      [runId]
    );
    return Object.freeze(result.rows.map((row) => row.payload));
  }

  async updateNode(input: {
    job: OrchestrationJobNode;
    expectedState: OrchestrationJobNodeState;
  }) {
    const { nodeHash: _priorHash, ...hashBase } = input.job;
    const nextHash = sha256Hex(hashBase);
    const next = Object.freeze({ ...hashBase, nodeHash: nextHash });
    const result = await this.db.query(
      `UPDATE orchestration_job_nodes
       SET state=$4,
           verification_request_id=$5,
           verification_receipt_id=$6,
           verification_receipt_hash=$7,
           definition_hash=$8,
           payload=$9::jsonb,
           updated_at=$10
       WHERE id=$1 AND run_id=$2 AND state=$3`,
      [
        next.id,
        next.runId,
        input.expectedState,
        next.state,
        next.verificationRequestId ?? null,
        next.verificationReceiptId ?? null,
        next.verificationReceiptHash ?? null,
        next.nodeHash,
        JSON.stringify(next),
        next.updatedAt
      ]
    );
    if (result.rowCount !== 1) {
      const current = await this.db.query<{ payload: OrchestrationJobNode }>(
        "SELECT payload FROM orchestration_job_nodes WHERE id=$1 AND run_id=$2",
        [next.id, next.runId]
      );
      const existing = current.rows[0]?.payload;
      if (existing && existing.state === next.state) return existing;
      throw new ControlPlaneError(
        "CONFLICT",
        "Orchestration Job node changed before compare-and-swap update"
      );
    }
    await this.refreshGraph(next.runId);
    return next;
  }

  private async refreshGraph(runId: string) {
    const graph = await this.getByRunIdWith(this.db, runId);
    if (!graph) throw new ControlPlaneError("NOT_FOUND", "Job graph was not found");
    const jobs = await this.listNodes(runId);
    const base = {
      id: graph.id,
      runId: graph.runId,
      correlationId: graph.correlationId,
      portfolioId: graph.portfolioId,
      companyId: graph.companyId,
      taskDagId: graph.taskDagId,
      taskDagHash: graph.taskDagHash,
      jobs,
      createdAt: graph.createdAt
    };
    const updated = Object.freeze({ ...base, artifactHash: sha256Hex(base) });
    await this.db.query(
      `UPDATE orchestration_job_graphs
       SET artifact_hash=$2,payload=$3::jsonb
       WHERE run_id=$1`,
      [runId, updated.artifactHash, JSON.stringify(updated)]
    );
    return updated;
  }
}
