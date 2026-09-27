ALTER TABLE "tenant_settings" ADD COLUMN "default_channel" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "preferred_channel" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "follow_up_channel" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "channel" "channel" DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "follow_up_channel" "channel";