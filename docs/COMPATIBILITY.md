# CLIPFORGE — Browser & Device Compatibility (Phase 13, §16)

Status: **honest-scope statement + static review, 2026-11-02.** This document
does not claim cross-browser support, because cross-browser testing has not
happened. Read the scope box first; everything after it is a risk inventory
built from the code, not test results.

---

## 0. Honest scope — what has actually been exercised

> **The only browser this application has actually been run and checked in is
> Chromium** (the app during development and its e2e/QA passes).
>
> In addition, the **static landing/preview artifact** (not this full app) went
> through one constrained in-app-viewer QA pass — an embedded viewer in which
> `localStorage` may throw and `hashchange` navigation may be silently
> swallowed. That pass produced a real finding (§3.4) and a navigation fix in
> the preview; it is **not** evidence about Firefox, Safari, or Edge behaviour
> of the application.
>
> **No Firefox run, no Safari run, no Edge run, and no physical-device run
> exists for this app.** There is no browser/device lab, no BrowserStack-style
> service, and no automated cross-browser harness in this repository. There is
> no `browserslist` configuration; the build target is simply TypeScript /
> Vite's ES2020 output (`tsconfig.json`: `target: ES2020`, `lib: ES2020 +
> DOM`; `vite.config.ts` sets no build target or legacy plugin).
>
> Every cell in the matrix in §5 that does not say "Verified (Chromium)" says
> **Not run**. "Not run" means exactly that — not "probably fine".

Consequence: CLIPFORGE may be described as **"developed and verified in
Chromium"**. It may not be described as "works in all modern browsers" until
the §6 checklist has actually been executed.

---

## 1. What the app is, technically

- React 18 + TypeScript, built by Vite 5 into ES modules
  (`<script type="module">` in `index.html`). Browsers without ES-module
  support cannot load it at all.
- CSS Modules + one token sheet (`src/styles/tokens.css`). No CSS framework,
  no autoprefixer step beyond Vite's defaults, **no webfonts** (system font
  stack only) — one whole class of cross-browser font/FOUT risk is absent.
- Routing is **hash routing** (`src/App.tsx`, `src/features/auth/routing.ts`):
  all navigation lives in `location.hash` (`#/studio`, `#/projects/<id>/editor`, …),
  driven by a `hashchange` listener. There is no History-API router.
- The backend is same-origin behind the Vite dev proxy / deployment path; the
  session is an HttpOnly, `SameSite=Lax` cookie (Secure only in production).

---

## 2. Responsive layout inventory

Breakpoints actually present in `src/**/*.css` (counted, not designed targets):

| Media query | Occurrences | Where it matters |
|---|---|---|
| `(max-width: 1200px)` | 1 | Wide-layout tightening |
| `(max-width: 960px)` | 1 | Layout tightening |
| `(max-width: 900px)` | 5 | App shell / page grids collapse |
| `(max-width: 820px)` | 4 | Page layouts |
| `(max-width: 700px)` | 7 | Most common small-screen breakpoint (shell sidebar becomes the overlay drawer with the hamburger button in `AppShell.tsx`) |
| `(max-width: 640px)` | 1 | Small-screen adjustment |
| `(max-width: 520px)` | 2 | Small-screen adjustment |
| `(max-width: 480px)` | 4 | Phone-width adjustments |
| `(prefers-reduced-motion: reduce)` | 11 | Motion, not size — see `ACCESSIBILITY.md` |

Plus: `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
in `index.html`, fluid `clamp()` type/spacing (14 uses), `min()`/`max()`
(21 uses), and a 1120 px content max-width token.

**What this does and does not prove:** the CSS *contains* a coherent
small-screen story down to 480 px and a drawer navigation under ~700 px.
Nothing here proves any specific phone or tablet renders it correctly —
no device, emulator, or second engine has rendered these pages under test.
The editor in particular (multi-track timeline, preview canvas, inspector,
`src/components/editor/`) is a dense desktop-oriented surface; its CSS wraps
and scrolls (`.timelineScroll`), but its usability at phone widths is
**Not run / not assessed on a real device**, and pointer-drag editing (§3.3)
is the primary interaction there.

---

## 3. Browser-specific risk inventory (static review)

### 3.1 CSS features used

| Feature | Usage | Risk note |
|---|---|---|
| Flexbox, Grid, `gap` | Pervasive (flex ~170 rules, grid ~37, `gap` ~198) | Baseline in all modern engines; low risk, **unverified** outside Chromium. |
| `aspect-ratio` | 5 uses | Baseline since ~2021 in all engines; low risk. |
| `position: sticky`, `inset`, `object-fit`, `clamp/min/max` | Small counts | Baseline modern; low risk. |
| `color-mix(in srgb, …)` | 4 uses, all decorative backgrounds (`AuthPages.module.css`, `Editor.module.css`) | The newest feature in the codebase. Supported in Chromium 111+, Safari 16.2+, Firefox 113+. On anything older the *background decoration only* drops out (it is not load-bearing for layout or text contrast). Still: **Not run** on any of those engines. |
| `-webkit-text-stroke`, `WebkitBackgroundClip: "text"` | Caption overlay rendering in `PreviewCanvas.tsx` | Deliberate WebKit-prefixed properties for styled caption text. Chromium and Safari honour them; Firefox supports both `-webkit-` aliases for these two properties in practice — but caption-outline rendering differences are exactly the kind of thing that must be *looked at*, and nobody has. **Not run.** |
| Scroll behaviour / custom scroll areas | Timeline and panel scrollers | No `::-webkit-scrollbar` styling dependency was found that would break other engines' layout. |

### 3.2 JavaScript / DOM APIs used

| API | Where | Risk note |
|---|---|---|
| ES modules, `fetch`, `AbortController` / `AbortSignal.timeout` (server-side) | Throughout | Baseline modern. `AbortSignal.timeout` is the newest; older Safari (<16.4) lacks it — it is used server-side (Node), not in the browser bundle paths reviewed. |
| Pointer Events (`onPointerDown`, `PointerEvent`, window `pointermove`/`pointerup`) | Timeline drag/trim, ruler seek (`Timeline.tsx`), caption drag | The editor's core editing gestures are pointer-based, which is the *right* cross-engine choice (mouse + touch unified). Safari supports Pointer Events from 13+. Behaviour under touch (scroll-vs-drag contention on the timeline) is **Not run** on any touch device. |
| `requestFullscreen` / `document.fullscreenElement` | Preview "Fullscreen" button (`PreviewCanvas.tsx`) | Called unprefixed. Safari on iPhone does not expose element fullscreen the same way (and historically used `webkitRequestFullscreen` / video-only fullscreen). The call is `.catch()`-guarded, so failure is silent and non-fatal — the button would simply do nothing. **Not run.** |
| `IntersectionObserver` | Landing reveal animations | Baseline; degrades to content-visible patterns in the reveal component. |
| `ResizeObserver` | Editor preview sizing | Baseline modern. |
| `window.matchMedia("(prefers-reduced-motion: reduce)")` | `HomePage.tsx` | Baseline. |
| `sessionStorage` | Guest-mode flag only (`AuthContext.tsx`: `GUEST_FLAG`) | Wrapped usage is minimal, but any storage API can throw in locked-down/embedded contexts (the constrained-viewer lesson); the *app* does not depend on `localStorage` at all — a repo-wide grep finds **zero `localStorage` uses** in `src/` — which removes the largest class of embedded-viewer breakage. |
| `history` / deep-linking | **Not used** — hash routing only | See §3.4. |

### 3.3 Video element usage

- Previews and exports are played with native `<video>` elements. Most
  surfaces use native `controls` (source preview, media library, reframe
  previews, publishing/export viewers, project detail). The main editor
  preview (`PreviewCanvas.tsx`) is a **custom transport** (its own
  play/pause/step/speed/caption/guide/fullscreen buttons over a bare
  `<video playsInline preload="auto">`, plus a separate `<audio>` element
  and a muted B-roll `<video>` layer) — its synchronisation logic is
  Chromium-exercised only.
- **No `<track>` caption elements are used in the in-app players.** Captions
  in the editor are rendered as styled DOM overlays from the caption
  document; captions in *exports* are either burned in or delivered as
  separate SRT/VTT files (§4). A user who needs the browser's native caption
  machinery gets it only from an exported file in a player that supports
  sidecar subtitles — not in-app.

### 3.4 The one real compatibility finding on record: hash routing in constrained viewers

The static preview's dead-buttons incident (2026-11-02) proved that an
embedded viewer can silently swallow `hashchange`-driven navigation while a
clean browser passes every probe. The main app uses the same hash-routing
mechanism (`App.tsx` listens for `hashchange`; `routing.ts` also performs a
synchronous `navigateTo()` on click in the preview fix pattern). Practical
consequences to state honestly:

- In a standards-compliant browser tab, hash routing works (Chromium-verified).
- In embedded/webview contexts (in-app browsers, some iframe sandboxes),
  hash navigation is a **known risk area**, and this app has not been run in
  any specific webview other than the preview incident above.
- Hash routing also means: no server-side deep links, URLs are not shareable
  as clean paths, and the browser's back/forward semantics are hash-step
  semantics.

---

## 4. Video codec / playback notes

Server-side outputs (FFmpeg; capability-probed at runtime in
`server/src/export.ts`, presets in `server/src/editor.ts` / `export.ts`):

| Output | Container / codecs | Playback expectation (general knowledge, **not** a test result) |
|---|---|---|
| Default renders & most presets | **MP4, H.264 (libx264), AAC, `yuv420p`, 48 kHz** | The maximally compatible combination: plays natively in every modern browser engine including Safari. This is the safe default and it was chosen as such. Chromium playback **verified**; other engines **Not run**. |
| "Maximum" preset | MP4, **H.265/HEVC (libx265)**, AAC | HEVC-in-MP4 is natively playable in Safari; Chromium's support depends on platform/hardware decoding support; Firefox's is platform-dependent and historically absent. Treat H.265 exports as **not portable** until tested per target. |
| WebM preset | WebM, **VP9 (libvpx-vp9)**, Opus | Plays in Chromium and Firefox. Safari added VP9-in-WebM support only in later versions and Opus-in-WebM later still — on older Safari this preset will simply not play. **Not run.** |
| Audio-only | MP3 (libmp3lame), or AAC/Opus audio | MP3 is universal. Opus audio carries the same Safari caveat as WebM. |
| Separate captions | SRT / VTT sidecar files (`captionMode: "separate"`) | VTT is the web-native format; SRT is for external players/platforms. Neither is attached via `<track>` in-app (§3.3). |

Inputs: uploads are validated by FFprobe (MP4/MOV/WebM are the supported
input types per the server README); an input the *server* accepts still has
to be decodable by the *browser* for in-app preview, and MOV/HEVC inputs in
particular can preview differently per engine. **Not run** outside Chromium.

---

## 5. Test matrix

Legend: **Verified (Chromium)** = actually exercised in Chromium during
development/QA of this codebase. **Not run** = never executed there. No cell
is marked verified on the basis of "it should work".

| Area | Chromium | Firefox | Safari (macOS) | Safari (iOS) | Edge | Android Chrome / device |
|---|---|---|---|---|---|---|
| Landing page render + nav | Verified (Chromium) | Not run | Not run | Not run | Not run | Not run |
| Auth (register/login/MFA/session cookie) | Verified (Chromium) | Not run | Not run | Not run | Not run | Not run |
| Studio upload + source preview playback | Verified (Chromium) | Not run | Not run | Not run | Not run | Not run |
| Editor: preview transport + timeline drag/trim | Verified (Chromium) | Not run | Not run | Not run | Not run | Not run |
| Editor: caption overlay styling (`-webkit-` text effects) | Verified (Chromium) | Not run | Not run | Not run | Not run | Not run |
| Exports: queue UI + in-app output playback (H.264/AAC) | Verified (Chromium) | Not run | Not run | Not run | Not run | Not run |
| Exports: H.265 / WebM-VP9 output playback | Not run* | Not run | Not run | Not run | Not run | Not run |
| Publishing / Analytics / Settings / Admin pages | Verified (Chromium) | Not run | Not run | Not run | Not run | Not run |
| Fullscreen preview button | Verified (Chromium) | Not run | Not run | Not run | Not run | Not run |
| Responsive layouts ≤700 px / ≤480 px | Verified (Chromium)† | Not run | Not run | Not run | Not run | Not run |
| Reduced-motion behaviour | Verified (Chromium)† | Not run | Not run | Not run | Not run | Not run |
| Embedded / in-app webview (full app) | Not run | — | — | Not run | — | Not run |

\* H.265/WebM preset *generation* is server-side and encoder-probed; *playback
of those outputs in any browser* has not been part of a recorded check.
† Exercised in Chromium at reduced viewport sizes / emulated preferences —
not on a physical device.

---

## 6. What a real compatibility pass would require (not done)

1. One manual smoke pass per engine — Firefox (current), Safari macOS
   (current), Edge (current) — over: landing, auth incl. MFA, upload +
   preview, editor transport + one timeline drag, one H.264 export played
   back, publishing and admin pages. Record build + engine versions with
   each result and replace "Not run" cells only then.
2. One iOS Safari pass (real device or a faithful simulator) with explicit
   attention to: fullscreen button behaviour, `playsInline` preview,
   touch-drag on the timeline, and the ≤480 px layouts.
3. Playback checks for the H.265 and WebM presets in each engine, and a
   product decision (warn in the preset picker?) for combinations that fail.
4. A decision on embedded webviews: either test the target webview(s) or
   document them as unsupported — the preview incident shows "untested
   webview" cannot be assumed equivalent to a browser tab.

Until then, the supported-browser statement for CLIPFORGE is exactly:
**Chromium, current versions, desktop — verified. Everything else: not run.**
