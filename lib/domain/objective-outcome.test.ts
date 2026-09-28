import { describe, expect, it } from "vitest";
import {
  assertGovernedReplanAdmission,
  createGovernedReplanRequest,
  createObjectiveDesiredOutcome,
  evaluateObjectiveOutcome
} from "@/lib/domain/objective-outcome";
import { createWorkAdmissionEnvelope } from "@/lib/planning/work-admission";
import { validPlan } from "@/lib/planning/test-fixture";
import {
  autoGrantFor,
  fixtureNow,
  fixtureScope,
  policySnapshotFor,
  receiptFor
} from "@/lib/planning/test-security-fixture";
import {
  createVerificationContract,
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest
} from "@/lib/verification/verification";

function deploymentContract() {
  return createVerificationContract({
    id: "objective-deploy-abc123",
    checks: [
      { id: "exists", key: "deployment.exists", operator: "truthy", required: true },
      { id: "environment", key: "deployment.environment", operator: "equals", expected: "production", required: true },
      { id: "sha", key: "deployment.sha", operator: "equals", expected: "abc123", required: true },
      { id: "health", key: "deployment.health", operator: "truthy", required: true },
      { id: "responds", key: "application.responds", operator: "truthy", required: true },
      { id: "functional", key: "functional.check", operator: "truthy", required: true }
    ]
  });
}

function deploymentReceipt(input: {
  id: string;
  sha: string;
  observedAt: string;
}) {
  const scope = fixtureScope();
  const contract = deploymentContract();
  const request = createVerificationRequest({
    id: `request-${input.id}`,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    environment: scope.environment,
    subject: { type: "job", id: `job-${input.id}` },
    strategies: ["system"],
    requiresIndependentEvidence: true,
    executionIndependenceKey: `provider:${input.id}`,
    contract,
    maxEvidenceAgeSeconds: 600,
    requestedAt: new Date(Date.parse(input.observedAt) - 1_000).toISOString(),
    expiresAt: new Date(Date.parse(input.observedAt) + 120_000).toISOString()
  });
  const evidence = createVerificationEvidence({
    id: `evidence-${input.id}`,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    subject: request.subject,
    strategy: "system",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "deployment-verifier",
    independenceKey: "verifier:deployment",
    observedAt: input.observedAt,
    expiresAt: new Date(Date.parse(input.observedAt) + 90_000).toISOString(),
    payloadHash: `state-${input.id}`,
    provenance: "gate-c-test",
    observations: {
      "deployment.exists": true,
      "deployment.environment": "production",
      "deployment.sha": input.sha,
      "deployment.health": true,
      "application.responds": true,
      "functional.check": true
    }
  });

  return resolveVerificationRequest(request, [evidence], {
    receiptId: `receipt-${input.id}`,
    verifiedAt: input.observedAt,
    receiptTtlSeconds: 60
  });
}

describe("Core Tranche C objective outcome loop", () => {
  it("completes only after independently verified current state matches desired outcome", () => {
    const scope = fixtureScope();
    const desiredOutcome = createObjectiveDesiredOutcome({
      objectiveId: "objective-1",
      contract: deploymentContract()
    });
    const verified = deploymentReceipt({
      id: "verified",
      sha: "abc123",
      observedAt: fixtureNow.toISOString()
    });

    expect(verified.verdict).toBe("verified");
    const evaluation = evaluateObjectiveOutcome({
      id: "evaluation-completed",
      desiredOutcome,
      verificationReceipts: [verified],
      scope,
      eligibleSubjects: [{ type: "job", id: "job-verified" }],
      evaluatedAt: new Date(fixtureNow.getTime() + 1_000).toISOString(),
      canGenerateMoreWork: true
    });

    expect(evaluation.state).toBe("completed");
    expect(evaluation.verifiedCurrentState?.values["deployment.sha"]).toBe("abc123");
    expect(evaluation.checkResults.every((result) => result.verdict === "verified")).toBe(true);
  });

  it("replans failed verification only through a fresh Plan -> Validation -> Policy -> Authority admission, then completes", () => {
    const scope = fixtureScope();
    const desiredOutcome = createObjectiveDesiredOutcome({
      objectiveId: "objective-1",
      contract: deploymentContract()
    });
    const failedVerification = deploymentReceipt({
      id: "wrong-sha",
      sha: "deadbeef",
      observedAt: fixtureNow.toISOString()
    });

    expect(failedVerification.verdict).toBe("failed");
    const needsWork = evaluateObjectiveOutcome({
      id: "evaluation-needs-work",
      desiredOutcome,
      verificationReceipts: [failedVerification],
      scope,
      eligibleSubjects: [{ type: "job", id: "job-wrong-sha" }],
      evaluatedAt: new Date(fixtureNow.getTime() + 1_000).toISOString(),
      canGenerateMoreWork: true
    });
    expect(needsWork.state).toBe("new_work_required");

    const replanRequestedAt = new Date(fixtureNow.getTime() + 2_000);
    const replan = createGovernedReplanRequest({
      id: "replan-1",
      evaluation: needsWork,
      scope,
      requestedAt: replanRequestedAt.toISOString(),
      previousPlanId: "plan-1"
    });
    expect(replan.requiredPipeline).toEqual(["plan", "validation", "policy", "authority"]);

    expect(() => assertGovernedReplanAdmission({
      request: replan,
      admission: {
        id: "forged",
        scope,
        planId: "plan-2",
        validationReceiptId: "fake",
        validationReceiptHash: "fake",
        policySnapshotId: "fake",
        policySnapshotHash: "fake",
        authorizationGrantId: "fake",
        authorizationGrantHash: "fake",
        createdAt: replanRequestedAt.toISOString(),
        expiresAt: new Date(replanRequestedAt.getTime() + 10_000).toISOString(),
        admissionHash: "fake"
      } as never,
      plan: validPlan({
        id: "plan-forged",
        proposalVersion: 2,
        source: { type: "objective", objectiveId: desiredOutcome.objectiveId }
      }),
      scope,
      now: replanRequestedAt.getTime()
    })).toThrow();

    const plan = validPlan({
      id: "plan-2",
      proposalVersion: 2,
      source: { type: "objective", objectiveId: desiredOutcome.objectiveId }
    });
    const step = plan.steps[0];
    const replanScope = fixtureScope(plan);
    const admittedAt = new Date(fixtureNow.getTime() + 3_000);
    const validationReceipt = receiptFor(plan, admittedAt);
    const policySnapshot = policySnapshotFor(plan, step.id, admittedAt);
    const grant = autoGrantFor(plan, step.id, validationReceipt, admittedAt);
    const admission = createWorkAdmissionEnvelope({
      id: "replan-admission-1",
      plan,
      stepId: step.id,
      scope: replanScope,
      receipt: validationReceipt,
      policySnapshot,
      grant,
      killSwitches: [],
      createdAt: admittedAt.toISOString(),
      expiresAt: new Date(admittedAt.getTime() + 20_000).toISOString()
    });

    expect(assertGovernedReplanAdmission({
      request: replan,
      admission,
      plan,
      scope: replanScope,
      now: admittedAt.getTime()
    })).toBe(admission);

    const repaired = deploymentReceipt({
      id: "repaired",
      sha: "abc123",
      observedAt: new Date(fixtureNow.getTime() + 4_000).toISOString()
    });
    const completed = evaluateObjectiveOutcome({
      id: "evaluation-after-replan",
      desiredOutcome,
      verificationReceipts: [repaired],
      scope,
      eligibleSubjects: [{ type: "job", id: "job-repaired" }],
      evaluatedAt: new Date(fixtureNow.getTime() + 5_000).toISOString(),
      canGenerateMoreWork: true
    });

    expect(completed.state).toBe("completed");
  });
});
