import { z } from "zod";

export const CONTROL_API_SURFACE_VERSION = "1.5.0";
import {
  serializeClearedSessionCookie,
  serializeSessionCookie
} from "@/lib/auth/cookies";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import { ControlPlaneError, toControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId, readIdempotencyKey } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";
import { readOwnerAIGatewayHealth } from "@/lib/ai-gateway/health.server";
import {
  RATE_LIMIT_POLICIES,
  enforceRateLimit,
  rateLimitHeaders,
  tenantRateLimitKey
} from "@/lib/security/rate-limit.server";

const stepUpVerifySchema = z.object({
  challengeId: z.string().uuid(),
  credential: z.object({
    id: z.string().min(1).max(2048),
    type: z.literal("public-key").optional(),
    response: z.object({
      clientDataJSON: z.string().min(1).max(32_768),
      authenticatorData: z.string().min(1).max(8_192),
      signature: z.string().min(1).max(8_192),
      userHandle: z.string().max(4096).nullable().optional()
    })
  })
});

const ownerIntentSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  channel: z.enum(["chat", "api"]).optional()
});

const objectiveIntakeSchema = z.object({
  rawText: z.string().trim().min(1).max(100_000),
  source: z.enum([
    "free_text",
    "multiline_list",
    "checklist",
    "pasted_document",
    "uploaded_text",
    "structured_json"
  ]).optional(),
  fileName: z.string().trim().min(1).max(255).optional()
});

const decisionMutationSchema = z.object({
  action: z.enum(["approve", "modify", "reject"]),
  note: z.string().max(2_000).optional()
});

const preferenceSuggestionResolutionSchema = z.object({
  action: z.enum(["allow", "keep-asking", "never-suggest"])
});

const resourceDiscoverySchema = z.object({
  id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  type: z.enum(["compute", "gpu", "storage", "network", "cloud", "partner", "other"]),
  providerId: z.string().min(1).max(160).optional(),
  poolId: z.string().min(1).max(160).optional(),
  capabilityNames: z.array(z.string().min(1).max(160)).max(100).optional(),
  failureDomainIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  credentialBindingIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  policyBindingIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  region: z.string().min(1).max(160).optional(),
  architecture: z.string().min(1).max(160).optional()
});

const resourceEnrollmentStartSchema = z.object({
  id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  requestedType: z.enum(["compute", "gpu", "storage", "network", "cloud", "partner", "other"]),
  ownerActionRequired: z.boolean(),
  ownerActionDescription: z.string().min(1).max(2_000).optional(),
  challengeToken: z.string().min(16).max(512),
  challengeExpiresAt: z.string().datetime()
});

const resourceEnrollmentActionSchema = z.object({
  action: z.enum([
    "create", "owner-action", "authenticate", "discover", "profile", "validate",
    "test", "register", "ready", "fail", "cancel", "expire", "restart"
  ]),
  evidenceId: z.string().min(1).max(160).optional(),
  challengeToken: z.string().min(16).max(512).optional(),
  authenticatedAt: z.string().datetime().optional(),
  resourceId: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  reason: z.string().min(1).max(2_000).optional(),
  challengeExpiresAt: z.string().datetime().optional(),
  restartedAt: z.string().datetime().optional()
});

function safeId(value: string, label: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return value;
}

function requireIdempotencyKey(request: Request) {
  const value = readIdempotencyKey(request.headers);
  if (!value) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Idempotency-Key header is required");
  }
  return value;
}

async function jsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "Request body must be valid JSON");
  }
}

async function parseJson<T>(request: Request, schema: z.ZodType<T>, label: string): Promise<T> {
  const parsed = schema.safeParse(await jsonBody(request));
  if (!parsed.success) {
    throw new ControlPlaneError("VALIDATION_FAILED", `Invalid ${label} payload`);
  }
  return parsed.data;
}

async function executeWithHeaders<T>(
  operation: (
    adapter: ReturnType<typeof getControlApiAdapter>,
    correlationId: string
  ) => Promise<{ data: T; headers?: Record<string, string> }>,
  options: { status?: number } = {}
) {
  const correlationId = createCorrelationId();
  const environment = readServerRuntimeEnvironment();
  try {
    const adapter = getControlApiAdapter();
    const result = await operation(adapter, correlationId);
    return Response.json(apiSuccess(result.data, { correlationId, environment }), {
      status: options.status ?? 200,
      headers: {
        "cache-control": "no-store",
        "x-correlation-id": correlationId,
        ...(result.headers ?? {})
      }
    });
  } catch (error) {
    const normalized = toControlPlaneError(error, correlationId);
    return Response.json(
      apiFailure(normalized.code, normalized.message, { correlationId, environment }),
      {
        status: normalized.status,
        headers: {
          "cache-control": "no-store",
          "x-correlation-id": correlationId,
          ...rateLimitHeaders(normalized)
        }
      }
    );
  }
}

async function execute<T>(
  operation: (
    adapter: ReturnType<typeof getControlApiAdapter>,
    correlationId: string
  ) => Promise<T>,
  options: { status?: number } = {}
) {
  return executeWithHeaders(async (adapter, correlationId) => ({
    data: await operation(adapter, correlationId)
  }), options);
}


export function handleControlHealth() {
  return execute((adapter) => adapter.health());
}

export function handleAIGatewayHealth(
  request: Request,
  reader: typeof readOwnerAIGatewayHealth = readOwnerAIGatewayHealth
) {
  return execute(async (adapter) => {
    const principal = await adapter.authenticate(request);
    if (principal.role !== "owner") {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Owner role is required for AI Gateway health"
      );
    }
    return reader(principal.scope);
  });
}

export function handleBeginStepUp(request: Request) {
  return execute(async (adapter) => {
    const principal = await adapter.authenticate(request);
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.stepUpBegin,
      [
        ...tenantRateLimitKey({
          portfolioId: principal.scope.portfolioId,
          companyId: principal.scope.companyId,
          userId: principal.scope.userId,
          sessionId: principal.sessionId
        }, "step-up-begin")
      ]
    );
    return adapter.beginStepUp(request);
  }, { status: 201 });
}

export function handleVerifyStepUp(request: Request) {
  return executeWithHeaders(async (adapter) => {
    const principal = await adapter.authenticate(request);
    const input = await parseJson(request, stepUpVerifySchema, "step-up verification");
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.stepUpVerify,
      [
        ...tenantRateLimitKey({
          portfolioId: principal.scope.portfolioId,
          companyId: principal.scope.companyId,
          userId: principal.scope.userId,
          sessionId: principal.sessionId
        }, input.challengeId)
      ]
    );
    const result = await adapter.verifyStepUp(request, input.challengeId, input.credential);
    const config = readWebAuthnServerConfig();
    return {
      data: result.session,
      headers: {
        "set-cookie": serializeSessionCookie(
          config,
          result.rotatedSessionToken,
          result.expiresAt
        )
      }
    };
  });
}

export function handleLogout(request: Request) {
  return executeWithHeaders(async (adapter) => {
    const result = await adapter.logout(request);
    return {
      data: result,
      headers: {
        "set-cookie": serializeClearedSessionCookie(readWebAuthnServerConfig())
      }
    };
  });
}

export function handleRevokeOtherSessions(request: Request) {
  return execute((adapter) => adapter.revokeOtherSessions(request));
}

export function handleOwnerIntent(request: Request) {
  return execute(async (adapter, correlationId) => {
    const actor = await adapter.authenticate(request);
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.ownerIntent,
      tenantRateLimitKey({
        portfolioId: actor.scope.portfolioId,
        companyId: actor.scope.companyId,
        userId: actor.scope.userId,
      }, "owner-intent")
    );
    const input = await parseJson(request, ownerIntentSchema, "owner intent");
    return adapter.submitOwnerIntent(
      actor,
      input,
      requireIdempotencyKey(request),
      correlationId
    );
  }, { status: 202 });
}

export function handleSubmitObjectives(request: Request) {
  return execute(async (adapter, correlationId) => {
    const actor = await adapter.authenticate(request);
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.ownerIntent,
      tenantRateLimitKey({
        portfolioId: actor.scope.portfolioId,
        companyId: actor.scope.companyId,
        userId: actor.scope.userId,
      }, "objective-intake")
    );
    const input = await parseJson(request, objectiveIntakeSchema, "objective intake");
    return adapter.submitObjectives(
      actor,
      input,
      requireIdempotencyKey(request),
      correlationId
    );
  }, { status: 201 });
}

export function handleListObjectives(request: Request) {
  return execute(async (adapter) =>
    adapter.listObjectives(await adapter.authenticate(request))
  );
}

export function handleGetObjective(request: Request, objectiveId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getObjective(
      await adapter.authenticate(request),
      safeId(objectiveId, "objectiveId")
    );
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Objective was not found");
    return value;
  });
}

export function handleListPreferenceSuggestions(request: Request) {
  return execute(async (adapter) =>
    adapter.listPreferenceSuggestions(await adapter.authenticate(request))
  );
}

export function handleResolvePreferenceSuggestion(
  request: Request,
  suggestionId: string
) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.decisionMutation,
      tenantRateLimitKey({
        portfolioId: actor.scope.portfolioId,
        companyId: actor.scope.companyId,
        userId: actor.scope.userId
      }, safeId(suggestionId, "suggestionId"))
    );
    const body = await parseJson(
      request,
      preferenceSuggestionResolutionSchema,
      "preference suggestion resolution"
    );
    return adapter.resolvePreferenceSuggestion(
      actor,
      safeId(suggestionId, "suggestionId"),
      body.action
    );
  });
}

export function handleListConfirmedPreferenceRules(request: Request) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    const capability = new URL(request.url).searchParams.get("capability");
    if (!capability) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "capability query parameter is required"
      );
    }
    return adapter.listConfirmedPreferenceRules(
      actor,
      safeId(capability, "capability")
    );
  });
}

export function handleListDecisions(request: Request) {
  return execute(async (adapter) => adapter.listDecisions(await adapter.authenticate(request)));
}

export function handleGetDecision(request: Request, decisionId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getDecision(await adapter.authenticate(request), safeId(decisionId, "decisionId"));
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Decision was not found");
    return value;
  });
}

export function handleMutateDecision(request: Request, decisionId: string) {
  return execute(async (adapter, correlationId) => {
    const actor = await adapter.authenticate(request);
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.decisionMutation,
      tenantRateLimitKey({
        portfolioId: actor.scope.portfolioId,
        companyId: actor.scope.companyId,
        userId: actor.scope.userId,
      }, safeId(decisionId, "decisionId"))
    );
    const body = await parseJson(request, decisionMutationSchema, "decision mutation");
    return adapter.mutateDecision(actor, {
      decisionId: safeId(decisionId, "decisionId"),
      action: body.action,
      note: body.note,
      idempotencyKey: requireIdempotencyKey(request)
    }, correlationId);
  });
}

export function handleListResources(request: Request) {
  return execute(async (adapter) => adapter.listResources(await adapter.authenticate(request)));
}

export function handleGetResource(request: Request, resourceId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getResource(await adapter.authenticate(request), safeId(resourceId, "resourceId"));
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Resource was not found");
    return value;
  });
}

export function handleDiscoverResource(request: Request) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.enrollmentMutation,
      tenantRateLimitKey({
        portfolioId: actor.scope.portfolioId,
        companyId: actor.scope.companyId,
        userId: actor.scope.userId,
      }, "resource-discovery")
    );
    const body = await parseJson(request, resourceDiscoverySchema, "resource discovery");
    return adapter.discoverResource(actor, {
      ...body,
      idempotencyKey: requireIdempotencyKey(request)
    });
  }, { status: 201 });
}

export function handleListResourceEnrollments(request: Request) {
  return execute(async (adapter) =>
    adapter.listResourceEnrollments(await adapter.authenticate(request))
  );
}

export function handleGetResourceEnrollment(request: Request, enrollmentId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getResourceEnrollment(
      await adapter.authenticate(request),
      safeId(enrollmentId, "enrollmentId")
    );
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Resource enrollment was not found");
    return value;
  });
}

export function handleStartResourceEnrollment(request: Request) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.enrollmentMutation,
      tenantRateLimitKey({
        portfolioId: actor.scope.portfolioId,
        companyId: actor.scope.companyId,
        userId: actor.scope.userId,
      }, "resource-enrollment-start")
    );
    const body = await parseJson(request, resourceEnrollmentStartSchema, "resource enrollment");
    return adapter.startResourceEnrollment(actor, {
      ...body,
      idempotencyKey: requireIdempotencyKey(request)
    });
  }, { status: 201 });
}

export function handleAdvanceResourceEnrollment(request: Request, enrollmentId: string) {
  return execute(async (adapter) => {
    const actor = await adapter.authenticate(request);
    await enforceRateLimit(
      RATE_LIMIT_POLICIES.enrollmentMutation,
      tenantRateLimitKey({
        portfolioId: actor.scope.portfolioId,
        companyId: actor.scope.companyId,
        userId: actor.scope.userId,
      }, safeId(enrollmentId, "enrollmentId"))
    );
    const body = await parseJson(request, resourceEnrollmentActionSchema, "resource enrollment action");
    return adapter.advanceResourceEnrollment(
      actor,
      safeId(enrollmentId, "enrollmentId"),
      { ...body, idempotencyKey: requireIdempotencyKey(request) }
    );
  });
}

export function handleListJobs(request: Request) {
  return execute(async (adapter) => adapter.listJobs(await adapter.authenticate(request)));
}

export function handleGetJob(request: Request, jobId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getJob(await adapter.authenticate(request), safeId(jobId, "jobId"));
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Job was not found");
    return value;
  });
}

export function handleGetJobResult(request: Request, jobId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getJobResult(await adapter.authenticate(request), safeId(jobId, "jobId"));
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Job result was not found");
    return value;
  });
}

export function handleListVerifications(request: Request) {
  return execute(async (adapter) => adapter.listVerifications(await adapter.authenticate(request)));
}

export function handleGetVerification(request: Request, verificationId: string) {
  return execute(async (adapter) => {
    const value = await adapter.getVerification(
      await adapter.authenticate(request),
      safeId(verificationId, "verificationId")
    );
    if (!value) throw new ControlPlaneError("NOT_FOUND", "Verification was not found");
    return value;
  });
}
