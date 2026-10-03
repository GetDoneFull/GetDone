import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import type { EntityStore, AuthoritativeEntity } from "@/lib/domain/services/common";
import { GoalService, type GoalRecord, type GoalStores } from "@/lib/domain/services/goal-service";
import { ApprovalService, type ApprovalRecord, type ApprovalStores } from "@/lib/domain/services/approval-service";
import { TaskService, type TaskRecord, type TaskStores } from "@/lib/domain/services/task-service";
import { JobService, type JobRecord, type JobStores } from "@/lib/domain/services/job-service";
import {
  createJobVerifiedCompletionFact,
  createJobVerifiedStartFact,
  type JobExecutionBridgeStore,
  type JobVerifiedCompletionFact,
  type JobVerifiedStartFact
} from "@/lib/domain/services/job-execution-bridge";
import type {
  VerifiedPlacementCompletion,
  VerifiedRunningPlacement
} from "@/lib/resources/scheduler";
import { OutcomeService, type OutcomeRecord, type OutcomeStores } from "@/lib/domain/services/outcome-service";
import { createStepUpProof } from "@/lib/authorization/proofs";
import { autoGrantFor, fixtureNow } from "@/lib/planning/test-security-fixture";
import {
  assertAuthorizationConsumption,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import { validPlan } from "@/lib/planning/test-fixture";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import {
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest,
  type VerificationReceipt,
  type VerificationReceiptStore,
  type VerificationSubjectType,
  type VerificationVerdict
} from "@/lib/verification/verification";

class MemoryStore<T extends AuthoritativeEntity> implements EntityStore<T> {
  constructor(public value: T) {}
  async get(id: string) { return id === this.value.id ? { ...this.value } : null; }
  async save(next: T, expectedVersion: number) {
    if (this.value.version !== expectedVersion) throw new Error("optimistic concurrency conflict");
    this.value = { ...next };
  }
}

class MemoryGrantStore implements AuthorizationGrantStore {
  readonly consumptions: AuthorizationConsumptionRecord[] = [];

  constructor(readonly grant: AuthorizationGrant) {}

  async get(id: string) {
    return id === this.grant.id ? this.grant : null;
  }

  async consume(record: AuthorizationConsumptionRecord) {
    assertAuthorizationConsumption(record, this.grant);
    const existing = this.consumptions.find((item) => item.id === record.id);
    if (existing) {
      if (existing.consumptionHash !== record.consumptionHash) {
        throw new Error("conflicting authorization consumption");
      }
      return;
    }
    if (this.consumptions.length > 0) {
      throw new Error("authorization grant already consumed");
    }
    this.consumptions.push(record);
  }

  async listConsumptions(grantId: string) {
    return this.consumptions.filter((record) => record.grantId === grantId);
  }

  async revoke() {}
}

class MemoryVerificationReceiptStore implements VerificationReceiptStore {
  constructor(private readonly receipts: readonly VerificationReceipt[]) {}

  async getReceipt(id: string) {
    return this.receipts.find((receipt) => receipt.id === id) ?? null;
  }
}

class MemoryExecutionBridgeStore implements JobExecutionBridgeStore {
  constructor(
    private readonly starts: readonly JobVerifiedStartFact[],
    private readonly completions: readonly JobVerifiedCompletionFact[]
  ) {}

  async getStartFact(id: string) {
    return this.starts.find((fact) => fact.id === id) ?? null;
  }

  async getCompletionFact(id: string) {
    return this.completions.find((fact) => fact.id === id) ?? null;
  }
}

function verifiedBridgeFacts(jobId: string) {
  const runningBase = {
    id: "running-service-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging" as const,
    jobId,
    placementDecisionId: "placement-service-1",
    placementDecisionHash: "placement-service-hash",
    reservationId: "reservation-service-1",
    reservationHash: "reservation-service-hash",
    allocationId: "allocation-service-1",
    allocationHash: "allocation-service-hash",
    dispatchIntentId: "dispatch-service-1",
    dispatchHash: "dispatch-service-hash",
    startVerificationRequestId: "start-request-service-1",
    startVerificationReceiptId: "start-receipt-service-1",
    startVerificationReceiptHash: "start-receipt-service-hash",
    startVerificationTrustAttestationId: "start-trust-service-1",
    startVerificationTrustAttestationHash: "start-trust-service-hash",
    startedVerifiedAt: "2026-09-20T22:00:06Z",
    state: "running-verified" as const,
    jobStateMutationApplied: false as const
  };
  const running: VerifiedRunningPlacement = Object.freeze({
    ...runningBase,
    recordHash: sha256Hex(runningBase)
  });

  const completionBase = {
    id: "completion-service-1",
    runningPlacementId: running.id,
    runningPlacementHash: running.recordHash,
    completionVerificationRequestId: "completion-request-service-1",
    completionVerificationReceiptId: "completion-receipt-service-1",
    completionVerificationReceiptHash: "completion-receipt-service-hash",
    completionVerificationTrustAttestationId: "completion-trust-service-1",
    completionVerificationTrustAttestationHash: "completion-trust-service-hash",
    verifiedAt: "2026-09-20T22:02:02Z",
    state: "completed-verified" as const,
    jobStateMutationApplied: false as const
  };
  const completion: VerifiedPlacementCompletion = Object.freeze({
    ...completionBase,
    recordHash: sha256Hex(completionBase)
  });

  const scope = {
    userId: "user-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging" as const
  };
  const startFact = createJobVerifiedStartFact({
    id: "job-start-fact-service",
    runningPlacement: running,
    scope,
    issuedAt: "2026-09-20T22:00:07Z",
    expiresAt: "2026-09-20T22:05:00Z"
  });
  const completionFact = createJobVerifiedCompletionFact({
    id: "job-completion-fact-service",
    runningPlacement: running,
    completion,
    scope,
    bridgedAt: "2026-09-20T22:02:03Z"
  });
  return { startFact, completionFact };
}

class MemoryAudit implements AuditLedger {
  readonly events: AuditEvent[] = [];
  fail = false;
  async append(event: AuditEvent) {
    if (this.fail) throw new Error("simulated audit failure");
    this.events.push(event);
  }
  async listByCorrelationId(correlationId: string) {
    return this.events.filter((event) => event.correlationId === correlationId);
  }
}

function manager<TStores>(stores: TStores, audit = new MemoryAudit()): ControlPlaneTransactionManager<TStores> {
  const idempotency = new MemoryIdempotencyStore();
  return { run: async (operation) => operation({ stores, audit, idempotency }) };
}

let commandCounter = 0;
function command(type: string) {
  commandCounter += 1;
  return createCommandEnvelope({
    commandId: `command-${commandCounter}`,
    actor: { type: "user", id: "user-a" },
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging"
    },
    correlationId: `correlation-${commandCounter}`,
    environment: "staging",
    idempotencyKey: `idempotency-${commandCounter}`,
    provenance: "unit-test",
    requestedMutation: { type }
  });
}

const stepUp = createStepUpProof({
  id: "stepup-service",
  actorId: "user-a",
  scope: {
    userId: "user-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging"
  },
  method: "passkey",
  authenticatedAt: "2026-09-20T17:59:00Z",
  expiresAt: "2099-01-01T00:00:00Z"
});

const base = {
  id: "entity-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  version: 1,
  updatedAt: "2026-09-20T16:00:00Z"
};

function verificationReceipt(
  subjectType: VerificationSubjectType,
  subjectId: string,
  verdict: VerificationVerdict = "verified"
) {
  const request = createVerificationRequest({
    id: "verification-request-" + subjectType + "-" + subjectId + "-" + verdict,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    subject: { type: subjectType, id: subjectId },
    strategies: ["system"],
    requiresIndependentEvidence: false,
    maxEvidenceAgeSeconds: 3_000_000_000,
    requestedAt: "2026-09-20T19:30:00Z",
    expiresAt: "2099-01-01T00:00:00Z"
  });

  const evidence = createVerificationEvidence({
    id: "verification-evidence-" + subjectType + "-" + subjectId + "-" + verdict,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    subject: { type: subjectType, id: subjectId },
    strategy: "system",
    result: verdict === "verified" ? "pass" : verdict === "failed" ? "fail" : "unknown",
    sourceType: "system-probe",
    sourceId: "independent-verifier",
    independenceKey: "verifier:independent",
    observedAt: "2026-09-20T19:31:00Z",
    payloadHash: "verification-payload-" + verdict,
    provenance: "unit-test"
  });

  return resolveVerificationRequest(request, [evidence], {
    receiptId: "verification-receipt-" + subjectType + "-" + subjectId + "-" + verdict,
    verifiedAt: "2026-09-20T19:31:00Z",
    receiptTtlSeconds: 2_000_000_000
  });
}

describe("transactional domain services", () => {
  it("transitions goals through the universal transition service", async () => {
    const audit = new MemoryAudit();
    const store = new MemoryStore<GoalRecord>({
      ...base, state: "draft", title: "Grow", metric: "revenue", target: 100, priority: 1
    });
    const service = new GoalService(manager<GoalStores>({ goals: store }, audit));
    const result = await service.activate(base.id, command("goal.activate"));
    expect(result.state).toBe("active");
    expect(result.version).toBe(2);
    expect(audit.events[0].eventType).toBe("goal.active");
  });

  it("requires a hash-bound step-up proof for strong approvals", async () => {
    const store = new MemoryStore<ApprovalRecord>({
      ...base, state: "pending", decisionId: "decision-1", requirement: "strong-approval"
    });
    const service = new ApprovalService(manager<ApprovalStores>({ approvals: store }));
    const plan = validPlan();
    const approvalInput = {
      planHash: hashPlan(plan),
      stepHash: hashPlanStep(plan.steps[0]),
      proofExpiresAt: "2098-12-31T23:59:00Z",
      stepUpProof: stepUp
    };
    await expect(service.grant(base.id, command("approval.grant"), { ...approvalInput, stepUpProof: undefined })).rejects.toThrow();
    const granted = await service.grant(base.id, command("approval.grant"), approvalInput);
    expect(granted.state).toBe("granted");
    expect(granted.approvalProof?.decisionId).toBe("decision-1");
    expect(granted.approvalProof?.planHash).toBe(hashPlan(plan));
  });

  it("requires an authoritative verified receipt before task success", async () => {
    const store = new MemoryStore<TaskRecord>({
      ...base, state: "verifying", reason: "approved plan", evidenceIds: ["evidence-1"],
      capabilityRequirements: ["email.send"], authorizationLineage: ["approval-1"], verificationEvidenceIds: []
    });
    const uncertain = verificationReceipt("task", base.id, "uncertain");
    const verified = verificationReceipt("task", base.id, "verified");
    const receipts = new MemoryVerificationReceiptStore([uncertain, verified]);
    const service = new TaskService(manager<TaskStores>({
      tasks: store,
      verificationReceipts: receipts
    }));

    await expect(
      service.succeed(base.id, command("task.succeed.missing"), "missing-receipt")
    ).rejects.toThrow();
    await expect(
      service.succeed(base.id, command("task.succeed.invalid"), uncertain.id)
    ).rejects.toThrow();

    const result = await service.succeed(base.id, command("task.succeed"), verified.id);
    expect(result.state).toBe("succeeded");
    expect(result.verificationReceiptHash).toBe(verified.receiptHash);
  });

  it("consumes authorization at the Task and lets Jobs inherit only persisted Task authority", async () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const grants = new MemoryGrantStore(grant);

    const taskStore = new MemoryStore<TaskRecord>({
      id: "task-1",
      portfolioId: plan.scope.portfolioId,
      companyId: plan.scope.companyId,
      state: "proposed",
      reason: "approved work",
      evidenceIds: [],
      capabilityRequirements: [...grant.capabilityNames],
      authorizationLineage: [],
      verificationEvidenceIds: [],
      version: 1,
      updatedAt: fixtureNow.toISOString()
    });
    const taskService = new TaskService(manager<TaskStores>({
      tasks: taskStore,
      authorizationGrants: grants
    }));
    const authorizedTask = await taskService.authorize(
      "task-1",
      command("task.authorize"),
      grant,
      fixtureNow.toISOString()
    );
    expect(authorizedTask.authorizationConsumption?.consumerType).toBe("task");
    expect(grants.consumptions).toHaveLength(1);

    const jobStore = new MemoryStore<JobRecord>({
      ...base,
      state: "created",
      taskId: "task-1",
      attempt: 0,
      verificationEvidenceIds: []
    });
    const verifiedJobReceipt = verificationReceipt("job", base.id, "verified");
    const bridgeFacts = verifiedBridgeFacts(base.id);
    const jobService = new JobService(manager<JobStores>({
      jobs: jobStore,
      authorizationGrants: grants,
      verificationReceipts: new MemoryVerificationReceiptStore([verifiedJobReceipt]),
      executionBridge: new MemoryExecutionBridgeStore(
        [bridgeFacts.startFact],
        [bridgeFacts.completionFact]
      )
    }), () => new Date("2026-09-20T22:03:00Z"));
    const queued = await jobService.queue(
      base.id,
      command("job.queue"),
      grant,
      authorizedTask.authorizationConsumption!,
      fixtureNow.toISOString()
    );
    expect(queued.authorizationConsumption?.consumerType).toBe("task");
    expect(queued.authorizationConsumption?.consumerId).toBe("task-1");

    await jobService.claim(base.id, command("job.claim"), "worker-1");
    await expect(
      jobService.start(base.id, command("job.start.missing"), "missing-start-fact")
    ).rejects.toThrow(/verified-start fact/i);
    const executing = await jobService.start(
      base.id,
      command("job.start"),
      bridgeFacts.startFact.id
    );
    expect(executing.state).toBe("executing");

    const providerCompleted = await jobService.recordProviderCompletion(
      base.id,
      command("job.provider-completed"),
      {
        providerResultId: "provider-operation-1",
        providerResultHash: bridgeFacts.completionFact.factHash,
        completedAt: "2026-09-20T22:02:03Z",
        verifiedCompletionFactId: bridgeFacts.completionFact.id
      }
    );
    expect(providerCompleted.state).toBe("provider_completed");

    expect((
      await jobService.beginVerification(
        base.id,
        command("job.verify.begin")
      )
    ).state).toBe("verifying");
    const verified = await jobService.verify(
      base.id,
      command("job.verified"),
      verifiedJobReceipt.id
    );
    expect(verified.state).toBe("verified");
    expect(verified.verificationReceiptHash).toBe(verifiedJobReceipt.receiptHash);
  });

  it("does not verify an outcome from a non-authoritative or uncertain receipt", async () => {
    const store = new MemoryStore<OutcomeRecord>({
      ...base, state: "recorded", jobId: "job-1", metric: "conversion-rate", value: 0.12, evidenceIds: []
    });
    const uncertain = verificationReceipt("outcome", base.id, "uncertain");
    const verified = verificationReceipt("outcome", base.id, "verified");
    const service = new OutcomeService(manager<OutcomeStores>({
      outcomes: store,
      verificationReceipts: new MemoryVerificationReceiptStore([uncertain, verified])
    }));

    await expect(
      service.verify(base.id, command("outcome.verify.missing"), "missing-receipt")
    ).rejects.toThrow();
    await expect(
      service.verify(base.id, command("outcome.verify.uncertain"), uncertain.id)
    ).rejects.toThrow();

    const result = await service.verify(base.id, command("outcome.verify"), verified.id);
    expect(result.state).toBe("verified");
    expect(result.verificationReceiptHash).toBe(verified.receiptHash);
  });
});
