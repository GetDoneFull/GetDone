BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_planner_inputs (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  source_run_version integer NOT NULL CHECK (source_run_version >= 1),
  context_snapshot_id text NOT NULL REFERENCES orchestration_context_snapshots(id),
  context_snapshot_hash text NOT NULL CHECK (context_snapshot_hash ~ '^[a-f0-9]{64}$'),
  input_hash text NOT NULL UNIQUE CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, source_run_version),
  UNIQUE (portfolio_id, company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS orchestration_planner_inputs_scope_idx
  ON orchestration_planner_inputs (portfolio_id, company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_planner_inputs_snapshot_idx
  ON orchestration_planner_inputs (context_snapshot_id, run_id);

CREATE TABLE IF NOT EXISTS orchestration_plan_proposals (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  planning_run_version integer NOT NULL CHECK (planning_run_version >= 1),
  planner_input_id text NOT NULL REFERENCES orchestration_planner_inputs(id),
  planner_input_hash text NOT NULL CHECK (planner_input_hash ~ '^[a-f0-9]{64}$'),
  planner_request_id text NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  artifact_hash text NOT NULL UNIQUE CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, planning_run_version),
  UNIQUE (portfolio_id, company_id, idempotency_key),
  UNIQUE (portfolio_id, company_id, planner_request_id)
);

CREATE INDEX IF NOT EXISTS orchestration_plan_proposals_scope_idx
  ON orchestration_plan_proposals (portfolio_id, company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_plan_proposals_input_idx
  ON orchestration_plan_proposals (planner_input_id, run_id);

GRANT SELECT,INSERT ON orchestration_planner_inputs TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_planner_inputs FROM getdone_tenant_runtime;

GRANT SELECT,INSERT ON orchestration_plan_proposals TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_plan_proposals FROM getdone_tenant_runtime;

ALTER TABLE orchestration_planner_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_planner_inputs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_planner_inputs;
CREATE POLICY getdone_tenant_isolation ON orchestration_planner_inputs
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

ALTER TABLE orchestration_plan_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_plan_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_plan_proposals;
CREATE POLICY getdone_tenant_isolation ON orchestration_plan_proposals
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.4')
ON CONFLICT (version) DO NOTHING;

COMMIT;
