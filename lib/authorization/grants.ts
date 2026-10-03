import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  assertTrustedExecutionScopeEqual,
  type TrustedExecutionScope
} from "@/lib/control-plane/trusted-execution-scope";
import type { TrustedActor } from "@/lib/control-plane/request-context";
import {
  assertApprovalProof,
  type ApprovalProof,
  type StepUpProof
} from "@/lib/authorization/proofs";
import {
  POLICY_ENGINE_VERSION,
  POLICY_RULES_HASH,
  type StepPolicyEvaluation
} from "@/lib/planning/policy-engine";
import {
  CAPABILITY_REGISTRY_HASH,
  CAPABILITY_REGISTRY_VERSION,
  requireEnabledCapability
} from "@/lib/domain/capabilities";
import {
  CURRENT_POLICY_REGISTRY_HASH,
  CURRENT_POLICY_VERSION
} from "@/lib/domain/policy-registry";
import type { PolicySnapshot } from "@/lib/planning/policy-snapshot";
import { assertPolicySnapshotIntegrity } from "@/lib/planning/policy-snapshot";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import {
  assertValidationReceipt,
  type PlanValidationReceipt
} from "@/lib/planning/validation-receipt";

export type AuthorizationGrantDisposition =
  | "AUTO"
  | "APPROVAL_REQUIRED"
  | "STRONG_APPROVAL";

export type AuthorizationGrantStatus = "active" | "consumed" | "revoked";
export type AuthorizationConsumerType = "task" | "job";

export interface AuthorizationGrant {
  id: string;
  status: AuthorizationGrantStatus;
  disposition: AuthorizationGrantDisposition;
  scope: TrustedExecutionScope;
  planId: string;
  planVersion: number;
  planHash: string;
  stepId: string;
  stepHash: string;
  capabilityNames: readonly string[];
  objectiveId?: string;
  integrationId?: string;
  executionLimits?: Readonly<{
    environment: TrustedExecutionScope["environment"];
    deadline?: string;
    expectedDurationSeconds?: number;
    retryable: boolean;
    maxJobCostCents?: number;
  }>;
  validationReceiptId: string;
  validationReceiptHash: string;
  policySnapshotId: string;
  policySnapshotHash: string;
  policyVersion: string;
  policyRegistryHash?: string;
  policyEngineVersion: string;
  policyRulesHash: string;
  capabilityRegistryVersion?: string;
  capabilityRegistryHash?: string;
  decisionId?: string;
  approvalProofId?: string;
  approvalProofHash?: string;
  stepUpProofId?: string;
  stepUpProofHash?: string;
  actor: TrustedActor;
  issuedAt: string;
  expiresAt: string;
  grantHash: string;
}

export interface AuthorizationConsumptionRecord {
  id: string;
  grantId: string;
  grantHash: string;
  consumerType: AuthorizationConsumerType;
  consumerId: string;
  scope: TrustedExecutionScope;
  planHash: string;
  stepHash: string;
  consumedAt: string;
  consumptionHash: string;
}

export interface AuthorizationGrantStore {
  get(id: string): Promise<AuthorizationGrant | null>;
  /**
   * Durable implementations MUST enforce a unique consumption id per grant
   * so the same grant cannot authorize two different Task/Job consumers.
   */
  consume(record: AuthorizationConsumptionRecord): Promise<void>;
  listConsumptions(grantId: string): Promise<readonly AuthorizationConsumptionRecord[]>;
  revoke(id: string, reason: string, revokedAt: string): Promise<void>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function stepFor(plan: PlanProposal, stepId: string) {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new ControlPlaneError("NOT_FOUND", "Plan step was not found");
  return step;
}

function sameCapabilities(left: readonly string[], right: readonly string[]) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function assertScopeMatchesPlan(scope: TrustedExecutionScope, plan: PlanProposal) {
  if (
    scope.portfolioId !== plan.scope.portfolioId
    || scope.companyId !== plan.scope.companyId
    || scope.environment !== plan.scope.environment
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorization scope does not match the plan scope"
    );
  }
}

export function issueAuthorizationGrant(input: {
  id: string;
  plan: PlanProposal;
  stepId: string;
  receipt: PlanValidationReceipt;
  policySnapshot: PolicySnapshot;
  policyEvaluation: StepPolicyEvaluation;
  actor: TrustedActor;
  scope: TrustedExecutionScope;
  approvalProof?: ApprovalProof;
  stepUpProof?: StepUpProof;
  issuedAt: string;
  expiresAt: string;
}): AuthorizationGrant {
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Authorization grant expiry must follow issue time"
    );
  }

  assertValidationReceipt(input.receipt, input.plan, issuedAt);
  assertPolicySnapshotIntegrity(input.policySnapshot);
  assertScopeMatchesPlan(input.scope, input.plan);

  const step = stepFor(input.plan, input.stepId);
  const planHash = hashPlan(input.plan);
  const stepHash = hashPlanStep(step);

  assertTrustedExecutionScopeEqual(input.scope, input.policySnapshot.scope, {
    requireSameResource: Boolean(input.scope.resourceId || input.policySnapshot.scope.resourceId)
  });

  if (
    input.policySnapshot.planHash !== planHash
    || input.policySnapshot.stepHash !== stepHash
    || !sameCapabilities(
      input.policySnapshot.capabilityNames,
      step.capabilityRequests.map((request) => request.capability)
    )
    || input.policySnapshot.policyVersion !== input.receipt.snapshot.policyVersion
    || input.policyEvaluation.policyEngineVersion !== input.policySnapshot.policyEngineVersion
    || input.policyEvaluation.policyRulesHash !== input.policySnapshot.policyRulesHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Policy snapshot/evaluation does not match the validated plan step"
    );
  }

  if (
    input.policyEvaluation.disposition === "BLOCKED"
    || !input.policyEvaluation.readyForTaskGeneration
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Policy evaluation does not authorize task generation"
    );
  }

  if (input.policyEvaluation.disposition !== "AUTO") {
    if (!input.approvalProof) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Approval proof is required to issue this grant"
      );
    }

    assertApprovalProof(input.approvalProof, {
      scope: input.scope,
      planHash,
      stepHash,
      requiredLevel:
        input.policyEvaluation.disposition === "STRONG_APPROVAL"
          ? "strong-approval"
          : "approval",
      now: issuedAt,
      stepUpProof: input.stepUpProof
    });

    if (Date.parse(input.approvalProof.expiresAt) < expiresAt) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Authorization grant cannot outlive its approval proof"
      );
    }

    if (input.stepUpProof && Date.parse(input.stepUpProof.expiresAt) < expiresAt) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Authorization grant cannot outlive its step-up proof"
      );
    }
  }

  const base = {
    id: input.id,
    status: "active" as const,
    disposition: input.policyEvaluation.disposition as AuthorizationGrantDisposition,
    scope: { ...input.scope },
    planId: input.plan.id,
    planVersion: input.plan.proposalVersion,
    planHash,
    stepId: input.stepId,
    stepHash,
    capabilityNames: [
      ...new Set(step.capabilityRequests.map((request) => request.capability))
    ].sort(),
    objectiveId: input.plan.source.type === "objective"
      ? input.plan.source.objectiveId
      : undefined,
    integrationId: input.policySnapshot.integrationId,
    executionLimits: {
      environment: step.resourceRequirements.execution.environment,
      deadline: step.resourceRequirements.execution.deadline,
      expectedDurationSeconds:
        step.resourceRequirements.execution.expectedDurationSeconds,
      retryable: step.resourceRequirements.execution.retryable,
      maxJobCostCents: step.resourceRequirements.economics.maxJobCostCents
    },
    validationReceiptId: input.receipt.id,
    validationReceiptHash: input.receipt.receiptHash,
    policySnapshotId: input.policySnapshot.id,
    policySnapshotHash: input.policySnapshot.snapshotHash,
    policyVersion: input.policySnapshot.policyVersion,
    policyRegistryHash: input.policySnapshot.policyRegistryHash,
    policyEngineVersion: input.policySnapshot.policyEngineVersion,
    policyRulesHash: input.policySnapshot.policyRulesHash,
    capabilityRegistryVersion: input.policySnapshot.capabilityRegistryVersion,
    capabilityRegistryHash: input.policySnapshot.capabilityRegistryHash,
    decisionId: input.approvalProof?.decisionId,
    approvalProofId: input.approvalProof?.id,
    approvalProofHash: input.approvalProof?.proofHash,
    stepUpProofId: input.stepUpProof?.id,
    stepUpProofHash: input.stepUpProof?.proofHash,
    actor: { ...input.actor },
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt
  };

  return deepFreeze({
    ...base,
    grantHash: sha256Hex(base)
  });
}

export function assertAuthorizationGrantEnvelope(
  grant: AuthorizationGrant,
  scope: TrustedExecutionScope,
  now = Date.now()
) {
  const { grantHash, ...base } = grant;
  if (sha256Hex(base) !== grantHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorization grant integrity check failed"
    );
  }

  if (grant.status !== "active") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorization grant is not active"
    );
  }

  if (
    grant.disposition !== "AUTO"
    && (
      !grant.decisionId
      || !grant.approvalProofId
      || !grant.approvalProofHash
    )
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Approval-backed authorization grant is missing immutable Decision proof lineage"
    );
  }

  if (
    grant.disposition === "STRONG_APPROVAL"
    && (!grant.stepUpProofId || !grant.stepUpProofHash)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Strong approval authorization grant is missing step-up proof lineage"
    );
  }

  assertTrustedExecutionScopeEqual(scope, grant.scope, {
    requireSameResource: Boolean(scope.resourceId || grant.scope.resourceId)
  });

  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt > now
    || expiresAt <= now
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorization grant is not currently valid"
    );
  }

  if (
    grant.policyVersion !== CURRENT_POLICY_VERSION
    || grant.policyRegistryHash !== CURRENT_POLICY_REGISTRY_HASH
    || grant.policyEngineVersion !== POLICY_ENGINE_VERSION
    || grant.policyRulesHash !== POLICY_RULES_HASH
    || grant.capabilityRegistryVersion !== CAPABILITY_REGISTRY_VERSION
    || grant.capabilityRegistryHash !== CAPABILITY_REGISTRY_HASH
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Authorization grant references stale or materially changed policy"
    );
  }

  for (const capabilityName of grant.capabilityNames) {
    requireEnabledCapability(capabilityName);
  }

  return grant;
}

export function assertAuthorizationGrant(input: {
  grant: AuthorizationGrant;
  plan: PlanProposal;
  stepId: string;
  receipt: PlanValidationReceipt;
  scope: TrustedExecutionScope;
  now?: number;
}) {
  assertAuthorizationGrantEnvelope(
    input.grant,
    input.scope,
    input.now ?? Date.now()
  );

  assertValidationReceipt(input.receipt, input.plan, input.now);
  assertScopeMatchesPlan(input.grant.scope, input.plan);
  assertScopeMatchesPlan(input.scope, input.plan);

  const step = stepFor(input.plan, input.stepId);
  if (
    input.grant.planId !== input.plan.id
    || input.grant.planVersion !== input.plan.proposalVersion
    || input.grant.planHash !== hashPlan(input.plan)
    || input.grant.stepId !== step.id
    || input.grant.stepHash !== hashPlanStep(step)
    || input.grant.validationReceiptId !== input.receipt.id
    || input.grant.validationReceiptHash !== input.receipt.receiptHash
    || input.grant.policyVersion !== input.receipt.snapshot.policyVersion
    || !sameCapabilities(
      input.grant.capabilityNames,
      step.capabilityRequests.map((request) => request.capability)
    )
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorization grant does not match the current plan/step/receipt"
    );
  }

  return input.grant;
}

export function createAuthorizationConsumptionRecord(input: {
  id: string;
  grant: AuthorizationGrant;
  consumerType: AuthorizationConsumerType;
  consumerId: string;
  consumedAt: string;
}): AuthorizationConsumptionRecord {
  const expectedId = `authorization-consumption:${input.grant.id}`;
  if (input.id !== expectedId) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Authorization consumption id must be derived from the grant id"
    );
  }

  const consumedAt = Date.parse(input.consumedAt);
  if (!Number.isFinite(consumedAt)) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Authorization consumption time is invalid"
    );
  }

  if (
    consumedAt < Date.parse(input.grant.issuedAt)
    || consumedAt >= Date.parse(input.grant.expiresAt)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorization cannot be consumed outside its validity window"
    );
  }

  const base = {
    id: input.id,
    grantId: input.grant.id,
    grantHash: input.grant.grantHash,
    consumerType: input.consumerType,
    consumerId: input.consumerId,
    scope: { ...input.grant.scope },
    planHash: input.grant.planHash,
    stepHash: input.grant.stepHash,
    consumedAt: input.consumedAt
  };

  return deepFreeze({
    ...base,
    consumptionHash: sha256Hex(base)
  });
}

export function assertAuthorizationConsumption(
  record: AuthorizationConsumptionRecord,
  grant: AuthorizationGrant
) {
  const { consumptionHash, ...base } = record;
  if (
    sha256Hex(base) !== consumptionHash
    || record.grantId !== grant.id
    || record.grantHash !== grant.grantHash
    || record.planHash !== grant.planHash
    || record.stepHash !== grant.stepHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorization consumption record does not match its grant"
    );
  }

  assertTrustedExecutionScopeEqual(record.scope, grant.scope, {
    requireSameResource: Boolean(record.scope.resourceId || grant.scope.resourceId)
  });

  return record;
}
