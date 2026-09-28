import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Page } from "@playwright/test";
import { sha256Hex } from "../../lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "../../lib/control-plane/command-envelope";
import type { TrustedExecutionScope } from "../../lib/control-plane/trusted-execution-scope";
import type { AuthoritativeDecision } from "../../lib/domain/decision-service";
import {
  JobService,
  type JobRecord,
  type JobStores
} from "../../lib/domain/services/job-service";
import { CoreTrancheCCoordinator } from "../../lib/domain/services/core-tranche-c-coordinator";
import type { VerificationRequestRecord } from "../../lib/domain/services/verification-service";
import { createObjectiveDesiredOutcome } from "../../lib/domain/objective-outcome";
import {
  TaskService,
  type TaskRecord,
  type TaskStores
} from "../../lib/domain/services/task-service";
import {
  type AuthorizationGrant
} from "../../lib/authorization/grants";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter
} from "../../lib/execution/adapters/business-action";
import { StaticBusinessActionAdapterRegistry } from "../../lib/execution/adapters/business-action-registry";
import { BusinessActionExecutionOrchestrator } from "../../lib/execution/business-action-orchestrator";
import { DurableJobEngine } from "../../lib/execution/durable-job-engine";
import { RoutedJobExecutionHandler } from "../../lib/execution/job-execution-router";
import { DurableJobWorker } from "../../lib/execution/job-worker-runtime";
import { MvpJobRuntime } from "../../lib/execution/mvp-job-runtime.server";
import { PostgresDatabase } from "../../lib/persistence/postgres/client";
import {
  PostgresAuthorizationGrantStore,
  PostgresEntityStore,
  PostgresVerificationReceiptStore
} from "../../lib/persistence/postgres/authority-stores";
import { PostgresControlPlaneTransactionManager } from "../../lib/persistence/postgres/transaction-manager";
import { PostgresDurableJobStore } from "../../lib/persistence/postgres/job-store";
import { PostgresJobExecutionSpecStore } from "../../lib/persistence/postgres/job-execution-spec-store";
import { PostgresBusinessActionExecutionStore } from "../../lib/persistence/postgres/execution-stores";
import { PostgresJobVerificationEvidenceStore } from "../../lib/persistence/postgres/worker-runtime-stores";
import {
  createVerificationContract,
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest,
  type VerificationEvidence
} from "../../lib/verification/verification";

export const STAGING_USER_ID = "browser-owner";
export const STAGING_PORTFOLIO_ID = "portfolio-browser";
export const STAGING_COMPANY_ID = "company-browser";
export const STAGING_ORGANIZATION_ID = "org-browser";

export const stagingScope: TrustedExecutionScope = Object.freeze({
  userId: STAGING_USER_ID,
  portfolioId: STAGING_PORTFOLIO_ID,
  companyId: STAGING_COMPANY_ID,
  environment: "staging"
});

export interface VirtualPasskeyFixture {
  credentialId: string;
  cdpCredentialId: string;
  privateKeyBase64: string;
  userHandleBase64: string;
}

function databaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required for staging browser E2E");
  return value;
}

export function pool() {
  return new Pool({
    connectionString: databaseUrl(),
    max: 6,
    ssl: process.env.GETDONE_DB_SSL === "false" ? false : { rejectUnauthorized: true }
  });
}

export function postgresDatabase() {
  return new PostgresDatabase({
    connectionString: databaseUrl(),
    maxConnections: 8,
    ssl: process.env.GETDONE_DB_SSL !== "false"
  });
}

export async function resetAuthoritativeStaging() {
  const db = pool();
  try {
    await db.query(`TRUNCATE
      rate_limit_buckets,
      auth_sign_in_challenges,
      auth_step_up_challenges,
      auth_sessions,
      auth_webauthn_credentials,
      owner_intents,
      business_action_verification_evidence,
      business_action_executions,
      job_runtime_events,
      job_execution_outcomes,
      job_recovery_records,
      job_dead_letters,
      job_retry_schedule,
      job_runtime_transactions,
      job_leases,
      job_runtime_state,
      job_execution_specs,
      authorization_consumptions,
      authorization_grants,
      verification_receipts,
      audit_events,
      idempotency_records,
      control_plane_entities,
      database_backup_evidence,
      portfolio_memberships,
      company_memberships,
      organization_memberships,
      portfolios,
      companies,
      organizations,
      auth_users
      RESTART IDENTITY CASCADE`);
  } finally {
    await db.end();
  }
}

export async function seedPasskeyOwner(): Promise<VirtualPasskeyFixture> {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  });
  const credentialBytes = randomBytes(32);
  const userHandle = Buffer.from(STAGING_USER_ID, "utf8");
  const fixture = {
    credentialId: credentialBytes.toString("base64url"),
    cdpCredentialId: credentialBytes.toString("base64"),
    privateKeyBase64: Buffer.from(
      privateKey.export({ type: "pkcs8", format: "der" })
    ).toString("base64"),
    userHandleBase64: userHandle.toString("base64")
  };

  const db = pool();
  try {
    await db.query(
      "INSERT INTO auth_users(id,status) VALUES($1,'active')",
      [STAGING_USER_ID]
    );
    await db.query(
      "INSERT INTO organizations(id,name) VALUES($1,'Browser Staging')",
      [STAGING_ORGANIZATION_ID]
    );
    await db.query(
      "INSERT INTO companies(id,organization_id,name) VALUES($1,$2,'Browser Company')",
      [STAGING_COMPANY_ID, STAGING_ORGANIZATION_ID]
    );
    await db.query(
      `INSERT INTO portfolios(id,organization_id,company_id,name)
       VALUES($1,$2,$3,'Browser Portfolio')`,
      [STAGING_PORTFOLIO_ID, STAGING_ORGANIZATION_ID, STAGING_COMPANY_ID]
    );
    await db.query(
      `INSERT INTO organization_memberships(user_id,organization_id,role,status)
       VALUES($1,$2,'owner','active')`,
      [STAGING_USER_ID, STAGING_ORGANIZATION_ID]
    );
    await db.query(
      `INSERT INTO company_memberships(user_id,company_id,role,status)
       VALUES($1,$2,'owner','active')`,
      [STAGING_USER_ID, STAGING_COMPANY_ID]
    );
    await db.query(
      `INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status)
       VALUES($1,$2,$3,'owner','active')`,
      [STAGING_USER_ID, STAGING_PORTFOLIO_ID, STAGING_COMPANY_ID]
    );
    await db.query(
      `INSERT INTO auth_webauthn_credentials
        (credential_id,user_id,user_handle,public_key_pem,algorithm,sign_count,transports)
       VALUES($1,$2,$3,$4,'ES256',0,ARRAY['internal']::text[])`,
      [
        fixture.credentialId,
        STAGING_USER_ID,
        userHandle.toString("base64url"),
        publicKey.export({ type: "spki", format: "pem" }).toString()
      ]
    );
    await db.query(
      `INSERT INTO database_backup_evidence
        (id,completed_at,status,backup_ref_hash,verification_hash,payload)
       VALUES('backup-browser-e2e',now(),'verified',$1,$2,$3::jsonb)`,
      [
        "b".repeat(64),
        "a".repeat(64),
        JSON.stringify({ source: "staging-browser-e2e" })
      ]
    );
  } finally {
    await db.end();
  }

  return fixture;
}

export async function installVirtualAuthenticator(
  page: Page,
  fixture: VirtualPasskeyFixture,
  options: { userVerified?: boolean; signCount?: number } = {}
) {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable", { enableUI: false });
  const created = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: options.userVerified ?? true,
      automaticPresenceSimulation: true
    }
  }) as { authenticatorId: string };

  await session.send("WebAuthn.addCredential", {
    authenticatorId: created.authenticatorId,
    credential: {
      credentialId: fixture.cdpCredentialId,
      isResidentCredential: false,
      rpId: "localhost",
      privateKey: fixture.privateKeyBase64,
      userHandle: fixture.userHandleBase64,
      signCount: options.signCount ?? 0
    }
  });

  return {
    session,
    authenticatorId: created.authenticatorId
  };
}

export async function browserAssertion(page: Page, challenge: {
  challenge: string;
  rpId: string;
  allowCredentialIds: readonly string[];
  userVerification: "required";
}) {
  return page.evaluate(async (value) => {
    const decode = (input: string) => Uint8Array.from(
      atob(input.replace(/-/g, "+").replace(/_/g, "/").padEnd(
        Math.ceil(input.length / 4) * 4,
        "="
      )),
      (char) => char.charCodeAt(0)
    ).buffer;
    const encode = (input: ArrayBuffer | null) => {
      if (!input) return null;
      const bytes = new Uint8Array(input);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    };

    const result = await navigator.credentials.get({
      publicKey: {
        challenge: decode(value.challenge),
        rpId: value.rpId,
        allowCredentials: value.allowCredentialIds.map((id) => ({
          id: decode(id),
          type: "public-key"
        })),
        userVerification: value.userVerification,
        timeout: 30_000
      }
    });
    if (!(result instanceof PublicKeyCredential)) throw new Error("No passkey credential");
    const response = result.response as AuthenticatorAssertionResponse;
    return {
      id: result.id,
      type: "public-key",
      response: {
        clientDataJSON: encode(response.clientDataJSON)!,
        authenticatorData: encode(response.authenticatorData)!,
        signature: encode(response.signature)!,
        userHandle: encode(response.userHandle)
      }
    };
  }, challenge);
}

export async function postJson<T>(
  page: Page,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; value: T }> {
  return page.evaluate(async ({ path, body, headers }) => {
    const response = await fetch(path, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
      status: response.status,
      value: await response.json()
    };
  }, { path, body, headers }) as Promise<{ status: number; value: T }>;
}

export async function latestIntent() {
  const db = pool();
  try {
    const result = await db.query<{ payload: {
      id: string;
      correlationId: string;
      receivedAt: string;
    } }>(
      "SELECT payload FROM owner_intents ORDER BY received_at DESC LIMIT 1"
    );
    const value = result.rows[0]?.payload;
    if (!value) throw new Error("Owner intent was not persisted");
    return value;
  } finally {
    await db.end();
  }
}

export async function materializeDecisionFromIntent(correlationId: string) {
  const now = new Date().toISOString();
  const decision = {
    id: "decision-browser-safe-integration",
    correlationId,
    portfolioId: STAGING_PORTFOLIO_ID,
    companyId: STAGING_COMPANY_ID,
    status: "pending",
    version: 1,
    requiresStepUp: true,
    updatedAt: now,
    title: "Approve safe staging integration",
    subtitle: "Browser E2E · owner approval required",
    priority: "high",
    category: "growth",
    rationale: "Exercise the authoritative staging Job pipeline with a read-only health integration.",
    impact: [
      "Creates a real authoritative Task and Job in PostgreSQL.",
      "Executes and verifies a safe read-only HTTP health check."
    ]
  } satisfies AuthoritativeDecision & Record<string, unknown>;

  const database = postgresDatabase();
  try {
    await new PostgresEntityStore<AuthoritativeDecision>(
      database,
      "decision"
    ).create(decision);
  } finally {
    await database.close();
  }
  return decision;
}

function command(correlationId: string, idempotencyKey: string, type: string) {
  return createCommandEnvelope({
    commandId: randomUUID(),
    actor: { type: "user", id: STAGING_USER_ID },
    scope: stagingScope,
    correlationId,
    environment: "staging",
    idempotencyKey,
    provenance: "staging-browser-e2e",
    requestedMutation: { type }
  });
}

function stagingGrant(correlationId: string): AuthorizationGrant {
  const issuedAt = new Date();
  const base = {
    id: "grant-browser-safe-http",
    status: "active" as const,
    disposition: "AUTO" as const,
    scope: { ...stagingScope },
    planId: "plan-browser-e2e",
    planVersion: 1,
    planHash: sha256Hex({ correlationId, type: "plan" }),
    stepId: "step-safe-http",
    stepHash: sha256Hex({ correlationId, type: "step" }),
    capabilityNames: Object.freeze(["http.request"]),
    validationReceiptId: "validation-browser-e2e",
    validationReceiptHash: sha256Hex({ correlationId, type: "validation" }),
    policySnapshotId: "policy-browser-e2e",
    policySnapshotHash: sha256Hex({ correlationId, type: "policy-snapshot" }),
    policyVersion: "browser-e2e-1",
    policyEngineVersion: "browser-e2e-1",
    policyRulesHash: sha256Hex({ correlationId, type: "policy-rules" }),
    actor: { type: "user" as const, id: STAGING_USER_ID },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 30 * 60_000).toISOString()
  };
  return Object.freeze({ ...base, grantHash: sha256Hex(base) });
}

class SafeStagingIntegrationAdapter implements BusinessActionAdapter {
  readonly id = "staging-safe-health-integration";
  readonly version = "1.0.0";

  constructor(private readonly baseURL: string) {}

  async execute(request: AuthorizedBusinessActionRequest) {
    const response = await fetch(this.baseURL + "/api/health", { cache: "no-store" });
    if (!response.ok) {
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "failed",
        retryable: true,
        retryClass: "transport",
        observedAt: new Date().toISOString()
      });
    }
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId: "safe-health:" + request.id,
      retryable: false,
      retryClass: "none",
      observedAt: new Date().toISOString()
    });
  }

  async status(input: { requestId: string; providerOperationId: string }) {
    const response = await fetch(this.baseURL + "/api/health", { cache: "no-store" });
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state: response.ok ? "completed" : "failed",
      observedAt: new Date().toISOString()
    });
  }
}

export async function createTaskJobAndExecute(
  correlationId: string,
  baseURL: string
) {
  const database = postgresDatabase();
  const grant = stagingGrant(correlationId);
  const grantStore = new PostgresAuthorizationGrantStore(database);
  try {
    await grantStore.insert(grant);

    const taskTransactions = new PostgresControlPlaneTransactionManager<TaskStores>(
      database,
      (client) => ({
        tasks: new PostgresEntityStore<TaskRecord>(client, "task"),
        authorizationGrants: new PostgresAuthorizationGrantStore(client),
        verificationReceipts: new PostgresVerificationReceiptStore(client)
      })
    );
    const taskService = new TaskService(taskTransactions);
    const taskId = "task-browser-safe-http";
    await taskService.create({
      id: taskId,
      reason: "Execute the approved safe staging health integration",
      capabilityRequirements: ["http.request"]
    }, command(correlationId, "browser-task-create", "task.create"));

    const authorizedTask = await taskService.authorize(
      taskId,
      command(correlationId, "browser-task-authorize", "task.authorize"),
      grant
    );
    await taskService.queue(
      taskId,
      command(correlationId, "browser-task-queue", "task.queue")
    );

    if (!authorizedTask.authorizationConsumption) {
      throw new Error("Task authorization consumption was not persisted");
    }

    const jobTransactions = new PostgresControlPlaneTransactionManager<JobStores>(
      database,
      (client) => ({
        jobs: new PostgresEntityStore<JobRecord>(client, "job"),
        authorizationGrants: new PostgresAuthorizationGrantStore(client),
        verificationReceipts: new PostgresVerificationReceiptStore(client)
      })
    );
    const jobService = new JobService(jobTransactions);
    const jobId = "job-browser-safe-http";
    await jobService.create({
      id: jobId,
      taskId,
      maxAttempts: 3
    }, command(correlationId, "browser-job-create", "job.create"));

    const queuedJob = await jobService.queue(
      jobId,
      command(correlationId, "browser-job-queue", "job.queue"),
      grant,
      authorizedTask.authorizationConsumption
    );

    const requestInput = {
      companyId: STAGING_COMPANY_ID,
      operation: "staging.health.read",
      payload: { purpose: "production-browser-e2e" }
    };
    const request: AuthorizedBusinessActionRequest = Object.freeze({
      id: "action-browser-safe-http",
      correlationId,
      jobId,
      scope: stagingScope,
      capability: "http.request",
      input: requestInput,
      inputHash: sha256Hex(requestInput),
      authorizationConsumptionHash:
        authorizedTask.authorizationConsumption.consumptionHash,
      idempotencyKey: "browser-safe-http-action",
      timeoutMs: 5_000,
      attempt: 1
    });

    const queue = new PostgresDurableJobStore(database, {
      maxAttempts: 3,
      recoveryDelayMs: 0
    });
    const worker = new DurableJobWorker(queue, {
      workerId: "browser-e2e-worker",
      leaseSeconds: 30,
      heartbeatSeconds: 5,
      batchSize: 2,
      concurrency: 1,
      retryBaseDelayMs: 0,
      maxAttempts: 3
    });
    const engine = new DurableJobEngine(queue, worker);
    const specs = new PostgresJobExecutionSpecStore(database);
    const jobs = new PostgresEntityStore<JobRecord>(database, "job");
    const business = new BusinessActionExecutionOrchestrator(
      new StaticBusinessActionAdapterRegistry([{
        capability: "http.request",
        adapter: new SafeStagingIntegrationAdapter(baseURL)
      }]),
      new PostgresBusinessActionExecutionStore(database),
      { maxStatusPolls: 2, pollIntervalMs: 0 }
    );
    const runtime = new MvpJobRuntime(
      engine,
      specs,
      new RoutedJobExecutionHandler(
        specs,
        business,
        undefined,
        {
          jobs,
          verificationEvidence: new PostgresJobVerificationEvidenceStore(database),
          lifecycle: jobService
        }
      ),
      jobs
    );

    await runtime.enqueueAuthorizedBusinessAction(queuedJob, request);
    const result = await runtime.runOnce();
    if (result[0]?.outcome.kind !== "provider-completed") {
      throw new Error("Safe staging integration did not reach provider completion");
    }

    const providerEvidenceResult = await database.query<{ payload: VerificationEvidence }>(
      `SELECT payload FROM business_action_verification_evidence
       WHERE job_id=$1 ORDER BY observed_at DESC LIMIT 1`,
      [jobId]
    );
    const providerEvidence = providerEvidenceResult.rows[0]?.payload;
    if (!providerEvidence || providerEvidence.result !== "pass") {
      throw new Error("Safe staging provider-completion evidence is missing");
    }

    const healthResponse = await fetch(baseURL + "/api/health", { cache: "no-store" });
    const observedAt = new Date().toISOString();
    const contract = createVerificationContract({
      id: "browser-safe-http-current-state",
      checks: [
        {
          id: "health-ok",
          key: "health.ok",
          operator: "truthy",
          required: true
        },
        {
          id: "application-responds",
          key: "application.responds",
          operator: "truthy",
          required: true
        }
      ]
    });
    const verification = createVerificationRequest({
      id: "verification-request-browser-safe-http",
      correlationId,
      portfolioId: STAGING_PORTFOLIO_ID,
      companyId: STAGING_COMPANY_ID,
      environment: "staging",
      subject: { type: "job", id: jobId },
      strategies: ["system"],
      contract,
      requestedAt: new Date(Date.parse(observedAt) - 1_000).toISOString(),
      expiresAt: new Date(Date.parse(observedAt) + 10 * 60_000).toISOString(),
      maxEvidenceAgeSeconds: 600,
      requiresIndependentEvidence: true,
      executionIndependenceKey: providerEvidence.independenceKey
    });
    const independentEvidence = createVerificationEvidence({
      id: "verification-evidence-browser-safe-http",
      correlationId,
      portfolioId: STAGING_PORTFOLIO_ID,
      companyId: STAGING_COMPANY_ID,
      subject: verification.subject,
      strategy: "system",
      result: healthResponse.ok ? "pass" : "fail",
      sourceType: "system-probe",
      sourceId: "browser-safe-health-verifier",
      independenceKey: "system-probe:browser-safe-health",
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 5 * 60_000).toISOString(),
      payloadHash: sha256Hex({
        status: healthResponse.status,
        ok: healthResponse.ok
      }),
      provenance: "browser-staging-independent-verifier",
      observations: {
        "health.ok": healthResponse.ok,
        "application.responds": true
      }
    });

    const receiptStore = new PostgresVerificationReceiptStore(database);
    const verificationLifecycle = {
      request: async () => ({
        id: verification.id,
        correlationId,
        portfolioId: STAGING_PORTFOLIO_ID,
        companyId: STAGING_COMPANY_ID,
        state: "requested",
        request: verification,
        version: 1,
        updatedAt: verification.requestedAt
      } as VerificationRequestRecord),
      beginCollecting: async () => ({
        id: verification.id,
        correlationId,
        portfolioId: STAGING_PORTFOLIO_ID,
        companyId: STAGING_COMPANY_ID,
        state: "collecting",
        request: verification,
        version: 2,
        updatedAt: observedAt
      } as VerificationRequestRecord),
      resolve: async (
        _id: string,
        _command: unknown,
        requestToResolve: typeof verification,
        evidenceToResolve: readonly VerificationEvidence[],
        receiptInput: {
          receiptId: string;
          verifiedAt?: string;
          receiptTtlSeconds?: number;
        }
      ) => {
        const receipt = resolveVerificationRequest(
          requestToResolve,
          evidenceToResolve,
          receiptInput
        );
        await receiptStore.insert(receipt);
        return {
          id: verification.id,
          correlationId,
          portfolioId: STAGING_PORTFOLIO_ID,
          companyId: STAGING_COMPANY_ID,
          state: receipt.verdict,
          request: verification,
          receipt,
          version: 3,
          updatedAt: receipt.verifiedAt
        } as VerificationRequestRecord;
      }
    };

    const coordinator = new CoreTrancheCCoordinator(
      jobService,
      verificationLifecycle as never
    );
    const closed = await coordinator.closeExecutionLoop({
      actor: { type: "system", id: "browser-staging-control-plane" },
      scope: stagingScope,
      correlationId,
      provenance: "browser-staging-gate-c",
      idempotencyRoot: `browser-gate-c:${jobId}`
    }, {
      jobId,
      verificationRequest: verification,
      evidence: [independentEvidence],
      desiredOutcome: createObjectiveDesiredOutcome({
        objectiveId: "objective-browser-safe-http",
        contract
      }),
      canGenerateMoreWork: true
    });
    if (
      closed.job.state !== "verified"
      || closed.verification.receipt?.verdict !== "verified"
      || closed.objectiveEvaluation.state !== "completed"
    ) {
      throw new Error("Safe staging integration did not reach verified Objective completion");
    }

    return {
      taskId,
      jobId,
      evidenceId: independentEvidence.id,
      receiptId: closed.verification.receipt.id
    };
  } finally {
    await database.close();
  }
}

export async function insertAdditionalSession(token: string) {
  const db = pool();
  try {
    const sessionId = randomUUID();
    const now = new Date();
    await db.query(
      `INSERT INTO auth_sessions
        (session_id,user_id,token_hash,issued_at,expires_at,authenticated_at)
       VALUES($1,$2,$3,$4,$5,$4)`,
      [
        sessionId,
        STAGING_USER_ID,
        sha256Hex(token),
        now.toISOString(),
        new Date(now.getTime() + 60 * 60_000).toISOString()
      ]
    );
    return sessionId;
  } finally {
    await db.end();
  }
}

export async function saturateRateLimit(
  policyId: string,
  keyParts: readonly string[],
  requestCount: number,
  windowSeconds = 60
) {
  const db = pool();
  try {
    const now = new Date();
    await db.query(
      `INSERT INTO rate_limit_buckets
        (policy_id,bucket_key_hash,window_started_at,window_expires_at,request_count,updated_at)
       VALUES($1,$2,$3,$4,$5,$3)
       ON CONFLICT(policy_id,bucket_key_hash)
       DO UPDATE SET
         window_started_at=excluded.window_started_at,
         window_expires_at=excluded.window_expires_at,
         request_count=excluded.request_count,
         updated_at=excluded.updated_at`,
      [
        policyId,
        sha256Hex({ policy: policyId, keyParts: [...keyParts] }),
        now.toISOString(),
        new Date(now.getTime() + windowSeconds * 1000).toISOString(),
        requestCount
      ]
    );
  } finally {
    await db.end();
  }
}

export async function latestSession() {
  const db = pool();
  try {
    const result = await db.query<{
      session_id: string;
      expires_at: Date | string;
      step_up_authenticated_at: Date | string | null;
    }>(
      `SELECT session_id,expires_at,step_up_authenticated_at
       FROM auth_sessions WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 1`,
      [STAGING_USER_ID]
    );
    return result.rows[0] ?? null;
  } finally {
    await db.end();
  }
}

export async function expireLatestChallenge(kind: "sign-in" | "step-up") {
  const db = pool();
  try {
    const table = kind === "sign-in"
      ? "auth_sign_in_challenges"
      : "auth_step_up_challenges";
    await db.query(
      `UPDATE ${table}
       SET issued_at=now() - interval '10 minutes',
           expires_at=now() - interval '1 second'
       WHERE challenge_id=(SELECT challenge_id FROM ${table}
         ORDER BY issued_at DESC LIMIT 1)`
    );
  } finally {
    await db.end();
  }
}

export async function revokeLatestSession() {
  const db = pool();
  try {
    await db.query(
      `UPDATE auth_sessions SET revoked_at=now()
       WHERE session_id=(SELECT session_id FROM auth_sessions
         WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 1)`,
      [STAGING_USER_ID]
    );
  } finally {
    await db.end();
  }
}

export async function expireLatestStepUpProof() {
  const db = pool();
  try {
    await db.query(
      `UPDATE auth_sessions
       SET step_up_authenticated_at=now() - interval '1 hour'
       WHERE session_id=(SELECT session_id FROM auth_sessions
         WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 1)`,
      [STAGING_USER_ID]
    );
  } finally {
    await db.end();
  }
}

export async function setCredentialSignCount(value: number) {
  const db = pool();
  try {
    await db.query(
      "UPDATE auth_webauthn_credentials SET sign_count=$2 WHERE credential_id=$1",
      [(await db.query<{ credential_id: string }>(
        "SELECT credential_id FROM auth_webauthn_credentials WHERE user_id=$1 LIMIT 1",
        [STAGING_USER_ID]
      )).rows[0]?.credential_id, value]
    );
  } finally {
    await db.end();
  }
}

export async function decisionStatus() {
  const db = pool();
  try {
    const result = await db.query<{ payload: AuthoritativeDecision }>(
      `SELECT payload FROM control_plane_entities
       WHERE entity_type='decision' AND id='decision-browser-safe-integration'`
    );
    return result.rows[0]?.payload ?? null;
  } finally {
    await db.end();
  }
}
