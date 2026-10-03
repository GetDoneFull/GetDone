import { describe, expect, it } from "vitest";
import type { AuthAdapter, AuthSession } from "@/lib/auth/contracts";
import { createStepUpProof } from "@/lib/authorization/proofs";
import type { AuditLedger } from "@/lib/domain/audit";
import type { DecisionAuthorityStore, AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { DecisionTransaction, DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import { ServiceBackedControlApiAdapter } from "@/lib/control-api/service-adapter";
import { ResourceRegistryService } from "@/lib/domain/services/resource-registry-service";
import { ResourceEnrollmentService, type ResourceEnrollmentRecord } from "@/lib/resources/enrollment";
import type { Resource } from "@/lib/domain/resources";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";

const session: AuthSession = {
  sessionId: "session-a",
  userId: "user-a",
  issuedAt: "2026-09-21T03:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
  authenticatedAt: "2026-09-21T03:00:00Z",
  stepUpAuthenticatedAt: "2026-09-21T03:59:00Z"
};

const scope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "development" as const
};

const objective: ObjectiveRecord = {
  id: "objective-1",
  objectiveId: "objective-1",
  correlationId: "corr-objective",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "development",
  createdByUserId: "user-a",
  source: "free_text",
  rawText: "Fix onboarding",
  normalizedGoal: "Fix onboarding",
  desiredOutcome: "Fix onboarding",
  constraints: [],
  priority: "normal",
  successCriteria: [],
  riskLevel: "low",
  status: "queued",
  relationship: "independent",
  dependsOnObjectiveIds: [],
  progress: [],
  createdAt: "2026-09-21T04:00:00Z",
  updatedAt: "2026-09-21T04:00:00Z",
  version: 1
};

function auth(): AuthAdapter {
  return {
    getSession: async () => session,
    revokeSession: async () => undefined,
    revokeOtherSessions: async () => 0,
    beginStepUp: async () => ({
      challengeId: "00000000-0000-4000-8000-000000000001",
      expiresAt: "2099-01-01T00:00:00Z",
      method: "passkey",
      challenge: "dGVzdC1jaGFsbGVuZ2U",
      rpId: "getdone.test",
      allowCredentialIds: ["Y3JlZGVudGlhbC0x"],
      userVerification: "required"
    }),
    verifyStepUp: async () => ({ session, token: "rotated-session-token" })
  };
}

class MemoryDecisionManager implements DecisionTransactionManager {
  decision: AuthoritativeDecision = {
    id: "decision-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    status: "pending",
    version: 1,
    requiresStepUp: true,
    updatedAt: "2026-09-21T04:00:00Z"
  };
  private readonly idempotency = new MemoryIdempotencyStore();

  async run<T>(operation: (transaction: DecisionTransaction) => Promise<T>): Promise<T> {
    const store: DecisionAuthorityStore = {
      get: async (id) => id === this.decision.id ? { ...this.decision } : null,
      save: async (next, expectedVersion) => {
        if (this.decision.version !== expectedVersion) throw new Error("version conflict");
        this.decision = { ...next };
      }
    };
    const audit: AuditLedger = {
      append: async () => undefined,
      listByCorrelationId: async () => []
    };
    return operation({
      stores: { decisions: store },
      audit,
      idempotency: this.idempotency
    });
  }
}

function resource(id = "resource-1", companyId = "company-a"): Resource {
  return {
    id,
    portfolioId: "portfolio-a",
    companyId,
    type: "compute",
    state: "discovered",
    environmentPermissions: ["development"],
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
    trustClass: "untrusted",
    dataClassesAllowed: ["public"],
    createdAt: "2026-09-21T04:00:00Z",
    updatedAt: "2026-09-21T04:00:00Z",
    version: 1
  };
}

function adapter(overrides: Partial<ConstructorParameters<typeof ServiceBackedControlApiAdapter>[0]> = {}) {
  const decisionTransactions = new MemoryDecisionManager();
  let capturedDiscovery: {
    input: Parameters<ResourceRegistryService["discover"]>[0];
    command: Parameters<ResourceRegistryService["discover"]>[1];
  } | undefined;
  const resourceRegistry = {
    discover: async (
      input: Parameters<ResourceRegistryService["discover"]>[0],
      command: Parameters<ResourceRegistryService["discover"]>[1]
    ) => {
      capturedDiscovery = { input, command };
      return resource(input.id);
    }
  } as unknown as ResourceRegistryService;

  const enrollmentRecord: ResourceEnrollmentRecord = {
    id: "enrollment-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    state: "identify",
    requestedType: "compute",
    requestedEnvironments: ["development"],
    ownerActionRequired: false,
    challengeHash: "challenge-hash",
    challengeIssuedAt: "2026-09-21T04:00:00Z",
    challengeExpiresAt: "2099-01-01T00:00:00Z",
    evidenceIds: [],
    attempt: 1,
    version: 1,
    updatedAt: "2026-09-21T04:00:00Z"
  };
  let enrollmentAction = "";
  const resourceEnrollmentService = {
    identify: async (
      input: Parameters<ResourceEnrollmentService["identify"]>[0]
    ) => ({ ...enrollmentRecord, id: input.id, requestedType: input.requestedType }),
    createEnrollment: async () => {
      enrollmentAction = "create";
      return { ...enrollmentRecord, state: "create-enrollment" as const };
    },
    recordOwnerAction: async () => enrollmentRecord,
    authenticate: async () => enrollmentRecord,
    discover: async () => enrollmentRecord,
    profile: async () => enrollmentRecord,
    validate: async () => enrollmentRecord,
    test: async () => enrollmentRecord,
    register: async () => enrollmentRecord,
    markReady: async () => enrollmentRecord,
    fail: async () => enrollmentRecord,
    cancel: async () => enrollmentRecord,
    expire: async () => enrollmentRecord,
    restart: async () => enrollmentRecord
  } as unknown as ResourceEnrollmentService;

  const instance = new ServiceBackedControlApiAdapter({
    auth: auth(),
    scopes: { resolve: async () => ({ scope, role: "owner" as const }) },
    authorizationEvidence: {
      resolveStepUpProof: async () => createStepUpProof({
        id: "step-up-1",
        actorId: "user-a",
        scope,
        method: "passkey",
        authenticatedAt: "2026-09-21T03:59:00Z",
        expiresAt: "2099-01-01T00:00:00Z"
      })
    },
    intents: { create: async (record) => record },
    objectives: {
      listByScope: async () => [objective],
      get: async (id) => id === objective.id ? objective : null
    },
    objectiveIntake: {
      createBatch: async (records) => records
    },
    decisions: {
      listByScope: async () => [decisionTransactions.decision],
      get: async (id) => id === "decision-1" ? decisionTransactions.decision : null
    },
    decisionTransactions,
    resources: {
      listByScope: async () => [resource()],
      get: async (id) => id === "foreign" ? resource("foreign", "company-b") : id === "resource-1" ? resource() : null
    },
    resourceRegistry,
    resourceEnrollments: {
      listByScope: async () => [enrollmentRecord],
      get: async (id) => id === enrollmentRecord.id ? enrollmentRecord : null
    },
    resourceEnrollmentService,
    jobs: {
      listByScope: async () => [],
      get: async (id) => id === "job-1" ? ({
        id,
        portfolioId: "portfolio-a",
        companyId: "company-a",
        state: "succeeded",
        taskId: "task-1",
        attempt: 1,
        verificationEvidenceIds: ["evidence-1"],
        verificationReceiptId: "receipt-1",
        authorizationGrantId: "grant-1",
        authorizationGrantHash: "grant-hash",
        authorizationDisposition: "AUTO",
        capabilityNames: ["deployment.staging.publish"],
        policySnapshotId: "policy-snapshot-1",
        policySnapshotHash: "policy-snapshot-hash",
        policyVersion: "policy-v7",
        policyEngineVersion: "2026-09-28.1",
        policyRulesHash: "policy-rules-hash",
        version: 2,
        updatedAt: "2026-09-21T04:00:00Z"
      }) : null
    },
    verifications: {
      listByScope: async () => [],
      get: async () => null
    },
    health: async () => ({
      service: "getdone-control-api",
      surfaceVersion: "1.1.0",
      status: "ready",
      authConnected: true,
      persistenceConnected: true,
      aiGatewayAdapterInstalled: false,
      durableJobStoreConnected: false
    }),
    now: () => new Date("2026-09-21T04:00:00Z"),
    ...overrides
  });

  return {
    instance,
    decisionTransactions,
    discovery: () => capturedDiscovery,
    enrollmentAction: () => enrollmentAction
  };
}

describe("ServiceBackedControlApiAdapter", () => {
  it("derives principal scope and step-up proof from server-side adapters", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    expect(principal).toMatchObject({
      actor: { type: "user", id: "user-a" },
      scope,
      sessionId: "session-a",
      role: "owner",
      stepUpProof: { id: "step-up-1" }
    });
  });

  it("rejects a trusted scope that does not belong to the authenticated session", async () => {
    const { instance } = adapter({
      scopes: {
        resolve: async () => ({
          scope: { ...scope, userId: "different-user" },
          role: "owner" as const
        })
      }
    });
    await expect(instance.authenticate(new Request("http://localhost"))).rejects.toThrow(/scope is incomplete/i);
  });

  it("stores owner intent as non-executing accepted input", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    const intent = await instance.submitOwnerIntent(principal, { message: "Investigate churn" }, "intent-key");
    expect(intent).toMatchObject({
      portfolioId: "portfolio-a",
      companyId: "company-a",
      status: "accepted",
      message: "Investigate churn",
      receivedAt: "2026-09-21T04:00:00.000Z"
    });
  });

  it("normalizes owner language into authoritative objectives without exposing task/job input", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    const objectives = await instance.submitObjectives(
      principal,
      {
        rawText: "Fix onboarding. Make safe fixes yourself. Deploy staging automatically. Ask me before production."
      },
      "objective-key-1",
      "corr-objective"
    );
    expect(objectives).toHaveLength(1);
    expect(objectives[0]).toMatchObject({
      portfolioId: "portfolio-a",
      companyId: "company-a",
      createdByUserId: "user-a",
      normalizedGoal: "Fix onboarding",
      constraints: [
        "Make safe fixes yourself",
        "Deploy staging automatically",
        "Ask me before production"
      ],
      riskLevel: "high"
    });
    expect(await instance.listObjectives(principal)).toEqual([objective]);
    expect(await instance.getObjective(principal, "objective-1")).toEqual(objective);
  });

  it("passes authoritative server-resolved step-up proof into Decision mutation", async () => {
    const { instance, decisionTransactions } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    const result = await instance.mutateDecision(principal, {
      decisionId: "decision-1",
      action: "approve",
      idempotencyKey: "decision-key-1"
    });
    expect(result.status).toBe("approved");
    expect(decisionTransactions.decision.status).toBe("approved");
  });

  it("hides cross-company entities as NOT_FOUND", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    await expect(instance.getResource(principal, "foreign")).rejects.toThrow(/not found/i);
    expect(await instance.getResource(principal, "missing")).toBeNull();
  });

  it("delegates Resource discovery with environment/data scope narrowed by trusted principal", async () => {
    const { instance, discovery } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    const enrolled = await instance.discoverResource(principal, {
      id: "resource-new",
      type: "compute",
      capabilityNames: ["http"],
      idempotencyKey: "resource-key-1"
    });
    expect(enrolled.id).toBe("resource-new");
    expect(discovery()!.input).toMatchObject({
      environmentPermissions: ["development"],
      dataClassesAllowed: ["public"]
    });
    expect(discovery()!.command.scope).toEqual(scope);
  });

  it("delegates governed Resource Enrollment initiation and actions", async () => {
    const { instance, enrollmentAction } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    const started = await instance.startResourceEnrollment(principal, {
      id: "enrollment-new",
      requestedType: "compute",
      ownerActionRequired: false,
      challengeToken: "one-time-challenge-value",
      challengeExpiresAt: "2099-01-01T00:00:00Z",
      idempotencyKey: "enrollment-key-1"
    });
    expect(started).toMatchObject({
      id: "enrollment-new",
      requestedEnvironments: ["development"],
      requestedType: "compute"
    });

    const advanced = await instance.advanceResourceEnrollment(
      principal,
      "enrollment-1",
      { action: "create", idempotencyKey: "enrollment-key-2" }
    );
    expect(advanced.state).toBe("create-enrollment");
    expect(enrollmentAction()).toBe("create");
    expect(await instance.listResourceEnrollments(principal)).toHaveLength(1);
    expect(await instance.getResourceEnrollment(principal, "enrollment-1")).toMatchObject({
      id: "enrollment-1"
    });
  });

  it("derives Job result views from authoritative Job state", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    expect(await instance.getJobResult(principal, "job-1")).toMatchObject({
      jobId: "job-1",
      state: "succeeded",
      verificationEvidenceIds: ["evidence-1"],
      verificationReceiptId: "receipt-1",
      explanation: {
        title: "Completed and verified",
        authority: {
          disposition: "AUTO",
          capabilityNames: ["deployment.staging.publish"],
          policyVersion: "policy-v7"
        },
        verification: {
          status: "verified",
          evidenceCount: 1
        }
      }
    });
    expect(await instance.getJobResult(principal, "missing")).toBeNull();
  });

  it("exposes health and scoped list/read seams without embedding persistence", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    expect((await instance.health()).status).toBe("ready");
    expect(await instance.listDecisions(principal)).toHaveLength(1);
    expect(await instance.getDecision(principal, "missing")).toBeNull();
    expect(await instance.listResources(principal)).toHaveLength(1);
    expect(await instance.listJobs(principal)).toEqual([]);
    expect(await instance.listVerifications(principal)).toEqual([]);
    expect(await instance.getVerification(principal, "missing")).toBeNull();
  });
  it("denies privileged Control API mutations to viewer membership", async () => {
    const { instance } = adapter({
      scopes: { resolve: async () => ({ scope, role: "viewer" as const }) }
    });
    const principal = await instance.authenticate(new Request("http://localhost"));
    expect(() => instance.mutateDecision(principal, {
      decisionId: "decision-1",
      action: "approve",
      idempotencyKey: "viewer-decision"
    })).toThrow(/elevated Control API role/i);
    expect(() => instance.discoverResource(principal, {
      id: "resource-viewer",
      type: "compute",
      idempotencyKey: "viewer-resource"
    })).toThrow(/elevated Control API role/i);
  });

});
