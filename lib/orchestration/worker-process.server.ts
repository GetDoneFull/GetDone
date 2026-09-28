import { createServer, type Server } from "node:http";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { PersistentOrchestrationWorkerService } from "@/lib/orchestration/persistent-worker.server";

export type DedicatedOrchestrationWorkerProcessState =
  | "starting"
  | "running"
  | "draining"
  | "stopped"
  | "failed";

export interface DedicatedOrchestrationWorkerProcessConfig {
  healthHost: string;
  healthPort: number;
}

function positivePort(value: string | undefined) {
  const parsed = value?.trim() ? Number(value) : 3002;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_ORCHESTRATION_WORKER_HEALTH_PORT must be an integer from 1 through 65535"
    );
  }
  return parsed;
}

export function readDedicatedOrchestrationWorkerProcessConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): DedicatedOrchestrationWorkerProcessConfig {
  const host = env.GETDONE_ORCHESTRATION_WORKER_HEALTH_HOST?.trim() || "0.0.0.0";
  if (host.includes("/") || host.includes("\\") || host.length > 255) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_ORCHESTRATION_WORKER_HEALTH_HOST is invalid"
    );
  }
  return Object.freeze({
    healthHost: host,
    healthPort: positivePort(env.GETDONE_ORCHESTRATION_WORKER_HEALTH_PORT)
  });
}

function listen(server: Server, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server | null) {
  if (!server?.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
}

export class DedicatedOrchestrationWorkerProcess {
  private stateValue: DedicatedOrchestrationWorkerProcessState = "starting";
  private server: Server | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly worker: Pick<
      PersistentOrchestrationWorkerService,
      "start" | "stop" | "requestStop" | "snapshot" | "isReady"
    >,
    private readonly closeDatabase: () => Promise<void>,
    private readonly config: DedicatedOrchestrationWorkerProcessConfig
  ) {}

  state() {
    return this.stateValue;
  }

  healthAddress() {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    return Object.freeze({ host: address.address, port: address.port });
  }

  health() {
    return Object.freeze({
      service: "getdone-orchestration-worker",
      state: this.stateValue,
      ...this.worker.snapshot()
    });
  }

  private healthServer() {
    return createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");

      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("allow", "GET");
        response.end(JSON.stringify({ ok: false }));
        return;
      }

      if (request.url === "/livez") {
        const live = this.stateValue !== "failed" && this.stateValue !== "stopped";
        response.statusCode = live ? 200 : 503;
        response.end(JSON.stringify({
          ok: live,
          service: "getdone-orchestration-worker",
          state: this.stateValue
        }));
        return;
      }

      if (request.url === "/readyz") {
        const ready = this.stateValue === "running" && this.worker.isReady();
        response.statusCode = ready ? 200 : 503;
        response.end(JSON.stringify({
          ok: ready,
          ...this.health()
        }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false }));
    });
  }

  async start() {
    if (this.stateValue !== "starting") {
      throw new ControlPlaneError(
        "CONFLICT",
        "Dedicated orchestration worker process has already started"
      );
    }

    try {
      await this.worker.start();
      this.server = this.healthServer();
      await listen(this.server, this.config.healthHost, this.config.healthPort);
      this.stateValue = "running";
    } catch (error) {
      this.stateValue = "failed";
      this.worker.requestStop();
      try { await this.worker.stop(); } catch {}
      try { await closeServer(this.server); } catch {}
      try { await this.closeDatabase(); } catch {}
      throw error;
    }
  }

  requestDrain() {
    if (this.stateValue === "stopped" || this.stateValue === "failed") return;
    this.stateValue = "draining";
    this.worker.requestStop();
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal() {
    this.requestDrain();
    let shutdownError: unknown;
    try {
      await this.worker.stop();
    } catch (error) {
      shutdownError = error;
    }

    try {
      await this.closeDatabase();
    } catch (error) {
      shutdownError ??= error;
    }

    try {
      await closeServer(this.server);
    } catch (error) {
      shutdownError ??= error;
    }

    this.stateValue = shutdownError ? "failed" : "stopped";
    if (shutdownError) throw shutdownError;
  }
}


export interface OrchestrationWorkerSignalTarget {
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exitCode?: number;
}

export function installOrchestrationWorkerShutdownHooks(
  workerProcess: Pick<DedicatedOrchestrationWorkerProcess, "requestDrain" | "shutdown">,
  signalTarget: OrchestrationWorkerSignalTarget =
    process as unknown as OrchestrationWorkerSignalTarget
) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    workerProcess.requestDrain();
    void workerProcess.shutdown().catch(() => {
      signalTarget.exitCode = 1;
    });
  };

  signalTarget.once("SIGTERM", stop);
  signalTarget.once("SIGINT", stop);

  return () => {
    signalTarget.off("SIGTERM", stop);
    signalTarget.off("SIGINT", stop);
  };
}
