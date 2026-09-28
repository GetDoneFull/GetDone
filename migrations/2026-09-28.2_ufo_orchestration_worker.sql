BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_worker_state (
  run_id text PRIMARY KEY REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  stage_run_version integer NOT NULL CHECK (stage_run_version >= 1),
  stage_attempt integer NOT NULL DEFAULT 0 CHECK (stage_attempt >= 0),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ready_at timestamptz NOT NULL,
  lease_id text UNIQUE,
  lease_worker_id text,
  lease_issued_at timestamptz,
  lease_heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  lease_version integer NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  claimed_run_version integer,
  claimed_record_hash text,
  last_error_code text,
  last_error_message text,
  updated_at timestamptz NOT NULL,
  CHECK (
    (
      lease_id IS NULL
      AND lease_worker_id IS NULL
      AND lease_issued_at IS NULL
      AND lease_heartbeat_at IS NULL
      AND lease_expires_at IS NULL
      AND claimed_run_version IS NULL
      AND claimed_record_hash IS NULL
    )
    OR
    (
      lease_id IS NOT NULL
      AND lease_worker_id IS NOT NULL
      AND lease_issued_at IS NOT NULL
      AND lease_heartbeat_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND claimed_run_version IS NOT NULL
      AND claimed_record_hash ~ '^[a-f0-9]{64}$'
      AND lease_expires_at > lease_issued_at
      AND lease_heartbeat_at >= lease_issued_at
    )
  )
);

INSERT INTO orchestration_worker_state(
  run_id,
  portfolio_id,
  company_id,
  stage_run_version,
  stage_attempt,
  consecutive_failures,
  ready_at,
  lease_version,
  updated_at
)
SELECT
  run.id,
  run.portfolio_id,
  run.company_id,
  run.version,
  0,
  0,
  run.updated_at,
  0,
  run.updated_at
FROM orchestration_runs run
ON CONFLICT (run_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS orchestration_worker_ready_idx
  ON orchestration_worker_state (ready_at, run_id)
  WHERE lease_id IS NULL;

CREATE INDEX IF NOT EXISTS orchestration_worker_lease_expiry_idx
  ON orchestration_worker_state (lease_expires_at, run_id)
  WHERE lease_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS orchestration_worker_scope_idx
  ON orchestration_worker_state (portfolio_id, company_id, ready_at, run_id);

GRANT SELECT,INSERT,UPDATE ON orchestration_worker_state TO getdone_tenant_runtime;
REVOKE DELETE ON orchestration_worker_state FROM getdone_tenant_runtime;

ALTER TABLE orchestration_worker_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_worker_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_worker_state;
CREATE POLICY getdone_tenant_isolation ON orchestration_worker_state
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.2')
ON CONFLICT (version) DO NOTHING;

COMMIT;
