import { describe, expect, it } from "vitest";
import type {
  PoolClient,
  QueryResult,
  QueryResultRow
} from "pg";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createAuthorizationConsumptionRecord,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant
} from "@/lib/authorization/grants";
import type {
  OrchestrationJobArtifact,
  OrchestrationTaskArtifact
} from "@/lib/orchestration/task-job-materialization";
import { PostgresOrchestrationTaskJobMaterializationStore } from "@/lib/persistence/postgres/orchestration-task-job-store";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import {
  autoGrantFor,
  fixtureNow,
  receiptFor
} from "@/lib/planning/test-security-fixture";
import { validPlan } from "@/lib/planning/test-fixture";
import type { GeneratedTask } from "@/lib/planning/task-generator";

class MaterializationDb implements PostgresTransactionalDatabase {
  readonly entities = new Map<string, unknown>();
  readonly consumptions = new Map<string, AuthorizationConsumptionRecord>();
  readonly grants = new Map<string, AuthorizationGrant>();

  constructor(grant: AuthorizationGrant) {
    this.grants.set(grant.id, grant);
  }

  private result<R extends QueryResultRow>(
    rows: R[],
    rowCount = rows.length
  ): QueryResult<R> {
    return {
      command: "",
      rowCount,
      oid: 0,
      fields: [],
      rows
    };
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<R>> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("SELECT status,grant_hash,payload FROM authorization_grants")) {
      const grant = this.grants.get(String(values[0]));
      if (!grant) return this.result<R>([], 0);
      return this.result([{
        status: grant.status,
        grant_hash: grant.grantHash,
        payload: grant
      } as unknown as R]);
    }

    if (sql.startsWith("SELECT payload FROM authorization_consumptions")) {
      const record = this.consumptions.get(String(values[0]));
      return record
        ? this.result([{ payload: record } as unknown as R])
        : this.result<R>([], 0);
    }

    if (sql.startsWith("INSERT INTO authorization_consumptions")) {
      const grantId = String(values[1]);
      if (this.consumptions.has(grantId)) {
        const error = Object.assign(new Error("duplicate consumption"), { code: "23505" });
        throw error;
      }
      const payload = JSON.parse(String(values[6])) as AuthorizationConsumptionRecord;
      this.consumptions.set(grantId, payload);
      return this.result<R>([], 1);
    }

    if (
      sql.startsWith("SELECT payload FROM control_plane_entities")
      && sql.includes("WHERE entity_type=$1 AND id=$2")
    ) {
      const payload = this.entities.get(`${String(values[0])}:${String(values[1])}`);
      return payload === undefined
        ? this.result<R>([], 0)
        : this.result([{ payload } as unknown as R]);
    }

    if (sql.startsWith("INSERT INTO control_plane_entities")) {
      const key = `${String(values[0])}:${String(values[1])}`;
      if (this.entities.has(key)) return this.result<R>([], 0);
      this.entities.set(key, JSON.parse(String(values[6])));
      return this.result<R>([], 1);
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    return operation(this as unknown as PoolClient);
  }
}

function fixture() {
  const plan = validPlan();
  const receipt = receiptFor(plan);
  const grant = autoGrantFor(plan, plan.steps[0]!.id, receipt);
  const step = plan.steps[0]!;
  const taskId = "task:run-1:step-1";
  const consumption = createAuthorizationConsumptionRecord({
    id: `authorization-consumption:${grant.id}`,
    grant,
    consumerType: "task",
    consumerId: taskId,
    consumedAt: new Date(fixtureNow.getTime() + 1_000).toISOString()
  });
  const generatedTask: GeneratedTask = Object.freeze({
    id: taskId,
    logicalKey: "portfolio-a:company-a:objective:objective-1:fixture",
    planId: plan.id,
    planStepId: step.id,
    scope: Object.freeze({
      userId: grant.scope.userId,
      portfolioId: grant.scope.portfolioId,
      companyId: grant.scope.companyId,
      environment: grant.scope.environment,
      resourceId: grant.scope.resourceId,
      dataClass: plan.scope.dataClass
    }),
    source: Object.freeze({
      type: plan.source.type,
      referenceId: "objective-1"
    }),
    reason: step.reason,
    evidenceIds: Object.freeze([...step.evidenceIds]),
    priority: "normal",
    capabilityRequirements: Object.freeze(
      step.capabilityRequests.map((item) => item.capability)
    ),
    operations: step.capabilityRequests,
    authorizationLineage: Object.freeze([Object.freeze({
      kind: "auto-policy" as const,
      referenceId: grant.id,
      grantedAt: grant.issuedAt,
      actorId: grant.actor.id
    })]),
    authorizationGrantId: grant.id,
    authorizationGrantHash: grant.grantHash,
    authorizationConsumption: consumption,
    validationReceiptId: receipt.id,
    validationReceiptHash: receipt.receiptHash,
    policySnapshotId: grant.policySnapshotId,
    policySnapshotHash: grant.policySnapshotHash,
    dependsOnLogicalKeys: Object.freeze([]),
    preconditions: step.preconditions,
    resourceRequirements: step.resourceRequirements,
    verificationRequirements: step.verificationRequirements,
    rollback: step.rollback,
    estimatedCostCents: step.estimatedCostCents,
    createdAt: new Date(fixtureNow.getTime() + 1_000).toISOString()
  });

  const taskBase = {
    id: `task-artifact:${taskId}`,
    taskId,
    correlationId: "correlation-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    objectiveId: "objective-1",
    orchestrationRunId: "run-1",
    planId: plan.id,
    planHash: grant.planHash,
    authorizationGrantId: grant.id,
    authorizationGrantHash: grant.grantHash,
    authorizationConsumptionHash: consumption.consumptionHash,
    capability: Object.freeze([...generatedTask.capabilityRequirements]),
    inputs: Object.freeze(generatedTask.operations.map((item) => item.input)),
    dependencies: Object.freeze([]),
    riskClass: step.risk.level,
    status: "ready" as const,
    createdAt: generatedTask.createdAt,
    generatedTask
  };
  const task: OrchestrationTaskArtifact = Object.freeze({
    ...taskBase,
    taskHash: sha256Hex(taskBase)
  });

  const jobId = `job:${taskId}:op-1`;
  const operation = generatedTask.operations[0]!;
  const inputHash = sha256Hex({
    capabilityId: operation.capability,
    input: operation.input
  });
  const authorityLineage = Object.freeze({
    orchestrationRunId: "run-1",
    planId: plan.id,
    planHash: grant.planHash,
    validationReceiptId: receipt.id,
    validationReceiptHash: receipt.receiptHash,
    policyArtifactId: "policy-artifact-1",
    policyArtifactHash: "a".repeat(64),
    authorizationGrantId: grant.id,
    authorizationGrantHash: grant.grantHash,
    authorizationConsumptionHash: consumption.consumptionHash,
    taskId,
    taskHash: task.taskHash,
    taskDagId: "task-dag:run-1:v8",
    taskDagHash: "b".repeat(64)
  });
  const jobBase = {
    id: `job-artifact:${jobId}`,
    jobId,
    correlationId: "correlation-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    taskId,
    capabilityId: operation.capability,
    integrationId: null,
    authorityLineage,
    input: operation.input,
    inputHash,
    idempotencyKey: `orchestration:run-1:v9:job-enqueue:${jobId}`,
    sideEffectIdempotencyKey: `job:${jobId}:side-effect:${operation.capability}`,
    sideEffectIdempotencyKeyPrefix: `job:${jobId}:side-effect`,
    dependencyJobIds: Object.freeze([]),
    retryPolicy: Object.freeze({
      maxAttempts: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 120_000
    }),
    executionLimits: Object.freeze({
      environment: "staging" as const,
      maxJobCostCents: step.resourceRequirements.economics.maxJobCostCents
    }),
    verificationRequirements: Object.freeze(
      step.verificationRequirements.map((item) => Object.freeze({ ...item }))
    ),
    status: "pending-binding" as const,
    createdAt: generatedTask.createdAt
  };
  const job: OrchestrationJobArtifact = Object.freeze({
    ...jobBase,
    jobHash: sha256Hex(jobBase)
  });

  return { grant, consumption, task, job };
}

describe("Postgres Tranche A materialization store", () => {
  it("atomically persists exact Task consumption and replay-safe Task/Job records", async () => {
    const built = fixture();
    const db = new MaterializationDb(built.grant);
    const store = new PostgresOrchestrationTaskJobMaterializationStore(
      db,
      () => new Date(fixtureNow.getTime() + 2_000)
    );

    await expect(store.claimTask(built.task, built.consumption))
      .resolves.toMatchObject({ created: true });
    await expect(store.claimTask(built.task, built.consumption))
      .resolves.toMatchObject({ created: false });

    expect(db.consumptions.size).toBe(1);
    expect(db.entities.has(`task:${built.task.taskId}`)).toBe(true);
    expect(db.entities.has(`orchestration-task-artifact:${built.task.id}`)).toBe(true);

    await expect(store.claimJob(built.job, built.task))
      .resolves.toMatchObject({ created: true });
    await expect(store.claimJob(built.job, built.task))
      .resolves.toMatchObject({ created: false });

    expect(db.entities.has(`job:${built.job.jobId}`)).toBe(true);
    expect(db.entities.has(`orchestration-job-artifact:${built.job.id}`)).toBe(true);
  });

  it("rejects deterministic Job ID replay when authoritative content changes", async () => {
    const built = fixture();
    const db = new MaterializationDb(built.grant);
    const store = new PostgresOrchestrationTaskJobMaterializationStore(
      db,
      () => new Date(fixtureNow.getTime() + 2_000)
    );
    await store.claimTask(built.task, built.consumption);
    await store.claimJob(built.job, built.task);

    const mutatedBase = {
      ...built.job,
      inputHash: "c".repeat(64)
    };
    delete (mutatedBase as Partial<OrchestrationJobArtifact>).jobHash;
    const mutated: OrchestrationJobArtifact = {
      ...mutatedBase,
      jobHash: sha256Hex(mutatedBase)
    } as OrchestrationJobArtifact;

    await expect(store.claimJob(mutated, built.task))
      .rejects.toThrow(/replay changed authoritative content/i);
  });

  it("re-checks revocation and tenant scope inside the materialization transaction", async () => {
    const built = fixture();
    const db = new MaterializationDb(built.grant);
    const store = new PostgresOrchestrationTaskJobMaterializationStore(
      db,
      () => new Date(fixtureNow.getTime() + 2_000)
    );

    db.grants.set(built.grant.id, { ...built.grant, status: "revoked" });
    await expect(store.claimTask(built.task, built.consumption))
      .rejects.toThrow(/non-revoked AuthorizationGrant/i);

    db.grants.set(built.grant.id, built.grant);
    const crossCompanyBase = {
      ...built.task,
      companyId: "company-b"
    };
    delete (crossCompanyBase as Partial<OrchestrationTaskArtifact>).taskHash;
    const crossCompany: OrchestrationTaskArtifact = {
      ...crossCompanyBase,
      taskHash: sha256Hex(crossCompanyBase)
    } as OrchestrationTaskArtifact;

    await expect(store.claimTask(crossCompany, built.consumption))
      .rejects.toThrow(/scope|integrity/i);
  });
});
