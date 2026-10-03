import { CAPABILITY_REGISTRY_HASH, CAPABILITY_REGISTRY_VERSION } from "@/lib/domain/capabilities";
import type { KillSwitch } from "@/lib/domain/kill-switch";
import type { Guardrail } from "@/lib/domain/objectives";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ResourceRequirementEnvelope } from "@/lib/planning/plan-schema";
import type { CredentialAvailabilitySnapshot } from "@/lib/domain/credential-binding";
import type { BudgetReservation } from "@/lib/domain/budget-reservation";
import type { ProtectedCapacitySnapshot } from "@/lib/domain/protected-capacity";
import {
  POLICY_ENGINE_VERSION,
  POLICY_RULES_HASH,
  type PolicyMonetaryBudgetInput,
  type PolicyRiskContext,
  type PolicyUsageBudgetInput
} from "@/lib/planning/policy-engine";
import {
  CURRENT_POLICY_REGISTRY_HASH,
  CURRENT_POLICY_VERSION,
  assertCurrentPolicyVersion
} from "@/lib/domain/policy-registry";
import {
  assertLearnedRuleIntegrity,
  type LearnedRuleRecord
} from "@/lib/domain/learned-rules";

export type PolicyBudgetSnapshot = PolicyMonetaryBudgetInput;
export type PolicyUsageBudgetSnapshot = PolicyUsageBudgetInput;

export interface PolicyGuardrailSnapshot {
  scopeId: string;
  policies: readonly Guardrail[];
  metrics: Readonly<Record<string, number | string | boolean | undefined>>;
}

export interface PolicySnapshotInput {
  id: string;
  policyVersion: string;
  scope: TrustedExecutionScope;
  planHash: string;
  stepHash: string;
  capabilityNames: readonly string[];
  dataClass: "public" | "internal" | "customer" | "sensitive";
  region?: string;
  allowedEnvironments: readonly TrustedExecutionScope["environment"][];
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

  /** @deprecated Prefer budgets for hierarchical budget evaluation. */
  budget?: PolicyBudgetSnapshot;
  budgets?: readonly PolicyBudgetSnapshot[];
  /** @deprecated Prefer budgetReservations for hierarchical budget evaluation. */
  budgetReservation?: BudgetReservation;
  budgetReservations?: readonly BudgetReservation[];
  usageBudgets?: readonly PolicyUsageBudgetSnapshot[];
  riskContext?: PolicyRiskContext;
  learnedRule?: LearnedRuleRecord;
  guardrails?: PolicyGuardrailSnapshot;
  killSwitches: readonly KillSwitch[];

  credentialRequirementIds: readonly string[];
  credentialSnapshot?: CredentialAvailabilitySnapshot;
  capacitySnapshot?: ProtectedCapacitySnapshot;
  capacityEvidenceRequired?: boolean;

  fallbackRequired: boolean;
  fallbackAvailable: boolean;
  idempotencyKey: string;

  resourceRequirements: ResourceRequirementEnvelope;
  createdAt: string;
}

export interface PolicySnapshot extends PolicySnapshotInput {
  policyRegistryHash: string;
  policyEngineVersion: string;
  policyRulesHash: string;
  capabilityRegistryVersion: string;
  capabilityRegistryHash: string;
  resourceRequirementsHash: string;
  killSwitchSnapshotHash: string;
  capacityEvidenceRequired: boolean;
  credentialSnapshotHash?: string;
  budgetReservationHash?: string;
  budgetReservationHashes?: readonly string[];
  capacitySnapshotHash?: string;
  policyInputHash: string;
  snapshotHash: string;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalizedKillSwitches(killSwitches: readonly KillSwitch[]) {
  return [...killSwitches]
    .map((item) => ({ ...item }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function hashKillSwitchSnapshot(killSwitches: readonly KillSwitch[]) {
  return sha256Hex(normalizedKillSwitches(killSwitches));
}

export function createPolicySnapshot(input: PolicySnapshotInput): PolicySnapshot {
  assertCurrentPolicyVersion(input.policyVersion);
  if (input.learnedRule) assertLearnedRuleIntegrity(input.learnedRule);

  const capacityEvidenceRequired =
    input.capacityEvidenceRequired
    ?? Boolean(input.resourceId || input.poolId || input.resourceRequirements.compute);

  if (capacityEvidenceRequired && !input.capacitySnapshot) {
    throw new Error("Policy snapshot requires protected-capacity evidence");
  }

  const killSwitches = normalizedKillSwitches(input.killSwitches);
  const budgets = [...(input.budgets ?? [])].sort(
    (left, right) => left.policy.id.localeCompare(right.policy.id)
  );
  const budgetReservations = [...(input.budgetReservations ?? [])].sort(
    (left, right) => left.policyId.localeCompare(right.policyId) || left.id.localeCompare(right.id)
  );
  const usageBudgets = [...(input.usageBudgets ?? [])].sort(
    (left, right) => left.policy.id.localeCompare(right.policy.id)
  );
  const budgetReservationHashes = budgetReservations.map(
    (reservation) => reservation.reservationHash
  );
  const killSwitchSnapshotHash = hashKillSwitchSnapshot(killSwitches);
  const resourceRequirementsHash = sha256Hex(input.resourceRequirements);

  const policyInput = {
    policyVersion: input.policyVersion,
    policyRegistryHash: CURRENT_POLICY_REGISTRY_HASH,
    scope: input.scope,
    capabilityNames: [...new Set(input.capabilityNames)].sort(),
    dataClass: input.dataClass,
    region: input.region,
    allowedEnvironments: [...input.allowedEnvironments],
    allowedDataClasses: [...input.allowedDataClasses],
    allowedRegions: input.allowedRegions ? [...input.allowedRegions] : undefined,
    integrationId: input.integrationId,
    resourceId: input.resourceId,
    poolId: input.poolId,
    providerId: input.providerId,
    failureDomainId: input.failureDomainId,
    workloadClass: input.workloadClass,
    objectiveId: input.objectiveId,
    jobId: input.jobId,
    budget: input.budget,
    budgets,
    budgetReservationHash: input.budgetReservation?.reservationHash,
    budgetReservationHashes,
    usageBudgets,
    riskContext: input.riskContext,
    learnedRuleHash: input.learnedRule?.recordHash,
    guardrails: input.guardrails,
    killSwitchSnapshotHash,
    credentialRequirementIds: [...new Set(input.credentialRequirementIds)].sort(),
    credentialSnapshotHash: input.credentialSnapshot?.snapshotHash,
    capacitySnapshotHash: input.capacitySnapshot?.snapshotHash,
    capacityEvidenceRequired,
    fallbackRequired: input.fallbackRequired,
    fallbackAvailable: input.fallbackAvailable,
    idempotencyKey: input.idempotencyKey,
    resourceRequirementsHash
  };

  const base = {
    ...input,
    policyVersion: CURRENT_POLICY_VERSION,
    policyRegistryHash: CURRENT_POLICY_REGISTRY_HASH,
    scope: { ...input.scope },
    capabilityNames: [...new Set(input.capabilityNames)].sort(),
    allowedEnvironments: [...input.allowedEnvironments],
    allowedDataClasses: [...input.allowedDataClasses],
    allowedRegions: input.allowedRegions ? [...input.allowedRegions] : undefined,
    budgets,
    budgetReservations,
    usageBudgets,
    riskContext: input.riskContext ? { ...input.riskContext } : undefined,
    learnedRule: input.learnedRule ? { ...input.learnedRule, conditions: { ...input.learnedRule.conditions } } : undefined,
    killSwitches,
    credentialRequirementIds: [...new Set(input.credentialRequirementIds)].sort(),
    capacityEvidenceRequired,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    capabilityRegistryHash: CAPABILITY_REGISTRY_HASH,
    resourceRequirementsHash,
    killSwitchSnapshotHash,
    credentialSnapshotHash: input.credentialSnapshot?.snapshotHash,
    budgetReservationHash: input.budgetReservation?.reservationHash,
    budgetReservationHashes,
    capacitySnapshotHash: input.capacitySnapshot?.snapshotHash,
    policyInputHash: sha256Hex(policyInput)
  };

  return deepFreeze({
    ...base,
    snapshotHash: sha256Hex(base)
  });
}

export function assertPolicySnapshotIntegrity(snapshot: PolicySnapshot) {
  const { snapshotHash, ...base } = snapshot;
  if (sha256Hex(base) !== snapshotHash) {
    throw new Error("Policy snapshot integrity check failed");
  }
  if (snapshot.learnedRule) assertLearnedRuleIntegrity(snapshot.learnedRule);
  if (
    snapshot.policyVersion !== CURRENT_POLICY_VERSION
    || snapshot.policyRegistryHash !== CURRENT_POLICY_REGISTRY_HASH
    || snapshot.policyEngineVersion !== POLICY_ENGINE_VERSION
    || snapshot.policyRulesHash !== POLICY_RULES_HASH
    || snapshot.capabilityRegistryVersion !== CAPABILITY_REGISTRY_VERSION
    || snapshot.capabilityRegistryHash !== CAPABILITY_REGISTRY_HASH
    || snapshot.killSwitchSnapshotHash !== hashKillSwitchSnapshot(snapshot.killSwitches)
  ) {
    throw new Error("Policy snapshot references stale policy, capability, or kill-switch definitions");
  }

  const requiresCapacity =
    snapshot.capacityEvidenceRequired
    || Boolean(snapshot.resourceId || snapshot.poolId || snapshot.resourceRequirements.compute);
  if (requiresCapacity && !snapshot.capacitySnapshotHash) {
    throw new Error("Policy snapshot is missing required protected-capacity evidence");
  }

  return snapshot;
}
