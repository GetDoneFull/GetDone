import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  createOwnerIntentContextSnapshot,
  createOwnerIntentOrchestrationRun
} from "@/lib/orchestration/owner-intent-flow";
import {
  createPersistedPlanProposal,
  createPlannerInputEnvelope,
  planArtifactIdempotencyKey,
  plannerInputIdempotencyKey
} from "@/lib/orchestration/planning-flow";
import { transitionOrchestrationRun } from "@/lib/orchestration/contracts";
import { assembleContext } from "@/lib/intelligence/context";
import { validPlan } from "@/lib/planning/test-fixture";
import {
  PostgresOrchestrationPlanProposalStore,
  PostgresPlannerInputStore
} from "@/lib/persistence/postgres/orchestration-planning-stores";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface ResponseSpec {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDb implements PostgresTransactionalDatabase {
  readonly calls: string[] = [];
  constructor(private readonly responses: ResponseSpec[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string
  ): Promise<QueryResult<R>> {
    this.calls.push(text.replace(/\s+/g, " ").trim());
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    return operation(this as unknown as PoolClient);
  }
}

const intent = {
  id: "intent-1",
  correlationId: "correlation-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const,
  userId: "owner-a",
  message: "grow",
  channel: "chat" as const,
  status: "accepted" as const,
  receivedAt: "2026-09-28T12:00:00.000Z"
};

function fixture() {
  const accepted = createOwnerIntentOrchestrationRun(intent);
  const assembledContext = assembleContext([], {
    portfolioId: intent.portfolioId,
    companyId: intent.companyId,
    allowedSensitivity: ["public", "internal"]
  }, {
    now: Date.parse("2026-09-28T12:00:01.000Z")
  });
  const snapshot = createOwnerIntentContextSnapshot({
    run: accepted,
    intent,
    assembledContext,
    createdAt: "2026-09-28T12:00:01.000Z"
  });
  const contextReady = transitionOrchestrationRun(accepted, {
    to: "context-ready",
    now: "2026-09-28T12:00:02.000Z",
    checkpointPatch: {
      contextSnapshot: { id: snapshot.id, hash: snapshot.snapshotHash }
    }
  });
  const plannerInput = createPlannerInputEnvelope({
    run: contextReady,
    snapshot,
    createdAt: "2026-09-28T12:00:03.000Z"
  });
  const planning = transitionOrchestrationRun(contextReady, {
    to: "planning",
    now: "2026-09-28T12:00:03.000Z",
    checkpointPatch: {
      plannerInput: { id: plannerInput.id, hash: plannerInput.inputHash }
    }
  });
  const proposal = validPlan({
    id: "plan-1",
    scope: {
      portfolioId: intent.portfolioId,
      companyId: intent.companyId,
      environment: intent.environment,
      dataClass: "internal"
    },
    source: { type: "owner-request", requestId: intent.id },
    objective: undefined
  });
  const artifact = createPersistedPlanProposal({
    run: planning,
    plannerInput,
    plannerRequestId: "planner-request-1",
    proposal,
    createdAt: "2026-09-28T12:00:04.000Z"
  });
  return { plannerInput, planning, artifact };
}

describe("PostgreSQL durable planning stores", () => {
  it("creates and exactly replays a PlannerInput", async () => {
    const { plannerInput } = fixture();
    const key = plannerInputIdempotencyKey(
      plannerInput.runId,
      plannerInput.sourceRunVersion
    );

    const createdDb = new ScriptedDb([{ rowCount: 1 }]);
    expect(await new PostgresPlannerInputStore(createdDb).create(plannerInput, key))
      .toEqual({ status: "created", input: plannerInput });

    const replayDb = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: plannerInput,
          input_hash: plannerInput.inputHash,
          idempotency_key: key
        }]
      }
    ]);
    expect(await new PostgresPlannerInputStore(replayDb).create(plannerInput, key))
      .toEqual({ status: "idempotent-replay", input: plannerInput });
  });

  it("rejects PlannerInput idempotency reuse with different content", async () => {
    const { plannerInput } = fixture();
    const key = plannerInputIdempotencyKey(
      plannerInput.runId,
      plannerInput.sourceRunVersion
    );
    const db = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: plannerInput,
          input_hash: "b".repeat(64),
          idempotency_key: key
        }]
      }
    ]);

    await expect(
      new PostgresPlannerInputStore(db).create(plannerInput, key)
    ).rejects.toThrow(/Planner input conflicts/i);
  });

  it("creates and exactly replays a plan artifact", async () => {
    const { artifact } = fixture();
    const key = planArtifactIdempotencyKey(
      artifact.runId,
      artifact.planningRunVersion
    );

    const createdDb = new ScriptedDb([{ rowCount: 1 }]);
    expect(await new PostgresOrchestrationPlanProposalStore(createdDb)
      .create(artifact, key))
      .toEqual({ status: "created", artifact });

    const replayDb = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: artifact,
          plan_hash: artifact.planHash,
          artifact_hash: artifact.artifactHash,
          idempotency_key: key
        }]
      }
    ]);
    expect(await new PostgresOrchestrationPlanProposalStore(replayDb)
      .create(artifact, key))
      .toEqual({ status: "idempotent-replay", artifact });
  });

  it("rejects different plan content for the same planner request/run version", async () => {
    const { artifact } = fixture();
    const key = planArtifactIdempotencyKey(
      artifact.runId,
      artifact.planningRunVersion
    );
    const db = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: artifact,
          plan_hash: "c".repeat(64),
          artifact_hash: "d".repeat(64),
          idempotency_key: key
        }]
      }
    ]);

    await expect(
      new PostgresOrchestrationPlanProposalStore(db).create(artifact, key)
    ).rejects.toThrow(/Plan artifact conflicts/i);
  });

  it("reads planner inputs and plans by exact identity and run version", async () => {
    const { plannerInput, artifact } = fixture();
    const plannerDb = new ScriptedDb([
      { rows: [{ payload: plannerInput }] },
      { rows: [{ payload: plannerInput }] }
    ]);
    const inputStore = new PostgresPlannerInputStore(plannerDb);
    expect(await inputStore.get(plannerInput.id)).toEqual(plannerInput);
    expect(await inputStore.getByRunVersion(
      plannerInput.runId,
      plannerInput.sourceRunVersion
    )).toEqual(plannerInput);

    const planDb = new ScriptedDb([
      { rows: [{ payload: artifact }] },
      { rows: [{ payload: artifact }] }
    ]);
    const planStore = new PostgresOrchestrationPlanProposalStore(planDb);
    expect(await planStore.get(artifact.id)).toEqual(artifact);
    expect(await planStore.getByRunVersion(
      artifact.runId,
      artifact.planningRunVersion
    )).toEqual(artifact);
  });
});
