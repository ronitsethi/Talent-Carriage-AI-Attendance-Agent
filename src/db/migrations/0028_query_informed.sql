-- A query that needed no ticket, shared with its COE team for their information.
-- Set once the notice is queued, so the query is never shared twice.
ALTER TABLE "queries" ADD COLUMN "informed_at" timestamp with time zone;
