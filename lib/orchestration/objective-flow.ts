import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { Objective } from "@/lib/domain/objectives";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import {
  assembleContext,
  type ContextAssemblyOptions,
  type ContextItem,
  type ContextScope
} from "@/lib/intelligence/context";
import {
  createOrchestrationRun,
  createOrchestrationSourceRef,
  transitionOrchestrationRun,
  type OrchestrationRunRecord
} from "@/lib/orchestration/contracts";
import {
  assertOrchestrationContextSnapshot,
  ownerIntentContextSnapshotId,
  ownerIntentContextSnapshotIdempotencyKey,
  type OrchestrationContextSnapshot,
  type OrchestrationContextSnapshotStore
} from "@/lib/orchestration/owner-intent-flow";
import type { OrchestrationStageOutcome } from "@/lib/orchestration/worker-contracts";

export const OBJECTIVE_ORCHESTRATION_FLOW_VERSION = "1.1.0";

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export type AuthoritativeObjective = Objective | ObjectiveRecord;

export interface ObjectiveReadStore {
  get(id: string): Promise<AuthoritativeObjective | null>;
}

function isObjectiveRecord(objective: AuthoritativeObjective): objective is ObjectiveRecord {
  return "normalizedGoal" in objective && "companyId" in objective;
}

function objectiveIsRunnable(objective: AuthoritativeObjective) {
  if (!isObjectiveRecord(objective)) return objective.status === "active";
  return ["queued", "planning", "executing", "new_work_required"].includes(objective.status);
}

export interface ObjectiveContextCandidateSource {
  listForObjective(input: {
    objective: AuthoritativeObjective;
    run: OrchestrationRunRecord;
  }): Promise<readonly ContextItem[]>;
}

export interface ObjectiveContextPolicyResolver {
  resolve(input: {
    objective: AuthoritativeObjective;
    run: OrchestrationRunRecord;
  }): Promise<{
    scope: ContextScope;
    options?: ContextAssemblyOptions;
  }>;
}

export function objectiveOrchestrationId(objectiveId: string) {
  if (!objectiveId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Objective id is required");
  }
  return `orchestration:objective:${objectiveId}`;
}

export function objectiveOrchestrationStartIdempotencyKey(objectiveId: string) {
  if (!objectiveId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Objective id is required");
  }
  return `orchestration:start:objective:${objectiveId}`;
}

function assertObjectiveScope(objective: AuthoritativeObjective, scope: TrustedExecutionScope) {
  if (isObjectiveRecord(objective)) {
    if (
      objective.portfolioId !== scope.portfolioId
      || objective.companyId !== scope.companyId
      || objective.environment !== scope.environment
      || objective.createdByUserId !== scope.userId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Objective scope does not match the trusted orchestration company/portfolio"
      );
    }
    return;
  }
  if (
    objective.scopeId !== scope.companyId
    && objective.scopeId !== scope.portfolioId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Objective scope does not match the trusted orchestration company/portfolio"
    );
  }
}

export function createObjectiveOrchestrationRun(input: {
  objective: AuthoritativeObjective;
  scope: TrustedExecutionScope;
  correlationId?: string;
  createdAt: string;
}): OrchestrationRunRecord {
  if (!objectiveIsRunnable(input.objective)) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Only a runnable Objective can enter autonomous orchestration"
    );
  }
  assertObjectiveScope(input.objective, input.scope);
  const correlationId = input.correlationId?.trim()
    || `objective:${input.objective.id}`;

  return createOrchestrationRun({
    id: objectiveOrchestrationId(input.objective.id),
    correlationId,
    source: createOrchestrationSourceRef(
      "objective",
      input.objective.id,
      input.objective
    ),
    scope: input.scope,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

function assertObjectiveMatchesRun(
  objective: AuthoritativeObjective,
  run: OrchestrationRunRecord
) {
  if (
    run.source.type !== "objective"
    || run.source.id !== objective.id
    || run.source.sourceHash !== sha256Hex(objective)
    || !objectiveIsRunnable(objective)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Objective no longer matches authoritative orchestration source lineage",
      { correlationId: run.correlationId }
    );
  }
  assertObjectiveScope(objective, run.scope);
}

export function createObjectiveContextSnapshot(input: {
  run: OrchestrationRunRecord;
  objective: AuthoritativeObjective;
  assembledContext: OrchestrationContextSnapshot["assembledContext"];
  createdAt: string;
}): OrchestrationContextSnapshot {
  if (input.run.state !== "accepted") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Objective Context Snapshot may only be frozen from accepted orchestration state",
      { correlationId: input.run.correlationId }
    );
  }
  assertObjectiveMatchesRun(input.objective, input.run);
  const base = {
    id: ownerIntentContextSnapshotId(input.run.id, input.run.version),
    runId: input.run.id,
    runVersion: input.run.version,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    sourceType: "objective" as const,
    sourceId: input.objective.id,
    sourceHash: input.run.source.sourceHash,
    sourceInput: isObjectiveRecord(input.objective)
      ? {
          type: "objective" as const,
          normalizedGoal: input.objective.normalizedGoal,
          desiredOutcome: input.objective.desiredOutcome,
          constraints: [...input.objective.constraints],
          successCriteria: [...input.objective.successCriteria],
          priority: input.objective.priority,
          riskLevel: input.objective.riskLevel,
          deadline: input.objective.deadline
        }
      : {
          type: "objective" as const,
          metric: input.objective.metric,
          direction: input.objective.direction,
          target: input.objective.target,
          priority: input.objective.priority,
          deadline: input.objective.deadline,
          budgetCents: input.objective.budgetCents
        },
    assembledContext: input.assembledContext,
    createdAt: new Date(input.createdAt).toISOString()
  };
  return deepFreeze({ ...base, snapshotHash: sha256Hex(base) });
}

export async function advanceObjectiveAcceptedToContextReady(input: {
  run: OrchestrationRunRecord;
  objectives: ObjectiveReadStore;
  candidates: ObjectiveContextCandidateSource;
  policy: ObjectiveContextPolicyResolver;
  snapshots: OrchestrationContextSnapshotStore;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  const now = input.now ?? (() => new Date());
  if (input.run.state !== "accepted" || input.run.source.type !== "objective") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Objective accepted-stage handler requires accepted Objective orchestration state",
      { correlationId: input.run.correlationId }
    );
  }

  const objective = await input.objectives.get(input.run.source.id);
  if (!objective) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Accepted orchestration references a missing authoritative Objective",
      { correlationId: input.run.correlationId }
    );
  }
  assertObjectiveMatchesRun(objective, input.run);

  const existing = await input.snapshots.getByRunVersion(
    input.run.id,
    input.run.version
  );
  if (existing) {
    assertOrchestrationContextSnapshot(existing);
    if (
      existing.sourceType !== "objective"
      || existing.sourceId !== objective.id
      || existing.sourceHash !== input.run.source.sourceHash
      || existing.portfolioId !== input.run.scope.portfolioId
      || existing.companyId !== input.run.scope.companyId
    ) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Existing Objective Context Snapshot does not match authoritative source lineage",
        { correlationId: input.run.correlationId }
      );
    }
    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "context-ready",
        now: now().toISOString(),
        checkpointPatch: {
          contextSnapshot: { id: existing.id, hash: existing.snapshotHash }
        }
      })
    };
  }

  const [candidates, policy] = await Promise.all([
    input.candidates.listForObjective({ objective, run: input.run }),
    input.policy.resolve({ objective, run: input.run })
  ]);
  if (
    policy.scope.portfolioId !== input.run.scope.portfolioId
    || policy.scope.companyId !== input.run.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Objective Context policy attempted to broaden trusted tenant scope",
      { correlationId: input.run.correlationId }
    );
  }

  const assembledContext = assembleContext(candidates, policy.scope, {
    ...policy.options,
    now: policy.options?.now ?? now().getTime()
  });
  const snapshot = createObjectiveContextSnapshot({
    run: input.run,
    objective,
    assembledContext,
    createdAt: now().toISOString()
  });
  const persisted = await input.snapshots.create(
    snapshot,
    ownerIntentContextSnapshotIdempotencyKey(input.run.id, input.run.version)
  );
  assertOrchestrationContextSnapshot(persisted.snapshot);
  if (
    persisted.snapshot.sourceType !== "objective"
    || persisted.snapshot.sourceHash !== input.run.source.sourceHash
  ) {
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Persisted Objective Context Snapshot does not match accepted orchestration lineage",
      { correlationId: input.run.correlationId }
    );
  }

  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "context-ready",
      now: now().toISOString(),
      checkpointPatch: {
        contextSnapshot: {
          id: persisted.snapshot.id,
          hash: persisted.snapshot.snapshotHash
        }
      }
    })
  };
}
