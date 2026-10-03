import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizationConsumption,
  assertAuthorizationGrantEnvelope,
  createAuthorizationConsumptionRecord,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import {
  commandFingerprint,
  type AuthoritativeCommandEnvelope
} from "@/lib/control-plane/command-envelope";
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

export type TaskState =
  | "proposed"
  | "authorized"
  | "queued"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "cancelled";

export interface TaskRecord extends StatefulEntity {
  state: TaskState;
  reason: string;
  evidenceIds: readonly string[];
  capabilityRequirements: readonly string[];
  dependencyTaskIds?: readonly string[];
  authorizationLineage: readonly string[];
  authorizationGrantId?: string;
  authorizationGrantHash?: string;
  authorizationConsumption?: AuthorizationConsumptionRecord;
  verificationEvidenceIds: readonly string[];
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  failureReason?: string;
  retryCount?: number;
  maxRetries?: number;
  lastRetryAt?: string;
  lastTimeoutAt?: string;
}

export interface TaskStore extends EntityStore<TaskRecord> {
  create?(record: TaskRecord): Promise<void>;
}

export interface TaskStores {
  tasks: TaskStore;
  authorizationGrants?: AuthorizationGrantStore;
  verificationReceipts?: VerificationReceiptStore;
}

export interface CreateTaskInput {
  id: string;
  reason: string;
  evidenceIds?: readonly string[];
  capabilityRequirements: readonly string[];
  dependencyTaskIds?: readonly string[];
  maxRetries?: number;
  createdAt?: string;
}

async function assertCurrentTaskExecutionAuthority(
  current: TaskRecord,
  stores: TaskStores,
  command: AuthoritativeCommandEnvelope,
  now: number
) {
  const consumption = current.authorizationConsumption;
  if (
    !current.authorizationGrantId
    || !current.authorizationGrantHash
    || !consumption
    || consumption.consumerType !== "task"
    || consumption.consumerId !== current.id
    || consumption.grantId !== current.authorizationGrantId
    || consumption.grantHash !== current.authorizationGrantHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Executable Task requires exact persisted authorization consumption and grant lineage"
    );
  }

  const grantStore = stores.authorizationGrants;
  if (!grantStore) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Current authorization storage is required before Task execution"
    );
  }

  const grant = await grantStore.get(current.authorizationGrantId);
  if (!grant || grant.grantHash !== current.authorizationGrantHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Task authorization is missing or differs from current authoritative storage"
    );
  }

  assertAuthorizationGrantEnvelope(grant, command.scope, now);
  assertAuthorizationConsumption(consumption, grant);

  const required = [...new Set(current.capabilityRequirements)].sort();
  const authorized = [...new Set(grant.capabilityNames)].sort();
  if (
    required.length !== authorized.length
    || required.some((item, index) => item !== authorized[index])
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Executable Task capabilities no longer match current authorization"
    );
  }
}

async function assertTaskDependenciesReady(
  store: EntityStore<TaskRecord>,
  current: TaskRecord
) {
  for (const dependencyId of current.dependencyTaskIds ?? []) {
    if (dependencyId === current.id) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Task cannot depend on itself");
    }
    const dependency = await store.get(dependencyId);
    if (
      !dependency
      || dependency.portfolioId !== current.portfolioId
      || dependency.companyId !== current.companyId
      || dependency.state !== "succeeded"
    ) {
      throw new ControlPlaneError(
        "CONFLICT",
        `Task dependency is not authoritatively succeeded: ${dependencyId}`
      );
    }
  }
}

export class TaskService {
  constructor(
    private readonly transactions: ControlPlaneTransactionManager<TaskStores>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async create(input: CreateTaskInput, command: AuthoritativeCommandEnvelope) {
    if (!input.id || !input.reason || input.capabilityRequirements.length === 0) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Task creation requires id, reason, and at least one capability"
      );
    }
    if (input.maxRetries !== undefined && (!Number.isInteger(input.maxRetries) || input.maxRetries < 0)) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Task maxRetries must be a non-negative integer");
    }
    const createdAt = input.createdAt ?? this.now().toISOString();
    const fingerprint = commandFingerprint(command);

    return this.transactions.run(async (transaction) => {
      const claim = await claimIdempotency<TaskRecord>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint,
        new Date(createdAt)
      );
      if (claim.state === "COMPLETED" && claim.record.result) return claim.record.result;
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError("CONFLICT", "Task creation is already in progress or previously failed");
      }
      const create = transaction.stores.tasks.create;
      if (!create) {
        throw new ControlPlaneError("UNAVAILABLE", "Task store does not support authoritative creation");
      }

      const dependencyTaskIds = [...new Set(input.dependencyTaskIds ?? [])];
      if (dependencyTaskIds.includes(input.id)) {
        throw new ControlPlaneError("VALIDATION_FAILED", "Task cannot depend on itself");
      }

      const record: TaskRecord = Object.freeze({
        id: input.id,
        correlationId: command.correlationId,
        portfolioId: command.scope.portfolioId,
        companyId: command.scope.companyId,
        state: "proposed",
        reason: input.reason,
        evidenceIds: Object.freeze([...new Set(input.evidenceIds ?? [])]),
        capabilityRequirements: Object.freeze([...new Set(input.capabilityRequirements)].sort()),
        dependencyTaskIds: Object.freeze(dependencyTaskIds),
        authorizationLineage: Object.freeze([]),
        verificationEvidenceIds: Object.freeze([]),
        retryCount: 0,
        maxRetries: input.maxRetries ?? 3,
        version: 1,
        updatedAt: createdAt
      });

      await create.call(transaction.stores.tasks, record);
      await transaction.audit.append(createAuditEvent({
        correlationId: command.correlationId,
        eventType: "task.proposed",
        actor: command.actor,
        scope: {
          userId: command.scope.userId,
          portfolioId: command.scope.portfolioId,
          companyId: command.scope.companyId,
          resourceId: command.scope.resourceId
        },
        environment: command.environment,
        entityType: "task",
        entityId: record.id,
        newState: "proposed",
        provenance: command.provenance,
        metadata: {
          commandId: command.commandId,
          dependencyCount: dependencyTaskIds.length,
          maxRetries: record.maxRetries ?? 0
        }
      }));
      await transaction.idempotency.complete(
        command.idempotencyKey,
        fingerprint,
        record,
        createdAt
      );
      return record;
    });
  }

  authorize(
    id: string,
    command: AuthoritativeCommandEnvelope,
    grant: AuthorizationGrant,
    consumedAt = this.now().toISOString()
  ) {
    assertAuthorizationGrantEnvelope(grant, command.scope, Date.parse(consumedAt));

    const consumption = createAuthorizationConsumptionRecord({
      id: `authorization-consumption:${grant.id}`,
      grant,
      consumerType: "task",
      consumerId: id,
      consumedAt
    });

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "authorized",
      command,
      triggeringEvent: "task-authorized",
      patch: async (current, transaction) => {
        const required = [...new Set(current.capabilityRequirements)].sort();
        const granted = [...new Set(grant.capabilityNames)].sort();

        if (
          required.length !== granted.length
          || required.some((item, index) => item !== granted[index])
        ) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authorization grant capabilities do not match the task requirements"
          );
        }

        const grantStore = transaction.stores.authorizationGrants;
        if (!grantStore) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authorization grant store is required before a task can be authorized"
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
          Date.parse(consumedAt)
        );

        await grantStore.consume(consumption);

        return {
          authorizationLineage: [...current.authorizationLineage, grant.id],
          authorizationGrantId: grant.id,
          authorizationGrantHash: grant.grantHash,
          authorizationConsumption: consumption
        };
      },
      metadata: () => ({
        authorizationGrantId: grant.id,
        authorizationGrantHash: grant.grantHash,
        authorizationConsumptionHash: consumption.consumptionHash
      }),
      now: this.now
    });
  }

  queue(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "task-queued",
      beforeTransition: async (current, transaction) => {
        await assertCurrentTaskExecutionAuthority(
          current,
          transaction.stores,
          command,
          this.now().getTime()
        );
        await assertTaskDependenciesReady(transaction.stores.tasks, current);
      },
      now: this.now
    });
  }

  start(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "running",
      command,
      triggeringEvent: "task-started",
      beforeTransition: async (current, transaction) => {
        await assertCurrentTaskExecutionAuthority(
          current,
          transaction.stores,
          command,
          this.now().getTime()
        );
      },
      now: this.now
    });
  }

  retry(
    id: string,
    command: AuthoritativeCommandEnvelope,
    reason: string,
    retriedAt = this.now().toISOString()
  ) {
    if (!reason) throw new ControlPlaneError("VALIDATION_FAILED", "Task retry requires a reason");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "task-retried",
      beforeTransition: async (current, transaction) => {
        await assertCurrentTaskExecutionAuthority(
          current,
          transaction.stores,
          command,
          Date.parse(retriedAt)
        );
        const retryCount = current.retryCount ?? 0;
        if (retryCount >= (current.maxRetries ?? 3)) {
          throw new ControlPlaneError("CONFLICT", "Task retry limit is exhausted");
        }
        await assertTaskDependenciesReady(transaction.stores.tasks, current);
      },
      patch: (current) => ({
        retryCount: (current.retryCount ?? 0) + 1,
        lastRetryAt: retriedAt,
        failureReason: undefined,
        verificationEvidenceIds: [],
        verificationReceiptId: undefined,
        verificationReceiptHash: undefined
      }),
      metadata: (current) => ({
        reason,
        retryCount: (current.retryCount ?? 0) + 1
      }),
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
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "task-timeout-recovered",
      beforeTransition: async (current, transaction) => {
        await assertCurrentTaskExecutionAuthority(
          current,
          transaction.stores,
          command,
          Date.parse(timedOutAt)
        );
        const retryCount = current.retryCount ?? 0;
        if (retryCount >= (current.maxRetries ?? 3)) {
          throw new ControlPlaneError("CONFLICT", "Task retry limit is exhausted");
        }
        await assertTaskDependenciesReady(transaction.stores.tasks, current);
      },
      patch: (current) => ({
        retryCount: (current.retryCount ?? 0) + 1,
        lastTimeoutAt: timedOutAt,
        lastRetryAt: timedOutAt,
        failureReason: undefined
      }),
      metadata: (current) => ({
        retryCount: (current.retryCount ?? 0) + 1,
        timedOutAt
      }),
      now: () => new Date(timedOutAt)
    });
  }

  beginVerification(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "verifying",
      command,
      triggeringEvent: "task-verification-started",
      now: this.now
    });
  }

  succeed(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    let receipt: VerificationReceipt | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "succeeded",
      command,
      triggeringEvent: "task-verified-succeeded",
      beforeTransition: async (_current, transaction) => {
        const store = transaction.stores.verificationReceipts;
        if (!store) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verification receipt storage is required for Task success"
          );
        }
        receipt = await requireAuthoritativeVerificationReceipt(store, receiptId, {
          scope: command.scope,
          subject: { type: "task", id },
          now: this.now().getTime(),
          allowedVerdicts: ["verified"]
        });
      },
      patch: () => {
        if (!receipt) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authoritative Task verification receipt is unavailable"
          );
        }
        return {
          verificationEvidenceIds: [...receipt.evidenceIds],
          verificationReceiptId: receipt.id,
          verificationReceiptHash: receipt.receiptHash
        };
      },
      metadata: () => ({ verificationReceiptId: receiptId }),
      now: this.now
    });
  }

  markUncertain(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    let receipt: VerificationReceipt | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "uncertain",
      command,
      triggeringEvent: "task-verification-uncertain",
      beforeTransition: async (_current, transaction) => {
        const store = transaction.stores.verificationReceipts;
        if (!store) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verification receipt storage is required for uncertain Task truth"
          );
        }
        receipt = await requireAuthoritativeVerificationReceipt(store, receiptId, {
          scope: command.scope,
          subject: { type: "task", id },
          now: this.now().getTime(),
          allowedVerdicts: ["uncertain"]
        });
      },
      patch: () => {
        if (!receipt) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authoritative Task verification receipt is unavailable"
          );
        }
        return {
          verificationEvidenceIds: [...receipt.evidenceIds],
          verificationReceiptId: receipt.id,
          verificationReceiptHash: receipt.receiptHash
        };
      },
      metadata: () => ({ verificationReceiptId: receiptId }),
      now: this.now
    });
  }

  fail(
    id: string,
    command: AuthoritativeCommandEnvelope,
    failureReason: string
  ) {
    if (!failureReason) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Task failure requires a reason"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "failed",
      command,
      triggeringEvent: "task-failed",
      patch: () => ({ failureReason }),
      now: this.now
    });
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "cancelled",
      command,
      triggeringEvent: "task-cancelled",
      now: this.now
    });
  }
}
