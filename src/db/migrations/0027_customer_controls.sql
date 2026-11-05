-- How each follow-up level reaches people, across a whole customer. Empty means
-- every level uses the employee's own setting, as it always has.
ALTER TABLE "tenant_settings" ADD COLUMN "follow_up_contacts" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- The audit trail refuses every delete, so a cascade from a deleted customer would
-- fail. Its rows now outlive the customer, keeping that customer's id.
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_tenant_id_tenants_id_fk";
