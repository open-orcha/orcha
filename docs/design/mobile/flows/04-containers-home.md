# Flow 04 — Containers home, workspace Home tab & Settings

Mockups: [`../mockups/04-containers-home.html`](../mockups/04-containers-home.html)

> **Status: buildable against the existing API.** Everything on these screens is served by
> endpoints already in `/openapi.json` — the probe, the bulk snapshot, the decision/verify writes,
> and the SSE event stream. The only external dependency is pairing itself (flow 03), which puts
> containers into the local store this flow reads.

## 1. Story

The app opens on **Containers home ("My Orchas")** — the list of every Orcha the phone has paired
with. Each card answers three questions at a glance: *which machine is this*, *can I reach it right
now*, and *does anything need me*. Tapping a reachable card enters that container's **workspace**,
landing on the **Home tab**: the mobile twin of the portal dashboard. Its hero is the **"Needs you"
queue** — plan approvals, tasks awaiting verification, and open requests aimed at the human — because
the phone's whole reason to exist is letting the human unblock agents from the couch. Below it:
agents at a glance, stat tiles, and a live activity feed. **Settings** (theme, manage containers,
about) hangs off Containers home and the workspace overflow menu.

## 2. Containers home ("My Orchas")

- **List** of paired container cards, most-recently-opened first. Card anatomy:
  - container **name** (from pairing payload) + host `baseUrl` in mono,
  - **reachability** chip: `live` (`.conn`, pulsing dot) / `polling` / `unreachable` (`.conn.off`,
    with "last seen …"),
  - **counts** line when reachable: `N agents · N tasks · N need you` (the "need you" count uses the
    same derivation as the Home tab queue, §3),
  - unreachable cards stay tappable → they open the workspace's unreachable full-screen state
    (frame H7) so Retry lives in one place.
- **Add:** Android **FAB "+ Add"** → full-screen QR scanner; iOS **toolbar "+"** → scanner sheet
  (both defined in flow 03).
- **Card actions:** Android **long-press** → menu (Rename, Disconnect); iOS **swipe-left** →
  Rename / Disconnect (also in a context menu on long-press). *Disconnect* is destructive-confirmed
  (frame H4): it only forgets the pairing on this phone — copy says so explicitly, the laptop's
  Orcha is untouched.
- **Rename** edits the local display name only (never writes to the server).
- **Empty state** (first launch, frame H3): brand mark, "Add your Orcha" primary CTA, and a
  pointer to where the QR lives — *"Open the portal on your computer and choose **Pair phone**"*.
- Reachability probes (`GET /api/containers/{cid}`, 3s timeout) fire for every card on appear,
  on pull-to-refresh, and on foreground; results render per-card without blocking the list.

## 3. Workspace Home tab

Landing tab after entering a container. Top app bar: container name + connection chip
(`live` / `polling`); overflow menu (Settings, Switch container, Disconnect). Android shows the
create-task FAB; iOS a toolbar "+". Bottom navigation: **Home / Tasks / Requests / Agents**, with a
badge on Home = pending decisions + open requests for me.

Sections, top to bottom (frames H5/H6):

1. **"Needs you" queue** — one card per actionable item, each with inline actions:
   - **Plan approval** — task title, proposing agent + model, plan excerpt (tap → full plan in the
     approval sheet, flow 08). Actions: **Approve plan** / **Reject…** (reason required on reject).
     Writes `POST /api/decisions` with `subject_type:"plan_approval"`, `subject_id` = task id,
     `decision:"approve"|"reject"`, optional `reason`, `actor_agent_id` = paired human.
   - **Verify task** — task title, assignee, definition-of-done excerpt. Actions: **Accept** /
     **Reject…** (feedback required on reject). Writes `POST /api/tasks/{tid}/verify`
     `{approve, feedback?, actor_agent_id}`.
   - **Request for me** — requester, payload excerpt. Action: **Respond** → Request detail (flow 07).
   - Empty queue renders a quiet "Nothing needs you right now" row — never a blank gap.

   **Derivation (binding, same as the portal dashboard):**
   - *plan approval pending* = task `in_progress` with **no** `plan_decision` and a plan message
     present;
   - *verify pending* = task status `needs_verification`;
   - *requests needing me* = `open` requests targeting the paired human.

2. **Agents at a glance** — horizontally scrolling strip: avatar + name + status pill per agent
   (status → color per foundations §2; `working` pulses). Tap → Agent detail (flow 09).

3. **Stat tiles** — tasks by status: In progress / Needs verify / Blocked / Done (tap → Tasks tab
   pre-filtered). Optionally a tokens tile from `GET /api/containers/{cid}/token-usage`.

4. **Activity** — recent thread messages, decisions, and request answers, newest first, synthesized
   from snapshot data (the SSE stream signals *when* to refetch; it is not itself a feed).
   Tap → the task/request it came from.

After a queue action succeeds, the card is suppressed locally until the next snapshot confirms the
state change (mirrors the portal's acted-set) — the same card can never be double-submitted.

## 4. Settings

Reached from Containers home (gear) and the workspace overflow. Frame S1. Plain grouped list:

- **Appearance:** theme segmented control **Auto / Light / Dark** (Auto = follow system, default;
  applies instantly, foundations §7).
- **Containers:** rows for each paired container (name, host, reachability) → rename / disconnect
  (same confirms as §2); "Add container" row → scanner.
- **About:** app version, link to openorcha.io, licenses.

All local; the one server-derived row is per-container reachability. Container autonomy state is
displayed read-only in v1 (doc 02, S18).

## 5. Connection states

| State | Trigger | Rendering |
|---|---|---|
| `live` | SSE `GET /api/containers/{cid}/events` connected | green `.conn` chip; lists update on events |
| `polling` | SSE dropped/failed; probe still OK | persistent warn banner "Live updates unavailable — checking every 30s" (frame H8); chip `.conn.polling`; data refetched on a 30s timer; SSE retried with backoff |
| `unreachable` | probe (`GET /api/containers/{cid}`, 3s timeout) fails | full-screen state (frame H7): wifi-off glyph, host shown in mono, Wi-Fi/running/firewall checklist (same copy as flow 03 A3), **Try again** + "Back to My Orchas" |
| paused | container `status != active` in the snapshot | info banner "This Orcha is paused — agents won't act until it's resumed from the laptop" (frame H10); mutating agent actions disable; reading stays free |
| loading | first entry, nothing cached | skeleton rows shaped like the real sections (frame H9); cached snapshot renders instantly on revisit with a background refetch |

Writes are never queued offline (doc 02 §4): when not `live`/`polling`, action buttons disable with
the explanatory state above.

## 6. Screens & states (mockup frames)

| Frame | Screen | Notes |
|---|---|---|
| H1 | Containers home (Android) | FAB Add; one live card + one unreachable card |
| H2 | Containers home (iOS, light) | large title, toolbar "+"; same cards |
| H3 | Containers home — empty | first launch; "Add your Orcha" CTA + portal Pair-phone pointer |
| H4 | Disconnect confirm (Android) | M3 AlertDialog, destructive; iOS uses confirmationDialog |
| H5 | Home tab (Android) | Needs-you queue (plan + verify + request), agents strip, stats, activity; nav bar badge; FAB |
| H6 | Home tab (iOS, light) | TabView variant; toolbar "+"; same anatomy |
| H7 | Unreachable full-screen | probe failed; checklist + Retry |
| H8 | Degraded — polling banner | SSE down, 30s polling; warn banner + `.conn.polling` chip |
| H9 | Loading skeleton | first-load shimmer shaped like the Home tab |
| H10 | Paused container banner | container paused; mutating actions disabled |
| S1 | Settings (iOS) | theme Auto/Light/Dark segmented, manage containers, about |

## 7. Behavior

- **Data:** on workspace entry, one `GET /api/snapshot/{cid}` paints everything (agents + tasks +
  requests); `GET /api/containers/{cid}/tasks` and `/requests` back the per-tab refetches that SSE
  events invalidate. One SSE connection per open workspace; closed on background, reconnect + full
  refetch on foreground.
- **Actor identity:** every write carries the paired human's agent id (`actor_agent_id`) captured
  at pairing — the phone is the human's remote control, not an agent of its own.
- **Reject requires a reason** (plan) / **feedback** (verify) — same invariant as the portal;
  the confirm button stays disabled until text is entered.
- **Badge count** (Home tab + app icon where allowed) = queue length from §3's derivation.
- **Pull-to-refresh** everywhere re-probes + refetches the snapshot.

## 8. Platform notes

- **Android:** container list is a plain scrolling list under a centered top app bar; FAB for Add
  (Containers home) and Create task (workspace). Long-press context menu; destructive confirm =
  M3 AlertDialog. Nav bar with active-indicator pill; predictive back from workspace → Containers
  home. Queue actions confirm via Snackbar ("Plan approved — routed to Dana").
- **iOS:** `NavigationStack` with large title "Orcha"; toolbar "+" and gear. Swipe actions on
  container rows; destructive confirm = `confirmationDialog`. Workspace is a `TabView`; tab re-tap
  pops to root. Queue actions confirm via top toast banner.
- **Both:** approval/verify one-tap actions live on the card; anything needing composition (reject
  reason, request response) opens the platform sheet (flow 07/08).

## 9. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| Reachability probe / health | `GET /api/containers/{cid}` | exists |
| Bulk workspace paint (agents + tasks + requests) | `GET /api/snapshot/{cid}` | exists |
| Tasks slice (tab refetch) | `GET /api/containers/{cid}/tasks` | exists |
| Requests slice (tab refetch) | `GET /api/containers/{cid}/requests` | exists |
| Live updates | SSE `GET /api/containers/{cid}/events` (fallback: 30s polling) | exists |
| Token/usage stat tile (optional) | `GET /api/containers/{cid}/token-usage` | exists |
| Approve/reject plan | `POST /api/decisions` `{subject_type:"plan_approval", subject_id, decision, reason?, actor_agent_id}` | exists |
| Accept/reject verification | `POST /api/tasks/{tid}/verify` `{approve, feedback?, actor_agent_id}` | exists |
