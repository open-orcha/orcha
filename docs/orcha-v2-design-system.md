# Orcha V2 — design system

§1 (token table) was authored by **Agent A** and retuned for the Linear "pop" frame + Inter Variable by the **type-tokens** agent (2026-09-28; the only editor of this doc in that round) from §6 of
`docs/orcha-linear-redesign-implementation-prompt.md`. **Agent B owns everything after §1**
(implementation file locations, primitives, component specs) and may refine values in §1 only
with a recorded contrast check.

V2 is **dark-only**. There is no light theme, no `auto`, no skins.

## 1. Token table ("Linear pop" retune, D5/D6/D8 — 2026-09-28)

Contrast ratios below were computed (WCAG 2.x relative luminance) on 2026-09-28 by the
type-tokens agent; they are static-value checks, re-verified in rendered 1440/390 screenshots
(`docs/orcha-v2-screen-review/linear/type-tokens/`). Everything lives in
`P/static/styles/v2-tokens.css`. **Never hard-code a hex in page CSS — if a value is missing,
ask for a token.**

### 1.0 The D5 app frame (how the surfaces stack)

```
window (#0E0F10) ─ sidebar sits directly on it, no divider line
 └─ 8px gap (--v2-frame-gap) ─ inset PANEL (#151618, 1px --v2-panel-border, radius 10px,
    overflow clipped, scrolls inside)  ← mark its root  data-v2-surface="panel"
     ├─ header row 44px (--v2-header-h): page icon + title (13px/500) | circular 28px icon buttons
     ├─ pills row 44px (--v2-pillbar-h): rounded-full filter pills | circular icon buttons
     └─ content: rows on the panel, group bands (--v2-band), cards (--v2-surface, 1px --v2-border)
          └─ popovers / menus / dialogs (--v2-raised + --v2-shadow-pop)
```

- `[data-v2-surface="panel"]` (or `.v2-panel-surface`) **re-scopes `--v2-canvas`** (and
  `--bg`, `--v2-avatar-ring`, both focus rings) to the panel tone, so any rule that paints
  "the background I sit on" (sticky headers, fades, focus-ring gaps, avatar badge rings) stays
  seamless inside the panel without per-page overrides. `[data-v2-surface="raised"]` does the
  same for popovers/menus that contain avatars or focus rings.
- ≤ 720 px: `--v2-frame-gap: 0`, `--v2-panel-radius: 0`, `--v2-panel-px: 16px` — the panel
  fills the viewport (Linear mobile); don't add your own media query for this.

### 1.1 Surfaces and lines

Elevation ladder, darkest → lightest: **window < panel < surface < raised**.

| Token | Value | Use |
|---|---|---|
| `--v2-window` | `#0E0F10` | app frame + sidebar; `<html>`/`<body>` background **before first paint** (index.html inline) |
| `--v2-canvas` | `var(--v2-window)`; **`var(--v2-panel)` inside `[data-v2-surface=panel]`** | "the background I sit on" — use for sticky headers / edge fades |
| `--v2-sidebar` | `var(--v2-window)` | sidebar (D5: on the window tone, no border) |
| `--v2-panel` | `#151618` | the inset content panel |
| `--v2-panel-border` | `#232427` | 1 px hairline around the panel |
| `--v2-surface` | `#19191C` | cards / bordered blocks ON the panel (activity comment cards, board cards, triage card) |
| `--v2-band` | `#1A1B1E` | list group-header band (full width, D8) |
| `--v2-raised` | `#1E1F23` | popovers, menus, dialogs, tooltips, command palette |
| `--v2-hover` | `rgba(255,255,255,0.045)` | row / control hover — **translucent**, reads the same on window, panel, surface and raised |
| `--v2-selected` | `rgba(255,255,255,0.08)` | selected row / active sidebar item (still paired with a non-colour marker where selection carries meaning) |
| `--v2-hover-solid` / `--v2-selected-solid` | `#1C1D20` / `#232427` | opaque equivalents over the panel — only when the fill must cover content |
| `--v2-border` | `#25262A` | hairline dividers + card borders (1.2:1 on panel — decorative only) |
| `--v2-border-subtle` | `#1E1F22` | inner separators that should almost disappear (Linear rows have none) |
| `--v2-border-strong` | `#33353A` | control outlines: inputs, circular icon buttons, chips |

### 1.2 Text

| Token | Value | Contrast (window / panel / surface / raised / band) | Use |
|---|---|---|---|
| `--v2-text` | `#EEEFF1` | 16.7 / 15.7 / 15.3 / 14.3 / 15.0 | primary text, row titles |
| `--v2-text-2` | `#B4B7BE` | 9.6 / 9.0 / 8.7 / 8.2 / 8.6 | secondary text, descriptions, pill labels, counts |
| `--v2-text-3` | `#8A8F98` | 5.9 / 5.6 / 5.4 / 5.1 / 5.3 (4.6 on selected pill) | meta: ids, timestamps, column headers, activity lines (lowest tone for readable text) |
| `--v2-text-disabled` | `#5E626A` | < 4.5 | disabled controls / placeholder glyphs ONLY — never information |
| `--v2-text-on-accent` | `#0E0F10` | 7.0 on accent | text/icons on a pastel `--v2-accent` fill (selected dots, badges). **White on `--v2-accent` fails — never use it.** Primary buttons do NOT use the accent fill — see `--v2-primary-*`. |

### 1.3 Accent and semantics

| Token | Value | Contrast (panel / raised) | Meaning |
|---|---|---|---|
| `--v2-accent` / `-hover` / `-soft` | `#8D93F7` / `#A1A6F9` / `rgba(141,147,247,.14)` | 6.6 / 6.0 | focus ring, links, selected marks, accent TEXT/icons. Sparingly. Never a large filled block. |
| `--v2-primary-bg` / `-bg-hover` / `-text` | `#5E6AD2` / `#5563CC` / `#FFFFFF` | white label 4.7 / 5.2 | **primary button fill** (Linear indigo, r1). `.v2-btn-primary`, legacy `.btn` / `.btn.approve`. Hover goes deeper, not lighter, so the white label stays AA. The pastel accent + black label read as the loudest element on every screen. |
| `--v2-ok` (+`-soft`) | `#4CB782` | 7.3 / 6.6 | success / done / verified |
| `--v2-warn` (+`-soft`) | `#E2A336` | 8.2 / 7.5 | attention / needs you / at risk |
| `--v2-danger` (+`-soft`) | `#EE7070` | 6.2 / 5.6 | failure / blocked / destructive |
| `--v2-info` (+`-soft`) | `#4EA7FC` | 7.0 / — | information |
| `--v2-neutral` (+`-soft`) | `#8A8F98` | 5.6 / 5.1 | idle / pending / cancelled |

**Status glyph colours (D8 — one glyph set everywhere):**

| Token | Value | Glyph |
|---|---|---|
| `--v2-status-todo` | `#8A8F98` | empty circle |
| `--v2-status-pending` | `#8A8F98` | dashed circle (waiting on deps) |
| `--v2-status-progress` | `#F0BF4C` (10.6:1 panel) | half-filled yellow circle |
| `--v2-status-review` | `#4CB782` | ring + centre dot, green |
| `--v2-status-verify` | `#E2A336` | ring + centre dot, amber (needs verification) |
| `--v2-status-done` | `#4CB782` | filled circle + check |
| `--v2-status-blocked` / `-failed` | `#EE7070` | red (blocked ⊖ / failed ✕ — different shapes) |
| `--v2-status-cancelled` | `#8A8F98` | circle + slash |

**Priority / health / labels:** `--v2-prio-bar` (filled bar, = text-2), `--v2-prio-bar-empty`
`#3A3C42`, `--v2-prio-urgent` `#F2994A` ("!" square). Health chips: `--v2-health-on` (ok),
`--v2-health-risk` (warn), `--v2-health-off` (danger) — icon + coloured text, never colour alone.
Label dots `--v2-label-1…8`: blue `#4EA7FC`, green `#4CB782`, yellow `#F0BF4C`, orange
`#F2994A`, red `#EE7070`, indigo `#8D93F7`, pink `#D682C8`, teal `#3FBAC9` — pick by a stable
hash of the label name.

Status is never conveyed by colour alone: every status carries its exact label (from
`F/lib/status.ts STAT`, visible or `.v2-sr`) and a distinct glyph shape.

### 1.3d Avatars (D7)

All avatars are **circles** (`border-radius: var(--v2-radius-full)`). Sizes `--v2-avatar-xs/sm/md/lg`
= `16 / 20 / 24 / 32 px`. Stack overlap `--v2-avatar-overlap: -4px`. Status badge
`--v2-avatar-badge: 8px` dot at bottom-right with a `2px` ring of `--v2-avatar-ring` (the
surface it sits on — auto re-scoped in the panel/raised scopes). AI vs human = a tiny
sparkle badge, not a shape change. **Projects are round too** (desktop parity) and show two
initials ("billing-service" → "BS").

**Identity colour (D13, desktop parity).** The `Avatar` primitive uses the desktop renderer's
fixed palette: `AVATAR_HUES = [4, 30, 50, 95, 145, 178, 208, 238, 272, 318]`, fill
`hsl(h 34% 28%)`, initial `hsl(h 72% 86%)`, slot = FNV-1a (`paletteIndex`, offset basis
`0x1f54177e`) of the alias (actors) or `name + "\u0000" + containerId` (projects,
`projectAvatarKey`). Lists that show several identities together pass collision-free slots from
`assignPalette(keys)` as `palette` (the sidebar, All projects and every `AvatarStack` do), so no
two neighbours share a colour. The older `--v2-avatar-bg-1…8` tokens were **removed** (r2) — they were
unused and diverged from desktop; identity colours are never tokens.

**Parity rules (r2 review — the same identity got different colours/shapes per surface):**
- **One palette map per scope, shared.** Compute `assignPalette` ONCE — projects over the sidebar's
  project order (`projectAvatarKey(name, id)`), actors over the project's full `snap.agents` +
  humans — and hand the resulting slot to every surface that shows that identity (sidebar,
  header, ⌘K palette, All projects, Needs → All projects, Agents board/roster, needs popover,
  inbox). A surface must **never** call `assignPalette` over its own partial list (that re-slots
  identities and breaks parity), and never fall back to raw `paletteIndex` when the shared map is
  available.
- **Every avatar class is a circle**, including legacy ones (`.proj-av`, `.av`): a later-loaded
  component stylesheet must not re-declare a smaller `border-radius`. Status dots are round too
  (never a square "offline" marker).

### 1.4 Typography (D6)

**Font:** Inter Variable 4.x with the **optical-size axis** (`wght 100–900`, `opsz 14–32`),
self-hosted — `static/fonts/inter-var-opsz-latin.woff2` (+ `-latin-ext`, `-latin-italic`),
from `@fontsource-variable/inter@5.3.0` (opsz build), SIL OFL 1.1 (`static/fonts/OFL-inter.txt`).
Registered as family **`"Inter Variable"`** in `v2-tokens.css` (`font-display: swap`); the latin
file is `<link rel=preload>`ed in `frontend/index.html`. `font-optical-sizing: auto` selects the
Display cut automatically at 24 px+. The legacy wght-only `"Inter"` face (fonts.css) stays as a
fallback only. **Desktop renderer:** load the same three woff2 files (see cross-file notes).

Body defaults (set on `body`, inherited by form controls): `font-feature-settings: "cv01", "ss03"`
(`--v2-font-features`), `-webkit-font-smoothing: antialiased`, `font-optical-sizing: auto`.

| Token | Value | Role |
|---|---|---|
| `--v2-font-sans` | `"Inter Variable", "Inter", system-ui, …` | all UI |
| `--v2-font-display` | `var(--v2-font-sans)` | display titles (opsz does the work) |
| `--v2-font-mono` | `"JetBrains Mono", …` | code, logs, branch names — **not** short ids (ids are Inter medium, muted) |
| `--v2-fs-xs` | `11px` | counters inside badges only |
| `--v2-fs-meta` / `--v2-fs-label` | `12px` | meta lines, ids, timestamps, chips, column headers / field + section labels (sentence case) |
| `--v2-fs-body` | `13px` | body + list rows (was 13.5) |
| `--v2-fs-btn` / `--v2-fs-header` | `13px` | buttons / D5 panel header title (500) |
| `--v2-fs-body-lg` | `14px` | long-form descriptions, markdown, conversation |
| `--v2-fs-title` | `15px` / 600 | section titles |
| `--v2-fs-page` | `18px` / 600 | in-page headings: metric values, settings/card titles |
| `--v2-fs-inspector-title` | `18px` / 600, lh 1.3 | split-inspector detail title (`.v2-t-inspector-title`; may clamp to 3 lines with `.v2-clamp-3` + title tooltip). **Never clamp the full-view H1.** |
| `--v2-fs-display` | `24px` / 600, `-0.012em`, lh 1.2 | full-view page / detail titles (task, request, agent) |
| `--v2-fs-display-lg` | `28px` | hero detail title, onboarding |
| `--v2-fw-regular / -book / -medium / -semibold` | `400 / 450 / 500 / 600` | `book` = row titles |
| `--v2-lh-tight / -snug / -body` | `1.2 / 1.35 / 1.5` | display / rows+chips+meta / paragraphs |
| `--v2-ls-display / -title` | `-0.012em / -0.006em` | |
| numerals | `font-variant-numeric: tabular-nums` (`.tnum`, `time`, `.v2-count`, `.v2-t-meta`, `.v2-t-id`) | counts, metrics, timestamps |

**Weight usage (r2).** List-row titles are `--v2-fw-book` 450 (`.v2-t-row`), never 400 — at 13 px
400 reads thin next to Linear. 500 is for header titles, labels, ids and button text; 600 for section
and display titles only. Page CSS uses the tokens (`var(--v2-fw-book)`), not raw numbers, so the
optical weight can be tuned in one place. Inter Variable renders intermediate weights exactly (verified
in Chromium: the "Inter Variable" face loads for `100 900`, `document.fonts.check('600 24px
"Inter Variable"')` is true, and `font-optical-sizing:auto` is inherited everywhere).

**Type utility classes** (font properties only, compose with your layout classes):
`.v2-t-display`, `.v2-t-display-lg`, `.v2-t-title`, `.v2-t-header`, `.v2-t-row` (13/450),
`.v2-t-body`, `.v2-t-body-lg` (14, text-2), `.v2-t-meta` (12, text-3, tnum), `.v2-t-label`
(12/500, text-3), `.v2-t-id` (12/500, text-3, tnum — muted short ids like `ENG-2749`),
`.v2-t-inspector-title` (18/600), `.v2-clamp-3` (3-line clamp helper).

**Code:** `code, kbd, pre, .mono` and CodeMirror (`.cm-editor/.cm-content/.cm-gutters`) render
with `font-variant-ligatures: none` (+ `liga`/`calt` off) — the file viewer and the editor must
show `=>` / `===` identically (r1: edit mode showed `⇒ ≡`). Same font, size and line-height in
both modes is the editor theme's job.

**Pre-paint (`frontend/index.html`):** the inline `<style>` repeats the body font stack,
`"cv01","ss03"`, `font-optical-sizing:auto`, antialiasing and `body{font-size:13px;line-height:1.5}`
(html stays 16 px, so `rem` is unchanged) so first paint in the fallback face has the same
metrics/features as the final one; the latin opsz file is preloaded (`crossorigin`).

### 1.5 Spacing, size, radius

| Token | Value |
|---|---|
| `--v2-space-1 … -8`, `-10`, `-12` | `4, 8, 12, 16, 20, 24, 28, 32, 40, 48 px` |
| `--v2-row-h` / `--v2-row-h-lg` / `--v2-row-h-touch` | `36px` rows / `40px` roomy rows / `44px` (coarse pointers: row-h → 44) |
| `--v2-control-h` / `-sm` | `32px` / `28px` inputs (both 44 px on coarse pointers) |
| `--v2-btn-h` / `--v2-btn-h-sm` | `28px` / `24px` — never raised on touch; `::after` hit area ≥ `--v2-hit-min` 44 px |
| `--v2-btn-secondary-bg` | `#1C1D21` |
| `--v2-radius-sm / -control / -card / -panel / -full` | `4 / 6 / 8 / 10 / 999 px` |
| `--v2-frame-gap` | `8px` (0 ≤ 720 px) — panel inset from window edges and sidebar |
| `--v2-panel-radius` | `var(--v2-radius-panel)` (0 ≤ 720 px) |
| `--v2-panel-px` | `20px` (16 ≤ 720 px) — horizontal padding for panel header, pills row, list rows |
| `--v2-header-h` / `--v2-pillbar-h` | `44px` / `44px` |
| `--v2-sidebar-w` | derived in v2-shell.css from `--v2-sidebar-user-w` (inline, user drag) or `--v2-sidebar-w-default` `248px`; rail `--v2-sidebar-rail` `56px` |
| `--v2-icon / -sm / -xs` | `16 / 14 / 12 px` |
| `--v2-fade-w` | `24px` — edge-fade width of `.v2-fade-x` strips |

**Horizontal strips (`.v2-fade-x`, v2-tokens.css).** Project tabs, filter-pill rows, board
columns and workspace tablists that can exceed their box are ONE row that scrolls sideways —
never wrap, never hard-cut mid-word. Put `.v2-fade-x` on the strip (nowrap flex, `overflow-x:auto`,
hidden scrollbar, children `flex:none`) and set `data-fade="start|end|both"` from scroll position
(`scrollLeft > 0` → start; `scrollLeft + clientWidth < scrollWidth` → end) to mask the cut edge.
On mount / route change call `activeEl.scrollIntoView({ inline: "center", block: "nearest" })` so
the current tab/pill is always visible. The page itself never scrolls sideways
(`html { overflow-x: clip }`, also in the pre-paint).

### 1.5c Chips, pills, circular icon buttons (D5/D8)

| Token | Value | Component |
|---|---|---|
| `--v2-chip-h`, `-px`, `-gap`, `-fs`, `-dot` | `22px`, `8px`, `6px`, `12px`, `7px` | metadata chip: rounded-full, 1 px border, colour dot + text (`● Performance`, `PR #55234`) |
| `--v2-chip-bg` / `-border` / `-text` | `transparent` / `#2C2D32` / `--v2-text-2` | |
| `--v2-pill-h`, `-px` | `28px`, `12px` | filter pill (`All · Active · Backlog`) |
| `--v2-pill-bg` / `-border` / `-text` | `transparent` / `--v2-border` / `--v2-text-2` | unselected |
| `--v2-pill-bg-selected` / `-border-selected` / `-text-selected` | `#26272C` / `#2E3035` / `--v2-text` | selected = filled subtle (+ `aria-pressed`/`aria-current`, not colour alone) |
| `--v2-iconbtn-size` / `-border` / `-bg` | `28px` / `--v2-border-strong` / `transparent` | circular icon button (header + pills row) |
| `--v2-livepill-h` | `20px` | "Working…" / "Waiting" / "Needs review" / "Error" / "Finished" outline pill + avatar |

### 1.6 Focus, elevation, z-index, motion

| Token | Value |
|---|---|
| `--v2-focus-ring` | `0 0 0 2px var(--v2-focus-color)` — ONE 2px ring hugging the element (r1: the old 2px canvas gap + 2px accent read as a thick two-tone halo). `--v2-focus-color` = `--v2-accent` (≥ 3:1 on window/panel/raised). Surface-independent, so it is not re-declared per scope. Controls must not add a second ring (no accent border + ring at once). |
| `--v2-focus-ring-inset` | `inset 0 0 0 2px var(--v2-accent), inset 0 0 0 3px var(--v2-canvas)` — rows/tabs inside overflow containers |
| `--v2-shadow-panel` | `0 1px 2px rgba(0,0,0,.28)` — the inset panel |
| `--v2-shadow-card` | `0 1px 1px rgba(0,0,0,.18)` — optional on cards |
| `--v2-shadow-pop` | `0 8px 28px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.2)` — popovers/dialogs; no glow |
| `--v2-z-sidebar / -header / -dock / -popover / -dialog / -toast / -palette` | `10 / 20 / 30 / 40 / 50 / 60 / 70` |
| `--v2-z-dialog-popover` | `55` — a Menu/Popover opened **from inside a dialog** (portaled to `body`) must use this, or it renders under the overlay and clicks land on `.v2-overlay` (r2 blocker: New-task Priority/Assignee menus). |
| `--v2-dur-fast` / `--v2-dur-base` / `--v2-ease` | `90ms` / `150ms` / `cubic-bezier(0.2,0,0,1)`; `0ms` under reduced motion |

### 1.7 Prohibited

Gradients, glass/blur, glow, large hero sections, oversized type (> 28 px), coloured left
stripes (D3), raw JSON (D4), rounded-square avatars (D7), nested rounded cards, white text on
the pastel `--v2-accent`, large pastel-accent filled blocks (primary = `--v2-primary-*`), two-tone focus halos, wrapping/hard-cut tab or pill rows, colour-only status, light theme / auto / skins, hard-coded hex values in page CSS, the same fact shown twice on one screen (D12 — e.g. a
"Live" dot next to a "Running" dot, an age in the row AND the card header), explanatory
boilerplate sentences where an (i) tooltip will do.

### 1.8 Legacy mapping (for migration)

Legacy variables (`--bg`, `--surface`, `--surface-2`, `--surface-3`, `--raised`, `--border(-2)`,
`--hover`, `--text(-2)`, `--muted`, `--faint`, `--accent*`, `--ok/--warn/--danger/--info/--violet/--idle`
(+ `-soft`/`-line`), `--diff-*`, `--shadow*`, `--ring`) are re-pointed in `v2-tokens.css` to V2
values (`--bg` follows `--v2-canvas`, i.e. panel inside the panel; `--surface-3` → `--v2-hover-solid`).
`data-theme` / `data-skin` are ignored. Desktop (`desktop/src/renderer/src/styles.css @theme`)
consumes **equivalent values**: `--color-bg` → `#0E0F10` (window), card → `#19191C`, panel →
`#151618`, text `#EEEFF1` / `#B4B7BE` / `#8A8F98`, border `#25262A`, accent `#8D93F7`, primary button `#5E6AD2` + white label, single 2 px accent focus ring,
ok/warn/danger as above, and the same Inter Variable opsz files + `"cv01","ss03"`.


---

## 2. Implementation (Agent B)

### 2.1 Where the tokens live

| File | Role |
|---|---|
| `P/static/styles/v2-tokens.css` | every §1 token as `--v2-*` on `:root`; **legacy mapping** (§1.8): `--bg`, `--surface`, `--surface-2`, `--raised`, `--border(-2)`, `--text(-2)`, `--muted`, `--faint`, `--accent(-ink/-soft/-line/-glow)`, `--amber`, `--ok/--warn/--danger/--info/--violet/--idle` (+ `-soft`/`-line`), `--diff-*`, `--shadow*`, `--ring` re-pointed to V2 values. Selectors `:root, :root[data-theme], :root[data-skin]` beat the legacy light/auto/skin blocks by specificity and order. Base `html/body` canvas, `:focus-visible` ring, `.v2-sr`, reduced-motion kill-switch, coarse-pointer row/control heights. |
| `P/static/styles/v2-primitives.css` | primitives below + light re-skin of legacy `.btn/.modal/.overlay/.pill/.card/.toast/.av` (no blur, no gradients; `.btn` / `.btn.approve` use `--v2-primary-*`, dark text on pastel accent/ok/danger badges). |
| `P/static/styles/v2-shell.css` | frame, sidebar, header, execution popover, connection states, palette, drawer, embedded mode. |
| `P/static/styles.css` | imports the three V2 files **last** (the r1 temporary `--v2-primary-*` repaint was folded into v2-primitives.css in r2). `responsive.css` (Swiss skin), `skin-minimal.css`, `skin-gold.css` are **no longer imported** (kept on disk for rollback). |
| `frontend/index.html` | pre-paint: inline `html,body{background:#0E0F10}` (= `--v2-window`, guarded by `tests/test_d0_design_system.py`) + the Inter font stack, `<link rel=preload>` of `inter-var-opsz-latin.woff2`, `data-theme="dark"`, drops `data-skin`, restores `data-sidebar` + `--v2-sidebar-user-w`, sets `data-embed="desktop"` from the capability/hint and strips `?embed=`. |

Contrast notes (static values; H re-verifies rendered): `--v2-faint` legacy `#5a6678` failed AA,
so `--faint` maps to `--v2-text-3` (5.6:1 on panel). Primary / `.btn` / `.btn.approve` fills are
`--v2-primary-bg` with a white label (4.7:1; hover 5.2:1). Remaining accent fills use
`--v2-text-on-accent` (`#0E0F10`): 7.0:1 on accent, ≈ 5.9:1 on `--v2-danger`, ≈ 7.5:1 on `--v2-ok` (computed, static).
Avatars are flat circles on the D13 palette (`hsl(h 34% 28%)` fill, `hsl(h 72% 86%)` initial; see §1.3d). Humans are neutral: no amber ring on `.av.human`, and the `Human` / `AI` kind badge is a neutral sentence-case chip (amber means attention in V2).

### 2.2 Dark-only mapping of stored preferences

`orcha:theme`, `orcha:skin` (localStorage) and the `/api/prefs` bag keep their values
(read-tolerant, never deleted, still PUT by the prefs mirror) but are **never applied**:
`initTheme()` (`F/shell/Shell.tsx`) and `index.html` pin `data-theme="dark"` and remove
`data-skin`; `F/cloud/projects/prefs.ts applyServer` mirrors theme/skin to storage without
touching `<html>`. `legacyThemePreference()` exposes the stored value (e.g. for G's Interface
section to say "your earlier choice X is now dark").

## 3. Primitives (`F/components/primitives`, import from `./components/primitives`)

| Component | Use | A11y contract |
|---|---|---|
| `Button` (`variant` primary · secondary · ghost · danger · link; `size` md 28 px · sm 24 px; `icon` / `iconRight` 14 px; `busy`) + `ButtonLink` (`to` / `href`) + `buttonClass()` | **Linear-style (D2).** `primary` (Linear indigo `--v2-primary-bg`, white label) ONLY for the single dominant action of a view. `secondary` (default) = subtle raised fill + 1 px border. `ghost` = no border, hover bg. `danger` = subtle fill, red text/icon — never a red slab. `link` = inline text action ("Expand full prompt", "Retry"). `approve` is a deprecated alias of `primary` (no green "Accept" slabs — use primary, or secondary with `icon="check"`). Navigational actions ("Open request →") are `ButtonLink variant="ghost" iconRight="arrow"`, never an oversized bordered block. Legacy `.btn` / `.btn.sm` / `.ghost` / `.subtle` / `.approve` / `.danger` / `.stop` are re-skinned to the same metrics until migrated. | `busy` ⇒ disabled + `aria-busy`, label kept. Always `type="button"` unless given. ≥ 44 px hit area on coarse pointers via `::after`. |
| `HelpTip` (`tip`, `label?`, `placement?`) | The ONE quiet "?" whose tooltip carries an explanation a sentence of copy used to (D12). A focusable `button.v2-help` (hover + keyboard focus open the tooltip); named by `label`, else the tip text. Replaces the per-page `.ov-help` / `.ob-help` / `.set-help` / `.cs-help` shims — never re-implement it. | Real button, `aria-label`; tooltip on focus. |
| `IconButton` (`icon`/`glyph`, **`label` required**, `size` sm·md, `shape` circle (default)·square, `variant` ghost·outline (the Linear 28 px toolbar circle)·secondary·solid·danger, `pressed`, `badge`, `busy`) + `iconButtonClass()` | Toolbar/inspector icons. `Button`/`ButtonLink`/`buttonClass` take `pill` for a fully rounded button. | `aria-label` + tooltip always; `aria-pressed` for toggles (the "on" state is a filled selected tone + stronger ring). |
| `Badge` / `Count` (`tone`) | Neutral metadata chips; counts are tabular. `Count n={null}` renders nothing (unknown ≠ 0). | — |
| `StatusDot` (`status`, `label?`, `showLabel`) | Legacy wrapper — renders the ONE D8 glyph set (`StatusGlyph`) + the label. Prefer `StatusIcon` in new code. | Exact `STAT` label always in the DOM (visible or `.v2-sr`). |
| `List` + `Row` (`selected`, `onActivate`, `href`, `dim`) | Dense lists (Tasks, Requests, roster, Needs you). **No coloured left stripes (D3)**: kind/urgency = a small status/type icon + muted coloured label text; rows are neutral with hairline separators. | `role=listbox/option`, `aria-selected`; selection = `--v2-selected` background (hover lighter). ↑/↓ (and `j`/`k` with `vimKeys`), Home/End, Enter — only when focus is on a row (never in inputs/CodeMirror/xterm). Rows keyed by stable `id` keep focus across live refreshes. |
| `SplitPane` (`list`, `inspector`, `storageKey`, `min/max`; drag uses pointer capture and ends on pointerup / pointercancel / lostpointercapture / blur; double-click resets; 1 px divider with a 9 px grab zone) + `Inspector` (title 15 px, clamped to 2 lines, full text in the tooltip) (`title`, `meta`, `onClose`, `expandHref`/`onExpand`, `actions`) | List/detail. Below 900 px the inspector becomes the full view (list hidden) — pages push a full-view URL so Back returns to the list. | Separator is focusable, `aria-valuenow`, ←/→ (Shift = bigger), Home/End; width persisted under the given key (`orcha:v2:<page>Inspector`). |
| `Tabs` + `TabPanel` (`icon`, `count`, `countTone`) | Task Overview/Activity/Runs, agent tabs. Mirror the tab in `?tab=`. Underline = 2 px `--v2-text`. Scrolls horizontally with edge fades; the selected tab is kept in view. | `tablist/tab/tabpanel`, roving tabindex, ←/→/Home/End, `aria-controls`. |
| `NavTabs` (`tabs: {key,label,to,count?,countTone?,icon?}`, `value`, `label`) | **The per-project section bar (D1)** under the breadcrumb header: Overview · Tasks · Agents · Requests · Code · GitHub · Activity · Metrics. Tabs are real links (URLs/deep links unchanged); counts cap at `99+`. | `<nav aria-label>`, current = `aria-current="page"`, ←/→/Home/End move focus, Enter follows; horizontal scroll + edge fades at narrow widths. |
| `Segmented` (`items`, `value`, `onChange`, `size`) | View/filter toggles — ONE style, sized to content (never stretched full-width). | `radiogroup`/`radio`, roving ←/→. |
| `MenuButton` (`label`, `value`, `items`, `icon`) | Compact (28 px) replacement for native `<select>`s and ad-hoc filter chips (sort, status, group). | `aria-haspopup=menu`, `aria-expanded`; items use `Menu`. |
| `Section` (`title`, `actions`) | Titled block separated by a hairline rule — use instead of nesting cards inside panes. | `section` labelled by its heading. |
| `Payload` (`value`, `exclude`, `labels`, `raw`, `empty`) + `KeyValue` + `ShortId` + `RawPayload`; helpers `payloadTitle`, `payloadText`, `normalizePayload`, `humanizeKey` | **D4: never render raw JSON, `{…}` or `[object Object]`.** Request / notification / activity payloads: title from summary/question/title/…; long body fields as markdown; remaining fields as a labelled key-value list (dates formatted, URLs linked, ids as `ShortId`); deep/unknown shapes in a collapsed pretty-printed disclosure ("Raw payload"). JSON strings are parsed first. Use `payloadTitle(p, "Request")` / `payloadText(p)` for one-line previews (palette, Needs you, notifications). | `ShortId` = mono muted short id + labelled copy button (full id in tooltip). |
| `Tooltip` (`label`, `placement`) | Styled tooltip (rail items, truncated names). Exported from the barrel. | `role=tooltip`, hover + focus-visible. |
| `Menu` (`items`, `label`) / `Popover` (`anchor`, `trap`, `role`) | Row ⋯ menus, filters, header popovers. Every hover-only action must also be a menu item. | `role=menu` + `menuitem`, roving ↑/↓/Home/End, Enter/Space, Escape returns focus to the anchor; disabled items carry `disabledReason` as tooltip. Items with `checked` (true **or** false) are `menuitemradio` + `aria-checked`, so the current choice (sort, model, effort) is announced. Clicks inside a dialog opened *from* the popover don't close it. |
| `Dialog` / `ConfirmDialog` (`danger`, `busy`) | Any modal; confirms carry the exact consequence copy. | Focus moves in (Cancel first on `danger`), Tab trapped, Escape/backdrop closes, focus restored to the opener. Legacy `Modal` (`components/ui.tsx`) got the same focus trap/restore. |
| `Toolbar`, `Breadcrumbs` (`collapsible`), `EmptyState` (`tone`, `icon`, `compact`), `Skeleton` | Filter bars, crumbs (last = `aria-current=page`; every crumb carries its full text as a tooltip; ancestors shrink first, the current crumb keeps ≥ 96 px; `collapsible` hides ancestors < 600 px), empty/error states (danger = `role=alert`; `compact` inside panes so they never leave a giant dead area), loading (`role=status`). | — |
| focus helpers | `useFocusReturn`, `trapTab`, `isEditingTarget`, `isEditorOrTerminal`. | — |

Toasts: `useToast()` unchanged; the region is now a persistent `role=status aria-live=polite`.

### 3.1 Identity + Linear iconography (D7/D8) — all from the barrel

| Component | Props · rules |
|---|---|
| `Avatar` | `alias`, `kind` (ai · human · project · system), `size` (16/20/24/32/48 or xs–xl), `ghLogin`, `status`, `showKind`, `label`, `decorative`, `palette` (slot from `assignPalette`), `seed` (projects: container id). Always a circle. `status` ⇒ bottom-right presence dot; otherwise AI actors get a sparkle badge at ≥ 20 px. Accessible name "alias · AI agent · <exact status label>". Set `--v2-av-ring` on the container so the badge ring matches the surface. Helpers: `AVATAR_HUES`, `paletteColor`, `paletteIndex`, `assignPalette`, `avatarColors`, `projectAvatarKey`, `projectInitials`. |
| `AvatarStack` | `actors[]`, `size` (20), `max` (3), `label`. −4 px overlap, "+N", everyone in the tooltip, collision-free colours, nothing when empty. |
| `StatusIcon` / `StatusGlyph` | `status`, `size` (14), `showLabel`, `label`, `decorative`. One glyph per `STAT` status (ready ring · pending dashed · idle/offline dotted · in progress yellow half · waiting amber pause · needs human amber ring+dot · needs verify green ¾ · completed/answered green check · blocked red bar · failed red × · terminated red stop · rejected red ring × · escalated red ↑ · cancelled grey slash · closed grey check · open ring+dot · accepted indigo check · converted indigo arrow). Helpers `statusShape`, `statusColor`, `statusLabel`. |
| `PriorityIcon` | `priority` (raw) or `level`, `showLabel`, `decorative`. Buckets from `taskQuery.priorityBucket`: urgent = orange "!" square; high/normal/low = 3/2/1 lit bars. Exact number in the tooltip. `priorityLevel()`. |
| `Chip` | `dot` (tone or `"auto"`), `icon`, `trailing`, `selected`, `size` sm·md, `href` · `to` (router Link) · `onClick` (button, `aria-pressed`, `disabled`). Rounded-full, 1 px border. Icon-only ⇒ 22 px circle. `PrChip {number, state, href}` — only with a real PR number. |
| `LivePill` + `liveStateFor({taskStatus, agentStatus, runStatus})` | "Working…" (shimmer, off under reduced motion) · Waiting · Needs review · Error · Finished, plus `actors`. `liveStateFor` returns `null` when nothing is live — render no pill. |
| `HealthChip` | `health` on_track · at_risk · off_track · no_data; word always printed; no data ⇒ `no_data`, never "On track". |

### 3.2 Linear layout blocks (primitives-b) — all from the barrel

| Component | Props · rules |
|---|---|
| `FilterPills` + `FilterBar` | `items:[{key,label,count?,icon?,to?,disabled?}]`, `value`, `onChange`, `label`, `size`. Radiogroup (←/→/Home/End); any `to` ⇒ a `<nav>` of links with `aria-current`. `count={null}` shows nothing. A pill row scrolls sideways on its own (`.v2-pills` never widens the page). `FilterBar {children, actions}`. |
| `GroupHeader` / `ListGroup` | Band header: `title`, `count`, `glyph`, `open`/`onToggle`, `onAdd`+`addLabel` ("+" on hover/focus, always on touch), `actions`, `level`. `ListGroup {id, defaultOpen \| open+onOpenChange, storageKey}` owns collapse (`aria-expanded`/`aria-controls`, `hidden` body), saved as `${storageKey}:${id}`. |
| `Timeline` (`label`) | Children: `TimelineEvent {icon\|glyph, actor, children, at\|time, trailing, body, oneLine}` ("actor verb **object** · 5m ago"; `oneLine` ellipsizes the sentence and keeps the time whole; `body` = one muted line under it), `TimelineCard` ⊃ `TimelineMessage {author, avatar, meta, at\|time, actions}` / `TimelineCardEvent`, `TimelineComment`, `TimelineDivider`. `RelTime {at}` = `<time>` + absolute tooltip. Message meta ellipsizes before the author. |
| `PropertyRail` ⊃ `PropertySection {title, actions}` ⊃ `Property {label, empty="None", layout row·stack, hint}` | Right rail (96 px label column). Always give an explicit `empty` when a missing value means something ("Unavailable", "No reviewer"). |
| `Composer` | `value, onChange, onSubmit, label, placeholder, busy, running+onStop, stopLabel, disabled+disabledReason, onFiles, accept, attachments, leading, tools, submitLabel, allowEmpty, minRows, maxHeight, id, attachButtonId, submitButtonId`. Enter sends · Shift+Enter newline · IME never submits · Cmd/Ctrl+Enter always sends. `ContextChip {icon, onRemove, removeLabel}`, `AttachGlyph`. |
| `Board` ⊃ `BoardColumn {id, title, icon, status, count, menu, onAdd, addLabel, empty}` ⊃ `BoardCard {id, topRight, glyph, title, chips, to\|href\|onClick, selected, dim, label?}` | Equal columns ≥ 280 px; 86 % snap columns on phones; the board is `position: relative` so sr-only/badge bits never widen the page. Chips in a card are not clickable (the card is the link). |
| `ChatThread` (`role=log`) ⊃ `ChatBubble {from user·agent·system, author, avatar, at, status, statusTone, compact}`, `ChatNote`, `WorkedFor {ms, running, label, defaultOpen}` | User = right-aligned bubble, agent = plain text. `formatDuration(ms)` returns null for unknown (never "0 sec"). |
| `ChangesCard` | `files, additions, deletions, pr:{number,title,state,href}, base, branch, action`. Missing fields are omitted (never 0); no data ⇒ renders nothing. Only from real run/PR data. |

### 3.3 Page patterns

- **Settings forms** — `SettingsGroup` (title + one-line description above one bordered box),
  `SettingRows` / `SettingRow` (label + muted description left, control right, 52 px rows) from
  `F/pages/settings/settingsUi.tsx`.
- **Code Space** — `F/cloud/codespace/threadBits.tsx` (thread status icon + author avatar
  helpers); pane toggles persist under `orcha:cs:collapsed`.
- **Pill row with a view switch** (Activity "All runs · Running · … · Events", Linear My issues).

## 4. Shell (`F/shell`)

- **Frame** (`chrome.tsx AppFrame`, registered as a layout route in `shell/routes.tsx`): the
  sidebar mounts once for every in-app route; pages keep rendering `<Shell>` which renders
  header + content. A page mounted without the frame (unit tests) gets the same chrome and its
  own sidebar from `<Shell>`. `/auth/device` stays standalone.
- **Shell props** (`ShellProps`): legacy `page`, `title`, `ctx` keep working; V2 adds
  `crumbs?: Crumb[]` (after Project / Section), `primaryAction?: ReactNode` (the ONE dominant
  action), `secondaryActions?: ReactNode`. `title="Dashboard"` renders as "Overview". Page keys:
  `home, tasks, agents, requests, code, github, metrics, settings, members, needs, activity`.
- **Header**: breadcrumbs · ctx meta · primary · secondary · connection indicator
  (Live / Polling / Reconnecting… / Offline + last update; click = refresh now) · persistent
  "Wakes paused" chip + pause bar · **Execution** button (`#execBtn`, always shows
  "Running|Paused · <level>") → popover dialog with the unchanged Notifier (`#notifTop`) and
  Autonomy (`#autTop`) controls and their confirm copy · bell (`#attnPill`, count = shared
  attention) → notification center (`#ncFloat`; Needs-you zone from `useAttention`, Earlier
  feed/pagination/mark-all-read unchanged). Offline/unreachable ⇒ `v2-stalebar` "showing data
  from HH:MM — not live" with Retry. No theme toggle.
- **Sidebar** (`Sidebar.tsx`): contract §8 of the architecture. Width `--v2-sidebar-w`
  (248, 200–360, `orcha:v2:sidebarWidth`, drag or keyboard on the separator, double-click
  resets), rail 56 px (`orcha:sidebar` + `data-sidebar`), drawer < 900 px (`data-drawer`,
  hamburger in header, Escape/navigation closes; rail pref ignored in the drawer). Counts:
  Needs you = `useAttention` (`N+` when partial, nothing when unknown); selected project row =
  same; other rows = `/api/containers needs_you` titled "pending decisions (excl. plan
  approvals) · as of HH:MM", missing ⇒ nothing rendered (marked `data-unavailable`, "unavailable"
  in the accessible name). **D11 live agents nest under their project row** (no standalone
  section): only the selected project has a snapshot, so only it shows them — working, needs
  review, blocked/failed agents (never idle), ≤ 3 + "+N more" → `/agents`; row = 16 px round
  avatar + status dot, alias, ONE muted fragment (task / "needs review" / status / age). The
  disclosure caret is open by default and remembered per project (`orcha:v2:sbProjAgents`).
  Section collapse (`favorites`, `projects`) persists in `orcha:v2:sbSections`. `[` toggles the
  rail (never while typing/in editors/with a dialog open). Compose = `COMPOSE_HREF`
  (`/tasks?new=1`), `RAIL_TOGGLE_KEY`; `<Tooltip shortcut="⌘K">` adds a keycap. Hooks:
  `.v2-sb-circle` (+ `.is-bordered`), `.v2-sb-h`/`.v2-sb-h-btn`, `--v2-sb-row-h` (28 px).
- **D5 frame + page chrome** (`Shell` / `PageChrome`): `toolbar?: ReactNode` = the fixed
  filter-pill row under the header; `flush?: boolean` = edge-to-edge content. From
  `shell/PageChrome` (re-exported by `Shell`): `PageToolbar {label, children, end}`,
  `FilterPills`, `CircleIconButton` (= `IconButton variant="outline"`), `PageHeader {glyph, id,
  title, titleAs h1·h2·div, trailing, actions, pager}` (the page places the 44 px container;
  the row layout is the shared `.v2-pagehead*` in `v2-shell.css`), `Pager {index, total,
  onPrev, onNext, noun}` ("1 / 84 ↑ ↓", `.v2-pager*`), `scrollMainTo(top)` /
  `mainScrollTop()` (never `window.scrollTo` — wide layouts scroll inside the panel). CSS hooks:
  `--v2-chrome-h`, `--v2-content-h` (fill-height regions), `--v2-sticky-top`; `#main` is the
  scroller (`tabIndex=-1`; drawer navigation focuses it). New task deep link:
  `/tasks?new=1&for=<alias>` pre-fills the assignee (only a real AI agent).
- **Palette** (`search/`): `registerSearchProvider({ id, group, minQuery?, limit?, search(q, ctx) })`
  from `search/providers.ts`; built-ins in `search/builtin.ts` (Actions, Navigate, Projects,
  Tasks, Requests, Agents). Results may carry `href` (SPA, cid-scoped; Cmd/Ctrl+Enter = new tab),
  `hardHref` (project switch), `run`, `status`, `disabledReason`. A provider that throws shows
  "<Group> search unavailable: <reason>" while others render. Recent destinations are stored
  per project (`orcha:v2:search:<cid>:recent`). **F**: register the Files provider from your own
  module and ask B (requests/B.md) to add the import to `extensions.ts`.
- **Hotkeys**: Cmd/Ctrl+K toggles the palette except inside `.cm-editor`/`.xterm`; `/` opens it
  only outside inputs/editors/terminals.
- **Embedded (desktop)**: `state/host.ts` mirrors `desktop/src/shared/embed.ts`. Sidebar-capable
  host ⇒ `<html data-embed="desktop">`, no portal sidebar/hamburger, acting chip + search button
  in the header; sends `ready` (every load), `route` (every location change), `attention`
  (`null` before the snapshot), `liveAgents` (≤ 5); handles `navigate` (safe paths only, SPA),
  `openSearch`, `hostModal` (closes palette/popovers, blocks opening).

## 5. Usage rules for page owners (D/E/F/G)

1. Use `--v2-*` tokens or the primitives; never hard-code colours. Legacy class names still
   render in V2 colours, but migrate to primitives as you touch a page.
2. One `primaryAction` per page via `<Shell primaryAction={…}>`; don't render a second page
   title inside content (the breadcrumb is the title).
3. Attention anywhere = `useAttention()` / `selectAttention()` from `state/attention.ts`; open
   work = `openWorkCounts()`. Never label `task_open_total` as "needs you".
4. Freshness: read `connection` / `stale` / `lastOkAt` from `useSnapshot()` before claiming
   anything is live.
5. Status = `StatusDot` (exact label). Don't merge failed/blocked or cancelled/completed.
6. Selection/filter state in the URL with `replace`; full-view detail at narrow widths `push`.

## New task from anywhere (r2)
"New task" (sidebar compose, Overview header + checklist, Agents board column "+",
palette) calls `useOpenCompose()` from `shell/chrome.tsx`: the Shell-owned composer
opens OVER the current route (Esc leaves you there); only on `/tasks` does it defer
to the page's own `?new=1` composer. Never `navigate("/tasks?new=1")` from a page.
