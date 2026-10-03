import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { RequestContext } from "@/lib/control-plane/request-context";
import { parsePlanProposal, type PlanProposal } from "@/lib/planning/plan-schema";

export type AuthorizedPlanSource =
  | { type: "objective"; referenceId: string }
  | { type: "investigation"; referenceId: string }
  | { type: "owner-request"; referenceId: string };

function sourceReference(plan: PlanProposal) {
  if (plan.source.type === "objective") return plan.source.objectiveId;
  if (plan.source.type === "investigation") return plan.source.investigationId;
  return plan.source.requestId;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/**
 * Deterministic boundary for model/owner-generated plan proposals.
 * The proposal is parsed with the GetDone-owned schema and rebound to a
 * server-authorized scope/source before later validation or authorization.
 */
export function constructPlanProposal(input: {
  candidate: unknown;
  request: RequestContext;
  authorizedSource: AuthorizedPlanSource;
}): PlanProposal {
  const plan = parsePlanProposal(input.candidate);

  if (!input.request.scope.portfolioId || !input.request.scope.companyId) {
    throw new ControlPlaneError("FORBIDDEN", "Trusted portfolio/company scope is required for plan construction");
  }

  if (
    plan.scope.portfolioId !== input.request.scope.portfolioId
    || plan.scope.companyId !== input.request.scope.companyId
    || plan.scope.environment !== input.request.environment
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Proposed plan scope/environment does not match server-authorized request", {
      correlationId: input.request.correlationId
    });
  }

  if (
    plan.source.type !== input.authorizedSource.type
    || sourceReference(plan) !== input.authorizedSource.referenceId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Plan source is not authorized for this request", {
      correlationId: input.request.correlationId
    });
  }

  return deepFreeze(plan);
}
