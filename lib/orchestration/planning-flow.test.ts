import { describe, expect, it } from "vitest";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import {
  createOwnerIntentContextSnapshot,
  createOwnerIntentOrchestrationRun,
  type OrchestrationContextSnapshot,
  type OrchestrationContextSnapshotStore
} from "@/lib/orchestration/owner-intent-flow";
import {
  advanceContextReadyToPlanning,
  advancePlanningToPlanned,
  createPlannerInputEnvelope,
  plannerRequestId,
  type DurablePlanner,
  type OrchestrationPlanProposalStore,
  type PersistedPlanProposal,
  type PlannerInputEnvelope,
  type PlannerInputStore
} from "@/lib/orchestration/planning-flow";
import { transitionOrchestrationRun } from "@/lib/orchestration/contracts";
import { assembleContext } from "@/lib/intelligence/context";
import { validPlan } from "@/lib/planning/test-fixture";

const intent: OwnerIntentRecord = {
  id: "intent-planning",
  correlationId: "correlation-planning",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging",
  userId: "owner-a",
  message: "Grow OpsManagerPro without increasing owner attention",
  channel: "chat",
  status: "accepted",
  receivedAt: "2026-09-28T12:00:00.000Z"
};

function snapshotAndContextReady() {
  const accepted = createOwnerIntentOrchestrationRun(intent);
  const assembled = assembleContext([{
    id: "fact-1",
    kind: "fact",
    portfolioId: intent.portfolioId,
    companyId: intent.companyId,
    source: "verified-metric",
    provenance: "verified:test",
    observedAt: "2026-09-28T11:59:30.000Z",
    freshnessSeconds: 300,
    sensitivity: "internal",
    content: "Trial conversion is 11%."
  }], {
    portfolioId: intent.portfolioId,
    companyId: intent.companyId,
    allowedSensitivity: ["public", "internal"]
  }, {
    now: Date.parse("2026-09-28T12:00:01.000Z")
  });

  const snapshot = createOwnerIntentContextSnapshot({
    run: accepted,
    intent,
    assembledContext: assembled,
    createdAt: "2026-09-28T12:00:01.000Z"
  });

  const contextReady = transitionOrchestrationRun(accepted, {
    to: "context-ready",
    now: "2026-09-28T12:00:02.000Z",
    checkpointPatch: {
      contextSnapshot: {
        id: snapshot.id,
        hash: snapshot.snapshotHash
      }
    }
  });

  return { accepted, snapshot, contextReady };
}

class MemorySnapshotStore implements OrchestrationContextSnapshotStore {
  reads = 0;
  constructor(readonly snapshot: OrchestrationContextSnapshot) {}
  async create() {
    return { status: "idempotent-replay" as const, snapshot: this.snapshot };
  }
  async get(id: string) {
    this.reads += 1;
    return id === this.snapshot.id ? this.snapshot : null;
  }
  async getByRunVersion(runId: string, runVersion: number) {
    return this.snapshot.runId === runId && this.snapshot.runVersion === runVersion
      ? this.snapshot
      : null;
  }
}

class MemoryPlannerInputStore implements PlannerInputStore {
  value: PlannerInputEnvelope | null = null;
  creates = 0;
  async create(input: PlannerInputEnvelope) {
    this.creates += 1;
    if (this.value) {
      return { status: "idempotent-replay" as const, input: this.value };
    }
    this.value = input;
    return { status: "created" as const, input };
  }
  async get(id: string) {
    return this.value?.id === id ? this.value : null;
  }
  async getByRunVersion(runId: string, sourceRunVersion: number) {
    return this.value?.runId === runId
      && this.value.sourceRunVersion === sourceRunVersion
      ? this.value
      : null;
  }
}

class MemoryPlanStore implements OrchestrationPlanProposalStore {
  value: PersistedPlanProposal | null = null;
  creates = 0;
  async create(artifact: PersistedPlanProposal) {
    this.creates += 1;
    if (this.value) {
      return { status: "idempotent-replay" as const, artifact: this.value };
    }
    this.value = artifact;
    return { status: "created" as const, artifact };
  }
  async get(id: string) {
    return this.value?.id === id ? this.value : null;
  }
  async getByRunVersion(runId: string, planningRunVersion: number) {
    return this.value?.runId === runId
      && this.value.planningRunVersion === planningRunVersion
      ? this.value
      : null;
  }
}

function plannerCandidate() {
  return validPlan({
    id: "plan-owner-request",
    scope: {
      portfolioId: intent.portfolioId,
      companyId: intent.companyId,
      environment: intent.environment,
      dataClass: "internal"
    },
    source: {
      type: "owner-request",
      requestId: intent.id
    },
    objective: undefined,
    createdAt: "2026-09-28T12:00:04.000Z"
  });
}

describe("durable snapshot-only planning flow", () => {
  it("freezes planner input only from the persisted ContextSnapshot", async () => {
    const { snapshot, contextReady } = snapshotAndContextReady();
    const snapshots = new MemorySnapshotStore(snapshot);
    const plannerInputs = new MemoryPlannerInputStore();

    const result = await advanceContextReadyToPlanning({
      run: contextReady,
      snapshots,
      plannerInputs,
      now: () => new Date("2026-09-28T12:00:03.000Z")
    });

    expect(result.kind).toBe("advance");
    if (result.kind !== "advance") throw new Error("advance expected");
    expect(result.next.state).toBe("planning");
    expect(result.next.version).toBe(contextReady.version + 1);
    expect(result.next.checkpoints.plannerInput).toEqual({
      id: plannerInputs.value?.id,
      hash: plannerInputs.value?.inputHash
    });
    expect(plannerInputs.value?.sourceInput).toEqual({
      type: "owner-intent",
      message: intent.message,
      channel: intent.channel
    });
    expect(plannerInputs.value?.contextSnapshot).toEqual({
      id: snapshot.id,
      hash: snapshot.snapshotHash
    });
    expect(snapshots.reads).toBe(1);
  });

  it("reuses planner input after crash before context-ready -> planning CAS", async () => {
    const { snapshot, contextReady } = snapshotAndContextReady();
    const snapshots = new MemorySnapshotStore(snapshot);
    const plannerInputs = new MemoryPlannerInputStore();

    const first = await advanceContextReadyToPlanning({
      run: contextReady,
      snapshots,
      plannerInputs,
      now: () => new Date("2026-09-28T12:00:03.000Z")
    });
    expect(first.kind).toBe("advance");
    expect(snapshots.reads).toBe(1);

    const replay = await advanceContextReadyToPlanning({
      run: contextReady,
      snapshots,
      plannerInputs,
      now: () => new Date("2026-09-28T12:05:00.000Z")
    });

    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.checkpoints.plannerInput)
      .toEqual(first.next.checkpoints.plannerInput);
    expect(snapshots.reads).toBe(1);
    expect(plannerInputs.creates).toBe(1);
  });

  it("invokes planner with deterministic request identity and persists planned checkpoint", async () => {
    const { snapshot, contextReady } = snapshotAndContextReady();
    const plannerInputs = new MemoryPlannerInputStore();
    const inputRecord = createPlannerInputEnvelope({
      run: contextReady,
      snapshot,
      createdAt: "2026-09-28T12:00:03.000Z"
    });
    plannerInputs.value = inputRecord;

    const planning = transitionOrchestrationRun(contextReady, {
      to: "planning",
      now: "2026-09-28T12:00:03.000Z",
      checkpointPatch: {
        plannerInput: {
          id: inputRecord.id,
          hash: inputRecord.inputHash
        }
      }
    });

    const plans = new MemoryPlanStore();
    let calls = 0;
    let captured: Parameters<DurablePlanner["propose"]>[0] | undefined;
    const planner: DurablePlanner = {
      descriptor: {
        snapshotOnlyInput: true,
        deterministicRequestIdentity: true,
        structuredPlanOutput: true
      },
      async propose(request) {
        calls += 1;
        captured = request;
        return {
          kind: "success",
          requestId: request.requestId,
          candidate: plannerCandidate()
        };
      }
    };

    const result = await advancePlanningToPlanned({
      run: planning,
      plannerInputs,
      plans,
      planner,
      now: () => new Date("2026-09-28T12:00:04.000Z")
    });

    expect(calls).toBe(1);
    expect(captured?.requestId).toBe(plannerRequestId(planning.id, planning.version));
    expect(captured?.plannerInput).toBe(inputRecord);
    expect(result.kind).toBe("advance");
    if (result.kind !== "advance") throw new Error("advance expected");
    expect(result.next.state).toBe("planned");
    expect(result.next.checkpoints.plan).toEqual({
      id: plans.value?.id,
      hash: plans.value?.planHash
    });
    expect(plans.value?.proposal.source).toEqual({
      type: "owner-request",
      requestId: intent.id
    });
  });

  it("reuses the persisted plan after crash before planning -> planned CAS", async () => {
    const { snapshot, contextReady } = snapshotAndContextReady();
    const plannerInputs = new MemoryPlannerInputStore();
    plannerInputs.value = createPlannerInputEnvelope({
      run: contextReady,
      snapshot,
      createdAt: "2026-09-28T12:00:03.000Z"
    });
    const planning = transitionOrchestrationRun(contextReady, {
      to: "planning",
      now: "2026-09-28T12:00:03.000Z",
      checkpointPatch: {
        plannerInput: {
          id: plannerInputs.value.id,
          hash: plannerInputs.value.inputHash
        }
      }
    });

    const plans = new MemoryPlanStore();
    let calls = 0;
    const planner: DurablePlanner = {
      descriptor: {
        snapshotOnlyInput: true,
        deterministicRequestIdentity: true,
        structuredPlanOutput: true
      },
      async propose(request) {
        calls += 1;
        return {
          kind: "success",
          requestId: request.requestId,
          candidate: plannerCandidate()
        };
      }
    };

    const first = await advancePlanningToPlanned({
      run: planning,
      plannerInputs,
      plans,
      planner,
      now: () => new Date("2026-09-28T12:00:04.000Z")
    });
    expect(first.kind).toBe("advance");
    expect(calls).toBe(1);

    const replay = await advancePlanningToPlanned({
      run: planning,
      plannerInputs,
      plans,
      planner,
      now: () => new Date("2026-09-28T12:05:00.000Z")
    });

    expect(replay.kind).toBe("advance");
    expect(calls).toBe(1);
    expect(plans.creates).toBe(1);
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.checkpoints.plan).toEqual(first.next.checkpoints.plan);
  });

  it("rejects planner output that attempts cross-company or environment scope", async () => {
    const { snapshot, contextReady } = snapshotAndContextReady();
    const plannerInputs = new MemoryPlannerInputStore();
    plannerInputs.value = createPlannerInputEnvelope({
      run: contextReady,
      snapshot,
      createdAt: "2026-09-28T12:00:03.000Z"
    });
    const planning = transitionOrchestrationRun(contextReady, {
      to: "planning",
      now: "2026-09-28T12:00:03.000Z",
      checkpointPatch: {
        plannerInput: {
          id: plannerInputs.value.id,
          hash: plannerInputs.value.inputHash
        }
      }
    });

    const planner: DurablePlanner = {
      descriptor: {
        snapshotOnlyInput: true,
        deterministicRequestIdentity: true,
        structuredPlanOutput: true
      },
      async propose(request) {
        return {
          kind: "success",
          requestId: request.requestId,
          candidate: validPlan({
            scope: {
              portfolioId: intent.portfolioId,
              companyId: "company-b",
              environment: "production",
              dataClass: "internal"
            },
            source: { type: "owner-request", requestId: intent.id },
            objective: undefined
          })
        };
      }
    };

    await expect(advancePlanningToPlanned({
      run: planning,
      plannerInputs,
      plans: new MemoryPlanStore(),
      planner
    })).rejects.toThrow(/scope\/environment/i);
  });

  it("maps planner unavailability to durable retry or terminal failure", async () => {
    const { snapshot, contextReady } = snapshotAndContextReady();
    const plannerInputs = new MemoryPlannerInputStore();
    plannerInputs.value = createPlannerInputEnvelope({
      run: contextReady,
      snapshot,
      createdAt: "2026-09-28T12:00:03.000Z"
    });
    const planning = transitionOrchestrationRun(contextReady, {
      to: "planning",
      now: "2026-09-28T12:00:03.000Z",
      checkpointPatch: {
        plannerInput: {
          id: plannerInputs.value.id,
          hash: plannerInputs.value.inputHash
        }
      }
    });

    const retry = await advancePlanningToPlanned({
      run: planning,
      plannerInputs,
      plans: new MemoryPlanStore(),
      planner: {
        descriptor: {
          snapshotOnlyInput: true,
          deterministicRequestIdentity: true,
          structuredPlanOutput: true
        },
        propose: async () => ({
          kind: "unavailable",
          code: "MODEL_CALL_FAILED",
          reason: "temporary transport failure",
          retryable: true,
          retryAfterMs: 5_000
        })
      }
    });
    expect(retry).toMatchObject({
      kind: "retry",
      code: "MODEL_CALL_FAILED",
      retryAfterMs: 5_000
    });

    const failed = await advancePlanningToPlanned({
      run: planning,
      plannerInputs,
      plans: new MemoryPlanStore(),
      planner: {
        descriptor: {
          snapshotOnlyInput: true,
          deterministicRequestIdentity: true,
          structuredPlanOutput: true
        },
        propose: async () => ({
          kind: "unavailable",
          code: "NO_ELIGIBLE_MODEL",
          reason: "policy admits no model",
          retryable: false
        })
      }
    });
    expect(failed).toMatchObject({
      kind: "failed",
      code: "NO_ELIGIBLE_MODEL"
    });
  });
});
