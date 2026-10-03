import { describe, expect, it } from "vitest";
import {
  issueAuthorizationGrant,
  assertAuthorizationGrant,
  assertAuthorizationGrantEnvelope,
  createAuthorizationConsumptionRecord,
  assertAuthorizationConsumption
} from "@/lib/authorization/grants";
import {
  createApprovalProof,
  createStepUpProof
} from "@/lib/authorization/proofs";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import { createPolicySnapshot } from "@/lib/planning/policy-snapshot";
import { evaluateStepPolicy } from "@/lib/planning/policy-engine";
import { validPlan } from "@/lib/planning/test-fixture";
import { fixtureNow, fixtureScope, receiptFor, autoGrantFor } from "@/lib/planning/test-security-fixture";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";

describe("authorization grants", () => {
  it("issues an immutable AUTO grant bound to plan version, hashes, receipt and policy version", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    const grant = autoGrantFor(plan, plan.steps[0].id, receipt);

    expect(grant.disposition).toBe("AUTO");
    expect(grant.planVersion).toBe(plan.proposalVersion);
    expect(grant.planHash).toBe(hashPlan(plan));
    expect(grant.stepHash).toBe(hashPlanStep(plan.steps[0]));
    expect(grant.validationReceiptHash).toBe(receipt.receiptHash);
    expect(grant.policyVersion).toBe(receipt.snapshot.policyVersion);
    expect(grant.grantHash).toHaveLength(64);
    expect(Object.isFrozen(grant)).toBe(true);
  });

  it("rejects grant reuse after the plan step mutates", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    const grant = autoGrantFor(plan, plan.steps[0].id, receipt);
    const mutated = {
      ...plan,
      steps: [{ ...plan.steps[0], reason: "changed after authorization" }]
    };

    expect(() => assertAuthorizationGrant({
      grant,
      plan: mutated,
      stepId: mutated.steps[0].id,
      receipt,
      scope: fixtureScope(plan),
      now: fixtureNow.getTime()
    })).toThrow();
  });

  it("rejects expired grants", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    const grant = autoGrantFor(plan, plan.steps[0].id, receipt);

    expect(() => assertAuthorizationGrant({
      grant,
      plan,
      stepId: plan.steps[0].id,
      receipt,
      scope: fixtureScope(plan),
      now: Date.parse("2026-09-20T18:31:00Z")
    })).toThrow();
  });

  it("records hash-bound authorization consumption by Task/Job", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    const grant = autoGrantFor(plan, plan.steps[0].id, receipt);
    const consumption = createAuthorizationConsumptionRecord({
      id: `authorization-consumption:${grant.id}`,
      grant,
      consumerType: "task",
      consumerId: "task-1",
      consumedAt: fixtureNow.toISOString()
    });

    expect(consumption.id).toBe(`authorization-consumption:${grant.id}`);
    expect(consumption.consumerType).toBe("task");
    expect(consumption.consumerId).toBe("task-1");
    expect(consumption.consumptionHash).toHaveLength(64);
    expect(assertAuthorizationConsumption(consumption, grant)).toBe(consumption);
  });

  it("issues STRONG_APPROVAL only from matching immutable approval and step-up proofs", () => {
    const base = validPlan();
    const productionPlan = {
      ...base,
      scope: {
        ...base.scope,
        environment: "production" as const,
        dataClass: "sensitive" as const
      },
      requestedCapabilities: ["production.deploy"],
      steps: [{
        ...base.steps[0],
        capabilityRequests: [{
          capability: "production.deploy",
          input: {
            companyId: "company-a",
            repository: "DMART19/GetDone",
            commitSha: "abcdef1",
            environment: "production",
            deploymentId: "deploy-1",
            rollbackRef: "previous",
            verificationChecks: ["health"]
          }
        }],
        resourceRequirements: {
          ...base.steps[0].resourceRequirements,
          execution: {
            ...base.steps[0].resourceRequirements.execution,
            environment: "production" as const
          },
          data: {
            ...base.steps[0].resourceRequirements.data,
            classification: "sensitive" as const
          }
        }
      }]
    };
    const receipt = receiptFor(productionPlan);
    const scope = fixtureScope(productionPlan);
    const step = productionPlan.steps[0];
    const stepUp = createStepUpProof({
      id: "stepup-strong",
      actorId: "user-a",
      scope,
      method: "passkey",
      authenticatedAt: "2026-09-20T18:29:00Z",
      expiresAt: "2026-09-20T18:35:00Z"
    });
    const approval = createApprovalProof({
      id: "approval-proof-strong",
      decisionId: "decision-1",
      approvalId: "approval-1",
      actorId: "user-a",
      scope,
      level: "strong-approval",
      planHash: hashPlan(productionPlan),
      stepHash: hashPlanStep(step),
      grantedAt: "2026-09-20T18:29:30Z",
      expiresAt: "2026-09-20T18:34:00Z",
      stepUpProofId: stepUp.id
    });
    const policySnapshot = createPolicySnapshot({
      id: "policy-snapshot-strong",
      policyVersion: CURRENT_POLICY_VERSION,
      scope,
      planHash: hashPlan(productionPlan),
      stepHash: hashPlanStep(step),
      capabilityNames: ["production.deploy"],
      dataClass: "sensitive",
      region: "us-west",
      allowedEnvironments: ["production"],
      allowedDataClasses: ["sensitive"],
      allowedRegions: ["us-west"],
      killSwitches: [],
      credentialRequirementIds: [],
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: "strong-policy-12345678",
      resourceRequirements: step.resourceRequirements,
      createdAt: fixtureNow.toISOString()
    });
    const policyEvaluation = evaluateStepPolicy({
      authenticated: true,
      scopeResolved: true,
      trustedScope: scope,
      capabilities: ["production.deploy"],
      planHash: hashPlan(productionPlan),
      stepHash: hashPlanStep(step),
      environment: "production",
      dataClass: "sensitive",
      region: "us-west",
      allowedEnvironments: ["production"],
      allowedDataClasses: ["sensitive"],
      allowedRegions: ["us-west"],
      credentialRequirementIds: [],
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: "strong-policy-12345678",
      killSwitches: [],
      approvalProof: approval,
      stepUpProof: stepUp,
      now: fixtureNow.getTime()
    });

    const grant = issueAuthorizationGrant({
      id: "grant-strong",
      plan: productionPlan,
      stepId: step.id,
      receipt,
      policySnapshot,
      policyEvaluation,
      actor: { type: "user", id: "user-a" },
      scope,
      approvalProof: approval,
      stepUpProof: stepUp,
      issuedAt: fixtureNow.toISOString(),
      expiresAt: "2026-09-20T18:33:00Z"
    });

    expect(grant.disposition).toBe("STRONG_APPROVAL");
    expect(grant.approvalProofId).toBe(approval.id);
    expect(grant.approvalProofHash).toBe(approval.proofHash);
    expect(grant.stepUpProofId).toBe(stepUp.id);
    expect(grant.stepUpProofHash).toBe(stepUp.proofHash);
  });
  it("rejects grants outside their exact scope or validity window", () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const scope = fixtureScope(plan);

    expect(() => assertAuthorizationGrantEnvelope(
      grant,
      { ...scope, companyId: "company-b" },
      fixtureNow.getTime()
    )).toThrow();

    expect(() => assertAuthorizationGrantEnvelope(
      grant,
      scope,
      Date.parse(grant.issuedAt) - 1
    )).toThrow(/not currently valid/i);

    expect(() => assertAuthorizationGrantEnvelope(
      grant,
      scope,
      Date.parse(grant.expiresAt)
    )).toThrow(/not currently valid/i);
  });

  it("rejects a cryptographically valid but revoked grant", () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const { grantHash, ...base } = grant;
    void grantHash;
    const revokedBase = { ...base, status: "revoked" as const };
    const revoked = Object.freeze({
      ...revokedBase,
      grantHash: sha256Hex(revokedBase)
    });

    expect(() => assertAuthorizationGrantEnvelope(
      revoked,
      fixtureScope(plan),
      fixtureNow.getTime()
    )).toThrow(/not active/i);
  });

  it("rejects approval-backed grants missing immutable Decision proof lineage", () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const { grantHash, ...base } = grant;
    void grantHash;
    const malformedBase = {
      ...base,
      disposition: "APPROVAL_REQUIRED" as const
    };
    const malformed = Object.freeze({
      ...malformedBase,
      grantHash: sha256Hex(malformedBase)
    });

    expect(() => assertAuthorizationGrantEnvelope(
      malformed,
      fixtureScope(plan),
      fixtureNow.getTime()
    )).toThrow(/Decision proof lineage/i);
  });

  it("rejects a cryptographically valid grant after material policy changes", () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const { grantHash, ...base } = grant;
    void grantHash;
    const staleBase = { ...base, policyVersion: "superseded-policy-version" };
    const stale = Object.freeze({
      ...staleBase,
      grantHash: sha256Hex(staleBase)
    });

    expect(() => assertAuthorizationGrantEnvelope(
      stale,
      fixtureScope(plan),
      fixtureNow.getTime()
    )).toThrow(/stale|materially changed policy/i);
  });

  it("rejects tampered authorization consumption lineage", () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const consumption = createAuthorizationConsumptionRecord({
      id: `authorization-consumption:${grant.id}`,
      grant,
      consumerType: "task",
      consumerId: "task-1",
      consumedAt: fixtureNow.toISOString()
    });

    expect(() => assertAuthorizationConsumption(
      { ...consumption, consumerId: "task-2" },
      grant
    )).toThrow(/does not match its grant/i);

    expect(() => createAuthorizationConsumptionRecord({
      id: "caller-selected-consumption-id",
      grant,
      consumerType: "task",
      consumerId: "task-1",
      consumedAt: fixtureNow.toISOString()
    })).toThrow(/derived from the grant id/i);
  });

});
