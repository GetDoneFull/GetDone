import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  handleControlHealth,
  handleGetDecision,
  handleGetJob,
  handleGetJobResult,
  handleGetResource,
  handleGetResourceEnrollment,
  handleGetVerification,
  handleListDecisions,
  handleListJobs,
  handleListResourceEnrollments,
  handleListResources,
  handleListVerifications,
  handleMutateDecision,
  handleOwnerIntent,
  handleSubmitObjectives,
  handleListObjectives,
  handleGetObjective
} from "@/lib/control-api/http";
import {
  resetControlApiAdapter
} from "@/lib/control-api/runtime.server";
import {
  resetPostgresRuntimeForTests
} from "@/lib/persistence/postgres/runtime.server";

const integrationEnabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;

const sessionToken = "getdone-control-api-integration-session-token";
const databaseUrl = process.env.DATABASE_URL ?? "";

function authenticatedRequest(
  path: string,
  init: RequestInit = {},
  extraHeaders: Record<string, string> = {}
) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "x-getdone-portfolio-id": "portfolio-a",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
      ...(init.headers as Record<string, string> | undefined)
    }
  });
}

async function envelope<T>(response: Response) {
  return await response.json() as {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string };
    correlationId: string;
  };
}

function decision(id: string, companyId = "company-a") {
  return {
    id,
    portfolioId: "portfolio-a",
    companyId,
    status: "pending",
    version: 1,
    requiresStepUp: false,
    updatedAt: "2026-09-22T04:00:00.000Z",
    title: id === "decision-owned" ? "Authoritative owner decision" : undefined,
    subtitle: "Loaded from PostgreSQL",
    priority: "normal",
    category: "growth",
    rationale: "Integration fixture",
    impact: ["Persisted"]
  };
}

function resource(id: string, companyId = "company-a") {
  return {
    id,
    portfolioId: "portfolio-a",
    companyId,
    type: "compute",
    state: "ready",
    environmentPermissions: ["staging"],
    capabilityNames: ["http.request"],
    failureDomainIds: [],
    credentialBindingIds: [],
    policyBindingIds: [],
    identityEvidenceIds: [],
    trustEvidenceIds: [],
    healthRecordIds: [],
    capabilityBindingIds: [],
    locationIds: [],
    costProfileIds: [],
    providerBindingIds: [],
    trustClass: "restricted",
    dataClassesAllowed: ["public"],
    region: "us-west",
    createdAt: "2026-09-22T04:00:00.000Z",
    updatedAt: "2026-09-22T04:00:00.000Z",
    version: 1
  };
}

async function insertEntity(
  pool: pg.Pool,
  entityType: string,
  payload: Record<string, unknown>
) {
  await pool.query(
    `INSERT INTO control_plane_entities
      (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      entityType,
      payload.id,
      payload.portfolioId,
      payload.companyId,
      payload.version ?? 1,
      payload.updatedAt ?? "2026-09-22T04:00:00.000Z",
      JSON.stringify(payload)
    ]
  );
}

describeIntegration("PostgreSQL-backed Control API HTTP acceptance", () => {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    ssl: process.env.GETDONE_DB_SSL === "false"
      ? false
      : { rejectUnauthorized: true }
  });

  beforeAll(async () => {
    process.env.GETDONE_RUNTIME_ENV = "staging";
    process.env.GETDONE_DATA_MODE = "authoritative";
    process.env.GETDONE_DB_SSL = process.env.GETDONE_DB_SSL ?? "false";
    process.env.GETDONE_WEBAUTHN_RP_ID = "localhost";
    process.env.GETDONE_WEBAUTHN_ORIGINS = "http://localhost";

    resetControlApiAdapter();
    await resetPostgresRuntimeForTests();

    await pool.query(
      `TRUNCATE
        owner_intents,
        auth_sign_in_challenges,
        auth_step_up_challenges,
        auth_webauthn_credentials,
        auth_step_up_credentials,
        auth_sessions,
        portfolio_memberships,
        company_memberships,
        organization_memberships,
        portfolios,
        companies,
        organizations,
        auth_users,
        control_plane_entities,
        idempotency_records,
        audit_events,
        database_backup_evidence
       RESTART IDENTITY CASCADE`
    );

    await pool.query(
      `INSERT INTO auth_users(id,status) VALUES('user-a','active')`
    );
    await pool.query(
      `INSERT INTO organizations(id,name) VALUES('org-a','GetDone Integration')`
    );
    await pool.query(
      `INSERT INTO companies(id,organization_id,name)
       VALUES('company-a','org-a','Company A')`
    );
    await pool.query(
      `INSERT INTO portfolios(id,organization_id,company_id,name)
       VALUES('portfolio-a','org-a','company-a','Portfolio A')`
    );
    await pool.query(
      `INSERT INTO organization_memberships(user_id,organization_id,role,status)
       VALUES('user-a','org-a','owner','active')`
    );
    await pool.query(
      `INSERT INTO company_memberships(user_id,company_id,role,status)
       VALUES('user-a','company-a','owner','active')`
    );
    await pool.query(
      `INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status)
       VALUES('user-a','portfolio-a','company-a','owner','active')`
    );
    await pool.query(
      `INSERT INTO auth_sessions
        (session_id,user_id,token_hash,issued_at,expires_at,authenticated_at)
       VALUES('session-a','user-a',$1,now() - interval '1 minute',now() + interval '1 hour',now() - interval '1 minute')`,
      [sha256Hex(sessionToken)]
    );

    await pool.query(
      `INSERT INTO database_backup_evidence
        (id,completed_at,status,backup_ref_hash,verification_hash,payload)
       VALUES('backup-control-api',now(),'verified',$1,$2,$3::jsonb)`,
      [
        "b".repeat(64),
        "a".repeat(64),
        JSON.stringify({ source: "control-api-integration-fixture" })
      ]
    );

    await insertEntity(pool, "decision", decision("decision-owned"));
    await insertEntity(pool, "decision", decision("decision-replay"));
    await insertEntity(pool, "decision", decision("decision-race"));
    await insertEntity(pool, "decision", decision("decision-foreign", "company-b"));
    await insertEntity(pool, "resource", resource("resource-owned"));
    await insertEntity(pool, "resource", resource("resource-foreign", "company-b"));

    await insertEntity(pool, "resource-enrollment", {
      id: "enrollment-owned",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "identify",
      requestedType: "compute",
      requestedEnvironments: ["staging"],
      ownerActionRequired: false,
      challengeHash: "hash",
      challengeIssuedAt: "2026-09-22T04:00:00.000Z",
      challengeExpiresAt: "2099-01-01T00:00:00.000Z",
      evidenceIds: [],
      attempt: 1,
      version: 1,
      updatedAt: "2026-09-22T04:00:00.000Z"
    });

    await insertEntity(pool, "job", {
      id: "job-owned",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "succeeded",
      taskId: "task-owned",
      attempt: 1,
      verificationEvidenceIds: ["evidence-owned"],
      verificationReceiptId: "receipt-owned",
      verificationReceiptHash: "receipt-hash",
      version: 2,
      updatedAt: "2026-09-22T04:00:00.000Z"
    });

    await insertEntity(pool, "verification", {
      id: "verification-owned",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "requested",
      request: {
        id: "verification-owned",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        environment: "staging",
        subject: { type: "job", id: "job-owned" },
        requestedAt: "2026-09-22T04:00:00.000Z",
        requestHash: "verification-hash"
      },
      version: 1,
      updatedAt: "2026-09-22T04:00:00.000Z"
    });
  }, 30_000);

  afterAll(async () => {
    resetControlApiAdapter();
    await resetPostgresRuntimeForTests();
    await pool.end();
  });

  it("reports actual database, auth, and durable runtime readiness", async () => {
    const response = await handleControlHealth();
    expect(response.status).toBe(200);
    const body = await envelope<{
      status: string;
      authConnected: boolean;
      persistenceConnected: boolean;
      durableJobStoreConnected: boolean;
      details: Record<string, unknown>;
    }>(response);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      status: "ready",
      authConnected: true,
      persistenceConnected: true,
      durableJobStoreConnected: true
    });
    expect(body.data?.details).toMatchObject({
      schemaCurrent: true,
      backupFresh: true,
      coreRelationsReady: true,
      authRelationsReady: true,
      durableRelationsReady: true
    });
  });

  it("persists and replays owner intents with one authoritative audit event", async () => {
    const key = "intent-replay-key";
    const makeRequest = () => authenticatedRequest(
      "/api/control/chat",
      {
        method: "POST",
        body: JSON.stringify({ message: "Run the authoritative path", channel: "chat" })
      },
      { "idempotency-key": key }
    );

    const first = await handleOwnerIntent(makeRequest());
    const second = await handleOwnerIntent(makeRequest());
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const firstBody = await envelope<{ id: string }>(first);
    const secondBody = await envelope<{ id: string }>(second);
    expect(firstBody.data?.id).toBe(secondBody.data?.id);

    const persisted = await pool.query(
      "SELECT COUNT(*)::int AS count FROM owner_intents WHERE idempotency_key=$1",
      [key]
    );
    expect(persisted.rows[0].count).toBe(1);

    const audits = await pool.query(
      "SELECT COUNT(*)::int AS count FROM audit_events WHERE entity_type='owner-intent'"
    );
    expect(audits.rows[0].count).toBe(1);
  });

  it("persists, audits, replays, and reads normalized objectives without a parallel task API", async () => {
    const key = "objective-replay-key";
    const makeRequest = () => authenticatedRequest(
      "/api/control/objectives",
      {
        method: "POST",
        body: JSON.stringify({
          rawText: "Fix onboarding. Make safe fixes yourself. Deploy staging automatically. Ask me before production."
        })
      },
      { "idempotency-key": key }
    );

    const first = await handleSubmitObjectives(makeRequest());
    const replay = await handleSubmitObjectives(makeRequest());
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);

    const firstBody = await envelope<Array<{ id: string; normalizedGoal: string; constraints: string[] }>>(first);
    const replayBody = await envelope<Array<{ id: string }>>(replay);
    expect(firstBody.data?.[0]).toMatchObject({
      normalizedGoal: "Fix onboarding",
      constraints: [
        "Make safe fixes yourself",
        "Deploy staging automatically",
        "Ask me before production"
      ]
    });
    expect(replayBody.data?.[0]?.id).toBe(firstBody.data?.[0]?.id);

    const persisted = await pool.query(
      "SELECT COUNT(*)::int AS count FROM control_plane_entities WHERE entity_type='objective'"
    );
    expect(persisted.rows[0].count).toBe(1);

    const audits = await pool.query(
      "SELECT COUNT(*)::int AS count FROM audit_events WHERE entity_type='objective'"
    );
    expect(audits.rows[0].count).toBe(1);

    const list = await handleListObjectives(authenticatedRequest("/api/control/objectives"));
    const listBody = await envelope<Array<{ id: string }>>(list);
    expect(listBody.data?.map((item) => item.id)).toContain(firstBody.data?.[0]?.id);

    const detail = await handleGetObjective(
      authenticatedRequest(`/api/control/objectives/${firstBody.data?.[0]?.id}`),
      firstBody.data?.[0]?.id ?? "missing"
    );
    expect(detail.status).toBe(200);
  });

  it("enforces scoped reads across decisions, resources, enrollments, jobs/results, and verifications", async () => {
    const decisionsResponse = await handleListDecisions(
      authenticatedRequest("/api/control/decisions")
    );
    const decisionsBody = await envelope<Array<{ id: string }>>(decisionsResponse);
    expect(decisionsBody.data?.map((item) => item.id)).toEqual(
      expect.arrayContaining(["decision-owned", "decision-replay", "decision-race"])
    );
    expect(decisionsBody.data?.some((item) => item.id === "decision-foreign")).toBe(false);

    const foreignDecision = await handleGetDecision(
      authenticatedRequest("/api/control/decisions/decision-foreign"),
      "decision-foreign"
    );
    expect(foreignDecision.status).toBe(404);

    const resourcesResponse = await handleListResources(
      authenticatedRequest("/api/control/resources")
    );
    const resourcesBody = await envelope<Array<{ id: string }>>(resourcesResponse);
    expect(resourcesBody.data?.map((item) => item.id)).toContain("resource-owned");
    expect(resourcesBody.data?.map((item) => item.id)).not.toContain("resource-foreign");

    const foreignResource = await handleGetResource(
      authenticatedRequest("/api/control/resources/resource-foreign"),
      "resource-foreign"
    );
    expect(foreignResource.status).toBe(404);

    const enrollmentList = await handleListResourceEnrollments(
      authenticatedRequest("/api/control/resource-enrollments")
    );
    expect((await envelope<Array<{ id: string }>>(enrollmentList)).data?.[0]?.id)
      .toBe("enrollment-owned");

    const enrollment = await handleGetResourceEnrollment(
      authenticatedRequest("/api/control/resource-enrollments/enrollment-owned"),
      "enrollment-owned"
    );
    expect((await envelope<{ id: string }>(enrollment)).data?.id).toBe("enrollment-owned");

    const jobs = await handleListJobs(authenticatedRequest("/api/control/jobs"));
    expect((await envelope<Array<{ id: string }>>(jobs)).data?.[0]?.id).toBe("job-owned");

    const job = await handleGetJob(
      authenticatedRequest("/api/control/jobs/job-owned"),
      "job-owned"
    );
    expect((await envelope<{ id: string }>(job)).data?.id).toBe("job-owned");

    const result = await handleGetJobResult(
      authenticatedRequest("/api/control/jobs/job-owned/result"),
      "job-owned"
    );
    expect((await envelope<{ jobId: string }>(result)).data?.jobId).toBe("job-owned");

    const verifications = await handleListVerifications(
      authenticatedRequest("/api/control/verifications")
    );
    expect((await envelope<Array<{ id: string }>>(verifications)).data?.[0]?.id)
      .toBe("verification-owned");

    const verification = await handleGetVerification(
      authenticatedRequest("/api/control/verifications/verification-owned"),
      "verification-owned"
    );
    expect((await envelope<{ id: string }>(verification)).data?.id)
      .toBe("verification-owned");
  });

  it("uses trusted scope for decision mutations and replays the same idempotency key", async () => {
    const key = "decision-replay-key";
    const makeRequest = () => authenticatedRequest(
      "/api/control/decisions/decision-replay",
      { method: "PATCH", body: JSON.stringify({ action: "approve" }) },
      { "idempotency-key": key }
    );

    const first = await handleMutateDecision(makeRequest(), "decision-replay");
    const replay = await handleMutateDecision(makeRequest(), "decision-replay");
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect((await envelope<{ status: string }>(replay)).data?.status).toBe("approved");

    const row = await pool.query<{ payload: { status: string; version: number } }>(
      `SELECT payload FROM control_plane_entities
       WHERE entity_type='decision' AND id='decision-replay'`
    );
    expect(row.rows[0].payload).toMatchObject({ status: "approved", version: 2 });

    const audits = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audit_events
       WHERE entity_type='decision' AND entity_id='decision-replay'`
    );
    expect(audits.rows[0].count).toBe(1);

    const foreignMutation = await handleMutateDecision(
      authenticatedRequest(
        "/api/control/decisions/decision-foreign",
        { method: "PATCH", body: JSON.stringify({ action: "reject" }) },
        { "idempotency-key": "foreign-mutation-key" }
      ),
      "decision-foreign"
    );
    expect([403, 404]).toContain(foreignMutation.status);
  });

  it("allows exactly one winner for simultaneous conflicting owner mutations", async () => {
    const [approve, reject] = await Promise.all([
      handleMutateDecision(
        authenticatedRequest(
          "/api/control/decisions/decision-race",
          { method: "PATCH", body: JSON.stringify({ action: "approve" }) },
          { "idempotency-key": "decision-race-approve" }
        ),
        "decision-race"
      ),
      handleMutateDecision(
        authenticatedRequest(
          "/api/control/decisions/decision-race",
          { method: "PATCH", body: JSON.stringify({ action: "reject" }) },
          { "idempotency-key": "decision-race-reject" }
        ),
        "decision-race"
      )
    ]);

    expect([approve.status, reject.status].sort((a, b) => a - b)).toEqual([200, 409]);

    const row = await pool.query<{ payload: { status: string; version: number } }>(
      `SELECT payload FROM control_plane_entities
       WHERE entity_type='decision' AND id='decision-race'`
    );
    expect(["approved", "rejected"]).toContain(row.rows[0].payload.status);
    expect(row.rows[0].payload.version).toBe(2);
  });

  it("survives application adapter/runtime restart and reads persisted authoritative state", async () => {
    resetControlApiAdapter();
    await resetPostgresRuntimeForTests();

    const response = await handleGetDecision(
      authenticatedRequest("/api/control/decisions/decision-replay"),
      "decision-replay"
    );
    expect(response.status).toBe(200);
    expect((await envelope<{ status: string }>(response)).data?.status).toBe("approved");
  });
});
