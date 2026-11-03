# CLIPFORGE — Accessibility Audit (Phase 13, §17)

Status: **static code audit against WCAG 2.2 AA, 2026-11-02.** Scope: the
React frontend in `src/` (components, pages, CSS modules, `styles/tokens.css`,
`styles/global.css`). Method: code inspection and grep evidence, plus computed
contrast ratios (§4, math shown). **Not done:** no screen-reader pass, no
keyboard-only end-to-end walkthrough, no automated axe/Lighthouse run, and no
testing with users. A "Meets" verdict below means *the code as written
implements the pattern*, not that an assistive-technology user has verified
it. Nothing in this audit changes the brand identity; where brand colours
constrain contrast, that is noted as a constraint, not quietly overridden.

## Verdict summary

| # | Criterion area (WCAG 2.2) | Verdict |
|---|---|---|
| 1 | Landmarks & page structure (1.3.1, 2.4.6) | **Partially** |
| 2 | Bypass blocks / skip link (2.4.1) | **Does not meet** |
| 3 | Form labels & instructions (1.3.1, 3.3.1, 4.1.2) | **Partially** |
| 4 | Focus visibility (2.4.7) & focus indication quality (2.4.13, AAA reference) | **Partially** |
| 5 | Keyboard operability — standard controls (2.1.1) | **Meets** (by construction) |
| 6 | Keyboard operability — custom controls: timeline, dialogs, menus, tabs (2.1.1, 2.1.3) | **Partially** (dialogs/tabs/menus mostly; **timeline editing Does not meet**) |
| 7 | Focus management in dialogs (2.4.3, 4.1.2) | **Partially** |
| 8 | Error identification & announcement (3.3.1, 4.1.3) | **Meets** (strongest area) |
| 9 | Reduced motion (2.3.3 / 2.2.2 practice; `prefers-reduced-motion`) | **Meets** |
| 10 | Colour contrast — text (1.4.3) | **Meets** for the token palette's text pairings (see §4 for the two conditional exceptions) |
| 11 | Colour contrast — non-text / focus & control boundaries (1.4.11) | **Partially** |
| 12 | Use of colour (1.4.1) | **Meets** (statuses pair colour with markers/labels) |
| 13 | Images & non-text alternatives (1.1.1) | **Partially** |
| 14 | Charts & canvas alternatives (1.1.1, 1.4.1) | **Partially** |
| 15 | Video / media alternatives & player controls (1.2.x, 2.1.1) | **Partially** |
| 16 | Target size (2.5.8, AA in 2.2) | **Not assessed** (no measurement pass; primary buttons are ~38 px tall by padding, small icon buttons on the timeline are visibly below 24 px in code — flagged, unmeasured) |
| 17 | Headings & reading order (1.3.2, 2.4.6) | **Partially** |
| 18 | Language, title, consistent navigation (3.1.1, 2.4.2, 3.2.3) | **Meets** (`lang="en"`, per-route `<h1>` + document title pattern, single shell nav) |

---

## 1. Landmarks & structure — Partially

Good evidence:

- App shell (`src/components/AppShell.tsx`): `<aside aria-label="Main
  navigation">` containing `<nav aria-label="Application">`, a
  `<header>` topbar with `<nav aria-label="Breadcrumb">`, and exactly one
  `<main>`. Nav links carry `aria-current="page"` for the active route.
- Landing (`src/pages/HomePage.tsx`): `<header>`, `<main id="top">`,
  `<footer>`, labelled `<nav>`s in the footer, and `<section
  aria-labelledby="…-heading">` for hero/demo/features/how/FAQ/CTA.
- Pages consistently use `<section aria-labelledby>` / `aria-label`
  (Studio create/enhance flows, Exports cards, editor panels:
  `CaptionStudio` "Captions Studio", `ReframePanel` "Face Lock and
  reframing", `MediaLibrary`, `Inspector`).

Why only Partially:

- The shell renders the page `<h1>` *inside* `<main>` after banner notes —
  fine — but several workspace pages *also* render their own `<h1>`
  (`AnalyticsPage`, `PublishingPage`, `ExportsPage` each render
  `<h1 className={title}>` while `AppShell` renders its own
  `<h1 className={pageTitle}>{title}</h1>`), producing **two `<h1>`s with
  duplicated text on those routes**.
- `<aside>` is used as the navigation landmark wrapper; with its
  `aria-label` it announces as complementary *and* navigation-adjacent —
  acceptable, but the pattern is unusual and untested with a screen reader.
- No `role="search"` except `ProjectsPage`'s controls container; search
  inputs elsewhere rely on labels alone (not a failure, noted for
  consistency).

## 2. Bypass blocks — Does not meet

**There is no skip link anywhere.** A grep for skip-link patterns across
`src/` finds none — not in `AppShell`, not in `AuthLayout`, not on the
landing page. A keyboard/screen-reader user must tab through the full
sidebar navigation on every route change (hash routing re-renders inside
the same shell, which mitigates this in practice *within* a session, but
2.4.1 is judged on the mechanism, and the mechanism is absent). This is the
audit's clearest single fix: add a "Skip to main content" link targeting
`<main>` in the shell and on the landing page.

## 3. Form labels & instructions — Partially

Good evidence:

- The shared controls are correct by construction: `Input.tsx`,
  `Select.tsx`, `Textarea.tsx` render a real `<label htmlFor={id}>`, set
  `aria-invalid` on error, wire `aria-describedby` to the error/hint node,
  and render the error with `role="alert"`. `AuthLayout`'s field components
  do the same (`id={`${id}-error`}`, `role="alert"`).
- Standalone selects/inputs in feature code very frequently carry an
  explicit `aria-label` (editor, captions, enhance, reframe panels are
  dense with them — e.g. "Playback speed", "Translation target language",
  "Placement start in seconds").
- The signup terms checkbox is a labelled `<label htmlFor="signup-terms">`
  with `aria-invalid` + `aria-describedby` to its error.

Why only Partially:

- The codebase mixes three labelling styles (shared labelled components,
  raw `<label>` without `htmlFor` wrapping an input, and `aria-label`-only),
  and this audit did not — and statically cannot — prove *every* one of the
  ~200 raw `<input>`/`<select>` elements across the large pages
  (`SettingsPage.tsx`, `PublishingPage.tsx`, `ExportsPage.tsx`) has an
  accessible name. Spot checks found labelled controls; a full
  element-by-element proof needs an automated pass (axe) that has not been run.
- Placeholder text is used as a supplementary hint in places (e.g. the
  YouTube URL field); placeholders are not labels, and wherever a
  placeholder is the *only* visible instruction, that field depends on its
  `aria-label`/surrounding heading — labelled "Partially" for exactly this
  residual risk.

## 4. Contrast — computed from the token palette

Method (WCAG 2.x relative luminance): for each sRGB channel
`c ∈ [0,1]`, linearise as `c/12.92` if `c ≤ 0.03928`, else
`((c+0.055)/1.055)^2.4`; `L = 0.2126·R + 0.7152·G + 0.0722·B`;
ratio `= (L_lighter + 0.05) / (L_darker + 0.05)`. Colours are the tokens in
`src/styles/tokens.css`. AA thresholds: **4.5:1** normal text, **3:1** large
text and non-text (focus/control boundaries).

| Foreground | Background | L(fg) | L(bg) | Ratio | AA normal text? |
|---|---|---|---|---|---|
| `--text` #F2F4F7 | `--midnight` #030407 | 0.9029 | 0.0012 | **18.61:1** | ✅ Pass |
| `--text` #F2F4F7 | `--surface` #0A0D14 | 0.9029 | 0.0040 | **17.64:1** | ✅ Pass |
| `--text` #F2F4F7 | `--surface-2` #10151F | 0.9029 | 0.0075 | **16.59:1** | ✅ Pass |
| `--text-muted` #9AA3B2 | `--midnight` #030407 | 0.3628 | 0.0012 | **8.06:1** | ✅ Pass |
| `--text-muted` #9AA3B2 | `--surface` #0A0D14 | 0.3628 | 0.0040 | **7.64:1** | ✅ Pass |
| `--text-muted` #9AA3B2 | `--surface-2` #10151F | 0.3628 | 0.0075 | **7.18:1** | ✅ Pass |
| `--text-muted` #9AA3B2 | `--surface-3` #171D29 | 0.3628 | 0.0122 | **6.64:1** | ✅ Pass |
| `--text-faint` #8490A3 | `--midnight` #030407 | 0.2750 | 0.0012 | **6.35:1** | ✅ Pass |
| `--text-faint` #8490A3 | `--surface` #0A0D14 | 0.2750 | 0.0040 | **6.01:1** | ✅ Pass |
| `--text-faint` #8490A3 | `--surface-2` #10151F | 0.2750 | 0.0075 | **5.66:1** | ✅ Pass |
| `--lime` #D4FF24 (accent text) | `--midnight` #030407 | 0.8564 | 0.0012 | **17.70:1** | ✅ Pass |
| `--lime-ink` #101503 on `--lime` #D4FF24 (lime buttons/badges) | — | 0.0065 | 0.8564 | **16.03:1** | ✅ Pass |
| White #FFFFFF on `--cobalt` #1558C9 (primary buttons) | — | 1.0000 | 0.1136 | **6.42:1** | ✅ Pass |
| `--text` #F2F4F7 on `--cobalt` #1558C9 | — | 0.9029 | 0.1136 | **5.83:1** | ✅ Pass |
| White #FFFFFF on `--cobalt-hover` #1D6AE8 | — | 1.0000 | 0.1640 | **4.91:1** | ✅ Pass |
| `--success` #3AA76D | `--midnight` #030407 | 0.2964 | 0.0012 | **6.76:1** | ✅ Pass |
| `--warning` #D9A441 | `--midnight` #030407 | 0.4168 | 0.0012 | **9.12:1** | ✅ Pass |
| `--error` #E5484D | `--midnight` #030407 | 0.2183 | 0.0012 | **5.24:1** | ✅ Pass |
| `--error` #E5484D | `--surface` #0A0D14 | 0.2183 | 0.0040 | **4.97:1** | ✅ Pass |
| **`--cobalt` #1558C9 as text/graphics on `--midnight` #030407** | — | 0.1136 | 0.0012 | **3.19:1** | ⚠️ **Fails normal text (needs 4.5); passes large-text/non-text (3:1) only** |
| **`--text-muted` #9AA3B2 on `--cobalt` #1558C9** | — | 0.3628 | 0.1136 | **2.52:1** | ❌ **Fails everything — must never occur** |

Reading of the results:

- **The palette's intended text system passes AA everywhere it is used as
  designed**: primary, muted, and even the faintest text token pass on all
  three surface tiers; lime is only ever a background with near-black ink or
  an accent on near-black; white on cobalt (the primary button) passes in
  both rest and hover states. This is a genuinely strong token palette for
  a dark UI.
- **Brand constraint, stated openly:** cobalt *on* midnight is a 3.19:1
  colour. The brand uses cobalt as a surface/accent colour, which is fine —
  but cobalt must never carry normal-size text, small icons that convey
  meaning, or a chart line that is the only carrier of information on the
  midnight background. The Analytics line chart's default colour is exactly
  `#1558C9` on the dark background (see §8) — acceptable as a *graphic*
  (≥3:1 for non-text) only because the chart also exposes its values
  textually per-point; the margin is thin (3.19 vs 3.0).
- Muted-on-cobalt (2.52:1) does not occur in the token system (cobalt
  surfaces take white text); it is listed so a future component cannot
  introduce it unknowingly.
- Chart axis text is hard-coded `#9AA3B2` on the page background in
  `Charts.tsx` — the 8.06:1 pairing above, ✅.
- **Not computed / not covered:** text over thumbnails/video frames,
  placeholder-image gradients on the landing page, disabled-state text
  (`opacity: 0.55` on disabled buttons lowers *effective* contrast — WCAG
  exempts disabled controls, noted for honesty), and any colour pair
  introduced by user content (caption styles are user-configurable colours
  over video, which no palette audit can certify).

## 5. Focus visibility — Partially

- Global rule (`src/styles/global.css`): `:focus-visible { outline: 2px
  solid var(--lime); outline-offset: 3px; }` — lime on midnight is 17.70:1,
  far above the 3:1 non-text requirement. Where this rule wins, focus is
  unmistakable. ✅
- **Conflict:** the shared form controls suppress it. `Form.module.css`:
  `.control:focus { outline: none; border-color: var(--cobalt); }` — the
  class+pseudo-class specificity of `.control:focus` beats the global
  `:focus-visible` rule for `outline`, so text inputs/selects/textareas
  built on the shared `Input`/`Select`/`Textarea` show focus as **only a
  border colour change from `--border` #232A38 to cobalt #1558C9** on a
  `--surface-2` background. A border change is a recognised focus indicator
  in principle, but this one is low-salience (cobalt vs. the dark surface
  is 3.03:1 and the *change* is a 1 px line). The auth pages' `.input:focus
  { outline: none; … }` (AuthPages.module.css) has the same pattern.
  Verdict Partially: focus is never *removed entirely*, but on the most
  common interactive elements it is the weakest permitted form. Fix
  direction (for a future change, not made here): drop `outline: none`
  from those two rules and let the global lime outline apply.

## 6. Keyboard operability — standard controls Meets; custom controls Partially

- Standard controls are native elements throughout (`<button>`, `<a href>`,
  native `<select>`/`<input>`), so Tab/Enter/Space operability is by
  construction. Icon-only buttons consistently carry `aria-label`
  (transport step buttons, timeline zoom, track lock/visible/mute/solo use
  `aria-pressed` toggles with labels).
- **FAQ** uses native `<details>/<summary>` (`HomePage.tsx`) — keyboard and
  AT behaviour is the platform's, correctly. ✅
- **Tabs** (`Tabs.tsx`): proper `tablist`/`tab`/`tabpanel` with
  `aria-selected`, `aria-controls`, `aria-labelledby`. **But** there is no
  roving `tabindex` and no ArrowLeft/ArrowRight handling — the component's
  own comment says arrow-key navigation "is handled by native button focus
  order", i.e. every tab stays in the Tab order and selection is
  click/Enter only. That is keyboard-*usable* (and arguably simpler), but
  it does not implement the ARIA tabs keyboard pattern; screen-reader
  expectations for a `tablist` may not match. Partially.
- **Dropdown/menus** (`Dropdown.tsx`): trigger is a real button with
  `aria-haspopup="menu"` + `aria-expanded`; Escape closes; outside-click
  closes. The menu container has `role="menu"` but its children are
  arbitrary content (the notification panel, profile actions) without
  `menuitem` roles or arrow-key navigation — keyboard users Tab through
  the contents once open, which works, but focus is **not moved into**
  the menu on open and does not return to the trigger on Escape.
  Partially.
- **Source-type tabs** (`SourcePanel.tsx`) replicate the tab roles by hand
  (`role="tab"`, `aria-selected`) without `tablist` keyboard semantics —
  same Partially as Tabs.
- **Timeline — Does not meet for editing.** The ruler is a
  `role="slider"` with `aria-valuemin/max/now` and `aria-label="Seek"`
  (`Timeline.tsx`) — but the slider `<div>` has **no `tabIndex` and no
  keyboard handler**, so it is not focusable and cannot be operated by
  keyboard at all; it announces slider semantics it does not deliver to
  keyboard users. Clip move/trim/caption-move are **pointer-drag only**
  (`onPointerDown` begin-drag; no keyboard equivalent, no focusable clip
  elements). Mitigations that keep this from being a total loss: the same
  edits are reachable non-spatially — clip/caption timing is editable in
  numeric form fields in `CaptionStudio`/Inspector, track toggles are
  buttons, and seek is also available via the transport's labelled
  step-frame buttons. The *timeline surface itself*, however, is
  mouse/touch-only, and the non-focusable slider should either gain real
  keyboard support or lose the slider role.
- **Caption overlay drag** (`PreviewCanvas`) is likewise pointer-only;
  caption position is also settable via the caption style controls.

## 7. Focus management in dialogs — Partially

`Modal.tsx` gets the basics right: `role="dialog"`, `aria-modal="true"`,
`aria-label` from the title, Escape closes, backdrop click closes, and
focus is moved to the close button on open. `ConfirmationDialog` inherits
all of it. Missing pieces, verified by reading the component:

- **No focus trap** — Tab can walk out of an open dialog into the page
  behind it.
- **No focus restoration** — on close, focus is not returned to the
  invoking element (it falls back to `<body>`).
- Initial focus lands on the *Close* (×) button rather than the dialog's
  primary content/action — safe for destructive confirms, suboptimal
  generally.
- Background content is not `inert`/aria-hidden while a dialog is open.

## 8. Error identification & announcement — Meets (strongest area)

`role="alert"` usage is pervasive and consistent (60+ occurrences): shared
`ErrorState` is itself `role="alert"`; form errors render as
`role="alert"` and are wired via `aria-describedby`; page-level errors in
Settings, Studio, Projects, editor panels, auth pages all use
`role="alert"`; success/status messages use `role="status"` /
`aria-live="polite"` (`LoadingState` is `role="status"`, preview and
reframe panels announce state changes with `aria-live="polite"`). Errors
are text, never colour-only (the form error style adds weight + text, the
invalid control adds `aria-invalid`). Status indicators pair colour with a
marker glyph and a text label (`StatusIndicator.tsx`).

## 9. Reduced motion — Meets

- Global kill-switch in `global.css`: under
  `(prefers-reduced-motion: reduce)`, all animations/transitions collapse
  to 0.01 ms and smooth scrolling is disabled.
- The same media query is repeated locally in 10 further stylesheets
  (AppShell, Modal, Dropdown, Tabs, States, Cards, Reveal, HomePage,
  AuthPages, Studio) — the pattern is systemic, not a one-off.
- `HomePage.tsx` additionally reads
  `matchMedia("(prefers-reduced-motion: reduce)")` in JS for its
  programmatic motion. No autoplaying video exists in the app shell;
  landing media slots are static placeholders.

## 10. Images & non-text alternatives — Partially

Thumbnails and meaningful images carry real alt text
(`alt={`Thumbnail of ${filename}`}`, `alt={`Frame from ${filename}`}`,
`alt={`Poster frame of ${name}`}`, subject thumbnails, post thumbnails,
workspace logos, `alt="Your profile"`). Decorative thumbnails inside
labelled cards correctly use `alt=""` (`ProjectCardView`,
`MediaLibrary`, publishing avatars). The logo exposes `aria-label
="CLIPFORGE"`. Why Partially: alt quality is filename-based (a screen
reader hears names, not content descriptions — appropriate for *your own*
media library, weaker for anything editorial), and no audit pass has
verified every `<img>` across all pages element-by-element.

## 11. Charts & canvas alternatives — Partially

Analytics charts are hand-rolled SVG (`Charts.tsx`), not canvas — a good
base. Each chart is `role="img"` with an `aria-label`, and **every data
point carries an SVG `<title>`** (`"2026-11-01: 1234"`), so values exist
in text form inside the graphic. The Analytics pages also present the same
metrics in tables/cards around the charts. Limits: a `role="img"` SVG is
announced as a single image — the per-point `<title>`s are not reliably
reachable by screen readers inside a `role="img"` container, and there is
no data-table toggle or text summary generated per chart. The editor's
preview canvas is a `<video>` + DOM overlays (not `<canvas>`), so it
inherits media behaviour rather than canvas problems; the timeline's
visual-only waveform/colour information has the form-field mitigations
noted in §6.

## 12. Video player controls — Partially

- Secondary players (source preview, media library, reframe, publishing,
  exports, project detail) use **native browser `controls`** — keyboard
  operable, AT-labelled by the platform. ✅ for those surfaces.
- The main editor transport is custom but built from real buttons with
  `aria-label`/`aria-pressed` and a polite live region announcing the clip
  under the playhead. ✅ for operability.
- Gaps: no `<track>` captions in any in-app player (captions are visual
  DOM overlays in the editor — visible, but not exposed as a text track
  to AT, and not user-toggleable through the video element); no audio
  description anywhere; autoplaying previews are `muted` + `playsInline`
  (no sound-on autoplay), which is the safe pattern.

## Priority fix list (for a future change — none made by this audit)

1. Add skip links (shell + landing + auth). — §2
2. Give the timeline ruler real keyboard support (focusable slider with
   arrow keys) or remove its slider semantics; add keyboard move/trim
   for clips. — §6
3. Remove `outline: none` on shared/auth input `:focus` so the global
   lime focus outline applies. — §5
4. Add focus trap + focus restoration to `Modal`. — §7
5. De-duplicate `<h1>` on Analytics/Publishing/Exports routes. — §1
6. Run the automated + AT passes this static audit cannot substitute for
   (axe, keyboard walkthrough, one screen-reader pass) and replace
   "Partially / Not assessed" verdicts with tested ones. — §0, §3, §16
