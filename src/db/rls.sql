-- The application connects as tc_app: no superuser, no BYPASSRLS, owns nothing.
-- This matters more than the policies themselves - PostgreSQL ignores row-level
-- security for superusers and table owners, so connecting as the owner would
-- make the isolation below look enforced while doing nothing at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tc_app') THEN
    CREATE ROLE tc_app LOGIN PASSWORD 'tc_app_local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO tc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tc_app;

-- Tenant isolation, enforced by PostgreSQL rather than by application code.
--
-- Every tenant-scoped table gets the same policy: a row is visible only when its
-- tenant_id matches app.tenant_id (set by withTenant), or when app.bypass_rls is
-- explicitly 'on' (platform console, workers, migrations).
--
-- FORCE is used so the table owner is subject to the policy too; without it, the
-- app's own role would quietly bypass everything and the guarantee would be
-- theatre.
--
-- Idempotent: safe to run on every migration.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'tenant_settings', 'tenant_channels', 'users',
    'employees', 'employee_history', 'shifts', 'calendars', 'calendar_days', 'leave_balances',
    'mapping_profiles', 'code_mappings', 'unmapped_codes', 'imports',
    'attendance_days', 'cases', 'detection_runs',
    'conversations', 'messages', 'templates',
    'actions', 'approvals',
    'policy_packs', 'policy_sources', 'policy_chunks',
    'ai_decisions', 'calls', 'usage_events', 'consent_events'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t AND table_schema = 'public') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %I
        USING (
          tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
          OR current_setting('app.bypass_rls', true) = 'on'
        )
        WITH CHECK (
          tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
          OR current_setting('app.bypass_rls', true) = 'on'
        )
      $f$, t);
    END IF;
  END LOOP;

  -- tenants itself: a tenant may read only its own row.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants' AND table_schema = 'public') THEN
    EXECUTE 'ALTER TABLE tenants ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE tenants FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON tenants';
    EXECUTE $f$
      CREATE POLICY tenant_isolation ON tenants
      USING (
        id = nullif(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.bypass_rls', true) = 'on'
      )
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on')
    $f$;
  END IF;

  -- jobs and audit_log carry a nullable tenant_id (platform-wide rows exist), so
  -- they allow NULL tenant rows through for the worker that processes them.
  FOREACH t IN ARRAY ARRAY['jobs', 'audit_log'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t AND table_schema = 'public') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %I
        USING (
          tenant_id IS NULL
          OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
          OR current_setting('app.bypass_rls', true) = 'on'
        )
        WITH CHECK (
          tenant_id IS NULL
          OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
          OR current_setting('app.bypass_rls', true) = 'on'
        )
      $f$, t);
    END IF;
  END LOOP;
END $$;

-- Full-text search over policy content, used to ground policy answers.
CREATE INDEX IF NOT EXISTS policy_chunks_fts_idx
  ON policy_chunks USING gin (to_tsvector('english', text));

-- The audit trail is append-only: no updates, no deletes, for anyone.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
