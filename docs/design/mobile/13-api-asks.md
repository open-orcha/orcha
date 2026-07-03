# Orcha Mobile — New API Asks (appendix)

Everything the mobile designs need that `/openapi.json` (verified 2026-07-01, 104 path+method
operations across 92 unique paths) cannot
serve today. Nothing here is silently assumed by the designs: each screen that depends on a new ask
labels it `NEW — ask <id>` in its endpoint annotations. Owners: backend + portal; Andrew and Ethan
build against the final contracts once agreed.

## A1 — Pairing payload endpoint + portal "Pair phone" UI  **(blocks pairing flow)**

- **What:** `GET /api/containers/{cid}/pairing` (proposed) returning the QR payload from
  [flows/03-pairing.md](flows/03-pairing.md) §2: version, kind, **LAN-reachable base URL**
  (never localhost — server must detect its LAN IP or refuse with a diagnosable error),
  container id + name, human agent id ("pair as"), short-lived pairing token, expiry, and a
  **human-typable short code** for the manual-entry fallback.
- **Portal work:** "Pair phone" header button + modal (specced with mockups P1/P2 in
  `mockups/03-pairing.html`), auto-regenerating QR, "pair as" picker when >1 human.
- **Open questions for the team:** payload as JSON vs. URL form (`orcha://pair?…`) for OS-level
  QR handling; expiry length; whether pairing is per-container or per-server.

## A2 — Mobile auth / device tokens  **(security decision, needs an explicit call)**

- **Reality today:** the API has **no authentication at all**; the portal relies on being
  localhost-only. Pairing a phone means the server starts listening on the LAN — that changes the
  security posture for *every* client, not just mobile.
- **Ask:** `POST /api/pair` (proposed) exchanging the short-lived pairing token for a long-lived
  device token; subsequent requests authenticated (e.g. `Authorization: Bearer`); a way to list and
  revoke paired devices (portal Settings).
- **Also in scope of this decision:** plain HTTP on LAN vs. self-signed TLS — the answer fixes the
  transport exceptions both apps ship, so treat it as **one** call (per Ethan + Andrew's ACKs):
  - *iOS:* the base URL is a runtime LAN IP, so no per-domain ATS exception is possible — it's
    `NSAllowsLocalNetworking` (RFC1918 / `.local`, the clean option) or the broader
    `NSAllowsArbitraryLoads`. Separately, the first LAN request triggers the iOS **local-network
    privacy prompt** (`NSLocalNetworkUsageDescription` + a distinct permission-denied failure state
    in the pairing flow — see flows/03 §Platform notes).
  - *Android:* plain-HTTP LAN needs a cleartext-traffic exception in the network security config,
    scoped narrowly (per-host, not app-wide `usesCleartextTraffic`).
  - Also: whether SSE endpoints accept the token via header or query param.
- **Design stance:** v1 mockups render no auth UI beyond pairing; if the team ships
  unauthenticated-LAN as an interim, the pairing confirm screen's copy must say so honestly.

## A3 — Read-scoped bulk endpoints exist — confirm mobile fitness (verify, not build)

- `GET /api/snapshot/{cid}` appears to bundle agents+tasks+requests (portal uses it). Mobile leans
  on it heavily (Home tab, pickers). **Ask:** confirm payload size stays phone-friendly on big
  containers, or add `?since=` delta support. Low priority; SSE + per-list endpoints are the fallback.

## A4 — Push notifications (v2, parked)

- No push infrastructure exists and v1 explicitly relies on foreground SSE
  ([02-ia-navigation.md](02-ia-navigation.md) §5). A future ask would need a relay (the laptop can't
  reach APNs/FCM for a sleeping phone without a cloud hop) — this contradicts the "nothing goes
  through the cloud" story, so it deserves its own design round. Parked, not assumed anywhere.

## A5 — Conversation/thread image upload from mobile (v2, parked)

- The API already accepts attachments (`POST /api/conversations/{conv_id}/attachments`,
  `POST /api/tasks/{tid}/attachments`) so this is *client* work, not an API gap; noted here only
  because flows 05/10 mark composer attachment buttons as v2.

## A6 — Human-actor conveniences (nice-to-have)

- Request list filtering server-side (`?involving=<agent_id>&status=open`) — today mobile filters
  `GET /api/containers/{cid}/requests` client-side; fine at current scale.
- `GET /api/tasks/{tid}` standalone (today task detail rides on `GET /api/tasks/{tid}/messages`
  which returns `{task, messages[]}` — works, slightly odd for a detail-only refresh).

## A7 — Task-update endpoint (edit / turn off a schedule)  **(NEW)**

- **What:** a route to change or clear `schedule_interval_secs` on an existing task — e.g.
  `PATCH /api/tasks/{tid}` (or `POST /api/tasks/{tid}/schedule`) accepting
  `{schedule_interval_secs}` where a value `>= 60` re-times the repeat and `null`/`0` turns repeat
  off while keeping the task. Reuse the same `ge=60` validation and the same "no dependencies"
  rejection as create (PR #68).
- **Why:** PR #68 only ever SETS `schedule_interval_secs` at creation
  (`POST /api/containers/{cid}/tasks`). The only mutations on an existing task are
  cancel / done / verify / assign / protocol — none touch the schedule. So there is no way to
  change an interval or turn a repeat off without a new endpoint. Verified against the PR #68 diff
  (the field is not in live `/openapi.json` until #68 merges).
- **What already works (so this is edit-only, not blocking):** *ending* a repeat needs no new API —
  the existing `POST /api/tasks/{tid}/cancel` stops it, because re-arm matches only
  `status='completed'` and a cancelled task never re-arms. A7 is only for *keeping the task alive
  while changing the cadence or pausing the repeat.*
- **Design stance:** the mobile detail (flows/scheduled/README.md §5) shows **Change interval…** and
  **Turn off repeat…** in the overflow menu, rendered **disabled with an honest note** until A7
  ships. No mockup silently assumes the endpoint exists.
- **Owners:** backend + portal define the contract; Andrew (Android) and Ethan (iOS) wire the
  affordance once agreed.

## Coordination

The shared connectivity/auth/navigation model (02 §4 + this doc) is the contract Andrew and Ethan
each acknowledge via Orcha requests before implementation starts, so the platforms cannot drift.
