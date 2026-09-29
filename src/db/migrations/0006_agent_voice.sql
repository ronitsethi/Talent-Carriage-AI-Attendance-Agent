-- The talking agent's voice, per customer. Which one sounds right is a matter
-- of taste, so it belongs in settings rather than in a config file.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS agent_voice text NOT NULL DEFAULT 'ritu';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS agent_voice_pace numeric(3,2) NOT NULL DEFAULT 0.95;
