import { describe, expect, it } from "vitest";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import {
  runJobEnqueueIdempotently,
  runTaskGenerationIdempotently
} from "@/lib/orchestration/materialization-idempotency";

const now = () => new Date("2026-09-28T17:00:00Z");

describe("durable orchestration materialization idempotency", () => {
  it("replays the persisted Task-generation result instead of generating twice", async () => {
    const store = new MemoryIdempotencyStore();
    let calls = 0;
    const execute = async () => {
      calls += 1;
      return { taskIds: ["task-1", "task-2"] };
    };

    const first = await runTaskGenerationIdempotently({
      store,
      runId: "run-1",
      runVersion: 12,
      fingerprint: "fingerprint-a",
      execute,
      now
    });
    const replay = await runTaskGenerationIdempotently({
      store,
      runId: "run-1",
      runVersion: 12,
      fingerprint: "fingerprint-a",
      execute,
      now
    });

    expect(first).toMatchObject({
      status: "created",
      key: "orchestration:run-1:v12:task-generation"
    });
    expect(replay).toEqual({
      status: "idempotent-replay",
      key: "orchestration:run-1:v12:task-generation",
      result: { taskIds: ["task-1", "task-2"] }
    });
    expect(calls).toBe(1);
  });

  it("replays the persisted Job-enqueue result instead of enqueueing twice", async () => {
    const store = new MemoryIdempotencyStore();
    let calls = 0;
    const execute = async () => {
      calls += 1;
      return { jobIds: ["job-1"] };
    };

    await runJobEnqueueIdempotently({
      store,
      runId: "run-2",
      runVersion: 13,
      fingerprint: "fingerprint-b",
      execute,
      now
    });
    const replay = await runJobEnqueueIdempotently({
      store,
      runId: "run-2",
      runVersion: 13,
      fingerprint: "fingerprint-b",
      execute,
      now
    });

    expect(replay).toEqual({
      status: "idempotent-replay",
      key: "orchestration:run-2:v13:job-enqueue",
      result: { jobIds: ["job-1"] }
    });
    expect(calls).toBe(1);
  });

  it("fails closed when the same materialization identity is reused for different input", async () => {
    const store = new MemoryIdempotencyStore();
    await runTaskGenerationIdempotently({
      store,
      runId: "run-3",
      runVersion: 14,
      fingerprint: "fingerprint-c",
      execute: async () => ({ taskIds: ["task-1"] }),
      now
    });

    await expect(runTaskGenerationIdempotently({
      store,
      runId: "run-3",
      runVersion: 14,
      fingerprint: "different-fingerprint",
      execute: async () => ({ taskIds: ["task-2"] }),
      now
    })).rejects.toThrow(/Idempotency key was reused for a different request/i);
  });
});
