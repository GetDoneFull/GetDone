import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { DecisionAction } from "@/lib/control-plane/schemas";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import {
  assertApprovalProof,
  assertStepUpProof,
  createApprovalProof,
  type ApprovalProof,
  type StepUpProof
} from "@/lib/authorization/proofs";
import type { DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import { authoritativeTransitionService } from "@/lib/domain/services/transition-service";
import {
  assertTrustedExecutionScopeEqual,
  type TrustedExecutionScope
} from "@/lib/control-plane/trusted-execution-scope";

export type AuthoritativeDecisionStatus = "pending" | "approved" | "modified" | "rejected";

export interface OrchestrationApprovalBinding {
  orchestrationRunId: string;
  trustedScope: TrustedExecutionScope;
  policyEvaluationArtifactId: string;
  policyEvaluationArtifactHash: string;
  planArtifactId: string;
  planArtifactHash: string;
  planHash: string;
  stepId: string;
  stepHash: string;
  policySnapshotId: string;
  policySnapshotHash: string;
  validationReceiptId: string;
  validationReceiptHash: string;
  requirement: "approval" | "strong-approval";
  proofExpiresAt: string;
}

export interface AuthoritativeDecision {
  id: string;
  correlationId?: string;
  portfolioId: string;
  companyId: string;
  status: AuthoritativeDecisionStatus;
  version: number;
  requiresStepUp: boolean;
  updatedAt: string;
  approvalBinding?: OrchestrationApprovalBinding;
  approvalProof?: ApprovalProof;
  stepUpProof?: StepUpProof;
  resolvedBy?: string;
}

export interface DecisionAuthorityStore {
  get(id: string): Promise<AuthoritativeDecision | null>;
  save(next: AuthoritativeDecision, expectedVersion: number): Promise<void>;
}

export interface DecisionResumeRequest {
  id: string;
  runId: string;
  decisionId: string;
  decisionVersion: number;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  resolution: Exclude<AuthoritativeDecisionStatus, "pending">;
  createdAt: string;
  requestHash: string;
}

export interface DecisionResumeRequestStore {
  create(request: DecisionResumeRequest): Promise<void>;
}

export interface DecisionMutation {
  type: "decision.resolve";
  decisionId: string;
  action: DecisionAction;
}

export interface ResolveDecisionInput {
  command: AuthoritativeCommandEnvelope<DecisionMutation>;
  transactionManager: DecisionTransactionManager;
  decisionId: string;
  action: DecisionAction;
  stepUpProof?: StepUpProof;
  now?: () => Date;
}

function targetState(action: DecisionAction): AuthoritativeDecisionStatus {
  if (action === "approve") return "approved";
  if (action === "modify") return "modified";
  return "rejected";
}

function approvalExpiry(
  binding: OrchestrationApprovalBinding,
  stepUpProof?: StepUpProof
) {
  const candidates = [Date.parse(binding.proofExpiresAt)];
  if (stepUpProof) candidates.push(Date.parse(stepUpProof.expiresAt));
  if (candidates.some((value) => !Number.isFinite(value))) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Decision approval binding has an invalid proof expiry"
    );
  }
  return new Date(Math.min(...candidates)).toISOString();
}

function createDecisionResumeRequest(input: {
  decision: AuthoritativeDecision;
  nextState: Exclude<AuthoritativeDecisionStatus, "pending">;
  nextVersion: number;
  createdAt: string;
}): DecisionResumeRequest | null {
  const binding = input.decision.approvalBinding;
  if (!binding) return null;

  const base = {
    id: `decision-resume:${input.decision.id}:v${input.nextVersion}`,
    runId: binding.orchestrationRunId,
    decisionId: input.decision.id,
    decisionVersion: input.nextVersion,
    correlationId: input.decision.correlationId ?? binding.orchestrationRunId,
    portfolioId: input.decision.portfolioId,
    companyId: input.decision.companyId,
    resolution: input.nextState,
    createdAt: input.createdAt
  };

  return Object.freeze({
    ...base,
    requestHash: sha256Hex(base)
  });
}

export async function resolveDecision(input: ResolveDecisionInput): Promise<AuthoritativeDecision> {
  if (
    input.command.requestedMutation.type !== "decision.resolve"
    || input.command.requestedMutation.decisionId !== input.decisionId
    || input.command.requestedMutation.action !== input.action
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Decision command mutation does not match requested decision action"
    );
  }

  const now = input.now ?? (() => new Date());
  const nextState = targetState(input.action);

  return authoritativeTransitionService.transition({
    manager: input.transactionManager,
    selectStore: (stores) => stores.decisions,
    entityType: "decision",
    entityId: input.decisionId,
    to: nextState,
    command: input.command,
    triggeringEvent: `decision-${nextState}`,
    stateOf: (decision) => decision.status,
    applyState: (decision, state) => ({
      ...decision,
      status: state as AuthoritativeDecisionStatus
    }),
    beforeTransition: (current) => {
      if (current.approvalBinding) {
        assertTrustedExecutionScopeEqual(
          current.approvalBinding.trustedScope,
          input.command.scope,
          {
            requireSameResource: Boolean(
              current.approvalBinding.trustedScope.resourceId
              || input.command.scope.resourceId
            )
          }
        );

        const expectedStepUp =
          current.approvalBinding.requirement === "strong-approval";
        if (current.requiresStepUp !== expectedStepUp) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Decision step-up requirement does not match its approval binding",
            { correlationId: input.command.correlationId }
          );
        }
      }

      if (current.requiresStepUp && input.action === "approve") {
        if (!input.stepUpProof) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Fresh step-up proof is required for this approval",
            { correlationId: input.command.correlationId }
          );
        }
        assertStepUpProof(input.stepUpProof, {
          actorId: input.command.actor.id,
          scope: input.command.scope,
          now: now().getTime()
        });
      }
    },
    patch: async (current, transaction) => {
      const resolvedAt = now().toISOString();
      const patch: Partial<AuthoritativeDecision> = {
        resolvedBy: input.command.actor.id
      };

      if (input.action === "approve" && current.approvalBinding) {
        const binding = current.approvalBinding;
        const boundStepUp = binding.requirement === "strong-approval"
          ? input.stepUpProof
          : undefined;
        const expiresAt = approvalExpiry(binding, boundStepUp);
        if (Date.parse(expiresAt) <= Date.parse(resolvedAt)) {
          throw new ControlPlaneError(
            "POLICY_BLOCKED",
            "Approval evidence expired before the Decision was resolved",
            { correlationId: input.command.correlationId }
          );
        }

        const proof = createApprovalProof({
          id: `approval-proof:${current.id}:v${current.version + 1}`,
          decisionId: current.id,
          approvalId: `approval:${current.id}`,
          actorId: input.command.actor.id,
          scope: input.command.scope,
          level: binding.requirement,
          planHash: binding.planHash,
          stepHash: binding.stepHash,
          grantedAt: resolvedAt,
          expiresAt,
          stepUpProofId: boundStepUp?.id
        });

        assertApprovalProof(proof, {
          actorId: input.command.actor.id,
          scope: input.command.scope,
          planHash: binding.planHash,
          stepHash: binding.stepHash,
          requiredLevel: binding.requirement,
          stepUpProof: boundStepUp,
          now: Date.parse(resolvedAt)
        });

        patch.approvalProof = proof;
        if (binding.requirement === "strong-approval") {
          patch.stepUpProof = boundStepUp;
        }
      }

      const resumeRequest = createDecisionResumeRequest({
        decision: current,
        nextState,
        nextVersion: current.version + 1,
        createdAt: resolvedAt
      });
      if (resumeRequest) {
        await transaction.stores.resumeRequests?.create(resumeRequest);
      }

      return patch;
    },
    metadata: (current) => ({
      stepUpProofId: input.stepUpProof?.id ?? null,
      orchestrationRunId: current.approvalBinding?.orchestrationRunId ?? null,
      planHash: current.approvalBinding?.planHash ?? null,
      stepHash: current.approvalBinding?.stepHash ?? null,
      approvalRequirement: current.approvalBinding?.requirement ?? null
    }),
    now
  });
}
