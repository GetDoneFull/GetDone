import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import type { EntityStore } from "@/lib/domain/services/common";
import {
  TaskService,
  type TaskRecord,
  type TaskStore,
  type TaskStores
} from "@/lib/domain/services/task-service";
import {
  JobService,
  type JobRecord,
  type JobStore,
  type JobStores
} from "@/lib/domain/services/job-service";
import {
  assertAuthorizationConsumption,
  createAuthorizationConsumptionRecord,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import { autoGrantFor, fixtureNow } from "@/lib/planning/test-security-fixture";
import { validPlan } from "@/lib/planning/test-fixture";

class MemoryAudit implements AuditLedger {
  readonly events: AuditEvent[] = [];
  async append(event: AuditEvent) { this.events.push(event); }
  async listByCorrelationId(correlationId: string) {
    return this.events.filter((event) => event.correlationId === correlationId);
  }
}

class MapStore<T extends { id: string; portfolioId: string; companyId: string; version: number; updatedAt: string }>
  implements EntityStore<T> {
  readonly values = new Map<string, T>();

  constructor(seed: readonly T[] = []) {
    for (const item of seed) this.values.set(item.id, { ...item });
  }

  async get(id: string) {
    const value = this.values.get(id);
    return value ? { ...value } : null;
  }

  async create(record: T) {
    if (this.values.has(record.id)) throw new Error("duplicate entity");
    this.values.set(record.id, { ...record });
  }

  async save(next: T, expectedVersion: number) {
    const current = this.values.get(next.id);
    if (!current || current.version !== expectedVersion) {
      throw new Error("optimistic concurrency conflict");
    }
    this.values.set(next.id, { ...next });
  }
}

class GrantStore implements AuthorizationGrantStore {
  readonly consumptions: AuthorizationConsumptionRecord[] = [];

  constructor(public grant: AuthorizationGrant) {}

  async get(id: string) {
    return id === this.grant.id ? this.grant : null;
  }

  async consume(record: AuthorizationConsumptionRecord) {
    assertAuthorizationConsumption(record, this.grant);
    const prior = this.consumptions.find((item) => item.grantId === record.grantId);
    if (prior && prior.consumptionHash !== record.consumptionHash) {
      throw new Error("conflicting consumption");
    }
    if (!prior) this.consumptions.push(record);
  }

  async listConsumptions(grantId: string) {
    return this.consumptions.filter((item) => item.grantId === grantId);
  }

  async revoke() {}
}

function manager<TStores>(stores: TStores, audit = new MemoryAudit()): ControlPlaneTransactionManager<TStores> {
  const idempotency = new MemoryIdempotencyStore();
  return {
    run: async (operation) => operation({ stores, audit, idempotency })
  };
}

let commandNumber = 0;
function command(
  type: string,
  scope: AuthorizationGrant["scope"] = {
    userId: "owner-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging"
  }
) {
  commandNumber += 1;
  return createCommandEnvelope({
    commandId: `task-job-command-${commandNumber}`,
    actor: { type: "system", id: "control-plane" },
    scope,
    correlationId: `task-job-correlation-${commandNumber}`,
    environment: "staging",
    idempotencyKey: `task-job-idempotency-${commandNumber}`,
    provenance: "task-job-lifecycle-test",
    requestedMutation: { type }
  });
}

function authorizedConsumption(grant: AuthorizationGrant, taskId: string) {
  return createAuthorizationConsumptionRecord({
    id: `authorization-consumption:${grant.id}`,
    grant,
    consumerType: "task",
    consumerId: taskId,
    consumedAt: fixtureNow.toISOString()
  });
}

describe("Task and Job authoritative lifecycle hardening", () => {
  it("creates Tasks idempotently and records creation audit authority", async () => {
    const store = new MapStore<TaskRecord>() as MapStore<TaskRecord> & TaskStore;
    const audit = new MemoryAudit();
    const service = new TaskService(manager<TaskStores>({ tasks: store }, audit), () => fixtureNow);
    const createCommand = command("task.create");

    const first = await service.create({
      id: "task-created-1",
      reason: "Run governed work",
      capabilityRequirements: ["compute.cpu.light"],
      dependencyTaskIds: [],
      maxRetries: 2,
      createdAt: fixtureNow.toISOString()
    }, createCommand);
    const replay = await service.create({
      id: "task-created-1",
      reason: "Run governed work",
      capabilityRequirements: ["compute.cpu.light"],
      dependencyTaskIds: [],
      maxRetries: 2,
      createdAt: fixtureNow.toISOString()
    }, createCommand);

    expect(replay).toEqual(first);
    expect(store.values.size).toBe(1);
    expect(audit.events.map((event) => event.eventType)).toEqual(["task.proposed"]);
  });

  it("blocks Task queueing until all declared dependencies have authoritatively succeeded", async () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const consumption = authorizedConsumption(grant, "task-child");
    const dependency: TaskRecord = {
      id: "task-parent",
      portfolioId: grant.scope.portfolioId,
      companyId: grant.scope.companyId,
      state: "running",
      reason: "parent",
      evidenceIds: [],
      capabilityRequirements: [...grant.capabilityNames],
      authorizationLineage: [grant.id],
      authorizationGrantId: grant.id,
      authorizationGrantHash: grant.grantHash,
      authorizationConsumption: consumption,
      verificationEvidenceIds: [],
      version: 2,
      updatedAt: fixtureNow.toISOString()
    };
    const child: TaskRecord = {
      ...dependency,
      id: "task-child",
      state: "authorized",
      reason: "child",
      dependencyTaskIds: ["task-parent"],
      version: 1
    };
    const store = new MapStore<TaskRecord>([dependency, child]) as MapStore<TaskRecord> & TaskStore;
    const service = new TaskService(
      manager<TaskStores>({
        tasks: store,
        authorizationGrants: new GrantStore(grant)
      }),
      () => fixtureNow
    );

    await expect(service.queue(child.id, command("task.queue.blocked")))
      .rejects.toThrow(/dependency is not authoritatively succeeded/i);

    store.values.set(dependency.id, { ...dependency, state: "succeeded" });
    expect((await service.queue(child.id, command("task.queue.ready"))).state).toBe("queued");
  });

  it("prevents a queued Task from starting after its authorization is revoked", async () => {
    const grant = autoGrantFor(validPlan());
    const consumption = authorizedConsumption(grant, "task-revoked");
    const task: TaskRecord = {
      id: "task-revoked",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "queued",
      reason: "must not execute after revocation",
      evidenceIds: [],
      capabilityRequirements: [...grant.capabilityNames],
      authorizationLineage: [grant.id],
      authorizationGrantId: grant.id,
      authorizationGrantHash: grant.grantHash,
      authorizationConsumption: consumption,
      verificationEvidenceIds: [],
      version: 2,
      updatedAt: fixtureNow.toISOString()
    };
    const { grantHash: _grantHash, ...grantBase } = grant;
    const revokedBase = { ...grantBase, status: "revoked" as const };
    const revoked: AuthorizationGrant = {
      ...revokedBase,
      grantHash: sha256Hex(revokedBase)
    };
    const store = new MapStore<TaskRecord>([task]) as MapStore<TaskRecord> & TaskStore;
    const service = new TaskService(
      manager<TaskStores>({
        tasks: store,
        authorizationGrants: new GrantStore(revoked)
      }),
      () => fixtureNow
    );

    await expect(service.start(task.id, command("task.start.revoked")))
      .rejects.toThrow(/authorization is missing|differs|not active/i);
  });

  it("bounds Task retry and recovers a timed-out running Task without losing authority", async () => {
    const grant = autoGrantFor(validPlan());
    const consumption = authorizedConsumption(grant, "task-retry");
    const store = new MapStore<TaskRecord>([{
      id: "task-retry",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "running",
      reason: "retry me",
      evidenceIds: [],
      capabilityRequirements: [...grant.capabilityNames],
      authorizationLineage: [grant.id],
      authorizationGrantId: grant.id,
      authorizationGrantHash: grant.grantHash,
      authorizationConsumption: consumption,
      verificationEvidenceIds: [],
      retryCount: 0,
      maxRetries: 1,
      version: 3,
      updatedAt: fixtureNow.toISOString()
    }]) as MapStore<TaskRecord> & TaskStore;
    const service = new TaskService(
      manager<TaskStores>({
        tasks: store,
        authorizationGrants: new GrantStore(grant)
      }),
      () => fixtureNow
    );

    const recovered = await service.recoverTimeout(
      "task-retry",
      command("task.timeout"),
      "2026-09-20T18:30:01Z"
    );
    expect(recovered).toMatchObject({
      state: "queued",
      retryCount: 1,
      lastTimeoutAt: "2026-09-20T18:30:01Z"
    });

    store.values.set("task-retry", {
      ...recovered,
      state: "failed",
      failureReason: "still failing"
    });
    await expect(
      service.retry("task-retry", command("task.retry.exhausted"), "again")
    ).rejects.toThrow(/retry limit is exhausted/i);
  });

  it("creates Jobs idempotently and enforces dependency completion before queue admission", async () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const grants = new GrantStore(grant);
    const consumption = authorizedConsumption(grant, "task-job-parent");
    await grants.consume(consumption);

    const dependency: JobRecord = {
      id: "job-dependency",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "running",
      taskId: "task-dependency",
      attempt: 1,
      maxAttempts: 3,
      verificationEvidenceIds: [],
      version: 2,
      updatedAt: fixtureNow.toISOString()
    };
    const store = new MapStore<JobRecord>([dependency]) as MapStore<JobRecord> & JobStore;
    const audit = new MemoryAudit();
    const service = new JobService(manager<JobStores>({
      jobs: store,
      authorizationGrants: grants
    }, audit), () => fixtureNow);

    const createCommand = command("job.create", grant.scope);
    const created = await service.create({
      id: "job-created",
      taskId: "task-job-parent",
      dependencyJobIds: ["job-dependency"],
      maxAttempts: 3,
      createdAt: fixtureNow.toISOString()
    }, createCommand);
    expect(await service.create({
      id: "job-created",
      taskId: "task-job-parent",
      dependencyJobIds: ["job-dependency"],
      maxAttempts: 3,
      createdAt: fixtureNow.toISOString()
    }, createCommand)).toEqual(created);

    await expect(service.queue(
      created.id,
      command("job.queue.blocked", grant.scope),
      grant,
      consumption,
      fixtureNow.toISOString()
    )).rejects.toThrow(/dependency is not authoritatively succeeded/i);

    store.values.set(dependency.id, { ...dependency, state: "succeeded" });
    expect((await service.queue(
      created.id,
      command("job.queue.ready", grant.scope),
      grant,
      consumption,
      fixtureNow.toISOString()
    )).state).toBe("queued");
    expect(audit.events.some((event) => event.eventType === "job.created")).toBe(true);
  });

  it("prevents duplicate Job execution claims and bounds retry attempts", async () => {
    const grant = autoGrantFor(validPlan());
    const consumption = authorizedConsumption(grant, "task-claim");
    const base: JobRecord = {
      id: "job-claim",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "queued",
      taskId: "task-claim",
      workerId: "worker-existing",
      attempt: 1,
      maxAttempts: 2,
      authorizationGrantId: grant.id,
      authorizationGrantHash: grant.grantHash,
      authorizationConsumption: consumption,
      verificationEvidenceIds: [],
      version: 2,
      updatedAt: fixtureNow.toISOString()
    };
    const store = new MapStore<JobRecord>([base]) as MapStore<JobRecord> & JobStore;
    const service = new JobService(manager<JobStores>({ jobs: store }), () => fixtureNow);

    await expect(service.claim(base.id, command("job.claim.duplicate"), "worker-new"))
      .rejects.toThrow(/active authoritative worker claim/i);

    store.values.set(base.id, {
      ...base,
      state: "failed",
      workerId: undefined,
      attempt: 2,
      failureReason: "terminal attempt"
    });
    await expect(service.retry(base.id, command("job.retry.exhausted"), "again"))
      .rejects.toThrow(/attempt limit is exhausted/i);
  });

  it("recovers timed-out Job execution into the queue and clears stale execution lineage", async () => {
    const grant = autoGrantFor(validPlan());
    const consumption = authorizedConsumption(grant, "task-timeout");
    const job: JobRecord = {
      id: "job-timeout",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "running",
      taskId: "task-timeout",
      workerId: "worker-a",
      attempt: 1,
      maxAttempts: 3,
      authorizationGrantId: grant.id,
      authorizationGrantHash: grant.grantHash,
      authorizationConsumption: consumption,
      verificationEvidenceIds: [],
      verifiedStartFactId: "start-fact",
      verifiedStartFactHash: "start-hash",
      verifiedRunningPlacementId: "placement",
      verifiedRunningPlacementHash: "placement-hash",
      version: 4,
      updatedAt: fixtureNow.toISOString()
    };
    const store = new MapStore<JobRecord>([job]) as MapStore<JobRecord> & JobStore;
    const service = new JobService(manager<JobStores>({ jobs: store }), () => fixtureNow);

    const recovered = await service.recoverTimeout(
      job.id,
      command("job.timeout.recover"),
      "2026-09-20T18:30:05Z"
    );
    expect(recovered).toMatchObject({
      state: "queued",
      workerId: undefined,
      retryReason: "execution-timeout",
      lastTimeoutAt: "2026-09-20T18:30:05Z"
    });
    expect(recovered.verifiedStartFactId).toBeUndefined();
    expect(recovered.verifiedRunningPlacementId).toBeUndefined();
    expect(recovered.authorizationConsumption?.consumptionHash)
      .toBe(consumption.consumptionHash);
  });
});
