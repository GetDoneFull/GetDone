import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const INTEGRATION_REGISTRY_CONTRACT_VERSION = "1.1.0";

export type IntegrationKind =
  | "stripe"
  | "github"
  | "sentry"
  | "analytics"
  | "hubspot"
  | "gmail"
  | "slack"
  | "notion"
  | "rest-api"
  | "webhook"
  | "mcp";

export type IntegrationConnectionState =
  | "disconnected"
  | "authenticating"
  | "connected"
  | "degraded"
  | "disabled"
  | "revoked";

export interface IntegrationHealth {
  status: "unknown" | "healthy" | "degraded" | "unavailable";
  observedAt?: string;
  detail?: string;
}

export interface IntegrationRateLimits {
  requestsPerMinute?: number;
  requestsPerDay?: number;
  concurrentRequests?: number;
}

export interface CompanyIntegration {
  id: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  kind: IntegrationKind;
  /** Provider identity is explicit and never inferred from model/job input. */
  provider: string;
  displayName: string;
  adapterId: string;
  adapterVersion: string;
  credentialBindingId?: string;
  /** Provider-side account identity, never a credential. */
  accountIdentity: string | null;
  /** GetDone capability IDs this exact tenant/environment binding supports. */
  supportedCapabilities: readonly string[];
  readScopes: readonly string[];
  writeScopes: readonly string[];
  state: IntegrationConnectionState;
  health: IntegrationHealth;
  rateLimits: IntegrationRateLimits;
  /** Explicit policy binding IDs that constrain this integration. */
  policies: readonly string[];
  metadata: Readonly<Record<string, string | number | boolean | null>>;
  mock: boolean;
  createdAt: string;
  updatedAt: string;
  recordHash: string;
}

export interface IntegrationAuthenticationEvidence {
  source: "integration-adapter";
  integrationId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  adapterId: string;
  adapterVersion: string;
  authenticated: boolean;
  credentialBindingId?: string;
  observedAt: string;
  evidenceHash: string;
}

export interface IntegrationAdapter {
  readonly id: string;
  readonly version: string;
  readonly mock: boolean;
  authenticate(input: {
    integration: CompanyIntegration;
    credentialBindingId?: string;
  }): Promise<IntegrationAuthenticationEvidence>;
}

export interface IntegrationRegistryStore {
  get(id: string): Promise<CompanyIntegration | null>;
  put(record: CompanyIntegration): Promise<void>;
  listByCompany(input: {
    portfolioId: string;
    companyId: string;
    environment?: TrustedExecutionScope["environment"];
  }): Promise<readonly CompanyIntegration[]>;
}
