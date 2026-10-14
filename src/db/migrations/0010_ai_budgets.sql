-- What the Azure OpenAI features may spend, per budget, and every top-up.
CREATE TABLE IF NOT EXISTS ai_budgets (
  budget text PRIMARY KEY,
  allowance_micros bigint NOT NULL,
  spent_micros bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Ten dollars each to start with.
INSERT INTO ai_budgets (budget, allowance_micros) VALUES ('whatsapp', 10000000), ('call', 10000000)
ON CONFLICT (budget) DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_budget_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget text NOT NULL,
  amount_micros bigint NOT NULL,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
