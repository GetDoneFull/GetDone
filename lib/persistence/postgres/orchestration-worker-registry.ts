import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OrchestrationWorkerRegistry } from "@/lib/orchestration/worker-contracts";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

function assertTimestamp(value: string, label: string) {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a timestamp`);
  }
}

function metadata(value: Readonly<Record<string, unknown>> | undefined) {
  return JSON.stringify(value ?? {});
}

export class PostgresOrchestrationWorkerRegistry implements OrchestrationWorkerRegistry {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async start(input: {
    workerId: string;
    processVersion: string;
    startedAt: string;
    metadata?: Readonly<Record<string, unknown>>;
  }) {
    if (!input.workerId.trim() || !input.processVersion.trim()) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Orchestration worker identity and processVersion are required"
      );
    }
    assertTimestamp(input.startedAt, "orchestration worker startedAt");

    await this.db.query(
      `INSERT INTO orchestration_worker_instances(
         worker_id,status,process_version,started_at,heartbeat_at,ready_at,stopped_at,metadata,updated_at
       )
       VALUES($1,'starting',$2,$3,$3,NULL,NULL,$4::jsonb,$3)
       ON CONFLICT(worker_id) DO UPDATE SET
         status='starting',
         process_version=EXCLUDED.process_version,
         started_at=EXCLUDED.started_at,
         heartbeat_at=EXCLUDED.heartbeat_at,
         ready_at=NULL,
         stopped_at=NULL,
         metadata=EXCLUDED.metadata,
         updated_at=EXCLUDED.updated_at`,
      [input.workerId, input.processVersion, input.startedAt, metadata(input.metadata)]
    );
  }

  async heartbeat(input: {
    workerId: string;
    status: "starting" | "running" | "draining" | "stopped" | "failed";
    heartbeatAt: string;
    ready: boolean;
    metadata?: Readonly<Record<string, unknown>>;
  }) {
    if (!input.workerId.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Orchestration workerId is required");
    }
    assertTimestamp(input.heartbeatAt, "orchestration worker heartbeatAt");

    const result = await this.db.query(
      `UPDATE orchestration_worker_instances
       SET
         status=$2,
         heartbeat_at=$3,
         ready_at=CASE WHEN $4 THEN COALESCE(ready_at,$3) ELSE ready_at END,
         metadata=$5::jsonb,
         updated_at=$3
       WHERE worker_id=$1`,
      [input.workerId, input.status, input.heartbeatAt, input.ready, metadata(input.metadata)]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Orchestration worker registry heartbeat requires a started worker"
      );
    }
  }

  async stop(input: {
    workerId: string;
    status: "stopped" | "failed";
    stoppedAt: string;
    metadata?: Readonly<Record<string, unknown>>;
  }) {
    if (!input.workerId.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Orchestration workerId is required");
    }
    assertTimestamp(input.stoppedAt, "orchestration worker stoppedAt");

    const result = await this.db.query(
      `UPDATE orchestration_worker_instances
       SET
         status=$2,
         heartbeat_at=$3,
         stopped_at=$3,
         metadata=$4::jsonb,
         updated_at=$3
       WHERE worker_id=$1`,
      [input.workerId, input.status, input.stoppedAt, metadata(input.metadata)]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Orchestration worker registry stop requires a started worker"
      );
    }
  }
}
