# Orcha Mobile — Design Foundations

Phase 1 of the mobile design for GitHub issue [#30](https://github.com/open-orcha/orcha/issues/30).
Companion apps (iOS + Android) share one visual language with the web portal; this document and
[`tokens/orcha-mobile-tokens.json`](tokens/orcha-mobile-tokens.json) are the source for it.

**Ground truth:** every color/typeface value here is copied from the portal stylesheet
`orcha-cli/orcha_cli/templates/portal/static/styles.css` (dark = `:root`, light = `[data-theme="light"]`),
and the launcher icon is `desktop/resources/icon.svg`. If the portal palette changes, change the token
file, not downstream app code.

---

## 1. Principles

1. **One family, three clients.** Portal, iOS, Android must be recognizably the same product:
   same palette, same status colors, same voice. A user who pairs their phone should feel zero
   translation cost coming from the portal.
2. **Platform-adapted, not platform-cloned.** Navigation, sheets/dialogs, back behavior, and
   controls follow Material 3 on Android and Apple HIG on iOS. The *skin* (color, type rhythm,
   badge language) is shared; the *skeleton* is native.
3. **Dark-first, light-equal.** The portal defaults dark; both themes are first-class on mobile with
   an `auto` (follow system) default. Every screen must be checked in both.
4. **Status is the interface.** Orcha is about watching agents work. The status color system
   (tasks/requests/agents) is the most load-bearing part of the design — it must be identical in
   meaning across all clients.

## 2. Color

All values in [`tokens/orcha-mobile-tokens.json`](tokens/orcha-mobile-tokens.json) → `color.dark` / `color.light`.

| Role | Dark | Light | Notes |
|---|---|---|---|
| Background | `#0a0d12` | `#f3f6fa` | plus two faint radial brand gradients (`bgGrad1/2`) |
| Surface / card | `#111620` | `#ffffff` | `surface2`/`surface3` for nested layers |
| Border | `#232d3d` / `#2c3848` | `#e4eaf2` / `#d3dce8` | hairline 1px |
| Text | `#e8edf6` | `#0e1722` | `text2`, `muted`, `faint` for hierarchy |
| **Accent (brand teal)** | `#1fc7cd` | `#0c9aa0` | primary actions, working state, links |
| Text on accent | `#04181a` | `#ffffff` | `accentInk` |
| OK | `#38d39a` | `#11a472` | completed |
| Info | `#5aa6ff` | `#2f74e6` | ready / open |
| Warn | `#f5b13d` | `#c9871a` | blocked |
| Danger | `#f6757e` | `#d94a55` | cancelled / rejected / errors |
| Violet | `#b08cff` | `#7b54d6` | needs-verification / answered — "a human should look" |
| Idle | `#6b788e` | `#768296` | pending / closed / idle |

Each semantic color ships with a `*Soft` (badge fill) and `*Line` (badge border) variant — badges are
always *color text on Soft fill with Line border*, exactly like the portal `.pill` classes.

### Status → color mapping (binding, from `statusColor` in the token file)

| Domain | Status | Color |
|---|---|---|
| Task | pending | idle |
| Task | ready | info |
| Task | in_progress | accent |
| Task | blocked | warn |
| Task | needs_verification | violet |
| Task | completed | ok |
| Task | cancelled | danger |
| Request | open | info |
| Request | accepted | accent |
| Request | rejected | danger |
| Request | answered | violet |
| Request | converted_to_task | violet |
| Request | closed | idle |
| Agent | idle | idle |
| Agent | working | accent (pulsing glyph) |
| Agent | blocked | warn |
| Agent | awaiting_request | info |
| Agent | awaiting_human | violet |
| Agent | terminated | danger |

### Accessibility

- Dark accent `#1fc7cd` on `#0a0d12` ≈ 9.9:1; light accent `#0c9aa0` on white ≈ 4.6:1 — both pass
  WCAG AA for text. Semantic colors are used at ≥12px semibold on Soft fills; all pass AA for
  UI text at the sizes specced here.
- Status is never conveyed by color alone: every badge carries its status **word**, and agent
  status also gets a glyph (pulse dot) — matching the portal.

## 3. Typography

- **Sans:** Inter (bundle 400/500/650-Medium-ish/700/800 axes or static cuts). Fallback: SF Pro (iOS),
  Roboto (Android). Inter's metrics are close enough to both that fallback screens don't shift.
- **Mono:** JetBrains Mono 400-700, bundled on both platforms — used for run logs, model ids, short
  ids, timestamps in log contexts (same as portal).

Type scale (`typography.scale` in the token file): `displaySm 24/800` (screen titles on scroll-collapse),
`titleLg 20/750` (large titles), `titleMd 17/700` (card titles), `titleSm 15/650` (list item titles),
`body 15/400`, `bodySm 13/400`, `label 12/650` (badges, meta), `overline 11/700 uppercase` (section
headers, matches portal's 11.5px 650 uppercase kickers), `mono 12`, `monoSm 10.5` (model tags).

Dynamic Type (iOS) / font scale (Android) must be honored: the scale above is the 100% reference;
all text uses relative styles so system accessibility sizes work.

## 4. Spacing, radius, elevation

- **Grid:** 4pt. Screen margin 16, card padding 14, list gap 10 (portal rhythm).
- **Radius:** cards 12, small elements 8, sheets 22 top corners, pills/badges 999, chat bubbles 16
  with a 6 tail corner.
- **Elevation:** portal shadows mapped to three levels (token `elevation`). Android dark theme
  prefers tonal elevation (surface → surface2 → surface3) over shadows per Material 3; iOS uses
  hairline borders + subtle shadow, matching the portal's card look.

## 5. Iconography

- UI icons: **Material Symbols (rounded, weight 500)** on Android; **SF Symbols (regular/medium)** on
  iOS. Shared meaning table lives in the component inventory (doc 12).
- Brand mark: the orca glyph from `desktop/resources/icon.svg` — teal orca on dark gradient squircle
  (`#0e2d33 → #06171c` radial). The in-app brand row (nav headers, about screen) uses the orca glyph
  alone, tinted `text` color or accent, never the full tile.

## 6. Launcher icon export matrix

Source of truth: `desktop/resources/icon.svg` (1024×1024, tile gradient + orca).
The tile's built-in squircle (`rx=230`) is for contexts that don't mask; both mobile platforms mask
for us, so exports below use a **full-bleed** variant: same radial gradient background extended to
the square canvas, orca group scaled so the glyph occupies the safe zone.

### iOS (asset catalog `AppIcon.appiconset`)

Xcode 14+ single-size flow: supply **1024×1024 PNG, no alpha, sRGB**; Xcode derives all sizes.
Provide additionally (optional but recommended):

| Variant | Size | Notes |
|---|---|---|
| App Store / universal | 1024×1024 | no transparency, no rounded corners (Apple masks) |
| Dark variant | 1024×1024 | same art; tile gradient already dark — supply as-is |
| Tinted variant | 1024×1024 | grayscale orca on transparent, per iOS 18 tinted-icon spec |

### Android (adaptive icon)

Adaptive icon = background layer + foreground layer, each **108dp canvas with 66dp safe zone**
(outer 21dp per side may be masked/parallaxed).

| Asset | Content | Exports |
|---|---|---|
| `ic_launcher_background` | radial gradient `#0e2d33 → #06171c` (or solid `#06171c` + gradient drawable) | vector drawable preferred; else PNG per density |
| `ic_launcher_foreground` | orca glyph + teal wave, centered in 66dp safe zone | vector drawable from icon.svg paths |
| `ic_launcher_monochrome` | orca glyph single-color silhouette | vector, for Android 13+ themed icons |
| Legacy round/square PNGs | composited tile | mdpi 48, hdpi 72, xhdpi 96, xxhdpi 144, xxxhdpi 192 px |
| Play Store listing | composited tile | 512×512 PNG, 32-bit with alpha |

**Asset production note:** the orca paths in `icon.svg` are simple (`<path>` + circles + strokes) and
convert cleanly to an Android `VectorDrawable` and a PDF/SVG for the iOS tinted variant. No redraw needed.

## 7. Theming behavior

- Setting: **Auto (default) / Light / Dark**, in app Settings — same three-way toggle as the portal.
- Theme is app-wide and instant (no restart). Status bar / nav bar chrome follows theme
  (`bg`-colored, transparent-friendly with edge-to-edge on Android 15+, iOS standard).
- All mockups in `mockups/` render both themes via the shared stylesheet.
