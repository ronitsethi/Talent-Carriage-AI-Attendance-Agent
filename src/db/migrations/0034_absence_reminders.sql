-- One message per person, reminders for ignored first contacts, and escalation
-- to the manager. Cases a manager has been told about are 'escalated'.
ALTER TYPE "case_status" ADD VALUE IF NOT EXISTS 'escalated' AFTER 'needs_hr';
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "reminder_channel" text DEFAULT 'whatsapp' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "reminder_call_mode" text DEFAULT 'keypad' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "reminder_interval_days" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "reminders_before_escalation" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "escalate_after_days" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- An employee's own channel is now only for someone given one on purpose: blank follows the customer's default.
ALTER TABLE "employees" ALTER COLUMN "preferred_channel" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "preferred_channel" DROP DEFAULT;
--> statement-breakpoint
UPDATE "employees" SET "preferred_channel" = NULL WHERE "preferred_channel" = 'whatsapp';
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "absence_contact_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "absence_reminders" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "covers" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "absence_escalations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "manager_id" uuid REFERENCES "managers"("id") ON DELETE SET NULL,
  "case_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason" text NOT NULL,
  "decision" text,
  "sent_at" timestamp with time zone,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "absence_escalations_employee_idx" ON "absence_escalations" ("employee_id", "created_at");
--> statement-breakpoint
-- A call about new absences that also carries the person's follow-ups, asked once the absences are done.
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "then_follow_ups" jsonb DEFAULT '[]'::jsonb NOT NULL;
