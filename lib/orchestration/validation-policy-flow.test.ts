import { describe, expect, it } from "vitest";
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
  advancePlannedToValidated,
  advanceValidatedToPolicyEvaluated,
  type DurablePolicyEvaluationArtifact,
  type DurablePolicyStepSnapshotArtifact,
  type DurableValidationArtifact,
  type OrchestrationPolicyEvaluationStore,
  type OrchestrationPolicyStepSnapshotStore,
  type OrchestrationValidationArtifactStore
} from "@/lib/orchestration/validation-policy-flow";
import { transitionOrchestrationRun } from "@/lib/orchestration/contracts";
import { validPlan } from "@/lib/planning/test-fixture";
import { validationPolicyFor } from "@/lib/planning/test-security-fixture";

function buildPlanned() {
  const intent = {
    id: "intent-validation",
    correlationId: "correlation-validation",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging" as const,
    userId: "owner-a",
    message: "validate and govern this work",
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
  const snapshot = createOwnerIntentContextSnapshot({
    run: accepted,
    intent,
    assembledContext: context,
    createdAt: "2026-09-28T13:00:01.000Z"
  });
  const contextReady = transitionOrchestrationRun(accepted, {
    to: "context-ready",
    now: "2026-09-28T13:00:02.000Z",
    checkpointPatch: {
      contextSnapshot: { id: snapshot.id, hash: snapshot.snapshotHash }
    }
  });
  const plannerInput = createPlannerInputEnvelope({
    run: contextReady,
    snapshot,
    createdAt: "2026-09-28T13:00:03.000Z"
  });
  const planning = transitionOrchestrationRun(contextReady, {
    to: "planning",
    now: "2026-09-28T13:00:03.000Z",
    checkpointPatch: {
      plannerInput: { id: plannerInput.id, hash: plannerInput.inputHash }
    }
  });
  const proposal = validPlan({
    id: "plan-validation",
    scope: {
      portfolioId: intent.portfolioId,
      companyId: intent.companyId,
      environment: intent.environment,
      dataClass: "internal"
    },
    source: {
      type: "owner-request",
      requestId: intent.id
    },
    objective: undefined,
    createdAt: "2026-09-28T13:00:04.000Z"
  });
  const artifact = createPersistedPlanProposal({
    run: planning,
    plannerInput,
    plannerRequestId: "planner-request-validation",
    proposal,
    createdAt: "2026-09-28T13:00:04.000Z"
  });
  const planned = transitionOrchestrationRun(planning, {
    to: "planned",
    now: "2026-09-28T13:00:05.000Z",
    checkpointPatch: {
      plan: { id: artifact.id, hash: artifact.planHash }
    }
  });
  return { intent, artifact, planned };
}

class MemoryPlanStore implements OrchestrationPlanProposalStore {
  reads = 0;
  constructor(readonly artifact: PersistedPlanProposal) {}
  async create() {
    return { status: "idempotent-replay" as const, artifact: this.artifact };
  }
  async get(id: string) {
    this.reads += 1;
    return id === this.artifact.id ? this.artifact : null;
  }
  async getByRunVersion(runId: string, planningRunVersion: number) {
    return this.artifact.runId === runId
      && this.artifact.planningRunVersion === planningRunVersion
      ? this.artifact
      : null;
  }
}

class MemoryValidationStore implements OrchestrationValidationArtifactStore {
  value: DurableValidationArtifact | null = null;
  creates = 0;
  async create(artifact: DurableValidationArtifact) {
    this.creates += 1;
    if (this.value) {
      return { status: "idempotent-replay" as const, artifact: this.value };
    }
    this.value = artifact;
    return { status: "created" as const, artifact };
  }
  async get(id: string) {
    return this.value?.id === id ? this.value : null;
  }
  async getByRunVersion(runId: string, plannedRunVersion: number) {
    return this.value?.runId === runId
      && this.value.plannedRunVersion === plannedRunVersion
      ? this.value
      : null;
  }
}

class MemoryPolicyStepSnapshotStore
  implements OrchestrationPolicyStepSnapshotStore {
  values = new Map<string, DurablePolicyStepSnapshotArtifact>();
  creates = 0;

  async create(artifact: DurablePolicyStepSnapshotArtifact) {
    this.creates += 1;
    const key = `${artifact.runId}:${artifact.validatedRunVersion}:${artifact.stepId}`;
    const existing = this.values.get(key);
    if (existing) {
      return { status: "idempotent-replay" as const, artifact: existing };
    }
    this.values.set(key, artifact);
    return { status: "created" as const, artifact };
  }

  async getByRunVersionStep(
    runId: string,
    validatedRunVersion: number,
    stepId: string
  ) {
    return this.values.get(`${runId}:${validatedRunVersion}:${stepId}`) ?? null;
  }
}

class MemoryPolicyStore implements OrchestrationPolicyEvaluationStore {
  value: DurablePolicyEvaluationArtifact | null = null;
  creates = 0;
  async create(artifact: DurablePolicyEvaluationArtifact) {
    this.creates += 1;
    if (this.value) {
      return { status: "idempotent-replay" as const, artifact: this.value };
    }
    this.value = artifact;
    return { status: "created" as const, artifact };
  }
  async get(id: string) {
    return this.value?.id === id ? this.value : null;
  }
  async getByRunVersion(runId: string, validatedRunVersion: number) {
    return this.value?.runId === runId
      && this.value.validatedRunVersion === validatedRunVersion
      ? this.value
      : null;
  }
}

function validationResolver(plan: PersistedPlanProposal) {
  return {
    resolve: async () => ({
      validationPolicy: validationPolicyFor(plan.proposal),
      snapshot: {
        configurationVersion: "validation-config-v1",
        evidenceRequirements: {
          health: "not-applicable" as const,
          capacity: "not-applicable" as const,
          credentials: "not-applicable" as const
        },
        expiresAt: "2026-09-28T13:10:00.000Z"
      },
      receiptExpiresAt: "2026-09-28T13:09:00.000Z"
    })
  };
}

function policyResolver(plan: PersistedPlanProposal) {
  return {
    resolveStep: async () => ({
      region: "us-west",
      allowedEnvironments: [plan.proposal.scope.environment],
      allowedDataClasses: [plan.proposal.scope.dataClass],
      allowedRegions: ["us-west"],
      killSwitches: [],
      credentialRequirementIds: [],
      fallbackRequired: false,
      fallbackAvailable: true
    })
  };
}

describe("durable planned -> validated -> policy-evaluated flow", () => {
  it("reads the immutable Plan artifact, persists validation evidence, and advances planned -> validated", async () => {
    const { artifact, planned } = buildPlanned();
    const validations = new MemoryValidationStore();
    const result = await advancePlannedToValidated({
      run: planned,
      plans: new MemoryPlanStore(artifact),
      validations,
      resolver: validationResolver(artifact),
      now: () => new Date("2026-09-28T13:00:06.000Z")
    });

    expect(result.kind).toBe("advance");
    if (result.kind !== "advance") throw new Error("advance expected");
    expect(result.next.state).toBe("validated");
    expect(result.next.checkpoints.validationReceipt).toEqual({
      id: validations.value?.receipt.id,
      hash: validations.value?.receipt.receiptHash
    });
    expect(validations.value?.planArtifactHash).toBe(artifact.artifactHash);
    expect(validations.value?.validationPolicyHash).toHaveLength(64);
    expect(validations.value?.receipt.status).toBe("valid");
  });

  it("reuses persisted validation after crash before planned -> validated CAS", async () => {
    const { artifact, planned } = buildPlanned();
    const validations = new MemoryValidationStore();
    let resolverCalls = 0;
    const resolver = {
      resolve: async () => {
        resolverCalls += 1;
        return validationResolver(artifact).resolve();
      }
    };

    const first = await advancePlannedToValidated({
      run: planned,
      plans: new MemoryPlanStore(artifact),
      validations,
      resolver,
      now: () => new Date("2026-09-28T13:00:06.000Z")
    });
    expect(first.kind).toBe("advance");
    expect(resolverCalls).toBe(1);

    const replay = await advancePlannedToValidated({
      run: planned,
      plans: new MemoryPlanStore(artifact),
      validations,
      resolver: {
        resolve: async () => {
          throw new Error("validation inputs must not be resolved again");
        }
      },
      now: () => new Date("2026-09-28T14:00:00.000Z")
    });

    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.state).toBe("validated");
    expect(replay.next.checkpoints.validationReceipt)
      .toEqual(first.next.checkpoints.validationReceipt);
    expect(validations.creates).toBe(1);
  });

  it("records deterministic validation failure and blocks instead of masquerading as validated", async () => {
    const { artifact, planned } = buildPlanned();
    const validations = new MemoryValidationStore();

    const result = await advancePlannedToValidated({
      run: planned,
      plans: new MemoryPlanStore(artifact),
      validations,
      resolver: {
        resolve: async () => ({
          ...await validationResolver(artifact).resolve(),
          validationPolicy: validationPolicyFor(artifact.proposal, {
            maxPlanCostCents: 0,
            maxStepCostCents: 0
          })
        })
      },
      now: () => new Date("2026-09-28T13:00:06.000Z")
    });

    expect(result.kind).toBe("advance");
    if (result.kind !== "advance") throw new Error("advance expected");
    expect(result.next.state).toBe("blocked");
    expect(result.next.blockedReason).toMatch(/validation/i);
    expect(validations.value?.receipt.status).toBe("invalid");
    expect(result.next.checkpoints.validationReceipt?.id)
      .toBe(validations.value?.receipt.id);
  });

  it("freezes per-step policy inputs and advances validated -> policy-evaluated", async () => {
    const { artifact, planned } = buildPlanned();
    const validations = new MemoryValidationStore();
    const validatedOutcome = await advancePlannedToValidated({
      run: planned,
      plans: new MemoryPlanStore(artifact),
      validations,
      resolver: validationResolver(artifact),
      now: () => new Date("2026-09-28T13:00:06.000Z")
    });
    if (validatedOutcome.kind !== "advance" || validatedOutcome.next.state !== "validated") {
      throw new Error("validated run expected");
    }

    const policies = new MemoryPolicyStore();
    const result = await advanceValidatedToPolicyEvaluated({
      run: validatedOutcome.next,
      plans: new MemoryPlanStore(artifact),
      validations,
      policyStepSnapshots: new MemoryPolicyStepSnapshotStore(),
      policies,
      resolver: policyResolver(artifact),
      now: () => new Date("2026-09-28T13:00:07.000Z")
    });

    expect(result.kind).toBe("advance");
    if (result.kind !== "advance") throw new Error("advance expected");
    expect(result.next.state).toBe("policy-evaluated");
    expect(result.next.checkpoints.policySnapshot).toEqual({
      id: policies.value?.id,
      hash: policies.value?.artifactHash
    });
    expect(policies.value?.stepPolicies).toHaveLength(artifact.proposal.steps.length);
    expect(policies.value?.aggregateDisposition).toBe("AUTO");
    expect(policies.value?.stepPolicies[0]?.snapshot.planHash)
      .toBe(artifact.planHash);
    expect(policies.value?.stepPolicies[0]?.evaluation.readyForTaskGeneration)
      .toBe(true);
  });

  it("reuses per-step policy snapshots after crash before aggregate policy artifact commit", async () => {
    const { artifact, planned } = buildPlanned();
    const validations = new MemoryValidationStore();
    const validatedOutcome = await advancePlannedToValidated({
      run: planned,
      plans: new MemoryPlanStore(artifact),
      validations,
      resolver: validationResolver(artifact),
      now: () => new Date("2026-09-28T13:00:06.000Z")
    });
    if (validatedOutcome.kind !== "advance" || validatedOutcome.next.state !== "validated") {
      throw new Error("validated run expected");
    }

    const policyStepSnapshots = new MemoryPolicyStepSnapshotStore();
    let policyReads = 0;
    const failingPolicies: OrchestrationPolicyEvaluationStore = {
      create: async () => {
        throw new Error("simulated crash before aggregate policy artifact commit");
      },
      get: async () => null,
      getByRunVersion: async () => null
    };

    await expect(advanceValidatedToPolicyEvaluated({
      run: validatedOutcome.next,
      plans: new MemoryPlanStore(artifact),
      validations,
      policyStepSnapshots,
      policies: failingPolicies,
      resolver: {
        resolveStep: async ({ idempotencyKey }) => {
          policyReads += 1;
          expect(idempotencyKey).toContain(":policy:");
          return policyResolver(artifact).resolveStep();
        }
      },
      now: () => new Date("2026-09-28T13:00:07.000Z")
    })).rejects.toThrow(/simulated crash/i);

    expect(policyReads).toBe(artifact.proposal.steps.length);
    expect(policyStepSnapshots.creates).toBe(artifact.proposal.steps.length);

    const recoveredPolicies = new MemoryPolicyStore();
    const recovered = await advanceValidatedToPolicyEvaluated({
      run: validatedOutcome.next,
      plans: new MemoryPlanStore(artifact),
      validations,
      policyStepSnapshots,
      policies: recoveredPolicies,
      resolver: {
        resolveStep: async () => {
          throw new Error("policy resolver must not rerun after step snapshots commit");
        }
      },
      now: () => new Date("2026-09-28T13:05:00.000Z")
    });

    expect(recovered.kind).toBe("advance");
    if (recovered.kind !== "advance") throw new Error("advance expected");
    expect(recovered.next.state).toBe("policy-evaluated");
    expect(policyReads).toBe(artifact.proposal.steps.length);
    expect(policyStepSnapshots.creates).toBe(artifact.proposal.steps.length);
  });

  it("reuses persisted policy evaluation after crash without resolving live policy inputs again", async () => {
    const { artifact, planned } = buildPlanned();
    const validations = new MemoryValidationStore();
    const validatedOutcome = await advancePlannedToValidated({
      run: planned,
      plans: new MemoryPlanStore(artifact),
      validations,
      resolver: validationResolver(artifact),
      now: () => new Date("2026-09-28T13:00:06.000Z")
    });
    if (validatedOutcome.kind !== "advance" || validatedOutcome.next.state !== "validated") {
      throw new Error("validated run expected");
    }

    const policies = new MemoryPolicyStore();
    const policyStepSnapshots = new MemoryPolicyStepSnapshotStore();
    let policyReads = 0;
    const first = await advanceValidatedToPolicyEvaluated({
      run: validatedOutcome.next,
      plans: new MemoryPlanStore(artifact),
      validations,
      policyStepSnapshots,
      policies,
      resolver: {
        resolveStep: async () => {
          policyReads += 1;
          return policyResolver(artifact).resolveStep();
        }
      },
      now: () => new Date("2026-09-28T13:00:07.000Z")
    });
    expect(first.kind).toBe("advance");
    expect(policyReads).toBe(artifact.proposal.steps.length);

    const replay = await advanceValidatedToPolicyEvaluated({
      run: validatedOutcome.next,
      plans: new MemoryPlanStore(artifact),
      validations,
      policyStepSnapshots,
      policies,
      resolver: {
        resolveStep: async () => {
          throw new Error("policy inputs must not be resolved again");
        }
      },
      now: () => new Date("2026-09-28T14:00:00.000Z")
    });

    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.state).toBe("policy-evaluated");
    expect(replay.next.checkpoints.policySnapshot)
      .toEqual(first.next.checkpoints.policySnapshot);
    expect(policies.creates).toBe(1);
  });

  it("fails closed when the immutable Plan artifact does not match orchestration tenant lineage", async () => {
    const { artifact, planned } = buildPlanned();
    const forged = {
      ...artifact,
      companyId: "company-b"
    };

    await expect(advancePlannedToValidated({
      run: planned,
      plans: new MemoryPlanStore(forged as PersistedPlanProposal),
      validations: new MemoryValidationStore(),
      resolver: validationResolver(artifact)
    })).rejects.toThrow(/integrity|lineage/i);
  });
});
