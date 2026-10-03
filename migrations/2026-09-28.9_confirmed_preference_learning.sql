BEGIN;

CREATE TABLE IF NOT EXISTS preference_decision_observations (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  decision_id text NOT NULL,
  capability text NOT NULL,
  pattern_hash text NOT NULL CHECK (pattern_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (portfolio_id,company_id,decision_id,capability)
);

CREATE TABLE IF NOT EXISTS learned_rule_suggestions (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  capability text NOT NULL,
  pattern_hash text NOT NULL CHECK (pattern_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('suggested','confirmed','keep-asking','never-suggest')),
  times_observed integer NOT NULL CHECK (times_observed >= 2),
  created_at timestamptz NOT NULL,
  resolved_by text,
  resolved_at timestamptz,
  resolution_payload jsonb,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS confirmed_preference_rules (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  capability text NOT NULL,
  pattern_hash text NOT NULL CHECK (pattern_hash ~ '^[a-f0-9]{64}$'),
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  revoked_at timestamptz,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS preference_observations_pattern_idx
  ON preference_decision_observations(portfolio_id,company_id,pattern_hash,observed_at,id);
CREATE INDEX IF NOT EXISTS learned_rule_suggestions_pending_idx
  ON learned_rule_suggestions(portfolio_id,company_id,status,created_at,id);
CREATE INDEX IF NOT EXISTS confirmed_preference_rules_active_idx
  ON confirmed_preference_rules(portfolio_id,company_id,capability,confirmed_at DESC,id)
  WHERE revoked_at IS NULL;

GRANT SELECT,INSERT ON preference_decision_observations TO getdone_tenant_runtime;
GRANT SELECT,INSERT,UPDATE(times_observed,payload,status,resolved_by,resolved_at,resolution_payload)
  ON learned_rule_suggestions TO getdone_tenant_runtime;
GRANT SELECT,INSERT,UPDATE(revoked_at,payload)
  ON confirmed_preference_rules TO getdone_tenant_runtime;

ALTER TABLE preference_decision_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE preference_decision_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE learned_rule_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learned_rule_suggestions FORCE ROW LEVEL SECURITY;
ALTER TABLE confirmed_preference_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmed_preference_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS getdone_tenant_isolation ON preference_decision_observations;
CREATE POLICY getdone_tenant_isolation ON preference_decision_observations
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

DROP POLICY IF EXISTS getdone_tenant_isolation ON learned_rule_suggestions;
CREATE POLICY getdone_tenant_isolation ON learned_rule_suggestions
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

DROP POLICY IF EXISTS getdone_tenant_isolation ON confirmed_preference_rules;
CREATE POLICY getdone_tenant_isolation ON confirmed_preference_rules
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-28.9')
ON CONFLICT (version) DO NOTHING;

COMMIT;
