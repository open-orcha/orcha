# Onboarding UX Redesign — Single-Window Stepper + Modern UI

**Date:** 2026-06-18
**Repo:** `open-orcha/orcha` · branch `feat/desktop-onboarding`
**Status:** Approved design (brainstorming complete)
**Supersedes UI of:** `2026-06-18-desktop-onboarding-design.md` (the provisioning engine/IPC built there is unchanged; only the renderer presentation + window model change)

## 1. Problem

The shipped onboarding opened a **second** `BrowserWindow` (and auto-opened it on
first launch alongside the manager window), producing two stacked windows. The UI
is also bare hand-written CSS. Goals:

1. **One window** — onboarding is a full-screen **stepper** inside the manager
   window, not a separate window.
2. **Modern React UI** — Tailwind v4 + local shadcn/Radix-style components across
   the whole renderer.
3. **Seamless** — animated transitions, no window pops, no empty-state flashes, one
   cohesive design system so "the wizard" and "the app" read as one product.

## 2. Key decisions (resolved during brainstorming)

- **Window model:** onboarding lives **inside the manager window**, route-switched
  in the renderer (`appMode: 'manager' | 'onboarding'`). The separate onboarding
  `BrowserWindow` and its auto-open-on-first-launch are removed.
- **UI stack:** Tailwind CSS **v4** (CSS-first, `@tailwindcss/vite`, no
  `tailwind.config.js`/`postcss.config.js`) + a **local shadcn-style component kit**
  (vendored primitives, not a runtime UI dep) using Radix where it matters
  (Progress, focus), `lucide-react` icons, `class-variance-authority` variants,
  `clsx`+`tailwind-merge` `cn()`.
- **Refresh scope:** the **whole renderer** — onboarding stepper, manager stack
  list, cards/rows, empty state, banners, and the tray popover — share one design
  system.
- **Stepper:** **4 steps** — `Docker (preflight) → Folder → Details → Create` —
  with an inline animated live-progress checklist + streaming log in step 4, ending
  in a success state that hands off to the portal `/onboarding`.
- **Motion:** **CSS transitions first** (one shared ~150–200ms duration token); no
  `framer-motion` unless the CSS version feels stiff after review.

## 3. Seamless requirements (explicit)

- **Manager ↔ onboarding**: cross-fade/slide within the same window; never a window
  pop (there is no second window anymore).
- **Step → step**: horizontal slide; stepper dots fill progressively; forward/back
  feel directional. Implemented with CSS keyframes + a small presence wrapper (no
  motion lib).
- **First launch**: starts directly in onboarding mode — the initial `appMode` is
  decided from `listStacks()` before first meaningful paint, so the empty manager
  never flashes before the wizard.
- **Provision → success → portal**: the checklist animates each step to ✓ as
  `ProgressEvent`s stream; success state; then the portal window opens with the
  manager already returned to its (now-populated) stack list behind it.
- **Consistency**: all surfaces share tokens/components, so there is no visual seam
  between wizard and app. Shared hover/active/focus/disabled states and motion
  timing.

## 4. Architecture

```
Renderer (single manager window)
  App.tsx ── appMode: 'manager' | 'onboarding'  (decided from listStacks before paint)
    ├─ <ManagerView>     (extracted current App body, restyled)
    │    ├─ StackList → StackCard / StackRow
    │    ├─ EmptyState  ([Create your first project] → setMode('onboarding'))
    │    ├─ DockerDownBanner
    │    └─ ViewToggle
    └─ <OnboardingWizard> (4-step state machine)
         ├─ <Stepper> (progress dots/bar)
         └─ steps/ PreflightStep · FolderStep · DetailsStep · ProvisionStep
              uses useProvisionStream (unchanged) for the live checklist
         onDone() → setMode('manager');  success → openOnboardingPortal(project)

UI kit  src/renderer/src/ui/  — cn, Button, Card, Input, Label, Progress, Badge, Stepper

Tray  TrayPanel (restyled, same data flow)  — separate #tray window, unchanged behavior

Main process
  - delete onboardingWindow.ts; remove showOnboardingWindow() + orcha:openOnboarding
  - File→New Project (appMenu) + (optional) first-launch send a one-way
    'orcha:navigate' → 'onboarding' to the manager window's webContents
  - progress events (orcha:provision:progress) target the manager window webContents
  - onboarding IPC handlers (preflight/pickFolder/inspectFolder/provision/
    openOnboardingPortal) and the provision ENGINE are UNCHANGED
```

## 5. Build setup (Tailwind v4 + kit)

- **Add deps:** `tailwindcss@^4`, `@tailwindcss/vite`, `clsx`, `tailwind-merge`,
  `class-variance-authority`, `lucide-react`, and the Radix primitives actually used
  (`@radix-ui/react-progress`, `@radix-ui/react-slot`).
- **`electron.vite.config.ts`:** add `tailwindcss()` to `renderer.plugins` alongside
  `react()`.
- **`styles.css`:** replace hand-CSS with `@import "tailwindcss";` + an `@theme`
  block mapping the existing palette to tokens: `--color-bg #141311`,
  `--color-card #1d1b18`, `--color-text #efe9df`, `--color-accent #f0b94b`,
  `--color-ok #42d98a`, `--color-danger #d9544f`, plus a shared
  `--duration-base: 180ms`. Keep a few app-level utility classes if needed.
- **No `tailwind.config.js` / `postcss.config.js`** (v4 is CSS-first).

## 6. UI kit (`src/renderer/src/ui/`)

Local, vendored, focused files (shadcn convention — copy-in components):
- `cn.ts` — `clsx` + `tailwind-merge` helper.
- `Button.tsx` — CVA variants (`default | ghost | destructive | outline`, sizes),
  `Slot` for `asChild`.
- `Card.tsx`, `Input.tsx`, `Label.tsx`, `Badge.tsx`.
- `Progress.tsx` — Radix Progress.
- `Stepper.tsx` — numbered/dot steps with a connecting bar; `current`, `steps[]`,
  done/active/upcoming states; accessible (`aria-current`).

All existing components (StackCard, StackRow, EmptyState, DockerDownBanner,
ViewToggle, TrayPanel) are rewritten to use the kit + Tailwind utilities. Behavior
and data flow unchanged.

## 7. Stepper flow (4 steps)

1. **Docker** — calls `preflight()`; shows status (checking → ok / not-installed /
   daemon-down with auto-start spinner). **Continue** disabled until `docker==='ok'`;
   **Re-check** button on failure.
2. **Folder** — `pickFolder('existing')`; shows chosen path; `inspectFolder` decides
   init vs reconnect (initialized folder → a "reconnect / open" note, never clobber).
3. **Details** — project name (prefilled from `suggestedName`), optional objective.
4. **Create** — calls `provision({folder, mode:'init', name, objective})`; renders
   the streamed `ProgressEvent`s as an animated checklist + a collapsible live log;
   on success → success panel → `openOnboardingPortal(project)` → `onDone()`.

Back/Next nav; can't advance past a failed preflight. The stale-run guard in
`useProvisionStream` (drop events whose runId ≠ first-seen) is preserved.

## 8. Main-process changes

- **Delete** `src/main/onboardingWindow.ts`; remove its imports/uses from
  `index.ts`. Remove the `orcha:openOnboarding` handler and the
  `showOnboardingWindow` references (menu + first-launch).
- **App menu** `File → New Project` now sends `mainWindow.webContents.send(
  'orcha:navigate', 'onboarding')` (a new one-way channel). The preload exposes
  `onNavigate(cb): () => void`.
- **First launch:** the renderer decides initial mode from `listStacks()`. Main no
  longer force-opens a window; it just creates the manager window as today. (The
  zero-stacks → onboarding decision moves entirely to the renderer.)
- **Progress streaming:** `orcha:provision:progress` is sent to the manager window's
  webContents (the only window now). `onboardingWebContents()` is replaced by
  sending to `managerWindow`.
- The provision **engine**, preflight, folderModes, templates, IPC handler bodies
  (preflight/pickFolder/inspectFolder/provision/openOnboardingPortal) are
  **unchanged**.

## 9. Testing

- **Kit:** `ui/Stepper.test.tsx` (active/done/upcoming + aria-current), light render
  tests for Button/Progress where logic exists.
- **Onboarding:** `OnboardingWizard.test.tsx` — step progression
  (preflight→folder→details→create), provision called with correct args, streamed
  events render the checklist, stale-run events ignored, success → `openOnboardingPortal`
  called once → `onDone`.
- **App:** `App.test.tsx` updated for `appMode` switching (zero stacks → onboarding
  mode; ≥1 → manager; EmptyState button switches mode; `onNavigate` switches mode).
- **Existing component tests** (StackCard/StackRow/EmptyState/TrayPanel): updated
  selectors only where markup changes; RTL role/text queries survive restyling. The
  `window.orchaDesktop` stubs lose `openOnboarding`, gain `onNavigate`.
- Gate: `npm test` + `npm run typecheck` + `npm run build` all green. Manual smoke:
  packaged DMG launches, one window, wizard auto-shown at zero stacks, full provision
  → portal handoff.

## 10. Out of scope

- The provisioning engine, preflight, folder modes, templates, DMG packaging
  (all unchanged).
- `framer-motion` / spring physics (CSS transitions first; revisit only if stiff).
- Tray popover behavior (restyled only, same logic).
- Reconnect/upgrade/reset UI beyond the "don't clobber, show a note" already speced.
```
