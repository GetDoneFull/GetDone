import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizationGrantEnvelope,
  issueAuthorizationGrant,
  type AuthorizationGrant
} from "@/lib/authorization/grants";
import type { ApprovalProof, StepUpProof } from "@/lib/authorization/proofs";
import type { AuthoritativeDecision, OrchestrationApprovalBinding } from "@/lib/domain/decision-service";
import {
  isOrchestrationTerminal,
  transitionOrchestrationRun,
  type AuthorizationGrantRef,
  type OrchestrationRunRecord,
  type OrchestrationRunStore
} from "@/lib/orchestration/contracts";
import type { OrchestrationStageOutcome } from "@/lib/orchestration/worker-contracts";
import { orchestrationTransitionIdempotencyKey } from "@/lib/persistence/postgres/orchestration-store";
import {
  assertPersistedPlanProposal,
  type OrchestrationPlanProposalStore,
  type PersistedPlanProposal
} from "@/lib/orchestration/planning-flow";
import {
  assertDurablePolicyEvaluationArtifact,
  assertDurableValidationArtifact,
  type DurablePolicyEvaluationArtifact,
  type DurableStepPolicyRecord,
  type DurableValidationArtifact,
  type OrchestrationPolicyEvaluationStore,
  type OrchestrationValidationArtifactStore
} from "@/lib/orchestration/validation-policy-flow";
import {
  evaluateStepPolicy,
  type StepPolicyEvaluation
} from "@/lib/planning/policy-engine";
import type { PolicySnapshot } from "@/lib/planning/policy-snapshot";

export const ORCHESTRATION_AUTHORIZATION_FLOW_VERSION = "1.0.0";
export const DEFAULT_AUTHORIZATION_GRANT_TTL_MS = 5 * 60_000;

export interface OrchestrationDecisionStore {
  create(
    decision: AuthoritativeDecision
  ): Promise<{
    status: "created" | "idempotent-replay";
    decision: AuthoritativeDecision;
  }>;
  get(id: string): Promise<AuthoritativeDecision | null>;
}

export interface OrchestrationAuthorizationGrantStore {
  /**
   * Persist the complete Plan-step grant set atomically. A failed batch must
   * not leave a subset of active execution authority behind.
   */
  insertMany(
    grants: readonly AuthorizationGrant[],
    idempotencyKey: string
  ): Promise<void>;
  get(id: string): Promise<AuthorizationGrant | null>;
}


export interface OrchestrationDecisionResumeQueueRecord {
  id: string;
  runId: string;
  decisionId: string;
  decisionVersion: number;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  resolution: "approved" | "modified" | "rejected";
  createdAt: string;
  requestHash: string;
  status: "pending" | "processed";
  processedAt?: string;
}

export interface OrchestrationDecisionResumeQueue {
  getByDecisionVersion(
    decisionId: string,
    decisionVersion: number
  ): Promise<OrchestrationDecisionResumeQueueRecord | null>;
  listPending(limit: number): Promise<readonly OrchestrationDecisionResumeQueueRecord[]>;
  markProcessed(id: string, requestHash: string, processedAt: string): Promise<void>;
}

interface AuthorizationLineage {
  planArtifact: PersistedPlanProposal;
  validationArtifact: DurableValidationArtifact;
  policyArtifact: DurablePolicyEvaluationArtifact;
}

function minIso(values: readonly (string | undefined)[]) {
  const parsed = values
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value));
  if (parsed.length === 0 || parsed.some((value) => !Number.isFinite(value))) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Authorization evidence contains an invalid expiry"
    );
  }
  return new Date(Math.min(...parsed)).toISOString();
}

function policyEvidenceExpiry(
  snapshot: PolicySnapshot,
  validationExpiresAt: string
) {
  return minIso([
    validationExpiresAt,
    snapshot.credentialSnapshot?.expiresAt,
    snapshot.capacitySnapshot?.expiresAt,
    snapshot.budgetReservation?.expiresAt
  ]);
}

function authorizationGrantId(
  runId: string,
  policyArtifact: DurablePolicyEvaluationArtifact,
  stepId: string
) {
  return `authorization-grant:${runId}:pv${policyArtifact.validatedRunVersion}:${stepId}`;
}

export function authorizationGrantIdempotencyKey(
  runId: string,
  policyArtifact: DurablePolicyEvaluationArtifact,
  stepId: string
) {
  return `orchestration:${runId}:policy-v${policyArtifact.validatedRunVersion}:authorization:${stepId}`;
}


export function authorizationBatchIdempotencyKey(
  runId: string,
  policyArtifact: DurablePolicyEvaluationArtifact
) {
  return `orchestration:${runId}:policy-v${policyArtifact.validatedRunVersion}:authorization-batch`;
}

export function orchestrationDecisionId(
  runId: string,
  policyArtifact: DurablePolicyEvaluationArtifact,
  stepId: string
) {
  return `decision:${runId}:policy-v${policyArtifact.validatedRunVersion}:${stepId}`;
}

function approvalRequirement(
  stepPolicy: DurableStepPolicyRecord
): "approval" | "strong-approval" | null {
  if (stepPolicy.evaluation.disposition === "APPROVAL_REQUIRED") return "approval";
  if (stepPolicy.evaluation.disposition === "STRONG_APPROVAL") return "strong-approval";
  return null;
}

async function loadAuthorizationLineage(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  policies: OrchestrationPolicyEvaluationStore;
}): Promise<AuthorizationLineage> {
  const planRef = input.run.checkpoints.plan;
  const validationRef = input.run.checkpoints.validationReceipt;
  const policyRef = input.run.checkpoints.policySnapshot;
  if (!planRef || !validationRef || !policyRef) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Authorization stage requires Plan, validation, and policy checkpoints",
      { correlationId: input.run.correlationId }
    );
  }

  const planArtifact = await input.plans.get(planRef.id);
  if (!planArtifact) {
    throw new ControlPlaneError("FORBIDDEN", "Persisted Plan artifact is missing");
  }
  assertPersistedPlanProposal(planArtifact);

  const validationArtifact = await input.validations.get(validationRef.id);
  if (!validationArtifact) {
    throw new ControlPlaneError("FORBIDDEN", "Validation artifact is missing");
  }

  const policyArtifact = await input.policies.get(policyRef.id);
  if (!policyArtifact) {
    throw new ControlPlaneError("FORBIDDEN", "Policy evaluation artifact is missing");
  }

  if (
    planRef.hash !== planArtifact.planHash
    || validationRef.hash !== validationArtifact.receipt.receiptHash
    || policyRef.hash !== policyArtifact.artifactHash
    || planArtifact.runId !== input.run.id
    || planArtifact.portfolioId !== input.run.scope.portfolioId
    || planArtifact.companyId !== input.run.scope.companyId
    || validationArtifact.runId !== input.run.id
    || validationArtifact.portfolioId !== input.run.scope.portfolioId
    || validationArtifact.companyId !== input.run.scope.companyId
    || policyArtifact.runId !== input.run.id
    || policyArtifact.portfolioId !== input.run.scope.portfolioId
    || policyArtifact.companyId !== input.run.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorization lineage does not match orchestration tenant/checkpoints",
      { correlationId: input.run.correlationId }
    );
  }

  assertDurableValidationArtifact(validationArtifact, planArtifact);
  assertDurablePolicyEvaluationArtifact(
    policyArtifact,
    planArtifact,
    validationArtifact
  );

  return { planArtifact, validationArtifact, policyArtifact };
}

function decisionBinding(input: {
  run: OrchestrationRunRecord;
  lineage: AuthorizationLineage;
  stepPolicy: DurableStepPolicyRecord;
  requirement: "approval" | "strong-approval";
}): OrchestrationApprovalBinding {
  const expiresAt = policyEvidenceExpiry(
    input.stepPolicy.snapshot,
    input.lineage.validationArtifact.receipt.expiresAt
  );
  return Object.freeze({
    orchestrationRunId: input.run.id,
    trustedScope: { ...input.run.scope },
    policyEvaluationArtifactId: input.lineage.policyArtifact.id,
    policyEvaluationArtifactHash: input.lineage.policyArtifact.artifactHash,
    planArtifactId: input.lineage.planArtifact.id,
    planArtifactHash: input.lineage.planArtifact.artifactHash,
    planHash: input.lineage.planArtifact.planHash,
    stepId: input.stepPolicy.stepId,
    stepHash: input.stepPolicy.stepHash,
    policySnapshotId: input.stepPolicy.snapshot.id,
    policySnapshotHash: input.stepPolicy.snapshot.snapshotHash,
    validationReceiptId: input.lineage.validationArtifact.receipt.id,
    validationReceiptHash: input.lineage.validationArtifact.receipt.receiptHash,
    requirement: input.requirement,
    proofExpiresAt: expiresAt
  });
}

function createOrchestrationDecision(input: {
  run: OrchestrationRunRecord;
  lineage: AuthorizationLineage;
  stepPolicy: DurableStepPolicyRecord;
  requirement: "approval" | "strong-approval";
}): AuthoritativeDecision {
  const binding = decisionBinding(input);
  const decision: AuthoritativeDecision = {
    id: orchestrationDecisionId(
      input.run.id,
      input.lineage.policyArtifact,
      input.stepPolicy.stepId
    ),
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    status: "pending",
    version: 1,
    requiresStepUp: input.requirement === "strong-approval",
    updatedAt: input.lineage.policyArtifact.createdAt,
    approvalBinding: binding
  };
  return Object.freeze(decision);
}

function assertDecisionMatchesStep(input: {
  run: OrchestrationRunRecord;
  decision: AuthoritativeDecision;
  lineage: AuthorizationLineage;
  stepPolicy: DurableStepPolicyRecord;
  requirement: "approval" | "strong-approval";
}) {
  const expectedId = orchestrationDecisionId(
    input.run.id,
    input.lineage.policyArtifact,
    input.stepPolicy.stepId
  );
  const binding = input.decision.approvalBinding;
  if (
    input.decision.id !== expectedId
    || input.decision.correlationId !== input.run.correlationId
    || input.decision.portfolioId !== input.run.scope.portfolioId
    || input.decision.companyId !== input.run.scope.companyId
    || input.decision.requiresStepUp !== (input.requirement === "strong-approval")
    || !binding
    || binding.orchestrationRunId !== input.run.id
    || binding.trustedScope.userId !== input.run.scope.userId
    || binding.trustedScope.portfolioId !== input.run.scope.portfolioId
    || binding.trustedScope.companyId !== input.run.scope.companyId
    || binding.trustedScope.environment !== input.run.scope.environment
    || binding.trustedScope.resourceId !== input.run.scope.resourceId
    || binding.policyEvaluationArtifactId !== input.lineage.policyArtifact.id
    || binding.policyEvaluationArtifactHash !== input.lineage.policyArtifact.artifactHash
    || binding.planArtifactId !== input.lineage.planArtifact.id
    || binding.planArtifactHash !== input.lineage.planArtifact.artifactHash
    || binding.planHash !== input.lineage.planArtifact.planHash
    || binding.stepId !== input.stepPolicy.stepId
    || binding.stepHash !== input.stepPolicy.stepHash
    || binding.policySnapshotId !== input.stepPolicy.snapshot.id
    || binding.policySnapshotHash !== input.stepPolicy.snapshot.snapshotHash
    || binding.validationReceiptId !== input.lineage.validationArtifact.receipt.id
    || binding.validationReceiptHash !== input.lineage.validationArtifact.receipt.receiptHash
    || binding.requirement !== input.requirement
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Decision does not match exact policy/Plan authorization lineage",
      { correlationId: input.run.correlationId }
    );
  }
  return input.decision;
}

function evaluateSnapshotWithProof(input: {
  snapshot: PolicySnapshot;
  approvalProof?: ApprovalProof;
  stepUpProof?: StepUpProof;
  now: number;
}): StepPolicyEvaluation {
  const snapshot = input.snapshot;
  return evaluateStepPolicy({
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
    integrationId: snapshot.integrationId,
    resourceId: snapshot.resourceId,
    poolId: snapshot.poolId,
    providerId: snapshot.providerId,
    failureDomainId: snapshot.failureDomainId,
    workloadClass: snapshot.workloadClass,
    credentialRequirementIds: snapshot.credentialRequirementIds,
    credentialSnapshot: snapshot.credentialSnapshot,
    capacitySnapshot: snapshot.capacitySnapshot,
    capacityEvidenceRequired: snapshot.capacityEvidenceRequired,
    fallbackRequired: snapshot.fallbackRequired,
    fallbackAvailable: snapshot.fallbackAvailable,
    idempotencyKey: snapshot.idempotencyKey,
    killSwitches: snapshot.killSwitches,
    budget: snapshot.budget,
    budgetReservation: snapshot.budgetReservation,
    guardrails: snapshot.guardrails,
    approvalProof: input.approvalProof,
    stepUpProof: input.stepUpProof,
    now: input.now
  });
}

function grantTimeWindow(input: {
  stepPolicy: DurableStepPolicyRecord;
  validationExpiresAt: string;
  issuedAt: string;
  approvalProof?: ApprovalProof;
  stepUpProof?: StepUpProof;
  ttlMs: number;
}) {
  const issuedAtMs = Date.parse(input.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Grant issue time is invalid");
  }
  const ttlExpiry = new Date(issuedAtMs + input.ttlMs).toISOString();
  const expiresAt = minIso([
    ttlExpiry,
    policyEvidenceExpiry(input.stepPolicy.snapshot, input.validationExpiresAt),
    input.approvalProof?.expiresAt,
    input.stepUpProof?.expiresAt
  ]);
  if (Date.parse(expiresAt) <= issuedAtMs) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Authorization evidence expired before a grant could be issued"
    );
  }
  return expiresAt;
}

async function issueOrReplayGrants(input: {
  run: OrchestrationRunRecord;
  lineage: AuthorizationLineage;
  decisions?: ReadonlyMap<string, AuthoritativeDecision>;
  grants: OrchestrationAuthorizationGrantStore;
  now: Date;
  grantTtlMs: number;
}) {
  const candidates: AuthorizationGrant[] = [];

  for (const stepPolicy of input.lineage.policyArtifact.stepPolicies) {
    if (stepPolicy.evaluation.disposition === "BLOCKED") {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        "Blocked policy step cannot receive authorization"
      );
    }

    const requirement = approvalRequirement(stepPolicy);
    let approvalProof: ApprovalProof | undefined;
    let stepUpProof: StepUpProof | undefined;
    let actor: { type: "system" | "user"; id: string } = {
      type: "system",
      id: "getdone-policy"
    };
    let issuedAt = input.lineage.policyArtifact.createdAt;

    if (requirement) {
      const decisionId = orchestrationDecisionId(
        input.run.id,
        input.lineage.policyArtifact,
        stepPolicy.stepId
      );
      const decision = input.decisions?.get(decisionId);
      if (!decision) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Required approval Decision is missing"
        );
      }
      assertDecisionMatchesStep({
        run: input.run,
        decision,
        lineage: input.lineage,
        stepPolicy,
        requirement
      });
      if (decision.status !== "approved" || !decision.approvalProof) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Authorization requires an approved exact-hash Decision proof"
        );
      }
      approvalProof = decision.approvalProof;
      stepUpProof = decision.stepUpProof;
      actor = { type: "user", id: approvalProof.actorId };
      issuedAt = approvalProof.grantedAt;
    }

    const evaluation = evaluateSnapshotWithProof({
      snapshot: stepPolicy.snapshot,
      approvalProof,
      stepUpProof,
      now: Date.parse(issuedAt)
    });
    if (
      evaluation.disposition !== stepPolicy.evaluation.disposition
      || !evaluation.readyForTaskGeneration
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Exact approval evidence does not satisfy the frozen policy disposition"
      );
    }

    const grantId = authorizationGrantId(
      input.run.id,
      input.lineage.policyArtifact,
      stepPolicy.stepId
    );
    const expiresAt = grantTimeWindow({
      stepPolicy,
      validationExpiresAt: input.lineage.validationArtifact.receipt.expiresAt,
      issuedAt,
      approvalProof,
      stepUpProof,
      ttlMs: input.grantTtlMs
    });

    const candidate = issueAuthorizationGrant({
      id: grantId,
      plan: input.lineage.planArtifact.proposal,
      stepId: stepPolicy.stepId,
      receipt: input.lineage.validationArtifact.receipt,
      policySnapshot: stepPolicy.snapshot,
      policyEvaluation: evaluation,
      actor,
      scope: input.run.scope,
      approvalProof,
      stepUpProof,
      issuedAt,
      expiresAt
    });

    candidates.push(candidate);
  }

  // The full Plan-step authority set commits atomically. This prevents a
  // later-step persistence conflict from stranding a subset of active grants.
  await input.grants.insertMany(
    candidates,
    authorizationBatchIdempotencyKey(
      input.run.id,
      input.lineage.policyArtifact
    )
  );

  const refs: AuthorizationGrantRef[] = [];
  for (const candidate of candidates) {
    const persisted = await input.grants.get(candidate.id);
    if (!persisted || persisted.grantHash !== candidate.grantHash) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Authorization grant replay did not preserve exact hash-bound content"
      );
    }
    assertAuthorizationGrantEnvelope(
      persisted,
      input.run.scope,
      input.now.getTime()
    );
    refs.push(Object.freeze({
      id: persisted.id,
      hash: persisted.grantHash,
      disposition: persisted.disposition
    }));
  }

  return Object.freeze(refs);
}

export async function advancePolicyEvaluatedToAuthority(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  policies: OrchestrationPolicyEvaluationStore;
  decisions: OrchestrationDecisionStore;
  grants: OrchestrationAuthorizationGrantStore;
  now?: () => Date;
  grantTtlMs?: number;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "policy-evaluated") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Authority stage requires policy-evaluated orchestration state",
      { correlationId: input.run.correlationId }
    );
  }
  const now = input.now ?? (() => new Date());
  const lineage = await loadAuthorizationLineage(input);

  if (
    lineage.policyArtifact.aggregateDisposition === "BLOCKED"
    || lineage.policyArtifact.stepPolicies.some(
      (item) => item.evaluation.disposition === "BLOCKED"
    )
  ) {
    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "blocked",
        now: now().toISOString(),
        blockedReason: "Deterministic policy evaluation blocked one or more Plan steps"
      })
    };
  }

  const approvalSteps = lineage.policyArtifact.stepPolicies.filter(
    (item) => approvalRequirement(item) !== null
  );

  if (approvalSteps.length > 0) {
    const decisionIds: string[] = [];
    const resolvedDecisions = new Map<string, AuthoritativeDecision>();

    for (const stepPolicy of approvalSteps) {
      const requirement = approvalRequirement(stepPolicy)!;
      const decision = createOrchestrationDecision({
        run: input.run,
        lineage,
        stepPolicy,
        requirement
      });
      if (Date.parse(decision.approvalBinding!.proofExpiresAt) <= now().getTime()) {
        return {
          kind: "advance",
          next: transitionOrchestrationRun(input.run, {
            to: "blocked",
            now: now().toISOString(),
            blockedReason: "Policy/validation evidence expired before owner approval could be requested"
          })
        };
      }
      const persisted = await input.decisions.create(decision);
      assertDecisionMatchesStep({
        run: input.run,
        decision: persisted.decision,
        lineage,
        stepPolicy,
        requirement
      });
      decisionIds.push(persisted.decision.id);
      resolvedDecisions.set(persisted.decision.id, persisted.decision);
    }

    const decisionsInOrder = decisionIds.map((id) => resolvedDecisions.get(id)!);
    const rejected = decisionsInOrder.find((decision) => decision.status === "rejected");
    const modified = decisionsInOrder.find((decision) => decision.status === "modified");

    if (rejected || modified) {
      return {
        kind: "advance",
        next: transitionOrchestrationRun(input.run, {
          to: "blocked",
          now: now().toISOString(),
          checkpointPatch: { decisionIds },
          blockedReason: rejected
            ? "Owner rejected a required authorization Decision"
            : "Owner modified a required Decision; replanning is required before authorization"
        })
      };
    }

    if (decisionsInOrder.every((decision) => decision.status === "approved")) {
      try {
        const grantRefs = await issueOrReplayGrants({
          run: input.run,
          lineage,
          decisions: resolvedDecisions,
          grants: input.grants,
          now: now(),
          grantTtlMs: input.grantTtlMs ?? DEFAULT_AUTHORIZATION_GRANT_TTL_MS
        });
        return {
          kind: "advance",
          next: transitionOrchestrationRun(input.run, {
            to: "authorized",
            now: now().toISOString(),
            checkpointPatch: {
              decisionIds,
              authorizationGrants: grantRefs
            }
          })
        };
      } catch (error) {
        if (
          error instanceof ControlPlaneError
          && (error.code === "POLICY_BLOCKED" || error.code === "FORBIDDEN")
        ) {
          return {
            kind: "advance",
            next: transitionOrchestrationRun(input.run, {
              to: "blocked",
              now: now().toISOString(),
              checkpointPatch: { decisionIds },
              blockedReason:
                `Approval/authorization evidence is no longer valid: ${error.message}`
            })
          };
        }
        throw error;
      }
    }

    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "awaiting-decision",
        now: now().toISOString(),
        checkpointPatch: {
          decisionIds
        }
      })
    };
  }

  try {
    const grantRefs = await issueOrReplayGrants({
      run: input.run,
      lineage,
      grants: input.grants,
      now: now(),
      grantTtlMs: input.grantTtlMs ?? DEFAULT_AUTHORIZATION_GRANT_TTL_MS
    });
    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "authorized",
        now: now().toISOString(),
        checkpointPatch: {
          authorizationGrants: grantRefs
        }
      })
    };
  } catch (error) {
    if (
      error instanceof ControlPlaneError
      && (error.code === "POLICY_BLOCKED" || error.code === "FORBIDDEN")
    ) {
      return {
        kind: "advance",
        next: transitionOrchestrationRun(input.run, {
          to: "blocked",
          now: now().toISOString(),
          blockedReason: `Authorization could not be established: ${error.message}`
        })
      };
    }
    throw error;
  }
}

export async function advanceAwaitingDecisionToAuthorized(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  policies: OrchestrationPolicyEvaluationStore;
  decisions: OrchestrationDecisionStore;
  grants: OrchestrationAuthorizationGrantStore;
  now?: () => Date;
  grantTtlMs?: number;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "awaiting-decision") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Decision resume requires awaiting-decision orchestration state",
      { correlationId: input.run.correlationId }
    );
  }
  const now = input.now ?? (() => new Date());
  const lineage = await loadAuthorizationLineage(input);
  const approvalSteps = lineage.policyArtifact.stepPolicies.filter(
    (item) => approvalRequirement(item) !== null
  );
  const expectedIds = approvalSteps.map((item) =>
    orchestrationDecisionId(input.run.id, lineage.policyArtifact, item.stepId)
  );
  if (
    expectedIds.length !== input.run.checkpoints.decisionIds.length
    || expectedIds.some((id) => !input.run.checkpoints.decisionIds.includes(id))
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "awaiting-decision checkpoint does not match required policy Decisions"
    );
  }

  const resolved = new Map<string, AuthoritativeDecision>();
  for (const stepPolicy of approvalSteps) {
    const requirement = approvalRequirement(stepPolicy)!;
    const id = orchestrationDecisionId(
      input.run.id,
      lineage.policyArtifact,
      stepPolicy.stepId
    );
    const decision = await input.decisions.get(id);
    if (!decision) {
      throw new ControlPlaneError("FORBIDDEN", "Required Decision disappeared");
    }
    assertDecisionMatchesStep({
      run: input.run,
      decision,
      lineage,
      stepPolicy,
      requirement
    });
    if (decision.status === "rejected" || decision.status === "modified") {
      return {
        kind: "advance",
        next: transitionOrchestrationRun(input.run, {
          to: "blocked",
          now: now().toISOString(),
          blockedReason:
            decision.status === "rejected"
              ? "Owner rejected a required authorization Decision"
              : "Owner modified a required Decision; replanning is required before authorization"
        })
      };
    }
    if (decision.status === "pending") {
      return {
        kind: "defer",
        delayMs: 30_000,
        reason: "Waiting for all required owner Decisions"
      };
    }
    if (!decision.approvalProof) {
      return {
        kind: "advance",
        next: transitionOrchestrationRun(input.run, {
          to: "blocked",
          now: now().toISOString(),
          blockedReason: "Approved Decision is missing exact-hash approval proof"
        })
      };
    }
    resolved.set(id, decision);
  }

  try {
    const grantRefs = await issueOrReplayGrants({
      run: input.run,
      lineage,
      decisions: resolved,
      grants: input.grants,
      now: now(),
      grantTtlMs: input.grantTtlMs ?? DEFAULT_AUTHORIZATION_GRANT_TTL_MS
    });
    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "authorized",
        now: now().toISOString(),
        checkpointPatch: {
          authorizationGrants: grantRefs
        }
      })
    };
  } catch (error) {
    if (
      error instanceof ControlPlaneError
      && (error.code === "POLICY_BLOCKED" || error.code === "FORBIDDEN")
    ) {
      return {
        kind: "advance",
        next: transitionOrchestrationRun(input.run, {
          to: "blocked",
          now: now().toISOString(),
          blockedReason: `Approval/authorization evidence is no longer valid: ${error.message}`
        })
      };
    }
    throw error;
  }
}


export type DecisionResumeDispatchResult =
  | { outcome: "advanced"; state: string; runId: string }
  | { outcome: "waiting"; state: "awaiting-decision"; runId: string }
  | { outcome: "not-ready"; state: string; runId: string }
  | { outcome: "already-finished"; state: string; runId: string };

export class DecisionResumeDispatcher {
  constructor(
    private readonly deps: {
      runStore: OrchestrationRunStore;
      queue: OrchestrationDecisionResumeQueue;
      plans: OrchestrationPlanProposalStore;
      validations: OrchestrationValidationArtifactStore;
      policies: OrchestrationPolicyEvaluationStore;
      decisions: OrchestrationDecisionStore;
      grants: OrchestrationAuthorizationGrantStore;
      grantTtlMs?: number;
    },
    private readonly now: () => Date = () => new Date()
  ) {}

  async processDecision(
    decision: AuthoritativeDecision
  ): Promise<DecisionResumeDispatchResult | null> {
    const request = await this.deps.queue.getByDecisionVersion(
      decision.id,
      decision.version
    );
    if (!request || request.status === "processed") return null;
    return this.processRequest(request);
  }

  async drain(limit = 25) {
    const pending = await this.deps.queue.listPending(limit);
    const results: DecisionResumeDispatchResult[] = [];
    for (const request of pending) {
      results.push(await this.processRequest(request));
    }
    return Object.freeze(results);
  }

  private async processRequest(
    request: OrchestrationDecisionResumeQueueRecord
  ): Promise<DecisionResumeDispatchResult> {
    const run = await this.deps.runStore.get(request.runId);
    if (!run) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Decision resume request references a missing orchestration run",
        { correlationId: request.correlationId }
      );
    }
    if (
      run.scope.portfolioId !== request.portfolioId
      || run.scope.companyId !== request.companyId
      || run.correlationId !== request.correlationId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Decision resume request is outside orchestration tenant/correlation lineage",
        { correlationId: request.correlationId }
      );
    }

    // A Decision can be resolved in the narrow window after its durable create
    // but before policy-evaluated -> awaiting-decision CAS. The Decision IDs
    // are not yet present in the run checkpoint, so leave the outbox pending.
    // The scoped resume pump will retry after the CAS.
    if (run.state === "policy-evaluated") {
      return {
        outcome: "not-ready",
        state: run.state,
        runId: run.id
      };
    }

    if (!run.checkpoints.decisionIds.includes(request.decisionId)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Decision resume request is not referenced by orchestration checkpoints",
        { correlationId: request.correlationId }
      );
    }

    if (run.state !== "awaiting-decision") {
      if (
        isOrchestrationTerminal(run.state)
        || [
          "authorized",
          "tasks-created",
          "jobs-enqueued",
          "executing",
          "verifying",
          "completed"
        ].includes(run.state)
      ) {
        await this.deps.queue.markProcessed(
          request.id,
          request.requestHash,
          this.now().toISOString()
        );
        return {
          outcome: "already-finished",
          state: run.state,
          runId: run.id
        };
      }

      return {
        outcome: "not-ready",
        state: run.state,
        runId: run.id
      };
    }

    const outcome = await advanceAwaitingDecisionToAuthorized({
      run,
      plans: this.deps.plans,
      validations: this.deps.validations,
      policies: this.deps.policies,
      decisions: this.deps.decisions,
      grants: this.deps.grants,
      now: this.now,
      grantTtlMs: this.deps.grantTtlMs
    });

    if (outcome.kind === "defer") {
      await this.deps.queue.markProcessed(
        request.id,
        request.requestHash,
        this.now().toISOString()
      );
      return {
        outcome: "waiting",
        state: "awaiting-decision",
        runId: run.id
      };
    }

    if (outcome.kind !== "advance") {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Decision resume authorization did not produce a deterministic advance"
      );
    }

    try {
      const persisted = await this.deps.runStore.compareAndSwap(outcome.next, {
        expectedVersion: run.version,
        expectedRecordHash: run.recordHash,
        idempotencyKey: orchestrationTransitionIdempotencyKey(
          run,
          outcome.next.state
        )
      });
      await this.deps.queue.markProcessed(
        request.id,
        request.requestHash,
        this.now().toISOString()
      );
      return {
        outcome: "advanced",
        state: persisted.state,
        runId: persisted.id
      };
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === "CONFLICT") {
        const current = await this.deps.runStore.get(run.id);
        if (
          current
          && current.version > run.version
          && (
            current.state === "authorized"
            || current.state === "blocked"
            || isOrchestrationTerminal(current.state)
          )
        ) {
          await this.deps.queue.markProcessed(
            request.id,
            request.requestHash,
            this.now().toISOString()
          );
          return {
            outcome: "already-finished",
            state: current.state,
            runId: current.id
          };
        }
      }
      throw error;
    }
  }
}
