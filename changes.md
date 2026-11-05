# Change Log

Entries are appended per session: `### YYYY-MM-DD — <one-line summary>` followed by **What changed**, **Why**, **Where**, and **Technical details** bullets.

## 2026-11-05 19:20
- **Files:** src/components/attendance-lock-card.tsx (new), src/components/attendance-lock.tsx, src/app/(app)/settings/page.tsx, src/app/(app)/mapping/page.tsx, src/app/(app)/cases/[id]/page.tsx, src/app/actions.ts, src/app/globals.css, CURRENT_STATE.md
- **Change:** The Lock attendance card moved from Mapping & import to Settings, below the settings form (its own forms, outside that one). Lock, unlock and Send-after-unlock now return to `/settings#attendance-lock`, where the toasts and the Send / Just unlock dialog appear; Settings shows a `problem` notice. The locked case page now says the month is unlocked in Settings. Mapping & import keeps only the import report's "days skipped: attendance is locked" line.
- **Why:** The user wants the lock controls in Settings.

## 2026-11-05 19:00
- **Files:** none changed (production database, deploy, git), CURRENT_STATE.md
- **Change:** Applied migration 0030 to production (31 migrations; `call_lines` and `attendance_locks` present, the lock table under tenant RLS), through a temporary firewall rule for 122.161.39.143, removed after. Deployed to `tc-attendance-99772` (healthy), then committed and pushed to both repos.
- **Why:** Put attendance locks and the 3-call limit live.

## 2026-11-05 18:35
- **Files:** CURRENT_STATE.md
- **Change:** Listed the lock actions and the Lock attendance card under Routes & Pages.
- **Why:** Keep the state file complete for the attendance-lock work.

## 2026-11-05 18:30
- **Files:** src/lib/voice/lines.ts (new), src/lib/voice/waiting.ts (new), src/lib/voice/session.ts, src/lib/voice/approval-calls.ts, src/lib/contact.ts, src/lib/conversation/followup.ts, src/lib/approvals.ts, src/lib/conversation/queries.ts, src/app/api/agent/turn/route.ts, src/app/api/voice/inbound/route.ts, src/lib/jobs/queue.ts, src/lib/jobs/worker.ts, src/lib/jobs/handlers.ts, src/lib/upload-send.ts, src/app/actions.ts, src/app/(app)/page.tsx, src/app/(app)/cases/page.tsx, src/app/(app)/cases/[id]/page.tsx, tests/setup.ts, tests/calls.test.ts, tests/talking-call.test.ts, tests/upload-send.test.ts, tests/locks.test.ts
- **Change:** No more than 3 calls at once across the whole platform, every kind: first questions, follow-ups, final notices, manager approval calls, and calls employees make to us. A call takes one of the shared lines in `call_lines` (`takeCallLine`, in its own transaction) before it is placed; a line frees itself when its call ends (status completed/failed/simulated or an end time), when an incoming call's query ends, after 2 minutes if the call row never appeared, or after 45 minutes. One number is never rung twice at once. A call that finds every line busy becomes a `waiting_call` job, retried every 15 seconds without spending attempts (`Postpone`), in priority order follow-ups and final notices, then manager calls, then first questions. Sends after an upload or unlock now queue follow-ups and first questions at the same moment, follow-ups first by priority (the old 10-minute gap is gone). An incoming call with every line busy hears "All our lines are busy right now. Please try again in a few minutes." and the call ends (LiveKit greeting returns `done`; the keypad line hangs up). The dashboard, Cases and case page say when calls are waiting for a line. `CALL_LINES` (default 3, max 20) sets the number; the older call tests raise it because they ring one person about every date in one step.
- **Why:** The single LiveKit voice worker carries only ~3 talking calls; extra dialled calls were answered by silence. The user asked for a 3-call limit covering everything, follow-ups first.

## 2026-11-05 18:30
- **Files:** src/db/migrations/0030_attendance_locks.sql, src/db/migrations/meta/_journal.json, src/db/schema/enums.ts, src/db/schema/cases.ts, src/db/schema/locks.ts (new), src/db/schema/index.ts, src/db/schema/mapping.ts, src/db/rls.sql, src/lib/locks.ts (new), src/lib/mapping/import.ts, src/lib/detection/run.ts, src/lib/contact.ts, src/lib/approvals.ts, src/lib/conversation/engine.ts, src/lib/jobs/handlers.ts, src/lib/upload-send.ts, src/lib/queries.ts, src/lib/display.ts, src/app/actions.ts, src/app/(app)/page.tsx, src/app/(app)/cases/page.tsx, src/app/(app)/cases/[id]/page.tsx, src/app/(app)/mapping/page.tsx, src/components/attendance-lock.tsx (new), src/app/globals.css, tests/locks.test.ts (new), tests/import-today.test.ts
- **Change:** Attendance locks. An admin (platform or HR admin) locks a month on Mapping & import (`lockAttendance`); `attendance_locks` holds one row per customer and month. While locked: uploads skip the month's days (report `daysLocked`/`lockedMonths`, notice says so; the file is not rejected); no case is opened in it (`ensureCase`, `runDailyCheck`); nobody is contacted about it (`contactCase` refuses; sends after uploads skip its dates); every case of it still open becomes the new status `unresolved` with where it stood kept in `cases.lock_state` (status, each pending approval's remaining time), shown on a new Unresolved tab with "Attendance locked"; its controls are disabled on the dashboard, Cases and the case page (close/flag/reset refuse it); a never-contacted locked absence stays on the dashboard as Not contacted, disabled. A manager request waiting on a locked case does not time out to HR. A reply after the lock changes nothing: the employee (tapped button, quoted message, or a typed non-question right after a locked question) gets once "Hi X, your attendance for October has been locked, so this can no longer be changed here. Please speak to your manager about it."; a manager deciding a locked request gets once "October's attendance for X (code) has been locked, so no action is needed on this request." Unlocking (`unlockAttendance`, one or more months from a dialog) puts each case back to its status and gives each manager request the time it had left. For a customer on automatic, a dialog then offers "Send" / "Just unlock" with the unopened and follow-up counts (`previewUnlockSend` / `startUnlockSend`, the same planning as after an upload).
- **Why:** Customers need to make a month's attendance final, stop all chasing for it, and be able to undo that.

## 2026-11-05 16:40
- **Files:** CURRENT_STATE.md
- **Change:** Open Issues notes the decided call limit: 3 calls at once platform-wide, to become per customer when LiveKit is upgraded.
- **Why:** The user asked for the per-customer limit to be filed for the LiveKit upgrade.

## 2026-11-05 16:10
- **Files:** none changed (WhatsApp Business account, production database, deploy, git), CURRENT_STATE.md
- **Change:** Created `employee_ticket_raised` (id 39632356449742304) and `employee_ticket_resolved` (id 30291397737113744) on WABA 1185067337113062, both PENDING Meta review. Applied migration 0029 to production (30 migrations; through a temporary firewall rule for 122.161.39.143, removed after). Deployed to `tc-attendance-99772` (healthy), then committed and pushed to both repos.
- **Why:** Put the employee ticket notices, the Queries/Tickets tabs, closing from the portal and follow-up tickets live.

## 2026-11-05 15:30
- **Files:** src/lib/tickets.ts, src/db/schema/messaging.ts, src/db/migrations/0029_ticket_follow_up.sql, src/db/migrations/meta/_journal.json, src/lib/queries.ts, src/app/(app)/queries/page.tsx, src/app/(app)/queries/[id]/page.tsx, src/app/globals.css, tests/ticket-whatsapp.test.ts
- **Change:** Follow-up tickets. The ticket check is now shown the employee's tickets closed in the 7 days before the query (`recentlyClosed`, up to 5, newest first) and returns `follows_ticket`. When the employee says one of those problems is still not right, a new ticket is raised linked to it (`queries.follows_query_id`, migration 0029): it keeps the earlier type when the model names none, its description starts "Follow-up to TKT-…", and it goes to whoever had the earlier ticket when it closed (`sameHands`); if that was the LT person it goes back to them marked transferred, with no clocks; if that person is no longer on a COE team, the usual least-busy choice is made. The earlier ticket stays closed. The Tickets tab shows "follows TKT-…" under the ticket number, and both ticket pages link to each other.
- **Why:** An employee whose problem is still not right after a ticket closes should get it raised again, to the same person, with the history, instead of it becoming a context-free new query.

## 2026-11-05 15:30
- **Files:** src/lib/conversation/ticket-notices.ts, scripts/create-ticket-templates.ts, tests/ticket-whatsapp.test.ts
- **Change:** The employee's ticket messages no longer carry the ticket number. Raised: "Hi {{1}}, your query has been logged as a ticket. Our team will look into it, and you will be told here once it is resolved." Resolved: "Hi {{1}}, your ticket has been resolved. If anything is still not right, reply here within 7 days and we will raise it again." Both templates now have one variable, the first name.
- **Why:** The ticket number is for the COE team and the portal, not the employee. The resolved message now says how long they have to say it is still not right.

## 2026-11-05 12:20
- **Files:** src/lib/queries.ts, src/app/actions.ts, src/app/(app)/queries/page.tsx, src/app/(app)/queries/[id]/page.tsx, src/app/(app)/selection.tsx, src/app/globals.css, tests/queries.test.ts, tests/ticket-whatsapp.test.ts
- **Change:** The Queries page has two tabs, Queries (default) and Tickets, each with its count under the same filters. Queries lists queries with no ticket (Employee, Date & time, Contact by, Feedback; Call style removed). Tickets lists queries a ticket was raised from: tick box (open tickets only), Employee, Date & time, Contact by, Query type (with ticket number and Open/Resolved under it), Priority, Assigned to, Transferred to LT (Yes/No), Feedback, with a Close selected button and a confirmation. The ticket's own page has a Close ticket button. Both use the new `closeTickets` server action. `listQueries` takes `view` and returns `{ rows, counts }`, with the ticket fields and the assignee's name.
- **Why:** Separate everyday queries from tickets, and let HR close tickets from the portal. A query moves to Tickets as soon as its ticket is raised.

## 2026-11-05 12:20
- **Files:** src/lib/conversation/ticket-notices.ts (new), src/lib/tickets.ts, src/lib/ticket-whatsapp.ts, src/lib/jobs/queue.ts, src/lib/jobs/handlers.ts, scripts/create-ticket-templates.ts, tests/ticket-whatsapp.test.ts
- **Change:** The employee is now told on WhatsApp when a ticket is raised from their query (its number) and when it is closed. New job `ticket_employee` (`{queryId, event: 'raised' | 'resolved'}`, deduped per ticket and event) runs `tellEmployeeAboutTicket`: plain text inside the 24-hour window, else the new templates `employee_ticket_raised` / `employee_ticket_resolved` (variables: first name, ticket number). The message is filed under the query (shows in its chat) without moving `lastActivityAt`, so a later reply starts a new query. Not sent when the ticket's state no longer matches, or sending is blocked for the employee. Every close now goes through `closeTicket()` in `tickets.ts` (COE WhatsApp reply and the portal), which only acts on an open ticket and queues the employee notice.
- **Why:** Employees should know their query became a ticket and when it is resolved.

## 2026-11-05 11:05
- **Files:** none changed (deploy and git)
- **Change:** Deployed the working tree to Azure App Service `tc-attendance-99772` with `npm run deploy` (healthy on `/api/health`), then committed everything as `2f067c0` and pushed `main` to both repos (ronitsethi/Talent-Carriage-AI-Attendance-Agent and AttendanceMaster).
- **Why:** Put the today's-attendance cut-off, the employee phone on COE ticket messages and the no-ticket COE notices live, and get the work since `6eefbb7` into git.

## 2026-11-05 10:40
- **Files:** CURRENT_STATE.md
- **Change:** Added an Open Issues entry: the `approval_noted` template is not on the WhatsApp account, what fails without it, and the command to create it. Parked by choice.
- **Why:** Not needed yet; kept on record so it is not forgotten.

## 2026-11-05 10:20
- **Files:** CURRENT_STATE.md
- **Change:** Recorded that Meta approved `coe_query_info` (checked on the WhatsApp Business account; it was PENDING when created).
- **Why:** The state file still said the template was waiting for review.

## 2026-11-05 10:00
- **Files:** none in the repo (production database and WhatsApp Business account), CURRENT_STATE.md
- **Change:** Applied migration 0028 (`queries.informed_at`) to the production `attendance` database; it now has 29 migrations. It was run from the laptop with the owner URL from the web app's App Settings, through a firewall rule for 122.161.39.143 that was removed straight after. Created the `coe_query_info` WhatsApp template on WABA 1185067337113062 (id 1616255606101519, status PENDING).
- **Why:** The "for information" notices to COE teams need the column and the template.

## 2026-11-04 17:10
- **Files:** src/lib/ticket-whatsapp.ts, scripts/create-ticket-templates.ts
- **Change:** The `coe_query_info` notice now says the employee "contacted the Attendance assistant" instead of "the HR assistant", both in the template body the script submits to Meta and in the preview logged on the query page.
- **Why:** The assistant is called the Attendance assistant.

## 2026-11-04 16:58
- **Files:** src/lib/tickets.ts, src/lib/ticket-whatsapp.ts, src/lib/jobs/queue.ts, src/lib/jobs/handlers.ts, src/db/schema/messaging.ts, src/db/migrations/0028_query_informed.sql, src/db/migrations/meta/_journal.json, src/app/(app)/queries/[id]/page.tsx, scripts/create-ticket-templates.ts, tests/ticket-whatsapp.test.ts
- **Change:** A query that needs no ticket but was about something real is now shared with its COE team for their information. The ticket prompt asks the model for the query type and a description (what was asked and what they were told) even when no ticket is needed. `raiseTicket` writes the type, COE code and description on the query with no ticket status or number, sets the new `queries.informed_at`, and queues a `query_inform` job. `informCoe` sends the new `coe_query_info` template (employee with phone, company, query type, description; no Resolved button) to every member of that query type's team who looks after the company, logged in `ticket_messages` as kind `info`; nobody is sent it twice. A reply quoting the notice is logged and closes nothing. Nothing is shared when the employee only greeted or tested, the query matched no type, or nobody on that team looks after the company (no other team stands in). The query page shows a "Shared with COE" section with the type, description and who was told.
- **Why:** The COE team should hear about queries the agent settled too, not only the ones that need resolving.

## 2026-11-04 16:58
- **Files:** src/lib/ticket-whatsapp.ts, scripts/create-ticket-templates.ts, tests/ticket-whatsapp.test.ts
- **Change:** Every WhatsApp notice about a ticket (assigned, 36-hour reminder, escalated to the LT person) now gives the employee's phone number with their name and code: `Ankit Panwar (E-1), phone +91 98765 43210`. It goes in the existing employee variable, so the approved templates are unchanged. `dialable()` formats the stored number. The template script's examples show the phone too.
- **Why:** The COE member should be able to ring the employee straight from the ticket message.

## 2026-11-04 16:58
- **Files:** src/lib/mapping/import.ts, src/db/schema/mapping.ts, src/app/(app)/mapping/page.tsx, tests/import-today.test.ts
- **Change:** An attendance upload now leaves out every day dated today or later, in the customer's own timezone (`holdBackFrom` in `import.ts`). The upload is not rejected: employees are still read and earlier days written. The import's date range, day count and meaning counts cover only the kept days; the report carries `daysHeldBack`, and the upload notice says today's attendance was left out (or, when the file held nothing but today, that nothing was imported and to upload it again tomorrow). `importAttendanceFile` takes an optional `today` for tests.
- **Why:** Customers may send a file that runs up to today. Today is not over, so its attendance is not final, and it must not reach the dashboard or the database.

## 2026-11-04 16:20
- **Files:** .git/config (not tracked), CURRENT_STATE.md
- **Change:** `origin` now has two push URLs: ronitsethi/Talent-Carriage-AI-Attendance-Agent and tcmpludaymoitraoffice-vsa/AttendanceMaster. A plain `git push` updates both; fetch/pull still come only from the ronitsethi repo. The `attendancemaster` remote is kept for fetching or pushing to that repo alone.
- **Why:** Every push should update both repos without a second command.

## 2026-11-04 16:01
- **Files:** .git/config (not tracked), CURRENT_STATE.md
- **Change:** Added a second git remote, `attendancemaster` → https://github.com/tcmpludaymoitraoffice-vsa/AttendanceMaster (private, empty when added). `origin` (ronitsethi/Talent-Carriage-AI-Attendance-Agent) is unchanged. Pushed `main` at `6eefbb7` (committed history only); local `main` still tracks `origin/main`.
- **Why:** The project should also live in the AttendanceMaster repo, alongside the existing one.

## 2026-11-03 14:47
- **Files:** src/app/(app)/layout.tsx
- **Change:** The "Viewing customer" form in the sidebar is keyed on the active customer, so it is drawn again after each switch with the new customer chosen.
- **Why:** After a switch the page showed the new customer but the drop-down still showed the previous one. React 19 resets a form after its action, which put the select back on the option it was first drawn with. Checked in a browser over three switches: before the fix the drop-down stayed on Demo Industries every time; after it, the drop-down matched each customer.

## 2026-11-03 12:58
- **Files:** docs/whatsapp-message-flow.xlsx, CURRENT_STATE.md
- **Change:** Added an Excel workbook of the full WhatsApp message flow: every message from the first question to the case closing (flow-sheet menus, applying, next date, typing and exceptions, follow-ups and final notice, manager approval, the decision to the employee, call feedback and COE tickets), with buttons, the step each reply leads to and the case status. Also tabs for the 20 outcomes and their instructions, the Meta templates, a worked example chat, and wording gaps found on the way. Built from the code, no code changed.
- **Why:** Requested by the user: the full WhatsApp flow from start to end in a sheet.

## 2026-11-03 12:45
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** Removed "Achha." from the English fillers, leaving "Okay." and "Sure.". Hindi is unchanged. Deployed as worker image v21 (revision tc-attendance-worker--0000021); `AGENT_FILLERS` stays `on`.
- **Why:** Requested by the user: on the 12:38 IST test call, in English, the first filler was "Achha.", which sounds Hindi.

## 2026-11-03 12:38
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** Fillers are placed as they were before being switched off on 2026-10-27: one before every reply that is not ready when the turn ends, except after a thank-you or goodbye. Removed the limits added today (first slow reply always, short answers skipped, never three in a row, random draw) and the dropping of an "Okay," that opens the reply. The filler no longer waits up to 0.3 s for the platform's pleasantry verdict: it uses the verdict if it is back and the word list if not. Kept the one-word fillers, the audio made in advance and the start the moment the turn ends. Deployed as worker image v20 (revision tc-attendance-worker--0000020); `AGENT_FILLERS` stays `on`.
- **Why:** Requested by the user: the only change wanted from the old fillers was one word instead of a sentence, and the filler should start as fast as possible. On the 12:22 IST call one reply had no filler and the other's waited 0.3 s on the check.

## 2026-11-03 12:22
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** A filler is now said the moment the turn ends instead of after a 0.5 s wait, and plays from audio made in the call's voice while the phone rings or the greeting plays, instead of a fresh trip to Sarvam. If that audio is not ready it is said through the voice as before. Up to two replies in a row can have one (never three), and about three in four substantial replies after the first, up from two in three with never two in a row. Speech silence stays at 0.8 s. Deployed as worker image v19 (revision tc-attendance-worker--0000019); `AGENT_FILLERS` stays `on`.
- **Why:** Requested by the user: on the 10:11 IST test call the filler came 1.89 s after they stopped and the next reply, which by the old rule had none, took 2.93 s. Expected now: the filler at about 1.0-1.2 s, on most substantial replies.

## 2026-11-03 09:50
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** Changed when fillers are said. The first slow reply of every call always has one (still not after a thank-you or goodbye). After that, only a reply to a question (a question mark, or a question word such as kab, kitni, क्या, what) or to a turn of 4+ words, never two replies in a row, and about two in three of those at random. One-word answers like "haan", "nahi" or "yes" get none after the first. Each skipped filler is logged with its reason. Deployed as worker image v18 (revision tc-attendance-worker--0000018); `AGENT_FILLERS` stays `on`.
- **Why:** Reported by the user: a test call at 04:05 UTC had no fillers. Both of its replies lost the random draw: with "never two in a row" plus 2 in 3, fillers came on only about 40% of slow replies, and a two-question call had none about 1 time in 9.

## 2026-11-03 09:32
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** Fillers are back on talking calls, as one word instead of a sentence: Okay / Sure / Achha in English, जी / अच्छा / ठीक है / हाँ जी in Hindi, the same for every voice. Still only when nothing of the reply has come within 0.5 s and never after a thank-you or goodbye; now also never on two replies in a row and on about two in three of the rest, picked at random. After a filler, a reply opening with an acknowledgement and a comma or stop ("Okay, so...", "जी, आपकी...") loses that word; "Right now" and "Okay so" are kept, and a reply that is only "Okay." is still said. Each word was synthesised in all five voices and transcribed back; Hmm, हम्म, Got it, Alright and Right were left out for how Bulbul said them. Deployed as worker image v17 (revision tc-attendance-worker--0000017) with `AGENT_FILLERS=on`.
- **Why:** Requested by the user, so a caller hears something about 2 s after they stop instead of 3.2 s of silence (measured on incoming calls on 2026-11-02), without fillers on every turn as before.

## 2026-11-01 13:15
- **Files:** src/db/migrations/0027_customer_controls.sql, src/db/migrations/meta/_journal.json, src/db/schema/tenants.ts, src/db/schema/ops.ts, src/lib/customers.ts, src/lib/runtime.ts, src/lib/auth.ts, src/lib/channel.ts, src/lib/contact.ts, src/lib/conversation/followup.ts, src/lib/voice/session.ts, src/app/api/webhook/route.ts, src/app/actions.ts, src/app/(app)/admin/page.tsx, src/app/(app)/settings/page.tsx, src/components/follow-up-contacts.tsx, tests/customers.test.ts, tests/follow-ups.test.ts, tests/settings-form.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** All customers has a Status column and Deactivate, Reactivate and Delete buttons. Deactivating stops all contact, replies and the customer's own sign-ins and keeps the data. Delete needs the customer deactivated first and removes everything except the audit log. Settings has a row per follow-up level, below No. of follow-ups, setting Contact by and Call style for the whole customer.
- **Why:** Requested by the user.

## 2026-11-01 12:36
- **Files:** src/lib/queries.ts, src/app/(app)/cases/page.tsx, tests/follow-ups.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** A case now enters Follow-up 1 as soon as the employee answers and still has to act, instead of sitting in Answered, and moves to Follow-up 2 when the first follow-up goes. The level is the follow-up the case is waiting for, not how many have gone.
- **Why:** Reported by the user: cases stayed in Answered until a reminder was pressed. This matches the ladder they described originally.

## 2026-11-01 12:25
- **Files:** src/lib/queries.ts, src/app/(app)/cases/page.tsx, tests/follow-ups.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** The Cases page now has one Follow-up tab per level, as many as No. of follow-ups, each with its own count, and a new Level column ("1 of 2"). Cases that have had their final follow-up stay in their level's tab while the manager decides, instead of moving to Answered.
- **Why:** Requested by the user, so follow-ups can be separated and filtered by level.

## 2026-11-01 11:48
- **Files:** src/db/migrations/0026_drop_timing_settings.sql, src/db/migrations/meta/_journal.json, src/db/schema/tenants.ts, src/db/schema/cases.ts, src/lib/conversation/flow.ts, src/lib/conversation/engine.ts, src/lib/conversation/followup.ts, src/lib/conversation/follow-up-state.ts, src/lib/conversation/sheet.ts, src/lib/conversation/talk.ts, src/lib/voice/keypad-sheet.ts, src/lib/approvals.ts, src/app/actions.ts, src/app/(app)/settings/page.tsx, tests/follow-ups.test.ts, tests/upload-send.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** Removed the Reminder after and Call after settings. Employees are now always told to act by the next day (`DAYS_TO_ACT`), on WhatsApp and on calls. Dashboard follow-ups fall due a day after the answer or the last follow-up. The unused `cases.call_due_at` is gone too.
- **Why:** Requested by the user: No. of follow-ups and the send choices now set the pace, and Call after never did anything.

## 2026-11-01 11:16
- **Files:** src/app/(app)/settings/page.tsx, src/app/actions.ts, tests/settings-form.test.ts, Backend-changes.md
- **Change:** Restored two Settings sections deleted by accident when Quiet hours was removed: The talking call (Voice, Speed) and Backlog and escalation (Outstanding questions cap, Reminder after, No. of follow-ups, Call after, Approval timeout, the pending-days summary). Added a note on what Reminder after still does. A setting missing from the form now keeps its fallback instead of saving 0, and a test checks that every field saved has a box on the page.
- **Why:** The removal overran its section, and that version was deployed. While it is live, saving Settings overwrites those values: Reminder after, Call after and Approval timeout become 0, the cap becomes 0, the summary turns off and the voice resets.

## 2026-11-01 10:47
- **Files:** src/lib/upload-send.ts, src/lib/conversation/followup.ts, src/lib/conversation/engine.ts, src/lib/conversation/feedback.ts, src/lib/jobs/handlers.ts, src/lib/display.ts, src/db/migrations/0025_send_delay.sql, src/db/migrations/meta/_journal.json, src/db/schema/tenants.ts, src/db/seed/index.ts, src/app/actions.ts, src/app/(app)/mapping/page.tsx, src/app/(app)/settings/page.tsx, src/app/(app)/cases/page.tsx, src/app/(app)/cases/[id]/page.tsx, tests/upload-send.test.ts, tests/helpers/scenario.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** The time period after an upload is now a delay: everything starts that many minutes after HR chooses to send (setting "Start sending after (minutes)", 0 to 1440), with follow-ups 10 minutes behind first questions. Quiet hours are removed everywhere, including manual sends, and their Settings section is gone; the columns stay. After uploads, anyone who answered on an earlier day and whose date is still unexplained gets a follow-up with that day's file, one a day, regardless of "Reminder after". Cases show "With the next upload" for these people. Manual mode and "Send due follow-ups" still use "Reminder after".
- **Why:** Requested by the user: the period is a wait, not a spread; quiet hours are not needed yet; and a follow-up goes with the next day's file along with that day's absences. The user chose to keep follow-ups to people who replied.

## 2026-11-01 09:10
- **Files:** src/lib/upload-send.ts, src/components/upload-choice.tsx, src/db/migrations/0024_upload_sending.sql, src/db/migrations/meta/_journal.json, src/db/schema/tenants.ts, src/db/schema/employees.ts, src/lib/detection/run.ts, src/lib/conversation/followup.ts, src/lib/jobs/queue.ts, src/lib/jobs/handlers.ts, src/lib/jobs/scheduler.ts, src/lib/queries.ts, src/app/actions.ts, src/app/(app)/settings/page.tsx, src/app/(app)/mapping/page.tsx, src/app/(app)/layout.tsx, src/app/(app)/page.tsx, src/app/(app)/admin/page.tsx, src/app/(app)/cases/page.tsx, src/app/(app)/cases/[id]/page.tsx, tests/upload-send.test.ts, tests/calls.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** Automatic now follows an attendance upload instead of the clock. The daily check, its time and the hourly follow-up sweep are gone. Every upload updates attendance, resolves contacted cases the file explains (shown as Resolved with "Action taken" below) and deletes unopened cases it no longer calls for. With Automatic on and CSV upload selected, an alert then asks "Send today's calls/messages" or "Just update attendance data". Sending covers new and old unopened dates and due follow-ups, spread evenly over the new "Send within (minutes)" setting, and leaves out employees set to Manual. Settings: the Daily check section is replaced by Automatic sending and Quiet hours. Approval timeouts now run for every active customer, not only automatic ones.
- **Why:** Requested by the user, so nothing is sent until a new file is uploaded, and an upload settles what the employee has already done.

## 2026-10-30 14:30
- **Files:** src/db/migrations/0023_follow_up_limit.sql, src/db/migrations/meta/_journal.json, src/db/schema/tenants.ts, src/db/schema/cases.ts, src/lib/conversation/followup.ts, src/lib/conversation/flow.ts, src/lib/conversation/outcomes.ts, src/lib/conversation/apply.ts, src/lib/conversation/talk.ts, src/lib/conversation/voice-script.ts, src/lib/approvals.ts, src/lib/contact.ts, src/lib/voice/session.ts, src/lib/voice/approval-calls.ts, src/app/api/agent/turn/route.ts, src/lib/queries.ts, src/lib/display.ts, src/app/actions.ts, src/app/(app)/settings/page.tsx, src/app/(app)/page.tsx, src/app/(app)/cases/[id]/page.tsx, scripts/create-ticket-templates.ts, tests/follow-ups.test.ts, tests/calls.test.ts, tests/talk.test.ts, tests/whatsapp-sheet.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** Settings has a "No. of follow-ups" box (1 to 10, default 2). A date gets that many follow-ups, "Reminder after" days apart, until the action is taken. The last one warns of loss of pay and moves the case to the manager as an Approved / Rejected request, or to HR when the file names no manager. "Not applied yet" no longer asks the manager straight away; the case stays with the employee and the follow-ups run. "Done" or later attendance data resolves the case. The Cases page shows which follow-up a case is on, and a case with the manager shows "With the manager".
- **Why:** Requested by the user. Until now a case that needed an application went to the manager at once and never reached a follow-up, so follow-ups did not run for leave or regularisation.

## 2026-10-30 13:37
- **Files:** src/lib/customers.ts, src/app/actions.ts, src/app/(app)/admin/page.tsx, tests/customers.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** The All customers page has an Add customer button. It opens a one-field form (customer name) that creates the customer with default settings: active, manual mode, sending off. The customers table now has a "Customers (n)" heading. A name already in use, or one with no English letter or number, is refused with a message.
- **Why:** Staff asked to create customers from the portal. Until now a customer could only be added through the seed script. Separate credentials are not needed for now, so no login or WhatsApp/phone config is created.

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

### 2026-10-29 — Voice worker hosting comparison for 10 calls at once
- **What changed:** Added `docs/voice-worker-hosting-10-calls.pdf`. It compares keeping the voice worker on Azure (sized 2 vCPU / 4 GiB) with letting LiveKit host it on the Ship plan, for 10 calls at once and at most 100 calls a day. It covers costs, how they change with volume, trade-offs, what changes where, an all-in monthly budget and the limits to check.
- **Why:** The worker is the largest Azure cost (₹3,307 for 1–29 Oct), and LiveKit is moving to a paid plan anyway.
- **Where:** `docs/voice-worker-hosting-10-calls.pdf`
- **Technical details:** Built with reportlab in the same style as `docs/plivo-livekit-costs.pdf`. Azure rates come from this account's October bill; LiveKit's from livekit.com/pricing and the agent deployment docs (Mumbai `ap-south` region, rolling deploys with a 1-hour drain, warm on paid plans). Result: about ₹13,000 a month hosted against about ₹21,000 on Azure, with break-even near 175 calls a day.

### 2026-10-29 — Shorten the upgrade-cost document to two pages
- **What changed:** Rewrote `docs/voice-worker-hosting-10-calls.pdf` as two pages of tables with no paragraphs. It has one table for each option, listing every resource across LiveKit, Azure and Plivo with today's setup, the upgrade and the monthly cost, followed by cost by calls a day, a short comparison and possible extra costs.
- **Why:** The first version was too long to read; the user asked for upgrade costing only, at most two pages.
- **Where:** `docs/voice-worker-hosting-10-calls.pdf`
- **Technical details:** Same figures as the first version, built with reportlab.

### 2026-10-29 — Upgrade-cost document: today's costs for unchanged resources
- **What changed:** In `docs/voice-worker-hosting-10-calls.pdf`, every resource that stays the same now shows its current monthly cost instead of "No change". The rows are web app ₹1,140, database ₹2,000, Azure OpenAI ₹0 fixed and Plivo number ₹200. Totals now cover every resource: today ₹7,200, option B ~₹16,360, option A ~₹24,320. The calls-a-day table adds LiveKit minutes. The comparison table now says the Azure worker is fixed while the hosted worker is billed per minute, which is why the two options grow differently. The document is still two pages.
- **Why:** The user asked for current costs in place of "No change", and asked why the calls-a-day figures differ.
- **Where:** `docs/voice-worker-hosting-10-calls.pdf`
- **Technical details:** The calls-a-day figures include the ₹3,340 of unchanged resources on both options; the gaps between A and B are unchanged.
