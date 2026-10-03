BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_context_snapshots (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  source_type text NOT NULL CHECK (
    source_type IN ('owner-intent','signal','investigation','objective')
  ),
  source_id text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  run_version integer NOT NULL CHECK (run_version >= 1),
  snapshot_hash text NOT NULL UNIQUE CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, run_version),
  UNIQUE (portfolio_id, company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS orchestration_context_snapshots_scope_idx
  ON orchestration_context_snapshots (portfolio_id, company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_context_snapshots_source_idx
  ON orchestration_context_snapshots (portfolio_id, company_id, source_type, source_id);

GRANT SELECT,INSERT ON orchestration_context_snapshots TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_context_snapshots FROM getdone_tenant_runtime;

ALTER TABLE orchestration_context_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_context_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_context_snapshots;
CREATE POLICY getdone_tenant_isolation ON orchestration_context_snapshots
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.3')
ON CONFLICT (version) DO NOTHING;

COMMIT;
