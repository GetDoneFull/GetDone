import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import { resolveDecision } from "@/lib/domain/decision-service";
import {
  advancePolicyEvaluatedToAuthority,
  DecisionResumeDispatcher
} from "@/lib/orchestration/authorization-flow";
import {
  advanceOwnerIntentAcceptedToContextReady
} from "@/lib/orchestration/owner-intent-flow";
import {
  advanceContextReadyToPlanning,
  advancePlanningToPlanned,
  type DurablePlanner
} from "@/lib/orchestration/planning-flow";
import {
  advancePlannedToValidated,
  advanceValidatedToPolicyEvaluated
} from "@/lib/orchestration/validation-policy-flow";
import {
  PostgresEntityStore
} from "@/lib/persistence/postgres/authority-stores";
import { PostgresOwnerIntentStore } from "@/lib/persistence/postgres/control-api-stores";
import {
  PostgresDecisionResumeRequestStore,
  PostgresOrchestrationAuthorizationGrantStore,
  PostgresOrchestrationDecisionStore
} from "@/lib/persistence/postgres/orchestration-authorization-stores";
import { PostgresOrchestrationContextSnapshotStore } from "@/lib/persistence/postgres/orchestration-context-snapshot-store";
import {
  PostgresOrchestrationPlanProposalStore,
  PostgresPlannerInputStore
} from "@/lib/persistence/postgres/orchestration-planning-stores";
import { PostgresOrchestrationRunStore } from "@/lib/persistence/postgres/orchestration-store";
import {
  PostgresOrchestrationPolicyEvaluationStore,
  PostgresOrchestrationPolicyStepSnapshotStore,
  PostgresOrchestrationValidationArtifactStore
} from "@/lib/persistence/postgres/orchestration-validation-policy-stores";
import {
  PostgresDatabase,
  readPostgresConfigFromEnv
} from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import { validPlan } from "@/lib/planning/test-fixture";
import { validationPolicyFor } from "@/lib/planning/test-security-fixture";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;

function approvalPlan(intentId: string): PlanProposal {
  const base = validPlan();
  return {
    ...base,
    id: `plan-${intentId}`,
    scope: {
      ...base.scope,
      dataClass: "customer"
    },
    source: {
      type: "owner-request",
      requestId: intentId
    },
    objective: undefined,
    requestedCapabilities: ["email.send"],
    risk: {
      level: "medium",
      summary: "Outbound customer email",
      blastRadius: "single-object"
    },
    steps: [{
      ...base.steps[0],
      title: "Send customer update",
      capabilityRequests: [{
        capability: "email.send",
        input: {
          companyId: "company-a",
          to: ["customer@example.com"],
          cc: [],
          subject: "Update",
          text: "Hello"
        }
      }],
      risk: {
        level: "medium",
        summary: "Outbound customer email",
        blastRadius: "single-object"
      },
      resourceRequirements: {
        ...base.steps[0].resourceRequirements,
        data: {
          ...base.steps[0].resourceRequirements.data,
          classification: "customer",
          customerData: true
        }
      }
    }],
    createdAt: "2026-09-28T14:00:04.000Z"
  };
}

integrationDescribe("PostgreSQL durable policy-evaluated -> authorized", () => {
  let database: PostgresDatabase | undefined;
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `authorization-user-${suffix}`;
  const portfolioId = `authorization-portfolio-${suffix}`;
  const companyId = "company-a";

  function db() {
    if (!database) throw new Error("authorization integration database is not initialized");
    return database;
  }

  function scope(company = companyId) {
    return {
      userId,
      portfolioId,
      companyId: company,
      environment: "staging" as const
    };
  }

  function inScope<T>(operation: () => T, company = companyId) {
    return runWithPostgresTenantScope(scope(company), operation);
  }

  function intent(name: string): OwnerIntentRecord {
    return {
      id: `intent-authorization-${name}-${suffix}`,
      correlationId: `correlation-authorization-${name}-${suffix}`,
      portfolioId,
      companyId,
      environment: "staging",
      userId,
      message: "Send the governed customer update",
      channel: "chat",
      status: "accepted",
      receivedAt: "2026-09-28T14:00:00.000Z"
    };
  }

  function plannerFor(record: OwnerIntentRecord): DurablePlanner {
    return {
      descriptor: {
        snapshotOnlyInput: true,
        deterministicRequestIdentity: true,
        structuredPlanOutput: true
      },
      async propose(request) {
        const plan = approvalPlan(record.id);
        return {
          kind: "success",
          requestId: request.requestId,
          candidate: {
            ...plan,
            scope: {
              ...plan.scope,
              portfolioId,
              companyId
            }
          }
        };
      }
    };
  }

  async function advanceToPolicyEvaluated(record: OwnerIntentRecord) {
    const ownerIntents = new PostgresOwnerIntentStore(db());
    const runStore = new PostgresOrchestrationRunStore(db());
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const plannerInputs = new PostgresPlannerInputStore(db());
    const plans = new PostgresOrchestrationPlanProposalStore(db());
    const validations = new PostgresOrchestrationValidationArtifactStore(db());
    const policyStepSnapshots =
      new PostgresOrchestrationPolicyStepSnapshotStore(db());
    const policies = new PostgresOrchestrationPolicyEvaluationStore(db());

    await inScope(() =>
      ownerIntents.create(record, `client-${record.id}`)
    );
    const accepted = await inScope(() =>
      runStore.getByCorrelationId(record.correlationId!)
    );
    if (!accepted) throw new Error("accepted run expected");

    const contextOutcome = await inScope(() =>
      advanceOwnerIntentAcceptedToContextReady({
        run: accepted,
        ownerIntents,
        candidates: {
          listForIntent: async () => []
        },
        policy: {
          resolve: async () => ({
            scope: {
              portfolioId,
              companyId,
              allowedSensitivity: ["public", "internal", "customer"]
            },
            options: {
              now: Date.parse("2026-09-28T14:00:01.000Z")
            }
          })
        },
        snapshots,
        now: () => new Date("2026-09-28T14:00:01.000Z")
      })
    );
    if (contextOutcome.kind !== "advance") throw new Error("context advance expected");
    const contextReady = await inScope(() =>
      runStore.compareAndSwap(contextOutcome.next, {
        expectedVersion: accepted.version,
        expectedRecordHash: accepted.recordHash,
        idempotencyKey:
          `orchestration:${accepted.id}:v${accepted.version}:accepted->context-ready`
      })
    );

    const planningOutcome = await inScope(() =>
      advanceContextReadyToPlanning({
        run: contextReady,
        snapshots,
        plannerInputs,
        now: () => new Date("2026-09-28T14:00:02.000Z")
      })
    );
    if (planningOutcome.kind !== "advance") throw new Error("planning advance expected");
    const planning = await inScope(() =>
      runStore.compareAndSwap(planningOutcome.next, {
        expectedVersion: contextReady.version,
        expectedRecordHash: contextReady.recordHash,
        idempotencyKey:
          `orchestration:${contextReady.id}:v${contextReady.version}:context-ready->planning`
      })
    );

    const plannedOutcome = await inScope(() =>
      advancePlanningToPlanned({
        run: planning,
        plannerInputs,
        plans,
        planner: plannerFor(record),
        now: () => new Date("2026-09-28T14:00:04.000Z")
      })
    );
    if (plannedOutcome.kind !== "advance") throw new Error("planned advance expected");
    const planned = await inScope(() =>
      runStore.compareAndSwap(plannedOutcome.next, {
        expectedVersion: planning.version,
        expectedRecordHash: planning.recordHash,
        idempotencyKey:
          `orchestration:${planning.id}:v${planning.version}:planning->planned`
      })
    );
    const planArtifact = await inScope(() =>
      plans.get(planned.checkpoints.plan!.id)
    );
    if (!planArtifact) throw new Error("plan artifact expected");

    const validationOutcome = await inScope(() =>
      advancePlannedToValidated({
        run: planned,
        plans,
        validations,
        resolver: {
          resolve: async () => ({
            validationPolicy: validationPolicyFor(planArtifact.proposal),
            snapshot: {
              configurationVersion: "authorization-integration-v1",
              evidenceRequirements: {
                health: "not-applicable",
                capacity: "not-applicable",
                credentials: "not-applicable"
              },
              expiresAt: "2026-09-28T14:20:00.000Z"
            },
            receiptExpiresAt: "2026-09-28T14:15:00.000Z"
          })
        },
        now: () => new Date("2026-09-28T14:00:06.000Z")
      })
    );
    if (validationOutcome.kind !== "advance" || validationOutcome.next.state !== "validated") {
      throw new Error("validated run expected");
    }
    const validated = await inScope(() =>
      runStore.compareAndSwap(validationOutcome.next, {
        expectedVersion: planned.version,
        expectedRecordHash: planned.recordHash,
        idempotencyKey:
          `orchestration:${planned.id}:v${planned.version}:planned->validated`
      })
    );

    const policyOutcome = await inScope(() =>
      advanceValidatedToPolicyEvaluated({
        run: validated,
        plans,
        validations,
        policyStepSnapshots,
        policies,
        resolver: {
          resolveStep: async () => ({
            region: "us-west",
            allowedEnvironments: [planArtifact.proposal.scope.environment],
            allowedDataClasses: [planArtifact.proposal.scope.dataClass],
            allowedRegions: ["us-west"],
            killSwitches: [],
            credentialRequirementIds: [],
            fallbackRequired: false,
            fallbackAvailable: true
          })
        },
        now: () => new Date("2026-09-28T14:00:07.000Z")
      })
    );
    if (policyOutcome.kind !== "advance" || policyOutcome.next.state !== "policy-evaluated") {
      throw new Error("policy-evaluated run expected");
    }
    const policyEvaluated = await inScope(() =>
      runStore.compareAndSwap(policyOutcome.next, {
        expectedVersion: validated.version,
        expectedRecordHash: validated.recordHash,
        idempotencyKey:
          `orchestration:${validated.id}:v${validated.version}:validated->policy-evaluated`
      })
    );

    return {
      planArtifact,
      policyEvaluated,
      runStore,
      plans,
      validations,
      policies
    };
  }

  beforeAll(async () => {
    database = new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    await db().query(
      `INSERT INTO auth_users(id,status)
       VALUES($1,'active')
       ON CONFLICT (id) DO NOTHING`,
      [userId]
    );
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  it("persists owner approval, exact-hash grant, resume outbox, and authorized CAS across transaction boundaries", async () => {
    const record = intent("approve");
    const built = await advanceToPolicyEvaluated(record);
    const decisions = new PostgresOrchestrationDecisionStore(db());
    const grants = new PostgresOrchestrationAuthorizationGrantStore(db());

    const authorityOutcome = await inScope(() =>
      advancePolicyEvaluatedToAuthority({
        run: built.policyEvaluated,
        plans: built.plans,
        validations: built.validations,
        policies: built.policies,
        decisions,
        grants,
        now: () => new Date("2026-09-28T14:00:08.000Z")
      })
    );
    if (authorityOutcome.kind !== "advance") throw new Error("authority advance expected");
    expect(authorityOutcome.next.state).toBe("awaiting-decision");

    const waiting = await inScope(() =>
      built.runStore.compareAndSwap(authorityOutcome.next, {
        expectedVersion: built.policyEvaluated.version,
        expectedRecordHash: built.policyEvaluated.recordHash,
        idempotencyKey:
          `orchestration:${built.policyEvaluated.id}:v${built.policyEvaluated.version}:policy-evaluated->awaiting-decision`
      })
    );
    const decisionId = waiting.checkpoints.decisionIds[0]!;
    const pending = await inScope(() => decisions.get(decisionId));
    expect(pending?.approvalBinding).toMatchObject({
      orchestrationRunId: waiting.id,
      planHash: built.planArtifact.planHash,
      requirement: "approval"
    });

    const transactions = new PostgresControlPlaneTransactionManager(
      db(),
      (client) => ({
        decisions: new PostgresEntityStore<AuthoritativeDecision>(
          client,
          "decision"
        ),
        resumeRequests: new PostgresDecisionResumeRequestStore(client)
      })
    );

    const approved = await inScope(() =>
      resolveDecision({
        command: createCommandEnvelope({
          commandId: `approve-${decisionId}`,
          actor: { type: "user", id: userId },
          scope: waiting.scope,
          correlationId: waiting.correlationId,
          environment: waiting.scope.environment,
          idempotencyKey: `approve-${decisionId}`,
          provenance: "integration-test",
          requestedMutation: {
            type: "decision.resolve",
            decisionId,
            action: "approve"
          }
        }),
        transactionManager: transactions,
        decisionId,
        action: "approve",
        now: () => new Date("2026-09-28T14:00:09.000Z")
      })
    );

    expect(approved.approvalProof).toMatchObject({
      decisionId,
      planHash: pending!.approvalBinding!.planHash,
      stepHash: pending!.approvalBinding!.stepHash,
      level: "approval"
    });

    const queue = new PostgresDecisionResumeRequestStore(db());
    const outbox = await inScope(() =>
      queue.getByDecisionVersion(decisionId, approved.version)
    );
    expect(outbox).toMatchObject({
      runId: waiting.id,
      resolution: "approved",
      status: "pending"
    });

    const dispatcher = new DecisionResumeDispatcher({
      runStore: built.runStore,
      queue,
      plans: built.plans,
      validations: built.validations,
      policies: built.policies,
      decisions,
      grants
    }, () => new Date("2026-09-28T14:00:10.000Z"));

    const dispatched = await inScope(() =>
      dispatcher.processDecision(approved)
    );
    expect(dispatched).toMatchObject({
      outcome: "advanced",
      state: "authorized",
      runId: waiting.id
    });

    const authorized = await inScope(() =>
      built.runStore.get(waiting.id)
    );
    expect(authorized?.state).toBe("authorized");
    expect(authorized?.checkpoints.authorizationGrants).toHaveLength(1);

    const grantRef = authorized!.checkpoints.authorizationGrants[0]!;
    const grant = await inScope(() => grants.get(grantRef.id));
    expect(grant).toMatchObject({
      grantHash: grantRef.hash,
      planHash: pending!.approvalBinding!.planHash,
      stepHash: pending!.approvalBinding!.stepHash,
      validationReceiptHash: pending!.approvalBinding!.validationReceiptHash,
      policySnapshotHash: pending!.approvalBinding!.policySnapshotHash,
      approvalProofHash: approved.approvalProof!.proofHash,
      disposition: "APPROVAL_REQUIRED"
    });

    expect((await inScope(() =>
      queue.getByDecisionVersion(decisionId, approved.version)
    ))?.status).toBe("processed");
  });

  it("keeps Decisions, resume requests, and authorization grants tenant isolated", async () => {
    const record = intent("rls");
    const built = await advanceToPolicyEvaluated(record);
    const decisions = new PostgresOrchestrationDecisionStore(db());
    const grants = new PostgresOrchestrationAuthorizationGrantStore(db());

    const authorityOutcome = await inScope(() =>
      advancePolicyEvaluatedToAuthority({
        run: built.policyEvaluated,
        plans: built.plans,
        validations: built.validations,
        policies: built.policies,
        decisions,
        grants,
        now: () => new Date("2026-09-28T14:00:08.000Z")
      })
    );
    if (authorityOutcome.kind !== "advance") throw new Error("authority advance expected");
    const waiting = await inScope(() =>
      built.runStore.compareAndSwap(authorityOutcome.next, {
        expectedVersion: built.policyEvaluated.version,
        expectedRecordHash: built.policyEvaluated.recordHash,
        idempotencyKey:
          `orchestration:${built.policyEvaluated.id}:v${built.policyEvaluated.version}:policy-evaluated->awaiting-decision`
      })
    );

    const decisionId = waiting.checkpoints.decisionIds[0]!;
    const foreignCompany = `foreign-${suffix}`;
    expect(await inScope(() => decisions.get(decisionId), foreignCompany))
      .toBeNull();

    const transactions = new PostgresControlPlaneTransactionManager(
      db(),
      (client) => ({
        decisions: new PostgresEntityStore<AuthoritativeDecision>(
          client,
          "decision"
        ),
        resumeRequests: new PostgresDecisionResumeRequestStore(client)
      })
    );
    const approved = await inScope(() =>
      resolveDecision({
        command: createCommandEnvelope({
          commandId: `approve-rls-${decisionId}`,
          actor: { type: "user", id: userId },
          scope: waiting.scope,
          correlationId: waiting.correlationId,
          environment: waiting.scope.environment,
          idempotencyKey: `approve-rls-${decisionId}`,
          provenance: "integration-test",
          requestedMutation: {
            type: "decision.resolve",
            decisionId,
            action: "approve"
          }
        }),
        transactionManager: transactions,
        decisionId,
        action: "approve",
        now: () => new Date("2026-09-28T14:00:09.000Z")
      })
    );
    const queue = new PostgresDecisionResumeRequestStore(db());
    expect(await inScope(
      () => queue.getByDecisionVersion(decisionId, approved.version),
      foreignCompany
    )).toBeNull();

    const dispatcher = new DecisionResumeDispatcher({
      runStore: built.runStore,
      queue,
      plans: built.plans,
      validations: built.validations,
      policies: built.policies,
      decisions,
      grants
    }, () => new Date("2026-09-28T14:00:10.000Z"));
    await inScope(() => dispatcher.processDecision(approved));

    const authorized = await inScope(() => built.runStore.get(waiting.id));
    const grantId = authorized!.checkpoints.authorizationGrants[0]!.id;
    expect(await inScope(() => grants.get(grantId), foreignCompany)).toBeNull();
  });
});
