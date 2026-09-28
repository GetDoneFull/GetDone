import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OrchestrationState } from "@/lib/orchestration/contracts";
import type {
  OrchestrationStageContext,
  OrchestrationStageHandler,
  OrchestrationStageOutcome
} from "@/lib/orchestration/worker-contracts";

export const ORCHESTRATION_WORKER_RESUMABLE_STATES = Object.freeze([
  "accepted",
  "context-ready",
  "planning",
  "planned",
  "validated",
  "policy-evaluated",
  "authorized",
  "tasks-created",
  "jobs-enqueued",
  "executing",
  "verifying"
] as const satisfies readonly OrchestrationState[]);

export type OrchestrationWorkerResumableState =
  (typeof ORCHESTRATION_WORKER_RESUMABLE_STATES)[number];

export type CompleteOrchestrationStageHandlers = Readonly<
  Record<OrchestrationWorkerResumableState, OrchestrationStageHandler>
>;

export class CompleteOrchestrationStageRouter implements OrchestrationStageHandler {
  constructor(private readonly handlers: CompleteOrchestrationStageHandlers) {
    for (const state of ORCHESTRATION_WORKER_RESUMABLE_STATES) {
      if (!handlers[state] || typeof handlers[state].execute !== "function") {
        throw new ControlPlaneError(
          "UNAVAILABLE",
          `Orchestration stage handler is missing for ${state}`
        );
      }
    }
  }

  async execute(
    context: OrchestrationStageContext
  ): Promise<OrchestrationStageOutcome> {
    const state = context.run.state;
    if (
      state === "awaiting-decision"
      || state === "completed"
      || state === "blocked"
      || state === "failed"
      || state === "cancelled"
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `Generic orchestration worker may not execute state ${state}`
      );
    }

    const handler = this.handlers[state];
    if (!handler) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `No orchestration stage handler is installed for ${state}`
      );
    }
    return handler.execute(context);
  }
}

export function createCompleteOrchestrationStageRouter(
  handlers: CompleteOrchestrationStageHandlers
) {
  return new CompleteOrchestrationStageRouter(handlers);
}
