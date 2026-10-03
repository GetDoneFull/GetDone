import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  claimIdempotency,
  type IdempotencyStore
} from "@/lib/domain/idempotency";
import {
  orchestrationJobEnqueueIdempotencyKey,
  orchestrationTaskGenerationIdempotencyKey
} from "@/lib/orchestration/execution-idempotency";

export interface OrchestrationMaterializationReplay<T> {
  status: "created" | "idempotent-replay";
  key: string;
  result: T;
}

async function runDurably<T>(input: {
  store: IdempotencyStore;
  key: string;
  fingerprint: string;
  now: () => Date;
  execute: () => Promise<T>;
}): Promise<OrchestrationMaterializationReplay<T>> {
  const claim = await claimIdempotency<T>(
    input.store,
    input.key,
    input.fingerprint,
    input.now()
  );

  if (claim.state === "COMPLETED") {
    if (claim.record.result === undefined) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Completed materialization idempotency record is missing its persisted result"
      );
    }
    return {
      status: "idempotent-replay",
      key: input.key,
      result: claim.record.result
    };
  }

  if (claim.state === "IN_PROGRESS") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Materialization with this authoritative identity is already in progress"
    );
  }

  if (claim.state === "FAILED") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Materialization previously failed and requires explicit recovery before re-execution"
    );
  }

  try {
    const result = await input.execute();
    await input.store.complete(
      input.key,
      input.fingerprint,
      result,
      input.now().toISOString()
    );
    return { status: "created", key: input.key, result };
  } catch (error) {
    const code = error instanceof ControlPlaneError ? error.code : "UNHANDLED";
    await input.store.fail(
      input.key,
      input.fingerprint,
      code,
      input.now().toISOString()
    );
    throw error;
  }
}

export function runTaskGenerationIdempotently<T>(input: {
  store: IdempotencyStore;
  runId: string;
  runVersion: number;
  fingerprint: string;
  execute: () => Promise<T>;
  now?: () => Date;
}) {
  return runDurably({
    store: input.store,
    key: orchestrationTaskGenerationIdempotencyKey(
      input.runId,
      input.runVersion
    ),
    fingerprint: input.fingerprint,
    execute: input.execute,
    now: input.now ?? (() => new Date())
  });
}

export function runJobEnqueueIdempotently<T>(input: {
  store: IdempotencyStore;
  runId: string;
  runVersion: number;
  fingerprint: string;
  execute: () => Promise<T>;
  now?: () => Date;
}) {
  return runDurably({
    store: input.store,
    key: orchestrationJobEnqueueIdempotencyKey(
      input.runId,
      input.runVersion
    ),
    fingerprint: input.fingerprint,
    execute: input.execute,
    now: input.now ?? (() => new Date())
  });
}
