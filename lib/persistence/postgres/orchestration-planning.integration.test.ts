import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  advanceContextReadyToPlanning,
  advancePlanningToPlanned,
  type DurablePlanner
} from "@/lib/orchestration/planning-flow";
import {
  advanceOwnerIntentAcceptedToContextReady
} from "@/lib/orchestration/owner-intent-flow";
import { PostgresOwnerIntentStore } from "@/lib/persistence/postgres/control-api-stores";
import { PostgresOrchestrationRunStore } from "@/lib/persistence/postgres/orchestration-store";
import { PostgresOrchestrationContextSnapshotStore } from "@/lib/persistence/postgres/orchestration-context-snapshot-store";
import {
  PostgresOrchestrationPlanProposalStore,
  PostgresPlannerInputStore
} from "@/lib/persistence/postgres/orchestration-planning-stores";
import {
  PostgresDatabase,
  readPostgresConfigFromEnv
} from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { validPlan } from "@/lib/planning/test-fixture";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;

integrationDescribe("PostgreSQL durable context-ready -> planning -> planned", () => {
  let database: PostgresDatabase | undefined;
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `planning-user-${suffix}`;
  const portfolioId = `planning-portfolio-${suffix}`;
  const companyId = `planning-company-${suffix}`;

  function db() {
    if (!database) throw new Error("PostgreSQL planning test database is not initialized");
    return database;
  }

  function scope(company = companyId) {
    return {
      userId,
      portfolioId,
      companyId: company,
      environment: "staging" as const
    };
  }

  function inScope<T>(operation: () => T, company = companyId) {
    return runWithPostgresTenantScope(scope(company), operation);
  }

  function intent(name: string): OwnerIntentRecord {
    return {
      id: `intent-planning-${name}-${suffix}`,
      correlationId: `correlation-planning-${name}-${suffix}`,
      portfolioId,
      companyId,
      environment: "staging",
      userId,
      message: `plan work ${name}`,
      channel: "chat",
      status: "accepted",
      receivedAt: "2026-09-28T12:30:00.000Z"
    };
  }

  async function acceptedToContextReady(record: OwnerIntentRecord) {
    const ownerIntents = new PostgresOwnerIntentStore(db());
    await inScope(() =>
      ownerIntents.create(record, `client-key-${record.id}`)
    );

    const runStore = new PostgresOrchestrationRunStore(db());
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const accepted = await inScope(() =>
      runStore.getByCorrelationId(record.correlationId!)
    );
    if (!accepted) throw new Error("accepted run expected");

    const contextOutcome = await inScope(() =>
      advanceOwnerIntentAcceptedToContextReady({
        run: accepted,
        ownerIntents,
        candidates: {
          listForIntent: async () => [{
            id: `fact-${record.id}`,
            kind: "fact",
            portfolioId,
            companyId,
            source: "integration-test",
            provenance: "verified:test",
            observedAt: "2026-09-28T12:29:59.000Z",
            freshnessSeconds: 300,
            sensitivity: "internal",
            content: "Verified planning fact."
          }]
        },
        policy: {
          resolve: async () => ({
            scope: {
              portfolioId,
              companyId,
              allowedSensitivity: ["public", "internal"]
            },
            options: {
              now: Date.parse("2026-09-28T12:30:01.000Z")
            }
          })
        },
        snapshots,
        now: () => new Date("2026-09-28T12:30:01.000Z")
      })
    );
    if (contextOutcome.kind !== "advance") {
      throw new Error("context-ready advance expected");
    }

    return inScope(() =>
      runStore.compareAndSwap(contextOutcome.next, {
        expectedVersion: accepted.version,
        expectedRecordHash: accepted.recordHash,
        idempotencyKey:
          `orchestration:${accepted.id}:v${accepted.version}:accepted->context-ready`
      })
    );
  }

  function plannerFor(record: OwnerIntentRecord, counter: { calls: number }): DurablePlanner {
    return {
      descriptor: {
        snapshotOnlyInput: true,
        deterministicRequestIdentity: true,
        structuredPlanOutput: true
      },
      async propose(request) {
        counter.calls += 1;
        return {
          kind: "success",
          requestId: request.requestId,
          candidate: validPlan({
            id: `plan-${record.id}`,
            scope: {
              portfolioId,
              companyId,
              environment: "staging",
              dataClass: "internal"
            },
            source: {
              type: "owner-request",
              requestId: record.id
            },
            objective: undefined,
            createdAt: "2026-09-28T12:30:04.000Z"
          })
        };
      }
    };
  }

  beforeAll(async () => {
    database = new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    await db().query(
      `INSERT INTO auth_users(id,status)
       VALUES($1,'active')
       ON CONFLICT (id) DO NOTHING`,
      [userId]
    );
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  it("persists frozen planner input then advances context-ready -> planning", async () => {
    const record = intent("input");
    const contextReady = await acceptedToContextReady(record);
    const runStore = new PostgresOrchestrationRunStore(db());
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const plannerInputs = new PostgresPlannerInputStore(db());

    const outcome = await inScope(() =>
      advanceContextReadyToPlanning({
        run: contextReady,
        snapshots,
        plannerInputs,
        now: () => new Date("2026-09-28T12:30:02.000Z")
      })
    );

    expect(outcome.kind).toBe("advance");
    if (outcome.kind !== "advance") throw new Error("planning advance expected");

    const planning = await inScope(() =>
      runStore.compareAndSwap(outcome.next, {
        expectedVersion: contextReady.version,
        expectedRecordHash: contextReady.recordHash,
        idempotencyKey:
          `orchestration:${contextReady.id}:v${contextReady.version}:context-ready->planning`
      })
    );

    expect(planning.state).toBe("planning");
    const plannerInput = await inScope(() =>
      plannerInputs.get(planning.checkpoints.plannerInput!.id)
    );
    expect(plannerInput?.sourceInput).toMatchObject({
      type: "owner-intent",
      message: record.message
    });
    expect(plannerInput?.contextSnapshot)
      .toEqual(planning.checkpoints.contextSnapshot);
  });

  it("persists one plan and advances planning -> planned without live OwnerIntent reads", async () => {
    const record = intent("planned");
    const contextReady = await acceptedToContextReady(record);
    const runStore = new PostgresOrchestrationRunStore(db());
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const plannerInputs = new PostgresPlannerInputStore(db());
    const plans = new PostgresOrchestrationPlanProposalStore(db());

    const planningOutcome = await inScope(() =>
      advanceContextReadyToPlanning({
        run: contextReady,
        snapshots,
        plannerInputs,
        now: () => new Date("2026-09-28T12:30:02.000Z")
      })
    );
    if (planningOutcome.kind !== "advance") throw new Error("planning advance expected");
    const planning = await inScope(() =>
      runStore.compareAndSwap(planningOutcome.next, {
        expectedVersion: contextReady.version,
        expectedRecordHash: contextReady.recordHash,
        idempotencyKey:
          `orchestration:${contextReady.id}:v${contextReady.version}:context-ready->planning`
      })
    );

    const counter = { calls: 0 };
    const plannedOutcome = await inScope(() =>
      advancePlanningToPlanned({
        run: planning,
        plannerInputs,
        plans,
        planner: plannerFor(record, counter),
        now: () => new Date("2026-09-28T12:30:04.000Z")
      })
    );

    expect(counter.calls).toBe(1);
    expect(plannedOutcome.kind).toBe("advance");
    if (plannedOutcome.kind !== "advance") throw new Error("planned advance expected");

    const planned = await inScope(() =>
      runStore.compareAndSwap(plannedOutcome.next, {
        expectedVersion: planning.version,
        expectedRecordHash: planning.recordHash,
        idempotencyKey:
          `orchestration:${planning.id}:v${planning.version}:planning->planned`
      })
    );

    expect(planned.state).toBe("planned");
    const artifact = await inScope(() =>
      plans.get(planned.checkpoints.plan!.id)
    );
    expect(artifact?.proposal.source).toEqual({
      type: "owner-request",
      requestId: record.id
    });
    expect(artifact?.plannerInputHash)
      .toBe(planning.checkpoints.plannerInput?.hash);
  });

  it("reuses frozen planner input after pre-CAS crash without rereading ContextSnapshot", async () => {
    const record = intent("input-crash");
    const contextReady = await acceptedToContextReady(record);
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const plannerInputs = new PostgresPlannerInputStore(db());

    const first = await inScope(() =>
      advanceContextReadyToPlanning({
        run: contextReady,
        snapshots,
        plannerInputs,
        now: () => new Date("2026-09-28T12:30:02.000Z")
      })
    );
    expect(first.kind).toBe("advance");

    const replay = await inScope(() =>
      advanceContextReadyToPlanning({
        run: contextReady,
        snapshots: {
          create: snapshots.create.bind(snapshots),
          get: async () => {
            throw new Error("ContextSnapshot must not be reread after planner input freeze");
          },
          getByRunVersion: snapshots.getByRunVersion.bind(snapshots)
        },
        plannerInputs,
        now: () => new Date("2026-09-28T12:35:00.000Z")
      })
    );

    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.checkpoints.plannerInput)
      .toEqual(first.next.checkpoints.plannerInput);
  });

  it("reuses persisted plan after pre-CAS crash without reinvoking planner", async () => {
    const record = intent("plan-crash");
    const contextReady = await acceptedToContextReady(record);
    const runStore = new PostgresOrchestrationRunStore(db());
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const plannerInputs = new PostgresPlannerInputStore(db());
    const plans = new PostgresOrchestrationPlanProposalStore(db());

    const planningOutcome = await inScope(() =>
      advanceContextReadyToPlanning({
        run: contextReady,
        snapshots,
        plannerInputs,
        now: () => new Date("2026-09-28T12:30:02.000Z")
      })
    );
    if (planningOutcome.kind !== "advance") throw new Error("planning advance expected");
    const planning = await inScope(() =>
      runStore.compareAndSwap(planningOutcome.next, {
        expectedVersion: contextReady.version,
        expectedRecordHash: contextReady.recordHash,
        idempotencyKey:
          `orchestration:${contextReady.id}:v${contextReady.version}:context-ready->planning`
      })
    );

    const counter = { calls: 0 };
    const planner = plannerFor(record, counter);
    const first = await inScope(() =>
      advancePlanningToPlanned({
        run: planning,
        plannerInputs,
        plans,
        planner,
        now: () => new Date("2026-09-28T12:30:04.000Z")
      })
    );
    expect(first.kind).toBe("advance");
    expect(counter.calls).toBe(1);

    const replay = await inScope(() =>
      advancePlanningToPlanned({
        run: planning,
        plannerInputs,
        plans,
        planner: {
          ...planner,
          propose: async () => {
            throw new Error("Planner must not be reinvoked after plan artifact commit");
          }
        },
        now: () => new Date("2026-09-28T12:35:00.000Z")
      })
    );

    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.checkpoints.plan).toEqual(first.next.checkpoints.plan);
    expect(counter.calls).toBe(1);
  });

  it("keeps planner inputs and plans tenant-isolated by forced RLS", async () => {
    const record = intent("rls");
    const contextReady = await acceptedToContextReady(record);
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const plannerInputs = new PostgresPlannerInputStore(db());

    const outcome = await inScope(() =>
      advanceContextReadyToPlanning({
        run: contextReady,
        snapshots,
        plannerInputs,
        now: () => new Date("2026-09-28T12:30:02.000Z")
      })
    );
    if (outcome.kind !== "advance") throw new Error("planning advance expected");

    const foreignCompany = `planning-other-company-${suffix}`;
    expect(await inScope(
      () => plannerInputs.get(outcome.next.checkpoints.plannerInput!.id),
      foreignCompany
    )).toBeNull();
  });
});
