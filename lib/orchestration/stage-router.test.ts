import { describe, expect, it, vi } from "vitest";
import {
  createCompleteOrchestrationStageRouter,
  ORCHESTRATION_WORKER_RESUMABLE_STATES,
  type CompleteOrchestrationStageHandlers
} from "@/lib/orchestration/stage-router";
import type { OrchestrationStageHandler } from "@/lib/orchestration/worker-contracts";
import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";

describe("CompleteOrchestrationStageRouter", () => {
  it("dispatches by exact resumable state", async () => {
    const calls: string[] = [];
    const handlers = Object.fromEntries(
      ORCHESTRATION_WORKER_RESUMABLE_STATES.map((state) => [
        state,
        {
          execute: vi.fn(async () => {
            calls.push(state);
            return {
              kind: "defer" as const,
              reason: `handled ${state}`,
              delayMs: 1000
            };
          })
        } satisfies OrchestrationStageHandler
      ])
    ) as CompleteOrchestrationStageHandlers;

    const router = createCompleteOrchestrationStageRouter(handlers);
    const run = {
      state: "authorized"
    } as OrchestrationRunRecord;

    const outcome = await router.execute({
      run,
      lease: {} as never,
      heartbeat: async () => {}
    });

    expect(outcome).toEqual({
      kind: "defer",
      reason: "handled authorized",
      delayMs: 1000
    });
    expect(calls).toEqual(["authorized"]);
  });

  it("refuses terminal or Decision-wait states", async () => {
    const handler: OrchestrationStageHandler = {
      execute: async () => ({
        kind: "defer",
        reason: "unused",
        delayMs: 1000
      })
    };
    const handlers = Object.fromEntries(
      ORCHESTRATION_WORKER_RESUMABLE_STATES.map((state) => [state, handler])
    ) as CompleteOrchestrationStageHandlers;
    const router = createCompleteOrchestrationStageRouter(handlers);

    await expect(router.execute({
      run: { state: "awaiting-decision" } as OrchestrationRunRecord,
      lease: {} as never,
      heartbeat: async () => {}
    })).rejects.toThrow(/may not execute state awaiting-decision/);

    await expect(router.execute({
      run: { state: "completed" } as OrchestrationRunRecord,
      lease: {} as never,
      heartbeat: async () => {}
    })).rejects.toThrow(/may not execute state completed/);
  });
});
