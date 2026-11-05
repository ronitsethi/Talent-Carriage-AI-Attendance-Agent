-- "Reminder after" and "Call after" are gone: employees always get until the next
-- day, and nothing ever placed the call that `call_due_at` scheduled.
DROP INDEX IF EXISTS "cases_call_due_idx";
--> statement-breakpoint
ALTER TABLE "cases" DROP COLUMN "call_due_at";
--> statement-breakpoint
ALTER TABLE "tenant_settings" DROP COLUMN "follow_up_after_days";
--> statement-breakpoint
ALTER TABLE "tenant_settings" DROP COLUMN "call_after_days";
