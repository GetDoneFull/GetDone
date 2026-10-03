import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { PolicySnapshot } from "@/lib/planning/policy-snapshot";

export const PREFERENCE_LEARNING_VERSION = "1.0.0";
export const DEFAULT_PREFERENCE_SUGGESTION_THRESHOLD = 3;

export type PreferenceDecisionResolution = "approved" | "modified" | "rejected";
export type PreferenceSuggestionResolution = "allow" | "keep-asking" | "never-suggest";

export interface PreferencePattern {
  capability: string;
  environment: TrustedExecutionScope["environment"];
  dataClass: "public" | "internal" | "customer" | "sensitive";
  integrationId?: string;
  resourceId?: string;
  workloadClass?: string;
  customerImpact: "none" | "internal" | "customer" | "broad-customer";
  publicVisibility: boolean;
  maxMonetaryAmountCents?: number;
}

export interface DecisionPreferenceObservation {
  id: string;
  portfolioId: string;
  companyId: string;
  decisionId: string;
  resolution: PreferenceDecisionResolution;
  pattern: PreferencePattern;
  patternHash: string;
  observedAt: string;
  observationHash: string;
}

export interface LearnedRuleSuggestion {
  id: string;
  portfolioId: string;
  companyId: string;
  capability: string;
  pattern: PreferencePattern;
  patternHash: string;
  sourceDecisionIds: readonly string[];
  timesObserved: number;
  proposedInstruction: "allow-auto";
  status: "suggested";
  createdAt: string;
  suggestionHash: string;
}

export interface ConfirmedPreferenceRule {
  id: string;
  suggestionId: string;
  portfolioId: string;
  companyId: string;
  capability: string;
  pattern: PreferencePattern;
  patternHash: string;
  sourceDecisionIds: readonly string[];
  timesObserved: number;
  instruction: "allow-auto";
  ownerConfirmed: true;
  confirmedBy: string;
  confirmedAt: string;
  revokedAt?: string;
  ruleHash: string;
}

export type PreferenceSuggestionResolutionResult =
  | { action: "allow"; rule: ConfirmedPreferenceRule }
  | {
      action: "keep-asking" | "never-suggest";
      disposition: PreferenceSuggestionDisposition;
    };

export interface PreferenceSuggestionDisposition {
  suggestionId: string;
  portfolioId: string;
  companyId: string;
  action: Exclude<PreferenceSuggestionResolution, "allow">;
  resolvedBy: string;
  resolvedAt: string;
  dispositionHash: string;
}

export interface PreferenceLearningStore {
  appendObservation(observation: DecisionPreferenceObservation): Promise<void>;
  listObservations(
    portfolioId: string,
    companyId: string,
    patternHash: string
  ): Promise<readonly DecisionPreferenceObservation[]>;
  putSuggestion(suggestion: LearnedRuleSuggestion): Promise<void>;
  getSuggestion(id: string): Promise<LearnedRuleSuggestion | null>;
  listSuggestions(
    portfolioId: string,
    companyId: string
  ): Promise<readonly LearnedRuleSuggestion[]>;
  resolveSuggestion(input: {
    suggestion: LearnedRuleSuggestion;
    action: PreferenceSuggestionResolution;
    actorId: string;
    resolvedAt: string;
    confirmedRule?: ConfirmedPreferenceRule;
    disposition?: PreferenceSuggestionDisposition;
  }): Promise<void>;
  listActiveRules(
    portfolioId: string,
    companyId: string,
    capability: string
  ): Promise<readonly ConfirmedPreferenceRule[]>;
}

function normalizePattern(pattern: PreferencePattern): PreferencePattern {
  return Object.freeze({
    capability: pattern.capability,
    environment: pattern.environment,
    dataClass: pattern.dataClass,
    integrationId: pattern.integrationId,
    resourceId: pattern.resourceId,
    workloadClass: pattern.workloadClass,
    customerImpact: pattern.customerImpact,
    publicVisibility: Boolean(pattern.publicVisibility),
    maxMonetaryAmountCents: pattern.maxMonetaryAmountCents
  });
}

export function preferencePatternHash(pattern: PreferencePattern) {
  return sha256Hex(normalizePattern(pattern));
}

export function preferencePatternFromPolicySnapshot(
  snapshot: PolicySnapshot,
  capability: string
): PreferencePattern {
  if (!snapshot.capabilityNames.includes(capability)) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Preference observation capability is not present in the frozen policy snapshot"
    );
  }
  return normalizePattern({
    capability,
    environment: snapshot.scope.environment,
    dataClass: snapshot.dataClass,
    integrationId: snapshot.integrationId,
    resourceId: snapshot.resourceId,
    workloadClass: snapshot.workloadClass,
    customerImpact: snapshot.riskContext?.customerImpact ?? "none",
    publicVisibility: snapshot.riskContext?.publicVisibility ?? false,
    maxMonetaryAmountCents: snapshot.riskContext?.monetaryAmountCents
  });
}

export function createDecisionPreferenceObservation(input: {
  scope: TrustedExecutionScope;
  decisionId: string;
  resolution: PreferenceDecisionResolution;
  pattern: PreferencePattern;
  observedAt: string;
}): DecisionPreferenceObservation {
  if (!input.decisionId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Preference observation requires decisionId");
  }
  const pattern = normalizePattern(input.pattern);
  const patternHash = preferencePatternHash(pattern);
  const base = {
    id: `preference-observation:${input.decisionId}:${pattern.capability}`,
    portfolioId: input.scope.portfolioId,
    companyId: input.scope.companyId,
    decisionId: input.decisionId,
    resolution: input.resolution,
    pattern,
    patternHash,
    observedAt: input.observedAt
  };
  return Object.freeze({ ...base, observationHash: sha256Hex(base) });
}

export function assertDecisionPreferenceObservation(
  observation: DecisionPreferenceObservation
) {
  const { observationHash, ...base } = observation;
  if (
    sha256Hex(base) !== observationHash
    || preferencePatternHash(observation.pattern) !== observation.patternHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Preference observation integrity check failed");
  }
  return observation;
}

function suggestionId(
  portfolioId: string,
  companyId: string,
  patternHash: string
) {
  return `learned-rule-suggestion:${sha256Hex({ portfolioId, companyId, patternHash })}`;
}

export function suggestLearnedRule(
  observations: readonly DecisionPreferenceObservation[],
  input: {
    minimumApprovals?: number;
    createdAt: string;
  }
): LearnedRuleSuggestion | null {
  const minimumApprovals = input.minimumApprovals
    ?? DEFAULT_PREFERENCE_SUGGESTION_THRESHOLD;
  if (!Number.isInteger(minimumApprovals) || minimumApprovals < 2) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Preference suggestion threshold must be an integer >= 2"
    );
  }
  if (observations.length === 0) return null;

  const verified = observations.map(assertDecisionPreferenceObservation);
  const first = verified[0];
  if (
    verified.some((item) =>
      item.portfolioId !== first.portfolioId
      || item.companyId !== first.companyId
      || item.patternHash !== first.patternHash
    )
  ) {
    return null;
  }

  const unique = new Map(verified.map((item) => [item.decisionId, item]));
  const approved = [...unique.values()].filter((item) => item.resolution === "approved");
  const nonApproved = [...unique.values()].filter((item) => item.resolution !== "approved");
  if (approved.length < minimumApprovals || nonApproved.length > 0) return null;

  const sourceDecisionIds = Object.freeze(
    approved.map((item) => item.decisionId).sort()
  );
  const base = {
    id: suggestionId(first.portfolioId, first.companyId, first.patternHash),
    portfolioId: first.portfolioId,
    companyId: first.companyId,
    capability: first.pattern.capability,
    pattern: first.pattern,
    patternHash: first.patternHash,
    sourceDecisionIds,
    timesObserved: approved.length,
    proposedInstruction: "allow-auto" as const,
    status: "suggested" as const,
    createdAt: input.createdAt
  };
  return Object.freeze({ ...base, suggestionHash: sha256Hex(base) });
}

export function assertLearnedRuleSuggestion(suggestion: LearnedRuleSuggestion) {
  const { suggestionHash, ...base } = suggestion;
  if (
    sha256Hex(base) !== suggestionHash
    || preferencePatternHash(suggestion.pattern) !== suggestion.patternHash
    || suggestion.timesObserved !== suggestion.sourceDecisionIds.length
    || suggestion.timesObserved < DEFAULT_PREFERENCE_SUGGESTION_THRESHOLD
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Learned-rule suggestion integrity check failed");
  }
  return suggestion;
}

export function confirmLearnedRule(input: {
  suggestion: LearnedRuleSuggestion;
  scope: TrustedExecutionScope;
  actorId: string;
  confirmedAt: string;
}): ConfirmedPreferenceRule {
  const suggestion = assertLearnedRuleSuggestion(input.suggestion);
  if (
    suggestion.portfolioId !== input.scope.portfolioId
    || suggestion.companyId !== input.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Learned-rule suggestion is outside the trusted owner scope"
    );
  }
  if (!input.actorId.trim()) {
    throw new ControlPlaneError("UNAUTHENTICATED", "Owner identity is required");
  }
  const base = {
    id: `confirmed-preference-rule:${suggestion.patternHash}`,
    suggestionId: suggestion.id,
    portfolioId: suggestion.portfolioId,
    companyId: suggestion.companyId,
    capability: suggestion.capability,
    pattern: suggestion.pattern,
    patternHash: suggestion.patternHash,
    sourceDecisionIds: suggestion.sourceDecisionIds,
    timesObserved: suggestion.timesObserved,
    instruction: "allow-auto" as const,
    ownerConfirmed: true as const,
    confirmedBy: input.actorId,
    confirmedAt: input.confirmedAt
  };
  return Object.freeze({ ...base, ruleHash: sha256Hex(base) });
}

export function dismissLearnedRuleSuggestion(input: {
  suggestion: LearnedRuleSuggestion;
  scope: TrustedExecutionScope;
  actorId: string;
  action: "keep-asking" | "never-suggest";
  resolvedAt: string;
}): PreferenceSuggestionDisposition {
  const suggestion = assertLearnedRuleSuggestion(input.suggestion);
  if (
    suggestion.portfolioId !== input.scope.portfolioId
    || suggestion.companyId !== input.scope.companyId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Suggestion is outside trusted owner scope");
  }
  const base = {
    suggestionId: suggestion.id,
    portfolioId: suggestion.portfolioId,
    companyId: suggestion.companyId,
    action: input.action,
    resolvedBy: input.actorId,
    resolvedAt: input.resolvedAt
  };
  return Object.freeze({ ...base, dispositionHash: sha256Hex(base) });
}

export function assertConfirmedPreferenceRule(rule: ConfirmedPreferenceRule) {
  const { ruleHash, ...base } = rule;
  if (
    rule.ownerConfirmed !== true
    || rule.revokedAt
    || sha256Hex(base) !== ruleHash
    || preferencePatternHash(rule.pattern) !== rule.patternHash
    || rule.capability !== rule.pattern.capability
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Confirmed preference rule is invalid or revoked");
  }
  return rule;
}

export function matchesConfirmedPreferenceRule(
  rule: ConfirmedPreferenceRule,
  input: {
    scope: TrustedExecutionScope;
    capability: string;
    dataClass: PreferencePattern["dataClass"];
    integrationId?: string;
    resourceId?: string;
    workloadClass?: string;
    customerImpact?: PreferencePattern["customerImpact"];
    publicVisibility?: boolean;
    monetaryAmountCents?: number;
  }
) {
  assertConfirmedPreferenceRule(rule);
  const pattern = rule.pattern;
  const amount = input.monetaryAmountCents;
  return (
    rule.portfolioId === input.scope.portfolioId
    && rule.companyId === input.scope.companyId
    && pattern.capability === input.capability
    && pattern.environment === input.scope.environment
    && pattern.dataClass === input.dataClass
    && (pattern.integrationId ?? null) === (input.integrationId ?? null)
    && (pattern.resourceId ?? null) === (input.resourceId ?? null)
    && (pattern.workloadClass ?? null) === (input.workloadClass ?? null)
    && pattern.customerImpact === (input.customerImpact ?? "none")
    && pattern.publicVisibility === Boolean(input.publicVisibility)
    && (
      pattern.maxMonetaryAmountCents === undefined
        ? amount === undefined
        : amount !== undefined && amount <= pattern.maxMonetaryAmountCents
    )
  );
}

export class PreferenceLearningService {
  constructor(
    private readonly store: PreferenceLearningStore,
    private readonly minimumApprovals = DEFAULT_PREFERENCE_SUGGESTION_THRESHOLD
  ) {}

  async recordDecision(input: {
    scope: TrustedExecutionScope;
    decisionId: string;
    resolution: PreferenceDecisionResolution;
    snapshot: PolicySnapshot;
    observedAt: string;
  }) {
    const suggestions: LearnedRuleSuggestion[] = [];
    for (const capability of [...new Set(input.snapshot.capabilityNames)].sort()) {
      const observation = createDecisionPreferenceObservation({
        scope: input.scope,
        decisionId: input.decisionId,
        resolution: input.resolution,
        pattern: preferencePatternFromPolicySnapshot(input.snapshot, capability),
        observedAt: input.observedAt
      });
      await this.store.appendObservation(observation);
      const history = await this.store.listObservations(
        input.scope.portfolioId,
        input.scope.companyId,
        observation.patternHash
      );
      const suggestion = suggestLearnedRule(history, {
        minimumApprovals: this.minimumApprovals,
        createdAt: input.observedAt
      });
      if (suggestion) {
        await this.store.putSuggestion(suggestion);
        suggestions.push(suggestion);
      }
    }
    return Object.freeze(suggestions);
  }

  listSuggestions(scope: TrustedExecutionScope) {
    return this.store.listSuggestions(scope.portfolioId, scope.companyId);
  }

  listActiveRules(scope: TrustedExecutionScope, capability: string) {
    return this.store.listActiveRules(scope.portfolioId, scope.companyId, capability);
  }

  async resolveSuggestion(input: {
    suggestionId: string;
    scope: TrustedExecutionScope;
    actorId: string;
    action: PreferenceSuggestionResolution;
    resolvedAt: string;
  }) {
    const suggestion = await this.store.getSuggestion(input.suggestionId);
    if (!suggestion) {
      throw new ControlPlaneError("NOT_FOUND", "Learned-rule suggestion was not found");
    }
    if (input.action === "allow") {
      const rule = confirmLearnedRule({
        suggestion,
        scope: input.scope,
        actorId: input.actorId,
        confirmedAt: input.resolvedAt
      });
      await this.store.resolveSuggestion({
        suggestion,
        action: input.action,
        actorId: input.actorId,
        resolvedAt: input.resolvedAt,
        confirmedRule: rule
      });
      return Object.freeze({ action: "confirm" as const, rule });
    }
    const disposition = dismissLearnedRuleSuggestion({
      suggestion,
      scope: input.scope,
      actorId: input.actorId,
      action: input.action,
      resolvedAt: input.resolvedAt
    });
    await this.store.resolveSuggestion({
      suggestion,
      action: input.action,
      actorId: input.actorId,
      resolvedAt: input.resolvedAt,
      disposition
    });
    return Object.freeze({ action: input.action, disposition });
  }
}
