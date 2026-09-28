import { PostgresAuthAdapter } from "@/lib/auth/postgres-adapter";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import { isAIGatewayConfigured } from "@/lib/ai-gateway/runtime.server";
import { parseAuthoritativeRuntimeEnvironment } from "@/lib/control-plane/runtime-environment";
import { CONTROL_API_SURFACE_VERSION } from "@/lib/control-api/contracts";
import { ServiceBackedControlApiAdapter } from "@/lib/control-api/service-adapter";
import {
  PostgresControlApiScopeResolver,
  SessionStepUpEvidenceResolver
} from "@/lib/control-api/postgres-auth";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { Resource } from "@/lib/domain/resources";
import type {
  ResourceRegistryStores
} from "@/lib/domain/services/resource-registry-service";
import { ResourceRegistryService } from "@/lib/domain/services/resource-registry-service";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { VerificationRequestRecord } from "@/lib/domain/services/verification-service";
import type {
  ResourceEnrollmentRecord,
  ResourceEnrollmentStores
} from "@/lib/resources/enrollment";
import { ResourceEnrollmentService } from "@/lib/resources/enrollment";
import {
  PostgresEntityStore
} from "@/lib/persistence/postgres/authority-stores";
import {
  PostgresOwnerIntentStore,
  PostgresResourceEnrollmentReadinessStore,
  PostgresResourceEvidenceStore
} from "@/lib/persistence/postgres/control-api-stores";
import {
  PostgresDecisionResumeRequestStore,
  PostgresOrchestrationAuthorizationGrantStore,
  PostgresOrchestrationDecisionStore
} from "@/lib/persistence/postgres/orchestration-authorization-stores";
import {
  PostgresOrchestrationPlanProposalStore
} from "@/lib/persistence/postgres/orchestration-planning-stores";
import {
  PostgresOrchestrationPolicyEvaluationStore,
  PostgresOrchestrationValidationArtifactStore
} from "@/lib/persistence/postgres/orchestration-validation-policy-stores";
import {
  PostgresOrchestrationRunStore
} from "@/lib/persistence/postgres/orchestration-store";
import {
  DecisionResumeDispatcher
} from "@/lib/orchestration/authorization-flow";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

export function createPostgresControlApiAdapter(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const environment = parseAuthoritativeRuntimeEnvironment(env.GETDONE_RUNTIME_ENV);
  if (environment === "development") {
    throw new Error("Postgres production Control API adapter must not be installed in development");
  }

  const runtime = getPostgresRuntimeFromEnv(env);
  const db = runtime.database;
  const webAuthn = readWebAuthnServerConfig(env);

  const decisions = new PostgresEntityStore<AuthoritativeDecision>(db, "decision");
  const resources = new PostgresEntityStore<Resource>(db, "resource");
  const resourceEnrollments = new PostgresEntityStore<ResourceEnrollmentRecord>(
    db,
    "resource-enrollment"
  );
  const jobs = new PostgresEntityStore<JobRecord>(db, "job");
  const verifications = new PostgresEntityStore<VerificationRequestRecord>(
    db,
    "verification"
  );

  const decisionTransactions = new PostgresControlPlaneTransactionManager(
    db,
    (client) => ({
      decisions: new PostgresEntityStore<AuthoritativeDecision>(client, "decision"),
      resumeRequests: new PostgresDecisionResumeRequestStore(client)
    })
  );

  const decisionResumeDispatcher = new DecisionResumeDispatcher({
    runStore: new PostgresOrchestrationRunStore(db),
    queue: new PostgresDecisionResumeRequestStore(db),
    plans: new PostgresOrchestrationPlanProposalStore(db),
    validations: new PostgresOrchestrationValidationArtifactStore(db),
    policies: new PostgresOrchestrationPolicyEvaluationStore(db),
    decisions: new PostgresOrchestrationDecisionStore(db),
    grants: new PostgresOrchestrationAuthorizationGrantStore(db)
  });

  const resourceRegistry = new ResourceRegistryService(
    new PostgresControlPlaneTransactionManager<ResourceRegistryStores>(
      db,
      (client) => ({
        resources: new PostgresEntityStore<Resource>(client, "resource"),
        identities: new PostgresResourceEvidenceStore(client, "identity"),
        trust: new PostgresResourceEvidenceStore(client, "trust"),
        health: new PostgresResourceEvidenceStore(client, "health"),
        capabilities: new PostgresResourceEvidenceStore(client, "capability"),
        locations: new PostgresResourceEvidenceStore(client, "location"),
        costs: new PostgresResourceEvidenceStore(client, "cost"),
        providers: new PostgresResourceEvidenceStore(client, "provider")
      })
    )
  );

  const resourceEnrollmentService = new ResourceEnrollmentService(
    new PostgresControlPlaneTransactionManager<ResourceEnrollmentStores>(
      db,
      (client) => ({
        enrollments: new PostgresEntityStore<ResourceEnrollmentRecord>(
          client,
          "resource-enrollment"
        ),
        resourceReadiness: new PostgresResourceEnrollmentReadinessStore(client)
      })
    )
  );

  return new ServiceBackedControlApiAdapter({
    auth: new PostgresAuthAdapter(db, {
      cookieName: webAuthn.cookieName,
      stepUpTtlSeconds: webAuthn.stepUpTtlSeconds,
      rpId: webAuthn.rpId,
      allowedOrigins: webAuthn.allowedOrigins
    }),
    scopes: new PostgresControlApiScopeResolver(db, environment),
    authorizationEvidence: new SessionStepUpEvidenceResolver(),
    intents: new PostgresOwnerIntentStore(db),
    decisions,
    decisionTransactions,
    decisionResumeDispatcher,
    resources,
    resourceRegistry,
    resourceEnrollments,
    resourceEnrollmentService,
    jobs,
    verifications,
    tenantScopeRunner: (scope, operation) =>
      runWithPostgresTenantScope(scope, operation),
    health: async () => {
      const health = await runtime.health();
      const schemaReady = health.connected && health.schemaCurrent;

      const requiredRelationsReady = async (relations: readonly string[]) => {
        if (!schemaReady) return false;
        const result = await db.query<{ ready: boolean }>(
          `SELECT COALESCE(bool_and(to_regclass(name) IS NOT NULL), false) AS ready
           FROM unnest($1::text[]) AS required(name)`,
          [relations]
        );
        return result.rows[0]?.ready === true;
      };

      const [coreRelationsReady, authRelationsReady, durableRelationsReady] =
        await Promise.all([
          requiredRelationsReady([
            "control_plane_entities",
            "idempotency_records",
            "audit_events",
            "owner_intents",
            "verification_receipts"
          ]),
          requiredRelationsReady([
            "auth_users",
            "auth_sessions",
            "organizations",
            "companies",
            "portfolios",
            "organization_memberships",
            "company_memberships",
            "portfolio_memberships",
            "auth_webauthn_credentials",
            "auth_step_up_challenges",
            "auth_sign_in_challenges"
          ]),
          requiredRelationsReady([
            "job_runtime_state",
            "job_leases",
            "job_runtime_transactions",
            "job_execution_specs",
            "job_execution_outcomes",
            "job_worker_instances",
            "business_action_verification_evidence"
          ])
        ]);

      const persistenceConnected = schemaReady && coreRelationsReady;
      const authConnected = persistenceConnected && authRelationsReady;
      const durableJobStoreConnected = persistenceConnected && durableRelationsReady;

      return {
        service: "getdone-control-api",
        surfaceVersion: CONTROL_API_SURFACE_VERSION,
        status: !persistenceConnected || !authConnected
          ? "unavailable"
          : health.backupFresh
            ? "ready"
            : "degraded",
        authConnected,
        persistenceConnected,
        aiGatewayAdapterInstalled: isAIGatewayConfigured(env),
        durableJobStoreConnected,
        details: {
          schemaCurrent: health.schemaCurrent,
          latestMigration: health.latestMigration ?? null,
          backupFresh: health.backupFresh,
          latestVerifiedBackupAt: health.latestVerifiedBackupAt ?? null,
          coreRelationsReady,
          authRelationsReady,
          durableRelationsReady
        }
      };
    }
  });
}
