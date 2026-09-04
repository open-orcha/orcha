# React portal adoption — premium-delta audit

> ## Remediation status & priority order (2026-08-05, post-deploy)
>
> **Fixed & deployed (PR #113 + upstream):** the unstyled-open-class bug family
> (open `styles.css` now layers under the cloud skin as `styles/open-base.css`
> — giant sidebar logo etc.), the dark-flash on full-page navigations
> (pre-paint theme script), intrinsic brand-SVG sizes, and GitHub avatar
> thumbnails wherever the snapshot carries `github_login` (adapter passes it
> through upstream now).
>
> **P0 — correctness/identity (do next, mostly §A/§B):**
> 1. `/api/me` acting-identity layer (§A) — trusted non-members currently fall
>    through to the project's first human on mutations. Upstream-able seam:
>    an identity provider the open `actingHuman` consults when present.
> 2. Multi-project `?cid=` propagation on shell nav + page links (§B) — links
>    drop project scope on full loads. Land `withCid()` in the open shell.
> 3. Sign-out account menu (§C) — sessions can't be cleared from the UI.
> 4. Reviewer routing (§F) + `[object Object]` resultText normalization —
>    adapter field additions are the smallest highest-leverage upstream PR.
> **P1 — premium UX:** provider-keys card, pairing entry points (topbar +
> settings), appearance/skin settings section (needs the settings-section
> extension seam upstream), conversation honesty (`wakesServed`), sidebar
> authoritative counts, #64 autonomy-override UI (tripwire test in place).
> **P2 — polish:** skeletons/primed-shell nav cache, viewer read-only states,
> notification-center gh-avatar rows, misc §J long tail.

**Purpose.** The open-Orcha React base now vendored at
`orcha-cli/orcha_cli/templates/portal/frontend/src/**` replaces the cloud vanilla portal
(`orcha-cli/orcha_cli/templates/portal/static/**`). The open base was written for open Orcha
(single project, no GitHub identity, no members). This document is the exhaustive checklist of
every **cloud-only behavior on the shared surfaces** that the base lacks — the list that prevents
silent premium regressions during adoption. Each item names what it is, where it lived
(vanilla `file:line`, paths relative to `orcha-cli/orcha_cli/templates/portal/`), the
user-visible impact if it ships missing, and a suggested landing spot.

**Scope.** Shared surfaces only: the shell/chrome (`app.js`, `data.js`, `modules/app-*`),
Home, Tasks, Agents (incl. conversation), Requests, Settings, Onboarding. The cloud-only
pages (Projects, Metrics, GitHub hub, Device) are ports in their own right (`src/cloud/*`
stubs) and are out of scope here. `modules/settings-members.js` is already ported —
`frontend/src/cloud/members/MembersPage.tsx` at `/members` (see §J.24).

**Audited:** branch `feat/react-portal-base`, 2026-08-05. Vanilla side: all of
`static/{home,tasks,agents,requests,settings,onboarding}.html`, `static/{data,app}.js`,
`static/modules/*.js`, `static/pages/{home,tasks,agents,requests,github,metrics,projects}-*.js`.
React side: all of `frontend/src/{pages,shell,state,api,components,hooks,lib}`.

**Landing-spot legend**
- `extensions` — registerable today via `src/extensions.ts` (route or nav entry).
- `src/cloud` — a new cloud-owned component/module under `frontend/src/cloud/**`.
- `shared-file (upstream)` — requires editing a shared open-base file (`Shell.tsx`,
  `SnapshotProvider.tsx`, `api/client.ts`, `components/ui.tsx`, `pages/*`). Under the sync
  contract (`extensions.ts` header: copy `frontend/src/**` verbatim EXCEPT `extensions.ts`
  and `src/cloud/**`) these must either be **upstreamed to open Orcha** (preferred — most are
  bug-fixes or neutral seams open Orcha wants too) or the open base must grow an extension
  seam cloud can hook. Items marked this way are the sync-contract risk register.
- `upstream (bug)` — the React base contradicts already-fixed behavior; fix belongs in open
  Orcha regardless of cloud.

---

## Top 10 most user-visible deltas

1. **Trusted non-members inherit another human's acting identity** — no `/api/me` layer at all
   (§A.1–A.4). A signed-in GitHub user who is *not* a member acts as, and is attributed as,
   the project's first human. Attribution/security bug, not just a missing feature.
2. **No sign-out.** The acting-chip account menu (`/oauth2/sign_out`) doesn't exist; a cloud
   session can never be cleared from the UI (§A.6).
3. **Multi-project is functionally gone** — no project switcher, no New-project modal, no
   `?cid=` on any nav or deep link, no cid persistence/validation; every sidebar click can
   dump the user out of their project (§B.1–B.7).
4. **`[object Object]` at the verification gate** — `resultText()` JSONB normalization dropped;
   structured agent results render raw at the exact moment a human must judge them (§G.3).
5. **Reviewer routing fully absent** — no reviewer chip, no owner picker, no "review: login"
   de-emphasis on verify cards; the backend's resolved reviewer data is fetched and discarded
   by the adapter (§G.1, §F.2, §L.1).
6. **Provider keys card gone while model selection survives** — a user can select xAI/Grok
   for a use-case but has nowhere to put the key; four working endpoints unreachable (§J.1).
7. **Phone pairing entirely unreachable** — no topbar "Pair phone", no settings card, no
   pairing modal; the mobile app is orphaned, and the cloud-vs-local honesty copy
   ("through this Orcha's sign-in perimeter" vs "nothing goes through the cloud") is lost (§C.9).
8. **Conversation shows fake "thinking…" dots** for messages nothing will ever pick up (no
   `wakesServed` banner/branch on portal-only projects), plus the dup-send/lost-message
   composer regression (§H.5–H.7).
9. **Sidebar badges under-report and contradict their own pages** — `taskOpenTotal()` /
   `request_open_total` authoritative counts dropped; the exact fixed bug ("badge says 0,
   header says 62") is reintroduced (§C.5, §G.6, §I.4).
10. **Every navigation double-blanks** — primed-shell cache and the skeleton system are both
    gone, so on high-RTT cloud connections each page shows blank chrome + blank content for a
    full round-trip; read-only viewers additionally get live-looking buttons that silently
    403 (§E.1–E.2, §A.7).

---

## A. Identity & access model (collab v1, mig 039)

The entire identity layer has no React counterpart. Nothing in `frontend/src` calls
`GET /api/me`, and the snapshot adapter strips the identity fields (§L.1). The Members port
(`src/cloud/members/MembersPage.tsx`) carries a page-local copy of these helpers; the rest of
the app needs a shared one.

1. **`/api/me` identity fetch** — single-flight `GET /api/me?cid=…` per page load; stashes
   `identity` + `trusted`; the call is also what fires the server-side first-arrival binding
   rule (root-human → GitHub name).
   Lived: `static/data.js:212-244` (`fetchMe` at 221-230, applied 243-244).
   Impact: everything below has no data source; new members are never auto-bound.
   Land: `src/cloud` identity provider (e.g. `cloud/identity/IdentityProvider.tsx`) +
   eventually `shared-file (upstream)` so `SnapshotProvider` exposes a seam.
2. **`identity()/identityTrusted()/viewerOnly()/identityHuman()` accessors.**
   Lived: `modules/app-data.js:107-114`.
   Impact: cannot distinguish self-host (trust off) from "trusted proxy, no membership".
   Land: same identity module as A.1.
3. **`actingOwner()/actingGrant()/viewerRole()/actingReadOnly()`** (grants: owners hold all,
   members need the grant listed; viewer role = every write 403s).
   Lived: `modules/app-data.js:119-145`.
   Impact: owner-gated affordances (invite, role menus, reviewer picker, settings tabs) render
   for everyone or no one; viewers see enabled buttons that always fail.
   Land: identity module; page gating is then `shared-file (upstream — as a seam)`.
4. **Identity-first `actingHuman()` resolution** — when `identityTrusted()`, the resolved
   member (or **null**) is the *only* possible actor; a trusted non-member must never fall
   through to the local/default human.
   Lived: `modules/app-data.js:149-164` (the guard at 151-156). React
   `state/SnapshotProvider.tsx:145-155` implements only localStorage-pick + first-human.
   Impact: **security/attribution bug** — a signed-in non-member performs verify/approve/wake
   actions attributed to another person. Top-10 #1.
   Land: `shared-file (upstream)` — `actingHuman` needs an identity hook; until then the
   cloud identity provider must wrap/override it.
5. **Acting chip: GitHub avatar + login, viewer chip.** GitHub identity → `ghAvatar` + login;
   `viewerOnly()` → "viewer · not a member" chip; never another member's avatar.
   Lived: `modules/app-shell.js:78-97` (`actingChipHtml`); React `shell/Shell.tsx:419-424`
   renders letter tile + alias only, no `#actingChip` id.
   Impact: users see a generated tile with possibly someone else's alias; non-members get no
   signal they are viewing, not acting.
   Land: `shared-file (upstream seam)` — chip renderer override point.
6. **Account menu + sign-out** — chip opens `amFloat` menu (`login` header,
   `member_role · GitHub` subtitle, Sign out → `GET /oauth2/sign_out?rd=%2Fwelcome`, plain
   `<a>` on purpose; distinct "Not a member / viewing only" head for viewers).
   Lived: `modules/app-shell.js:99-135`.
   Impact: **no way to sign out of Orcha Cloud.** Top-10 #2.
   Land: `src/cloud` component slotted via a Shell seam (`shared-file (upstream seam)`).
7. **Viewer read-only banner** — `#viewerbar` under the topbar with two copies: viewer-role
   ("Your role here is viewer — read-only…") vs non-member ("You're viewing as a non-member —
   ask an owner for an invite to act."), toggled off `actingReadOnly()` every re-render.
   Lived: `modules/app-shell.js:137-161`.
   Impact: read-only users get zero explanation; they click, fail, and never learn why.
   Land: `shared-file (upstream seam)` / `src/cloud` banner component.
8. **Per-page read-only gating + role-accurate copy** — action buttons render
   `disabled title="Not a member of this project"` (vs "No acting human"), and `actorOrWarn`
   toasts matching copy:
   - Home approve/reject: `pages/home-state.js:118-119, 141-142, 170-185`
     (React `pages/home/HomePage.tsx:258-262, 359-365, 390-393` — one message, never disabled)
   - Tasks gate: `pages/tasks-detail.js:135-138`, `pages/tasks-actions.js:5-11`
     (React `pages/tasks/TasksPage.tsx:288, 295`)
   - Requests actions: `pages/requests-actions.js:63-69`
     (React `pages/requests/RequestsPage.tsx:210-214`)
   Impact: viewers everywhere get live-looking buttons that silently 403.
   Land: `shared-file (upstream)` — thread an optional identity/read-only context through the
   pages; the cheap open-safe form is a `useActingGate()` hook defaulting to today's behavior.
9. **GitHub faces everywhere (`ghAvatar`/`face`)** — humans with a `github_login` render their
   real GitHub avatar over the letter tile (onerror falls back).
   Lived: `modules/app-ui.js:15-36`; consumed in home feed (`pages/home-render.js:100`),
   agents roster/header (`pages/agents-state.js:132,141`, `pages/agents-detail.js:16`),
   requests rows/flow (`pages/requests-state.js:76-78,136`, `pages/requests-actions.js:20-22`).
   A React port exists at `frontend/src/cloud/projects/avatars.tsx` (untracked WIP) and a
   page-local `GhAvatar` in `cloud/members/MembersPage.tsx`, but nothing shared consumes one.
   Impact: no real human faces anywhere; teammates indistinguishable at a glance.
   Land: promote `cloud/projects/avatars.tsx` to `src/cloud/avatars.tsx`; `shared-file
   (upstream)` a `face` seam in `components/ui.tsx` so open pages pick it up when fields exist.

## B. Multi-project (`?cid=`)

1. **`resolveCid` 4-tier chain with validation + persistence** — `?cid=` → persisted
   `orcha:cid` → per-user `orcha:defaultCid` (mig 040) → active/first, each candidate
   validated against `/api/containers`; winner persisted.
   Lived: `static/data.js:153-195`. React `api/client.ts:153-162`: `?cid=` unvalidated, else
   active/first; no localStorage read or write.
   Impact: stale deep-links 404-loop the poll; project choice doesn't survive reload; the
   starred default project is ignored.
   Land: `shared-file (upstream)` — validation + a pluggable persistence hook are open-safe.
2. **`switchProject`/`persistCid`** — persist + full reload on
   `location.pathname?cid=…`, deliberately dropping stale `?task=/?req=` deep-links so page
   caches never leak across projects.
   Lived: `static/data.js:203-208`, exported `:305`.
   Impact: no way to change projects; a bolted-on switcher without the reload bleeds
   thread/run-stream caches between projects.
   Land: `src/cloud` (projects module) once B.1's persistence hook exists.
3. **Sidebar project switcher** — brand-area `.proj-switch` button (status dot + name +
   chevron); dropdown fetches `/api/containers` fresh on open; rows show status · N agents
   with a checkmark on current; plus **"All projects"** and **"＋ New project"** rows.
   Lived: `modules/app-shell.js:163-222` (`projSwitchHtml` 169-176, `projMenuHtml` 178-191,
   `openProjectMenu` 209-222), wired `:343-344`.
   Impact: multi-project customers can't see or switch projects in-app. Top-10 #3.
   Land: `src/cloud` component + `shared-file (upstream seam)` — Shell needs a brand-area slot.
4. **New-project modal + `POST /api/containers {additional:true}`** — name/desc form,
   "Portal-only until a host workspace is bound" copy, detail-bearing error toasts, arms the
   one-time `orcha:projNotice:<cid>` flag, then switches.
   Lived: `modules/app-shell.js:224-262`.
   Impact: no project creation from the portal; the new-project notice (F.5) can never arm.
   Land: `src/cloud` (projects module).
5. **`withCid()` on every nav/deep link** — brand link, all nav entries, Run feed, attention
   card, mini-bell, attn-pill; and every page-level link/`navigate` (Home
   `HomePage.tsx:366,394,402,498-499,512,578,603`; Tasks `TasksPage.tsx:141,753,1552,1744`;
   Agents `AgentsPage.tsx:141,171,215,391,718,737,818`; Requests
   `RequestsPage.tsx:102,122,205`; notification deeplinks `Shell.tsx:176-178,267-270`).
   Lived: `modules/app-shell.js:264-273`, applied `:282-338,363`.
   Impact: on a multi-project stack every click can land in the wrong project or bounce
   through the `/projects` landing — the exact bug the vanilla comment documents.
   Land: `shared-file (upstream)` — a `useHref`/link-wrapper seam (open no-ops it; cloud
   appends cid). This is the highest-leverage single seam to negotiate upstream.
6. **Bare-`/` landing redirect** — no `?cid=` + container count ≠ 1 →
   `location.replace("/projects")`.
   Lived: `pages/home-render.js:165-177`. (extensions.ts header notes "HomePage-side redirect
   for now" — not yet implemented anywhere in React.)
   Impact: multi-project users typing the root land on an arbitrary project.
   Land: `src/cloud` — a route-level guard registered via `extensions` (or a
   ProjectsPage-owned redirect), per the extensions.ts access-model note.
7. **`wakesServed()` / `last_wake_scan_at`** — "is a host-side daemon serving this project's
   wakes?" (2-minute window; mig 037).
   Lived: `modules/app-data.js:44-54`, fallback-stubbed `app.js:73`.
   Impact: portal-only projects look fully functional but never wake an agent, silently.
   Consumed by F.5 and H.5.
   Land: `shared-file (upstream)` — the helper is open-useful; the notice UI is `src/cloud`.

## C. Shell chrome

1. **Collapsible sidebar rail** — `orcha:sidebar` localStorage + `data-sidebar="collapsed"`
   on `<html>`, `#sbToggle` with aria state, prefs mirror, collapsed-rail mini-bell
   (`.attn-mini`) and nav `title` tooltips carrying counts (the only way to read counts when
   collapsed).
   Lived: `modules/app-shell.js:52-76` (toggle), `:310-318` (brand-row + button),
   `:338-340` (mini-bell), `:322` (titles). React Shell: none.
   Impact: layout preference gone; icon-rail users lose the whole affordance.
   Land: `shared-file (upstream)` — nothing cloud-specific except the prefs mirror (§D).
2. **Seamless-nav primed shell cache** — last sidebar/topbar markup cached per `(cid, page)`
   in `orcha:shellHtml:*`, restored synchronously at script load; re-wires only browser-local
   controls pre-data.
   Lived: `modules/app-shell.js:423-473`.
   Impact: every navigation shows blank chrome for a full RTT — specifically a cloud
   (remote-server) pain the cache was built for. Top-10 #10.
   Land: `shared-file (upstream)` — for the SPA the equivalent is caching the last snapshot
   (e.g. localStorage-seeded `SnapshotProvider`) rather than markup; either way it's a
   SnapshotProvider change.
3. **GitHub + Metrics nav entries: icons/idiom** — vanilla ships dedicated `github` and
   `metrics` glyphs and deliberately badge-less entries; cloud's `extensions.ts` currently
   registers `github → ico:"link"` and `metrics → ico:"live"` (wrong glyphs), plus a
   top-level "Projects" row (`ico:"home"`, duplicating Dashboard's icon) that vanilla never
   had (the hub is reached via the switcher).
   Lived: `modules/app-shell.js:294-301`; icon paths `modules/app-ui.js:77,82`.
   Impact: nav glyphs don't read as their destinations; duplicated home icon.
   Land: `extensions` (fix `extensions.ts` icons once C.4's icons exist) + decide
   Projects-row vs switcher idiom when B.3 lands.
4. **Eight missing icons** — `phone`, `alert`, `metrics`, `github`, `issueDot`, `pullArrow`,
   `ring`, `info`. React `Icon` renders unknown names as an **empty svg** (silent blank).
   Lived: `modules/app-ui.js:47-48,77,82,91-92,96,102`; React map `components/ui.tsx:13-45`.
   Land: `shared-file (upstream)` for generally-useful ones (`phone`, `alert`, `info`);
   `src/cloud` icon add-on for the GitHub-hub set — or upstream all eight (harmless).
5. **Authoritative open totals** — `taskOpenTotal()`/`requestOpenTotal()` read the
   server-computed `task_open_total`/`request_open_total` snapshot fields (full-table counts,
   not the capped window), with client fallback. React counts the windowed arrays and the
   Tasks badge counts `needs_verification` only (+ `attn` styling), the exact regression the
   vanilla comment documents.
   Lived: `modules/app-data.js:60-74`; badges `modules/app-shell.js:284-293`. React
   `shell/Shell.tsx:344-345`; fields absent from `types.ts` Snapshot and `api/client.ts:148`.
   Impact: badges under-report on big projects and contradict the page headers. Top-10 #9.
   Land: `upstream (bug)` — adapter + Shell + types fix belongs in open Orcha.
6. **Notifier vs Autonomy as two controls (GH #148)** — vanilla renders `#notifGroup`
   (power switch, `wakes_enabled`) and `#autGroup` (gearbox, `autonomy_level`) with a
   divider; level stays legible/editable while paused. React fuses them into one 4-rung
   radiogroup (rung 0 = Paused) — the pre-#148 design; toast/pausebar copy says "Autonomy"
   where vanilla says "Notifier".
   Lived: `modules/app-shell.js:352-392` (markup), `modules/app-autonomy.js:56-121`
   (painters), rationale `app-shell.js:475-485`. React `shell/Shell.tsx:38-149,429-431`.
   Impact: pausing reads as "autonomy level 0"; the level can't be pre-set while paused.
   Land: `upstream (bug/design)` — open Orcha wants #148 too.
7. **`autonomy_enforced` lock chip (mig 043)** — the "🔒 Enforced / Enforce" seg beside the
   level segs: `role="switch"`, danger-confirmed enable, POSTs `autonomy_enforced` through
   the same `/autonomy` endpoint, optimistic + revert.
   Lived: `modules/app-autonomy.js:34-36,96-115,209-250,272-274`; also in the fallback
   (`app.js:216-236`). React sends `{level, actor_agent_id}` only (`Shell.tsx:75-87`).
   Impact: owners can't enforce a container-wide autonomy ceiling over per-agent overrides —
   a governance control that matters most to multi-member cloud teams. Pairs with H.1.
   Land: `shared-file (upstream)`.
8. **Autonomy/notifier write robustness** — optimistic paint + revert-on-failure
   (`app-autonomy.js:185-203,260-283`), actor gate at *every* choke point incl. the pausebar
   Resume (`:142,164,182,210,227,258`), Enter/Space keyboard activation on every seg
   (`:80,119,135`), and the pausebar **"Resume ↩" button** (`:47-48`). React: await-then-
   refresh, gate only in `click()`, no key handlers/tabIndex, inert pausebar
   (`Shell.tsx:62-104,119-130,429-431`).
   Impact: laggy feedback, no revert on failure, keyboard-inaccessible controls, a paused
   banner that offers no way to resume.
   Land: `upstream (bug)`.
9. **Phone pairing — button + entire modal.** Topbar `#pairPhoneBtn` ("Pair phone"), and
   `modules/app-pairing.js:1-274`: cid-scoped `openPairingModal({cid,name})`, QR + base URL +
   manual short code + expiry countdown with auto-regenerate, "Pair as" picker (only when >1
   human), **trusted-lane rule** (the resolved GitHub member is the ONLY pairable human — no
   selector, server 403s mismatch), `choose_human` 400 chooser, structured warnings, and the
   **cloud-context copy branch** (`pairingCloudContext` :55-68 — HTTPS ⇒ "works from
   anywhere… through this Orcha's sign-in perimeter", never the self-host "nothing goes
   through the cloud" claim). Settings card: §J.5. Endpoint:
   `GET /api/containers/{cid}/pairing` (`app-pairing.js:149`).
   Lived: button `modules/app-shell.js:386-396`; modal `modules/app-pairing.js` (all).
   Impact: mobile app unreachable from the portal; and any partial port that lifts self-host
   copy would ship a false network claim on cloud. Top-10 #7.
   Land: `src/cloud/pairing` module + `shared-file (upstream seam)` for the topbar button
   slot (pairing itself is open-useful → candidate to upstream whole).
10. **Topbar two-line responsive layout** — `.tb-line-1`/`.tb-line-2` split that reflows to
    two balanced rows when narrow; React emits one flat row.
    Lived: `modules/app-shell.js:350-392`. Impact: overflow/squeeze on narrow viewports —
    worse for cloud, whose topbar carries more controls.
    Land: `shared-file (upstream)`.
11. **`rewriteGithubLinks()`** — portal-wide rewrite of `<a class="lnk">` links pointing at
    the **connected repo's** PRs/issues into the internal `/github?pr=N&cid=…` route, with a
    secondary "open on GitHub ↗" link and `stopPropagation` so clickable rows don't race.
    Lived: `modules/app-text.js:194-218`, exported `app.js:268`, pass-through fallback
    `app.js:76`. Consumed by Home feed, Tasks (result/plan/thread/notes), Requests
    (payload/answer/reason) — see §F.3, §G.2, §I.2.
    Impact: every agent-posted "see PR #42" bounces users out to github.com; the GitHub hub's
    main integration payoff is orphaned.
    Land: `src/cloud` helper + `shared-file (upstream seam)`: pages need a text-postprocess
    hook (open no-ops).
12. **Scroll/selection-preserving repaint discipline (`patch()`)** — `selectionWithin`
    (both range endpoints + intersectsNode), `inputActiveWithin` (defers while focused OR
    dirty-vs-defaultValue — GH #74), `snapScroll/restoreScroll` keyed on
    `[id]/[data-scrollkey]`.
    Lived: `modules/app-patch-log.js:27-108`. React: reconciliation covers "unchanged → no
    write" but nothing preserves nested scroll positions or defers repaints mid-selection
    across the 3s poll.
    Impact: reading position/selection disrupted every 3s on long lists — a class of bug
    React does not automatically solve.
    Land: `upstream (bug)` — audit each ported page for scroll keys; not a cloud-only port.
13. **Run controls: Stop-run flow + honest run cards** —
    Stop: acting-gated danger modal with graceful-stop copy, `POST /api/runs/{id}/stop`
    handling all three 200 shapes, instant relabel via `markStopRequested`, delegated
    document listener that survives repaints (`modules/app-run-stream.js:51-105,117-119`,
    `modules/app-sort.js:2`; also `app.js:250-265`).
    Run card chrome: status chip + exit code, the **#299 honesty split** (human stop renders
    "■ stopped", only genuine watchdog kills render "⚠ watchdog-killed" — `killCause`
    `:52,115`), wake-kind tag, live pulse, timing line, collapsible code-diff, and
    `wireSections()` collapsible log sections (`modules/app-run-stream.js:106-134`,
    `modules/app-patch-log.js:112-121`).
    React: `hooks/useRunStream.ts` returns flat log lines only.
    Impact: runaway runs can't be stopped; humans get blamed for watchdog kills (and vice
    versa); long run logs are an unbrowsable wall.
    Land: `upstream (bug/feature)` — all of this is open-relevant.
14. **Notification polish** — deeplinks as raw `<a href>` cause a full app reload under the
    router (`Shell.tsx:197`); `read_through_ts` cursor from load/mark-read responses is
    ignored (`Shell.tsx:221-259` vs `modules/app-notifications.js:142,167`); deeplinks carry
    no cid (covered by B.5).
    Land: `upstream (bug)`.
15. **Poll-failure discipline** — first consecutive failure retries silently, a persistent
    outage toasts exactly once, success re-arms (`static/data.js:250-265`). React sets
    `error` state on every failure (`SnapshotProvider.tsx:54-56`).
    Impact: routine cloud restarts/502s flap the error surface every 3s.
    Land: `upstream (bug)`.

## D. Per-user prefs & appearance (mig 040, skins)

1. **`OrchaPrefs` server sync** — `GET /api/prefs` once per load (null ⇒ module inert =
   pre-040 self-host behavior; non-null ⇒ **server wins**, applied to `<html>` + mirrored to
   localStorage); debounced full-bag `PUT /api/prefs` (`theme, skin, sidebar, default_cid` —
   omitting a key IS unsetting it); `setDefaultCid` star.
   Lived: `modules/app-prefs.js:31-105`, booted `static/data.js:239`. React: a faithful port
   exists at `frontend/src/cloud/projects/prefs.ts` but **nothing imports it**, and
   `Shell.tsx applyTheme` (23-26) never calls `queuePut`.
   Impact: theme/skin/sidebar/default-project stop following the user across devices.
   **Porting landmine:** any partial PUT silently wipes the user's other prefs server-side.
   Land: promote `cloud/projects/prefs.ts` to `src/cloud/prefs.ts`, wire `sync()` at boot and
   `queuePut()` from every cosmetic write (`shared-file (upstream seam)`: theme/sidebar
   writers need a post-write hook).
2. **Skin system** — three skins (classic/swiss/minimal), `applySkin` → `data-skin` on
   `<html>` + `orcha:skin` + prefs mirror; Appearance card UI is §J.3.
   Lived: `modules/settings-appearance.js:9-27`. React handles theme only.
   Impact: Swiss/Minimalist users are trapped: their stored skin still applies via nothing
   (see D.3) and there is no way to change it.
   Land: `src/cloud` (appearance module) + the pre-paint fix below.
3. **Pre-paint FOUC guard** — every vanilla page's `<head>` script reads `orcha:theme`,
   `orcha:skin`, `orcha:sidebar` and sets `data-*` plus matched inline colors before first
   paint (per-skin light/dark). React `frontend/index.html` hardcodes `data-theme="dark"`;
   `initTheme()` runs post-module-load; skin/sidebar never read.
   Lived: `static/home.html:14` (same in settings/onboarding/tasks/… `:14`).
   Impact: light-theme users get a dark flash, skinned users a classic flash, collapsed-
   sidebar users an expand-then-collapse — on every load, including onboarding (first
   impression).
   Land: `shared-file (upstream)` — index.html pre-paint script (open needs the theme half
   anyway).
4. **Speculation-rules constraint (carry-forward, not a port)** — vanilla prerender rules
   exclude `/device*` (GET mints a token) and `/oauth2/*` (hover must never sign out)
   (`static/onboarding.html:35-50`, `settings.html:33-48`). Moot for the SPA, but the
   exclusions encode hazards any future prefetch must respect.
   Land: doc note only (this file).

## E. Loading & perceived performance

1. **Skeleton system (`modules/app-skeleton.js:1-198`)** — `show(container, kind)` with
   120ms anti-flash delay, kinds `list-rows|roster|stat-cards|detail-pane`, `swap()`
   cross-fade honoring `prefers-reduced-motion`. Invoked on every page first-paint:
   Home `pages/home-render.js:144-155`; Tasks `pages/tasks-boot.js:68-87`; Agents
   `pages/agents-boot.js:53-69`; Requests `pages/requests-actions.js:149-164`.
   React: no equivalent; pages render blank until the first poll (`HomePage.tsx:433`,
   `RequestsPage.tsx:401-407` etc.).
   Impact: blank-then-pop on every navigation — the founder-reported lag returns. Top-10 #10.
   Land: `upstream (feature)` — open-useful; or `src/cloud` Skeleton components used by cloud
   pages while shared pages get it upstream.
2. **Primed shell cache** — see C.2 (same cluster: chrome side of the double-blank).

## F. Home / Dashboard

1. **GitHub repo chip + Connect-repo modal on the context card** — official `ghMarkSVG` chip
   linking to the bound repo, pencil → repo-picker modal (`GET /api/github/repos`,
   `PUT /api/containers/{cid}/github`), graceful "GitHub App isn't wired" state.
   Lived: `pages/home-github.js:8-145`, embedded `pages/home-state.js:24`. React
   `HomePage.tsx:441-444` renders name/desc only.
   Impact: repo binding invisible and unchangeable from the dashboard; two endpoints
   unreachable. Top-10 #5-adjacent (metrics/github cross-links cluster).
   Land: `src/cloud` component + `shared-file (upstream seam)` — HomePage context-card slot.
2. **Reviewer-aware verify cards** — a card whose assigned reviewer is someone else renders
   `other-review` + `review: <github_login|alias>` tag so members don't race reviews.
   Lived: `pages/home-state.js:125-135`. React `HomePage.tsx:373-399` has no branch (and no
   identity to compute it).
   Impact: reviewer routing invisible on the dashboard. Depends on §A + §L.1.
   Land: `shared-file (upstream seam)` after L.1.
3. **Markdown + GitHub-link rewriting in the queue/feed** — plan bodies through `mdText`
   (`pages/home-state.js:116`); activity previews `linkify` + `rewriteGithubLinks`, rows as
   `<div onclick>` so inner anchors work (`pages/home-render.js:91-99`). React: plan via
   `Linkified` only (`HomePage.tsx:356`); feed rows are whole-row `<a>` with **plain escaped
   text** (`:557-567`) — not even linkified.
   Impact: humans approve plans rendered as raw markdown; PR links in the feed dead or
   external-only.
   Land: `upstream (bug)` for mdText use; C.11 seam for the GH rewrite.
4. **Notifier stat mislabeled** — vanilla stat = `Notifier` Running/Paused
   (`pages/home-state.js:33`); React renders the same value labeled `Autonomy`
   (`HomePage.tsx:454`), asserting something false (level ≠ wakes).
   Land: `upstream (bug)`.
5. **Portal-only project notice** — dismissible warn card on a NEW project while
   `!wakesServed(c)` (armed via `orcha:projNotice:<cid>` from the New-project flow),
   self-clearing when a workspace binds.
   Lived: `pages/home-state.js:43-68`, mount `home.html:60-62`.
   Impact: users assign work to a project that silently never wakes. Depends on B.4/B.7.
   Land: `src/cloud` + Home slot seam.
6. **Faces in the feed** — §A.9. **cid on links** — §B.5. **Skeleton** — §E.1.

## G. Tasks

1. **Reviewer chip + owner-only picker** — detail-header `reviewer <face login>` (or
   "anyone"), pencil → member picker, `PUT /api/tasks/{tid}/reviewer {reviewer_agent_id,
   actor_agent_id}`, optimistic update, "routes attention, doesn't lock the gate" copy.
   Lived: `pages/tasks-detail.js:46,165-178`; `pages/tasks-actions.js:64-99`; wiring
   `pages/tasks-thread.js:84-85`. React `TasksPage.tsx:1686-1696`: status/priority/assignee
   only.
   Impact: the whole `assign_reviewers` feature disappears; endpoint unreachable; backend
   reviewer data discarded (§L.1). Top-10 #5.
   Land: `src/cloud` reviewer widget + `shared-file (upstream seam)` in the task detail
   header (open Orcha may want reviewers eventually → upstream candidate).
2. **`mdGh()` on every agent-authored surface** — `mdText` + `rewriteGithubLinks` on Result
   (`pages/tasks-detail.js:52`), gate plan/result body (`:145`), protocol Notes (`:208`),
   thread bubbles (`:286`; helper `:29`). React uses `Linkified` at
   `TasksPage.tsx:353,550,1713,233`.
   Impact: raw markdown + external-only PR links on the page where agents narrate work.
   Land: `upstream (bug)` (mdText) + C.11 seam (rewrite).
3. **`resultText()` JSONB normalization** — unwraps `{result|summary|text|message}` and
   pretty-prints other shapes.
   Lived: `pages/tasks-detail.js:3-20`, used `:52,145`. React interpolates `t.result` raw
   (`TasksPage.tsx:353,1713`).
   Impact: **`[object Object]` at the verification gate** — regression of a documented fix.
   Top-10 #4.
   Land: `upstream (bug)` — pure helper, belongs in `lib/format.ts`.
4. **Create-task protocol section** — collapsible Protocol block (review chain / hand-off /
   autonomy / notes) in the New Task modal; `protocol` attached to
   `POST /api/containers/{cid}/tasks` only when a field is set.
   Lived: `pages/tasks-actions.js:131-143,167-176`. React `NewTaskModal`
   (`TasksPage.tsx:1079-1246`) has no protocol fields.
   Impact: tasks can't be created with their hand-off protocol; extra post-create round trip.
   Land: `upstream (feature)` — protocol is an open concept (SPEC-4).
5. **#74 thread-fetch error latch + Retry** — failed/suspicious thread fetch latches (stops
   the 3s auto-retry) and renders "Couldn't load the thread. [Retry]"; failed refresh over
   cache renders a stale-banner variant.
   Lived: `pages/tasks-state.js:16,28-45`; `pages/tasks-detail.js:68-82`;
   `pages/tasks-thread.js:76-77`. React `TasksPage.tsx:1531-1547,786-790`: loading ref only —
   permanent "Loading thread…" + infinite 3s re-fetch on persistent failure.
   Land: `upstream (bug)`.
6. **Header count = `taskOpenTotal()`** — `pages/tasks-boot.js:80` (with the count-mismatch
   rationale); React `TasksPage.tsx:1604` uses `tasks.length` over the capped window.
   Land: `upstream (bug)` (with C.5).
7. **React-only additions to review during adoption** — "Pair in terminal" on the thread
   header and a live-lease composer lock (`TasksPage.tsx:747-764,668-669,821,843,850`) exist
   in React but not vanilla cloud. Intentional-or-not divergence: decide keep/drop
   explicitly.
   Land: decision item (likely keep — but verify against cloud terminal behavior).
8. **cid on links** — §B.5. **Skeleton** — §E.1. **Read-only gating** — §A.8.

## H. Agents & conversation

1. **Per-agent autonomy override (mig 043)** — 4-chip Inherit/Plan-only/PR/Full control,
   `PATCH /api/agents/{id} {autonomy_override}`, optimistic + revert, effective-autonomy
   description, enforced-container lock state; plus the roster `ovrBadge` (🔒 "override
   IGNORED" variant when the container enforces).
   Lived: `pages/agents-detail.js:60-61,105-110,244-287`; `pages/agents-controls.js:40-63`;
   roster `pages/agents-state.js:143,171-179`. React `AgentsPage.tsx:669-698`: wake +
   auto-wake only.
   Impact: an entire governance feature gone; can't see or set what autonomy an agent
   actually runs at. Pairs with C.7.
   Land: `shared-file (upstream)` — mig 043 is open-schema; feature belongs upstream.
2. **Reasoning-effort control** — Default/Low/Medium/High/Extra-high segs;
   `GET /api/reasoning-efforts` + `POST /api/agents/{id}/reasoning-effort`; optimistic +
   revert; snapshot field `reasoning_effort` (dropped by React adapter, §L.1).
   Lived: `pages/agents-state.js:63-76`; `pages/agents-detail.js:54-55,105-106`;
   `pages/agents-controls.js:97-125`; `static/data.js:57`.
   Impact: users can't tune worker effort; two endpoints unreachable.
   Land: `shared-file (upstream)`.
3. **This-browser live-terminal awareness** — `OrchaTerm.liveAgentIds()` wins over the read
   payload so a backgrounded live terminal in your own tab shows "live" (ISS-71).
   Lived: `pages/agents-state.js:136-166`. React `EmbodBadge` uses `leaseOf(a)` only
   (`AgentsPage.tsx:89-98`).
   Impact: roster shows idle for an agent you hold live; wake failures become inexplicable.
   Land: `upstream (bug)`.
4. **Seed model list drift** — vanilla seeds Opus 5 / Sonnet 5 / GPT-5.6 Sol|Terra|Luna
   (`pages/agents-state.js:47-58`); React seeds `claude-opus-4-8`/`claude-sonnet-4-6` only
   (`AgentsPage.tsx:45-53`).
   Impact: before `/api/models` resolves (or if it fails), wrong models render and current
   selections show unselected.
   Land: `upstream (bug)` — better: render from `/api/models` only, seed minimal.
5. **"No agent runtime yet" honesty in conversation** — persistent warn banner while
   `!convWakesServed()`, and the indicator renders "Message queued — this project has no
   agent runtime yet" instead of thinking dots.
   Lived: `modules/conversation-render.js:48-53,159-167`; `modules/conversation-state.js:
   97-103,130`; `modules/conversation-lifecycle.js:13`. React `Conversation.tsx:462-469`.
   Impact: fake "thinking…" for messages nothing will pick up — dishonest UI on portal-only
   cloud projects. Top-10 #8.
   Land: `src/cloud`-gated branch via B.7 helper + `shared-file (upstream seam)`.
6. **Cold-start honesty** — first-turn state labeled "starting…" + "the first reply can take
   a minute" note (`modules/conversation-render.js:65-72`); React always "thinking…"
   (`Conversation.tsx:470-485`).
   Land: `upstream (bug)`.
7. **Composer optimistic-send state machine** — `sending` re-entry guard (dup-send fix),
   optimistic pending bubble, failure → "not sent" + danger note + **Retry**, text and staged
   attachments restored, `reconcilePending` drops the local bubble when the durable copy
   arrives (covers "POST landed, response lost").
   Lived: `modules/conversation-composer.js:90-182`; `modules/conversation-render.js:78-91,
   250-264`; `modules/conversation-state.js:19-28`. React `Conversation.tsx:418-422,644`.
   Impact: dup-send regression; failed sends lose staged attachments silently; no retry.
   Land: `upstream (bug)`.
8. **Attachment upload mount-token race guard** — `ensureConv(tok)`/uploads pinned to a mount
   token so stale completions never write another agent's conversation
   (`modules/conversation-composer.js:6-20,48,56,64-65`). React relies on `key={a.id}`
   remount; in-flight promises can still resolve post-unmount
   (`Conversation.tsx:346-390`).
   Land: `upstream (bug)` — add an alive/token guard.
9. **Faces in roster/header** — §A.9. **cid on links** — §B.5. **Skeleton** — §E.1.
   Verified parity: memory digest, requests mini, tasks mini (`agents-detail.js:177-229` ↔
   `AgentsPage.tsx:477-525,139-157,706-803`).

## I. Requests

1. **Nudge action (#60)** — button on `open`/`answered`, modal with optional note,
   `POST /api/requests/{id}/nudge {actor_agent_id, note}`, reports "Nudged the <role>" vs
   "No agent to wake — a human owns the next action"; never changes state.
   Lived: `pages/requests-state.js:133`; `pages/requests-actions.js:105-115`. React
   `RequestsPage.tsx:296-314,354-373`: Answer/Convert/Escalate/Close only.
   Impact: stalled requests can't be nudged; endpoint unreachable.
   Land: `upstream (feature)` — nothing cloud-specific about nudge.
2. **`mdGh()` on payload/answer/rejection reason** — `pages/requests-actions.js:7,38-40`;
   React `RequestsPage.tsx:535,542,550` (`Linkified` only).
   Land: `upstream (bug)` + C.11 seam.
3. **Read-only toast copy** — §A.8 (requests instance).
4. **Open count = `requestOpenTotal()`** — `pages/requests-state.js:59`; React recomputes
   over the capped window (`RequestsPage.tsx:187`).
   Land: `upstream (bug)` (with C.5).
5. **Faces on rows/flow nodes** — §A.9. **cid on links** — §B.5. **Skeleton** — §E.1.

## J. Settings

React `SettingsPage.tsx` ships 2 of the vanilla 6 cards (Anthropic key + models — both
faithful, incl. the PR #315 human gate and draft preservation). Missing:

1. **Provider keys (BYO keys per non-Anthropic provider)** — the whole card + module: renders
   every catalog provider except anthropic, per-provider busy/test/draft isolation,
   draft-restore after Test, per-provider banners/placeholders/verdicts, empty state, error +
   Retry. Endpoints: `GET/PUT/DELETE /api/containers/{cid}/settings/provider-keys[/{provider}]`
   + `POST .../{provider}/test`.
   Lived: `static/settings.html:85-93`; `modules/settings-provider-keys.js:1-161`.
   Impact: **headline settings regression** — model selection ships but a use-case set to
   xAI/Grok has nowhere to put its key; stored non-Anthropic keys become invisible and
   unremovable. Four endpoints unreachable. Top-10 #6.
   Land: `shared-file (upstream)` — extend SettingsPage (provider keys are open-relevant);
   else `src/cloud` card pending a settings section-extension point.
2. **Settings tabs (Workspace/Collaboration/Appearance)** — segmented `.aut.set-tabs` nav
   (reusing the house pill idiom), `data-settab` per card, `#tab=` hash deep-links via
   `history.replaceState` + hashchange, Enter/Space + aria a11y, no-JS all-visible fallback.
   Lived: `static/settings.html:69-73`; `modules/settings-tabs.js:16-86`;
   `static/pages/settings.css:17-21`.
   Impact: once the missing cards return, one unnavigable scroll; deep links land wrong;
   keyboard/AT users lose section nav.
   Land: `shared-file (upstream)` (tab shell) — and this is the natural place to add the
   **settings section-extension point** cloud needs (see J.6).
3. **Appearance card (skin picker)** — `.skin-grid` tiles for classic/swiss/minimal with
   swatch strips, per-skin radius previews, active checkmark, toast; `applySkin` per §D.2.
   Lived: `static/settings.html:123-131`; `modules/settings-appearance.js:9-47`;
   `static/pages/settings.css:84-99`.
   Impact: shipped premium personalization silently deleted; users trapped on current skin.
   Land: `src/cloud` appearance card (skins are cloud premium) via the settings extension
   point.
4. **`manage_keys` gating of the Workspace tab** — hidden for a trusted identity lacking the
   grant; re-applied on a 3s interval because `/api/me` resolves after first paint (falls
   back to first visible tab).
   Lived: `modules/settings-tabs.js:23-51,84-85`. React renders key/model cards
   unconditionally.
   Impact: non-holders see dead affordances that always 403.
   Land: depends on §A; then `shared-file (upstream seam)`.
5. **Phone pairing card (Collaboration tab)** — `#pairingCard` banner + "Open pairing" button
   wired to `openPairingModal`, with the honest network hint (self-host copy hardcoded in the
   static hint; the modal is context-aware — see C.9's cloud-copy warning).
   Lived: `static/settings.html:115-121`; `modules/settings-key-panel.js:131-141`;
   `static/settings.js:207-213`.
   Land: with C.9's pairing module.
6. **Members card → standalone page (architectural note).** Vanilla: settings Collaboration
   tab card (`static/settings.html:105-113`; `modules/settings-members.js`; styles
   `static/pages/settings.css:101-123`). Ported: `frontend/src/cloud/members/MembersPage.tsx`
   at `/members` (route in `extensions.ts`), carrying the `.mem-*`/`.sc-*` styles in a
   page-scoped `<style>`. Until the open SettingsPage grows a section-extension point, the
   IA differs from vanilla (page, not tab) and `/members` has **no nav entry** — reachable
   only by URL. Follow-ups: (a) add a nav entry or settings cross-link via `extensions.ts`;
   (b) when a settings extension seam lands upstream, decide page-vs-section.
7. **Intro copy drift** — vanilla `settings.html:60-62` says "provider API keys" (plural);
   React names only Anthropic (`SettingsPage.tsx:779-783`). Restore with J.1.

Verified parity (no action): Anthropic key card three-state VM, env precedence, human gate
wording, retired-model injection, staged/dirty savebar, models card, and the pure-helper
export surface (`SettingsPage.tsx:119-207`).

## K. Onboarding

High-fidelity port (`logic.ts` reproduces the template, rails, SSE parse, roster
normalization, ERR copy verbatim; `pageCss.ts` covers every vanilla class; same
`orcha:onboarding` localStorage key so drafts carry across; endpoint parity complete:
`POST .../agents`, `POST .../tasks`, `GET /api/models`, `POST /api/onboarding/propose`).
Remaining deltas:

1. **Pre-paint theme/skin/sidebar script** — §D.3; worst on onboarding (first impression).
2. **Speculation-rules exclusions** — §D.4 (constraint note).
3. **Fragile-but-correct spots to not refactor away:** the SSE abort now lives in effect
   cleanup (`OnboardingPage.tsx:73-74,772`) — refactoring `StepProposeStream` to not unmount
   would leak the stream; `qp()`'s `window.location.search` fallback (`:91-94`) is
   load-bearing given the router-vs-comment mismatch (§N.4).
4. **No cloud/self-host welcome fork exists in either implementation** — checked
   `modules/onboarding-welcome-fork.js:1-88`: the fork is Path G/A/B only. Candidate does
   not reproduce; no action.

## L. Data layer / snapshot adapter

1. **Adapter strips identity + reviewer + effort fields.** Vanilla whitelists per agent
   `github_login`, `member_role` (`static/data.js:61-62`) and `reasoning_effort` (`:57`);
   per task `reviewer_agent_id` + resolved `reviewer` chip (`:97-98`); backend ships them
   (`portal_backend/task_list_query.py:16-22`). React `api/client.ts:80-119` and
   `types.ts` (`Agent` 16-30, `Task` 50-72) omit all of them, plus the
   `task_open_total`/`request_open_total` snapshot fields (§C.5).
   Impact: even fully-ported components would read `undefined` — this is the enabling fix
   for §A.9, §F.2, §G.1, §H.2.
   Land: `upstream` — additive optional fields are open-safe; smallest, highest-leverage PR
   of the whole audit.
2. **Slack-origin fields: nothing to port.** Checked: no Slack badge/field renders anywhere
   in the vanilla portal (only comments in `pages/github-render.js:97,120,300` noting that
   Slack-started runs show as tracked). Slack capture is backend/task-first by design; no
   portal delta exists.
3. **`recencyTs/recencyBand` orphaned** — ported to `lib/format.ts:37-46` but never wired
   into `lib/sort.tsx:41-56`'s comparator (vanilla slots the band between status and
   priority — ISS-83). Land: `upstream (bug)`.
4. **`threadOf(tid, agents)` signature** — callers must thread `agents` (vanilla read
   globals). Porting footgun only.
5. **Poll-failure discipline** — §C.15.

## M. Endpoints vanilla calls that no React code calls

| Endpoint | Vanilla call site | Feature |
|---|---|---|
| `GET /api/me?cid=` | `data.js:225` | identity/gating (§A) |
| `GET /api/prefs`, `PUT /api/prefs` | `app-prefs.js:69,90` | per-user prefs (§D.1) |
| `POST /api/containers` `{additional:true}` | `app-shell.js:244` | new project (§B.4) |
| `GET /api/containers/{cid}/pairing` | `app-pairing.js:149` | phone pairing (§C.9) |
| `POST /api/runs/{id}/stop` | `app-run-stream.js:74` | stop run (§C.13) |
| `GET /api/github/repos` | `home-github.js:70` | repo picker (§F.1) |
| `PUT /api/containers/{cid}/github` | `home-github.js:118` | repo binding (§F.1) |
| `PUT /api/tasks/{tid}/reviewer` | `tasks-actions.js:83` | reviewer (§G.1) |
| `POST /api/requests/{id}/nudge` | `requests-actions.js:111` | nudge (§I.1) |
| `GET /api/reasoning-efforts` | `agents-state.js:70` | effort (§H.2) |
| `POST /api/agents/{id}/reasoning-effort` | `agents-controls.js:108` | effort (§H.2) |
| `PATCH /api/agents/{id}` (`autonomy_override`) | `agents-controls.js:53` | override (§H.1) |
| `GET/PUT/DELETE .../settings/provider-keys*`, `POST .../test` | `settings-provider-keys.js:26,126,138,155` | provider keys (§J.1) |
| `POST /api/containers/{cid}/autonomy` (`autonomy_enforced`) | `app-autonomy.js:226-250` | enforce lock (§C.7) |

(The members endpoints — `GET/POST/PATCH/DELETE /api/containers/{cid}/members*` — are now
called by `src/cloud/members/MembersPage.tsx`.)

## N. React-base contradictions to fix during adoption (not ports — corrections)

1. **Tasks badge** counts `needs_verification` with `attn` styling (`Shell.tsx:344`) —
   reintroduces the fixed count-mismatch bug (§C.5).
2. **`types.ts:118` declares `autonomy_paused?`** while the code reads `wakes_enabled` via an
   inline cast (`Shell.tsx:57,339`); `Container` lacks `wakes_enabled`, `autonomy_enforced`,
   `last_wake_scan_at`, `task_open_total`, `request_open_total`, `repo`.
3. **Toast kinds** — `ToastFn` permits `"ok"|"warn"|"danger"|""`; vanilla's `"bad"` tone
   (paused notifier) has no mapping, so the paused toast renders neutral (`Shell.tsx:69`).
4. **`BrowserRouter` vs hash-routing comments** — `main.tsx:38-45` mounts `BrowserRouter`
   while `main.tsx:15-17` and `Shell.tsx:4-6` claim hash routing / "no history fallback
   needed". Deep links 404 on deploy unless the server grows a fallback. Deploy-breaking.
5. **`path="*"` routes to HomePage** (`main.tsx:50`) — typos silently render the dashboard
   (in an arbitrary project, per §B.1) instead of a not-found state.
6. **"Developed by Quantal Labs" maker block** (`Shell.tsx:387-397`) exists only in the React
   base (no vanilla source, no vanilla styles). Explicit keep-or-drop decision.
7. **Autonomy/notifier copy** — "Autonomy · Paused" toast and "⏸ Autonomy paused" pausebar
   vs vanilla's "Notifier · …" (§C.6).

## O. Verified parity (no action needed)

- `attnItems`/`autLevel` #367 autonomy gating (`SnapshotProvider.tsx:161-190`).
- Notification NEEDS-YOU zone recompute per poll; EARLIER fetch-on-open (matches vanilla).
- Onboarding flow end-to-end (§K), incl. model-picker late-arrival handling (React
  reconciliation obsoletes the vanilla in-place patch).
- Settings Anthropic-key + models cards (§J footnote).
- Agents memory digest / requests-mini / tasks-mini panes.
- Members (this branch): `src/cloud/members/MembersPage.tsx` — endpoint/body parity with
  `settings-members.js`, roster privacy, last-owner guard, owner-only permissions expander,
  human-gated mutations (`actor_agent_id`), tested in
  `src/cloud/members/MembersPage.test.tsx`.
