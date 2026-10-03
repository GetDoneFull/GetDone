import type { JobRecord } from "@/lib/domain/services/job-service";

export type OwnerVerificationStatus =
  | "not-started"
  | "pending"
  | "verified"
  | "unverified";

export interface OwnerPolicyAuthority {
  disposition?: "AUTO" | "APPROVAL_REQUIRED" | "STRONG_APPROVAL";
  capabilityNames: readonly string[];
  policyVersion?: string;
  policyEngineVersion?: string;
  policyRulesHash?: string;
  policySnapshotId?: string;
  policySnapshotHash?: string;
  decisionId?: string;
  authorizationGrantId?: string;
  authorizationGrantHash?: string;
}

export interface OwnerFailureAction {
  label: string;
  href: string;
}

export interface OwnerFailurePresentation {
  title: string;
  summary: string;
  safetyMessage: string;
  action?: OwnerFailureAction;
}

export interface OwnerOperationExplanation {
  title: string;
  summary: string;
  reasons: readonly string[];
  authority: OwnerPolicyAuthority;
  verification: {
    status: OwnerVerificationStatus;
    evidenceCount: number;
    receiptId?: string;
  };
}

function authority(job: JobRecord): OwnerPolicyAuthority {
  return Object.freeze({
    disposition: job.authorizationDisposition,
    capabilityNames: Object.freeze([...(job.capabilityNames ?? [])]),
    policyVersion: job.policyVersion,
    policyEngineVersion: job.policyEngineVersion,
    policyRulesHash: job.policyRulesHash,
    policySnapshotId: job.policySnapshotId,
    policySnapshotHash: job.policySnapshotHash,
    decisionId: job.decisionId,
    authorizationGrantId: job.authorizationGrantId,
    authorizationGrantHash: job.authorizationGrantHash
  });
}

function verification(job: JobRecord): OwnerOperationExplanation["verification"] {
  if (job.verificationReceiptId && (job.state === "verified" || job.state === "succeeded")) {
    return Object.freeze({
      status: "verified" as const,
      evidenceCount: job.verificationEvidenceIds.length,
      receiptId: job.verificationReceiptId
    });
  }
  if (job.state === "provider_completed" || job.state === "verifying") {
    return Object.freeze({
      status: "pending" as const,
      evidenceCount: job.verificationEvidenceIds.length,
      receiptId: job.verificationReceiptId
    });
  }
  if (job.state === "failed" || job.state === "blocked" || job.state === "uncertain") {
    return Object.freeze({
      status: "unverified" as const,
      evidenceCount: job.verificationEvidenceIds.length,
      receiptId: job.verificationReceiptId
    });
  }
  return Object.freeze({
    status: "not-started" as const,
    evidenceCount: job.verificationEvidenceIds.length,
    receiptId: job.verificationReceiptId
  });
}

function policyReasons(job: JobRecord): string[] {
  const reasons: string[] = [];
  const capabilities = job.capabilityNames ?? [];

  if (job.authorizationDisposition === "AUTO") {
    reasons.push("Current policy authorized this work automatically.");
  } else if (job.authorizationDisposition === "APPROVAL_REQUIRED") {
    reasons.push("Current policy required owner approval before this work could run.");
  } else if (job.authorizationDisposition === "STRONG_APPROVAL") {
    reasons.push("Current policy required strong owner approval before this work could run.");
  }

  if (capabilities.length === 1) {
    reasons.push(`Capability: ${capabilities[0]}.`);
  } else if (capabilities.length > 1) {
    reasons.push(`Capabilities: ${capabilities.join(", ")}.`);
  }

  if (job.policyVersion) {
    reasons.push(`Policy version used for authorization: ${job.policyVersion}.`);
  }
  if (job.policyEngineVersion) {
    reasons.push(`Policy engine version: ${job.policyEngineVersion}.`);
  }
  return reasons;
}

export function buildOwnerFailurePresentation(
  job: JobRecord
): OwnerFailurePresentation | undefined {
  if (job.state !== "failed" && job.state !== "blocked" && job.state !== "uncertain") return undefined;

  const raw = (job.failureReason ?? "").toLowerCase();
  const hasVerifiedCompletion = Boolean(job.verifiedCompletionFactId);

  if (job.state === "uncertain" || /verification|verify|receipt|evidence/.test(raw)) {
    return Object.freeze({
      title: "Completion could not be verified",
      summary: "GetDone did not mark this work complete because the required verification did not pass.",
      safetyMessage: hasVerifiedCompletion
        ? "The provider reported completion, but the intended final state was not authoritatively verified."
        : "GetDone has no authoritative evidence that the intended final state was reached."
    });
  }

  if (/\b401\b|unauth|authentication|credential|token expired|invalid token/.test(raw)) {
    return Object.freeze({
      title: "Integration authentication failed",
      summary: "The connected provider rejected authentication, so GetDone stopped this job.",
      safetyMessage: "GetDone has no verified evidence that the intended action completed.",
      action: Object.freeze({
        label: "Review integration",
        href: "/integrations"
      })
    });
  }

  if (/\b429\b|rate.?limit|too many requests/.test(raw)) {
    return Object.freeze({
      title: "Provider rate limit paused work",
      summary: "The provider temporarily refused more requests, so this job was not marked complete.",
      safetyMessage: "GetDone has no verified evidence that the intended action completed."
    });
  }

  if (/timeout|timed out|deadline exceeded/.test(raw)) {
    return Object.freeze({
      title: "Provider response timed out",
      summary: "GetDone could not confirm the provider result before the execution deadline.",
      safetyMessage: hasVerifiedCompletion
        ? "A provider completion signal exists, but the intended final state was not authoritatively verified."
        : "GetDone has no verified evidence that the intended action completed."
    });
  }

  if (/budget|spend|limit exceeded/.test(raw)) {
    return Object.freeze({
      title: "Budget policy stopped this action",
      summary: "The job could not continue under the active budget limits.",
      safetyMessage: "GetDone did not mark the action complete."
    });
  }

  if (/forbidden|policy|blocked|kill switch|guardrail/.test(raw)) {
    return Object.freeze({
      title: "Policy stopped this action",
      summary: "The active authorization or safety policy did not allow this job to continue.",
      safetyMessage: "GetDone did not mark the action complete."
    });
  }

  return Object.freeze({
    title: "Action could not be completed",
    summary: "GetDone stopped this job before it reached a verified successful outcome.",
    safetyMessage: hasVerifiedCompletion
      ? "A provider completion signal exists, but the intended final state was not authoritatively verified."
      : "GetDone has no verified evidence that the intended action completed."
  });
}

export function buildJobOwnerExplanation(job: JobRecord): OwnerOperationExplanation {
  const reasons = policyReasons(job);
  const verificationState = verification(job);

  if (verificationState.status === "verified") {
    reasons.push(
      `Verification passed with ${verificationState.evidenceCount} evidence item(s).`
    );
  } else if (verificationState.status === "pending") {
    reasons.push("Provider work is complete enough to begin verification; final success is not claimed yet.");
  } else if (verificationState.status === "unverified") {
    reasons.push("The job does not have authoritative verified completion.");
  }

  const byState: Record<JobRecord["state"], { title: string; summary: string }> = {
    created: {
      title: "Created",
      summary: "The job exists but has not yet been admitted for execution."
    },
    queued: {
      title: "Authorized and queued",
      summary: "The job has authoritative task authorization and is waiting for execution."
    },
    claimed: {
      title: "Assigned to a worker",
      summary: "A worker has claimed the authorized job."
    },
    executing: {
      title: "Execution in progress",
      summary: "GetDone is executing the authorized work."
    },
    provider_completed: {
      title: "Provider work completed",
      summary: "The provider reported completion; GetDone has not claimed success until verification finishes."
    },
    running: {
      title: "Execution in progress",
      summary: "GetDone is executing the authorized work."
    },
    verifying: {
      title: "Verifying provider result",
      summary: "GetDone is checking the actual resulting state before claiming success."
    },
    verified: {
      title: "Completed and verified",
      summary: "GetDone verified the intended outcome before marking this job successful."
    },
    succeeded: {
      title: "Completed and verified",
      summary: "GetDone verified the intended outcome before marking this job successful."
    },
    failed: {
      title: "Stopped before verified completion",
      summary: "The job ended without an authoritative verified-success result."
    },
    blocked: {
      title: "Blocked by policy or dependency",
      summary: "GetDone did not execute or complete this job because an authoritative requirement blocked it."
    },
    uncertain: {
      title: "Completion is uncertain",
      summary: "GetDone could not prove the intended final state, so it did not claim success."
    },
    cancelled: {
      title: "Cancelled",
      summary: "The job was cancelled and is not considered complete."
    }
  };

  const state = byState[job.state];
  return Object.freeze({
    title: state.title,
    summary: state.summary,
    reasons: Object.freeze(reasons),
    authority: authority(job),
    verification: verificationState
  });
}
