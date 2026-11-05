-- How many follow-ups a customer gives for one date, and how many a case has had.
ALTER TABLE "tenant_settings" ADD COLUMN "max_follow_ups" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "follow_up_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
SELECT set_config('app.bypass_rls', 'on', true);
--> statement-breakpoint
-- A follow-up already sent counts as the first. Its clock is cleared so that this
-- deploy alone sends nobody a further follow-up or a final notice.
UPDATE "cases"
SET "follow_up_count" = 1, "follow_up_due_at" = NULL
WHERE "follow_up_sent_at" IS NOT NULL;
