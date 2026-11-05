-- Automatic sending now follows an attendance upload instead of the clock: the
-- daily check and its time go, and a customer sets how long the sends spread over.
ALTER TABLE "tenant_settings" DROP COLUMN "check_time";
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "send_window_minutes" integer DEFAULT 60 NOT NULL;
--> statement-breakpoint
SELECT set_config('app.bypass_rls', 'on', true);
--> statement-breakpoint
-- Nothing already queued by the old schedule may still go out after this.
DELETE FROM "jobs" WHERE "kind" IN ('daily_check', 'send_follow_up') AND "status" IN ('pending', 'claimed');
