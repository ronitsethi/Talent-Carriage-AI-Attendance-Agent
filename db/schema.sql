-- Idempotent: safe to run on every start.
CREATE TABLE IF NOT EXISTS employees (
  id           SERIAL PRIMARY KEY,
  emp_code     TEXT UNIQUE NOT NULL,
  full_name    TEXT NOT NULL,
  department   TEXT,
  branch       TEXT,
  manager      TEXT,
  mobile       TEXT,
  mobile_e164  TEXT,            -- digits only, e.g. 919876543210 (WhatsApp "wa_id" format)
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employees_mobile_idx ON employees (mobile_e164);

CREATE TABLE IF NOT EXISTS attendance (
  employee_id  INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  att_date     DATE NOT NULL,
  first_half   TEXT,
  second_half  TEXT,
  raw          TEXT,
  PRIMARY KEY (employee_id, att_date)
);
CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance (att_date);

-- One case = one employee + one absent date. The unique key stops double messaging.
CREATE TABLE IF NOT EXISTS cases (
  id             SERIAL PRIMARY KEY,
  employee_id    INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  absent_date    DATE NOT NULL,
  code           TEXT NOT NULL,                 -- A|A, A|P, P|A
  status         TEXT NOT NULL DEFAULT 'new',   -- new, sent, delivered, read, failed, replied, needs_hr, no_reply
  wa_message_id  TEXT,
  reply_option   SMALLINT,                      -- 1..4 from the flowchart
  reply_text     TEXT,
  ai_used        BOOLEAN NOT NULL DEFAULT false,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  replied_at     TIMESTAMPTZ,
  UNIQUE (employee_id, absent_date)
);
CREATE INDEX IF NOT EXISTS cases_wamid_idx ON cases (wa_message_id);

CREATE TABLE IF NOT EXISTS messages (
  id             SERIAL PRIMARY KEY,
  case_id        INT REFERENCES cases(id) ON DELETE CASCADE,
  direction      TEXT NOT NULL,                 -- in / out
  wa_message_id  TEXT UNIQUE,
  wa_id          TEXT,
  body           TEXT,
  status         TEXT,
  payload        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_case_idx ON messages (case_id);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
INSERT INTO settings (key, value) VALUES
  ('check_time', '10:30'),
  ('scheduler_enabled', 'false'),
  ('last_auto_run', '')
ON CONFLICT (key) DO NOTHING;
