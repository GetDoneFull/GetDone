import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizationConsumption,
  assertAuthorizationGrant,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import { assertCurrentPolicyVersion } from "@/lib/domain/policy-registry";
import {
  transitionOrchestrationRun,
  type OrchestrationRunRecord,
  type TaskRef
} from "@/lib/orchestration/contracts";
import {
  assertPersistedPlanProposal,
  type OrchestrationPlanProposalStore,
  type PersistedPlanProposal
} from "@/lib/orchestration/planning-flow";
import type {
  OrchestrationStageHandler,
  OrchestrationStageOutcome
} from "@/lib/orchestration/worker-contracts";
import {
  assertDurablePolicyEvaluationArtifact,
  assertDurableValidationArtifact,
  type DurablePolicyEvaluationArtifact,
  type DurableValidationArtifact,
  type OrchestrationPolicyEvaluationStore,
  type OrchestrationValidationArtifactStore
} from "@/lib/orchestration/validation-policy-flow";
import {
  TaskGenerator,
  type GeneratedTask,
  type TaskGenerationDedupeStore
} from "@/lib/planning/task-generator";
import type {
  PlanProposal,
  VerificationRequirement
} from "@/lib/planning/plan-schema";

export const ORCHESTRATION_TASK_DAG_VERSION = 1;
export const ORCHESTRATION_TASK_JOB_FLOW_VERSION = "1.0.0";

export type MaterializedTaskStatus =
  | "ready"
  | "waiting"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export interface OrchestrationTaskArtifact {
  id: string;
  taskId: string;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  objectiveId: string | null;
  orchestrationRunId: string;
  planId: string;
  planHash: string;
  authorizationGrantId: string;
  authorizationGrantHash: string;
  authorizationConsumptionHash: string;
  capability: readonly string[];
  inputs: readonly unknown[];
  dependencies: readonly string[];
  riskClass: "low" | "medium" | "high" | "critical";
  status: MaterializedTaskStatus;
  createdAt: string;
  generatedTask: GeneratedTask;
  taskHash: string;
}

export interface TaskDagNode {
  taskId: string;
  planStepId: string;
  dependencies: readonly string[];
  dependents: readonly string[];
  initialStatus: "ready" | "waiting";
}

export interface TaskDagArtifact {
  id: string;
  correlationId: string;
  orchestrationRunId: string;
  sourceRunVersion: number;
  portfolioId: string;
  companyId: string;
  planId: string;
  planHash: string;
  dagVersion: number;
  nodes: readonly TaskDagNode[];
  topologicalOrder: readonly string[];
  taskGenerationIdempotencyKey: string;
  createdAt: string;
  dagHash: string;
}

export interface JobAuthorityLineage {
  orchestrationRunId: string;
  planId: string;
  planHash: string;
  validationReceiptId: string;
  validationReceiptHash: string;
  policyArtifactId: string;
  policyArtifactHash: string;
  authorizationGrantId: string;
  authorizationGrantHash: string;
  authorizationConsumptionHash: string;
  taskId: string;
  taskHash: string;
  taskDagId: string;
  taskDagHash: string;
}

export interface OrchestrationJobArtifact {
  id: string;
  jobId: string;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  taskId: string;
  capabilityId: string;
  integrationId: string | null;
  authorityLineage: JobAuthorityLineage;
  input: unknown;
  inputHash: string;
  idempotencyKey: string;
  sideEffectIdempotencyKey: string;
  sideEffectIdempotencyKeyPrefix: string;
  dependencyJobIds: readonly string[];
  retryPolicy: Readonly<{
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }>;
  executionLimits: Readonly<{
    environment: "development" | "staging" | "production";
    deadline?: string;
    expectedDurationSeconds?: number;
    maxJobCostCents?: number;
  }>;
  verificationRequirements: readonly VerificationRequirement[];
  status: "pending-binding";
  createdAt: string;
  jobHash: string;
}

export interface OrchestrationTaskJobMaterializationStore {
  claimTask(
    artifact: OrchestrationTaskArtifact,
    consumption: AuthorizationConsumptionRecord
  ): Promise<{
    created: boolean;
    artifact: OrchestrationTaskArtifact;
    consumption: AuthorizationConsumptionRecord;
  }>;
  getTask(taskId: string): Promise<OrchestrationTaskArtifact | null>;
  claimDag(
    dag: TaskDagArtifact
  ): Promise<{ created: boolean; dag: TaskDagArtifact }>;
  getDag(id: string): Promise<TaskDagArtifact | null>;
  claimJob(
    job: OrchestrationJobArtifact,
    task: OrchestrationTaskArtifact
  ): Promise<{ created: boolean; job: OrchestrationJobArtifact }>;
  getJob(jobId: string): Promise<OrchestrationJobArtifact | null>;
}

export interface MaterializationLineage {
  planArtifact: PersistedPlanProposal;
  validationArtifact: DurableValidationArtifact;
  policyArtifact: DurablePolicyEvaluationArtifact;
  grantsByStep: ReadonlyMap<string, AuthorizationGrant>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object) || Object.isFrozen(object)) return value;
  seen.add(object);
  Object.freeze(object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return value;
}

function objectiveId(plan: PlanProposal) {
  if (plan.source.type === "objective") return plan.source.objectiveId;
  return plan.objective?.id ?? null;
}

export function taskGenerationIdempotencyKey(run: OrchestrationRunRecord) {
  return `orchestration:${run.id}:v${run.version}:task-generation`;
}

export function jobEnqueueIdempotencyKey(run: OrchestrationRunRecord) {
  return `orchestration:${run.id}:v${run.version}:job-enqueue`;
}

export function deterministicTaskId(runId: string, stepId: string) {
  return `task:${runId}:${stepId}`;
}

export function deterministicJobId(taskId: string, operationIndex: number) {
  return `job:${taskId}:op-${operationIndex + 1}`;
}

function materializationCreatedAt(run: OrchestrationRunRecord) {
  return new Date(run.updatedAt).toISOString();
}

function policyStepFor(
  policy: DurablePolicyEvaluationArtifact,
  stepId: string
) {
  const step = policy.stepPolicies.find((candidate) => candidate.stepId === stepId);
  if (!step) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `Policy artifact is missing Plan step: ${stepId}`
    );
  }
  return step;
}

export function deterministicPlanDagOrder(plan: PlanProposal) {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        `Plan DAG contains duplicate step id: ${step.id}`
      );
    }
    ids.add(step.id);
  }

  const incoming = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of plan.steps) {
    incoming.set(step.id, 0);
    dependents.set(step.id, []);
  }

  for (const step of plan.steps) {
    const uniqueDependencies = [...new Set(step.dependsOn)];
    if (uniqueDependencies.length !== step.dependsOn.length) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        `Plan step contains duplicate dependencies: ${step.id}`
      );
    }
    if (uniqueDependencies.includes(step.id)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        `Plan step cannot depend on itself: ${step.id}`
      );
    }
    for (const dependency of uniqueDependencies) {
      if (!ids.has(dependency)) {
        throw new ControlPlaneError(
          "VALIDATION_FAILED",
          `Plan DAG references missing dependency ${dependency} from ${step.id}`
        );
      }
      incoming.set(step.id, (incoming.get(step.id) ?? 0) + 1);
      dependents.get(dependency)!.push(step.id);
    }
  }

  const ready = [...incoming.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift()!;
    ordered.push(next);
    for (const dependent of [...dependents.get(next)!].sort()) {
      const remaining = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (ordered.length !== plan.steps.length) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Plan DAG contains a dependency cycle"
    );
  }

  return Object.freeze(ordered);
}

async function loadMaterializationLineage(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  policies: OrchestrationPolicyEvaluationStore;
  grants: AuthorizationGrantStore;
  now: Date;
}): Promise<MaterializationLineage> {
  const planRef = input.run.checkpoints.plan;
  const validationRef = input.run.checkpoints.validationReceipt;
  const policyRef = input.run.checkpoints.policySnapshot;
  if (!planRef || !validationRef || !policyRef) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Task/Job materialization requires Plan, validation, and policy checkpoints"
    );
  }

  const [planArtifact, validationArtifact, policyArtifact] = await Promise.all([
    input.plans.get(planRef.id),
    input.validations.get(validationRef.id),
    input.policies.get(policyRef.id)
  ]);
  if (!planArtifact || !validationArtifact || !policyArtifact) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authoritative Plan/validation/policy lineage is missing"
    );
  }

  assertPersistedPlanProposal(planArtifact);
  assertDurableValidationArtifact(validationArtifact, planArtifact);
  assertDurablePolicyEvaluationArtifact(
    policyArtifact,
    planArtifact,
    validationArtifact
  );

  if (
    planRef.hash !== planArtifact.planHash
    || validationRef.hash !== validationArtifact.receipt.receiptHash
    || policyRef.hash !== policyArtifact.artifactHash
    || planArtifact.runId !== input.run.id
    || validationArtifact.runId !== input.run.id
    || policyArtifact.runId !== input.run.id
    || planArtifact.portfolioId !== input.run.scope.portfolioId
    || validationArtifact.portfolioId !== input.run.scope.portfolioId
    || policyArtifact.portfolioId !== input.run.scope.portfolioId
    || planArtifact.companyId !== input.run.scope.companyId
    || validationArtifact.companyId !== input.run.scope.companyId
    || policyArtifact.companyId !== input.run.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Task/Job materialization lineage crosses orchestration scope or hashes"
    );
  }

  const expectedRefs = new Map(
    input.run.checkpoints.authorizationGrants.map((ref) => [ref.id, ref])
  );
  const persistedGrants = await Promise.all(
    input.run.checkpoints.authorizationGrants.map(async (ref) => ({
      ref,
      grant: await input.grants.get(ref.id)
    }))
  );
  const grantsByStep = new Map<string, AuthorizationGrant>();
  for (const { ref, grant } of persistedGrants) {
    if (!grant || grant.grantHash !== ref.hash) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "AuthorizationGrant checkpoint is missing or changed in authoritative storage"
      );
    }
    if (grantsByStep.has(grant.stepId)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `Multiple AuthorizationGrants resolve to Plan step: ${grant.stepId}`
      );
    }
    grantsByStep.set(grant.stepId, grant);
  }

  for (const step of planArtifact.proposal.steps) {
    const policyStep = policyStepFor(policyArtifact, step.id);
    assertCurrentPolicyVersion(policyStep.snapshot.policyVersion);
    const grant = grantsByStep.get(step.id);

    if (!grant) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `Missing authoritative AuthorizationGrant for Plan step: ${step.id}`
      );
    }
    const ref = expectedRefs.get(grant.id);
    if (!ref || ref.hash !== grant.grantHash) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "AuthorizationGrant checkpoint hash does not match authoritative storage"
      );
    }
    assertCurrentPolicyVersion(grant.policyVersion);
    assertAuthorizationGrant({
      grant,
      plan: planArtifact.proposal,
      stepId: step.id,
      receipt: validationArtifact.receipt,
      scope: input.run.scope,
      now: input.now.getTime()
    });
    if (
      grant.policySnapshotId !== policyStep.snapshot.id
      || grant.policySnapshotHash !== policyStep.snapshot.snapshotHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "AuthorizationGrant no longer matches the authoritative policy result"
      );
    }
  }

  if (
    grantsByStep.size !== planArtifact.proposal.steps.length
    || input.run.checkpoints.authorizationGrants.length !== grantsByStep.size
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "AuthorizationGrant set must match Plan steps exactly"
    );
  }

  deterministicPlanDagOrder(planArtifact.proposal);
  return { planArtifact, validationArtifact, policyArtifact, grantsByStep };
}

function taskArtifact(input: {
  run: OrchestrationRunRecord;
  planArtifact: PersistedPlanProposal;
  task: GeneratedTask;
}): OrchestrationTaskArtifact {
  const step = input.planArtifact.proposal.steps.find(
    (candidate) => candidate.id === input.task.planStepId
  );
  if (!step) {
    throw new ControlPlaneError("FORBIDDEN", "Generated Task is not a Plan step");
  }
  const dependencies = [...step.dependsOn]
    .sort()
    .map((stepId) => deterministicTaskId(input.run.id, stepId));
  const base = {
    id: `task-artifact:${input.task.id}`,
    taskId: input.task.id,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    objectiveId: objectiveId(input.planArtifact.proposal),
    orchestrationRunId: input.run.id,
    planId: input.planArtifact.proposal.id,
    planHash: input.planArtifact.planHash,
    authorizationGrantId: input.task.authorizationGrantId,
    authorizationGrantHash: input.task.authorizationGrantHash,
    authorizationConsumptionHash:
      input.task.authorizationConsumption.consumptionHash,
    capability: [...input.task.capabilityRequirements].sort(),
    inputs: input.task.operations.map((operation) => operation.input),
    dependencies,
    riskClass: step.risk.level,
    status: dependencies.length === 0 ? "ready" as const : "waiting" as const,
    createdAt: input.task.createdAt,
    generatedTask: input.task
  };
  return deepFreeze({ ...base, taskHash: sha256Hex(base) });
}

export function assertTaskArtifact(artifact: OrchestrationTaskArtifact) {
  const { taskHash, ...base } = artifact;
  const generated = artifact.generatedTask;
  const expectedCapabilities = [...generated.capabilityRequirements].sort();
  const expectedInputs = generated.operations.map((operation) => operation.input);
  if (
    sha256Hex(base) !== taskHash
    || artifact.taskId !== generated.id
    || artifact.portfolioId !== generated.scope.portfolioId
    || artifact.companyId !== generated.scope.companyId
    || artifact.planId !== generated.planId
    || artifact.authorizationGrantId !== generated.authorizationGrantId
    || artifact.authorizationGrantHash !== generated.authorizationGrantHash
    || artifact.authorizationConsumptionHash
      !== generated.authorizationConsumption.consumptionHash
    || generated.authorizationConsumption.grantId !== artifact.authorizationGrantId
    || generated.authorizationConsumption.consumerType !== "task"
    || generated.authorizationConsumption.consumerId !== artifact.taskId
    || generated.authorizationConsumption.scope.portfolioId !== artifact.portfolioId
    || generated.authorizationConsumption.scope.companyId !== artifact.companyId
    || sha256Hex(artifact.capability) !== sha256Hex(expectedCapabilities)
    || sha256Hex(artifact.inputs) !== sha256Hex(expectedInputs)
    || artifact.createdAt !== generated.createdAt
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Task materialization artifact integrity check failed"
    );
  }
  return artifact;
}

export function buildTaskDagArtifact(input: {
  run: OrchestrationRunRecord;
  planArtifact: PersistedPlanProposal;
  tasks: readonly OrchestrationTaskArtifact[];
}): TaskDagArtifact {
  const order = deterministicPlanDagOrder(input.planArtifact.proposal);
  for (const task of input.tasks) assertTaskArtifact(task);
  const byStep = new Map(
    input.tasks.map((task) => [task.generatedTask.planStepId, task])
  );
  if (
    input.tasks.length !== input.planArtifact.proposal.steps.length
    || byStep.size !== input.planArtifact.proposal.steps.length
    || input.tasks.some(
      (task) =>
        task.portfolioId !== input.run.scope.portfolioId
        || task.companyId !== input.run.scope.companyId
        || task.orchestrationRunId !== input.run.id
        || task.planHash !== input.planArtifact.planHash
    )
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Task set does not exactly match the authorized Plan scope"
    );
  }

  const dependents = new Map<string, string[]>();
  for (const task of input.tasks) dependents.set(task.taskId, []);
  for (const task of input.tasks) {
    for (const dependency of task.dependencies) {
      if (!dependents.has(dependency)) {
        throw new ControlPlaneError(
          "VALIDATION_FAILED",
          `Task DAG references missing dependency: ${dependency}`
        );
      }
      dependents.get(dependency)!.push(task.taskId);
    }
  }

  const nodes = order.map((stepId) => {
    const task = byStep.get(stepId);
    if (!task) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `Task missing for Plan step: ${stepId}`
      );
    }
    const step = input.planArtifact.proposal.steps.find(
      (candidate) => candidate.id === stepId
    )!;
    const expectedDependencies = [...step.dependsOn]
      .sort()
      .map((dependency) => deterministicTaskId(input.run.id, dependency));
    if (
      task.taskId !== deterministicTaskId(input.run.id, stepId)
      || task.generatedTask.planStepId !== stepId
      || task.planId !== input.planArtifact.proposal.id
      || task.generatedTask.planId !== input.planArtifact.proposal.id
      || task.riskClass !== step.risk.level
      || sha256Hex(task.dependencies) !== sha256Hex(expectedDependencies)
      || sha256Hex(task.generatedTask.operations) !== sha256Hex(step.capabilityRequests)
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `Task does not exactly materialize authorized Plan step: ${stepId}`
      );
    }
    return Object.freeze({
      taskId: task.taskId,
      planStepId: stepId,
      dependencies: Object.freeze([...task.dependencies]),
      dependents: Object.freeze([...(dependents.get(task.taskId) ?? [])].sort()),
      initialStatus: task.dependencies.length === 0
        ? "ready" as const
        : "waiting" as const
    });
  });

  const base = {
    id: `task-dag:${input.run.id}:v${input.run.version}`,
    correlationId: input.run.correlationId,
    orchestrationRunId: input.run.id,
    sourceRunVersion: input.run.version,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    planId: input.planArtifact.proposal.id,
    planHash: input.planArtifact.planHash,
    dagVersion: ORCHESTRATION_TASK_DAG_VERSION,
    nodes: Object.freeze(nodes),
    topologicalOrder: Object.freeze(
      order.map((stepId) => byStep.get(stepId)!.taskId)
    ),
    taskGenerationIdempotencyKey: taskGenerationIdempotencyKey(input.run),
    createdAt: materializationCreatedAt(input.run)
  };
  return deepFreeze({ ...base, dagHash: sha256Hex(base) });
}

export function assertTaskDagArtifact(dag: TaskDagArtifact) {
  const { dagHash, ...base } = dag;
  if (
    sha256Hex(base) !== dagHash
    || dag.dagVersion !== ORCHESTRATION_TASK_DAG_VERSION
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Task DAG integrity check failed");
  }
  const ids = new Set(dag.nodes.map((node) => node.taskId));
  if (
    ids.size !== dag.nodes.length
    || dag.topologicalOrder.length !== dag.nodes.length
    || new Set(dag.topologicalOrder).size !== dag.topologicalOrder.length
    || dag.topologicalOrder.some((id) => !ids.has(id))
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Task DAG ordering is invalid");
  }
  const position = new Map(dag.topologicalOrder.map((id, index) => [id, index]));
  const inverseEdges = new Map<string, string[]>(
    dag.nodes.map((node) => [node.taskId, []])
  );
  for (const node of dag.nodes) {
    if (
      new Set(node.dependencies).size !== node.dependencies.length
      || new Set(node.dependents).size !== node.dependents.length
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Task DAG contains duplicate dependency edges"
      );
    }
    for (const dependency of node.dependencies) {
      if (!ids.has(dependency) || position.get(dependency)! >= position.get(node.taskId)!) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Task DAG dependency order is invalid"
        );
      }
      inverseEdges.get(dependency)!.push(node.taskId);
    }
    for (const dependent of node.dependents) {
      if (!ids.has(dependent) || position.get(dependent)! <= position.get(node.taskId)!) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Task DAG dependent order is invalid"
        );
      }
    }
  }
  for (const node of dag.nodes) {
    const expected = [...(inverseEdges.get(node.taskId) ?? [])].sort();
    const declared = [...node.dependents].sort();
    if (sha256Hex(expected) !== sha256Hex(declared)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Task DAG dependent edges do not mirror dependency edges"
      );
    }
  }
  return dag;
}

export function propagateTaskDagStatus(
  dag: TaskDagArtifact,
  states: Readonly<Record<string, MaterializedTaskStatus>>
) {
  assertTaskDagArtifact(dag);
  const result: Record<string, MaterializedTaskStatus> = {};
  for (const taskId of dag.topologicalOrder) {
    const node = dag.nodes.find((candidate) => candidate.taskId === taskId)!;
    const explicit = states[taskId];
    if (
      explicit === "failed"
      || explicit === "blocked"
      || explicit === "cancelled"
      || explicit === "succeeded"
    ) {
      result[taskId] = explicit;
      continue;
    }
    const dependencyStates = node.dependencies.map(
      (dependency) => result[dependency] ?? states[dependency] ?? "waiting"
    );
    if (dependencyStates.some((state) => state === "failed" || state === "blocked")) {
      result[taskId] = "blocked";
    } else if (dependencyStates.some((state) => state === "cancelled")) {
      result[taskId] = "cancelled";
    } else if (
      node.dependencies.length === 0
      || dependencyStates.every((state) => state === "succeeded")
    ) {
      result[taskId] = explicit === "running" ? "running" : "ready";
    } else {
      result[taskId] = "waiting";
    }
  }
  return Object.freeze(result);
}

function createJobArtifact(input: {
  run: OrchestrationRunRecord;
  lineage: MaterializationLineage;
  dag: TaskDagArtifact;
  task: OrchestrationTaskArtifact;
  operationIndex: number;
  dependencyJobIds: readonly string[];
}): OrchestrationJobArtifact {
  const operation = input.task.generatedTask.operations[input.operationIndex];
  if (!operation) {
    throw new ControlPlaneError("FORBIDDEN", "Task operation was not found");
  }
  const policyStep = policyStepFor(
    input.lineage.policyArtifact,
    input.task.generatedTask.planStepId
  );
  const jobId = deterministicJobId(input.task.taskId, input.operationIndex);
  const authorityLineage: JobAuthorityLineage = Object.freeze({
    orchestrationRunId: input.run.id,
    planId: input.lineage.planArtifact.proposal.id,
    planHash: input.lineage.planArtifact.planHash,
    validationReceiptId: input.lineage.validationArtifact.receipt.id,
    validationReceiptHash: input.lineage.validationArtifact.receipt.receiptHash,
    policyArtifactId: input.lineage.policyArtifact.id,
    policyArtifactHash: input.lineage.policyArtifact.artifactHash,
    authorizationGrantId: input.task.authorizationGrantId,
    authorizationGrantHash: input.task.authorizationGrantHash,
    authorizationConsumptionHash: input.task.authorizationConsumptionHash,
    taskId: input.task.taskId,
    taskHash: input.task.taskHash,
    taskDagId: input.dag.id,
    taskDagHash: input.dag.dagHash
  });
  const inputHash = sha256Hex({
    capabilityId: operation.capability,
    input: operation.input
  });
  const createdAt = materializationCreatedAt(input.run);
  const base = {
    id: `job-artifact:${jobId}`,
    jobId,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    taskId: input.task.taskId,
    capabilityId: operation.capability,
    integrationId: policyStep.snapshot.integrationId ?? null,
    authorityLineage,
    input: operation.input,
    inputHash,
    idempotencyKey: `${jobEnqueueIdempotencyKey(input.run)}:${jobId}`,
    sideEffectIdempotencyKey: `job:${jobId}:side-effect:${operation.capability}`,
    sideEffectIdempotencyKeyPrefix: `job:${jobId}:side-effect`,
    dependencyJobIds: Object.freeze([...input.dependencyJobIds]),
    retryPolicy: Object.freeze({
      maxAttempts: input.task.generatedTask.resourceRequirements.execution.retryable ? 5 : 1,
      baseDelayMs: 1_000,
      maxDelayMs: 120_000
    }),
    executionLimits: Object.freeze({
      environment: input.run.scope.environment,
      deadline: input.task.generatedTask.resourceRequirements.execution.deadline,
      expectedDurationSeconds:
        input.task.generatedTask.resourceRequirements.execution.expectedDurationSeconds,
      maxJobCostCents:
        input.task.generatedTask.resourceRequirements.economics.maxJobCostCents
    }),
    verificationRequirements: Object.freeze(
      input.task.generatedTask.verificationRequirements.map((item) =>
        Object.freeze({ ...item })
      )
    ),
    status: "pending-binding" as const,
    createdAt
  };
  return deepFreeze({ ...base, jobHash: sha256Hex(base) });
}

export function assertJobArtifact(job: OrchestrationJobArtifact) {
  const { jobHash, ...base } = job;
  if (
    sha256Hex(base) !== jobHash
    || job.authorityLineage.taskId !== job.taskId
    || job.authorityLineage.authorizationConsumptionHash.length === 0
    || job.inputHash !== sha256Hex({
      capabilityId: job.capabilityId,
      input: job.input
    })
    || !job.idempotencyKey.endsWith(`:${job.jobId}`)
    || job.sideEffectIdempotencyKey !== `job:${job.jobId}:side-effect:${job.capabilityId}`
    || job.sideEffectIdempotencyKeyPrefix !== `job:${job.jobId}:side-effect`
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Job materialization artifact integrity check failed"
    );
  }
  return job;
}

export function buildJobArtifacts(input: {
  run: OrchestrationRunRecord;
  lineage: MaterializationLineage;
  dag: TaskDagArtifact;
  tasks: readonly OrchestrationTaskArtifact[];
}) {
  assertTaskDagArtifact(input.dag);
  if (
    input.dag.orchestrationRunId !== input.run.id
    || input.dag.portfolioId !== input.run.scope.portfolioId
    || input.dag.companyId !== input.run.scope.companyId
    || input.dag.planId !== input.lineage.planArtifact.proposal.id
    || input.dag.planHash !== input.lineage.planArtifact.planHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Task DAG does not match current authoritative orchestration lineage"
    );
  }
  const tasksById = new Map(input.tasks.map((task) => [task.taskId, task]));
  if (
    input.tasks.length !== input.dag.nodes.length
    || tasksById.size !== input.dag.nodes.length
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Job materialization requires exactly the Tasks in the authoritative DAG"
    );
  }
  const jobIdsByTask = new Map<string, string[]>();

  for (const taskId of input.dag.topologicalOrder) {
    const task = tasksById.get(taskId);
    if (!task) {
      throw new ControlPlaneError("FORBIDDEN", `Missing Task artifact: ${taskId}`);
    }
    assertTaskArtifact(task);
    if (
      task.orchestrationRunId !== input.run.id
      || task.portfolioId !== input.run.scope.portfolioId
      || task.companyId !== input.run.scope.companyId
      || task.planId !== input.lineage.planArtifact.proposal.id
      || task.planHash !== input.lineage.planArtifact.planHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `Task lineage changed before Job materialization: ${taskId}`
      );
    }
    jobIdsByTask.set(
      taskId,
      task.generatedTask.operations.map((_, index) =>
        deterministicJobId(taskId, index)
      )
    );
  }

  const jobs: OrchestrationJobArtifact[] = [];
  for (const taskId of input.dag.topologicalOrder) {
    const task = tasksById.get(taskId)!;
    const node = input.dag.nodes.find((candidate) => candidate.taskId === taskId)!;
    const dependencyJobIds = node.dependencies.flatMap(
      (dependencyTaskId) => jobIdsByTask.get(dependencyTaskId) ?? []
    );
    for (
      let operationIndex = 0;
      operationIndex < task.generatedTask.operations.length;
      operationIndex += 1
    ) {
      jobs.push(createJobArtifact({
        run: input.run,
        lineage: input.lineage,
        dag: input.dag,
        task,
        operationIndex,
        dependencyJobIds
      }));
    }
  }
  return Object.freeze(jobs);
}

async function assertGrantConsumptionAvailable(input: {
  grant: AuthorizationGrant;
  expectedTaskId: string;
  grants: AuthorizationGrantStore;
}) {
  const consumptions = await input.grants.listConsumptions(input.grant.id);
  if (consumptions.length === 0) return;
  if (consumptions.length !== 1) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "AuthorizationGrant has multiple persisted consumptions"
    );
  }
  const existing = consumptions[0]!;
  assertAuthorizationConsumption(existing, input.grant);
  if (
    existing.consumerType !== "task"
    || existing.consumerId !== input.expectedTaskId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "AuthorizationGrant was already consumed by different work"
    );
  }
}

export async function advanceAuthorizedToTasksCreated(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  policies: OrchestrationPolicyEvaluationStore;
  grants: AuthorizationGrantStore;
  materialization: OrchestrationTaskJobMaterializationStore;
  objectiveStatus?: "active" | "paused" | "completed";
  objectiveStatusResolver?: ObjectiveExecutionStatusResolver;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "authorized") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Task generation requires authorized orchestration state"
    );
  }
  const now = input.now ?? (() => new Date());
  const lineage = await loadMaterializationLineage({
    ...input,
    now: now()
  });
  const plan = lineage.planArtifact.proposal;
  const stepOrder = deterministicPlanDagOrder(plan);
  let objectiveStatus = input.objectiveStatus;
  if (plan.source.type === "objective" && objectiveStatus === undefined) {
    if (!input.objectiveStatusResolver) {
      return {
        kind: "retry",
        code: "UNAVAILABLE",
        reason: "Authoritative objective status is required before Task materialization"
      };
    }
    objectiveStatus = await input.objectiveStatusResolver.getStatus({
      portfolioId: input.run.scope.portfolioId,
      companyId: input.run.scope.companyId,
      objectiveId: plan.source.objectiveId
    });
  }

  for (const stepId of stepOrder) {
    const grant = lineage.grantsByStep.get(stepId)!;
    await assertGrantConsumptionAvailable({
      grant,
      expectedTaskId: deterministicTaskId(input.run.id, stepId),
      grants: input.grants
    });
  }

  const artifacts = new Map<string, OrchestrationTaskArtifact>();
  const adapter: TaskGenerationDedupeStore = {
    claim: async (task, consumption) => {
      const artifact = taskArtifact({
        run: input.run,
        planArtifact: lineage.planArtifact,
        task
      });
      const claimed = await input.materialization.claimTask(artifact, consumption);
      assertTaskArtifact(claimed.artifact);
      artifacts.set(task.planStepId, claimed.artifact);
      return {
        created: claimed.created,
        task: claimed.artifact.generatedTask,
        consumption: claimed.consumption
      };
    }
  };

  let idIndex = 0;
  const generator = new TaskGenerator(
    adapter,
    () => deterministicTaskId(input.run.id, plan.steps[idIndex++]!.id),
    () => new Date(materializationCreatedAt(input.run))
  );
  const result = await generator.generate({
    plan,
    validationReceipt: lineage.validationArtifact.receipt,
    authorizationGrants: Object.fromEntries(
      [...lineage.grantsByStep.entries()]
    ),
    objectiveStatus: plan.source.type === "objective"
      ? objectiveStatus
      : "active"
  });

  if (result.status === "blocked") {
    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "blocked",
        now: now().toISOString(),
        blockedReason: result.reasons.join("; ") || "Task generation was blocked"
      })
    };
  }

  const tasks = stepOrder.map((stepId) => {
    const artifact = artifacts.get(stepId);
    if (!artifact) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        `Task materialization did not return Plan step: ${stepId}`
      );
    }
    return artifact;
  });
  const dagCandidate = buildTaskDagArtifact({
    run: input.run,
    planArtifact: lineage.planArtifact,
    tasks
  });
  const dagClaim = await input.materialization.claimDag(dagCandidate);
  assertTaskDagArtifact(dagClaim.dag);
  if (dagClaim.dag.dagHash !== dagCandidate.dagHash) {
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Task DAG replay differs from persisted authoritative DAG"
    );
  }

  const taskRefs: TaskRef[] = tasks.map((task) => Object.freeze({
    id: task.taskId,
    hash: task.taskHash,
    authorizationConsumptionHash: task.authorizationConsumptionHash
  }));

  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "tasks-created",
      now: now().toISOString(),
      checkpointPatch: {
        taskDag: {
          id: dagClaim.dag.id,
          hash: dagClaim.dag.dagHash
        },
        tasks: taskRefs
      }
    })
  };
}

export async function advanceTasksCreatedToJobsEnqueued(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  policies: OrchestrationPolicyEvaluationStore;
  grants: AuthorizationGrantStore;
  materialization: OrchestrationTaskJobMaterializationStore;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "tasks-created") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Job materialization requires tasks-created orchestration state"
    );
  }
  const now = input.now ?? (() => new Date());
  const lineage = await loadMaterializationLineage({
    ...input,
    now: now()
  });
  const dagRef = input.run.checkpoints.taskDag;
  if (!dagRef) {
    throw new ControlPlaneError("FORBIDDEN", "tasks-created run is missing Task DAG checkpoint");
  }
  const dag = await input.materialization.getDag(dagRef.id);
  if (!dag || dag.dagHash !== dagRef.hash) {
    throw new ControlPlaneError("FORBIDDEN", "Authoritative Task DAG is missing or changed");
  }
  assertTaskDagArtifact(dag);

  const tasks: OrchestrationTaskArtifact[] = [];
  for (const ref of input.run.checkpoints.tasks) {
    const task = await input.materialization.getTask(ref.id);
    if (
      !task
      || task.taskHash !== ref.hash
      || task.authorizationConsumptionHash !== ref.authorizationConsumptionHash
      || task.portfolioId !== input.run.scope.portfolioId
      || task.companyId !== input.run.scope.companyId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Task checkpoint does not match authoritative materialization"
      );
    }
    assertTaskArtifact(task);

    const grant = await input.grants.get(task.authorizationGrantId);
    if (!grant || grant.grantHash !== task.authorizationGrantHash) {
      throw new ControlPlaneError("FORBIDDEN", "Task AuthorizationGrant is missing or changed");
    }
    assertCurrentPolicyVersion(grant.policyVersion);
    assertAuthorizationGrant({
      grant,
      plan: lineage.planArtifact.proposal,
      stepId: task.generatedTask.planStepId,
      receipt: lineage.validationArtifact.receipt,
      scope: input.run.scope,
      now: now().getTime()
    });
    const consumptions = await input.grants.listConsumptions(grant.id);
    const consumption = consumptions.find(
      (candidate) => candidate.consumptionHash === task.authorizationConsumptionHash
    );
    if (
      !consumption
      || consumption.consumerType !== "task"
      || consumption.consumerId !== task.taskId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Task authorization consumption is not authoritative"
      );
    }
    assertAuthorizationConsumption(consumption, grant);
    tasks.push(task);
  }

  const jobs = buildJobArtifacts({
    run: input.run,
    lineage,
    dag,
    tasks
  });
  const persistedJobs: OrchestrationJobArtifact[] = [];
  for (const job of jobs) {
    const task = tasks.find((candidate) => candidate.taskId === job.taskId)!;
    const claimed = await input.materialization.claimJob(job, task);
    assertJobArtifact(claimed.job);
    if (claimed.job.jobHash !== job.jobHash) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Job replay differs from persisted authoritative Job"
      );
    }
    persistedJobs.push(claimed.job);
  }

  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "jobs-enqueued",
      now: now().toISOString(),
      checkpointPatch: {
        jobIds: persistedJobs.map((job) => job.jobId)
      }
    })
  };
}


export interface ObjectiveExecutionStatusResolver {
  getStatus(input: {
    portfolioId: string;
    companyId: string;
    objectiveId: string;
  }): Promise<"active" | "paused" | "completed">;
}

/**
 * Tranche-A stage handler for the existing DurableOrchestrationWorker.
 *
 * It deliberately stops at authoritative Job materialization. It never calls
 * a provider, never creates an execution spec, and never enqueues the durable
 * provider Job Engine. Later binding/execution remains owned by the existing
 * governed Job runtime.
 */
export class TaskJobMaterializationStageHandler
  implements OrchestrationStageHandler {
  constructor(
    private readonly deps: {
      plans: OrchestrationPlanProposalStore;
      validations: OrchestrationValidationArtifactStore;
      policies: OrchestrationPolicyEvaluationStore;
      grants: AuthorizationGrantStore;
      materialization: OrchestrationTaskJobMaterializationStore;
      objectiveStatus?: ObjectiveExecutionStatusResolver;
      now?: () => Date;
    }
  ) {}

  async execute(context: Parameters<OrchestrationStageHandler["execute"]>[0]) {
    await context.heartbeat();

    if (context.run.state === "authorized") {
      return advanceAuthorizedToTasksCreated({
        run: context.run,
        plans: this.deps.plans,
        validations: this.deps.validations,
        policies: this.deps.policies,
        grants: this.deps.grants,
        materialization: this.deps.materialization,
        objectiveStatusResolver: this.deps.objectiveStatus,
        now: this.deps.now
      });
    }

    if (context.run.state === "tasks-created") {
      return advanceTasksCreatedToJobsEnqueued({
        run: context.run,
        plans: this.deps.plans,
        validations: this.deps.validations,
        policies: this.deps.policies,
        grants: this.deps.grants,
        materialization: this.deps.materialization,
        now: this.deps.now
      });
    }

    throw new ControlPlaneError(
      "CONFLICT",
      `Task/Job materialization handler cannot execute orchestration state: ${context.run.state}`
    );
  }
}
