import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import {
  PostgresCurrentExecutionAdmissionGate
} from "@/lib/execution/current-execution-admission";
import {
  createCompanyIntegration,
  deactivateIntegration
} from "@/lib/integrations/registry";
import { autoGrantFor, fixtureNow, fixtureScope } from "@/lib/planning/test-security-fixture";
import { validPlan } from "@/lib/planning/test-fixture";

class ScriptedDb implements SqlQueryable {
  constructor(private readonly rowsByCall: readonly (readonly QueryResultRow[])[]) {}
  private call = 0;

  async query<R extends QueryResultRow = QueryResultRow>() {
    const rows = (this.rowsByCall[this.call++] ?? []) as readonly R[];
    return {
      command: "",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows: [...rows]
    };
  }
}

function gate(
  rowsByCall: readonly (readonly QueryResultRow[])[] = [[]]
) {
  return new PostgresCurrentExecutionAdmissionGate(
    new ScriptedDb(rowsByCall),
    () => fixtureNow
  );
}

function input(grant: AuthorizationGrant) {
  return {
    scope: fixtureScope(validPlan()),
    grant,
    capability: grant.capabilityNames[0]!,
    timeoutMs: 1_000,
    attempt: 1
  };
}

describe("fresh execution admission", () => {
  it("blocks execution when the underlying approval Decision is no longer approved", async () => {
    const base = autoGrantFor(validPlan());
    const grant = {
      ...base,
      decisionId: "decision-1",
      approvalProofHash: "proof-hash"
    };
    const scope = fixtureScope(validPlan());
    const admission = gate([[
      {
        payload: {
          id: "decision-1",
          portfolioId: scope.portfolioId,
          companyId: scope.companyId,
          status: "rejected",
          version: 2,
          requiresStepUp: false,
          updatedAt: fixtureNow.toISOString()
        }
      } as QueryResultRow
    ]]);

    await expect(admission.assertAllowed(input(grant)))
      .rejects.toThrow(/Decision is rejected/i);
  });

  it("blocks a paused Objective immediately", async () => {
    const base = autoGrantFor(validPlan());
    const grant = { ...base, objectiveId: "objective-1" };
    const admission = gate([[
      {
        payload: {
          id: "objective-1",
          scopeId: "company-a",
          metric: "revenue",
          direction: "increase",
          target: 1,
          priority: 1,
          status: "paused"
        }
      } as QueryResultRow
    ]]);

    await expect(admission.assertAllowed(input(grant)))
      .rejects.toThrow(/Objective is paused/i);
  });

  it("requires an integration binding for consequential business capabilities", async () => {
    const base = autoGrantFor(validPlan());
    const grant = {
      ...base,
      capabilityNames: ["email.send"],
      integrationId: undefined
    };

    await expect(gate().assertAllowed(input(grant)))
      .rejects.toThrow(/requires a current integration binding/i);
  });

  it("blocks an integration whose adapter binding no longer matches the capability", async () => {
    const plan = validPlan();
    const scope = fixtureScope(plan);
    const base = autoGrantFor(plan);
    const mismatched = createCompanyIntegration({
      id: "integration-wrong-adapter",
      scope,
      kind: "gmail",
      displayName: "Wrong adapter",
      adapterId: "business.slack",
      adapterVersion: "1.0.0",
      writeScopes: ["email.send"],
      createdAt: fixtureNow.toISOString()
    });
    const grant = {
      ...base,
      capabilityNames: ["email.send"],
      integrationId: mismatched.id
    };
    const admission = gate([[{ payload: mismatched } as QueryResultRow]]);

    await expect(admission.assertAllowed(input(grant)))
      .rejects.toThrow(/adapter does not match/i);
  });

  it("blocks a disabled integration immediately", async () => {
    const plan = validPlan();
    const scope = fixtureScope(plan);
    const base = autoGrantFor(plan);
    const created = createCompanyIntegration({
      id: "integration-1",
      scope,
      kind: "gmail",
      displayName: "Gmail",
      adapterId: "business.email",
      adapterVersion: "1.0.0",
      writeScopes: ["email.send"],
      createdAt: fixtureNow.toISOString()
    });
    const disabled = deactivateIntegration(
      created,
      scope,
      fixtureNow.toISOString(),
      "disabled"
    );
    const grant = {
      ...base,
      capabilityNames: ["email.send"],
      integrationId: disabled.id
    };
    const admission = gate([[{ payload: disabled } as QueryResultRow]]);

    await expect(admission.assertAllowed(input(grant)))
      .rejects.toThrow(/Integration is disabled/i);
  });

  it("blocks an enabled emergency or scoped kill switch immediately", async () => {
    const grant = autoGrantFor(validPlan());
    const admission = gate([[
      {
        payload: {
          id: "emergency-stop",
          scopeType: "company",
          scopeId: fixtureScope(validPlan()).companyId,
          enabled: true,
          reason: "operator emergency stop",
          activatedAt: fixtureNow.toISOString(),
          activatedBy: "owner"
        }
      } as QueryResultRow
    ]]);

    await expect(admission.assertAllowed(input(grant)))
      .rejects.toThrow(/kill switch: emergency-stop/i);
  });

  it("enforces persisted execution timeout and retry limits", async () => {
    const base = autoGrantFor(validPlan());
    const grant = {
      ...base,
      executionLimits: {
        environment: base.scope.environment,
        expectedDurationSeconds: 1,
        retryable: false
      }
    };

    await expect(gate().assertAllowed({
      ...input(grant),
      timeoutMs: 1_001
    })).rejects.toThrow(/timeout exceeds authorized execution limits/i);

    await expect(gate().assertAllowed({
      ...input(grant),
      attempt: 2
    })).rejects.toThrow(/does not permit a repeated side-effect attempt/i);
  });

  it("allows current authority when no live revocation is present", async () => {
    const grant = autoGrantFor(validPlan());
    await expect(gate().assertAllowed(input(grant))).resolves.toBeUndefined();
  });
});
