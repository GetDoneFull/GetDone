import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { CapabilityDefinition } from "@/lib/domain/capabilities";

export const LEARNED_RULE_CONTRACT_VERSION = "1.0.0";

export interface LearnedRuleConditions {
  environment: TrustedExecutionScope["environment"];
  integrationId: string | null;
  dataClass: "public" | "internal" | "customer" | "sensitive";
  repositoryId: string | null;
  customerImpact: "none" | "internal" | "customer" | "broad-customer";
  publicVisibility: boolean;
  monetaryAmountCeilingCents: number | null;
  executionFrequencyCeiling: number | null;
  blastRadius: CapabilityDefinition["blastRadius"];
  reversible: boolean;
  productionEffect: boolean;
  verificationRequirementsHash: string | null;
  rollbackAvailable: boolean;
}

export interface LearnedRuleRecord {
  id: string;
  portfolioId: string;
  companyId: string;
  ownerId: string;
  capability: string;
  triggerPattern: string;
  conditions: LearnedRuleConditions;
  decision: "AUTO";
  sourceDecisionIds: readonly string[];
  timesObserved: number;
  ownerConfirmed: boolean;
  confirmedAt?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  state: "suggested" | "confirmed" | "revoked";
  version: number;
  updatedAt: string;
  recordHash: string;
}

export interface LearnedRuleDecisionObservation {
  decisionId: string;
  portfolioId: string;
  companyId: string;
  ownerId: string;
  capability: string;
  triggerPattern: string;
  conditions: LearnedRuleConditions;
  approved: boolean;
  observedAt: string;
}

export interface LearnedRuleMatchContext {
  scope: TrustedExecutionScope;
  capability: string;
  triggerPattern: string;
  integrationId?: string;
  dataClass: LearnedRuleConditions["dataClass"];
  repositoryId?: string;
  customerImpact?: LearnedRuleConditions["customerImpact"];
  publicVisibility?: boolean;
  monetaryAmountCents?: number;
  executionFrequency?: number;
  blastRadius: CapabilityDefinition["blastRadius"];
  reversible: boolean;
  productionEffect: boolean;
  verificationRequirementsHash?: string;
  rollbackAvailable?: boolean;
}

function canonicalConditions(input: LearnedRuleConditions): LearnedRuleConditions {
  if (
    input.monetaryAmountCeilingCents !== null
    && (!Number.isInteger(input.monetaryAmountCeilingCents) || input.monetaryAmountCeilingCents < 0)
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Learned-rule monetary ceiling must be a non-negative integer");
  }
  if (
    input.executionFrequencyCeiling !== null
    && (!Number.isInteger(input.executionFrequencyCeiling) || input.executionFrequencyCeiling < 0)
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Learned-rule frequency ceiling must be a non-negative integer");
  }
  return Object.freeze({ ...input });
}

function hashRecord(input: Omit<LearnedRuleRecord, "recordHash">) {
  return sha256Hex(input);
}

export function assertLearnedRuleIntegrity(rule: LearnedRuleRecord) {
  const { recordHash, ...base } = rule;
  if (hashRecord(base) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Learned rule integrity check failed");
  }
  if (rule.ownerConfirmed !== (rule.state === "confirmed")) {
    throw new ControlPlaneError("FORBIDDEN", "Learned rule confirmation state is inconsistent");
  }
  if (rule.state === "revoked" && !rule.revokedAt) {
    throw new ControlPlaneError("FORBIDDEN", "Revoked learned rule requires revocation time");
  }
  return rule;
}

export function suggestLearnedRule(input: {
  id: string;
  observations: readonly LearnedRuleDecisionObservation[];
  createdAt: string;
  minimumObservations?: number;
}): LearnedRuleRecord {
  const minimum = input.minimumObservations ?? 3;
  const approved = input.observations.filter((item) => item.approved);
  if (approved.length < minimum) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Learned rule suggestion requires at least ${minimum} matching approvals`
    );
  }
  const first = approved[0]!;
  const conditionHash = sha256Hex(canonicalConditions(first.conditions));
  const uniqueDecisionIds = [...new Set(approved.map((item) => item.decisionId))].sort();
  if (uniqueDecisionIds.length < minimum) {
    throw new ControlPlaneError("CONFLICT", "Repeated learned-rule evidence must come from distinct Decisions");
  }
  for (const item of approved) {
    if (
      item.portfolioId !== first.portfolioId
      || item.companyId !== first.companyId
      || item.ownerId !== first.ownerId
      || item.capability !== first.capability
      || item.triggerPattern !== first.triggerPattern
      || sha256Hex(canonicalConditions(item.conditions)) !== conditionHash
    ) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Learned-rule observations must represent the same material approval pattern"
      );
    }
  }

  const base: Omit<LearnedRuleRecord, "recordHash"> = {
    id: input.id,
    portfolioId: first.portfolioId,
    companyId: first.companyId,
    ownerId: first.ownerId,
    capability: first.capability,
    triggerPattern: first.triggerPattern,
    conditions: canonicalConditions(first.conditions),
    decision: "AUTO",
    sourceDecisionIds: Object.freeze(uniqueDecisionIds),
    timesObserved: uniqueDecisionIds.length,
    ownerConfirmed: false,
    createdAt: new Date(input.createdAt).toISOString(),
    state: "suggested",
    version: 1,
    updatedAt: new Date(input.createdAt).toISOString()
  };
  return Object.freeze({ ...base, recordHash: hashRecord(base) });
}

export function confirmLearnedRule(
  rule: LearnedRuleRecord,
  ownerId: string,
  confirmedAt: string
): LearnedRuleRecord {
  assertLearnedRuleIntegrity(rule);
  if (rule.state !== "suggested" || rule.ownerId !== ownerId) {
    throw new ControlPlaneError("FORBIDDEN", "Only the owning user may confirm a suggested learned rule");
  }
  const base: Omit<LearnedRuleRecord, "recordHash"> = {
    ...rule,
    ownerConfirmed: true,
    confirmedAt: new Date(confirmedAt).toISOString(),
    state: "confirmed",
    version: rule.version + 1,
    updatedAt: new Date(confirmedAt).toISOString()
  };
  delete (base as Partial<LearnedRuleRecord>).recordHash;
  return Object.freeze({ ...base, recordHash: hashRecord(base) });
}

export function revokeLearnedRule(
  rule: LearnedRuleRecord,
  ownerId: string,
  revokedAt: string
): LearnedRuleRecord {
  assertLearnedRuleIntegrity(rule);
  if (rule.ownerId !== ownerId) {
    throw new ControlPlaneError("FORBIDDEN", "Only the owning user may revoke a learned rule");
  }
  const at = new Date(revokedAt).toISOString();
  const base: Omit<LearnedRuleRecord, "recordHash"> = {
    ...rule,
    ownerConfirmed: false,
    revokedAt: at,
    state: "revoked",
    version: rule.version + 1,
    updatedAt: at
  };
  delete (base as Partial<LearnedRuleRecord>).recordHash;
  return Object.freeze({ ...base, recordHash: hashRecord(base) });
}

export function matchesConfirmedLearnedRule(
  rule: LearnedRuleRecord,
  context: LearnedRuleMatchContext
) {
  assertLearnedRuleIntegrity(rule);
  if (
    rule.state !== "confirmed"
    || !rule.ownerConfirmed
    || rule.revokedAt
    || rule.portfolioId !== context.scope.portfolioId
    || rule.companyId !== context.scope.companyId
    || rule.ownerId !== context.scope.userId
    || rule.capability !== context.capability
    || rule.triggerPattern !== context.triggerPattern
  ) return false;

  const c = rule.conditions;
  if (
    c.environment !== context.scope.environment
    || c.integrationId !== (context.integrationId ?? null)
    || c.dataClass !== context.dataClass
    || c.repositoryId !== (context.repositoryId ?? null)
    || c.customerImpact !== (context.customerImpact ?? "none")
    || c.publicVisibility !== (context.publicVisibility ?? false)
    || c.blastRadius !== context.blastRadius
    || c.reversible !== context.reversible
    || c.productionEffect !== context.productionEffect
    || c.verificationRequirementsHash !== (context.verificationRequirementsHash ?? null)
    || c.rollbackAvailable !== (context.rollbackAvailable ?? false)
  ) return false;

  if (
    c.monetaryAmountCeilingCents !== null
    && (context.monetaryAmountCents === undefined
      || context.monetaryAmountCents > c.monetaryAmountCeilingCents)
  ) return false;

  if (
    c.executionFrequencyCeiling !== null
    && (context.executionFrequency === undefined
      || context.executionFrequency > c.executionFrequencyCeiling)
  ) return false;

  return true;
}
