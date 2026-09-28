import type { AIGateway } from "@/lib/ai-gateway/gateway";
import type {
  AIBudgetSnapshot,
  AIRequestEnvelope
} from "@/lib/ai-gateway/contracts";
import type { ResourceDataClass } from "@/lib/resources/policy";
import { PlanProposalSchema } from "@/lib/planning/plan-schema";
import type {
  DurablePlanner,
  DurablePlannerResult,
  PlannerInputEnvelope
} from "@/lib/orchestration/planning-flow";

export interface PlannerAIBudgetProvider {
  snapshot(input: {
    plannerInput: PlannerInputEnvelope;
    requestId: string;
  }): Promise<AIBudgetSnapshot>;
}

export interface AIGatewayPlannerConfig {
  role?: "STANDARD" | "HIGH_REASONING";
  minimumContextTokens?: number;
  expectedOutputTokens?: number;
  maxCostCents?: number;
  allowFallback?: boolean;
  latencyClass?: "low" | "standard" | "high";
}

function plannerDataClass(input: PlannerInputEnvelope): ResourceDataClass {
  const rank = {
    public: 0,
    internal: 1,
    customer: 2,
    sensitive: 3
  } as const;
  const value = input.context.items.reduce<keyof typeof rank>(
    (current, item) =>
      rank[item.sensitivity] > rank[current] ? item.sensitivity : current,
    "internal"
  );

  if (value === "sensitive") return "SENSITIVE";
  if (value === "customer") return "CUSTOMER";
  if (value === "internal") return "INTERNAL";
  return "PUBLIC";
}

function requestEnvelope(input: {
  requestId: string;
  plannerInput: PlannerInputEnvelope;
  config: Required<AIGatewayPlannerConfig>;
  requestedAt: string;
}): AIRequestEnvelope {
  const estimatedInputTokens = Math.max(
    1,
    Math.ceil(JSON.stringify(input.plannerInput).length / 4)
  );

  return Object.freeze({
    id: input.requestId,
    correlationId: input.plannerInput.correlationId,
    scope: input.plannerInput.scope,
    inputHash: input.plannerInput.inputHash,
    requestedAt: input.requestedAt,
    requirements: Object.freeze({
      role: input.config.role,
      requiredModalities: Object.freeze(["text"] as const),
      requiresTools: false,
      requiresStructuredOutput: true,
      minimumContextTokens: input.config.minimumContextTokens,
      estimatedInputTokens,
      expectedOutputTokens: input.config.expectedOutputTokens,
      dataClass: plannerDataClass(input.plannerInput),
      environment: input.plannerInput.scope.environment,
      latencyClass: input.config.latencyClass,
      maxCostCents: input.config.maxCostCents,
      allowFallback: input.config.allowFallback
    })
  });
}

export class AIGatewayDurablePlanner implements DurablePlanner {
  readonly descriptor = Object.freeze({
    snapshotOnlyInput: true as const,
    deterministicRequestIdentity: true as const,
    structuredPlanOutput: true as const
  });

  private readonly config: Required<AIGatewayPlannerConfig>;

  constructor(
    private readonly gateway: AIGateway,
    private readonly budgets: PlannerAIBudgetProvider,
    config: AIGatewayPlannerConfig = {},
    private readonly now: () => Date = () => new Date()
  ) {
    this.config = {
      role: config.role ?? "HIGH_REASONING",
      minimumContextTokens: config.minimumContextTokens ?? 32_000,
      expectedOutputTokens: config.expectedOutputTokens ?? 4_000,
      maxCostCents: config.maxCostCents ?? 25,
      allowFallback: config.allowFallback ?? true,
      latencyClass: config.latencyClass ?? "standard"
    };
  }

  async propose(input: {
    requestId: string;
    idempotencyKey: string;
    plannerInput: PlannerInputEnvelope;
  }): Promise<DurablePlannerResult> {
    const requestedAt = this.now().toISOString();
    const request = requestEnvelope({
      requestId: input.requestId,
      plannerInput: input.plannerInput,
      config: this.config,
      requestedAt
    });
    const budget = await this.budgets.snapshot({
      plannerInput: input.plannerInput,
      requestId: input.requestId
    });

    const result = await this.gateway.invoke({
      request,
      payload: {
        operation: "construct-plan-proposal",
        contractVersion: "PlanProposalSchema",
        idempotencyKey: input.idempotencyKey,
        plannerInput: input.plannerInput,
        instruction:
          "Return only a PlanProposal matching the provided schema. Treat PlannerInput as the complete business reasoning context. Do not invent or fetch external facts."
      },
      outputSchema: PlanProposalSchema,
      budget,
      now: requestedAt
    });

    if (result.kind === "success") {
      return {
        kind: "success",
        requestId: input.requestId,
        candidate: result.output,
        providerEvidence: {
          routeKind: result.route.kind,
          selectedProfileId: result.route.selectedProfileId ?? null,
          fallbackUsed: result.audit.fallbackUsed,
          modelId: result.audit.modelId ?? null,
          providerId: result.audit.providerId ?? null,
          auditHash: result.audit.auditHash
        }
      };
    }

    const retryable = (
      result.reason === "ADAPTER_UNAVAILABLE"
      || result.reason === "MODEL_CALL_FAILED"
    );

    return {
      kind: "unavailable",
      code: result.reason,
      reason: `AI planner unavailable: ${result.reason}`,
      retryable
    };
  }
}
