-- A call now knows why it is ringing: the first question about an absence, or
-- the day-2 reminder about the action the employee was given.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'first_contact';
