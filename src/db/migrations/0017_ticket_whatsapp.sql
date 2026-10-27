-- Tickets on WhatsApp: a number to name each by, and every message about a
-- ticket - to the COE person it is with, and their replies - so a reply can be
-- matched to its ticket and the query page can show what was sent and whether
-- it got there.
CREATE SEQUENCE IF NOT EXISTS ticket_no_seq;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS ticket_no integer;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS queries_ticket_no_key ON queries (ticket_no);
--> statement-breakpoint
-- Tickets raised before numbers existed get theirs now, oldest first.
UPDATE queries SET ticket_no = numbered.n
FROM (SELECT id, nextval('ticket_no_seq') AS n FROM (SELECT id FROM queries WHERE ticket_status IS NOT NULL AND ticket_no IS NULL ORDER BY ticket_raised_at) ordered) numbered
WHERE queries.id = numbered.id;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
--> statement-breakpoint
-- Talent Carriage's own, like the COE tables: no tenant, no row-level security.
CREATE TABLE IF NOT EXISTS ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  person_id uuid REFERENCES coe_people(id) ON DELETE SET NULL,
  direction text NOT NULL,
  kind text NOT NULL,
  body text,
  provider_message_id text,
  status text NOT NULL DEFAULT 'queued',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ticket_messages_provider_key ON ticket_messages (provider_message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ticket_messages_query_idx ON ticket_messages (query_id, created_at);
