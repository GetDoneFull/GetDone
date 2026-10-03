import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { createRequestContext } from "@/lib/control-plane/request-context";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import {
  activeObjectives,
  detectObjectiveConflicts,
  type Objective
} from "@/lib/domain/objectives";
import {
  resolveDecision,
  type AuthoritativeDecision,
  type DecisionAuthorityStore
} from "@/lib/domain/decision-service";
import type { DecisionStores } from "@/lib/domain/decision-transaction";
import type { AuthoritativeEntity, EntityStore } from "@/lib/domain/services/common";
import {
  ApprovalService,
  type ApprovalRecord,
  type ApprovalStores
} from "@/lib/domain/services/approval-service";
import {
  JobService,
  type JobRecord,
  type JobStores
} from "@/lib/domain/services/job-service";
import {
  OutcomeService,
  type OutcomeRecord,
  type OutcomeStores
} from "@/lib/domain/services/outcome-service";
import {
  createJobCompletionVerificationEvidence,
  createJobCompletionVerificationRequest,
  createJobVerifiedCompletionFact,
  createJobVerifiedStartFact,
  type JobExecutionBridgeStore,
  type JobVerifiedCompletionFact,
  type JobVerifiedStartFact
} from "@/lib/domain/services/job-execution-bridge";
import {
  assertAuthorizationConsumption,
  issueAuthorizationGrant,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import { CURRENT_POLICY_VERSION, currentPolicyRegistryReference } from "@/lib/domain/policy-registry";
import { createProtectedCapacitySnapshot } from "@/lib/domain/protected-capacity";
import { constructPlanProposal } from "@/lib/planning/plan-construction";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import {
  attestPlanValidation,
  type PlanValidationPolicy
} from "@/lib/planning/plan-validator";
import {
  createValidationReceipt,
  createValidationSnapshot
} from "@/lib/planning/validation-receipt";
import {
  createPolicySnapshot
} from "@/lib/planning/policy-snapshot";
import { evaluateStepPolicy } from "@/lib/planning/policy-engine";
import {
  TaskGenerator,
  type GeneratedTask,
  type TaskGenerationDedupeStore
} from "@/lib/planning/task-generator";
import {
  createPlacementCandidateSnapshot,
  createPlacementRequest,
  evaluatePlacementCandidates
} from "@/lib/resources/placement";
import type { ResourcePolicy } from "@/lib/resources/policy";
import {
  createCapacityEconomicSnapshot,
  evaluateCostCapacityGovernor
} from "@/lib/resources/cost-governor";
import {
  createAllocationRecord,
  createCapacityLedger,
  reserveCapacity
} from "@/lib/resources/reservations";
import {
  createDispatchAdapterResult,
  createDispatchAdmissionReceipt,
  createDispatchIntent,
  createPlacementDecision,
  createSchedulerCandidateSnapshot,
  createStartVerificationRequest,
  createVerifiedRunningPlacement,
  createCompletionVerificationRequest,
  createVerifiedPlacementCompletion,
  rankEligibleCandidates,
  releaseVerifiedPlacement,
  reservationAuthorityFromDecision
} from "@/lib/resources/scheduler";
import {
  createCredentialBinding,
  createCredentialRequest,
  createSecretReference,
  issueCredentialLease,
  releaseCredentialLease
} from "@/lib/credentials/broker";
import {
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest,
  type VerificationReceipt,
  type VerificationReceiptStore
} from "@/lib/verification/verification";
import {
  createVerificationSourceBinding,
  createVerificationTrustAttestation
} from "@/lib/verification/source-trust";
import { createOperationalMemory } from "@/lib/intelligence/memory";
import {
  EventService,
  type EventRecord,
  type EventStore,
  type EventStores
} from "@/lib/domain/services/event-service";
import { toJobResultView } from "@/lib/control-api/service-adapter";

export const GOLDEN_PATH_HARNESS_VERSION = "1.2.0";

export type GoldenPathStageName =
  | "objective"
  | "plan"
  | "validation"
  | "policy"
  | "decision"
  | "approval"
  | "authorization"
  | "task"
  | "job"
  | "placement"
  | "governor"
  | "reservation"
  | "credential-admission"
  | "dispatch-admission"
  | "start-verification"
  | "job-executing"
  | "provider-completed"
  | "completion-verification"
  | "outcome"
  | "event-audit"
  | "owner-visibility"
  | "memory"
  | "resource-release";

export interface GoldenPathStage {
  name: GoldenPathStageName;
  status: "passed";
  artifactId: string;
  artifactHash: string;
}

export interface GoldenPathSimulationResult {
  harnessVersion: string;
  simulationOnly: true;
  productionExecutionClaimed: false;
  stages: readonly GoldenPathStage[];
  final: Readonly<{
    jobState: "verified";
    outcomeState: "verified";
    eventState: "processed";
    ownerVisibleJobState: "verified";
    auditEventCount: number;
    memoryAuthority: "advisory";
    reservationState: "released";
    credentialState: "released";
    reservedCapacity: Readonly<Record<string, number>>;
  }>;
  resultHash: string;
}

class MemoryEntityStore<T extends AuthoritativeEntity> implements EntityStore<T> {
  constructor(public value: T) {}
  async get(id: string) {
    return id === this.value.id ? { ...this.value } : null;
  }
  async save(next: T, expectedVersion: number) {
    if (this.value.version !== expectedVersion) {
      throw new Error("golden-path optimistic concurrency conflict");
    }
    this.value = { ...next };
  }
}

class MemoryDecisionStore implements DecisionAuthorityStore {
  constructor(public value: AuthoritativeDecision) {}
  async get(id: string) {
    return id === this.value.id ? { ...this.value } : null;
  }
  async save(next: AuthoritativeDecision, expectedVersion: number) {
    if (this.value.version !== expectedVersion) {
      throw new Error("golden-path decision concurrency conflict");
    }
    this.value = { ...next };
  }
}

class MemoryEventStore implements EventStore {
  value: EventRecord | null = null;

  async get(id: string) {
    return this.value?.id === id ? { ...this.value } : null;
  }

  async save(next: EventRecord, expectedVersion: number) {
    if (!this.value || this.value.version !== expectedVersion) {
      throw new Error("golden-path event concurrency conflict");
    }
    this.value = { ...next };
  }

  async create(record: EventRecord) {
    if (this.value) throw new Error("golden-path event already exists");
    this.value = { ...record };
  }
}

class MemoryAudit implements AuditLedger {
  readonly events: AuditEvent[] = [];
  async append(event: AuditEvent) {
    this.events.push(event);
  }
  async listByCorrelationId(correlationId: string) {
    return this.events.filter((event) => event.correlationId === correlationId);
  }
}

function transactionManager<TStores>(
  stores: TStores,
  audit = new MemoryAudit()
): ControlPlaneTransactionManager<TStores> {
  const idempotency = new MemoryIdempotencyStore();
  return {
    run: async (operation) => operation({ stores, audit, idempotency })
  };
}

class MemoryTaskDedupe implements TaskGenerationDedupeStore {
  readonly tasks = new Map<string, GeneratedTask>();
  readonly consumptions = new Map<string, AuthorizationConsumptionRecord>();

  async claim(task: GeneratedTask, consumption: AuthorizationConsumptionRecord) {
    const existing = this.tasks.get(task.logicalKey);
    if (existing) {
      return {
        created: false,
        task: existing,
        consumption: existing.authorizationConsumption
      };
    }
    this.tasks.set(task.logicalKey, task);
    this.consumptions.set(consumption.grantId, consumption);
    return { created: true, task, consumption };
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
        throw new Error("golden-path conflicting authorization consumption");
      }
      return;
    }
    this.consumptions.push(record);
  }

  async listConsumptions(grantId: string) {
    return this.consumptions.filter((record) => record.grantId === grantId);
  }

  async revoke() {}
}

class MutableVerificationReceiptStore implements VerificationReceiptStore {
  readonly receipts = new Map<string, VerificationReceipt>();

  add(receipt: VerificationReceipt) {
    this.receipts.set(receipt.id, receipt);
  }

  async getReceipt(id: string) {
    return this.receipts.get(id) ?? null;
  }
}

class MutableExecutionBridgeStore implements JobExecutionBridgeStore {
  readonly starts = new Map<string, JobVerifiedStartFact>();
  readonly completions = new Map<string, JobVerifiedCompletionFact>();

  addStart(fact: JobVerifiedStartFact) {
    this.starts.set(fact.id, fact);
  }

  addCompletion(fact: JobVerifiedCompletionFact) {
    this.completions.set(fact.id, fact);
  }

  async getStartFact(id: string) {
    return this.starts.get(id) ?? null;
  }

  async getCompletionFact(id: string) {
    return this.completions.get(id) ?? null;
  }
}

function stage(
  name: GoldenPathStageName,
  artifactId: string,
  artifactHash: string
): GoldenPathStage {
  return Object.freeze({ name, status: "passed", artifactId, artifactHash });
}

function planCandidate() {
  return {
    id: "golden-plan-1",
    proposalVersion: 1,
    scope: {
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging",
      dataClass: "internal"
    },
    source: {
      type: "objective",
      objectiveId: "golden-objective-1"
    },
    objective: {
      id: "golden-objective-1",
      metric: "deterministic-jobs-completed",
      target: 1
    },
    evidence: [{
      id: "golden-evidence-1",
      kind: "fact",
      source: "golden-path-harness",
      observedAt: "2026-09-20T22:00:00Z"
    }],
    assumptions: ["The deterministic simulation resource remains healthy"],
    planDependencies: [],
    requestedCapabilities: ["compute.cpu.light"],
    expectedOutcomes: [{
      metric: "deterministic-jobs-completed",
      target: 1,
      description: "One approved deterministic compute job completes and verifies"
    }],
    estimatedCostCents: 25,
    risk: {
      level: "medium",
      summary: "Bounded deterministic compute simulation",
      blastRadius: "single-object"
    },
    rollback: {
      strategy: "none",
      cancellationAllowed: true
    },
    verificationRequirements: [{
      id: "golden-plan-verify",
      description: "Verify the deterministic job completes",
      kind: "state",
      required: true
    }],
    steps: [{
      id: "golden-step-1",
      title: "Run bounded compute work",
      reason: "Exercise the complete governed execution path",
      evidenceIds: ["golden-evidence-1"],
      dependsOn: [],
      conflictsWith: [],
      capabilityRequests: [{
        capability: "compute.cpu.light",
        input: {
          companyId: "company-a",
          workloadId: "golden-workload-1",
          environment: "staging",
          dataClass: "internal",
          cpuCores: 2,
          memoryMb: 2048,
          durationSeconds: 120,
          workloadType: "batch-transform"
        }
      }],
      preconditions: [{
        key: "resource.capacity.available",
        operator: "equals",
        expected: true
      }],
      effects: [{
        key: "golden.workload.completed",
        operation: "set",
        value: true
      }],
      expectedOutcome: "Bounded deterministic compute workload completes",
      estimatedCostCents: 25,
      risk: {
        level: "medium",
        summary: "Bounded compute action",
        blastRadius: "single-object"
      },
      rollback: {
        strategy: "none",
        cancellationAllowed: true
      },
      verificationRequirements: [{
        id: "golden-step-verify",
        description: "Independent execution verification",
        kind: "independent-check",
        required: true
      }],
      resourceRequirements: {
        compute: {
          cpuCores: 2,
          memoryMb: 2048,
          architecture: "amd64"
        },
        execution: {
          environment: "staging",
          priority: 80,
          expectedDurationSeconds: 120,
          checkpointable: true,
          retryable: true
        },
        reliability: {
          minimumTier: "standard",
          fallbackRequired: false,
          maxInterruptionClass: "brief"
        },
        data: {
          classification: "internal",
          customerData: false,
          allowedRegions: ["us-west"],
          localityPreference: "sacramento"
        },
        economics: {
          maxJobCostCents: 50
        },
        credentialBindingRequired: false
      }
    }],
    createdAt: "2026-09-20T22:00:00Z"
  };
}

function verificationSource(
  strategy: "resource-start" | "execution",
  sourceId: string,
  independenceDomain: string
) {
  return createVerificationSourceBinding({
    id: `golden-source-${strategy}`,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    sourceType: "system-probe",
    sourceId,
    allowedStrategies: [strategy],
    independenceDomain,
    status: "active",
    validFrom: "2026-09-20T21:00:00Z",
    expiresAt: "2026-09-20T23:00:00Z"
  });
}

export async function runDeterministicGoldenPath(): Promise<GoldenPathSimulationResult> {
  const stages: GoldenPathStage[] = [];
  const objective: Objective = Object.freeze({
    id: "golden-objective-1",
    scopeId: "company-a",
    metric: "deterministic-jobs-completed",
    direction: "increase",
    target: 1,
    priority: 100,
    status: "active"
  });
  if (activeObjectives([objective]).length !== 1 || detectObjectiveConflicts([objective]).length !== 0) {
    throw new Error("Golden-path objective is not active and conflict-free");
  }
  stages.push(stage("objective", objective.id, sha256Hex(objective)));

  const requestContext = createRequestContext({
    actor: { type: "user", id: "owner-a" },
    scope: {
      userId: "owner-a",
      portfolioId: "portfolio-a",
      companyId: "company-a"
    },
    environment: "staging",
    correlationId: "golden-correlation"
  });
  const plan = constructPlanProposal({
    candidate: planCandidate(),
    request: requestContext,
    authorizedSource: { type: "objective", referenceId: objective.id }
  });
  const planHash = hashPlan(plan);
  const step = plan.steps[0];
  const stepHash = hashPlanStep(step);
  stages.push(stage("plan", plan.id, planHash));

  const validationPolicy: PlanValidationPolicy = {
    trustedScope: {
      portfolioId: plan.scope.portfolioId,
      companyId: plan.scope.companyId
    },
    allowedEnvironments: ["staging"],
    allowedDataClasses: ["internal"],
    allowedRegions: ["us-west"],
    maxPlanCostCents: 500,
    maxStepCostCents: 100,
    minimumReliabilityTier: "standard",
    fallbackRequiredForProduction: false,
    fallbackRequiredForCustomerData: false,
    availableCredentialBindings: true
  };
  const attestation = attestPlanValidation(
    plan,
    validationPolicy,
    "2026-09-20T22:00:01Z"
  );
  const validationSnapshot = createValidationSnapshot({
    id: "golden-validation-snapshot",
    policyVersion: CURRENT_POLICY_VERSION,
    environment: "staging",
    configurationVersion: "golden-config-v1",
    evidenceRequirements: {
      health: "not-applicable",
      capacity: "not-applicable",
      credentials: "not-applicable"
    },
    createdAt: "2026-09-20T22:00:01Z",
    expiresAt: "2026-09-20T22:30:00Z"
  });
  const validationReceipt = createValidationReceipt({
    id: "golden-validation-receipt",
    plan,
    attestation,
    snapshot: validationSnapshot,
    validatedAt: "2026-09-20T22:00:02Z",
    expiresAt: "2026-09-20T22:30:00Z"
  });
  stages.push(stage("validation", validationReceipt.id, validationReceipt.receiptHash));

  const scope: TrustedExecutionScope = Object.freeze({
    userId: "owner-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging"
  });
  const capacitySnapshot = createProtectedCapacitySnapshot({
    id: "golden-protected-capacity",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    poolId: "golden-pool",
    capacityClass: "cpu",
    totalUnits: 16,
    committedUnits: 4,
    protectedMinimumFreeUnits: 4,
    requestedUnits: 2,
    observedAt: "2026-09-20T22:00:02Z",
    expiresAt: "2026-09-20T22:20:00Z"
  });

  const policyBase = {
    authenticated: true,
    scopeResolved: true,
    trustedScope: scope,
    capabilities: ["compute.cpu.light"] as const,
    planHash,
    stepHash,
    environment: "staging" as const,
    dataClass: "internal" as const,
    region: "us-west",
    allowedEnvironments: ["staging"] as const,
    allowedDataClasses: ["internal"] as const,
    allowedRegions: ["us-west"] as const,
    poolId: "golden-pool",
    workloadClass: "compute.worker",
    credentialRequirementIds: [] as const,
    capacitySnapshot,
    capacityEvidenceRequired: true,
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: "golden-policy-idempotency",
    killSwitches: [] as const,
    now: Date.parse("2026-09-20T22:00:03Z")
  };
  const preApprovalPolicy = evaluateStepPolicy(policyBase);
  if (preApprovalPolicy.disposition !== "APPROVAL_REQUIRED" || preApprovalPolicy.readyForTaskGeneration) {
    throw new Error("Golden-path compute policy must require approval before task generation");
  }
  stages.push(stage(
    "policy",
    "golden-policy-pre-approval",
    sha256Hex({
      disposition: preApprovalPolicy.disposition,
      rules: preApprovalPolicy.policyRulesHash
    })
  ));

  const decisionStore = new MemoryDecisionStore({
    id: "golden-decision-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    status: "pending",
    version: 1,
    requiresStepUp: false,
    updatedAt: "2026-09-20T22:00:03Z"
  });
  const decisionCommand = createCommandEnvelope({
    commandId: "golden-decision-command",
    actor: { type: "user", id: "owner-a" },
    scope,
    correlationId: "golden-decision-correlation",
    environment: "staging",
    idempotencyKey: "golden-decision-idempotency",
    provenance: "deterministic-golden-path",
    requestedMutation: {
      type: "decision.resolve" as const,
      decisionId: decisionStore.value.id,
      action: "approve" as const
    }
  });
  const decision = await resolveDecision({
    command: decisionCommand,
    transactionManager: transactionManager<DecisionStores>({ decisions: decisionStore }),
    decisionId: decisionStore.value.id,
    action: "approve",
    now: () => new Date("2026-09-20T22:00:04Z")
  });
  stages.push(stage(
    "decision",
    decision.id,
    sha256Hex({ id: decision.id, status: decision.status, version: decision.version })
  ));

  const approvalStore = new MemoryEntityStore<ApprovalRecord>({
    id: "golden-approval-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    state: "pending",
    decisionId: decision.id,
    requirement: "approval",
    version: 1,
    updatedAt: "2026-09-20T22:00:04Z"
  });
  const approvalService = new ApprovalService(
    transactionManager<ApprovalStores>({ approvals: approvalStore }),
    () => new Date("2026-09-20T22:00:05Z")
  );
  const approval = await approvalService.grant(
    approvalStore.value.id,
    createCommandEnvelope({
      commandId: "golden-approval-command",
      actor: { type: "user", id: "owner-a" },
      scope,
      correlationId: "golden-approval-correlation",
      environment: "staging",
      idempotencyKey: "golden-approval-idempotency",
      provenance: "deterministic-golden-path",
      requestedMutation: { type: "approval.grant" }
    }),
    {
      planHash,
      stepHash,
      proofExpiresAt: "2026-09-20T22:30:00Z"
    }
  );
  if (!approval.approvalProof) {
    throw new Error("Golden-path approval service did not create an approval proof");
  }
  stages.push(stage("approval", approval.id, approval.approvalProof.proofHash));

  const policyEvaluation = evaluateStepPolicy({
    ...policyBase,
    approvalProof: approval.approvalProof,
    now: Date.parse("2026-09-20T22:00:06Z")
  });
  if (!policyEvaluation.readyForTaskGeneration) {
    throw new Error("Golden-path policy did not become ready after approval");
  }
  const policySnapshot = createPolicySnapshot({
    id: "golden-policy-snapshot",
    policyVersion: CURRENT_POLICY_VERSION,
    scope,
    planHash,
    stepHash,
    capabilityNames: ["compute.cpu.light"],
    dataClass: "internal",
    region: "us-west",
    allowedEnvironments: ["staging"],
    allowedDataClasses: ["internal"],
    allowedRegions: ["us-west"],
    poolId: "golden-pool",
    workloadClass: "compute.worker",
    killSwitches: [],
    credentialRequirementIds: [],
    capacitySnapshot,
    capacityEvidenceRequired: true,
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: "golden-policy-idempotency",
    resourceRequirements: step.resourceRequirements,
    createdAt: "2026-09-20T22:00:06Z"
  });

  const grant = issueAuthorizationGrant({
    id: "golden-authorization-grant",
    plan,
    stepId: step.id,
    receipt: validationReceipt,
    policySnapshot,
    policyEvaluation,
    actor: { type: "user", id: "owner-a" },
    scope,
    approvalProof: approval.approvalProof,
    issuedAt: "2026-09-20T22:00:07Z",
    expiresAt: "2026-09-20T22:20:00Z"
  });
  stages.push(stage("authorization", grant.id, grant.grantHash));

  const taskGenerator = new TaskGenerator(
    new MemoryTaskDedupe(),
    () => "golden-task-1",
    () => new Date("2026-09-20T22:00:08Z")
  );
  const generated = await taskGenerator.generate({
    plan,
    validationReceipt,
    authorizationGrants: { [step.id]: grant },
    objectiveStatus: "active"
  });
  const task = generated.tasks[0];
  if (generated.status !== "created" || !task) {
    throw new Error("Golden-path task generation did not create exactly one task");
  }
  stages.push(stage("task", task.id, sha256Hex(task)));

  const grantStore = new MemoryGrantStore(grant);
  await grantStore.consume(task.authorizationConsumption);
  const bridgeStore = new MutableExecutionBridgeStore();
  const verificationStore = new MutableVerificationReceiptStore();
  const jobStore = new MemoryEntityStore<JobRecord>({
    id: "golden-job-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    state: "created",
    taskId: task.id,
    attempt: 0,
    verificationEvidenceIds: [],
    version: 1,
    updatedAt: "2026-09-20T22:00:08Z"
  });
  let jobNow = "2026-09-20T22:00:09Z";
  const jobService = new JobService(
    transactionManager<JobStores>({
      jobs: jobStore,
      authorizationGrants: grantStore,
      verificationReceipts: verificationStore,
      executionBridge: bridgeStore
    }),
    () => new Date(jobNow)
  );
  const jobCommand = (suffix: string) => createCommandEnvelope({
    commandId: `golden-job-${suffix}`,
    actor: { type: "system", id: "golden-control-plane" },
    scope,
    correlationId: `golden-job-correlation-${suffix}`,
    environment: "staging",
    idempotencyKey: `golden-job-idempotency-${suffix}`,
    provenance: "deterministic-golden-path",
    requestedMutation: { type: `job.${suffix}` }
  });

  await jobService.queue(
    jobStore.value.id,
    jobCommand("queue"),
    grant,
    task.authorizationConsumption,
    "2026-09-20T22:00:09Z"
  );
  jobNow = "2026-09-20T22:00:10Z";
  const claimedJob = await jobService.claim(
    jobStore.value.id,
    jobCommand("claim"),
    "golden-worker"
  );
  stages.push(stage(
    "job",
    claimedJob.id,
    sha256Hex({
      id: claimedJob.id,
      state: claimedJob.state,
      taskId: claimedJob.taskId,
      attempt: claimedJob.attempt,
      authorizationConsumptionHash: claimedJob.authorizationConsumption?.consumptionHash
    })
  ));

  const placementRequest = createPlacementRequest({
    id: "golden-placement-request",
    source: "control-plane",
    jobAuthorized: true,
    scope,
    jobId: claimedJob.id,
    jobAuthorizationHash: task.authorizationConsumption.consumptionHash,
    requiredCapabilities: ["compute.cpu"],
    compute: { cpuCores: 2, memoryMb: 2048, architecture: "amd64" },
    priority: "high",
    checkpointable: true,
    retryable: true,
    dataClass: "INTERNAL",
    allowedRegions: ["us-west"],
    preferredLocality: "sacramento",
    reliabilityTier: "STANDARD",
    fallbackRequired: false,
    maxJobCostCents: 50,
    idempotencyKey: "golden-placement-idempotency",
    createdAt: "2026-09-20T22:00:10Z",
    expiresAt: "2026-09-20T22:20:00Z"
  });
  const resourceCandidate = createPlacementCandidateSnapshot({
    resourceId: "golden-resource-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environmentPermissions: ["staging"],
    locationClass: "CLOUD",
    region: "us-west",
    reliabilityTier: "HIGH",
    encryptedAtRest: true,
    encryptedInTransit: true,
    fallbackAvailable: true,
    interruptionClass: "NON_INTERRUPTIBLE",
    workloadClass: "compute.worker",
    healthStatus: "healthy",
    healthObservedAt: "2026-09-20T22:00:09Z",
    validatedCapabilities: ["compute.cpu"],
    architecture: "amd64",
    profileExpiresAt: "2026-09-20T22:30:00Z",
    profileHash: "golden-resource-profile",
    availableCapacity: { cpuCores: 8, memoryMb: 16384 },
    capacityObservedAt: "2026-09-20T22:00:09Z",
    capacityExpiresAt: "2026-09-20T22:20:00Z",
    credentialAvailable: true,
    estimatedJobCostCents: 25
  });
  const resourcePolicy: ResourcePolicy = {
    id: "golden-resource-policy",
    allowedEnvironments: ["staging"],
    allowedDataClasses: ["INTERNAL"],
    allowedLocationClasses: ["CLOUD"],
    allowedRegions: ["us-west"],
    minimumReliabilityTier: "STANDARD",
    requireEncryptionAtRest: true,
    requireEncryptionInTransit: true,
    requireFallback: false,
    allowedInterruptionClasses: ["NON_INTERRUPTIBLE"]
  };
  const placementReport = evaluatePlacementCandidates({
    request: placementRequest,
    candidates: [resourceCandidate],
    policy: resourcePolicy,
    now: Date.parse("2026-09-20T22:00:11Z")
  });
  stages.push(stage("placement", placementRequest.id, placementReport.reportHash));

  const governorReport = evaluateCostCapacityGovernor({
    placementReport,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    jobId: claimedJob.id,
    candidates: [{
      resourceId: resourceCandidate.resourceId,
      placementSnapshotHash: resourceCandidate.snapshotHash,
      requestedDurationSeconds: 120,
      economicSnapshot: createCapacityEconomicSnapshot({
        id: "golden-economic-snapshot",
        resourceId: resourceCandidate.resourceId,
        portfolioId: "portfolio-a",
        companyId: "company-a",
        capacityClass: "owned",
        totalUnits: 16,
        usedUnits: 4,
        reservedUnits: 2,
        protectedHeadroomUnits: 2,
        requestedUnits: 2,
        quotaLimitUnits: 32,
        quotaUsedUnits: 4,
        effectiveHourlyCents: 20,
        marginalHourlyCents: 5,
        observedAt: "2026-09-20T22:00:10Z",
        expiresAt: "2026-09-20T22:20:00Z"
      })
    }],
    budget: {
      id: "golden-governor-budget",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      jobId: claimedJob.id,
      hardCapCents: 50,
      approvalAboveCents: 40,
      status: "active"
    },
    now: Date.parse("2026-09-20T22:00:11Z")
  });
  stages.push(stage("governor", governorReport.placementRequestId, governorReport.reportHash));

  const ranking = rankEligibleCandidates({
    placementReport,
    governorReport,
    candidates: [createSchedulerCandidateSnapshot({
      resourceId: resourceCandidate.resourceId,
      placementCandidateSnapshotHash: resourceCandidate.snapshotHash,
      reliabilityTier: "HIGH",
      locality: "sacramento",
      estimatedCostCents: 25,
      startupLatencyMs: 100,
      protectedCapacityImpactPct: 10,
      observedAt: "2026-09-20T22:00:10Z",
      expiresAt: "2026-09-20T22:10:00Z"
    })],
    preferences: {
      weights: {
        reliability: 2,
        locality: 1,
        cost: 1,
        startupLatency: 1,
        protectedCapacityImpact: 1,
        ownerPreference: 1
      },
      preferredLocality: "sacramento",
      ownerPreferredResourceIds: [resourceCandidate.resourceId]
    },
    evaluatedAt: "2026-09-20T22:00:11Z"
  });
  const placementDecision = createPlacementDecision({
    id: "golden-placement-decision",
    request: placementRequest,
    placementReport,
    governorReport,
    rankingReport: ranking,
    decidedAt: "2026-09-20T22:00:12Z"
  });

  const initialLedger = createCapacityLedger({
    id: "golden-capacity-ledger",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    target: { type: "resource", id: placementDecision.selectedResourceId },
    totalCapacity: { cpu: 8, memoryMb: 16384 },
    protectedHeadroom: { cpu: 2, memoryMb: 2048 },
    updatedAt: "2026-09-20T22:00:12Z"
  });
  const reserved = reserveCapacity({
    transactionId: "golden-reserve-txn",
    reservationId: "golden-reservation",
    ledger: initialLedger,
    expectedLedgerRevision: initialLedger.revision,
    authority: reservationAuthorityFromDecision(placementDecision),
    requestedCapacity: { cpu: 2, memoryMb: 2048 },
    idempotencyKey: "golden-reservation-idempotency",
    issuedAt: "2026-09-20T22:00:12Z",
    expiresAt: "2026-09-20T22:10:00Z"
  });
  const allocation = createAllocationRecord({
    id: "golden-allocation",
    reservation: reserved.reservation,
    jobId: claimedJob.id,
    createdAt: "2026-09-20T22:00:13Z",
    now: Date.parse("2026-09-20T22:00:13Z")
  });
  stages.push(stage("reservation", reserved.reservation.id, reserved.reservation.reservationHash));

  const providerId = "golden-provider";
  const dispatchCapability = "compute.cpu.light";
  const secret = createSecretReference({
    id: "golden-secret-ref",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    providerId,
    environment: "staging",
    purpose: "deterministic resource dispatch",
    backendRef: "vault://golden/dispatch",
    status: "active",
    rotationVersion: 1
  });
  const binding = createCredentialBinding({
    id: "golden-credential-binding",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    providerId,
    environment: "staging",
    secretReferenceId: secret.id,
    capabilityNames: [dispatchCapability],
    grantedScopes: ["execute"],
    allowedResourceIds: [placementDecision.selectedResourceId],
    allowedLocationClasses: ["cloud"],
    status: "active"
  });
  const credentialRequest = createCredentialRequest({
    id: "golden-credential-request",
    jobId: claimedJob.id,
    placementRequestId: placementRequest.id,
    scope: { ...scope, resourceId: placementDecision.selectedResourceId },
    resourceId: placementDecision.selectedResourceId,
    resourceState: "ready",
    resourceLocationClass: "cloud",
    providerId,
    capability: dispatchCapability,
    requestedScopes: ["execute"],
    requestedAt: "2026-09-20T22:00:12Z",
    expiresAt: "2026-09-20T22:10:00Z"
  });
  const credentialLease = issueCredentialLease({
    leaseId: "golden-credential-lease",
    request: credentialRequest,
    secret,
    binding,
    deliveryRef: "delivery://golden/credential-lease",
    issuedAt: "2026-09-20T22:00:13Z",
    ttlSeconds: 600
  });
  stages.push(stage("credential-admission", credentialLease.id, credentialLease.leaseHash));

  const dispatchAdmission = createDispatchAdmissionReceipt({
    id: "golden-dispatch-admission",
    decision: placementDecision,
    reservation: reserved.reservation,
    allocation,
    credentialLease,
    governorReport,
    policyRegistry: currentPolicyRegistryReference(),
    killSwitches: [],
    resourceState: "ready",
    environmentPermissions: ["staging"],
    providerId,
    capability: dispatchCapability,
    admittedAt: "2026-09-20T22:00:13Z"
  });
  const dispatch = createDispatchIntent({
    id: "golden-dispatch",
    decision: placementDecision,
    reservation: reserved.reservation,
    allocation,
    credentialLease,
    admissionReceipt: dispatchAdmission,
    adapterId: "golden-resource-adapter",
    adapterVersion: "1.0.0",
    providerId,
    capability: dispatchCapability,
    idempotencyKey: "golden-dispatch-idempotency",
    issuedAt: "2026-09-20T22:00:14Z",
    now: Date.parse("2026-09-20T22:00:14Z")
  });
  const adapterResult = createDispatchAdapterResult({
    source: "resource-adapter",
    dispatchIntentId: dispatch.id,
    dispatchHash: dispatch.dispatchHash,
    adapterId: dispatch.adapterId,
    adapterVersion: dispatch.adapterVersion,
    status: "accepted",
    providerOperationId: "golden-provider-operation",
    executionRef: "golden-provider-execution",
    observedAt: "2026-09-20T22:00:15Z"
  });
  stages.push(stage("dispatch-admission", dispatchAdmission.id, dispatchAdmission.receiptHash));

  const startRequest = createStartVerificationRequest({
    id: "golden-start-request",
    dispatch,
    requestedAt: "2026-09-20T22:00:15Z",
    expiresAt: "2026-09-20T22:05:00Z",
    maxEvidenceAgeSeconds: 120
  });
  const startEvidence = createVerificationEvidence({
    id: "golden-start-evidence",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    subject: startRequest.subject,
    strategy: "resource-start",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "golden-start-probe",
    independenceKey: "golden-start-independent-domain",
    observedAt: "2026-09-20T22:00:16Z",
    payloadHash: sha256Hex({ allocationId: allocation.id, process: "running" }),
    provenance: "deterministic-golden-path"
  });
  const startReceipt = resolveVerificationRequest(startRequest, [startEvidence], {
    receiptId: "golden-start-receipt",
    verifiedAt: "2026-09-20T22:00:17Z",
    receiptTtlSeconds: 120
  });
  const startTrust = createVerificationTrustAttestation({
    id: "golden-start-trust",
    request: startRequest,
    receipt: startReceipt,
    evidence: [startEvidence],
    sourceBindings: [verificationSource(
      "resource-start",
      "golden-start-probe",
      "golden-start-independent-domain"
    )],
    scope,
    attestedAt: "2026-09-20T22:00:17Z"
  });
  const runningPlacement = createVerifiedRunningPlacement({
    id: "golden-running-placement",
    decision: placementDecision,
    reservation: reserved.reservation,
    allocation,
    dispatch,
    adapterResult,
    verificationRequest: startRequest,
    verificationReceipt: startReceipt,
    verificationTrustAttestation: startTrust,
    scope,
    now: Date.parse("2026-09-20T22:00:17Z")
  });
  stages.push(stage("start-verification", runningPlacement.id, runningPlacement.recordHash));

  const startFact = createJobVerifiedStartFact({
    id: "golden-job-start-fact",
    runningPlacement,
    scope,
    issuedAt: "2026-09-20T22:00:18Z",
    expiresAt: "2026-09-20T22:10:00Z"
  });
  bridgeStore.addStart(startFact);
  jobNow = "2026-09-20T22:00:19Z";
  const executingJob = await jobService.start(
    claimedJob.id,
    jobCommand("start"),
    startFact.id
  );
  stages.push(stage(
    "job-executing",
    executingJob.id,
    sha256Hex({
      id: executingJob.id,
      state: executingJob.state,
      verifiedStartFactHash: executingJob.verifiedStartFactHash,
      verifiedRunningPlacementHash: executingJob.verifiedRunningPlacementHash
    })
  ));

  const completionRequest = createCompletionVerificationRequest({
    id: "golden-completion-request",
    runningPlacement,
    requestedAt: "2026-09-20T22:02:00Z",
    expiresAt: "2026-09-20T22:05:00Z",
    maxEvidenceAgeSeconds: 120
  });
  const completionEvidence = createVerificationEvidence({
    id: "golden-completion-evidence",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    subject: completionRequest.subject,
    strategy: "execution",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "golden-completion-probe",
    independenceKey: "golden-completion-independent-domain",
    observedAt: "2026-09-20T22:02:01Z",
    payloadHash: sha256Hex({ allocationId: allocation.id, exitCode: 0 }),
    provenance: "deterministic-golden-path"
  });
  const completionReceipt = resolveVerificationRequest(
    completionRequest,
    [completionEvidence],
    {
      receiptId: "golden-completion-receipt",
      verifiedAt: "2026-09-20T22:02:02Z",
      receiptTtlSeconds: 120
    }
  );
  const completionTrust = createVerificationTrustAttestation({
    id: "golden-completion-trust",
    request: completionRequest,
    receipt: completionReceipt,
    evidence: [completionEvidence],
    sourceBindings: [verificationSource(
      "execution",
      "golden-completion-probe",
      "golden-completion-independent-domain"
    )],
    scope,
    attestedAt: "2026-09-20T22:02:02Z"
  });
  const verifiedCompletion = createVerifiedPlacementCompletion({
    id: "golden-verified-completion",
    runningPlacement,
    verificationRequest: completionRequest,
    verificationReceipt: completionReceipt,
    verificationTrustAttestation: completionTrust,
    scope,
    now: Date.parse("2026-09-20T22:02:02Z")
  });
  const completionFact = createJobVerifiedCompletionFact({
    id: "golden-job-completion-fact",
    runningPlacement,
    completion: verifiedCompletion,
    scope,
    bridgedAt: "2026-09-20T22:02:03Z"
  });
  bridgeStore.addCompletion(completionFact);
  jobNow = "2026-09-20T22:02:04Z";
  const providerCompletedJob = await jobService.recordProviderCompletion(
    executingJob.id,
    jobCommand("provider-completed"),
    {
      providerResultId: "golden-provider-operation",
      providerResultHash: verifiedCompletion.recordHash,
      completedAt: "2026-09-20T22:02:03Z",
      verifiedCompletionFactId: completionFact.id
    }
  );
  stages.push(stage(
    "provider-completed",
    providerCompletedJob.id,
    sha256Hex({
      id: providerCompletedJob.id,
      state: providerCompletedJob.state,
      providerResultHash: providerCompletedJob.providerResultHash,
      verifiedCompletionFactHash: providerCompletedJob.verifiedCompletionFactHash
    })
  ));

  await jobService.beginVerification(
    providerCompletedJob.id,
    jobCommand("verification-begin")
  );

  const jobVerificationRequest = createJobCompletionVerificationRequest({
    id: "golden-job-verification-request",
    fact: completionFact,
    scope,
    requestedAt: "2026-09-20T22:02:04Z",
    expiresAt: "2026-09-20T22:10:00Z",
    maxEvidenceAgeSeconds: 300
  });
  const jobVerificationEvidence = createJobCompletionVerificationEvidence({
    id: "golden-job-verification-evidence",
    fact: completionFact,
    request: jobVerificationRequest,
    scope,
    observedAt: "2026-09-20T22:02:05Z"
  });
  const jobVerificationReceipt = resolveVerificationRequest(
    jobVerificationRequest,
    [jobVerificationEvidence],
    {
      receiptId: "golden-job-verification-receipt",
      verifiedAt: "2026-09-20T22:02:06Z",
      receiptTtlSeconds: 600
    }
  );
  verificationStore.add(jobVerificationReceipt);
  jobNow = "2026-09-20T22:02:07Z";
  const verifiedJob = await jobService.verify(
    providerCompletedJob.id,
    jobCommand("verify"),
    jobVerificationReceipt.id
  );
  stages.push(stage(
    "completion-verification",
    verifiedCompletion.id,
    sha256Hex({
      completionHash: verifiedCompletion.recordHash,
      completionFactHash: completionFact.factHash,
      jobVerificationReceiptHash: jobVerificationReceipt.receiptHash,
      jobState: verifiedJob.state
    })
  ));

  const outcomeStore = new MemoryEntityStore<OutcomeRecord>({
    id: "golden-outcome-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    state: "recorded",
    objectiveId: objective.id,
    taskId: task.id,
    jobId: verifiedJob.id,
    metric: "deterministic-jobs-completed",
    value: 1,
    evidenceIds: [],
    version: 1,
    updatedAt: "2026-09-20T22:02:07Z"
  });
  const outcomeRequest = createVerificationRequest({
    id: "golden-outcome-request",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    subject: { type: "outcome", id: outcomeStore.value.id },
    strategies: ["business"],
    requiresIndependentEvidence: false,
    maxEvidenceAgeSeconds: 3_000_000_000,
    requestedAt: "2026-09-20T22:02:08Z",
    expiresAt: "2099-01-01T00:00:00Z"
  });
  const outcomeEvidence = createVerificationEvidence({
    id: "golden-outcome-evidence",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    subject: outcomeRequest.subject,
    strategy: "business",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "golden-outcome-verifier",
    independenceKey: "golden-outcome-domain",
    observedAt: "2026-09-20T22:02:09Z",
    payloadHash: jobVerificationReceipt.receiptHash,
    provenance: "deterministic-golden-path"
  });
  const outcomeReceipt = resolveVerificationRequest(
    outcomeRequest,
    [outcomeEvidence],
    {
      receiptId: "golden-outcome-receipt",
      verifiedAt: "2026-09-20T22:02:10Z",
      receiptTtlSeconds: 2_000_000_000
    }
  );
  verificationStore.add(outcomeReceipt);
  const outcomeService = new OutcomeService(transactionManager<OutcomeStores>({
    outcomes: outcomeStore,
    verificationReceipts: verificationStore
  }));
  const verifiedOutcome = await outcomeService.verify(
    outcomeStore.value.id,
    createCommandEnvelope({
      commandId: "golden-outcome-command",
      actor: { type: "system", id: "golden-control-plane" },
      scope,
      correlationId: "golden-outcome-correlation",
      environment: "staging",
      idempotencyKey: "golden-outcome-idempotency",
      provenance: "deterministic-golden-path",
      requestedMutation: { type: "outcome.verify" }
    }),
    outcomeReceipt.id
  );
  stages.push(stage("outcome", verifiedOutcome.id, outcomeReceipt.receiptHash));

  const eventStore = new MemoryEventStore();
  const eventAudit = new MemoryAudit();
  const eventService = new EventService(transactionManager<EventStores>({
    events: eventStore
  }, eventAudit));
  const eventCommand = (suffix: string) => createCommandEnvelope({
    commandId: `golden-event-${suffix}`,
    actor: { type: "system", id: "golden-control-plane" },
    scope,
    correlationId: `golden-event-correlation-${suffix}`,
    environment: "staging",
    idempotencyKey: `golden-event-idempotency-${suffix}`,
    provenance: "deterministic-golden-path",
    requestedMutation: { type: `event.${suffix}` }
  });
  await eventService.record({
    id: "golden-event-1",
    eventType: "outcome.verified",
    source: "control-plane",
    provenance: `outcome:${verifiedOutcome.id}`,
    payloadHash: outcomeReceipt.receiptHash,
    subjectType: "outcome",
    subjectId: verifiedOutcome.id,
    evidenceIds: [outcomeReceipt.id],
    recordedAt: "2026-09-20T22:02:11Z"
  }, eventCommand("record"));
  await eventService.accept("golden-event-1", eventCommand("accept"));
  await eventService.beginProcessing("golden-event-1", eventCommand("process"));
  const processedEvent = await eventService.markProcessed(
    "golden-event-1",
    eventCommand("processed"),
    [outcomeReceipt.id]
  );
  const auditEventTypes = eventAudit.events.map((event) => event.eventType);
  stages.push(stage(
    "event-audit",
    processedEvent.id,
    sha256Hex({
      eventId: processedEvent.id,
      state: processedEvent.state,
      auditEventTypes
    })
  ));

  const ownerJobView = toJobResultView(verifiedJob);
  stages.push(stage(
    "owner-visibility",
    ownerJobView.jobId,
    sha256Hex(ownerJobView)
  ));

  const memory = createOperationalMemory({
    id: "golden-memory-1",
    kind: "outcome-reference",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    outcomeId: verifiedOutcome.id,
    metric: verifiedOutcome.metric,
    value: verifiedOutcome.value,
    confidence: 1,
    sampleSize: 1,
    confounders: [],
    evidenceIds: [outcomeReceipt.id],
    relevanceTags: ["golden-path", "verified-outcome"],
    observedAt: "2026-09-20T22:02:11Z",
    sensitivity: "internal"
  });
  stages.push(stage("memory", memory.id, memory.recordHash));

  const released = releaseVerifiedPlacement({
    transactionId: "golden-release-txn",
    ledger: reserved.ledger,
    expectedLedgerRevision: reserved.ledger.revision,
    reservation: reserved.reservation,
    completion: verifiedCompletion,
    runningPlacement,
    releasedAt: "2026-09-20T22:02:12Z"
  });
  const releasedCredential = releaseCredentialLease(
    credentialLease,
    "2026-09-20T22:02:12Z"
  );
  stages.push(stage(
    "resource-release",
    released.reservation.id,
    released.commit?.commitHash ?? released.reservation.reservationHash
  ));

  const final = Object.freeze({
    jobState: verifiedJob.state as "verified",
    outcomeState: verifiedOutcome.state as "verified",
    eventState: processedEvent.state as "processed",
    ownerVisibleJobState: ownerJobView.state as "verified",
    auditEventCount: eventAudit.events.length,
    memoryAuthority: memory.authority as "advisory",
    reservationState: released.reservation.state as "released",
    credentialState: releasedCredential.status as "released",
    reservedCapacity: Object.freeze({ ...released.ledger.reservedCapacity })
  });
  const base = {
    harnessVersion: GOLDEN_PATH_HARNESS_VERSION,
    simulationOnly: true as const,
    productionExecutionClaimed: false as const,
    stages: Object.freeze(stages),
    final
  };
  return Object.freeze({ ...base, resultHash: sha256Hex(base) });
}
