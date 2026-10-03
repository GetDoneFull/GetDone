import { describe, expect, it } from "vitest";
import { CoreTrancheCCoordinator } from "@/lib/domain/services/core-tranche-c-coordinator";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { VerificationRequestRecord } from "@/lib/domain/services/verification-service";
import { createObjectiveDesiredOutcome } from "@/lib/domain/objective-outcome";
import {
  createVerificationContract,
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest
} from "@/lib/verification/verification";

const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const
};
const now = new Date("2026-09-28T19:10:00Z");

function contract() {
  return createVerificationContract({
    id: "deploy-abc123",
    checks: [
      { id: "exists", key: "deployment.exists", operator: "truthy", required: true },
      { id: "sha", key: "deployment.sha", operator: "equals", expected: "abc123", required: true },
      { id: "health", key: "deployment.health", operator: "truthy", required: true }
    ]
  });
}

function fixture(sha: string) {
  const verificationContract = contract();
  const request = createVerificationRequest({
    id: `verify-${sha}`,
    correlationId: "objective-correlation",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    environment: scope.environment,
    subject: { type: "job", id: "job-1" },
    strategies: ["system"],
    requiresIndependentEvidence: true,
    executionIndependenceKey: "provider:deploy-1",
    contract: verificationContract,
    maxEvidenceAgeSeconds: 300,
    requestedAt: "2026-09-28T19:09:00Z",
    expiresAt: "2026-09-28T19:15:00Z"
  });
  const evidence = createVerificationEvidence({
    id: `evidence-${sha}`,
    correlationId: "objective-correlation",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    subject: request.subject,
    strategy: "system",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "deployment-verifier",
    independenceKey: "verifier:deployment",
    observedAt: "2026-09-28T19:09:30Z",
    expiresAt: "2026-09-28T19:14:30Z",
    payloadHash: `payload-${sha}`,
    provenance: "gate-c-coordinator-test",
    observations: {
      "deployment.exists": true,
      "deployment.sha": sha,
      "deployment.health": true
    }
  });
  return {
    request,
    evidence,
    desiredOutcome: createObjectiveDesiredOutcome({
      objectiveId: "objective-1",
      contract: verificationContract
    })
  };
}

function job(state: JobRecord["state"]): JobRecord {
  return {
    id: "job-1",
    correlationId: "objective-correlation",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    state,
    taskId: "task-1",
    workerId: "worker-1",
    attempt: 1,
    maxAttempts: 3,
    providerResultId: "provider-result-1",
    providerResultHash: "provider-result-hash",
    providerCompletedAt: "2026-09-28T19:09:00Z",
    verificationEvidenceIds: [],
    version: 6,
    updatedAt: now.toISOString()
  };
}

function harness(sha: string) {
  const calls: string[] = [];
  const data = fixture(sha);

  const jobs = {
    beginVerification: async () => {
      calls.push("job:verifying");
      return job("verifying");
    },
    verify: async () => {
      calls.push("job:verified");
      return job("verified");
    },
    failVerification: async () => {
      calls.push("job:failed");
      return job("failed");
    },
    markUncertain: async () => {
      calls.push("job:blocked");
      return job("blocked");
    }
  };

  const verifications = {
    request: async () => {
      calls.push("verification:requested");
      return {
        id: data.request.id,
        correlationId: data.request.correlationId,
        portfolioId: scope.portfolioId,
        companyId: scope.companyId,
        state: "requested",
        request: data.request,
        version: 1,
        updatedAt: data.request.requestedAt
      } as VerificationRequestRecord;
    },
    beginCollecting: async () => {
      calls.push("verification:collecting");
      return {
        id: data.request.id,
        correlationId: data.request.correlationId,
        portfolioId: scope.portfolioId,
        companyId: scope.companyId,
        state: "collecting",
        request: data.request,
        version: 2,
        updatedAt: now.toISOString()
      } as VerificationRequestRecord;
    },
    resolve: async () => {
      calls.push("verification:resolved");
      const receipt = resolveVerificationRequest(data.request, [data.evidence], {
        receiptId: `receipt:${data.request.id}`,
        verifiedAt: now.toISOString(),
        receiptTtlSeconds: 120
      });
      return {
        id: data.request.id,
        correlationId: data.request.correlationId,
        portfolioId: scope.portfolioId,
        companyId: scope.companyId,
        state: receipt.verdict,
        request: data.request,
        receipt,
        version: 3,
        updatedAt: now.toISOString()
      } as VerificationRequestRecord;
    }
  };

  return {
    calls,
    data,
    coordinator: new CoreTrancheCCoordinator(
      jobs as never,
      verifications as never,
      () => now
    )
  };
}

const context = {
  actor: { type: "system" as const, id: "control-plane" },
  scope,
  correlationId: "objective-correlation",
  provenance: "gate-c-coordinator-test",
  idempotencyRoot: "tranche-c:job-1"
};

describe("CoreTrancheCCoordinator", () => {
  it("orders provider completion handoff through verification before completing the Objective", async () => {
    const { coordinator, calls, data } = harness("abc123");
    const result = await coordinator.closeExecutionLoop(context, {
      jobId: "job-1",
      verificationRequest: data.request,
      evidence: [data.evidence],
      desiredOutcome: data.desiredOutcome,
      canGenerateMoreWork: true
    });

    expect(calls).toEqual([
      "job:verifying",
      "verification:requested",
      "verification:collecting",
      "verification:resolved",
      "job:verified"
    ]);
    expect(result.job.state).toBe("verified");
    expect(result.verification.receipt?.verdict).toBe("verified");
    expect(result.objectiveEvaluation.state).toBe("completed");
    expect(result.replanRequest).toBeUndefined();
  });

  it("turns a verification mismatch into governed new work instead of false success", async () => {
    const { coordinator, calls, data } = harness("deadbeef");
    const result = await coordinator.closeExecutionLoop(context, {
      jobId: "job-1",
      verificationRequest: data.request,
      evidence: [data.evidence],
      desiredOutcome: data.desiredOutcome,
      canGenerateMoreWork: true,
      previousPlanId: "plan-1"
    });

    expect(calls.at(-1)).toBe("job:failed");
    expect(result.job.state).toBe("failed");
    expect(result.verification.receipt?.verdict).toBe("failed");
    expect(result.objectiveEvaluation.state).toBe("new_work_required");
    expect(result.replanRequest?.requiredPipeline).toEqual([
      "plan",
      "validation",
      "policy",
      "authority"
    ]);
    expect(result.replanRequest?.previousPlanId).toBe("plan-1");
  });
});
