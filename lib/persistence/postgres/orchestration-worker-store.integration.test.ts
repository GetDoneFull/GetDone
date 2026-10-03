import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrchestrationRun,
  createOrchestrationSourceRef,
  transitionOrchestrationRun
} from "@/lib/orchestration/contracts";
import {
  orchestrationClaimIdempotencyKey,
  orchestrationHeartbeatIdempotencyKey,
  orchestrationRetryIdempotencyKey
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

integrationDescribe("PostgreSQL UFO orchestration worker", () => {
  let database: PostgresDatabase | undefined;
  let runStore: PostgresOrchestrationRunStore;
  let workerStore: PostgresOrchestrationWorkerStore;
  const suffix = `${process.pid}-${Date.now()}`;

  const scope = {
    userId: `owner-${suffix}`,
    portfolioId: `portfolio-worker-${suffix}`,
    companyId: `company-worker-${suffix}`,
    environment: "staging" as const
  };

  function db() {
    if (!database) throw new Error("PostgreSQL worker test database is not initialized");
    return database;
  }

  function inScope<T>(operation: () => T) {
    return runWithPostgresTenantScope(scope, operation);
  }

  function run(name: string, runScope = scope) {
    const source = {
      id: `intent-worker-${name}-${suffix}`,
      message: `worker ${name}`
    };
    return createOrchestrationRun({
      id: `run-worker-${name}-${suffix}`,
      correlationId: `correlation-worker-${name}-${suffix}`,
      source: createOrchestrationSourceRef("owner-intent", source.id, source),
      scope: runScope,
      createdAt: "2026-09-28T11:00:00.000Z",
      updatedAt: "2026-09-28T11:00:00.000Z"
    });
  }

  beforeAll(() => {
    database = new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    runStore = new PostgresOrchestrationRunStore(db());
    workerStore = new PostgresOrchestrationWorkerStore(db());
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  it("claims one run with an exclusive lease and blocks a second worker", async () => {
    const current = run("claim");
    await inScope(() => runStore.create(
      current,
      `orchestration:start:owner-intent:${current.source.id}`
    ));

    const candidates = await inScope(() => workerStore.listReady({
      now: "2026-09-28T11:00:01.000Z",
      limit: 10
    }));
    expect(candidates.some((candidate) => candidate.run.id === current.id)).toBe(true);

    const lease = await inScope(() => workerStore.claimAtomic({
      runId: current.id,
      workerId: "worker-a",
      now: "2026-09-28T11:00:01.000Z",
      leaseSeconds: 60,
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationClaimIdempotencyKey({
        runId: current.id,
        runVersion: current.version,
        workerId: "worker-a"
      })
    }));
    expect(lease).not.toBeNull();

    const second = await inScope(() => workerStore.claimAtomic({
      runId: current.id,
      workerId: "worker-b",
      now: "2026-09-28T11:00:02.000Z",
      leaseSeconds: 60,
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationClaimIdempotencyKey({
        runId: current.id,
        runVersion: current.version,
        workerId: "worker-b"
      })
    }));
    expect(second).toBeNull();
  });

  it("heartbeats a live lease and schedules retry with durable backoff readiness", async () => {
    const current = run("retry");
    await inScope(() => runStore.create(
      current,
      `orchestration:start:owner-intent:${current.source.id}`
    ));

    const lease = await inScope(() => workerStore.claimAtomic({
      runId: current.id,
      workerId: "worker-a",
      now: "2026-09-28T11:01:00.000Z",
      leaseSeconds: 60,
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationClaimIdempotencyKey({
        runId: current.id,
        runVersion: current.version,
        workerId: "worker-a"
      })
    }));
    expect(lease).not.toBeNull();
    if (!lease) throw new Error("lease expected");

    const renewed = await inScope(() => workerStore.heartbeat({
      lease,
      now: "2026-09-28T11:01:20.000Z",
      extendSeconds: 60,
      idempotencyKey: orchestrationHeartbeatIdempotencyKey(lease)
    }));
    expect(renewed.version).toBe(lease.version + 1);

    await inScope(() => workerStore.scheduleRetry({
      lease: renewed,
      now: "2026-09-28T11:01:21.000Z",
      readyAt: "2026-09-28T11:01:30.000Z",
      code: "UNAVAILABLE",
      reason: "temporary dependency failure",
      idempotencyKey: orchestrationRetryIdempotencyKey(renewed)
    }));

    const tooEarly = await inScope(() => workerStore.listReady({
      now: "2026-09-28T11:01:29.000Z",
      limit: 100
    }));
    expect(tooEarly.some((candidate) => candidate.run.id === current.id)).toBe(false);

    const ready = await inScope(() => workerStore.listReady({
      now: "2026-09-28T11:01:31.000Z",
      limit: 100
    }));
    const candidate = ready.find((item) => item.run.id === current.id);
    expect(candidate?.consecutiveFailures).toBe(1);
  });

  it("recovers a crash after checkpoint commit without replaying the completed stage", async () => {
    const current = run("crash-after-cas");
    await inScope(() => runStore.create(
      current,
      `orchestration:start:owner-intent:${current.source.id}`
    ));

    const lease = await inScope(() => workerStore.claimAtomic({
      runId: current.id,
      workerId: "worker-a",
      now: "2026-09-28T11:02:00.000Z",
      leaseSeconds: 2,
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationClaimIdempotencyKey({
        runId: current.id,
        runVersion: current.version,
        workerId: "worker-a"
      })
    }));
    expect(lease).not.toBeNull();
    if (!lease) throw new Error("lease expected");

    const next = transitionOrchestrationRun(current, {
      to: "context-ready",
      now: "2026-09-28T11:02:01.000Z",
      checkpointPatch: {
        contextSnapshot: {
          id: `context-worker-${suffix}`,
          hash: "a".repeat(64)
        }
      }
    });

    await inScope(() => runStore.compareAndSwap(next, {
      expectedVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationTransitionIdempotencyKey(current, next.state)
    }));

    const recovered = await inScope(() => workerStore.recoverExpired({
      now: "2026-09-28T11:02:03.000Z",
      limit: 10,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000
    }));

    const record = recovered.find((item) => item.runId === current.id);
    expect(record?.outcome).toBe("stage-advanced-before-crash");
    expect(record?.nextReadyAt).toBe("2026-09-28T11:02:03.000Z");

    const ready = await inScope(() => workerStore.listReady({
      now: "2026-09-28T11:02:03.000Z",
      limit: 100
    }));
    const candidate = ready.find((item) => item.run.id === current.id);
    expect(candidate?.run.state).toBe("context-ready");
    expect(candidate?.stageAttempt).toBe(0);
    expect(candidate?.consecutiveFailures).toBe(0);
  });

  it("discovers routing metadata across companies then re-enters exact tenant scope", async () => {
    const otherScope = {
      userId: `owner-other-${suffix}`,
      portfolioId: `portfolio-other-${suffix}`,
      companyId: `company-other-${suffix}`,
      environment: "staging" as const
    };
    const first = run("global-discovery-a");
    const second = run("global-discovery-b", otherScope);

    await inScope(() => runStore.create(
      first,
      `orchestration:start:owner-intent:${first.source.id}`
    ));
    await runWithPostgresTenantScope(otherScope, () => runStore.create(
      second,
      `orchestration:start:owner-intent:${second.source.id}`
    ));

    const candidates = await workerStore.listReady({
      now: "2026-09-28T11:00:01.000Z",
      limit: 100
    });
    const discovered = new Map(candidates.map((candidate) => [
      candidate.run.id,
      candidate.run.scope.companyId
    ]));

    expect(discovered.get(first.id)).toBe(scope.companyId);
    expect(discovered.get(second.id)).toBe(otherScope.companyId);

    const firstCandidate = candidates.find((candidate) => candidate.run.id === first.id);
    const secondCandidate = candidates.find((candidate) => candidate.run.id === second.id);
    expect(firstCandidate).toBeTruthy();
    expect(secondCandidate).toBeTruthy();
    if (!firstCandidate || !secondCandidate) throw new Error("both candidates expected");

    const firstVisible = await workerStore.withCandidateScope(firstCandidate, () =>
      runStore.get(first.id)
    );
    const crossTenantHidden = await workerStore.withCandidateScope(firstCandidate, () =>
      runStore.get(second.id)
    );
    const secondVisible = await workerStore.withCandidateScope(secondCandidate, () =>
      runStore.get(second.id)
    );

    expect(firstVisible?.id).toBe(first.id);
    expect(crossTenantHidden).toBeNull();
    expect(secondVisible?.id).toBe(second.id);
  });

  it("reconstructs one durable dead letter after a crash following failed-state CAS", async () => {
    const current = run("dead-letter-recovery");
    await inScope(() => runStore.create(
      current,
      `orchestration:start:owner-intent:${current.source.id}`
    ));

    const lease = await inScope(() => workerStore.claimAtomic({
      runId: current.id,
      workerId: "worker-dead-letter",
      now: "2026-09-28T11:04:00.000Z",
      leaseSeconds: 2,
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationClaimIdempotencyKey({
        runId: current.id,
        runVersion: current.version,
        workerId: "worker-dead-letter"
      })
    }));
    expect(lease).not.toBeNull();
    if (!lease) throw new Error("lease expected");

    const failed = transitionOrchestrationRun(current, {
      to: "failed",
      now: "2026-09-28T11:04:01.000Z",
      failure: {
        code: "TEST_TERMINAL",
        message: "crash after terminal checkpoint",
        retryable: false,
        failedAt: "2026-09-28T11:04:01.000Z"
      }
    });
    await inScope(() => runStore.compareAndSwap(failed, {
      expectedVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationTransitionIdempotencyKey(current, failed.state)
    }));

    const recovered = await workerStore.recoverExpired({
      now: "2026-09-28T11:04:03.000Z",
      limit: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000
    });
    expect(
      recovered.find((item) => item.runId === current.id)?.outcome
    ).toBe("dead-letter-recovered");

    const deadLetters = await inScope(() => db().query<{
      failure_code: string;
      recovery_kind: string;
    }>(
      `SELECT failure_code,recovery_kind
       FROM orchestration_worker_dead_letters
       WHERE run_id=$1`,
      [current.id]
    ));
    expect(deadLetters.rows).toEqual([{
      failure_code: "TEST_TERMINAL",
      recovery_kind: "expired-lease-recovery"
    }]);

    await workerStore.recoverExpired({
      now: "2026-09-28T11:04:04.000Z",
      limit: 100,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000
    });
    const replay = await inScope(() => db().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM orchestration_worker_dead_letters
       WHERE run_id=$1`,
      [current.id]
    ));
    expect(replay.rows[0]?.count).toBe(1);
  });

  it("recovers a crash before checkpoint commit by scheduling the same stage for retry", async () => {
    const current = run("crash-before-cas");
    await inScope(() => runStore.create(
      current,
      `orchestration:start:owner-intent:${current.source.id}`
    ));

    const lease = await inScope(() => workerStore.claimAtomic({
      runId: current.id,
      workerId: "worker-a",
      now: "2026-09-28T11:03:00.000Z",
      leaseSeconds: 2,
      expectedRunVersion: current.version,
      expectedRecordHash: current.recordHash,
      idempotencyKey: orchestrationClaimIdempotencyKey({
        runId: current.id,
        runVersion: current.version,
        workerId: "worker-a"
      })
    }));
    expect(lease).not.toBeNull();

    const recovered = await inScope(() => workerStore.recoverExpired({
      now: "2026-09-28T11:03:03.000Z",
      limit: 10,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000
    }));
    const record = recovered.find((item) => item.runId === current.id);
    expect(record?.outcome).toBe("retry-scheduled");
    expect(Date.parse(record?.nextReadyAt ?? "")).toBeGreaterThan(
      Date.parse("2026-09-28T11:03:03.000Z")
    );
  });
});
