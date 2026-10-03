import { describe, expect, it } from "vitest";
import {
  activeObjectives,
  combineConstraintDispositions,
  detectObjectiveConflicts,
  evaluateBudget,
  evaluateGuardrails,
  evaluateUsageBudget,
  guardrailsForScope
} from "@/lib/domain/objectives";

describe("objectives and guardrails", () => {
  it("excludes paused objectives from active work", () => {
    expect(activeObjectives([
      { id: "o1", scopeId: "c1", metric: "revenue", direction: "increase", target: 10, priority: 1, status: "active" },
      { id: "o2", scopeId: "c1", metric: "cost", direction: "decrease", target: 10, priority: 2, status: "paused" }
    ]).map((objective) => objective.id)).toEqual(["o1"]);
  });

  it("detects conflicting directions on the same scoped metric", () => {
    const conflicts = detectObjectiveConflicts([
      { id: "o1", scopeId: "c1", metric: "compute-cost", direction: "increase", target: 10, priority: 1, status: "active" },
      { id: "o2", scopeId: "c1", metric: "compute-cost", direction: "decrease", target: 10, priority: 2, status: "active" }
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it("returns only guardrails for the requested scope", () => {
    expect(guardrailsForScope([
      { id: "g1", scopeId: "c1", metric: "availability", operator: "min", value: 99.9, protected: true },
      { id: "g2", scopeId: "c2", metric: "availability", operator: "min", value: 99.9, protected: true }
    ], "c1").map((guardrail) => guardrail.id)).toEqual(["g1"]);
  });

  it("blocks hard budget overruns and requires approval above the soft threshold", () => {
    const budget = {
      id: "budget-1",
      scopeId: "c1",
      currency: "USD",
      period: "monthly" as const,
      hardLimitCents: 100_000,
      approvalThresholdCents: 80_000,
      enabled: true
    };

    expect(evaluateBudget(budget, {
      scopeId: "c1",
      currentSpendCents: 70_000,
      requestedCostCents: 15_000
    }).disposition).toBe("approval-required");

    expect(evaluateBudget(budget, {
      scopeId: "c1",
      currentSpendCents: 95_000,
      requestedCostCents: 10_000
    }).disposition).toBe("blocked");
  });

  it("evaluates non-monetary usage budgets with hard and approval thresholds", () => {
    const policy = {
      id: "outbound-daily",
      scopeType: "company" as const,
      scopeId: "c1",
      metric: "outbound-emails",
      period: "daily" as const,
      hardLimit: 500,
      approvalThreshold: 400,
      enabled: true
    };

    expect(evaluateUsageBudget(policy, {
      scopeId: "c1",
      currentUsage: 350,
      requestedUsage: 25
    })).toMatchObject({ disposition: "allow", projectedUsage: 375 });

    expect(evaluateUsageBudget(policy, {
      scopeId: "c1",
      currentUsage: 390,
      requestedUsage: 20
    })).toMatchObject({ disposition: "approval-required", projectedUsage: 410 });

    expect(evaluateUsageBudget(policy, {
      scopeId: "c1",
      currentUsage: 499,
      requestedUsage: 2
    })).toMatchObject({ disposition: "blocked", projectedUsage: 501 });

    expect(() => evaluateUsageBudget(policy, {
      scopeId: "c1",
      currentUsage: -1,
      requestedUsage: 1
    })).toThrow(/non-negative integers/i);
  });

  it("blocks protected guardrail violations", () => {
    const result = evaluateGuardrails([
      { id: "g1", scopeId: "c1", metric: "availability", operator: "min", value: 99.9, protected: true },
      { id: "g2", scopeId: "c1", metric: "cost-per-job", operator: "max", value: 100, protected: false }
    ], "c1", {
      availability: 98.5,
      "cost-per-job": 120
    });

    expect(result.disposition).toBe("blocked");
    expect(result.violations).toHaveLength(2);
    expect(combineConstraintDispositions("allow", result.disposition)).toBe("blocked");
  });
  it("covers non-conflicting objectives, disabled/wrong-scope budgets, valid allow, and invalid cents", () => {
    expect(detectObjectiveConflicts([
      { id: "o1", scopeId: "c1", metric: "revenue", direction: "increase", target: 10, priority: 1, status: "active" },
      { id: "o2", scopeId: "c2", metric: "revenue", direction: "decrease", target: 10, priority: 2, status: "active" },
      { id: "o3", scopeId: "c1", metric: "cost", direction: "decrease", target: 5, priority: 3, status: "active" },
      { id: "o4", scopeId: "c1", metric: "revenue", direction: "increase", target: 20, priority: 4, status: "active" }
    ])).toEqual([]);

    const budget = {
      id: "budget-branches",
      scopeId: "c1",
      currency: "USD",
      period: "monthly" as const,
      hardLimitCents: 1000,
      approvalThresholdCents: 800,
      enabled: true
    };

    expect(evaluateBudget({ ...budget, enabled: false }, {
      scopeId: "c1",
      currentSpendCents: 100,
      reservedCents: 50,
      requestedCostCents: 25
    })).toMatchObject({ disposition: "allow", projectedSpendCents: 175 });

    expect(evaluateBudget(budget, {
      scopeId: "other-company",
      currentSpendCents: 100,
      requestedCostCents: 25
    }).disposition).toBe("allow");

    expect(evaluateBudget(budget, {
      scopeId: "c1",
      currentSpendCents: 100,
      reservedCents: 100,
      requestedCostCents: 100
    })).toMatchObject({ disposition: "allow", projectedSpendCents: 300, remainingCents: 700 });

    expect(() => evaluateBudget(budget, {
      scopeId: "c1",
      currentSpendCents: -1,
      requestedCostCents: 1
    })).toThrow(/non-negative integer cents/i);
    expect(() => evaluateBudget(budget, {
      scopeId: "c1",
      currentSpendCents: 0,
      requestedCostCents: 1.5
    })).toThrow(/non-negative integer cents/i);
  });

  it("covers every guardrail operator plus unprotected approval and no-violation allow", () => {
    const guardrails = [
      { id: "min", scopeId: "c1", metric: "availability", operator: "min" as const, value: 99, protected: false },
      { id: "max", scopeId: "c1", metric: "latency", operator: "max" as const, value: 100, protected: false },
      { id: "equals", scopeId: "c1", metric: "region", operator: "equals" as const, value: "us-west", protected: false },
      { id: "deny-value", scopeId: "c1", metric: "blocked-provider", operator: "deny" as const, value: "bad-provider", protected: false },
      { id: "deny-truthy", scopeId: "c1", metric: "emergency-stop", operator: "deny" as const, protected: false }
    ];

    const violations = evaluateGuardrails(guardrails, "c1", {
      availability: 98,
      latency: 101,
      region: "us-east",
      "blocked-provider": "bad-provider",
      "emergency-stop": true
    });
    expect(violations.disposition).toBe("approval-required");
    expect(violations.violations).toHaveLength(5);

    expect(evaluateGuardrails(guardrails, "c1", {
      availability: 99.9,
      latency: 90,
      region: "us-west",
      "blocked-provider": "good-provider",
      "emergency-stop": false
    })).toEqual({ disposition: "allow", violations: [] });

    expect(evaluateGuardrails([
      { id: "missing", scopeId: "c1", metric: "required", operator: "equals", value: "present", protected: true }
    ], "c1", {})).toMatchObject({ disposition: "blocked" });

    expect(combineConstraintDispositions("allow", "approval-required")).toBe("approval-required");
    expect(combineConstraintDispositions("allow", "allow")).toBe("allow");
  });

});
