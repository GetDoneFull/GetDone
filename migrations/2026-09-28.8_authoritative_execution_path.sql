BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_task_materializations (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  logical_key text NOT NULL,
  plan_step_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  grant_id text NOT NULL,
  authorization_consumption_hash text NOT NULL CHECK (authorization_consumption_hash ~ '^[a-f0-9]{64}$'),
  task_hash text NOT NULL CHECK (task_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, logical_key),
  UNIQUE (run_id, plan_step_id)
);

CREATE TABLE IF NOT EXISTS orchestration_task_dags (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  validation_receipt_hash text NOT NULL CHECK (validation_receipt_hash ~ '^[a-f0-9]{64}$'),
  artifact_hash text NOT NULL UNIQUE CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_job_graphs (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  task_dag_id text NOT NULL REFERENCES orchestration_task_dags(id),
  task_dag_hash text NOT NULL CHECK (task_dag_hash ~ '^[a-f0-9]{64}$'),
  artifact_hash text NOT NULL UNIQUE CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_job_nodes (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  node_id text NOT NULL,
  task_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  capability text NOT NULL,
  state text NOT NULL CHECK (
    state IN ('created','enqueued','provider-succeeded','verified','failed','cancelled')
  ),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  verification_request_id text,
  verification_receipt_id text,
  verification_receipt_hash text CHECK (
    verification_receipt_hash IS NULL OR verification_receipt_hash ~ '^[a-f0-9]{64}$'
  ),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (run_id, node_id)
);

CREATE TABLE IF NOT EXISTS orchestration_objective_evaluations (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('met','not-met','uncertain')),
  evaluation_hash text NOT NULL UNIQUE CHECK (evaluation_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  evaluated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_outcomes (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  objective_evaluation_id text NOT NULL REFERENCES orchestration_objective_evaluations(id),
  verification_receipt_id text NOT NULL,
  verification_receipt_hash text NOT NULL CHECK (verification_receipt_hash ~ '^[a-f0-9]{64}$'),
  outcome_hash text NOT NULL UNIQUE CHECK (outcome_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS orchestration_task_materializations_scope_idx
  ON orchestration_task_materializations(portfolio_id,company_id,created_at DESC);
CREATE INDEX IF NOT EXISTS orchestration_task_materializations_run_idx
  ON orchestration_task_materializations(run_id,plan_step_id);
CREATE INDEX IF NOT EXISTS orchestration_task_dags_scope_idx
  ON orchestration_task_dags(portfolio_id,company_id,created_at DESC);
CREATE INDEX IF NOT EXISTS orchestration_job_graphs_scope_idx
  ON orchestration_job_graphs(portfolio_id,company_id,created_at DESC);
CREATE INDEX IF NOT EXISTS orchestration_job_nodes_ready_idx
  ON orchestration_job_nodes(run_id,state,updated_at,id);
CREATE INDEX IF NOT EXISTS orchestration_job_nodes_scope_idx
  ON orchestration_job_nodes(portfolio_id,company_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS orchestration_objective_evaluations_scope_idx
  ON orchestration_objective_evaluations(portfolio_id,company_id,evaluated_at DESC);
CREATE INDEX IF NOT EXISTS orchestration_outcomes_scope_idx
  ON orchestration_outcomes(portfolio_id,company_id,recorded_at DESC);

GRANT SELECT,INSERT ON orchestration_task_materializations TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON orchestration_task_dags TO getdone_tenant_runtime;
GRANT SELECT,INSERT,UPDATE(payload,artifact_hash) ON orchestration_job_graphs TO getdone_tenant_runtime;
GRANT SELECT,INSERT,UPDATE(state,verification_request_id,verification_receipt_id,verification_receipt_hash,payload,updated_at)
  ON orchestration_job_nodes TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON orchestration_objective_evaluations TO getdone_tenant_runtime;
GRANT SELECT,INSERT ON orchestration_outcomes TO getdone_tenant_runtime;

ALTER TABLE orchestration_task_materializations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_task_materializations FORCE ROW LEVEL SECURITY;
ALTER TABLE orchestration_task_dags ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_task_dags FORCE ROW LEVEL SECURITY;
ALTER TABLE orchestration_job_graphs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_job_graphs FORCE ROW LEVEL SECURITY;
ALTER TABLE orchestration_job_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_job_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE orchestration_objective_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_objective_evaluations FORCE ROW LEVEL SECURITY;
ALTER TABLE orchestration_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_outcomes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_task_materializations;
CREATE POLICY getdone_tenant_isolation ON orchestration_task_materializations
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_task_dags;
CREATE POLICY getdone_tenant_isolation ON orchestration_task_dags
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_job_graphs;
CREATE POLICY getdone_tenant_isolation ON orchestration_job_graphs
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_job_nodes;
CREATE POLICY getdone_tenant_isolation ON orchestration_job_nodes
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_objective_evaluations;
CREATE POLICY getdone_tenant_isolation ON orchestration_objective_evaluations
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_outcomes;
CREATE POLICY getdone_tenant_isolation ON orchestration_outcomes
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.8')
ON CONFLICT (version) DO NOTHING;

COMMIT;
