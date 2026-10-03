import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { JobRecord } from "@/lib/domain/services/job-service";
import {
  createDurableJobLease,
  createJobQueueEnvelope
} from "@/lib/execution/job-runtime-contracts";
import {
  RoutedJobExecutionHandler,
  createPersistedJobExecutionSpec,
  type JobExecutionSpecStore,
  type PersistedJobExecutionSpec
} from "@/lib/execution/job-execution-router";
import type { DurableJobExecutionContext } from "@/lib/execution/job-worker-runtime";
import { createVerificationEvidence } from "@/lib/verification/verification";

class MemorySpecStore implements JobExecutionSpecStore {
  value: PersistedJobExecutionSpec | null = null;
  async get(jobId: string) { return this.value?.jobId === jobId ? this.value : null; }
  async put(record: PersistedJobExecutionSpec) { this.value = record; }
}

const envelope = createJobQueueEnvelope({
  id: "queue-1",
  jobId: "job-1",
  taskId: "task-1",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "staging"
  },
  authorizationConsumptionHash: "auth",
  idempotencyKey: "queue-1",
  scheduledAt: "2026-09-21T04:00:00Z",
  createdAt: "2026-09-21T04:00:00Z"
});

const authoritativeJob: JobRecord = {
  id: "job-1",
  portfolioId: "portfolio",
  companyId: "company",
  state: "queued",
  taskId: "task-1",
  attempt: 0,
  maxAttempts: 5,
  authorizationGrantId: "grant-1",
  authorizationGrantHash: "grant-hash",
  authorizationConsumption: {
    id: "consumption-1",
    grantId: "grant-1",
    grantHash: "grant-hash",
    consumerType: "task",
    consumerId: "task-1",
    scope: envelope.scope,
    planHash: "plan-hash",
    stepHash: "step-hash",
    consumedAt: "2026-09-21T03:59:00Z",
    consumptionHash: "auth"
  },
  verificationEvidenceIds: [],
  version: 2,
  updatedAt: "2026-09-21T04:00:00Z"
};

function authority(job: JobRecord = authoritativeJob) {
  const persisted: unknown[] = [];
  const lifecycle: string[] = [];
  const claimed: JobRecord = {
    ...job,
    state: "claimed",
    workerId: "worker-1",
    attempt: job.attempt + 1,
    version: job.version + 1
  };
  const executing: JobRecord = {
    ...claimed,
    state: "executing",
    version: claimed.version + 1
  };
  return {
    persisted,
    lifecycle,
    value: {
      jobs: { get: async () => job },
      verificationEvidence: {
        put: async (_jobId: string, _requestId: string, evidence: unknown) => {
          persisted.push(evidence);
        }
      },
      lifecycle: {
        claim: async () => {
          lifecycle.push("claimed");
          return claimed;
        },
        startProviderExecution: async () => {
          lifecycle.push("executing");
          return executing;
        },
        recordProviderCompletion: async () => {
          lifecycle.push("provider_completed");
          return { ...executing, state: "provider_completed" as const };
        },
        retry: async () => {
          lifecycle.push("retry");
          return { ...executing, state: "queued" as const };
        },
        recoverTimeout: async () => {
          lifecycle.push("recover-timeout");
          return { ...executing, state: "queued" as const };
        },
        fail: async () => {
          lifecycle.push("failed");
          return { ...executing, state: "failed" as const };
        },
        cancel: async () => {
          lifecycle.push("cancelled");
          return { ...executing, state: "cancelled" as const };
        }
      }
    }
  };
}

const context = {
  envelope,
  lease: createDurableJobLease({
    id: "lease-1",
    jobId: "job-1",
    workerId: "worker-1",
    attempt: 1,
    leaseIssuedAt: "2026-09-21T04:00:00Z",
    leaseSeconds: 60
  }),
  heartbeat: async () => undefined,
  runtimeVersion: () => 1,
  runtimeHash: () => "hash"
} satisfies DurableJobExecutionContext;

describe("RoutedJobExecutionHandler", () => {
  it("dead-letters a Job with no durable execution spec", async () => {
    const handler = new RoutedJobExecutionHandler(
      new MemorySpecStore(),
      {} as never,
      {} as never
    );
    await expect(handler.execute(context)).resolves.toEqual({
      kind: "dead-letter",
      reason: "Job execution spec is missing"
    });
  });

  it("routes completed business actions to verification handoff and persists evidence", async () => {
    const specs = new MemorySpecStore();
    const payload = { message: "hello" };
    specs.value = createPersistedJobExecutionSpec({
      kind: "business-action",
      jobId: "job-1",
      authoritativeJobVersion: authoritativeJob.version,
      authoritativeJobHash: sha256Hex(authoritativeJob),
      request: {
        id: "action-1",
        jobId: "job-1",
        scope: envelope.scope,
        capability: "email.send",
        input: payload,
        inputHash: sha256Hex(payload),
        authorizationConsumptionHash: "auth",
        idempotencyKey: "action-1",
        timeoutMs: 1000,
        attempt: 1
      }
    }, "2026-09-21T04:00:00Z");

    const evidence = createVerificationEvidence({
      id: "evidence-1",
      portfolioId: "portfolio",
      companyId: "company",
      subject: { type: "job", id: "job-1" },
      strategy: "business",
      result: "pass",
      sourceType: "provider",
      sourceId: "provider:operation-1",
      independenceKey: "operation-1",
      observedAt: "2026-09-21T04:00:01Z",
      payloadHash: "payload-hash",
      provenance: "test"
    });
    const business = {
      execute: async () => ({
        record: {
          requestId: "action-1",
          providerOperationId: "operation-1",
          state: "completed",
          retryable: false,
          recordHash: "provider-record-hash",
          updatedAt: "2026-09-21T04:00:01Z"
        },
        verificationEvidence: evidence
      })
    };
    const auth = authority();
    const handler = new RoutedJobExecutionHandler(
      specs,
      business as never,
      undefined,
      auth.value as never
    );
    expect(await handler.execute(context)).toEqual({ kind: "provider-completed" });
    expect(auth.persisted).toEqual([evidence]);
    expect(auth.lifecycle).toEqual(["claimed", "executing", "provider_completed"]);
  });

  it("rejects stale or cancelled authoritative Job snapshots before side effects", async () => {
    const specs = new MemorySpecStore();
    specs.value = createPersistedJobExecutionSpec({
      kind: "business-action",
      jobId: "job-1",
      authoritativeJobVersion: authoritativeJob.version,
      authoritativeJobHash: sha256Hex(authoritativeJob),
      request: {
        id: "action-1",
        jobId: "job-1",
        scope: envelope.scope,
        capability: "email.send",
        input: { message: "hello" },
        inputHash: sha256Hex({ message: "hello" }),
        authorizationConsumptionHash: "auth",
        idempotencyKey: "action-1",
        timeoutMs: 1000,
        attempt: 1
      }
    }, "2026-09-21T04:00:00Z");

    let executions = 0;
    const business = { execute: async () => {
      executions += 1;
      return { record: { state: "completed", retryable: false } };
    } };

    const stale = authority({ ...authoritativeJob, version: 3 });
    const staleHandler = new RoutedJobExecutionHandler(
      specs, business as never, undefined, stale.value as never
    );
    await expect(staleHandler.execute(context)).resolves.toEqual({
      kind: "dead-letter",
      reason: "Authoritative Job snapshot is stale"
    });

    const cancelled = authority({ ...authoritativeJob, state: "cancelled" });
    const cancelledHandler = new RoutedJobExecutionHandler(
      specs, business as never, undefined, cancelled.value as never
    );
    await expect(cancelledHandler.execute(context)).resolves.toEqual({
      kind: "cancelled",
      reason: "Authoritative Job was cancelled before execution"
    });

    expect(executions).toBe(0);
  });

  it("rejects tampered persisted execution specs", async () => {
    const specs = new MemorySpecStore();
    const valid = createPersistedJobExecutionSpec({
      kind: "software-prepare",
      jobId: "job-1",
      plan: {} as never
    }, "2026-09-21T04:00:00Z");
    specs.value = { ...valid, specHash: "tampered" };
    const handler = new RoutedJobExecutionHandler(specs, {} as never, {} as never);
    await expect(handler.execute(context)).rejects.toThrow(/tampered/i);
  });
});
