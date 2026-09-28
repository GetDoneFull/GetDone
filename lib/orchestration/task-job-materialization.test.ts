import { describe, expect, it } from "vitest";
import {
  assertAuthorizationConsumption,
  createAuthorizationConsumptionRecord,
  issueAuthorizationGrant,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import { assembleContext } from "@/lib/intelligence/context";
import {
  createOwnerIntentContextSnapshot,
  createOwnerIntentOrchestrationRun
} from "@/lib/orchestration/owner-intent-flow";
import {
  createPersistedPlanProposal,
  createPlannerInputEnvelope,
  type OrchestrationPlanProposalStore,
  type PersistedPlanProposal
} from "@/lib/orchestration/planning-flow";
import {
  advanceAuthorizedToTasksCreated,
  advanceTasksCreatedToJobsEnqueued,
  deterministicJobId,
  deterministicPlanDagOrder,
  deterministicTaskId,
  propagateTaskDagStatus,
  type OrchestrationJobArtifact,
  type OrchestrationTaskArtifact,
  type OrchestrationTaskJobMaterializationStore,
  type TaskDagArtifact
} from "@/lib/orchestration/task-job-materialization";
import {
  createDurablePolicyEvaluationArtifact,
  createDurableValidationArtifact,
  type DurablePolicyEvaluationArtifact,
  type DurableValidationArtifact,
  type OrchestrationPolicyEvaluationStore,
  type OrchestrationValidationArtifactStore
} from "@/lib/orchestration/validation-policy-flow";
import {
  createOrchestrationRun,
  transitionOrchestrationRun,
  type OrchestrationRunRecord
} from "@/lib/orchestration/contracts";
import { hashPlanStep } from "@/lib/planning/plan-hash";
import {
  attestPlanValidation
} from "@/lib/planning/plan-validator";
import { evaluateStepPolicy } from "@/lib/planning/policy-engine";
import { createPolicySnapshot } from "@/lib/planning/policy-snapshot";
import type { PlanProposal, PlanStep } from "@/lib/planning/plan-schema";
import { validPlan } from "@/lib/planning/test-fixture";
import { validationPolicyFor } from "@/lib/planning/test-security-fixture";
import {
  createValidationReceipt,
  createValidationSnapshot
} from "@/lib/planning/validation-receipt";

class PlanStore implements OrchestrationPlanProposalStore {
  constructor(readonly value: PersistedPlanProposal) {}
  async create() {
    return { status: "idempotent-replay" as const, artifact: this.value };
  }
  async get(id: string) {
    return id === this.value.id ? this.value : null;
  }
  async getByRunVersion(runId: string, version: number) {
    return this.value.runId === runId && this.value.planningRunVersion === version
      ? this.value
      : null;
  }
}

class ValidationStore implements OrchestrationValidationArtifactStore {
  constructor(readonly value: DurableValidationArtifact) {}
  async create() {
    return { status: "idempotent-replay" as const, artifact: this.value };
  }
  async get(id: string) {
    return id === this.value.id ? this.value : null;
  }
  async getByRunVersion(runId: string, version: number) {
    return this.value.runId === runId && this.value.plannedRunVersion === version
      ? this.value
      : null;
  }
}

class PolicyStore implements OrchestrationPolicyEvaluationStore {
  constructor(readonly value: DurablePolicyEvaluationArtifact) {}
  async create() {
    return { status: "idempotent-replay" as const, artifact: this.value };
  }
  async get(id: string) {
    return id === this.value.id ? this.value : null;
  }
  async getByRunVersion(runId: string, version: number) {
    return this.value.runId === runId && this.value.validatedRunVersion === version
      ? this.value
      : null;
  }
}

class GrantStore implements AuthorizationGrantStore {
  readonly grants = new Map<string, AuthorizationGrant>();
  readonly consumptions = new Map<string, AuthorizationConsumptionRecord>();

  constructor(grants: readonly AuthorizationGrant[]) {
    for (const grant of grants) this.grants.set(grant.id, grant);
  }

  async get(id: string) {
    return this.grants.get(id) ?? null;
  }

  async consume(record: AuthorizationConsumptionRecord) {
    const grant = this.grants.get(record.grantId);
    if (!grant) throw new Error("grant missing");
    assertAuthorizationConsumption(record, grant);
    const existing = this.consumptions.get(record.grantId);
    if (existing) {
      if (existing.consumptionHash !== record.consumptionHash) {
        throw new Error("grant already consumed by different work");
      }
      return;
    }
    this.consumptions.set(record.grantId, record);
  }

  async listConsumptions(grantId: string) {
    const value = this.consumptions.get(grantId);
    return value ? [value] : [];
  }

  async revoke(id: string, _reason: string, _revokedAt: string) {
    const current = this.grants.get(id);
    if (!current) return;
    this.grants.set(id, { ...current, status: "revoked" });
  }
}

class MemoryMaterializationStore
  implements OrchestrationTaskJobMaterializationStore {
  readonly tasks = new Map<string, OrchestrationTaskArtifact>();
  readonly dags = new Map<string, TaskDagArtifact>();
  readonly jobs = new Map<string, OrchestrationJobArtifact>();

  constructor(private readonly grants: GrantStore) {}

  async claimTask(
    artifact: OrchestrationTaskArtifact,
    consumption: AuthorizationConsumptionRecord
  ) {
    const existing = this.tasks.get(artifact.taskId);
    if (existing) {
      if (existing.taskHash !== artifact.taskHash) {
        throw new Error("task replay conflict");
      }
      const persisted = this.grants.consumptions.get(artifact.authorizationGrantId);
      if (!persisted) throw new Error("task replay lost consumption");
      return { created: false, artifact: existing, consumption: persisted };
    }
    await this.grants.consume(consumption);
    this.tasks.set(artifact.taskId, artifact);
    return { created: true, artifact, consumption };
  }

  async getTask(taskId: string) {
    return this.tasks.get(taskId) ?? null;
  }

  async claimDag(dag: TaskDagArtifact) {
    const existing = this.dags.get(dag.id);
    if (existing) {
      if (existing.dagHash !== dag.dagHash) throw new Error("DAG replay conflict");
      return { created: false, dag: existing };
    }
    this.dags.set(dag.id, dag);
    return { created: true, dag };
  }

  async getDag(id: string) {
    return this.dags.get(id) ?? null;
  }

  async claimJob(job: OrchestrationJobArtifact) {
    const existing = this.jobs.get(job.jobId);
    if (existing) {
      if (existing.jobHash !== job.jobHash) throw new Error("job replay conflict");
      return { created: false, job: existing };
    }
    this.jobs.set(job.jobId, job);
    return { created: true, job };
  }

  async getJob(jobId: string) {
    return this.jobs.get(jobId) ?? null;
  }
}

function copyStep(
  source: PlanStep,
  input: {
    id: string;
    dependsOn?: readonly string[];
    ref: string;
  }
): PlanStep {
  return {
    ...source,
    id: input.id,
    title: `Inspect ${input.id}`,
    reason: `Collect evidence for ${input.id}`,
    dependsOn: [...(input.dependsOn ?? [])],
    capabilityRequests: [{
      capability: "repository.inspect",
      input: {
        companyId: "company-a",
        repository: "DMART19/GetDone",
        ref: input.ref
      }
    }],
    effects: [{
      key: `repository.inspected.${input.id}`,
      operation: "set",
      value: true
    }],
    verificationRequirements: [{
      id: `verify-${input.id}`,
      description: `Validate ${input.id}`,
      kind: "capability-output",
      required: true
    }]
  };
}

function fanPlan(): PlanProposal {
  const base = validPlan({
    id: "plan-gate-a",
    source: { type: "owner-request", requestId: "intent-gate-a" },
    objective: undefined,
    createdAt: "2026-09-28T13:00:04.000Z"
  });
  const seed = base.steps[0]!;
  const steps = [
    copyStep(seed, { id: "step-root", ref: "root" }),
    copyStep(seed, { id: "step-a", dependsOn: ["step-root"], ref: "a" }),
    copyStep(seed, { id: "step-b", dependsOn: ["step-root"], ref: "b" }),
    copyStep(seed, {
      id: "step-join",
      dependsOn: ["step-a", "step-b"],
      ref: "join"
    })
  ];
  return {
    ...base,
    estimatedCostCents: 80,
    steps
  };
}

function cyclePlan(): PlanProposal {
  const base = fanPlan();
  return {
    ...base,
    steps: base.steps.map((step) => {
      if (step.id === "step-root") return { ...step, dependsOn: ["step-join"] };
      return step;
    })
  };
}

function buildAuthorized(plan = fanPlan()) {
  const intent = {
    id: "intent-gate-a",
    correlationId: "correlation-gate-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging" as const,
    userId: "owner-a",
    message: "materialize this authorized plan",
    channel: "chat" as const,
    status: "accepted" as const,
    receivedAt: "2026-09-28T13:00:00.000Z"
  };
  const accepted = createOwnerIntentOrchestrationRun(intent);
  const context = assembleContext([], {
    portfolioId: intent.portfolioId,
    companyId: intent.companyId,
    allowedSensitivity: ["public", "internal"]
  }, {
    now: Date.parse("2026-09-28T13:00:01.000Z")
  });
  const contextSnapshot = createOwnerIntentContextSnapshot({
    run: accepted,
    intent,
    assembledContext: context,
    createdAt: "2026-09-28T13:00:01.000Z"
  });
  const contextReady = transitionOrchestrationRun(accepted, {
    to: "context-ready",
    now: "2026-09-28T13:00:02.000Z",
    checkpointPatch: {
      contextSnapshot: { id: contextSnapshot.id, hash: contextSnapshot.snapshotHash }
    }
  });
  const plannerInput = createPlannerInputEnvelope({
    run: contextReady,
    snapshot: contextSnapshot,
    createdAt: "2026-09-28T13:00:03.000Z"
  });
  const planning = transitionOrchestrationRun(contextReady, {
    to: "planning",
    now: "2026-09-28T13:00:03.000Z",
    checkpointPatch: {
      plannerInput: { id: plannerInput.id, hash: plannerInput.inputHash }
    }
  });
  const planArtifact = createPersistedPlanProposal({
    run: planning,
    plannerInput,
    plannerRequestId: "planner-request-gate-a",
    proposal: plan,
    createdAt: "2026-09-28T13:00:04.000Z"
  });
  const planned = transitionOrchestrationRun(planning, {
    to: "planned",
    now: "2026-09-28T13:00:05.000Z",
    checkpointPatch: {
      plan: { id: planArtifact.id, hash: planArtifact.planHash }
    }
  });

  const validationPolicy = validationPolicyFor(plan);
  const validationSnapshot = createValidationSnapshot({
    id: "validation-snapshot-gate-a",
    policyVersion: CURRENT_POLICY_VERSION,
    environment: plan.scope.environment,
    configurationVersion: "gate-a-v1",
    evidenceRequirements: {
      health: "not-applicable",
      capacity: "not-applicable",
      credentials: "not-applicable"
    },
    createdAt: "2026-09-28T13:00:06.000Z",
    expiresAt: "2026-09-28T13:30:00.000Z"
  });
  const attestation = attestPlanValidation(
    plan,
    validationPolicy,
    "2026-09-28T13:00:06.000Z"
  );
  const receipt = createValidationReceipt({
    id: "validation-receipt-gate-a",
    plan,
    attestation,
    snapshot: validationSnapshot,
    validatedAt: "2026-09-28T13:00:06.000Z",
    expiresAt: "2026-09-28T13:25:00.000Z"
  });
  const validationArtifact = createDurableValidationArtifact({
    run: planned,
    planArtifact,
    validationPolicy,
    snapshot: validationSnapshot,
    attestation,
    receipt,
    createdAt: "2026-09-28T13:00:06.000Z"
  });
  const validated = transitionOrchestrationRun(planned, {
    to: "validated",
    now: "2026-09-28T13:00:07.000Z",
    checkpointPatch: {
      validationReceipt: { id: receipt.id, hash: receipt.receiptHash }
    }
  });

  const stepPolicies = plan.steps.map((step) => {
    const stepHash = hashPlanStep(step);
    const snapshot = createPolicySnapshot({
      id: `policy-snapshot-gate-a:${step.id}`,
      policyVersion: CURRENT_POLICY_VERSION,
      scope: validated.scope,
      planHash: planArtifact.planHash,
      stepHash,
      capabilityNames: step.capabilityRequests.map((item) => item.capability),
      dataClass: plan.scope.dataClass,
      region: "us-west",
      allowedEnvironments: [plan.scope.environment],
      allowedDataClasses: [plan.scope.dataClass],
      allowedRegions: ["us-west"],
      killSwitches: [],
      credentialRequirementIds: [],
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: `policy-gate-a:${step.id}`,
      resourceRequirements: step.resourceRequirements,
      createdAt: "2026-09-28T13:00:08.000Z"
    });
    const evaluation = evaluateStepPolicy({
      authenticated: true,
      scopeResolved: true,
      trustedScope: snapshot.scope,
      capabilities: snapshot.capabilityNames,
      planHash: snapshot.planHash,
      stepHash: snapshot.stepHash,
      environment: snapshot.scope.environment,
      dataClass: snapshot.dataClass,
      region: snapshot.region,
      allowedEnvironments: snapshot.allowedEnvironments,
      allowedDataClasses: snapshot.allowedDataClasses,
      allowedRegions: snapshot.allowedRegions,
      credentialRequirementIds: [],
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: snapshot.idempotencyKey,
      killSwitches: [],
      now: Date.parse("2026-09-28T13:00:08.000Z")
    });
    if (!evaluation.readyForTaskGeneration || evaluation.disposition !== "AUTO") {
      throw new Error("Gate A fixture requires AUTO task-generation authority");
    }
    return { stepId: step.id, stepHash, snapshot, evaluation };
  });

  const policyArtifact = createDurablePolicyEvaluationArtifact({
    run: validated,
    planArtifact,
    validationArtifact,
    stepPolicies,
    createdAt: "2026-09-28T13:00:08.000Z"
  });
  const policyEvaluated = transitionOrchestrationRun(validated, {
    to: "policy-evaluated",
    now: "2026-09-28T13:00:09.000Z",
    checkpointPatch: {
      policySnapshot: { id: policyArtifact.id, hash: policyArtifact.artifactHash }
    }
  });

  const grants = stepPolicies.map((stepPolicy) =>
    issueAuthorizationGrant({
      id: `authorization-grant:${policyEvaluated.id}:${stepPolicy.stepId}`,
      plan,
      stepId: stepPolicy.stepId,
      receipt,
      policySnapshot: stepPolicy.snapshot,
      policyEvaluation: stepPolicy.evaluation,
      actor: { type: "system", id: "getdone-policy" },
      scope: policyEvaluated.scope,
      issuedAt: "2026-09-28T13:00:10.000Z",
      expiresAt: "2026-09-28T13:20:00.000Z"
    })
  );
  const authorized = transitionOrchestrationRun(policyEvaluated, {
    to: "authorized",
    now: "2026-09-28T13:00:10.000Z",
    checkpointPatch: {
      authorizationGrants: grants.map((grant) => ({
        id: grant.id,
        hash: grant.grantHash,
        disposition: grant.disposition
      }))
    }
  });

  const grantStore = new GrantStore(grants);
  return {
    authorized,
    planArtifact,
    validationArtifact,
    policyArtifact,
    grants,
    grantStore,
    stores: {
      plans: new PlanStore(planArtifact),
      validations: new ValidationStore(validationArtifact),
      policies: new PolicyStore(policyArtifact)
    }
  };
}

function crossCompanyAuthorized(source: OrchestrationRunRecord) {
  let run = createOrchestrationRun({
    id: source.id,
    correlationId: source.correlationId,
    source: source.source,
    scope: { ...source.scope, companyId: "company-b" },
    createdAt: "2026-09-28T13:00:00.000Z",
    updatedAt: "2026-09-28T13:00:00.000Z"
  });
  run = transitionOrchestrationRun(run, {
    to: "context-ready",
    now: "2026-09-28T13:00:02.000Z",
    checkpointPatch: { contextSnapshot: source.checkpoints.contextSnapshot }
  });
  run = transitionOrchestrationRun(run, {
    to: "planning",
    now: "2026-09-28T13:00:03.000Z",
    checkpointPatch: { plannerInput: source.checkpoints.plannerInput }
  });
  run = transitionOrchestrationRun(run, {
    to: "planned",
    now: "2026-09-28T13:00:05.000Z",
    checkpointPatch: { plan: source.checkpoints.plan }
  });
  run = transitionOrchestrationRun(run, {
    to: "validated",
    now: "2026-09-28T13:00:07.000Z",
    checkpointPatch: { validationReceipt: source.checkpoints.validationReceipt }
  });
  run = transitionOrchestrationRun(run, {
    to: "policy-evaluated",
    now: "2026-09-28T13:00:09.000Z",
    checkpointPatch: { policySnapshot: source.checkpoints.policySnapshot }
  });
  return transitionOrchestrationRun(run, {
    to: "authorized",
    now: "2026-09-28T13:00:10.000Z",
    checkpointPatch: { authorizationGrants: source.checkpoints.authorizationGrants }
  });
}

describe("Core Tranche A: AuthorizationGrant -> Task DAG -> Jobs", () => {
  it("rejects cycles before executable work can materialize", () => {
    expect(() => deterministicPlanDagOrder(cyclePlan()))
      .toThrow(/dependency cycle/i);
  });

  it("deterministically materializes fan-out/fan-in Tasks and Jobs with no replay duplicates", async () => {
    const built = buildAuthorized();
    const materialization = new MemoryMaterializationStore(built.grantStore);
    const now = () => new Date("2026-09-28T13:00:11.000Z");

    const firstTasks = await advanceAuthorizedToTasksCreated({
      run: built.authorized,
      ...built.stores,
      grants: built.grantStore,
      materialization,
      now
    });
    const replayTasks = await advanceAuthorizedToTasksCreated({
      run: built.authorized,
      ...built.stores,
      grants: built.grantStore,
      materialization,
      now
    });

    expect(firstTasks.kind).toBe("advance");
    expect(replayTasks.kind).toBe("advance");
    if (firstTasks.kind !== "advance" || replayTasks.kind !== "advance") {
      throw new Error("tasks-created advance expected");
    }
    expect(firstTasks.next.state).toBe("tasks-created");
    expect(replayTasks.next.checkpoints.tasks)
      .toEqual(firstTasks.next.checkpoints.tasks);
    expect(materialization.tasks.size).toBe(4);
    expect(built.grantStore.consumptions.size).toBe(4);

    const dag = await materialization.getDag(firstTasks.next.checkpoints.taskDag!.id);
    if (!dag) throw new Error("DAG expected");
    expect(dag.topologicalOrder).toEqual([
      deterministicTaskId(built.authorized.id, "step-root"),
      deterministicTaskId(built.authorized.id, "step-a"),
      deterministicTaskId(built.authorized.id, "step-b"),
      deterministicTaskId(built.authorized.id, "step-join")
    ]);
    const root = dag.nodes.find((node) => node.planStepId === "step-root")!;
    const join = dag.nodes.find((node) => node.planStepId === "step-join")!;
    expect(root.dependents).toEqual([
      deterministicTaskId(built.authorized.id, "step-a"),
      deterministicTaskId(built.authorized.id, "step-b")
    ]);
    expect(join.dependencies).toEqual([
      deterministicTaskId(built.authorized.id, "step-a"),
      deterministicTaskId(built.authorized.id, "step-b")
    ]);

    const firstJobs = await advanceTasksCreatedToJobsEnqueued({
      run: firstTasks.next,
      ...built.stores,
      grants: built.grantStore,
      materialization,
      now
    });
    const replayJobs = await advanceTasksCreatedToJobsEnqueued({
      run: firstTasks.next,
      ...built.stores,
      grants: built.grantStore,
      materialization,
      now
    });

    expect(firstJobs.kind).toBe("advance");
    expect(replayJobs.kind).toBe("advance");
    if (firstJobs.kind !== "advance" || replayJobs.kind !== "advance") {
      throw new Error("jobs-enqueued advance expected");
    }
    expect(firstJobs.next.state).toBe("jobs-enqueued");
    expect(replayJobs.next.checkpoints.jobIds)
      .toEqual(firstJobs.next.checkpoints.jobIds);
    expect(materialization.jobs.size).toBe(4);

    const joinTaskId = deterministicTaskId(built.authorized.id, "step-join");
    const joinJob = materialization.jobs.get(deterministicJobId(joinTaskId, 0))!;
    expect(joinJob.dependencyJobIds).toEqual([
      deterministicJobId(deterministicTaskId(built.authorized.id, "step-a"), 0),
      deterministicJobId(deterministicTaskId(built.authorized.id, "step-b"), 0)
    ]);
    expect(joinJob.authorityLineage.authorizationConsumptionHash)
      .toBe(materialization.tasks.get(joinTaskId)!.authorizationConsumptionHash);
    expect(joinJob.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(joinJob.sideEffectIdempotencyKey)
      .toBe(`job:${joinJob.jobId}:side-effect:repository.inspect`);
  });

  it("propagates failure and cancellation across blocked dependencies and remains resumable", async () => {
    const built = buildAuthorized();
    const materialization = new MemoryMaterializationStore(built.grantStore);
    const result = await advanceAuthorizedToTasksCreated({
      run: built.authorized,
      ...built.stores,
      grants: built.grantStore,
      materialization,
      now: () => new Date("2026-09-28T13:00:11.000Z")
    });
    if (result.kind !== "advance") throw new Error("tasks-created expected");
    const dag = await materialization.getDag(result.next.checkpoints.taskDag!.id);
    if (!dag) throw new Error("DAG expected");

    const root = deterministicTaskId(built.authorized.id, "step-root");
    const a = deterministicTaskId(built.authorized.id, "step-a");
    const b = deterministicTaskId(built.authorized.id, "step-b");
    const join = deterministicTaskId(built.authorized.id, "step-join");

    expect(propagateTaskDagStatus(dag, { [root]: "failed" })).toMatchObject({
      [root]: "failed",
      [a]: "blocked",
      [b]: "blocked",
      [join]: "blocked"
    });
    expect(propagateTaskDagStatus(dag, { [root]: "cancelled" })).toMatchObject({
      [root]: "cancelled",
      [a]: "cancelled",
      [b]: "cancelled",
      [join]: "cancelled"
    });
    expect(propagateTaskDagStatus(dag, { [root]: "blocked" })).toMatchObject({
      [root]: "blocked",
      [a]: "blocked",
      [b]: "blocked",
      [join]: "blocked"
    });
    expect(propagateTaskDagStatus(dag, {
      [root]: "succeeded",
      [a]: "succeeded",
      [b]: "running"
    })[join]).toBe("waiting");
    expect(propagateTaskDagStatus(dag, {
      [root]: "succeeded",
      [a]: "succeeded",
      [b]: "succeeded"
    })[join]).toBe("ready");
  });

  it("fails closed when a grant was already consumed by different work", async () => {
    const built = buildAuthorized();
    const grant = built.grants[0]!;
    const foreign = createAuthorizationConsumptionRecord({
      id: `authorization-consumption:${grant.id}`,
      grant,
      consumerType: "task",
      consumerId: "task:foreign-run:foreign-step",
      consumedAt: "2026-09-28T13:00:10.000Z"
    });
    built.grantStore.consumptions.set(grant.id, foreign);

    await expect(
      advanceAuthorizedToTasksCreated({
        run: built.authorized,
        ...built.stores,
        grants: built.grantStore,
        materialization: new MemoryMaterializationStore(built.grantStore),
        now: () => new Date("2026-09-28T13:00:11.000Z")
      })
    ).rejects.toThrow(/already consumed by different work/i);
  });

  it("stops before grant consumption when the authoritative Objective is paused", async () => {
    const built = buildAuthorized(validPlan({
      id: "plan-objective-gate-a",
      createdAt: "2026-09-28T13:00:04.000Z"
    }));
    const materialization = new MemoryMaterializationStore(built.grantStore);

    const result = await advanceAuthorizedToTasksCreated({
      run: built.authorized,
      ...built.stores,
      grants: built.grantStore,
      materialization,
      objectiveStatusResolver: {
        getStatus: async () => "paused"
      },
      now: () => new Date("2026-09-28T13:00:11.000Z")
    });

    expect(result.kind).toBe("advance");
    if (result.kind !== "advance") throw new Error("blocked advance expected");
    expect(result.next.state).toBe("blocked");
    expect(materialization.tasks.size).toBe(0);
    expect(built.grantStore.consumptions.size).toBe(0);
  });

  it("fails closed for revoked authority before Task materialization", async () => {
    const built = buildAuthorized();
    await built.grantStore.revoke(built.grants[0]!.id, "test", "2026-09-28T13:00:10.500Z");

    await expect(
      advanceAuthorizedToTasksCreated({
        run: built.authorized,
        ...built.stores,
        grants: built.grantStore,
        materialization: new MemoryMaterializationStore(built.grantStore),
        now: () => new Date("2026-09-28T13:00:11.000Z")
      })
    ).rejects.toThrow();
  });

  it("fails closed when authoritative Plan lineage is reused across another company", async () => {
    const built = buildAuthorized();
    const crossCompany = crossCompanyAuthorized(built.authorized);

    await expect(
      advanceAuthorizedToTasksCreated({
        run: crossCompany,
        ...built.stores,
        grants: built.grantStore,
        materialization: new MemoryMaterializationStore(built.grantStore),
        now: () => new Date("2026-09-28T13:00:11.000Z")
      })
    ).rejects.toThrow(/scope|tenant|lineage/i);
  });
});
