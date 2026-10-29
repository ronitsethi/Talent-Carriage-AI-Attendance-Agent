-- The agent's voices moved from Sarvam's Bulbul v3 to v4 Flash, whose voices
-- have other names. A customer's chosen v3 voice becomes the v4 Hinglish voice
-- of the same gender, and new customers start on Simran.
ALTER TABLE "tenant_settings" ALTER COLUMN "agent_voice" SET DEFAULT 'simran_enhi_customer';
--> statement-breakpoint
SELECT set_config('app.bypass_rls', 'on', true);
--> statement-breakpoint
UPDATE "tenant_settings"
SET "agent_voice" = CASE
  WHEN "agent_voice" IN ('rahul', 'amit', 'dev', 'rohan', 'shubh', 'manan', 'sumit') THEN 'sunny_enhi_customer'
  ELSE 'simran_enhi_customer'
END
WHERE "agent_voice" NOT IN ('simran_enhi_customer', 'ishita_enhi_customer', 'shalini_enhi_customer', 'sunny_enhi_customer', 'shubh_enhi_banking');
