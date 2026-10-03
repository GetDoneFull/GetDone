import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  OrchestrationStageHandler,
  OrchestrationWorkerProcessStatus,
  OrchestrationWorkerRegistry
} from "@/lib/orchestration/worker-contracts";
import type { DurableOrchestrationWorker } from "@/lib/orchestration/worker-runtime";

export const ORCHESTRATION_WORKER_PROCESS_VERSION = "1.0.0";

export interface PersistentOrchestrationWorkerConfig {
  workerId: string;
  pollIntervalMs?: number;
  errorBackoffMs?: number;
}

export interface PersistentOrchestrationWorkerSnapshot {
  workerId: string;
  status: OrchestrationWorkerProcessStatus;
  cycles: number;
  draining: boolean;
  stopped: boolean;
  lastPollAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastErrorHash?: string;
}

function boundedMs(value: number | undefined, fallback: number, label: string) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 300_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return resolved;
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeErrorHash(error: unknown) {
  return sha256Hex({
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error)
  });
}

function structuredLog(
  level: "info" | "error",
  event: string,
  fields: Readonly<Record<string, unknown>>
) {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    service: "getdone-orchestration-worker",
    level,
    event,
    ...fields
  });
  if (level === "error") console.error(payload);
  else console.log(payload);
}

export class PersistentOrchestrationWorkerService {
  private statusValue: OrchestrationWorkerProcessStatus = "starting";
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private cycles = 0;
  private lastPollAt?: string;
  private lastSuccessAt?: string;
  private lastErrorAt?: string;
  private lastErrorHash?: string;
  private readonly pollIntervalMs: number;
  private readonly errorBackoffMs: number;

  constructor(
    private readonly worker: Pick<DurableOrchestrationWorker, "runOnce">,
    private readonly handler: OrchestrationStageHandler,
    private readonly registry: OrchestrationWorkerRegistry,
    private readonly config: PersistentOrchestrationWorkerConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!config.workerId.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Persistent orchestration workerId is required"
      );
    }
    this.pollIntervalMs = boundedMs(
      config.pollIntervalMs,
      1_000,
      "orchestration worker pollIntervalMs"
    );
    this.errorBackoffMs = boundedMs(
      config.errorBackoffMs,
      5_000,
      "orchestration worker errorBackoffMs"
    );
  }

  snapshot(): PersistentOrchestrationWorkerSnapshot {
    return Object.freeze({
      workerId: this.config.workerId,
      status: this.statusValue,
      cycles: this.cycles,
      draining: this.statusValue === "draining",
      stopped: this.statusValue === "stopped" || this.statusValue === "failed",
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorHash: this.lastErrorHash
    });
  }

  isReady() {
    return this.statusValue === "running"
      && !this.stopRequested
      && Boolean(this.lastSuccessAt);
  }

  async start() {
    if (this.loopPromise) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Persistent orchestration worker has already started"
      );
    }

    const startedAt = this.now().toISOString();
    await this.registry.start({
      workerId: this.config.workerId,
      processVersion: ORCHESTRATION_WORKER_PROCESS_VERSION,
      startedAt,
      metadata: { pid: process.pid }
    });
    this.statusValue = "running";
    this.loopPromise = this.runLoop();

    structuredLog("info", "worker_started", {
      workerId: this.config.workerId,
      processVersion: ORCHESTRATION_WORKER_PROCESS_VERSION
    });
  }

  requestStop() {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (this.statusValue === "running" || this.statusValue === "starting") {
      this.statusValue = "draining";
    }
  }

  async stop() {
    this.requestStop();
    if (this.loopPromise) await this.loopPromise;
  }

  private async heartbeat(status: OrchestrationWorkerProcessStatus) {
    const at = this.now().toISOString();
    await this.registry.heartbeat({
      workerId: this.config.workerId,
      status,
      heartbeatAt: at,
      ready: this.isReady(),
      metadata: {
        cycles: this.cycles,
        lastSuccessAt: this.lastSuccessAt ?? null,
        lastErrorAt: this.lastErrorAt ?? null,
        lastErrorHash: this.lastErrorHash ?? null
      }
    });
  }

  private async runLoop() {
    let terminalStatus: "stopped" | "failed" = "stopped";
    try {
      while (!this.stopRequested) {
        const pollAt = this.now().toISOString();
        this.lastPollAt = pollAt;
        try {
          const results = await this.worker.runOnce(this.handler, {
            shouldStop: () => this.stopRequested
          });
          this.cycles += 1;
          this.lastSuccessAt = this.now().toISOString();
          this.lastErrorAt = undefined;
          this.lastErrorHash = undefined;
          await this.heartbeat("running");

          structuredLog("info", "worker_cycle", {
            workerId: this.config.workerId,
            cycle: this.cycles,
            resultCount: results.length,
            outcomes: results.map((result) => ({
              runId: result.runId,
              outcome: result.outcome,
              state: result.state
            }))
          });

          if (!this.stopRequested && results.length === 0) {
            await sleep(this.pollIntervalMs);
          }
        } catch (error) {
          this.cycles += 1;
          this.lastErrorAt = this.now().toISOString();
          this.lastErrorHash = safeErrorHash(error);

          structuredLog("error", "worker_cycle_failed", {
            workerId: this.config.workerId,
            cycle: this.cycles,
            errorHash: this.lastErrorHash
          });

          try {
            await this.heartbeat("running");
          } catch {
            // Registry failure is itself retryable by the outer loop.
          }
          if (!this.stopRequested) await sleep(this.errorBackoffMs);
        }
      }

      this.statusValue = "draining";
      await this.heartbeat("draining");
      this.statusValue = "stopped";
    } catch (error) {
      terminalStatus = "failed";
      this.statusValue = "failed";
      this.lastErrorAt = this.now().toISOString();
      this.lastErrorHash = safeErrorHash(error);
      structuredLog("error", "worker_loop_failed", {
        workerId: this.config.workerId,
        errorHash: this.lastErrorHash
      });
      throw error;
    } finally {
      const stoppedAt = this.now().toISOString();
      try {
        await this.registry.stop({
          workerId: this.config.workerId,
          status: terminalStatus,
          stoppedAt,
          metadata: {
            cycles: this.cycles,
            lastSuccessAt: this.lastSuccessAt ?? null,
            lastErrorAt: this.lastErrorAt ?? null,
            lastErrorHash: this.lastErrorHash ?? null
          }
        });
      } catch (error) {
        if (terminalStatus !== "failed") throw error;
      }
      structuredLog("info", "worker_stopped", {
        workerId: this.config.workerId,
        status: terminalStatus,
        cycles: this.cycles
      });
    }
  }
}

export function readPersistentOrchestrationWorkerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): PersistentOrchestrationWorkerConfig {
  const workerId = env.GETDONE_ORCHESTRATION_WORKER_ID?.trim();
  if (!workerId) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_ORCHESTRATION_WORKER_ID is required"
    );
  }
  const numberValue = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new ControlPlaneError("UNAVAILABLE", `${name} must be an integer`);
    }
    return parsed;
  };
  return Object.freeze({
    workerId,
    pollIntervalMs: numberValue("GETDONE_ORCHESTRATION_POLL_INTERVAL_MS", 1_000),
    errorBackoffMs: numberValue("GETDONE_ORCHESTRATION_ERROR_BACKOFF_MS", 5_000)
  });
}
