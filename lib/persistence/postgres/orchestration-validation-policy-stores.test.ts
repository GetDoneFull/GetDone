import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import { assembleContext } from "@/lib/intelligence/context";
import {
  createOwnerIntentContextSnapshot,
  createOwnerIntentOrchestrationRun
} from "@/lib/orchestration/owner-intent-flow";
import {
  createPersistedPlanProposal,
  createPlannerInputEnvelope
} from "@/lib/orchestration/planning-flow";
import {
  createDurablePolicyEvaluationArtifact,
  createDurablePolicyStepSnapshotArtifact,
  createDurableValidationArtifact,
  policyEvaluationIdempotencyKey,
  policySnapshotId,
  policyStepIdempotencyKey,
  validationArtifactIdempotencyKey,
  validationReceiptId,
  validationSnapshotId
} from "@/lib/orchestration/validation-policy-flow";
import { transitionOrchestrationRun } from "@/lib/orchestration/contracts";
import { validPlan } from "@/lib/planning/test-fixture";
import {
  validationPolicyFor
} from "@/lib/planning/test-security-fixture";
import {
  attestPlanValidation
} from "@/lib/planning/plan-validator";
import {
  createValidationReceipt,
  createValidationSnapshot
} from "@/lib/planning/validation-receipt";
import { hashPlanStep } from "@/lib/planning/plan-hash";
import {
  evaluateStepPolicy
} from "@/lib/planning/policy-engine";
import {
  createPolicySnapshot
} from "@/lib/planning/policy-snapshot";
import {
  PostgresOrchestrationPolicyEvaluationStore,
  PostgresOrchestrationPolicyStepSnapshotStore,
  PostgresOrchestrationValidationArtifactStore
} from "@/lib/persistence/postgres/orchestration-validation-policy-stores";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface ResponseSpec {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDb implements PostgresTransactionalDatabase {
  readonly calls: string[] = [];
  constructor(private readonly responses: ResponseSpec[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string
  ): Promise<QueryResult<R>> {
    this.calls.push(text.replace(/\s+/g, " ").trim());
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    return operation(this as unknown as PoolClient);
  }
}

function artifacts() {
  const intent = {
    id: "intent-store",
    correlationId: "correlation-store",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging" as const,
    userId: "owner-a",
    message: "do governed work",
    channel: "chat" as const,
    status: "accepted" as const,
    receivedAt: "2026-09-28T13:30:00.000Z"
  };
  const accepted = createOwnerIntentOrchestrationRun(intent);
  const context = assembleContext([], {
    portfolioId: intent.portfolioId,
    companyId: intent.companyId,
    allowedSensitivity: ["public", "internal"]
  }, {
    now: Date.parse("2026-09-28T13:30:01.000Z")
  });
  const contextSnapshot = createOwnerIntentContextSnapshot({
    run: accepted,
    intent,
    assembledContext: context,
    createdAt: "2026-09-28T13:30:01.000Z"
  });
  const contextReady = transitionOrchestrationRun(accepted, {
    to: "context-ready",
    now: "2026-09-28T13:30:02.000Z",
    checkpointPatch: {
      contextSnapshot: {
        id: contextSnapshot.id,
        hash: contextSnapshot.snapshotHash
      }
    }
  });
  const plannerInput = createPlannerInputEnvelope({
    run: contextReady,
    snapshot: contextSnapshot,
    createdAt: "2026-09-28T13:30:03.000Z"
  });
  const planning = transitionOrchestrationRun(contextReady, {
    to: "planning",
    now: "2026-09-28T13:30:03.000Z",
    checkpointPatch: {
      plannerInput: { id: plannerInput.id, hash: plannerInput.inputHash }
    }
  });
  const proposal = validPlan({
    id: "plan-store",
    scope: {
      portfolioId: intent.portfolioId,
      companyId: intent.companyId,
      environment: intent.environment,
      dataClass: "internal"
    },
    source: { type: "owner-request", requestId: intent.id },
    objective: undefined,
    createdAt: "2026-09-28T13:30:04.000Z"
  });
  const planArtifact = createPersistedPlanProposal({
    run: planning,
    plannerInput,
    plannerRequestId: "planner-request-store",
    proposal,
    createdAt: "2026-09-28T13:30:04.000Z"
  });
  const planned = transitionOrchestrationRun(planning, {
    to: "planned",
    now: "2026-09-28T13:30:05.000Z",
    checkpointPatch: {
      plan: { id: planArtifact.id, hash: planArtifact.planHash }
    }
  });

  const validationPolicy = validationPolicyFor(proposal);
  const validationSnapshot = createValidationSnapshot({
    id: validationSnapshotId(planned.id, planned.version),
    policyVersion: CURRENT_POLICY_VERSION,
    environment: proposal.scope.environment,
    configurationVersion: "config-store-v1",
    evidenceRequirements: {
      health: "not-applicable",
      capacity: "not-applicable",
      credentials: "not-applicable"
    },
    createdAt: "2026-09-28T13:30:06.000Z",
    expiresAt: "2026-09-28T13:40:00.000Z"
  });
  const attestation = attestPlanValidation(
    proposal,
    validationPolicy,
    "2026-09-28T13:30:06.000Z"
  );
  const receipt = createValidationReceipt({
    id: validationReceiptId(planned.id, planned.version),
    plan: proposal,
    attestation,
    snapshot: validationSnapshot,
    validatedAt: "2026-09-28T13:30:06.000Z",
    expiresAt: "2026-09-28T13:39:00.000Z"
  });
  const validationArtifact = createDurableValidationArtifact({
    run: planned,
    planArtifact,
    validationPolicy,
    snapshot: validationSnapshot,
    attestation,
    receipt,
    createdAt: "2026-09-28T13:30:06.000Z"
  });

  const validated = transitionOrchestrationRun(planned, {
    to: "validated",
    now: "2026-09-28T13:30:07.000Z",
    checkpointPatch: {
      validationReceipt: {
        id: receipt.id,
        hash: receipt.receiptHash
      }
    }
  });

  const step = proposal.steps[0]!;
  const stepHash = hashPlanStep(step);
  const policySnapshot = createPolicySnapshot({
    id: policySnapshotId(validated.id, validated.version, step.id),
    policyVersion: CURRENT_POLICY_VERSION,
    scope: validated.scope,
    planHash: planArtifact.planHash,
    stepHash,
    capabilityNames: step.capabilityRequests.map((item) => item.capability),
    dataClass: proposal.scope.dataClass,
    region: "us-west",
    allowedEnvironments: [proposal.scope.environment],
    allowedDataClasses: [proposal.scope.dataClass],
    allowedRegions: ["us-west"],
    killSwitches: [],
    credentialRequirementIds: [],
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: policyStepIdempotencyKey(
      validated.id,
      validated.version,
      step.id
    ),
    resourceRequirements: step.resourceRequirements,
    createdAt: "2026-09-28T13:30:08.000Z"
  });
  const evaluation = evaluateStepPolicy({
    authenticated: true,
    scopeResolved: true,
    trustedScope: policySnapshot.scope,
    capabilities: policySnapshot.capabilityNames,
    planHash: policySnapshot.planHash,
    stepHash: policySnapshot.stepHash,
    environment: policySnapshot.scope.environment,
    dataClass: policySnapshot.dataClass,
    region: policySnapshot.region,
    allowedEnvironments: policySnapshot.allowedEnvironments,
    allowedDataClasses: policySnapshot.allowedDataClasses,
    allowedRegions: policySnapshot.allowedRegions,
    credentialRequirementIds: policySnapshot.credentialRequirementIds,
    fallbackRequired: policySnapshot.fallbackRequired,
    fallbackAvailable: policySnapshot.fallbackAvailable,
    idempotencyKey: policySnapshot.idempotencyKey,
    killSwitches: policySnapshot.killSwitches,
    now: Date.parse("2026-09-28T13:30:08.000Z")
  });
  const policyStepArtifact = createDurablePolicyStepSnapshotArtifact({
    run: validated,
    planArtifact,
    validationArtifact,
    step,
    snapshot: policySnapshot,
    createdAt: "2026-09-28T13:30:08.000Z"
  });
  const policyArtifact = createDurablePolicyEvaluationArtifact({
    run: validated,
    planArtifact,
    validationArtifact,
    stepPolicies: [{
      stepId: step.id,
      stepHash,
      snapshot: policyStepArtifact.snapshot,
      evaluation
    }],
    createdAt: "2026-09-28T13:30:08.000Z"
  });

  return { validationArtifact, policyStepArtifact, policyArtifact };
}

describe("PostgreSQL validation/policy artifact stores", () => {
  it("creates and exactly replays a validation artifact", async () => {
    const { validationArtifact } = artifacts();
    const key = validationArtifactIdempotencyKey(
      validationArtifact.runId,
      validationArtifact.plannedRunVersion
    );

    const createdDb = new ScriptedDb([{ rowCount: 1 }]);
    expect(await new PostgresOrchestrationValidationArtifactStore(createdDb)
      .create(validationArtifact, key))
      .toEqual({ status: "created", artifact: validationArtifact });

    const replayDb = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: validationArtifact,
          receipt_hash: validationArtifact.receipt.receiptHash,
          artifact_hash: validationArtifact.artifactHash,
          idempotency_key: key
        }]
      }
    ]);
    expect(await new PostgresOrchestrationValidationArtifactStore(replayDb)
      .create(validationArtifact, key))
      .toEqual({ status: "idempotent-replay", artifact: validationArtifact });
  });

  it("rejects validation idempotency reuse with different contents", async () => {
    const { validationArtifact } = artifacts();
    const key = validationArtifactIdempotencyKey(
      validationArtifact.runId,
      validationArtifact.plannedRunVersion
    );
    const db = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: validationArtifact,
          receipt_hash: "a".repeat(64),
          artifact_hash: "b".repeat(64),
          idempotency_key: key
        }]
      }
    ]);

    await expect(
      new PostgresOrchestrationValidationArtifactStore(db)
        .create(validationArtifact, key)
    ).rejects.toThrow(/Validation artifact conflicts/i);
  });

  it("creates and exactly replays a per-step policy snapshot artifact", async () => {
    const { policyStepArtifact } = artifacts();
    const key = policyStepIdempotencyKey(
      policyStepArtifact.runId,
      policyStepArtifact.validatedRunVersion,
      policyStepArtifact.stepId
    );

    const createdDb = new ScriptedDb([{ rowCount: 1 }]);
    expect(await new PostgresOrchestrationPolicyStepSnapshotStore(createdDb)
      .create(policyStepArtifact, key))
      .toEqual({ status: "created", artifact: policyStepArtifact });

    const replayDb = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: policyStepArtifact,
          snapshot_hash: policyStepArtifact.snapshot.snapshotHash,
          artifact_hash: policyStepArtifact.artifactHash,
          idempotency_key: key
        }]
      }
    ]);
    expect(await new PostgresOrchestrationPolicyStepSnapshotStore(replayDb)
      .create(policyStepArtifact, key))
      .toEqual({ status: "idempotent-replay", artifact: policyStepArtifact });
  });

  it("creates and exactly replays a policy evaluation artifact", async () => {
    const { policyArtifact } = artifacts();
    const key = policyEvaluationIdempotencyKey(
      policyArtifact.runId,
      policyArtifact.validatedRunVersion
    );

    const createdDb = new ScriptedDb([{ rowCount: 1 }]);
    expect(await new PostgresOrchestrationPolicyEvaluationStore(createdDb)
      .create(policyArtifact, key))
      .toEqual({ status: "created", artifact: policyArtifact });

    const replayDb = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: policyArtifact,
          artifact_hash: policyArtifact.artifactHash,
          idempotency_key: key
        }]
      }
    ]);
    expect(await new PostgresOrchestrationPolicyEvaluationStore(replayDb)
      .create(policyArtifact, key))
      .toEqual({ status: "idempotent-replay", artifact: policyArtifact });
  });

  it("rejects policy idempotency reuse with different contents", async () => {
    const { policyArtifact } = artifacts();
    const key = policyEvaluationIdempotencyKey(
      policyArtifact.runId,
      policyArtifact.validatedRunVersion
    );
    const db = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: policyArtifact,
          artifact_hash: "c".repeat(64),
          idempotency_key: key
        }]
      }
    ]);

    await expect(
      new PostgresOrchestrationPolicyEvaluationStore(db)
        .create(policyArtifact, key)
    ).rejects.toThrow(/Policy evaluation artifact conflicts/i);
  });

  it("reads durable validation/policy artifacts by id and run version", async () => {
    const { validationArtifact, policyArtifact } = artifacts();

    const validationDb = new ScriptedDb([
      { rows: [{ payload: validationArtifact }] },
      { rows: [{ payload: validationArtifact }] }
    ]);
    const validationStore =
      new PostgresOrchestrationValidationArtifactStore(validationDb);
    expect(await validationStore.get(validationArtifact.id))
      .toEqual(validationArtifact);
    expect(await validationStore.getByRunVersion(
      validationArtifact.runId,
      validationArtifact.plannedRunVersion
    )).toEqual(validationArtifact);

    const { policyStepArtifact } = artifacts();
    const policyStepDb = new ScriptedDb([
      { rows: [{ payload: policyStepArtifact }] }
    ]);
    const policyStepStore =
      new PostgresOrchestrationPolicyStepSnapshotStore(policyStepDb);
    expect(await policyStepStore.getByRunVersionStep(
      policyStepArtifact.runId,
      policyStepArtifact.validatedRunVersion,
      policyStepArtifact.stepId
    )).toEqual(policyStepArtifact);

    const policyDb = new ScriptedDb([
      { rows: [{ payload: policyArtifact }] },
      { rows: [{ payload: policyArtifact }] }
    ]);
    const policyStore = new PostgresOrchestrationPolicyEvaluationStore(policyDb);
    expect(await policyStore.get(policyArtifact.id)).toEqual(policyArtifact);
    expect(await policyStore.getByRunVersion(
      policyArtifact.runId,
      policyArtifact.validatedRunVersion
    )).toEqual(policyArtifact);
  });
});
