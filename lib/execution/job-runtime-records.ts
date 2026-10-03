import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";

export type DurableJobOutcomeKind =
  | "provider-completed"
  | "verified"
  | "succeeded" // legacy persisted runtime outcome; new code must not emit this
  | "retry-scheduled"
  | "dead-lettered"
  | "cancelled"
  | "recovered";

export interface DurableJobExecutionOutcomeRecord {
  id: string;
  correlationId?: string;
  jobId: string;
  kind: DurableJobOutcomeKind;
  runtimeState: string;
  attempt: number;
  reason?: string;
  occurredAt: string;
  transactionHash: string;
  recordHash: string;
}

export interface DurableJobRuntimeEventRecord {
  id: string;
  correlationId?: string;
  jobId: string;
  eventType: string;
  attempt: number;
  occurredAt: string;
  transactionHash: string;
  outcomeHash: string;
  recordHash: string;
}

function timestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return new Date(parsed).toISOString();
}

export function createDurableJobExecutionOutcome(
  input: Omit<DurableJobExecutionOutcomeRecord, "recordHash">
): DurableJobExecutionOutcomeRecord {
  if (!input.id || !input.jobId || !input.kind || !input.runtimeState || !input.transactionHash) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Durable Job outcome identity and transaction lineage are required");
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Durable Job outcome attempt must be non-negative");
  }
  const base = {
    ...input,
    occurredAt: timestamp(input.occurredAt, "Durable Job outcome occurredAt")
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function createDurableJobRuntimeEvent(input: {
  id: string;
  jobId: string;
  eventType: string;
  attempt: number;
  occurredAt: string;
  transactionHash: string;
  outcome: DurableJobExecutionOutcomeRecord;
}): DurableJobRuntimeEventRecord {
  if (!input.eventType || input.outcome.jobId !== input.jobId) {
    throw new ControlPlaneError("FORBIDDEN", "Durable Job event must match its outcome lineage");
  }
  const base = {
    id: input.id,
    correlationId: input.outcome.correlationId,
    jobId: input.jobId,
    eventType: input.eventType,
    attempt: input.attempt,
    occurredAt: timestamp(input.occurredAt, "Durable Job event occurredAt"),
    transactionHash: input.transactionHash,
    outcomeHash: input.outcome.recordHash
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}
