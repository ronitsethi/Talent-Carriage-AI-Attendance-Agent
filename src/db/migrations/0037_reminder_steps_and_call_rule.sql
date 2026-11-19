-- Reminders counted per date, a time for them on days with no upload send, and
-- the call rule: calls for reminders and follow-ups only when allowed and when
-- the person has ignored enough contacts, with a gap between calls and a cap per date.
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "reminder_time" text DEFAULT '14:00' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "reminder_calls_allowed" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "follow_up_calls_allowed" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "follow_up_call_mode" text DEFAULT 'keypad' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "ignored_before_call" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "call_gap_days" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "max_calls_per_date" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
-- Every working day for a new customer; existing customers keep what they have (0 = off) until they set it.
ALTER TABLE "tenant_settings" ALTER COLUMN "reminder_interval_days" SET DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "ignored_contacts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "last_call_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "reminder_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "reminded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "calls_made" integer DEFAULT 0 NOT NULL;
