import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import type { Objective } from "@/lib/domain/objectives";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import {
  createOrchestrationRun,
  createOrchestrationSourceRef,
  transitionOrchestrationRun,
  type OrchestrationRunRecord,
  type OrchestrationSourceType
} from "@/lib/orchestration/contracts";
import type { OrchestrationStageOutcome } from "@/lib/orchestration/worker-contracts";
import {
  assembleContext,
  type AssembledContext,
  type ContextAssemblyOptions,
  type ContextItem,
  type ContextScope
} from "@/lib/intelligence/context";

export const OWNER_INTENT_ORCHESTRATION_FLOW_VERSION = "1.1.0";

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export interface OwnerIntentReadStore {
  get(id: string): Promise<OwnerIntentRecord | null>;
}

export interface OwnerIntentContextCandidateSource {
  listForIntent(input: {
    intent: OwnerIntentRecord;
    run: OrchestrationRunRecord;
  }): Promise<readonly ContextItem[]>;
}

export interface OwnerIntentContextPolicyResolver {
  resolve(input: {
    intent: OwnerIntentRecord;
    run: OrchestrationRunRecord;
  }): Promise<{
    scope: ContextScope;
    options?: ContextAssemblyOptions;
  }>;
}

export type OrchestrationContextSourceInput =
  | {
      type: "owner-intent";
      message: string;
      channel: OwnerIntentRecord["channel"];
    }
  | {
      type: "objective";
      metric: Objective["metric"];
      direction: Objective["direction"];
      target: Objective["target"];
      priority: Objective["priority"];
      deadline?: Objective["deadline"];
      budgetCents?: Objective["budgetCents"];
    }
  | {
      type: "objective";
      normalizedGoal: ObjectiveRecord["normalizedGoal"];
      desiredOutcome: ObjectiveRecord["desiredOutcome"];
      constraints: ObjectiveRecord["constraints"];
      successCriteria: ObjectiveRecord["successCriteria"];
      priority: ObjectiveRecord["priority"];
      riskLevel: ObjectiveRecord["riskLevel"];
      deadline?: ObjectiveRecord["deadline"];
    };

export interface OrchestrationContextSnapshot {
  id: string;
  runId: string;
  runVersion: number;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  sourceType: OrchestrationSourceType;
  sourceId: string;
  sourceHash: string;
  sourceInput: OrchestrationContextSourceInput;
  assembledContext: AssembledContext;
  createdAt: string;
  snapshotHash: string;
}

export interface OrchestrationContextSnapshotStore {
  create(
    snapshot: OrchestrationContextSnapshot,
    idempotencyKey: string
  ): Promise<{
    status: "created" | "idempotent-replay";
    snapshot: OrchestrationContextSnapshot;
  }>;
  get(id: string): Promise<OrchestrationContextSnapshot | null>;
  getByRunVersion(
    runId: string,
    runVersion: number
  ): Promise<OrchestrationContextSnapshot | null>;
}

export function ownerIntentOrchestrationId(intentId: string) {
  if (!intentId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "OwnerIntent id is required");
  }
  return `orchestration:owner-intent:${intentId}`;
}

export function ownerIntentOrchestrationStartIdempotencyKey(intentId: string) {
  if (!intentId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "OwnerIntent id is required");
  }
  return `orchestration:start:owner-intent:${intentId}`;
}

export function ownerIntentContextSnapshotId(
  runId: string,
  runVersion: number
) {
  return `context-snapshot:${runId}:v${runVersion}`;
}

export function ownerIntentContextSnapshotIdempotencyKey(
  runId: string,
  runVersion: number
) {
  return `orchestration:${runId}:v${runVersion}:context-snapshot`;
}

export function createOwnerIntentOrchestrationRun(
  intent: OwnerIntentRecord
): OrchestrationRunRecord {
  const correlationId = intent.correlationId?.trim()
    || `owner-intent:${intent.id}`;

  return createOrchestrationRun({
    id: ownerIntentOrchestrationId(intent.id),
    correlationId,
    source: createOrchestrationSourceRef(
      "owner-intent",
      intent.id,
      intent
    ),
    scope: {
      userId: intent.userId,
      portfolioId: intent.portfolioId,
      companyId: intent.companyId,
      environment: intent.environment
    },
    createdAt: intent.receivedAt,
    updatedAt: intent.receivedAt
  });
}

function assertIntentMatchesRun(
  intent: OwnerIntentRecord,
  run: OrchestrationRunRecord
) {
  if (
    run.source.type !== "owner-intent"
    || run.source.id !== intent.id
    || run.scope.userId !== intent.userId
    || run.scope.portfolioId !== intent.portfolioId
    || run.scope.companyId !== intent.companyId
    || run.scope.environment !== intent.environment
    || run.correlationId !== (intent.correlationId?.trim() || `owner-intent:${intent.id}`)
    || run.source.sourceHash !== sha256Hex(intent)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "OwnerIntent no longer matches orchestration source/scope lineage",
      { correlationId: run.correlationId }
    );
  }
}

export function createOwnerIntentContextSnapshot(input: {
  run: OrchestrationRunRecord;
  intent: OwnerIntentRecord;
  assembledContext: AssembledContext;
  createdAt: string;
}): OrchestrationContextSnapshot {
  if (input.run.state !== "accepted") {
    throw new ControlPlaneError(
      "CONFLICT",
      "OwnerIntent context snapshot may only be frozen from accepted orchestration state",
      { correlationId: input.run.correlationId }
    );
  }

  assertIntentMatchesRun(input.intent, input.run);

  const base = {
    id: ownerIntentContextSnapshotId(input.run.id, input.run.version),
    runId: input.run.id,
    runVersion: input.run.version,
    correlationId: input.run.correlationId,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    sourceType: "owner-intent" as const,
    sourceId: input.intent.id,
    sourceHash: input.run.source.sourceHash,
    sourceInput: {
      type: "owner-intent" as const,
      message: input.intent.message,
      channel: input.intent.channel
    },
    assembledContext: input.assembledContext,
    createdAt: new Date(input.createdAt).toISOString()
  };

  return deepFreeze({
    ...base,
    snapshotHash: sha256Hex(base)
  });
}

export function assertOrchestrationContextSnapshot(
  snapshot: OrchestrationContextSnapshot
) {
  const { snapshotHash, ...base } = snapshot;
  if (sha256Hex(base) !== snapshotHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "ContextSnapshot integrity check failed",
      { correlationId: snapshot.correlationId }
    );
  }
  return snapshot;
}

export async function advanceOwnerIntentAcceptedToContextReady(input: {
  run: OrchestrationRunRecord;
  ownerIntents: OwnerIntentReadStore;
  candidates: OwnerIntentContextCandidateSource;
  policy: OwnerIntentContextPolicyResolver;
  snapshots: OrchestrationContextSnapshotStore;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  const now = input.now ?? (() => new Date());

  if (input.run.state !== "accepted") {
    throw new ControlPlaneError(
      "CONFLICT",
      "OwnerIntent accepted-stage handler requires accepted orchestration state",
      { correlationId: input.run.correlationId }
    );
  }
  if (input.run.source.type !== "owner-intent") {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "OwnerIntent accepted-stage handler received a non-owner-intent source",
      { correlationId: input.run.correlationId }
    );
  }

  const intent = await input.ownerIntents.get(input.run.source.id);
  if (!intent) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Accepted orchestration references a missing OwnerIntent",
      { correlationId: input.run.correlationId }
    );
  }
  assertIntentMatchesRun(intent, input.run);

  const existingSnapshot = await input.snapshots.getByRunVersion(
    input.run.id,
    input.run.version
  );
  if (existingSnapshot) {
    assertOrchestrationContextSnapshot(existingSnapshot);
    if (
      existingSnapshot.runId !== input.run.id
      || existingSnapshot.runVersion !== input.run.version
      || existingSnapshot.sourceHash !== input.run.source.sourceHash
      || existingSnapshot.portfolioId !== input.run.scope.portfolioId
      || existingSnapshot.companyId !== input.run.scope.companyId
    ) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Existing ContextSnapshot does not match accepted orchestration lineage",
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
            id: existingSnapshot.id,
            hash: existingSnapshot.snapshotHash
          }
        }
      })
    };
  }

  const [contextCandidates, contextPolicy] = await Promise.all([
    input.candidates.listForIntent({ intent, run: input.run }),
    input.policy.resolve({ intent, run: input.run })
  ]);

  if (
    contextPolicy.scope.portfolioId !== input.run.scope.portfolioId
    || contextPolicy.scope.companyId !== input.run.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Context policy attempted to broaden OwnerIntent orchestration tenant scope",
      { correlationId: input.run.correlationId }
    );
  }

  const assembledContext = assembleContext(
    contextCandidates,
    contextPolicy.scope,
    {
      ...contextPolicy.options,
      now: contextPolicy.options?.now ?? now().getTime()
    }
  );

  const snapshot = createOwnerIntentContextSnapshot({
    run: input.run,
    intent,
    assembledContext,
    createdAt: now().toISOString()
  });

  const persisted = await input.snapshots.create(
    snapshot,
    ownerIntentContextSnapshotIdempotencyKey(
      input.run.id,
      input.run.version
    )
  );
  assertOrchestrationContextSnapshot(persisted.snapshot);

  if (
    persisted.snapshot.runId !== input.run.id
    || persisted.snapshot.runVersion !== input.run.version
    || persisted.snapshot.sourceHash !== input.run.source.sourceHash
  ) {
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Persisted ContextSnapshot does not match accepted orchestration lineage",
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
