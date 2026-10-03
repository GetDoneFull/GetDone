BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_validation_artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  planned_run_version integer NOT NULL CHECK (planned_run_version >= 1),
  plan_artifact_id text NOT NULL REFERENCES orchestration_plan_proposals(id),
  plan_artifact_hash text NOT NULL CHECK (plan_artifact_hash ~ '^[a-f0-9]{64}$'),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  validation_policy_hash text NOT NULL CHECK (validation_policy_hash ~ '^[a-f0-9]{64}$'),
  receipt_hash text NOT NULL UNIQUE CHECK (receipt_hash ~ '^[a-f0-9]{64}$'),
  validation_status text NOT NULL CHECK (
    validation_status IN ('valid','invalid','owner-decision-required')
  ),
  artifact_hash text NOT NULL UNIQUE CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, planned_run_version),
  UNIQUE (portfolio_id, company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS orchestration_validation_artifacts_scope_idx
  ON orchestration_validation_artifacts (portfolio_id, company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_validation_artifacts_plan_idx
  ON orchestration_validation_artifacts (plan_artifact_id, run_id);

CREATE TABLE IF NOT EXISTS orchestration_policy_step_snapshots (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  validated_run_version integer NOT NULL CHECK (validated_run_version >= 1),
  plan_artifact_id text NOT NULL REFERENCES orchestration_plan_proposals(id),
  plan_artifact_hash text NOT NULL CHECK (plan_artifact_hash ~ '^[a-f0-9]{64}$'),
  validation_receipt_id text NOT NULL REFERENCES orchestration_validation_artifacts(id),
  validation_receipt_hash text NOT NULL CHECK (validation_receipt_hash ~ '^[a-f0-9]{64}$'),
  step_id text NOT NULL,
  step_hash text NOT NULL CHECK (step_hash ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL UNIQUE CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  artifact_hash text NOT NULL UNIQUE CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, validated_run_version, step_id),
  UNIQUE (portfolio_id, company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS orchestration_policy_step_snapshots_scope_idx
  ON orchestration_policy_step_snapshots (portfolio_id, company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_policy_step_snapshots_run_idx
  ON orchestration_policy_step_snapshots (run_id, validated_run_version, step_id);

CREATE TABLE IF NOT EXISTS orchestration_policy_evaluations (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  validated_run_version integer NOT NULL CHECK (validated_run_version >= 1),
  plan_artifact_id text NOT NULL REFERENCES orchestration_plan_proposals(id),
  plan_artifact_hash text NOT NULL CHECK (plan_artifact_hash ~ '^[a-f0-9]{64}$'),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  validation_receipt_id text NOT NULL REFERENCES orchestration_validation_artifacts(id),
  validation_receipt_hash text NOT NULL CHECK (validation_receipt_hash ~ '^[a-f0-9]{64}$'),
  aggregate_disposition text NOT NULL CHECK (
    aggregate_disposition IN ('AUTO','APPROVAL_REQUIRED','STRONG_APPROVAL','BLOCKED')
  ),
  policy_engine_version text NOT NULL,
  policy_rules_hash text NOT NULL CHECK (policy_rules_hash ~ '^[a-f0-9]{64}$'),
  artifact_hash text NOT NULL UNIQUE CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, validated_run_version),
  UNIQUE (portfolio_id, company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS orchestration_policy_evaluations_scope_idx
  ON orchestration_policy_evaluations (portfolio_id, company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_policy_evaluations_plan_idx
  ON orchestration_policy_evaluations (plan_artifact_id, run_id);

CREATE INDEX IF NOT EXISTS orchestration_policy_evaluations_validation_idx
  ON orchestration_policy_evaluations (validation_receipt_id, run_id);

GRANT SELECT,INSERT ON orchestration_validation_artifacts TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_validation_artifacts FROM getdone_tenant_runtime;

GRANT SELECT,INSERT ON orchestration_policy_step_snapshots TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_policy_step_snapshots FROM getdone_tenant_runtime;

GRANT SELECT,INSERT ON orchestration_policy_evaluations TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_policy_evaluations FROM getdone_tenant_runtime;

ALTER TABLE orchestration_validation_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_validation_artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_validation_artifacts;
CREATE POLICY getdone_tenant_isolation ON orchestration_validation_artifacts
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

ALTER TABLE orchestration_policy_step_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_policy_step_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_policy_step_snapshots;
CREATE POLICY getdone_tenant_isolation ON orchestration_policy_step_snapshots
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

ALTER TABLE orchestration_policy_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_policy_evaluations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_policy_evaluations;
CREATE POLICY getdone_tenant_isolation ON orchestration_policy_evaluations
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.5')
ON CONFLICT (version) DO NOTHING;

COMMIT;
