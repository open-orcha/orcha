# Push notifications — APNs pipeline (dormant until credentials)

Real remote push for needs-you items, built end-to-end and deployed **dormant**:
until the paid Apple Developer Program upgrade supplies an APNs auth key, every
layer degrades to a quiet no-op and the existing BGAppRefresh **local**
notification path (`ios/Orcha/App/NotificationManager.swift`) keeps doing what
it does today. Flipping push on is configuration, not code.

**Design rule:** customer/BYOC boxes NEVER hold the APNs signing key. A small
central relay (operated by us) signs and delivers; boxes only emit events.

## Architecture

```
box (portal)                          box (host timer)            our box (central)
────────────────────────────          ─────────────────────       ─────────────────────
needs-you transition commits          push-forwarder.timer        push-relay.service
  └─ after-commit hook                  (deploy/push-forwarder.py)  (deploy/push-relay/)
     push_outbox row  ───claim/mark───►  POST /relay/push  ───────►  signs ES256 JWT
     (portal_backend/push_outbox.py)     bearer RELAY_TOKEN          APNs HTTP/2 ──► phone
push_devices registry                    revokes Unregistered
  (POST /api/push/devices)               tokens via the portal
```

### 1. Device registry (portal, mig 041 `push_devices`)

Identity-level like `user_prefs` (mig 040): a device belongs to a GitHub
account, not a project. All three endpoints require the trusted proxy identity
mapped as a live human member of ANY project on the stack (403 otherwise —
self-host stacks have no surface here, same as device tokens):

- `POST /api/push/devices` `{apns_token, platform?='ios'}` — upsert by token
  (UNIQUE), **re-owned to the current login** on every registration (a
  handed-down phone stops pushing to its previous owner), `last_seen_at`
  refreshed, a revoked token revived. Tokens are 16-200 hex chars, stored
  lowercased.
- `GET /api/push/devices` — the acting identity's own live devices.
- `DELETE /api/push/devices` `{apns_token}` — revoke: your own, or (as an
  **owner**) a device held by a member of a project you own. Idempotent.

### 2. Event emission (portal, `portal_backend/push_outbox.py`)

The hook fires on exactly the three transitions that BIRTH a needs-you item —
the same gate set the iOS local sweep computes client-side:

| transition | hook call site (after the handler's `conn.commit()`) | outbox kind |
|---|---|---|
| task → `needs_verification` (`plan`/`pr` autonomy `/done`) | `task_done_routes.mark_done` | `task_verify` |
| OPENING agent-authored message on an in-progress task (= `plan_message`, `task_list_query.py` semantics; no `plan_approval` decision yet) | `task_message_routes.post_message` | `plan_approval` |
| request opened targeting a human (unspecified targets resolve to the human at birth — Orcha#30) | `request_creation_routes.create_request` | `request` |

Contract: **after-commit, best-effort, failure-silent.** The hook runs in its
own connection after the main transaction committed, swallows every exception,
and its cheapest gate runs first — if no live `push_devices` row belongs to a
member of the container, nothing is written (the dormant default costs one
indexed SELECT per needs-you birth). Rows carry `(container_id, kind, ref_id,
title, body)` only — recipient devices are resolved **at send time**, never
snapshotted. Titles mirror the local sweep verbatim ("Verify task — {project}",
"Plan approval — {project}", "Request for you — {project}"). Rows older than
48h are pruned on every enqueue and every claim. Known non-goals for now:
request escalation/re-target paths and `/verify` reject-rework do not enqueue
(the BGAppRefresh sweep still covers them).

### 3. Box forwarder (`deploy/push-forwarder.py` + `.service`/`.timer`)

A one-minute oneshot timer, stdlib-only. Dormant contract: without `RELAY_URL`
+ `RELAY_TOKEN` (from `/opt/orcha-cloud/deploy/push.env`) it exits 0 without a
single HTTP call. When active, one tick:

1. `POST /api/push/outbox/claim` — pending events with devices resolved live
   (rows whose audience vanished are failed in place; >48h rows pruned).
2. `POST {RELAY_URL}/relay/push` (bearer) — one entry per event × device.
3. `POST /api/push/outbox/mark` — `delivered_at` when ≥1 device delivered;
   `failed` when every device is Unregistered; retryable failures stay pending
   for the next tick (at-least-once, bounded by the 48h prune).
4. `POST /api/push/devices/revoke-unregistered` — retires dead tokens.

The three portal box-lane endpoints refuse a trusted browser identity (403) —
they are for the headerless loopback lane the deploy timers already use.

### 4. Central relay (`deploy/push-relay/` — README there for install)

The ONLY holder of the `.p8`. `POST /relay/push {events:[{apns_token, title,
body, payload}]}` behind per-box bearer `RELAY_TOKEN`; signs an ES256 provider
JWT from `APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_KEY_P8`/`APNS_TOPIC`/`APNS_ENV`
(refreshed every 50 min) and delivers over APNs HTTP/2. Per-event status:
`delivered` | `unregistered` (410/`Unregistered`/`BadDeviceToken` → boxes
revoke) | `failed` (retryable). **APNS env absent → every push answers 503**
with a message naming the missing variables. Runs on our box for dogfood;
architecturally central — moving it later only changes the boxes' `RELAY_URL`.

## Honest current state

| | today (free Apple account) | after the paid upgrade + runbook |
|---|---|---|
| needs-you alerts | BGAppRefresh local sweep — opportunistic, "within the hour", only while iOS grants background budget | real APNs push, seconds after the transition commits (minute-granular: forwarder tick) |
| server pipeline | fully built; outbox stays EMPTY (no devices registered → hook no-ops) | active end-to-end |
| relay | deployable now; `/relay/push` answers 503 (dormant) | delivers |
| iOS app | cannot register with APNs at all — the `aps-environment` entitlement requires a paid team; `registerForRemoteNotifications` would fail with error 3000 | registers, POSTs token, receives pushes |
| deep-link taps | local notifications only | identical routing for both (same `{cid, kind, id}` payload) |
| risk of regression | zero — nothing existing reads the new tables | local sweep stays as belt-and-braces |

---

## iOS integration SPEC (for the iOS worktree — no `ios/` files changed here)

The pushes carry the SAME `userInfo` triple the local notifications already
use, so tap routing needs zero changes. The work is: an entitlement, an app
delegate adaptor, token registration gated on capability, and one API call.

### S1. project.yml — entitlement + background mode (paid team required)

Add to the `Orcha` target (this is inert until built with a paid
`DEVELOPMENT_TEAM`, which lives in the gitignored `project.local.yml`):

```yaml
    entitlements:
      path: Orcha/Orcha.entitlements
      properties:
        aps-environment: development   # Xcode flips to `production` for App Store/TestFlight archives
    info:
      properties:
        UIBackgroundModes:
          - fetch
          - remote-notification        # append; keep `fetch` — the local sweep stays
```

Keep `CODE_SIGNING_ALLOWED: "NO"` in the base settings; simulator/CI builds
without a team keep compiling because the entitlement only matters at signing.

### S2. App delegate adaptor (registration callbacks)

SwiftUI apps need a `UIApplicationDelegate` for the APNs callbacks. In
`OrchaApp.swift` add `@UIApplicationDelegateAdaptor(PushDelegate.self)`; new
file `ios/Orcha/App/PushDelegate.swift`:

- `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)` → hex-encode
  lowercased (`token.map { String(format: "%02x", $0) }.joined()`) and hand it
  to the registration flow (S3). Fires on every launch AND on token rotation —
  both must re-POST.
- `application(_:didFailToRegisterForRemoteNotificationsWithError:)` → **the
  entitlement gate.** On a free-team build this fires (error 3000, "no valid
  aps-environment entitlement"). Log once, do nothing else — the local sweep
  is the fallback by construction. Never surface an error to the user.

### S3. Registration flow (gated, idempotent)

Call `UIApplication.shared.registerForRemoteNotifications()` on app foreground
when BOTH hold: notification permission is `.authorized` (the existing
`NotificationCoordinator.requestPermission()` flow) AND at least one stored
container has a device bearer token (`BearerTokens.token(for:)` non-nil).
The call is free — without the entitlement it just routes to `didFail`.

On receiving the hex token, for EVERY paired cloud container (dedup by
`baseUrl`): `POST {base}/api/push/devices` body
`{"apns_token": "<hex>", "platform": "ios"}` with the stored
`Authorization: Bearer <device token>` (the perimeter's forward_auth lane turns
it into the trusted identity — same as every other API call). Each box keeps
its own registry, so registering with all of them is correct, not redundant.
Expected failures to swallow silently: 403 (self-host box, no proxy identity —
push simply doesn't exist there), timeouts (LAN box asleep). Re-POST on every
launch — the upsert is the `last_seen_at` heartbeat.

On unpair/remove of a container (and on the Settings "sign out" path if one
exists): `DELETE {base}/api/push/devices` body `{"apns_token": "<hex>"}`
against that box. Best-effort; revocation also happens server-side when APNs
reports the token dead.

### S4. Payload, foreground handling, taps

Delivered payload (relay-constructed):

```json
{"aps": {"alert": {"title": "Verify task — myproj", "body": "ship the widget"},
         "sound": "default"},
 "cid": "<container uuid>", "kind": "task", "id": "<task-or-request uuid>"}
```

`kind` is `"task"` (verify + plan approval) or `"request"` — EXACTLY the
`userInfo` triple `NotificationCoordinator` already writes into local
notifications, so the existing
`userNotificationCenter(_:didReceive:)` deep-link handler (`kind == "request"
? .request(id) : .task(id)`) handles remote taps with **zero changes** once
the delegate is (already) the notification-center delegate.

Foreground: the existing `willPresent` returns `[]` for everything but the
test alert — keep that; a remote push arriving while the app is open stays
silent and the in-app Needs-you badge covers it. Keep the BGAppRefresh sweep
untouched as belt-and-braces; the known cosmetic overlap (a remote push AND a
later local alert for the same still-pending item within one sweep window) is
acceptable for v1 — if it grates, `didReceive`/`willPresent` can add the
matching sweep keys (`"\(cid)|task|\(id)|verify"` / `|plan`,
`"\(cid)|request|\(id)"`) to the `orcha_notified_ids` seen set.

### S5. iOS test hooks

Unit-testable seams (mirror `DeviceAuthFlow` conventions): token-hex encoding;
"should register" gate (permission × paired-cloud-container); the register/
unregister POST/DELETE bodies + swallowed-403 behavior. No XCUITest needed.

---

## Activation runbook (when the paid upgrade lands)

1. **Apple Developer Program** — upgrade the account ($99/yr). The team id
   changes from the free "personal team": note the new `DEVELOPMENT_TEAM`.
2. **APNs auth key** — developer.apple.com → Certificates, Identifiers &
   Profiles → Keys → new key with APNs enabled → download
   `AuthKey_<KEYID>.p8` (one-time download; vault it). One key serves both
   sandbox and production.
3. **Relay** — install per `deploy/push-relay/README.md`; add the `APNS_*` env
   to `relay.env` (`APNS_TOPIC=io.openorcha.mobile.ios`, `APNS_ENV=sandbox`
   for dev/TestFlight-sandbox tokens, `production` for App Store/TestFlight
   builds — note TestFlight builds get PRODUCTION tokens); restart; healthz
   shows `"configured": true`.
4. **Box** — write `/opt/orcha-cloud/deploy/push.env` with `RELAY_URL` +
   `RELAY_TOKEN`; `systemctl enable --now push-forwarder.timer` (units in
   `deploy/`). The portal needs nothing: mig 041 applied on boot.
5. **iOS** — apply S1-S3; set the paid `DEVELOPMENT_TEAM` in
   `project.local.yml`; `xcodegen generate`; register the App ID with Push
   Notifications capability (Xcode automatic signing does this). Device build
   → Settings → register → verify `GET /api/push/devices` lists the token.
6. **Smoke** — assign a task, mark it done at `plan` autonomy: outbox row →
   next forwarder tick → relay → phone banner within ~60s; tap deep-links to
   the task. Then `TestFlight`: switch `APNS_ENV=production` before inviting
   external testers (TestFlight uses production APNs).

## Tests

- `tests/test_push_pipeline.py` — routes (register/re-own/revoke/auth gates),
  the hook on all three transitions and its negative space (full-autonomy
  done, non-plan messages, agent-targeted requests, no-devices dormancy,
  broken-hook resilience), box lane (claim/mark/revoke, 48h prune, browser-
  identity 403).
- `tests/test_push_relay.py` — provider JWT shape + signature, signer cache,
  dormant 503 + healthz, bearer auth, per-event classification through a mock
  APNs transport (no real APNs traffic).
- `tests/test_push_forwarder.py` — tick harness over a scripted wire: flatten,
  bearer, mark semantics, Unregistered revocation, dormant/503/empty paths.
