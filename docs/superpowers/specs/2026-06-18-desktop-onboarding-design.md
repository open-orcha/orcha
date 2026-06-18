# Desktop Onboarding & "New Project" — Design

**Date:** 2026-06-18
**Repo:** `open-orcha/orcha` · branch `feat/desktop-onboarding`
**Status:** Approved design (brainstorming complete)

## 1. Goal

A user who installs the signed Orcha DMG can go — in one guided flow, no terminal,
no Homebrew, no `orcha` CLI — from "nothing" to "a running Orcha project with its
portal onboarding open." Plus a **File → New Project** menu to repeat this for an
existing folder, a new blank folder, or to reconnect an already-initialized folder.

Today the desktop app (`desktop/`, Electron + React 19 + TS) is only a *stack
manager*: it discovers `orcha-*` Docker stacks (`discovery.ts`), starts/stops them
(`lifecycle.ts`), opens portals, and shows tray/Notification-Center attention. It has
**no onboarding**, **no app menu**, and `EmptyState` only prints the hint
"run `orcha init`". This feature fills that gap.

## 2. Key decisions (resolved during brainstorming)

- **Init engine: reimplement natively in TypeScript.** The Electron main process
  reimplements only the *orchestration logic* of the CLI's `cmd_init`
  (`orcha-cli/orcha_cli/__main__.py:322`). No dependency on an installed `orcha`
  binary. Everything those steps *lay down* (compose template, 26 migrations, the
  whole `portal/` FastAPI app, 28 skills, prefs) ships **unchanged** as bundled
  assets — we are not reimplementing Orcha, only the thin "render files + run docker
  + call the portal API + start daemons" sequence.
- **Scope: init, then hand off to the portal roster wizard.** The desktop wizard does
  preflight + provision (stack up, container created, first human registered), then
  opens the project's portal `/onboarding` page (the existing web roster wizard) in an
  app window. The roster UI is **not** duplicated in Electron.
- **Drift control: copy templates at build time + parity test.** A build script copies
  `orcha-cli/orcha_cli/templates/` into `desktop/resources/orcha-templates/`; a Vitest
  parity test asserts the bundle is byte-for-byte identical to the CLI's templates.
  Only the orchestration logic is hand-written in TS.
- **Prereqs: detect, guide, AND auto-start Docker.** Preflight detects Docker
  installed / daemon running via the Finder-safe PATH helper (`dockerExec.ts`),
  attempts `open -a Docker` + polls `docker info` ≤60s, surfaces the macOS
  AppTranslocation gotcha, then guides the user if it still can't proceed.
- **First-launch: auto-open the wizard when zero stacks exist.** If discovery finds no
  `orcha-*` stacks, open the wizard on launch; otherwise go to the manager. `EmptyState`
  also gets a real **[Create your first project]** button. No persisted "seen" flag.
- **Folder modes (all three):** initialize in an existing folder; create a new blank
  directory; reconnect to a folder that already has `.orcha/` (never clobber).

## 3. Where the install files come from (no Homebrew, no GitHub at runtime)

The CLI's templates are **local package data** — `PKG_TEMPLATES = files("orcha_cli") /
"templates"`, shipped via hatchling `include = ["orcha_cli/templates/**"]` (~1.5 MB:
`docker-compose.yml.j2`, `migrations/` ×26, `portal/`, `project-preferences.md`,
`skills/` ×28). `orcha init` performs **no network file fetches** — its only `urlopen`
calls are localhost portal API calls and an optional version-check ping. So we copy
the templates into the `.app` bundle at build time; the signed DMG is **fully
self-contained and offline**. The only network the flow ever needs is Docker's own
`compose up --build` (pulling `postgres:16` + building the portal image) — identical to
the CLI today. "Updated install files" arrive via a **new DMG** carrying newer bundled
templates; nothing is pulled from GitHub at provision time.

## 4. Updates, re-init, and reset-data

`cmd_upgrade` (`__main__.py:878`) is the **same orchestration as `cmd_init` with
different toggles** — re-render compose (ports/name preserved from `orcha.json`),
re-copy migrations/portal/skills from templates, re-register hooks,
`compose up -d --build`, **no volume wipe**; pending migrations apply on portal startup.
So one TS `initEngine` covers all three modes by flag:

| Mode | Steps | Data |
|---|---|---|
| **Init** (new) | render → copy-templates → up --build → wait-portal → create-container → register-human → start-daemons | fresh |
| **Upgrade** (existing) | render (preserve ports) → re-copy templates → re-register hooks → up --build → restart daemons; **skips** create-container/human | **preserved** |
| **Reset-data** (re-init) | init sequence **plus** `compose down -v` first (drop `pgdata`) + prune stale tab bindings / stop old daemon | **wiped — explicit only** |

UX: **Upgrade** is a per-stack "Upgrade to latest" action in the manager (the bundle
carries a version, so the app can detect a stack older than what it ships).
**Reset-data** is a deliberately gated, type-to-confirm destructive action that names
exactly what is wiped (agents/tasks/requests + the `pgdata` volume). Because the app
*ships* the templates, "update Orcha" = update the app (new DMG) → the app offers to
upgrade existing stacks. This honors the repo rule: never `down -v` casually; relaunch
with `up`; reset is always explicit.

## 5. Architecture

```
┌─ Renderer (#onboarding wizard) ───────────────────────────┐
│ Preflight → Folder → Details → Provision(stream) → HandOff│
└───────────────┬───────────────────────────────────────────┘
        IPC (asResult request/response + one push event channel)
┌───────────────▼───────────────────────────────────────────┐
│ Main: preflight.ts · initEngine.ts · folderModes.ts ·      │
│       templates.ts · onboardingWindow.ts · appMenu.ts      │
│  reuses dockerExec.ts (Finder-safe PATH)                   │
│  reads bundled resources/orcha-templates/                  │
└────────────────────────────────────────────────────────────┘
```

The renderer keeps the existing single-HTML-bundle / hash-route convention: `main.tsx`
branches `#tray → TrayPanel`, `#onboarding → OnboardingApp`, else `App`. The
onboarding window is modeled on `managerWindow` (secure `webPreferences`,
`sandbox: true`, open-or-focus).

## 6. Components

### Main process (`desktop/src/main/`)
- **`templates.ts`** — resolves the bundled `resources/orcha-templates/` root (dev vs
  packaged) and reads template assets. Pure path logic + fs reads.
- **`initEngine.ts`** — `provision(opts, onProgress)` runs the init/upgrade/reset
  sequence, emitting structured `ProgressEvent`s per stage. Reuses `dockerExec`.
  `exec`/`fetchJson`/`fs` injected for tests (repo DI convention).
- **`preflight.ts`** — Docker installed? daemon running? auto-start (`open -a Docker`,
  poll ≤60s); AppTranslocation detection; port availability (scan/shift like the CLI).
  Returns a `PreflightReport`.
- **`folderModes.ts`** — init-in-existing, create-new-blank, reconnect-existing-`.orcha`;
  validates (`.orcha` present? writable? safe name?).
- **`onboardingWindow.ts`** — `showOnboardingWindow()` (open-or-focus), loads renderer
  with `#onboarding`.
- **`appMenu.ts`** — builds the macOS app menu (none exists today) with **File → New
  Project** (+ standard roles); `Menu.setApplicationMenu` from `index.ts`.

### Renderer (`desktop/src/renderer/src/onboarding/`)
- **`OnboardingApp.tsx`** — wizard state machine:
  `Preflight → Folder → Details → Provision(stream) → HandOff`.
- Step components + `useProvisionStream` hook subscribing to streamed progress.
- **`EmptyState.tsx`** gains a **[Create your first project]** button.

### Build / shared
- **`scripts/copy-orcha-templates.*`** — build-time copy from the CLI into
  `resources/orcha-templates/`; wired into `build` and `dist:mac`.
- **`templates.parity.test.ts`** — asserts bundled templates byte-match the CLI's.
- **`shared/types.ts`** additions: `ProvisionMode`, `ProvisionOptions`, `ProgressEvent`,
  `ProvisionStep`, `PreflightReport`, `FolderChoice`/`FolderState`, new `BridgeError`
  codes.

## 7. IPC contract & progress streaming

Existing bridge: 7 `invoke` channels → one `IpcResult<T>` each, errors as a `BridgeError`
discriminated union re-thrown by the preload (`shared/types.ts`, `preload/index.ts`).
We keep that model and add:

**New request/response channels (all `asResult`-wrapped → `IpcResult<T>`):**

| Channel | Signature | Purpose |
|---|---|---|
| `orcha:preflight` | `() => PreflightReport` | Docker state, auto-start, ports, AppTranslocation |
| `orcha:pickFolder` | `(mode) => FolderChoice \| null` | native dir picker (parent+name for new-blank) |
| `orcha:inspectFolder` | `(path) => FolderState` | already-`.orcha`? writable? → reconnect vs init |
| `orcha:provision` | `(ProvisionOptions) => ProvisionResult` | starts the run; resolves on done/fail |
| `orcha:openOnboardingPortal` | `(project) => void` | open portal `/onboarding` window (hand-off) |
| `orcha:openOnboarding` | `() => void` | open the wizard window (menu / EmptyState) |

**New one-way event channel (main → renderer)** — the only push channel in the app:

```ts
onProvisionProgress(cb: (e: ProgressEvent) => void): () => void  // returns unsubscribe
```

Preload wraps `ipcRenderer.on('orcha:provision:progress', …)` so the renderer receives
only the typed payload (never the raw `IpcRendererEvent`); unsubscribe calls
`removeListener`. Main emits via `webContents.send` to the onboarding window.

```ts
type ProvisionStep =
  | 'preflight' | 'render-compose' | 'copy-templates' | 'compose-up'
  | 'wait-portal' | 'create-container' | 'register-human' | 'start-daemons'

type ProgressEvent =
  | { runId: string; step: ProvisionStep; status: 'start' | 'ok' | 'skip' }
  | { runId: string; step: ProvisionStep; status: 'log'; line: string }
  | { runId: string; step: ProvisionStep; status: 'fail'; code: BridgeError['code']; detail: string }
```

`runId` lets the renderer drop late events from a cancelled/old run.

**New `BridgeError` codes** (added to the existing union):
`DOCKER_NOT_INSTALLED`, `DOCKER_START_TIMEOUT`, `PORT_UNAVAILABLE`, `TEMPLATES_MISSING`,
`ALREADY_INITIALIZED`, `PORTAL_TIMEOUT`, `CONTAINER_EXISTS`, `PROVISION_FAILED`
(carries failing step + stderr tail).

**Security:** `sandbox: true` stays on; all capability flows through typed channels.
The folder picker returns canonical absolute paths; project names are sanitized with
the CLI's rule before touching compose; `dockerExec` uses arg arrays (never shell
strings).

## 8. Error handling & failure modes

Principle: every step is **idempotent / re-runnable**; failures are **typed and
actionable** (never a raw stack trace); a failed run **never leaves a silently-broken
half-state** — the wizard says what failed, what it left, and the one recovery button.

| Stage | Failure | Detection | UX / recovery |
|---|---|---|---|
| Preflight | Docker not installed | `docker version` ENOENT after PATH probe | `DOCKER_NOT_INSTALLED` → "Install Docker Desktop" + Recheck; block Next |
| | Daemon down | server section errors | auto-start `open -a Docker`, poll `docker info` ≤60s; timeout → `DOCKER_START_TIMEOUT` + Recheck |
| | AppTranslocation | docker found but compose can't find credential helper | specific banner → move Docker.app to /Applications |
| | Ports busy | bind probe / scan | auto-shift like CLI; `PORT_UNAVAILABLE` only if 100-wide span exhausted |
| Folder | `.orcha/` exists | `inspectFolder` | route to **Reconnect**, never clobber |
| | not writable / bad name / new-blank collision | fs stat + sanitize | inline validation before provision |
| render/copy | templates missing/corrupt | `templates.ts` existence + parity | `TEMPLATES_MISSING` → reinstall app; fails before any docker side effect |
| compose-up | build/pull fails | non-zero exit | `PROVISION_FAILED{step, stderr-tail}` + streamed log; **Retry** re-runs `up` (reuses partial containers) |
| wait-portal | no 200 in 30s | poll timeout | `PORTAL_TIMEOUT` → [View logs] (`compose logs portal`) + Retry |
| create-container | 409 already has one | POST 409 | `CONTAINER_EXISTS` → data preserved; offer Reconnect or gated Reset; never auto-wipe |
| register-human / daemons | failure | API / spawn error | **non-fatal** (matches CLI): warn in checklist; project usable; "register later" |

Cross-cutting:
- **Cancellation:** Cancel during compose-up sends `SIGINT` to the child, marks the run
  aborted; we do **not** auto-`down` (let the user inspect). Wizard shows "Partially
  provisioned — [Resume] / [Open logs] / [Reset & remove]".
- **Resume / re-entrancy:** every step idempotent → re-running `provision` on the same
  folder safely continues; primary recovery is always "Retry."
- **Stale-run guard:** `runId` on every event → late events from old runs dropped.
- **No silent success:** "done" only after wait-portal 200 **and** (new projects)
  container-create OK; daemon/human warnings shown, not swallowed into a green check.
- **Destructive gating:** reset-data / reconnect-clobber require type-to-confirm naming
  exactly what is wiped.

## 9. Testing strategy

Repo conventions: Vitest, co-located `*.test.ts(x)`, `node` env for main with per-file
`// @vitest-environment jsdom` for renderer, dependency injection (`exec`/`fetchJson`/
`fs` passed in) so no real Docker/network in unit tests.

**Main-process unit tests:**
- `initEngine.test.ts` (most important) — exact step sequence + docker/POST args for
  init; upgrade preserves ports, re-copies, skips container/human, no `down -v`;
  reset-data runs `down -v` first + prunes/stops stale; failure mapping
  (portal-timeout/409/non-zero); idempotent re-run; `runId` stamped on every event.
- `preflight.test.ts` — installed-but-down → auto-start path; timeout →
  `DOCKER_START_TIMEOUT`; ENOENT → `DOCKER_NOT_INSTALLED`; AppTranslocation signature;
  port scan/shift.
- `folderModes.test.ts` — existing-`.orcha` → reconnect; new-blank collision; bad name;
  non-writable.
- `templates.test.ts` — dev vs packaged root resolution.
- `appMenu.test.ts` — File → New Project present and wired.

**Renderer tests** (`// @vitest-environment jsdom`, stub the *whole* `window.orchaDesktop`
in `beforeEach`; every existing bridge stub updated for the larger surface):
- `OnboardingApp.test.tsx` — state-machine progression; streamed events → checklist/log;
  per-`BridgeError` recovery affordance; stale-run (wrong `runId`) events ignored.
- `EmptyState.test.tsx` — [Create your first project] calls `openOnboarding`.
- Hand-off: success → `openOnboardingPortal(project)` called once.

**Parity guard:** `templates.parity.test.ts` walks both template trees and asserts
identical file set + byte-for-byte content (compose, 26 migrations, full `portal/`, 28
skills, prefs). The build-time copy keeps them equal; the test is the backstop. Both run
in `npm test` and before `dist:mac`.

**Out of scope for CI (manual smoke, documented — no silent gap):** the real
`docker compose up` end-to-end and the actual signed-DMG first-launch need real Docker +
a notarized build. Per repo rule "never self-certify; a human verifies."

## 10. Out of scope

- Reimplementing the portal, migration runner, roster wizard, or daemons (all shipped
  unchanged and reused).
- Windows/Linux onboarding (macOS-first, matching the existing app).
- Auto-updating the app binary itself (DMG distribution already exists).
- Installing Docker on the user's behalf (we detect, auto-start, and guide only).
```
