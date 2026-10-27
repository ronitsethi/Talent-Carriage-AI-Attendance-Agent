-- Tickets. A query the agent could not settle becomes a ticket for a COE team
-- member: which member is decided by the company they look after, so clients
-- move from the team to each member on it.
CREATE TABLE IF NOT EXISTS coe_member_clients (
  team_id uuid NOT NULL REFERENCES coe_teams(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES coe_people(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, person_id, tenant_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS coe_member_clients_tenant_idx ON coe_member_clients (tenant_id);
--> statement-breakpoint
-- Whatever a team looked after, each of its members now looks after.
INSERT INTO coe_member_clients (team_id, person_id, tenant_id)
SELECT m.team_id, m.person_id, c.tenant_id
FROM coe_team_members m JOIN coe_team_clients c ON c.team_id = m.team_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TABLE IF EXISTS coe_team_clients;
--> statement-breakpoint
-- The training sheet: what an employee can ask about, and which COE handles it.
CREATE TABLE IF NOT EXISTS query_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position integer NOT NULL,
  cluster text,
  coe_code text NOT NULL,
  name text NOT NULL,
  description text,
  target_variables text,
  keywords text,
  trigger_criteria text,
  required_info text,
  clarifying_questions text,
  routing_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS query_types_name_key ON query_types (name);
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS ticket_status text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS ticket_raised_at timestamptz;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS query_type_id uuid REFERENCES query_types(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS query_type_name text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS coe_code text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS priority text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS problem_description text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS assigned_person_id uuid REFERENCES coe_people(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS assigned_team_id uuid REFERENCES coe_teams(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS assignment_mark text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS lt_transferred_at timestamptz;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS lt_person_id uuid REFERENCES coe_people(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
--> statement-breakpoint
-- A member's open tickets, counted on every assignment.
CREATE INDEX IF NOT EXISTS queries_ticket_assignee_idx ON queries (assigned_person_id, ticket_status);
