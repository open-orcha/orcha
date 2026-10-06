# Orcha V2 — architecture and shared contracts

Owner: **Agent A** (coordinator). Status: **v1 contract, 2026-09-28**. Spec:
`docs/orcha-linear-redesign-implementation-prompt.md` (the brief). Parity rows referenced as
`R-xx`, `S-xx`, … live in `docs/orcha-v2-feature-parity.md`. Tokens:
`docs/orcha-v2-design-system.md`.

Changes to this document go through A. If you need a contract change, write it to
`docs/orcha-v2-requests/<your-letter>.md` (section "To A") and keep working against the current
contract until A answers there.

Paths: `F/` = `orcha-cli/orcha_cli/templates/portal/frontend/src/`, `P/` =
`orcha-cli/orcha_cli/templates/portal/`, `BE/` = `P/portal_backend/`, `DT/` = `desktop/src/`.

---

## 1. Ground truth that constrains everything

- Portal: React 18 + TS + Vite + **`BrowserRouter`** (not hash routing — comments saying so are
  stale, GAP-08). Every page URL is served by an explicit FastAPI page route returning
  `static/dist/index.html` (`BE/dashboard_routes.py`, `P/main.py /onboarding`,
  `BE/device_token_routes.py /auth/device`). A new direct-entry route **needs a new backend
  page route**, or a hard reload 404s.
- Build output `P/static/dist/` is **tracked** and is what ships (also copied into the desktop
  bundle by `desktop/scripts/copy-orcha-templates.mjs`). Only the integration step (A, at the
  end) runs `npm run build`. Nobody else rebuilds dist.
- Global CSS is `P/static/styles.css` → `@import`s of `P/static/styles/*.css`, served at
  `/assets/styles.css` and injected as a blocking `<link>` by `vite.config.ts sharedCssPlugin`.
- Live state: one `SnapshotProvider` — `GET /api/containers/{cid}` (3 s poll) + SSE
  `/api/containers/{cid}/events?since_ts=` (150 ms coalesced refresh, 3 s reconnect). Snapshot is
  capped at 1000 tasks / 1000 requests server-side.
- Project scope is `?cid=` (`F/lib/scope.ts`). Single-container stacks never show `cid`.
  Multi-container stacks pin it in the URL and upgrade every same-origin anchor click.
  **Project switch today is a full navigation to `/?cid=<id>`** — this guarantees no state from
  project A survives into project B. V2 keeps that as the switching mechanism (§4).
- Python "source-contract" tests in `tests/` grep frontend source files for strings (list in
  `docs/orcha-v2-validation.md` §3). If you restructure a file they pin, run them and either keep
  the pinned behavior string or update the test **with the same guarantee** (never delete the
  guarantee). Tests you touch are yours.

## 2. Route map (V2)

All old URLs, query params and hash links keep working (parity R-01…R-18). New ones are additive.

### 2.1 Page routes

| URL | Renders (V2) | Params (old → kept; **new** in bold) | Owner (page) | Backend page route |
|---|---|---|---|---|
| `/` | Project **Overview** (bare `/` on a multi-project stack with no resolved cid still bounces to `/projects` via `CloudHome`) | `cid` | G | exists |
| `/projects` | All projects (inside V2 shell chrome, no project selected) | — | G | exists |
| `/needs` | **Needs you** queue (new) | `cid`, **`item=<kind>:<id>` (kinds incl. `followup:<requestId>` for answered-to-you rows)**, **`scope=project|all`**, **`view=open|history`** | D | added (B) |
| `/tasks` | Tasks list/detail | `task`, `cid`, **`q`, `status` (csv), `assignee`, `sort=time-desc|time-asc|priority-asc|priority-desc`, `group`, `view=list|board`, `tab=overview|activity|runs`, `full=1` (selected task as a full view; pushed), `new=1` (opens the New task composer; removed on close)** | D | exists |
| `/requests` | Requests list/detail | `req`, `cid`, **`filter=all|open|answered|escalated|task`, `q`** (selection below 900 px pushes) | D | exists |
| `/agents` | Roster + agent workspace | `agent` (alias), `cid`, **`tab=conversation|runs|tasks|requests|memory|config`** | E | exists |
| `/activity` | **Activity** — runs/events (new; replaces the "Run feed → /agents" link) | `cid`, **`agent`, `task`, `run`, `state=running|finished|failed|all`, `view=runs|events`** | E | added (B) |
| `/code` | Code Space | `ref`, `path`, `line`, `thread`, `cid` | F | exists |
| `/github` | GitHub hub | `tab`, `pr`, `issue`, `browse`, `ref`, `path`, `cid` | F | exists |
| `/metrics` | Metrics | `agent`, `cid` (**`days`, `window`** optional) | G | exists |
| `/settings` | Settings | `#tab=<key>` (see 2.3), `cid` | G | exists |
| `/members` | Members (also Settings › Members & access) | `cid` | G | exists |
| `/onboarding` | Portal onboarding | `new`, `step`, `demo`, `cid` | G | exists |
| `/auth/device` | Device token (standalone, no shell) | — | G | exists |
| `*` | fallback → Overview (never blank) | — | B | n/a (SPA only) |

Rules:
- New query params are **optional**; absent = today's behavior. Unknown values are ignored,
  never thrown.
- Selection changes use `replace` (as today); filter changes use `replace` too, so Back returns
  to the previous *page*, not every keystroke. Opening a detail as a *full view* (narrow widths)
  pushes, so Back returns to the list with filters and scroll (store list scroll in
  `history.state`).
- B adds page routes `/needs` and `/activity` to `BE/dashboard_routes.py` (additive, same
  `serve_page("dist/index.html")` pattern) **plus a pytest** asserting both return 200 HTML, and
  adds them to `vite.config.ts PAGE_ROUTES` (fix GAP-09 at the same time).
- Routes are registered in `F/main.tsx` (B). Domain agents export a page component from their
  own directory; B imports it. D exports `F/pages/needs/NeedsPage.tsx`; E exports
  `F/pages/activity/ActivityPage.tsx`.

### 2.2 Deep-link producers that must keep producing the same URLs
`/tasks?task=`, `/requests?req=`, `/agents?agent=` (alias, not id), `/github?pr=`, `/metrics?agent=`
(id), `/code?path=&line=&thread=`, `/onboarding?new=1`, `/?cid=`, notification deeplinks
(`ncDeeplinkHref`), desktop attention/tray paths, desktop `orcha://open?project=&path=`.

### 2.3 Settings hash keys
Old keys **must** keep selecting the right content: `general`, `provider-keys`, `github-access`,
`members`, `pairing`, `appearance`. G may introduce V2 sections; the mapping is:

| V2 section | key | Also accepts (alias) | Content |
|---|---|---|---|
| General | `general` | — | project name/description display, default-project pref |
| Execution | `execution` | — | worktree routing (P-05); links to header Execution controls |
| Models & providers | `provider-keys` | `models` | Anthropic key, provider keys, universal model selection |
| Integrations | `github-access` | `integrations` | GitHub PAT/App access, repo connection link |
| Members & access | `members` | — | Members section |
| Devices & pairing | `pairing` | `devices` | phone pairing (+ link to `/auth/device` docs) |
| Interface | `interface` | `appearance` | dark-only note; sidebar prefs; (no theme/skin pickers) |

`#tab=general` is used by desktop "Pair phone" (GAP-06): C changes that link to `#tab=pairing`;
G keeps `general` valid regardless.

## 3. Attention ("Needs you") — canonical definition and shared selector

### 3.1 Definition (per project, for the acting viewer)

An **attention item** is one *entity* awaiting a human decision the backend allows a human to
make. One entity counts once, even if it is also in notifications.

| kind | Entity | Condition (from snapshot) | Primary action (existing API) |
|---|---|---|---|
| `plan` | task | `status==="in_progress" && !plan_decision && planMessageOf(t)` **and** container `autonomy_level==="plan"` | `POST /api/decisions` plan_approval |
| `verify` | task | `status==="needs_verification"` and `autonomy_level!=="full"` | `POST /api/tasks/{tid}/verify` |
| `request` | request | (`status==="open"` and target is a human or null) **or** `status==="escalated"` | respond / convert / escalate / close (Requests actions) |

Sub-classification (not separate counts): a `verify`/`plan` task whose `reviewer_agent_id` is set
and is **not** the acting human is flagged `assignedToOther: true` (rendered de-emphasized, as
`lib/reviewer.ts` does today). A `request` whose target is a *different* human is
`assignedToOther: true`.

**Follow-ups** (informational, NOT in the badge): answered requests where the acting human is the
requester (desktop "request_close"). Exposed separately as `followUps`.

**Not attention**: notifications (read/unread), run failures, blocked tasks. These appear in
Activity / notifications. Marking read never resolves an item.

Rationale for the one change vs today: the portal currently omits `status==="escalated"`
requests while the backend `needs_you` includes them (GAP-04). Escalated requests are explicitly
routed to a human, so they are included.

### 3.2 Counts

- **Badge number = unique entities** `plan + verify + request` where `assignedToOther === false`.
  Items assigned to someone else are listed but not counted in *your* badge. The label everywhere
  is "Needs you" and tooltips say "N decisions waiting on you in <project>".
- Computed **from snapshot lists only**. Do **not** use `task_open_total` / `request_open_total`
  as attention counts (GAP-01 — they count all open work). Those totals remain the **Tasks /
  Requests nav counts** ("open tasks", "open requests"), labeled as such.
- Truncation: if `task_total > tasks.length` or `request_total > requests.length`
  (B stops dropping these fields in `mapSnapshot`, GAP-05), the selector returns
  `partial: true` and UI renders `N+` with a tooltip "counted from the first 1000 …".
- Unknown vs zero: before the first snapshot, count is `null` → render nothing/skeleton, never 0.

### 3.3 Scope

- Web portal default scope = **current project** (label "in <project name>").
- All-projects scope (`/needs?scope=all`, sidebar project rows): only from `GET /api/containers`
  `needs_you` (membership-filtered server-side). That number is a **different measure**
  (verifications + open-to-human + escalated requests; **no plan approvals**, no
  reviewer filtering). UI must label it "pending decisions (excl. plan approvals)" or show it as a
  dot + count with that tooltip. Projects for which the field is missing → "unavailable", not 0.
  No new aggregate endpoint in v1; if D wants plan approvals across projects, request an additive
  backend field via `docs/orcha-v2-requests/D.md`.
- Desktop: the host aggregates per stack via its existing `attentionPoller` (`DT/main/attention.ts`).
  C aligns `computeAttention` to §3.1 kinds (add `plan`, add `escalated`, keep answered-requester
  as `followUp` for the tray list but exclude it from the numeric badge **or** keep it and label the
  tray "N items (incl. follow-ups)" — C decides and records it; either way the label must say what
  is counted).

### 3.4 Shared selector (B owns; everyone consumes)

File: `F/state/attention.ts` (B). Signature:

```ts
export type AttentionKind = "plan" | "verify" | "request";
export interface AttentionItem {
  kind: AttentionKind;
  key: string;              // `${kind}:${id}` — stable React key and `/needs?item=` value
  id: string;               // task id or request id
  title: string;
  projectCid: string | null;
  agentAlias: string | null;   // plan author / assignee / requester
  since: string | null;        // ISO; plan message time, started_at, created_at
  href: string;                // /tasks?task=… or /requests?req=…
  assignedToOther: boolean;
  task?: Task; request?: OrchaRequest;
}
export interface Attention {
  items: AttentionItem[];      // sorted: plan, verify, request; then oldest first
  count: number | null;        // unique, assignedToOther excluded; null = unknown (no snapshot)
  partial: boolean;
  followUps: OrchaRequest[];
}
export function selectAttention(snap: Snapshot | null, actingHumanId: string | null): Attention;
export function useAttention(): Attention;  // memoized on snapshot bump + acting human
```

`attnItems`, `attnCardCounts`, `navCounts` stay exported for back-compat until every consumer
migrates; `attnCardCounts` is re-implemented on top of `selectAttention` (fixes GAP-01). Tests:
`F/state/attention.test.ts` (B) covering each kind, autonomy gating, escalated, reviewer
exclusion, partial, null-before-snapshot.

## 4. Project scope, switching and caching

- **Switching projects = full navigation** to the target URL with `?cid=<target>` (use
  `navigateScoped`-style helper `switchProject(cid, path?)` in `F/lib/scope.ts`, B). Default
  landing path on switch: same section if it is project-scoped (e.g. `/tasks`), dropping entity
  params (`task`, `req`, `agent`, `pr`, `issue`, `path`, `line`, `thread`, `run`, `item`).
  This keeps the existing guarantee that no in-memory state crosses projects.
- Anything cached **in memory** across renders must be keyed by `cid` (and by origin implicitly —
  separate local stacks are separate origins, so localStorage is already per-origin).
- **localStorage keys** that carry project data must include cid: pattern
  `orcha:v2:<area>:<cid>:<name>`. Existing keys keep their names (`orcha:actingHuman:<cid>`,
  `orcha:sort:*`, `orcha:sidebar`, `orcha:defaultCid`, Code Space draft store keys). New
  non-project UI prefs: `orcha:v2:<name>` (e.g. `orcha:v2:sidebarWidth`,
  `orcha:v2:pinnedProjects`, `orcha:v2:projectOrder`).
- Every async fetch in a page must discard responses whose `cid` (or selected entity) no longer
  matches (request-id ref pattern, as `SnapshotProvider` identity fetch already does).
- Sidebar project list: fetched from `GET /api/containers` **once on shell mount + on explicit
  open/refresh + every 60 s** (not every 3 s, not per row). Only the *selected* project has live
  snapshot data; other rows show `status` and `needs_you` from the list response with its fetch
  time.
- Identity (`/api/me?cid=`) is single-flighted per cid (`F/cloud/identity.ts`) — unchanged.

## 5. Live-state ownership

| State | Owner (module) | Consumers | Rules |
|---|---|---|---|
| Snapshot, cid, multi, identity, error, refresh, bump | B `F/state/SnapshotProvider.tsx` | all | Unchanged pipeline. B adds `lastOkAt: number \| null`, `connection: "live" \| "polling" \| "reconnecting" \| "offline"`, `stale: boolean` (no successful refresh for > 10 s). Pages must not start their own snapshot poll. |
| Attention | B `F/state/attention.ts` | shell, D, G, E | §3 |
| Acting human | B (`actingHuman`, `actingIdentityHuman`) | all | never impersonate; `null` ⇒ actions disabled with reason |
| Container list (projects) | B `F/state/projects.ts` (new) | sidebar, palette, G `/projects` may reuse | §4 cadence |
| Per-page heavy data (runs, threads, github lists, metrics, code) | owning domain agent | own pages | fetch on demand; key by cid + entity; cancel/ignore stale |
| Run SSE streams | E `F/hooks/useRunStream.ts` | D (task Runs tab), F (LivePanel) | one EventSource per visible run; close on unmount |
| Notifications feed | B (header popover) | D (history section may call same endpoint) | never marks read on open |

Stream/scroll rules (all agents): updates must not steal focus, reset selection, collapse
expanded sections or clear input. Logs auto-follow only when at bottom (`F/lib/logScroll.ts`),
with "Jump to latest" otherwise.

## 6. Search (Cmd/Ctrl+K)

B owns the palette UI and provider registry: `F/shell/search/` (B).

- Open: `Cmd+K` (mac) / `Ctrl+K`; `/` still focuses search **only** when focus is not in
  input/textarea/select/contenteditable/CodeMirror (`.cm-editor`)/xterm (`.xterm`). `Cmd/Ctrl+K`
  is also ignored inside `.cm-editor` and `.xterm` (they may bind it). Escape closes and
  restores focus to the previously focused element.
- Scope chip visible at all times: "in <project>" (default) — results are current-project only
  except the "Projects" group.
- Providers (all read-only, real data):

| Group | Source | Match | Destination |
|---|---|---|---|
| Actions | static list filtered by permission (acting human present) | label | New task (`/tasks` + open composer via `?new=1` — D implements), Go to Needs you, Execution controls, Settings sections |
| Navigate | route map §2 | label | section URL |
| Projects | `F/state/projects.ts` list | name | `switchProject(cid)` |
| Tasks | snapshot `tasks` | title, id prefix, `#<shortId>` | `/tasks?task=` |
| Requests | snapshot `requests` | payload text, type, from/to | `/requests?req=` |
| Agents | snapshot `agents` | alias, role, model | `/agents?agent=` |
| Files (optional, F supplies) | `GET …/github/browse/search?mode=names` (debounced 250 ms, min 2 chars, only when repo bound) | path | `/code?path=` |

- States: empty query shows recent + actions; no results → "No matches in <project>"; provider
  error → inline row "Files search unavailable: <reason>" (others still render). Keyboard:
  ↑/↓, Enter, Cmd+Enter opens in new tab where the destination is a URL.
- Provider interface: `registerSearchProvider({ id, group, search(q, ctx): Promise<Result[]> | Result[] })`
  in `F/shell/search/providers.ts`; F registers the Files provider from its own module via an
  import in `F/extensions.ts` requested through B.

## 7. Desktop embedded-mode contract (B + C)

### 7.1 Who owns navigation

- **Standalone web**: portal renders the full V2 shell (sidebar + header + content).
- **Desktop**: the **host** (Electron renderer, C) renders the persistent left sidebar
  (projects across all local stacks, per-stack attention, start/stop, selected project's section
  links, live agents of the selected project, account/help, All projects/manager). The portal,
  when embedded, renders **header + content only** (no sidebar, no project switcher, no theme,
  no maker footer). Exactly one visible navigation hierarchy.
- Host manager screens (ProjectsHome, onboarding wizard) replace the embedded view area when no
  project is open; the host sidebar stays visible except during first-run onboarding.

### 7.2 Capability detection

- C adds a **dedicated, minimal portal preload** (`DT/preload/portal.ts`) attached only to
  portal `WebContentsView`s. It exposes `window.orchaHost` via `contextBridge` **only** when
  `location.origin === "http://localhost:<apiPort of that view's stack>"` (C passes the expected
  origin via `additionalArguments`). No Node, no generic invoke.
- Portal detection (B, `F/state/host.ts`): `const host = window.orchaHost?.version === 1 ? window.orchaHost : null`.
  Embedded mode ⇔ `host !== null && host.capabilities.includes("sidebar")`. Additionally the
  host appends `?embed=desktop` **only** on the first load URL as a pre-paint hint (B's inline
  boot script sets `data-embed="desktop"` on `<html>` so the sidebar never flashes); the
  capability object is authoritative afterward. Plain browsers never see either.

### 7.3 Typed messages (single source: `DT/shared/embed.ts`, C; mirrored by B in `F/state/host.ts`)

```ts
// host -> portal (preload delivers via callbacks registered by the portal)
type HostToPortal =
  | { type: "navigate"; path: string }            // SPA navigate (same origin, safe path /^\/(?![/\\])/)
  | { type: "openSearch" }                         // host Cmd/Ctrl+K when host chrome focused
  | { type: "hostModal"; open: boolean };          // host dialog open: portal must not trap focus

// portal -> host
type PortalToHost =
  | { type: "ready"; version: 1 }
  | { type: "route"; path: string; search: string; title: string }  // on every location change
  | { type: "attention"; cid: string | null; count: number | null; partial: boolean }
  | { type: "liveAgents"; cid: string | null; agents: { alias: string; status: string; task: string | null; updatedAt: string | null }[] } // capped 5
  | { type: "requestHostAction"; action: "startStack" | "stopStack" | "openManager" | "addProject" };

interface OrchaHostApi {
  version: 1;
  capabilities: ("sidebar" | "notifications" | "stackControl")[];
  project: string;                 // compose project, e.g. "orcha-foo"
  send(msg: PortalToHost): void;   // preload validates shape + origin, then ipcRenderer.send on a fixed channel
  on(cb: (msg: HostToPortal) => void): () => void;
}
```

- Main (C) validates every `PortalToHost` message: sender webContents must be a known portal
  view; `path` must pass the deep-link safe-path regex; unknown `type` is dropped. No message can
  run shell commands or reach arbitrary `orcha:*` channels. `requestHostAction` maps only to the
  existing stack operations and still goes through host confirm UI where one exists today.
- Host `navigate` uses the SPA router (no reload) for same-project paths; project switches use
  `portalShow(project, path)` (existing).

### 7.4 WebContentsView bounds, overlays, focus

- Bounds: `x = sidebarWidth` (host-owned, persisted in host localStorage), `y = 0` (the slim
  TopBar is removed in embedded V2; its "← Projects"/name/status move into the host sidebar),
  `width = contentWidth - sidebarWidth`, `height = contentHeight`. C extends
  `computeViewBounds(windowSize, { left: sidebarWidth, top: 0 })` (pure, unit-tested; clamp ≥ 0).
  macOS traffic lights live over the host sidebar (`titleBarStyle: "hiddenInset"` optional, C's
  call) — the view never covers them.
- Sidebar collapse/resize → host recomputes bounds immediately (during drag, throttle to rAF).
- **Portal DOM modals** stay inside the view (they only need to cover content). **Host dialogs**
  (reset confirm, add project, etc.) cannot overlay the native view: host hides the active view
  (`setVisible(false)`) while the dialog is open and sends `hostModal`; restores on close. The
  portal never renders dialogs meant to cover the host sidebar.
- Keyboard: Cmd/Ctrl+K inside the view is handled by the portal; when host chrome has focus, host
  forwards `openSearch` and focuses the view. Window-level accelerators in the app menu must not
  steal keys the portal/editors use.
- Notifications/tray/deep links: unchanged entry (`portalShow(project, path)`), paths gain `cid`
  (GAP-07). After navigation the portal emits `route` so the host highlights the right item.
- Appearance: V2 is dark-only. C stops pushing skins (retire `appearanceScripts` apply of
  `data-skin`; keep the store file readable for rollback). Portal boot ignores `data-skin`.

### 7.5 Fallback
If the preload/capability is absent (older desktop or plain browser at a localhost port), the
portal renders its own sidebar (web mode). A newer desktop with an older portal (no `ready`
within 3 s) → host keeps the old slim TopBar layout (`y = TOPBAR_HEIGHT`, `x = 0`) so the old
portal's own sidebar is not doubled.

## 8. Sidebar contract (web; desktop host mirrors the same information)

Top → bottom:
1. Brand/account row: Orcha mark, acting identity (avatar + alias or "no human registered"),
   account menu (`extensions.accountMenu`), collapse button.
2. Search trigger ("Search  ⌘K").
3. **Needs you** — count from `useAttention()` (§3), `N+` when partial, links `/needs`.
4. **Projects** header with `+` (New project modal, P-02) and list:
   - Row: status dot (container `status`), name, attention count (`needs_you` from list, labeled per
     §3.3; selected project uses the live selector), expand chevron, `⋯` menu (Open, Pin/Unpin,
     Move up/down, Pair phone, Project settings). Pinned first, then local order
     (`orcha:v2:projectOrder`), then server order.
   - Selected project expanded with children: Overview `/`, Tasks (count = open tasks, labeled
     "open"), Agents (count = agents), Requests (count = open requests), Code, GitHub, Activity,
     Metrics. Counts are distinct from attention.
   - **Live agents** (selected project only): up to 5 AI agents sorted by activity
     (working/in-progress first, then most recent `last_active`), row = avatar, alias, real status
     label, current task title or "idle"; "updated 5m ago" only when stale (> 2 min, derived from
     `last_active`). Link → `/agents?agent=<alias>&tab=conversation`. "View all agents" → `/agents`.
     Model in tooltip only. No branch/worktree unless a real binding field exists.
5. Bottom: All projects (`/projects`), Settings (`/settings`), Help (docs link), discreet
   attribution.
- Width default 248 px, resizable 200–360 px, collapsible to a 56 px rail (keep `orcha:sidebar`
  + `data-sidebar` for back-compat). Below 900 px: sidebar becomes a drawer (hamburger in header).
- Keyboard: all rows focusable, arrow keys move within the list, Enter activates, menus are
  `role="menu"` with Escape + focus return.

## 9. Header contract

Breadcrumb (Project › Section › Object) · page's one primary action slot · compact secondary
slot · connection indicator (live / reconnecting / offline + last update) · **Execution controls**
button showing notifier state (Running/Paused) and autonomy level, opening a popover with the two
independent controls and their existing confirm copy (S-12/S-13) · notifications bell (S-10/S-11).
Pages provide `title`, `crumbs`, `primaryAction`, `secondaryActions` via the Shell props
(B defines the prop shape; old `page/title/ctx` props keep working during migration).

## 10. FILE OWNERSHIP (disjoint)

Everything under `F/` unless noted. "Owns" = only this agent edits it. Tests colocated with a file
belong to the file's owner. New files go in the owner's directories.

| Agent | Owns |
|---|---|
| **A** | `docs/orcha-v2-feature-parity.md`, `docs/orcha-v2-architecture.md`, `docs/orcha-v2-design-system.md` (initial token table; B extends everything after §1), `docs/orcha-v2-validation.md` (skeleton + baseline §1–3; H owns evidence sections §4+), `docs/orcha-v2-requests/README.md`. Final integration build (`npm run build` → `P/static/dist/`). |
| **B** | `F/main.tsx`, `F/extensions.ts`, `F/types.ts`, `F/api/**`, `F/state/**` (incl. new `attention.ts`, `projects.ts`, `host.ts`), `F/shell/**` (incl. `search/**`), `F/components/ui.tsx`, new `F/components/primitives/**`, `F/lib/scope.ts`, `F/lib/status.ts`, `F/lib/format.ts`, `F/lib/sort.tsx`, `F/cloud/identity.ts`, `F/cloud/shared/plan.ts`, `F/cloud/shared/PremiumGate.tsx`, `F/cloud/projects/ProjectSwitcher.tsx`, `F/cloud/projects/switcher.css`, `F/cloud/projects/prefs.ts`, `F/test-setup.ts`, `frontend/index.html`, `frontend/vite.config.ts`, `frontend/package.json` (+lock), `frontend/tsconfig.json`, `P/static/styles.css`, `P/static/styles/**`, `P/static/fonts/**`, `P/static/favicon.svg`, `BE/dashboard_routes.py` (new page routes only) + its new pytest, `docs/orcha-v2-design-system.md` (after the initial table). |
| **C** | `desktop/**` (everything: `src/main`, `src/preload`, `src/shared`, `src/renderer`, `scripts`, `widget`, configs, `package*.json`). |
| **D** | `F/pages/tasks/**`, `F/pages/requests/**`, new `F/pages/needs/**`, `F/lib/reviewer.ts`, `F/lib/resultText.ts`, `F/components/MessageComposer.tsx`, `F/components/messageComposer.css`. |
| **E** | `F/pages/agents/**`, new `F/pages/activity/**`, `F/components/terminal/**`, `F/hooks/**`, `F/lib/classify.ts`, `F/lib/logScroll.ts`. |
| **F** | `F/cloud/codespace/**`, `F/cloud/github/**`, `F/cloud/shared/browseTree.tsx`, `F/cloud/shared/useBrowseTree.ts`, `F/components/FilesChanged.tsx`. |
| **G** | `F/pages/home/**`, `F/pages/settings/**`, `F/pages/onboarding/**`, `F/cloud/projects/**` **except** `ProjectSwitcher.tsx`, `switcher.css`, `prefs.ts`; `F/cloud/settings/**`, `F/cloud/metrics/**`, `F/cloud/members/**`, `F/cloud/device/**`. |
| **H** | new `F/test/v2/**` (fixtures, cross-page integration tests), new `tests/v2/**` (Python), `docs/orcha-v2-validation.md` §4+ (evidence), screenshots under `docs/orcha-v2-evidence/**`. |

Shared-module consumption rules:
- `F/pages/tasks/pageCss.ts` (D) is imported by G's onboarding — G must not depend on changes
  there; if G needs styles, G copies into its own module.
- `MessageComposer` (D) is used by E's Conversation; `FilesChanged` (F) by D/E; `useRunStream`
  (E) by D/F; `runlog.tsx` (E) by D via import only. Change requests go to the owner's file in
  `docs/orcha-v2-requests/`.
- Backend (`BE/**`, `P/main.py`, `tests/*.py` existing): **no one edits by default**. An additive
  endpoint needs a named owner: write the request to `docs/orcha-v2-requests/<letter>.md` → A
  assigns (default: the requesting domain agent, one file per new route module, plus permission
  tests). Existing Python source-contract tests are owned by the owner of the source file they
  pin.
- `docs/orcha-v2-requests/<letter>.md`: each agent owns its own file; others append only under a
  heading `## From <letter>` in the *target* owner's file.

## 11. Integration plan (A)

1. Wave 1 (parallel): B tokens/primitives/shell/state/search/routes; C desktop embed + host
   sidebar against §7; H fixtures (20 projects / 100 agents / 1000 tasks / long run log).
2. Wave 2 (after B publishes primitives + `useAttention` + Shell props): D, E, F, G migrate pages.
   Vertical slice first: sidebar → Tasks list → Task detail → Verify/Approve.
3. Wave 3: H parity/a11y/responsive/leakage checks; A resolves conflicts, runs full
   test/typecheck/pytest, then the single `npm run build`, desktop template-copy parity test, and
   fills `docs/orcha-v2-validation.md`.
4. No feature flag remains at the end; V2 is the only UI. Legacy prefs (`orcha:theme`,
   `orcha:skin`, `/api/prefs` bag, desktop `appearance.json`) are read-tolerant and never deleted.


## 12. Migration and rollback (A, integration, 2026-09-28)

**No database migration.** V2 adds no tables, columns or SQL migrations. Backend changes are
additive and shape-compatible with pre-V2 clients (verify against `/openapi.json`):

| Change | File | Compatibility |
|---|---|---|
| `GET /needs`, `GET /activity` page routes (serve the SPA shell) | `P/portal_backend/dashboard_routes.py` | new paths only; old routes unchanged |
| `runs_with_cost` per task and in totals on the agent-spend response (QA 19) | `P/portal_backend/agent_spend_routes.py` | additive field; old clients ignore it |
| `require_member_read` on `GET /api/agents/{aid}/runs`, `GET /api/tasks/{tid}/runs`, `…/runs/{rid}/stream` | `P/portal_backend/worker_run_read_routes.py` | trusted-proxy (cloud) non-members now get 403; self-host / trust-off behaviour unchanged |

**Browser storage (read-tolerant, never deleted).**
- New V2 keys are all prefixed `orcha:v2:` (`sidebarWidth`, `pinnedProjects`, `projectOrder`,
  `*Inspector`, `tasks:listScroll`, `search:*`, `onboarding:<cid>:state`). Rolling back leaves them
  orphaned but harmless; the pre-V2 UI never reads them.
- Onboarding draft (QA 11): V2 writes `orcha:v2:onboarding:<cid>:state`. On a **single-project**
  origin the legacy `orcha:onboarding` key is read on first boot and kept mirrored, so a rollback
  resumes the same draft. On multi-project origins the legacy key is ignored (it has no cid) and
  never deleted.
- Legacy prefs `orcha:theme`, `orcha:skin`, the `/api/prefs` bag and desktop `appearance.json` are
  read but never rewritten or applied (V2 is dark-only); a rollback restores the user's old choice.

**Desktop.** The host sidebar only lights up after the portal sends `ready` (§7.5); an older
portal (pre-V2 template) falls back to the legacy TopBar layout after 3 s, and a V2 portal opened in
an older desktop build runs in its normal web layout (no `window.orchaHost`). The desktop template
copy (`desktop/scripts/copy-orcha-templates.mjs`) must be regenerated whenever `static/dist` is
rebuilt; `templates.parity.test.ts` guards it.

**Rollback procedure.** Revert the V2 commits on the branch (the built `static/dist` is tracked, so
a revert restores the previous bundle without a node build), rebuild the portal image and relaunch
with `orcha up` (never `orcha init --force` or `orcha down -v`). No data step is needed: the DB is
untouched, and the member-read guard on run reads may simply be reverted with the rest.

**Cross-agent request log retired.** Every entry in `docs/orcha-v2-requests/` was answered
(A: run-read member scope, route-table additions; B: host bridge, Files provider, `@lezer/highlight`,
request `detail`, 390 px header, Settings tabs; D/E/F/G hand-offs; E's xterm theme now uses the V2
token values in `components/terminal/orchaTerm.ts`), so the directory was deleted in the QA
parallel-fix-round commit. References to it above are historical; read it from git history.

---

## Desktop host (Agent C)

Implementation of §7 on the desktop side (`DT/` = `desktop/src/`). Everything below is shipped
code with unit tests; portal-side counterparts are B's (`F/state/host.ts`).

### C.1 Files

| Concern | File(s) |
|---|---|
| Message contract (types, channels, validators, URL helpers) — single source | `DT/shared/embed.ts` (+ `embed.test.ts`) |
| Portal-only preload → `window.orchaHost` | `DT/preload/portal.ts` (Electron wiring) + `DT/preload/portalBridge.ts` (pure, `portalBridge.test.ts`) |
| Preload build (two sandboxed entries, no shared runtime chunk) | `desktop/electron.vite.config.ts` (`preload.build.rollupOptions.input = {index, portal}`) |
| Embed-mode state machine (`pending → v2 | legacy`, 3 s) | `DT/main/embedTracker.ts` (+ test) |
| Portal→host sender check (registered view, main frame, exact origin) | `DT/main/embedIpc.ts` (+ test) |
| View bounds (left sidebar inset / legacy top inset, clamps) | `DT/main/viewBounds.ts` (+ test) |
| IPC wiring, view creation, host-modal hide, focus | `DT/main/index.ts` |
| Canonical attention on the host (plan/verify/request + follow-ups, per container, `cid` paths) | `DT/main/attention.ts`, `attentionPoller.ts` (`snapshot()`), `statusFile.ts` |
| Host sidebar (renderer) | `DT/renderer/src/host/{HostSidebar.tsx, projectModel.ts, sidebarPrefs.ts, useHostState.ts, useHostModal.ts, ConfirmStopDialog.tsx}`, `App.tsx` |
| V2 tokens for manager / onboarding / tray | `DT/renderer/src/styles.css` `@theme`, `ui/*` |

### C.2 Runtime contract as implemented

- **Preload exposure.** Each portal `WebContentsView` gets `preload: out/preload/portal.js` and
  `additionalArguments: ["--orcha-embed-origin=http://localhost:<apiPort>", "--orcha-embed-project=orcha-…"]`.
  `createOrchaHost` exposes `window.orchaHost = { version: 1, capabilities: ["sidebar","notifications","stackControl"], project, send, on }`
  **only** when `location.origin` equals that origin (checked again on every `send`/delivery).
  The manager/tray keep `preload/index.js` (`window.orchaDesktop`); portals never see it.
- **Channels.** Portal → host: `orcha:embed:toHost` (`ipcRenderer.send`, fire-and-forget).
  Host → portal: `orcha:embed:toPortal` (`webContents.send`). Nothing else is reachable.
- **Validation (both ends).** `parsePortalMessage` rebuilds every accepted message field by field
  (unknown `type` → dropped; paths must match `^\/(?![/\\])`; `search` must be `""` or start
  with `?`; counts are non-negative integers or `null`; `liveAgents` capped at 5;
  `requestHostAction.action ∈ {startStack, stopStack, openManager, addProject}`).
  Main additionally requires the sender to be the registered view's **main frame** on the
  **exact stack origin** (`acceptPortalSender`), and derives the project from the sender.
- **Mode detection.** Every main-frame cross-document navigation re-arms a 3 s timer
  (`did-start-navigation`). `ready` → `v2`; timeout → `legacy`. `pending` is laid out as V2.
  The **first** load of a view carries `?embed=desktop` (`withEmbedHint`, query/hash-safe);
  later host-initiated loads (notifications, deep links, section fallbacks) do not.
- **Layout / bounds.** `v2`/`pending`: `computeViewBounds(content, { left: sidebarWidth, top: 0 })`;
  `legacy`: `{ left: 0, top: TOPBAR_HEIGHT }` with the old TopBar and **no** host sidebar.
  The renderer reports `setHostLayout({ sidebarWidth, collapsed })` on every width/collapse
  change (drag is rAF-throttled; main clamps 200–360, rail 56). Window `minWidth 760`.
  No `titleBarStyle` change: the native title bar stays, so the view can never cover the
  window controls.
- **Host dialogs.** `ConfirmStopDialog` and `ConfirmResetModal` call `setHostModal(true/false)`
  (`useHostModal`). Main hides the active view (`setVisible(false)`) and sends
  `{type:"hostModal", open}` to it; on close it re-shows + refocuses the view. A
  `portalShow` while a host dialog is open keeps the view hidden. Sidebar row menus are
  anchored inside the sidebar (never under the view) and need no hide.
- **Focus / keys.** Showing a view focuses its webContents. Cmd/Ctrl+K in host chrome →
  `embedSend({type:"openSearch"})` → main forwards + focuses the view (only in `v2`). Keys
  inside the view never reach the host. Sidebar: ↑/↓/Home/End across rows, menus are
  `role="menu"` with Escape + focus return; the resize handle is a focusable `separator`
  (←/→ = ±16 px). Dialogs: Escape cancels (not while busy), focus restored on close.
- **Navigation.** Same project in `v2` → `embedSend({type:"navigate", path})` (SPA, keeps
  drafts/scroll). Anything else (other project, non-v2 view) → `portalShow(project, path)`
  = full load. Project switch always lands on `/?cid=<id>` (arch §4). Section/agent/settings
  paths get `cid` via `withCidParam`. `embedSend` to a non-v2 view falls back to a full load of
  the same safe path on the same origin.
- **requestHostAction.** Forwarded to the manager renderer tagged with the *sender's* stack:
  `startStack` → start; `stopStack` → the host **confirm dialog** (never silent);
  `openManager` → hide view, show Projects; `addProject` → wizard.
- **Appearance.** The 3 s skin/theme poller and the dom-ready seeding are removed. The stored
  `appearance.json` is only read, and only applied (once) to a view that falls back to
  `legacy`, so older portals keep their look; it is never rewritten (rollback-safe).
- **Pre-paint dark.** `BrowserWindow` (manager + tray) `backgroundColor: #101113`, portal views
  `setBackgroundColor(#101113)`, `html { background }` in the renderer CSS.

### C.3 Attention on the desktop (C's §3.3 decision)

- `computeAttention` implements §3.1 per container: `task_plan` (autonomy `plan`, unknown ⇒
  `plan` like the portal), `task_verify` (unless `full`), `request_answer` (open to a
  human/untargeted **or `escalated`**), plus `request_close` = **follow-up**.
- Source: `GET /api/containers` then **every** container's snapshot
  `GET /api/containers/{cid}?task_limit=200&request_limit=200` (existing member-read endpoint,
  consume-only; ≤ 25 containers/stack). `partial` when `task_total`/`request_total` exceed the
  window. Poll: 15 s (unchanged). Widget roster/task counts stay on the founding container.
- **Decision:** follow-ups are **listed** (tray list, labelled “follow-up”, status.json list)
  but **excluded from every number**: tray title, tray “NEEDS YOU”, status.json
  `totalAttention`/per-stack `attention`, host sidebar counts (`isDecisionItem`).
- The host has **no acting-human identity**, so reviewer-assigned-to-someone-else items are
  counted by the host poll. For the project open in a V2 portal the sidebar uses the portal's
  own `attention` message (acting-human aware, `assignedToOther` excluded) — tooltips say
  which measure is shown.
- Unknown ≠ zero: `orcha:listAttentionStatus` returns per-stack `{ok, containers[], unavailable[], fetchedAt}`;
  stopped / not-yet-checked / failed projects render **no number** plus a reason, and the top
  total becomes `N+` with “(k projects unavailable)”.
- Item paths carry `cid` (`/tasks?task=…&cid=…`, `/requests?req=…&cid=…`) → notifications and
  tray clicks land in the right project (GAP-07).

### C.4 Host sidebar content (desktop mirror of §8)

Brand + collapse · **Needs you** (sum of known decision counts; click → `/needs` in the open V2
project, else the first waiting decision's deep link) · **Projects** + add · one row per
container across all local stacks (status shape + word, name, count, `⋯` menu: Open, Pin/Unpin
(shared with the home screen's favorites), Move up/down (`orcha:host:projectOrder`), Pair phone
→ `/settings?cid=…#tab=pairing` (GAP-06), Project settings, Start stack / Stop stack…) · for the
open project: Overview, Tasks, Agents, Requests, Code, GitHub, Activity, Metrics and **Live
agents** (≤ 5 from the portal's `liveAgents`; stale label after 2 min; → `/agents?agent=…&tab=conversation`;
“View all agents”) · All projects (manager) · Settings (open project) · Help (repo README) ·
discreet attribution. Stopped stacks are one muted row (“stopped”); a running stack whose
container list is not loaded yet is one “loading…” row. Section rows show **no counts** on
desktop (the host has no authoritative open-task/request totals — rather none than a wrong one).
Delete & reset stays on the Projects manager behind its type-to-confirm dialog.

### C.5 What the portal (B) must do for this to light up

See `docs/orcha-v2-requests/B.md` “From C”. Until B ships `F/state/host.ts`, every view times
out to `legacy` and the desktop behaves exactly like today (TopBar + portal's own sidebar).

### C.6 Known limitations

- First onboarding and the add-project wizard hide the host sidebar entirely (the wizard has its
  own Cancel back to the manager); switching projects mid-provisioning is intentionally not
  offered.
- An older portal shows its own sidebar for up to 3 s on its first load before the host
  switches to the legacy layout (then cached per stack for the session).
- Home-screen favorites and sidebar pins share storage but the home grid reads it on mount, so
  a pin made in the sidebar shows on the grid after its next mount.
