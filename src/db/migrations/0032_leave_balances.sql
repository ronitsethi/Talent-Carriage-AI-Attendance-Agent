-- Leave balances from an uploaded file: each customer's leave balance mapping,
-- every upload, and balances that keep half days and what is pending approval.
CREATE TABLE IF NOT EXISTS "leave_balance_profiles" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "field_map" jsonb,
  "columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "draft" jsonb,
  "saved_at" timestamp with time zone,
  "saved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leave_balance_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "filename" text,
  "report" jsonb,
  "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "uploaded_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leave_balance_uploads_tenant_idx" ON "leave_balance_uploads" ("tenant_id", "uploaded_at");
--> statement-breakpoint
ALTER TABLE "leave_balances" ALTER COLUMN "balance_days" TYPE numeric USING "balance_days"::numeric;
--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "leave_name" text;
--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "pending_days" numeric;
--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "balance_after_pending" numeric;
--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'hrms' NOT NULL;
--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "upload_id" uuid REFERENCES "leave_balance_uploads"("id") ON DELETE SET NULL;
