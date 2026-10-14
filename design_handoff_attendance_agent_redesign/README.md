# Handoff: Attendance Agent redesign (Talent Carriage brand)

## Overview
A visual redesign of every screen in the Attendance Agent web app (`TC-Attendance-agent`, Next.js App Router). **No functionality changes.** Every route, form, action, switch and server call stays as it is; only markup structure, styling and some layout grouping change. The new look follows `TalentCarriage_Brand_Guidelines.md` (included), so the app reads as a sibling of the Client Hub.

Screens covered (all in one prototype file):
1. Login (`src/app/login/page.tsx`)
2. App shell: sidebar + status bar (`src/app/(app)/layout.tsx`, `src/components/wordmark.tsx`)
3. Dashboard (`src/app/(app)/page.tsx`, `selection.tsx`)
4. Follow-up cases (`src/app/(app)/cases/page.tsx`)
5. Case detail (`src/app/(app)/cases/[id]/page.tsx`)
6. Mapping & import (`src/app/(app)/mapping/page.tsx`, `editor.tsx`)
7. Guidelines (`src/app/(app)/knowledge/page.tsx`)
8. Settings (`src/app/(app)/settings/page.tsx`)
9. All customers / admin (`src/app/(app)/admin/page.tsx`)

## About the design files
`Attendance Agent v2.dc.html` is a **design reference built in HTML**: a clickable prototype with mock data that shows the intended look and behaviour. It is not production code. Recreate it in the existing Next.js codebase using its current patterns: server components, server actions, `globals.css` classes and the `SelectionProvider` client context. Keep every existing `action=`, `name=`, form field, hidden input and query param exactly as it is now.

To view it, open the file in a browser (it loads `support.js` from the same folder). Navigate with the sidebar. Sign out to reach Login. The prototype has four tweak props: `dryRun`, `platformAdmin`, `readOnly` and `density`.

## Fidelity
**High fidelity.** Colours, type, spacing, radii and states are final. Match them with the tokens below, which go into `globals.css`. Where the prototype and the brand guide differ on a detail, the brand guide wins.

## Implementation approach
1. Replace the `:root` tokens in `src/app/globals.css` with the brand token block (section *Design tokens*; the brand guide's "Developer drop-in" has the same block). Keep the existing class names (`.btn`, `.card`, `.pill`, `.table`, `.switch`, `.nav-item`, `.field`, `.banner`, etc.) so the page markup barely changes. Restyle the classes; don't rename them.
2. Fonts: in `src/app/layout.tsx`, load IBM Plex Sans (400/500/600/700), IBM Plex Mono (500/600) and Sansation (400/700) through `next/font/google`, and expose them as `--font-sans`, `--font-mono` and `--font-display`.
3. Logos: replace the files in `public/brand/` with the supplied PNGs (see *Assets*). Update `Wordmark` so it renders the colour logo at 40px high in the sidebar and the white logo with tagline on the login panel. Remove the white "card" that sat behind the logo.
4. Status pills: add a Lucide icon to every pill (see *Status pills*). The `lucide-react` package is the simplest way to do this.
5. Go through each page and apply the layout changes described below.

## Design tokens

### Colour
| Token | Hex | Use |
|---|---|---|
| `--primary` | `#1E5AA9` | Primary buttons, active nav bar, active toggle ring, focus outline, on-switch |
| `--primary-hover` | `#123A70` | Primary hover; active nav text; active toggle text |
| `--link` | `#17488A` | Links and blue text |
| `--navy` | `#16437E` | Login panel gradient start, avatar |
| `--navy-2` | `#0E2A52` | Login panel gradient end |
| `--blue-bg` / `--blue-bdr` | `#E8F0FA` / `#C5DAF1` | Active nav background, selected table row, selected settings card |
| `--teal` | `#52B5B5` | Fills only. Never text |
| `--teal-100` / `--teal-200` | `#E4F2F2` / `#B8DEDE` | Outgoing (agent) message bubble fill and border |
| `--ink-900` | `#0E1726` | Headings, input text |
| `--ink-700` | `#26344A` | Default text, labels, table values, nav items |
| `--ink-600` | `#3D4C63` | Body copy and descriptions |
| `--ink-500` | `#56657D` | Metadata: dates, codes, counts, column headers |
| `--ink-400` | `#78869C` | Input and secondary-button borders, dashed drop zones. Never text |
| `--line-200` | `#DDE3EC` | Card edges, toggle-group border |
| `--line-100` | `#ECF0F6` | Rules between rows inside cards |
| `--hover-tint` | `#F1F5F9` | Row hover, secondary-button hover, toggle-group track, conversation background |
| `--surface-50` | `#F8FAFC` | Table headers, save bars, read-only footers |
| `--surface-0` | `#FFFFFF` | Cards, sidebar, top status bar |
| `--canvas` | `#EAEEF4` | Page background |

Status colours (text / background / border):
| State | Text | Bg | Border | Used for |
|---|---|---|---|---|
| Success | `#10653C` | `#E7F4EC` | `#B5DDC5` | Resolved, sending on, automatic, doc ready, success notices |
| Warning | `#7A4205` | `#FDF2E0` | `#EFD3A0` | Answered, offer sent, with the manager, dry-run badge, "Awaiting reply" KPI |
| Error | `#A01B14` | `#FDECEA` | `#F4C2BD` | Needs HR, send failed, sending-off banner, unmapped codes, nav count badge, danger button |
| Info | `#17488A` | `#E8F0FA` | `#C5DAF1` | Asked / delivered / read, AI chip, doc "Reading…" |
| Neutral | `#3D4C63` | `#EEF1F6` | `#D6DDE7` | Not contacted, cancelled, off states, raw code chips |

Status-bar dots: green `#10653C`, amber `#C98A2B`, red `#A01B14`, grey `#78869C`.

### Typography
Root size is **15.3px** (the brand's Compact setting). All sizes below are rendered px.
| Style | Font | Size | Weight | Other |
|---|---|---|---|---|
| Login headline | Sansation | 36 | 700 | lh 1.15, ls −0.4px, white |
| Page title (H1) | Sansation | 28 | 700 | ls −0.4px, `#0E1726` |
| Card title (H2) | Plex Sans | 18 | 600 | `#0E1726` |
| Mapping section title | Plex Sans | 20 | 600 | |
| Body | Plex Sans | 15.3 | 400 | lh 1.6 |
| Secondary body / descriptions | Plex Sans | 14.5 | 400 | `#3D4C63` |
| Labels | Plex Sans | 13.5 | 500 | `#3D4C63`, sits above the field, 6px gap |
| Metadata (the floor) | Plex Sans | 13.5 | 400 | `#56657D` |
| Kicker above H1 | Plex Mono | 13.5 | 500 | uppercase, ls .08em, `#56657D` |
| KPI number | Plex Mono | 30 | 600 | lh 1.1, tabular numerals |
| Codes, phone numbers, file names, webhook URL | Plex Mono | 13.5 | 500 | |

Nothing goes below 13.5px. Sansation is for H1 and the login only. Use sentence case everywhere ("Follow-up cases", "Mapping & import", "All customers").

### Radius
Controls 10px · cards 14px · main action (Sign in) 12px · status pills 8px · toggle buttons 8px · nav badges and the switch 999px · code chips 6px.

### Spacing
Use only these steps: 4, 8, 12, 16, 20, 24, 32, 40, 56. Main content padding is 28px 32px 56px; the content column is capped at 1360px. Card padding is 18–20px, with a 14px gap under card titles. The grid gap between cards is 16px, and there are 22px under the page header.

### Shadows and focus
No shadows on cards or buttons. Focus everywhere is `outline: 3px solid #1E5AA9; outline-offset: 2px` (`:focus-visible`). Checkboxes are 18px with `accent-color: #1E5AA9`.

## Shared components
- **Primary button:** bg and border `#1E5AA9`, white text, 600 weight, radius 10. Hover: bg and border `#123A70`. Heights are 44 in toolbars, 46 in forms, 40 inside table rows, and 50 with radius 12 for Sign in.
- **Secondary button:** white, 1px `#78869C` border, `#26344A` text, 500 weight. Hover: bg `#F1F5F9`.
- **Danger button** (Reset all cases): white, 1px `#A01B14` border and text. Hover: bg `#FDECEA`.
- **Quiet text button** (Remove, Sign out): no border, `#56657D`. Hover: bg `#F1F5F9`, text `#26344A`.
- **Input / select:** height 44 (toolbar) or 46 (form), radius 10, 1px `#78869C` border, white, padding 0 10px, 14.5px text.
- **File drop zone:** 1px dashed `#78869C`, bg `#F8FAFC`, radius 10. Shows a mono format hint (".xlsx .xls .csv") followed by the label.
- **Card:** white, 1px `#DDE3EC`, radius 14, no shadow. Card header rows use `padding:14px 18px` and a bottom border `#DDE3EC`.
- **Segmented toggle** (replaces the old text switches `WhatsApp | Call`, `Keypad | Talk`, `Manual | Auto`, case tabs and date layout): track bg `#F1F5F9`, 1px `#DDE3EC`, radius 10, 2px padding, 2px gap. Each button is 36 high, padding 0 12px, radius 8, 13.5px. Off: transparent, `#3D4C63`, 500. On: white, `#123A70`, 600, `box-shadow: inset 0 0 0 1.5px #1E5AA9`. Keypad/Talk drops to 45% opacity when the channel is WhatsApp; it stays clickable, as today.
- **Status pill:** inline-flex, gap 6, padding 3px 9px, radius 8, 1px border, 13.5px / 600, colours from the status table. It **always has a 15px Lucide icon**: waiting → `clock`, pending → `circle-arrow-right`, done → `circle-check`, needs attention → `circle-alert`, neutral → `circle-minus`. Map statuses with `STATUS_DISPLAY` in `src/lib/display.ts`. Tones: `waiting` = info, `pending` = warning, `done` = success, `call` = error, `idle` = neutral.
- **Code chip** (raw attendance code, e.g. `A|P`): Plex Mono 13.5, padding 2px 7px, radius 6, bg `#EEF1F6`.
- **Tables:** header cells are 13.5px / 500 `#56657D` on `#F8FAFC` with a bottom border `#DDE3EC`. Body cells pad `12px 16px` (comfortable) or `8px 16px` (compact), with a bottom border `#ECF0F6`. Row hover is `#F1F5F9`; selected rows are `#E8F0FA`. The first cell has 16px left padding.
- **Definition lists** (Connections, Case facts): a CSS grid with `auto 1fr` columns and an `8px 16px` gap. Terms are `#56657D`; values are 500.
- **Notices / flash banners:** flex, radius 10, padding 12px 16px, 15.3px / 500, coloured with the success or error tokens and a 1px border, with a "Dismiss" text button on the right.

## Screens

### App shell
- **Sidebar:** 264px fixed, white, 1px right border `#DDE3EC`, sticky at full height.
  - Logo row: colour logo `tc-logo.png` at 40px high, with a mono kicker "ATTENDANCE AGENT" under it. The row has a bottom rule `#ECF0F6` and 20px top padding.
  - Nav items: 48px high, radius 10, padding 0 14px, 14px gap between the 21px icon (Lucide, 1.8 stroke) and the label, 15.3px / 500 in `#26344A`.
  - **Active item:** bg `#E8F0FA`, `inset 4px 0 0 #1E5AA9` left bar, weight 600, text `#123A70`.
  - Icons: Dashboard `layout-dashboard`, Follow-up cases `clipboard-check`, Mapping & import `arrow-left-right`, Guidelines `book-open`, Settings `sliders-horizontal`, All customers `users`.
  - Follow-up cases shows a round count badge (`#A01B14`, white, 13px / 600, min 24×24) with the open-case count.
  - Platform admins see a "Viewing customer" select under the nav (same `switchTenant` action).
  - The footer pins to the bottom with a top rule: a 32px navy (`#16437E`) avatar with initials, the tenant name (600), the user and role line (13.5 `#56657D`), and a "Sign out" text button (same `signOut` form).
- **Top status bar** (new location for the old Dashboard status flags, so they show on every page): sticky, white, bottom border `#DDE3EC`, padding 10px 32px, wraps with a `6px 18px` gap, 13.5px text `#3D4C63`. Each flag is a 7px dot plus its text: Dry run / Live, Sending enabled / off, `AI: <provider>`, Manual / Automatic at HH:MM, "Calls from <caller ID>". Keep the existing `title` tooltips.

### Login
- Two columns, 46fr and 54fr.
- **Left:** `linear-gradient(160deg, #16437E 0%, #0E2A52 100%)`, padding 56, laid out as a column with space-between. It holds the white logo with tagline (200px wide), then the mono kicker "ATTENDANCE AGENT" in `#C5DAF1`, the white Sansation headline "AI attendance follow-up across every customer, in one place.", and the footer "Talent Carriage HR workspace" (13.5 `#C5DAF1`).
- **Right:** white, with the form centred and max 360 wide. "Sign in" in Sansation 28/700, the sub "Sign in to the HR workspace.", an error notice if `?error`, Email and Password fields (48 high), and a full-width primary "Sign in" button (50 high, radius 12). Under a top rule: the seeded-login hint, with the emails in mono.

### Dashboard
1. A sending-off error banner (only when `sendingEnabled` is false), with its existing copy and the Settings link.
2. Header: mono kicker "HR COMMAND CENTER", H1 with the tenant name, then the description paragraph (max 70ch) including the attendance range.
3. **KPI strip:** one white card with an auto-fit grid (min 130px) and 1px dividers. Each cell has padding 16px 18px, a label (13.5 `#56657D`) and a value (Plex Mono 30/600). Awaiting reply is `#7A4205`; Needs HR is `#A01B14` when above 0. The six cells: Total cases, Awaiting reply, Answered, Resolved, Needs HR, Employees.
4. **Flagged table card:**
   - Toolbar: From / To date inputs, a "Show" secondary button, and the count text "N flagged · M not contacted yet". On the right, "N selected" and a primary "Contact selected" button.
   - Columns: checkbox (select-all in the header) · Employee (name 600, then code · dept in meta) · Date (label, then mobile in mono meta) · Attendance (code chip, then meaning in meta) · Status (pill, or "Not contacted" meta) · Contact by (WhatsApp/Call toggle) · Call style (Keypad/Talk toggle) · Mode (Manual/Auto toggle, with the existing title tooltip) · Case ("Open →" secondary button or "Not started").
   - Selected rows get bg `#E8F0FA`.
5. Below, an auto-fit grid (min 320px):
   - **How the agent works** card spanning 2 columns: four numbered steps (mono "01"–"04", title 600, description). The text is the existing four list items, split into a title and a description.
   - **Housekeeping** card: "Send due day-N reminders" (secondary) and "Reset all cases" (danger), plus a meta line explaining the reset.
   - **Connections** card: a definition list.

### Follow-up cases
- Header: kicker "FOLLOW-UP CASES", H1 "Cases", and the existing description.
- One card. Its toolbar holds:
  - a segmented status filter with counts: Open · Needs HR · Resolved · All. These map to the existing `status` query values: open, attention, resolved, all.
  - From and To date inputs.
  - an Employee search box.
  - a "Reset" button and the case count on the right.
- Columns:
  - Employee
  - Absent date (label, then code chip)
  - Status (pill, then the "needs HR" reason in meta)
  - Reply → action (option text, AI chip, "→ action" meta, or "—")
  - Contact by, Call style, Mode (toggles; time in meta under Mode)
  - Actions, right-aligned: "Send now" / "Call now" primary when queued or failed, then "Open →"
- Empty state: centred meta text "No cases match that filter."

### Case detail
- Header: "← All cases" link, then H1 with the employee name, the status pill inline, and a sub line with the date label and meaning.
- Two columns, `1.6fr | minmax(300px,1fr)`, aligned to the top.
- **Left card, Conversation.** Header: "Conversation", with the phone line in mono on the right.
  - Thread: bg `#F1F5F9`, max-height 460 with scroll, 8px gap.
  - Outgoing messages: right-aligned, bg `#E4F2F2`, border `#B8DEDE`, radius 14 with a 4px bottom-right corner.
  - Incoming messages: left-aligned, white, border `#DDE3EC`, 4px bottom-left corner.
  - Options and metadata sit under a hairline in each bubble; metadata is mono 13.5, right-aligned.
- **Simulator** (dry run only), below a top border:
  - a "DRY RUN" warning chip and the simulator title, with the keypad hint for calls.
  - the four options as a 2-column grid of secondary buttons, each with a mono "1–4" / "Press 1–4" prefix.
  - a free-text input and a primary "Send" / "Speak" button.
  - when applicable: manager approval (Approve / Reject), the offer reply, and the day-2 reminder replies.
  - Live mode shows a `#F8FAFC` footer: "Simulation is disabled…".
- **Right column:**
  - **Case** card: definition list, the Needs HR error notice, and the action row (primary send/call/reminder button; Close case, Flag for HR and Reset case as secondary buttons).
  - **Calls** card (only if there are calls or the channel is voice).
  - **Actions** card (only if there are actions).
  - **Also pending** card: the chained dates as links, oldest first.

### Mapping & import
- Header: kicker "MAPPING & IMPORT", then the H1 and description as they are now. Import result notices appear under it.
- Two cards side by side (auto-fit, min 300): **Import attendance** and **Fill the form from a file**. Each has a drop zone and a button; Import is primary and Fill in the form is secondary.
- **Codes nobody has explained** (only when there are unmapped codes): error-tinted header (`#FDECEA`, border `#F4C2BD`, title `#A01B14`). Each row has a code chip, "seen N×", a meaning select and a "Save" button.
- **The mapping for this customer** form card. A header (H2 20px plus description), then four sections. Each section is a `200px | 1fr` grid with the section label on the left (600, with help text under it) and the controls on the right:
  1. *Name*: mapping name and HRMS inputs, side by side.
  2. *How their file lays out the dates*: a segmented toggle (A column for each day / A row for each day), then the day-heading format and year (or the date column), with the year warning. Then the "two halves" separator select.
  3. *What their columns are called*: a two-column bordered grid (We call it | They call it). Required fields carry a "needed" error chip, and notes go under the label. Inputs are in mono.
  4. *What their codes mean*: the explanatory note for two-session cells (shown only when there is a separator), then a bordered grid (Their code 120px | Means | Chase 64px | Remove 84px) and a dashed "+ Add a code" button.
  - Save bar: `#F8FAFC`, with a primary "Save mapping" button and the meta note.
- Below, `1.6fr | 1fr`: a **Recent imports** table (When, Source + mono file, Covering in mono, Result + rejected meta) and a **Layout** definition card.

### Guidelines
- Header: kicker "WHAT THE AGENT KNOWS", then the H1 and description as they are now.
- Two columns, `1.6fr | minmax(300px,1fr)`.
- **Left column:**
  - **Try a question** card: an "Asking as" select, a Question input and an "Ask" primary button in one wrapping row. The answer box is bg `#F1F5F9`, radius 10, with the question in 600 and the answer below.
  - **Documents** card: a header showing "N ready of M". Each row has a 34×40 "PDF" file glyph, the title (600) with "file · date" meta, a topic chip, a status pill (ready → "N passages" success; processing → "Reading…" info; failed → "Could not be read" error) and "Remove". Empty-state text appears when there are no documents.
- **Right column:**
  - **Add a guideline** card: Title and Topic fields, a 104px-tall PDF drop zone, and a full-width primary "Add and read it" button.
- Keep `<KnowledgeRefresh>` polling as it is now.

### Settings
- Header: kicker "SETTINGS", H1 with the tenant name, then the description.
- Two columns, `1.6fr | 1fr`.
- **Left: one form card** with four sections split by `#ECF0F6` rules.
  1. **Master switch row:** the title "Let the agent contact employees" and its existing description. On the right, a 44×24 switch (on `#1E5AA9`, off `#78869C`, white 20px knob). When the switch is off, the row background turns `#FDECEA`. This is still the `sendingEnabled` checkbox; render it as a switch with `role="switch"`.
  2. **Daily check:** Check time, Quiet from and Quiet until inputs. Then "How the agent runs" as **two selectable cards** (Manual / Automatic, each with a one-line description). Off: white with a 1px `#78869C` border. On: `#E8F0FA` with a 2px `#1E5AA9` border. This is still the `operatingMode` radio. The existing help text sits under the cards.
  3. **The talking call:** a "LiveKit connected / not configured" status, the Voice select (Female and Male optgroups), Speed, and the help text.
  4. **Backlog and escalation:** four number fields in an auto-fit grid, the cap explanation, and two checkboxes.
  - Footer: `#F8FAFC` with a primary "Save settings" button, or the read-only sentence for roles that can't edit.
- **Right:** the **Connection** definition card.

### All customers (admin)
- Header: kicker "TALENT CARRIAGE CONSOLE", H1 "All customers", then the description.
- A table card with the same columns as now. The numbers are right-aligned with tabular numerals. Needs HR, Sending, Mode and Actions are pills (error when needs HR is above 0; success when on or automatic; neutral otherwise). The check time goes under Mode.
- A **Platform connections** definition card, max 640 wide.

## Interactions and behaviour
All behaviour stays as it is in the current code. The prototype only mimics it with mock data. Notes:
- Selection (Dashboard) still uses `SelectionProvider`. The header checkbox is select-all, and "N selected" shows the live count.
- Toggles submit their existing server actions (`setChannel`, `setCallMode`, `setOperatingMode` per employee). The visual change is only from text-switch to segmented control.
- Flash messages from `?sent=`, `?notice=` and so on render as notice banners at the top of the content.
- Hover states: row tint `#F1F5F9`; secondary buttons tint; primary buttons darken to `#123A70`; links darken to `#123A70` with an underline. No animations beyond the browser default.
- Density: comfortable rows are 12px vertical cell padding and compact rows are 8px. Optional user setting.
- Responsive: the two-column screens use `minmax(0,…)` tracks and should collapse to one column under about 900px. The sidebar becomes a drawer on mobile, per the brand guide.

## Assets
- `brand/tc-logo.png`: colour logo, no tagline (1069×404). Sidebar header.
- `brand/tc-logo-tagline.png`: colour logo with tagline (1098×501). Documents and footers if needed.
- `brand/tc-logo-white-tagline.png`: white logo with tagline (1098×501). Login navy panel.
- Icons: Lucide (`lucide-react`), 1.8 stroke for nav and 2 for pills.
- Never redraw, recolour or stretch the logo (see the brand guide).

## Files
- `Attendance Agent v2.dc.html`: the hi-fi prototype for all screens. Inline styles are the source of exact values; the logic class at the bottom has the status → tone → icon maps and the mock data.
- `support.js`: runtime needed to open the prototype in a browser.
- `TalentCarriage_Brand_Guidelines.md`: the full brand spec, which wins on identity questions.
- `brand/`: logo files.
