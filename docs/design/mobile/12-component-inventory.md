# Orcha Mobile — Component Inventory

Every reusable mobile component, mapped to (a) its web-portal equivalent (ground truth:
`orcha-cli/orcha_cli/templates/portal/static/styles.css` + page templates) and (b) the native
building block each platform implements it with. Mockup kit class = the CSS class in
`mockups/mobile.css` that renders it in the design mockups.

## Core components

| Component | Portal equivalent | Android (Material 3 / Compose) | iOS (SwiftUI) | Mockup kit |
|---|---|---|---|---|
| Status pill | `.pill` + `.s-*` classes | `SuggestionChip`-style custom chip (tinted container + outline) | `Capsule` w/ tinted bg + overlay stroke | `.pill.s-*` |
| Working pulse | `.pill.s-working .gl pulse` | `InfiniteTransition` alpha anim on dot | `.opacity` w/ repeatForever animation | `.pill.pulse` |
| Card | `.card` (12px radius, border, surface) | `OutlinedCard` (surface, 12dp) | `RoundedRectangle(12)` fill+stroke | `.card` |
| Section header (kicker) | portal 11.5px 650 uppercase headers | `Text` w/ `labelSmall` + tracking | `Text` `.caption` smallcaps-style | `.section-h` |
| Model/meta tag | `.tag`, `.tag.model` (mono) | `AssistChip` compact | bordered `Text` mono | `.tag`, `.tag.model` |
| Primary button | portal accent button | `Button` (full-radius, primary) | `.borderedProminent` tinted accent | `.btn.primary` |
| Tonal button | accent-soft buttons | `FilledTonalButton` | `.bordered` w/ accent tint | `.btn.tonal` |
| Destructive-tonal | danger-soft buttons | `FilledTonalButton` (error colors) | `.bordered` `.tint(.danger)` | `.btn.danger-tonal` |
| Text field | portal inputs | `OutlinedTextField` | `TextField` w/ rounded bg | `.input` |
| Multiline field | portal textareas | `OutlinedTextField` minLines | `TextEditor` in rounded bg | `.input.area` |
| Segmented control | theme toggle triple | `SingleChoiceSegmentedButtonRow` | `Picker` `.segmented` | `.seg` |
| Avatar (agent) | agent initial tiles | custom `Box` rounded-12 | `RoundedRectangle` w/ initial | `.avatar` |
| Avatar (human) | round human dot | round variant | `Circle` variant | `.avatar.human` |
| Stat tile | home KPI tiles | `Card` + big numeral | same | `.stat` |
| Connection indicator | portal SSE dot | pulsing dot + label | same | `.conn` (`.polling`, `.off`) |
| Banner (inline alert) | portal notice rows | custom row (tinted container) | same | `.banner.warn/.danger/.info` |
| Skeleton loader | (portal has none — spinner) | shimmer `Modifier` | redacted/shimmer | `.skel` |
| Empty/error state | portal empty text | column: glyph + title + sub + action | same | `.state` |
| Brand mark | portal `.brand .mark` orca | `Image` vector drawable | `Image` asset | `.brandmark` |

## Navigation & chrome

| Component | Portal equivalent | Android | iOS | Mockup kit |
|---|---|---|---|---|
| Bottom navigation | portal top nav links | M3 `NavigationBar` (active indicator pill, labels) | `TabView` (SF Symbols) | `.tabbar` (+ `.ind` Android) |
| Tab badge | portal count chips | `Badge` on nav item | `.badge()` | `.tab .bdg` |
| Top app bar | portal page header | `TopAppBar` / `LargeTopAppBar` (collapsing) | nav bar / large title | `.appbar`, `.appbar.large` |
| Back affordance | browser back | predictive back arrow | chevron + swipe-back | `.backbtn` |
| Overflow menu | portal "…" menus | `DropdownMenu` on `IconButton` | `Menu` on ellipsis | `.iconbtn` |
| FAB (create) | portal "+ New task" button | `FloatingActionButton` (16dp radius) | — (toolbar `+` instead) | `.fab` |
| Pull-to-refresh | manual refresh | `PullToRefreshBox` | `.refreshable` | (annotation only) |
| Search | portal filter inputs | M3 `SearchBar` | `.searchable` | `.input` w/ icon |

## Surfaces

| Component | Portal equivalent | Android | iOS | Mockup kit |
|---|---|---|---|---|
| Action sheet (respond/approve/verify/picker) | portal modals | `ModalBottomSheet` (drag handle) | `.sheet` w/ `.medium/.large` detents | `.sheet` (+ `.scrim`) |
| Destructive confirm | `confirm()` dialogs | M3 `AlertDialog` | `confirmationDialog` | `.dialog` / `.action-sheet` |
| Transient feedback | portal toasts | `Snackbar` | top banner toast (custom) | `.snackbar` / `.toast` |

## Content components

| Component | Portal equivalent | Android | iOS | Mockup kit |
|---|---|---|---|---|
| Thread bubble (agent) | task thread rows | left-aligned surface-2 bubble | same | `.bubble.theirs` |
| Thread bubble (me/human) | human thread rows | right-aligned accent bubble | same | `.bubble.mine` |
| System/decision bubble | portal decision rows (amber) | centered dashed chip | same | `.bubble.system` |
| Composer | portal reply box | `TextField` + send `IconButton` in bottom bar (imePadding) | same in `safeAreaInset(.bottom)` | `.composer` |
| Log viewer | `.log` (JetBrains Mono 12px) | `LazyColumn` mono text, color-keyed lines | `ScrollView` mono w/ auto-scroll anchor | `.log` (+ `.ln-*`) |
| Diff view (v2) | `.diff` classes | mono w/ add/del line tints | same | (tokens only: `diff*`) |
| Key-value row | portal detail tables | `ListItem` two-slot | `LabeledContent` | `.kv` |
| QR display (portal) | — (new) | — | — | `.qr` |
| Filter chips | portal filter buttons | `FilterChip` row | capsule buttons `ScrollView(.horizontal)` | `.pill` variants |

## Status → component contract

The pill is the single place status is rendered. Never restyle per-screen; always the mapping in
[`01-foundations.md`](01-foundations.md) §2 / token `statusColor`. Status words appear verbatim
(`needs_verification` renders as "needs verification"; `converted_to_task` as "became a task";
`awaiting_human` as "waiting on you" when the viewer is the human — copy table below).

| Raw status | Display copy |
|---|---|
| `in_progress` | in progress |
| `needs_verification` | needs verification |
| `converted_to_task` | became a task |
| `awaiting_request` | waiting on a request |
| `awaiting_human` | waiting on you |
| everything else | as-is |

## Icon language

| Meaning | Material Symbol (rounded) | SF Symbol |
|---|---|---|
| Home tab | `home` | `house.fill` |
| Tasks tab | `checklist` | `checklist` |
| Requests tab | `forum` | `tray.full.fill` |
| Agents tab | `smart_toy` | `sparkles` |
| Add / create | `add` | `plus` |
| Scan QR | `qr_code_scanner` | `qrcode.viewfinder` |
| Send | `send` | `arrow.up.circle.fill` |
| Nudge | `notifications_active` | `bell.badge` |
| Approve | `check` | `checkmark` |
| Reject / send back | `undo` | `arrow.uturn.backward` |
| Cancel task | `cancel` | `xmark.circle` |
| Run log | `terminal` | `terminal` |
| Model | `memory` | `cpu` |
| Unreachable | `wifi_off` | `wifi.slash` |
| Settings | `settings` | `gearshape` |
