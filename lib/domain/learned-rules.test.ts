import { describe, expect, it } from "vitest";
import {
  confirmLearnedRule,
  matchesConfirmedLearnedRule,
  revokeLearnedRule,
  suggestLearnedRule,
  type LearnedRuleConditions,
  type LearnedRuleDecisionObservation,
  type LearnedRuleMatchContext
} from "@/lib/domain/learned-rules";

const conditions: LearnedRuleConditions = {
  environment: "production",
  integrationId: "github-primary",
  dataClass: "internal",
  repositoryId: "DMART19/GetDone",
  customerImpact: "internal",
  publicVisibility: false,
  monetaryAmountCeilingCents: 0,
  executionFrequencyCeiling: 5,
  blastRadius: "company",
  reversible: true,
  productionEffect: true,
  verificationRequirementsHash: "verify:onboarding+health",
  rollbackAvailable: true
};

function observation(index: number, overrides: Partial<LearnedRuleDecisionObservation> = {}): LearnedRuleDecisionObservation {
  return {
    decisionId: `decision-${index}`,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    ownerId: "owner",
    capability: "production.deploy",
    triggerPattern: "same-repository:same-verification:same-rollback",
    conditions,
    approved: true,
    observedAt: `2026-09-2${index}T12:00:00Z`,
    ...overrides
  };
}

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

function match(overrides: Partial<LearnedRuleMatchContext> = {}): LearnedRuleMatchContext {
  return {
    scope,
    capability: "production.deploy",
    triggerPattern: "same-repository:same-verification:same-rollback",
    integrationId: "github-primary",
    dataClass: "internal" as const,
    repositoryId: "DMART19/GetDone",
    customerImpact: "internal" as const,
    publicVisibility: false,
    monetaryAmountCents: 0,
    executionFrequency: 2,
    blastRadius: "company" as const,
    reversible: true,
    productionEffect: true,
    verificationRequirementsHash: "verify:onboarding+health",
    rollbackAvailable: true,
    ...overrides
  };
}

describe("confirmed preference learning", () => {
  it("does not create a rule from one approval", () => {
    expect(() => suggestLearnedRule({
      id: "rule-1",
      observations: [observation(1)],
      createdAt: "2026-09-28T12:00:00Z"
    })).toThrow(/at least 3/i);
  });

  it("suggests repeated exact patterns but grants no authority before confirmation", () => {
    const suggested = suggestLearnedRule({
      id: "rule-1",
      observations: [observation(1), observation(2), observation(3)],
      createdAt: "2026-09-28T12:00:00Z"
    });
    expect(suggested).toMatchObject({
      state: "suggested",
      ownerConfirmed: false,
      timesObserved: 3,
      decision: "AUTO"
    });
    expect(matchesConfirmedLearnedRule(suggested, match())).toBe(false);
  });

  it("matches only after explicit owner confirmation", () => {
    const suggested = suggestLearnedRule({
      id: "rule-1",
      observations: [observation(1), observation(2), observation(3)],
      createdAt: "2026-09-28T12:00:00Z"
    });
    const confirmed = confirmLearnedRule(suggested, "owner", "2026-09-28T12:01:00Z");
    expect(confirmed.ownerConfirmed).toBe(true);
    expect(matchesConfirmedLearnedRule(confirmed, match())).toBe(true);
  });

  it("fails matching when material execution conditions change", () => {
    const confirmed = confirmLearnedRule(suggestLearnedRule({
      id: "rule-1",
      observations: [observation(1), observation(2), observation(3)],
      createdAt: "2026-09-28T12:00:00Z"
    }), "owner", "2026-09-28T12:01:00Z");

    expect(matchesConfirmedLearnedRule(confirmed, match({ integrationId: "github-other" }))).toBe(false);
    expect(matchesConfirmedLearnedRule(confirmed, match({ repositoryId: "DMART19/Other" }))).toBe(false);
    expect(matchesConfirmedLearnedRule(confirmed, match({ publicVisibility: true }))).toBe(false);
    expect(matchesConfirmedLearnedRule(confirmed, match({ rollbackAvailable: false }))).toBe(false);
    expect(matchesConfirmedLearnedRule(confirmed, match({ monetaryAmountCents: 1 }))).toBe(false);
    expect(matchesConfirmedLearnedRule(confirmed, match({ verificationRequirementsHash: "weaker" }))).toBe(false);
  });

  it("revocation immediately removes learned authority", () => {
    const confirmed = confirmLearnedRule(suggestLearnedRule({
      id: "rule-1",
      observations: [observation(1), observation(2), observation(3)],
      createdAt: "2026-09-28T12:00:00Z"
    }), "owner", "2026-09-28T12:01:00Z");
    const revoked = revokeLearnedRule(confirmed, "owner", "2026-09-28T12:02:00Z");
    expect(matchesConfirmedLearnedRule(revoked, match())).toBe(false);
  });
});
