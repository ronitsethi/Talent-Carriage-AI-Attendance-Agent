-- Working days, the manager's steps (WhatsApp, then a call, then HR), and HR's
-- details, ready for when a customer gives them.
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "saturday_working" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "escalation_route" text DEFAULT 'manager_then_hr' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "manager_respond_days" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "speak_grace_days" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "hr_name" text;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "hr_mobile_e164" text;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "hr_email" text;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "hr_tell_whatsapp" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "hr_daily_summary" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "payroll_cutoff_day" integer;
--> statement-breakpoint
-- "Done" on a follow-up: nothing more until the file has had a day to show it.
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "follow_up_paused_until" date;
--> statement-breakpoint
-- When the dates went to HR, for the daily flag and the payroll cut-off.
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "hr_at" timestamp with time zone;
--> statement-breakpoint
-- A no-reply escalation's steps: 0 sent on WhatsApp, 1 called; when the next is due; the grace "I'll speak to them" gave.
ALTER TABLE "absence_escalations" ADD COLUMN IF NOT EXISTS "steps" smallint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "absence_escalations" ADD COLUMN IF NOT EXISTS "next_step_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "absence_escalations" ADD COLUMN IF NOT EXISTS "speak_until" date;
