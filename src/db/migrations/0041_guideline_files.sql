-- The uploaded guideline PDF itself, kept so it can be previewed: its path in
-- the private storage container (`guidelines/<id>.pdf`). Empty for documents
-- added before files were kept; those preview as the text the agent reads.
ALTER TABLE "policy_documents" ADD COLUMN IF NOT EXISTS "file_path" text;
