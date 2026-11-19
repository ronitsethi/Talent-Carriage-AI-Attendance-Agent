-- The Company tab on Mapping: which column names the company in this customer's
-- files, and the company name itself. Uploads are checked against these instead
-- of the customer's name in the portal.
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "company_column" text;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "company_name" text;
