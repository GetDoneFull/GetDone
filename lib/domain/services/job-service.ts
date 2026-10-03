import { ControlPlaneError } from "@/lib/control-plane/errors";
import { commandFingerprint, type AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import {
  assertAuthorizationConsumption,
  assertAuthorizationGrantEnvelope,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import { createAuditEvent } from "@/lib/domain/audit";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { claimIdempotency } from "@/lib/domain/idempotency";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";
import {
  requireAuthoritativeVerificationReceipt,
  type VerificationReceipt,
  type VerificationReceiptStore
} from "@/lib/verification/verification";
import {
  assertJobVerifiedCompletionFact,
  assertJobVerifiedStartFact,
  type JobExecutionBridgeStore,
  type JobVerifiedCompletionFact,
  type JobVerifiedStartFact
} from "@/lib/domain/services/job-execution-bridge";

export type JobState =
  | "created"
  | "queued"
  | "claimed"
  | "executing"
  | "provider_completed"
  | "verifying"
  | "verified"
  | "failed"
  | "blocked"
  | "cancelled"
  // Legacy persisted states are read-compatible only. New transitions do not emit them.
  | "running"
  | "succeeded"
  | "uncertain";

export interface JobRecord extends StatefulEntity {
  state: JobState;
  taskId: string;
  dependencyJobIds?: readonly string[];
  workerId?: string;
  attempt: number;
  maxAttempts?: number;
  lastRetryAt?: string;
  lastTimeoutAt?: string;
  retryReason?: string;
  authorizationGrantId?: string;
  authorizationGrantHash?: string;
  authorizationDisposition?: AuthorizationGrant["disposition"];
  capabilityNames?: readonly string[];
  policySnapshotId?: string;
  policySnapshotHash?: string;
  policyVersion?: string;
  policyEngineVersion?: string;
  policyRulesHash?: string;
  decisionId?: string;
  authorizationConsumption?: AuthorizationConsumptionRecord;
  verificationEvidenceIds: readonly string[];
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  verifiedStartFactId?: string;
  verifiedStartFactHash?: string;
  verifiedRunningPlacementId?: string;
  verifiedRunningPlacementHash?: string;
  verifiedCompletionFactId?: string;
  verifiedCompletionFactHash?: string;
  providerResultId?: string;
  providerResultHash?: string;
  providerCompletedAt?: string;
  failureReason?: string;
}

export interface JobStore extends EntityStore<JobRecord> {
  create?(record: JobRecord): Promise<void>;
}

export interface JobStores {
  jobs: JobStore;
  authorizationGrants?: AuthorizationGrantStore;
  verificationReceipts?: VerificationReceiptStore;
  executionBridge?: JobExecutionBridgeStore;
}

export interface CreateJobInput {
  id: string;
  taskId: string;
  dependencyJobIds?: readonly string[];
  maxAttempts?: number;
  createdAt?: string;
}

async function assertJobDependenciesReady(store: EntityStore<JobRecord>, current: JobRecord) {
  for (const dependencyId of current.dependencyJobIds ?? []) {
    if (dependencyId === current.id) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Job cannot depend on itself");
    }
    const dependency = await store.get(dependencyId);
    if (
      !dependency
      || dependency.portfolioId !== current.portfolioId
      || dependency.companyId !== current.companyId
      || !["verified", "succeeded"].includes(dependency.state)
    ) {
      throw new ControlPlaneError(
        "CONFLICT",
        `Job dependency is not authoritatively succeeded: ${dependencyId}`
      );
    }
  }
}

export class JobService {
  constructor(
    private readonly transactions: ControlPlaneTransactionManager<JobStores>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async create(input: CreateJobInput, command: AuthoritativeCommandEnvelope) {
    if (!input.id || !input.taskId) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Job creation requires id and parent taskId");
    }
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Job maxAttempts must be a positive integer");
    }
    const dependencyJobIds = [...new Set(input.dependencyJobIds ?? [])];
    if (dependencyJobIds.includes(input.id)) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Job cannot depend on itself");
    }
    const createdAt = input.createdAt ?? this.now().toISOString();
    const fingerprint = commandFingerprint(command);

    return this.transactions.run(async (transaction) => {
      const claim = await claimIdempotency<JobRecord>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint,
        new Date(createdAt)
      );
      if (claim.state === "COMPLETED" && claim.record.result) return claim.record.result;
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError("CONFLICT", "Job creation is already in progress or previously failed");
      }
      const create = transaction.stores.jobs.create;
      if (!create) {
        throw new ControlPlaneError("UNAVAILABLE", "Job store does not support authoritative creation");
      }
      const record: JobRecord = Object.freeze({
        id: input.id,
        correlationId: command.correlationId,
        portfolioId: command.scope.portfolioId,
        companyId: command.scope.companyId,
        state: "created",
        taskId: input.taskId,
        dependencyJobIds: Object.freeze(dependencyJobIds),
        attempt: 0,
        maxAttempts,
        verificationEvidenceIds: Object.freeze([]),
        version: 1,
        updatedAt: createdAt
      });
      await create.call(transaction.stores.jobs, record);
      await transaction.audit.append(createAuditEvent({
        correlationId: command.correlationId,
        eventType: "job.created",
        actor: command.actor,
        scope: {
          userId: command.scope.userId,
          portfolioId: command.scope.portfolioId,
          companyId: command.scope.companyId,
          resourceId: command.scope.resourceId
        },
        environment: command.environment,
        entityType: "job",
        entityId: record.id,
        newState: "created",
        provenance: command.provenance,
        metadata: {
          commandId: command.commandId,
          taskId: record.taskId,
          dependencyCount: dependencyJobIds.length,
          maxAttempts
        }
      }));
      await transaction.idempotency.complete(command.idempotencyKey, fingerprint, record, createdAt);
      return record;
    });
  }

  queue(
    id: string,
    command: AuthoritativeCommandEnvelope,
    grant: AuthorizationGrant,
    taskConsumption: AuthorizationConsumptionRecord,
    admittedAt = new Date().toISOString()
  ) {
    assertAuthorizationGrantEnvelope(grant, command.scope, Date.parse(admittedAt));
    assertAuthorizationConsumption(taskConsumption, grant);

    if (taskConsumption.consumerType !== "task") {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Jobs must inherit authorization from an already-authorized Task"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "job-queued",
      patch: async (current, transaction) => {
        await assertJobDependenciesReady(transaction.stores.jobs, current);
        if (taskConsumption.consumerId !== current.taskId) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authorization consumption belongs to a different parent Task"
          );
        }

        const grantStore = transaction.stores.authorizationGrants;
        if (!grantStore) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authorization grant store is required before a job can be queued"
          );
        }

        const persistedGrant = await grantStore.get(grant.id);
        if (!persistedGrant || persistedGrant.grantHash !== grant.grantHash) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authorization grant is missing or differs from authoritative storage"
          );
        }
        assertAuthorizationGrantEnvelope(
          persistedGrant,
          command.scope,
          Date.parse(admittedAt)
        );

        const persistedConsumptions = await grantStore.listConsumptions(grant.id);
        const persistedTaskConsumption = persistedConsumptions.find(
          (record) =>
            record.consumerType === "task"
            && record.consumerId === current.taskId
            && record.consumptionHash === taskConsumption.consumptionHash
        );
        if (!persistedTaskConsumption) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Parent Task authorization consumption is not authoritative"
          );
        }

        return {
          authorizationGrantId: grant.id,
          authorizationGrantHash: grant.grantHash,
          authorizationConsumption: persistedTaskConsumption
        };
      },
      metadata: () => ({
        authorizationGrantId: grant.id,
        inheritedTaskConsumptionHash: taskConsumption.consumptionHash
      })
    });
  }

  claim(id: string, command: AuthoritativeCommandEnvelope, workerId: string) {
    if (!workerId) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Worker identity is required");
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "claimed",
      command,
      triggeringEvent: "job-claimed",
      patch: (current) => {
        if (!current.authorizationConsumption) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Job cannot be claimed without inherited authoritative Task authorization"
          );
        }
        if (current.workerId) {
          throw new ControlPlaneError("CONFLICT", "Job already has an active authoritative worker claim");
        }
        if (current.attempt >= (current.maxAttempts ?? 5)) {
          throw new ControlPlaneError("CONFLICT", "Job attempt limit is exhausted");
        }
        return { workerId, attempt: current.attempt + 1 };
      },
      metadata: (current) => ({ workerId, attempt: current.attempt + 1 })
    });
  }

  releaseClaim(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "job-claim-released",
      patch: () => ({ workerId: undefined })
    });
  }

  retry(
    id: string,
    command: AuthoritativeCommandEnvelope,
    reason: string,
    retriedAt = this.now().toISOString()
  ) {
    if (!reason) throw new ControlPlaneError("VALIDATION_FAILED", "Job retry requires a reason");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "job-retried",
      beforeTransition: async (current, transaction) => {
        if (!current.authorizationConsumption) {
          throw new ControlPlaneError("FORBIDDEN", "Job retry requires authoritative Task authorization");
        }
        if (current.attempt >= (current.maxAttempts ?? 5)) {
          throw new ControlPlaneError("CONFLICT", "Job attempt limit is exhausted");
        }
        await assertJobDependenciesReady(transaction.stores.jobs, current);
      },
      patch: () => ({
        workerId: undefined,
        retryReason: reason,
        lastRetryAt: retriedAt,
        failureReason: undefined,
        verificationEvidenceIds: [],
        verificationReceiptId: undefined,
        verificationReceiptHash: undefined,
        verifiedStartFactId: undefined,
        verifiedStartFactHash: undefined,
        verifiedRunningPlacementId: undefined,
        verifiedRunningPlacementHash: undefined,
        verifiedCompletionFactId: undefined,
        verifiedCompletionFactHash: undefined,
        providerResultId: undefined,
        providerResultHash: undefined,
        providerCompletedAt: undefined
      }),
      metadata: () => ({ reason, retriedAt }),
      now: () => new Date(retriedAt)
    });
  }

  recoverTimeout(
    id: string,
    command: AuthoritativeCommandEnvelope,
    timedOutAt = this.now().toISOString()
  ) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "job-timeout-recovered",
      beforeTransition: async (current, transaction) => {
        if (!current.authorizationConsumption) {
          throw new ControlPlaneError("FORBIDDEN", "Job timeout recovery requires authoritative Task authorization");
        }
        if (current.attempt >= (current.maxAttempts ?? 5)) {
          throw new ControlPlaneError("CONFLICT", "Job attempt limit is exhausted");
        }
        await assertJobDependenciesReady(transaction.stores.jobs, current);
      },
      patch: () => ({
        workerId: undefined,
        retryReason: "execution-timeout",
        lastTimeoutAt: timedOutAt,
        lastRetryAt: timedOutAt,
        verifiedStartFactId: undefined,
        verifiedStartFactHash: undefined,
        verifiedRunningPlacementId: undefined,
        verifiedRunningPlacementHash: undefined,
        verifiedCompletionFactId: undefined,
        verifiedCompletionFactHash: undefined,
        providerResultId: undefined,
        providerResultHash: undefined,
        providerCompletedAt: undefined
      }),
      metadata: () => ({ timedOutAt }),
      now: () => new Date(timedOutAt)
    });
  }

  startProviderExecution(
    id: string,
    command: AuthoritativeCommandEnvelope,
    workerId: string
  ) {
    if (!workerId) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Worker identity is required");
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "executing",
      command,
      triggeringEvent: "job-provider-execution-started",
      beforeTransition: (current) => {
        if (current.workerId !== workerId) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Provider execution worker does not hold the authoritative Job claim"
          );
        }
        if (!current.authorizationConsumption) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Provider execution requires inherited authoritative Task authorization"
          );
        }
      },
      metadata: () => ({ workerId }),
      now: this.now
    });
  }

  start(
    id: string,
    command: AuthoritativeCommandEnvelope,
    verifiedStartFactId: string
  ) {
    let startFact: JobVerifiedStartFact | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "executing",
      command,
      triggeringEvent: "job-started-from-verified-resource-start",
      beforeTransition: async (current, transaction) => {
        if (!current.workerId) {
          throw new ControlPlaneError(
            "CONFLICT",
            "A claimed worker is required before job start"
          );
        }
        if (!current.authorizationConsumption) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Job authorization lineage is missing"
          );
        }

        const bridge = transaction.stores.executionBridge;
        if (!bridge) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verified-start bridge storage is required before Job start"
          );
        }
        const persisted = await bridge.getStartFact(verifiedStartFactId);
        if (!persisted) {
          throw new ControlPlaneError(
            "NOT_FOUND",
            "Authoritative verified-start fact was not found"
          );
        }
        startFact = assertJobVerifiedStartFact(persisted, {
          jobId: id,
          scope: command.scope,
          now: this.now().getTime()
        });
      },
      patch: () => {
        if (!startFact) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Verified resource-start authority is unavailable"
          );
        }
        return {
          verifiedStartFactId: startFact.id,
          verifiedStartFactHash: startFact.factHash,
          verifiedRunningPlacementId: startFact.runningPlacementId,
          verifiedRunningPlacementHash: startFact.runningPlacementHash
        };
      },
      metadata: () => ({
        verifiedStartFactId,
        verifiedStartFactHash: startFact?.factHash ?? null
      })
    });
  }

  recordProviderCompletion(
    id: string,
    command: AuthoritativeCommandEnvelope,
    input: {
      providerResultId: string;
      providerResultHash: string;
      completedAt?: string;
      verifiedCompletionFactId?: string;
    }
  ) {
    if (!input.providerResultId || !input.providerResultHash) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Provider completion requires a durable provider result id and hash"
      );
    }

    let completionFact: JobVerifiedCompletionFact | undefined;
    const completedAt = input.completedAt ?? this.now().toISOString();

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "provider_completed",
      command,
      triggeringEvent: "job-provider-completed",
      beforeTransition: async (current, transaction) => {
        if (!current.workerId) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Provider completion requires an executing Job with an authoritative worker claim"
          );
        }

        if (!input.verifiedCompletionFactId) return;
        if (!current.verifiedRunningPlacementId || !current.verifiedRunningPlacementHash) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Verified resource completion requires verified running-placement lineage"
          );
        }
        const bridge = transaction.stores.executionBridge;
        if (!bridge) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verified-completion bridge storage is unavailable"
          );
        }
        const persisted = await bridge.getCompletionFact(input.verifiedCompletionFactId);
        if (!persisted) {
          throw new ControlPlaneError(
            "NOT_FOUND",
            "Authoritative verified-completion fact was not found"
          );
        }
        completionFact = assertJobVerifiedCompletionFact(persisted, {
          jobId: id,
          scope: command.scope,
          runningPlacementId: current.verifiedRunningPlacementId,
          runningPlacementHash: current.verifiedRunningPlacementHash,
          now: this.now().getTime()
        });
      },
      patch: () => ({
        providerResultId: input.providerResultId,
        providerResultHash: input.providerResultHash,
        providerCompletedAt: completedAt,
        ...(completionFact ? {
          verifiedCompletionFactId: completionFact.id,
          verifiedCompletionFactHash: completionFact.factHash
        } : {})
      }),
      metadata: () => ({
        providerResultId: input.providerResultId,
        providerResultHash: input.providerResultHash,
        verifiedCompletionFactId: completionFact?.id ?? null
      }),
      now: () => new Date(completedAt)
    });
  }

  beginVerification(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "verifying",
      command,
      triggeringEvent: "job-verification-started-from-verified-resource-completion",
      beforeTransition: (current) => {
        if (!current.providerResultId || !current.providerResultHash || !current.providerCompletedAt) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Job verification requires persisted provider-completion lineage"
          );
        }
      },
      now: this.now
    });
  }

  verify(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    let receipt: VerificationReceipt | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "verified",
      command,
      triggeringEvent: "job-verified",
      beforeTransition: async (_current, transaction) => {
        const store = transaction.stores.verificationReceipts;
        if (!store) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verification receipt storage is required for Job success"
          );
        }
        receipt = await requireAuthoritativeVerificationReceipt(store, receiptId, {
          scope: command.scope,
          subject: { type: "job", id },
          now: this.now().getTime(),
          allowedVerdicts: ["verified"]
        });
      },
      patch: () => {
        if (!receipt) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authoritative Job verification receipt is unavailable"
          );
        }
        return {
          verificationEvidenceIds: [...receipt.evidenceIds],
          verificationReceiptId: receipt.id,
          verificationReceiptHash: receipt.receiptHash
        };
      },
      metadata: () => ({ verificationReceiptId: receiptId })
    });
  }

  succeed(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    return this.verify(id, command, receiptId);
  }

  markUncertain(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    let receipt: VerificationReceipt | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "blocked",
      command,
      triggeringEvent: "job-verification-blocked",
      beforeTransition: async (_current, transaction) => {
        const store = transaction.stores.verificationReceipts;
        if (!store) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verification receipt storage is required for uncertain Job truth"
          );
        }
        receipt = await requireAuthoritativeVerificationReceipt(store, receiptId, {
          scope: command.scope,
          subject: { type: "job", id },
          now: this.now().getTime(),
          allowedVerdicts: ["uncertain"]
        });
      },
      patch: () => {
        if (!receipt) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authoritative Job verification receipt is unavailable"
          );
        }
        return {
          verificationEvidenceIds: [...receipt.evidenceIds],
          verificationReceiptId: receipt.id,
          verificationReceiptHash: receipt.receiptHash,
          failureReason: "Verification is uncertain; additional evidence or owner input is required"
        };
      },
      metadata: () => ({ verificationReceiptId: receiptId })
    });
  }

  failVerification(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string,
    failureReason: string
  ) {
    if (!failureReason) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Verification failure requires a reason");
    }
    let receipt: VerificationReceipt | undefined;
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "failed",
      command,
      triggeringEvent: "job-verification-failed",
      beforeTransition: async (_current, transaction) => {
        const store = transaction.stores.verificationReceipts;
        if (!store) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verification receipt storage is required for verification failure"
          );
        }
        receipt = await requireAuthoritativeVerificationReceipt(store, receiptId, {
          scope: command.scope,
          subject: { type: "job", id },
          now: this.now().getTime(),
          allowedVerdicts: ["failed"]
        });
      },
      patch: () => ({
        failureReason,
        verificationEvidenceIds: [...(receipt?.evidenceIds ?? [])],
        verificationReceiptId: receipt?.id,
        verificationReceiptHash: receipt?.receiptHash
      }),
      metadata: () => ({ verificationReceiptId: receiptId })
    });
  }

  fail(id: string, command: AuthoritativeCommandEnvelope, failureReason: string) {
    if (!failureReason) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Job failure requires a reason");
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "failed",
      command,
      triggeringEvent: "job-failed",
      beforeTransition: (current) => {
        if (current.state === "verifying") {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Verification failure must be backed by an authoritative failed verification receipt"
          );
        }
      },
      patch: () => ({ failureReason })
    });
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "cancelled",
      command,
      triggeringEvent: "job-cancelled"
    });
  }
}
