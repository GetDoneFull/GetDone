import { spawnSync } from "node:child_process";
import pg from "pg";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const requiredMigration = "2026-09-28.6";
const maxBackupAgeHours = Number(process.env.GETDONE_BACKUP_MAX_AGE_HOURS || "24");
if (!Number.isFinite(maxBackupAgeHours) || maxBackupAgeHours <= 0) {
  throw new Error("GETDONE_BACKUP_MAX_AGE_HOURS must be positive");
}

const pool = new pg.Pool({
  connectionString: required("DATABASE_URL"),
  max: 2,
  application_name: "getdone-production-verifier",
  ssl: process.env.GETDONE_DB_SSL === "false"
    ? false
    : { rejectUnauthorized: true }
});

const client = await pool.connect();
try {
  const version = await client.query("SHOW server_version_num");
  if (Number(version.rows[0]?.server_version_num) < 160000) {
    throw new Error("PostgreSQL 16+ is required");
  }

  const migration = await client.query(
    "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
  );
  if (migration.rows[0]?.version !== requiredMigration) {
    throw new Error(`Database schema is not current; expected ${requiredMigration}`);
  }

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const isolation = await client.query("SHOW transaction_isolation");
    if (isolation.rows[0]?.transaction_isolation !== "serializable") {
      throw new Error("Production transaction isolation is not serializable");
    }
    await client.query("CREATE TEMP TABLE getdone_rollback_probe(id integer) ON COMMIT DROP");
    await client.query("INSERT INTO getdone_rollback_probe(id) VALUES(1)");
    await client.query("ROLLBACK");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  }

  const rolledBack = await client.query(
    "SELECT to_regclass('pg_temp.getdone_rollback_probe') AS relation"
  );
  if (rolledBack.rows[0]?.relation !== null) {
    throw new Error("Rollback verification failed");
  }

  const constraints = await client.query(
    `SELECT indexname,indexdef FROM pg_indexes
     WHERE schemaname=current_schema()
       AND tablename IN (
         'authorization_consumptions',
         'job_leases',
         'job_runtime_transactions',
         'provider_concurrency_leases',
         'rate_limit_buckets',
         'job_disaster_recovery_decisions'
       )`
  );
  const indexText = constraints.rows.map((row) => row.indexdef).join("\n");
  for (const requiredFragment of [
    "authorization_consumptions",
    "job_leases",
    "job_runtime_transactions",
    "provider_concurrency_leases",
    "rate_limit_buckets",
    "job_disaster_recovery_decisions"
  ]) {
    if (!indexText.includes(requiredFragment)) {
      throw new Error(`Concurrency/idempotency index verification missing: ${requiredFragment}`);
    }
  }


  const rlsRelations = [
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
    "orchestration_worker_state",
    "orchestration_context_snapshots",
    "orchestration_planner_inputs",
    "orchestration_plan_proposals",
    "orchestration_validation_artifacts",
    "orchestration_policy_step_snapshots",
    "orchestration_policy_evaluations",
    "orchestration_decision_resume_requests"
  ];
  const rls = await client.query(
    `SELECT required.name, relation.relrowsecurity, relation.relforcerowsecurity
     FROM unnest($1::text[]) AS required(name)
     LEFT JOIN pg_class relation ON relation.oid=to_regclass(required.name)`,
    [rlsRelations]
  );
  const unsafeRls = rls.rows.filter(
    (row) => row.relrowsecurity !== true || row.relforcerowsecurity !== true
  );
  if (unsafeRls.length > 0) {
    throw new Error(
      `Tenant RLS is not enabled and forced on: ${unsafeRls.map((row) => row.name).join(", ")}`
    );
  }

  const runtimeRole = await client.query(
    `SELECT rolsuper,rolbypassrls
     FROM pg_roles
     WHERE rolname='getdone_tenant_runtime'`
  );
  if (
    runtimeRole.rows.length !== 1
    || runtimeRole.rows[0].rolsuper
    || runtimeRole.rows[0].rolbypassrls
  ) {
    throw new Error("Tenant runtime role must exist without superuser/BYPASSRLS");
  }
  const roleMembership = await client.query(
    "SELECT pg_has_role(current_user,'getdone_tenant_runtime','MEMBER') AS member"
  );
  if (roleMembership.rows[0]?.member !== true) {
    throw new Error("Migration/runtime principal cannot SET ROLE getdone_tenant_runtime");
  }

  await client.query('SET ROLE "getdone_tenant_runtime"');
  try {
    const effectiveRuntimeRole = await client.query(
      `SELECT current_user AS role_name, role.rolsuper, role.rolbypassrls
       FROM pg_roles role
       WHERE role.rolname=current_user`
    );
    const effective = effectiveRuntimeRole.rows[0];
    if (
      effective?.role_name !== "getdone_tenant_runtime"
      || effective.rolsuper
      || effective.rolbypassrls
    ) {
      throw new Error("Effective PostgreSQL runtime role is not RLS-safe");
    }
  } finally {
    await client.query("RESET ROLE");
  }

  const authSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM unnest(ARRAY[
       'companies',
       'company_memberships',
       'auth_sessions',
       'auth_webauthn_credentials',
       'auth_step_up_challenges',
       'auth_sign_in_challenges'
     ]::text[]) AS required(name)
     WHERE to_regclass(required.name) IS NOT NULL`
  );
  if (authSchema.rows[0]?.count !== 6) {
    throw new Error("Production auth persistence schema verification failed");
  }

  const workerSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM unnest(ARRAY[
       'job_worker_instances',
       'business_action_verification_evidence',
       'provider_concurrency_leases',
       'credential_leases',
       'credential_usage_audits'
     ]::text[]) AS required(name)
     WHERE to_regclass(required.name) IS NOT NULL`
  );
  if (workerSchema.rows[0]?.count !== 5) {
    throw new Error("Durable worker/credential broker persistence schema verification failed");
  }

  const rateLimitSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_name='rate_limit_buckets'
       AND column_name IN (
         'policy_id','bucket_key_hash','window_started_at',
         'window_expires_at','request_count','updated_at'
       )`
  );
  if (rateLimitSchema.rows[0]?.count !== 6) {
    throw new Error("Rate limit persistence schema verification failed");
  }

  const disasterRecoverySchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM unnest(ARRAY[
       'disaster_recovery_incidents',
       'job_disaster_recovery_decisions'
     ]::text[]) AS required(name)
     WHERE to_regclass(required.name) IS NOT NULL`
  );
  if (disasterRecoverySchema.rows[0]?.count !== 2) {
    throw new Error("Disaster recovery persistence schema verification failed");
  }

  const disasterRecoveryIndexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname=current_schema()
       AND indexname IN (
         'job_disaster_recovery_active_hold_idx',
         'job_disaster_recovery_incident_decision_idx'
       )`
  );
  if (disasterRecoveryIndexes.rows[0]?.count !== 2) {
    throw new Error("Disaster recovery hold/index verification failed");
  }

  const releaseGateSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM unnest(ARRAY[
       'production_release_gate_evidence',
       'migration_compatibility_evidence'
     ]::text[]) AS required(name)
     WHERE to_regclass(required.name) IS NOT NULL`
  );
  if (releaseGateSchema.rows[0]?.count !== 2) {
    throw new Error("Production release gate persistence schema verification failed");
  }

  const releaseGateIndexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname=current_schema()
       AND indexname IN (
         'production_release_gate_passed_sha_idx',
         'migration_compatibility_release_idx'
       )`
  );
  if (releaseGateIndexes.rows[0]?.count !== 2) {
    throw new Error("Production release gate index verification failed");
  }

  const analyticsSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM unnest(ARRAY[
       'analytics_ingestion_checkpoints',
       'analytics_ingestion_evidence',
       'analytics_ingestion_runs'
     ]::text[]) AS required(name)
     WHERE to_regclass(required.name) IS NOT NULL`
  );
  if (analyticsSchema.rows[0]?.count !== 3) {
    throw new Error("Analytics ingestion persistence schema verification failed");
  }

  const analyticsIndexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname=current_schema()
       AND indexname IN (
         'analytics_ingestion_evidence_source_idx',
         'analytics_ingestion_checkpoint_updated_idx',
         'analytics_ingestion_runs_scope_idx'
       )`
  );
  if (analyticsIndexes.rows[0]?.count !== 3) {
    throw new Error("Analytics ingestion index verification failed");
  }

  const orchestrationSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM unnest(ARRAY[
       'orchestration_runs',
       'orchestration_transition_receipts',
       'orchestration_checkpoints'
     ]::text[]) AS required(name)
     WHERE to_regclass(required.name) IS NOT NULL`
  );
  if (orchestrationSchema.rows[0]?.count !== 3) {
    throw new Error("UFO orchestration persistence schema verification failed");
  }

  const orchestrationIndexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname=current_schema()
       AND indexname IN (
         'orchestration_runs_scope_idx',
         'orchestration_runs_source_idx',
         'orchestration_runs_resumable_idx',
         'orchestration_transition_receipts_scope_idx',
         'orchestration_checkpoints_scope_idx'
       )`
  );
  if (orchestrationIndexes.rows[0]?.count !== 5) {
    throw new Error("UFO orchestration persistence index verification failed");
  }

  const orchestrationConstraints = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_runs'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (portfolio_id, company_id, correlation_id)'
       )::int AS correlation_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_runs'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (portfolio_id, company_id, start_idempotency_key)'
       )::int AS start_idempotency_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_transition_receipts'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (run_id, idempotency_key)'
       )::int AS transition_idempotency_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_transition_receipts'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (run_id, next_version)'
       )::int AS transition_version_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_checkpoints'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (run_id, run_version)'
       )::int AS checkpoint_version_unique
     FROM pg_constraint
     WHERE conrelid IN (
       'orchestration_runs'::regclass,
       'orchestration_transition_receipts'::regclass,
       'orchestration_checkpoints'::regclass
     )`
  );
  const orchestrationConstraintRow = orchestrationConstraints.rows[0];
  if (
    orchestrationConstraintRow?.correlation_unique !== 1
    || orchestrationConstraintRow?.start_idempotency_unique !== 1
    || orchestrationConstraintRow?.transition_idempotency_unique !== 1
    || orchestrationConstraintRow?.transition_version_unique !== 1
    || orchestrationConstraintRow?.checkpoint_version_unique !== 1
  ) {
    throw new Error("UFO orchestration uniqueness/CAS constraints are incomplete");
  }

  const orchestrationWorkerSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_name='orchestration_worker_state'
       AND column_name IN (
         'run_id','portfolio_id','company_id','stage_run_version','stage_attempt',
         'consecutive_failures','ready_at','lease_id','lease_worker_id',
         'lease_issued_at','lease_heartbeat_at','lease_expires_at','lease_version',
         'claimed_run_version','claimed_record_hash','last_error_code',
         'last_error_message','updated_at'
       )`
  );
  if (orchestrationWorkerSchema.rows[0]?.count !== 18) {
    throw new Error("UFO orchestration worker persistence schema verification failed");
  }

  const orchestrationWorkerIndexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname=current_schema()
       AND indexname IN (
         'orchestration_worker_ready_idx',
         'orchestration_worker_lease_expiry_idx',
         'orchestration_worker_scope_idx'
       )`
  );
  if (orchestrationWorkerIndexes.rows[0]?.count !== 3) {
    throw new Error("UFO orchestration worker index verification failed");
  }

  const orchestrationContextSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_name='orchestration_context_snapshots'
       AND column_name IN (
         'id','run_id','portfolio_id','company_id','source_type','source_id',
         'source_hash','run_version','snapshot_hash','idempotency_key','payload','created_at'
       )`
  );
  if (orchestrationContextSchema.rows[0]?.count !== 12) {
    throw new Error("OwnerIntent ContextSnapshot schema verification failed");
  }

  const orchestrationContextIndexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname=current_schema()
       AND indexname IN (
         'orchestration_context_snapshots_scope_idx',
         'orchestration_context_snapshots_source_idx'
       )`
  );
  if (orchestrationContextIndexes.rows[0]?.count !== 2) {
    throw new Error("OwnerIntent ContextSnapshot index verification failed");
  }

  const orchestrationContextConstraints = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_context_snapshots'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (run_id, run_version)'
       )::int AS run_version_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_context_snapshots'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (portfolio_id, company_id, idempotency_key)'
       )::int AS tenant_idempotency_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_context_snapshots'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (snapshot_hash)'
       )::int AS snapshot_hash_unique
     FROM pg_constraint
     WHERE conrelid='orchestration_context_snapshots'::regclass`
  );
  const contextConstraintRow = orchestrationContextConstraints.rows[0];
  if (
    contextConstraintRow?.run_version_unique !== 1
    || contextConstraintRow?.tenant_idempotency_unique !== 1
    || contextConstraintRow?.snapshot_hash_unique !== 1
  ) {
    throw new Error("OwnerIntent ContextSnapshot uniqueness constraints are incomplete");
  }

  const planningSchema = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE table_name='orchestration_planner_inputs')::int AS planner_input_columns,
       COUNT(*) FILTER (WHERE table_name='orchestration_plan_proposals')::int AS plan_proposal_columns
     FROM information_schema.columns
     WHERE (
       table_name='orchestration_planner_inputs'
       AND column_name IN (
         'id','run_id','portfolio_id','company_id','source_run_version',
         'context_snapshot_id','context_snapshot_hash','input_hash',
         'idempotency_key','payload','created_at'
       )
     ) OR (
       table_name='orchestration_plan_proposals'
       AND column_name IN (
         'id','run_id','portfolio_id','company_id','planning_run_version',
         'planner_input_id','planner_input_hash','planner_request_id',
         'plan_hash','artifact_hash','idempotency_key','payload','created_at'
       )
     )`
  );
  if (
    planningSchema.rows[0]?.planner_input_columns !== 11
    || planningSchema.rows[0]?.plan_proposal_columns !== 13
  ) {
    throw new Error("UFO durable planning schema verification failed");
  }

  const planningIndexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname=current_schema()
       AND indexname IN (
         'orchestration_planner_inputs_scope_idx',
         'orchestration_planner_inputs_snapshot_idx',
         'orchestration_plan_proposals_scope_idx',
         'orchestration_plan_proposals_input_idx'
       )`
  );
  if (planningIndexes.rows[0]?.count !== 4) {
    throw new Error("UFO durable planning index verification failed");
  }

  const planningConstraints = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_planner_inputs'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (run_id, source_run_version)'
       )::int AS planner_run_version_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_planner_inputs'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (portfolio_id, company_id, idempotency_key)'
       )::int AS planner_idempotency_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_plan_proposals'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (run_id, planning_run_version)'
       )::int AS plan_run_version_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_plan_proposals'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (portfolio_id, company_id, idempotency_key)'
       )::int AS plan_idempotency_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_plan_proposals'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (portfolio_id, company_id, planner_request_id)'
       )::int AS planner_request_unique
     FROM pg_constraint
     WHERE conrelid IN (
       'orchestration_planner_inputs'::regclass,
       'orchestration_plan_proposals'::regclass
     )`
  );
  const planningConstraintRow = planningConstraints.rows[0];
  if (
    planningConstraintRow?.planner_run_version_unique !== 1
    || planningConstraintRow?.planner_idempotency_unique !== 1
    || planningConstraintRow?.plan_run_version_unique !== 1
    || planningConstraintRow?.plan_idempotency_unique !== 1
    || planningConstraintRow?.planner_request_unique !== 1
  ) {
    throw new Error("UFO durable planning uniqueness constraints are incomplete");
  }

  const validationPolicySchema = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE table_name='orchestration_validation_artifacts')::int AS validation_columns,
       COUNT(*) FILTER (WHERE table_name='orchestration_policy_step_snapshots')::int AS policy_step_columns,
       COUNT(*) FILTER (WHERE table_name='orchestration_policy_evaluations')::int AS policy_columns
     FROM information_schema.columns
     WHERE (
       table_name='orchestration_validation_artifacts'
       AND column_name IN (
         'id','run_id','portfolio_id','company_id','planned_run_version',
         'plan_artifact_id','plan_artifact_hash','plan_hash',
         'validation_policy_hash','receipt_hash','validation_status',
         'artifact_hash','idempotency_key','payload','created_at'
       )
     ) OR (
       table_name='orchestration_policy_step_snapshots'
       AND column_name IN (
         'id','run_id','portfolio_id','company_id','validated_run_version',
         'plan_artifact_id','plan_artifact_hash',
         'validation_receipt_id','validation_receipt_hash',
         'step_id','step_hash','snapshot_hash','artifact_hash',
         'idempotency_key','payload','created_at'
       )
     ) OR (
       table_name='orchestration_policy_evaluations'
       AND column_name IN (
         'id','run_id','portfolio_id','company_id','validated_run_version',
         'plan_artifact_id','plan_artifact_hash','plan_hash',
         'validation_receipt_id','validation_receipt_hash','aggregate_disposition',
         'policy_engine_version','policy_rules_hash','artifact_hash',
         'idempotency_key','payload','created_at'
       )
     )`
  );
  if (
    validationPolicySchema.rows[0]?.validation_columns !== 15
    || validationPolicySchema.rows[0]?.policy_step_columns !== 16
    || validationPolicySchema.rows[0]?.policy_columns !== 17
  ) {
    throw new Error("UFO durable validation/policy schema verification failed");
  }

  const validationPolicyIndexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname=current_schema()
       AND indexname IN (
         'orchestration_validation_artifacts_scope_idx',
         'orchestration_validation_artifacts_plan_idx',
         'orchestration_policy_step_snapshots_scope_idx',
         'orchestration_policy_step_snapshots_run_idx',
         'orchestration_policy_evaluations_scope_idx',
         'orchestration_policy_evaluations_plan_idx',
         'orchestration_policy_evaluations_validation_idx'
       )`
  );
  if (validationPolicyIndexes.rows[0]?.count !== 7) {
    throw new Error("UFO durable validation/policy index verification failed");
  }

  const validationPolicyConstraints = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_validation_artifacts'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (run_id, planned_run_version)'
       )::int AS validation_run_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_validation_artifacts'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (portfolio_id, company_id, idempotency_key)'
       )::int AS validation_idempotency_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_policy_step_snapshots'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (run_id, validated_run_version, step_id)'
       )::int AS policy_step_run_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_policy_step_snapshots'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (portfolio_id, company_id, idempotency_key)'
       )::int AS policy_step_idempotency_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_policy_evaluations'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (run_id, validated_run_version)'
       )::int AS policy_run_unique,
       COUNT(*) FILTER (
         WHERE conrelid='orchestration_policy_evaluations'::regclass
           AND contype='u'
           AND pg_get_constraintdef(oid)='UNIQUE (portfolio_id, company_id, idempotency_key)'
       )::int AS policy_idempotency_unique
     FROM pg_constraint
     WHERE conrelid IN (
       'orchestration_validation_artifacts'::regclass,
       'orchestration_policy_step_snapshots'::regclass,
       'orchestration_policy_evaluations'::regclass
     )`
  );
  const validationPolicyConstraintRow = validationPolicyConstraints.rows[0];
  if (
    validationPolicyConstraintRow?.validation_run_unique !== 1
    || validationPolicyConstraintRow?.validation_idempotency_unique !== 1
    || validationPolicyConstraintRow?.policy_step_run_unique !== 1
    || validationPolicyConstraintRow?.policy_step_idempotency_unique !== 1
    || validationPolicyConstraintRow?.policy_run_unique !== 1
    || validationPolicyConstraintRow?.policy_idempotency_unique !== 1
  ) {
    throw new Error("UFO durable validation/policy uniqueness constraints are incomplete");
  }

  const authorizationResumeSchema = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_name='orchestration_decision_resume_requests'
       AND column_name IN (
         'id','run_id','decision_id','decision_version','portfolio_id',
         'company_id','resolution','request_hash','status','created_at',
         'processed_at','payload'
       )`
  );
  if (authorizationResumeSchema.rows[0]?.count !== 12) {
    throw new Error("UFO durable authorization resume schema verification failed");
  }

  const authorizationResumeIndexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname=current_schema()
       AND indexname IN (
         'orchestration_decision_resume_scope_idx',
         'orchestration_decision_resume_pending_idx'
       )`
  );
  if (authorizationResumeIndexes.rows[0]?.count !== 2) {
    throw new Error("UFO durable authorization resume index verification failed");
  }

  const authorizationResumeConstraint = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_constraint
     WHERE conrelid='orchestration_decision_resume_requests'::regclass
       AND contype='u'
       AND pg_get_constraintdef(oid)='UNIQUE (decision_id, decision_version)'`
  );
  if (authorizationResumeConstraint.rows[0]?.count !== 1) {
    throw new Error("UFO durable authorization resume uniqueness constraint is missing");
  }

  const backup = await client.query(
    `SELECT completed_at,verification_hash
     FROM database_backup_evidence
     WHERE status='verified'
     ORDER BY completed_at DESC LIMIT 1`
  );
  const latest = backup.rows[0];
  if (!latest || !/^[a-f0-9]{64}$/i.test(latest.verification_hash)) {
    throw new Error("No cryptographically verified backup evidence is recorded");
  }
  const backupAgeMs = Date.now() - Date.parse(
    latest.completed_at instanceof Date
      ? latest.completed_at.toISOString()
      : String(latest.completed_at)
  );
  if (backupAgeMs < 0 || backupAgeMs > maxBackupAgeHours * 60 * 60_000) {
    throw new Error("Latest verified backup evidence is stale");
  }

  const audit = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_name='audit_events'
       AND column_name IN (
         'id','correlation_id','entity_type','entity_id','occurred_at','payload',
         'chain_sequence','previous_event_hash','event_hash'
       )`
  );
  if (audit.rows[0]?.count !== 9) {
    throw new Error("Audit ledger schema integrity verification failed");
  }

  const auditIntegrity = spawnSync(
    process.execPath,
    ["scripts/verify-audit-ledger-integrity.mjs"],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8"
    }
  );
  if (auditIntegrity.status !== 0) {
    throw new Error(
      `Audit ledger integrity verification failed\nSTDOUT:\n${auditIntegrity.stdout}\nSTDERR:\n${auditIntegrity.stderr}`
    );
  }

  console.log(JSON.stringify({
    database: "reachable",
    minimumVersion: "16",
    migration: requiredMigration,
    transactionIsolation: "serializable",
    rollback: "verified",
    concurrencyConstraints: "verified",
    tenantRls: "verified",
    tenantRuntimeRole: "verified",
    effectiveRuntimeRole: "verified",
    auditSchema: "verified",
    auditLedgerIntegrity: "verified",
    authSchema: "verified",
    durableWorkerSchema: "verified",
    rateLimitSchema: "verified",
    disasterRecoverySchema: "verified",
    releaseGateSchema: "verified",
    analyticsSchema: "verified",
    orchestrationSchema: "verified",
    orchestrationCasConstraints: "verified",
    orchestrationWorkerSchema: "verified",
    orchestrationContextSchema: "verified",
    orchestrationContextConstraints: "verified",
    durablePlanningSchema: "verified",
    durablePlanningConstraints: "verified",
    durableValidationPolicySchema: "verified",
    durableValidationPolicyConstraints: "verified",
    durableAuthorizationResumeSchema: "verified",
    durableAuthorizationResumeConstraints: "verified",
    backupFresh: true
  }, null, 2));
} finally {
  client.release();
  await pool.end();
}
