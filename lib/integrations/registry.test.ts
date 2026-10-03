import { describe, expect, it } from "vitest";
import {
  activateIntegration,
  assertIntegrationUsable,
  beginIntegrationAuthentication,
  createCompanyIntegration,
  deactivateIntegration,
  getCompanyIntegrationForScope,
  listCompanyIntegrationsForScope
} from "@/lib/integrations/registry";
import { DevelopmentMockIntegrationAdapter } from "@/lib/integrations/development-mock-adapter";
import type { CompanyIntegration, IntegrationRegistryStore } from "@/lib/integrations/contracts";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "development" as const
};

function makeIntegration(input: {
  id?: string;
  companyId?: string;
  adapterId?: string;
  credentialBindingId?: string;
} = {}) {
  return createCompanyIntegration({
    id: input.id ?? "github-a",
    scope: {
      ...scope,
      companyId: input.companyId ?? scope.companyId
    },
    kind: "github",
    displayName: "GitHub",
    adapterId: input.adapterId ?? "development-mock-integration",
    adapterVersion: "1.0.0",
    credentialBindingId: input.credentialBindingId ?? "credential-binding-github-a",
    accountIdentity: "github-account-a",
    supportedCapabilities: [
      "github.repository.read",
      "github.branch.create",
      "github.pull-request.write"
    ],
    readScopes: ["repository.read"],
    writeScopes: ["repository.write"],
    health: {
      status: "healthy",
      observedAt: "2026-09-20T21:59:00Z"
    },
    rateLimits: { requestsPerMinute: 60 },
    policies: ["policy:github-default"],
    metadata: { installation: "app" },
    mock: true,
    createdAt: "2026-09-20T22:00:00Z"
  });
}

async function connected() {
  const created = makeIntegration();
  const authenticating = beginIntegrationAuthentication(created, scope, "2026-09-20T22:00:01Z");
  const adapter = new DevelopmentMockIntegrationAdapter(
    "development-mock-integration",
    () => new Date("2026-09-20T22:00:01.500Z")
  );
  const evidence = await adapter.authenticate({
    integration: authenticating,
    credentialBindingId: authenticating.credentialBindingId
  });
  return activateIntegration({
    record: authenticating,
    scope,
    evidence,
    activatedAt: "2026-09-20T22:00:02Z"
  });
}

class TenantAdversarialStore implements IntegrationRegistryStore {
  constructor(private readonly records: readonly CompanyIntegration[]) {}

  async get(id: string) {
    return this.records.find((record) => record.id === id) ?? null;
  }

  async put(record: CompanyIntegration) {
    void record;
  }

  async listByCompany(input: {
    portfolioId: string;
    companyId: string;
    environment?: CompanyIntegration["environment"];
  }) {
    void input;
    return this.records;
  }
}

describe("Phase 4 deterministic Integration Registry", () => {
  it("records the minimum provider/capability/health/policy contract", () => {
    const record = makeIntegration();
    expect(record).toMatchObject({
      provider: "github",
      accountIdentity: "github-account-a",
      supportedCapabilities: [
        "github.branch.create",
        "github.pull-request.write",
        "github.repository.read"
      ],
      state: "disconnected",
      health: { status: "healthy" },
      rateLimits: { requestsPerMinute: 60 },
      policies: ["policy:github-default"],
      metadata: { installation: "app" }
    });
  });

  it("keeps read and write permissions explicit and separate", async () => {
    const record = await connected();
    expect(assertIntegrationUsable({
      record,
      scope,
      access: "read",
      requiredScope: "repository.read"
    })).toBe(record);
    expect(() => assertIntegrationUsable({
      record,
      scope,
      access: "write",
      requiredScope: "repository.read"
    })).toThrow(/required access scope/i);
  });

  it("fails tenant scope tampering", async () => {
    const record = await connected();
    expect(() => assertIntegrationUsable({
      record,
      scope: { ...scope, companyId: "company-b" },
      access: "read",
      requiredScope: "repository.read"
    })).toThrow(/outside trusted/i);
  });

  it("enforces tenant isolation at scoped store retrieval even if a store returns the wrong tenant", async () => {
    const foreign = makeIntegration({ id: "foreign", companyId: "company-b" });
    const store = new TenantAdversarialStore([foreign]);
    await expect(getCompanyIntegrationForScope({
      store,
      id: "foreign",
      scope
    })).rejects.toThrow(/outside trusted/i);
    await expect(listCompanyIntegrationsForScope({
      store,
      scope
    })).rejects.toThrow(/outside trusted/i);
  });

  it("cannot activate from provider evidence that changes company lineage", async () => {
    const created = createCompanyIntegration({
      id: "slack-a",
      scope,
      kind: "slack",
      displayName: "Slack",
      adapterId: "development-mock-integration",
      adapterVersion: "1.0.0",
      credentialBindingId: "credential-binding-slack-a",
      readScopes: ["messages.read"],
      createdAt: "2026-09-20T22:00:00Z",
      mock: true
    });
    const authenticating = beginIntegrationAuthentication(created, scope, "2026-09-20T22:00:01Z");
    const adapter = new DevelopmentMockIntegrationAdapter(
      "development-mock-integration",
      () => new Date("2026-09-20T22:00:01.500Z")
    );
    const evidence = await adapter.authenticate({
      integration: authenticating,
      credentialBindingId: authenticating.credentialBindingId
    });
    const tampered = { ...evidence, companyId: "company-b" };
    expect(() => activateIntegration({
      record: authenticating,
      scope,
      evidence: tampered,
      activatedAt: "2026-09-20T22:00:02Z"
    })).toThrow();
  });

  it("uses credential references and rejects raw credential-shaped values", () => {
    expect(() => createCompanyIntegration({
      id: "github-secret",
      scope,
      kind: "github",
      displayName: "GitHub",
      adapterId: "adapter",
      adapterVersion: "1.0.0",
      credentialBindingId: "Bearer " + "x".repeat(28),
      createdAt: "2026-09-20T22:00:00Z"
    })).toThrow(/reference/i);
  });

  it("deactivation removes usability without deleting history", async () => {
    const record = await connected();
    const disabled = deactivateIntegration(record, scope, "2026-09-20T22:05:00Z");
    expect(disabled.state).toBe("disabled");
    expect(disabled.id).toBe(record.id);
    expect(() => assertIntegrationUsable({
      record: disabled,
      scope,
      access: "read",
      requiredScope: "repository.read"
    })).toThrow(/not connected/i);
  });

  it("mock adapters fail outside development", async () => {
    const productionScope = { ...scope, environment: "production" as const };
    const record = createCompanyIntegration({
      id: "mock-prod",
      scope: productionScope,
      kind: "rest-api",
      displayName: "Mock",
      adapterId: "development-mock-integration",
      adapterVersion: "1.0.0",
      mock: true,
      createdAt: "2026-09-20T22:00:00Z"
    });
    const adapter = new DevelopmentMockIntegrationAdapter();
    await expect(adapter.authenticate({ integration: record })).rejects.toThrow(/DEVELOPMENT-only/);
  });

  it("makes DEVELOPMENT mock authentication deterministic with an injected clock", async () => {
    const record = makeIntegration();
    const adapter = new DevelopmentMockIntegrationAdapter(
      "development-mock-integration",
      () => new Date("2026-09-20T22:00:07Z")
    );
    const evidence = await adapter.authenticate({
      integration: record,
      credentialBindingId: record.credentialBindingId
    });
    expect(evidence.observedAt).toBe("2026-09-20T22:00:07.000Z");
  });

  it("rejects mock adapter identity or credential-reference drift", async () => {
    const wrongAdapterRecord = makeIntegration({ adapterId: "other-adapter" });
    const adapter = new DevelopmentMockIntegrationAdapter();
    await expect(adapter.authenticate({
      integration: wrongAdapterRecord,
      credentialBindingId: wrongAdapterRecord.credentialBindingId
    })).rejects.toThrow(/identity/i);

    const record = makeIntegration();
    await expect(adapter.authenticate({
      integration: record,
      credentialBindingId: "credential-binding-other"
    })).rejects.toThrow(/credential reference/i);
  });
});
