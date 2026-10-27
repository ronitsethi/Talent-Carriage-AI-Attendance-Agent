-- A COE person's Talent Carriage employee code. One code is one person, as one
-- number is. Nullable only so people entered before codes were asked for stay
-- valid; the form requires it from now on.
ALTER TABLE coe_people ADD COLUMN IF NOT EXISTS emp_code text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS coe_people_emp_code_key ON coe_people (emp_code);
