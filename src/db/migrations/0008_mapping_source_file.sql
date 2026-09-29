-- The file being mapped, kept on the draft so the file that was mapped is the
-- one that gets imported. Cleared as soon as the mapping is saved.
ALTER TABLE mapping_profiles ADD COLUMN IF NOT EXISTS source_file text;
ALTER TABLE mapping_profiles ADD COLUMN IF NOT EXISTS source_filename text;
