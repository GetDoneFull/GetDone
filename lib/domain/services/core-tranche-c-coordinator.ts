import { createCommandEnvelope, type AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  assertGovernedReplanAdmission,
  createGovernedReplanRequest,
  evaluateObjectiveOutcome,
  type GovernedReplanRequest,
  type ObjectiveDesiredOutcome,
  type ObjectiveOutcomeEvaluation,
  type ObjectiveOutcomeState
} from "@/lib/domain/objective-outcome";
import type { JobRecord, JobService } from "@/lib/domain/services/job-service";
import type {
  VerificationRequestRecord,
  VerificationService
} from "@/lib/domain/services/verification-service";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import type { WorkAdmissionEnvelope } from "@/lib/planning/work-admission";
import type {
  VerificationEvidence,
  VerificationReceipt,
  VerificationRequest
} from "@/lib/verification/verification";

export const CORE_TRANCHE_C_COORDINATOR_VERSION = "1.0.0";

export interface TrancheCJobLifecycle {
  beginVerification: JobService["beginVerification"];
  verify: JobService["verify"];
  failVerification: JobService["failVerification"];
  markUncertain: JobService["markUncertain"];
}

export interface TrancheCVerificationLifecycle {
  request: VerificationService["request"];
  beginCollecting: VerificationService["beginCollecting"];
  resolve: VerificationService["resolve"];
}

export interface TrancheCExecutionContext {
  actor: AuthoritativeCommandEnvelope["actor"];
  scope: TrustedExecutionScope;
  correlationId: string;
  provenance: string;
  idempotencyRoot: string;
}

export interface CloseExecutionLoopInput {
  jobId: string;
  verificationRequest: VerificationRequest;
  evidence: readonly VerificationEvidence[];
  desiredOutcome: ObjectiveDesiredOutcome;
  priorObjectiveReceipts?: readonly VerificationReceipt[];
  canGenerateMoreWork: boolean;
  previousPlanId?: string;
  uncertainObjectiveState?: Extract<
    ObjectiveOutcomeState,
    "blocked" | "needs_owner_input"
  >;
  receiptTtlSeconds?: number;
}

export interface CloseExecutionLoopResult {
  job: JobRecord;
  verification: VerificationRequestRecord;
  objectiveEvaluation: ObjectiveOutcomeEvaluation;
  replanRequest?: GovernedReplanRequest;
}

function assertRequestTargetsJob(
  request: VerificationRequest,
  jobId: string,
  scope: TrustedExecutionScope
) {
  if (
    request.subject.type !== "job"
    || request.subject.id !== jobId
    || request.portfolioId !== scope.portfolioId
    || request.companyId !== scope.companyId
    || request.environment !== scope.environment
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Tranche C verification request must target the authoritative Job in the same trusted scope"
    );
  }
  if (!request.contract) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Tranche C Job verification requires an explicit verification contract"
    );
  }
}

export class CoreTrancheCCoordinator {
  constructor(
    private readonly jobs: TrancheCJobLifecycle,
    private readonly verifications: TrancheCVerificationLifecycle,
    private readonly now: () => Date = () => new Date()
  ) {}

  private command(
    context: TrancheCExecutionContext,
    stage: string,
    mutation: Readonly<Record<string, unknown>>
  ) {
    return createCommandEnvelope({
      commandId: `${context.idempotencyRoot}:${stage}`,
      actor: context.actor,
      scope: context.scope,
      correlationId: context.correlationId,
      environment: context.scope.environment,
      idempotencyKey: `${context.idempotencyRoot}:${stage}`,
      provenance: context.provenance,
      requestedMutation: {
        type: `tranche-c.${stage}`,
        ...mutation
      }
    });
  }

  async closeExecutionLoop(
    context: TrancheCExecutionContext,
    input: CloseExecutionLoopInput
  ): Promise<CloseExecutionLoopResult> {
    assertRequestTargetsJob(input.verificationRequest, input.jobId, context.scope);
    const verifiedAt = this.now().toISOString();

    await this.jobs.beginVerification(
      input.jobId,
      this.command(context, "job-verifying", { jobId: input.jobId })
    );

    await this.verifications.request(
      input.verificationRequest,
      this.command(context, "verification-request", {
        jobId: input.jobId,
        verificationRequestId: input.verificationRequest.id
      })
    );
    await this.verifications.beginCollecting(
      input.verificationRequest.id,
      this.command(context, "verification-collecting", {
        jobId: input.jobId,
        verificationRequestId: input.verificationRequest.id
      })
    );
    const verification = await this.verifications.resolve(
      input.verificationRequest.id,
      this.command(context, "verification-resolve", {
        jobId: input.jobId,
        verificationRequestId: input.verificationRequest.id
      }),
      input.verificationRequest,
      input.evidence,
      {
        receiptId: `receipt:${input.verificationRequest.id}`,
        verifiedAt,
        receiptTtlSeconds: input.receiptTtlSeconds
      }
    );

    const receipt = verification.receipt;
    if (!receipt) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Tranche C verification resolution did not persist an authoritative receipt"
      );
    }

    let job: JobRecord;
    switch (receipt.verdict) {
      case "verified":
        job = await this.jobs.verify(
          input.jobId,
          this.command(context, "job-verified", {
            jobId: input.jobId,
            verificationReceiptId: receipt.id
          }),
          receipt.id
        );
        break;
      case "failed":
        job = await this.jobs.failVerification(
          input.jobId,
          this.command(context, "job-verification-failed", {
            jobId: input.jobId,
            verificationReceiptId: receipt.id
          }),
          receipt.id,
          "Verification contract did not match independently verified current state"
        );
        break;
      case "uncertain":
        job = await this.jobs.markUncertain(
          input.jobId,
          this.command(context, "job-verification-blocked", {
            jobId: input.jobId,
            verificationReceiptId: receipt.id
          }),
          receipt.id
        );
        break;
    }

    const receipts = [...(input.priorObjectiveReceipts ?? []), receipt];
    const eligibleSubjects = [
      ...new Map(
        receipts.map((item) => [
          `${item.subject.type}:${item.subject.id}`,
          item.subject
        ])
      ).values()
    ];
    const evaluationAt = receipt.verifiedAt;
    const objectiveEvaluation = evaluateObjectiveOutcome({
      id: `objective-evaluation:${input.desiredOutcome.objectiveId}:${input.verificationRequest.id}`,
      desiredOutcome: input.desiredOutcome,
      verificationReceipts: receipts,
      scope: context.scope,
      eligibleSubjects,
      evaluatedAt: evaluationAt,
      canGenerateMoreWork: input.canGenerateMoreWork,
      ...(receipt.verdict === "uncertain"
        ? { disposition: input.uncertainObjectiveState ?? "blocked" as const }
        : {})
    });

    const replanRequest = objectiveEvaluation.state === "new_work_required"
      ? createGovernedReplanRequest({
          id: `replan:${objectiveEvaluation.id}`,
          evaluation: objectiveEvaluation,
          scope: context.scope,
          requestedAt: evaluationAt,
          previousPlanId: input.previousPlanId
        })
      : undefined;

    return Object.freeze({
      job,
      verification,
      objectiveEvaluation,
      replanRequest
    });
  }

  admitReplannedWork(input: {
    request: GovernedReplanRequest;
    plan: PlanProposal;
    admission: WorkAdmissionEnvelope;
    scope: TrustedExecutionScope;
    now?: number;
  }) {
    return assertGovernedReplanAdmission(input);
  }
}
