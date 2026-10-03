import { ControlPlaneError } from "@/lib/control-plane/errors";

function requireId(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `${label} must be a non-empty canonical identifier`
    );
  }
  return trimmed;
}

function requireVersion(version: number) {
  if (!Number.isInteger(version) || version < 1) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Orchestration version must be a positive integer"
    );
  }
  return version;
}

export function orchestrationTaskGenerationIdempotencyKey(
  runId: string,
  version: number
) {
  return `orchestration:${requireId(runId, "runId")}:v${requireVersion(version)}:task-generation`;
}

export function orchestrationJobEnqueueIdempotencyKey(
  runId: string,
  version: number
) {
  return `orchestration:${requireId(runId, "runId")}:v${requireVersion(version)}:job-enqueue`;
}

export function jobSideEffectIdempotencyKey(
  jobId: string,
  operation: string
) {
  return `job:${requireId(jobId, "jobId")}:side-effect:${requireId(operation, "operation")}`;
}
