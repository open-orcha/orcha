# Android four-fixes plan (task 54c0b415)

Fixes four issues Kedar reported on the Orcha Android app. **Web portal is the parity
reference; `/openapi.json` is the only API contract. All changes are app-only (under
`android/`); zero server changes.** Every root cause below was reproduced live on an
emulator (Pixel 7 Pro API 34) against a running Orcha on 2026-07-02 and confirmed in code.

Line references: portal = `orcha-cli/orcha_cli/templates/portal/static/`,
app = `android/app/src/main/java/io/openorcha/mobile/`.

---

## Issue 1 — Requests screen: filtering/sorting + question-mark icons

### Confirmed root causes
**(a) Only agent→you shows.** `MobileUx.requestGroups` (`domain/MobileUx.kt:39-56`) hard-filters
the snapshot's requests to rows where the human is requester or target, silently dropping all
agent↔agent requests (the bulk of traffic). There are no filter chips and no sort control.
The web requests page (`requests.html:88-99`) shows ALL container requests with five
client-side filter chips — **All / Open / Answered / Escalations / Task reqs** — plus a
sort control (`requests.html:112-120`, `app.js:1600-1673`): keys **Time | Priority** with an
asc/desc toggle, applied inside a fixed outer status bucket `open → answered → everything else`.

**(b) "?" icons.** `RequestDto` maps `requester_alias`/`target_alias`
(`data/OrchaDtos.kt:188,190`) — fields the server never emits (snapshot SELECT in portal
`main.py:2492-2510` ships only `requester_id`/`target_id`/`owner_alias`). Both are always
null, and every render site falls back to `Avatar(alias ?: "?")`
(`ui/screens/WorkspaceScreen.kt:576-586`, `ui/screens/RequestScreens.kt:136-142`), which
draws the literal `?` tile. The web instead resolves aliases client-side from the snapshot's
`agents[]` (`data.js:118-119`). Not a font/icon-resource problem.

### Fix
1. **Show all requests with web-parity chips + sort.** Feed RequestsTab from the full
   `snapshot.requests` (no involvement filter). Add the web's five single-select chips —
   All / Open / Answered / Escalations (`targetId == null && status == "open"`) / Task reqs
   (`type == "task"`) — and a Time|Priority + asc/desc sort control, sorting inside the web's
   status bucket (open → answered → rest), unchosen key as tiebreaker, priority ascending =
   higher priority first (mirror `app.js:1632-1648`). Default: time desc, like web.
   Chips/sort are client-side over the snapshot exactly as the web does (the windowed
   `GET /containers/{cid}/requests` endpoint has no `type`/escalation params, so server-side
   chips are impossible without inventing API surface — which we won't do).
   Keep a "Yours" affordance: the existing needs-you grouping stays available as the default
   chip-state ("All" still surfaces open-yours first via the status bucket; the Home
   needs-you queue is untouched).
2. **Alias resolution.** Add a selector (in `domain/OrchaSelectors.kt`) mapping
   `requesterId`/`targetId` → alias via `snapshot.agents`, `null` target → "human" (web
   `aliasFor` equivalent). Use it at the three render sites; avatars then show real initials,
   header text shows real names ("Informer → you"), no "?" anywhere.
3. **Status glyphs (web `STAT` map parity, `app.js:320-353`).** Replace the plain status text
   pill with icon+tint per state: open=warning-triangle, accepted=play, answered=check,
   rejected=X, converted_to_task=arrow, closed=neutral-dot, escalated(open, human-targeted)=X
   with danger tint. Request *type* stays a text tag (`task`/`info`) — that's what the web does.
4. **Pagination of this list** is Issue 4 (render cap 15 + Load more).

---

## Issue 2 — Chat keyboard gap

### Confirmed root cause (two stacked)
1. **Window pan + imePadding double-shift (primary).** `AndroidManifest.xml` declares no
   `windowSoftInputMode` → system heuristic resolves to pan for this Compose hierarchy: the
   whole window translates up ~IME-height. Simultaneously `Modifier.imePadding()`
   (`ui/screens/AgentScreens.kt:494`, `ui/screens/TaskScreens.kt:316`) pads the content by the
   IME height. The shifts add: composer floats a full keyboard-height above the keyboard and
   the top of the conversation is pushed off-screen. Reproduced exactly on emulator.
2. **Missing inset consumption (residual).** The chain is `.padding(padding).imePadding()`
   where `padding` (Scaffold default insets) already contains the nav-bar bottom inset, and
   plain `padding()` doesn't consume window insets — so `imePadding()` stacks a nav-bar-height
   extra gap. Canonical fix is `.padding(padding).consumeWindowInsets(padding).imePadding()`.

### Fix
1. `AndroidManifest.xml`: add `android:windowSoftInputMode="adjustResize"` on MainActivity.
2. `AgentScreens.kt:494` and `TaskScreens.kt:316`: insert `.consumeWindowInsets(padding)`
   between `.padding(padding)` and `.imePadding()`.
3. **Keep messages visible:** give TaskThreadScreen a `LazyListState` (it has none today) and
   on BOTH chat screens scroll to the last item when the IME opens (key a LaunchedEffect on
   `WindowInsets.isImeVisible` in addition to the existing message-count trigger at
   `AgentScreens.kt:463-466`). List stays top-anchored otherwise (no reverseLayout — smaller diff).
4. **Screens that pan rescues today and adjustResize would regress:** add `imePadding` to
   CreateTaskScreen (`CreateTaskScreen.kt:118`) and ManualConnectScreen
   (`HomeScreens.kt:266-285`). Bottom-sheet and dialog composers manage their own insets —
   audited, no change (RequestScreens sheets, plan/verify sheets, rename dialogs).

---

## Issue 3 — Live run-log stream

### Confirmed root cause
Right endpoint, wrong consumption model. The web opens `EventSource` on
`GET /api/agents/{aid}/runs/{run_id}/stream` (`app.js:1444-1468`; server emits
`text/event-stream`: per-line `data: {"seq":n,"line":"…"}`, heartbeat comments every 1s,
terminal `data: {"seq":n,"done":true,"status":…}`, 30-min cap → `status:"stream_timeout"`,
client dedups by monotonic `seq` and reopens on timeout). Android's
`getRunStreamText` (`data/OrchaApiClient.kt:118-120`) does `client.get(...).bodyAsText()` —
a buffered read of a response that, for a RUNNING run, never ends. The client's own global
`requestTimeoutMillis = 10_000` (`OrchaApiClient.kt:29-33`) kills it after ~10s and
`friendlyConnectionError` mislabels it as a connectivity failure. Reproduced: a live run
shows "No log lines yet." + "Could not reach Orcha at this address" while the portal streams
the same run fine. Finished runs happen to work (server closes immediately) — which is why
the screen looked functional in testing.

### Fix (same endpoint, incremental consumption; no new dependency)
1. **`OrchaApiClient`: add a streaming reader** returning `Flow<RunStreamEvent>` using Ktor
   `prepareGet(...) { timeout { requestTimeoutMillis = INFINITE; socketTimeoutMillis = INFINITE } }
   .execute { resp -> resp.bodyAsChannel() … readUTF8Line() loop }`. Per-request timeout
   override is load-bearing (global 10s cap stays for everything else). Parse only
   `data: `-prefixed lines into `{seq, line}` / `{seq, done, status}` (server never uses
   `event:`/`id:` fields; 1s heartbeat comments keep the socket alive). Sealed
   `RunStreamEvent { Line(seq, line), Done(seq, status) }`.
2. **`OrchaViewModel.refreshRunLog` → collector job.** If the run is `running`: cancel any
   prior job, collect the flow, append lines with the web's monotonic-`seq` guard, reopen on
   `done.status == "stream_timeout"`, mark run finished on any other `done` (then refresh run
   status). Cancel the job on back/route change. If NOT running: keep the existing one-shot
   fetch (works today). On stream failure: retry with backoff and show a neutral "log stream
   interrupted — retrying" row — never the Wi-Fi banner (reuse the `isDataShapeError`-style
   discrimination pattern from the plan_decision fix).
3. **UI:** `RunDetailScreen` (`TaskScreens.kt:392-474`) already renders `state.runLines`
   incrementally with pin-to-bottom — no structural change; cap retained lines at 400
   (web parity, `app.js:1284`).
4. Out of scope, unchanged: the workspace "Live updates unavailable — checking every 30s"
   snapshot-SSE banner is a separate listed follow-up; issue 3 is the run log only.

---

## Issue 4 — Pagination / lazy-loading

### Confirmed root cause
Web pattern: page-capped rendering with explicit **"Load more" buttons** (never infinite
scroll) — tasks 10/page (`tasks.html:190-191,250,272`), requests 15/page
(`requests.html:85-86,128,148`), conversation "Load earlier" reveal 10/+20
(`conversation.js:26-27,439-445`) with `after_seq` delta appends (`conversation.js:586`),
notifications keyset 20/page. Android: renders entire arrays with no cap; fetches the
container snapshot with NO `task_limit`/`request_limit` (up to 1000+1000 rows) on connect,
every 30s, after every action, and once per stored container on the home screen
(`probeContainers`, `ui/OrchaViewModel.kt:144-158`); fetches task threads UNBOUNDED
(`GET /api/tasks/{tid}/messages` with no `limit` → entire thread, re-fetched wholesale after
every post — `OrchaApiClient.kt:44-46`); conversation is a full-replace `?limit=80` fetch with
no `after_seq` delta. No list carries paging state; nothing watches scroll.

### Fix (web page sizes, web "Load more" affordance)
1. **Tasks tab:** render cap 10 + "Load more · N of M" row appended to the LazyColumn
   (`WorkspaceScreen.kt:435`), +10 per tap — the web's exact mechanism over the same
   snapshot data. Existing chips/search keep working (they filter before the cap; cap resets
   on filter change).
2. **Requests tab:** same with cap 15 (+15) (`WorkspaceScreen.kt:536`), composed with the
   Issue-1 chips/sort.
3. **Task thread (the one genuinely unbounded fetch):** use the endpoint's keyset paging —
   initial `GET /api/tasks/{tid}/messages?limit=20`, store `has_more/next_before/
   next_before_id`, "Load earlier" row at the TOP of the thread list re-calls with
   `before/before_id` and prepends. After posting, re-fetch only the newest page instead of
   the whole thread. (Web is unbounded here; this uses the contract's intended paging and is
   strictly better on mobile.)
4. **Conversation:** on refresh, delta-append via
   `GET /api/conversations/{conv_id}/turns?after_seq=<lastSeq>&limit=50` (web parity,
   `conversation.js:586`) instead of full-replace; keep initial `?limit=80` mount fetch. Add
   the web's "Load earlier" client-side reveal (show last 10, +20 per tap). No before-cursor
   exists on this endpoint (same limitation the web documents) — nothing more required.
5. **Snapshot slimming:** `probeContainers` (home cards need counts only) passes explicit
   small `?task_limit=&request_limit=` values; the workspace snapshot keeps server defaults
   (it feeds the capped lists — same payload the web polls).
6. **Runs lists:** pass explicit `limit=20` (documents the server default; already capped).

---

## Delivery

- **Branch/PR:** one branch off local `main` (which already carries the plan_decision parse
  fix `7e19f89`), one PR, commits grouped per issue for reviewability.
- **Order:** 2 (manifest+insets, smallest) → 1 (aliases+chips+sort) → 3 (SSE) → 4 (paging).
- **Tests** (`:app:testDebugUnitTest`, existing 23 stay green; JDK 21 via Android Studio JBR):
  - Issue 1: selector unit tests (alias resolution incl. null→human; chip predicates;
    bucket+key+dir sort ordering vs web semantics).
  - Issue 3: SSE line-parser unit tests (data-line, done-frame, heartbeat/comment skip,
    seq-dedup, stream_timeout classification) against captured real frames.
  - Issue 4: paging-state reducer tests (cap/advance/reset; keyset prepend, no dup at seam;
    after_seq append).
  - Issue 2 is layout: verified on emulator (keyboard open/close on both chat screens +
    regression pass on create-task and manual-connect).
- **Emulator verification** of all four against the live stack, side-by-side with the web
  portal, before requesting PR review.
- Gate per task protocol: this plan → Code Reviewer until CLEAN → implement → PR → Code
  Reviewer until CLEAN → needs_verification → Kedar merges and does the on-phone check.
