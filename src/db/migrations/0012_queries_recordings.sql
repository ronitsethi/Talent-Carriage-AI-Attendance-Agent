-- Whatever an employee asks us of their own accord - a call to us, or a WhatsApp
-- message that is not about an absent date. A call is one query; a chat is one
-- query until it has gone quiet for half an hour.
CREATE TABLE IF NOT EXISTS queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  channel channel NOT NULL,
  call_style text,
  provider_call_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  transcript jsonb,
  recording_uri text,
  summary_queries text,
  summary_reply text,
  summarised_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS queries_tenant_started_idx ON queries (tenant_id, started_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS queries_employee_open_idx ON queries (employee_id, channel, last_activity_at DESC);
--> statement-breakpoint
-- The WhatsApp messages that make up a query.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS query_id uuid REFERENCES queries(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_query_idx ON messages (query_id, created_at) WHERE query_id IS NOT NULL;
--> statement-breakpoint
-- One overall summary of a case's conversation, written when somebody first
-- opens it and rewritten only once something new has been said.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS summary text;
--> statement-breakpoint
ALTER TABLE cases ADD COLUMN IF NOT EXISTS summarised_at timestamptz;
