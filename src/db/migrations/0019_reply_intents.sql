-- The first question's new options: "I was on leave", and "Weekly off / Comp off".
ALTER TYPE reply_intent ADD VALUE IF NOT EXISTS 'on_leave';
--> statement-breakpoint
ALTER TYPE reply_intent ADD VALUE IF NOT EXISTS 'weekly_off';
