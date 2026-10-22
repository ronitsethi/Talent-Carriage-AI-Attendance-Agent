-- What an employee who rang us said about the call, asked on WhatsApp a minute
-- after it ended: was their question answered, how was the call, and - when
-- either was not good - what could have been better.
ALTER TABLE queries ADD COLUMN IF NOT EXISTS feedback_sent_at timestamptz;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS feedback_step text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS feedback_resolved text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS feedback_rating text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS feedback_comment text;
--> statement-breakpoint
ALTER TABLE queries ADD COLUMN IF NOT EXISTS feedback_answered_at timestamptz;
--> statement-breakpoint
-- The employee's feedback still waiting on an answer, found from their reply.
CREATE INDEX IF NOT EXISTS queries_feedback_open_idx ON queries (employee_id, feedback_sent_at DESC)
  WHERE feedback_step IS NOT NULL AND feedback_step <> 'done';
