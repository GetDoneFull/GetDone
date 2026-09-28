import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { assertTrustedExecutionScopeEqual } from "@/lib/control-plane/trusted-execution-scope";
import type { WorkAdmissionEnvelope } from "@/lib/planning/work-admission";
import { assertWorkAdmissionEnvelope } from "@/lib/planning/work-admission";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import { hashPlan } from "@/lib/planning/plan-hash";
import {
  assertVerificationContractIntegrity,
  assertVerificationReceiptIntegrity,
  assertVerifiedCurrentStateIntegrity,
  evaluateVerificationCheck,
  type VerificationCheckResult,
  type VerificationContract,
  type VerificationReceipt,
  type VerificationSubject,
  type VerificationValue,
  type VerifiedCurrentState
} from "@/lib/verification/verification";

export type ObjectiveOutcomeState =
  | "completed"
  | "partially_completed"
  | "new_work_required"
  | "blocked"
  | "needs_owner_input"
  | "failed"
  | "cancelled";

export interface ObjectiveDesiredOutcome {
  objectiveId: string;
  contract: VerificationContract;
  desiredOutcomeHash: string;
}

export interface ObjectiveOutcomeEvaluation {
  id: string;
  objectiveId: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  state: ObjectiveOutcomeState;
  desiredOutcomeHash: string;
  verifiedCurrentState?: VerifiedCurrentState;
  eligibleSubjects: readonly VerificationSubject[];
  checkResults: readonly VerificationCheckResult[];
  sourceVerificationReceiptIds: readonly string[];
  sourceVerificationReceiptHashes: readonly string[];
  evaluatedAt: string;
  evaluationHash: string;
}

export const REPLAN_GOVERNANCE_PIPELINE = Object.freeze([
  "plan",
  "validation",
  "policy",
  "authority"
] as const);

export interface GovernedReplanRequest {
  id: string;
  objectiveId: string;
  objectiveEvaluationId: string;
  objectiveEvaluationHash: string;
  scope: TrustedExecutionScope;
  previousPlanId?: string;
  requiredPipeline: typeof REPLAN_GOVERNANCE_PIPELINE;
  requestedAt: string;
  requestHash: string;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function buildMergedCurrentState(
  receipts: readonly VerificationReceipt[]
): VerifiedCurrentState | undefined {
  const candidates = receipts
    .map((receipt) => receipt.verifiedCurrentState)
    .filter((state): state is VerifiedCurrentState => Boolean(state));

  if (candidates.length === 0) return undefined;
  candidates.forEach(assertVerifiedCurrentStateIntegrity);

  const latest = new Map<string, {
    observedAt: number;
    value: VerificationValue;
    evidenceIds: Set<string>;
    evidenceHashes: Set<string>;
    conflict: boolean;
  }>();

  for (const state of candidates) {
    const observedAt = Date.parse(state.observedAt);
    for (const [key, value] of Object.entries(state.values)) {
      const current = latest.get(key);
      if (!current || observedAt > current.observedAt) {
        latest.set(key, {
          observedAt,
          value,
          evidenceIds: new Set(state.sourceEvidenceIds),
          evidenceHashes: new Set(state.sourceEvidenceHashes),
          conflict: state.conflictingKeys.includes(key)
        });
        continue;
      }
      if (observedAt === current.observedAt) {
        state.sourceEvidenceIds.forEach((id) => current.evidenceIds.add(id));
        state.sourceEvidenceHashes.forEach((hash) => current.evidenceHashes.add(hash));
        if (!Object.is(current.value, value) || state.conflictingKeys.includes(key)) {
          current.conflict = true;
        }
      }
    }
  }

  const values: Record<string, VerificationValue> = {};
  const sourceEvidenceIds = new Set<string>();
  const sourceEvidenceHashes = new Set<string>();
  const conflictingKeys: string[] = [];
  let observedAt = 0;

  for (const key of [...latest.keys()].sort()) {
    const entry = latest.get(key)!;
    values[key] = entry.value;
    observedAt = Math.max(observedAt, entry.observedAt);
    entry.evidenceIds.forEach((id) => sourceEvidenceIds.add(id));
    entry.evidenceHashes.forEach((hash) => sourceEvidenceHashes.add(hash));
    if (entry.conflict) conflictingKeys.push(key);
  }

  const base = {
    values: Object.freeze(values),
    sourceEvidenceIds: Object.freeze([...sourceEvidenceIds].sort()),
    sourceEvidenceHashes: Object.freeze([...sourceEvidenceHashes].sort()),
    conflictingKeys: Object.freeze(conflictingKeys.sort()),
    observedAt: new Date(observedAt).toISOString()
  };

  return Object.freeze({
    ...base,
    stateHash: sha256Hex(base)
  });
}

export function createObjectiveDesiredOutcome(input: {
  objectiveId: string;
  contract: VerificationContract;
}): ObjectiveDesiredOutcome {
  if (!input.objectiveId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Objective id is required");
  }
  assertVerificationContractIntegrity(input.contract);
  const base = {
    objectiveId: input.objectiveId,
    contract: input.contract
  };
  return Object.freeze({
    ...base,
    desiredOutcomeHash: sha256Hex(base)
  });
}

export function assertObjectiveDesiredOutcome(outcome: ObjectiveDesiredOutcome) {
  const { desiredOutcomeHash, ...base } = outcome;
  if (
    sha256Hex(base) !== desiredOutcomeHash
    || outcome.contract.contractHash !== base.contract.contractHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Objective desired outcome integrity check failed");
  }
  assertVerificationContractIntegrity(outcome.contract);
  return outcome;
}

export function assertObjectiveOutcomeEvaluation(evaluation: ObjectiveOutcomeEvaluation) {
  const { evaluationHash, ...base } = evaluation;
  if (sha256Hex(base) !== evaluationHash) {
    throw new ControlPlaneError("FORBIDDEN", "Objective outcome evaluation integrity check failed");
  }
  if (evaluation.verifiedCurrentState) {
    assertVerifiedCurrentStateIntegrity(evaluation.verifiedCurrentState);
  }
  return evaluation;
}

export function evaluateObjectiveOutcome(input: {
  id: string;
  desiredOutcome: ObjectiveDesiredOutcome;
  verificationReceipts: readonly VerificationReceipt[];
  scope: TrustedExecutionScope;
  eligibleSubjects: readonly VerificationSubject[];
  evaluatedAt: string;
  canGenerateMoreWork: boolean;
  disposition?: Extract<
    ObjectiveOutcomeState,
    "blocked" | "needs_owner_input" | "failed" | "cancelled"
  >;
}): ObjectiveOutcomeEvaluation {
  assertObjectiveDesiredOutcome(input.desiredOutcome);
  const evaluatedAt = parseTime(input.evaluatedAt, "Objective evaluatedAt");

  if (input.eligibleSubjects.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Objective evaluation requires at least one authorized verification subject"
    );
  }
  const eligibleSubjects = input.eligibleSubjects.map((subject) => Object.freeze({ ...subject }));
  const subjectKeys = new Set(eligibleSubjects.map((subject) => `${subject.type}:${subject.id}`));
  if (subjectKeys.size !== eligibleSubjects.length) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Objective evaluation verification subjects must be unique"
    );
  }

  const receipts = input.verificationReceipts.map((receipt) => {
    assertVerificationReceiptIntegrity(receipt);
    const subjectKey = `${receipt.subject.type}:${receipt.subject.id}`;
    if (
      receipt.portfolioId !== input.scope.portfolioId
      || receipt.companyId !== input.scope.companyId
      || receipt.environment !== input.scope.environment
      || !subjectKeys.has(subjectKey)
      || Date.parse(receipt.verifiedAt) > evaluatedAt
      || Date.parse(receipt.expiresAt) <= evaluatedAt
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Objective evaluation receipt is stale or outside authoritative scope"
      );
    }
    return receipt;
  });

  const verifiedCurrentState = buildMergedCurrentState(receipts);
  const checkResults = input.desiredOutcome.contract.checks.map((check) =>
    evaluateVerificationCheck(check, verifiedCurrentState)
  );
  const required = checkResults.filter(
    (_result, index) => input.desiredOutcome.contract.checks[index].required
  );
  const allVerified = required.length > 0
    && required.every((result) => result.verdict === "verified");
  const anyVerified = required.some((result) => result.verdict === "verified");

  let state: ObjectiveOutcomeState;
  if (input.disposition) {
    state = input.disposition;
  } else if (allVerified) {
    state = "completed";
  } else if (input.canGenerateMoreWork) {
    state = "new_work_required";
  } else if (anyVerified) {
    state = "partially_completed";
  } else {
    state = "failed";
  }

  const base = {
    id: input.id,
    objectiveId: input.desiredOutcome.objectiveId,
    portfolioId: input.scope.portfolioId,
    companyId: input.scope.companyId,
    environment: input.scope.environment,
    state,
    desiredOutcomeHash: input.desiredOutcome.desiredOutcomeHash,
    eligibleSubjects: Object.freeze(eligibleSubjects),
    verifiedCurrentState,
    checkResults: Object.freeze(checkResults),
    sourceVerificationReceiptIds: Object.freeze(receipts.map((receipt) => receipt.id).sort()),
    sourceVerificationReceiptHashes: Object.freeze(
      receipts.map((receipt) => receipt.receiptHash).sort()
    ),
    evaluatedAt: new Date(evaluatedAt).toISOString()
  };

  return Object.freeze({
    ...base,
    evaluationHash: sha256Hex(base)
  });
}

export function createGovernedReplanRequest(input: {
  id: string;
  evaluation: ObjectiveOutcomeEvaluation;
  scope: TrustedExecutionScope;
  requestedAt: string;
  previousPlanId?: string;
}): GovernedReplanRequest {
  assertObjectiveOutcomeEvaluation(input.evaluation);
  assertTrustedExecutionScopeEqual(input.scope, {
    ...input.scope,
    portfolioId: input.evaluation.portfolioId,
    companyId: input.evaluation.companyId,
    environment: input.evaluation.environment
  });

  if (input.evaluation.state !== "new_work_required") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Only a new_work_required Objective evaluation may request another plan"
    );
  }
  parseTime(input.requestedAt, "Governed replan requestedAt");

  const base = {
    id: input.id,
    objectiveId: input.evaluation.objectiveId,
    objectiveEvaluationId: input.evaluation.id,
    objectiveEvaluationHash: input.evaluation.evaluationHash,
    scope: Object.freeze({ ...input.scope }),
    previousPlanId: input.previousPlanId,
    requiredPipeline: REPLAN_GOVERNANCE_PIPELINE,
    requestedAt: input.requestedAt
  };

  return Object.freeze({
    ...base,
    requestHash: sha256Hex(base)
  });
}

export function assertGovernedReplanRequest(request: GovernedReplanRequest) {
  const { requestHash, ...base } = request;
  if (
    sha256Hex(base) !== requestHash
    || request.requiredPipeline.length !== REPLAN_GOVERNANCE_PIPELINE.length
    || request.requiredPipeline.some(
      (stage, index) => stage !== REPLAN_GOVERNANCE_PIPELINE[index]
    )
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Governed replan request integrity or governance pipeline check failed"
    );
  }
  return request;
}

export function assertGovernedReplanAdmission(input: {
  request: GovernedReplanRequest;
  admission: WorkAdmissionEnvelope;
  plan: PlanProposal;
  scope: TrustedExecutionScope;
  now?: number;
}) {
  assertGovernedReplanRequest(input.request);
  assertTrustedExecutionScopeEqual(input.request.scope, input.scope, {
    requireSameResource: Boolean(
      input.request.scope.resourceId || input.scope.resourceId
    )
  });

  const admission = assertWorkAdmissionEnvelope(input.admission, {
    scope: input.scope,
    now: input.now
  });
  const planHash = hashPlan(input.plan);
  if (
    input.plan.id !== admission.planId
    || planHash !== admission.planHash
    || input.plan.source.type !== "objective"
    || input.plan.source.objectiveId !== input.request.objectiveId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Replanned work admission must bind to a fresh governed plan for the same Objective"
    );
  }

  if (Date.parse(admission.createdAt) < Date.parse(input.request.requestedAt)) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Replanned work admission predates the Objective replan request"
    );
  }
  if (
    input.request.previousPlanId
    && admission.planId === input.request.previousPlanId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Replanned work must be admitted from a newly governed plan"
    );
  }
  if (
    !admission.validationReceiptId
    || !admission.validationReceiptHash
    || !admission.policySnapshotId
    || !admission.policySnapshotHash
    || !admission.authorizationGrantId
    || !admission.authorizationGrantHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Replanned work must prove Plan, Validation, Policy, and Authority lineage"
    );
  }

  return admission;
}
