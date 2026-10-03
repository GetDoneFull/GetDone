import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { JobRecord } from "@/lib/domain/services/job-service";
import {
  assertInternalWorkerToken,
  MvpJobRuntime
} from "@/lib/execution/mvp-job-runtime.server";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import type { PersistedJobExecutionSpec } from "@/lib/execution/job-execution-router";
import type { JobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

const consumption = {
  id: "consumption-1",
  grantId: "grant-1",
  grantHash: "grant-hash",
  consumerType: "task" as const,
  consumerId: "task-1",
  scope,
  planHash: "plan-hash",
  stepHash: "step-hash",
  consumedAt: "2026-09-22T12:00:00Z",
  consumptionHash: "consumption-hash"
};

const correlationId = "corr-mvp-runtime-1";

const job: JobRecord = {
  id: "job-1",
  correlationId,
  portfolioId: "portfolio-a",
  companyId: "company-a",
  state: "queued",
  taskId: "task-1",
  attempt: 0,
  maxAttempts: 5,
  authorizationGrantId: "grant-1",
  authorizationGrantHash: "grant-hash",
  authorizationConsumption: consumption,
  verificationEvidenceIds: [],
  version: 2,
  updatedAt: "2026-09-22T12:00:00Z"
};

function action(capability = "http.request"): AuthorizedBusinessActionRequest {
  const input = {
    companyId: "company-a",
    operation: "crm.contact.sync",
    payload: { contactId: "contact-1" }
  };
  return {
    id: "action-1",
    correlationId,
    jobId: "job-1",
    scope,
    capability,
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: consumption.consumptionHash,
    credentialLeaseId: "credential-lease-1",
    idempotencyKey: "action-key",
    timeoutMs: 5_000,
    attempt: 1
  };
}

describe("MVP capability-dispatched Job runtime", () => {
  const jobs = { get: async (id: string) => id === job.id ? job : null };

  it("persists a capability spec before queueing an authorized Job", async () => {
    const stored: PersistedJobExecutionSpec[] = [];
    const enqueued: JobQueueEnvelope[] = [];
    const engine = {
      enqueue: async (record: JobQueueEnvelope) => {
        enqueued.push(record);
        return { status: "enqueued" as const };
      }
    } as unknown as ConstructorParameters<typeof MvpJobRuntime>[0];
    const specs = {
      put: async (record: PersistedJobExecutionSpec) => { stored.push(record); }
    } as unknown as ConstructorParameters<typeof MvpJobRuntime>[1];
    const runtime = new MvpJobRuntime(
      engine,
      specs,
      {} as unknown as ConstructorParameters<typeof MvpJobRuntime>[2],
      jobs as ConstructorParameters<typeof MvpJobRuntime>[3],
      () => new Date("2026-09-22T12:00:00Z")
    );
    await runtime.enqueueAuthorizedHttpAction(job, action());
    expect(stored[0]).toMatchObject({
      jobId: "job-1",
      spec: {
        kind: "business-action",
        request: {
          capability: "http.request",
          correlationId,
          idempotencyKey: "job:job-1:side-effect:action-1"
        }
      }
    });
    expect(enqueued[0]).toMatchObject({
      correlationId,
      jobId: "job-1",
      taskId: "task-1",
      authorizationConsumptionHash: "consumption-hash",
      idempotencyKey: "queue:job:job-1:side-effect:action-1"
    });
  });

  it("rejects hardware-specific dispatch and mismatched authorization lineage", async () => {
    const runtime = new MvpJobRuntime(
      {} as unknown as ConstructorParameters<typeof MvpJobRuntime>[0],
      {} as unknown as ConstructorParameters<typeof MvpJobRuntime>[1],
      {} as unknown as ConstructorParameters<typeof MvpJobRuntime>[2],
      jobs as ConstructorParameters<typeof MvpJobRuntime>[3]
    );
    await expect(runtime.enqueueAuthorizedBusinessAction(job, action("raspberryPi5")))
      .rejects.toThrow(/Capability is unavailable/i);
    await expect(runtime.enqueueAuthorizedHttpAction(
      job,
      { ...action(), authorizationConsumptionHash: "forged" }
    )).rejects.toThrow(/authorization consumption/i);
  });

  it("returns an owner-safe notification derived from durable outcome truth", async () => {
    const runtime = new MvpJobRuntime({
      status: async () => ({
        runtime: {
          state: "released",
          envelope: { correlationId }
        },
        outcomes: [{
          id: "outcome-1",
          jobId: "job-1",
          kind: "verified",
          runtimeState: "released",
          attempt: 1,
          occurredAt: "2026-09-22T12:00:00Z",
          transactionHash: "transaction-hash",
          recordHash: "outcome-hash"
        }],
        events: []
      })
    } as unknown as ConstructorParameters<typeof MvpJobRuntime>[0],
    {} as unknown as ConstructorParameters<typeof MvpJobRuntime>[1],
    {} as unknown as ConstructorParameters<typeof MvpJobRuntime>[2],
    jobs as ConstructorParameters<typeof MvpJobRuntime>[3]);
    const view = await runtime.ownerView("job-1", "task-1");
    expect(view.correlationId).toBe(correlationId);
    expect(view.notification).toMatchObject({
      destination: "/?focus=task-result&id=task-1",
      requiresAuthoritativeFetch: true
    });
  });

  it("does not notify the owner when execution only reached provider completion", async () => {
    const runtime = new MvpJobRuntime({
      status: async () => ({
        runtime: {
          state: "released",
          envelope: { correlationId }
        },
        outcomes: [{
          id: "outcome-provider",
          jobId: "job-1",
          kind: "provider-completed",
          runtimeState: "released",
          attempt: 1,
          occurredAt: "2026-09-22T12:00:00Z",
          transactionHash: "provider-transaction",
          recordHash: "provider-outcome-hash"
        }],
        events: []
      })
    } as unknown as ConstructorParameters<typeof MvpJobRuntime>[0],
    {} as unknown as ConstructorParameters<typeof MvpJobRuntime>[1],
    {} as unknown as ConstructorParameters<typeof MvpJobRuntime>[2],
    jobs as ConstructorParameters<typeof MvpJobRuntime>[3]);

    expect((await runtime.ownerView("job-1", "task-1")).notification).toBeNull();
  });

  it("protects the internal worker trigger with constant-time bearer authentication", () => {
    const env = { GETDONE_INTERNAL_WORKER_TOKEN: "worker-secret" };
    expect(() => assertInternalWorkerToken(new Request("https://getdone.test", {
      headers: { authorization: "Bearer worker-secret" }
    }), env)).not.toThrow();
    expect(() => assertInternalWorkerToken(new Request("https://getdone.test", {
      headers: { authorization: "Bearer wrong" }
    }), env)).toThrow(/invalid/i);
  });
});
