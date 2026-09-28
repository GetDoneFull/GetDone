import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";

export const ORCHESTRATION_WORKER_CONTRACT_VERSION = "1.0.0";

export interface OrchestrationWorkCandidate {
  run: OrchestrationRunRecord;
  stageRunVersion: number;
  stageAttempt: number;
  consecutiveFailures: number;
  readyAt: string;
}

export interface OrchestrationLease {
  id: string;
  runId: string;
  workerId: string;
  claimedRunVersion: number;
  claimedRecordHash: string;
  attempt: number;
  consecutiveFailures: number;
  version: number;
  issuedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  leaseHash: string;
}

export type OrchestrationStageOutcome =
  | {
      kind: "advance";
      next: OrchestrationRunRecord;
    }
  | {
      kind: "defer";
      reason: string;
      delayMs: number;
    }
  | {
      kind: "retry";
      code: string;
      reason: string;
      retryAfterMs?: number;
    }
  | {
      kind: "failed";
      code: string;
      reason: string;
    };

export interface OrchestrationStageContext {
  run: OrchestrationRunRecord;
  lease: OrchestrationLease;
  heartbeat(): Promise<void>;
}

export interface OrchestrationStageHandler {
  execute(context: OrchestrationStageContext): Promise<OrchestrationStageOutcome>;
}

export interface OrchestrationWorkerStore {
  listReady(input: {
    now: string;
    limit: number;
  }): Promise<readonly OrchestrationWorkCandidate[]>;

  claimAtomic(input: {
    runId: string;
    workerId: string;
    now: string;
    leaseSeconds: number;
    expectedRunVersion: number;
    expectedRecordHash: string;
    idempotencyKey: string;
  }): Promise<OrchestrationLease | null>;

  heartbeat(input: {
    lease: OrchestrationLease;
    now: string;
    extendSeconds: number;
    idempotencyKey: string;
  }): Promise<OrchestrationLease>;

  release(input: {
    lease: OrchestrationLease;
    now: string;
    idempotencyKey: string;
  }): Promise<void>;

  defer(input: {
    lease: OrchestrationLease;
    now: string;
    readyAt: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;

  scheduleRetry(input: {
    lease: OrchestrationLease;
    now: string;
    readyAt: string;
    code: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;

  recoverExpired(input: {
    now: string;
    limit: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  }): Promise<readonly OrchestrationRecoveryRecord[]>;
}

export interface OrchestrationRecoveryRecord {
  runId: string;
  leaseId: string;
  outcome: "stage-advanced-before-crash" | "retry-scheduled";
  nextReadyAt: string;
  attempt: number;
}

function parse(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a timestamp`);
  }
  return parsed;
}

export function createOrchestrationLease(input: {
  id: string;
  runId: string;
  workerId: string;
  claimedRunVersion: number;
  claimedRecordHash: string;
  attempt: number;
  consecutiveFailures: number;
  version?: number;
  issuedAt: string;
  leaseSeconds: number;
}): OrchestrationLease {
  if (
    !input.id.trim()
    || !input.runId.trim()
    || !input.workerId.trim()
    || !input.claimedRecordHash.trim()
    || !Number.isInteger(input.claimedRunVersion)
    || input.claimedRunVersion < 1
    || !Number.isInteger(input.attempt)
    || input.attempt < 1
    || !Number.isInteger(input.consecutiveFailures)
    || input.consecutiveFailures < 0
    || !Number.isInteger(input.leaseSeconds)
    || input.leaseSeconds < 2
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Orchestration lease identity, lineage, attempt, and duration are invalid"
    );
  }

  const issuedAtMs = parse(input.issuedAt, "orchestration lease issuedAt");
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Orchestration lease version must be positive");
  }

  const base = {
    id: input.id,
    runId: input.runId,
    workerId: input.workerId,
    claimedRunVersion: input.claimedRunVersion,
    claimedRecordHash: input.claimedRecordHash,
    attempt: input.attempt,
    consecutiveFailures: input.consecutiveFailures,
    version,
    issuedAt: new Date(issuedAtMs).toISOString(),
    heartbeatAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + input.leaseSeconds * 1_000).toISOString()
  };

  return Object.freeze({ ...base, leaseHash: sha256Hex(base) });
}

export function assertOrchestrationLease(
  lease: OrchestrationLease,
  input: {
    runId?: string;
    workerId?: string;
    now?: number;
  } = {}
) {
  const { leaseHash, ...base } = lease;
  if (sha256Hex(base) !== leaseHash) {
    throw new ControlPlaneError("FORBIDDEN", "Orchestration lease integrity check failed");
  }
  if (input.runId && lease.runId !== input.runId) {
    throw new ControlPlaneError("CONFLICT", "Orchestration lease run does not match");
  }
  if (input.workerId && lease.workerId !== input.workerId) {
    throw new ControlPlaneError("CONFLICT", "Orchestration lease worker does not match");
  }
  const now = input.now ?? Date.now();
  if (Date.parse(lease.expiresAt) <= now) {
    throw new ControlPlaneError("CONFLICT", "Orchestration lease expired");
  }
  return lease;
}

export function renewOrchestrationLease(
  lease: OrchestrationLease,
  input: {
    now: string;
    extendSeconds: number;
  }
): OrchestrationLease {
  const now = parse(input.now, "orchestration lease heartbeat");
  assertOrchestrationLease(lease, {
    runId: lease.runId,
    workerId: lease.workerId,
    now
  });
  if (!Number.isInteger(input.extendSeconds) || input.extendSeconds < 2) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Orchestration lease heartbeat extension must be at least two seconds"
    );
  }

  const base = {
    ...lease,
    version: lease.version + 1,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + input.extendSeconds * 1_000).toISOString()
  };
  delete (base as Partial<OrchestrationLease>).leaseHash;

  return Object.freeze({
    ...base,
    leaseHash: sha256Hex(base)
  }) as OrchestrationLease;
}

export function orchestrationClaimIdempotencyKey(input: {
  runId: string;
  runVersion: number;
  workerId: string;
}) {
  return `orchestration-worker:claim:${input.runId}:v${input.runVersion}:${input.workerId}`;
}

export function orchestrationHeartbeatIdempotencyKey(lease: OrchestrationLease) {
  return `orchestration-worker:heartbeat:${lease.id}:v${lease.version}`;
}

export function orchestrationReleaseIdempotencyKey(lease: OrchestrationLease) {
  return `orchestration-worker:release:${lease.id}`;
}

export function orchestrationRetryIdempotencyKey(lease: OrchestrationLease) {
  return `orchestration-worker:retry:${lease.id}:attempt${lease.attempt}`;
}

export function orchestrationDeferIdempotencyKey(lease: OrchestrationLease) {
  return `orchestration-worker:defer:${lease.id}:attempt${lease.attempt}`;
}

export function computeOrchestrationBackoffMs(input: {
  runId: string;
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
}) {
  if (
    !Number.isInteger(input.attempt)
    || input.attempt < 1
    || !Number.isFinite(input.baseDelayMs)
    || input.baseDelayMs < 0
    || !Number.isFinite(input.maxDelayMs)
    || input.maxDelayMs < input.baseDelayMs
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Orchestration backoff inputs are invalid");
  }

  const exponential = Math.min(
    input.maxDelayMs,
    input.baseDelayMs * 2 ** Math.max(0, input.attempt - 1)
  );

  if (exponential === 0) return 0;

  const seed = Number.parseInt(
    sha256Hex(`${input.runId}:${input.attempt}`).slice(0, 8),
    16
  );
  const ratio = seed / 0xffffffff;
  const jitterFactor = 0.75 + ratio * 0.25;
  return Math.max(1, Math.floor(exponential * jitterFactor));
}
