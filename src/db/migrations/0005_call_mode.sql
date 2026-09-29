-- A voice call can now be a keypad menu or a spoken conversation. The choice is
-- per employee, falling back to the customer's default.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS call_mode text NOT NULL DEFAULT 'keypad';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS call_mode text;
