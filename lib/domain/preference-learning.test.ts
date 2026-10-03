import { describe, expect, it } from "vitest";
import {
  confirmLearnedRule,
  createDecisionPreferenceObservation,
  suggestLearnedRule,
  type PreferencePattern
} from "@/lib/domain/preference-learning";
import {
  evaluatePolicy,
  type PolicyEvaluationInput
} from "@/lib/planning/policy-engine";

const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

const pattern: PreferencePattern = {
  capability: "production.deploy",
  environment: "production",
  dataClass: "sensitive",
  integrationId: "github-a",
  customerImpact: "internal",
  publicVisibility: false
};

function observation(decisionId: string, resolution: "approved" | "modified" | "rejected" = "approved") {
  return createDecisionPreferenceObservation({
    scope,
    decisionId,
    resolution,
    pattern,
    observedAt: "2026-09-28T20:00:00Z"
  });
}

function confirmedRule() {
  const suggestion = suggestLearnedRule(
    [observation("decision-1"), observation("decision-2"), observation("decision-3")],
    { createdAt: "2026-09-28T20:01:00Z" }
  );
  if (!suggestion) throw new Error("expected suggestion");
  return confirmLearnedRule({
    suggestion,
    scope,
    actorId: "owner-a",
    confirmedAt: "2026-09-28T20:02:00Z"
  });
}

function policy(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    authenticated: true,
    scopeResolved: true,
    trustedScope: scope,
    capability: "production.deploy",
    planHash: "plan-hash",
    stepHash: "step-hash",
    environment: "production",
    dataClass: "sensitive",
    integrationId: "github-a",
    allowedEnvironments: ["production"],
    allowedDataClasses: ["sensitive"],
    credentialRequirementIds: [],
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: "policy-preference-test",
    killSwitches: [],
    riskContext: {
      customerImpact: "internal",
      publicVisibility: false,
      confidence: 0.99,
      novelty: 0.1
    },
    now: Date.parse("2026-09-28T20:03:00Z"),
    ...overrides
  };
}

describe("confirmed preference learning", () => {
  it("suggests only after repeated exact approvals", () => {
    expect(suggestLearnedRule(
      [observation("decision-1"), observation("decision-2")],
      { createdAt: "2026-09-28T20:01:00Z" }
    )).toBeNull();

    const suggestion = suggestLearnedRule(
      [observation("decision-1"), observation("decision-2"), observation("decision-3")],
      { createdAt: "2026-09-28T20:01:00Z" }
    );
    expect(suggestion?.timesObserved).toBe(3);
    expect(suggestion?.proposedInstruction).toBe("allow-auto");
  });

  it("refuses to suggest when the same pattern has a rejection or modification", () => {
    const suggestion = suggestLearnedRule(
      [
        observation("decision-1"),
        observation("decision-2"),
        observation("decision-3"),
        observation("decision-4", "rejected")
      ],
      { createdAt: "2026-09-28T20:01:00Z" }
    );
    expect(suggestion).toBeNull();
  });

  it("does not change future authority until the owner explicitly confirms", () => {
    const before = evaluatePolicy(policy());
    expect(before.disposition).toBe("APPROVAL_REQUIRED");
    expect(before.readyForTaskGeneration).toBe(false);

    const after = evaluatePolicy(policy({ confirmedPreferenceRule: confirmedRule() }));
    expect(after.disposition).toBe("AUTO");
    expect(after.readyForTaskGeneration).toBe(true);
    expect(after.reasons.some((reason) =>
      reason.code === "CONFIRMED_PREFERENCE_AUTO"
    )).toBe(true);
  });

  it("stops matching when material execution conditions change", () => {
    const rule = confirmedRule();
    const changedIntegration = evaluatePolicy(policy({
      integrationId: "github-b",
      confirmedPreferenceRule: rule
    }));
    expect(changedIntegration.disposition).toBe("APPROVAL_REQUIRED");

    const publicChange = evaluatePolicy(policy({
      confirmedPreferenceRule: rule,
      riskContext: {
        customerImpact: "internal",
        publicVisibility: true,
        confidence: 0.99,
        novelty: 0.1
      }
    }));
    expect(publicChange.disposition).toBe("APPROVAL_REQUIRED");
  });

  it("never lets a learned AUTO rule weaken hard execution controls", () => {
    const rule = confirmedRule();
    const killed = evaluatePolicy(policy({
      confirmedPreferenceRule: rule,
      killSwitches: [{
        id: "emergency",
        scopeType: "company",
        scopeId: "company-a",
        enabled: true,
        reason: "incident",
        activatedAt: "2026-09-28T20:02:00Z",
        activatedBy: "owner-a"
      }]
    }));
    expect(killed.disposition).toBe("BLOCKED");

    const irreversible = evaluatePolicy(policy({
      capability: "email.send",
      confirmedPreferenceRule: {
        ...rule,
        capability: "email.send",
        pattern: { ...rule.pattern, capability: "email.send" }
      } as never
    }));
    expect(irreversible.disposition).not.toBe("AUTO");
  });
});
