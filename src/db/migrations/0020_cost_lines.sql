-- What every call and message cost, item by item: the model's tokens, speech to
-- text and back, the phone line, LiveKit's minutes. Linked loosely - no foreign
-- keys - because a cost is written from its own connection, often before the
-- call or message it belongs to has been committed, and it outlives a rollback.
CREATE TABLE IF NOT EXISTS cost_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid,
  call_id uuid,
  query_id uuid,
  provider_message_id text,
  source_key text,
  provider text NOT NULL,
  item text NOT NULL,
  quantity double precision NOT NULL DEFAULT 0,
  unit text NOT NULL,
  amount_micros bigint,
  currency text NOT NULL DEFAULT 'INR',
  estimated boolean NOT NULL DEFAULT true,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cost_lines_call_idx ON cost_lines (call_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cost_lines_case_idx ON cost_lines (case_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cost_lines_query_idx ON cost_lines (query_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cost_lines_message_idx ON cost_lines (provider_message_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cost_lines_source_key ON cost_lines (tenant_id, source_key);
--> statement-breakpoint
-- What Meta said about a message's billing on its delivery receipt.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pricing jsonb;
