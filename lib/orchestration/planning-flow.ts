import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createRequestContext } from "@/lib/control-plane/request-context";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  assertOrchestrationContextSnapshot,
  type OrchestrationContextSnapshot,
  type OrchestrationContextSnapshotStore
} from "@/lib/orchestration/owner-intent-flow";
import {
  transitionOrchestrationRun,
  type OrchestrationRunRecord,
  type OrchestrationSourceRef
} from "@/lib/orchestration/contracts";
import type { OrchestrationStageOutcome } from "@/lib/orchestration/worker-contracts";
import { constructPlanProposal } from "@/lib/planning/plan-construction";
import { hashPlan } from "@/lib/planning/plan-hash";
import type { PlanProposal } from "@/lib/planning/plan-schema";

export const ORCHESTRATION_PLANNING_FLOW_VERSION = "1.0.0";

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export interface PlannerInputEnvelope {
  id: string;
  runId: string;
  sourceRunVersion: number;
  correlationId: string;
  scope: TrustedExecutionScope;
  source: OrchestrationSourceRef;
  authorizedPlanSource: {
    type: "owner-request" | "objective" | "investigation";
    referenceId: string;
  };
  contextSnapshot: {
    id: string;
    hash: string;
  };
  sourceInput: OrchestrationContextSnapshot["sourceInput"];
  context: OrchestrationContextSnapshot["assembledContext"];
  createdAt: string;
  inputHash: string;
}

export interface PlannerInputStore {
  create(
    input: PlannerInputEnvelope,
    idempotencyKey: string
  ): Promise<{
    status: "created" | "idempotent-replay";
    input: PlannerInputEnvelope;
  }>;
  get(id: string): Promise<PlannerInputEnvelope | null>;
  getByRunVersion(
    runId: string,
    sourceRunVersion: number
  ): Promise<PlannerInputEnvelope | null>;
}

export interface DurablePlannerDescriptor {
  snapshotOnlyInput: true;
  deterministicRequestIdentity: true;
  structuredPlanOutput: true;
}

export type DurablePlannerResult =
  | {
      kind: "success";
      candidate: unknown;
      requestId: string;
      providerEvidence?: Readonly<Record<string, string | number | boolean | null>>;
    }
  | {
      kind: "unavailable";
      code: string;
      reason: string;
      retryable: boolean;
      retryAfterMs?: number;
    };

export interface DurablePlanner {
  readonly descriptor: DurablePlannerDescriptor;
  propose(input: {
    requestId: string;
    idempotencyKey: string;
    plannerInput: PlannerInputEnvelope;
  }): Promise<DurablePlannerResult>;
}

export interface PersistedPlanProposal {
  id: string;
  runId: string;
  planningRunVersion: number;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  plannerInputId: string;
  plannerInputHash: string;
  plannerRequestId: string;
  proposal: PlanProposal;
  planHash: string;
  createdAt: string;
  artifactHash: string;
}

export interface OrchestrationPlanProposalStore {
  create(
    artifact: PersistedPlanProposal,
    idempotencyKey: string
  ): Promise<{
    status: "created" | "idempotent-replay";
    artifact: PersistedPlanProposal;
  }>;
  get(id: string): Promise<PersistedPlanProposal | null>;
  getByRunVersion(
    runId: string,
    planningRunVersion: number
  ): Promise<PersistedPlanProposal | null>;
}

export function plannerInputId(runId: string, sourceRunVersion: number) {
  return `planner-input:${runId}:v${sourceRunVersion}`;
}

export function plannerInputIdempotencyKey(
  runId: string,
  sourceRunVersion: number
) {
  return `orchestration:${runId}:v${sourceRunVersion}:planner-input`;
}

export function plannerRequestId(runId: string, planningRunVersion: number) {
  return `planner-request:${runId}:v${planningRunVersion}`;
}

export function plannerRequestIdempotencyKey(
  runId: string,
  planningRunVersion: number
) {
  return `orchestration:${runId}:v${planningRunVersion}:planner`;
}

export function planArtifactId(runId: string, planningRunVersion: number) {
  return `plan-artifact:${runId}:v${planningRunVersion}`;
}

export function planArtifactIdempotencyKey(
  runId: string,
  planningRunVersion: number
) {
  return `orchestration:${runId}:v${planningRunVersion}:plan-artifact`;
}

function authorizedPlanSource(source: OrchestrationSourceRef) {
  switch (source.type) {
    case "owner-intent":
      return { type: "owner-request" as const, referenceId: source.id };
    case "objective":
      return { type: "objective" as const, referenceId: source.id };
    case "investigation":
      return { type: "investigation" as const, referenceId: source.id };
    case "signal":
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Direct signal planning is not supported; create an Investigation first"
      );
  }
}

export function createPlannerInputEnvelope(input: {
  run: OrchestrationRunRecord;
  snapshot: OrchestrationContextSnapshot;
  createdAt: string;
}): PlannerInputEnvelope {
  if (input.run.state !== "context-ready") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Planner input may only be frozen from context-ready state",
      { correlationId: input.run.correlationId }
    );
  }

  assertOrchestrationContextSnapshot(input.snapshot);
  const contextRef = input.run.checkpoints.contextSnapshot;
  if (
    !contextRef
    || contextRef.id !== input.snapshot.id
    || contextRef.hash !== input.snapshot.snapshotHash
    || input.snapshot.runId !== input.run.id
    || input.snapshot.correlationId !== input.run.correlationId
    || input.snapshot.portfolioId !== input.run.scope.portfolioId
    || input.snapshot.companyId !== input.run.scope.companyId
    || input.snapshot.sourceId !== input.run.source.id
    || input.snapshot.sourceHash !== input.run.source.sourceHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "ContextSnapshot does not match context-ready orchestration lineage",
      { correlationId: input.run.correlationId }
    );
  }

  const base = {
    id: plannerInputId(input.run.id, input.run.version),
    runId: input.run.id,
    sourceRunVersion: input.run.version,
    correlationId: input.run.correlationId,
    scope: input.run.scope,
    source: input.run.source,
    authorizedPlanSource: authorizedPlanSource(input.run.source),
    contextSnapshot: {
      id: input.snapshot.id,
      hash: input.snapshot.snapshotHash
    },
    sourceInput: input.snapshot.sourceInput,
    context: input.snapshot.assembledContext,
    createdAt: new Date(input.createdAt).toISOString()
  };

  return deepFreeze({
    ...base,
    inputHash: sha256Hex(base)
  });
}

export function assertPlannerInputEnvelope(input: PlannerInputEnvelope) {
  const { inputHash, ...base } = input;
  if (sha256Hex(base) !== inputHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Planner input integrity check failed",
      { correlationId: input.correlationId }
    );
  }
  return input;
}

export function createPersistedPlanProposal(input: {
  run: OrchestrationRunRecord;
  plannerInput: PlannerInputEnvelope;
  plannerRequestId: string;
  proposal: PlanProposal;
  createdAt: string;
}): PersistedPlanProposal {
  if (input.run.state !== "planning") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Plan artifact may only be persisted from planning state",
      { correlationId: input.run.correlationId }
    );
  }

  assertPlannerInputEnvelope(input.plannerInput);
  const plannerRef = input.run.checkpoints.plannerInput;
  if (
    !plannerRef
    || plannerRef.id !== input.plannerInput.id
    || plannerRef.hash !== input.plannerInput.inputHash
    || input.plannerInput.runId !== input.run.id
    || input.plannerInput.correlationId !== input.run.correlationId
    || input.plannerInput.scope.portfolioId !== input.run.scope.portfolioId
    || input.plannerInput.scope.companyId !== input.run.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Planner input does not match planning orchestration lineage",
      { correlationId: input.run.correlationId }
    );
  }

  const planHash = hashPlan(input.proposal);
  const base = {
    id: planArtifactId(input.run.id, input.run.version),
    runId: input.run.id,
    planningRunVersion: input.run.version,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    plannerInputId: input.plannerInput.id,
    plannerInputHash: input.plannerInput.inputHash,
    plannerRequestId: input.plannerRequestId,
    proposal: input.proposal,
    planHash,
    createdAt: new Date(input.createdAt).toISOString()
  };

  return deepFreeze({
    ...base,
    artifactHash: sha256Hex(base)
  });
}

export function assertPersistedPlanProposal(
  artifact: PersistedPlanProposal
) {
  const { artifactHash, ...base } = artifact;
  if (
    sha256Hex(base) !== artifactHash
    || hashPlan(artifact.proposal) !== artifact.planHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Persisted plan artifact integrity check failed",
      { correlationId: artifact.correlationId }
    );
  }
  return artifact;
}

export async function advanceContextReadyToPlanning(input: {
  run: OrchestrationRunRecord;
  snapshots: OrchestrationContextSnapshotStore;
  plannerInputs: PlannerInputStore;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  const now = input.now ?? (() => new Date());
  if (input.run.state !== "context-ready") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Planning-input stage requires context-ready orchestration state",
      { correlationId: input.run.correlationId }
    );
  }

  const existing = await input.plannerInputs.getByRunVersion(
    input.run.id,
    input.run.version
  );
  if (existing) {
    assertPlannerInputEnvelope(existing);
    if (
      existing.contextSnapshot.id !== input.run.checkpoints.contextSnapshot?.id
      || existing.contextSnapshot.hash !== input.run.checkpoints.contextSnapshot?.hash
      || existing.scope.portfolioId !== input.run.scope.portfolioId
      || existing.scope.companyId !== input.run.scope.companyId
    ) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Existing planner input does not match context-ready orchestration lineage",
        { correlationId: input.run.correlationId }
      );
    }

    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "planning",
        now: now().toISOString(),
        checkpointPatch: {
          plannerInput: {
            id: existing.id,
            hash: existing.inputHash
          }
        }
      })
    };
  }

  const contextRef = input.run.checkpoints.contextSnapshot;
  if (!contextRef) {
    throw new ControlPlaneError(
      "CONFLICT",
      "context-ready orchestration is missing ContextSnapshot lineage"
    );
  }

  const snapshot = await input.snapshots.get(contextRef.id);
  if (!snapshot) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "ContextSnapshot referenced by orchestration was not found",
      { correlationId: input.run.correlationId }
    );
  }

  const plannerInput = createPlannerInputEnvelope({
    run: input.run,
    snapshot,
    createdAt: now().toISOString()
  });

  const persisted = await input.plannerInputs.create(
    plannerInput,
    plannerInputIdempotencyKey(input.run.id, input.run.version)
  );
  assertPlannerInputEnvelope(persisted.input);

  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "planning",
      now: now().toISOString(),
      checkpointPatch: {
        plannerInput: {
          id: persisted.input.id,
          hash: persisted.input.inputHash
        }
      }
    })
  };
}

export async function advancePlanningToPlanned(input: {
  run: OrchestrationRunRecord;
  plannerInputs: PlannerInputStore;
  plans: OrchestrationPlanProposalStore;
  planner: DurablePlanner;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  const now = input.now ?? (() => new Date());
  if (input.run.state !== "planning") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Planner stage requires planning orchestration state",
      { correlationId: input.run.correlationId }
    );
  }

  if (
    !input.planner.descriptor.snapshotOnlyInput
    || !input.planner.descriptor.deterministicRequestIdentity
    || !input.planner.descriptor.structuredPlanOutput
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Planner does not satisfy durable snapshot-only planning contract",
      { correlationId: input.run.correlationId }
    );
  }

  const plannerRef = input.run.checkpoints.plannerInput;
  if (!plannerRef) {
    throw new ControlPlaneError("CONFLICT", "planning orchestration is missing planner input");
  }

  const plannerInput = await input.plannerInputs.get(plannerRef.id);
  if (!plannerInput) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Planner input referenced by orchestration was not found",
      { correlationId: input.run.correlationId }
    );
  }
  assertPlannerInputEnvelope(plannerInput);

  if (
    plannerInput.inputHash !== plannerRef.hash
    || plannerInput.runId !== input.run.id
    || plannerInput.correlationId !== input.run.correlationId
    || plannerInput.scope.portfolioId !== input.run.scope.portfolioId
    || plannerInput.scope.companyId !== input.run.scope.companyId
    || plannerInput.contextSnapshot.id !== input.run.checkpoints.contextSnapshot?.id
    || plannerInput.contextSnapshot.hash !== input.run.checkpoints.contextSnapshot?.hash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Planner input lineage does not match planning orchestration",
      { correlationId: input.run.correlationId }
    );
  }

  const existing = await input.plans.getByRunVersion(
    input.run.id,
    input.run.version
  );
  if (existing) {
    assertPersistedPlanProposal(existing);
    if (
      existing.plannerInputId !== plannerInput.id
      || existing.plannerInputHash !== plannerInput.inputHash
    ) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Existing plan artifact does not match frozen planner input",
        { correlationId: input.run.correlationId }
      );
    }

    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "planned",
        now: now().toISOString(),
        checkpointPatch: {
          plan: {
            id: existing.id,
            hash: existing.planHash
          }
        }
      })
    };
  }

  const requestId = plannerRequestId(input.run.id, input.run.version);
  const plannerResult = await input.planner.propose({
    requestId,
    idempotencyKey: plannerRequestIdempotencyKey(
      input.run.id,
      input.run.version
    ),
    plannerInput
  });

  if (plannerResult.kind === "unavailable") {
    return plannerResult.retryable
      ? {
          kind: "retry",
          code: plannerResult.code,
          reason: plannerResult.reason,
          retryAfterMs: plannerResult.retryAfterMs
        }
      : {
          kind: "failed",
          code: plannerResult.code,
          reason: plannerResult.reason
        };
  }

  if (plannerResult.requestId !== requestId) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Planner response request identity does not match deterministic request",
      { correlationId: input.run.correlationId }
    );
  }

  const request = createRequestContext({
    actor: { type: "system", id: "getdone-planner" },
    scope: {
      userId: input.run.scope.userId,
      portfolioId: input.run.scope.portfolioId,
      companyId: input.run.scope.companyId
    },
    environment: input.run.scope.environment,
    correlationId: input.run.correlationId
  });

  const proposal = constructPlanProposal({
    candidate: plannerResult.candidate,
    request,
    authorizedSource: plannerInput.authorizedPlanSource
  });

  const artifact = createPersistedPlanProposal({
    run: input.run,
    plannerInput,
    plannerRequestId: requestId,
    proposal,
    createdAt: now().toISOString()
  });

  const persisted = await input.plans.create(
    artifact,
    planArtifactIdempotencyKey(input.run.id, input.run.version)
  );
  assertPersistedPlanProposal(persisted.artifact);

  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "planned",
      now: now().toISOString(),
      checkpointPatch: {
        plan: {
          id: persisted.artifact.id,
          hash: persisted.artifact.planHash
        }
      }
    })
  };
}
