import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createAuthorizationConsumptionRecord,
  type AuthorizationGrant
} from "@/lib/authorization/grants";
import {
  CAPABILITY_REGISTRY_HASH,
  CAPABILITY_REGISTRY_VERSION
} from "@/lib/domain/capabilities";
import {
  CURRENT_POLICY_REGISTRY_HASH,
  CURRENT_POLICY_VERSION
} from "@/lib/domain/policy-registry";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import { POLICY_ENGINE_VERSION, POLICY_RULES_HASH } from "@/lib/planning/policy-engine";
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

const now = new Date("2026-09-21T04:00:00Z");
const scope = {
  userId: "owner",
  portfolioId: "portfolio",
  companyId: "company",
  environment: "staging" as const
};

const grantBase = {
  id: "grant-1",
  status: "active" as const,
  disposition: "APPROVAL_REQUIRED" as const,
  scope,
  planId: "plan-1",
  planVersion: 1,
  planHash: "plan-hash",
  stepId: "step-1",
  stepHash: "step-hash",
  capabilityNames: ["email.send"],
  executionLimits: {
    environment: "staging" as const,
    expectedDurationSeconds: 30,
    retryable: true
  },
  validationReceiptId: "validation-1",
  validationReceiptHash: "validation-hash",
  policySnapshotId: "policy-snapshot-1",
  policySnapshotHash: "policy-snapshot-hash",
  policyVersion: CURRENT_POLICY_VERSION,
  policyRegistryHash: CURRENT_POLICY_REGISTRY_HASH,
  policyEngineVersion: POLICY_ENGINE_VERSION,
  policyRulesHash: POLICY_RULES_HASH,
  capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  capabilityRegistryHash: CAPABILITY_REGISTRY_HASH,
  decisionId: "decision-1",
  approvalProofId: "approval-proof-1",
  approvalProofHash: "approval-proof-hash",
  actor: { type: "user" as const, id: "owner" },
  issuedAt: "2026-09-21T03:58:00Z",
  expiresAt: "2026-09-21T04:10:00Z"
};
const currentGrant: AuthorizationGrant = { ...grantBase, grantHash: sha256Hex(grantBase) };
const currentConsumption = createAuthorizationConsumptionRecord({
  id: `authorization-consumption:${currentGrant.id}`,
  grant: currentGrant,
  consumerType: "task",
  consumerId: "task-1",
  consumedAt: "2026-09-21T03:59:00Z"
});

const envelope = createJobQueueEnvelope({
  id: "queue-1",
  jobId: "job-1",
  taskId: "task-1",
  scope,
  authorizationConsumptionHash: currentConsumption.consumptionHash,
  idempotencyKey: "queue-1",
  scheduledAt: now.toISOString(),
  createdAt: now.toISOString()
});

const authoritativeTask: TaskRecord = {
  id: "task-1",
  portfolioId: "portfolio",
  companyId: "company",
  state: "queued",
  reason: "send governed email",
  evidenceIds: [],
  capabilityRequirements: ["email.send"],
  authorizationLineage: [currentGrant.id],
  authorizationGrantId: currentGrant.id,
  authorizationGrantHash: currentGrant.grantHash,
  authorizationConsumption: currentConsumption,
  verificationEvidenceIds: [],
  version: 2,
  updatedAt: now.toISOString()
};

const authoritativeJob: JobRecord = {
  id: "job-1",
  portfolioId: "portfolio",
  companyId: "company",
  state: "queued",
  taskId: "task-1",
  attempt: 0,
  maxAttempts: 5,
  authorizationGrantId: currentGrant.id,
  authorizationGrantHash: currentGrant.grantHash,
  authorizationConsumption: currentConsumption,
  verificationEvidenceIds: [],
  version: 2,
  updatedAt: now.toISOString()
};

const validEmailInput = {
  companyId: "company",
  to: ["owner@example.com"],
  cc: [],
  subject: "GetDone test",
  text: "hello"
};

function setBusinessSpec(specs: MemorySpecStore, job: JobRecord = authoritativeJob) {
  specs.value = createPersistedJobExecutionSpec({
    kind: "business-action",
    jobId: job.id,
    authoritativeJobVersion: job.version,
    authoritativeJobHash: sha256Hex(job),
    request: {
      id: "action-1",
      jobId: job.id,
      scope,
      capability: "email.send",
      input: validEmailInput,
      inputHash: sha256Hex(validEmailInput),
      authorizationConsumptionHash: currentConsumption.consumptionHash,
      idempotencyKey: "action-1",
      timeoutMs: 1000,
      attempt: 1
    }
  }, now.toISOString());
}

function authority(
  job: JobRecord = authoritativeJob,
  task: TaskRecord = authoritativeTask,
  grant: AuthorizationGrant = currentGrant
) {
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
      tasks: { get: async () => task },
      grants: { get: async () => grant },
      admission: { assertAllowed: async () => undefined },
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
    leaseIssuedAt: now.toISOString(),
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
    setBusinessSpec(specs);

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
      auth.value as never,
      () => now
    );
    expect(await handler.execute(context)).toEqual({ kind: "provider-completed" });
    expect(auth.persisted).toEqual([evidence]);
    expect(auth.lifecycle).toEqual(["claimed", "executing", "provider_completed"]);
  });

  it("rejects stale or cancelled authoritative Job snapshots before side effects", async () => {
    const specs = new MemorySpecStore();
    setBusinessSpec(specs);

    let executions = 0;
    const business = { execute: async () => {
      executions += 1;
      return { record: { state: "completed", retryable: false } };
    } };

    const stale = authority({ ...authoritativeJob, version: 3 });
    const staleHandler = new RoutedJobExecutionHandler(
      specs, business as never, undefined, stale.value as never, () => now
    );
    await expect(staleHandler.execute(context)).resolves.toEqual({
      kind: "dead-letter",
      reason: "Authoritative Job snapshot is stale"
    });

    const cancelled = authority({ ...authoritativeJob, state: "cancelled" });
    const cancelledHandler = new RoutedJobExecutionHandler(
      specs, business as never, undefined, cancelled.value as never, () => now
    );
    await expect(cancelledHandler.execute(context)).resolves.toEqual({
      kind: "cancelled",
      reason: "Authoritative Job was cancelled before execution"
    });

    expect(executions).toBe(0);
  });

  it("re-reads Task and AuthorizationGrant immediately before provider execution", async () => {
    const specs = new MemorySpecStore();
    setBusinessSpec(specs);
    let executions = 0;
    const revokedGrant: AuthorizationGrant = {
      ...currentGrant,
      status: "revoked",
      revokedAt: now.toISOString(),
      grantHash: sha256Hex({
        ...grantBase,
        status: "revoked",
        revokedAt: now.toISOString()
      })
    };
    const auth = authority(authoritativeJob, authoritativeTask, revokedGrant);
    const handler = new RoutedJobExecutionHandler(
      specs,
      {
        execute: async () => {
          executions += 1;
          return { record: { state: "completed", retryable: false } };
        }
      } as never,
      undefined,
      auth.value as never,
      () => now
    );

    const result = await handler.execute(context);
    expect(result.kind).toBe("dead-letter");
    expect(result.kind === "dead-letter" ? result.reason : "").toMatch(/authorization grant|authority is invalid/i);
    expect(executions).toBe(0);
    expect(auth.lifecycle).toEqual([]);
  });

  it("fails closed if the parent Task is no longer executable", async () => {
    const specs = new MemorySpecStore();
    setBusinessSpec(specs);
    let executions = 0;
    const auth = authority(authoritativeJob, { ...authoritativeTask, state: "cancelled" });
    const handler = new RoutedJobExecutionHandler(
      specs,
      {
        execute: async () => {
          executions += 1;
          return { record: { state: "completed", retryable: false } };
        }
      } as never,
      undefined,
      auth.value as never,
      () => now
    );

    const result = await handler.execute(context);
    expect(result).toMatchObject({ kind: "dead-letter" });
    expect(executions).toBe(0);
    expect(auth.lifecycle).toEqual([]);
  });

  it("rejects tampered persisted execution specs", async () => {
    const specs = new MemorySpecStore();
    const valid = createPersistedJobExecutionSpec({
      kind: "software-prepare",
      jobId: "job-1",
      plan: {} as never
    }, now.toISOString());
    specs.value = { ...valid, specHash: "tampered" };
    const handler = new RoutedJobExecutionHandler(specs, {} as never, {} as never);
    await expect(handler.execute(context)).rejects.toThrow(/tampered/i);
  });
});
