-- Payroll: each customer's payroll mapping, one upload per locked month, and its
-- rows per employee.
CREATE TABLE IF NOT EXISTS "payroll_profiles" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "field_map" jsonb,
  "excluded" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "draft" jsonb,
  "saved_at" timestamp with time zone,
  "saved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "month" text NOT NULL,
  "filename" text,
  "columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "report" jsonb,
  "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "uploaded_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_uploads_month_key" ON "payroll_uploads" ("tenant_id", "month");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "upload_id" uuid NOT NULL REFERENCES "payroll_uploads"("id") ON DELETE CASCADE,
  "month" text NOT NULL,
  "employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "emp_code" text NOT NULL,
  "employee_name" text,
  "calendar_days" numeric,
  "paid_days" numeric,
  "monthly_rate" numeric,
  "gross" numeric,
  "deductions" numeric,
  "net" numeric,
  "arrears" numeric,
  "fields" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_rows_month_code_key" ON "payroll_rows" ("tenant_id", "month", "emp_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_rows_employee_idx" ON "payroll_rows" ("employee_id", "month");
