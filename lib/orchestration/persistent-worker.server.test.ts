import { describe, expect, it, vi } from "vitest";
import {
  PersistentOrchestrationWorkerService,
  readPersistentOrchestrationWorkerConfig
} from "@/lib/orchestration/persistent-worker.server";
import type {
  OrchestrationStageHandler,
  OrchestrationWorkerProcessStatus,
  OrchestrationWorkerRegistry
} from "@/lib/orchestration/worker-contracts";

class MemoryRegistry implements OrchestrationWorkerRegistry {
  starts: string[] = [];
  heartbeats: Array<{ status: OrchestrationWorkerProcessStatus; ready: boolean }> = [];
  stops: Array<"stopped" | "failed"> = [];

  async start(input: { workerId: string }) {
    this.starts.push(input.workerId);
  }

  async heartbeat(input: {
    status: OrchestrationWorkerProcessStatus;
    ready: boolean;
  }) {
    this.heartbeats.push({ status: input.status, ready: input.ready });
  }

  async stop(input: { status: "stopped" | "failed" }) {
    this.stops.push(input.status);
  }
}

const handler: OrchestrationStageHandler = {
  execute: async () => ({
    kind: "defer",
    reason: "unused",
    delayMs: 1
  })
};

describe("PersistentOrchestrationWorkerService", () => {
  it("registers identity, runs cycles, reports readiness, and drains", async () => {
    const registry = new MemoryRegistry();
    let calls = 0;
    const runtime = {
      runOnce: vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? [{ runId: "run-1", outcome: "advanced" as const, state: "planned" as const }]
          : [];
      })
    };
    const service = new PersistentOrchestrationWorkerService(
      runtime,
      handler,
      registry,
      {
        workerId: "orchestrator-a",
        pollIntervalMs: 1,
        errorBackoffMs: 1
      },
      (() => {
        let tick = 0;
        return () => new Date(Date.parse("2026-09-28T17:00:00.000Z") + tick++ * 10);
      })()
    );

    await service.start();
    for (let attempt = 0; attempt < 100 && !service.isReady(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(service.isReady()).toBe(true);
    expect(service.snapshot().cycles).toBeGreaterThanOrEqual(1);
    expect(registry.starts).toEqual(["orchestrator-a"]);
    expect(registry.heartbeats.some((item) => item.status === "running")).toBe(true);

    service.requestStop();
    await service.stop();

    expect(service.snapshot().status).toBe("stopped");
    expect(registry.heartbeats.some((item) => item.status === "draining")).toBe(true);
    expect(registry.stops).toEqual(["stopped"]);
  });

  it("keeps the process alive through transient loop errors and records only a hash", async () => {
    const registry = new MemoryRegistry();
    let calls = 0;
    const runtime = {
      runOnce: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("secret provider text must not be logged as state");
        return [];
      })
    };
    const service = new PersistentOrchestrationWorkerService(
      runtime,
      handler,
      registry,
      {
        workerId: "orchestrator-b",
        pollIntervalMs: 1,
        errorBackoffMs: 1
      }
    );

    await service.start();
    for (
      let attempt = 0;
      attempt < 100 && (!service.isReady() || calls < 2);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const snapshot = service.snapshot();
    expect(snapshot.status).toBe("running");
    expect(snapshot.lastSuccessAt).toBeTruthy();
    expect(snapshot.lastErrorHash).toBeUndefined();

    service.requestStop();
    await service.stop();
    expect(registry.stops).toEqual(["stopped"]);
  });

  it("requires explicit worker identity and bounded polling configuration", () => {
    expect(readPersistentOrchestrationWorkerConfig({
      GETDONE_ORCHESTRATION_WORKER_ID: "worker-pod-1",
      GETDONE_ORCHESTRATION_POLL_INTERVAL_MS: "250",
      GETDONE_ORCHESTRATION_ERROR_BACKOFF_MS: "1500"
    })).toEqual({
      workerId: "worker-pod-1",
      pollIntervalMs: 250,
      errorBackoffMs: 1500
    });

    expect(() => readPersistentOrchestrationWorkerConfig({}))
      .toThrow(/GETDONE_ORCHESTRATION_WORKER_ID is required/);
  });
});
