import type { DedicatedOrchestrationWorkerProcess } from "@/lib/orchestration/worker-process.server";
import {
  createAuthoritativeOrchestrationWorkerProcessFromEnv
} from "@/lib/orchestration/orchestration-worker-runtime.server";

let workerProcess: DedicatedOrchestrationWorkerProcess | null = null;
let terminating = false;

function safeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

async function terminate(exitCode: number, reason: string, error?: unknown) {
  if (terminating) return;
  terminating = true;

  if (error) {
    console.error("GetDone orchestration worker terminating", {
      reason,
      ...safeError(error)
    });
  } else {
    console.log("GetDone orchestration worker draining", { reason });
  }

  try {
    workerProcess?.requestDrain();
    if (workerProcess) await workerProcess.shutdown();
  } catch (shutdownError) {
    console.error(
      "GetDone orchestration worker shutdown failed",
      safeError(shutdownError)
    );
    exitCode = 1;
  }

  process.exit(exitCode);
}

process.once("SIGTERM", () => {
  void terminate(0, "SIGTERM");
});
process.once("SIGINT", () => {
  void terminate(0, "SIGINT");
});
process.once("uncaughtException", (error) => {
  void terminate(1, "uncaughtException", error);
});
process.once("unhandledRejection", (error) => {
  void terminate(1, "unhandledRejection", error);
});

async function main() {
  try {
    workerProcess = await createAuthoritativeOrchestrationWorkerProcessFromEnv();
    await workerProcess.start();
    console.log("GetDone orchestration worker ready", workerProcess.health());
  } catch (error) {
    await terminate(1, "startup-failure", error);
  }
}

void main();
