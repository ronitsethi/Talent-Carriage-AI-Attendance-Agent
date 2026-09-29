-- What the uploaded file looked like, so the mapping screen can be reopened and
-- corrected without asking for the file a second time.
ALTER TABLE mapping_profiles ADD COLUMN IF NOT EXISTS detected jsonb;
