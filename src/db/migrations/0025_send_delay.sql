-- The time period after an upload is how long sending waits, not how long it spreads over.
ALTER TABLE "tenant_settings" RENAME COLUMN "send_window_minutes" TO "send_delay_minutes";
