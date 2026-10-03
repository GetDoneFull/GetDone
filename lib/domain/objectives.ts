export type ObjectiveDirection = "increase" | "decrease" | "maintain";

export interface Objective {
  id: string;
  scopeId: string;
  metric: string;
  direction: ObjectiveDirection;
  target: number;
  priority: number;
  deadline?: string;
  budgetCents?: number;
  status: "active" | "paused" | "completed";
}

export interface Guardrail {
  id: string;
  scopeId: string;
  metric: string;
  operator: "min" | "max" | "equals" | "deny";
  value?: number | string | boolean;
  protected: boolean;
}

export type BudgetScopeType =
  | "portfolio"
  | "company"
  | "integration"
  | "capability"
  | "objective"
  | "job";

export interface BudgetPolicy {
  id: string;
  scopeType?: BudgetScopeType;
  scopeId: string;
  currency: string;
  period: "per-action" | "per-job" | "daily" | "monthly";
  hardLimitCents: number;
  approvalThresholdCents?: number;
  enabled: boolean;
}

export interface UsageBudgetPolicy {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  metric: string;
  period: "per-action" | "per-job" | "daily" | "monthly";
  hardLimit: number;
  approvalThreshold?: number;
  enabled: boolean;
}

export type ConstraintDisposition = "allow" | "approval-required" | "blocked";

export interface BudgetEvaluation {
  disposition: ConstraintDisposition;
  projectedSpendCents: number;
  remainingCents: number;
  reason?: string;
}

export interface UsageBudgetEvaluation {
  disposition: ConstraintDisposition;
  projectedUsage: number;
  remaining: number;
  reason?: string;
}

export interface GuardrailViolation {
  guardrailId: string;
  metric: string;
  actual: number | string | boolean | undefined;
  expected: number | string | boolean | undefined;
  operator: Guardrail["operator"];
  protected: boolean;
}

export interface GuardrailEvaluation {
  disposition: ConstraintDisposition;
  violations: readonly GuardrailViolation[];
}

export function activeObjectives(objectives: readonly Objective[]) {
  return objectives.filter((objective) => objective.status === "active");
}

export function detectObjectiveConflicts(objectives: readonly Objective[]) {
  const conflicts: Array<{ left: string; right: string; metric: string }> = [];
  const active = activeObjectives(objectives);

  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      const a = active[left];
      const b = active[right];
      if (a.scopeId !== b.scopeId || a.metric !== b.metric) continue;
      if (a.direction === "maintain" || b.direction === "maintain" || a.direction !== b.direction) {
        conflicts.push({ left: a.id, right: b.id, metric: a.metric });
      }
    }
  }

  return conflicts;
}

export function guardrailsForScope(guardrails: readonly Guardrail[], scopeId: string) {
  return guardrails.filter((guardrail) => guardrail.scopeId === scopeId);
}

export function evaluateBudget(
  budget: BudgetPolicy,
  input: { scopeId: string; currentSpendCents: number; reservedCents?: number; requestedCostCents: number }
): BudgetEvaluation {
  const values = [
    input.currentSpendCents,
    input.reservedCents ?? 0,
    input.requestedCostCents,
    budget.hardLimitCents,
    budget.approvalThresholdCents ?? 0
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new TypeError("Budget values must be non-negative integer cents");
  }

  const projectedSpendCents =
    input.currentSpendCents + (input.reservedCents ?? 0) + input.requestedCostCents;
  const remainingCents = Math.max(0, budget.hardLimitCents - projectedSpendCents);

  if (!budget.enabled || budget.scopeId !== input.scopeId) {
    return { disposition: "allow", projectedSpendCents, remainingCents };
  }

  if (projectedSpendCents > budget.hardLimitCents) {
    return {
      disposition: "blocked",
      projectedSpendCents,
      remainingCents,
      reason: "Projected spend exceeds the hard budget limit"
    };
  }

  if (
    budget.approvalThresholdCents !== undefined
    && projectedSpendCents > budget.approvalThresholdCents
  ) {
    return {
      disposition: "approval-required",
      projectedSpendCents,
      remainingCents,
      reason: "Projected spend exceeds the configured approval threshold"
    };
  }

  return { disposition: "allow", projectedSpendCents, remainingCents };
}

export function evaluateUsageBudget(
  budget: UsageBudgetPolicy,
  input: {
    scopeId: string;
    currentUsage: number;
    reservedUsage?: number;
    requestedUsage: number;
  }
): UsageBudgetEvaluation {
  const values = [
    input.currentUsage,
    input.reservedUsage ?? 0,
    input.requestedUsage,
    budget.hardLimit,
    budget.approvalThreshold ?? 0
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new TypeError("Usage budget values must be non-negative integers");
  }

  const projectedUsage =
    input.currentUsage + (input.reservedUsage ?? 0) + input.requestedUsage;
  const remaining = Math.max(0, budget.hardLimit - projectedUsage);

  if (!budget.enabled || budget.scopeId !== input.scopeId) {
    return { disposition: "allow", projectedUsage, remaining };
  }

  if (projectedUsage > budget.hardLimit) {
    return {
      disposition: "blocked",
      projectedUsage,
      remaining,
      reason: `Projected ${budget.metric} usage exceeds the hard budget limit`
    };
  }

  if (
    budget.approvalThreshold !== undefined
    && projectedUsage > budget.approvalThreshold
  ) {
    return {
      disposition: "approval-required",
      projectedUsage,
      remaining,
      reason: `Projected ${budget.metric} usage exceeds the configured approval threshold`
    };
  }

  return { disposition: "allow", projectedUsage, remaining };
}

function violatesGuardrail(guardrail: Guardrail, actual: number | string | boolean | undefined) {
  if (actual === undefined) return true;

  switch (guardrail.operator) {
    case "min":
      return typeof actual !== "number" || typeof guardrail.value !== "number" || actual < guardrail.value;
    case "max":
      return typeof actual !== "number" || typeof guardrail.value !== "number" || actual > guardrail.value;
    case "equals":
      return actual !== guardrail.value;
    case "deny":
      return guardrail.value === undefined ? Boolean(actual) : actual === guardrail.value;
  }
}

export function evaluateGuardrails(
  guardrails: readonly Guardrail[],
  scopeId: string,
  metrics: Readonly<Record<string, number | string | boolean | undefined>>
): GuardrailEvaluation {
  const violations = guardrailsForScope(guardrails, scopeId)
    .filter((guardrail) => violatesGuardrail(guardrail, metrics[guardrail.metric]))
    .map((guardrail) => ({
      guardrailId: guardrail.id,
      metric: guardrail.metric,
      actual: metrics[guardrail.metric],
      expected: guardrail.value,
      operator: guardrail.operator,
      protected: guardrail.protected
    }));

  if (violations.some((violation) => violation.protected)) {
    return { disposition: "blocked", violations };
  }

  if (violations.length > 0) {
    return { disposition: "approval-required", violations };
  }

  return { disposition: "allow", violations };
}

export function combineConstraintDispositions(...dispositions: readonly ConstraintDisposition[]): ConstraintDisposition {
  if (dispositions.includes("blocked")) return "blocked";
  if (dispositions.includes("approval-required")) return "approval-required";
  return "allow";
}
