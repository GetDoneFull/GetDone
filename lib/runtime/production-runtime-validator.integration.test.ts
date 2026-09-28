import { spawnSync } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const baseConnectionString = process.env.DATABASE_URL?.trim() ?? "";
const ssl = process.env.GETDONE_DB_SSL === "false"
  ? false
  : { rejectUnauthorized: true };
const root = process.cwd();

function quoteIdentifier(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function databaseUrl(name: string) {
  const url = new URL(baseConnectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

function runMigrations(connectionString: string) {
  const result = spawnSync(process.execPath, ["scripts/migrate-postgres.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false"
    },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `Migration failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
}

const profiles = [
  {
    id: "standard-primary",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "openai/gpt-5.6-sol",
    enabled: true,
    validationStatus: "validated",
    roles: ["STANDARD"],
    modalities: ["text"],
    supportsTools: true,
    supportsStructuredOutput: true,
    maxContextTokens: 128000,
    allowedDataClasses: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    allowedEnvironments: ["production"],
    health: "healthy",
    latencyClass: "standard",
    inputCostPerMillionTokensCents: 1,
    outputCostPerMillionTokensCents: 1,
    profileVersion: "1.0.0"
  },
  {
    id: "standard-fallback",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "openai/gpt-5.6-sol-fallback",
    enabled: true,
    validationStatus: "validated",
    roles: ["STANDARD"],
    modalities: ["text"],
    supportsTools: true,
    supportsStructuredOutput: true,
    maxContextTokens: 128000,
    allowedDataClasses: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    allowedEnvironments: ["production"],
    health: "healthy",
    latencyClass: "standard",
    inputCostPerMillionTokensCents: 1,
    outputCostPerMillionTokensCents: 1,
    profileVersion: "1.0.0"
  }
];

function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !key.startsWith("GETDONE_")
      && !key.startsWith("OPENROUTER_")
      && !key.startsWith("NEXT_PUBLIC_")
      && key !== "DATABASE_URL"
      && key !== "NODE_ENV"
    )
  );
}

function productionEnv(connectionString: string): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    NODE_ENV: "production",
    NEXT_PUBLIC_APP_ENV: "production",
    GETDONE_RUNTIME_ENV: "production",
    GETDONE_DATA_MODE: "authoritative",
    GETDONE_PROCESS_ROLE: "web",
    DATABASE_URL: connectionString,
    GETDONE_DB_RUNTIME_ROLE: "getdone_tenant_runtime",
    GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
    GETDONE_BACKUP_MAX_AGE_HOURS: "24",
    GETDONE_WEBAUTHN_RP_ID: "getdone.example",
    GETDONE_WEBAUTHN_ORIGINS: JSON.stringify(["https://app.getdone.example"]),
    GETDONE_INTERNAL_WORKER_TOKEN: "worker-token-abcdefghijklmnopqrstuvwxyz-123456",
    OPENROUTER_API_KEY: "openrouter-key-abcdefghijklmnopqrstuvwxyz",
    OPENROUTER_BASE_URL: "https://" + "openrouter.ai/api/v1",
    OPENROUTER_CANARY_ENABLED: "true",
    OPENROUTER_CANARY_MODEL: "openai/gpt-5.6-sol",
    GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify(profiles),
    GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
      version: "production-1",
      routes: { STANDARD: ["standard-primary", "standard-fallback"] }
    }),
    GETDONE_OBSERVABILITY_ENABLED: "true",
    GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.getdone.example",
    GETDONE_CREDENTIAL_DELIVERY_URL: "https://credentials.getdone.example/redeem",
    GETDONE_CREDENTIAL_BROKER_TOKEN: "broker-authentication-token-abcdefghijklmnopqrstuvwxyz",
    GETDONE_HTTP_ACTIONS_JSON: JSON.stringify([{
      name: "crm-sync",
      companyId: "company-prod",
      environment: "production",
      url: "https://api.example.com/actions",
      credentialProviderId: "crm-provider-prod"
    }])
  };
}

function runValidator(connectionString: string) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts", "verify-production-runtime.mjs")],
    {
      cwd: root,
      env: productionEnv(connectionString),
      encoding: "utf8"
    }
  );
}

integrationDescribe("production runtime validator PostgreSQL acceptance", () => {
  const databaseName = `getdone_runtime_validator_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let connectionString: string;

  beforeAll(async () => {
    if (!baseConnectionString) throw new Error("DATABASE_URL is required");
    adminPool = new Pool({
      connectionString: baseConnectionString,
      max: 2,
      application_name: "getdone-runtime-validator-admin",
      ssl
    });
    await adminPool.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    connectionString = databaseUrl(databaseName);
    runMigrations(connectionString);
    pool = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-runtime-validator-test",
      ssl
    });
    await pool.query(
      `INSERT INTO database_backup_evidence
        (id,completed_at,status,backup_ref_hash,verification_hash,payload)
       VALUES('runtime-validator-backup',now(),'verified',$1,$2,$3::jsonb)`,
      [
        "a".repeat(64),
        "b".repeat(64),
        JSON.stringify({
          id: "runtime-validator-backup",
          completedAt: new Date().toISOString(),
          status: "verified",
          backupRefHash: "a".repeat(64),
          verificationHash: "b".repeat(64)
        })
      ]
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`
      );
      await adminPool.end();
    }
  });

  it("accepts complete production configuration with healthy PostgreSQL and fresh backup evidence", () => {
    const result = runValidator(connectionString);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      verifier: "verify-production-runtime",
      environment: "production",
      processRole: "web",
      database: {
        database: "reachable",
        migration: "2026-09-28.6",
        tenantRls: "verified",
        tenantRuntimeRole: "verified",
        effectiveRuntimeRole: "verified",
        backupFresh: true
      },
      webAuthn: "configured",
      workerAuthentication: "configured",
      aiRouting: "configured",
      integrations: "configured",
      developmentSettings: "prohibited"
    });
  });

  it("refuses production runtime when verified backup evidence is stale", async () => {
    await pool.query(
      `UPDATE database_backup_evidence
       SET completed_at=now() - interval '48 hours'
       WHERE id='runtime-validator-backup'`
    );

    const result = runValidator(connectionString);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain("DATABASE_READINESS");
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/backup evidence is stale/i);

    await pool.query(
      `UPDATE database_backup_evidence
       SET completed_at=now()
       WHERE id='runtime-validator-backup'`
    );
  });

  it("refuses production runtime when backup evidence is absent", async () => {
    await pool.query("DELETE FROM database_backup_evidence");

    const result = runValidator(connectionString);
    expect(result.status).not.toBe(0);
    const text = `${result.stderr}\n${result.stdout}`;
    expect(text).toContain("DATABASE_READINESS");
    expect(text).toMatch(/No cryptographically verified backup evidence/i);
  });
});
