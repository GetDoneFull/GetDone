import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import type {
  OrchestrationAuthorizationGrantStore
} from "@/lib/orchestration/authorization-flow";
import {
  transitionOrchestrationRun,
  type OrchestrationRunRecord,
  type VerifiedOutcomeRef
} from "@/lib/orchestration/contracts";
import type { OrchestrationStageOutcome } from "@/lib/orchestration/worker-contracts";
import type { ObjectiveReadStore } from "@/lib/orchestration/objective-flow";
import {
  assertPersistedPlanProposal,
  type OrchestrationPlanProposalStore,
  type PersistedPlanProposal
} from "@/lib/orchestration/planning-flow";
import {
  assertDurableValidationArtifact,
  type DurableValidationArtifact,
  type OrchestrationValidationArtifactStore
} from "@/lib/orchestration/validation-policy-flow";
import {
  DagCompiler,
  type ExecutableDag
} from "@/lib/planning/dag-compiler";
import {
  TaskGenerator,
  type GeneratedTask,
  type TaskGenerationDedupeStore
} from "@/lib/planning/task-generator";
import type { VerificationEvidence } from "@/lib/verification/verification";

export const ORCHESTRATION_POST_AUTHORIZATION_FLOW_VERSION = "1.0.0";

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export interface DurableTaskDagArtifact {
  id: string;
  runId: string;
  authorizedRunVersion: number;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  planArtifactId: string;
  planHash: string;
  validationReceiptId: string;
  validationReceiptHash: string;
  tasks: readonly GeneratedTask[];
  dag: ExecutableDag;
  createdAt: string;
  artifactHash: string;
}

export interface OrchestrationTaskDagStore {
  create(
    artifact: DurableTaskDagArtifact,
    idempotencyKey: string
  ): Promise<{ status: "created" | "idempotent-replay"; artifact: DurableTaskDagArtifact }>;
  get(id: string): Promise<DurableTaskDagArtifact | null>;
  getByRunId(runId: string): Promise<DurableTaskDagArtifact | null>;
}

export type OrchestrationJobNodeState =
  | "created"
  | "enqueued"
  | "provider-completed"
  | "verified"
  | "failed"
  | "cancelled";

export interface OrchestrationJobNode {
  id: string;
  runId: string;
  nodeId: string;
  taskId: string;
  capability: string;
  capabilityInput: unknown;
  dependsOnJobIds: readonly string[];
  authorizationGrantId: string;
  authorizationGrantHash: string;
  authorizationConsumptionHash: string;
  state: OrchestrationJobNodeState;
  verificationRequestId?: string;
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  createdAt: string;
  updatedAt: string;
  nodeHash: string;
}

export interface DurableJobGraphArtifact {
  id: string;
  runId: string;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  taskDagId: string;
  taskDagHash: string;
  jobs: readonly OrchestrationJobNode[];
  createdAt: string;
  artifactHash: string;
}

export interface OrchestrationJobGraphStore {
  create(
    artifact: DurableJobGraphArtifact,
    idempotencyKey: string
  ): Promise<{ status: "created" | "idempotent-replay"; artifact: DurableJobGraphArtifact }>;
  getByRunId(runId: string): Promise<DurableJobGraphArtifact | null>;
}

export interface GovernedJobRuntimeDescriptor {
  providerCalls: "job-worker-only";
  authoritativeState: "postgresql";
  requiresAuthorizationConsumption: true;
  verifiesBeforeSuccess: true;
}

export interface GovernedJobRuntimePort {
  readonly descriptor: GovernedJobRuntimeDescriptor;
  materializeAndEnqueue(input: {
    run: OrchestrationRunRecord;
    taskDag: DurableTaskDagArtifact;
    idempotencyKey: string;
  }): Promise<DurableJobGraphArtifact>;
  reconcile(input: {
    run: OrchestrationRunRecord;
    taskDag: DurableTaskDagArtifact;
    jobGraph: DurableJobGraphArtifact;
    idempotencyKey: string;
  }): Promise<
    | { kind: "pending"; reason: string; delayMs?: number }
    | { kind: "failed"; code: string; reason: string }
    | {
        kind: "verified";
        jobGraph: DurableJobGraphArtifact;
        verificationRequestIds: readonly string[];
        evidence: readonly VerificationEvidence[];
      }
  >;
}

export interface ObjectiveEvaluationArtifact {
  id: string;
  runId: string;
  planId: string;
  planHash: string;
  status: "met" | "not-met" | "uncertain";
  observations: readonly {
    metric: string;
    target: number | string;
    observed?: number | string | boolean;
    met: boolean | null;
    evidenceIds: readonly string[];
  }[];
  evaluatedAt: string;
  evaluationHash: string;
}

export interface VerifiedOrchestrationOutcome {
  id: string;
  runId: string;
  objectiveEvaluationId: string;
  objectiveEvaluationHash: string;
  verificationReceiptId: string;
  verificationReceiptHash: string;
  state: "verified";
  recordedAt: string;
  outcomeHash: string;
}

export interface ObjectiveOutcomePort {
  readonly descriptor: {
    authoritativeState: "postgresql";
    requiresVerifiedJobEvidence: true;
    appendsAudit: true;
  };
  evaluateAndRecord(input: {
    run: OrchestrationRunRecord;
    plan: PersistedPlanProposal;
    taskDag: DurableTaskDagArtifact;
    jobGraph: DurableJobGraphArtifact;
    evidence: readonly VerificationEvidence[];
    idempotencyKey: string;
  }): Promise<
    | { kind: "pending"; reason: string; delayMs?: number }
    | { kind: "failed"; code: string; reason: string }
    | {
        kind: "verified";
        evaluation: ObjectiveEvaluationArtifact;
        outcome: VerifiedOrchestrationOutcome;
      }
  >;
}

function taskDagId(runId: string) {
  return `task-dag:${runId}`;
}

function jobGraphId(runId: string) {
  return `job-graph:${runId}`;
}

export function taskDagIdempotencyKey(run: OrchestrationRunRecord) {
  return `orchestration:${run.id}:v${run.version}:task-dag`;
}

export function jobGraphIdempotencyKey(run: OrchestrationRunRecord) {
  return `orchestration:${run.id}:v${run.version}:job-graph`;
}

export function reconciliationIdempotencyKey(run: OrchestrationRunRecord) {
  return `orchestration:${run.id}:execution-reconcile`;
}

export function outcomeIdempotencyKey(run: OrchestrationRunRecord) {
  return `orchestration:${run.id}:objective-outcome`;
}

function assertRuntimeBoundary(runtime: GovernedJobRuntimePort) {
  if (
    runtime.descriptor.providerCalls !== "job-worker-only"
    || runtime.descriptor.authoritativeState !== "postgresql"
    || runtime.descriptor.requiresAuthorizationConsumption !== true
    || runtime.descriptor.verifiesBeforeSuccess !== true
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Orchestration may only hand Jobs to the governed PostgreSQL-backed Job worker boundary"
    );
  }
}

function assertOutcomeBoundary(outcomes: ObjectiveOutcomePort) {
  if (
    outcomes.descriptor.authoritativeState !== "postgresql"
    || outcomes.descriptor.requiresVerifiedJobEvidence !== true
    || outcomes.descriptor.appendsAudit !== true
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Objective completion requires PostgreSQL-backed verified Outcome + Audit authority"
    );
  }
}

async function loadPlanAndValidation(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
}) {
  const planRef = input.run.checkpoints.plan;
  const validationRef = input.run.checkpoints.validationReceipt;
  if (!planRef || !validationRef) {
    throw new ControlPlaneError("CONFLICT", "Authorized orchestration is missing Plan/Validation lineage");
  }
  const [plan, validation] = await Promise.all([
    input.plans.get(planRef.id),
    input.validations.get(validationRef.id)
  ]);
  if (!plan || !validation) {
    throw new ControlPlaneError("FORBIDDEN", "Plan/Validation lineage referenced by orchestration is missing");
  }
  assertPersistedPlanProposal(plan);
  assertDurableValidationArtifact(validation, plan);
  if (
    plan.planHash !== planRef.hash
    || validation.receipt.receiptHash !== validationRef.hash
    || plan.portfolioId !== input.run.scope.portfolioId
    || plan.companyId !== input.run.scope.companyId
    || validation.portfolioId !== input.run.scope.portfolioId
    || validation.companyId !== input.run.scope.companyId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Plan/Validation lineage does not match authoritative orchestration scope");
  }
  return { plan, validation };
}

async function loadGrantMap(
  run: OrchestrationRunRecord,
  store: OrchestrationAuthorizationGrantStore,
  plan: PersistedPlanProposal
) {
  const grants: Record<string, AuthorizationGrant> = {};
  for (const ref of run.checkpoints.authorizationGrants) {
    const grant = await store.get(ref.id);
    if (
      !grant
      || grant.grantHash !== ref.hash
      || grant.planHash !== plan.planHash
      || grant.scope.portfolioId !== run.scope.portfolioId
      || grant.scope.companyId !== run.scope.companyId
    ) {
      throw new ControlPlaneError("FORBIDDEN", "AuthorizationGrant checkpoint differs from authoritative storage");
    }
    grants[grant.stepId] = grant;
  }
  if (Object.keys(grants).length !== plan.proposal.steps.length) {
    throw new ControlPlaneError("FORBIDDEN", "Every Plan step must have exactly one authoritative AuthorizationGrant");
  }
  return grants;
}

export function createDurableTaskDagArtifact(input: {
  run: OrchestrationRunRecord;
  plan: PersistedPlanProposal;
  validation: DurableValidationArtifact;
  tasks: readonly GeneratedTask[];
  dag: ExecutableDag;
  createdAt: string;
}): DurableTaskDagArtifact {
  if (input.run.state !== "authorized") {
    throw new ControlPlaneError("CONFLICT", "Task DAG materialization requires authorized orchestration state");
  }
  const base = {
    id: taskDagId(input.run.id),
    runId: input.run.id,
    authorizedRunVersion: input.run.version,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    planArtifactId: input.plan.id,
    planHash: input.plan.planHash,
    validationReceiptId: input.validation.receipt.id,
    validationReceiptHash: input.validation.receipt.receiptHash,
    tasks: input.tasks,
    dag: input.dag,
    createdAt: new Date(input.createdAt).toISOString()
  };
  return deepFreeze({ ...base, artifactHash: sha256Hex(base) });
}

export function assertDurableTaskDagArtifact(artifact: DurableTaskDagArtifact) {
  const { artifactHash, ...base } = artifact;
  if (
    sha256Hex(base) !== artifactHash
    || artifact.dag.taskIds.length !== artifact.tasks.length
    || artifact.tasks.some((task) => !artifact.dag.taskIds.includes(task.id))
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Durable Task DAG integrity check failed");
  }
  return artifact;
}

export async function advanceAuthorizedToTasksCreated(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  grants: OrchestrationAuthorizationGrantStore;
  taskDedupe: TaskGenerationDedupeStore;
  taskDags: OrchestrationTaskDagStore;
  objectives?: ObjectiveReadStore;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "authorized") {
    throw new ControlPlaneError("CONFLICT", "Task DAG stage requires authorized orchestration state");
  }
  const now = input.now ?? (() => new Date());
  const existing = await input.taskDags.getByRunId(input.run.id);
  if (existing) {
    assertDurableTaskDagArtifact(existing);
    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "tasks-created",
        now: now().toISOString(),
        checkpointPatch: {
          tasks: existing.tasks.map((task) => ({
            id: task.id,
            hash: sha256Hex(task),
            authorizationConsumptionHash: task.authorizationConsumption.consumptionHash
          }))
        }
      })
    };
  }

  const { plan, validation } = await loadPlanAndValidation(input);
  const grants = await loadGrantMap(input.run, input.grants, plan);
  let taskIndex = 0;
  const taskGenerator = new TaskGenerator(
    input.taskDedupe,
    () => {
      const step = plan.proposal.steps[taskIndex++];
      if (!step) throw new ControlPlaneError("CONFLICT", "Task generator requested more IDs than Plan steps");
      return `task:${input.run.id}:${step.id}`;
    },
    now
  );
  let objectiveStatus: "active" | "paused" | "completed" | undefined;
  if (plan.proposal.source.type === "objective") {
    if (!input.objectives) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Objective-backed Task generation requires the authoritative Objective store"
      );
    }
    const objective = await input.objectives.get(plan.proposal.source.objectiveId);
    if (!objective) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Objective-backed Task generation references a missing authoritative Objective"
      );
    }
    if ("companyId" in objective) {
      if (
        objective.portfolioId !== input.run.scope.portfolioId
        || objective.companyId !== input.run.scope.companyId
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Objective-backed Task generation crossed authoritative tenant scope"
        );
      }
      objectiveStatus =
        objective.status === "completed"
          ? "completed"
          : ["queued", "planning", "executing", "new_work_required"].includes(objective.status)
            ? "active"
            : "paused";
    } else {
      if (
        objective.scopeId !== input.run.scope.companyId
        && objective.scopeId !== input.run.scope.portfolioId
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Objective-backed Task generation crossed authoritative tenant scope"
        );
      }
      objectiveStatus = objective.status;
    }
  }

  const generated = await taskGenerator.generate({
    plan: plan.proposal,
    validationReceipt: validation.receipt,
    authorizationGrants: grants,
    objectiveStatus
  });
  if (generated.status === "blocked") {
    return { kind: "failed", code: "TASK_GENERATION_BLOCKED", reason: generated.reasons.join("; ") };
  }
  const tasks = [...generated.tasks, ...generated.duplicateTasks]
    .sort((a, b) => a.planStepId.localeCompare(b.planStepId));
  if (tasks.length !== plan.proposal.steps.length) {
    throw new ControlPlaneError("FORBIDDEN", "Task generation did not materialize the complete authorized Plan");
  }
  const dag = new DagCompiler(
    () => `dag:${input.run.id}`,
    now
  ).compile(tasks);
  const artifact = createDurableTaskDagArtifact({
    run: input.run,
    plan,
    validation,
    tasks,
    dag,
    createdAt: now().toISOString()
  });
  const persisted = await input.taskDags.create(
    artifact,
    taskDagIdempotencyKey(input.run)
  );
  assertDurableTaskDagArtifact(persisted.artifact);
  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "tasks-created",
      now: now().toISOString(),
      checkpointPatch: {
        tasks: persisted.artifact.tasks.map((task) => ({
          id: task.id,
          hash: sha256Hex(task),
          authorizationConsumptionHash: task.authorizationConsumption.consumptionHash
        }))
      }
    })
  };
}

export async function advanceTasksCreatedToJobsEnqueued(input: {
  run: OrchestrationRunRecord;
  taskDags: OrchestrationTaskDagStore;
  runtime: GovernedJobRuntimePort;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "tasks-created") {
    throw new ControlPlaneError("CONFLICT", "Job materialization requires tasks-created orchestration state");
  }
  assertRuntimeBoundary(input.runtime);
  const now = input.now ?? (() => new Date());
  const taskDag = await input.taskDags.getByRunId(input.run.id);
  if (!taskDag) throw new ControlPlaneError("FORBIDDEN", "Authoritative Task DAG was not found");
  assertDurableTaskDagArtifact(taskDag);
  const graph = await input.runtime.materializeAndEnqueue({
    run: input.run,
    taskDag,
    idempotencyKey: jobGraphIdempotencyKey(input.run)
  });
  if (
    graph.runId !== input.run.id
    || graph.taskDagId !== taskDag.id
    || graph.taskDagHash !== taskDag.artifactHash
    || graph.jobs.length === 0
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Governed Job runtime returned invalid Task DAG lineage");
  }
  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "jobs-enqueued",
      now: now().toISOString(),
      checkpointPatch: { jobIds: graph.jobs.map((job) => job.id) }
    })
  };
}

export function advanceJobsEnqueuedToExecuting(input: {
  run: OrchestrationRunRecord;
  now?: () => Date;
}): OrchestrationStageOutcome {
  if (input.run.state !== "jobs-enqueued") {
    throw new ControlPlaneError("CONFLICT", "Execution start requires jobs-enqueued orchestration state");
  }
  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "executing",
      now: (input.now ?? (() => new Date()))().toISOString()
    })
  };
}

export async function advanceExecutingToVerifying(input: {
  run: OrchestrationRunRecord;
  taskDags: OrchestrationTaskDagStore;
  jobGraphs: OrchestrationJobGraphStore;
  runtime: GovernedJobRuntimePort;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "executing") {
    throw new ControlPlaneError("CONFLICT", "Execution reconciliation requires executing orchestration state");
  }
  assertRuntimeBoundary(input.runtime);
  const [taskDag, graph] = await Promise.all([
    input.taskDags.getByRunId(input.run.id),
    input.jobGraphs.getByRunId(input.run.id)
  ]);
  if (!taskDag || !graph) {
    throw new ControlPlaneError("FORBIDDEN", "Executing orchestration lost its authoritative Task/Job graph");
  }
  assertDurableTaskDagArtifact(taskDag);
  const result = await input.runtime.reconcile({
    run: input.run,
    taskDag,
    jobGraph: graph,
    idempotencyKey: reconciliationIdempotencyKey(input.run)
  });
  if (result.kind === "pending") {
    return { kind: "defer", reason: result.reason, delayMs: result.delayMs ?? 2_000 };
  }
  if (result.kind === "failed") {
    return { kind: "failed", code: result.code, reason: result.reason };
  }
  if (result.verificationRequestIds.length === 0) {
    throw new ControlPlaneError("FORBIDDEN", "Provider completion cannot advance without authoritative Verification");
  }
  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "verifying",
      now: (input.now ?? (() => new Date()))().toISOString(),
      checkpointPatch: {
        verificationRequestIds: [...result.verificationRequestIds]
      }
    })
  };
}

export async function advanceVerifyingToCompleted(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  taskDags: OrchestrationTaskDagStore;
  jobGraphs: OrchestrationJobGraphStore;
  runtime: GovernedJobRuntimePort;
  outcomes: ObjectiveOutcomePort;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "verifying") {
    throw new ControlPlaneError("CONFLICT", "Objective evaluation requires verifying orchestration state");
  }
  assertRuntimeBoundary(input.runtime);
  assertOutcomeBoundary(input.outcomes);
  const [taskDag, graph, planRef] = await Promise.all([
    input.taskDags.getByRunId(input.run.id),
    input.jobGraphs.getByRunId(input.run.id),
    Promise.resolve(input.run.checkpoints.plan)
  ]);
  if (!taskDag || !graph || !planRef) {
    throw new ControlPlaneError("FORBIDDEN", "Objective evaluation lost Plan/Task/Job lineage");
  }
  const plan = await input.plans.get(planRef.id);
  if (!plan) throw new ControlPlaneError("FORBIDDEN", "Objective evaluation Plan artifact was not found");
  assertPersistedPlanProposal(plan);
  const reconciled = await input.runtime.reconcile({
    run: input.run,
    taskDag,
    jobGraph: graph,
    idempotencyKey: reconciliationIdempotencyKey(input.run)
  });
  if (reconciled.kind === "pending") {
    return { kind: "defer", reason: reconciled.reason, delayMs: reconciled.delayMs ?? 2_000 };
  }
  if (reconciled.kind === "failed") {
    return { kind: "failed", code: reconciled.code, reason: reconciled.reason };
  }
  const result = await input.outcomes.evaluateAndRecord({
    run: input.run,
    plan,
    taskDag,
    jobGraph: reconciled.jobGraph,
    evidence: reconciled.evidence,
    idempotencyKey: outcomeIdempotencyKey(input.run)
  });
  if (result.kind === "pending") {
    return { kind: "defer", reason: result.reason, delayMs: result.delayMs ?? 5_000 };
  }
  if (result.kind === "failed") {
    return { kind: "failed", code: result.code, reason: result.reason };
  }
  const outcomeRef: VerifiedOutcomeRef = {
    id: result.outcome.id,
    verificationReceiptId: result.outcome.verificationReceiptId,
    verificationReceiptHash: result.outcome.verificationReceiptHash
  };
  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "completed",
      now: (input.now ?? (() => new Date()))().toISOString(),
      checkpointPatch: { verifiedOutcomes: [outcomeRef] }
    })
  };
}

export function createJobGraphArtifact(input: {
  run: OrchestrationRunRecord;
  taskDag: DurableTaskDagArtifact;
  jobs: readonly OrchestrationJobNode[];
  createdAt: string;
}): DurableJobGraphArtifact {
  const base = {
    id: jobGraphId(input.run.id),
    runId: input.run.id,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    taskDagId: input.taskDag.id,
    taskDagHash: input.taskDag.artifactHash,
    jobs: input.jobs,
    createdAt: new Date(input.createdAt).toISOString()
  };
  return deepFreeze({ ...base, artifactHash: sha256Hex(base) });
}
