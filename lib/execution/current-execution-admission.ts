import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import type { Objective } from "@/lib/domain/objectives";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import { requireEnabledCapability } from "@/lib/domain/capabilities";
import {
  blockingKillSwitches,
  type KillSwitch
} from "@/lib/domain/kill-switch";
import type { CompanyIntegration } from "@/lib/integrations/contracts";
import { assertCompanyIntegrationScope } from "@/lib/integrations/registry";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

export interface CurrentExecutionAdmissionInput {
  scope: TrustedExecutionScope;
  grant: AuthorizationGrant;
  capability: string;
  timeoutMs: number;
  attempt: number;
}

export interface CurrentExecutionAdmissionGate {
  assertAllowed(input: CurrentExecutionAdmissionInput): Promise<void>;
}

function assertExecutionLimits(
  input: CurrentExecutionAdmissionInput,
  now: number
) {
  const limits = input.grant.executionLimits;
  if (!limits) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Current execution requires persisted authorization execution limits"
    );
  }
  if (limits.environment !== input.scope.environment) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorized execution environment no longer matches current scope"
    );
  }
  if (
    !Number.isInteger(input.timeoutMs)
    || input.timeoutMs <= 0
    || !Number.isInteger(input.attempt)
    || input.attempt < 1
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Execution timeout and attempt must be positive integers"
    );
  }
  if (limits.deadline) {
    const deadline = Date.parse(limits.deadline);
    if (!Number.isFinite(deadline) || deadline <= now) {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        "Authorized execution deadline is invalid or has elapsed"
      );
    }
  }
  if (
    limits.expectedDurationSeconds !== undefined
    && input.timeoutMs > limits.expectedDurationSeconds * 1_000
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Requested provider timeout exceeds authorized execution limits"
    );
  }
  if (!limits.retryable && input.attempt > 1) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Authorization does not permit a repeated side-effect attempt"
    );
  }
}

export class PostgresCurrentExecutionAdmissionGate
  implements CurrentExecutionAdmissionGate {
  constructor(
    private readonly db: SqlQueryable,
    private readonly now: () => Date = () => new Date()
  ) {}

  async assertAllowed(input: CurrentExecutionAdmissionInput) {
    assertExecutionLimits(input, this.now().getTime());

    if (!input.grant.capabilityNames.includes(input.capability)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Requested capability is outside current grant authority"
      );
    }

    const capability = requireEnabledCapability(input.capability);
    const requiresBusinessIntegration =
      capability.productionEffect
      && capability.adapterBinding.startsWith("business.");
    if (requiresBusinessIntegration && !input.grant.integrationId) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Consequential business capability requires a current integration binding"
      );
    }

    if (input.grant.decisionId) {
      const decision = await this.db.query<{ payload: AuthoritativeDecision }>(
        `SELECT payload
         FROM control_plane_entities
         WHERE entity_type='decision'
           AND id=$1
           AND portfolio_id=$2
           AND company_id=$3`,
        [
          input.grant.decisionId,
          input.scope.portfolioId,
          input.scope.companyId
        ]
      );
      const current = decision.rows[0]?.payload;
      if (
        !current
        || current.id !== input.grant.decisionId
        || current.portfolioId !== input.scope.portfolioId
        || current.companyId !== input.scope.companyId
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Approval Decision is missing from the current company scope"
        );
      }
      if (current.status !== "approved") {
        throw new ControlPlaneError(
          "POLICY_BLOCKED",
          `Approval Decision is ${current.status}; new execution is blocked`
        );
      }
      if (
        current.approvalProof?.proofHash !== input.grant.approvalProofHash
        || (
          input.grant.stepUpProofHash !== undefined
          && current.stepUpProof?.proofHash !== input.grant.stepUpProofHash
        )
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Current Decision proof no longer matches the issued authorization grant"
        );
      }
    }

    if (input.grant.objectiveId) {
      const objective = await this.db.query<{ payload: Objective }>(
        `SELECT payload
         FROM control_plane_entities
         WHERE entity_type='objective'
           AND id=$1
           AND portfolio_id=$2
           AND company_id=$3`,
        [
          input.grant.objectiveId,
          input.scope.portfolioId,
          input.scope.companyId
        ]
      );
      const current = objective.rows[0]?.payload;
      if (!current || current.id !== input.grant.objectiveId) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Objective authority is missing from the current company scope"
        );
      }
      if (current.status !== "active") {
        throw new ControlPlaneError(
          "POLICY_BLOCKED",
          `Objective is ${current.status}; new execution is blocked`
        );
      }
    }

    if (input.grant.integrationId) {
      const integration = await this.db.query<{ payload: CompanyIntegration }>(
        `SELECT payload
         FROM control_plane_entities
         WHERE entity_type='integration'
           AND id=$1
           AND portfolio_id=$2
           AND company_id=$3`,
        [
          input.grant.integrationId,
          input.scope.portfolioId,
          input.scope.companyId
        ]
      );
      const current = integration.rows[0]?.payload;
      if (!current) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Required integration binding is missing from the current company scope"
        );
      }
      assertCompanyIntegrationScope(current, input.scope);
      if (current.adapterId !== capability.adapterBinding) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Current integration adapter does not match the authorized capability binding"
        );
      }
      if (current.state !== "connected") {
        throw new ControlPlaneError(
          "POLICY_BLOCKED",
          `Integration is ${current.state}; new execution is blocked`
        );
      }
      if (current.mock && input.scope.environment !== "development") {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Mock integration cannot authorize non-development execution"
        );
      }
      const accessScopes = capability.access === "read"
        ? current.readScopes
        : current.writeScopes;
      if (accessScopes.length === 0) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          `Current integration grants no ${capability.access} access`
        );
      }
    }

    const killSwitchResult = await this.db.query<{ payload: KillSwitch }>(
      `SELECT payload
       FROM control_plane_entities
       WHERE entity_type='kill-switch'
         AND portfolio_id=$1
         AND company_id=$2`,
      [input.scope.portfolioId, input.scope.companyId]
    );
    const blocking = blockingKillSwitches(
      killSwitchResult.rows.map((row) => row.payload),
      {
        portfolioId: input.scope.portfolioId,
        companyId: input.scope.companyId,
        integrationId: input.grant.integrationId,
        capability: input.capability,
        resourceId: input.scope.resourceId
      }
    );
    if (blocking.length > 0) {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        `Current execution is stopped by kill switch: ${blocking[0]!.id}`
      );
    }
  }
}
