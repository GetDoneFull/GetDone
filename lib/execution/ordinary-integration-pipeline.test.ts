import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import { ConfiguredHttpActionAdapter } from "@/lib/execution/adapters/configured-http-action";
import { ConfiguredWebhookActionAdapter } from "@/lib/execution/adapters/configured-webhook-action";
import { GmailBusinessActionAdapter } from "@/lib/execution/adapters/gmail-action";
import { CrmBusinessActionAdapter } from "@/lib/execution/adapters/crm-action";
import {
  BusinessActionExecutionOrchestrator,
  type BusinessActionExecutionRecord
} from "@/lib/execution/business-action-orchestrator";
import {
  createPersistedJobExecutionSpec,
  RoutedJobExecutionHandler,
  type PersistedJobExecutionSpec
} from "@/lib/execution/job-execution-router";
import {
  createDurableJobLease,
  createJobQueueEnvelope
} from "@/lib/execution/job-runtime-contracts";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

function authoritativeJob(id: string, taskId: string, consumptionHash: string): JobRecord {
  return {
    id,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    state: "queued",
    taskId,
    attempt: 0,
    maxAttempts: 5,
    authorizationGrantId: `grant-${id}`,
    authorizationGrantHash: `grant-hash-${id}`,
    authorizationConsumption: {
      id: `consumption-${id}`,
      grantId: `grant-${id}`,
      grantHash: `grant-hash-${id}`,
      consumerType: "task",
      consumerId: taskId,
      scope,
      planHash: `plan-${id}`,
      stepHash: `step-${id}`,
      consumedAt: "2026-09-22T16:00:00Z",
      consumptionHash
    },
    verificationEvidenceIds: [],
    version: 2,
    updatedAt: "2026-09-22T16:00:00Z"
  };
}

function action(input: {
  id: string;
  jobId: string;
  capability: string;
  payload: unknown;
  consumptionHash: string;
}): AuthorizedBusinessActionRequest {
  return {
    id: input.id,
    jobId: input.jobId,
    scope,
    capability: input.capability,
    input: input.payload,
    inputHash: sha256Hex(input.payload),
    authorizationConsumptionHash: input.consumptionHash,
    credentialLeaseId: `lease-${input.id}`,
    idempotencyKey: `key-${input.id}`,
    timeoutMs: 5_000,
    attempt: 1
  };
}

describe("ordinary integration governed Job pipeline exit gate", () => {
  it("executes HTTPS, webhook, Gmail, and CRM through the exact same governed Job handler", async () => {
    const now = () => new Date("2026-09-22T16:00:00Z");
    const http = new ConfiguredHttpActionAdapter([{
      name: "crm.sync",
      companyId: "company-a",
      environment: "production",
      url: "https://http.example.test/action"
    }], {
      fetchImpl: async () => new Response("ok", {
        status: 200,
        headers: { "x-provider-operation-id": "http-provider-1" }
      }),
      now
    });
    const webhook = new ConfiguredWebhookActionAdapter([{
      name: "notify",
      companyId: "company-a",
      environment: "production",
      url: "https://webhook.example.test/action",
      consequential: false
    }], {
      fetchImpl: async () => new Response('{"accepted":true}', {
        status: 202,
        headers: { "x-provider-operation-id": "webhook-provider-1" }
      }),
      now
    });
    const crm = new CrmBusinessActionAdapter([{
      id: "crm-primary",
      companyId: "company-a",
      environment: "production",
      credentialProviderId: "crm-pipeline-provider",
      baseUrl: "https://crm.example.test/api/",
      objects: {
        contact: { collectionPath: "contacts", itemPath: "contacts/{recordId}" },
        company: { collectionPath: "companies", itemPath: "companies/{recordId}" },
        deal: { collectionPath: "deals", itemPath: "deals/{recordId}" }
      },
      readScopes: ["crm.read"],
      writeScopes: ["crm.write"]
    }], {
      fetchImpl: async (_url, init) => init?.method === "POST"
        ? new Response('{"id":"contact-1","properties":{"email":"owner@example.com"}}', { status: 201 })
        : new Response('{"id":"contact-1","properties":{"email":"owner@example.com"}}', { status: 200 }),
      now
    });
    const gmail = new GmailBusinessActionAdapter([{
      id: "gmail-primary",
      companyId: "company-a",
      environment: "production",
      credentialProviderId: "gmail-pipeline-provider",
      baseUrl: "https://gmail.example.test/",
      verificationMode: "provider-object-read"
    }], {
      fetchImpl: async (_url, init) => init?.method === "POST"
        ? new Response('{"id":"msg-1"}', { status: 200 })
        : new Response('{"id":"msg-1"}', { status: 200 }),
      now
    });

    const requests = [
      action({
        id: "action-http",
        jobId: "job-http",
        capability: "http.request",
        payload: {
          companyId: "company-a",
          operation: "crm.sync",
          payload: { contactId: "contact-1" }
        },
        consumptionHash: "consumption-http"
      }),
      action({
        id: "action-webhook",
        jobId: "job-webhook",
        capability: "webhook.send",
        payload: {
          companyId: "company-a",
          operation: "notify",
          payload: { invoiceId: "inv-1" }
        },
        consumptionHash: "consumption-webhook"
      }),
      action({
        id: "action-crm",
        jobId: "job-crm",
        capability: "crm.record.write",
        payload: {
          companyId: "company-a",
          connectionId: "crm-primary",
          objectType: "contact",
          operation: "create",
          properties: { email: "owner@example.com" }
        },
        consumptionHash: "consumption-crm"
      }),
      action({
        id: "action-email",
        jobId: "job-email",
        capability: "email.send",
        payload: {
          companyId: "company-a",
          to: ["owner@example.com"],
          cc: [],
          subject: "Authorized update",
          text: "hello"
        },
        consumptionHash: "consumption-email"
      })
    ];

    const jobs = new Map<string, JobRecord>([
      ["job-http", authoritativeJob("job-http", "task-http", "consumption-http")],
      ["job-webhook", authoritativeJob("job-webhook", "task-webhook", "consumption-webhook")],
      ["job-crm", authoritativeJob("job-crm", "task-crm", "consumption-crm")],
      ["job-email", authoritativeJob("job-email", "task-email", "consumption-email")]
    ]);
    const specs = new Map<string, PersistedJobExecutionSpec>();
    for (const request of requests) {
      const job = jobs.get(request.jobId)!;
      specs.set(request.jobId, createPersistedJobExecutionSpec({
        kind: "business-action",
        jobId: job.id,
        authoritativeJobVersion: job.version,
        authoritativeJobHash: sha256Hex(job),
        request
      }, "2026-09-22T16:00:00Z"));
    }

    const executions = new Map<string, BusinessActionExecutionRecord>();
    const evidence: string[] = [];
    const orchestrator = new BusinessActionExecutionOrchestrator(
      new StaticBusinessActionAdapterRegistry([
        { capability: "http.request", adapter: http },
        { capability: "webhook.send", adapter: webhook },
        { capability: "crm.record.write", adapter: crm },
        { capability: "email.send", adapter: gmail }
      ]),
      {
        get: async (requestId) => executions.get(requestId) ?? null,
        save: async (record, expected) => {
          const current = executions.get(record.requestId);
          if (current && expected !== current.recordHash) throw new Error("CAS conflict");
          executions.set(record.requestId, record);
        }
      },
      {
        maxStatusPolls: 2,
        pollIntervalMs: 0,
        now,
        credentialBroker: {
          resolve: async ({ request, requirement }) => ({
            leaseId: request.credentialLeaseId!,
            leaseHash: sha256Hex({ leaseId: request.credentialLeaseId }),
            providerId: requirement.providerId,
            capability: request.capability,
            grantedScopes: [...requirement.requiredScopes],
            material: "short-lived-pipeline-token",
            issuedAt: "2026-09-22T15:59:00Z",
            expiresAt: "2099-01-01T00:00:00Z"
          })
        }
      }
    );

    const transitionJob = (
      jobId: string,
      state: JobRecord["state"],
      patch: Partial<JobRecord> = {}
    ) => {
      const current = jobs.get(jobId)!;
      const next: JobRecord = {
        ...current,
        ...patch,
        state,
        version: current.version + 1
      };
      jobs.set(jobId, next);
      return next;
    };

    const handler = new RoutedJobExecutionHandler(
      { get: async (jobId) => specs.get(jobId) ?? null, put: async () => undefined },
      orchestrator,
      undefined,
      {
        jobs: { get: async (jobId) => jobs.get(jobId) ?? null },
        verificationEvidence: {
          put: async (jobId: string, requestId: string) => {
            evidence.push(`${jobId}:${requestId}`);
          },
          get: async () => null
        } as never,
        lifecycle: {
          claim: async (jobId: string, _command: unknown, workerId: string) =>
            transitionJob(jobId, "claimed", {
              workerId,
              attempt: jobs.get(jobId)!.attempt + 1
            }),
          startProviderExecution: async (jobId: string) =>
            transitionJob(jobId, "executing"),
          recordProviderCompletion: async (jobId: string) =>
            transitionJob(jobId, "provider_completed"),
          retry: async (jobId: string) =>
            transitionJob(jobId, "queued", { workerId: undefined }),
          recoverTimeout: async (jobId: string) =>
            transitionJob(jobId, "queued", { workerId: undefined }),
          fail: async (jobId: string) =>
            transitionJob(jobId, "failed"),
          cancel: async (jobId: string) =>
            transitionJob(jobId, "cancelled")
        } as never
      }
    );

    const outcomes = [];
    for (const request of requests) {
      const job = jobs.get(request.jobId)!;
      const envelope = createJobQueueEnvelope({
        id: `queue-${job.id}`,
        jobId: job.id,
        taskId: job.taskId,
        scope,
        authorizationConsumptionHash: request.authorizationConsumptionHash,
        idempotencyKey: `queue-${request.id}`,
        scheduledAt: "2026-09-22T16:00:00Z",
        createdAt: "2026-09-22T16:00:00Z"
      });
      outcomes.push(await handler.execute({
        envelope,
        lease: createDurableJobLease({
          id: `lease-${job.id}`,
          jobId: job.id,
          workerId: "worker-a",
          attempt: 1,
          leaseIssuedAt: "2026-09-22T16:00:00Z",
          leaseSeconds: 60
        }),
        heartbeat: async () => undefined,
        runtimeVersion: () => 2,
        runtimeHash: () => "runtime-hash"
      }));
    }

    expect(outcomes).toEqual([
      { kind: "provider-completed" },
      { kind: "provider-completed" },
      { kind: "provider-completed" },
      { kind: "provider-completed" }
    ]);
    expect(evidence).toEqual([
      "job-http:action-http",
      "job-webhook:action-webhook",
      "job-crm:action-crm",
      "job-email:action-email"
    ]);
    expect([...executions.values()].map((record) => record.adapterId).sort()).toEqual([
      "configured-http-action",
      "configured-webhook-action",
      "crm-business-action",
      "gmail-business-action"
    ]);
  });
});
