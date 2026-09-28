BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_decision_resume_requests (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  decision_id text NOT NULL,
  decision_version integer NOT NULL CHECK (decision_version >= 2),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  resolution text NOT NULL CHECK (
    resolution IN ('approved','modified','rejected')
  ),
  request_hash text NOT NULL UNIQUE CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','processed')
  ),
  created_at timestamptz NOT NULL,
  processed_at timestamptz,
  payload jsonb NOT NULL,
  UNIQUE (decision_id, decision_version)
);

CREATE INDEX IF NOT EXISTS orchestration_decision_resume_scope_idx
  ON orchestration_decision_resume_requests
  (portfolio_id, company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orchestration_decision_resume_pending_idx
  ON orchestration_decision_resume_requests
  (status, created_at, id)
  WHERE status='pending';

GRANT SELECT,INSERT ON orchestration_decision_resume_requests
  TO getdone_tenant_runtime;
GRANT UPDATE(status,processed_at) ON orchestration_decision_resume_requests
  TO getdone_tenant_runtime;

ALTER TABLE orchestration_decision_resume_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_decision_resume_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation
  ON orchestration_decision_resume_requests;
CREATE POLICY getdone_tenant_isolation
  ON orchestration_decision_resume_requests
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.6')
ON CONFLICT (version) DO NOTHING;

COMMIT;
