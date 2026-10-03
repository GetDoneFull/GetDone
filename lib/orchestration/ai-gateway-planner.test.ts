import { describe, expect, it } from "vitest";
import { AIGateway } from "@/lib/ai-gateway/gateway";
import { DevelopmentMockAIGatewayAdapter } from "@/lib/ai-gateway/development-mock-adapter";
import type { ModelProfile, ModelRoutePolicy } from "@/lib/ai-gateway/contracts";
import { AIGatewayDurablePlanner } from "@/lib/orchestration/ai-gateway-planner";
import {
  createOwnerIntentContextSnapshot,
  createOwnerIntentOrchestrationRun
} from "@/lib/orchestration/owner-intent-flow";
import { createPlannerInputEnvelope } from "@/lib/orchestration/planning-flow";
import { transitionOrchestrationRun } from "@/lib/orchestration/contracts";
import { assembleContext } from "@/lib/intelligence/context";
import { validPlan } from "@/lib/planning/test-fixture";

const profile: ModelProfile = {
  id: "planner-profile",
  gatewayId: "mock-gateway",
  providerId: "mock-provider",
  modelId: "mock-model",
  enabled: true,
  validationStatus: "validated",
  roles: ["HIGH_REASONING"],
  modalities: ["text"],
  supportsTools: false,
  supportsStructuredOutput: true,
  maxContextTokens: 128000,
  allowedDataClasses: ["INTERNAL"],
  allowedEnvironments: ["development"],
  health: "healthy",
  latencyClass: "standard",
  inputCostPerMillionTokensCents: 1,
  outputCostPerMillionTokensCents: 1,
  profileVersion: "1"
};

const policy: ModelRoutePolicy = {
  version: "1",
  routes: { HIGH_REASONING: [profile.id] }
};

function plannerInput() {
  const intent = {
    id: "intent-ai-planner",
    correlationId: "correlation-ai-planner",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "development" as const,
    userId: "owner-a",
    message: "plan growth",
    channel: "chat" as const,
    status: "accepted" as const,
    receivedAt: "2026-09-28T12:00:00.000Z"
  };
  const accepted = createOwnerIntentOrchestrationRun(intent);
  const assembled = assembleContext([{
    id: "fact-1",
    kind: "fact",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    source: "test",
    provenance: "verified:test",
    observedAt: "2026-09-28T11:59:59.000Z",
    freshnessSeconds: 60,
    sensitivity: "internal",
    content: "Verified internal fact."
  }], {
    portfolioId: "portfolio-a",
    companyId: "company-a",
    allowedSensitivity: ["public", "internal"]
  }, {
    now: Date.parse("2026-09-28T12:00:00.000Z")
  });
  const snapshot = createOwnerIntentContextSnapshot({
    run: accepted,
    intent,
    assembledContext: assembled,
    createdAt: "2026-09-28T12:00:00.000Z"
  });
  const contextReady = transitionOrchestrationRun(accepted, {
    to: "context-ready",
    now: "2026-09-28T12:00:01.000Z",
    checkpointPatch: {
      contextSnapshot: { id: snapshot.id, hash: snapshot.snapshotHash }
    }
  });
  return {
    input: createPlannerInputEnvelope({
      run: contextReady,
      snapshot,
      createdAt: "2026-09-28T12:00:02.000Z"
    }),
    intent
  };
}

describe("AIGatewayDurablePlanner", () => {
  it("passes only frozen PlannerInput to the AI Gateway and requires structured PlanProposal output", async () => {
    const { input, intent } = plannerInput();
    let captured: unknown;
    const adapter = new DevelopmentMockAIGatewayAdapter((call) => {
      captured = call.input;
      return validPlan({
        id: "plan-ai",
        scope: {
          portfolioId: intent.portfolioId,
          companyId: intent.companyId,
          environment: intent.environment,
          dataClass: "internal"
        },
        source: {
          type: "owner-request",
          requestId: intent.id
        },
        objective: undefined,
        createdAt: "2026-09-28T12:00:03.000Z"
      });
    });
    const gateway = new AIGateway([profile], policy, adapter);
    const planner = new AIGatewayDurablePlanner(
      gateway,
      {
        snapshot: async () => ({
          portfolioId: input.scope.portfolioId,
          companyId: input.scope.companyId,
          period: "2026-09",
          companyRemainingCents: 1000,
          portfolioRemainingCents: 1000,
          activeConcurrentCalls: 0,
          concurrencyLimit: 4,
          snapshotAt: "2026-09-28T11:59:00.000Z",
          expiresAt: "2026-09-28T12:10:00.000Z"
        })
      },
      {},
      () => new Date("2026-09-28T12:00:03.000Z")
    );

    const result = await planner.propose({
      requestId: "planner-request-1",
      idempotencyKey: "planner-idem-1",
      plannerInput: input
    });

    expect(result.kind).toBe("success");
    expect(captured).toMatchObject({
      operation: "construct-plan-proposal",
      plannerInput: input
    });
    expect(planner.descriptor).toEqual({
      snapshotOnlyInput: true,
      deterministicRequestIdentity: true,
      structuredPlanOutput: true
    });
  });

  it("maps unavailable model routing into a non-retryable planner result", async () => {
    const { input } = plannerInput();
    const gateway = new AIGateway(
      [{ ...profile, enabled: false }],
      policy,
      new DevelopmentMockAIGatewayAdapter(() => ({ bad: true }))
    );
    const planner = new AIGatewayDurablePlanner(gateway, {
      snapshot: async () => ({
        portfolioId: input.scope.portfolioId,
        companyId: input.scope.companyId,
        period: "2026-09",
        companyRemainingCents: 1000,
        portfolioRemainingCents: 1000,
        activeConcurrentCalls: 0,
        concurrencyLimit: 4,
        snapshotAt: "2026-09-28T11:59:00.000Z",
        expiresAt: "2026-09-28T12:10:00.000Z"
      })
    });

    const result = await planner.propose({
      requestId: "planner-request-2",
      idempotencyKey: "planner-idem-2",
      plannerInput: input
    });

    expect(result).toMatchObject({
      kind: "unavailable",
      code: "NO_ELIGIBLE_MODEL",
      retryable: false
    });
  });
});
