-- A month's attendance made final: no upload changes it and nobody is contacted
-- about it until it is unlocked. Its open cases wait in 'unresolved'.
ALTER TYPE "case_status" ADD VALUE IF NOT EXISTS 'unresolved';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attendance_locks" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "month" text NOT NULL,
  "locked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "locked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "attendance_locks_pk" PRIMARY KEY ("tenant_id", "month")
);
--> statement-breakpoint
-- Where a case stood when its month was locked, so unlocking puts it back.
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "lock_state" jsonb;
--> statement-breakpoint
-- The phone lines every call shares, across all customers: a call or an incoming
-- call holds one while it is ringing or talking. Only the first few are used.
CREATE TABLE IF NOT EXISTS "call_lines" (
  "id" smallint PRIMARY KEY,
  "holder_kind" text,
  "holder_id" uuid,
  "taken_at" timestamp with time zone
);
--> statement-breakpoint
INSERT INTO "call_lines" ("id") SELECT generate_series(1, 20) ON CONFLICT DO NOTHING;
