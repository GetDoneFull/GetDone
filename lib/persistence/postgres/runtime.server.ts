import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  PostgresDatabase,
  readPostgresConfigFromEnv
} from "@/lib/persistence/postgres/client";

export const REQUIRED_POSTGRES_MIGRATION = "2026-09-28.7";

export const REQUIRED_POSTGRES_RELATIONS = Object.freeze([
  "getdone_schema_migrations",
  "control_plane_entities",
  "idempotency_records",
  "audit_events",
  "authorization_grants",
  "authorization_consumptions",
  "verification_receipts",
  "job_execution_start_facts",
  "job_execution_completion_facts",
  "capacity_ledgers",
  "capacity_reservations",
  "reservation_commits",
  "job_runtime_state",
  "job_runtime_transactions",
  "job_leases",
  "job_retry_schedule",
  "job_dead_letters",
  "job_recovery_records",
  "job_execution_specs",
  "business_action_executions",
  "software_pipeline_records",
  "database_backup_evidence",
  "auth_users",
  "auth_sessions",
  "auth_webauthn_credentials",
  "auth_step_up_challenges",
  "auth_sign_in_challenges",
  "organizations",
  "companies",
  "portfolios",
  "organization_memberships",
  "company_memberships",
  "portfolio_memberships",
  "owner_intents",
  "job_execution_outcomes",
  "job_worker_instances",
  "business_action_verification_evidence",
  "provider_concurrency_leases",
  "credential_leases",
  "credential_usage_audits",
  "rate_limit_buckets",
  "audit_chain_heads",
  "disaster_recovery_incidents",
  "job_disaster_recovery_decisions",
  "production_release_gate_evidence",
  "migration_compatibility_evidence",
  "analytics_ingestion_checkpoints",
  "analytics_ingestion_evidence",
  "analytics_ingestion_runs",
  "orchestration_runs",
  "orchestration_transition_receipts",
  "orchestration_checkpoints",
  "orchestration_worker_state",
  "orchestration_worker_instances",
  "orchestration_worker_dead_letters",
  "orchestration_context_snapshots",
  "orchestration_planner_inputs",
  "orchestration_plan_proposals",
  "orchestration_validation_artifacts",
  "orchestration_policy_step_snapshots",
  "orchestration_policy_evaluations",
  "orchestration_decision_resume_requests"
] as const);

export const REQUIRED_POSTGRES_INDEXES = Object.freeze([
  "control_plane_entities_scope_idx",
  "audit_events_correlation_idx",
  "job_runtime_ready_idx",
  "job_leases_one_active_per_job",
  "job_leases_expiry_idx",
  "job_worker_instances_status_idx",
  "business_action_verification_scope_idx",
  "business_action_executions_job_idx",
  "provider_concurrency_leases_active_idx",
  "credential_leases_scope_idx",
  "credential_leases_job_idx",
  "credential_usage_audits_lease_idx",
  "rate_limit_buckets_expiry_idx",
  "audit_events_chain_sequence_idx",
  "audit_events_chain_hash_idx",
  "job_disaster_recovery_active_hold_idx",
  "job_disaster_recovery_incident_decision_idx",
  "production_release_gate_passed_sha_idx",
  "migration_compatibility_release_idx",
  "analytics_ingestion_evidence_source_idx",
  "analytics_ingestion_checkpoint_updated_idx",
  "analytics_ingestion_runs_scope_idx",
  "orchestration_runs_scope_idx",
  "orchestration_runs_source_idx",
  "orchestration_runs_resumable_idx",
  "orchestration_transition_receipts_scope_idx",
  "orchestration_checkpoints_scope_idx",
  "orchestration_worker_ready_idx",
  "orchestration_worker_lease_expiry_idx",
  "orchestration_worker_scope_idx",
  "orchestration_worker_dispatch_ready_idx",
  "orchestration_worker_instances_status_idx",
  "orchestration_worker_dead_letters_scope_idx",
  "orchestration_worker_dead_letters_run_idx",
  "orchestration_context_snapshots_scope_idx",
  "orchestration_context_snapshots_source_idx",
  "orchestration_planner_inputs_scope_idx",
  "orchestration_planner_inputs_snapshot_idx",
  "orchestration_plan_proposals_scope_idx",
  "orchestration_plan_proposals_input_idx",
  "orchestration_validation_artifacts_scope_idx",
  "orchestration_validation_artifacts_plan_idx",
  "orchestration_policy_step_snapshots_scope_idx",
  "orchestration_policy_step_snapshots_run_idx",
  "orchestration_policy_evaluations_scope_idx",
  "orchestration_policy_evaluations_plan_idx",
  "orchestration_policy_evaluations_validation_idx",
  "orchestration_decision_resume_scope_idx",
  "orchestration_decision_resume_pending_idx"
] as const);

export const REQUIRED_POSTGRES_RLS_RELATIONS = Object.freeze([
  "control_plane_entities",
  "audit_events",
  "authorization_grants",
  "authorization_consumptions",
  "verification_receipts",
  "job_execution_start_facts",
  "job_execution_completion_facts",
  "capacity_ledgers",
  "capacity_reservations",
  "reservation_commits",
  "owner_intents",
  "resource_evidence",
  "business_action_executions",
  "business_action_verification_evidence",
  "credential_leases",
  "credential_usage_audits",
  "audit_chain_heads",
  "analytics_ingestion_checkpoints",
  "analytics_ingestion_evidence",
  "analytics_ingestion_runs",
  "orchestration_runs",
  "orchestration_transition_receipts",
  "orchestration_checkpoints",
  "orchestration_worker_dead_letters",
  "orchestration_context_snapshots",
  "orchestration_planner_inputs",
  "orchestration_plan_proposals",
  "orchestration_validation_artifacts",
  "orchestration_policy_step_snapshots",
  "orchestration_policy_evaluations",
  "orchestration_decision_resume_requests"
] as const);

export interface PostgresRuntimeHealth {
  connected: boolean;
  inspectionSucceeded: boolean;
  ready: boolean;
  schemaCurrent: boolean;
  latestMigration?: string;
  requiredRelationsPresent: boolean;
  missingRelations: readonly string[];
  requiredIndexesPresent: boolean;
  missingIndexes: readonly string[];
  tenantRlsProtected: boolean;
  missingRlsRelations: readonly string[];
  databaseRole?: string;
  databaseRoleRlsSafe: boolean;
  transactionIsolationSerializable: boolean;
  transactionIsolation?: string;
  backupFresh: boolean;
  latestVerifiedBackupAt?: string;
}

interface PresenceRow {
  name: string;
  present: boolean;
}

interface RlsRow {
  name: string;
  row_security: boolean | null;
  force_row_security: boolean | null;
}

interface RoleRow {
  role_name: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

const unavailableHealth = (): PostgresRuntimeHealth => ({
  connected: false,
  inspectionSucceeded: false,
  ready: false,
  schemaCurrent: false,
  requiredRelationsPresent: false,
  missingRelations: REQUIRED_POSTGRES_RELATIONS,
  requiredIndexesPresent: false,
  missingIndexes: REQUIRED_POSTGRES_INDEXES,
  tenantRlsProtected: false,
  missingRlsRelations: REQUIRED_POSTGRES_RLS_RELATIONS,
  databaseRoleRlsSafe: false,
  transactionIsolationSerializable: false,
  backupFresh: false
});

export class PostgresRuntime {
  constructor(
    readonly database: PostgresDatabase,
    private readonly backupMaxAgeHours = 24
  ) {}

  private async missingObjects(names: readonly string[]) {
    const result = await this.database.query<PresenceRow>(
      `SELECT name, to_regclass(name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS required(name)`,
      [names]
    );
    return result.rows.filter((row) => !row.present).map((row) => row.name);
  }

  private async tenantRlsHealth() {
    const result = await this.database.query<RlsRow>(
      `SELECT
         required.name,
         relation.relrowsecurity AS row_security,
         relation.relforcerowsecurity AS force_row_security
       FROM unnest($1::text[]) AS required(name)
       LEFT JOIN pg_class relation ON relation.oid = to_regclass(required.name)`,
      [REQUIRED_POSTGRES_RLS_RELATIONS]
    );
    const missingRlsRelations = result.rows
      .filter((row) => row.row_security !== true || row.force_row_security !== true)
      .map((row) => row.name);

    const roleResult = await this.database.query<RoleRow>(
      `SELECT
         current_user AS role_name,
         role.rolsuper,
         role.rolbypassrls
       FROM pg_roles role
       WHERE role.rolname = current_user`
    );
    const role = roleResult.rows[0];
    return {
      tenantRlsProtected: missingRlsRelations.length === 0,
      missingRlsRelations,
      databaseRole: role?.role_name,
      databaseRoleRlsSafe: Boolean(role && !role.rolsuper && !role.rolbypassrls)
    };
  }

  async health(now = Date.now()): Promise<PostgresRuntimeHealth> {
    try {
      await this.database.query("SELECT 1");
    } catch {
      return unavailableHealth();
    }

    try {
      const missingRelations = await this.missingObjects(REQUIRED_POSTGRES_RELATIONS);
      const missingIndexes = await this.missingObjects(REQUIRED_POSTGRES_INDEXES);
      const requiredRelationsPresent = missingRelations.length === 0;
      const requiredIndexesPresent = missingIndexes.length === 0;

      let latestMigration: string | undefined;
      if (!missingRelations.includes("getdone_schema_migrations")) {
        const migrations = await this.database.query<{ version: string }>(
          "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
        );
        latestMigration = migrations.rows[0]?.version;
      }
      const schemaCurrent = latestMigration === REQUIRED_POSTGRES_MIGRATION;

      const rls = await this.tenantRlsHealth();
      const transactionIsolation = await this.database.serializableTransactionIsolation();
      const transactionIsolationSerializable = transactionIsolation === "serializable";

      let latestVerifiedBackupAt: string | undefined;
      let backupFresh = false;
      if (!missingRelations.includes("database_backup_evidence")) {
        const backups = await this.database.query<{
          completed_at: Date | string;
          verification_hash: string;
        }>(
          `SELECT completed_at,verification_hash
           FROM database_backup_evidence
           WHERE status='verified'
           ORDER BY completed_at DESC LIMIT 1`
        );
        const latest = backups.rows[0];
        if (latest && /^[a-f0-9]{64}$/i.test(latest.verification_hash)) {
          const value = latest.completed_at;
          latestVerifiedBackupAt = value instanceof Date ? value.toISOString() : String(value);
          const ageMs = now - Date.parse(latestVerifiedBackupAt);
          backupFresh = Number.isFinite(ageMs)
            && ageMs >= 0
            && ageMs <= this.backupMaxAgeHours * 60 * 60_000;
        }
      }

      const ready = schemaCurrent
        && requiredRelationsPresent
        && requiredIndexesPresent
        && rls.tenantRlsProtected
        && rls.databaseRoleRlsSafe
        && transactionIsolationSerializable
        && backupFresh;

      return {
        connected: true,
        inspectionSucceeded: true,
        ready,
        schemaCurrent,
        latestMigration,
        requiredRelationsPresent,
        missingRelations,
        requiredIndexesPresent,
        missingIndexes,
        ...rls,
        transactionIsolationSerializable,
        transactionIsolation,
        backupFresh,
        latestVerifiedBackupAt
      };
    } catch {
      return {
        ...unavailableHealth(),
        connected: true
      };
    }
  }

  async assertReady() {
    const health = await this.health();
    if (!health.connected) {
      throw new ControlPlaneError("UNAVAILABLE", "PostgreSQL production persistence is not reachable");
    }
    if (!health.inspectionSucceeded) {
      throw new ControlPlaneError("UNAVAILABLE", "PostgreSQL production readiness inspection failed");
    }
    if (!health.schemaCurrent) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `PostgreSQL schema is not current; required migration ${REQUIRED_POSTGRES_MIGRATION}`
      );
    }
    if (!health.requiredRelationsPresent) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `PostgreSQL required relations are missing: ${health.missingRelations.join(", ")}`
      );
    }
    if (!health.requiredIndexesPresent) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `PostgreSQL required indexes are missing: ${health.missingIndexes.join(", ")}`
      );
    }
    if (!health.tenantRlsProtected) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `PostgreSQL tenant RLS is not forced on: ${health.missingRlsRelations.join(", ")}`
      );
    }
    if (!health.databaseRoleRlsSafe) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "PostgreSQL runtime role must not be superuser or BYPASSRLS"
      );
    }
    if (!health.transactionIsolationSerializable) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "PostgreSQL production transaction isolation is not serializable"
      );
    }
    if (!health.backupFresh) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "PostgreSQL production backup verification evidence is missing, invalid, future-dated, or stale"
      );
    }
    if (!health.ready) {
      throw new ControlPlaneError("UNAVAILABLE", "PostgreSQL production persistence is not ready");
    }
    return health;
  }
}

let installed: PostgresRuntime | null = null;

export function getPostgresRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (installed) return installed;
  const config = readPostgresConfigFromEnv(env);
  const backupMaxAgeHours = env.GETDONE_BACKUP_MAX_AGE_HOURS
    ? Number(env.GETDONE_BACKUP_MAX_AGE_HOURS)
    : 24;
  if (!Number.isFinite(backupMaxAgeHours) || backupMaxAgeHours <= 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "GETDONE_BACKUP_MAX_AGE_HOURS must be positive");
  }
  installed = new PostgresRuntime(new PostgresDatabase(config), backupMaxAgeHours);
  return installed;
}

export async function assertPostgresReadyAtStartup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtime?: PostgresRuntime
) {
  const environment = env.GETDONE_RUNTIME_ENV?.trim();

  if (!environment) {
    if (env.NODE_ENV === "production") {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "GETDONE_RUNTIME_ENV is required before a production server can start"
      );
    }
    return null;
  }
  if (environment === "development") return null;
  if (environment !== "staging" && environment !== "production") {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "GETDONE_RUNTIME_ENV must be development, staging, or production"
    );
  }

  return (runtime ?? getPostgresRuntimeFromEnv(env)).assertReady();
}

export async function resetPostgresRuntimeForTests() {
  const current = installed;
  installed = null;
  if (current) await current.database.close();
}
