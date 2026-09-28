import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import {
  advanceOwnerIntentAcceptedToContextReady
} from "@/lib/orchestration/owner-intent-flow";
import {
  advanceContextReadyToPlanning,
  advancePlanningToPlanned,
  type DurablePlanner,
  type PersistedPlanProposal
} from "@/lib/orchestration/planning-flow";
import {
  advancePlannedToValidated,
  advanceValidatedToPolicyEvaluated
} from "@/lib/orchestration/validation-policy-flow";
import { PostgresOwnerIntentStore } from "@/lib/persistence/postgres/control-api-stores";
import { PostgresOrchestrationRunStore } from "@/lib/persistence/postgres/orchestration-store";
import { PostgresOrchestrationContextSnapshotStore } from "@/lib/persistence/postgres/orchestration-context-snapshot-store";
import {
  PostgresOrchestrationPlanProposalStore,
  PostgresPlannerInputStore
} from "@/lib/persistence/postgres/orchestration-planning-stores";
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
import { validPlan } from "@/lib/planning/test-fixture";
import { validationPolicyFor } from "@/lib/planning/test-security-fixture";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;

integrationDescribe("PostgreSQL durable planned -> validated -> policy-evaluated", () => {
  let database: PostgresDatabase | undefined;
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `validation-user-${suffix}`;
  const portfolioId = `validation-portfolio-${suffix}`;
  const companyId = `validation-company-${suffix}`;

  function db() {
    if (!database) throw new Error("PostgreSQL validation test database is not initialized");
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
      id: `intent-validation-${name}-${suffix}`,
      correlationId: `correlation-validation-${name}-${suffix}`,
      portfolioId,
      companyId,
      environment: "staging",
      userId,
      message: `govern work ${name}`,
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
        return {
          kind: "success",
          requestId: request.requestId,
          candidate: validPlan({
            id: `plan-${record.id}`,
            scope: {
              portfolioId,
              companyId,
              environment: "staging",
              dataClass: "internal"
            },
            source: {
              type: "owner-request",
              requestId: record.id
            },
            objective: undefined,
            createdAt: "2026-09-28T14:00:04.000Z"
          })
        };
      }
    };
  }

  async function advanceToPlanned(record: OwnerIntentRecord) {
    const ownerIntents = new PostgresOwnerIntentStore(db());
    const runStore = new PostgresOrchestrationRunStore(db());
    const snapshots = new PostgresOrchestrationContextSnapshotStore(db());
    const plannerInputs = new PostgresPlannerInputStore(db());
    const plans = new PostgresOrchestrationPlanProposalStore(db());

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
          listForIntent: async () => [{
            id: `fact-${record.id}`,
            kind: "fact",
            portfolioId,
            companyId,
            source: "integration-test",
            provenance: "verified:test",
            observedAt: "2026-09-28T13:59:59.000Z",
            freshnessSeconds: 300,
            sensitivity: "internal",
            content: "Verified validation input fact."
          }]
        },
        policy: {
          resolve: async () => ({
            scope: {
              portfolioId,
              companyId,
              allowedSensitivity: ["public", "internal"]
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

    return { planned, planArtifact, runStore, plans };
  }

  function validationResolver(planArtifact: PersistedPlanProposal) {
    return {
      resolve: async () => ({
        validationPolicy: validationPolicyFor(planArtifact.proposal),
        snapshot: {
          configurationVersion: "validation-integration-v1",
          evidenceRequirements: {
            health: "not-applicable" as const,
            capacity: "not-applicable" as const,
            credentials: "not-applicable" as const
          },
          expiresAt: "2026-09-28T14:10:00.000Z"
        },
        receiptExpiresAt: "2026-09-28T14:09:00.000Z"
      })
    };
  }

  function policyResolver(planArtifact: PersistedPlanProposal) {
    return {
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

  it("persists immutable validation and policy artifacts through policy-evaluated", async () => {
    const record = intent("full");
    const { planned, planArtifact, runStore, plans } = await advanceToPlanned(record);
    const validations = new PostgresOrchestrationValidationArtifactStore(db());
    const policyStepSnapshots =
      new PostgresOrchestrationPolicyStepSnapshotStore(db());
    const policies = new PostgresOrchestrationPolicyEvaluationStore(db());

    const validationOutcome = await inScope(() =>
      advancePlannedToValidated({
        run: planned,
        plans,
        validations,
        resolver: validationResolver(planArtifact),
        now: () => new Date("2026-09-28T14:00:06.000Z")
      })
    );
    if (validationOutcome.kind !== "advance") throw new Error("validation advance expected");
    expect(validationOutcome.next.state).toBe("validated");

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
        resolver: policyResolver(planArtifact),
        now: () => new Date("2026-09-28T14:00:07.000Z")
      })
    );
    if (policyOutcome.kind !== "advance") throw new Error("policy advance expected");
    expect(policyOutcome.next.state).toBe("policy-evaluated");

    const policyEvaluated = await inScope(() =>
      runStore.compareAndSwap(policyOutcome.next, {
        expectedVersion: validated.version,
        expectedRecordHash: validated.recordHash,
        idempotencyKey:
          `orchestration:${validated.id}:v${validated.version}:validated->policy-evaluated`
      })
    );

    const validationArtifact = await inScope(() =>
      validations.get(policyEvaluated.checkpoints.validationReceipt!.id)
    );
    const policyArtifact = await inScope(() =>
      policies.get(policyEvaluated.checkpoints.policySnapshot!.id)
    );

    expect(validationArtifact?.planArtifactHash).toBe(planArtifact.artifactHash);
    expect(validationArtifact?.receipt.status).toBe("valid");
    expect(policyArtifact?.planArtifactHash).toBe(planArtifact.artifactHash);
    expect(policyArtifact?.aggregateDisposition).toBe("AUTO");
    expect(policyArtifact?.stepPolicies).toHaveLength(planArtifact.proposal.steps.length);
  });

  it("reuses validation artifact after crash before planned -> validated CAS", async () => {
    const record = intent("validation-crash");
    const { planned, planArtifact, plans } = await advanceToPlanned(record);
    const validations = new PostgresOrchestrationValidationArtifactStore(db());
    let resolverCalls = 0;

    const first = await inScope(() =>
      advancePlannedToValidated({
        run: planned,
        plans,
        validations,
        resolver: {
          resolve: async () => {
            resolverCalls += 1;
            return validationResolver(planArtifact).resolve();
          }
        },
        now: () => new Date("2026-09-28T14:00:06.000Z")
      })
    );
    expect(first.kind).toBe("advance");
    expect(resolverCalls).toBe(1);

    const replay = await inScope(() =>
      advancePlannedToValidated({
        run: planned,
        plans,
        validations,
        resolver: {
          resolve: async () => {
            throw new Error("validation resolver must not rerun after artifact commit");
          }
        },
        now: () => new Date("2026-09-28T15:00:00.000Z")
      })
    );

    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.checkpoints.validationReceipt)
      .toEqual(first.next.checkpoints.validationReceipt);
  });

  it("reuses policy artifact after crash before validated -> policy-evaluated CAS", async () => {
    const record = intent("policy-crash");
    const { planned, planArtifact, runStore, plans } = await advanceToPlanned(record);
    const validations = new PostgresOrchestrationValidationArtifactStore(db());
    const policyStepSnapshots =
      new PostgresOrchestrationPolicyStepSnapshotStore(db());
    const policies = new PostgresOrchestrationPolicyEvaluationStore(db());

    const validationOutcome = await inScope(() =>
      advancePlannedToValidated({
        run: planned,
        plans,
        validations,
        resolver: validationResolver(planArtifact),
        now: () => new Date("2026-09-28T14:00:06.000Z")
      })
    );
    if (validationOutcome.kind !== "advance") throw new Error("validation advance expected");
    const validated = await inScope(() =>
      runStore.compareAndSwap(validationOutcome.next, {
        expectedVersion: planned.version,
        expectedRecordHash: planned.recordHash,
        idempotencyKey:
          `orchestration:${planned.id}:v${planned.version}:planned->validated`
      })
    );

    let policyReads = 0;
    const first = await inScope(() =>
      advanceValidatedToPolicyEvaluated({
        run: validated,
        plans,
        validations,
        policyStepSnapshots,
        policies,
        resolver: {
          resolveStep: async () => {
            policyReads += 1;
            return policyResolver(planArtifact).resolveStep();
          }
        },
        now: () => new Date("2026-09-28T14:00:07.000Z")
      })
    );
    expect(first.kind).toBe("advance");
    expect(policyReads).toBe(planArtifact.proposal.steps.length);

    const replay = await inScope(() =>
      advanceValidatedToPolicyEvaluated({
        run: validated,
        plans,
        validations,
        policyStepSnapshots,
        policies,
        resolver: {
          resolveStep: async () => {
            throw new Error("policy resolver must not rerun after artifact commit");
          }
        },
        now: () => new Date("2026-09-28T15:00:00.000Z")
      })
    );

    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("advance expected");
    }
    expect(replay.next.checkpoints.policySnapshot)
      .toEqual(first.next.checkpoints.policySnapshot);
  });

  it("keeps validation and policy artifacts tenant-isolated by forced RLS", async () => {
    const record = intent("rls");
    const { planned, planArtifact, runStore, plans } = await advanceToPlanned(record);
    const validations = new PostgresOrchestrationValidationArtifactStore(db());
    const policyStepSnapshots =
      new PostgresOrchestrationPolicyStepSnapshotStore(db());
    const policies = new PostgresOrchestrationPolicyEvaluationStore(db());

    const validationOutcome = await inScope(() =>
      advancePlannedToValidated({
        run: planned,
        plans,
        validations,
        resolver: validationResolver(planArtifact),
        now: () => new Date("2026-09-28T14:00:06.000Z")
      })
    );
    if (validationOutcome.kind !== "advance") throw new Error("validation advance expected");
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
        resolver: policyResolver(planArtifact),
        now: () => new Date("2026-09-28T14:00:07.000Z")
      })
    );
    if (policyOutcome.kind !== "advance") throw new Error("policy advance expected");

    const foreignCompany = `validation-other-${suffix}`;
    expect(await inScope(
      () => validations.get(policyOutcome.next.checkpoints.validationReceipt!.id),
      foreignCompany
    )).toBeNull();
    const firstStepId = planArtifact.proposal.steps[0]!.id;
    expect(await inScope(
      () => policyStepSnapshots.getByRunVersionStep(
        validated.id,
        validated.version,
        firstStepId
      ),
      foreignCompany
    )).toBeNull();
    expect(await inScope(
      () => policies.get(policyOutcome.next.checkpoints.policySnapshot!.id),
      foreignCompany
    )).toBeNull();
  });
});
