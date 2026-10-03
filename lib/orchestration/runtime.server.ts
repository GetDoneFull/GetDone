import { execFileSync } from "node:child_process";
import path from "node:path";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OrchestrationStageHandler } from "@/lib/orchestration/worker-contracts";
import { DurableOrchestrationWorker } from "@/lib/orchestration/worker-runtime";
import {
  PersistentOrchestrationWorkerService,
  readPersistentOrchestrationWorkerConfig
} from "@/lib/orchestration/persistent-worker.server";
import {
  DedicatedOrchestrationWorkerProcess,
  readDedicatedOrchestrationWorkerProcessConfig
} from "@/lib/orchestration/worker-process.server";
import { PostgresOrchestrationRunStore } from "@/lib/persistence/postgres/orchestration-store";
import { PostgresOrchestrationWorkerStore } from "@/lib/persistence/postgres/orchestration-worker-store";
import { PostgresOrchestrationWorkerRegistry } from "@/lib/persistence/postgres/orchestration-worker-registry";
import {
  assertPostgresReadyAtStartup,
  getPostgresRuntimeFromEnv
} from "@/lib/persistence/postgres/runtime.server";

export interface OrchestrationWorkerRuntimeConfig {
  leaseSeconds: number;
  heartbeatSeconds: number;
  batchSize: number;
  concurrency: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxConsecutiveFailures: number;
}

function integer(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum = 1
) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      `${name} must be an integer greater than or equal to ${minimum}`
    );
  }
  return value;
}

export function readOrchestrationWorkerRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): OrchestrationWorkerRuntimeConfig {
  const config = {
    leaseSeconds: integer(env, "GETDONE_ORCHESTRATION_LEASE_SECONDS", 60, 2),
    heartbeatSeconds: integer(env, "GETDONE_ORCHESTRATION_HEARTBEAT_SECONDS", 20),
    batchSize: integer(env, "GETDONE_ORCHESTRATION_BATCH_SIZE", 10),
    concurrency: integer(env, "GETDONE_ORCHESTRATION_CONCURRENCY", 2),
    retryBaseDelayMs: integer(env, "GETDONE_ORCHESTRATION_RETRY_BASE_DELAY_MS", 1_000),
    retryMaxDelayMs: integer(env, "GETDONE_ORCHESTRATION_RETRY_MAX_DELAY_MS", 120_000),
    maxConsecutiveFailures: integer(env, "GETDONE_ORCHESTRATION_MAX_FAILURES", 8)
  };

  if (config.heartbeatSeconds >= config.leaseSeconds) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Orchestration heartbeat must be shorter than the lease"
    );
  }
  if (config.concurrency > config.batchSize) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Orchestration concurrency must not exceed batch size"
    );
  }
  if (config.retryBaseDelayMs > config.retryMaxDelayMs) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Orchestration retry base delay must not exceed maximum delay"
    );
  }

  return Object.freeze(config);
}

function assertProcessRole(
  env: Readonly<Record<string, string | undefined>>
) {
  if (env.GETDONE_PROCESS_ROLE !== "orchestration-worker") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dedicated orchestration worker requires GETDONE_PROCESS_ROLE=orchestration-worker"
    );
  }
}

function verifyProductionRuntime(
  env: Readonly<Record<string, string | undefined>>
) {
  if (
    env.GETDONE_RUNTIME_ENV === "production"
    || (env.NODE_ENV === "production" && !env.GETDONE_RUNTIME_ENV?.trim())
  ) {
    execFileSync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "verify-production-runtime.mjs")],
      {
        cwd: process.cwd(),
        env: env as NodeJS.ProcessEnv,
        stdio: "inherit"
      }
    );
  }
}

export async function createPersistentOrchestrationWorkerFromEnv(
  handler: OrchestrationStageHandler,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  assertProcessRole(env);
  verifyProductionRuntime(env);
  await assertPostgresReadyAtStartup(env);

  const postgres = getPostgresRuntimeFromEnv(env);
  const processConfig = readPersistentOrchestrationWorkerConfig(env);
  const runtimeConfig = readOrchestrationWorkerRuntimeConfig(env);
  const runStore = new PostgresOrchestrationRunStore(postgres.database);
  const workerStore = new PostgresOrchestrationWorkerStore(postgres.database);
  const registry = new PostgresOrchestrationWorkerRegistry(postgres.database);
  const runtime = new DurableOrchestrationWorker(
    runStore,
    workerStore,
    {
      workerId: processConfig.workerId,
      ...runtimeConfig
    }
  );

  return Object.freeze({
    postgres,
    service: new PersistentOrchestrationWorkerService(
      runtime,
      handler,
      registry,
      processConfig
    )
  });
}

export async function createDedicatedOrchestrationWorkerProcessFromEnv(
  handler: OrchestrationStageHandler,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const runtime = await createPersistentOrchestrationWorkerFromEnv(handler, env);
  return new DedicatedOrchestrationWorkerProcess(
    runtime.service,
    () => runtime.postgres.database.close(),
    readDedicatedOrchestrationWorkerProcessConfig(env)
  );
}
