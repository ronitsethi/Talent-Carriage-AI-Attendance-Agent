-- Saved versions of the AI's editable prompts (AI prompts page, staff only).
-- tenant_id null: a version for every customer; set: that customer's own. The
-- original wording lives in the code and is never stored here.
CREATE TABLE IF NOT EXISTS "prompt_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "prompt" text NOT NULL,
  "tenant_id" uuid REFERENCES "tenants"("id") ON DELETE CASCADE,
  "number" integer NOT NULL,
  "body" text NOT NULL,
  "note" text,
  "active" boolean DEFAULT false NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "prompt_versions_lookup_idx" ON "prompt_versions" ("prompt", "tenant_id");

-- Version numbers are unique per prompt and scope; the all-customers scope is a
-- null tenant, which a plain unique index would treat as all different.
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_versions_number_key"
  ON "prompt_versions" ("prompt", coalesce("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid), "number");

-- At most one active version per prompt and scope.
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_versions_active_key"
  ON "prompt_versions" ("prompt", coalesce("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "active";
