ALTER TABLE "tenant_settings" ADD COLUMN "contact_lag_days" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "max_dates_per_call" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "operating_mode" text;