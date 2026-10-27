-- Talent Carriage's COE teams, which tickets will be handed to. They belong to
-- Talent Carriage rather than a customer, so there is no tenant_id and no
-- row-level security: only staff reach these tables.
CREATE TABLE IF NOT EXISTS coe_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  mobile_e164 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS coe_people_mobile_key ON coe_people (mobile_e164);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS coe_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  full_name text NOT NULL,
  fallback_person_id uuid REFERENCES coe_people(id) ON DELETE SET NULL,
  lt_person_id uuid REFERENCES coe_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS coe_teams_code_key ON coe_teams (code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS coe_team_members (
  team_id uuid NOT NULL REFERENCES coe_teams(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES coe_people(id) ON DELETE CASCADE,
  position integer NOT NULL,
  PRIMARY KEY (team_id, person_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS coe_team_members_person_idx ON coe_team_members (person_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS coe_team_clients (
  team_id uuid NOT NULL REFERENCES coe_teams(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, tenant_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS coe_team_clients_tenant_idx ON coe_team_clients (tenant_id);
