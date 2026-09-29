-- A customer's policy documents, and the passages the agent answers from.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS policy_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  filename text NOT NULL,
  topic text NOT NULL DEFAULT 'other',
  status text NOT NULL DEFAULT 'processing',
  error text,
  content text,
  page_count text,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz
);
CREATE INDEX IF NOT EXISTS policy_documents_tenant_idx ON policy_documents (tenant_id, status);

CREATE TABLE IF NOT EXISTS policy_passages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES policy_documents(id) ON DELETE CASCADE,
  ordinal text NOT NULL,
  text text NOT NULL,
  embedding vector(1536),
  meta jsonb
);
CREATE INDEX IF NOT EXISTS policy_passages_tenant_idx ON policy_passages (tenant_id);
-- No vector index: a customer's policy set is a few hundred passages, where a
-- sequential scan is faster than an approximate index and always exact.
