-- Each reminder and each follow-up has its own row in Settings: WhatsApp or a
-- call, and the call style. A call goes only at a level set to Call, and only
-- when the rest of the call rule allows it. Replaces "Calls allowed for
-- reminders / follow-ups" and "Max calls per date" (columns kept, unused).
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "reminder_contacts" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- The old follow-up rows ("Employee's own setting" or a channel per level) have
-- not been read for a while; clear them so the new defaults apply until a
-- customer saves its own rows.
UPDATE "tenant_settings" SET "follow_up_contacts" = '[]'::jsonb;
