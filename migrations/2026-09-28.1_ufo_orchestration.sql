BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_runs (
  id text PRIMARY KEY,
  correlation_id text NOT NULL,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  user_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  source_type text NOT NULL CHECK (
    source_type IN ('owner-intent','signal','investigation','objective')
  ),
  source_id text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (
    state IN (
      'accepted',
      'context-ready',
      'planning',
      'planned',
      'validated',
      'policy-evaluated',
      'awaiting-decision',
      'authorized',
      'tasks-created',
      'jobs-enqueued',
      'executing',
      'verifying',
      'completed',
      'blocked',
      'failed',
      'cancelled'
    )
  ),
  authority text NOT NULL CHECK (authority = 'coordination-only'),
  version integer NOT NULL CHECK (version >= 1),
  attempt integer NOT NULL CHECK (attempt >= 1),
  start_idempotency_key text NOT NULL,
  record_hash text NOT NULL CHECK (record_hash ~ '^[a-f0-9]{64}$'),
  checkpoints jsonb NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at >= created_at),
  UNIQUE (portfolio_id, company_id, correlation_id),
  UNIQUE (portfolio_id, company_id, start_idempotency_key)
);

CREATE INDEX IF NOT EXISTS orchestration_runs_scope_idx
  ON orchestration_runs (portfolio_id, company_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_runs_source_idx
  ON orchestration_runs (portfolio_id, company_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS orchestration_runs_resumable_idx
  ON orchestration_runs (updated_at, id)
  WHERE state IN (
    'accepted',
    'context-ready',
    'planning',
    'planned',
    'validated',
    'policy-evaluated',
    'authorized',
    'tasks-created',
    'jobs-enqueued',
    'executing',
    'verifying'
  );

CREATE TABLE IF NOT EXISTS orchestration_transition_receipts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  idempotency_key text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 1),
  next_version integer NOT NULL CHECK (next_version = expected_version + 1),
  expected_record_hash text NOT NULL CHECK (expected_record_hash ~ '^[a-f0-9]{64}$'),
  next_record_hash text NOT NULL CHECK (next_record_hash ~ '^[a-f0-9]{64}$'),
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (run_id, idempotency_key),
  UNIQUE (run_id, next_version)
);

CREATE INDEX IF NOT EXISTS orchestration_transition_receipts_scope_idx
  ON orchestration_transition_receipts (portfolio_id, company_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS orchestration_checkpoints (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  run_version integer NOT NULL CHECK (run_version >= 1),
  state text NOT NULL,
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, run_version)
);

CREATE INDEX IF NOT EXISTS orchestration_checkpoints_scope_idx
  ON orchestration_checkpoints (portfolio_id, company_id, run_id, run_version);

GRANT SELECT,INSERT,UPDATE ON orchestration_runs TO getdone_tenant_runtime;
REVOKE DELETE ON orchestration_runs FROM getdone_tenant_runtime;

GRANT SELECT,INSERT ON orchestration_transition_receipts TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_transition_receipts FROM getdone_tenant_runtime;

GRANT SELECT,INSERT ON orchestration_checkpoints TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_checkpoints FROM getdone_tenant_runtime;

ALTER TABLE orchestration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_runs;
CREATE POLICY getdone_tenant_isolation ON orchestration_runs
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

ALTER TABLE orchestration_transition_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_transition_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_transition_receipts;
CREATE POLICY getdone_tenant_isolation ON orchestration_transition_receipts
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

ALTER TABLE orchestration_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_checkpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_checkpoints;
CREATE POLICY getdone_tenant_isolation ON orchestration_checkpoints
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
