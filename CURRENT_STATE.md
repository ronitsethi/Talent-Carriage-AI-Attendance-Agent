# Current System State

_Populated from the codebase on 2026-10-13. Edit only the section that changed._

## Overview

**What it is:** Talent Carriage AI Attendance Agent, a multi-tenant platform. Each customer (tenant) uploads its attendance register. The platform finds unexplained days (absences, half days, missed punches) and contacts the employee on WhatsApp or by phone. It records the reason and sends guidance. Where enabled, it files leave or regularisation in the HRMS after the manager approves. Anything it cannot settle goes to HR.

**Stack**
- Next.js 16 App Router (React 19, server components and server actions), TypeScript, `output: 'standalone'`.
- PostgreSQL 16 with pgvector, accessed through Drizzle ORM and the `pg` driver. Tenant isolation is enforced by row-level security (see Database).
- Zod-validated env (`src/lib/env.ts`), JWT sessions (`jose`) with bcrypt passwords.
- SheetJS (`xlsx`) parses spreadsheets. MuPDF and Tesseract.js (WASM) do OCR, with English data bundled in `tessdata/`.
- Vitest tests live in `tests/`.

**Processes**
1. **Web app:** the portal pages, server actions (`src/app/actions.ts`) and webhook/API routes (`src/app/api/**`).
2. **Job worker:** a Postgres-backed queue. It runs inside the web server through `src/instrumentation.ts` when `BACKGROUND_WORKER` is true (the default in production). Locally it runs separately with `npm run worker`.
3. **Voice agent (optional):** `agent/worker.py`, a Python LiveKit worker with a Dockerfile and no ingress. It carries spoken calls and holds no business logic: every turn calls back into `POST /api/agent/turn`.

**Safe by default:** every external provider is optional.
- With no keys, or with `DRY_RUN=true` (the default), everything runs on in-process fakes: `FakeChannel`, `FakeVoiceProvider`, `MockHrms` and a stub model.
- Two per-tenant switches add further brakes: `sending_enabled` (default false) and `operating_mode` (default `manual`).
- `src/lib/runtime.ts#buildContext` is the single place that decides between fake and real providers.

**Local development**
- `npm run db:up` starts Docker `pgvector/pgvector:pg16` on port 5434.
- `npm run db:migrate` uses the owner connection to apply the Drizzle migrations, then re-applies `src/db/rls.sql`.
- `npm run db:seed` creates 4 demo tenants (Demo Industries, DPOD Lifestyle, Northwind Retail, Sunrise Logistics). Each gets an `hr@<slug>.test` user with the `hr_admin` role. It also creates `admin@talentcarriage.test` (`platform_admin`).
- `npm run tunnel` (`scripts/retunnel.sh`) opens a Cloudflare quick tunnel so webhooks can reach the machine.

**Deploy:** to Azure App Service (Linux), through `npm run deploy` → `scripts/deploy-azure.sh`.
- Defaults: resource group `rg-client-hub`, web app `tc-attendance-99772`.
- The script builds standalone and bundles the migrations, `rls.sql` and `tessdata/`. It strips `.env*`, zip-deploys with `--clean`, then polls `/api/health`.
- The database is an Azure PostgreSQL Flexible Server shared with Client Hub (`tc-clienthub-pg-99772`). This app has its own database (`attendance`) and its own `tc_app` role, both set up by `scripts/azure-db-setup.ts`.
- The in-process worker relies on App Service "Always On".

**Other folders**
- `demo/` is an earlier, separate Express prototype that covers only the first WhatsApp step. It is not part of the platform.
- `docs/` holds `scope.html` and `azure-cost-estimate.html`.

## Database

Drizzle schema lives in `src/db/schema/*.ts`. Migrations `0000`–`0010` are in `src/db/migrations/`. `src/db/rls.sql` holds the RLS policies and triggers and is re-applied on every migrate.

**Tenant isolation (RLS)**
- The app connects as `tc_app`: not a superuser, no `BYPASSRLS`. Migrations use `MIGRATION_DATABASE_URL`, the owner connection.
- Every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy. A row is visible when `tenant_id = current_setting('app.tenant_id')` or when `app.bypass_rls = 'on'`.
- `withTenant(tenantId, fn)` in `src/db/index.ts` sets `app.tenant_id` for one transaction. `withPlatformScope(fn)` sets `app.bypass_rls`; it is used by the admin console, workers, auth lookups and webhook tenant resolution.
- `tenants`: a tenant can read only its own row. Writes require bypass.
- `jobs` and `audit_log`: rows with a NULL `tenant_id` are also visible.
- `audit_log` is append-only: a trigger raises on UPDATE or DELETE.
- Also defined in `rls.sql`: a GIN full-text index on `policy_chunks.text`.

**Tables by area**

| Area | Tables | Notes |
|---|---|---|
| Tenancy | `tenants`, `tenant_settings`, `tenant_channels`, `users` | `tenant_settings` holds every per-customer knob (see below). `tenant_channels` holds per-tenant provider config (WhatsApp `phoneNumberId`/token/template name in `config` jsonb). `users.tenant_id` is NULL for Talent Carriage staff. |
| People | `employees`, `employee_history`, `leave_balances`, `shifts`, `calendars`, `calendar_days` | Employees are unique on `(tenant_id, emp_code)`; `mobile_e164` is the WhatsApp id. Per-employee settings: `preferred_channel` (whatsapp/voice), `follow_up_channel`, `operating_mode` (manual/automatic/null), `call_mode` (keypad/agent/null), and opt-out flags. |
| Data intake | `mapping_profiles`, `code_mappings`, `unmapped_codes`, `imports`, `attendance_days` | Mapping profiles are versioned (`draft`/`active`/`archived`); a draft keeps the uploaded file (`source_file`, base64) and `detected` analysis. `code_mappings` turns a customer's codes into the canonical `attendance_meaning`. `attendance_days` has PK `(tenant_id, employee_id, att_date)` plus a `revision` counter. |
| Cases | `cases`, `detection_runs` | One case per `(tenant_id, employee_id, att_date)` (unique). Holds status, reply option/intent, follow-up and call clocks, close/needs-HR reasons, and `context` jsonb. |
| Messaging | `conversations`, `messages`, `templates` | One conversation per employee and channel, tracking the 24h WhatsApp window and `active_case_id`. Messages are de-duplicated on `provider_message_id`. |
| HRMS actions | `actions`, `approvals` | `actions` is unique on `(tenant_id, idempotency_key)`; approvals have a timeout and escalation. |
| Voice | `calls` | `provider`, `purpose` (first_contact/follow_up), `status`, `outcome`, transcript jsonb. |
| Knowledge | `policy_documents`, `policy_passages` (migration 0009) | Uploaded guideline PDFs and their chunks, with `vector(1536)` embeddings. No vector index. Older `policy_packs`, `policy_sources` and `policy_chunks` are also defined. |
| Ops | `jobs`, `ai_decisions`, `audit_log`, `usage_events`, `consent_events` | `jobs` is the queue (`dedupe_key` unique). `ai_decisions` logs model classifications. `usage_events` meters messages, calls and actions. |
| AI budgets | `ai_budgets`, `ai_budget_topups` (migration 0010) | Platform-wide, not per tenant. One row per budget (`whatsapp`, `call`) with `allowance_micros` and `spent_micros` (micro-dollars), seeded at $10 each. Top-ups are logged with `added_by`. |

**Key enums** (`src/db/schema/enums.ts`)
- `attendance_meaning`: 25 canonical meanings.
  - Chased by default: `absent_full`, `absent_first_half`, `absent_second_half`, `absent_half_unspecified`, `missed_punch`.
  - Optional (opt-in per tenant): `short_hours`, `late_in`, `early_out`, `leave_unpaid`.
  - Never chased: weekly off, holidays, not employed, suspension, long leave, unknown.
  - Explains the day (closes a case): `present`, `leave_approved`, `on_duty`, `work_from_home`, `travel`, `training`, `comp_off`.
- `case_status`, `reply_intent`, `action_status`, `approval_decision`, `call_outcome`: see Status Machine.
- `user_role`: `platform_admin`, `hr_admin`, `hr_user`, `manager`, `auditor`.
- Other enums: `tenant_status`, `channel`, `message_kind`, `message_status`, `job_status`, `import_source`, `import_status`, `mapping_status`, `usage_kind`.

**Notable `tenant_settings` defaults**
- Scheduling: `operating_mode=manual`, `check_time=10:30`, `timezone=Asia/Kolkata`, `contact_lag_days=1`, quiet hours 20:00–09:00.
- Sending and actions: `sending_enabled=false`, `actions_enabled=false`.
- Calls: `call_mode=keypad`, `agent_voice=ritu`, `agent_voice_pace=0.95`.
- Follow-up: `follow_up_after_days=2`, `call_after_days=3`, `approval_timeout_hours=24`.
- Backlog: `max_outstanding_questions=0` (no cap), `send_backlog_summary=true`.

## API Routes & Webhooks

All live under `src/app/api/**/route.ts`. None of them use the portal session.

| Route | Methods | Caller | What it does |
|---|---|---|---|
| `/api/health` | GET | Deploy script, monitoring | Runs `select 1` and returns `capabilities()` (dry run, which providers are configured). Returns 503 if the DB is down. |
| `/api/webhook` | GET, POST | Meta WhatsApp Cloud API | GET answers the `hub.verify_token` handshake (`WA_VERIFY_TOKEN`). POST checks `X-Hub-Signature-256` when `WA_APP_SECRET` is set, replies 200 straight away, then processes the payload asynchronously. It resolves the tenant by `tenant_channels.config->>'phoneNumberId'`, falling back to the only tenant when exactly one channel row exists. Then it applies delivery receipts and runs `handleInbound` for each message. |
| `/api/voice/answer` | GET, POST | Plivo (answer URL of outbound calls) | Runs `openingTurn` for `?call=<id>` and returns Plivo XML that prompts for keypad or speech. |
| `/api/voice/input` | POST, GET | Plivo | One employee answer (`Digits`/`Speech`) passed to `handleTurn`. Returns the next question or hangs up. A single call works through every pending date. |
| `/api/voice/status` | POST, GET | Plivo hangup callback | Closes the call: an answered call with no outcome becomes `not_completed`; otherwise `no_answer`/`busy`. Missed calls are not retried. |
| `/api/voice/clip/[id]` | GET | Plivo | Serves Sarvam TTS audio (wav) from an in-memory cache that keeps clips for 5 minutes. |
| `/api/voice/inbound` | GET, POST | Plivo (via `/api/plivo/answer`) | Incoming call. Finds the caller by `From` number across active tenants and greets them in the tenant's voice. Unknown numbers are refused. |
| `/api/voice/ask` | POST | Plivo | One spoken question on an incoming call. Answered by `answerQuestion` from the tenant's guidelines and the caller's own attendance, then loops. |
| `/api/plivo/answer` | GET, POST | Plivo (number's answer URL) | Currently returns `inboundXml` (the inbound agent). `?to=` forwards the call instead. The branch that recorded WhatsApp number-verification calls is commented out. |
| `/api/plivo/recording` | GET, POST | Plivo | Logs a verification-call recording URL, used with `npm run verify:code`. |
| `/api/agent/turn` | POST | LiveKit worker (`agent/worker.py`) | Requires the `x-agent-token` header to equal `AGENT_API_TOKEN`; the route stays closed if that is unset. Modes: opening/answer turn (same `openingTurn`/`handleTurn` as keypad calls, returned as JSON), `brief` (voice, pace and language for the call), `ended` (closes the call), `ask` (inbound Q&A). |

## Background Jobs

Code is in `src/lib/jobs/*`. Jobs live in the Postgres `jobs` table.

**How the queue works**
- `enqueue(kind, payload, {tenantId, dedupeKey, runAt, priority})` inserts with `ON CONFLICT (dedupe_key) DO NOTHING`.
- `claim()` uses `FOR UPDATE SKIP LOCKED`, so several workers can run safely.
- `fail()` retries with exponential backoff, capped at 60 minutes. After `max_attempts` (default 5) the job is marked `dead`.
- `requeueStalled()` returns jobs that have been claimed for more than 15 minutes.

**Each tick** (`worker.ts#tick`): `scheduleDueWork()`, then `requeueStalled()`, then claim up to 10 jobs and run them.
- In-process: every `WORKER_INTERVAL_MS`, default 15s (`src/instrumentation.ts`, Node runtime only, ticks never overlap).
- Standalone: `npm run worker`, default every 5s.

**Scheduler** (`scheduler.ts`): only tenants that are `active` and have `operating_mode='automatic'`.
- `daily_check`: once local time passes `check_time`, deduped per tenant per local date.
- `send_follow_up`, `approval_timeout`, `verify_action`: deduped per tenant per local hour.

| Job kind | Handler behaviour |
|---|---|
| `daily_check` | Calls `closeCasesExplainedByData`, then `runDailyCheckAndContact`. The first transaction creates and commits cases; each person is then contacted in their own transaction. |
| `send_follow_up` | `sendDueFollowUps`: day-2 reminders for `answered` cases whose `follow_up_due_at` has passed. Sent as WhatsApp buttons, or as one follow-up call per person on voice. |
| `approval_timeout` | Expires pending approvals past `timeout_at` and moves the case to `needs_hr`. |
| `verify_action` | Reads back `unconfirmed` actions from the HRMS and marks them `executed` when confirmed. |
| `refresh_leave_balances` | Handler exists (fetches balances from the HRMS); not scheduled. |
| `place_call` | Stub: returns "voice provider not configured". |
| `import_file` | Stub: imports are handled by the upload server action. |

## Routes & Pages

**Portal**

| Path | Page | Purpose |
|---|---|---|
| `/login` | `src/app/login/page.tsx` | Email and password sign-in through an inline server action. Already signed in → `/`. |
| `/` | `(app)/page.tsx` | Dashboard. Stats, capability flags (dry run, sending, AI providers, mode, caller ID), and a date-range table of flagged employees with channel/mode/call-mode switches. Also "Contact selected", "send due follow-ups" and reset all cases. |
| `/cases` | `(app)/cases/page.tsx` | Case list with date, status and search filters, and per-row contact and channel/mode switches. |
| `/cases/[id]` | `(app)/cases/[id]/page.tsx` | Case detail: timeline of messages and calls, contact now, close, flag for HR, reset. In dry run it also offers a WhatsApp reply simulator and a call simulator. |
| `/mapping` | `(app)/mapping/page.tsx` + `editor.tsx` | "Mapping & Import". Upload a file to analyse it into a draft mapping, edit fields, layout and codes, save as a new active version, import attendance, and resolve unmapped codes. |
| `/knowledge` | `(app)/knowledge/page.tsx` + `refresh.tsx` | "Guidelines". Upload and delete policy PDFs (OCR, then embeddings, in the background; the page auto-refreshes while reading). A test box asks a question the way the agent would. |
| `/settings` | `(app)/settings/page.tsx` | Per-tenant settings: check time, quiet hours, operating mode, sending/actions switches, cap, follow-up/call/approval timings, agent voice and pace. Read-only unless the user can manage settings. |
| `/admin` | `(app)/admin/page.tsx` | "All customers" console for `platform_admin` only: per-tenant health, AI spending (spent / allowed / left per budget, with a top-up form → `topUpAiBudget`), and platform connections. |

`(app)/layout.tsx` provides the sidebar navigation, the tenant switcher (platform admins only) and sign-out.

**Server actions** (`src/app/actions.ts`, all scoped through `requireTenant()` + `withTenant`)

| Area | Actions |
|---|---|
| Checks and contact | `previewCheck`, `runCheck`, `contactSelected`, `contactNow`, `runFollowUps` |
| Case handling | `closeCase`, `flagForHr`, `resetCase` (deletes the case and its messages/actions/calls), `resetAllCases` |
| Employee switches | `setChannelFromRow`, `setCallModeFromRow`, `setModeFromRow`, `setEmployeeChannel`, `setEmployeeMode` |
| Simulation (`DRY_RUN` only) | `simulateReply`, `simulateCallAnswer` |
| Settings and session | `updateSettings`, `switchTenant`, `signOutAction` |
| Mapping | `analyseMappingFile`, `saveMapping`, `setCodeMeaning`, `importAttendance` |
| Guidelines | `uploadPolicyDocument` (ingestion runs without blocking the request), `deletePolicyDocument`, `askPolicyQuestion` |

**Frontend / UI**
- Follows the Talent Carriage brand guide (the Client Hub's look). Spec: `design_handoff_attendance_agent_redesign/` (README, HTML prototype, brand guide).
- Styling is class-based and lives in `src/app/globals.css`. Its `:root` holds the brand tokens (`--primary`, `--ink-*`, `--line-*`, status `--ok/warn/err/info/neutral-*`), with a 15.3px root and a 13.5px type floor.
- Fonts come from `next/font/google` in `src/app/layout.tsx`: IBM Plex Sans (`--font-sans`), IBM Plex Mono (`--font-mono`) and Sansation (`--font-display`, used for page titles and sign-in only).
- Icons come from `lucide-react`. Every status pill has an icon (`src/components/status-pill.tsx`, tone → icon, using `STATUS_DISPLAY` and `Tone` in `src/lib/display.ts`).
- Shell: a white 264px sidebar and a sticky top status bar showing Dry run/Live, Sending, AI, Mode and Caller ID on every page. Nav active state, the open-case count badge (`caseCounts` in `src/lib/queries.ts`) and the mobile drawer (under 900px) are in `(app)/shell.tsx`.
- Logos are in `public/brand/` (`tc-logo.png`, `tc-logo-tagline.png`, `tc-logo-white-tagline.png`) and rendered by `src/components/wordmark.tsx` (`variant="sidebar" | "login"`).
- Client components: `(app)/shell.tsx` (nav and drawer), `(app)/selection.tsx` (row tick-boxes and the live "N selected"), `mapping/editor.tsx`, `knowledge/refresh.tsx`, `components/notice.tsx` (dismissible flash notices that strip their URL params), `components/file-drop.tsx` (file input drawn as a drop zone).
- Known trade-off: the dashboard and Cases tables need about 1,250–1,350px, so they scroll sideways below roughly a 1,700px-wide window, as the prototype's `overflow-x:auto` wrapper expects.
- Security headers (`next.config.ts`): `X-Frame-Options: DENY`, `nosniff`, and a strict referrer policy. Server action bodies may be up to 25 MB.

## Status Machine & Validation

**Case status** (`case_status`; portal labels come from `src/lib/display.ts`)

| From | To | Trigger |
|---|---|---|
| (none) | `queued` ("Not contacted") | Daily check (`runDailyCheck`) or dashboard contact (`ensureCase`). The unique key on `(tenant, employee, date)` makes this idempotent. |
| `queued` | `asked` | `askCase` sends WhatsApp, or `placeCaseCall` places a first-contact call. Outside the 24h window WhatsApp uses the approved template; inside it, an interactive option list. If `max_outstanding_questions` is reached, the case stays `queued`. |
| `asked` | `delivered` → `read` | Meta delivery receipts (`applyDeliveryUpdate`). Only ever moves forward. |
| any unanswered | `failed` | Meta reports a delivery failure. |
| any unanswered | `answered` | One of 4 options: 1 absent, 2 was working, 3 leave already applied, 4 regularisation already sent. It can come from a button tap, a digit or exact text (rules), a model classification, or keypad/speech on a call. Guidance is sent, and `follow_up_due_at` (+`follow_up_after_days`) and `call_due_at` (+`call_after_days`) are set. Then the next pending date is asked (`chainNextPending`). |
| `answered` | `awaiting_action` | `actions_enabled`, option 1 or 2, the HRMS supports it, and sending is allowed. The employee is offered "apply it for me" (leave type picked by best balance). |
| `awaiting_action` | `answered` | The employee picks "I'll do it myself", or a pre-check fails (e.g. insufficient balance). |
| `awaiting_action` | `awaiting_approval` | Accepted. An `actions` row is created (idempotency key `type:employee:date`) and an approval is sent to the manager on WhatsApp. |
| `awaiting_approval` | `resolved` | Manager approves. The HRMS executes, and the action becomes `executed`, or `unconfirmed` when no reference comes back. |
| `answered` | `resolved` | Day-2 reminder answered "Done". "Not done" pushes `call_due_at` out by 1 day; "Need help" moves to `needs_hr`. |
| unanswered / `answered` / `needs_hr` | `resolved` (`closed_by_revision`) | Later attendance data shows an explaining meaning (`closeCasesExplainedByData`, run on import and on each check). |
| various | `needs_hr` | Employee asks a question or for help; reply unclear twice (one clarification is allowed first); opt-out (all of their unanswered cases); help requested on a call; manager rejects; no reachable manager; approval timeout; HRMS action failure; or HR clicks "Flag for HR". |
| any | `resolved` / deleted | HR uses `closeCase`, `resetCase` or `resetAllCases`. |

**Design rules**
- Unanswered dates are never reminded. The only nudge is the backlog summary sent after another date is answered.
- Missed calls behave like an ignored message: no retry.
- `cancelled` exists in the enum but nothing sets it.

**Send guards** (`canSend`): tenant `sending_enabled`, no WhatsApp opt-out, a mobile number on file, and outside quiet hours. Calls check `sending_enabled`, `call_opt_out` and a mobile number. Global `DRY_RUN` routes everything to fakes.

**Detection** (`src/lib/detection/run.ts#findGaps`)
- Considers the chased meanings and skips non-working days.
- Excludes entirely: excluded departments or employee codes, new joiners within `exclude_first_days`, and exited employees.
- No mobile and opted-out are only counted as skips: the case is still created, and the send guards then block contact.
- Scheduled runs only contact employees whose effective mode is automatic.
- Contact date = local date minus `contact_lag_days`.

**Reply classification** (`src/lib/conversation/classify.ts`)
- Rules first: option digits, exact option text, and opt-out/help keywords (English and Hindi).
- Otherwise the model gateway classifies. Results below the 0.6 confidence floor get a clarifying question. Model decisions are logged to `ai_decisions`.

**Action status:** `awaiting_approval` → `approved` | `rejected` → `executing` → `executed` | `unconfirmed` | `failed`. `unconfirmed` becomes `executed` through the `verify_action` job. `draft`, `pre_check_failed` and `cancelled` are defined but not set.

**Call status:** `queued` → `ringing` | `simulated` → `in_progress` → `completed` | `failed`, with outcomes `completed_confirmed`, `not_completed`, `needs_help`, `no_answer`, `busy`, `failed`. A call's purpose (`first_contact` vs `follow_up`) comes from the case: answered without a follow-up reply means `follow_up`.

**Validation:** env is checked by Zod at boot. Settings input is clamped (agent voice must be a known voice; pace 0.7–1.3). Mapping save requires `REQUIRED_FIELDS`, upper-cases codes and splits two-session pairs.

## Integrations

| Integration | Code | Config | Notes |
|---|---|---|---|
| WhatsApp (Meta Cloud API, Graph `v23.0`) | `src/lib/channels/meta.ts`, `fake.ts`, `/api/webhook` | `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN` (platform fallbacks); per-tenant `tenant_channels.config` | Real sends happen only when `DRY_RUN=false` and credentials exist; otherwise the in-memory `FakeChannel` is used. The template defaults to `attendance_absent_check` (4 buttons). Inside the 24h window it uses interactive lists and buttons. |
| Plivo voice (keypad calls, inbound line) | `src/lib/voice/plivo.ts`, `xml.ts`, `/api/voice/*`, `/api/plivo/*` | `VOICE_PROVIDER=plivo`, `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER`, `PLIVO_FORWARD_NUMBER`; `tenant_settings.caller_id` | Used when `DRY_RUN=false`; otherwise `FakeVoiceProvider`. `exotel` and `acs` are accepted values with no implementation. |
| LiveKit (spoken "agent" calls) | `src/lib/voice/livekit.ts`, `agent/worker.py`, `/api/agent/turn` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SIP_TRUNK_ID`, `AGENT_API_TOKEN` | Creates a room `attendance-call-<callId>` and dials out over a SIP trunk. Used when the employee or tenant `call_mode='agent'`; otherwise falls back to keypad. The worker uses LiveKit agents with OpenAI, Sarvam and Silero plugins. |
| Model gateway | `src/lib/models/gateway.ts`, `providers.ts`, `budget.ts` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` (Azure OpenAI `https://tc-attendance-aoai.openai.azure.com/openai/v1`; unset means OpenAI itself), `OPENAI_MODEL` (gpt-4.1-mini, an Azure deployment name), `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` (claude-haiku-4-5), `SARVAM_API_KEY` + chat/STT/TTS models | Order: OpenAI → Anthropic → Sarvam, with Sarvam first for Indian languages. A per-tenant `model_overrides` can change it, and a stub fallback answers "unclear". Used for reply classification. WhatsApp and call usage is costed from reported tokens at Azure list price and charged to the `whatsapp` / `call` budget. Once a budget is spent, that feature stops calling the model (no fallback provider) and replies go to HR until a platform admin tops it up. |
| Policy Q&A / RAG | `src/lib/knowledge/index.ts`, `ocr.ts` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | Calls the OpenAI client (Azure OpenAI when `OPENAI_BASE_URL` is set): `text-embedding-3-small` embeddings and `OPENAI_MODEL` answers. Also answers WhatsApp questions. pgvector cosine search is scoped to the tenant. Answers draw only on guideline passages and the caller's own attendance. PDFs are read by MuPDF + Tesseract OCR, not an LLM. |
| Sarvam TTS | `src/lib/voice/say.ts`, `voices.ts` | `SARVAM_API_KEY` | Speaks Plivo call lines in the tenant's chosen voice (14 Indian voices, default `ritu`). Falls back to Plivo `<Speak>`. |
| HRMS | `src/lib/hrms/types.ts`, `mock.ts` | `HRMS_CONNECTOR` (`mock` default, `file`, `rest`, `none`), `MOCK_HRMS_URL` | Only the in-memory `MockHrms` exists; `file` and `rest` fall back to it. The connector declares capabilities (apply leave or regularisation, approve, read status, balances). |
| Azure | `scripts/deploy-azure.sh`, `scripts/azure-db-setup.ts` | `AZURE_RESOURCE_GROUP`, `AZURE_WEBAPP`; App Settings | App Service web app and a shared PostgreSQL Flexible Server. |
| Dev tooling | `scripts/*` | | `retunnel.sh` (Cloudflare tunnel), `verify-preflight.ts`/`verification-code.ts` (Meta number verification), `voices.ts` (voice audition), `demo-flow.ts`/`demo-calls.ts`/`rehearse-call.ts`/`screenshot.ts` (Puppeteer and flow smoke tests). |

`capabilities()` in `env.ts` reports what is live. It is shown on the dashboard, `/admin` and `/api/health`.

## Auth & Permissions

**Sessions** (`src/lib/auth.ts`)
- Email and password (bcrypt) against `users`, with `is_active` required.
- The session is an HS256 JWT in the httpOnly `tc_session` cookie, valid for 12h, signed with `AUTH_SECRET`. The default secret is `dev-only-change-me`.

**Route protection**
- There is no middleware. `(app)/layout.tsx` and every page call `getSession()` and redirect to `/login`.
- Server actions call `requireTenant()`: a session plus an active tenant, otherwise a redirect or an error.

**Tenant scoping**
- Customer users are pinned to their own `tenant_id`.
- Platform admins (`tenant_id` NULL) choose a tenant in the sidebar switcher. The choice is stored in the `tc_tenant` cookie and checked against the DB; if none is chosen, the first active tenant is used.
- All data access goes through `withTenant`, so RLS enforces the boundary whatever the cookie says.

**Roles enforced in code**
- `platform_admin`: sees `/admin` ("All Customers") and the tenant switcher.
- `canManageSettings` (`platform_admin` or `hr_admin`): required to save settings (`updateSettings`) and to `resetAllCases`. For other roles the settings page is read-only.
- Every other page and action is open to any signed-in user of the tenant. `hr_user`, `manager` and `auditor` are not restricted further, and `department_scope` is carried in the session but not applied.

**Machine endpoints**
- Meta webhook: verify token on GET; HMAC signature on POST, checked only when `WA_APP_SECRET` is set.
- `/api/agent/turn`: shared-secret header.
- Plivo callbacks: no signature check. Calls are identified by call UUID; inbound callers by matching their phone number to an employee.

**Dry-run gating:** `simulateReply` and `simulateCallAnswer` throw unless `DRY_RUN` is true.

## Open Issues

- **RLS gap:** `policy_documents` and `policy_passages` (migration 0009) are not in `rls.sql`'s tenant-table list, so they have no row-level security. Isolation there depends on explicit `tenant_id` filters in code.
- **Escalation call clock unused:** `cases.call_due_at` is set, but nothing enqueues `place_call`, and its handler is a stub. `refresh_leave_balances` is never scheduled, and `import_file` is a stub.
- **HRMS:** only `MockHrms` exists (in-memory, per process); `file`/`rest` fall back to it. The `npm run mock-hrms` script points to `tools/mock-hrms/server.ts`, which does not exist.
- **Voice:** `exotel`/`acs` are not implemented. Plivo callbacks are not signature-verified. Inbound calls use one shared number and search every active tenant for the caller.
- **WhatsApp questions:** questions and help requests on WhatsApp go to HR. Policy answering is wired only to voice and the Guidelines test box. The `policy_answers_enabled` and `conversational_replies_enabled` settings are not read anywhere.
- **Roles:** `hr_user`, `manager` and `auditor` have no distinct permissions, and `department_scope` is unenforced.
- **Unused schema:** `audit_log` (never written), `templates`, `policy_packs`/`policy_sources`/`policy_chunks`, `shifts`, `calendars`/`calendar_days`. Some enum values are also never set: case `cancelled`; action `draft`, `pre_check_failed`, `cancelled`.
- **Per-process memory state:** TTS clips, fake channels and the mock HRMS live in memory, so they are not shared across instances.
- **Unwired actions:** `runCheck` and `previewCheck` are not referenced by any page; the dashboard uses `contactSelected`.
