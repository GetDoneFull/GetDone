import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DedicatedOrchestrationWorkerProcess,
  readDedicatedOrchestrationWorkerProcessConfig
} from "@/lib/orchestration/worker-process.server";

describe("DedicatedOrchestrationWorkerProcess", () => {
  const processes: DedicatedOrchestrationWorkerProcess[] = [];

  afterEach(async () => {
    await Promise.all(processes.map(async (process) => {
      try { await process.shutdown(); } catch {}
    }));
  });

  it("serves independent liveness/readiness and drains gracefully", async () => {
    let ready = true;
    const worker = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      requestStop: vi.fn(() => { ready = false; }),
      isReady: vi.fn(() => ready),
      snapshot: vi.fn(() => ({
        workerId: "orchestrator-1",
        status: ready ? "running" as const : "draining" as const,
        cycles: 4,
        draining: !ready,
        stopped: false,
        lastSuccessAt: "2026-09-28T17:00:00.000Z"
      }))
    };
    const closeDatabase = vi.fn(async () => {});
    const process = new DedicatedOrchestrationWorkerProcess(
      worker,
      closeDatabase,
      { healthHost: "127.0.0.1", healthPort: 0 }
    );
    processes.push(process);

    await process.start();
    const address = process.healthAddress();
    expect(address).not.toBeNull();
    if (!address) throw new Error("health address expected");

    const live = await fetch(`http://127.0.0.1:${address.port}/livez`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({
      ok: true,
      service: "getdone-orchestration-worker",
      state: "running"
    });

    const readyResponse = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(readyResponse.status).toBe(200);
    expect(await readyResponse.json()).toMatchObject({
      ok: true,
      workerId: "orchestrator-1",
      cycles: 4
    });

    process.requestDrain();
    expect(process.state()).toBe("draining");

    const draining = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(draining.status).toBe(503);

    await process.shutdown();
    expect(process.state()).toBe("stopped");
    expect(worker.requestStop).toHaveBeenCalled();
    expect(worker.stop).toHaveBeenCalled();
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("parses an isolated health surface from environment", () => {
    expect(readDedicatedOrchestrationWorkerProcessConfig({
      GETDONE_ORCHESTRATION_WORKER_HEALTH_HOST: "127.0.0.1",
      GETDONE_ORCHESTRATION_WORKER_HEALTH_PORT: "3312"
    })).toEqual({
      healthHost: "127.0.0.1",
      healthPort: 3312
    });

    expect(() => readDedicatedOrchestrationWorkerProcessConfig({
      GETDONE_ORCHESTRATION_WORKER_HEALTH_PORT: "0"
    })).toThrow(/1 through 65535/);
  });
});
