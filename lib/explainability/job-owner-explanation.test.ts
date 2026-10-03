import { describe, expect, it } from "vitest";
import {
  buildJobOwnerExplanation,
  buildOwnerFailurePresentation
} from "@/lib/explainability/job-owner-explanation";
import type { JobRecord } from "@/lib/domain/services/job-service";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    state: "verified",
    taskId: "task-1",
    attempt: 1,
    verificationEvidenceIds: ["evidence-1", "evidence-2"],
    verificationReceiptId: "receipt-1",
    authorizationGrantId: "grant-1",
    authorizationGrantHash: "grant-hash",
    authorizationDisposition: "AUTO",
    capabilityNames: ["deployment.staging.publish"],
    policySnapshotId: "policy-snapshot-1",
    policySnapshotHash: "snapshot-hash",
    policyVersion: "policy-v7",
    policyEngineVersion: "2026-09-28.1",
    policyRulesHash: "rules-hash",
    version: 3,
    updatedAt: "2026-09-28T19:00:00Z",
    ...overrides
  };
}

describe("owner-safe Job explainability", () => {
  it("explains automatic consequential work with exact policy lineage", () => {
    const explanation = buildJobOwnerExplanation(job());

    expect(explanation).toMatchObject({
      title: "Completed and verified",
      authority: {
        disposition: "AUTO",
        capabilityNames: ["deployment.staging.publish"],
        policyVersion: "policy-v7",
        policyEngineVersion: "2026-09-28.1",
        policyRulesHash: "rules-hash",
        policySnapshotId: "policy-snapshot-1",
        policySnapshotHash: "snapshot-hash",
        authorizationGrantId: "grant-1"
      },
      verification: {
        status: "verified",
        evidenceCount: 2,
        receiptId: "receipt-1"
      }
    });
    expect(explanation.reasons).toEqual(expect.arrayContaining([
      "Current policy authorized this work automatically.",
      "Capability: deployment.staging.publish.",
      "Policy version used for authorization: policy-v7.",
      "Verification passed with 2 evidence item(s)."
    ]));
  });

  it("interprets provider authentication failures without exposing the raw infrastructure error", () => {
    const failed = job({
      state: "failed",
      verificationEvidenceIds: [],
      verificationReceiptId: undefined,
      failureReason: "Stripe POST /v1/refunds returned 401 invalid token sk_live_secret_value"
    });

    const failure = buildOwnerFailurePresentation(failed);

    expect(failure).toEqual({
      title: "Integration authentication failed",
      summary: "The connected provider rejected authentication, so GetDone stopped this job.",
      safetyMessage: "GetDone has no verified evidence that the intended action completed.",
      action: {
        label: "Review integration",
        href: "/integrations"
      }
    });
    expect(JSON.stringify(failure)).not.toContain("sk_live_secret_value");
    expect(JSON.stringify(failure)).not.toContain("/v1/refunds");
  });


  it("shows provider completion as pending verification rather than success", () => {
    const pending = job({
      state: "provider_completed",
      verificationReceiptId: undefined
    });

    expect(buildJobOwnerExplanation(pending)).toMatchObject({
      title: "Provider work completed",
      verification: {
        status: "pending"
      }
    });
  });

  it("interprets policy-blocked work without claiming a provider failure", () => {
    const blocked = job({
      state: "blocked",
      verificationEvidenceIds: [],
      verificationReceiptId: undefined,
      failureReason: "blocked by active policy guardrail"
    });

    expect(buildOwnerFailurePresentation(blocked)).toMatchObject({
      title: "Policy stopped this action"
    });
  });

  it("does not claim success when verification is uncertain", () => {
    const uncertain = job({
      state: "uncertain",
      verificationReceiptId: "receipt-uncertain",
      failureReason: "provider returned success but verification evidence conflicted"
    });

    expect(buildJobOwnerExplanation(uncertain)).toMatchObject({
      title: "Completion is uncertain",
      verification: {
        status: "unverified"
      }
    });
    expect(buildOwnerFailurePresentation(uncertain)).toMatchObject({
      title: "Completion could not be verified"
    });
  });
});
