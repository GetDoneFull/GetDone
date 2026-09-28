import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import {
  transitionOrchestrationRun,
  type OrchestrationRunRecord
} from "@/lib/orchestration/contracts";
import type { OrchestrationStageOutcome } from "@/lib/orchestration/worker-contracts";
import {
  assertPersistedPlanProposal,
  type OrchestrationPlanProposalStore,
  type PersistedPlanProposal
} from "@/lib/orchestration/planning-flow";
import {
  assertPlanValidatorAttestation,
  attestPlanValidation,
  type PlanValidationPolicy,
  type PlanValidatorAttestation
} from "@/lib/planning/plan-validator";
import {
  assertValidationReceipt,
  assertValidationSnapshot,
  createValidationReceipt,
  createValidationSnapshot,
  type PlanValidationReceipt,
  type ValidationSnapshot,
  type ValidationSnapshotInput
} from "@/lib/planning/validation-receipt";
import { hashPlanStep } from "@/lib/planning/plan-hash";
import {
  evaluateStepPolicy,
  strongestDisposition,
  POLICY_ENGINE_VERSION,
  POLICY_RULES_HASH,
  type PolicyDisposition,
  type StepPolicyEvaluation
} from "@/lib/planning/policy-engine";
import {
  assertPolicySnapshotIntegrity,
  createPolicySnapshot,
  type PolicySnapshot,
  type PolicySnapshotInput
} from "@/lib/planning/policy-snapshot";
import type { PlanStep } from "@/lib/planning/plan-schema";

export const ORCHESTRATION_VALIDATION_POLICY_FLOW_VERSION = "1.0.0";

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export interface DurableValidationInputs {
  validationPolicy: PlanValidationPolicy;
  snapshot: Omit<
    ValidationSnapshotInput,
    "id" | "createdAt" | "policyVersion" | "environment"
  >;
  receiptExpiresAt: string;
}

export interface DurableValidationInputResolver {
  resolve(input: {
    run: OrchestrationRunRecord;
    planArtifact: PersistedPlanProposal;
    idempotencyKey: string;
  }): Promise<DurableValidationInputs>;
}

export interface DurableValidationArtifact {
  id: string;
  runId: string;
  plannedRunVersion: number;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  planArtifactId: string;
  planArtifactHash: string;
  planHash: string;
  validationPolicy: PlanValidationPolicy;
  validationPolicyHash: string;
  snapshot: ValidationSnapshot;
  attestation: PlanValidatorAttestation;
  receipt: PlanValidationReceipt;
  createdAt: string;
  artifactHash: string;
}

export interface OrchestrationValidationArtifactStore {
  create(
    artifact: DurableValidationArtifact,
    idempotencyKey: string
  ): Promise<{
    status: "created" | "idempotent-replay";
    artifact: DurableValidationArtifact;
  }>;
  get(id: string): Promise<DurableValidationArtifact | null>;
  getByRunVersion(
    runId: string,
    plannedRunVersion: number
  ): Promise<DurableValidationArtifact | null>;
}

export type DurablePolicyStepInputs = Omit<
  PolicySnapshotInput,
  | "id"
  | "policyVersion"
  | "scope"
  | "planHash"
  | "stepHash"
  | "capabilityNames"
  | "dataClass"
  | "idempotencyKey"
  | "resourceRequirements"
  | "createdAt"
>;

export interface DurablePolicyInputResolver {
  resolveStep(input: {
    run: OrchestrationRunRecord;
    planArtifact: PersistedPlanProposal;
    validationArtifact: DurableValidationArtifact;
    step: PlanStep;
    idempotencyKey: string;
  }): Promise<DurablePolicyStepInputs>;
}

export interface DurablePolicyStepSnapshotArtifact {
  id: string;
  runId: string;
  validatedRunVersion: number;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  planArtifactId: string;
  planArtifactHash: string;
  validationReceiptId: string;
  validationReceiptHash: string;
  stepId: string;
  stepHash: string;
  snapshot: PolicySnapshot;
  createdAt: string;
  artifactHash: string;
}

export interface OrchestrationPolicyStepSnapshotStore {
  create(
    artifact: DurablePolicyStepSnapshotArtifact,
    idempotencyKey: string
  ): Promise<{
    status: "created" | "idempotent-replay";
    artifact: DurablePolicyStepSnapshotArtifact;
  }>;
  getByRunVersionStep(
    runId: string,
    validatedRunVersion: number,
    stepId: string
  ): Promise<DurablePolicyStepSnapshotArtifact | null>;
}

export interface DurableStepPolicyRecord {
  stepId: string;
  stepHash: string;
  snapshot: PolicySnapshot;
  evaluation: StepPolicyEvaluation;
}

export interface DurablePolicyEvaluationArtifact {
  id: string;
  runId: string;
  validatedRunVersion: number;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  planArtifactId: string;
  planArtifactHash: string;
  planHash: string;
  validationReceiptId: string;
  validationReceiptHash: string;
  stepPolicies: readonly DurableStepPolicyRecord[];
  aggregateDisposition: PolicyDisposition;
  policyEngineVersion: string;
  policyRulesHash: string;
  createdAt: string;
  artifactHash: string;
}

export interface OrchestrationPolicyEvaluationStore {
  create(
    artifact: DurablePolicyEvaluationArtifact,
    idempotencyKey: string
  ): Promise<{
    status: "created" | "idempotent-replay";
    artifact: DurablePolicyEvaluationArtifact;
  }>;
  get(id: string): Promise<DurablePolicyEvaluationArtifact | null>;
  getByRunVersion(
    runId: string,
    validatedRunVersion: number
  ): Promise<DurablePolicyEvaluationArtifact | null>;
}

export function validationSnapshotId(runId: string, plannedRunVersion: number) {
  return `validation-snapshot:${runId}:v${plannedRunVersion}`;
}

export function validationReceiptId(runId: string, plannedRunVersion: number) {
  return `validation-receipt:${runId}:v${plannedRunVersion}`;
}

export function validationArtifactIdempotencyKey(
  runId: string,
  plannedRunVersion: number
) {
  return `orchestration:${runId}:v${plannedRunVersion}:validation`;
}

export function policySnapshotId(
  runId: string,
  validatedRunVersion: number,
  stepId: string
) {
  return `policy-snapshot:${runId}:v${validatedRunVersion}:${stepId}`;
}

export function policyStepIdempotencyKey(
  runId: string,
  validatedRunVersion: number,
  stepId: string
) {
  return `orchestration:${runId}:v${validatedRunVersion}:policy:${stepId}`;
}

export function policyEvaluationArtifactId(
  runId: string,
  validatedRunVersion: number
) {
  return `policy-evaluation:${runId}:v${validatedRunVersion}`;
}

export function policyEvaluationIdempotencyKey(
  runId: string,
  validatedRunVersion: number
) {
  return `orchestration:${runId}:v${validatedRunVersion}:policy-evaluation`;
}

function assertPlanArtifactForRun(
  run: OrchestrationRunRecord,
  artifact: PersistedPlanProposal
) {
  assertPersistedPlanProposal(artifact);
  const planRef = run.checkpoints.plan;
  if (
    !planRef
    || planRef.id !== artifact.id
    || planRef.hash !== artifact.planHash
    || artifact.runId !== run.id
    || artifact.correlationId !== run.correlationId
    || artifact.portfolioId !== run.scope.portfolioId
    || artifact.companyId !== run.scope.companyId
    || artifact.proposal.scope.portfolioId !== run.scope.portfolioId
    || artifact.proposal.scope.companyId !== run.scope.companyId
    || artifact.proposal.scope.environment !== run.scope.environment
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Immutable Plan artifact does not match orchestration lineage",
      { correlationId: run.correlationId }
    );
  }
  return artifact;
}

async function loadPlanArtifact(
  run: OrchestrationRunRecord,
  plans: OrchestrationPlanProposalStore
) {
  const ref = run.checkpoints.plan;
  if (!ref) {
    throw new ControlPlaneError("CONFLICT", "Orchestration is missing Plan checkpoint");
  }
  const artifact = await plans.get(ref.id);
  if (!artifact) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Plan artifact referenced by orchestration was not found",
      { correlationId: run.correlationId }
    );
  }
  return assertPlanArtifactForRun(run, artifact);
}

export function createDurableValidationArtifact(input: {
  run: OrchestrationRunRecord;
  planArtifact: PersistedPlanProposal;
  validationPolicy: PlanValidationPolicy;
  snapshot: ValidationSnapshot;
  attestation: PlanValidatorAttestation;
  receipt: PlanValidationReceipt;
  createdAt: string;
}): DurableValidationArtifact {
  if (input.run.state !== "planned") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Validation artifact may only be created from planned state",
      { correlationId: input.run.correlationId }
    );
  }
  assertPlanArtifactForRun(input.run, input.planArtifact);

  if (
    input.validationPolicy.trustedScope.portfolioId !== input.run.scope.portfolioId
    || input.validationPolicy.trustedScope.companyId !== input.run.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation policy attempted to broaden orchestration tenant scope",
      { correlationId: input.run.correlationId }
    );
  }

  const base = {
    id: input.receipt.id,
    runId: input.run.id,
    plannedRunVersion: input.run.version,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    planArtifactId: input.planArtifact.id,
    planArtifactHash: input.planArtifact.artifactHash,
    planHash: input.planArtifact.planHash,
    validationPolicy: input.validationPolicy,
    validationPolicyHash: sha256Hex(input.validationPolicy),
    snapshot: input.snapshot,
    attestation: input.attestation,
    receipt: input.receipt,
    createdAt: new Date(input.createdAt).toISOString()
  };

  return deepFreeze({
    ...base,
    artifactHash: sha256Hex(base)
  });
}

export function assertDurableValidationArtifact(
  artifact: DurableValidationArtifact,
  planArtifact?: PersistedPlanProposal
) {
  const { artifactHash, ...base } = artifact;
  if (
    sha256Hex(base) !== artifactHash
    || sha256Hex(artifact.validationPolicy) !== artifact.validationPolicyHash
    || artifact.receipt.id !== artifact.id
    || artifact.receipt.planHash !== artifact.planHash
    || artifact.receipt.snapshot.snapshotHash !== artifact.snapshot.snapshotHash
    || artifact.attestation.attestationHash !== artifact.receipt.validatorAttestationHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Durable validation artifact integrity check failed",
      { correlationId: artifact.correlationId }
    );
  }

  assertValidationSnapshot(
    artifact.snapshot,
    Date.parse(artifact.createdAt)
  );

  if (artifact.attestation.validationPolicyHash !== artifact.validationPolicyHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation attestation does not match frozen validation policy",
      { correlationId: artifact.correlationId }
    );
  }

  if (planArtifact) {
    assertPersistedPlanProposal(planArtifact);
    if (
      artifact.planArtifactId !== planArtifact.id
      || artifact.planArtifactHash !== planArtifact.artifactHash
      || artifact.planHash !== planArtifact.planHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Validation artifact does not match immutable Plan artifact",
        { correlationId: artifact.correlationId }
      );
    }
    assertPlanValidatorAttestation(
      artifact.attestation,
      planArtifact.proposal
    );
    if (
      artifact.snapshot.environment !== planArtifact.proposal.scope.environment
      || artifact.receipt.planId !== planArtifact.proposal.id
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Validation artifact plan/environment lineage is invalid",
        { correlationId: artifact.correlationId }
      );
    }

    if (
      artifact.receipt.status === "valid"
      && artifact.receipt.errors.length === 0
      && artifact.receipt.ownerDecisions.length === 0
    ) {
      assertValidationReceipt(
        artifact.receipt,
        planArtifact.proposal,
        Date.parse(artifact.createdAt)
      );
    }
  }

  return artifact;
}

function transitionFromValidationArtifact(
  run: OrchestrationRunRecord,
  artifact: DurableValidationArtifact,
  now: Date
): OrchestrationStageOutcome {
  const receipt = artifact.receipt;
  const checkpointPatch = {
    validationReceipt: {
      id: receipt.id,
      hash: receipt.receiptHash
    }
  };

  if (
    receipt.status !== "valid"
    || receipt.errors.length > 0
    || receipt.ownerDecisions.length > 0
  ) {
    return {
      kind: "advance",
      next: transitionOrchestrationRun(run, {
        to: "blocked",
        now: now.toISOString(),
        checkpointPatch,
        blockedReason:
          `Plan validation did not produce a clean executable proposal: ${receipt.status}`
      })
    };
  }

  return {
    kind: "advance",
    next: transitionOrchestrationRun(run, {
      to: "validated",
      now: now.toISOString(),
      checkpointPatch
    })
  };
}

export async function advancePlannedToValidated(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  resolver: DurableValidationInputResolver;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  const now = input.now ?? (() => new Date());
  if (input.run.state !== "planned") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Validation stage requires planned orchestration state",
      { correlationId: input.run.correlationId }
    );
  }

  const planArtifact = await loadPlanArtifact(input.run, input.plans);

  const existing = await input.validations.getByRunVersion(
    input.run.id,
    input.run.version
  );
  if (existing) {
    assertDurableValidationArtifact(existing, planArtifact);
    if (
      existing.portfolioId !== input.run.scope.portfolioId
      || existing.companyId !== input.run.scope.companyId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Existing validation artifact is outside orchestration tenant scope"
      );
    }

    return transitionFromValidationArtifact(input.run, existing, now());
  }

  const validationIdempotencyKey = validationArtifactIdempotencyKey(
    input.run.id,
    input.run.version
  );
  const resolved = await input.resolver.resolve({
    run: input.run,
    planArtifact,
    idempotencyKey: validationIdempotencyKey
  });

  if (
    resolved.validationPolicy.trustedScope.portfolioId !== input.run.scope.portfolioId
    || resolved.validationPolicy.trustedScope.companyId !== input.run.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation input resolver attempted cross-tenant policy scope",
      { correlationId: input.run.correlationId }
    );
  }

  const createdAt = now().toISOString();
  const snapshot = createValidationSnapshot({
    ...resolved.snapshot,
    id: validationSnapshotId(input.run.id, input.run.version),
    policyVersion: CURRENT_POLICY_VERSION,
    environment: planArtifact.proposal.scope.environment,
    createdAt
  });
  const attestation = attestPlanValidation(
    planArtifact.proposal,
    resolved.validationPolicy,
    createdAt
  );
  const receipt = createValidationReceipt({
    id: validationReceiptId(input.run.id, input.run.version),
    plan: planArtifact.proposal,
    attestation,
    snapshot,
    validatedAt: createdAt,
    expiresAt: resolved.receiptExpiresAt
  });

  const artifact = createDurableValidationArtifact({
    run: input.run,
    planArtifact,
    validationPolicy: resolved.validationPolicy,
    snapshot,
    attestation,
    receipt,
    createdAt
  });

  const persisted = await input.validations.create(
    artifact,
    validationIdempotencyKey
  );
  assertDurableValidationArtifact(persisted.artifact, planArtifact);

  if (
    persisted.artifact.receipt.status === "valid"
    && persisted.artifact.receipt.errors.length === 0
    && persisted.artifact.receipt.ownerDecisions.length === 0
  ) {
    assertValidationReceipt(
      persisted.artifact.receipt,
      planArtifact.proposal,
      now().getTime()
    );
  }

  return transitionFromValidationArtifact(input.run, persisted.artifact, now());
}

function evaluateFrozenPolicySnapshot(
  snapshot: PolicySnapshot,
  now: number
): StepPolicyEvaluation {
  assertPolicySnapshotIntegrity(snapshot);
  return evaluateStepPolicy({
    authenticated: true,
    scopeResolved: true,
    trustedScope: snapshot.scope,
    capabilities: snapshot.capabilityNames,
    planHash: snapshot.planHash,
    stepHash: snapshot.stepHash,
    environment: snapshot.scope.environment,
    dataClass: snapshot.dataClass,
    region: snapshot.region,
    allowedEnvironments: snapshot.allowedEnvironments,
    allowedDataClasses: snapshot.allowedDataClasses,
    allowedRegions: snapshot.allowedRegions,
    integrationId: snapshot.integrationId,
    resourceId: snapshot.resourceId,
    poolId: snapshot.poolId,
    providerId: snapshot.providerId,
    failureDomainId: snapshot.failureDomainId,
    workloadClass: snapshot.workloadClass,
    credentialRequirementIds: snapshot.credentialRequirementIds,
    credentialSnapshot: snapshot.credentialSnapshot,
    capacitySnapshot: snapshot.capacitySnapshot,
    capacityEvidenceRequired: snapshot.capacityEvidenceRequired,
    fallbackRequired: snapshot.fallbackRequired,
    fallbackAvailable: snapshot.fallbackAvailable,
    idempotencyKey: snapshot.idempotencyKey,
    killSwitches: snapshot.killSwitches,
    budget: snapshot.budget,
    budgetReservation: snapshot.budgetReservation,
    guardrails: snapshot.guardrails,
    now
  });
}

export function createDurablePolicyStepSnapshotArtifact(input: {
  run: OrchestrationRunRecord;
  planArtifact: PersistedPlanProposal;
  validationArtifact: DurableValidationArtifact;
  step: PlanStep;
  snapshot: PolicySnapshot;
  createdAt: string;
}): DurablePolicyStepSnapshotArtifact {
  if (input.run.state !== "validated") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Policy step snapshot may only be created from validated state",
      { correlationId: input.run.correlationId }
    );
  }
  assertPlanArtifactForRun(input.run, input.planArtifact);
  assertDurableValidationArtifact(input.validationArtifact, input.planArtifact);
  assertPolicySnapshotIntegrity(input.snapshot);

  const expectedStepHash = hashPlanStep(input.step);
  if (
    input.snapshot.planHash !== input.planArtifact.planHash
    || input.snapshot.stepHash !== expectedStepHash
    || input.snapshot.scope.portfolioId !== input.run.scope.portfolioId
    || input.snapshot.scope.companyId !== input.run.scope.companyId
    || input.snapshot.scope.environment !== input.run.scope.environment
    || input.snapshot.dataClass !== input.planArtifact.proposal.scope.dataClass
    || sha256Hex(input.snapshot.resourceRequirements)
      !== sha256Hex(input.step.resourceRequirements)
    || sha256Hex([...input.snapshot.capabilityNames].sort())
      !== sha256Hex([...new Set(input.step.capabilityRequests.map(
        (request) => request.capability
      ))].sort())
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Policy step snapshot does not match validated orchestration lineage",
      { correlationId: input.run.correlationId }
    );
  }

  const base = {
    id: input.snapshot.id,
    runId: input.run.id,
    validatedRunVersion: input.run.version,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    planArtifactId: input.planArtifact.id,
    planArtifactHash: input.planArtifact.artifactHash,
    validationReceiptId: input.validationArtifact.receipt.id,
    validationReceiptHash: input.validationArtifact.receipt.receiptHash,
    stepId: input.step.id,
    stepHash: expectedStepHash,
    snapshot: input.snapshot,
    createdAt: new Date(input.createdAt).toISOString()
  };

  return deepFreeze({
    ...base,
    artifactHash: sha256Hex(base)
  });
}

export function assertDurablePolicyStepSnapshotArtifact(
  artifact: DurablePolicyStepSnapshotArtifact,
  input?: {
    run: OrchestrationRunRecord;
    planArtifact: PersistedPlanProposal;
    validationArtifact: DurableValidationArtifact;
    step: PlanStep;
  }
) {
  const { artifactHash, ...base } = artifact;
  if (
    sha256Hex(base) !== artifactHash
    || artifact.id !== artifact.snapshot.id
    || artifact.stepHash !== artifact.snapshot.stepHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Durable policy step snapshot artifact integrity check failed",
      { correlationId: artifact.correlationId }
    );
  }
  assertPolicySnapshotIntegrity(artifact.snapshot);

  if (input) {
    const expectedStepHash = hashPlanStep(input.step);
    if (
      artifact.runId !== input.run.id
      || artifact.validatedRunVersion !== input.run.version
      || artifact.portfolioId !== input.run.scope.portfolioId
      || artifact.companyId !== input.run.scope.companyId
      || artifact.planArtifactId !== input.planArtifact.id
      || artifact.planArtifactHash !== input.planArtifact.artifactHash
      || artifact.validationReceiptId !== input.validationArtifact.receipt.id
      || artifact.validationReceiptHash !== input.validationArtifact.receipt.receiptHash
      || artifact.stepId !== input.step.id
      || artifact.stepHash !== expectedStepHash
      || artifact.snapshot.planHash !== input.planArtifact.planHash
      || artifact.snapshot.scope.portfolioId !== input.run.scope.portfolioId
      || artifact.snapshot.scope.companyId !== input.run.scope.companyId
      || artifact.snapshot.scope.environment !== input.run.scope.environment
      || artifact.snapshot.dataClass !== input.planArtifact.proposal.scope.dataClass
      || sha256Hex(artifact.snapshot.resourceRequirements)
        !== sha256Hex(input.step.resourceRequirements)
      || sha256Hex([...artifact.snapshot.capabilityNames].sort())
        !== sha256Hex([...new Set(input.step.capabilityRequests.map(
          (request) => request.capability
        ))].sort())
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Persisted policy step snapshot does not match orchestration lineage",
        { correlationId: input.run.correlationId }
      );
    }
  }

  return artifact;
}

export function createDurablePolicyEvaluationArtifact(input: {
  run: OrchestrationRunRecord;
  planArtifact: PersistedPlanProposal;
  validationArtifact: DurableValidationArtifact;
  stepPolicies: readonly DurableStepPolicyRecord[];
  createdAt: string;
}): DurablePolicyEvaluationArtifact {
  if (input.run.state !== "validated") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Policy evaluation artifact may only be created from validated state",
      { correlationId: input.run.correlationId }
    );
  }

  assertPlanArtifactForRun(input.run, input.planArtifact);
  assertDurableValidationArtifact(input.validationArtifact, input.planArtifact);

  const validationRef = input.run.checkpoints.validationReceipt;
  if (
    !validationRef
    || validationRef.id !== input.validationArtifact.receipt.id
    || validationRef.hash !== input.validationArtifact.receipt.receiptHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validated orchestration does not reference this validation artifact",
      { correlationId: input.run.correlationId }
    );
  }

  let aggregateDisposition: PolicyDisposition = "AUTO";
  for (const item of input.stepPolicies) {
    aggregateDisposition = strongestDisposition(
      aggregateDisposition,
      item.evaluation.disposition
    );
  }

  const base = {
    id: policyEvaluationArtifactId(input.run.id, input.run.version),
    runId: input.run.id,
    validatedRunVersion: input.run.version,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    planArtifactId: input.planArtifact.id,
    planArtifactHash: input.planArtifact.artifactHash,
    planHash: input.planArtifact.planHash,
    validationReceiptId: input.validationArtifact.receipt.id,
    validationReceiptHash: input.validationArtifact.receipt.receiptHash,
    stepPolicies: input.stepPolicies,
    aggregateDisposition,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    createdAt: new Date(input.createdAt).toISOString()
  };

  return deepFreeze({
    ...base,
    artifactHash: sha256Hex(base)
  });
}

export function assertDurablePolicyEvaluationArtifact(
  artifact: DurablePolicyEvaluationArtifact,
  planArtifact?: PersistedPlanProposal,
  validationArtifact?: DurableValidationArtifact
) {
  const { artifactHash, ...base } = artifact;
  if (
    sha256Hex(base) !== artifactHash
    || artifact.policyEngineVersion !== POLICY_ENGINE_VERSION
    || artifact.policyRulesHash !== POLICY_RULES_HASH
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Durable policy evaluation artifact integrity check failed",
      { correlationId: artifact.correlationId }
    );
  }

  if (planArtifact) {
    assertPersistedPlanProposal(planArtifact);
    if (
      artifact.planArtifactId !== planArtifact.id
      || artifact.planArtifactHash !== planArtifact.artifactHash
      || artifact.planHash !== planArtifact.planHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Policy evaluation does not match immutable Plan artifact"
      );
    }

    const byStep = new Map(planArtifact.proposal.steps.map((step) => [step.id, step]));
    if (
      artifact.stepPolicies.length !== planArtifact.proposal.steps.length
      || new Set(artifact.stepPolicies.map((item) => item.stepId)).size
        !== artifact.stepPolicies.length
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Policy evaluation does not cover every Plan step exactly once"
      );
    }

    for (const item of artifact.stepPolicies) {
      const step = byStep.get(item.stepId);
      if (
        !step
        || item.stepHash !== hashPlanStep(step)
        || item.snapshot.scope.portfolioId !== planArtifact.portfolioId
        || item.snapshot.scope.companyId !== planArtifact.companyId
        || item.snapshot.scope.environment !== planArtifact.proposal.scope.environment
        || item.snapshot.dataClass !== planArtifact.proposal.scope.dataClass
        || sha256Hex(item.snapshot.resourceRequirements)
          !== sha256Hex(step.resourceRequirements)
        || sha256Hex([...item.snapshot.capabilityNames].sort())
          !== sha256Hex([...new Set(step.capabilityRequests.map(
            (request) => request.capability
          ))].sort())
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Policy snapshot does not match immutable Plan step authority"
        );
      }
    }
  }

  if (
    validationArtifact
    && (
      artifact.validationReceiptId !== validationArtifact.receipt.id
      || artifact.validationReceiptHash !== validationArtifact.receipt.receiptHash
    )
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Policy evaluation does not match validation receipt lineage"
    );
  }

  if (validationArtifact && planArtifact) {
    assertValidationReceipt(
      validationArtifact.receipt,
      planArtifact.proposal,
      Date.parse(artifact.createdAt)
    );
  }

  let aggregate: PolicyDisposition = "AUTO";
  for (const item of artifact.stepPolicies) {
    assertPolicySnapshotIntegrity(item.snapshot);
    if (
      item.snapshot.stepHash !== item.stepHash
      || item.snapshot.planHash !== artifact.planHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Policy step snapshot does not match artifact plan/step lineage"
      );
    }
    const reevaluated = evaluateFrozenPolicySnapshot(
      item.snapshot,
      Date.parse(artifact.createdAt)
    );
    if (sha256Hex(reevaluated) !== sha256Hex(item.evaluation)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Persisted policy evaluation does not match frozen policy inputs"
      );
    }
    aggregate = strongestDisposition(aggregate, item.evaluation.disposition);
  }

  if (aggregate !== artifact.aggregateDisposition) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Aggregate policy disposition does not match step evaluations"
    );
  }

  return artifact;
}

export async function advanceValidatedToPolicyEvaluated(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  policyStepSnapshots: OrchestrationPolicyStepSnapshotStore;
  policies: OrchestrationPolicyEvaluationStore;
  resolver: DurablePolicyInputResolver;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  const now = input.now ?? (() => new Date());
  if (input.run.state !== "validated") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Policy stage requires validated orchestration state",
      { correlationId: input.run.correlationId }
    );
  }

  const planArtifact = await loadPlanArtifact(input.run, input.plans);
  const validationRef = input.run.checkpoints.validationReceipt;
  if (!validationRef) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Validated orchestration is missing validation receipt checkpoint"
    );
  }
  const validationArtifact = await input.validations.get(validationRef.id);
  if (!validationArtifact) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation artifact referenced by orchestration was not found",
      { correlationId: input.run.correlationId }
    );
  }
  assertDurableValidationArtifact(validationArtifact, planArtifact);

  if (
    validationArtifact.receipt.receiptHash !== validationRef.hash
    || validationArtifact.portfolioId !== input.run.scope.portfolioId
    || validationArtifact.companyId !== input.run.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation receipt lineage does not match validated orchestration"
    );
  }

  const existing = await input.policies.getByRunVersion(
    input.run.id,
    input.run.version
  );
  if (existing) {
    assertDurablePolicyEvaluationArtifact(
      existing,
      planArtifact,
      validationArtifact
    );
    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "policy-evaluated",
        now: now().toISOString(),
        checkpointPatch: {
          policySnapshot: {
            id: existing.id,
            hash: existing.artifactHash
          }
        }
      })
    };
  }

  try {
    assertValidationReceipt(
      validationArtifact.receipt,
      planArtifact.proposal,
      now().getTime()
    );
  } catch (error) {
    if (error instanceof ControlPlaneError && error.code === "POLICY_BLOCKED") {
      return {
        kind: "advance",
        next: transitionOrchestrationRun(input.run, {
          to: "blocked",
          now: now().toISOString(),
          blockedReason: "Validation receipt became stale before policy evaluation"
        })
      };
    }
    throw error;
  }

  const stepById = new Map(
    planArtifact.proposal.steps.map((step) => [step.id, step])
  );
  const orderedSteps = validationArtifact.receipt.orderedStepIds.map((id) => {
    const step = stepById.get(id);
    if (!step) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Validation receipt references a missing Plan step"
      );
    }
    return step;
  });

  const createdAt = now().toISOString();
  const stepPolicies: DurableStepPolicyRecord[] = [];

  for (const step of orderedSteps) {
    const stepHash = hashPlanStep(step);
    const stepIdempotencyKey = policyStepIdempotencyKey(
      input.run.id,
      input.run.version,
      step.id
    );

    let stepArtifact = await input.policyStepSnapshots.getByRunVersionStep(
      input.run.id,
      input.run.version,
      step.id
    );

    if (stepArtifact) {
      assertDurablePolicyStepSnapshotArtifact(stepArtifact, {
        run: input.run,
        planArtifact,
        validationArtifact,
        step
      });
    } else {
      const resolved = await input.resolver.resolveStep({
        run: input.run,
        planArtifact,
        validationArtifact,
        step,
        idempotencyKey: stepIdempotencyKey
      });
      const snapshot = createPolicySnapshot({
        ...resolved,
        id: policySnapshotId(input.run.id, input.run.version, step.id),
        policyVersion: CURRENT_POLICY_VERSION,
        scope: input.run.scope,
        planHash: planArtifact.planHash,
        stepHash,
        capabilityNames: step.capabilityRequests.map(
          (request) => request.capability
        ),
        dataClass: planArtifact.proposal.scope.dataClass,
        idempotencyKey: stepIdempotencyKey,
        resourceRequirements: step.resourceRequirements,
        createdAt
      });
      const candidate = createDurablePolicyStepSnapshotArtifact({
        run: input.run,
        planArtifact,
        validationArtifact,
        step,
        snapshot,
        createdAt
      });
      const persistedStep = await input.policyStepSnapshots.create(
        candidate,
        stepIdempotencyKey
      );
      stepArtifact = persistedStep.artifact;
      assertDurablePolicyStepSnapshotArtifact(stepArtifact, {
        run: input.run,
        planArtifact,
        validationArtifact,
        step
      });
    }

    const evaluation = evaluateFrozenPolicySnapshot(
      stepArtifact.snapshot,
      Date.parse(stepArtifact.createdAt)
    );
    stepPolicies.push(deepFreeze({
      stepId: step.id,
      stepHash,
      snapshot: stepArtifact.snapshot,
      evaluation
    }));
  }

  const artifact = createDurablePolicyEvaluationArtifact({
    run: input.run,
    planArtifact,
    validationArtifact,
    stepPolicies,
    createdAt
  });

  const persisted = await input.policies.create(
    artifact,
    policyEvaluationIdempotencyKey(input.run.id, input.run.version)
  );
  assertDurablePolicyEvaluationArtifact(
    persisted.artifact,
    planArtifact,
    validationArtifact
  );

  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "policy-evaluated",
      now: now().toISOString(),
      checkpointPatch: {
        policySnapshot: {
          id: persisted.artifact.id,
          hash: persisted.artifact.artifactHash
        }
      }
    })
  };
}
