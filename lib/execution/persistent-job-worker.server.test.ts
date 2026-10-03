import { describe, expect, it } from "vitest";
import {
  PersistentJobWorkerService,
  readPersistentJobWorkerConfig
} from "@/lib/execution/persistent-job-worker.server";

class MemoryWorkerInstanceStore {
  records: Array<Record<string, unknown>> = [];
  async upsert(record: Record<string, unknown>) {
    this.records.push(record);
  }
}

describe("PersistentJobWorkerService", () => {
  it("fails closed unless running in the dedicated authenticated worker role", () => {
    expect(() => readPersistentJobWorkerConfig({
      GETDONE_PROCESS_ROLE: "web"
    })).toThrow(/dedicated job-worker/i);

    expect(() => readPersistentJobWorkerConfig({
      GETDONE_PROCESS_ROLE: "job-worker",
      GETDONE_INTERNAL_WORKER_TOKEN: "secret"
    })).toThrow(/WORKER_ID/i);

    expect(() => readPersistentJobWorkerConfig({
      GETDONE_PROCESS_ROLE: "job-worker",
      GETDONE_JOB_WORKER_ID: "worker-a"
    })).toThrow(/WORKER_TOKEN/i);
  });

  it("parses persistent worker timing and recovery configuration", () => {
    expect(readPersistentJobWorkerConfig({
      GETDONE_PROCESS_ROLE: "job-worker",
      GETDONE_JOB_WORKER_ID: "worker-a",
      GETDONE_INTERNAL_WORKER_TOKEN: "secret",
      GETDONE_JOB_POLL_INTERVAL_MS: "250",
      GETDONE_JOB_ERROR_BACKOFF_MS: "750",
      GETDONE_JOB_RECOVERY_LIMIT: "9"
    })).toEqual({
      workerId: "worker-a",
      pollIntervalMs: 250,
      errorBackoffMs: 750,
      recoveryLimit: 9
    });

    expect(() => readPersistentJobWorkerConfig({
      GETDONE_PROCESS_ROLE: "job-worker",
      GETDONE_JOB_WORKER_ID: "worker-a",
      GETDONE_INTERNAL_WORKER_TOKEN: "secret",
      GETDONE_JOB_POLL_INTERVAL_MS: "0"
    })).toThrow(/positive integer/i);
  });

  it("runs recovery before polling and persists worker liveness", async () => {
    const order: string[] = [];
    const runtime = {
      recoverExpired: async (limit?: number) => {
        order.push(`recover:${limit}`);
        return [{ id: "recovery-1" }];
      },
      runOnce: async () => {
        order.push("run");
        return [{ jobId: "job-1", outcome: { kind: "provider-completed" } }];
      }
    };
    const instances = new MemoryWorkerInstanceStore();
    let tick = 0;
    const service = new PersistentJobWorkerService(
      runtime as never,
      instances as never,
      {
        workerId: "worker-a",
        pollIntervalMs: 10,
        errorBackoffMs: 20,
        recoveryLimit: 7
      },
      () => new Date(Date.UTC(2026, 8, 22, 7, 0, tick++))
    );

    const cycle = await service.runCycle();
    expect(order).toEqual(["recover:7", "run"]);
    expect(cycle.recovered).toHaveLength(1);
    expect(cycle.results).toHaveLength(1);
    expect(service.snapshot()).toMatchObject({
      workerId: "worker-a",
      status: "running",
      cycles: 1,
      stopped: false
    });
    expect(instances.records.at(-1)).toMatchObject({
      workerId: "worker-a",
      processRole: "job-worker",
      status: "running"
    });
  });

  it("backs off after transient runtime failure and can stop cleanly", async () => {
    let calls = 0;
    let secondCycle!: () => void;
    const secondCycleReached = new Promise<void>((resolve) => { secondCycle = resolve; });
    const runtime = {
      recoverExpired: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary database outage");
        secondCycle();
        return [];
      },
      runOnce: async () => []
    };
    const instances = new MemoryWorkerInstanceStore();
    const sleeps: number[] = [];

    const service = new PersistentJobWorkerService(
      runtime as never,
      instances as never,
      {
        workerId: "worker-b",
        pollIntervalMs: 5,
        errorBackoffMs: 11,
        recoveryLimit: 2
      },
      () => new Date("2026-09-22T07:00:00.000Z"),
      async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    );

    await service.start();
    await secondCycleReached;
    service.requestStop();
    await service.stop();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(sleeps).toContain(11);
    expect(service.snapshot()).toMatchObject({
      draining: false,
      stopped: true,
      status: "stopped"
    });
    expect(instances.records.some((record) => record.status === "degraded")).toBe(true);
    expect(instances.records.at(-1)?.status).toBe("stopped");
  });

  it("waits for the active cycle to settle after drain is requested", async () => {
    let releaseActive!: () => void;
    let activeStarted!: () => void;
    const active = new Promise<void>((resolve) => { releaseActive = resolve; });
    const started = new Promise<void>((resolve) => { activeStarted = resolve; });
    let observedStop = false;

    const service = new PersistentJobWorkerService(
      {
        recoverExpired: async () => [],
        runOnce: async (options: { shouldStop?: () => boolean }) => {
          activeStarted();
          await active;
          observedStop = options.shouldStop?.() === true;
          return [];
        }
      } as never,
      new MemoryWorkerInstanceStore() as never,
      {
        workerId: "worker-drain",
        pollIntervalMs: 100,
        errorBackoffMs: 100,
        recoveryLimit: 2
      }
    );

    await service.start();
    await started;
    service.requestStop();
    const stopping = service.stop();

    expect(service.snapshot().draining).toBe(true);
    let settled = false;
    void stopping.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseActive();
    await stopping;
    expect(observedStop).toBe(true);
    expect(service.snapshot().stopped).toBe(true);
  });
});
