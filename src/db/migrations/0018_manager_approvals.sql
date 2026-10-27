-- Whether a customer's attendance comes from a file or a connected HRMS. With an
-- HRMS the agent offers to apply leave and regularisation itself; with a file it
-- asks the employee to, and either way the manager is asked to approve.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS attendance_source text NOT NULL DEFAULT 'csv';
--> statement-breakpoint
-- The people who approve: found from each employee's manager mobile, or their
-- manager code. Known by number, and contacted the way set for them here.
CREATE TABLE IF NOT EXISTS managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mobile_e164 text NOT NULL,
  full_name text NOT NULL,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  preferred_channel text NOT NULL DEFAULT 'whatsapp',
  call_mode text,
  operating_mode text NOT NULL DEFAULT 'automatic',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS managers_tenant_mobile_key ON managers (tenant_id, mobile_e164);
--> statement-breakpoint
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approver_manager_id uuid REFERENCES managers(id) ON DELETE SET NULL;
--> statement-breakpoint
-- When the request went to the manager; null while it waits for HR to send it.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS sent_at timestamptz;
--> statement-breakpoint
UPDATE approvals SET sent_at = requested_at WHERE sent_at IS NULL;
--> statement-breakpoint
ALTER TYPE action_type ADD VALUE IF NOT EXISTS 'apply_on_duty';
--> statement-breakpoint
ALTER TYPE action_type ADD VALUE IF NOT EXISTS 'apply_comp_off';
