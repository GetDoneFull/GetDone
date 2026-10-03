import { describe, expect, it } from "vitest";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertOrchestrationRunIntegrity,
  assertProductionOrchestrationRunStoreDescriptor,
  canTransitionOrchestration,
  createOrchestrationRun,
  createOrchestrationSourceRef,
  isOrchestrationTerminal,
  isOrchestrationWorkerResumable,
  transitionOrchestrationRun,
  type OrchestrationRunRecord
} from "@/lib/orchestration/contracts";

const scope = {
  userId: "user-1",
  portfolioId: "portfolio-1",
  companyId: "company-1",
  environment: "development" as const
};

function acceptedRun() {
  const source = createOrchestrationSourceRef(
    "owner-intent",
    "intent-1",
    {
      id: "intent-1",
      message: "Work on growth",
      companyId: scope.companyId
    }
  );

  return createOrchestrationRun({
    id: "orchestration-1",
    correlationId: "correlation-1",
    source,
    scope,
    createdAt: "2026-09-27T20:00:00.000Z",
    updatedAt: "2026-09-27T20:00:00.000Z"
  });
}

function contextReady(run: OrchestrationRunRecord) {
  return transitionOrchestrationRun(run, {
    to: "context-ready",
    now: "2026-09-27T20:00:01.000Z",
    checkpointPatch: {
      contextSnapshot: { id: "context-1", hash: "context-hash" }
    }
  });
}

function throughPolicy() {
  let run = contextReady(acceptedRun());
  run = transitionOrchestrationRun(run, {
    to: "planning",
    now: "2026-09-27T20:00:02.000Z",
    checkpointPatch: {
      plannerInput: { id: "planner-input-1", hash: "planner-input-hash" }
    }
  });
  run = transitionOrchestrationRun(run, {
    to: "planned",
    now: "2026-09-27T20:00:03.000Z",
    checkpointPatch: {
      plan: { id: "plan-1", hash: "plan-hash" }
    }
  });
  run = transitionOrchestrationRun(run, {
    to: "validated",
    now: "2026-09-27T20:00:04.000Z",
    checkpointPatch: {
      validationReceipt: { id: "validation-1", hash: "validation-hash" }
    }
  });
  return transitionOrchestrationRun(run, {
    to: "policy-evaluated",
    now: "2026-09-27T20:00:05.000Z",
    checkpointPatch: {
      policySnapshot: { id: "policy-1", hash: "policy-hash" }
    }
  });
}

describe("UFO nervous-system coordinator contracts", () => {
  it("creates a hash-bound, coordination-only orchestration run", () => {
    const run = acceptedRun();

    expect(run.state).toBe("accepted");
    expect(run.authority).toBe("coordination-only");
    expect(run.version).toBe(1);
    expect(run.attempt).toBe(1);
    expect(run.source.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(run.recordHash).toMatch(/^[a-f0-9]{64}$/);
    expect(assertOrchestrationRunIntegrity(run)).toBe(run);
  });

  it("rejects tampered orchestration state", () => {
    const run = acceptedRun();
    const tampered = {
      ...run,
      scope: { ...run.scope, companyId: "company-2" }
    };

    expect(() =>
      assertOrchestrationRunIntegrity(tampered as OrchestrationRunRecord)
    ).toThrowError(ControlPlaneError);
  });

  it("prevents skipping persisted orchestration boundaries", () => {
    const run = acceptedRun();

    expect(canTransitionOrchestration("accepted", "planned")).toBe(false);
    expect(() =>
      transitionOrchestrationRun(run, {
        to: "planned",
        now: "2026-09-27T20:00:01.000Z",
        checkpointPatch: {
          contextSnapshot: { id: "context-1", hash: "context-hash" },
          plan: { id: "plan-1", hash: "plan-hash" }
        }
      })
    ).toThrowError(/Invalid orchestration transition/);
  });

  it("requires a frozen context snapshot before planning can start", () => {
    const run = acceptedRun();

    expect(() =>
      transitionOrchestrationRun(run, {
        to: "context-ready",
        now: "2026-09-27T20:00:01.000Z"
      })
    ).toThrowError(/frozen context snapshot/);
  });

  it("requires a frozen planner input before entering planning", () => {
    const run = contextReady(acceptedRun());

    expect(() =>
      transitionOrchestrationRun(run, {
        to: "planning",
        now: "2026-09-27T20:00:02.000Z"
      })
    ).toThrowError(/frozen planner input/);
  });

  it("can pause for an authoritative Decision and resume only with grant lineage", () => {
    let run = throughPolicy();

    run = transitionOrchestrationRun(run, {
      to: "awaiting-decision",
      now: "2026-09-27T20:00:06.000Z",
      checkpointPatch: {
        decisionIds: ["decision-1"]
      }
    });

    expect(run.state).toBe("awaiting-decision");
    expect(isOrchestrationWorkerResumable(run)).toBe(false);

    expect(() =>
      transitionOrchestrationRun(run, {
        to: "authorized",
        now: "2026-09-27T20:00:07.000Z"
      })
    ).toThrowError(/authorization grant lineage/);

    run = transitionOrchestrationRun(run, {
      to: "authorized",
      now: "2026-09-27T20:00:07.000Z",
      checkpointPatch: {
        authorizationGrants: [{
          id: "grant-1",
          hash: "grant-hash",
          disposition: "APPROVAL_REQUIRED"
        }]
      }
    });

    expect(run.state).toBe("authorized");
    expect(isOrchestrationWorkerResumable(run)).toBe(true);
  });

  it("supports the AUTO path without manufacturing a Decision", () => {
    let run = throughPolicy();

    run = transitionOrchestrationRun(run, {
      to: "authorized",
      now: "2026-09-27T20:00:06.000Z",
      checkpointPatch: {
        authorizationGrants: [{
          id: "grant-auto-1",
          hash: "grant-auto-hash",
          disposition: "AUTO"
        }]
      }
    });

    expect(run.state).toBe("authorized");
    expect(run.checkpoints.decisionIds).toEqual([]);
    expect(run.checkpoints.authorizationGrants[0]?.disposition).toBe("AUTO");
  });

  it("requires an immutable Task DAG checkpoint at tasks-created", () => {
    let run = throughPolicy();
    run = transitionOrchestrationRun(run, {
      to: "authorized",
      now: "2026-09-27T20:00:06.000Z",
      checkpointPatch: {
        authorizationGrants: [{
          id: "grant-auto-1",
          hash: "grant-auto-hash",
          disposition: "AUTO"
        }]
      }
    });

    expect(() =>
      transitionOrchestrationRun(run, {
        to: "tasks-created",
        now: "2026-09-27T20:00:07.000Z",
        checkpointPatch: {
          tasks: [{
            id: "task-1",
            hash: "task-hash",
            authorizationConsumptionHash: "consumption-hash"
          }]
        }
      })
    ).toThrowError(/Task DAG checkpoint/);
  });

  it("cannot claim completion without verified Outcome lineage", () => {
    let run = throughPolicy();
    run = transitionOrchestrationRun(run, {
      to: "authorized",
      now: "2026-09-27T20:00:06.000Z",
      checkpointPatch: {
        authorizationGrants: [{
          id: "grant-auto-1",
          hash: "grant-auto-hash",
          disposition: "AUTO"
        }]
      }
    });
    run = transitionOrchestrationRun(run, {
      to: "tasks-created",
      now: "2026-09-27T20:00:07.000Z",
      checkpointPatch: {
        taskDag: {
          id: "task-dag-1",
          hash: "task-dag-hash"
        },
        tasks: [{
          id: "task-1",
          hash: "task-hash",
          authorizationConsumptionHash: "consumption-hash"
        }]
      }
    });
    run = transitionOrchestrationRun(run, {
      to: "jobs-enqueued",
      now: "2026-09-27T20:00:08.000Z",
      checkpointPatch: {
        jobIds: ["job-1"]
      }
    });
    run = transitionOrchestrationRun(run, {
      to: "executing",
      now: "2026-09-27T20:00:09.000Z"
    });
    run = transitionOrchestrationRun(run, {
      to: "verifying",
      now: "2026-09-27T20:00:10.000Z",
      checkpointPatch: {
        verificationRequestIds: ["verification-1"]
      }
    });

    expect(() =>
      transitionOrchestrationRun(run, {
        to: "completed",
        now: "2026-09-27T20:00:11.000Z"
      })
    ).toThrowError(/independently verified Outcome/);

    const completed = transitionOrchestrationRun(run, {
      to: "completed",
      now: "2026-09-27T20:00:11.000Z",
      checkpointPatch: {
        verifiedOutcomes: [{
          id: "outcome-1",
          verificationReceiptId: "receipt-1",
          verificationReceiptHash: "receipt-hash"
        }]
      }
    });

    expect(completed.state).toBe("completed");
    expect(isOrchestrationTerminal(completed.state)).toBe(true);
    expect(isOrchestrationWorkerResumable(completed)).toBe(false);
  });

  it("requires evidence for blocked and failed terminal states", () => {
    const run = acceptedRun();

    expect(() =>
      transitionOrchestrationRun(run, {
        to: "blocked",
        now: "2026-09-27T20:00:01.000Z"
      })
    ).toThrowError(/requires a reason/);

    expect(() =>
      transitionOrchestrationRun(run, {
        to: "failed",
        now: "2026-09-27T20:00:01.000Z"
      })
    ).toThrowError(/requires failure evidence/);
  });

  it("fails closed for a non-durable production orchestration store", () => {
    expect(() =>
      assertProductionOrchestrationRunStoreDescriptor({
        persistence: "ephemeral-reference",
        compareAndSwap: true,
        uniqueCorrelationId: true,
        restartSafe: false,
        multiProcessSafe: false,
        productionEligible: false
      })
    ).toThrowError(/Production orchestration requires durable CAS persistence/);

    expect(
      assertProductionOrchestrationRunStoreDescriptor({
        persistence: "durable-external",
        compareAndSwap: true,
        uniqueCorrelationId: true,
        restartSafe: true,
        multiProcessSafe: true,
        productionEligible: true
      }).productionEligible
    ).toBe(true);
  });
});
