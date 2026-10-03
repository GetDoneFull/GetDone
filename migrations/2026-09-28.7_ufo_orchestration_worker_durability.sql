BEGIN;

CREATE TABLE IF NOT EXISTS orchestration_worker_instances (
  worker_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('starting','running','draining','stopped','failed')),
  process_version text NOT NULL,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  ready_at timestamptz,
  stopped_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS orchestration_worker_instances_status_idx
  ON orchestration_worker_instances (status, heartbeat_at, worker_id);

-- orchestration_worker_state is the cross-tenant dispatch queue, not authoritative
-- business state. Keep only bounded routing/lease metadata globally discoverable.
-- Authoritative orchestration/artifact reads still require exact tenant scope.
ALTER TABLE orchestration_worker_state NO FORCE ROW LEVEL SECURITY;
ALTER TABLE orchestration_worker_state DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_worker_state;

ALTER TABLE orchestration_worker_state
  ADD COLUMN IF NOT EXISTS run_state text NOT NULL DEFAULT 'accepted'
  CHECK (run_state IN (
    'accepted','context-ready','planning','planned','validated','policy-evaluated',
    'awaiting-decision','authorized','tasks-created','jobs-enqueued','executing',
    'verifying','completed','blocked','failed','cancelled'
  ));

UPDATE orchestration_worker_state worker
SET run_state=run.state
FROM orchestration_runs run
WHERE run.id=worker.run_id
  AND worker.run_state IS DISTINCT FROM run.state;

CREATE INDEX IF NOT EXISTS orchestration_worker_dispatch_ready_idx
  ON orchestration_worker_state (ready_at, run_id)
  WHERE lease_id IS NULL
    AND run_state IN (
      'accepted','context-ready','planning','planned','validated','policy-evaluated',
      'authorized','tasks-created','jobs-enqueued','executing','verifying'
    );

CREATE TABLE IF NOT EXISTS orchestration_worker_dead_letters (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES orchestration_runs(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  lease_id text NOT NULL,
  worker_id text NOT NULL,
  claimed_run_version integer NOT NULL CHECK (claimed_run_version >= 1),
  claimed_record_hash text NOT NULL CHECK (claimed_record_hash ~ '^[a-f0-9]{64}$'),
  terminal_run_version integer NOT NULL CHECK (terminal_run_version >= 1),
  terminal_record_hash text NOT NULL CHECK (terminal_record_hash ~ '^[a-f0-9]{64}$'),
  attempt integer NOT NULL CHECK (attempt >= 1),
  failure_code text NOT NULL,
  failure_message_hash text NOT NULL CHECK (failure_message_hash ~ '^[a-f0-9]{64}$'),
  dead_lettered_at timestamptz NOT NULL,
  recovery_kind text NOT NULL CHECK (recovery_kind IN ('explicit-failure','expired-lease-recovery')),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  UNIQUE (run_id, lease_id)
);

CREATE INDEX IF NOT EXISTS orchestration_worker_dead_letters_scope_idx
  ON orchestration_worker_dead_letters (portfolio_id, company_id, dead_lettered_at, run_id);

CREATE INDEX IF NOT EXISTS orchestration_worker_dead_letters_run_idx
  ON orchestration_worker_dead_letters (run_id, dead_lettered_at);

GRANT SELECT,INSERT,UPDATE ON orchestration_worker_instances TO getdone_tenant_runtime;
REVOKE DELETE ON orchestration_worker_instances FROM getdone_tenant_runtime;

GRANT SELECT,INSERT ON orchestration_worker_dead_letters TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON orchestration_worker_dead_letters FROM getdone_tenant_runtime;

ALTER TABLE orchestration_worker_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration_worker_dead_letters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON orchestration_worker_dead_letters;
CREATE POLICY getdone_tenant_isolation ON orchestration_worker_dead_letters
  USING (getdone_tenant_scope_matches(portfolio_id, company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id, company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.7')
ON CONFLICT (version) DO NOTHING;

COMMIT;
