import { describe, expect, it } from "vitest";
import {
  assertVerificationReceipt,
  createVerificationContract,
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest
} from "@/lib/verification/verification";

const scope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const
};

const requestedAt = "2026-09-20T19:30:00Z";
const now = "2026-09-20T19:31:00Z";

function request() {
  return createVerificationRequest({
    id: "verify-request-1",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    environment: scope.environment,
    subject: { type: "job", id: "job-1" },
    strategies: ["execution", "system"],
    requiresIndependentEvidence: true,
    executionIndependenceKey: "worker:worker-1",
    maxEvidenceAgeSeconds: 600,
    requestedAt,
    expiresAt: "2026-09-20T20:00:00Z"
  });
}

function evidence(
  strategy: "execution" | "system",
  overrides: Partial<Parameters<typeof createVerificationEvidence>[0]> = {}
) {
  return createVerificationEvidence({
    id: "evidence-" + strategy,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    subject: { type: "job", id: "job-1" },
    strategy,
    result: "pass",
    sourceType: "system-probe",
    sourceId: "verifier-1",
    independenceKey: "verifier:independent-1",
    observedAt: now,
    expiresAt: "2026-09-20T19:40:00Z",
    payloadHash: "payload-" + strategy,
    provenance: "unit-test",
    ...overrides
  });
}

describe("verification receipts", () => {
  it("creates a hash-bound verified receipt only from fresh matching evidence", () => {
    const receipt = resolveVerificationRequest(
      request(),
      [evidence("execution"), evidence("system")],
      { receiptId: "receipt-1", verifiedAt: now, receiptTtlSeconds: 300 }
    );

    expect(receipt.verdict).toBe("verified");
    expect(receipt.evidenceIds).toHaveLength(2);
    expect(() => assertVerificationReceipt(receipt, {
      scope,
      subject: { type: "job", id: "job-1" },
      now: Date.parse("2026-09-20T19:32:00Z")
    })).not.toThrow();
  });

  it("does not accept evidence from the same execution independence domain", () => {
    const receipt = resolveVerificationRequest(
      request(),
      [
        evidence("execution", { independenceKey: "worker:worker-1" }),
        evidence("system", { independenceKey: "worker:worker-1" })
      ],
      { receiptId: "receipt-2", verifiedAt: now }
    );

    expect(receipt.verdict).toBe("uncertain");
  });

  it("fails when fresh authoritative evidence reports failure", () => {
    const receipt = resolveVerificationRequest(
      request(),
      [
        evidence("execution"),
        evidence("system", { result: "fail" })
      ],
      { receiptId: "receipt-3", verifiedAt: now }
    );

    expect(receipt.verdict).toBe("failed");
  });

  it("rejects cross-company evidence", () => {
    expect(() => resolveVerificationRequest(
      request(),
      [
        evidence("execution"),
        evidence("system", { companyId: "company-b" })
      ],
      { receiptId: "receipt-4", verifiedAt: now }
    )).toThrow();
  });

  it("requires verified current state to satisfy a deployment contract", () => {
    const contract = createVerificationContract({
      id: "deploy-abc123",
      checks: [
        { id: "exists", key: "deployment.exists", operator: "truthy", required: true },
        { id: "environment", key: "deployment.environment", operator: "equals", expected: "production", required: true },
        { id: "sha", key: "deployment.sha", operator: "equals", expected: "abc123", required: true },
        { id: "health", key: "deployment.health", operator: "truthy", required: true },
        { id: "responds", key: "application.responds", operator: "truthy", required: true },
        { id: "functional", key: "functional.check", operator: "truthy", required: true }
      ]
    });
    const deploymentRequest = createVerificationRequest({
      id: "verify-deploy-1",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      environment: scope.environment,
      subject: { type: "job", id: "job-1" },
      strategies: ["system"],
      requiresIndependentEvidence: true,
      executionIndependenceKey: "provider:operation-1",
      contract,
      maxEvidenceAgeSeconds: 600,
      requestedAt,
      expiresAt: "2026-09-20T20:00:00Z"
    });

    const providerAccepted = createVerificationEvidence({
      id: "provider-accepted",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      subject: { type: "job", id: "job-1" },
      strategy: "system",
      result: "pass",
      sourceType: "provider",
      sourceId: "provider:operation-1",
      independenceKey: "provider:operation-1",
      observedAt: now,
      payloadHash: "provider-result",
      provenance: "provider-response",
      observations: { "deployment.exists": true }
    });

    const acceptedOnly = resolveVerificationRequest(
      deploymentRequest,
      [providerAccepted],
      { receiptId: "receipt-provider-only", verifiedAt: now }
    );
    expect(acceptedOnly.verdict).toBe("uncertain");

    const currentState = createVerificationEvidence({
      id: "deploy-probe",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      subject: { type: "job", id: "job-1" },
      strategy: "system",
      result: "pass",
      sourceType: "system-probe",
      sourceId: "deployment-verifier",
      independenceKey: "verifier:deployment",
      observedAt: now,
      payloadHash: "deploy-state",
      provenance: "deployment-probe",
      observations: {
        "deployment.exists": true,
        "deployment.environment": "production",
        "deployment.sha": "abc123",
        "deployment.health": true,
        "application.responds": true,
        "functional.check": true
      }
    });

    const verified = resolveVerificationRequest(
      deploymentRequest,
      [providerAccepted, currentState],
      { receiptId: "receipt-deploy-verified", verifiedAt: now }
    );
    expect(verified.verdict).toBe("verified");
    expect(verified.verifiedCurrentState?.values["deployment.sha"]).toBe("abc123");
    expect(verified.contractResults?.every((result) => result.verdict === "verified")).toBe(true);

    const wrongSha = createVerificationEvidence({
      id: "deploy-probe-wrong-sha",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      subject: { type: "job", id: "job-1" },
      strategy: "system",
      result: "pass",
      sourceType: "system-probe",
      sourceId: "deployment-verifier",
      independenceKey: "verifier:deployment",
      observedAt: now,
      payloadHash: "deploy-state-wrong-sha",
      provenance: "deployment-probe",
      observations: {
        "deployment.exists": true,
        "deployment.environment": "production",
        "deployment.sha": "deadbeef",
        "deployment.health": true,
        "application.responds": true,
        "functional.check": true
      }
    });
    const failed = resolveVerificationRequest(
      deploymentRequest,
      [wrongSha],
      { receiptId: "receipt-deploy-failed", verifiedAt: now }
    );
    expect(failed.verdict).toBe("failed");
    expect(failed.verifiedCurrentState?.values["deployment.sha"]).toBe("deadbeef");
  });

  it("rejects mutated receipts", () => {
    const receipt = resolveVerificationRequest(
      request(),
      [evidence("execution"), evidence("system")],
      { receiptId: "receipt-5", verifiedAt: now }
    );

    expect(() => assertVerificationReceipt(
      { ...receipt, verdict: "failed" },
      {
        scope,
        subject: { type: "job", id: "job-1" },
        now: Date.parse("2026-09-20T19:32:00Z")
      }
    )).toThrow();
  });
});
