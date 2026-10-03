import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrchestrationRun,
  createOrchestrationSourceRef,
  transitionOrchestrationRun,
  type OrchestrationCheckpoints,
  type OrchestrationRunRecord,
  type OrchestrationState
} from "@/lib/orchestration/contracts";
import {
  orchestrationClaimIdempotencyKey
} from "@/lib/orchestration/worker-contracts";
import {
  PostgresOrchestrationRunStore,
  orchestrationTransitionIdempotencyKey
} from "@/lib/persistence/postgres/orchestration-store";
import { PostgresOrchestrationWorkerStore } from "@/lib/persistence/postgres/orchestration-worker-store";
import {
  PostgresDatabase,
  readPostgresConfigFromEnv
} from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;

type ResumableState = Exclude<
  OrchestrationState,
  "awaiting-decision" | "completed" | "blocked" | "failed" | "cancelled"
>;

const stages: ReadonlyArray<{
  from: ResumableState;
  to: OrchestrationState;
}> = [
  { from: "accepted", to: "context-ready" },
  { from: "context-ready", to: "planning" },
  { from: "planning", to: "planned" },
  { from: "planned", to: "validated" },
  { from: "validated", to: "policy-evaluated" },
  { from: "policy-evaluated", to: "authorized" },
  { from: "authorized", to: "tasks-created" },
  { from: "tasks-created", to: "jobs-enqueued" },
  { from: "jobs-enqueued", to: "executing" },
  { from: "executing", to: "verifying" },
  { from: "verifying", to: "completed" }
];

integrationDescribe("PostgreSQL orchestration crash/restart lifecycle matrix", () => {
  let database: PostgresDatabase | undefined;
  let runStore: PostgresOrchestrationRunStore;
  let workerStore: PostgresOrchestrationWorkerStore;
  const suffix = `${process.pid}-${Date.now()}`;
  const scope = {
    userId: `owner-crash-${suffix}`,
    portfolioId: `portfolio-crash-${suffix}`,
    companyId: `company-crash-${suffix}`,
    environment: "staging" as const
  };

  function db() {
    if (!database) throw new Error("PostgreSQL crash matrix database is not initialized");
    return database;
  }

  function inScope<T>(operation: () => T) {
    return runWithPostgresTenantScope(scope, operation);
  }

  function initial(name: string) {
    const source = {
      id: `intent-crash-${name}-${suffix}`,
      message: `crash matrix ${name}`
    };
    return createOrchestrationRun({
      id: `run-crash-${name}-${suffix}`,
      correlationId: `correlation-crash-${name}-${suffix}`,
      source: createOrchestrationSourceRef("owner-intent", source.id, source),
      scope,
      createdAt: "2026-09-28T10:00:00.000Z",
      updatedAt: "2026-09-28T10:00:00.000Z"
    });
  }

  function patchFor(to: OrchestrationState) {
    switch (to) {
      case "context-ready":
        return { contextSnapshot: { id: "context", hash: "a".repeat(64) } };
      case "planning":
        return { plannerInput: { id: "planner-input", hash: "b".repeat(64) } };
      case "planned":
        return { plan: { id: "plan", hash: "c".repeat(64) } };
      case "validated":
        return { validationReceipt: { id: "validation", hash: "d".repeat(64) } };
      case "policy-evaluated":
        return { policySnapshot: { id: "policy", hash: "e".repeat(64) } };
      case "authorized":
        return {
          authorizationGrants: [{
            id: "grant",
            hash: "f".repeat(64),
            disposition: "AUTO" as const
          }]
        };
      case "tasks-created":
        return {
          tasks: [{
            id: "task",
            hash: "1".repeat(64),
            authorizationConsumptionHash: "2".repeat(64)
          }]
        };
      case "jobs-enqueued":
        return { jobIds: ["job-1"] };
      case "executing":
        return {};
      case "verifying":
        return { verificationRequestIds: ["verification-request-1"] };
      case "completed":
        return {
          verifiedOutcomes: [{
            id: "outcome-1",
            verificationReceiptId: "receipt-1",
            verificationReceiptHash: "3".repeat(64)
          }]
        };
      default:
        return {};
    }
  }

  async function cas(
    current: OrchestrationRunRecord,
    to: OrchestrationState,
    at: string,
    extraPatch: Partial<OrchestrationCheckpoints> = {}
  ) {
    const next = transitionOrchestrationRun(current, {
      to,
      now: at,
      checkpointPatch: {
        ...patchFor(to),
        ...extraPatch
      }
    });
    return inScope(() => runStore.compareAndSwap(next, {
      expectedVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationTransitionIdempotencyKey(current, next.state)
    }));
  }

  async function buildTo(name: string, target: ResumableState) {
    let current = initial(name);
    await inScope(() => runStore.create(
      current,
      `orchestration:start:owner-intent:${current.source.id}`
    ));
    if (target === "accepted") return current;

    let minute = 1;
    for (const stage of stages) {
      if (stage.from !== current.state) {
        throw new Error(`fixture drift: expected ${stage.from}, got ${current.state}`);
      }
      current = await cas(
        current,
        stage.to,
        `2026-09-28T10:${String(minute++).padStart(2, "0")}:00.000Z`
      );
      if (current.state === target) return current;
      if (current.state === "completed") break;
    }
    throw new Error(`could not build fixture to ${target}`);
  }

  beforeAll(() => {
    database = new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    runStore = new PostgresOrchestrationRunStore(db());
    workerStore = new PostgresOrchestrationWorkerStore(db());
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  for (const [index, stage] of stages.entries()) {
    it(`retries ${stage.from} after crash immediately before checkpoint persistence`, async () => {
      const current = await buildTo(`before-${stage.from}`, stage.from);
      const minute = String(20 + index * 2).padStart(2, "0");
      const claimedAt = `2026-09-28T12:${minute}:00.000Z`;

      const lease = await inScope(() => workerStore.claimAtomic({
        runId: current.id,
        workerId: `crash-before-${index}`,
        now: claimedAt,
        leaseSeconds: 2,
        expectedRunVersion: current.version,
        expectedRecordHash: current.recordHash,
        idempotencyKey: orchestrationClaimIdempotencyKey({
          runId: current.id,
          runVersion: current.version,
          workerId: `crash-before-${index}`
        })
      }));
      expect(lease).not.toBeNull();

      const recoveredAt = new Date(Date.parse(claimedAt) + 3_000).toISOString();
      const recovered = await workerStore.recoverExpired({
        now: recoveredAt,
        limit: 100,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 1
      });
      expect(
        recovered.find((item) => item.runId === current.id)?.outcome
      ).toBe("retry-scheduled");

      const authoritative = await inScope(() => runStore.get(current.id));
      expect(authoritative?.state).toBe(stage.from);
      expect(authoritative?.version).toBe(current.version);
    });

    it(`resumes from ${stage.to} after crash immediately after checkpoint persistence`, async () => {
      const current = await buildTo(`after-${stage.from}`, stage.from);
      const minute = String(21 + index * 2).padStart(2, "0");
      const claimedAt = `2026-09-28T12:${minute}:00.000Z`;

      const lease = await inScope(() => workerStore.claimAtomic({
        runId: current.id,
        workerId: `crash-after-${index}`,
        now: claimedAt,
        leaseSeconds: 2,
        expectedRunVersion: current.version,
        expectedRecordHash: current.recordHash,
        idempotencyKey: orchestrationClaimIdempotencyKey({
          runId: current.id,
          runVersion: current.version,
          workerId: `crash-after-${index}`
        })
      }));
      expect(lease).not.toBeNull();

      const checkpointAt = new Date(Date.parse(claimedAt) + 1_000).toISOString();
      const next = await cas(current, stage.to, checkpointAt);

      const recoveredAt = new Date(Date.parse(claimedAt) + 3_000).toISOString();
      const recovered = await workerStore.recoverExpired({
        now: recoveredAt,
        limit: 100,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 1
      });
      expect(
        recovered.find((item) => item.runId === current.id)?.outcome
      ).toBe("stage-advanced-before-crash");

      const authoritative = await inScope(() => runStore.get(current.id));
      expect(authoritative?.state).toBe(stage.to);
      expect(authoritative?.version).toBe(next.version);

      const ready = await workerStore.listReady({
        now: recoveredAt,
        limit: 500
      });
      const candidate = ready.find((item) => item.run.id === current.id);
      if (stage.to === "completed") {
        expect(candidate).toBeUndefined();
      } else {
        expect(candidate?.run.state).toBe(stage.to);
        expect(candidate?.stageAttempt).toBe(0);
        expect(candidate?.consecutiveFailures).toBe(0);
      }
    });
  }

  it("keeps awaiting-decision unclaimable and wakes the exact run after Decision resolution", async () => {
    let current = await buildTo("decision-resolution", "policy-evaluated");
    current = await cas(
      current,
      "awaiting-decision",
      "2026-09-28T13:00:00.000Z",
      { decisionIds: ["decision-1"] }
    );

    const waiting = await workerStore.listReady({
      now: "2026-09-28T13:00:01.000Z",
      limit: 500
    });
    expect(waiting.some((candidate) => candidate.run.id === current.id)).toBe(false);

    const authorized = transitionOrchestrationRun(current, {
      to: "authorized",
      now: "2026-09-28T13:00:02.000Z",
      checkpointPatch: {
        authorizationGrants: [{
          id: "grant-decision",
          hash: "4".repeat(64),
          disposition: "APPROVAL_REQUIRED"
        }]
      }
    });
    await inScope(() => runStore.compareAndSwap(authorized, {
      expectedVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationTransitionIdempotencyKey(current, authorized.state)
    }));

    const ready = await workerStore.listReady({
      now: "2026-09-28T13:00:02.000Z",
      limit: 500
    });
    expect(
      ready.find((candidate) => candidate.run.id === current.id)?.run.state
    ).toBe("authorized");
  });
});
