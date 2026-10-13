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
