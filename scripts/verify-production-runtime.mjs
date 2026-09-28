import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const failures = [];

function fail(code, message) {
  failures.push({ code, message });
}

function required(name) {
  const value = env[name]?.trim();
  if (!value) {
    fail("MISSING_CONFIG", `${name} is required in production`);
    return "";
  }
  return value;
}

function parseJson(name) {
  const raw = required(name);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    fail("INVALID_JSON", `${name} must be valid JSON`);
    return null;
  }
}

function isPlaceholderSecret(value) {
  return /^(changeme|change-me|example|placeholder|secret|token|test|dummy)$/i.test(value);
}

function assertSecret(name, minLength = 16) {
  const value = required(name);
  if (!value) return "";
  if (value.length < minLength || isPlaceholderSecret(value)) {
    fail("WEAK_SECRET", `${name} must be a non-placeholder secret of at least ${minLength} characters`);
  }
  return value;
}

function assertHttpsUrl(value, label, { approvedHosts } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID_URL", `${label} must be a valid URL`);
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail("INSECURE_URL", `${label} must be credential-free HTTPS`);
    return null;
  }
  if (approvedHosts && !approvedHosts.includes(url.hostname)) {
    fail("UNAPPROVED_HOST", `${label} must use an approved host`);
    return null;
  }
  return url;
}

function walkLegacyCredentialFields(value, label) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkLegacyCredentialFields(item, `${label}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((/credentialRef$/i.test(key) || key === "authorizationEnv") && item !== undefined) {
      fail(
        "LEGACY_CREDENTIAL_CONFIG",
        `${label}.${key} is prohibited; ordinary integrations must use brokered credentialProviderId references`
      );
    } else {
      walkLegacyCredentialFields(item, `${label}.${key}`);
    }
  }
}

function walkHttpsUrls(value, label) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkHttpsUrls(item, `${label}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === "url" || key === "baseUrl" || key === "apiBaseUrl") && typeof item === "string") {
      const probe = item.replaceAll("{providerOperationId}", "provider-operation");
      assertHttpsUrl(probe, `${label}.${key}`);
    } else {
      walkHttpsUrls(item, `${label}.${key}`);
    }
  }
}

let brokeredCredentialIntegrations = 0;

function validateIntegrationArray(name, type) {
  const parsed = parseJson(name);
  if (parsed === null) return 0;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail("INVALID_INTEGRATION_CONFIG", `${name} must be a non-empty JSON array`);
    return 0;
  }

  parsed.forEach((entry, index) => {
    const label = `${name}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("INVALID_INTEGRATION_CONFIG", `${label} must be an object`);
      return;
    }
    if (entry.environment !== "production") {
      fail("NON_PRODUCTION_INTEGRATION", `${label}.environment must be production`);
    }
    if (typeof entry.companyId !== "string" || !entry.companyId.trim()) {
      fail("INVALID_INTEGRATION_CONFIG", `${label}.companyId is required`);
    }

    if (type === "http" || type === "webhook") {
      if (typeof entry.name !== "string" || !/^[A-Za-z0-9._:-]+$/.test(entry.name)) {
        fail("INVALID_INTEGRATION_CONFIG", `${label}.name is invalid`);
      }
      if (typeof entry.url !== "string") {
        fail("INVALID_INTEGRATION_CONFIG", `${label}.url is required`);
      }
      if (entry.consequential === true && !entry.verification) {
        fail(
          "UNVERIFIED_CONSEQUENTIAL_ACTION",
          `${label} is consequential and requires independent verification`
        );
      }
    } else {
      if (typeof entry.id !== "string" || !entry.id.trim()) {
        fail("INVALID_INTEGRATION_CONFIG", `${label}.id is required`);
      }
      if (typeof entry.credentialProviderId !== "string" || !entry.credentialProviderId.trim()) {
        fail("INVALID_INTEGRATION_CONFIG", `${label}.credentialProviderId is required`);
      }
      if (
        (type === "gmail" || type === "slack")
        && entry.verificationMode === "provider-acceptance-only"
      ) {
        fail(
          "UNVERIFIED_PRODUCTION_INTEGRATION",
          `${label} must use provider-object verification in production`
        );
      }
      if (type === "crm") {
        if (typeof entry.baseUrl !== "string") {
          fail("INVALID_INTEGRATION_CONFIG", `${label}.baseUrl is required`);
        }
        for (const objectType of ["contact", "company", "deal"]) {
          const endpoint = entry.objects?.[objectType];
          if (
            !endpoint
            || typeof endpoint.collectionPath !== "string"
            || typeof endpoint.itemPath !== "string"
            || !endpoint.itemPath.includes("{recordId}")
          ) {
            fail(
              "INVALID_INTEGRATION_CONFIG",
              `${label}.objects.${objectType} requires collectionPath and itemPath with {recordId}`
            );
          }
        }
      }
      if (type === "github") {
        if (
          entry.apiBaseUrl !== undefined
          && typeof entry.apiBaseUrl !== "string"
        ) {
          fail("INVALID_INTEGRATION_CONFIG", `${label}.apiBaseUrl must be a URL string`);
        }
        if (
          !Array.isArray(entry.repositories)
          || entry.repositories.length === 0
          || entry.repositories.some(
            (repository) => typeof repository !== "string"
              || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
          )
        ) {
          fail("INVALID_INTEGRATION_CONFIG", `${label}.repositories must be a non-empty repository allowlist`);
        }
        if (
          entry.protectedBranches !== undefined
          && (
            !Array.isArray(entry.protectedBranches)
            || entry.protectedBranches.some((branch) => typeof branch !== "string" || !branch.trim())
          )
        ) {
          fail("INVALID_INTEGRATION_CONFIG", `${label}.protectedBranches is invalid`);
        }
      }
      if (type === "analytics") {
        if (typeof entry.url !== "string") {
          fail("INVALID_INTEGRATION_CONFIG", `${label}.url is required`);
        }
        if (
          !entry.schema
          || typeof entry.schema !== "object"
          || Array.isArray(entry.schema)
          || !entry.schema.fields
          || typeof entry.schema.fields !== "object"
          || Array.isArray(entry.schema.fields)
          || Object.keys(entry.schema.fields).length === 0
        ) {
          fail("INVALID_INTEGRATION_CONFIG", `${label}.schema.fields must be a non-empty object`);
        }
        if (
          entry.maxResponseBytes !== undefined
          && (
            !Number.isInteger(entry.maxResponseBytes)
            || entry.maxResponseBytes < 1
            || entry.maxResponseBytes > 2_000_000
          )
        ) {
          fail("INVALID_INTEGRATION_CONFIG", `${label}.maxResponseBytes is invalid`);
        }
      }
    }

    if (entry.credentialProviderId !== undefined) {
      if (
        typeof entry.credentialProviderId !== "string"
        || !/^[A-Za-z0-9._:@+-]{1,200}$/.test(entry.credentialProviderId)
      ) {
        fail("INVALID_CREDENTIAL_PROVIDER", `${label}.credentialProviderId is invalid`);
      } else {
        brokeredCredentialIntegrations += 1;
      }
    }
    walkLegacyCredentialFields(entry, label);
    walkHttpsUrls(entry, label);
  });

  return parsed.length;
}

function validateEnvironmentIdentity() {
  if (env.GETDONE_RUNTIME_ENV?.trim() !== "production") {
    fail("ENVIRONMENT_IDENTITY", "GETDONE_RUNTIME_ENV must be production");
  }
  if (env.NODE_ENV?.trim() !== "production") {
    fail("ENVIRONMENT_IDENTITY", "NODE_ENV must be production");
  }
  if (env.NEXT_PUBLIC_APP_ENV?.trim() !== "production") {
    fail("ENVIRONMENT_IDENTITY", "NEXT_PUBLIC_APP_ENV must be production");
  }
  if (env.GETDONE_DATA_MODE?.trim() !== "authoritative") {
    fail("ENVIRONMENT_IDENTITY", "GETDONE_DATA_MODE must be authoritative");
  }

  const role = env.GETDONE_PROCESS_ROLE?.trim();
  if (role !== "web" && role !== "job-worker" && role !== "orchestration-worker") {
    fail(
      "PROCESS_IDENTITY",
      "GETDONE_PROCESS_ROLE must be explicitly web, job-worker, or orchestration-worker"
    );
  }

  const runtimeRole = env.GETDONE_DB_RUNTIME_ROLE?.trim();
  if (runtimeRole !== "getdone_tenant_runtime") {
    fail("DATABASE_ROLE", "GETDONE_DB_RUNTIME_ROLE must be getdone_tenant_runtime");
  }
}

function validateProhibitedSettings() {
  const prohibited = [
    "GETDONE_NODE_IDENTITY_DEV_SECRET",
    "GETDONE_OWNER_SESSION_TOKEN",
    "GETDONE_OWNER_SESSION_ID"
  ];
  for (const name of prohibited) {
    if (env[name]?.trim()) {
      fail("PROHIBITED_PRODUCTION_SETTING", `${name} must not be set in production`);
    }
  }

  for (const [name, value] of Object.entries(env)) {
    if (
      value?.trim()
      && name.startsWith("NEXT_PUBLIC_")
      && /(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|DATABASE_URL)/i.test(name)
    ) {
      fail("PUBLIC_SECRET", `${name} looks secret-bearing and must not be exposed to the browser`);
    }
  }
}

function validateDatabaseConfiguration() {
  const connection = required("DATABASE_URL");
  if (connection) {
    let url;
    try {
      url = new URL(connection);
    } catch {
      fail("DATABASE_CONFIG", "DATABASE_URL must be a valid PostgreSQL URL");
      return;
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      fail("DATABASE_CONFIG", "DATABASE_URL must use postgres:// or postgresql://");
    }
  }

  const maxBackupAge = Number(env.GETDONE_BACKUP_MAX_AGE_HOURS || "24");
  if (!Number.isFinite(maxBackupAge) || maxBackupAge <= 0) {
    fail("BACKUP_CONFIG", "GETDONE_BACKUP_MAX_AGE_HOURS must be positive");
  }
}

function validateWebAuthn() {
  if (env.GETDONE_AUTH_COOKIE_SECURE === "false") {
    fail("WEBAUTHN_CONFIG", "Production auth cookies must use Secure transport");
  }
  const cookieName = env.GETDONE_AUTH_COOKIE_NAME?.trim() || "getdone_session";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(cookieName)) {
    fail("WEBAUTHN_CONFIG", "GETDONE_AUTH_COOKIE_NAME is invalid");
  }
  const rpId = required("GETDONE_WEBAUTHN_RP_ID");
  if (rpId && (!/^[A-Za-z0-9.-]+$/.test(rpId) || rpId === "localhost")) {
    fail("WEBAUTHN_CONFIG", "GETDONE_WEBAUTHN_RP_ID must be a production DNS RP ID");
  }

  const rawOrigins = required("GETDONE_WEBAUTHN_ORIGINS");
  if (!rawOrigins || !rpId) return;

  let origins;
  if (rawOrigins.startsWith("[")) {
    try {
      origins = JSON.parse(rawOrigins);
    } catch {
      origins = null;
    }
  } else {
    origins = rawOrigins.split(",");
  }

  if (!Array.isArray(origins) || origins.length === 0 || origins.some((item) => typeof item !== "string")) {
    fail("WEBAUTHN_CONFIG", "GETDONE_WEBAUTHN_ORIGINS must be a non-empty string list");
    return;
  }

  const normalized = [...new Set(origins.map((item) => item.trim()).filter(Boolean))];
  if (normalized.length === 0) {
    fail("WEBAUTHN_CONFIG", "At least one WebAuthn origin is required");
    return;
  }

  for (const origin of normalized) {
    const url = assertHttpsUrl(origin, "WebAuthn origin");
    if (!url) continue;
    if (url.origin !== origin) {
      fail("WEBAUTHN_CONFIG", "WebAuthn origins must be exact origins without path/query");
    }
    if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
      fail("WEBAUTHN_CONFIG", "WebAuthn origin hostname must match or be a subdomain of the RP ID");
    }
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      fail("WEBAUTHN_CONFIG", "Loopback WebAuthn origins are prohibited in production");
    }
  }
}

function validateWorkerConfiguration() {
  assertSecret("GETDONE_INTERNAL_WORKER_TOKEN", 32);
  if (env.GETDONE_PROCESS_ROLE?.trim() === "job-worker") {
    const workerId = required("GETDONE_JOB_WORKER_ID");
    if (workerId && !/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
      fail("WORKER_CONFIG", "GETDONE_JOB_WORKER_ID is malformed");
    }
  }

  if (env.GETDONE_PROCESS_ROLE?.trim() === "orchestration-worker") {
    const workerId = required("GETDONE_ORCHESTRATION_WORKER_ID");
    if (workerId && !/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
      fail("WORKER_CONFIG", "GETDONE_ORCHESTRATION_WORKER_ID is malformed");
    }

    const orchestrationIntegers = [
      ["GETDONE_ORCHESTRATION_LEASE_SECONDS", 60],
      ["GETDONE_ORCHESTRATION_HEARTBEAT_SECONDS", 20],
      ["GETDONE_ORCHESTRATION_BATCH_SIZE", 10],
      ["GETDONE_ORCHESTRATION_CONCURRENCY", 2],
      ["GETDONE_ORCHESTRATION_RETRY_BASE_DELAY_MS", 1000],
      ["GETDONE_ORCHESTRATION_RETRY_MAX_DELAY_MS", 120000],
      ["GETDONE_ORCHESTRATION_MAX_FAILURES", 8],
      ["GETDONE_ORCHESTRATION_POLL_INTERVAL_MS", 1000],
      ["GETDONE_ORCHESTRATION_ERROR_BACKOFF_MS", 5000]
    ];
    const parsedOrchestration = new Map();
    for (const [name, fallback] of orchestrationIntegers) {
      const value = Number(env[name] || fallback);
      parsedOrchestration.set(name, value);
      if (!Number.isInteger(value) || value < 1) {
        fail("WORKER_CONFIG", `${name} must be a positive integer`);
      }
    }
    if (
      Number(parsedOrchestration.get("GETDONE_ORCHESTRATION_HEARTBEAT_SECONDS"))
      >= Number(parsedOrchestration.get("GETDONE_ORCHESTRATION_LEASE_SECONDS"))
    ) {
      fail(
        "WORKER_CONFIG",
        "GETDONE_ORCHESTRATION_HEARTBEAT_SECONDS must be lower than GETDONE_ORCHESTRATION_LEASE_SECONDS"
      );
    }
    if (
      Number(parsedOrchestration.get("GETDONE_ORCHESTRATION_CONCURRENCY"))
      > Number(parsedOrchestration.get("GETDONE_ORCHESTRATION_BATCH_SIZE"))
    ) {
      fail(
        "WORKER_CONFIG",
        "GETDONE_ORCHESTRATION_CONCURRENCY must not exceed GETDONE_ORCHESTRATION_BATCH_SIZE"
      );
    }
    if (
      Number(parsedOrchestration.get("GETDONE_ORCHESTRATION_RETRY_BASE_DELAY_MS"))
      > Number(parsedOrchestration.get("GETDONE_ORCHESTRATION_RETRY_MAX_DELAY_MS"))
    ) {
      fail(
        "WORKER_CONFIG",
        "GETDONE_ORCHESTRATION_RETRY_BASE_DELAY_MS must not exceed GETDONE_ORCHESTRATION_RETRY_MAX_DELAY_MS"
      );
    }
  }

  const positiveWorkerIntegers = [
    ["GETDONE_JOB_BATCH_SIZE", 10],
    ["GETDONE_JOB_CONCURRENCY", 4],
    ["GETDONE_JOB_QUEUE_DEPTH_LIMIT", 1000],
    ["GETDONE_JOB_COMPANY_QUEUE_DEPTH_LIMIT", 250],
    ["GETDONE_PROVIDER_CONCURRENCY_LIMIT", 4],
    ["GETDONE_PROVIDER_CONCURRENCY_LEASE_SECONDS", 120]
  ];
  const parsed = new Map();
  for (const [name, fallback] of positiveWorkerIntegers) {
    const value = Number(env[name] || fallback);
    parsed.set(name, value);
    if (!Number.isInteger(value) || value < 1) {
      fail("WORKER_BACKPRESSURE_CONFIG", `${name} must be a positive integer`);
    }
  }
  if (
    Number(parsed.get("GETDONE_JOB_CONCURRENCY"))
    > Number(parsed.get("GETDONE_JOB_BATCH_SIZE"))
  ) {
    fail(
      "WORKER_BACKPRESSURE_CONFIG",
      "GETDONE_JOB_CONCURRENCY must not exceed GETDONE_JOB_BATCH_SIZE"
    );
  }
  if (
    Number(parsed.get("GETDONE_JOB_COMPANY_QUEUE_DEPTH_LIMIT"))
    >= Number(parsed.get("GETDONE_JOB_QUEUE_DEPTH_LIMIT"))
  ) {
    fail(
      "WORKER_BACKPRESSURE_CONFIG",
      "GETDONE_JOB_COMPANY_QUEUE_DEPTH_LIMIT must be lower than GETDONE_JOB_QUEUE_DEPTH_LIMIT"
    );
  }

  const rawProviderLimits = env.GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON?.trim();
  if (rawProviderLimits) {
    try {
      const limits = JSON.parse(rawProviderLimits);
      if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
        throw new Error("not-object");
      }
      for (const [providerKey, limit] of Object.entries(limits)) {
        if (!providerKey.trim() || !Number.isInteger(Number(limit)) || Number(limit) < 1) {
          throw new Error("invalid-entry");
        }
      }
    } catch {
      fail(
        "WORKER_BACKPRESSURE_CONFIG",
        "GETDONE_PROVIDER_CONCURRENCY_LIMITS_JSON must map provider IDs to positive integer limits"
      );
    }
  }
}

function validateAiRouting() {
  assertSecret("OPENROUTER_API_KEY", 16);
  const base = required("OPENROUTER_BASE_URL");
  assertHttpsUrl(base, "OPENROUTER_BASE_URL", {
    approvedHosts: ["openrouter.ai", "eu.openrouter.ai"]
  });

  const profiles = parseJson("GETDONE_AI_MODEL_PROFILES_JSON");
  const policy = parseJson("GETDONE_AI_ROUTING_POLICY_JSON");
  if (!Array.isArray(profiles) || profiles.length < 2) {
    fail("AI_ROUTING", "Production AI routing requires at least two model profiles for primary/fallback routing");
    return;
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("AI_ROUTING", "GETDONE_AI_ROUTING_POLICY_JSON must be an object");
    return;
  }
  if (typeof policy.version !== "string" || !policy.version.trim()) {
    fail("AI_ROUTING", "AI routing policy version is required");
  }
  if (!policy.routes || typeof policy.routes !== "object" || Array.isArray(policy.routes)) {
    fail("AI_ROUTING", "AI routing policy routes are required");
    return;
  }

  const byId = new Map();
  for (const [index, profile] of profiles.entries()) {
    const label = `GETDONE_AI_MODEL_PROFILES_JSON[${index}]`;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      fail("AI_PROFILE", `${label} must be an object`);
      continue;
    }
    if (typeof profile.id !== "string" || !profile.id.trim()) {
      fail("AI_PROFILE", `${label}.id is required`);
      continue;
    }
    if (byId.has(profile.id)) {
      fail("AI_PROFILE", `Duplicate AI profile id: ${profile.id}`);
      continue;
    }
    byId.set(profile.id, profile);

    if (
      profile.gatewayId !== "openrouter"
      || profile.providerId !== "openrouter"
      || profile.enabled !== true
      || profile.validationStatus !== "validated"
      || profile.health !== "healthy"
      || !Array.isArray(profile.allowedEnvironments)
      || !profile.allowedEnvironments.includes("production")
    ) {
      fail("AI_PROFILE", `${label} is not an enabled, validated, healthy production OpenRouter profile`);
    }
    if (
      typeof profile.modelId !== "string"
      || !profile.modelId.trim()
      || profile.modelId === "openrouter/auto"
      || profile.modelId.startsWith("~")
    ) {
      fail("AI_PROFILE", `${label}.modelId must be a concrete model ID`);
    }
  }

  const routeEntries = Object.entries(policy.routes);
  if (routeEntries.length === 0) {
    fail("AI_ROUTING", "At least one AI route is required");
  }
  if (!Array.isArray(policy.routes.STANDARD) || policy.routes.STANDARD.length < 2) {
    fail("AI_ROUTING", "STANDARD routing requires an ordered primary and fallback profile");
  }

  for (const [role, route] of routeEntries) {
    if (!Array.isArray(route) || route.length === 0 || route.some((id) => typeof id !== "string")) {
      fail("AI_ROUTING", `AI route ${role} must contain profile IDs`);
      continue;
    }
    if (new Set(route).size !== route.length) {
      fail("AI_ROUTING", `AI route ${role} contains duplicate profile IDs`);
    }
    for (const id of route) {
      const profile = byId.get(id);
      if (!profile) {
        fail("AI_ROUTING", `AI route ${role} references unknown profile ${id}`);
      } else if (
        profile.enabled !== true
        || profile.validationStatus !== "validated"
        || profile.health !== "healthy"
        || !profile.allowedEnvironments?.includes("production")
      ) {
        fail("AI_ROUTING", `AI route ${role} references production-ineligible profile ${id}`);
      }
    }
  }

  if (env.OPENROUTER_CANARY_ENABLED !== "true") {
    fail("AI_CANARY", "OPENROUTER_CANARY_ENABLED must be true in production");
  }
  const canaryModel = required("OPENROUTER_CANARY_MODEL");
  if (canaryModel) {
    if (canaryModel === "openrouter/auto" || canaryModel.startsWith("~")) {
      fail("AI_CANARY", "OPENROUTER_CANARY_MODEL must be a concrete model ID");
    }
    const configuredModels = new Set([...byId.values()].map((profile) => profile.modelId));
    if (!configuredModels.has(canaryModel)) {
      fail("AI_CANARY", "OPENROUTER_CANARY_MODEL must match a configured production profile");
    }
  }
}

function validateObservability() {
  if (env.GETDONE_OBSERVABILITY_ENABLED !== "true") {
    fail("OBSERVABILITY_CONFIG", "GETDONE_OBSERVABILITY_ENABLED must be true in production");
  }
  const endpoint = required("GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT");
  if (endpoint) {
    const url = assertHttpsUrl(endpoint, "GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT");
    if (url && url.username) {
      fail("OBSERVABILITY_CONFIG", "OTLP endpoint must not embed credentials");
    }
  }
}

function validateIntegrations() {
  const configs = [
    ["GETDONE_HTTP_ACTIONS_JSON", "http"],
    ["GETDONE_WEBHOOK_ACTIONS_JSON", "webhook"],
    ["GETDONE_GMAIL_ACTIONS_JSON", "gmail"],
    ["GETDONE_SLACK_ACTIONS_JSON", "slack"],
    ["GETDONE_CRM_ACTIONS_JSON", "crm"],
    ["GETDONE_GITHUB_ACTIONS_JSON", "github"],
    ["GETDONE_ANALYTICS_SOURCES_JSON", "analytics"]
  ];

  let configured = 0;
  brokeredCredentialIntegrations = 0;
  for (const [name, type] of configs) {
    if (!env[name]?.trim()) continue;
    configured += validateIntegrationArray(name, type);
  }
  if (configured === 0) {
    fail(
      "INTEGRATION_CONFIG",
      "At least one governed ordinary production integration must be configured"
    );
  }

  if (brokeredCredentialIntegrations > 0) {
    const deliveryUrl = required("GETDONE_CREDENTIAL_DELIVERY_URL");
    if (deliveryUrl) assertHttpsUrl(deliveryUrl, "GETDONE_CREDENTIAL_DELIVERY_URL");
    assertSecret("GETDONE_CREDENTIAL_BROKER_TOKEN", 32);
  }
}

function printFailureAndExit() {
  console.error(JSON.stringify({
    ok: false,
    verifier: "verify-production-runtime",
    failures
  }, null, 2));
  process.exit(1);
}

validateEnvironmentIdentity();
validateProhibitedSettings();
validateDatabaseConfiguration();
validateWebAuthn();
validateWorkerConfiguration();
validateAiRouting();
validateIntegrations();
validateObservability();

if (failures.length > 0) {
  printFailureAndExit();
}

const databaseVerifier = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "verify-postgres-production.mjs")],
  {
    cwd: root,
    env,
    encoding: "utf8"
  }
);

if (databaseVerifier.status !== 0) {
  const output = [databaseVerifier.stderr, databaseVerifier.stdout]
    .filter(Boolean)
    .join("\n")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-8);
  fail(
    "DATABASE_READINESS",
    output.length > 0
      ? `PostgreSQL production readiness failed: ${output.join(" | ")}`
      : "PostgreSQL production readiness verification failed"
  );
  printFailureAndExit();
}

let database = {};
try {
  database = JSON.parse(databaseVerifier.stdout);
} catch {
  database = { status: "verified" };
}

console.log(JSON.stringify({
  ok: true,
  verifier: "verify-production-runtime",
  environment: "production",
  processRole: env.GETDONE_PROCESS_ROLE,
  database,
  webAuthn: "configured",
  workerAuthentication: "configured",
  aiRouting: "configured",
  integrations: "configured",
  observability: "configured",
  developmentSettings: "prohibited"
}, null, 2));
