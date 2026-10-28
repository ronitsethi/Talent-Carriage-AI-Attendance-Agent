-- Plivo's call-record API gives amounts in US dollars, whatever the account is
-- billed in, and the phone lines written before this were stored as if they
-- were rupees (₹0.0047 for a call the console shows as ₹0.38). A rupee account
-- is charged the seconds Plivo billed at ₹0.38 a minute, so those lines are
-- worked out again from their billed seconds, keeping the dollar figure.
-- The table is row-level secured even for this connection, hence the bypass.
SELECT set_config('app.bypass_rls', 'on', true);
--> statement-breakpoint
UPDATE cost_lines
   SET detail = detail || jsonb_build_object(
         'plivoUsd', amount_micros / 1000000.0,
         'source', coalesce(detail->>'source', 'Plivo') || ': ' || round(quantity)::int || 's billed at ₹0.38/min'),
       amount_micros = round(quantity / 60.0 * 0.38 * 1000000),
       currency = 'INR'
 WHERE provider = 'Plivo' AND estimated = false AND item LIKE 'Phone%' AND NOT (detail ? 'plivoUsd');
