import { describe, expect, it } from "vitest";
import {
  createApprovalProof,
  createStepUpProof
} from "@/lib/authorization/proofs";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import { assembleContext } from "@/lib/intelligence/context";
import {
  advanceAwaitingDecisionToAuthorized,
  advancePolicyEvaluatedToAuthority,
  DecisionResumeDispatcher,
  orchestrationDecisionId,
  type OrchestrationAuthorizationGrantStore,
  type OrchestrationDecisionStore
} from "@/lib/orchestration/authorization-flow";
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
  createDurablePolicyEvaluationArtifact,
  createDurableValidationArtifact,
  type DurablePolicyEvaluationArtifact,
  type DurableValidationArtifact,
  type OrchestrationPolicyEvaluationStore,
  type OrchestrationValidationArtifactStore
} from "@/lib/orchestration/validation-policy-flow";
import {
  transitionOrchestrationRun,
  type OrchestrationRunRecord,
  type OrchestrationRunStore
} from "@/lib/orchestration/contracts";
import { validPlan } from "@/lib/planning/test-fixture";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import {
  attestPlanValidation
} from "@/lib/planning/plan-validator";
import {
  createValidationReceipt,
  createValidationSnapshot
} from "@/lib/planning/validation-receipt";
import { hashPlanStep } from "@/lib/planning/plan-hash";
import {
  evaluateStepPolicy
} from "@/lib/planning/policy-engine";
import {
  createPolicySnapshot
} from "@/lib/planning/policy-snapshot";
import { validationPolicyFor } from "@/lib/planning/test-security-fixture";

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

class DecisionStore implements OrchestrationDecisionStore {
  values = new Map<string, AuthoritativeDecision>();
  creates = 0;

  async create(decision: AuthoritativeDecision) {
    this.creates += 1;
    const existing = this.values.get(decision.id);
    if (existing) {
      if (
        existing.portfolioId !== decision.portfolioId
        || existing.companyId !== decision.companyId
        || existing.correlationId !== decision.correlationId
        || existing.requiresStepUp !== decision.requiresStepUp
        || JSON.stringify(existing.approvalBinding)
          !== JSON.stringify(decision.approvalBinding)
        || existing.version < decision.version
      ) {
        throw new Error("decision replay conflict");
      }
      return { status: "idempotent-replay" as const, decision: existing };
    }
    this.values.set(decision.id, decision);
    return { status: "created" as const, decision };
  }

  async get(id: string) {
    return this.values.get(id) ?? null;
  }
}

class RunStore implements OrchestrationRunStore {
  readonly descriptor = {
    persistence: "durable-external" as const,
    compareAndSwap: true,
    uniqueCorrelationId: true,
    restartSafe: true,
    multiProcessSafe: true,
    productionEligible: true
  };
  constructor(public value: OrchestrationRunRecord) {}
  async create() {
    return { status: "idempotent-replay" as const, record: this.value };
  }
  async get(id: string) {
    return this.value.id === id ? this.value : null;
  }
  async getByCorrelationId(correlationId: string) {
    return this.value.correlationId === correlationId ? this.value : null;
  }
  async compareAndSwap(
    next: OrchestrationRunRecord,
    input: { expectedVersion: number; expectedRecordHash: string }
  ) {
    if (
      this.value.version !== input.expectedVersion
      || this.value.recordHash !== input.expectedRecordHash
    ) {
      throw new Error("run CAS conflict");
    }
    this.value = next;
    return next;
  }
  async listResumable() {
    return [this.value];
  }
}

class ResumeQueue {
  processed = false;
  failMarkOnce = false;
  constructor(public record: {
    id: string;
    runId: string;
    decisionId: string;
    decisionVersion: number;
    correlationId: string;
    portfolioId: string;
    companyId: string;
    resolution: "approved";
    createdAt: string;
    requestHash: string;
    status: "pending" | "processed";
    processedAt?: string;
  }) {}

  async getByDecisionVersion(decisionId: string, decisionVersion: number) {
    return this.record.decisionId === decisionId
      && this.record.decisionVersion === decisionVersion
      ? this.record
      : null;
  }
  async listPending() {
    return this.record.status === "pending" ? [this.record] : [];
  }
  async markProcessed(id: string, requestHash: string, processedAt: string) {
    if (this.failMarkOnce) {
      this.failMarkOnce = false;
      throw new Error("simulated crash after orchestration CAS");
    }
    if (id !== this.record.id || requestHash !== this.record.requestHash) {
      throw new Error("resume queue mismatch");
    }
    this.processed = true;
    this.record = {
      ...this.record,
      status: "processed",
      processedAt
    };
  }
}

class GrantStore implements OrchestrationAuthorizationGrantStore {
  values = new Map<string, AuthorizationGrant>();
  inserts = 0;

  async insertMany(grants: readonly AuthorizationGrant[]) {
    this.inserts += 1;
    const staged = new Map(this.values);
    for (const grant of grants) {
      const existing = staged.get(grant.id);
      if (existing && existing.grantHash !== grant.grantHash) {
        throw new Error("grant replay conflict");
      }
      staged.set(grant.id, existing ?? grant);
    }
    this.values = staged;
  }

  async get(id: string) {
    return this.values.get(id) ?? null;
  }
}

function capabilityPlan(
  capability: "repository.inspect" | "email.send" | "production.deploy"
): PlanProposal {
  if (capability === "production.deploy") return productionDeployPlan();
  if (capability === "repository.inspect") return validPlan({
    id: `plan-${capability}`,
    source: { type: "owner-request", requestId: `intent-${capability}` },
    objective: undefined,
    createdAt: "2026-09-28T13:00:04.000Z"
  });

  const base = validPlan();
  return {
    ...base,
    id: `plan-${capability}`,
    source: { type: "owner-request" as const, requestId: `intent-${capability}` },
    objective: undefined,
    scope: {
      ...base.scope,
      dataClass: "customer" as const
    },
    requestedCapabilities: ["email.send"],
    risk: {
      level: "medium" as const,
      summary: "Outbound customer email",
      blastRadius: "single-object" as const
    },
    steps: [{
      ...base.steps[0],
      id: "step-1",
      title: "Send customer email",
      capabilityRequests: [{
        capability: "email.send",
        input: {
          companyId: "company-a",
          to: ["customer@example.com"],
          cc: [],
          subject: "Update",
          text: "Hello"
        }
      }],
      risk: {
        level: "medium" as const,
        summary: "Outbound customer email",
        blastRadius: "single-object" as const
      },
      resourceRequirements: {
        ...base.steps[0].resourceRequirements,
        data: {
          ...base.steps[0].resourceRequirements.data,
          classification: "customer" as const,
          customerData: true
        }
      }
    }],
    createdAt: "2026-09-28T13:00:04.000Z"
  };
}

function productionDeployPlan(): PlanProposal {
  const base = validPlan();
  return {
    ...base,
    id: "plan-production.deploy",
    scope: {
      ...base.scope,
      environment: "production",
      dataClass: "sensitive"
    },
    source: {
      type: "owner-request",
      requestId: "intent-production.deploy"
    },
    objective: undefined,
    requestedCapabilities: ["production.deploy"],
    risk: {
      level: "critical",
      summary: "Production deployment",
      blastRadius: "company"
    },
    rollback: {
      strategy: "Rollback to the previous verified release",
      cancellationAllowed: true
    },
    steps: [{
      ...base.steps[0],
      title: "Deploy verified release",
      capabilityRequests: [{
        capability: "production.deploy",
        input: {
          companyId: "company-a",
          repository: "DMART19/GetDone",
          commitSha: "abcdef1234567",
          environment: "production",
          deploymentId: "deploy-1",
          rollbackRef: "previous-release",
          verificationChecks: ["health"]
        }
      }],
      risk: {
        level: "critical",
        summary: "Production deployment",
        blastRadius: "company"
      },
      rollback: {
        strategy: "Rollback to the previous verified release",
        cancellationAllowed: true
      },
      resourceRequirements: {
        ...base.steps[0].resourceRequirements,
        execution: {
          ...base.steps[0].resourceRequirements.execution,
          environment: "production"
        },
        data: {
          ...base.steps[0].resourceRequirements.data,
          classification: "sensitive",
          customerData: false
        }
      }
    }],
    createdAt: "2026-09-28T13:00:04.000Z"
  };
}

function buildPolicyEvaluated(capability: "repository.inspect" | "email.send" | "production.deploy") {
  const intent = {
    id: `intent-${capability}`,
    correlationId: `correlation-${capability}`,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: capability === "production.deploy"
      ? "production" as const
      : "staging" as const,
    userId: "owner-a",
    message: "govern this work",
    channel: "chat" as const,
    status: "accepted" as const,
    receivedAt: "2026-09-28T13:00:00.000Z"
  };
  const accepted = createOwnerIntentOrchestrationRun(intent);
  const context = assembleContext([], {
    portfolioId: intent.portfolioId,
    companyId: intent.companyId,
    allowedSensitivity: ["public", "internal", "customer"]
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
  const plan = capabilityPlan(capability);
  const planArtifact = createPersistedPlanProposal({
    run: planning,
    plannerInput,
    plannerRequestId: `planner-request-${capability}`,
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
    id: `validation-snapshot-${capability}`,
    policyVersion: CURRENT_POLICY_VERSION,
    environment: plan.scope.environment,
    configurationVersion: "authorization-test-v1",
    evidenceRequirements: {
      health: "not-applicable",
      capacity: "not-applicable",
      credentials: "not-applicable"
    },
    createdAt: "2026-09-28T13:00:06.000Z",
    expiresAt: "2026-09-28T13:20:00.000Z"
  });
  const attestation = attestPlanValidation(
    plan,
    validationPolicy,
    "2026-09-28T13:00:06.000Z"
  );
  const receipt = createValidationReceipt({
    id: `validation-receipt-${capability}`,
    plan,
    attestation,
    snapshot: validationSnapshot,
    validatedAt: "2026-09-28T13:00:06.000Z",
    expiresAt: "2026-09-28T13:15:00.000Z"
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

  const step = plan.steps[0]!;
  const stepHash = hashPlanStep(step);
  const policySnapshot = createPolicySnapshot({
    id: `policy-snapshot-${capability}`,
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
    idempotencyKey: `policy-${capability}-step-1`,
    resourceRequirements: step.resourceRequirements,
    createdAt: "2026-09-28T13:00:08.000Z"
  });
  const evaluation = evaluateStepPolicy({
    authenticated: true,
    scopeResolved: true,
    trustedScope: policySnapshot.scope,
    capabilities: policySnapshot.capabilityNames,
    planHash: policySnapshot.planHash,
    stepHash: policySnapshot.stepHash,
    environment: policySnapshot.scope.environment,
    dataClass: policySnapshot.dataClass,
    region: policySnapshot.region,
    allowedEnvironments: policySnapshot.allowedEnvironments,
    allowedDataClasses: policySnapshot.allowedDataClasses,
    allowedRegions: policySnapshot.allowedRegions,
    credentialRequirementIds: [],
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: policySnapshot.idempotencyKey,
    killSwitches: [],
    now: Date.parse("2026-09-28T13:00:08.000Z")
  });
  const policyArtifact = createDurablePolicyEvaluationArtifact({
    run: validated,
    planArtifact,
    validationArtifact,
    stepPolicies: [{
      stepId: step.id,
      stepHash,
      snapshot: policySnapshot,
      evaluation
    }],
    createdAt: "2026-09-28T13:00:08.000Z"
  });
  const policyEvaluated = transitionOrchestrationRun(validated, {
    to: "policy-evaluated",
    now: "2026-09-28T13:00:09.000Z",
    checkpointPatch: {
      policySnapshot: { id: policyArtifact.id, hash: policyArtifact.artifactHash }
    }
  });

  return {
    planArtifact,
    validationArtifact,
    policyArtifact,
    policyEvaluated,
    stores: {
      plans: new PlanStore(planArtifact),
      validations: new ValidationStore(validationArtifact),
      policies: new PolicyStore(policyArtifact)
    }
  };
}

describe("durable policy-evaluated -> authorized flow", () => {
  it("issues exact-hash AUTO grants and advances directly to authorized", async () => {
    const built = buildPolicyEvaluated("repository.inspect");
    const decisions = new DecisionStore();
    const grants = new GrantStore();

    const result = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:10.000Z")
    });

    expect(result.kind).toBe("advance");
    if (result.kind !== "advance") throw new Error("advance expected");
    expect(result.next.state).toBe("authorized");
    expect(result.next.checkpoints.authorizationGrants).toHaveLength(1);

    const grant = [...grants.values.values()][0]!;
    expect(grant).toMatchObject({
      disposition: "AUTO",
      planHash: built.planArtifact.planHash,
      validationReceiptHash: built.validationArtifact.receipt.receiptHash,
      policySnapshotHash: built.policyArtifact.stepPolicies[0]!.snapshot.snapshotHash
    });
    expect(grant.stepHash).toBe(built.policyArtifact.stepPolicies[0]!.stepHash);
    expect(grant.grantHash).toHaveLength(64);
  });

  it("reuses the same grant after crash before policy-evaluated -> authorized CAS", async () => {
    const built = buildPolicyEvaluated("repository.inspect");
    const decisions = new DecisionStore();
    const grants = new GrantStore();

    const first = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:10.000Z")
    });
    const firstHash = [...grants.values.values()][0]!.grantHash;

    const replay = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:11.000Z")
    });

    expect(first.kind).toBe("advance");
    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.checkpoints.authorizationGrants)
      .toEqual(first.next.checkpoints.authorizationGrants);
    expect([...grants.values.values()][0]!.grantHash).toBe(firstHash);
    expect(grants.values.size).toBe(1);
  });

  it("recovers when the owner resolved a Decision after create but before the orchestration CAS", async () => {
    const built = buildPolicyEvaluated("email.send");
    const decisions = new DecisionStore();
    const grants = new GrantStore();

    const first = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:10.000Z")
    });
    if (first.kind !== "advance" || first.next.state !== "awaiting-decision") {
      throw new Error("awaiting-decision expected");
    }

    // Simulate the process dying before the orchestration CAS, while the owner
    // resolves the already-visible authoritative Decision.
    const id = first.next.checkpoints.decisionIds[0]!;
    const pending = decisions.values.get(id)!;
    const binding = pending.approvalBinding!;
    const proof = createApprovalProof({
      id: `approval-proof:${id}:v2`,
      decisionId: id,
      approvalId: `approval:${id}`,
      actorId: "owner-a",
      scope: built.policyEvaluated.scope,
      level: "approval",
      planHash: binding.planHash,
      stepHash: binding.stepHash,
      grantedAt: "2026-09-28T13:00:11.000Z",
      expiresAt: "2026-09-28T13:10:00.000Z"
    });
    decisions.values.set(id, Object.freeze({
      ...pending,
      status: "approved",
      version: 2,
      updatedAt: "2026-09-28T13:00:11.000Z",
      approvalProof: proof
    }));

    const recovered = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:12.000Z")
    });

    expect(recovered.kind).toBe("advance");
    if (recovered.kind !== "advance") throw new Error("advance expected");
    expect(recovered.next.state).toBe("authorized");
    expect(recovered.next.checkpoints.decisionIds).toEqual([id]);
    expect(recovered.next.checkpoints.authorizationGrants).toHaveLength(1);
    expect(grants.values.size).toBe(1);
  });

  it("creates an exact-bound Decision and pauses when policy requires approval", async () => {
    const built = buildPolicyEvaluated("email.send");
    const decisions = new DecisionStore();
    const grants = new GrantStore();

    const result = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:10.000Z")
    });

    expect(result.kind).toBe("advance");
    if (result.kind !== "advance") throw new Error("advance expected");
    expect(result.next.state).toBe("awaiting-decision");
    expect(grants.values.size).toBe(0);

    const expectedId = orchestrationDecisionId(
      built.policyEvaluated.id,
      built.policyArtifact,
      "step-1"
    );
    expect(result.next.checkpoints.decisionIds).toEqual([expectedId]);
    const decision = decisions.values.get(expectedId)!;
    expect(decision).toMatchObject({
      status: "pending",
      requiresStepUp: false,
      portfolioId: "portfolio-a",
      companyId: "company-a",
      approvalBinding: {
        planHash: built.planArtifact.planHash,
        stepHash: built.policyArtifact.stepPolicies[0]!.stepHash,
        policySnapshotHash:
          built.policyArtifact.stepPolicies[0]!.snapshot.snapshotHash,
        validationReceiptHash: built.validationArtifact.receipt.receiptHash,
        requirement: "approval"
      }
    });
  });

  it("resumes an approved Decision into exact-hash authorization", async () => {
    const built = buildPolicyEvaluated("email.send");
    const decisions = new DecisionStore();
    const grants = new GrantStore();
    const waitingResult = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:10.000Z")
    });
    if (waitingResult.kind !== "advance" || waitingResult.next.state !== "awaiting-decision") {
      throw new Error("awaiting-decision expected");
    }

    const id = waitingResult.next.checkpoints.decisionIds[0]!;
    const pending = decisions.values.get(id)!;
    const binding = pending.approvalBinding!;
    const proof = createApprovalProof({
      id: `approval-proof:${id}:v2`,
      decisionId: id,
      approvalId: `approval:${id}`,
      actorId: "owner-a",
      scope: waitingResult.next.scope,
      level: "approval",
      planHash: binding.planHash,
      stepHash: binding.stepHash,
      grantedAt: "2026-09-28T13:00:11.000Z",
      expiresAt: "2026-09-28T13:10:00.000Z"
    });
    decisions.values.set(id, Object.freeze({
      ...pending,
      status: "approved",
      version: 2,
      updatedAt: "2026-09-28T13:00:11.000Z",
      resolvedBy: "owner-a",
      approvalProof: proof
    }));

    const authorized = await advanceAwaitingDecisionToAuthorized({
      run: waitingResult.next,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:12.000Z")
    });

    expect(authorized.kind).toBe("advance");
    if (authorized.kind !== "advance") throw new Error("advance expected");
    expect(authorized.next.state).toBe("authorized");
    const grant = [...grants.values.values()][0]!;
    expect(grant.disposition).toBe("APPROVAL_REQUIRED");
    expect(grant.decisionId).toBe(id);
    expect(grant.approvalProofHash).toBe(proof.proofHash);
    expect(grant.planHash).toBe(binding.planHash);
    expect(grant.stepHash).toBe(binding.stepHash);
  });

  it("requires strong owner approval plus fresh step-up before issuing a strong grant", async () => {
    const built = buildPolicyEvaluated("production.deploy");
    const decisions = new DecisionStore();
    const grants = new GrantStore();
    const waiting = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:10.000Z")
    });
    if (waiting.kind !== "advance" || waiting.next.state !== "awaiting-decision") {
      throw new Error("awaiting-decision expected");
    }

    const id = waiting.next.checkpoints.decisionIds[0]!;
    const pending = decisions.values.get(id)!;
    expect(pending.requiresStepUp).toBe(true);
    expect(pending.approvalBinding?.requirement).toBe("strong-approval");

    const stepUp = createStepUpProof({
      id: "step-up-production",
      actorId: "owner-a",
      scope: waiting.next.scope,
      method: "passkey",
      authenticatedAt: "2026-09-28T13:00:10.000Z",
      expiresAt: "2026-09-28T13:05:00.000Z"
    });
    const binding = pending.approvalBinding!;
    const proof = createApprovalProof({
      id: `approval-proof:${id}:v2`,
      decisionId: id,
      approvalId: `approval:${id}`,
      actorId: "owner-a",
      scope: waiting.next.scope,
      level: "strong-approval",
      planHash: binding.planHash,
      stepHash: binding.stepHash,
      grantedAt: "2026-09-28T13:00:11.000Z",
      expiresAt: "2026-09-28T13:05:00.000Z",
      stepUpProofId: stepUp.id
    });
    decisions.values.set(id, Object.freeze({
      ...pending,
      status: "approved",
      version: 2,
      updatedAt: "2026-09-28T13:00:11.000Z",
      resolvedBy: "owner-a",
      approvalProof: proof,
      stepUpProof: stepUp
    }));

    const authorized = await advanceAwaitingDecisionToAuthorized({
      run: waiting.next,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:12.000Z")
    });
    expect(authorized.kind).toBe("advance");
    if (authorized.kind !== "advance") throw new Error("advance expected");
    expect(authorized.next.state).toBe("authorized");
    const grant = [...grants.values.values()][0]!;
    expect(grant.disposition).toBe("STRONG_APPROVAL");
    expect(grant.stepUpProofHash).toBe(stepUp.proofHash);
    expect(grant.approvalProofHash).toBe(proof.proofHash);
  });

  it("blocks rejected or modified Decisions instead of creating authority", async () => {
    for (const status of ["rejected", "modified"] as const) {
      const built = buildPolicyEvaluated("email.send");
      const decisions = new DecisionStore();
      const grants = new GrantStore();
      const waiting = await advancePolicyEvaluatedToAuthority({
        run: built.policyEvaluated,
        ...built.stores,
        decisions,
        grants,
        now: () => new Date("2026-09-28T13:00:10.000Z")
      });
      if (waiting.kind !== "advance" || waiting.next.state !== "awaiting-decision") {
        throw new Error("awaiting-decision expected");
      }

      const id = waiting.next.checkpoints.decisionIds[0]!;
      const pending = decisions.values.get(id)!;
      decisions.values.set(id, Object.freeze({
        ...pending,
        status,
        version: 2,
        updatedAt: "2026-09-28T13:00:11.000Z"
      }));

      const result = await advanceAwaitingDecisionToAuthorized({
        run: waiting.next,
        ...built.stores,
        decisions,
        grants,
        now: () => new Date("2026-09-28T13:00:12.000Z")
      });
      expect(result.kind).toBe("advance");
      if (result.kind !== "advance") throw new Error("advance expected");
      expect(result.next.state).toBe("blocked");
      expect(grants.values.size).toBe(0);
    }
  });

  it("recovers a crash after authorized CAS but before the Decision resume outbox is marked processed", async () => {
    const built = buildPolicyEvaluated("email.send");
    const decisions = new DecisionStore();
    const grants = new GrantStore();
    const waiting = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:10.000Z")
    });
    if (waiting.kind !== "advance" || waiting.next.state !== "awaiting-decision") {
      throw new Error("awaiting-decision expected");
    }

    const id = waiting.next.checkpoints.decisionIds[0]!;
    const pending = decisions.values.get(id)!;
    const binding = pending.approvalBinding!;
    const proof = createApprovalProof({
      id: `approval-proof:${id}:v2`,
      decisionId: id,
      approvalId: `approval:${id}`,
      actorId: "owner-a",
      scope: waiting.next.scope,
      level: "approval",
      planHash: binding.planHash,
      stepHash: binding.stepHash,
      grantedAt: "2026-09-28T13:00:11.000Z",
      expiresAt: "2026-09-28T13:10:00.000Z"
    });
    const approved = Object.freeze({
      ...pending,
      status: "approved" as const,
      version: 2,
      updatedAt: "2026-09-28T13:00:11.000Z",
      approvalProof: proof
    });
    decisions.values.set(id, approved);

    const runStore = new RunStore(waiting.next);
    const queue = new ResumeQueue({
      id: `decision-resume:${id}:v2`,
      runId: waiting.next.id,
      decisionId: id,
      decisionVersion: 2,
      correlationId: waiting.next.correlationId,
      portfolioId: waiting.next.scope.portfolioId,
      companyId: waiting.next.scope.companyId,
      resolution: "approved",
      createdAt: "2026-09-28T13:00:11.000Z",
      requestHash: "a".repeat(64),
      status: "pending"
    });
    queue.failMarkOnce = true;

    const dispatcher = new DecisionResumeDispatcher({
      runStore,
      queue,
      ...built.stores,
      decisions,
      grants
    }, () => new Date("2026-09-28T13:00:12.000Z"));

    await expect(dispatcher.processDecision(approved))
      .rejects.toThrow(/simulated crash/i);
    expect(runStore.value.state).toBe("authorized");
    expect(queue.record.status).toBe("pending");

    const replay = await dispatcher.processDecision(approved);
    expect(replay).toMatchObject({
      outcome: "already-finished",
      state: "authorized",
      runId: waiting.next.id
    });
    expect(queue.record.status).toBe("processed");
    expect(grants.values.size).toBe(1);
  });

  it("rejects a tampered Decision binding and never mints a grant", async () => {
    const built = buildPolicyEvaluated("email.send");
    const decisions = new DecisionStore();
    const grants = new GrantStore();
    const waiting = await advancePolicyEvaluatedToAuthority({
      run: built.policyEvaluated,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:10.000Z")
    });
    if (waiting.kind !== "advance" || waiting.next.state !== "awaiting-decision") {
      throw new Error("awaiting-decision expected");
    }

    const id = waiting.next.checkpoints.decisionIds[0]!;
    const pending = decisions.values.get(id)!;
    decisions.values.set(id, {
      ...pending,
      status: "approved",
      version: 2,
      approvalBinding: {
        ...pending.approvalBinding!,
        stepHash: "0".repeat(64)
      },
      approvalProof: createApprovalProof({
        id: "forged-proof",
        decisionId: id,
        approvalId: `approval:${id}`,
        actorId: "owner-a",
        scope: waiting.next.scope,
        level: "approval",
        planHash: pending.approvalBinding!.planHash,
        stepHash: "0".repeat(64),
        grantedAt: "2026-09-28T13:00:11.000Z",
        expiresAt: "2026-09-28T13:10:00.000Z"
      }),
      updatedAt: "2026-09-28T13:00:11.000Z"
    };

    await expect(advanceAwaitingDecisionToAuthorized({
      run: waiting.next,
      ...built.stores,
      decisions,
      grants,
      now: () => new Date("2026-09-28T13:00:12.000Z")
    })).rejects.toThrow(/lineage|match exact/i);
    expect(grants.values.size).toBe(0);
  });
});
