# Android flavors + parity plan — mobile open-core strategy

**Status:** proposed · mirrors the iOS capability-negotiation + thin-flavor approach
**Scope:** PLAN ONLY — no Android code changes in this doc or its authoring worktree.

## 1. Current state

### What upstream Android has

Single module at `android/app/src/main/java/io/openorcha/mobile/`, one `applicationId`
(`io.openorcha.mobile`), Jetpack Compose + Kotlin, min/target/compileSdk 26/35/35,
Ktor client over OkHttp, kotlinx.serialization. No product flavors — one build.

Feature surface (from the screen inventory):

- Containers/workspaces list, workspace home/agents/tasks/requests tabs
  (`WorkspaceScreen.kt` + `WorkspaceHomeTab.kt`/`WorkspaceAgentsTab.kt`/etc.)
- Task lifecycle: create, thread view, close, priority selector
  (`CreateTaskScreen.kt`, `TaskThreadScreen.kt`, `TaskCloseDialog.kt`)
- Agent detail + model picker + auto-wake sheet
- Requests: detail, convert, text sheet, approval sheets
- Runs: run row/detail, conversation screen + turn bubbles
- QR pairing via CameraX + ML Kit barcode scanning (`ScannerScreen.kt`) — build already
  ships `camera-core/camera2/lifecycle/view` + `com.google.mlkit:barcode-scanning`
- Manual connect screen (paste a URL instead of scanning)
- Settings screen
- Task-reference linkification in prose (`LinkifiedText.kt`) — tappable references,
  not full Markdown rendering

The upstream README (`android/README.md`) is explicit that this is a deliberately
narrow first slice: "read-only," using only endpoints that exist in the running
`/openapi.json`, with QR pairing/auth/write actions gated on the server exposing
those contracts first. `OrchaApiClient`/`OrchaHttpClient`/`OrchaJsonTransport` do
now issue writes (that's what issue #198 breaks — see below), so the app has moved
past pure read-only, but there's no capability negotiation, no push, no flavors.

`AndroidManifest.xml` requests only `INTERNET` and optional `CAMERA` — no
`POST_NOTIFICATIONS`, no Firebase/FCM dependency anywhere in `build.gradle.kts`.
Confirmed by grep: zero push/notification/FCM/Firebase code in the module.

### The #198 compile break

[open-orcha/orcha#198](https://github.com/open-orcha/orcha/issues/198) — "Android
module does not compile since PR #191... and CI never builds Android." Root cause,
per the issue:

- `OrchaHttpClient.kt:36-55` defines `OrchaJsonTransport`, an `internal class` whose
  `post`/`patch` are `suspend inline fun <reified T, reified R>` bodies that read
  `private val client: HttpClient`.
- Pre-#191, these were `private suspend inline fun` *inside* `OrchaApiClient`,
  reading that same class's own private field — legal, because a `private` inline
  function may access private members of its own class.
- #191 moved the bodies onto the new `OrchaJsonTransport` class as effectively
  internal (non-private) inline functions, but left the field `private` and added
  no `@PublishedApi` annotation. Kotlin forbids a non-private inline function from
  touching a private member (`NON_PUBLIC_CALL_FROM_PUBLIC_INLINE`) because the body
  gets inlined at call sites outside the declaring class.
- **Result:** `./gradlew assembleDebug` fails on every Orcha write call (post/patch)
  — the app does not build from that commit forward.
- **Why CI didn't catch it:** `.github/workflows/build-check.yml` and `test.yml`
  contain zero references to `android`/`gradle` (confirmed directly in this repo's
  workflow files — the only CI job is a Python sdist/wheel/twine smoke test). The
  Android module has never been compiled in CI, so a build-breaking refactor merged
  silently.
- Fix options the issue lists: make the field `internal` + `@PublishedApi`; make
  `post`/`patch` non-inline with explicit `TypeInfo` bodies; or keep the functions
  `private` inside the one class that uses them. A minor, unrelated cosmetic
  regression (lost 12dp spacing on the Create Task priority header) shipped in the
  same slice.

This is a **blocking prerequisite**, not parity backlog — nothing else in this plan
should land on top of a branch that doesn't compile.

### Feature gap vs iOS

The iOS app (native SwiftUI, `orcha-sdkios-wt/ios`) has several screens/subsystems
with no Android counterpart:

| iOS has | Android has | Gap |
|---|---|---|
| `DiffViewer.swift` | task-reference linkification only | No code/diff rendering — Android shows plain(ish) text, not a real diff view |
| `ChatMarkdownView.swift` | plain text + linkified refs | No Markdown rendering in conversation turns |
| `SearchTabView.swift` | — | No cross-workspace search |
| `ReviewerPickerSheet.swift` | — | No reviewer-assignment UI |
| `ConnectRepoSheet.swift` | — | No in-app repo-connect flow (Android's pairing is QR/manual-URL only, no repo linking) |
| `NotificationManager.swift` + APNs pipeline (`docs/push-notifications.md`) | nothing (no permission, no dependency, no code) | No push, no local background-refresh notification sweep either |
| `PairingScreens.swift` | `ScannerScreen.kt` + `ManualConnectScreen.kt` | Roughly at parity — both have QR + manual |

Screens that are roughly at parity: containers/workspace home, agents, tasks,
requests, run detail/conversation, settings, create-task flow, approval sheets.

Net: Android's CRUD/workspace-management surface is close to iOS; the gaps cluster
around **rich content rendering** (diff, Markdown), **discovery** (search), and
**push/background notification** entirely.

## 2. Strategy mirror: one codebase, thin flavors

Same shape as the iOS plan: one upstream codebase, cloud-only concerns confined to
build configuration and a small relay-integration surface, not forked logic.

**Gradle `productFlavors`:**

```kotlin
android {
    flavorDimensions += "distribution"
    productFlavors {
        create("oss") {
            dimension = "distribution"
            applicationId = "io.openorcha.mobile"
            // default/no-op push: no google-services.json, no FCM dependency active
        }
        create("cloud") {
            dimension = "distribution"
            applicationId = "io.openorcha.mobile.cloud"   // distinct App ID for Play + FCM project
            // branding resource overrides (app name, icon, palette accents) via
            // flavor-specific res/ source sets: app/src/cloud/res/...
            // FCM enabled: google-services plugin applied only for this flavor
        }
    }
}
```

Flavor-specific source sets (`app/src/oss/...`, `app/src/cloud/...`) hold exactly:
applicationId, signing config reference, `google-services.json` (cloud only),
launcher icon / app name / accent color resources, and the FCM registration
call-site (a one-file `PushRegistrar` implementation per flavor — `oss` is a no-op,
`cloud` calls Firebase). Everything else — every screen, ViewModel, the API client,
domain selectors — stays in `app/src/main/` and is identical across flavors. This
is the same "flavors differ only in bundle id/entitlements/branding" rule the iOS
plan uses, translated to Gradle's flavor mechanism (Android's nearest equivalent to
Xcode's per-target entitlements + build settings).

Signing: `oss` uses whatever debug/release keystore upstream contributors already
use for local builds; `cloud` uses a dedicated release keystore held by the cloud
side (Play Console requires a stable signing identity across releases — never
shared with the oss flavor's key).

**Capability negotiation — identical to iOS:**

Same endpoint, same client-side rule set, no Android-specific variant:

- On connecting to a box, `GET /api/capabilities`.
- Fields present and truthy → feature enabled (e.g. `push`, future capability
  flags). Fields absent (older self-host box that predates the endpoint's growth)
  → treat as **not supported**, degrade gracefully, no error surfaced.
- The endpoint itself missing entirely (`404`) → treat as **full self-host feature
  set** (the box predates `/api/capabilities` outright but is a normal, complete
  self-host install) — never treat 404 as "nothing is supported." This is the same
  404-means-full-set rule the iOS side uses; Android must not diverge on this
  specific case since it's the difference between "old box, everything works" and
  "old box, spuriously degraded UI."
- This one negotiation replaces any Android-specific feature-detection hacks
  (version sniffing, endpoint-probing). Both native clients read the same contract.

## 3. Push: FCM relay design mirroring the APNs pipeline

Mirrors `docs/push-notifications.md` section-for-section. The **design rule
carries over unchanged**: customer/BYOC boxes never hold a push signing credential
— for FCM that means boxes never hold the Firebase service-account JSON.

| APNs (iOS, existing) | FCM (Android, planned) |
|---|---|
| Central relay holds `.p8` APNs auth key, signs ES256 provider JWT | Central relay holds the **FCM service-account JSON** (Google's HTTP v1 API uses OAuth2 access tokens minted from the service account, not a per-message signature — same "boxes never hold the credential" shape, different mechanics) |
| `deploy/push-relay/` — `POST /relay/push`, per-box bearer `RELAY_TOKEN` | Same relay service, same endpoint contract, extended to accept a `platform` discriminator (`ios`/`android`) per event so one relay serves both, OR a sibling route `/relay/push/fcm` if keeping wire formats separate is cleaner — decide at implementation time, not in this doc |
| `deploy/push-forwarder.py` timer, box-side, dormant without `RELAY_URL`/`RELAY_TOKEN` | **Unchanged conceptually** — the forwarder already claims/marks generic `push_outbox` rows and POSTs to the relay; it does not need to know iOS vs Android, only that a device row has a `platform` value the relay understands |
| `push_devices` registry (mig 041), `POST/GET/DELETE /api/push/devices` with `platform?='ios'` | **Already platform-parameterized** — the existing schema takes `platform`, so Android device registration is `POST /api/push/devices {"apns_token": "<fcm-token>", "platform": "android"}` against the SAME endpoint. Field name `apns_token` is iOS-legacy naming; either accept FCM tokens under that field as-is (cheapest, zero backend schema change) or add a neutral alias — a backend-side call, not an Android-side one |
| `push_outbox.py` hook on 3 needs-you transitions | **Unchanged** — the hook already writes generic outbox rows; it has no iOS-specific logic today |
| iOS: `PushDelegate.swift`, `registerForRemoteNotifications()`, entitlement gate | Android: `PushRegistrar` (cloud flavor only) calls Firebase's `FirebaseMessaging.getInstance().token` on foreground when (a) notification permission granted (Android 13+ runtime `POST_NOTIFICATIONS`) AND (b) at least one paired cloud container exists — same two-part gate as iOS's "permission × paired-cloud-container" rule |
| Payload: `{"aps": {...}, "cid", "kind", "id"}` | FCM payload: `{"notification": {"title", "body"}, "data": {"cid", "kind", "id"}}` — same `cid`/`kind`/`id` triple for deep-link routing, so the existing tap-routing logic pattern (`kind == "request" ? request(id) : task(id)`) ports directly |
| Dormant contract: missing `APNS_*` env → relay answers 503 | Same contract for FCM: missing service-account env → relay answers 503 on the FCM path specifically (independent dormancy per platform — APNs can be live while FCM is still dormant, or vice versa) |

**What's cloud-flavor-only:**

- The `PushRegistrar` Firebase implementation, `google-services.json`, and the FCM
  Gradle plugin/dependency (`com.google.gms:google-services`,
  `com.google.firebase:firebase-messaging`) — none of this ships in the `oss`
  flavor's APK. An oss build has no Firebase SDK linked at all, matching iOS's
  "free-team build never gets the aps-environment entitlement" pattern: the
  capability is architecturally absent, not just turned off.
- The relay's FCM credential and OAuth token-minting logic (relay is centrally
  operated regardless of platform — same as APNs).
- Any Play Store listing/release-track config.

Self-host (`oss`) Android users get exactly what self-host iOS users get today
without a paid Apple team: no remote push. Unlike iOS, Android has no existing
local-notification fallback (no BGAppRefresh equivalent implemented yet) — that
gap is called out explicitly in the parity backlog below since it's the
lowest-effort partial substitute and iOS already proves the pattern.

## 4. Sequencing with effort ballparks

Ordered; each step assumes the previous is merged. Ballparks are rough
engineering-days for one contributor familiar with the codebase, not calendar time.

**(a) Fix upstream #198 first — upstream PR.** *(~0.5–1 day)*
Smallest of the three fix options from the issue (make the field `internal` +
`@PublishedApi`, or de-inline `post`/`patch` with explicit `TypeInfo`) plus a CI
compile-check job (`assembleDebug` on JDK 17, matching the README's build steps) so
this class of break can't merge silently again. Must land and be verified green in
CI before anything below starts — every later task assumes a compiling base.

**(b) Parity backlog, ordered by user value** *(~2–3 weeks total, sequenced
independently — any subset can ship without the others)*:

1. **Markdown rendering in conversation turns** *(~2-3 days)* — highest value,
   lowest risk: conversation turns currently render closer to plain text than
   iOS's `ChatMarkdownView`. A Compose Markdown renderer (e.g. `compose-markdown`
   or a hand-rolled subset covering code fences/bold/lists, matching whatever
   subset iOS actually renders) unblocks readable agent output.
2. **Diff viewer** *(~3-5 days)* — code-review is a core Orcha workflow; Android
   users currently can't see a real diff for a task/PR the way iOS's
   `DiffViewer.swift` shows one. Port the visual design (unified or side-by-side,
   whichever iOS ships), not the Swift code.
3. **Local background-refresh notification sweep** *(~2-3 days)* — Android
   equivalent of iOS's BGAppRefresh needs-you sweep (`NotificationManager.swift`).
   Ships independently of FCM and gives self-host Android users the same
   "opportunistic, within the hour" fallback self-host iOS users have today.
   Natural precursor to FCM since it establishes the local notification
   posting/permission code FCM will reuse.
4. **Search tab** *(~2-4 days)* — cross-workspace search parity with
   `SearchTabView.swift`. Depends on whatever search endpoint(s) iOS's version
   calls; if that's already a generic API, this is mostly UI.
5. **Reviewer picker + connect-repo sheet** *(~2-3 days combined)* — smaller,
   more self-contained UI additions; lower priority than the above since they
   affect a narrower slice of workflows (PR review assignment, initial repo
   linking) that many users touch less often than reading conversations/diffs.

**(c) Flavor split (`oss`/`cloud` productFlavors)** *(~2-3 days)*
Introduce the flavor dimension, move applicationId/signing/branding into flavor
source sets, wire capability negotiation (`GET /api/capabilities`, same
graceful-absence + 404-full-set rules as section 2). Do this **after** the parity
backlog (or at least after markdown+diff+local-sweep) so the flavor split doesn't
have to be re-touched every time a parity feature lands — cheaper to fork the
build config once against a feature-complete-enough base than twice.

**(d) FCM relay** *(~3-5 days, split cloud-relay-side vs box-side vs app-side)*
Extend the existing relay for FCM (credential handling, HTTP v1 API calls,
platform discriminator), confirm `push_devices`/`push_outbox`/forwarder need zero
or near-zero changes (per the "unchanged conceptually" mapping in section 3),
implement `PushRegistrar` in the cloud flavor. Requires (c) to exist first since
FCM code must be cloud-flavor-scoped.

**(e) Play Store ship of the cloud flavor** *(~1-2 days engineering + external
review latency, which is unpredictable — Play Console review can take hours to
days)*
Play Console listing, release track (internal → closed → production), Play App
Signing enrollment, privacy policy / data-safety form (push tokens = "app
functionality" data collection, declare accordingly). Purely cloud-side; the oss
flavor is never submitted to Play (self-host users sideload or build from source,
matching how self-host iOS users use it today without TestFlight/App Store).

**Explicit "not now" list:**
- Widgets (iOS doesn't have a shipped widget target in the current worktree either
  — no cross-platform pressure to build one now)
- Any Android-specific feature iOS lacks (keep the two clients in lockstep;
  don't let Android grow capabilities iOS doesn't have first)
- Multi-account / multi-tenant switching beyond today's multi-container pairing
- Tablet/foldable-optimized layouts
- Wear OS companion
- Any auth mechanism beyond the existing device-token pairing flow
- F-Droid / alternate-store distribution of the oss flavor (plain sideload/
  build-from-source is sufficient until there's explicit demand)

## 5. Maintenance model

**Lives upstream (open-orcha/orcha, `android/` module):** everything except
signing, branding, and relay config — i.e. all screens, ViewModels, domain
selectors, the API client/transport layer, the `oss` flavor definition itself
(flavors are a build-config concept that belongs in the shared module so both
flavors stay mechanically in sync), markdown/diff rendering, search, the local
notification sweep, and the `PushRegistrar` **interface** (cloud provides the
Firebase implementation, but the interface and the no-op `oss` implementation are
upstream so the shared code compiles either way).

**Lives cloud-side (orcha-cloud):** the `cloud` flavor's `google-services.json`,
release keystore, Play Console configuration/listing, the FCM relay's service
account credential and deployment, and the cloud flavor's branding resource
overrides (icon/name/accent — actual asset files, not the mechanism for applying
them). This matches the SDK plan's existing "what's already SDK-shaped" framing
(`docs/open-core-sdk-plan.md`): deploy/signing/credential concerns are zero-coupling
shell around a shared core, same as `deploy/` is today for the server.

**CI needs:**
- The #198 fix's compile-check job (`assembleDebug`, JDK 17) becomes a required
  status check on `open-orcha/orcha` PRs touching `android/**` — mirrors how
  `build-check.yml` already gates the Python package, and should run unit tests
  too (`:app:testDebugUnitTest`, which already exists as a documented build step
  in `android/README.md` but — like `assembleDebug` — currently runs nowhere in
  CI).
- Once the flavor split lands, CI compiles both flavors
  (`assembleOssDebug`/`assembleCloudDebug` or equivalent) so a change that
  compiles for `oss` but not `cloud` (or vice versa) can't merge — this is the
  Android analogue of the iOS "flavors must both build" gate the parallel iOS plan
  presumably adds.
- The cloud flavor's `google-services.json` must never be required for the
  upstream/oss CI job to pass — oss CI should not depend on any cloud secret.
  Cloud-flavor compile checks that need real Firebase config run in
  orcha-cloud's own CI (or with a checked-in dummy `google-services.json` upstream
  solely to prove the cloud flavor *compiles*, never a real one).
