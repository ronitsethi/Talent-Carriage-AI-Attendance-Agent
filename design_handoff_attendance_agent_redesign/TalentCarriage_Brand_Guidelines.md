# TalentCarriage — Brand Guidelines for Digital Platforms

As of 12 Oct 2026

## Purpose and source of truth

Any new Talent Carriage platform should look like a sibling of the Client Hub: Cyan Cobalt Blue `#1E5AA9`, Verdigris teal `#52B5B5`, Sansation for headlines, and the real logo artwork, unchanged.

This guide combines two sources:

- **The official brand PDF:** *Brand Guideline Talent Carriage.pdf* (18 pages: logo, logo misuse, colours, typeface).
- **The live Client Hub design system:** `client-hub/src/app/globals.css`, `src/app/layout.tsx` and `src/lib/brandRules.ts`. The PDF stops at print basics, so this is where the screen colours, type scale, components and contrast rules come from.

Where they disagree, the PDF wins on identity (logo, core colours, typeface). The Client Hub wins on UI detail.

**Brand facts to reuse word for word**

- Name: **Talent Carriage** (legal/short form: TCMPL)
- Tagline: **Imagine Innovate Transform** (no commas, dots or separators)
- Mission: Create shared services that bring best quality and economy of scale to small and mid-size players.
- Vision: Simplify global management practices and make them available to all companies.
- What we do: Talent Carriage moves a client's HR functions into a shared-services model, so they can professionalise and automate HR while cutting costs through an SLA-based model.

## Logo and brand mark

Always use the supplied logo files. Never redraw, recolour or rebuild the logo in code (the Client Hub tried a hand-drawn SVG once and deleted it).

**Anatomy.** A circle split in two: the top half is horizontal Verdigris teal stripes, the bottom half is solid Cyan Cobalt Blue. To its right, the wordmark "Talent" sits in teal over "Carriage" in blue. The tagline version adds "Imagine Innovate Transform" in blue underneath.

**Approved variants (brand PDF p. 02-0 and 02-1)**

| Variant | Use it on | File |
| --- | --- | --- |
| Colour, no tagline | White or very light backgrounds; app headers and sidebars | `Logo FIles/Talent Carriage@3x.png` (1069 × 404) |
| Colour, with tagline | Login pages, marketing pages, footers, documents | `Logo FIles/Logo with tagline@3x.png` (1098 × 501) |
| White, with tagline | Dark, navy or photo backgrounds (e.g. the sign-in panel) | `Logo FIles/White@3x.png` (1098 × 501) |
| Black | One-colour print and fax only | Shown in the PDF; no separate file supplied yet |
| Logo mark (circle only) | Favicon, app icon, collapsed nav rail, avatar slots | `client-hub/public/brand/logo-mark.png`; favicon = `client-hub/src/app/icon.png` (256 × 256) |
| Vector master | Print and anything larger than the PNGs | `Logo FIles/Logo Pdf.pdf` |

**App icon.** Place the mark centred on a rounded square: colour mark on white, white mark on black, or black mark on white (PDF p. 02-1).

**On photos or busy backgrounds**, use the all-white logo (PDF p. 02-3).

**Clear space.** Keep an empty margin around the whole lockup on all four sides (PDF p. 02-2). Nothing else (text, edges, other logos) goes inside it.

**Never** (PDF p. 03-0):

- stretch or squash it
- change the proportion between the mark and the wordmark
- change the distance between the mark and the wordmark
- move or rearrange any part of it
- add outlines or strokes
- rotate it

## Colour palette

Blue leads, teal accents, and neutrals carry most of each screen. The brand has four official colours. The Client Hub adds tints, shades and greys so the screen palette meets WCAG AA contrast.

**Typo warning:** the brand PDF prints Verdigris as `#B55252`. That is a red, and it is wrong. The PDF's own RGB values (82, 181, 181) and swatch both give **`#52B5B5`**. Never use `#B55252`.

**Official brand colours (PDF p. 04-0)**

| Name | Hex | RGB | Role |
| --- | --- | --- | --- |
| Cyan Cobalt Blue | `#1E5AA9` | 30, 90, 169 | Primary. Buttons, active nav, focus ring, key highlights |
| Verdigris | `#52B5B5` | 82, 181, 181 | Accent. Fills, charts, illustrations, the logo's stripes |
| Black | `#000000` | 0, 0, 0 | Logo (one-colour version) only. Not used for on-screen text |
| White | `#FFFFFF` | 255, 255, 255 | Backgrounds, text on blue or navy |

**Blues and teals for screens**

| Token | Hex | Use | Contrast |
| --- | --- | --- | --- |
| `--primary` | `#1E5AA9` | Primary fills, active nav, focus outline | White text on it: 6.79:1 |
| `--primary-hover` | `#123A70` | Hover and pressed state of primary fills | — |
| `--link` | `#17488A` | Blue used as text: links, row actions | 9.01:1 on white |
| `--navy` | `#16437E` | Sign-in panel, avatars, dark brand surfaces | White on it: 9.82:1 |
| `--navy-2` | `#0E2A52` | Deepest navy, second stop in dark panels | — |
| `--blue-bg` | `#E8F0FA` | Light blue tint: info banners, selected rows | — |
| `--blue-bdr` | `#C5DAF1` | Border paired with `--blue-bg` | — |
| `--teal` | `#52B5B5` | Teal fills and graphics only | 2.43:1. **Never use as text** |
| `--teal-800` | `#185C5C` | Teal used as text (e.g. a "Saved" state) | 7.71:1 on white |
| `--teal-100` | `#E4F2F2` | Light teal tint background | — |
| `--teal-200` | `#B8DEDE` | Border paired with `--teal-100` | — |

**Neutrals**

| Token | Hex | Use | Contrast on white |
| --- | --- | --- | --- |
| `--ink-900` | `#0E1726` | Headings, the name of a thing | 17.96:1 |
| `--ink-700` | `#26344A` | Labels, nav items, button text, table values | 12.56:1 |
| `--ink-600` | `#3D4C63` | Body copy and descriptions | 8.71:1 |
| `--ink-500` | `#56657D` | Metadata only: dates, sizes, reference numbers | 5.91:1 |
| `--ink-400` | `#78869C` | Control borders and placeholders. Not for text | 3.69:1 |
| `--line-200` | `#DDE3EC` | Card and panel edges | — |
| `--line-100` | `#ECF0F6` | Rules between rows inside a card | — |
| `--hover-tint` | `#F1F5F9` | Row and secondary-button hover | — |
| `--surface-50` | `#F8FAFC` | Table headers, save bars | — |
| `--surface-0` | `#FFFFFF` | Cards and panels | — |
| `--canvas` | `#EAEEF4` | Page background behind cards | — |

**Status colours.** Each state is a text colour, a tint and a border, always shown with an icon and a word.

| State | Text | Background | Border |
| --- | --- | --- | --- |
| Success | `#10653C` | `#E7F4EC` | `#B5DDC5` |
| Warning | `#7A4205` | `#FDF2E0` | `#EFD3A0` |
| Error | `#A01B14` | `#FDECEA` | `#F4C2BD` |
| Info | `#17488A` | `#E8F0FA` | `#C5DAF1` |
| Neutral | `#3D4C63` | `#EEF1F6` | `#D6DDE7` |
| Brand / saved (teal) | `#185C5C` | `#E4F2F2` | `#B8DEDE` |

## Typography

Sansation is the brand typeface (PDF p. 05-0) and is used for headlines. IBM Plex Sans handles the interface, and IBM Plex Mono handles figures.

| Font | Role | Weights | Rules |
| --- | --- | --- | --- |
| **Sansation** ([Google Fonts](https://fonts.google.com/specimen/Sansation)) | Display text, page titles, brand lockups | 300, 400, 700 only (there is no 500 or 600) | 28px or larger, usually 700. Never for labels, buttons or numbers in tables |
| **IBM Plex Sans** | All UI text: body, labels, buttons, nav, H2 and below | 400, 500, 600, 700 | The workhorse. 600 for labels and buttons |
| **IBM Plex Mono** | Figures: amounts, IDs, dates in tables | 500, 600 | Tabular numerals (`font-feature-settings: "tnum"`), 15px or larger |

Only Sansation comes from the brand PDF. Plex Sans and Plex Mono are Client Hub choices, made because Sansation has no medium or semibold weight for dense UI. Reuse them so both platforms read the same.

**Type scale** (pixel sizes at a 17px root; the Client Hub sets everything in `rem`)

| Style | Size | Weight | Line height | Font |
| --- | --- | --- | --- | --- |
| Display | 40px | 700 | 1.15, letter-spacing −0.4px | Sansation |
| Page title (H1) | 30px | 700 | 1.3, letter-spacing −0.4px | Sansation |
| H2 | 24px | 600 | 1.3 | Plex Sans |
| H3 | 20px | 600 | 1.35 | Plex Sans |
| Lede (sentence under a title) | 19px | 400 | 1.6 | Plex Sans |
| Group heading | 18px | 600 | 1.4 | Plex Sans |
| Body | 17px | 400 | 1.6 | Plex Sans |
| Label | 16px | 600 | — | Plex Sans |
| Metadata (the floor) | 15px | 400 | — | Plex Sans |
| Big number (KPI) | 34px | 600 | 1.1 | Plex Mono |

**Minimum size: nothing smaller than the metadata size (15px at the 17px root, 13.5px at the shipped Compact setting).** The Client Hub's users include business owners in their 50s, so readability beats density.

**Text-size setting.** The Client Hub lets each user pick a text size (Compact, Normal, Large, Largest = 15.3, 17, 19, 21px root). It ships on **Compact (15.3px)**, a deliberate decision after users said 17px felt too big. If the new platform has no size setting, use a 15.3px root (17px × 0.9) and scale every size in the table by 0.9 to match the Client Hub as people see it today.

Headings use sentence case ("Client experience", not "Client Experience").

## UI foundations

The Client Hub look is calm and flat: white cards with a 1px edge on a cool grey-blue canvas, generous spacing, big touch targets, and one strong focus ring.

| Foundation | Value | Notes |
| --- | --- | --- |
| Spacing scale | 4, 8, 12, 16, 20, 24, 32, 40, 56, 72, 96px | Use only these steps. Card padding is 24px; the gap under a page header is 32px |
| Corner radius | Controls 10px, cards 14px, panels 16px, pills 8px, round pills 999px | The main page action (`btn-xl`) uses 12px |
| Borders | 1px `#DDE3EC` on cards; 1px `#78869C` on inputs and secondary buttons | Rows inside a card are split by 1px `#ECF0F6` |
| Shadows | None on cards. Toasts: `0 12px 32px rgba(14,23,38,.35)`. Modals: `0 30px 80px rgba(14,23,38,.4)` | Cards are separated from the page by the darker canvas, not by shadow |
| Focus | `outline: 3px solid #1E5AA9; outline-offset: 2px` | One focus style everywhere, never a soft glow |
| Touch targets | 48px default, 52px inputs and nav rows, 56px for the one main action, 44px minimum (table rows only) | |
| Table rows | 64px comfortable, 56px compact | Staff can toggle density |
| Content width | Capped at about 1120px | Stops cards and actions drifting apart on wide monitors |
| Sidebar | 280px wide (216px minimum), white, 1px right border, logo row 84px tall with a 42px-high logo | Becomes a full-width drawer on mobile |
| Page background | `#EAEEF4` canvas; body text `#3D4C63` | |

**Icons.** Lucide-style outline icons on a 24 × 24 grid, 1.8px stroke, round caps, drawn at 23px by default. They inherit the text colour. Use the [Lucide](https://lucide.dev) set on the new platform to match. Every icon-only button needs an `aria-label`.

**Links** are `#17488A`, darkening to `#123A70` with an underline on hover. Links in prose are underlined by default for client users.

## Components

Build these first. Together they give the new platform the Client Hub look.

**Buttons.** 48px tall, 10px radius, Plex Sans 600 at body size, 20px side padding. Labels are verbs that say what happens ("Save changes", "Send request").

| Button | Fill | Border | Text | Hover |
| --- | --- | --- | --- | --- |
| Primary | `#1E5AA9` | `#1E5AA9` | White | Fill and border `#123A70` |
| Secondary (default) | White | `#78869C` | `#26344A` | Fill `#F1F5F9` |
| Quiet primary | White | `#1E5AA9` | `#17488A` | Fill `#E8F0FA`, text `#123A70` |
| Danger | White | `#A01B14` | `#A01B14` | Fill `#FDECEA` |
| Disabled | `#F8FAFC` | `#DDE3EC` | `#78869C` | No change |

Sizes: 44px (inside table rows only), 48px (default), 52px (large), 56px with 12px radius and 18px text (the one action a screen exists for: Save, Send, Sign in).

**Inputs.** 52px tall, white, 1px `#78869C` border, 10px radius, 12 × 16px padding, text `#0E1726`. Labels sit above in Plex Sans 600 at 16px, `#26344A`. Hint text goes below with a help icon. Errors are `#A01B14` with an icon and a sentence, never colour alone.

**Cards and panels.** White, 1px `#DDE3EC` edge, 14px radius (16px for large panels), 24px padding, no shadow.

**Status pills.** Sentence case, 15px / 600, 3 × 9px padding, 8px radius, coloured from the status table above. **Always an icon and a word**, never a coloured dot alone. Use teal pills for brand or "saved" states.

**Sidebar navigation.** Items are 52px tall, Plex Sans 500, `#26344A`, with a 14px gap between icon and label, grouped under small grey headings. The active item is marked four ways at once, so it survives colour blindness and poor screens:

1. light blue background `#E8F0FA`
2. 4px `#1E5AA9` bar on the left
3. weight 600
4. text colour `#123A70`

Count badges are round, `#A01B14` with white text.

**Tables.** Header row on `#F8FAFC`, rows split by `#ECF0F6`, hover `#F1F5F9`. Amounts and IDs use Plex Mono with tabular numerals.

**KPI tiles.** Big number in Plex Mono 34px / 600, `#0E1726`, with a Plex Sans label above.

**Sign-in page.** Split screen: about 46% is a navy panel, `linear-gradient(160deg, #16437E 0%, #0E2A52 100%)`, carrying the white logo with tagline and two short reassurance lines. The other side is a white form.

## Voice and copy

Write like a capable HR partner talking to a busy business owner: plain, short, reassuring, and specific about what happens next.

- **Plain words over HR jargon.** "Your HR paperwork, in one place." (the Client Hub sign-in headline)
- **Reassure with facts, not adjectives.** "Your data is held in India and never shared." "Every change is recorded and can be traced."
- **Buttons are verbs that say what will happen:** "Save as v2", "Send request", not "Submit" or "OK".
- **Sentence case everywhere:** headings, buttons, pills, nav. The only all-caps text is short statute codes (PF, ESIC, PT, LWF) and small kicker lines such as "HR SHARED SERVICES · CENTRE OF EXCELLENCE".
- **British/Indian spelling:** organisation, centre, colour.
- **Indian number and currency formats:** ₹2.4Cr, ₹12.5L, and lakh/crore grouping.
- **Say what happened and what to do next** in errors and empty states. Never colour alone.
- **Brand name:** always "Talent Carriage", two words, both capitalised. Use "TCMPL" only where the legal entity matters. The tagline is "Imagine Innovate Transform", with no punctuation.

## Developer drop-in

Copy these into the new platform's global stylesheet. The names match the Client Hub's `globals.css`, so code and conversations carry over between the two codebases.

**1. Fonts.** In Next.js:

```ts
import { IBM_Plex_Sans, IBM_Plex_Mono, Sansation } from "next/font/google";

const plexSans = IBM_Plex_Sans({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-sans" });
const plexMono = IBM_Plex_Mono({ weight: ["500", "600"], subsets: ["latin"], variable: "--font-mono" });
const sansation = Sansation({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-display" });
// <html className={`${plexSans.variable} ${plexMono.variable} ${sansation.variable}`}>
```

Any other stack:

```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=Sansation:wght@400;700&display=swap" rel="stylesheet">
```

**2. Tokens.**

```css
:root {
  /* brand */
  --primary: #1e5aa9;        /* Cyan Cobalt Blue */
  --primary-hover: #123a70;
  --link: #17488a;
  --navy: #16437e;
  --navy-2: #0e2a52;
  --teal: #52b5b5;           /* Verdigris: fills only, never text */
  --teal-800: #185c5c;       /* teal as text */
  --teal-100: #e4f2f2;
  --teal-200: #b8dede;
  --blue-bg: #e8f0fa;
  --blue-bdr: #c5daf1;

  /* neutrals */
  --ink-900: #0e1726;
  --ink-700: #26344a;
  --ink-600: #3d4c63;
  --ink-500: #56657d;
  --ink-400: #78869c;
  --line-200: #dde3ec;
  --line-100: #ecf0f6;
  --hover-tint: #f1f5f9;
  --surface-50: #f8fafc;
  --surface-0: #ffffff;
  --canvas: #eaeef4;

  /* status: ink / bg / border */
  --ok-ink: #10653c;   --ok-bg: #e7f4ec;   --ok-bdr: #b5ddc5;
  --warn-ink: #7a4205; --warn-bg: #fdf2e0; --warn-bdr: #efd3a0;
  --err-ink: #a01b14;  --err-bg: #fdecea;  --err-bdr: #f4c2bd;
  --neutral-ink: #3d4c63; --neutral-bg: #eef1f6; --neutral-bdr: #d6dde7;

  /* type (1rem = 17px at Normal; the Client Hub default is 17px x 0.9) */
  --fs-display: 2.353rem; /* 40 */
  --fs-h1: 1.765rem;      /* 30 */
  --fs-h2: 1.412rem;      /* 24 */
  --fs-h3: 1.176rem;      /* 20 */
  --fs-lede: 1.118rem;    /* 19 */
  --fs-group: 1.059rem;   /* 18 */
  --fs-body: 1rem;        /* 17 */
  --fs-label: 0.941rem;   /* 16 */
  --fs-meta: 0.882rem;    /* 15, the floor */
  --lh-body: 1.6;

  /* radius */
  --r-ctl: 10px;
  --r-card: 14px;
  --r-panel: 16px;
  --r-pill: 999px;
}

html { font-size: calc(17px * var(--text-scale, 0.9)); }
body {
  font-family: var(--font-sans), system-ui, sans-serif;
  background: var(--canvas);
  color: var(--ink-600);
  font-size: var(--fs-body);
  line-height: var(--lh-body);
}
h1, .t-display { font-family: var(--font-display), var(--font-sans), sans-serif; font-weight: 700; letter-spacing: -0.4px; }
:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
```

**3. Tailwind v4 (optional).** Expose the same tokens as utilities:

```css
@theme inline {
  --color-primary: var(--primary);
  --color-primary-hover: var(--primary-hover);
  --color-link: var(--link);
  --color-navy: var(--navy);
  --color-teal: var(--teal);
  --color-teal-ink: var(--teal-800);
  --color-canvas: var(--canvas);
  --color-ink: var(--ink-900);
  --color-body: var(--ink-600);
  --color-muted: var(--ink-500);
  --color-line: var(--line-200);
  /* new names on purpose: --font-sans: var(--font-sans) would be circular */
  --font-heading: var(--font-display);  /* font-heading */
  --font-ui: var(--font-sans);          /* font-ui */
  --font-figures: var(--font-mono);     /* font-figures */
  --radius-ctl: 10px;
  --radius-card: 14px;
}
```

**4. Logo files.** Copy `TalentCarriage/client-hub/public/brand/` (`logo.png`, `logo-white.png`, `logo-tagline.png`, `logo-mark.png`) and `src/app/icon.png` (favicon) into the new project unchanged.

## Do's, don'ts and accessibility

Run through this list before the new platform ships.

**Do**

- [ ] Use the supplied logo PNGs or PDF, with clear space on all sides
- [ ] Use Cyan Cobalt Blue `#1E5AA9` for the primary action and active states
- [ ] Use Verdigris `#52B5B5` as an accent: fills, charts, illustrations
- [ ] Set page titles in Sansation 700 and everything else in IBM Plex Sans
- [ ] Put white cards with a 1px edge on the `#EAEEF4` canvas
- [ ] Pair every status colour with an icon and a word
- [ ] Give every interactive element a 3px blue focus outline and a target of at least 48px (44px in table rows)

**Don't**

- Use `#B55252`. It is the PDF's typo for Verdigris, and it is a red
- Put teal `#52B5B5` behind or as text (2.43:1 fails WCAG). Use `#185C5C` for teal text
- Use pure black `#000000` for UI text. Use `#0E1726` for headings and `#3D4C63` for body
- Use `#78869C` for text. It is for borders and placeholders only
- Use Sansation for labels, buttons, small text or table numbers, or ask for weights 500/600 (they don't exist)
- Stretch, rotate, outline, recolour or rearrange the logo, or redraw it in SVG/CSS
- Add drop shadows to cards or soft glows to focus states

**Accessibility targets.** Body text clears WCAG AAA (8.71:1). Metadata clears AA (5.91:1). White on the primary blue is 6.79:1, and white on navy is 9.82:1. If you add a colour, check it against white with a contrast checker before use. Anything under 4.5:1 is for fills and graphics only.
