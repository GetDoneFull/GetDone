import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  advancePolicyEvaluatedToAuthority,
  advanceAwaitingDecisionToAuthorized
} from "@/lib/orchestration/authorization-flow";
import {
  advanceOwnerIntentAcceptedToContextReady
} from "@/lib/orchestration/owner-intent-flow";
import {
  advanceObjectiveAcceptedToContextReady
} from "@/lib/orchestration/objective-flow";
import {
  advanceContextReadyToPlanning,
  advancePlanningToPlanned
} from "@/lib/orchestration/planning-flow";
import {
  advancePlannedToValidated,
  advanceValidatedToPolicyEvaluated
} from "@/lib/orchestration/validation-policy-flow";
import {
  advanceAuthorizedToTasksCreated,
  advanceTasksCreatedToJobsEnqueued,
  advanceJobsEnqueuedToExecuting,
  advanceExecutingToVerifying,
  advanceVerifyingToCompleted
} from "@/lib/orchestration/post-authorization-flow";
import type {
  OrchestrationStageContext,
  OrchestrationStageHandler,
  OrchestrationStageOutcome
} from "@/lib/orchestration/worker-contracts";

export const AUTHORITATIVE_EXECUTION_COORDINATOR_VERSION = "1.0.0";

type WithoutRun<T> = Omit<T, "run">;

export interface AuthoritativeExecutionCoordinatorDependencies {
  ownerIntentContext: WithoutRun<
    Parameters<typeof advanceOwnerIntentAcceptedToContextReady>[0]
  >;
  objectiveContext: WithoutRun<
    Parameters<typeof advanceObjectiveAcceptedToContextReady>[0]
  >;
  contextPlanning: WithoutRun<
    Parameters<typeof advanceContextReadyToPlanning>[0]
  >;
  planner: WithoutRun<
    Parameters<typeof advancePlanningToPlanned>[0]
  >;
  validation: WithoutRun<
    Parameters<typeof advancePlannedToValidated>[0]
  >;
  policy: WithoutRun<
    Parameters<typeof advanceValidatedToPolicyEvaluated>[0]
  >;
  authorization: WithoutRun<
    Parameters<typeof advancePolicyEvaluatedToAuthority>[0]
  >;
  decisionResume: WithoutRun<
    Parameters<typeof advanceAwaitingDecisionToAuthorized>[0]
  >;
  taskDag: WithoutRun<
    Parameters<typeof advanceAuthorizedToTasksCreated>[0]
  >;
  jobs: WithoutRun<
    Parameters<typeof advanceTasksCreatedToJobsEnqueued>[0]
  >;
  execution: WithoutRun<
    Parameters<typeof advanceExecutingToVerifying>[0]
  >;
  completion: WithoutRun<
    Parameters<typeof advanceVerifyingToCompleted>[0]
  >;
}

export class AuthoritativeExecutionCoordinator
  implements OrchestrationStageHandler {
  readonly descriptor = Object.freeze({
    path: "owner-intent/objective->verified-outcome" as const,
    providerAccess: false as const,
    authorityCreation: false as const,
    uiAuthority: false as const,
    authoritativePersistence: "postgresql" as const
  });

  constructor(
    private readonly deps: AuthoritativeExecutionCoordinatorDependencies
  ) {}

  execute(
    context: OrchestrationStageContext
  ): Promise<OrchestrationStageOutcome> {
    const run = context.run;

    switch (run.state) {
      case "accepted":
        if (run.source.type === "owner-intent") {
          return advanceOwnerIntentAcceptedToContextReady({
            run,
            ...this.deps.ownerIntentContext
          });
        }
        if (run.source.type === "objective") {
          return advanceObjectiveAcceptedToContextReady({
            run,
            ...this.deps.objectiveContext
          });
        }
        return Promise.resolve({
          kind: "failed",
          code: "SOURCE_CONTEXT_NOT_MATERIALIZED",
          reason:
            "Signals and Investigations require an authoritative source-specific Context Snapshot adapter before they can enter the execution chain"
        });

      case "context-ready":
        return advanceContextReadyToPlanning({
          run,
          ...this.deps.contextPlanning
        });

      case "planning":
        return advancePlanningToPlanned({
          run,
          ...this.deps.planner
        });

      case "planned":
        return advancePlannedToValidated({
          run,
          ...this.deps.validation
        });

      case "validated":
        return advanceValidatedToPolicyEvaluated({
          run,
          ...this.deps.policy
        });

      case "policy-evaluated":
        return advancePolicyEvaluatedToAuthority({
          run,
          ...this.deps.authorization
        });

      case "awaiting-decision":
        return advanceAwaitingDecisionToAuthorized({
          run,
          ...this.deps.decisionResume
        });

      case "authorized":
        return advanceAuthorizedToTasksCreated({
          run,
          ...this.deps.taskDag
        });

      case "tasks-created":
        return advanceTasksCreatedToJobsEnqueued({
          run,
          ...this.deps.jobs
        });

      case "jobs-enqueued":
        return Promise.resolve(advanceJobsEnqueuedToExecuting({ run }));

      case "executing":
        return advanceExecutingToVerifying({
          run,
          ...this.deps.execution
        });

      case "verifying":
        return advanceVerifyingToCompleted({
          run,
          ...this.deps.completion
        });

      case "blocked":
      case "failed":
      case "cancelled":
      case "completed":
        break;
    }

    throw new ControlPlaneError(
      "CONFLICT",
      `Orchestration state ${run.state} is not executable by the authoritative coordinator`,
      { correlationId: run.correlationId }
    );
  }
}
