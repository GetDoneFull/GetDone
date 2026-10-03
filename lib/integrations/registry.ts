import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type {
  CompanyIntegration,
  IntegrationAuthenticationEvidence,
  IntegrationKind,
  IntegrationRegistryStore
} from "@/lib/integrations/contracts";

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return new Date(parsed).toISOString();
}

function safeText(value: string, label: string, max = 160) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must contain 1-${max} characters`);
  }
  return trimmed;
}

function normalizeScopes(values: readonly string[], label: string) {
  const normalized = [...new Set(values.map((value) => safeText(value, label, 200)))].sort();
  return Object.freeze(normalized);
}

function assertNoRawSecretShape(value: string | undefined, label: string) {
  if (!value) return;
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i.test(value)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
  ) {
    throw new ControlPlaneError("FORBIDDEN", `${label} must be a reference, never raw credential material`);
  }
}

export function createCompanyIntegration(input: {
  id: string;
  scope: TrustedExecutionScope;
  kind: IntegrationKind;
  provider?: string;
  displayName: string;
  adapterId: string;
  adapterVersion: string;
  credentialBindingId?: string;
  accountIdentity?: string;
  supportedCapabilities?: readonly string[];
  readScopes?: readonly string[];
  writeScopes?: readonly string[];
  health?: CompanyIntegration["health"];
  rateLimits?: CompanyIntegration["rateLimits"];
  policies?: readonly string[];
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  mock?: boolean;
  createdAt: string;
}): CompanyIntegration {
  assertNoRawSecretShape(input.credentialBindingId, "credentialBindingId");
  const createdAt = parseTime(input.createdAt, "integration createdAt");
  if (input.health?.observedAt) parseTime(input.health.observedAt, "integration health observedAt");
  for (const [name, value] of Object.entries(input.rateLimits ?? {})) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new ControlPlaneError("VALIDATION_FAILED", `Integration rate limit ${name} must be a non-negative integer`);
    }
  }
  const base = {
    id: safeText(input.id, "integration id"),
    portfolioId: input.scope.portfolioId,
    companyId: input.scope.companyId,
    environment: input.scope.environment,
    kind: input.kind,
    provider: safeText(input.provider ?? input.kind, "provider"),
    displayName: safeText(input.displayName, "displayName"),
    adapterId: safeText(input.adapterId, "adapterId"),
    adapterVersion: safeText(input.adapterVersion, "adapterVersion", 80),
    credentialBindingId: input.credentialBindingId
      ? safeText(input.credentialBindingId, "credentialBindingId", 200)
      : undefined,
    accountIdentity: input.accountIdentity
      ? safeText(input.accountIdentity, "accountIdentity", 240)
      : null,
    supportedCapabilities: normalizeScopes(
      input.supportedCapabilities ?? [],
      "supported capability"
    ),
    readScopes: normalizeScopes(input.readScopes ?? [], "read scope"),
    writeScopes: normalizeScopes(input.writeScopes ?? [], "write scope"),
    state: "disconnected" as const,
    health: Object.freeze(input.health
      ? { ...input.health }
      : { status: "unknown" as const }),
    rateLimits: Object.freeze({ ...(input.rateLimits ?? {}) }),
    policies: normalizeScopes(input.policies ?? [], "integration policy"),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    mock: input.mock ?? false,
    createdAt,
    updatedAt: createdAt
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function assertCompanyIntegrationIntegrity(record: CompanyIntegration) {
  const { recordHash, ...base } = record;
  if (sha256Hex(base) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Integration registry record integrity check failed");
  }
  return record;
}

function assertScope(record: CompanyIntegration, scope: TrustedExecutionScope) {
  if (
    record.portfolioId !== scope.portfolioId
    || record.companyId !== scope.companyId
    || record.environment !== scope.environment
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Integration is outside trusted company/environment scope");
  }
}

export function assertCompanyIntegrationScope(
  record: CompanyIntegration,
  scope: TrustedExecutionScope
) {
  assertCompanyIntegrationIntegrity(record);
  assertScope(record, scope);
  return record;
}

export async function getCompanyIntegrationForScope(input: {
  store: IntegrationRegistryStore;
  id: string;
  scope: TrustedExecutionScope;
}): Promise<CompanyIntegration | null> {
  const record = await input.store.get(input.id);
  if (!record) return null;
  return assertCompanyIntegrationScope(record, input.scope);
}

export async function listCompanyIntegrationsForScope(input: {
  store: IntegrationRegistryStore;
  scope: TrustedExecutionScope;
}): Promise<readonly CompanyIntegration[]> {
  const records = await input.store.listByCompany({
    portfolioId: input.scope.portfolioId,
    companyId: input.scope.companyId,
    environment: input.scope.environment
  });
  for (const record of records) {
    assertCompanyIntegrationScope(record, input.scope);
  }
  return Object.freeze([...records]);
}

function assertEvidence(
  record: CompanyIntegration,
  evidence: IntegrationAuthenticationEvidence
) {
  const { evidenceHash, ...base } = evidence;
  if (sha256Hex(base) !== evidenceHash) {
    throw new ControlPlaneError("FORBIDDEN", "Integration authentication evidence integrity check failed");
  }
  if (
    evidence.source !== "integration-adapter"
    || evidence.integrationId !== record.id
    || evidence.companyId !== record.companyId
    || evidence.environment !== record.environment
    || evidence.adapterId !== record.adapterId
    || evidence.adapterVersion !== record.adapterVersion
    || evidence.credentialBindingId !== record.credentialBindingId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Integration authentication evidence does not match registry lineage");
  }
}

function transition(
  record: CompanyIntegration,
  nextState: CompanyIntegration["state"],
  updatedAt: string
): CompanyIntegration {
  assertCompanyIntegrationIntegrity(record);
  const base = {
    ...record,
    state: nextState,
    updatedAt: parseTime(updatedAt, "integration updatedAt")
  };
  delete (base as Partial<CompanyIntegration>).recordHash;
  return Object.freeze({ ...base, recordHash: sha256Hex(base) }) as CompanyIntegration;
}

export function beginIntegrationAuthentication(
  record: CompanyIntegration,
  scope: TrustedExecutionScope,
  updatedAt: string
) {
  assertScope(record, scope);
  if (!["disconnected", "degraded"].includes(record.state)) {
    throw new ControlPlaneError("CONFLICT", `Cannot authenticate integration from ${record.state}`);
  }
  return transition(record, "authenticating", updatedAt);
}

export function activateIntegration(input: {
  record: CompanyIntegration;
  scope: TrustedExecutionScope;
  evidence: IntegrationAuthenticationEvidence;
  activatedAt: string;
}): CompanyIntegration {
  assertScope(input.record, input.scope);
  if (input.record.state !== "authenticating") {
    throw new ControlPlaneError("CONFLICT", "Integration must be authenticating before activation");
  }
  assertEvidence(input.record, input.evidence);
  if (!input.evidence.authenticated) {
    throw new ControlPlaneError("FORBIDDEN", "Unauthenticated integration evidence cannot activate a connection");
  }
  if (input.record.mock && input.record.environment !== "development") {
    throw new ControlPlaneError("FORBIDDEN", "Mock integration adapters are DEVELOPMENT-only");
  }
  return transition(input.record, "connected", input.activatedAt);
}

export function deactivateIntegration(
  record: CompanyIntegration,
  scope: TrustedExecutionScope,
  updatedAt: string,
  state: "disabled" | "revoked" | "disconnected" = "disabled"
) {
  assertScope(record, scope);
  return transition(record, state, updatedAt);
}

export function assertIntegrationUsable(input: {
  record: CompanyIntegration;
  scope: TrustedExecutionScope;
  access: "read" | "write";
  requiredScope: string;
}) {
  assertCompanyIntegrationIntegrity(input.record);
  assertScope(input.record, input.scope);
  if (input.record.state !== "connected") {
    throw new ControlPlaneError("UNAVAILABLE", "Integration is not connected");
  }
  if (input.record.mock && input.record.environment !== "development") {
    throw new ControlPlaneError("FORBIDDEN", "Mock integration cannot be used outside DEVELOPMENT");
  }
  const scopes = input.access === "read" ? input.record.readScopes : input.record.writeScopes;
  if (!scopes.includes(input.requiredScope)) {
    throw new ControlPlaneError("FORBIDDEN", "Integration does not grant the required access scope");
  }
  return input.record;
}
