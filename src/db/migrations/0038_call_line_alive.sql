-- When the voice worker last said a call holding this line is still going. It
-- says so every 10 seconds while somebody is on the line; a line whose holder
-- has gone quiet for 30 seconds is free, so a call process killed mid-call
-- does not hold its line until the 45-minute fallback.
ALTER TABLE "call_lines" ADD COLUMN IF NOT EXISTS "alive_at" timestamp with time zone;
