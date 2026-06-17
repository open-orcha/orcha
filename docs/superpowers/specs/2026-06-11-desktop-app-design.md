# Orcha Desktop v1 — design

**Date:** 2026-06-11
**Status:** implemented on `feat/desktop-app` (v1 + v1.1); packaging deferred post-#238
**Tracking:** [Orcha#237 — Desktop app shell for Orcha](https://github.com/open-orcha/orcha/issues/237)
**Branch:** `feat/desktop-app` (cut from `main`; independent of the un-merged
distribution PR #238)

## Goal

A desktop **stack manager** for Orcha: see every `orcha-*` Docker stack on the
machine (running or stopped), start/stop them, and open each stack's existing
web portal in an app window. Built now, tested locally, PR after local
verification.

## Decisions (from discussion)

- **Electron + React + TypeScript**, scaffolded with **electron-vite**
  (react-ts shape): one dev command, renderer HMR, real build output.
- Window app (not a tray utility) — a proper UI with room to grow.
- v1 shells out to `docker`; it does **not** bundle the CLI or a Python
  runtime. Docker Desktop (or OrbStack/Colima) is assumed, exactly as the CLI
  assumes it.
- Lives in this repo under `desktop/`, own `package.json`, app version 0.1.0
  (independent of the CLI's version).

## 1. Architecture

```
desktop/
├── package.json            # electron, electron-vite, react, vitest, ...
├── electron.vite.config.ts
├── tsconfig.json (+ node/web variants per electron-vite convention)
├── src/
│   ├── main/
│   │   ├── index.ts        # app lifecycle, manager window, IPC handlers, portal windows
│   │   ├── discovery.ts    # docker ps -a → Stack[]  (pure parsing core)
│   │   └── lifecycle.ts    # docker compose -p orcha-<name> start|stop
│   ├── preload/
│   │   └── index.ts        # contextBridge: the 4-method OrchaDesktopApi
│   ├── shared/
│   │   └── types.ts        # Stack, DockerUnavailableError shape, OrchaDesktopApi
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx             # poll loop + state
│           └── components/
│               ├── StackList.tsx
│               ├── StackCard.tsx   # status pill, ports, Open portal / Start / Stop
│               ├── DockerDownBanner.tsx
│               └── EmptyState.tsx
└── tests co-located as *.test.ts(x) (vitest)
```

Renderer security: `contextIsolation: true`, `nodeIntegration: false`,
sandboxed; all privileged work happens in the main process behind IPC.

## 2. Data model & discovery

`Stack` (shared type):

```ts
interface Stack {
  project: string;        // docker compose project, e.g. "orcha-todo-app"
  projectShort: string;   // "todo-app"
  apiPort: number | null; // host port of the portal (8000+ range)
  dbPort: number | null;  // host port of postgres
  portalStatus: string;   // raw docker status, e.g. "Up 3 hours" / "Exited (0) ..."
  running: boolean;       // portalStatus starts with "Up"
}
```

`discovery.ts` ports the CLI's `_discover_stacks` logic
(`orcha-cli/orcha_cli/__main__.py:428`) to TypeScript, with one deliberate
difference: it runs `docker ps -a` (not `ps`) so **stopped stacks appear** and
can be started from the app. Parsing core is a pure function
`parseDockerPs(stdout: string): Stack[]` over the same tab-separated
`--format` template the CLI uses (names, status, ports, compose-project
label), filtered to projects starting `orcha-`. Port extraction matches the
CLI's `_parse_host_port` behavior (map container port 8000→apiPort,
5432→dbPort from the `0.0.0.0:PORT->...` published-ports field; stopped
containers publish nothing → `null`).

## 3. IPC surface (the only main↔renderer contract)

`window.orchaDesktop` (typed `OrchaDesktopApi`, exposed by preload):

- `listStacks(): Promise<Stack[]>` — rejects with `{ code: "DOCKER_UNAVAILABLE" }`
  when the docker CLI is missing or the daemon is down.
- `startStack(project: string): Promise<void>` — `docker compose -p <project> start`.
- `stopStack(project: string): Promise<void>` — `docker compose -p <project> stop`.
- `openPortal(project: string): Promise<void>` — main opens/focuses that
  stack's portal `BrowserWindow` at `http://localhost:<apiPort>/`.

Lifecycle rejections carry `{ code: "COMPOSE_FAILED", stderr: string }` (tail
of stderr) for inline display. `project` values are validated in main against
the current discovery snapshot (must be a known `orcha-*` project) before any
shell-out — the renderer never controls argv beyond choosing a known stack.

## 4. Renderer behavior

- `App` polls `listStacks()` every 5 s (and immediately on action completion);
  state: `stacks | dockerDown | loading`.
- `StackCard`: name (`projectShort`), status pill (green "running" / grey
  "stopped"), `API :<port> · DB :<port>` when running, buttons:
  - **Open portal** — disabled when not running or `apiPort` is null.
  - **Start** / **Stop** — whichever applies; button disables with a busy label (Stopping…/Starting…) while the
    compose command runs; on rejection shows the stderr tail inline on the card.
- `DockerDownBanner` replaces the list when `DOCKER_UNAVAILABLE`.
- `EmptyState` when Docker is up but no `orcha-*` stacks exist: "No orcha
  stacks yet — run `orcha init` in a project."

## 5. Portal windows

One `BrowserWindow` per stack (tracked by project name): loads the existing
portal dashboard over localhost HTTP; re-`openPortal` focuses the existing
window. Closed windows are dropped from tracking. Portal windows use the same
hardened webPreferences (no nodeIntegration, no preload — it's plain web
content the stack already serves to browsers).

## 6. Error handling

- docker CLI missing (`ENOENT`) or daemon down (non-zero `docker ps` exit) →
  `DOCKER_UNAVAILABLE` → banner. Poll keeps running, so the app recovers by
  itself when Docker comes up.
- compose start/stop non-zero → `COMPOSE_FAILED` with stderr tail → inline
  card error; next poll refreshes truth.
- Portal window for a stack that died → standard Chromium error page inside
  that window; the manager window's card flips to stopped on next poll.

## 7. Testing

- **Vitest** unit tests (no Electron in the loop):
  - `discovery`: parsing running/stopped/mixed stacks, non-orcha projects
    filtered, garbage lines skipped, port extraction edge cases (no published
    ports, multiple port mappings).
  - `lifecycle`: exact argv construction; rejection shape on failure (with a
    stubbed spawner).
  - `StackCard` (+ App states) via @testing-library/react + jsdom: pill/button
    states for running/stopped, bridge methods called with the right project,
    disabled Open-portal when stopped, error display on rejection.
- **Local manual verification (gate before the PR):** `npm run dev` on this
  machine against the real running Orcha stack — card appears, stop → status
  flips, start → portal reachable, Open portal shows the dashboard.
- CI wiring for `desktop/` tests is a **deferred follow-up** (Node availability
  on the self-hosted pool unverified); noted for the post-v1 backlog.

## 8. Out of scope for v1 (recorded)

- Packaging/signing/notarization/DMG/auto-update — gated on the #238 release
  pipeline; the app is dev-run only (`npm run dev`) until then.
- `orcha init` from the app (folder picker), log viewer,
  Windows/Linux, bundling the CLI/Python runtime, portal write-actions beyond
  what the portal itself offers.
- No HTTP routes or DB shapes change ⇒ `docs/orcha.postman_collection.json`
  untouched (FT-DEPLOY-4 unaffected).

## 9. v1.1 addendum — tray, attention & notifications (approved 2026-06-11)

Approved mid-build after the v1 core passed review. All of it is **API-consuming
only** — no HTTP routes or DB shapes change, so the Postman collection stays
untouched.

### 9.1 Attention model

A main-process poller (every 15 s, per **running** stack) calls the stack's
existing portal API:
- container snapshot → which agents are `kind='human'`;
- `/api/containers/{cid}/requests` → open requests whose pending action sits
  with a human (open + human/escalated target → **answer needed**; answered +
  human requester → **close needed**);
- `/api/containers/{cid}/tasks` → `needs_verification` → **verify needed**;
- discovery diffs → **health** items (running stack went down / came back).

`AttentionItem { project, projectShort, kind: 'request_answer' | 'request_close'
| 'task_verify' | 'health', id, title }` — computation is a pure function over
fetched JSON (fixture-tested with real captures from the live stack).

### 9.2 Tray + popover ("stacks snapshot")

- Tray presence as a text glyph (⬡ / ⬢ N — empty image + title; a proper template icon lands with packaging), total count in the title.
- **Left-click toggles a frameless, always-on-top popover** anchored under the
  icon (hides on blur / ✕), styled as a dark card: header ("Orcha" +
  running/total chip), a focal ring with the big attention count (green "ALL
  CLEAR" when zero), a stack list (status icon, name, right-aligned attention
  count; attention rows highlighted; click → that stack's portal window),
  footer (gear → manager window · primary "Open portal" for the most-urgent
  stack · ✕).
- Right-click: minimal native menu (Open Orcha / Send test notification / Quit) — the test item verifies Notification Center delivery on demand while the app is dev-run.
- The popover is the same renderer build on a `#tray` hash route.
- **Close-to-tray:** closing the manager window no longer quits; the app lives
  in the tray. Quit via tray menu or ⌘Q.

### 9.3 System + in-app notifications

- Native macOS Notification Center (Electron `Notification`). The first poll
  after launch is a silent baseline; only items appearing after it notify.
  Clicking a notification opens that stack's portal.
- StackCard gains an amber "needs attention · N" badge fed by a new
  `listAttention()` bridge method returning the poller's cached items.

### 9.4 New IPC surface

`listAttention(): Promise<AttentionItem[]>` (cached, no renderer-driven API
traffic), `openManager(): Promise<void>`, `quitApp(): Promise<void>` — same
IpcResult/preload-rejection pattern as the existing four.

### 9.5 Testing

Pure attention computation, notification diffing (baseline + dedup), health
transitions, and the popover panel components are unit/component tested; tray
positioning, real Notification Center delivery, and popover blur behavior are
manual-gate items.

### 9.6 v1.1 out of scope

Deep-linking to a specific request in the portal (popover/notification clicks
open the portal home), notification preferences/quiet hours, Windows/Linux
tray semantics.


## 10. v1.2 addendum — macOS widgets, deep links, branding (approved 2026-06-11/12)

Built under the user's standing direct-implement authorization; verified live
on the dev machine. All API-consuming; Postman untouched.

### 10.1 Widget data bridge

The attention poller writes an atomic, best-effort
`~/Library/Group Containers/<TEAM_ID>.orcha/status.json` every tick
(`src/main/statusFile.ts`). Schema **v3**: per-stack
`{projectShort, running, attention, working, agents:[{alias, kind, status,
model, task}], tasks:{ready, inProgress, needsVerification}}` plus a capped
top-level attention list. The app group MUST be prefixed with the signing
cert's real TeamIdentifier (the cert's OU — which can differ from the team id
in its display name; containermanagerd rejects mismatches).

### 10.2 Native WidgetKit bundle (`desktop/widget/`, XcodeGen)

A dev-signed SwiftUI host app (`OrchaWidgets.app`, installed to
`~/Applications`) embeds one appex exposing four widget kinds:
**Orcha** (status ring + stacks; small/medium), **Orcha Agents** (roster with
working/idle dots, model chips, current-task lines; medium/large),
**Orcha Pipeline** (ready→working→verify flow bars; medium), **Orcha
Attention** (pending-item list with kind chips; large). Gallery previews
render sample data; stale data (>2 min) renders an OFFLINE state. Provider
logs diagnostics under subsystem `ai.quantal.orcha.widget` (query with
`/usr/bin/log` — zsh shadows `log`).

**Operational rules learned:** chronod caches widget descriptors per appex
version — bump `CFBundleVersion` whenever widget kinds change; deregister the
Xcode build-products copy after installing (xcodebuild re-registers it on
every build).

### 10.3 Deep links

The Electron app registers the `orcha://` scheme;
`orcha://open?project=<compose-project>&path=<portal-path>` opens the stack's
portal at that page (parser in `src/main/deepLink.ts`: project regex + path
sanitizer + live-discovery re-validation). Widgets tap through: status/pipeline
→ portal home, agents → `/agents`, attention → `/requests`.

### 10.4 Dev branding

`scripts/sign-dev-electron.sh` swaps the dev Electron bundle's icns for the
Orcha mark (rendered from the portal's own logo SVG, committed at
`resources/icon.{svg,png}`), patches CFBundleName→Orcha, and re-signs —
required on macOS 26 for Notification Center delivery (ad-hoc binaries are
refused) and gives Dock/banner/app-menu the right identity in dev. The widget
host app carries the same icon (`HostApp/AppIcon.icns`).

### 10.5 v1.2 out of scope

Interactive widget buttons (AppIntents), event/run feeds in widgets,
configurable widget intents (per-stack selection), packaging the host app —
all post-v1.
