import type { GetDoneEnvironment } from "@/lib/control-plane/request-context";
import {
  matchesConfirmedPreferenceRule,
  type ConfirmedPreferenceRule
} from "@/lib/domain/preference-learning";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { getCapability, type CapabilityDefinition } from "@/lib/domain/capabilities";
import { blockingKillSwitches, type KillSwitch } from "@/lib/domain/kill-switch";
import {
  evaluateBudget,
  evaluateGuardrails,
  evaluateUsageBudget,
  type BudgetPolicy,
  type Guardrail,
  type UsageBudgetPolicy
} from "@/lib/domain/objectives";
import {
  evaluateCredentialAvailability,
  type CredentialAvailabilitySnapshot
} from "@/lib/domain/credential-binding";
import {
  assertBudgetReservation,
  type BudgetReservation
} from "@/lib/domain/budget-reservation";
import {
  assertProtectedCapacitySnapshot,
  type ProtectedCapacitySnapshot
} from "@/lib/domain/protected-capacity";
import {
  assertApprovalProof,
  type ApprovalProof,
  type StepUpProof
} from "@/lib/authorization/proofs";

export type PolicyDisposition =
  | "AUTO"
  | "APPROVAL_REQUIRED"
  | "STRONG_APPROVAL"
  | "BLOCKED";

export const POLICY_ENGINE_VERSION = "2026-09-28.2";
export const POLICY_PRECEDENCE: readonly PolicyDisposition[] = Object.freeze([
  "AUTO",
  "APPROVAL_REQUIRED",
  "STRONG_APPROVAL",
  "BLOCKED"
]);
export const POLICY_RULES_HASH = sha256Hex({
  version: POLICY_ENGINE_VERSION,
  precedence: POLICY_PRECEDENCE,
  rules: [
    "identity-and-scope",
    "capability-approval",
    "runtime-risk-context",
    "environment-data-region",
    "credential-snapshot",
    "protected-capacity-snapshot",
    "fallback",
    "idempotency",
    "all-kill-switch-scopes",
    "hierarchical-monetary-budgets",
    "usage-budgets",
    "budget-reservation",
    "guardrails",
    "approval-proof",
    "strong-step-up-proof",
    "confirmed-preference-rule"
  ]
});

export interface PolicyMonetaryBudgetInput {
  policy: BudgetPolicy;
  currentSpendCents: number;
  reservedCents?: number;
  requestedCostCents: number;
}

export interface PolicyUsageBudgetInput {
  policy: UsageBudgetPolicy;
  currentUsage: number;
  reservedUsage?: number;
  requestedUsage: number;
}

export interface PolicyRiskContext {
  monetaryAmountCents?: number;
  autoMonetaryLimitCents?: number;
  customerImpact?: "none" | "internal" | "customer" | "broad-customer";
  publicVisibility?: boolean;
  confidence?: number;
  novelty?: number;
  previousApprovedPolicy?: boolean;
  executionFrequency?: number;
  autoFrequencyLimit?: number;
  budgetConsumptionRatio?: number;
  ownerInstruction?:
    | "allow-auto"
    | "require-approval"
    | "require-strong-approval"
    | "block";
}

export interface PolicyEvaluationInput {
  authenticated: boolean;
  scopeResolved: boolean;
  trustedScope: TrustedExecutionScope;
  capability: string;
  planHash: string;
  stepHash: string;
  environment: GetDoneEnvironment;
  dataClass: "public" | "internal" | "customer" | "sensitive";
  region?: string;
  allowedEnvironments: readonly GetDoneEnvironment[];
  allowedDataClasses: readonly ("public" | "internal" | "customer" | "sensitive")[];
  allowedRegions?: readonly string[];

  integrationId?: string;
  resourceId?: string;
  poolId?: string;
  providerId?: string;
  failureDomainId?: string;
  workloadClass?: string;
  objectiveId?: string;
  jobId?: string;

  credentialRequirementIds: readonly string[];
  credentialSnapshot?: CredentialAvailabilitySnapshot;
  capacitySnapshot?: ProtectedCapacitySnapshot;
  capacityEvidenceRequired?: boolean;

  fallbackRequired: boolean;
  fallbackAvailable: boolean;

  idempotencyKey?: string;
  killSwitches: readonly KillSwitch[];

  /** @deprecated Prefer budgets for hierarchical budget evaluation. */
  budget?: PolicyMonetaryBudgetInput;
  budgets?: readonly PolicyMonetaryBudgetInput[];
  /** @deprecated Prefer budgetReservations for hierarchical budget evaluation. */
  budgetReservation?: BudgetReservation;
  budgetReservations?: readonly BudgetReservation[];
  usageBudgets?: readonly PolicyUsageBudgetInput[];
  riskContext?: PolicyRiskContext;
  confirmedPreferenceRule?: ConfirmedPreferenceRule;

  guardrails?: {
    scopeId?: string;
    policies: readonly Guardrail[];
    metrics: Readonly<Record<string, number | string | boolean | undefined>>;
  };

  approvalProof?: ApprovalProof;
  stepUpProof?: StepUpProof;
  now?: number;
}

export interface PolicyReason {
  code:
    | "UNAUTHENTICATED"
    | "UNRESOLVED_SCOPE"
    | "UNKNOWN_CAPABILITY"
    | "CAPABILITY_BLOCKED"
    | "ENVIRONMENT_BLOCKED"
    | "DATA_CLASS_BLOCKED"
    | "REGION_BLOCKED"
    | "CREDENTIAL_MISSING"
    | "CREDENTIAL_SNAPSHOT_INVALID"
    | "HEADROOM_BLOCKED"
    | "CAPACITY_REQUIRED"
    | "CAPACITY_SNAPSHOT_INVALID"
    | "FALLBACK_MISSING"
    | "IDEMPOTENCY_MISSING"
    | "KILL_SWITCH"
    | "BUDGET_BLOCKED"
    | "BUDGET_APPROVAL"
    | "BUDGET_INVALID"
    | "USAGE_BUDGET_BLOCKED"
    | "USAGE_BUDGET_APPROVAL"
    | "USAGE_BUDGET_INVALID"
    | "RISK_APPROVAL"
    | "RISK_STRONG_APPROVAL"
    | "OWNER_POLICY_BLOCKED"
    | "BUDGET_RESERVATION_MISSING"
    | "BUDGET_RESERVATION_INVALID"
    | "GUARDRAIL_BLOCKED"
    | "GUARDRAIL_APPROVAL"
    | "CAPABILITY_APPROVAL"
    | "CAPABILITY_STRONG_APPROVAL"
    | "APPROVAL_PROOF_INVALID"
    | "STEP_UP_PROOF_INVALID"
    | "CONFIRMED_PREFERENCE_AUTO";
  message: string;
}

export interface PolicyEvaluation {
  disposition: PolicyDisposition;
  reasons: readonly PolicyReason[];
  capability?: CapabilityDefinition;
  policyEngineVersion: string;
  policyRulesHash: string;
  requiresFreshStepUp: boolean;
  approvalSatisfied: boolean;
  readyForTaskGeneration: boolean;
}

export interface StepPolicyEvaluation {
  disposition: PolicyDisposition;
  reasons: readonly PolicyReason[];
  capabilityEvaluations: Readonly<Record<string, PolicyEvaluation>>;
  policyEngineVersion: string;
  policyRulesHash: string;
  requiresFreshStepUp: boolean;
  approvalSatisfied: boolean;
  readyForTaskGeneration: boolean;
}

const dispositionRank: Record<PolicyDisposition, number> = {
  AUTO: 0,
  APPROVAL_REQUIRED: 1,
  STRONG_APPROVAL: 2,
  BLOCKED: 3
};

export function strongestDisposition(
  left: PolicyDisposition,
  right: PolicyDisposition
): PolicyDisposition {
  return dispositionRank[right] > dispositionRank[left] ? right : left;
}

function capabilityDisposition(capability: CapabilityDefinition): PolicyDisposition {
  if (capability.approval === "blocked") return "BLOCKED";
  if (capability.approval === "strong-approval") return "STRONG_APPROVAL";
  if (capability.approval === "approval") return "APPROVAL_REQUIRED";
  return "AUTO";
}

function proofSatisfied(
  disposition: PolicyDisposition,
  input: PolicyEvaluationInput,
  reasons: PolicyReason[]
) {
  if (disposition === "AUTO") return true;
  if (disposition === "BLOCKED") return false;

  if (!input.approvalProof) {
    reasons.push({
      code: "APPROVAL_PROOF_INVALID",
      message: "A matching approval proof is required"
    });
    return false;
  }

  try {
    assertApprovalProof(input.approvalProof, {
      scope: input.trustedScope,
      planHash: input.planHash,
      stepHash: input.stepHash,
      requiredLevel: disposition === "STRONG_APPROVAL" ? "strong-approval" : "approval",
      now: input.now,
      stepUpProof: input.stepUpProof
    });
  } catch {
    reasons.push({
      code: disposition === "STRONG_APPROVAL" && !input.stepUpProof
        ? "STEP_UP_PROOF_INVALID"
        : "APPROVAL_PROOF_INVALID",
      message: disposition === "STRONG_APPROVAL"
        ? "Strong approval requires matching fresh approval and step-up proofs"
        : "Approval proof is missing, expired, tampered, or does not match this plan step"
    });
    return false;
  }

  return true;
}

function resolvedBudgetScopeId(
  scopeType: BudgetPolicy["scopeType"] | UsageBudgetPolicy["scopeType"],
  input: PolicyEvaluationInput
) {
  if (!scopeType) return undefined;

  switch (scopeType) {
    case "portfolio":
      return input.trustedScope.portfolioId;
    case "company":
      return input.trustedScope.companyId;
    case "integration":
      return input.integrationId;
    case "capability":
      return input.capability;
    case "objective":
      return input.objectiveId;
    case "job":
      return input.jobId;
  }
}

function applicableBudgetScopeId(
  policy: Pick<BudgetPolicy | UsageBudgetPolicy, "scopeType" | "scopeId">,
  input: PolicyEvaluationInput
) {
  if (!policy.scopeType) return policy.scopeId;
  const resolved = resolvedBudgetScopeId(policy.scopeType, input);
  if (!resolved) {
    throw new Error(`Budget scope context is missing for ${policy.scopeType}`);
  }
  return resolved === policy.scopeId ? resolved : null;
}

function uniqueMonetaryBudgets(input: PolicyEvaluationInput) {
  const budgets = [...(input.budgets ?? [])];
  if (input.budget && !budgets.some((candidate) => candidate.policy.id === input.budget!.policy.id)) {
    budgets.push(input.budget);
  }
  return budgets.sort((left, right) => left.policy.id.localeCompare(right.policy.id));
}

function budgetReservations(input: PolicyEvaluationInput) {
  const reservations = [...(input.budgetReservations ?? [])];
  if (
    input.budgetReservation
    && !reservations.some((candidate) => candidate.id === input.budgetReservation!.id)
  ) {
    reservations.push(input.budgetReservation);
  }
  return reservations;
}

function validNonNegativeNumber(value: number | undefined) {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}

function validUnitInterval(value: number | undefined) {
  return value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1);
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const reasons: PolicyReason[] = [];
  let disposition: PolicyDisposition = "AUTO";
  const now = input.now ?? Date.now();

  const block = (code: PolicyReason["code"], message: string) => {
    disposition = "BLOCKED";
    reasons.push({ code, message });
  };

  if (!input.authenticated) block("UNAUTHENTICATED", "Authenticated actor/system identity is required");
  if (!input.scopeResolved) block("UNRESOLVED_SCOPE", "Trusted portfolio/company scope must be resolved server-side");

  const capability = getCapability(input.capability);
  if (!capability || !capability.enabled) {
    block("UNKNOWN_CAPABILITY", `Capability is unavailable: ${input.capability}`);
  } else {
    const required = capabilityDisposition(capability);
    disposition = strongestDisposition(disposition, required);
    if (required === "BLOCKED") {
      reasons.push({ code: "CAPABILITY_BLOCKED", message: "Capability policy is explicitly blocked" });
    } else if (required === "STRONG_APPROVAL") {
      reasons.push({ code: "CAPABILITY_STRONG_APPROVAL", message: "Capability requires strong approval" });
    } else if (required === "APPROVAL_REQUIRED") {
      reasons.push({ code: "CAPABILITY_APPROVAL", message: "Capability requires approval" });
    }
  }

  const risk = input.riskContext;
  if (risk) {
    if (
      !validUnitInterval(risk.confidence)
      || !validUnitInterval(risk.novelty)
      || !validNonNegativeNumber(risk.budgetConsumptionRatio)
      || (risk.monetaryAmountCents !== undefined
        && (!Number.isInteger(risk.monetaryAmountCents) || risk.monetaryAmountCents < 0))
      || (risk.autoMonetaryLimitCents !== undefined
        && (!Number.isInteger(risk.autoMonetaryLimitCents) || risk.autoMonetaryLimitCents < 0))
      || (risk.executionFrequency !== undefined
        && (!Number.isInteger(risk.executionFrequency) || risk.executionFrequency < 0))
      || (risk.autoFrequencyLimit !== undefined
        && (!Number.isInteger(risk.autoFrequencyLimit) || risk.autoFrequencyLimit < 0))
    ) {
      block("OWNER_POLICY_BLOCKED", "Risk context is malformed; policy evaluation fails closed");
    }

    if (risk.ownerInstruction === "block") {
      block("OWNER_POLICY_BLOCKED", "Owner policy explicitly blocks this action");
    } else if (risk.ownerInstruction === "require-strong-approval") {
      disposition = strongestDisposition(disposition, "STRONG_APPROVAL");
      reasons.push({
        code: "RISK_STRONG_APPROVAL",
        message: "Owner policy requires strong approval"
      });
    } else if (risk.ownerInstruction === "require-approval") {
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Owner policy requires approval"
      });
    }

    if (risk.publicVisibility) {
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Publicly visible changes may not execute with AUTO authority"
      });
    }

    if (risk.customerImpact === "broad-customer") {
      disposition = strongestDisposition(disposition, "STRONG_APPROVAL");
      reasons.push({
        code: "RISK_STRONG_APPROVAL",
        message: "Broad customer impact requires strong approval"
      });
    } else if (risk.customerImpact === "customer") {
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Customer-impacting work requires approval"
      });
    }

    if (
      risk.monetaryAmountCents !== undefined
      && risk.autoMonetaryLimitCents !== undefined
      && risk.monetaryAmountCents > risk.autoMonetaryLimitCents
    ) {
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Monetary amount exceeds the configured AUTO threshold"
      });
    }

    if (
      risk.executionFrequency !== undefined
      && risk.autoFrequencyLimit !== undefined
      && risk.executionFrequency > risk.autoFrequencyLimit
    ) {
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Execution frequency exceeds the configured AUTO threshold"
      });
    }

    if (risk.budgetConsumptionRatio !== undefined && risk.budgetConsumptionRatio > 1) {
      block("BUDGET_BLOCKED", "Budget consumption is already beyond its hard limit");
    } else if (
      risk.budgetConsumptionRatio !== undefined
      && risk.budgetConsumptionRatio > 0.8
    ) {
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Budget consumption is above the configured high-water mark"
      });
    }

    if (
      risk.confidence !== undefined
      && risk.confidence < 0.8
      && !risk.previousApprovedPolicy
    ) {
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Low-confidence novel work requires owner approval"
      });
    }

    if (
      risk.novelty !== undefined
      && risk.novelty > 0.7
      && !risk.previousApprovedPolicy
    ) {
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Novel work without a previously approved policy requires approval"
      });
    }

  }

  if (capability) {
    if (
      input.environment === "production"
      && capability.productionEffect
      && disposition === "AUTO"
    ) {
      disposition = "APPROVAL_REQUIRED";
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Production-changing work may not execute with AUTO authority"
      });
    }

    if (
      capability.access === "write"
      && (input.dataClass === "customer" || input.dataClass === "sensitive")
      && disposition === "AUTO"
    ) {
      disposition = "APPROVAL_REQUIRED";
      reasons.push({
        code: "RISK_APPROVAL",
        message: "Writes over customer or sensitive data may not execute with AUTO authority"
      });
    }

    if (!capability.reversible) {
      if (
        capability.blastRadius === "portfolio"
        || capability.blastRadius === "infrastructure"
      ) {
        disposition = strongestDisposition(disposition, "STRONG_APPROVAL");
        reasons.push({
          code: "RISK_STRONG_APPROVAL",
          message: "Irreversible wide-blast-radius work requires strong approval"
        });
      } else if (capability.blastRadius === "company") {
        disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
        reasons.push({
          code: "RISK_APPROVAL",
          message: "Irreversible company-wide work requires approval"
        });
      }
    }
  }

  if (input.environment !== input.trustedScope.environment) {
    block("ENVIRONMENT_BLOCKED", "Policy environment does not match trusted execution scope");
  } else if (!input.allowedEnvironments.includes(input.environment)) {
    block("ENVIRONMENT_BLOCKED", `Environment is not permitted: ${input.environment}`);
  }

  if (!input.allowedDataClasses.includes(input.dataClass)) {
    block("DATA_CLASS_BLOCKED", `Data class is not permitted: ${input.dataClass}`);
  }

  if (input.allowedRegions && input.region && !input.allowedRegions.includes(input.region)) {
    block("REGION_BLOCKED", `Region is not permitted: ${input.region}`);
  }

  if (input.credentialRequirementIds.length > 0) {
    if (!input.credentialSnapshot) {
      block("CREDENTIAL_MISSING", "Credential requirements exist but no credential availability snapshot was supplied");
    } else {
      try {
        const knownRequirements = new Set(input.credentialSnapshot.requirements.map((item) => item.id));
        if (input.credentialRequirementIds.some((id) => !knownRequirements.has(id))) {
          block("CREDENTIAL_MISSING", "Credential snapshot does not contain all required credential requirements");
        } else {
          const result = evaluateCredentialAvailability(input.credentialSnapshot, {
            scope: input.trustedScope,
            capabilities: [input.capability],
            now
          });
          if (!result.satisfied) {
            block("CREDENTIAL_MISSING", `Required credential bindings are unavailable: ${result.missingRequirementIds.join(", ")}`);
          }
        }
      } catch {
        block("CREDENTIAL_SNAPSHOT_INVALID", "Credential availability snapshot is stale, tampered, or out of scope");
      }
    }
  }

  if (input.capacityEvidenceRequired && !input.capacitySnapshot) {
    block("CAPACITY_REQUIRED", "Protected-capacity evidence is required before authorization");
  }

  if (input.capacitySnapshot) {
    try {
      assertProtectedCapacitySnapshot({
        snapshot: input.capacitySnapshot,
        scope: input.trustedScope,
        resourceId: input.resourceId ?? input.trustedScope.resourceId,
        poolId: input.poolId,
        now
      });
    } catch {
      block("CAPACITY_SNAPSHOT_INVALID", "Protected capacity snapshot is stale, tampered, out of scope, or lacks required headroom");
    }
  }

  if (input.fallbackRequired && !input.fallbackAvailable) {
    block("FALLBACK_MISSING", "Required fallback is unavailable");
  }

  if (!input.idempotencyKey) {
    block("IDEMPOTENCY_MISSING", "Idempotency key is required before authorization");
  }

  const killSwitches = blockingKillSwitches(input.killSwitches, {
    portfolioId: input.trustedScope.portfolioId,
    companyId: input.trustedScope.companyId,
    integrationId: input.integrationId,
    capability: input.capability,
    resourceId: input.resourceId ?? input.trustedScope.resourceId,
    poolId: input.poolId,
    providerId: input.providerId,
    failureDomainId: input.failureDomainId,
    workloadClass: input.workloadClass
  });
  if (killSwitches.length > 0) {
    block("KILL_SWITCH", `Applicable kill switch blocks new work: ${killSwitches.map((item) => item.id).join(", ")}`);
  }

  const reservations = budgetReservations(input);
  for (const budgetInput of uniqueMonetaryBudgets(input)) {
    try {
      const scopeId = applicableBudgetScopeId(budgetInput.policy, input);
      if (scopeId === null) continue;

      const budget = evaluateBudget(budgetInput.policy, {
        scopeId,
        currentSpendCents: budgetInput.currentSpendCents,
        reservedCents: budgetInput.reservedCents,
        requestedCostCents: budgetInput.requestedCostCents
      });

      if (budget.disposition === "blocked") {
        block("BUDGET_BLOCKED", budget.reason ?? "Budget policy blocked the action");
        continue;
      }

      if (budgetInput.requestedCostCents > 0) {
        const reservation = reservations.find(
          (candidate) => candidate.policyId === budgetInput.policy.id
        );
        if (!reservation) {
          block(
            "BUDGET_RESERVATION_MISSING",
            `Budgeted work requires a reservation for policy ${budgetInput.policy.id}`
          );
        } else {
          try {
            assertBudgetReservation({
              reservation,
              scope: input.trustedScope,
              planHash: input.planHash,
              stepHash: input.stepHash,
              minimumAmountCents: budgetInput.requestedCostCents,
              policyId: budgetInput.policy.id,
              now
            });
          } catch {
            block(
              "BUDGET_RESERVATION_INVALID",
              `Budget reservation is stale, tampered, out of scope, insufficient, or bound to another policy: ${budgetInput.policy.id}`
            );
          }
        }
      }

      if (budget.disposition === "approval-required") {
        disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
        reasons.push({
          code: "BUDGET_APPROVAL",
          message: budget.reason ?? "Budget threshold requires approval"
        });
      }
    } catch {
      block(
        "BUDGET_INVALID",
        `Budget state is malformed for policy ${budgetInput.policy.id}; failing closed`
      );
    }
  }

  for (const usageInput of [...(input.usageBudgets ?? [])].sort(
    (left, right) => left.policy.id.localeCompare(right.policy.id)
  )) {
    try {
      const scopeId = applicableBudgetScopeId(usageInput.policy, input);
      if (scopeId === null) continue;

      const usage = evaluateUsageBudget(usageInput.policy, {
        scopeId,
        currentUsage: usageInput.currentUsage,
        reservedUsage: usageInput.reservedUsage,
        requestedUsage: usageInput.requestedUsage
      });

      if (usage.disposition === "blocked") {
        block(
          "USAGE_BUDGET_BLOCKED",
          usage.reason ?? "Usage budget policy blocked the action"
        );
      } else if (usage.disposition === "approval-required") {
        disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
        reasons.push({
          code: "USAGE_BUDGET_APPROVAL",
          message: usage.reason ?? "Usage budget threshold requires approval"
        });
      }
    } catch {
      block(
        "USAGE_BUDGET_INVALID",
        `Usage budget state is malformed for policy ${usageInput.policy.id}; failing closed`
      );
    }
  }

  if (input.guardrails) {
    const guardrails = evaluateGuardrails(
      input.guardrails.policies,
      input.guardrails.scopeId ?? input.trustedScope.companyId,
      input.guardrails.metrics
    );

    if (guardrails.disposition === "blocked") {
      block("GUARDRAIL_BLOCKED", "Protected guardrail violation blocks the action");
    } else if (guardrails.disposition === "approval-required") {
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({ code: "GUARDRAIL_APPROVAL", message: "Guardrail exception requires approval" });
    }
  }

  if (input.confirmedPreferenceRule) {
    try {
      const matches = matchesConfirmedPreferenceRule(input.confirmedPreferenceRule, {
        scope: input.trustedScope,
        capability: input.capability,
        dataClass: input.dataClass,
        integrationId: input.integrationId,
        resourceId: input.resourceId ?? input.trustedScope.resourceId,
        workloadClass: input.workloadClass,
        customerImpact: input.riskContext?.customerImpact,
        publicVisibility: input.riskContext?.publicVisibility,
        monetaryAmountCents: input.riskContext?.monetaryAmountCents
      });

      const explicitOwnerRestriction =
        input.riskContext?.ownerInstruction === "block"
        || input.riskContext?.ownerInstruction === "require-approval"
        || input.riskContext?.ownerInstruction === "require-strong-approval";
      const nonOverridableApproval = reasons.some((reason) =>
        [
          "BUDGET_APPROVAL",
          "USAGE_BUDGET_APPROVAL",
          "GUARDRAIL_APPROVAL",
          "CAPABILITY_STRONG_APPROVAL",
          "RISK_STRONG_APPROVAL"
        ].includes(reason.code)
      );
      const safeForLearnedAuto =
        disposition === "APPROVAL_REQUIRED"
        && capability?.approval === "approval"
        && capability.reversible
        && input.riskContext?.publicVisibility !== true
        && !["customer", "broad-customer"].includes(
          input.riskContext?.customerImpact ?? "none"
        )
        && !explicitOwnerRestriction
        && !nonOverridableApproval;

      if (matches && safeForLearnedAuto) {
        disposition = "AUTO";
        reasons.push({
          code: "CONFIRMED_PREFERENCE_AUTO",
          message: "Confirmed owner preference rule permits AUTO only for this exact previously approved pattern"
        });
      }
    } catch {
      block(
        "OWNER_POLICY_BLOCKED",
        "Confirmed preference rule is invalid, tampered, or revoked"
      );
    }
  }

  const requiresFreshStepUp = disposition === "STRONG_APPROVAL";
  const approvalSatisfied = proofSatisfied(disposition, input, reasons);

  return {
    disposition,
    reasons,
    capability,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    requiresFreshStepUp,
    approvalSatisfied,
    readyForTaskGeneration: disposition !== "BLOCKED" && approvalSatisfied
  };
}

export function evaluateStepPolicy(
  input: Omit<PolicyEvaluationInput, "capability"> & { capabilities: readonly string[] }
): StepPolicyEvaluation {
  const capabilityEvaluations: Record<string, PolicyEvaluation> = {};
  let disposition: PolicyDisposition = "AUTO";
  const reasons: PolicyReason[] = [];

  for (const capability of [...new Set(input.capabilities)].sort()) {
    const evaluation = evaluatePolicy({ ...input, capability });
    capabilityEvaluations[capability] = evaluation;
    disposition = strongestDisposition(disposition, evaluation.disposition);
    reasons.push(...evaluation.reasons);
  }

  const dedupedReasons = reasons.filter((reason, index, all) =>
    all.findIndex((candidate) => candidate.code === reason.code && candidate.message === reason.message) === index
  );

  const readyForTaskGeneration =
    disposition !== "BLOCKED"
    && Object.values(capabilityEvaluations).every((evaluation) => evaluation.readyForTaskGeneration);

  return Object.freeze({
    disposition,
    reasons: Object.freeze(dedupedReasons),
    capabilityEvaluations: Object.freeze(capabilityEvaluations),
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    requiresFreshStepUp: disposition === "STRONG_APPROVAL",
    approvalSatisfied: readyForTaskGeneration,
    readyForTaskGeneration
  });
}
