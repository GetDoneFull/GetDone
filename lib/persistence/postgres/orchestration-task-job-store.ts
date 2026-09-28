import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizationConsumption,
  assertAuthorizationGrantEnvelope,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant
} from "@/lib/authorization/grants";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import {
  assertJobArtifact,
  assertTaskArtifact,
  assertTaskDagArtifact,
  type OrchestrationJobArtifact,
  type OrchestrationTaskArtifact,
  type OrchestrationTaskJobMaterializationStore,
  type TaskDagArtifact
} from "@/lib/orchestration/task-job-materialization";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";

const TASK_ARTIFACT_TYPE = "orchestration-task-artifact";
const TASK_DAG_TYPE = "orchestration-task-dag";
const JOB_ARTIFACT_TYPE = "orchestration-job-artifact";

type MaterializedTaskRecord = TaskRecord & {
  objectiveId: string | null;
  orchestrationRunId: string;
  planId: string;
  planHash: string;
  authorizationConsumptionHash: string;
  capability: readonly string[];
  inputs: readonly unknown[];
  dependencies: readonly string[];
  riskClass: OrchestrationTaskArtifact["riskClass"];
  materializationStatus: OrchestrationTaskArtifact["status"];
  materializationHash: string;
  createdAt: string;
};

type MaterializedJobRecord = JobRecord & {
  capabilityId: string;
  integrationId: string | null;
  authorityLineage: OrchestrationJobArtifact["authorityLineage"];
  inputHash: string;
  idempotencyKey: string;
  sideEffectIdempotencyKey: string;
  retryPolicy: OrchestrationJobArtifact["retryPolicy"];
  executionLimits: OrchestrationJobArtifact["executionLimits"];
  verificationRequirements: OrchestrationJobArtifact["verificationRequirements"];
  materializationStatus: OrchestrationJobArtifact["status"];
  materializationHash: string;
  createdAt: string;
};

function exactScope(
  artifact: { portfolioId: string; companyId: string },
  expected: { portfolioId: string; companyId: string }
) {
  if (
    artifact.portfolioId !== expected.portfolioId
    || artifact.companyId !== expected.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authoritative materialization crosses portfolio/company scope"
    );
  }
}

async function getEntity<T>(
  db: SqlQueryable,
  entityType: string,
  id: string
): Promise<T | null> {
  const result = await db.query<{ payload: T }>(
    `SELECT payload
     FROM control_plane_entities
     WHERE entity_type=$1 AND id=$2`,
    [entityType, id]
  );
  return result.rows[0]?.payload ?? null;
}

async function getEntityForUpdate<T>(
  db: SqlQueryable,
  entityType: string,
  id: string
): Promise<T | null> {
  const result = await db.query<{ payload: T }>(
    `SELECT payload
     FROM control_plane_entities
     WHERE entity_type=$1 AND id=$2
     FOR UPDATE`,
    [entityType, id]
  );
  return result.rows[0]?.payload ?? null;
}

async function insertEntity(
  db: SqlQueryable,
  input: {
    entityType: string;
    id: string;
    portfolioId: string;
    companyId: string;
    version: number;
    updatedAt: string;
    payload: unknown;
  }
) {
  return db.query(
    `INSERT INTO control_plane_entities
      (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (entity_type,id) DO NOTHING`,
    [
      input.entityType,
      input.id,
      input.portfolioId,
      input.companyId,
      input.version,
      input.updatedAt,
      JSON.stringify(input.payload)
    ]
  );
}

async function authoritativeGrant(
  db: SqlQueryable,
  artifact: OrchestrationTaskArtifact,
  now: number
) {
  const result = await db.query<{
    status: AuthorizationGrant["status"];
    grant_hash: string;
    payload: AuthorizationGrant;
  }>(
    `SELECT status,grant_hash,payload
     FROM authorization_grants
     WHERE id=$1
     FOR UPDATE`,
    [artifact.authorizationGrantId]
  );
  const row = result.rows[0];
  if (
    !row
    || row.status !== "active"
    || row.grant_hash !== artifact.authorizationGrantHash
    || row.payload.grantHash !== artifact.authorizationGrantHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Task materialization requires the current non-revoked AuthorizationGrant"
    );
  }
  exactScope(artifact, row.payload.scope);
  assertAuthorizationGrantEnvelope(row.payload, artifact.generatedTask.scope, now);
  return row.payload;
}

async function authoritativeConsumption(
  db: SqlQueryable,
  grant: AuthorizationGrant
) {
  const result = await db.query<{ payload: AuthorizationConsumptionRecord }>(
    `SELECT payload
     FROM authorization_consumptions
     WHERE grant_id=$1
     FOR UPDATE`,
    [grant.id]
  );
  return result.rows[0]?.payload ?? null;
}

function taskRecord(
  artifact: OrchestrationTaskArtifact,
  consumption: AuthorizationConsumptionRecord
): MaterializedTaskRecord {
  const generated = artifact.generatedTask;
  return Object.freeze({
    id: artifact.taskId,
    correlationId: artifact.correlationId,
    portfolioId: artifact.portfolioId,
    companyId: artifact.companyId,
    state: "authorized" as const,
    reason: generated.reason,
    evidenceIds: Object.freeze([...generated.evidenceIds]),
    capabilityRequirements: Object.freeze([...generated.capabilityRequirements]),
    dependencyTaskIds: Object.freeze([...artifact.dependencies]),
    authorizationLineage: Object.freeze([artifact.authorizationGrantId]),
    authorizationGrantId: artifact.authorizationGrantId,
    authorizationGrantHash: artifact.authorizationGrantHash,
    authorizationConsumption: consumption,
    verificationEvidenceIds: Object.freeze([]),
    retryCount: 0,
    maxRetries: 3,
    version: 1,
    updatedAt: artifact.createdAt,
    objectiveId: artifact.objectiveId,
    orchestrationRunId: artifact.orchestrationRunId,
    planId: artifact.planId,
    planHash: artifact.planHash,
    authorizationConsumptionHash: artifact.authorizationConsumptionHash,
    capability: Object.freeze([...artifact.capability]),
    inputs: Object.freeze([...artifact.inputs]),
    dependencies: Object.freeze([...artifact.dependencies]),
    riskClass: artifact.riskClass,
    materializationStatus: artifact.status,
    materializationHash: artifact.taskHash,
    createdAt: artifact.createdAt
  });
}

function jobRecord(
  artifact: OrchestrationJobArtifact,
  task: OrchestrationTaskArtifact
): MaterializedJobRecord {
  const consumption = task.generatedTask.authorizationConsumption;
  return Object.freeze({
    id: artifact.jobId,
    correlationId: artifact.correlationId,
    portfolioId: artifact.portfolioId,
    companyId: artifact.companyId,
    state: "created" as const,
    taskId: artifact.taskId,
    dependencyJobIds: Object.freeze([...artifact.dependencyJobIds]),
    attempt: 0,
    maxAttempts: artifact.retryPolicy.maxAttempts,
    authorizationGrantId: task.authorizationGrantId,
    authorizationGrantHash: task.authorizationGrantHash,
    authorizationConsumption: consumption,
    verificationEvidenceIds: Object.freeze([]),
    version: 1,
    updatedAt: artifact.createdAt,
    capabilityId: artifact.capabilityId,
    integrationId: artifact.integrationId,
    authorityLineage: artifact.authorityLineage,
    inputHash: artifact.inputHash,
    idempotencyKey: artifact.idempotencyKey,
    sideEffectIdempotencyKey: artifact.sideEffectIdempotencyKey,
    retryPolicy: artifact.retryPolicy,
    executionLimits: artifact.executionLimits,
    verificationRequirements: artifact.verificationRequirements,
    materializationStatus: artifact.status,
    materializationHash: artifact.jobHash,
    createdAt: artifact.createdAt
  });
}

function taskReplayMatches(
  existing: MaterializedTaskRecord,
  artifact: OrchestrationTaskArtifact
) {
  return (
    existing.materializationHash === artifact.taskHash
    && existing.portfolioId === artifact.portfolioId
    && existing.companyId === artifact.companyId
    && existing.authorizationConsumptionHash === artifact.authorizationConsumptionHash
  );
}

function jobReplayMatches(
  existing: MaterializedJobRecord,
  artifact: OrchestrationJobArtifact
) {
  return (
    existing.materializationHash === artifact.jobHash
    && existing.portfolioId === artifact.portfolioId
    && existing.companyId === artifact.companyId
    && existing.taskId === artifact.taskId
  );
}

export class PostgresOrchestrationTaskJobMaterializationStore
  implements OrchestrationTaskJobMaterializationStore {
  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  async claimTask(
    artifact: OrchestrationTaskArtifact,
    consumption: AuthorizationConsumptionRecord
  ) {
    assertTaskArtifact(artifact);
    if (
      consumption.consumptionHash !== artifact.authorizationConsumptionHash
      || consumption.consumerType !== "task"
      || consumption.consumerId !== artifact.taskId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Task materialization authorization consumption does not match the Task"
      );
    }

    return this.db.transaction(async (client) => {
      const grant = await authoritativeGrant(
        client,
        artifact,
        this.now().getTime()
      );
      assertAuthorizationConsumption(consumption, grant);

      const existingConsumption = await authoritativeConsumption(client, grant);
      if (
        existingConsumption
        && existingConsumption.consumptionHash !== consumption.consumptionHash
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "AuthorizationGrant was already consumed by different work"
        );
      }

      const existingArtifact = await getEntityForUpdate<OrchestrationTaskArtifact>(
        client,
        TASK_ARTIFACT_TYPE,
        artifact.id
      );
      if (existingArtifact) {
        assertTaskArtifact(existingArtifact);
        exactScope(existingArtifact, artifact);
        if (existingArtifact.taskHash !== artifact.taskHash) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Deterministic Task replay changed authoritative content"
          );
        }
        const existingTask = await getEntityForUpdate<MaterializedTaskRecord>(
          client,
          "task",
          artifact.taskId
        );
        if (!existingTask || !taskReplayMatches(existingTask, artifact)) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Task artifact exists without its exact authoritative Task record"
          );
        }
        if (!existingConsumption) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Task artifact exists without authoritative grant consumption"
          );
        }
        return {
          created: false,
          artifact: existingArtifact,
          consumption: existingConsumption
        };
      }

      if (!existingConsumption) {
        await client.query(
          `INSERT INTO authorization_consumptions
            (id,grant_id,consumer_type,consumer_id,consumption_hash,consumed_at,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            consumption.id,
            consumption.grantId,
            consumption.consumerType,
            consumption.consumerId,
            consumption.consumptionHash,
            consumption.consumedAt,
            JSON.stringify(consumption)
          ]
        );
      }

      const runtimeTask = taskRecord(artifact, consumption);
      const taskInsert = await insertEntity(client, {
        entityType: "task",
        id: runtimeTask.id,
        portfolioId: runtimeTask.portfolioId,
        companyId: runtimeTask.companyId,
        version: runtimeTask.version,
        updatedAt: runtimeTask.updatedAt,
        payload: runtimeTask
      });
      if (taskInsert.rowCount !== 1) {
        const existingTask = await getEntityForUpdate<MaterializedTaskRecord>(
          client,
          "task",
          runtimeTask.id
        );
        if (!existingTask || !taskReplayMatches(existingTask, artifact)) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Task ID already exists with different authoritative content"
          );
        }
      }

      await insertEntity(client, {
        entityType: TASK_ARTIFACT_TYPE,
        id: artifact.id,
        portfolioId: artifact.portfolioId,
        companyId: artifact.companyId,
        version: 1,
        updatedAt: artifact.createdAt,
        payload: artifact
      });

      return { created: true, artifact, consumption };
    });
  }

  getTask(taskId: string) {
    return getEntity<OrchestrationTaskArtifact>(
      this.db,
      TASK_ARTIFACT_TYPE,
      `task-artifact:${taskId}`
    );
  }

  async claimDag(dag: TaskDagArtifact) {
    assertTaskDagArtifact(dag);
    return this.db.transaction(async (client) => {
      const existing = await getEntityForUpdate<TaskDagArtifact>(
        client,
        TASK_DAG_TYPE,
        dag.id
      );
      if (existing) {
        assertTaskDagArtifact(existing);
        exactScope(existing, dag);
        if (existing.dagHash !== dag.dagHash) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Deterministic Task DAG replay changed authoritative content"
          );
        }
        return { created: false, dag: existing };
      }

      await insertEntity(client, {
        entityType: TASK_DAG_TYPE,
        id: dag.id,
        portfolioId: dag.portfolioId,
        companyId: dag.companyId,
        version: dag.dagVersion,
        updatedAt: dag.createdAt,
        payload: dag
      });
      return { created: true, dag };
    });
  }

  getDag(id: string) {
    return getEntity<TaskDagArtifact>(this.db, TASK_DAG_TYPE, id);
  }

  async claimJob(
    job: OrchestrationJobArtifact,
    task: OrchestrationTaskArtifact
  ) {
    assertJobArtifact(job);
    assertTaskArtifact(task);
    if (
      job.taskId !== task.taskId
      || job.portfolioId !== task.portfolioId
      || job.companyId !== task.companyId
      || job.authorityLineage.taskHash !== task.taskHash
      || job.authorityLineage.authorizationConsumptionHash
        !== task.authorizationConsumptionHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Job authority lineage does not match its authoritative parent Task"
      );
    }

    return this.db.transaction(async (client) => {
      const grant = await authoritativeGrant(
        client,
        task,
        this.now().getTime()
      );
      const persistedConsumption = await authoritativeConsumption(client, grant);
      if (
        !persistedConsumption
        || persistedConsumption.consumptionHash !== task.authorizationConsumptionHash
        || persistedConsumption.consumerType !== "task"
        || persistedConsumption.consumerId !== task.taskId
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Job materialization requires the exact authoritative Task grant consumption"
        );
      }
      assertAuthorizationConsumption(persistedConsumption, grant);

      const authoritativeTask = await getEntityForUpdate<MaterializedTaskRecord>(
        client,
        "task",
        task.taskId
      );
      if (!authoritativeTask || !taskReplayMatches(authoritativeTask, task)) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Job materialization requires the exact persisted parent Task"
        );
      }

      const existingArtifact = await getEntityForUpdate<OrchestrationJobArtifact>(
        client,
        JOB_ARTIFACT_TYPE,
        job.id
      );
      if (existingArtifact) {
        assertJobArtifact(existingArtifact);
        exactScope(existingArtifact, job);
        if (existingArtifact.jobHash !== job.jobHash) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Deterministic Job replay changed authoritative content"
          );
        }
        const existingJob = await getEntityForUpdate<MaterializedJobRecord>(
          client,
          "job",
          job.jobId
        );
        if (!existingJob || !jobReplayMatches(existingJob, job)) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Job artifact exists without its exact authoritative Job record"
          );
        }
        return { created: false, job: existingArtifact };
      }

      const runtimeJob = jobRecord(job, task);
      const jobInsert = await insertEntity(client, {
        entityType: "job",
        id: runtimeJob.id,
        portfolioId: runtimeJob.portfolioId,
        companyId: runtimeJob.companyId,
        version: runtimeJob.version,
        updatedAt: runtimeJob.updatedAt,
        payload: runtimeJob
      });
      if (jobInsert.rowCount !== 1) {
        const existingJob = await getEntityForUpdate<MaterializedJobRecord>(
          client,
          "job",
          runtimeJob.id
        );
        if (!existingJob || !jobReplayMatches(existingJob, job)) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Job ID already exists with different authoritative content"
          );
        }
      }

      await insertEntity(client, {
        entityType: JOB_ARTIFACT_TYPE,
        id: job.id,
        portfolioId: job.portfolioId,
        companyId: job.companyId,
        version: 1,
        updatedAt: job.createdAt,
        payload: job
      });

      return { created: true, job };
    });
  }

  getJob(jobId: string) {
    return getEntity<OrchestrationJobArtifact>(
      this.db,
      JOB_ARTIFACT_TYPE,
      `job-artifact:${jobId}`
    );
  }
}

export function materializedTaskRecordHash(record: MaterializedTaskRecord) {
  return sha256Hex(record);
}

export function materializedJobRecordHash(record: MaterializedJobRecord) {
  return sha256Hex(record);
}
