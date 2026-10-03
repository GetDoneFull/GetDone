import { timingSafeEqual } from "node:crypto";
import {
  GovernedBusinessActionCredentialBroker,
  readCredentialDeliveryProviderFromEnv
} from "@/lib/credentials/runtime-broker";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { assertTrustedExecutionScopeEqual } from "@/lib/control-plane/trusted-execution-scope";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import { JobService, type JobRecord, type JobStores } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import { createOrdinaryBusinessActionBindingsFromEnv } from "@/lib/execution/adapters/ordinary-integration-registry";
import { BusinessActionExecutionOrchestrator } from "@/lib/execution/business-action-orchestrator";
import { PostgresCurrentExecutionAdmissionGate } from "@/lib/execution/current-execution-admission";
import {
  PostgresProviderConcurrencyGate,
  readProviderConcurrencyConfigFromEnv
} from "@/lib/execution/provider-concurrency.server";
import { getDurableJobEngineFromEnv } from "@/lib/execution/durable-job-engine.server";
import {
  createPersistedJobExecutionSpec,
  RoutedJobExecutionHandler
} from "@/lib/execution/job-execution-router";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import { jobSideEffectIdempotencyKey } from "@/lib/orchestration/execution-idempotency";
import { planOwnerNotification } from "@/lib/mobile/notifications";
import { PostgresBusinessActionExecutionStore } from "@/lib/persistence/postgres/execution-stores";
import { PostgresAnalyticsIngestionStore } from "@/lib/persistence/postgres/analytics-ingestion-store";
import { PostgresCredentialBrokerStore } from "@/lib/persistence/postgres/credential-broker-store";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import {
  PostgresAuthorizationGrantStore,
  PostgresEntityStore,
  PostgresJobExecutionBridgeStore,
  PostgresVerificationReceiptStore
} from "@/lib/persistence/postgres/authority-stores";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";
import { PostgresJobVerificationEvidenceStore } from "@/lib/persistence/postgres/worker-runtime-stores";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { getTelemetry, OTEL_SEMANTIC } from "@/lib/observability/telemetry";

export class MvpJobRuntime {
  constructor(
    private readonly engine: ReturnType<typeof getDurableJobEngineFromEnv>,
    private readonly specs: PostgresJobExecutionSpecStore,
    private readonly handler: RoutedJobExecutionHandler,
    private readonly jobs: Pick<PostgresEntityStore<JobRecord>, "get">,
    private readonly now: () => Date = () => new Date()
  ) {}

  async enqueueAuthorizedBusinessAction(job: JobRecord, request: AuthorizedBusinessActionRequest) {
    return getTelemetry().withSpan("job.enqueue", {
      [OTEL_SEMANTIC.jobId]: job.id,
      [OTEL_SEMANTIC.capability]: request.capability,
      [OTEL_SEMANTIC.companyId]: request.scope.companyId,
      [OTEL_SEMANTIC.environment]: request.scope.environment,
      [OTEL_SEMANTIC.correlationId]: request.correlationId ?? job.correlationId ?? null
    }, () => runWithPostgresTenantScope(request.scope, async () => {
      try {
        const result = await this.enqueueAuthorizedBusinessActionScoped(job, request);
        await getTelemetry().counter("getdone.job.enqueue.total", 1, {
          [OTEL_SEMANTIC.capability]: request.capability,
          outcome: "accepted"
        });
        return result;
      } catch (error) {
        if (error instanceof ControlPlaneError && ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code)) {
          await getTelemetry().counter("getdone.authorization.denial.total", 1, {
            [OTEL_SEMANTIC.capability]: request.capability,
            [OTEL_SEMANTIC.authorizationOutcome]: "denied"
          });
          await getTelemetry().log("WARN", "authorization.denied", {
            [OTEL_SEMANTIC.jobId]: job.id,
            [OTEL_SEMANTIC.capability]: request.capability,
            [OTEL_SEMANTIC.authorizationOutcome]: "denied"
          });
        }
        throw error;
      }
    }));
  }

  private async enqueueAuthorizedBusinessActionScoped(
    job: JobRecord,
    request: AuthorizedBusinessActionRequest
  ) {
    const authoritative = await this.jobs.get(job.id);
    if (
      !authoritative
      || sha256Hex(authoritative) !== sha256Hex(job)
      || authoritative.state !== "queued"
      || authoritative.id !== request.jobId
      || authoritative.portfolioId !== request.scope.portfolioId
      || authoritative.companyId !== request.scope.companyId
      || !authoritative.authorizationGrantId
      || !authoritative.authorizationGrantHash
      || !authoritative.authorizationConsumption
      || authoritative.authorizationConsumption.consumerType !== "task"
      || authoritative.authorizationConsumption.consumerId !== authoritative.taskId
      || authoritative.authorizationConsumption.grantId !== authoritative.authorizationGrantId
      || authoritative.authorizationConsumption.grantHash !== authoritative.authorizationGrantHash
      || authoritative.authorizationConsumption.consumptionHash !== request.authorizationConsumptionHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Capability dispatch requires the persisted authoritative queued Job and its exact Task authorization consumption"
      );
    }
    assertTrustedExecutionScopeEqual(authoritative.authorizationConsumption.scope, request.scope, {
      requireSameResource: Boolean(
        authoritative.authorizationConsumption.scope.resourceId || request.scope.resourceId
      )
    });
    validateCapabilityInput(request.capability, request.input);
    const correlationId = authoritative.correlationId
      ?? request.correlationId
      ?? (request.scope.environment === "production"
        ? undefined
        : `legacy-job:${authoritative.id}`);
    if (!correlationId) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Production governed Job execution requires persisted correlation lineage"
      );
    }
    const correlatedRequest = Object.freeze({
      ...request,
      correlationId,
      idempotencyKey: jobSideEffectIdempotencyKey(authoritative.id, request.id)
    });
    const createdAt = this.now().toISOString();
    const spec = createPersistedJobExecutionSpec({
      kind: "business-action",
      jobId: authoritative.id,
      authoritativeJobVersion: authoritative.version,
      authoritativeJobHash: sha256Hex(authoritative),
      request: correlatedRequest
    }, createdAt);
    await this.specs.put(spec);
    return this.engine.enqueue(createJobQueueEnvelope({
      id: `queue:${authoritative.id}`,
      correlationId,
      jobId: authoritative.id,
      taskId: authoritative.taskId,
      scope: request.scope,
      authorizationConsumptionHash: request.authorizationConsumptionHash,
      idempotencyKey: `queue:${correlatedRequest.idempotencyKey}`,
      scheduledAt: createdAt,
      createdAt
    }));
  }

  async enqueueAuthorizedHttpAction(job: JobRecord, request: AuthorizedBusinessActionRequest) {
    if (request.capability !== "http.request") {
      throw new ControlPlaneError("FORBIDDEN", "HTTP compatibility entrypoint only accepts http.request");
    }
    return this.enqueueAuthorizedBusinessAction(job, request);
  }

  runOnce(options: { shouldStop?: () => boolean } = {}) {
    return this.engine.runOnce(this.handler, options);
  }

  recoverExpired(limit?: number) {
    return this.engine.recoverExpired(limit);
  }

  async ownerView(jobId: string, taskId: string) {
    const status = await this.engine.status(jobId);
    const runtimeScope = status.runtime?.envelope?.scope;
    const authoritative = runtimeScope
      ? await runWithPostgresTenantScope(
          runtimeScope,
          () => this.jobs.get(jobId)
        )
      : null;

    if (authoritative && authoritative.taskId !== taskId) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Owner Job view task does not match the authoritative Job lineage"
      );
    }

    const latest = status.outcomes.at(-1);
    const durableTerminal = latest
      && ["verified", "dead-lettered", "cancelled", "succeeded"].includes(latest.kind)
      ? latest
      : undefined;
    const authoritativeTerminal = authoritative
      && ["verified", "succeeded", "failed", "cancelled"].includes(authoritative.state)
      ? authoritative
      : undefined;

    const notification = authoritativeTerminal
      ? planOwnerNotification({
          id: `job-authoritative:${sha256Hex({
            id: authoritativeTerminal.id,
            state: authoritativeTerminal.state,
            version: authoritativeTerminal.version,
            verificationReceiptHash: authoritativeTerminal.verificationReceiptHash
          })}`,
          attention: authoritativeTerminal.state === "failed" ? "high" : "fyi",
          target: { kind: "task-result", taskId: authoritativeTerminal.taskId },
          sensitive: true
        })
      : durableTerminal
        ? planOwnerNotification({
            id: `job-outcome:${durableTerminal.recordHash}`,
            attention: durableTerminal.kind === "dead-lettered" ? "high" : "fyi",
            target: { kind: "task-result", taskId },
            sensitive: true
          })
        : null;

    return Object.freeze({
      correlationId:
        authoritative?.correlationId
        ?? status.runtime?.envelope?.correlationId,
      status,
      notification
    });
  }
}

let installed: MvpJobRuntime | null = null;

export function getMvpJobRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (installed) return installed;
  const database = getPostgresRuntimeFromEnv(env).database;
  const credentialStore = new PostgresCredentialBrokerStore(database);
  const credentialBroker = env.GETDONE_CREDENTIAL_DELIVERY_URL?.trim()
    && env.GETDONE_CREDENTIAL_BROKER_TOKEN?.trim()
    ? new GovernedBusinessActionCredentialBroker(
        credentialStore,
        credentialStore,
        readCredentialDeliveryProviderFromEnv(env)
      )
    : undefined;
  const business = new BusinessActionExecutionOrchestrator(
    new StaticBusinessActionAdapterRegistry(
      createOrdinaryBusinessActionBindingsFromEnv(env, {
        analyticsStore: new PostgresAnalyticsIngestionStore(database)
      })
    ),
    new PostgresBusinessActionExecutionStore(database),
    {
      providerConcurrencyGate: new PostgresProviderConcurrencyGate(
        database,
        readProviderConcurrencyConfigFromEnv(env)
      ),
      credentialBroker
    }
  );
  const specs = new PostgresJobExecutionSpecStore(database);
  const jobs = new PostgresEntityStore<JobRecord>(database, "job");
  const tasks = new PostgresEntityStore<TaskRecord>(database, "task");
  const grants = new PostgresAuthorizationGrantStore(database);
  const jobLifecycle = new JobService(
    new PostgresControlPlaneTransactionManager<JobStores>(
      database,
      (client) => ({
        jobs: new PostgresEntityStore<JobRecord>(client, "job"),
        authorizationGrants: new PostgresAuthorizationGrantStore(client),
        verificationReceipts: new PostgresVerificationReceiptStore(client),
        executionBridge: new PostgresJobExecutionBridgeStore(client)
      })
    )
  );
  installed = new MvpJobRuntime(
    getDurableJobEngineFromEnv(env),
    specs,
    new RoutedJobExecutionHandler(
      specs,
      business,
      undefined,
      {
        jobs,
        tasks,
        grants,
        admission: new PostgresCurrentExecutionAdmissionGate(database),
        verificationEvidence: new PostgresJobVerificationEvidenceStore(database),
        lifecycle: jobLifecycle
      }
    ),
    jobs
  );
  return installed;
}

export function assertInternalWorkerToken(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const expected = env.GETDONE_INTERNAL_WORKER_TOKEN?.trim();
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected || !actual) throw new ControlPlaneError("UNAUTHENTICATED", "Internal worker token is required");
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ControlPlaneError("UNAUTHENTICATED", "Internal worker token is invalid");
  }
}

export function resetMvpJobRuntimeForTests() {
  installed = null;
}
