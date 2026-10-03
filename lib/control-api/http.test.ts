import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlApiApplicationAdapter, ControlApiPrincipal } from "@/lib/control-api/contracts";
import {
  handleControlHealth,
  handleAIGatewayHealth,
  handleDiscoverResource,
  handleAdvanceResourceEnrollment,
  handleGetDecision,
  handleGetResourceEnrollment,
  handleGetJobResult,
  handleGetVerification,
  handleListDecisions,
  handleListJobs,
  handleListResourceEnrollments,
  handleListResources,
  handleListVerifications,
  handleMutateDecision,
  handleOwnerIntent,
  handleSubmitObjectives,
  handleListObjectives,
  handleGetObjective,
  handleStartResourceEnrollment,
  handleLogout,
  handleRevokeOtherSessions,
  handleVerifyStepUp
} from "@/lib/control-api/http";
import {
  installControlApiAdapter,
  resetControlApiAdapter
} from "@/lib/control-api/runtime.server";

const principal: ControlApiPrincipal = {
  actor: { type: "user", id: "user-a" },
  scope: {
    userId: "user-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "development"
  },
  sessionId: "session-a",
  role: "owner"
};

const objective = {
  id: "objective-1",
  objectiveId: "objective-1",
  correlationId: "corr-objective",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "development" as const,
  createdByUserId: "user-a",
  source: "free_text" as const,
  rawText: "Fix onboarding",
  normalizedGoal: "Fix onboarding",
  desiredOutcome: "Fix onboarding",
  constraints: [],
  priority: "normal" as const,
  successCriteria: [],
  riskLevel: "low" as const,
  status: "queued" as const,
  relationship: "independent" as const,
  dependsOnObjectiveIds: [],
  progress: [],
  createdAt: "2026-09-21T04:00:00Z",
  updatedAt: "2026-09-21T04:00:00Z",
  version: 1
};

const decision = {
  id: "decision-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  status: "pending" as const,
  version: 1,
  requiresStepUp: false,
  updatedAt: "2026-09-21T04:00:00Z"
};

const resource = {
  id: "resource-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  type: "compute" as const,
  state: "discovered" as const,
  environmentPermissions: ["development" as const],
  capabilityNames: [],
  failureDomainIds: [],
  credentialBindingIds: [],
  policyBindingIds: [],
  identityEvidenceIds: [],
  trustEvidenceIds: [],
  healthRecordIds: [],
  capabilityBindingIds: [],
  locationIds: [],
  costProfileIds: [],
  providerBindingIds: [],
  trustClass: "untrusted" as const,
  dataClassesAllowed: ["public" as const],
  createdAt: "2026-09-21T04:00:00Z",
  updatedAt: "2026-09-21T04:00:00Z",
  version: 1
};

const job = {
  id: "job-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  state: "succeeded" as const,
  taskId: "task-1",
  attempt: 1,
  verificationEvidenceIds: ["evidence-1"],
  verificationReceiptId: "receipt-1",
  verificationReceiptHash: "receipt-hash",
  version: 2,
  updatedAt: "2026-09-21T04:00:00Z"
};

const enrollment = {
  id: "enrollment-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  state: "identify" as const,
  requestedType: "compute" as const,
  requestedEnvironments: ["development" as const],
  ownerActionRequired: false,
  challengeHash: "challenge-hash",
  challengeIssuedAt: "2026-09-21T04:00:00Z",
  challengeExpiresAt: "2099-01-01T00:00:00Z",
  evidenceIds: [],
  attempt: 1,
  version: 1,
  updatedAt: "2026-09-21T04:00:00Z"
};

const verification = {
  id: "verification-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  state: "requested" as const,
  request: {
    id: "request-1"
  } as never,
  version: 1,
  updatedAt: "2026-09-21T04:00:00Z"
};

function fakeAdapter(): ControlApiApplicationAdapter {
  return {
    authenticate: async () => principal,
    beginStepUp: async () => ({
      challengeId: "00000000-0000-4000-8000-000000000002",
      expiresAt: "2099-01-01T00:00:00Z",
      method: "passkey",
      challenge: "dGVzdC1jaGFsbGVuZ2U",
      rpId: "getdone.test",
      allowCredentialIds: ["Y3JlZGVudGlhbC0x"],
      userVerification: "required"
    }),
    verifyStepUp: async () => ({
      session: {
        sessionId: "session-a",
        userId: "user-a",
        stepUpAuthenticatedAt: "2026-09-21T04:00:00Z"
      },
      expiresAt: "2099-01-01T00:00:00Z",
      rotatedSessionToken: "rotated-session-token"
    }),
    logout: async () => ({ sessionId: "session-a", revoked: true as const }),
    revokeOtherSessions: async () => ({
      sessionId: "session-a",
      revokedOtherSessions: 2
    }),
    health: async () => ({
      service: "getdone-control-api",
      surfaceVersion: "1.1.0",
      status: "ready",
      authConnected: true,
      persistenceConnected: true,
      aiGatewayAdapterInstalled: true,
      durableJobStoreConnected: true
    }),
    submitOwnerIntent: async (_principal, input) => ({
      id: "intent-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development",
      userId: "user-a",
      message: input.message,
      channel: input.channel ?? "chat",
      status: "accepted",
      receivedAt: "2026-09-21T04:00:00Z"
    }),
    submitObjectives: async (_principal, input) => [{
      ...objective,
      rawText: input.rawText,
      normalizedGoal: input.rawText.split(".")[0],
      desiredOutcome: input.rawText.split(".")[0]
    }],
    listObjectives: async () => [objective],
    getObjective: async (_principal, id) => id === objective.id ? objective : null,
    listDecisions: async () => [decision],
    getDecision: async (_principal, id) => id === decision.id ? decision : null,
    mutateDecision: async (_principal, input) => ({
      ...decision,
      status: input.action === "approve" ? "approved" : input.action === "modify" ? "modified" : "rejected",
      version: 2
    }),
    listResources: async () => [resource],
    getResource: async (_principal, id) => id === resource.id ? resource : null,
    discoverResource: async (_principal, input) => ({ ...resource, id: input.id, type: input.type }),
    listResourceEnrollments: async () => [enrollment],
    getResourceEnrollment: async (_principal, id) => id === enrollment.id ? enrollment : null,
    startResourceEnrollment: async (_principal, input) => ({
      ...enrollment,
      id: input.id,
      requestedType: input.requestedType
    }),
    advanceResourceEnrollment: async (_principal, id, input) => ({
      ...enrollment,
      id,
      state: input.action === "create" ? "create-enrollment" : enrollment.state
    }),
    listJobs: async () => [job],
    getJob: async (_principal, id) => id === job.id ? job : null,
    getJobResult: async (_principal, id) => id === job.id ? {
      jobId: job.id,
      state: job.state,
      verificationEvidenceIds: job.verificationEvidenceIds,
      verificationReceiptId: job.verificationReceiptId,
      verificationReceiptHash: job.verificationReceiptHash,
      explanation: {
        title: "Completed and verified",
        summary: "GetDone verified the intended outcome before marking this job successful.",
        reasons: ["Verification passed with 1 evidence item(s)."],
        authority: { capabilityNames: [] },
        verification: {
          status: "verified",
          evidenceCount: 1,
          receiptId: job.verificationReceiptId
        }
      }
    } : null,
    listVerifications: async () => [verification],
    getVerification: async (_principal, id) => id === verification.id ? verification : null
  };
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  process.env.GETDONE_RUNTIME_ENV = "development";
  process.env.GETDONE_WEBAUTHN_RP_ID = "localhost";
  process.env.GETDONE_WEBAUTHN_ORIGINS = "http://localhost";
  process.env.GETDONE_AUTH_COOKIE_NAME = "getdone_session";
  process.env.GETDONE_AUTH_COOKIE_SECURE = "false";
  installControlApiAdapter(fakeAdapter());
});

afterEach(() => {
  resetControlApiAdapter();
});

describe("Control API HTTP surface", () => {
  it("returns owner-safe AI Gateway health without exposing provider identities", async () => {
    const reader = async () => ({
      surfaceVersion: "1.0.0",
      configured: true,
      status: "ready" as const,
      activeRoutingPolicyVersion: "routing-v7",
      lastSuccessfulCanaryAt: "2026-09-23T08:00:00.000Z",
      primary: {
        configured: true,
        available: true,
        lastSuccessfulCallAt: "2026-09-23T08:10:00.000Z"
      },
      fallback: {
        configured: true,
        available: true,
        lastSuccessfulCallAt: "2026-09-23T08:05:00.000Z"
      },
      recentErrorClass: "MODEL_CALL_FAILED",
      budget: {
        configured: true,
        status: "healthy" as const,
        period: "2026-09",
        spentCents: 25,
        limitCents: 100,
        remainingCents: 75
      }
    });

    const response = await handleAIGatewayHealth(
      new Request("http://localhost/api/control/ai/health"),
      reader
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await json(response);
    expect(body).toMatchObject({
      ok: true,
      data: {
        configured: true,
        activeRoutingPolicyVersion: "routing-v7",
        primary: { available: true },
        fallback: { available: true },
        recentErrorClass: "MODEL_CALL_FAILED"
      }
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("modelId");
    expect(serialized).not.toContain("profileId");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("credential");
  });

  it("denies non-owner AI Gateway health access", async () => {
    installControlApiAdapter({
      ...fakeAdapter(),
      authenticate: async () => ({ ...principal, role: "viewer" as const })
    });
    let called = false;
    const response = await handleAIGatewayHealth(
      new Request("http://localhost/api/control/ai/health"),
      async () => {
        called = true;
        throw new Error("must not run");
      }
    );
    expect(response.status).toBe(403);
    expect(called).toBe(false);
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" }
    });
  });

  it("rotates the session cookie on step-up without serializing the token", async () => {
    const response = await handleVerifyStepUp(new Request(
      "http://localhost/api/control/auth/step-up/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: "00000000-0000-4000-8000-000000000002",
          credential: {
            id: "Y3JlZGVudGlhbC0x",
            type: "public-key",
            response: {
              clientDataJSON: "Y2xpZW50",
              authenticatorData: "YXV0aA",
              signature: "c2ln"
            }
          }
        })
      }
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("getdone_session=rotated-session-token");
    const value = await json(response);
    expect(value).toMatchObject({
      ok: true,
      data: { sessionId: "session-a", userId: "user-a" }
    });
    expect(JSON.stringify(value)).not.toContain("rotated-session-token");
  });

  it("revokes current and other device sessions through explicit session controls", async () => {
    const logout = await handleLogout(new Request("http://localhost/api/control/auth/logout", {
      method: "POST"
    }));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await json(logout)).toMatchObject({
      ok: true,
      data: { sessionId: "session-a", revoked: true }
    });

    const others = await handleRevokeOtherSessions(new Request(
      "http://localhost/api/control/auth/sessions/revoke-others",
      { method: "POST" }
    ));
    expect(await json(others)).toMatchObject({
      ok: true,
      data: { sessionId: "session-a", revokedOtherSessions: 2 }
    });
  });

  it("returns explicit health and no-store envelopes", async () => {
    const response = await handleControlHealth();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await json(response)).toMatchObject({
      ok: true,
      environment: "development",
      data: { service: "getdone-control-api", status: "ready" }
    });
  });

  it("defaults to fail-closed unavailable runtime when no adapter is installed", async () => {
    resetControlApiAdapter();
    const health = await handleControlHealth();
    expect(await json(health)).toMatchObject({
      ok: true,
      data: { status: "unavailable", persistenceConnected: false }
    });

    const blocked = await handleListDecisions(new Request("http://localhost/api/control/decisions"));
    expect(blocked.status).toBe(503);
    expect(await json(blocked)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" }
    });
  });

  it("accepts owner intent only with valid JSON and an idempotency key", async () => {
    const missingKey = await handleOwnerIntent(new Request("http://localhost/api/control/intents", {
      method: "POST",
      body: JSON.stringify({ message: "Move the company forward" })
    }));
    expect(missingKey.status).toBe(400);

    const invalid = await handleOwnerIntent(new Request("http://localhost/api/control/intents", {
      method: "POST",
      headers: { "idempotency-key": "intent-key-123" },
      body: "{not-json"
    }));
    expect(invalid.status).toBe(400);

    const schemaInvalid = await handleOwnerIntent(new Request("http://localhost/api/control/intents", {
      method: "POST",
      headers: { "idempotency-key": "intent-key-124" },
      body: JSON.stringify({ message: "" })
    }));
    expect(schemaInvalid.status).toBe(400);

    const accepted = await handleOwnerIntent(new Request("http://localhost/api/control/intents", {
      method: "POST",
      headers: { "idempotency-key": "intent-key-125" },
      body: JSON.stringify({ message: "Move the company forward", channel: "api" })
    }));
    expect(accepted.status).toBe(202);
    expect(await json(accepted)).toMatchObject({
      ok: true,
      data: { message: "Move the company forward", channel: "api", status: "accepted" }
    });
  });

  it("serves scoped Decision reads and mutation contracts", async () => {
    const list = await handleListDecisions(new Request("http://localhost/api/control/decisions"));
    expect(await json(list)).toMatchObject({ ok: true, data: [{ id: "decision-1" }] });

    const missing = await handleGetDecision(
      new Request("http://localhost/api/control/decisions/missing"),
      "missing"
    );
    expect(missing.status).toBe(404);

    const unsafe = await handleGetDecision(
      new Request("http://localhost/api/control/decisions/x"),
      "../other"
    );
    expect(unsafe.status).toBe(400);

    const invalidAction = await handleMutateDecision(
      new Request("http://localhost/api/control/decisions/decision-1", {
        method: "PATCH",
        headers: { "idempotency-key": "decision-key-1" },
        body: JSON.stringify({ action: "force" })
      }),
      "decision-1"
    );
    expect(invalidAction.status).toBe(400);

    const approved = await handleMutateDecision(
      new Request("http://localhost/api/control/decisions/decision-1", {
        method: "PATCH",
        headers: { "idempotency-key": "decision-key-2" },
        body: JSON.stringify({ action: "approve" })
      }),
      "decision-1"
    );
    expect(await json(approved)).toMatchObject({ ok: true, data: { status: "approved" } });
  });

  it("exposes Resource enrollment through the adapter instead of route-local persistence", async () => {
    const list = await handleListResources(new Request("http://localhost/api/control/resources"));
    expect(await json(list)).toMatchObject({ ok: true, data: [{ id: "resource-1" }] });

    const discovered = await handleDiscoverResource(new Request("http://localhost/api/control/resources", {
      method: "POST",
      headers: { "idempotency-key": "resource-key-1" },
      body: JSON.stringify({ id: "resource-new", type: "compute", capabilityNames: ["http"] })
    }));
    expect(discovered.status).toBe(201);
    expect(await json(discovered)).toMatchObject({ ok: true, data: { id: "resource-new", type: "compute" } });

    const started = await handleStartResourceEnrollment(new Request("http://localhost/api/control/resources/enroll", {
      method: "POST",
      headers: { "idempotency-key": "enrollment-key-1" },
      body: JSON.stringify({
        id: "enrollment-new",
        requestedType: "compute",
        ownerActionRequired: false,
        challengeToken: "one-time-challenge-value",
        challengeExpiresAt: "2099-01-01T00:00:00Z"
      })
    }));
    expect(started.status).toBe(201);
    expect(await json(started)).toMatchObject({ ok: true, data: { id: "enrollment-new", state: "identify" } });

    expect((await json(await handleListResourceEnrollments(
      new Request("http://localhost/api/control/resource-enrollments")
    )))).toMatchObject({ ok: true, data: [{ id: "enrollment-1" }] });

    expect(await json(await handleGetResourceEnrollment(
      new Request("http://localhost/api/control/resource-enrollments/enrollment-1"),
      "enrollment-1"
    ))).toMatchObject({ ok: true, data: { id: "enrollment-1" } });

    const advanced = await handleAdvanceResourceEnrollment(
      new Request("http://localhost/api/control/resource-enrollments/enrollment-1/actions", {
        method: "POST",
        headers: { "idempotency-key": "enrollment-key-2" },
        body: JSON.stringify({ action: "create" })
      }),
      "enrollment-1"
    );
    expect(await json(advanced)).toMatchObject({ ok: true, data: { state: "create-enrollment" } });
  });

  it("accepts and reads owner-facing Objectives through the Control API", async () => {
    const created = await handleSubmitObjectives(new Request(
      "http://localhost/api/control/objectives",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "objective-key-1"
        },
        body: JSON.stringify({
          rawText: "Fix onboarding. Deploy staging automatically. Ask me before production."
        })
      }
    ));
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      ok: true,
      data: [{ objectiveId: "objective-1", normalizedGoal: "Fix onboarding" }]
    });

    const list = await handleListObjectives(
      new Request("http://localhost/api/control/objectives")
    );
    expect(await json(list)).toMatchObject({
      ok: true,
      data: [{ id: "objective-1" }]
    });

    const one = await handleGetObjective(
      new Request("http://localhost/api/control/objectives/objective-1"),
      "objective-1"
    );
    expect(await json(one)).toMatchObject({
      ok: true,
      data: { normalizedGoal: "Fix onboarding" }
    });

    const missing = await handleGetObjective(
      new Request("http://localhost/api/control/objectives/missing"),
      "missing"
    );
    expect(missing.status).toBe(404);
  });

  it("exposes Jobs, verified result views, and Verification reads", async () => {
    expect(await json(await handleListJobs(
      new Request("http://localhost/api/control/jobs")
    ))).toMatchObject({ ok: true, data: [{ id: "job-1" }] });

    const result = await handleGetJobResult(
      new Request("http://localhost/api/control/jobs/job-1/result"),
      "job-1"
    );
    expect(await json(result)).toMatchObject({
      ok: true,
      data: { jobId: "job-1", state: "succeeded", verificationReceiptId: "receipt-1" }
    });

    expect(await json(await handleListVerifications(
      new Request("http://localhost/api/control/verifications")
    ))).toMatchObject({ ok: true, data: [{ id: "verification-1" }] });

    const missingVerification = await handleGetVerification(
      new Request("http://localhost/api/control/verifications/missing"),
      "missing"
    );
    expect(missingVerification.status).toBe(404);
  });
});
