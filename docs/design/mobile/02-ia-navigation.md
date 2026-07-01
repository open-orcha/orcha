# Orcha Mobile — Information Architecture & Navigation

Phase 2 for GH [#30](https://github.com/open-orcha/orcha/issues/30). Defines every screen, how they
connect, and where iOS and Android differ. Screen-level specs live in `flows/`; visual mockups in
`mockups/`.

## 1. Mental model

A phone connects to one or more **containers** (a container = one locally-running Orcha on some
machine, reached over the LAN at the base URL captured during QR pairing). Inside a container the
user sees the same four worlds the portal shows: **Home** (action queue), **Tasks**, **Requests**,
**Agents**.

```
App root
└── Containers home ("My Orchas")            ← multi-container list + Add (QR scan)
    └── Container workspace (tabbed)
        ├── Tab 1: Home        — action queue (approvals + requests needing me) + agents glance + activity
        ├── Tab 2: Tasks       — kanban-ish grouped list → Task detail
        │       └── Task detail (status, DoD, close/cancel)
        │           ├── Thread (read + send messages)
        │           ├── Worker runs → Run detail (streaming log)
        │           └── Approval sheets (plan approval / verify) when pending
        ├── Tab 3: Requests    — grouped list → Request detail (respond / nudge / close)
        ├── Tab 4: Agents      — grid/list → Agent detail
        │       ├── Conversation (converse with agent)
        │       ├── Controls (model picker, scheduled wakes/auto-wake)
        │       └── Runs → Run detail (streaming log)
        └── (+) Create task    — floating action / toolbar button, available on Home & Tasks
```

Settings (theme, notifications, manage containers) hangs off the Containers home and the workspace
overflow menu.

## 2. Screen inventory

| # | Screen | Source of data (primary endpoints) | Spec |
|---|---|---|---|
| S1 | Containers home + Add | local store of paired containers; per container `GET /api/containers/{cid}` (health probe) | flows/04 |
| S2 | QR scan / pairing | camera + payload → `GET /api/containers` on target host (validation) — **new API ask for auth** | flows/03 |
| S3 | Container Home tab | `GET /api/containers/{cid}/tasks`, `/requests`, `/agents` via `GET /api/snapshot/{cid}` where possible; SSE `GET /api/containers/{cid}/events` | flows/04 |
| S4 | Tasks list | `GET /api/containers/{cid}/tasks` | flows/05 |
| S5 | Task detail | `GET /api/tasks/{tid}/messages` (returns task + messages), `POST /api/tasks/{tid}/cancel`, `POST /api/tasks/{tid}/verify` | flows/05, 08 |
| S6 | Task thread | `GET/POST /api/tasks/{tid}/messages` | flows/05 |
| S7 | Task runs list | `GET /api/tasks/{tid}/runs` | flows/06 |
| S8 | Run detail (live log) | `GET /api/agents/{aid}/runs/{run_id}/stream` (SSE) | flows/06 |
| S9 | Requests list | `GET /api/containers/{cid}/requests` | flows/07 |
| S10 | Request detail | `POST /api/requests/{rid}/respond`, `/nudge`, `/close`, `/accept-task`, `/reject-task`, `/escalate`, `/convert-to-task` | flows/07 |
| S11 | Plan-approval sheet | `POST /api/decisions` (subject plan_approval) | flows/08 |
| S12 | Verify sheet | `POST /api/tasks/{tid}/verify` | flows/08 |
| S13 | Agents list | `GET /api/snapshot/{cid}` (agents slice) | flows/09 |
| S14 | Agent detail | agent slice + `GET /api/agents/{aid}/outbox`, `/inbox`, `/runs`, `/resident-runs` | flows/09 |
| S15 | Agent controls | `GET /api/models`, `POST /api/agents/{aid}/model`, `PATCH /api/agents/{aid}/auto-wake` | flows/09 |
| S16 | Converse | `POST /api/agents/{aid}/conversations`, `GET /api/agents/{aid}/conversation`, `GET/POST /api/conversations/{conv_id}/turns`, `POST /api/conversations/{conv_id}/end` | flows/10 |
| S17 | Create task | `GET /api/snapshot/{cid}` (agents for assignee picker), `POST /api/containers/{cid}/tasks`, `POST /api/tasks/{tid}/assign` | flows/11 |
| S18 | Settings | local prefs; container: `GET/POST /api/containers/{cid}/autonomy` (read-only display v1) | flows/04 |

## 3. Navigation patterns

### Android — Material 3

- **Containers home:** top app bar (centered "Orcha"), list of container cards, **FAB "Add"** →
  full-screen QR scanner.
- **Container workspace:** **Navigation bar** (bottom) with 4 destinations: Home, Tasks, Requests,
  Agents (Material icons + labels, badge counts on Home/Requests). Top app bar shows container name,
  overflow menu (Settings, Switch container, Disconnect).
- **Create task:** FAB on Home and Tasks tabs.
- **Detail screens** push onto the tab's back stack. System back pops; back from tab root returns to
  Containers home; back from Containers home exits app (default predictive-back).
- **Approvals / confirmations:** **modal bottom sheets** for plan-approval, verify, respond; **M3
  AlertDialog** only for destructive confirms (cancel task, disconnect container).
- **Run log:** full screen with collapsing top app bar; log text in JetBrains Mono.
- **Pull-to-refresh** on all lists (M3 `PullToRefreshBox`); SSE keeps things live when connected.

### iOS — Human Interface Guidelines

- **Containers home:** `NavigationStack` root, large title "Orcha", **toolbar "+" (Add)** → QR
  scanner sheet (`.sheet`, full-height detent with camera).
- **Container workspace:** **TabView** with 4 tabs (SF Symbols + labels, badge counts). Navigation
  title = container name; toolbar trailing: overflow (ellipsis) menu.
- **Create task:** toolbar "+" on Home and Tasks tabs (`navigationBarTrailing`); no FAB on iOS.
- **Detail screens** push in each tab's `NavigationStack`. Swipe-back everywhere. Tab re-tap pops to
  root (platform default).
- **Approvals / confirmations:** **sheets with detents** (`.medium`/`.large`) for plan-approval,
  verify, respond; destructive confirms use `confirmationDialog` (action sheet idiom) — *not* alerts —
  for cancel task / disconnect.
- **Run log:** pushed screen, inline nav title, mono text, auto-scroll toggle.
- **Pull-to-refresh** via `.refreshable`.

### Where the platforms intentionally differ

| Concern | Android | iOS |
|---|---|---|
| Tab bar | M3 Navigation bar, active-indicator pill | TabView, SF Symbols |
| Primary create action | FAB | Toolbar "+" |
| Approval surface | Modal bottom sheet (drag handle) | Sheet with medium/large detents |
| Destructive confirm | AlertDialog | confirmationDialog (action sheet) |
| Back | System/predictive back button + gesture | Swipe-back + chevron |
| Snack/toast feedback | M3 Snackbar | Inline banner (top, auto-dismiss) |
| Menus | DropdownMenu on overflow | Menu on ellipsis button |
| Search in lists | M3 SearchBar collapsing | `.searchable` in nav bar |

Everything else — card anatomy, badge colors, list grouping, empty/error states, thread bubbles —
is pixel-equivalent between platforms.

## 4. Connectivity & realtime model (shared — Andrew + Ethan must build the SAME model)

- **Base URL per container** captured at pairing (LAN IP + port, e.g. `http://192.168.1.20:8001`).
  Stored locally (Keychain / EncryptedSharedPreferences) together with the pairing token (see
  flows/03 + doc 13 — auth is a NEW API ask).
- **Reachability:** every container screen renders one of: `live` (SSE connected), `polling`
  (SSE failed, 30s poll fallback), `unreachable` (probe failed → full-screen state with retry, see
  flows/04). Probe = `GET /api/containers/{cid}` with 3s timeout.
- **Realtime:** one SSE connection per open container workspace: `GET /api/containers/{cid}/events`.
  On event, invalidate the relevant list/detail query (client-side cache keyed per endpoint). Run
  logs open their own stream `GET /api/agents/{aid}/runs/{run_id}/stream` while the run screen is
  visible. SSE closes when app backgrounds; reconnect + full refetch on foreground.
- **No writes are queued offline in v1**: if unreachable, mutating buttons disable with an
  explanatory note. (Offline queue = v2 consideration.)
- **Actor identity:** every mutating call needs an actor id (`actor_agent_id` /
  `requester_agent_id` / `author_agent_id`). The phone acts as the paired **human** — the pairing
  payload must therefore carry the human agent id. Listed in doc 13 as part of the pairing contract.

## 5. Notifications (scope note)

Issue #30 doesn't require push, and the backend has no push service; v1 relies on foreground SSE.
The Home tab badge shows the pending-decisions + open-requests-for-me count while connected.
Local/push notifications are listed as a v2 ask in doc 13.

## 6. Deep-link map (internal routing, also future push payloads)

```
orcha://container/{cid}                     → workspace Home tab
orcha://container/{cid}/tasks/{tid}         → Task detail
orcha://container/{cid}/tasks/{tid}/thread  → Task thread
orcha://container/{cid}/requests/{rid}      → Request detail
orcha://container/{cid}/agents/{aid}        → Agent detail
orcha://container/{cid}/agents/{aid}/chat   → Conversation
orcha://pair?payload=…                      → pairing confirm screen
```
