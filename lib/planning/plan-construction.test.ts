import { describe, expect, it } from "vitest";
import { createRequestContext } from "@/lib/control-plane/request-context";
import { constructPlanProposal } from "@/lib/planning/plan-construction";
import { validPlan } from "@/lib/planning/test-fixture";

const request = createRequestContext({
  actor: { type: "user", id: "user-a" },
  scope: {
    userId: "user-a",
    portfolioId: "portfolio-a",
    companyId: "company-a"
  },
  environment: "staging",
  correlationId: "plan-construction-1"
});

describe("plan construction boundary", () => {
  it("accepts a schema-valid proposal only when scope and source are server-authorized", () => {
    const plan = constructPlanProposal({
      candidate: validPlan(),
      request,
      authorizedSource: { type: "objective", referenceId: "objective-1" }
    });

    expect(plan.id).toBe("plan-1");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.scope)).toBe(true);
  });

  it("rejects a model-proposed cross-company scope", () => {
    const candidate = validPlan({
      scope: {
        ...validPlan().scope,
        companyId: "company-b"
      }
    });

    expect(() => constructPlanProposal({
      candidate,
      request,
      authorizedSource: { type: "objective", referenceId: "objective-1" }
    })).toThrow();
  });

  it("rejects a model-proposed environment outside the authoritative request", () => {
    const candidate = validPlan({
      scope: {
        ...validPlan().scope,
        environment: "production"
      }
    });

    expect(() => constructPlanProposal({
      candidate,
      request,
      authorizedSource: { type: "objective", referenceId: "objective-1" }
    })).toThrow(/scope\/environment/i);
  });

  it("rejects a model-proposed source that was not authorized by GetDone", () => {
    expect(() => constructPlanProposal({
      candidate: validPlan(),
      request,
      authorizedSource: { type: "objective", referenceId: "objective-other" }
    })).toThrow();
  });
});
