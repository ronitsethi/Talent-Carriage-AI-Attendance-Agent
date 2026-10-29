# Change Log

Entries are appended per session: `### YYYY-MM-DD — <one-line summary>` followed by **What changed**, **Why**, **Where**, and **Technical details** bullets.

### 2026-10-13 — Document the system in CURRENT_STATE.md
- **What changed:** Filled in every section of the system-state document from the code: overview, database, API routes and webhooks, background jobs, pages, case statuses, integrations, sign-in and permissions, and open issues.
- **Why:** The file was created empty with "auto-populate pending" markers, and the documentation rules require it to describe the real system.
- **Where:** `CURRENT_STATE.md`
- **Technical details:** The template's "Edge Functions" section became "API Routes & Webhooks" plus "Background Jobs", because this is a Next.js app with route handlers and an in-process job queue, not Supabase. The open issues recorded include: no RLS on `policy_documents`/`policy_passages`, the escalation call never being placed, and unverified Plivo callbacks.

### 2026-10-13 — Redesign every screen in the Talent Carriage brand
- **What changed:** The whole app now looks like a sibling of the Client Hub: a white sidebar with the colour logo and icons, a status bar on every page, brand blues and greys, IBM Plex and Sansation type, status pills with icons, segmented toggles, a split-screen sign-in page, and reorganised layouts for the dashboard, cases, case detail, mapping, guidelines, settings and admin pages. Nothing the app does has changed: every form, button, action and filter works as before. A few small conveniences came with the design: a live "N selected" count, case counts on the status filter, an open-case count in the nav, Dismiss buttons on messages, drop zones that show the chosen file, and a slide-out menu on phones.
- **Why:** To implement the design handoff in `design_handoff_attendance_agent_redesign/` (high fidelity, no functional changes).
- **Where:** `src/app/globals.css`, `src/app/layout.tsx`, `src/app/login/page.tsx`, `src/app/(app)/layout.tsx`, new `src/app/(app)/shell.tsx`, `src/app/(app)/page.tsx`, `selection.tsx`, `cases/page.tsx`, `cases/[id]/page.tsx`, `mapping/page.tsx`, `mapping/editor.tsx`, `knowledge/page.tsx`, `settings/page.tsx`, `admin/page.tsx`, `src/components/wordmark.tsx`, new `src/components/status-pill.tsx`, `notice.tsx`, `file-drop.tsx`, `src/lib/display.ts`, `src/lib/queries.ts`, `public/brand/`, `package.json`.
- **Technical details:**
  - Replaced the `:root` tokens with the brand guide's drop-in. Kept the existing class names (`.btn`, `.card`, `.pill`, `.switch-group`, `.nav-item`, `.notice`, `.kv`, ...) and restyled them. The root size is 15.3px and nothing is smaller than 13.5px.
  - Fonts now load through `next/font/google` (Plex Sans, Plex Mono, Sansation) as `--font-sans`, `--font-mono` and `--font-display`, replacing the Google Fonts `<link>`. Added `lucide-react` for the nav and pill icons.
  - Swapped `public/brand/` to the supplied `tc-logo*.png` files and removed the four old, unreferenced logos. `Wordmark` takes `variant="sidebar" | "login"` and has no white card any more.
  - The status flags moved from the dashboard banner into the app layout. `Shell`/`Nav` (client) handle the active nav item via `usePathname`, the drawer under 900px (closes on navigation and on Escape) and the open-case badge.
  - New `caseCounts()` in `queries.ts` shares a `caseFilterConditions()` helper with `listCases()` (a behaviour-preserving refactor), so tab counts match what each tab lists.
  - Dashboard: the date-range inputs sit inside the contact form's toolbar but belong to an empty `<form id="range" method="get">` through their `form` attribute, so the range is never posted with the selection. Selected rows are tinted with `tr:has(input[name=target]:checked)`.
  - Cases: the status `<select>` became link tabs plus a hidden `status` input, so the GET filter still carries it.
  - Settings: `sendingEnabled` is still a checkbox (`role="switch"`, drawn with CSS). The row turns red via `:has(:not(:checked))`. `operatingMode` is now radio cards with the same name and values (it was a `<select>`), and `updateSettings` is unchanged.
  - File inputs use `FileDrop`: the real input is laid invisibly over the zone, so `name`, `accept` and `required` are unchanged.
  - Flash messages use `Notice`, which hides itself on Dismiss and removes its query params (`sent`, `blocked`, `problem`, `saved`) with `router.replace`.
  - Checked with `tsc`, `next build`, and a headless-Chrome run against a seeded local database: every page screenshotted at 1440px and 390px, plus selection, contact, range filter, Dismiss, tabs, toggles, the settings save round-trip, the mapping save, sign-out and the admin switcher.
  - `vitest` against the local database: 90 passed, 2 failed. The failures are `tests/calls.test.ts` ("understands the employee speaking…") and `tests/talking-call.test.ts` ("…sweeps the backlog"). Both fail the same way on unmodified HEAD and import nothing this change touched, so they predate it; they most likely need an AI provider key for speech understanding.

### 2026-10-14 — Bring main's AI spending caps into the redesign
- **What changed:** The redesign branch now includes everything added to `main` in the meantime: Azure OpenAI as the model provider, spending caps on WhatsApp and calls, guideline answers over WhatsApp, and clearer errors. The new "AI spending" card on the All customers page is drawn in the new design: amounts in mono, a slim progress bar per budget, a "Used up" pill with an icon, and the top-up form.
- **Why:** Deploying the redesign without these would have undone them on the live site.
- **Where:** `src/app/(app)/admin/page.tsx` (merge conflict resolved), `src/app/globals.css` (`.meter`), `CURRENT_STATE.md` (Database, Routes & Pages, Integrations).
- **Technical details:** `main`'s card used colour variables the new stylesheet no longer defines (`--border-soft`, `--danger-text`, `--accent`), so its inline-styled bar became `.meter` / `.meter.full` on the brand tokens. Checked with `tsc`, `next build` and `vitest` (100 passed; the same 2 voice tests fail as on untouched code). On a local database with migration 0010 applied, topping up $5 took the WhatsApp allowance from $10.00 to $15.00. CURRENT_STATE.md now records `ai_budgets` / `ai_budget_topups`, `OPENAI_BASE_URL` / gpt-4.1-mini on Azure OpenAI, and `topUpAiBudget`.

### 2026-10-27 — Record the Azure footprint and fixed monthly cost
- **What changed:** Added an "Azure footprint" table to the Deploy section of CURRENT_STATE.md: every Azure resource the platform runs on, with its size and approximate fixed monthly cost (about $74/month). Created the missing `Backend-changes.md`.
- **Why:** The user asked for the platform's fixed monthly Azure cost. The state doc did not list the Container Apps voice worker, the container registry, the recordings storage account or the Azure OpenAI deployments.
- **Where:** `CURRENT_STATE.md`, new `Backend-changes.md`.
- **Technical details:** The resources were read with `az` (tenant Default Directory, `rg-client-hub`) and priced from the Azure Retail Prices API (Central India, USD list price, 730 h/month). The Cost Management and consumption APIs returned RBACAccessDenied for this login, so these are list-price estimates, not billed amounts. The Container Apps cost subtracts the monthly free grant. It assumes active-rate billing, because the worker averaged about 47 millicores over 7 days, above the idle threshold. No code or infrastructure was changed.

### 2026-10-27 — Record capacity limits in CURRENT_STATE.md
- **What changed:** Added three open issues: how many calls and chats the current setup handles at once, model calls holding a DB connection, and contacting being serial and done inside the request.
- **Why:** The user asked how far the platform scales, and these are the limits found in the code and the live Azure settings.
- **Where:** `CURRENT_STATE.md` (Open Issues).
- **Technical details:** The limits come from the Azure OpenAI deployment rate limits (`az cognitiveservices account deployment list`), the Postgres `max_connections` setting (50), the container app's size and replica count, and the code paths `src/app/api/webhook/route.ts:82`, `src/app/api/agent/turn/route.ts:279` and `src/app/actions.ts:485`. No code was changed.

### 2026-10-27 — Add the Azure capacity and fixed-cost PDF
- **What changed:** Added `docs/azure-capacity-and-cost.pdf`, a 5-page document. It covers the current Azure setup and its ~$74/month fixed cost, what that setup can handle (2–3 calls at once, ~500 WhatsApp chats an hour), the peak demand for companies of 100 to 1,000,000 employees, and three upgrade steps. Each step lists the resource changes and its fixed cost: Step 1 ~$310, Step 2 ~$950 and Step 3 ~$4,850 a month. It ends with the limits outside Azure (WhatsApp, Plivo, LiveKit, Sarvam).
- **Why:** The user asked for a PDF on fixed costs, the resource upgrades at each step, and what the current setup can do.
- **Where:** `docs/azure-capacity-and-cost.pdf`, `CURRENT_STATE.md` (Other folders).
- **Technical details:** Built with reportlab from a throwaway script (not committed). Prices come from the Azure Retail Prices API (Central India; South India for Azure OpenAI), at list price, before GST and at 730 h/month. P1v3 and P2v3 are taken as 2× and 4× the P0v3 price, because the price API did not return them. The capacity figures use the assumptions printed in the document (5% of employees a day, a 2-hour peak, ~30K tokens a call, ~25K a chat, ~5 calls per voice-worker vCPU).

### 2026-10-26 — Manager approvals, the new first question and the CSV/HRMS switch
- **What changed:** The first question is now I didn't come / I was working / I was on leave / Weekly off-Comp off. Every outcome that needs leave, regularisation, On-Duty or comp-off asks where it stands, and the request goes to the employee's manager to approve. Added a Managers page (Contact by, Call style, Mode per manager, and the approvals waiting) and a Settings switch between a CSV upload and a connected HRMS. A manager's rejection closes the case; an approval closes it or, with an HRMS, applies it.
- **Why:** The user's spec: managers approve only after approving in their own system, the same flow for every apply outcome, and one platform for customers with and without HRMS access.
- **Where:** `src/lib/approvals.ts`, `src/lib/conversation/apply.ts`, `sheet.ts`, `flow.ts`, `outcomes.ts`, `classify.ts`, `talk.ts`, `engine.ts`, `src/app/(app)/managers/page.tsx`, `settings/page.tsx`, `src/app/actions.ts`, `src/db/schema/actions.ts`, `tenants.ts`, `enums.ts`, migrations `0018_manager_approvals.sql`, `0019_reply_intents.sql`, `scripts/create-ticket-templates.ts`.
- **Technical details:** The manager is found from the manager mobile column, else the manager code's own mobile, and kept in `managers`. New taps carry `c2:` payloads; the old template's `case:` taps keep their old meaning. Templates `attendance_absent_v2`, `manager_approval_request` and `approval_outcome` were created on Meta; `manager_approval_request` was cut to 4 variables after Meta refused 6 as too many for its length.

### 2026-10-26 — Manager calls and the keypad version of the flow sheet
- **What changed:** Managers set to Call are rung (press 1 to approve, 2 to reject, or say it), and a missed or undecided call sends the request on WhatsApp. Keypad calls to employees now walk the same flow-sheet menus as WhatsApp.
- **Why:** The user chose a contact medium per manager, and the keypad had to ask the new questions.
- **Where:** `src/lib/voice/approval-calls.ts`, `keypad-sheet.ts`, `session.ts`, `src/lib/conversation/voice-script.ts`, `tests/approval-calls.test.ts`, `tests/calls.test.ts`, `tests/talking-call.test.ts`.
- **Technical details:** The keypad walker reuses `MENUS`/`STEPS` from `sheet.ts` and keeps its place in `case.context.sheet`, so a date half-answered on one channel continues on the other. "Other reason" cannot be typed on a keypad and is noted as such.

### 2026-10-27 — Tell the employee and the manager the decision on WhatsApp only
- **What changed:** After a manager decides, the employee is always told on WhatsApp, whatever their Contact by, and the manager always gets "X has been told on WhatsApp", also after deciding on a call.
- **Why:** The user asked for decision notices to go only by WhatsApp.
- **Where:** `src/lib/approvals.ts`, `scripts/create-ticket-templates.ts`, `tests/approval-calls.test.ts`, `tests/whatsapp-sheet.test.ts`.
- **Technical details:** The note to the manager is free text right after a tap, else the new `approval_noted` template (one variable). Approval requests that fall back from a call to WhatsApp now record the channel as WhatsApp.

### 2026-10-27 — The cost of every case and query, by service
- **What changed:** Each case and query page ends with a Costs card: WhatsApp, AI (Azure OpenAI), Speech (Sarvam), Phone line (Plivo) and Talking calls (LiveKit), each with its subtotal and what made it up. Plivo's own charge is used where it reports one. The voice worker (v14) reports each talking call's length and speech usage.
- **Why:** The user asked for the cost of every call and message, split by service. It went through three layouts on their feedback: inside each transcript, cards under each conversation, then one box per case or query, by service, at the bottom.
- **Where:** new `src/lib/costs/` (`prices.ts`, `record.ts`, `calls.ts`, `plivo.ts`, `summary.ts`), new `src/components/cost-box.tsx`, `src/lib/models/gateway.ts`, `src/lib/knowledge/index.ts`, `src/lib/conversation/talk.ts`, `summary.ts`, `feedback.ts`, `src/lib/tickets.ts`, `src/lib/voice/say.ts`, `resolve.ts`, `src/app/api/webhook/route.ts`, `api/agent/turn/route.ts`, `api/voice/status|recorded|ask|inbound/route.ts`, `src/lib/channels/meta.ts`, `types.ts`, `src/lib/conversation/engine.ts`, `src/lib/jobs/*`, `src/lib/env.ts`, `src/lib/queries.ts`, the case and query pages, `src/app/globals.css`, `agent/worker.py`, migration `0020_cost_lines.sql`, `tests/costs.test.ts`.
- **Technical details:** An `AsyncLocalStorage` cost scope ties model use to the call, message, case or query it was for, written on its own connection without waiting. WhatsApp fees come from Meta's receipt (`messages.pricing`) and the India rate card the user downloaded (₹0.115 utility, effective 1 Oct 2026). LiveKit is priced at the Build plan (₹0), Plivo in INR. Costs start from the 27 Oct deploy; older conversations say so.

### 2026-10-27 — Keep the mapping tests off the editable demo file
- **What changed:** The mapping tests read a copy of the original demo register in `tests/fixtures/` instead of `demo/DEMO_Attendance_data_v1.0.xlsx`.
- **Why:** The user had edited the demo file down to one test row, which broke four mapping tests.
- **Where:** `tests/mapping.test.ts`, new `tests/fixtures/timeoffice-register-august-2026.xlsx`.
- **Technical details:** The fixture is `git show HEAD:demo/DEMO_Attendance_data_v1.0.xlsx`. The edited demo file was left as the user had it and not committed.

### 2026-10-28 — Stop ignoring the recordings route
- **What changed:** `.gitignore` ignores `/recordings/` (the top-level folder of local recordings) instead of every `recordings/` folder, and ignores `__pycache__/`.
- **Why:** The old rule also hid `src/app/api/recordings/`, so the route that serves recordings was never committed.
- **Where:** `.gitignore`.
- **Technical details:** None.

### 2026-10-28 — Bring CURRENT_STATE.md up to date
- **What changed:** Recorded migrations 0011–0020 and the queries, COE/ticket, manager and cost tables; the new routes, jobs, pages, env settings and templates; two new sections, Conversation flow and approvals, and Costs; and four open issues (summaries rewritten on view, Plivo charge unconfirmed live, test caveats, legacy code).
- **Why:** The document still described the platform as of migration 0010.
- **Where:** `CURRENT_STATE.md`.
- **Technical details:** No code was changed.

### 2026-10-28 — Add the Plivo and LiveKit cost PDF
- **What changed:** Added `docs/plivo-livekit-costs.pdf`, a 4-page document on calling costs. It covers how much of the Plivo and LiveKit bills is fixed and how much is per use, the prices used, the cost per call (~INR 2.5) and per employee (~INR 3 a month), the cost at each scaling step (Today ~INR 6,100, Step 1 ~INR 33,700, Step 2 ~INR 3 lakh, Step 3 ~INR 27.8 lakh a month), the Plivo and LiveKit limits to raise at each step, and ways to cut the cost.
- **Why:** The user asked for a separate document on Plivo and LiveKit across the same steps as the Azure PDF, and whether they can be counted as fixed charges.
- **Where:** `docs/plivo-livekit-costs.pdf`, `CURRENT_STATE.md` (Other folders).
- **Technical details:** Built with reportlab from a throwaway script (not committed). Prices come from livekit.com/pricing and plivo.com/voice/pricing/in, checked 27 Oct 2026; the defaults for Plivo's calls per second and calls at once come from Plivo's docs. The cost model is: 5% of employees called per working day, 22 days a month, ~3.5 billed minutes per call on Plivo and ~4 on LiveKit. It flags as unconfirmed whether LiveKit charges agent session minutes for a self-hosted agent (+~INR 3.5 per call if it does).

### 2026-10-28 — Show Plivo's phone charge in rupees
- **What changed:** The Plivo phone line in the cost box now matches Plivo's console: the seconds Plivo billed at ₹0.38 a minute. Lines already saved were corrected.
- **Why:** The user saw ₹0.0047 for a call the Plivo console shows as ₹0.38, and ₹0.017 for one shown as ₹1.33. Plivo's API gives amounts in US dollars even for a rupee account, and they had been stored as rupees.
- **Where:** `src/lib/costs/calls.ts` (`plivoCharged`), `src/lib/costs/plivo.ts`, `src/app/api/voice/status/route.ts`, new migration `0021_plivo_rupees.sql`, `tests/costs.test.ts`, `CURRENT_STATE.md`.
- **Technical details:** Converting the dollar amount at ₹88/$ would have given ₹0.41 and ₹1.50, because Plivo uses its own exchange rate; billed seconds × the rupee rate gives the console's figures exactly. The dollar amount is kept as `detail.plivoUsd`. With `PLIVO_BILLING_CURRENCY=USD` the dollar amount is used as it is. Migration 0021 recomputes saved Plivo lines that carry Plivo's own figure (not estimates) from their billed seconds, sets `app.bypass_rls` for the update because `cost_lines` is under forced RLS, and skips lines already corrected. Tested on a local line (₹0.017 → ₹1.33) and with the two calls from the user's console in `tests/costs.test.ts`.

### 2026-10-28 — Make the AI's repeated prompt cheaper, and price cached tokens correctly
- **What changed:** On calls and chats, the guideline extracts and attendance looked up for a turn now come after the conversation history in the AI's prompt instead of before it, so each turn's prompt starts with the same text as the last one. Token usage now records how much input Azure took from its prompt cache, and both the cost box and the AI spending caps price that part at the cached rate ($0.10 instead of $0.40 per million tokens for gpt-4.1-mini). The cost box notes how many tokens were cached.
- **Why:** The user asked to cut the AI cost of calls (option 3 of the cost review). The fixed rules were already first, but the per-turn look-ups sat before the history, so only the rules could be reused; and every cached token was being counted at the full price.
- **Where:** `src/lib/conversation/talk.ts` (`describe`), `src/lib/models/types.ts` (`cachedInputTokens`, `fromOpenAIUsage`), `src/lib/models/providers.ts`, `src/lib/knowledge/index.ts`, `src/lib/models/budget.ts`, `src/lib/costs/prices.ts`, `src/lib/costs/record.ts`, `src/lib/costs/summary.ts`, `tests/costs.test.ts`.
- **Technical details:** Azure reports cached input as `usage.prompt_tokens_details.cached_tokens`, on streamed replies too (`stream_options.include_usage`). Caching applies automatically from 1,024 identical leading tokens. Cached prices added for every model on the price list.

### 2026-10-29 — Stop the talking-call worker's own discarded AI requests
- **What changed:** The worker no longer lets LiveKit start its own early AI reply on each caller turn.
- **Why:** LiveKit's preemptive generation is on by default; every reply comes from the platform, so those early replies were always discarded but still billed (the "Agent worker's own model" cost line, about ₹0.20 a call).
- **Where:** `agent/worker.py`
- **Technical details:** Added `"preemptive_generation": {"enabled": False}` to `TURN_HANDLING`. Takes effect after the next worker image build and deploy.

### 2026-10-29 — Bulbul v4 Flash voices, and fewer stray words on talking calls
- **What changed:** The agent now speaks with Sarvam's Bulbul v4 Flash. Settings offers five Hinglish voices (Simran, Ishita, Shalini, Sunny, Shubh); existing customers are moved to the one of the same gender. On talking calls, the caller's audio goes through LiveKit's phone noise and background-voice filter. One or two words no longer interrupt the agent. A turn that is only "hmm", "हम्म" or "uh" gets no reply. A turn of one or two words no longer switches the reply language.
- **Why:** v4 Flash costs ₹10 per 10K characters, a third of v3's ₹30. The stray turns came from the caller's murmurs and people in the room being transcribed as words, which cut the agent off, got replies, and switched calls into Hindi. Each one also cost an AI reply and speech.
- **Where:** `agent/worker.py`, `agent/requirements.txt`, `src/lib/voice/voices.ts`, `src/lib/voice/say.ts`, `src/app/api/agent/turn/route.ts`, `src/app/api/voice/inbound/route.ts`, `src/app/api/voice/ask/route.ts`, `src/app/(app)/settings/page.tsx`, `src/lib/costs/prices.ts`, `src/lib/conversation/talk.ts`, `src/db/schema/tenants.ts`, `src/db/migrations/0022_v4_voices.sql`, `scripts/voices.ts`, `tests/talk.test.ts`, `tests/costs.test.ts`, `CURRENT_STATE.md`
- **Technical details:** Worker libraries go to livekit-agents 1.8.8 (1.8.7 is the first Sarvam plugin with v4 Flash), with every plugin pinned to 1.8.8, plus livekit-plugins-noise-cancellation 0.3.2 (`BVCTelephony`, through `room_io.RoomOptions`). Interruption is `mode: "vad"`, `min_words: 3`, `min_duration: 0.8`. LiveKit's "adaptive" detector was left off because it calls LiveKit's hosted inference on every overlap. `is_filler` matches whole turns of sounds only; "haan", "ok", "no", "ji" and "हम" still count. `agentVoice()` maps old v3 names to a v4 voice; the worker's `speaker()` does the same for any name without an underscore. Migration 0022 sets the column default and rewrites stored voices. Worker image v15 was deployed on 2026-10-29 (revision tc-attendance-worker--0000014) with the app, after migration 0022 was run on production. On start, 2 of the 4 pre-started call processes were killed (exit -9, likely memory, since all 4 start at once) and were started again within a second.

### 2026-10-29 — One query per incoming call, a worker that fits its memory, and no language switch on a stray word
- **What changed:** An incoming talking call no longer shows as two queries. The worker keeps one call process ready instead of four, so a call's own process is no longer killed for memory. One Devanagari word in an English sentence no longer switches the reply to Hindi. The worker picks the Bulbul model from the voice, so a mismatched setting can no longer crash a call.
- **Why:** On the first v15 calls, idle memory had gone from about 600 MB to about 850 MB of the 1 GiB limit (four pre-started processes, each holding the VAD and the noise filter). The process answering the 11:50 call was killed (exit -9), LiveKit gave the call to another process 21 seconds later, and that one opened a second query. "तो I would like to know my attendance for the month of September" was answered in Hindi. At 11:39 and 11:43 calls rang out because `AGENT_VOICE_MODEL` was still `bulbul:v3-beta` while the voice was a v4 one (the Azure setting was then changed by hand).
- **Where:** `agent/worker.py`, `src/app/api/agent/turn/route.ts`, `src/lib/conversation/queries.ts`, `src/lib/conversation/talk.ts`, `tests/queries.test.ts`, `tests/talk.test.ts`
- **Technical details:** `WorkerOptions(num_idle_processes=1)`; LiveKit's production default is min(CPUs seen, 4), and it sees the host's CPUs. The inbound greeting sends `ask.room` (the LiveKit room name), stored as `queries.provider_call_id`; `startCallQuery` returns the existing query for the same tenant and `providerCallId`, replacing a greeting-only transcript with the new greeting. `spokenLanguage` only counts a script when at least half the words are in it. `voice_model()` gives v4 Flash for names with an underscore and v3 otherwise. Worker image v16.
