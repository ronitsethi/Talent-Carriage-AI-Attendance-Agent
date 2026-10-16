-- An employee deleted by HR whose cases are kept as a record. Nothing is sent
-- to them and nothing they send is acted on; only the cases remain, read-only.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
-- Every query that picks people to contact filters on this, so it is worth an index.
CREATE INDEX IF NOT EXISTS employees_tenant_live_idx ON employees (tenant_id) WHERE deleted_at IS NULL;
