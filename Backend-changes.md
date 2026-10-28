# Backend Change Log

Every backend change (APIs/routes, server logic, database schema, migrations, queries, auth, background jobs, environment variables, infrastructure, backend dependencies). Newest entries at the top. Each entry is also recorded in `changes.md`.

Format:
```
## YYYY-MM-DD HH:MM
- **Files:** path/to/file1, path/to/file2
- **Change:** what was changed
- **Why:** reason for the change
- **Impact:** e.g. breaking API change, migration required, new env var
```

## 2026-10-28 13:36
- **Files:** src/lib/costs/calls.ts, src/lib/costs/plivo.ts, src/app/api/voice/status/route.ts, src/db/migrations/0021_plivo_rupees.sql, src/db/migrations/meta/_journal.json
- **Change:** Plivo phone lines are priced as the seconds Plivo billed × ₹0.38/min on a rupee account, instead of Plivo's API amount (which is in US dollars) stored as rupees. Migration 0021 corrects the lines already saved.
- **Why:** The cost box showed ₹0.0047 for a call Plivo bills at ₹0.38.
- **Impact:** Migration 0021 required (data only: updates `cost_lines`; no schema change). `PLIVO_BILLING_CURRENCY` now decides how Plivo's figures are read.

## 2026-10-28 12:25
- **Files:** .gitignore
- **Change:** Ignore only the top-level `/recordings/` folder, and `__pycache__/`.
- **Why:** The old `recordings/` rule hid the `src/app/api/recordings` route from git.
- **Impact:** The recordings route is now committed. No runtime change.

## 2026-10-27 16:40
- **Files:** src/lib/costs/summary.ts, src/lib/queries.ts
- **Change:** One cost box per case and per query, grouped by service, replacing the per-message and per-call boxes.
- **Why:** The user wants the cost of a case or query by service, not message by message.
- **Impact:** None beyond the pages; no schema change.

## 2026-10-27 14:30
- **Files:** src/lib/costs/plivo.ts, src/lib/jobs/queue.ts, src/lib/jobs/handlers.ts, src/app/api/agent/turn/route.ts, src/app/api/voice/recorded/route.ts
- **Change:** New `plivo_charge` job. After a talking call (or a keypad call to us) ends, it reads Plivo's SIP trunk CDRs (`/Zentrunk/Call/`) or call record (`/Call/{uuid}/`) and replaces the estimated phone line with Plivo's charge. It retries at 2, 10 and 30 minutes.
- **Why:** So the phone line on talking calls is Plivo's real charge.
- **Impact:** New job kind. Uses the existing `PLIVO_AUTH_ID`/`PLIVO_AUTH_TOKEN`; does nothing without them.

## 2026-10-27 13:30
- **Files:** src/db/migrations/0020_cost_lines.sql, src/db/schema/ops.ts, src/db/schema/messaging.ts, src/db/rls.sql, src/lib/costs/*, src/lib/models/gateway.ts, src/lib/knowledge/index.ts, src/lib/conversation/talk.ts, src/lib/conversation/summary.ts, src/lib/conversation/feedback.ts, src/lib/tickets.ts, src/lib/voice/say.ts, src/lib/voice/resolve.ts, src/app/api/webhook/route.ts, src/app/api/agent/turn/route.ts, src/app/api/voice/status/route.ts, src/app/api/voice/ask/route.ts, src/app/api/voice/inbound/route.ts, src/lib/channels/meta.ts, src/lib/channels/types.ts, src/lib/conversation/engine.ts, src/lib/env.ts, agent/worker.py
- **Change:** New `cost_lines` table (under RLS) and `messages.pricing`. Model use, Sarvam clips and each call's phone line, speech and LiveKit minutes are written against the case, call, query or WhatsApp message they were for. Delivery receipts store Meta's pricing. The worker sends `durationSeconds` and `usage` with `ended`.
- **Why:** The cost of every call and message, by service.
- **Impact:** Migration 0020 required (applied in production 2026-10-27). New env vars, all optional: `USD_INR_RATE` (88), `LIVEKIT_PLAN` (build), `PLIVO_BILLING_CURRENCY` (INR). Voice worker v14 deployed.

## 2026-10-27 11:00
- **Files:** src/lib/approvals.ts, scripts/create-ticket-templates.ts
- **Change:** The decision goes to the employee on WhatsApp only, never by call. The manager is always told the employee knows, on WhatsApp: free text after a tap, else the new `approval_noted` template.
- **Why:** The user asked for decision notices only on WhatsApp.
- **Impact:** New WhatsApp template `approval_noted` (created on Meta 2026-10-27).

## 2026-10-26 18:00
- **Files:** src/lib/voice/approval-calls.ts, src/lib/voice/keypad-sheet.ts, src/lib/voice/session.ts
- **Change:** Calls to managers (keypad or talking) to approve or reject, falling back to WhatsApp. Keypad calls to employees walk the flow-sheet menus.
- **Why:** A contact medium per manager; the keypad had to ask the new questions.
- **Impact:** New call purposes `manager_approval` and `approval_outcome`. No schema change.

## 2026-10-26 12:00
- **Files:** src/db/migrations/0018_manager_approvals.sql, src/db/migrations/0019_reply_intents.sql, src/db/schema/actions.ts, src/db/schema/tenants.ts, src/db/schema/enums.ts, src/db/rls.sql, src/lib/approvals.ts, src/lib/conversation/apply.ts, src/lib/conversation/engine.ts, src/lib/env.ts, src/app/actions.ts
- **Change:** `managers` table; `approvals.approver_manager_id` and `sent_at`; action types `apply_on_duty` and `apply_comp_off`; reply intents `on_leave` and `weekly_off`; `tenant_settings.attendance_source` (csv/hrms). Manager approval requests, decisions and typed manager replies are handled in the webhook before the unknown-sender check.
- **Why:** The manager approval flow and the CSV/HRMS switch.
- **Impact:** Migrations 0018 and 0019 required (applied in production 2026-10-26). New optional env var `WA_FIRST_TEMPLATE`, to switch to `attendance_absent_v2` once Meta approves it. New templates `attendance_absent_v2`, `manager_approval_request`, `approval_outcome`.

_Earlier backend changes, before 2026-10-26, are in `changes.md`._
