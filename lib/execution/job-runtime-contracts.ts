import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const JOB_RUNTIME_CONTRACT_VERSION = "1.3.0";

export interface JobQueueEnvelope {
  id: string;
  correlationId?: string;
  jobId: string;
  taskId: string;
  scope: TrustedExecutionScope;
  authorizationConsumptionHash: string;
  idempotencyKey: string;
  scheduledAt: string;
  createdAt: string;
  envelopeHash: string;
}

export type JobLeaseState = "active" | "released" | "expired";

export type DurableJobCompletionKind = "provider-completed" | "verified";

export interface DurableJobLease {
  id: string;
  jobId: string;
  workerId: string;
  attempt: number;
  leaseIssuedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  state: JobLeaseState;
  version: number;
  leaseHash: string;
}

export type JobStoreTransactionOperation =
  | "enqueue"
  | "claim"
  | "heartbeat"
  | "release"
  | "retry"
  | "dead-letter"
  | "cancel"
  | "recover-expired";

export interface JobStoreTransactionReceipt {
  id: string;
  operation: JobStoreTransactionOperation;
  jobId: string;
  idempotencyKey: string;
  expectedVersion: number;
  expectedHash: string;
  nextVersion: number;
  nextHash: string;
  occurredAt: string;
  transactionHash: string;
}

export interface JobRetryScheduleRecord {
  id: string;
  jobId: string;
  nextAttempt: number;
  runAt: string;
  reason: string;
  sourceEnvelopeHash: string;
  transactionHash: string;
  recordHash: string;
}

export interface DeadLetterRecord {
  id: string;
  jobId: string;
  finalAttempt: number;
  reason: string;
  failedAt: string;
  sourceEnvelopeHash: string;
  transactionHash: string;
  recordHash: string;
}

export interface JobRecoveryRecord {
  id: string;
  jobId: string;
  expiredLeaseHash: string;
  outcome: "retry-scheduled" | "dead-lettered" | "cancelled";
  recoveredAt: string;
  transactionHash: string;
  recordHash: string;
}

export interface DurableJobStoreDescriptor {
  persistence: "durable-external" | "ephemeral-reference";
  atomicClaims: boolean;
  compareAndSwap: boolean;
  restartSafe: boolean;
  multiProcessSafe: boolean;
  productionEligible: boolean;
}

/**
 * Production implementation requirement.
 *
 * A production store must be externally durable, transactional, compare-and-swap
 * capable, restart-safe, and multi-process safe. In-memory/reference stores must
 * declare "ephemeral-reference" and productionEligible=false.
 *
 * This interface is a contract only. The repository intentionally provides no
 * production queue implementation. No in-memory implementation is production evidence.
 */
export interface DurableJobStore {
  readonly descriptor: DurableJobStoreDescriptor;
  enqueue(input: JobQueueEnvelope): Promise<{
    status: "enqueued" | "idempotent-replay";
    transaction: JobStoreTransactionReceipt;
  }>;
  claimAtomic(input: {
    jobId: string;
    workerId: string;
    now: string;
    leaseSeconds: number;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
  }): Promise<{
    lease: DurableJobLease;
    transaction: JobStoreTransactionReceipt;
  } | null>;
  heartbeat(input: {
    lease: DurableJobLease;
    now: string;
    extendSeconds: number;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
  }): Promise<{
    lease: DurableJobLease;
    transaction: JobStoreTransactionReceipt;
  }>;
  release(input: {
    lease: DurableJobLease;
    now: string;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
    outcomeKind: DurableJobCompletionKind;
  }): Promise<JobStoreTransactionReceipt>;
  scheduleRetry(record: JobRetryScheduleRecord): Promise<JobStoreTransactionReceipt>;
  deadLetter(record: DeadLetterRecord): Promise<JobStoreTransactionReceipt>;
  cancel(input: {
    jobId: string;
    reason: string;
    cancelledAt: string;
    expectedJobVersion: number;
    expectedJobHash: string;
    idempotencyKey: string;
  }): Promise<JobStoreTransactionReceipt>;
  recoverExpired(input: {
    now: string;
    limit: number;
  }): Promise<readonly JobRecoveryRecord[]>;
}

function parse(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a timestamp`);
  }
  return parsed;
}

function requireNonEmpty(value: string, label: string) {
  if (!value.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is required`);
  }
  return value;
}

export function assertProductionDurableJobStoreDescriptor(
  descriptor: DurableJobStoreDescriptor
) {
  if (
    descriptor.persistence !== "durable-external"
    || !descriptor.atomicClaims
    || !descriptor.compareAndSwap
    || !descriptor.restartSafe
    || !descriptor.multiProcessSafe
    || !descriptor.productionEligible
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Production Job Store requires external durability, atomic claims, CAS, restart safety, and multi-process safety"
    );
  }
  return descriptor;
}

export function createJobStoreTransactionReceipt(
  input: Omit<JobStoreTransactionReceipt, "transactionHash">
): JobStoreTransactionReceipt {
  requireNonEmpty(input.id, "transaction id");
  requireNonEmpty(input.jobId, "transaction jobId");
  requireNonEmpty(input.idempotencyKey, "transaction idempotencyKey");
  requireNonEmpty(input.expectedHash, "transaction expectedHash");
  requireNonEmpty(input.nextHash, "transaction nextHash");
  const occurredAt = parse(input.occurredAt, "transaction occurredAt");
  if (
    !Number.isInteger(input.expectedVersion)
    || input.expectedVersion < 0
    || !Number.isInteger(input.nextVersion)
    || input.nextVersion !== input.expectedVersion + 1
  ) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Job Store transaction must advance the authoritative version exactly once"
    );
  }
  if (input.expectedHash === input.nextHash) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Job Store transaction must change authoritative state hash"
    );
  }
  const base = {
    ...input,
    occurredAt: new Date(occurredAt).toISOString()
  };
  return Object.freeze({ ...base, transactionHash: sha256Hex(base) });
}

export function assertJobStoreTransactionReceipt(receipt: JobStoreTransactionReceipt) {
  const { transactionHash, ...base } = receipt;
  if (
    sha256Hex(base) !== transactionHash
    || receipt.nextVersion !== receipt.expectedVersion + 1
    || receipt.expectedHash === receipt.nextHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Job Store transaction receipt integrity check failed");
  }
  parse(receipt.occurredAt, "transaction occurredAt");
  return receipt;
}

export function createJobQueueEnvelope(
  input: Omit<JobQueueEnvelope, "envelopeHash">
): JobQueueEnvelope {
  if (!input.authorizationConsumptionHash || !input.idempotencyKey) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Durable job enqueue requires authorization consumption and idempotency lineage"
    );
  }
  const scheduledAt = parse(input.scheduledAt, "scheduledAt");
  const createdAt = parse(input.createdAt, "createdAt");
  if (scheduledAt < createdAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "scheduledAt cannot precede createdAt");
  }
  const base = {
    ...input,
    scheduledAt: new Date(scheduledAt).toISOString(),
    createdAt: new Date(createdAt).toISOString()
  };
  return Object.freeze({ ...base, envelopeHash: sha256Hex(base) });
}

export function createDurableJobLease(input: {
  id: string;
  jobId: string;
  workerId: string;
  attempt: number;
  leaseIssuedAt: string;
  leaseSeconds: number;
}): DurableJobLease {
  if (!input.workerId || !Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Worker identity and positive attempt are required");
  }
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Positive leaseSeconds are required");
  }
  const issued = parse(input.leaseIssuedAt, "leaseIssuedAt");
  const base = {
    id: input.id,
    jobId: input.jobId,
    workerId: input.workerId,
    attempt: input.attempt,
    leaseIssuedAt: new Date(issued).toISOString(),
    heartbeatAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + input.leaseSeconds * 1000).toISOString(),
    state: "active" as const,
    version: 1
  };
  return Object.freeze({ ...base, leaseHash: sha256Hex(base) });
}

export function assertDurableJobLease(
  lease: DurableJobLease,
  input: { jobId: string; workerId?: string; now?: number }
) {
  const { leaseHash, ...base } = lease;
  if (sha256Hex(base) !== leaseHash) {
    throw new ControlPlaneError("FORBIDDEN", "Durable job lease integrity check failed");
  }
  const now = input.now ?? Date.now();
  if (
    lease.jobId !== input.jobId
    || (input.workerId && lease.workerId !== input.workerId)
    || lease.state !== "active"
    || Date.parse(lease.expiresAt) <= now
  ) {
    throw new ControlPlaneError("CONFLICT", "Durable job lease is stale, inactive, or mismatched");
  }
  return lease;
}

export function renewDurableJobLease(
  lease: DurableJobLease,
  input: { now: string; extendSeconds: number }
): DurableJobLease {
  const now = parse(input.now, "heartbeatAt");
  assertDurableJobLease(lease, { jobId: lease.jobId, workerId: lease.workerId, now });
  if (!Number.isInteger(input.extendSeconds) || input.extendSeconds < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Positive heartbeat extension is required");
  }
  const base = {
    ...lease,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + input.extendSeconds * 1000).toISOString(),
    version: lease.version + 1
  };
  delete (base as Partial<DurableJobLease>).leaseHash;
  return Object.freeze({ ...base, leaseHash: sha256Hex(base) }) as DurableJobLease;
}

export function createJobRetryScheduleRecord(
  input: Omit<JobRetryScheduleRecord, "recordHash">
): JobRetryScheduleRecord {
  if (
    !Number.isInteger(input.nextAttempt)
    || input.nextAttempt < 1
    || !input.reason.trim()
    || !input.sourceEnvelopeHash
    || !input.transactionHash
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Retry scheduling requires attempt, reason, source envelope, and transaction lineage"
    );
  }
  const runAt = parse(input.runAt, "retry runAt");
  const base = { ...input, runAt: new Date(runAt).toISOString() };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function createDeadLetterRecord(
  input: Omit<DeadLetterRecord, "recordHash">
): DeadLetterRecord {
  if (
    !input.reason.trim()
    || !Number.isInteger(input.finalAttempt)
    || input.finalAttempt < 1
    || !input.sourceEnvelopeHash
    || !input.transactionHash
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Dead letter requires reason, final attempt, source envelope, and transaction lineage"
    );
  }
  const failedAt = parse(input.failedAt, "failedAt");
  const base = { ...input, failedAt: new Date(failedAt).toISOString() };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function createJobRecoveryRecord(
  input: Omit<JobRecoveryRecord, "recordHash">
): JobRecoveryRecord {
  if (!input.expiredLeaseHash || !input.transactionHash) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Recovery requires expired lease and transaction lineage"
    );
  }
  const recoveredAt = parse(input.recoveredAt, "recoveredAt");
  const base = { ...input, recoveredAt: new Date(recoveredAt).toISOString() };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}
