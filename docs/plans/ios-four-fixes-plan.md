# iOS four-fixes plan (task 3fbd363b — GH #30 iOS track)

Checks the four issues Kedar reported on the Orcha **Android** app against the **iOS** app,
and fixes the ones that reproduce on iOS. **Web portal is the parity reference; `/openapi.json`
is the only API contract. All changes are app-only (under `ios/`); zero server changes.**

Grounding:
- Android sibling plan (web-portal line refs, reproduced live on emulator 2026-07-02):
  commit `b0f228f` `docs/plans/android-four-fixes-plan.md`. iOS is a 1:1 port of that
  Android app, so its root causes map directly — but each is re-checked in iOS code below,
  and Issue 2 (keyboard) is platform-specific and must be re-judged on iOS, not assumed.
- Live API confirmed against `http://localhost:8001/openapi.json` on 2026-07-02.
- iOS line refs: `ios/Orcha/…`. Web refs: `orcha-cli/orcha_cli/templates/portal/…`.

Summary of applicability on iOS:
- **Issue 1 (requests filter/sort + icons)** — **APPLIES** (same two root causes as Android).
- **Issue 2 (chat keyboard gap)** — **Android root cause is Android-only.** iOS uses native
  keyboard avoidance. Re-scoped to a *simulator-verified* parity check + a small
  consistency fix; may end up "does not apply" with evidence. See §2.
- **Issue 3 (live run-log stream)** — **APPLIES** (identical one-shot-read bug).
- **Issue 4 (pagination / lazy-load)** — **APPLIES** (identical unbounded-fetch pattern).

---

## Issue 1 — Requests screen: filtering/sorting + "?" icons — APPLIES

### Confirmed root causes on iOS
**(a) Only human-involved requests show; no chips, no sort.** `MobileUx.requestGroups`
(`ios/Orcha/Domain/MobileUx.swift:31-61`) filters the snapshot to rows where the human is
requester or target (`needs`/`waiting`/`answered`/`done` all gate on `humanId`), silently
dropping every agent↔agent request. `RequestsTabView` (`ios/Orcha/Screens/RequestsTabView.swift`)
renders only those four binding groups — no filter chips, no sort control. The web requests page
shows ALL container requests with five single-select chips (**All / Open / Answered /
Escalations / Task reqs**) plus a **Time | Priority** sort with an asc/desc toggle, applied
inside a fixed outer status bucket `open → answered → everything else`
(web `requests.html` filter chips + `app.js` sort; per Android plan §1).

**(b) "?" avatars.** `RequestDto.requesterAlias`/`targetAlias`
(`ios/Orcha/Data/Dtos.swift:218-220,255-257`) map server fields the snapshot never emits
(the snapshot SELECT ships `requester_id`/`target_id`/`owner_alias` only). Both are always
nil, so `RequestRowCard` (`RequestsTabView.swift:79-90`) falls back to
`AgentAvatar(alias: … ?? "?")` (a "?" tile) and header text `… ?? "agent"`. The web resolves
aliases client-side from the snapshot's `agents[]`. Not a font/asset problem.

**(c) Status shown as a text pill.** `StatusPill(status:domain:.request)` (text+tint). Web
uses a status pill too. Adding an icon+tint glyph is the one deliberate *mobile adaptation*,
matching what Android added.

> Web-parity note (confirmed in `portal/static/requests.html` + `app.js`): the web reads
> requests straight from the container snapshot (`D().requests`) and does ALL filter/sort/cap
> **client-side** — it does not call the windowed `/containers/{cid}/requests` endpoint.
> Request **type** is rendered as a plain text tag (`info`/`task`), **not** an icon — so the
> reported "icons" problem is the broken **"?" avatars** (root cause b), not a missing
> type-icon. The five chips and Time|Priority sort match §1 above exactly.

### Fix (client-side over the snapshot, exactly as web does — the windowed
`/containers/{cid}/requests` endpoint has no `type`/escalation params, so server-side chips
are impossible without inventing API surface, which we will not do)
1. **Alias resolution selector** in `MobileUx`: `aliasFor(id:in:)` mapping
   `requesterId`/`targetId` → alias via `snapshot.agents`; `nil` target → "human"
   (web `aliasFor` equivalent). Thread it into `RequestRowCard` and `RequestDetailScreen`
   so avatars show real initials and header text shows real names — no "?" anywhere.
2. **Show all requests + web-parity chips + sort.** Add a new selector
   `MobileUx.filterSortRequests(_:humanId:chip:sortKey:ascending:agents:)` and drive
   `RequestsTabView` from the full `snapshot.requests` when a chip is active. Chips:
   - **All** (no filter), **Open** (`status == "open"`), **Answered** (`status == "answered"`),
   - **Escalations** = web `isToHuman`: `targetId == nil` OR the resolved target agent's
     `kind == "human"` (NO status filter — mirrors web),
   - **Task reqs** (`type == "task"`).
   Sort keys **Time | Priority** with asc/desc, sorted inside the web status bucket
   (open → answered → rest), unchosen key as tiebreaker, priority ascending = higher priority
   first (mirror web). Default: **All**, time desc.
   Keep the existing four-group "needs-you-first" view as the default landing state (it is the
   design-package flow-07 contract and the Home needs-you queue depends on `requestGroups`,
   which stays untouched). The chips are an added lens over the same snapshot.
3. **Status glyph pill** (mobile adaptation, web `STAT` map parity): icon+tint per state —
   open=warning-triangle, accepted=play, answered=check, rejected=X, converted_to_task=arrow,
   closed=neutral-dot, escalated(open + human-targeted)=X danger-tint. Request *type* stays a
   text tag (`task`/`info`), as web does.
4. **Pagination of this list** is Issue 4 (render cap 15 + "Load more").

---

## Issue 2 — Chat keyboard gap — Android root cause is Android-only; iOS = verify + small consistency fix

### Why the Android root cause does not port
Android's bug was `windowSoftInputMode` (pan) + `Modifier.imePadding()` double-shift plus
nav-bar inset stacking — all Android-window mechanics with no iOS equivalent. iOS uses
SwiftUI's automatic keyboard avoidance.

### What iOS actually has (two chat surfaces, inconsistent)
- **TaskThreadScreen** (`ios/Orcha/Screens/TaskScreens.swift:337-465`) pins the composer with
  `.safeAreaInset(edge: .bottom) { composer }` — the idiomatic, keyboard-correct pattern
  (SwiftUI lifts the inset above the keyboard and shrinks the scroll area). Looks correct.
- **ConversationScreen** (`ios/Orcha/Screens/AgentScreens.swift:514-526`) puts the composer as
  the last child of a plain `VStack(spacing: 0)` — NOT a `safeAreaInset`. This relies on
  default focused-field avoidance and may push the top banner off or leave a gap.
- Neither screen scrolls to the last message when the keyboard *opens* (they only scroll on
  message/turn-count change + onAppear).

### Fix (empirical-first; do the smallest change the evidence justifies)
1. **Verify on the iOS Simulator** (iPhone 15, keyboard shown via hardware-keyboard toggle
   off) side-by-side with the web: open both chat screens, focus the field, confirm the
   composer sits directly above the keyboard with the last message visible and the
   conversation scrollable. Capture the result.
2. If a real gap/obscuring is observed on **ConversationScreen**: switch it to the same
   `.safeAreaInset(edge: .bottom) { composer }` pattern as TaskThreadScreen (make the
   transcript the main content). This is the one likely change.
3. If the last message is hidden behind the composer when the keyboard opens on either
   screen: key a scroll-to-bottom on keyboard appearance (observe the keyboard via a small
   `@State` toggled from `keyboardWillShow`/an `onReceive` of the keyboard notification, or
   the `isKeyboardVisible` environment) in addition to the existing count trigger.
4. If the simulator shows both screens already correct: **report Issue 2 as "does not apply
   on iOS"** with the simulator evidence, and make no code change (do not manufacture a diff).

This issue is layout-empirical; its resolution is decided by step 1, not by code reading.

---

## Issue 3 — Live run-log stream — APPLIES (identical bug)

### Confirmed root cause on iOS
Right endpoint, wrong consumption model — exactly Android's bug. `OrchaApiClient.runStreamText`
(`ios/Orcha/Data/OrchaApiClient.swift:66-69`) does a buffered one-shot
`session.data(from: /api/agents/{aid}/runs/{run_id}/stream)`, then `AppModel.loadRunLog`
(`ios/Orcha/App/AppModel.swift:256-266`) parses it once. For a **running** run the SSE
endpoint never ends, so the read blocks until the session's `timeoutIntervalForResource = 20`
(config at `OrchaApiClient.swift:11-13`) fires → throws → `friendly(error)` shows the Wi-Fi
banner ("Could not reach Orcha…", `AppModel.swift:475-483`). Finished runs happen to work
(server closes immediately), which is why the screen looked functional. The SSE contract
(confirmed in `portal/main.py`, web opens `EventSource`): per-line `data: {"seq":n,"line":"…"}`,
1s heartbeat comments, terminal `data: {"seq":n,"done":true,"status":…}`, 30-min cap →
`status:"stream_timeout"`; client dedups by monotonic `seq` and reopens on timeout.
`RunDetailScreen` (`TaskScreens.swift:471-590`) already renders `model.runLines` incrementally
with pin-to-bottom — the UI is ready; only the data path is wrong.

### Fix (same endpoint, incremental consumption; no new dependency)
1. **`OrchaApiClient`: add a streaming reader** `runStream(base:aid:runId:)` returning
   `AsyncThrowingStream<RunStreamEvent, Error>` (or an `AsyncStream` of parsed events) using
   `URLSession.bytes(for:)` + `for try await line in bytes.lines`. It must use a URLSession
   (or per-request) config WITHOUT the 10s/20s caps (those stay for every other call); a
   dedicated `URLSessionConfiguration` with infinite request/resource timeouts for streams.
   Parse only `data:`-prefixed lines into `RunStreamEvent.line(seq,text)` /
   `.done(seq,status)`; skip heartbeat comment lines (`:`-prefixed) and blank lines. Reuse
   the existing `parseSseLines` JSON shape logic (extended for `seq`/`done`).
2. **`AppModel`: streaming lifecycle.** Replace `loadRunLog` for **running** runs with a
   collector `Task` stored on the model: cancel any prior stream, append lines with a
   monotonic-`seq` guard, reopen on `done.status == "stream_timeout"`, mark the run finished
   on any other `done` (then refresh the run row). Cap retained `runLines` at **400**
   (web parity). On stream failure: retry with backoff and surface a neutral
   "log stream interrupted — retrying" row — **never** the Wi-Fi banner (discriminate the
   stream error from a real connectivity error, like the existing `friendly` mapping but
   stream-specific). For **finished** runs keep the current one-shot fetch (it works).
   Cancel the collector when leaving `RunDetailScreen` (`.task`/`.onDisappear`).
3. **UI:** `RunDetailScreen` unchanged structurally (already incremental + pin-to-bottom);
   `.task { }` starts the stream for running runs, `.onDisappear` cancels it.
4. **Out of scope:** the workspace "checking every 30s" snapshot polling is a separate listed
   follow-up; this issue is the run log only.

---

## Issue 4 — Pagination / lazy-loading — APPLIES (identical bug)

### Confirmed root cause on iOS
iOS renders whole snapshot arrays with no cap and fetches unbounded, exactly like Android:
- **Snapshot** `GET /api/containers/{cid}` fetched with NO `task_limit`/`request_limit`
  (`OrchaApiClient.swift:22-24`, `AppModel.refresh` `:187-205`, `probeContainers` `:165-183`,
  and the 30s poll `:207-216`) → up to 1000+1000 rows on connect, every 30s, after every
  action, and once per stored container on the home screen.
- **Task thread** `GET /api/tasks/{tid}/messages` with NO `limit` (`OrchaApiClient.swift:26-28`)
  → entire thread, re-fetched wholesale after every post (`AppModel.sendTaskMessage` →
  `loadTaskDetail`).
- **Conversation** `GET /api/agents/{aid}/conversation` full-replace, no `after_seq` delta
  (`OrchaApiClient.swift:62-64`, `AppModel.loadConversation` `:268-277`).
- Lists render via `ScrollView { VStack { ForEach } }` (Tasks/Requests tabs), no cap, no
  scroll paging state.

Endpoints confirmed to support paging (openapi 2026-07-02):
`/containers/{cid}` → `task_limit,request_limit`; `/containers/{cid}/requests` →
`limit,offset,agent,direction,status,sort,dir` (returns `{requests,total,has_more}`);
`/containers/{cid}/tasks` → `limit,offset,agent,status,unassigned,sort,dir`
(`{tasks,total,has_more}`); `/tasks/{tid}/messages` → `limit,before,before_id`
(returns `{messages (ASC), has_more, next_before, next_before_id}`, confirmed
`portal/main.py:5940-5941`); `/conversations/{conv_id}/turns` → `limit,after_seq`;
`/agents/{aid}/runs` and `/tasks/{tid}/runs` → `limit`.

### Fix (web page sizes, web "Load more" affordance — never infinite scroll)
1. **Tasks tab** (`TasksTabView.swift`): render cap **10** + a "Load more · N of M" row, +10
   per tap, over the same snapshot data (client-side, exactly web's mechanism). Chips/search
   filter before the cap; cap resets on filter/search change.
2. **Requests tab** (`RequestsTabView.swift`): same with cap **15** (+15), composed with the
   Issue-1 chips/sort.
3. **Task thread** (the one genuinely unbounded fetch): use the endpoint's keyset paging.
   > Divergence-from-web, matching Android's approved choice: the **web does NOT paginate
   > the task thread** — it lazy-fetches the whole thread once and renders it whole
   > (`portal/static/tasks.html` `maybeLoadThread`). Leaving it unbounded on mobile is the
   > actual bug (whole thread re-fetched after every post). Android's approved plan chose the
   > contract's intended keyset paging here as a deliberate mobile improvement; iOS matches
   > that for cross-platform consistency. This is the one intentional step beyond strict web
   > parity, and it uses only documented API params.
   Add `has_more`/`next_before`/`next_before_id` to `TaskMessagesResponse`
   (`Dtos.swift:294-296`) and a paged fetch to `OrchaApiClient.taskMessages(limit:before:before_id:)`.
   Initial `?limit=20`; store the cursor; a "Load earlier" row at the TOP re-calls with
   `before/before_id` and **prepends** (messages come back ASC — prepend the older page). After
   posting, re-fetch only the newest page (`?limit=20`) instead of the whole thread. Keep the
   auto-scroll-to-bottom behavior for new/sent messages; "Load earlier" must NOT jump to
   bottom.
4. **Conversation** (`AgentScreens.swift` / `AppModel.loadConversation`): initial mount
   `?limit=80`; on refresh, delta-append via `/conversations/{conv_id}/turns?after_seq=<lastSeq>&limit=50`
   (web parity) instead of full-replace. Add a web-style "Load earlier" client-side reveal
   (show last 10, +20 per tap) over the already-fetched turns. No before-cursor exists on this
   endpoint (same limitation web documents) — nothing more required.
5. **Snapshot slimming:** `probeContainers` (home cards need counts only) passes small
   explicit `?task_limit=&request_limit=` values; the workspace snapshot keeps server defaults
   (it feeds the capped lists — same payload the web polls). NOTE: home "needs you" counts are
   computed from the probe snapshot (`AppModel.probeContainers:171-177`); if a small
   task_limit/request_limit would undercount them, keep the probe unbounded OR use the
   dedicated count source — resolve during implementation and call it out to the reviewer.
6. **Runs lists** (`taskRuns`/`agentRuns`): pass explicit `limit=20` (documents the server
   default; already effectively capped).

---

## Delivery

- **Branch/PR:** one branch off `main`, one PR, commits grouped per issue for reviewability.
- **Order:** 1 (aliases + chips/sort + glyphs) → 3 (SSE streaming) → 4 (paging) → 2
  (verify-first; may be no-op). Issue 2 gates on simulator evidence.
- **Tests** (`ios/OrchaTests`, Swift Testing; existing `MobileUxTests` stay green):
  - Issue 1: selector tests — `aliasFor` (incl. `nil`→"human"); chip predicates
    (All/Open/Answered/Escalations=`isToHuman`/Task reqs); bucket + key + direction sort
    ordering vs web semantics.
  - Issue 3: SSE line-parser tests — data-line, done-frame, heartbeat/comment skip, seq
    dedup, `stream_timeout` classification — against captured real frames.
  - Issue 4: paging-state reducer tests — cap/advance/reset; keyset prepend with no dup at
    the seam; `after_seq` append.
  - Issue 2: layout — verified on the iOS Simulator (keyboard open/close on both chat
    screens), evidence recorded; no unit test.
- **Simulator verification** of all four against the live stack, side-by-side with the web
  portal, before requesting PR review.
- **Gate (task protocol):** this plan → Code Reviewer until CLEAN → implement → PR → Code
  Reviewer until CLEAN → needs_verification → Kedar merges and does the on-device check.
  Never self-certify.
