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

## 2026-11-12 21:45
- **Files:** none changed (deploy)
- **Change:** Deployed the multi-date reply fix (`per_date` sorted by code) and the "applied yet?" fix to production; health check passed. No migration.
- **Why:** The faults were live.
- **Impact:** production conversation flow updated; nothing committed yet.

## 2026-11-12 21:30
- **Files:** src/lib/conversation/apply.ts, CURRENT_STATE.md
- **Change:** The "applied yet?" check now only holds back `leave_not_applied` (the model's fallback when someone just says they were on leave); `leave_pending_approval` (they said it is applied) goes straight to the manager again. Checked jumping ahead on the live model across branches: 9 of 10 one-message replies understood in full; the miss only asks a question again.
- **Why:** "I have already applied leave" said at the start should not be asked again.
- **Impact:** none beyond the conversation flow; no migration.

## 2026-11-12 21:00
- **Files:** src/lib/conversation/talk.ts, src/lib/conversation/sheet.ts, src/lib/conversation/apply.ts, src/lib/conversation/multi-date.ts, tests/absence-group.test.ts, CURRENT_STATE.md
- **Change:** Fixed two faults seen live: (1) "I was on leave on 3rd and was working on 4th" put both dates on leave - the model was asked to judge which dates were "the same" and lumped different answers together; it now only lists `per_date` (each date with its own answer, "none" when incomplete) and code sorts same from different (`sortDates`), with worked examples in the prompt and WhatsApp temperature 0.6 → 0.3. Checked against the live model (gpt-4.1-mini), 12/12 runs split correctly. (2) A typed "I was on leave" was told to apply leave without being asked whether it was already applied, because `leave_not_applied` carries a preset stage; on-leave outcomes now count as known only when said (`isOnLeave`), so WhatsApp sends the "applied yet?" buttons and calls ask - the same for other dates in one reply.
- **Why:** Live test: a mixed reply was recorded as leave for both days, and the applied-yet step was skipped.
- **Impact:** conversation model schema changes (`same_dates`/`other_dates` replaced by `per_date`); no migration.

## 2026-11-12 19:00
- **Files:** CURRENT_STATE.md
- **Change:** Production migrated through 0034 (35 migration records; `absence_escalations`, `calls.then_follow_ups`, nullable `employees.preferred_channel` with no 'whatsapp' left) and deployed with one message per person, reminders, escalation, multi-date answers and merged calls. Laptop firewall rule added for the migration and removed afterwards.
- **Why:** Put the new contact flow live.
- **Impact:** reminders and escalation are off (0) for every customer until set in Settings.

## 2026-11-12 18:30
- **Files:** src/db/migrations/0034_absence_reminders.sql (new), src/db/migrations/meta/_journal.json, src/db/schema/{enums,tenants,employees,actions,ops}.ts, src/db/rls.sql, src/lib/conversation/absence-templates.ts (new), src/lib/conversation/absence-group.ts (new), src/lib/conversation/absence-reminders.ts (new), src/lib/conversation/multi-date.ts (new), src/lib/approval-dates.ts (new), src/lib/conversation/{engine,sheet,talk,flow,apply,followup}.ts, src/lib/approvals.ts, src/lib/voice/{session,keypad-sheet,approval-calls}.ts, src/lib/contact.ts, src/lib/upload-send.ts, src/lib/detection/run.ts, src/lib/jobs/{queue,handlers}.ts, src/lib/queries.ts, src/lib/display.ts, src/app/actions.ts, src/app/(app)/{page,settings/page,cases/page,cases/[id]/page,employees/page}.tsx, src/components/{upload-choice,follow-up-contacts}.tsx, scripts/create-ticket-templates.ts, tests/absence-group.test.ts (new), tests/absence-reminders.test.ts (new), tests/{chaining,calls,talking-call,whatsapp-sheet,upload-send}.test.ts, CURRENT_STATE.md
- **Change:** One message or call per person for every unanswered absence, reminders for ignored first contacts, escalation to the manager, multi-date answers, and merged calls. (1) A send lists every unanswered date in one WhatsApp message (`attendance_absent_v3`) or one call naming them all; a tap answers every date its message listed (per-message `g2:` payloads); keypad calls ask "the same for all of these days?". (2) One typed or spoken reply can cover several dates (`same_dates`, `other_dates` in the conversation verdict); each is recorded on its own case, and an application goes to the manager as one request for all of them (`approvals.covers`). (3) Reminders (`attendance_absent_reminder`) every N days by the clock (`absence_watch` job), reset by a new absence message (not counted), nothing at night; after X reminders or Y days the employee is warned (`attendance_absent_escalated` / spoken notice) and the manager gets `manager_no_response` with "I'll speak to them" / "Mark as Loss of Pay"; cases become `escalated` ("With manager"). Manual employees: dashboard shows "Reminder due". (4) Someone due an absence call and follow-up calls gets one call (absences, then follow-ups). (5) Settings: first contact and reminders contact by + call style, remind after (days), reminders before the manager, days before the manager; the outstanding-questions cap is removed. Employee Contact by can now be blank (= customer default), and existing WhatsApp values were cleared to blank. Templates submitted and approved by Meta. Old tests updated for the new opening and oldest-first behaviour; the outstanding-cap tests removed.
- **Why:** Many first messages and calls were ignored and then abandoned, and people with several absences got one message per date; the customer wants one combined message, reminders, and escalation to the manager.
- **Impact:** migration 0034 required (enum value, new columns, `absence_escalations`, `employees.preferred_channel` made nullable with existing 'whatsapp' cleared). New job kind `absence_watch` (clock-driven). New WhatsApp templates `attendance_absent_v3`, `attendance_absent_reminder`, `attendance_absent_escalated`, `manager_no_response` (approved). Conversation verdict schema gains `same_dates` / `other_dates`. Button payload `g2:` added. Reminders/escalation default off (0). No new env var.

## 2026-11-09 15:30
- **Files:** CURRENT_STATE.md
- **Change:** Production migrated through 0033 (34 migration records; the eight leave kinds are in `attendance_meaning`) and deployed with kinds of leave. Laptop firewall rule added for the migration and removed afterwards.
- **Why:** Put leave taken per type and typed leave balances live.
- **Impact:** production `attendance_meaning` enum has the new leave values.

## 2026-11-09 15:10
- **Files:** src/db/migrations/0033_leave_kinds.sql (new), src/db/migrations/meta/_journal.json, src/db/schema/enums.ts, src/db/schema/leave.ts, src/lib/mapping/meanings.ts, src/lib/mapping/presets.ts, src/lib/mapping/analyse.ts, src/lib/leave-types.ts (new), src/lib/leave-balance.ts, src/lib/knowledge/index.ts, src/app/(app)/uploads/page.tsx, src/app/(app)/mapping/page.tsx, src/components/leave-balance-mapping.tsx, tests/leave-types.test.ts (new), tests/mapping.test.ts, CURRENT_STATE.md
- **Change:** Kinds of leave in the code meanings, and leave balances typed through the attendance code table. New meanings: Earned / privilege, Casual, Sick, Maternity, Paternity, Marriage, Bereavement, Other paid leave, each behaving like Leave approved (relabelled "Leave approved (type not given)"). Presets and file analysis now guess CL casual, SL sick, EL/PL earned. The leave balance file's leave types are looked up in the same code table, so the leave name column is not needed: balances are told to the agent as e.g. "Sick leave (SL)"; types not in the table are listed on the upload and added to Codes nobody has explained, types mapped only as Leave approved are pointed out. The agent's attendance now has "Leave taken by type" month by month, from each day's own code (half of a split cell like PL|P is half a day; EL and PL both earned leave count together), and leave days are no longer also listed as whole days by meaning. LEAVE_RULES tell it to set leave taken against the balance of the same type. Mapping test updated: CL in the preset is now Casual leave.
- **Why:** Leave balance files may not carry a leave name, and leave taken per type could not be told because every paid leave was one meaning.
- **Impact:** migration 0033 required (adds values to the `attendance_meaning` enum; add-only). `LeaveReport` gains optional `unexplained` and `untyped`. Leave balance uploads may add rows to `unmapped_codes`. Agent prompt text changes (ATTENDANCE gains leave taken by type). No new env var.

## 2026-11-09 13:40
- **Files:** CURRENT_STATE.md
- **Change:** Production migrated through 0032 (33 migration records) and deployed with Uploads, the Mapping tabs and leave balances. Laptop firewall rule added for the migration and removed afterwards.
- **Why:** Put the leave balance import and the new layout live.
- **Impact:** production schema now has `leave_balance_profiles`, `leave_balance_uploads`, and numeric `leave_balances.balance_days`.

## 2026-11-09 13:20
- **Files:** src/db/migrations/0032_leave_balances.sql (new), src/db/migrations/meta/_journal.json, src/db/schema/leave.ts (new), src/db/schema/employees.ts, src/db/schema/index.ts, src/db/rls.sql, src/lib/leave-balance.ts (new), src/lib/company.ts, src/lib/conversation/talk.ts, src/lib/knowledge/index.ts, src/lib/actions/engine.ts, src/lib/queries.ts, src/lib/payroll.ts, src/app/actions.ts, src/app/(app)/uploads/page.tsx (new), src/app/(app)/mapping/page.tsx, src/app/(app)/month-end/page.tsx, src/app/(app)/shell.tsx, src/components/leave-balance-mapping.tsx (new), src/components/payroll-mapping.tsx, src/components/upload-choice.tsx, src/db/schema/payroll.ts, tests/leave-balance.test.ts (new), CURRENT_STATE.md
- **Change:** Leave balance import, and imports reorganised into three sections. **Uploads** (new, `/uploads`): attendance import (moved from Mapping, with its outcome, the send-or-just-update choice and Recent attendance imports; codes with no meaning now show a notice linking to Mapping) and the new Leave balances upload with its outcome and history. **Month end**: unchanged (lock, payroll, downloads). **Mapping** (renamed from Mapping & import): tabs Attendance, Leave balance, Payroll; attendance import removed from it. Nav: Uploads, Month end, Mapping. Leave balances: a mapping like payroll's (employee code, leave type, balance required; leave name, pending, balance after pending optional; a sample file fills the form, headings matched ignoring case and spacing). An upload is refused for another company (company check) or a file missing a mapped column; otherwise everyone in it has their balances replaced (a leave type no longer listed goes), half days kept. The agent gets the caller's balances as LEAVE BALANCE next to ATTENDANCE and PAYROLL on calls, WhatsApp and the question answerer, with LEAVE_RULES. `leave_balances.balance_days` is now numeric (HRMS balances no longer rounded down).
- **Why:** Leave balances will be uploaded about as often as attendance and used to answer how much leave is left; mapping and imports were scattered across pages.
- **Impact:** migration 0032 required (new tables `leave_balance_profiles`, `leave_balance_uploads`; `leave_balances` column type change and new columns). New server actions `uploadLeaveBalances`, `analyseLeaveFile`, `saveLeaveMapping`, `discardLeaveDraft`; `importAttendance` and `sendAfterUpload` now redirect to `/uploads`. New query `uploadsOverview`, `leaveMappingOverview`. Agent prompts gain LEAVE BALANCE. No new env var.

## 2026-11-09 11:30
- **Files:** src/lib/payroll.ts, src/app/actions.ts, src/app/(app)/month-end/page.tsx, src/db/schema/payroll.ts, tests/payroll.test.ts, CURRENT_STATE.md
- **Change:** Month end can unlock a month's payroll so it can be uploaded again. Admins get an **Unlock payroll** button (with a confirm dialog) on each month with payroll in the Months table. It runs the new `unlockPayroll` action → `removePayroll(tx, tenantId, month)`, which deletes that month's `payroll_uploads` row; its `payroll_rows` go with it through the existing cascade. The attendance lock stays, so the month shows up in the upload's month list again and is preselected there. A notice confirms it. The outcome notice after an upload and the "already uploaded" refusal both point to Unlock payroll.
- **Why:** A wrong payroll file, or one with mistakes, could not be replaced: a month's payroll went in only once.
- **Impact:** new server action `unlockPayroll` (admins). No migration and no new env var. Until a replacement is uploaded, the agent has no salary for that month.

## 2026-11-05 22:45
- **Files:** src/lib/company.ts (new), src/lib/mapping/import.ts, src/app/actions.ts, src/app/(app)/mapping/page.tsx, tests/company.test.ts (new), CURRENT_STATE.md
- **Change:** Attendance and payroll uploads only go into the customer being viewed. The file's company column is found by its heading (Company, Company name, Employer, Organisation, Legal entity, Entity; no mapping), and every name in it must match the viewing customer's name, ignoring case, punctuation and legal-form words (Private Limited, Pvt Ltd, LLP...), with either name allowed to be the shorter form of the other. Otherwise the upload is refused: "<file> is attendance/payroll for <company>, not <customer>. Switch to that customer under Viewing customer, or upload this customer's own file." Attendance: `importAttendanceFile` throws, recorded as a failed import (the notice now says "was not imported" instead of "could not be read"). Payroll: `uploadPayroll` returns the problem. A file with no company column is not checked.
- **Why:** Stop one company's attendance or payroll being uploaded into another customer.
- **Impact:** No migration. A customer whose portal name shares no words with the legal name in its files will have its uploads refused until the name is changed.

## 2026-11-05 21:50
- **Files:** none changed (production database, deploy, git), CURRENT_STATE.md
- **Change:** Applied migration 0031 to production (32 migrations; `payroll_profiles`, `payroll_uploads`, `payroll_rows` present under tenant RLS), through a temporary firewall rule for 122.161.39.143, removed after. Deployed to `tc-attendance-99772` (healthy), then committed and pushed to both repos.
- **Why:** Put Month end, the payroll mapping and upload, the downloads and salary answers live.
- **Impact:** Live. Each customer needs a payroll mapping saved on Mapping & import before payroll can be uploaded.

## 2026-11-05 21:30
- **Files:** src/db/migrations/0031_payroll.sql, src/db/schema/payroll.ts, src/lib/payroll.ts, src/app/actions.ts, src/lib/queries.ts, src/components/payroll-mapping.tsx (new), src/app/(app)/mapping/page.tsx, src/app/(app)/month-end/page.tsx, src/app/globals.css, tests/payroll.test.ts, CURRENT_STATE.md
- **Change:** Payroll now uses a mapping like attendance instead of a confirmation at upload. Mapping & import has a Payroll mapping section (admins): HR types which heading is the employee code, days in the month, paid days, monthly rate, gross, deductions, net and arrears, and ticks the other columns the agent may read (a list of headings not to keep when no sample is known); "Fill in payroll mapping" reads a sample file and fills the form as a draft (`analysePayrollFile`), nothing is used until "Save payroll mapping" (`savePayrollMapping`); a draft can be discarded. Month end's upload (`uploadPayroll`) needs a saved mapping, reads the file with it (headings matched ignoring case and spacing, `resolveMap`), and refuses a file missing a mapped column with which ones. Removed: the "Is this right?" screen, `confirmPayroll`/`cancelPayroll`, and holding the file while waiting. Migration 0031 reshaped before release: `payroll_profiles` gains `columns`, `draft`, `saved_at/by` (`field_map` nullable); `payroll_uploads` loses `status`, `detected`, `source_file` and is unique per month.
- **Why:** The user wants payroll mapped like attendance, not auto-detected and confirmed at upload.
- **Impact:** Migration 0031 changed (not yet applied in production). Actions `confirmPayroll`/`cancelPayroll` removed; `analysePayrollFile`, `savePayrollMapping`, `discardPayrollDraft` added.

## 2026-11-05 20:40
- **Files:** src/db/migrations/0031_payroll.sql, src/db/migrations/meta/_journal.json, src/db/schema/payroll.ts (new), src/db/schema/index.ts, src/db/rls.sql, src/lib/payroll.ts (new), src/app/actions.ts, src/lib/queries.ts, src/app/api/exports/attendance/route.ts (new), src/app/api/exports/payroll/route.ts (new), src/app/(app)/month-end/page.tsx (new), src/app/(app)/shell.tsx, src/app/(app)/settings/page.tsx, src/components/attendance-lock-card.tsx, src/lib/conversation/talk.ts, src/lib/knowledge/index.ts, src/app/globals.css, tests/payroll.test.ts (new)
- **Change:** Payroll upload and the Month end tab. New sidebar page Month end (`/month-end`) holds Lock attendance (moved from Settings; lock actions now return there), the payroll upload, and a Months table with downloads. Payroll: admins only, one file per month, only for a locked month (`payrollRefusal`); a file whose salary month/year columns name another month is refused. Columns are found by their headings (`detectFields`: employee code, days in month, paid days, monthly rate, gross, deductions, net, arrears); on a customer's first upload, or when the headings change, HR confirms them once on a "Is this right?" screen with the columns to keep (`confirmPayroll`; saved in `payroll_profiles`); later uploads with the same headings go straight in. PAN, Aadhaar, bank account, IFSC, UAN and similar are never stored; internal columns (employee cost, Addtax, processing dates, serial no.) are dropped by default. The draft file is held only until confirmed, then cleared. Rows are stored per employee (`payroll_rows`: key figures plus every kept column by heading), matched by employee code, and checked against the locked attendance: paid days vs days not paid (absent = 1, half day = 0.5, unpaid/rejected leave, suspension, not employed), gross vs rate × paid ÷ days, paid > days; shown to HR as warnings with codes not found. The agent (talking calls, WhatsApp, and the question answerer) now also gets the caller's own payroll for the last six uploaded months (`payrollSummary`) and salary rules (`PAYROLL_RULES`): it may state those amounts and explains a lower salary from paid days and the unpaid dates. Downloads: `/api/exports/attendance?month=` (locked months only; register of codes per day with totals and unpaid days) and `/api/exports/payroll?month=` (admins only; kept columns only).
- **Why:** Salary questions need the final attendance and what was actually paid; the user asked for a payroll upload after the lock, one tab holding the lock, the upload and month downloads.
- **Impact:** Migration 0031 required (`payroll_profiles`, `payroll_uploads`, `payroll_rows`, tenant RLS). New actions `uploadPayroll`, `confirmPayroll`, `cancelPayroll`; new routes `/api/exports/attendance`, `/api/exports/payroll`; new page `/month-end`. Agent prompts gain a PAYROLL section and rules.

## 2026-11-05 19:20
- **Files:** src/components/attendance-lock-card.tsx (new), src/components/attendance-lock.tsx, src/app/(app)/settings/page.tsx, src/app/(app)/mapping/page.tsx, src/app/(app)/cases/[id]/page.tsx, src/app/actions.ts, src/app/globals.css, CURRENT_STATE.md
- **Change:** The Lock attendance card moved from Mapping & import to Settings, below the settings form (its own forms, outside that one). Lock, unlock and Send-after-unlock now return to `/settings#attendance-lock`, where the toasts and the Send / Just unlock dialog appear; Settings shows a `problem` notice. The locked case page now says the month is unlocked in Settings. Mapping & import keeps only the import report's "days skipped: attendance is locked" line.
- **Why:** The user wants the lock controls in Settings.
- **Impact:** Redirect targets of `lockAttendance`, `unlockAttendance`, `sendAfterUnlock` changed to /settings. No migration.

## 2026-11-05 19:00
- **Files:** none changed (production database, deploy, git), CURRENT_STATE.md
- **Change:** Applied migration 0030 to production (31 migrations; `call_lines` and `attendance_locks` present, the lock table under tenant RLS), through a temporary firewall rule for 122.161.39.143, removed after. Deployed to `tc-attendance-99772` (healthy), then committed and pushed to both repos.
- **Why:** Put attendance locks and the 3-call limit live.
- **Impact:** Live. From now every call takes one of the 3 shared lines; calls placed before the deploy do not hold one.

## 2026-11-05 18:30
- **Files:** src/lib/voice/lines.ts (new), src/lib/voice/waiting.ts (new), src/lib/voice/session.ts, src/lib/voice/approval-calls.ts, src/lib/contact.ts, src/lib/conversation/followup.ts, src/lib/approvals.ts, src/lib/conversation/queries.ts, src/app/api/agent/turn/route.ts, src/app/api/voice/inbound/route.ts, src/lib/jobs/queue.ts, src/lib/jobs/worker.ts, src/lib/jobs/handlers.ts, src/lib/upload-send.ts, src/app/actions.ts, src/app/(app)/page.tsx, src/app/(app)/cases/page.tsx, src/app/(app)/cases/[id]/page.tsx, tests/setup.ts, tests/calls.test.ts, tests/talking-call.test.ts, tests/upload-send.test.ts, tests/locks.test.ts
- **Change:** No more than 3 calls at once across the whole platform, every kind: first questions, follow-ups, final notices, manager approval calls, and calls employees make to us. A call takes one of the shared lines in `call_lines` (`takeCallLine`, in its own transaction) before it is placed; a line frees itself when its call ends (status completed/failed/simulated or an end time), when an incoming call's query ends, after 2 minutes if the call row never appeared, or after 45 minutes. One number is never rung twice at once. A call that finds every line busy becomes a `waiting_call` job, retried every 15 seconds without spending attempts (`Postpone`), in priority order follow-ups and final notices, then manager calls, then first questions. Sends after an upload or unlock now queue follow-ups and first questions at the same moment, follow-ups first by priority (the old 10-minute gap is gone). An incoming call with every line busy hears "All our lines are busy right now. Please try again in a few minutes." and the call ends (LiveKit greeting returns `done`; the keypad line hangs up). The dashboard, Cases and case page say when calls are waiting for a line. `CALL_LINES` (default 3, max 20) sets the number; the older call tests raise it because they ring one person about every date in one step.
- **Why:** The single LiveKit voice worker carries only ~3 talking calls; extra dialled calls were answered by silence. The user asked for a 3-call limit covering everything, follow-ups first.
- **Impact:** No new required env var (`CALL_LINES` optional, default 3). New job kind `waiting_call`. Voice worker unchanged (it already hangs up on a `done` greeting). To be per customer when LiveKit is upgraded.

## 2026-11-05 18:30
- **Files:** src/db/migrations/0030_attendance_locks.sql, src/db/migrations/meta/_journal.json, src/db/schema/enums.ts, src/db/schema/cases.ts, src/db/schema/locks.ts (new), src/db/schema/index.ts, src/db/schema/mapping.ts, src/db/rls.sql, src/lib/locks.ts (new), src/lib/mapping/import.ts, src/lib/detection/run.ts, src/lib/contact.ts, src/lib/approvals.ts, src/lib/conversation/engine.ts, src/lib/jobs/handlers.ts, src/lib/upload-send.ts, src/lib/queries.ts, src/lib/display.ts, src/app/actions.ts, src/app/(app)/page.tsx, src/app/(app)/cases/page.tsx, src/app/(app)/cases/[id]/page.tsx, src/app/(app)/mapping/page.tsx, src/components/attendance-lock.tsx (new), src/app/globals.css, tests/locks.test.ts (new), tests/import-today.test.ts
- **Change:** Attendance locks. An admin (platform or HR admin) locks a month on Mapping & import (`lockAttendance`); `attendance_locks` holds one row per customer and month. While locked: uploads skip the month's days (report `daysLocked`/`lockedMonths`, notice says so; the file is not rejected); no case is opened in it (`ensureCase`, `runDailyCheck`); nobody is contacted about it (`contactCase` refuses; sends after uploads skip its dates); every case of it still open becomes the new status `unresolved` with where it stood kept in `cases.lock_state` (status, each pending approval's remaining time), shown on a new Unresolved tab with "Attendance locked"; its controls are disabled on the dashboard, Cases and the case page (close/flag/reset refuse it); a never-contacted locked absence stays on the dashboard as Not contacted, disabled. A manager request waiting on a locked case does not time out to HR. A reply after the lock changes nothing: the employee (tapped button, quoted message, or a typed non-question right after a locked question) gets once "Hi X, your attendance for October has been locked, so this can no longer be changed here. Please speak to your manager about it."; a manager deciding a locked request gets once "October's attendance for X (code) has been locked, so no action is needed on this request." Unlocking (`unlockAttendance`, one or more months from a dialog) puts each case back to its status and gives each manager request the time it had left. For a customer on automatic, a dialog then offers "Send" / "Just unlock" with the unopened and follow-up counts (`previewUnlockSend` / `startUnlockSend`, the same planning as after an upload).
- **Why:** Customers need to make a month's attendance final, stop all chasing for it, and be able to undo that.
- **Impact:** Migration 0030 required (new enum value `case_status.unresolved`, `attendance_locks`, `cases.lock_state`, `call_lines`). New actions `lockAttendance`, `unlockAttendance`, `sendAfterUnlock`. New Cases tab `unresolved`.

## 2026-11-05 16:10
- **Files:** none changed (WhatsApp Business account, production database, deploy, git), CURRENT_STATE.md
- **Change:** Created `employee_ticket_raised` (id 39632356449742304) and `employee_ticket_resolved` (id 30291397737113744) on WABA 1185067337113062, both PENDING Meta review. Applied migration 0029 to production (30 migrations; through a temporary firewall rule for 122.161.39.143, removed after). Deployed to `tc-attendance-99772` (healthy), then committed and pushed to both repos.
- **Why:** Put the employee ticket notices, the Queries/Tickets tabs, closing from the portal and follow-up tickets live.
- **Impact:** Live. Until Meta approves the two templates, employee notices outside the 24-hour window fail (the job retries, then goes dead); inside the window they go as plain text.

## 2026-11-05 15:30
- **Files:** src/lib/tickets.ts, src/db/schema/messaging.ts, src/db/migrations/0029_ticket_follow_up.sql, src/db/migrations/meta/_journal.json, src/lib/queries.ts, src/app/(app)/queries/page.tsx, src/app/(app)/queries/[id]/page.tsx, src/app/globals.css, tests/ticket-whatsapp.test.ts
- **Change:** Follow-up tickets. The ticket check is now shown the employee's tickets closed in the 7 days before the query (`recentlyClosed`, up to 5, newest first) and returns `follows_ticket`. When the employee says one of those problems is still not right, a new ticket is raised linked to it (`queries.follows_query_id`, migration 0029): it keeps the earlier type when the model names none, its description starts "Follow-up to TKT-…", and it goes to whoever had the earlier ticket when it closed (`sameHands`); if that was the LT person it goes back to them marked transferred, with no clocks; if that person is no longer on a COE team, the usual least-busy choice is made. The earlier ticket stays closed. The Tickets tab shows "follows TKT-…" under the ticket number, and both ticket pages link to each other.
- **Why:** An employee whose problem is still not right after a ticket closes should get it raised again, to the same person, with the history, instead of it becoming a context-free new query.
- **Impact:** Migration 0029 (`queries.follows_query_id`) required. Ticket prompt and schema gain `follows_ticket`; `raiseTicket` outcome gains `follows`.

## 2026-11-05 15:30
- **Files:** src/lib/conversation/ticket-notices.ts, scripts/create-ticket-templates.ts, tests/ticket-whatsapp.test.ts
- **Change:** The employee's ticket messages no longer carry the ticket number. Raised: "Hi {{1}}, your query has been logged as a ticket. Our team will look into it, and you will be told here once it is resolved." Resolved: "Hi {{1}}, your ticket has been resolved. If anything is still not right, reply here within 7 days and we will raise it again." Both templates now have one variable, the first name.
- **Why:** The ticket number is for the COE team and the portal, not the employee. The resolved message now says how long they have to say it is still not right.
- **Impact:** Templates `employee_ticket_raised` / `employee_ticket_resolved` not yet created; they will be submitted with this wording.

## 2026-11-05 12:20
- **Files:** src/lib/queries.ts, src/app/actions.ts, src/app/(app)/queries/page.tsx, src/app/(app)/queries/[id]/page.tsx, src/app/(app)/selection.tsx, src/app/globals.css, tests/queries.test.ts, tests/ticket-whatsapp.test.ts
- **Change:** The Queries page has two tabs, Queries (default) and Tickets, each with its count under the same filters. Queries lists queries with no ticket (Employee, Date & time, Contact by, Feedback; Call style removed). Tickets lists queries a ticket was raised from: tick box (open tickets only), Employee, Date & time, Contact by, Query type (with ticket number and Open/Resolved under it), Priority, Assigned to, Transferred to LT (Yes/No), Feedback, with a Close selected button and a confirmation. The ticket's own page has a Close ticket button. Both use the new `closeTickets` server action. `listQueries` takes `view` and returns `{ rows, counts }`, with the ticket fields and the assignee's name.
- **Why:** Separate everyday queries from tickets, and let HR close tickets from the portal. A query moves to Tickets as soon as its ticket is raised.
- **Impact:** `listQueries` return shape changed (`{ rows, counts }`). New server action `closeTickets`.

## 2026-11-05 12:20
- **Files:** src/lib/conversation/ticket-notices.ts (new), src/lib/tickets.ts, src/lib/ticket-whatsapp.ts, src/lib/jobs/queue.ts, src/lib/jobs/handlers.ts, scripts/create-ticket-templates.ts, tests/ticket-whatsapp.test.ts
- **Change:** The employee is now told on WhatsApp when a ticket is raised from their query (its number) and when it is closed. New job `ticket_employee` (`{queryId, event: 'raised' | 'resolved'}`, deduped per ticket and event) runs `tellEmployeeAboutTicket`: plain text inside the 24-hour window, else the new templates `employee_ticket_raised` / `employee_ticket_resolved` (variables: first name, ticket number). The message is filed under the query (shows in its chat) without moving `lastActivityAt`, so a later reply starts a new query. Not sent when the ticket's state no longer matches, or sending is blocked for the employee. Every close now goes through `closeTicket()` in `tickets.ts` (COE WhatsApp reply and the portal), which only acts on an open ticket and queues the employee notice.
- **Why:** Employees should know their query became a ticket and when it is resolved.
- **Impact:** New job kind `ticket_employee`; no migration. Templates `employee_ticket_raised` and `employee_ticket_resolved` must be created on WABA 1185067337113062 and approved, or out-of-window notices fail (the job retries, then goes dead).

## 2026-11-05 11:05
- **Files:** none changed (deploy and git)
- **Change:** Deployed the working tree to Azure App Service `tc-attendance-99772` with `npm run deploy` (healthy on `/api/health`), then committed everything as `2f067c0` and pushed `main` to both repos (ronitsethi/Talent-Carriage-AI-Attendance-Agent and AttendanceMaster).
- **Why:** Put the today's-attendance cut-off, the employee phone on COE ticket messages and the no-ticket COE notices live, and get the work since `6eefbb7` into git.
- **Impact:** Live now. Migration 0028 was applied beforehand; no new env vars.

## 2026-11-05 10:00
- **Files:** none in the repo (production database and WhatsApp Business account), CURRENT_STATE.md
- **Change:** Applied migration 0028 (`queries.informed_at`) to the production `attendance` database; it now has 29 migrations. It was run from the laptop with the owner URL from the web app's App Settings, through a firewall rule for 122.161.39.143 that was removed straight after. Created the `coe_query_info` WhatsApp template on WABA 1185067337113062 (id 1616255606101519, status PENDING).
- **Why:** The "for information" notices to COE teams need the column and the template.
- **Impact:** The live app does not use the new column until the new code is deployed; the column is additive, so the running code is unaffected. `coe_query_info` notices fail until Meta approves the template.

## 2026-11-04 17:10
- **Files:** src/lib/ticket-whatsapp.ts, scripts/create-ticket-templates.ts
- **Change:** The `coe_query_info` notice now says the employee "contacted the Attendance assistant" instead of "the HR assistant", both in the template body the script submits to Meta and in the preview logged on the query page.
- **Why:** The assistant is called the Attendance assistant.
- **Impact:** Wording only. `coe_query_info` has not been submitted to Meta yet, so nothing needs re-approval.

## 2026-11-04 16:58
- **Files:** src/lib/tickets.ts, src/lib/ticket-whatsapp.ts, src/lib/jobs/queue.ts, src/lib/jobs/handlers.ts, src/db/schema/messaging.ts, src/db/migrations/0028_query_informed.sql, src/db/migrations/meta/_journal.json, src/app/(app)/queries/[id]/page.tsx, scripts/create-ticket-templates.ts, tests/ticket-whatsapp.test.ts
- **Change:** A query that needs no ticket but was about something real is now shared with its COE team for their information. The ticket prompt asks the model for the query type and a description (what was asked and what they were told) even when no ticket is needed. `raiseTicket` writes the type, COE code and description on the query with no ticket status or number, sets the new `queries.informed_at`, and queues a `query_inform` job. `informCoe` sends the new `coe_query_info` template (employee with phone, company, query type, description; no Resolved button) to every member of that query type's team who looks after the company, logged in `ticket_messages` as kind `info`; nobody is sent it twice. A reply quoting the notice is logged and closes nothing. Nothing is shared when the employee only greeted or tested, the query matched no type, or nobody on that team looks after the company (no other team stands in). The query page shows a "Shared with COE" section with the type, description and who was told.
- **Why:** The COE team should hear about queries the agent settled too, not only the ones that need resolving.
- **Impact:** Migration 0028 (`queries.informed_at`) must run. New job kind `query_inform`. New WhatsApp template `coe_query_info` must be created (`npx tsx scripts/create-ticket-templates.ts <WABA id> coe_query_info`) and approved by Meta; until then these sends fail and show as "not sent" on the query page.

## 2026-11-04 16:58
- **Files:** src/lib/ticket-whatsapp.ts, scripts/create-ticket-templates.ts, tests/ticket-whatsapp.test.ts
- **Change:** Every WhatsApp notice about a ticket (assigned, 36-hour reminder, escalated to the LT person) now gives the employee's phone number with their name and code: `Ankit Panwar (E-1), phone +91 98765 43210`. It goes in the existing employee variable, so the approved templates are unchanged. `dialable()` formats the stored number. The template script's examples show the phone too.
- **Why:** The COE member should be able to ring the employee straight from the ticket message.
- **Impact:** No template change or re-approval needed: the phone rides in variable {{2}}.

## 2026-11-04 16:58
- **Files:** src/lib/mapping/import.ts, src/db/schema/mapping.ts, src/app/(app)/mapping/page.tsx, tests/import-today.test.ts
- **Change:** An attendance upload now leaves out every day dated today or later, in the customer's own timezone (`holdBackFrom` in `import.ts`). The upload is not rejected: employees are still read and earlier days written. The import's date range, day count and meaning counts cover only the kept days; the report carries `daysHeldBack`, and the upload notice says today's attendance was left out (or, when the file held nothing but today, that nothing was imported and to upload it again tomorrow). `importAttendanceFile` takes an optional `today` for tests.
- **Why:** Customers may send a file that runs up to today. Today is not over, so its attendance is not final, and it must not reach the dashboard or the database.
- **Impact:** No migration. `ImportReport.daysHeldBack` is a new optional field in the `imports.report` jsonb. Rows for today written by uploads before this change are not removed.

## 2026-11-03 12:45
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** Removed "Achha." from the English fillers, leaving "Okay." and "Sure.". Hindi is unchanged. Deployed as worker image v21 (revision tc-attendance-worker--0000021); `AGENT_FILLERS` stays `on`.
- **Why:** Requested by the user: on the 12:38 IST test call, in English, the first filler was "Achha.", which sounds Hindi.
- **Impact:** Worker redeploy (v21). No env var, platform or database change.

## 2026-11-03 12:38
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** Fillers are placed as they were before being switched off on 2026-10-27: one before every reply that is not ready when the turn ends, except after a thank-you or goodbye. Removed the limits added today (first slow reply always, short answers skipped, never three in a row, random draw) and the dropping of an "Okay," that opens the reply. The filler no longer waits up to 0.3 s for the platform's pleasantry verdict: it uses the verdict if it is back and the word list if not. Kept the one-word fillers, the audio made in advance and the start the moment the turn ends. Deployed as worker image v20 (revision tc-attendance-worker--0000020); `AGENT_FILLERS` stays `on`.
- **Why:** Requested by the user: the only change wanted from the old fillers was one word instead of a sentence, and the filler should start as fast as possible. On the 12:22 IST call one reply had no filler and the other's waited 0.3 s on the check.
- **Impact:** Worker redeploy (v20). No env var, platform or database change.

## 2026-11-03 12:22
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** A filler is now said the moment the turn ends instead of after a 0.5 s wait, and plays from audio made in the call's voice while the phone rings or the greeting plays, instead of a fresh trip to Sarvam. If that audio is not ready it is said through the voice as before. Up to two replies in a row can have one (never three), and about three in four substantial replies after the first, up from two in three with never two in a row. Speech silence stays at 0.8 s. Deployed as worker image v19 (revision tc-attendance-worker--0000019); `AGENT_FILLERS` stays `on`.
- **Why:** Requested by the user: on the 10:11 IST test call the filler came 1.89 s after they stopped and the next reply, which by the old rule had none, took 2.93 s. Expected now: the filler at about 1.0-1.2 s, on most substantial replies.
- **Impact:** Worker redeploy (v19). Each call makes 7 short Sarvam clips at its start (~30 characters, about ₹0.03), not yet counted in its cost lines. No env var, platform or database change.

## 2026-11-03 09:50
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** Changed when fillers are said. The first slow reply of every call always has one (still not after a thank-you or goodbye). After that, only a reply to a question (a question mark, or a question word such as kab, kitni, क्या, what) or to a turn of 4+ words, never two replies in a row, and about two in three of those at random. One-word answers like "haan", "nahi" or "yes" get none after the first. Each skipped filler is logged with its reason. Deployed as worker image v18 (revision tc-attendance-worker--0000018); `AGENT_FILLERS` stays `on`.
- **Why:** Reported by the user: a test call at 04:05 UTC had no fillers. Both of its replies lost the random draw: with "never two in a row" plus 2 in 3, fillers came on only about 40% of slow replies, and a two-question call had none about 1 time in 9.
- **Impact:** Worker redeploy (v18). No env var, platform or database change.

## 2026-11-03 09:32
- **Files:** agent/worker.py, CURRENT_STATE.md, Backend-changes.md
- **Change:** Fillers are back on talking calls, as one word instead of a sentence: Okay / Sure / Achha in English, जी / अच्छा / ठीक है / हाँ जी in Hindi, the same for every voice. Still only when nothing of the reply has come within 0.5 s and never after a thank-you or goodbye; now also never on two replies in a row and on about two in three of the rest, picked at random. After a filler, a reply opening with an acknowledgement and a comma or stop ("Okay, so...", "जी, आपकी...") loses that word; "Right now" and "Okay so" are kept, and a reply that is only "Okay." is still said. Each word was synthesised in all five voices and transcribed back; Hmm, हम्म, Got it, Alright and Right were left out for how Bulbul said them. Deployed as worker image v17 (revision tc-attendance-worker--0000017) with `AGENT_FILLERS=on`.
- **Why:** Requested by the user, so a caller hears something about 2 s after they stop instead of 3.2 s of silence (measured on incoming calls on 2026-11-02), without fillers on every turn as before.
- **Impact:** Worker redeploy (v17). New use of the existing `AGENT_FILLERS` env var on the Container App, now `on`; setting it to `off` turns fillers off without a rebuild. No platform or database change.

## 2026-11-01 13:15
- **Files:** src/db/migrations/0027_customer_controls.sql, src/db/migrations/meta/_journal.json, src/db/schema/tenants.ts, src/db/schema/ops.ts, src/lib/customers.ts, src/lib/runtime.ts, src/lib/auth.ts, src/lib/channel.ts, src/lib/contact.ts, src/lib/conversation/followup.ts, src/lib/voice/session.ts, src/app/api/webhook/route.ts, src/app/actions.ts, src/app/(app)/admin/page.tsx, src/app/(app)/settings/page.tsx, src/components/follow-up-contacts.tsx, tests/customers.test.ts, tests/follow-ups.test.ts, tests/settings-form.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** All customers has a Status column and Deactivate, Reactivate and Delete buttons. Deactivating stops all contact, replies and the customer's own sign-ins and keeps the data. Delete needs the customer deactivated first and removes everything except the audit log. Settings has a row per follow-up level, below No. of follow-ups, setting Contact by and Call style for the whole customer.
- **Why:** Requested by the user.
- **Impact:** Migration 0027 required, adding `follow_up_contacts` and dropping the `audit_log` foreign key. Migrate first, then deploy: the new code reads the new column. Deleting a customer is permanent.

## 2026-11-01 12:36
- **Files:** src/lib/queries.ts, src/app/(app)/cases/page.tsx, tests/follow-ups.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** A case now enters Follow-up 1 as soon as the employee answers and still has to act, instead of sitting in Answered, and moves to Follow-up 2 when the first follow-up goes. The level is the follow-up the case is waiting for, not how many have gone.
- **Why:** Reported by the user: cases stayed in Answered until a reminder was pressed. This matches the ladder they described originally.
- **Impact:** No migration. Needs a deploy.

## 2026-11-01 12:25
- **Files:** src/lib/queries.ts, src/app/(app)/cases/page.tsx, tests/follow-ups.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** The Cases page now has one Follow-up tab per level, as many as No. of follow-ups, each with its own count, and a new Level column ("1 of 2"). Cases that have had their final follow-up stay in their level's tab while the manager decides, instead of moving to Answered.
- **Why:** Requested by the user, so follow-ups can be separated and filtered by level.
- **Impact:** No migration. Needs a deploy. `caseCounts` now also returns `followUpLevels`, and `listCases` accepts `follow_up_<level>`.

## 2026-11-01 11:48
- **Files:** src/db/migrations/0026_drop_timing_settings.sql, src/db/migrations/meta/_journal.json, src/db/schema/tenants.ts, src/db/schema/cases.ts, src/lib/conversation/flow.ts, src/lib/conversation/engine.ts, src/lib/conversation/followup.ts, src/lib/conversation/follow-up-state.ts, src/lib/conversation/sheet.ts, src/lib/conversation/talk.ts, src/lib/voice/keypad-sheet.ts, src/lib/approvals.ts, src/app/actions.ts, src/app/(app)/settings/page.tsx, tests/follow-ups.test.ts, tests/upload-send.test.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** Removed the Reminder after and Call after settings. Employees are now always told to act by the next day (`DAYS_TO_ACT`), on WhatsApp and on calls. Dashboard follow-ups fall due a day after the answer or the last follow-up. The unused `cases.call_due_at` is gone too.
- **Why:** Requested by the user: No. of follow-ups and the send choices now set the pace, and Call after never did anything.
- **Impact:** Migration 0026 required, and it permanently drops three columns. Deploy first, then migrate: the new code does not read them, while the old code fails without them.

## 2026-11-01 11:16
- **Files:** src/app/(app)/settings/page.tsx, src/app/actions.ts, tests/settings-form.test.ts, Backend-changes.md
- **Change:** Restored two Settings sections deleted by accident when Quiet hours was removed: The talking call (Voice, Speed) and Backlog and escalation (Outstanding questions cap, Reminder after, No. of follow-ups, Call after, Approval timeout, the pending-days summary). Added a note on what Reminder after still does. A setting missing from the form now keeps its fallback instead of saving 0, and a test checks that every field saved has a box on the page.
- **Why:** The removal overran its section, and that version was deployed. While it is live, saving Settings overwrites those values: Reminder after, Call after and Approval timeout become 0, the cap becomes 0, the summary turns off and the voice resets.
- **Impact:** No migration. Needs a deploy. Any customer whose Settings were saved while the broken version was live must have those values re-entered.

## 2026-11-01 10:47
- **Files:** src/lib/upload-send.ts, src/lib/conversation/followup.ts, src/lib/conversation/engine.ts, src/lib/conversation/feedback.ts, src/lib/jobs/handlers.ts, src/lib/display.ts, src/db/migrations/0025_send_delay.sql, src/db/migrations/meta/_journal.json, src/db/schema/tenants.ts, src/db/seed/index.ts, src/app/actions.ts, src/app/(app)/mapping/page.tsx, src/app/(app)/settings/page.tsx, src/app/(app)/cases/page.tsx, src/app/(app)/cases/[id]/page.tsx, tests/upload-send.test.ts, tests/helpers/scenario.ts, CURRENT_STATE.md, Backend-changes.md
- **Change:** The time period after an upload is now a delay: everything starts that many minutes after HR chooses to send (setting "Start sending after (minutes)", 0 to 1440), with follow-ups 10 minutes behind first questions. Quiet hours are removed everywhere, including manual sends, and their Settings section is gone; the columns stay. After uploads, anyone who answered on an earlier day and whose date is still unexplained gets a follow-up with that day's file, one a day, regardless of "Reminder after". Cases show "With the next upload" for these people. Manual mode and "Send due follow-ups" still use "Reminder after".
- **Why:** Requested by the user: the period is a wait, not a spread; quiet hours are not needed yet; and a follow-up goes with the next day's file along with that day's absences. The user chose to keep follow-ups to people who replied.
- **Impact:** Migration 0025 required (renames `send_window_minutes` to `send_delay_minutes`). Queued `query_feedback` jobs no longer retry for quiet hours. `sendDueFollowUps` no longer takes an employee; `sendFollowUpsAfterUpload` does that job. Sends can now go at any hour.

## 2026-11-01 09:10
- **Files:** src/lib/upload-send.ts, src/db/migrations/0024_upload_sending.sql, src/db/schema/tenants.ts, src/lib/detection/run.ts, src/lib/conversation/followup.ts, src/lib/jobs/queue.ts, src/lib/jobs/handlers.ts, src/lib/jobs/scheduler.ts, src/lib/queries.ts, src/app/actions.ts
- **Change:** Removed the `daily_check` and `send_follow_up` jobs and `tenant_settings.check_time`; added `send_window_minutes` (default 60), the `upload_contact` job and the `sendAfterUpload` action. `importAttendance` now redirects with what it settled. `closeCasesExplainedByData` deletes `queued` cases no longer chased and also resolves `awaiting_action` and `awaiting_approval` cases, cancelling the action and expiring its pending approval. `scheduleDueWork` only queues `approval_timeout` and `verify_action`, for every active tenant.
- **Why:** Automatic sending now follows an upload rather than a time of day.
- **Impact:** Migration 0024 required: it drops a column and deletes pending `daily_check` and `send_follow_up` jobs. A customer already on automatic stays on it, under the new meaning. Nothing goes out on a schedule any more. Manual customers now get approval timeouts, so requests unanswered past the timeout move to Needs HR. Follow-ups outside the 24-hour window still need the two Meta templates from the previous change. No new env var or worker change.

## 2026-10-30 14:30
- **Files:** src/db/migrations/0023_follow_up_limit.sql, src/db/schema/tenants.ts, src/db/schema/cases.ts, src/lib/conversation/followup.ts, src/lib/conversation/flow.ts, src/lib/conversation/outcomes.ts, src/lib/conversation/apply.ts, src/lib/conversation/talk.ts, src/lib/conversation/voice-script.ts, src/lib/approvals.ts, src/lib/contact.ts, src/lib/voice/session.ts, src/lib/voice/approval-calls.ts, src/app/api/agent/turn/route.ts, src/lib/queries.ts, src/app/actions.ts, scripts/create-ticket-templates.ts
- **Change:** New `tenant_settings.max_follow_ups` (default 2) and `cases.follow_up_count`. `sendDueFollowUps` now repeats: each send sets the next `follow_up_due_at`, and the last sends the final notice and calls `requestManagerApproval` with the new `overdue` stage. `submitApplication` no longer asks the manager for `not_applied`. Outside the 24-hour window, follow-ups go as new templates `attendance_follow_up` and `attendance_final_notice`. New call purpose `final_notice`: fixed wording, no model, hangs up; a missed one goes on WhatsApp. A refused message is recorded on the case and retried at the next sweep, instead of failing the job.
- **Why:** The configurable follow-ups the user asked for. Follow-ups were also interactive messages, which WhatsApp refuses once the window has closed.
- **Impact:** Migration 0023 required. The migration clears the follow-up clock on cases that already had a follow-up, so the deploy sends them nothing. Two new WhatsApp templates must be created and approved by Meta (`scripts/create-ticket-templates.ts <WABA id> attendance_follow_up attendance_final_notice`) before follow-ups reach anyone outside the window. Until then those sends are refused and retried; ones already in the portal show the error on the case. Behaviour change: managers no longer get the early "has been asked to apply" request. No new env var or worker change.

## 2026-10-30 13:37
- **Files:** src/lib/customers.ts, src/app/actions.ts
- **Change:** New `createCustomer` inserts a `tenants` row (status `active`, slug from the name) and its `tenant_settings` row in one platform-scope transaction. New `addCustomer` server action, for platform admins only, redirects to `/admin` with `added` or `problem`.
- **Why:** Staff need to create customers from the All customers page.
- **Impact:** No migration or env change. No `users` or `tenant_channels` row is created: the customer shares the platform's WhatsApp and phone numbers, and the webhook's check for exactly one `tenant_channels` row is unaffected. Needs an app deploy to go live.

## 2026-10-29 12:20
- **Files:** agent/worker.py, src/app/api/agent/turn/route.ts, src/lib/conversation/queries.ts, src/lib/conversation/talk.ts
- **Change:** Worker keeps 1 idle process (was 4) and chooses the Bulbul model from the voice name. The inbound greeting passes the LiveKit room, and `startCallQuery` reuses the query with the same `providerCallId`. The reply language needs at least half of the words in a script.
- **Why:** Out-of-memory kills of the call process on the 1 GiB worker made LiveKit re-dispatch the call, opening a second query. A stale `AGENT_VOICE_MODEL` crashed calls before answer. One Devanagari word was switching English calls to Hindi.
- **Impact:** New worker image v16 and app deploy. `/api/agent/turn` accepts an optional `ask.room`; older workers that don't send it behave as before. No migration or env change (`AGENT_VOICE`/`AGENT_VOICE_MODEL` on the worker were updated to `simran_enhi_customer`/`bulbul:v4-flash` by hand on 2026-10-29).

## 2026-10-29 11:10
- **Files:** agent/worker.py, agent/requirements.txt, src/lib/voice/voices.ts, src/lib/voice/say.ts, src/app/api/agent/turn/route.ts, src/app/api/voice/inbound/route.ts, src/app/api/voice/ask/route.ts, src/lib/costs/prices.ts, src/lib/conversation/talk.ts, src/db/schema/tenants.ts, src/db/migrations/0022_v4_voices.sql
- **Change:** Bulbul v4 Flash for all agent speech, with five Hinglish voices and old v3 names mapped to them. The worker filters caller audio with LiveKit BVCTelephony, interrupts on 3 words over 0.8 s (VAD mode), and skips filler-only turns. Turns under three words keep the reply language. TTS is priced at ₹10/10K characters for v4 Flash.
- **Why:** A third of the speech cost, and stray transcribed sounds were interrupting the agent, getting replies and switching languages.
- **Impact:** Migration 0022 required (column default plus rewrite of `tenant_settings.agent_voice`). New worker image v15 (livekit-agents 1.8.8 and new noise-cancellation dependency) needs a container app update. The filter adds CPU on the 0.5 vCPU worker; watch it on the first calls. No API or env change.

## 2026-10-29 10:00
- **Files:** agent/worker.py
- **Change:** Turned off LiveKit preemptive generation in TURN_HANDLING.
- **Why:** Its speculative LLM replies were always discarded (replies come from the platform) but still paid for.
- **Impact:** Needs a new worker image (v15) and container app update; no API, schema or env change.

## 2026-10-28 13:58
- **Files:** src/lib/conversation/talk.ts, src/lib/models/types.ts, src/lib/models/providers.ts, src/lib/knowledge/index.ts, src/lib/models/budget.ts, src/lib/costs/prices.ts, src/lib/costs/record.ts, src/lib/costs/summary.ts
- **Change:** The per-turn prompt puts the conversation history before that turn's look-ups, for Azure's prompt cache. Model usage carries `cachedInputTokens`, priced at the cached rate in cost lines and the AI budgets.
- **Why:** Lower and correctly counted AI cost per call.
- **Impact:** No migration, no new env var. AI budgets are now charged less for the same requests (correctly).

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
