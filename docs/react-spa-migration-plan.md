# Orcha portal — React SPA strangler migration plan

**Status:** approved direction (2026-08-02) · execution blueprint for an agent fleet
**Companion (target state):** `docs/react-spa-architecture.md`
**Problem owner:** hussein-quant

> **Naming (out of scope):** "Orcha" throughout; a cloud-product rename is a separate
> decision and changes nothing here.

This plan takes the MPA portal to the React SPA of the architecture doc **incrementally**,
without a big-bang rewrite, without breaking the frozen mobile contract, and while keeping the
open-core fork thin at every step. It is written for a fleet of parallel agents, so every work
package is independently shippable, independently deployable, and file-scoped to avoid
collisions.

---

## 1. Strangler strategy

### 1.1 The shell ships first and hosts legacy pages *beside* it (not inside)

Two mechanical options for the coexistence window:

- **(A) Wrap** — the SPA shell embeds each legacy page (iframe or DOM-graft) and proxies nav.
- **(B) Route-level split** — a single front router sends each path to *either* the SPA or the
  legacy MPA document; ported pages are React routes, unported pages are the existing
  server-rendered HTML. No page is ever rendered by both.

**Pick (B), route-level split.** Justification: the portal is already an MPA — each page is a
standalone document with its own script stack. There is nothing to "embed"; a legacy page is a
URL that returns HTML. Option A (iframes) would fight the shared shell, the skin/theme
attributes, `localStorage` prefs, and the SSE streams — all of which assume one document. Option
B is mechanically simpler *because the app is already page-partitioned*: the SPA's catch-all
(architecture §7.1) serves `index.html` for ported routes; every other path still hits its
existing FastAPI page route and returns legacy HTML. A tiny **route manifest** (a checked-in
list of "which paths are SPA-owned") is the single source of truth for the split; flipping a
page from legacy to SPA is a one-line manifest change (plus the ported code). The SPA shell and
the legacy shell share `tokens.css`/skins/`localStorage` keys, so the two look identical during
the window.

**Concretely:** ship the SPA shell as the app served at the SPA-owned routes. On boot the shell
renders the sidebar (from `registerNavItem` — including nav items that *link out* to still-legacy
pages) and the top bar; a click on a legacy nav item is a normal navigation to the
server-rendered page, a click on a ported one is client-side routing. The user sees one portal.

### 1.2 Page order — by (value × isolation)

Ordered so each package delivers user-visible value, is well-isolated (few shared dependencies,
clean API surface), and de-risks the *next* package. This matches the brief's proposed order,
with justification per slot:

| # | Page | Why here | Value | Isolation |
|---|---|---|---|---|
| 1 | **GitHub hub** (`/github`) | Newest, most componentful, cleanest API (`available:false` contract, self-contained detail/diff views). It exercises the DiffViewer, detail sections, and the api-client end-to-end — the perfect pipe-cleaner that *validates the extension registry and `@orcha/ui`* before anything depends on them. | High | High |
| 2 | **Tasks** (`/tasks`) | The portal's center of gravity: detail pane, runs & diffs (SSE run-log stream), lazy thread, protocol editor, new-task modal, `taskDetailSection` injection point. Porting it early validates the streaming + registry stories on the hardest page while the toolchain is fresh. | High | Medium |
| 3 | **Agents** (`/agents`) | Roster + detail + the **conversation panel** (embeds the terminal). High value; medium isolation (depends on the conversation/terminal modules — port those as shared pieces here). | High | Medium |
| 4 | **Dashboard / home** (`/`) | The landing surface; the "needs-you" action queue + activity feed. Depends on tasks/agents/requests data already modeled by packages 2–5, so it composes cleanly once they exist. | High | Medium |
| 5 | **Requests** (`/requests`) | Lifecycle + chains; self-contained, well-understood API. A clean mid-run win. | Medium | High |
| 6 | **Metrics** (`/metrics`) | Stat tiles + cost table + daily bars; reads one additive endpoint (`…/metrics?days=`). Very isolated (no writes), a good parallel package. Cloud-flavored (metrics is a cloud surface) — lands as a cloud extension. | Medium | High |
| 7 | **Settings** (`/settings`) | Three tabs (workspace/collaboration/appearance) + members + skin picker + pairing + keys/models. Touches the settings-tab registry, capability grants, and prefs — best done after the registry has been proven by packages 1–3. | Medium | Low |
| 8 | **Projects + Onboarding + Device** (`/projects`, `/onboarding`, `/device`) | Projects hub is small. Onboarding is a self-contained wizard with its *own* shell (`onboarding-shell.js`, not `mountShell`) — port it last as an isolated flow. Device is a minimal pairing page (mints a token on GET) — port with onboarding. | Low–Med | High (onboarding), High (device) |

**Cloud surfaces (members, github-hub cloud twin, push/Slack settings)** are not separate
pages — they ride along as **extensions** registered into packages 1 (github), 7 (settings
tabs: members, push/Slack), and 6 (metrics). They land in `orcha-cloud/portal/src/cloud/` per
phase, never patching core.

### 1.3 Phase 0 — the shell (prerequisite for everything)

Before any page: stand up the monorepo, the four packages' skeletons, `@orcha/api-client`
generation from `openapi.json`, `@orcha/ui` with `tokens.css` + 3 skins + DiffViewer +
primitives, the `portal-core` shell/router/registry, the route-manifest split, and the
Docker/serve change (architecture §7.1). Ship the shell serving **zero** ported pages — every
route still falls through to legacy. This is the riskiest infra and must be green (api-contract
suite passing, both themes × 3 skins pixel-matched on the shell chrome) before page work fans out.

---

## 2. Per-page work package template

Every package (including Phase 0) is a self-contained unit an agent owns end-to-end. Definition
of a package:

- **Branch/worktree:** its own worktree off `origin/main` of the relevant repo (open-orcha for
  core pieces, orcha-cloud for cloud extensions).
- **Files to port:** the exact legacy JS/CSS files it replaces (listed per package below).
- **API endpoints used:** enumerated so the agent knows the contract surface and whether any
  *additive* endpoint is needed (frozen ones are never reshaped).
- **Tests to write:** Vitest component/unit tests for the ported components; Playwright flow(s).
- **Acceptance gates (all must be green to merge):**
  1. **Feature-parity checklist** — a per-page list of behaviors from the legacy page, each
     ticked (e.g. tasks: detail pane opens, run log streams live, thread lazy-loads, diff
     renders, new-task modal submits, skeleton shows during first load).
  2. **Playwright flows** — the page's primary user journeys pass, across **3 skins × 2 themes**.
  3. **api-contract suite green** — proves no frozen endpoint moved (architecture §3.2).
  4. **No-patch guard green** — cloud packages import only public package entries (§5.3 arch).
  5. **Route-manifest flip** — the page's path is moved from legacy to SPA in the manifest, and
     the legacy files are marked frozen (not deleted until §4 cleanup).

### 2.1 The packages

**P0 — Shell + packages (infra).**
Ports: `app-shell.js`, `app-state.js`, `app-data.js`, `data.js`, `app-prefs.js`,
`app-ui.js`, `app-skeleton.js`, `tokens.css` + all `styles/*.css`, `settings-appearance.js`
(skin/theme logic). Builds: monorepo, 4 packages, api-client generation, registry, route split,
Docker serve stage. API: `/api/containers`, `/api/me`, `/api/prefs`. Tests: registry unit
tests, api-client generation test, shell Playwright (nav renders, skin/theme switch persists).
Gates: shell parity + api-contract green + serve works in the container.

**P1 — GitHub hub.**
Ports: `pages/github-state.js`, `github-render.js`, `github-boot.js`, `github.css`. Promotes
`app-patch-log.js`'s `renderDiff` into `@orcha/ui`'s **DiffViewer**. API (all frozen, read-only
+ one write): `…/github/issues`, `…/github/pulls`, `…/github/issues/{n}`, `…/github/pulls/{n}`,
`…/github/start`, `/api/github/repos`. Tests: DiffViewer unit tests, issue/PR list + detail
Playwright, "start task" flow. Gates: `available:false` off-state renders correctly (not an
error), diff parity.

**P2 — Tasks.**
Ports: `tasks-state.js`, `tasks-detail.js`, `tasks-actions.js`, `tasks-thread.js`,
`tasks-boot.js`, `tasks.css`. Builds the `taskDetailSection` injection point. API (frozen):
`/api/containers/{cid}` (snapshot), `…/tasks` (create), `/api/tasks/{tid}/{messages,runs,
cancel,verify,reviewer}`, `/api/decisions`, `/api/agents/{aid}/runs/{rid}/stream` (SSE run
log), `/api/runs/{rid}/stop`. Tests: run-log stream append + monotonic-seq drop, thread lazy
page, verify/cancel/reviewer writes, new-task modal. Gates: live run log streams identically;
diff card renders; scroll/selection-safe rendering preserved.

**P3 — Agents (+ conversation + terminal shared pieces).**
Ports: `agents-state.js`, `agents-controls.js`, `agents-detail.js`, `agents-boot.js`,
`agents-layout.css`, `agents-detail.css`, plus the shared **conversation** modules
(`conversation.js` + `conversation-*.js`, `conversation.css`) and **terminal** (`terminal.js` +
vendored xterm). API (frozen): `/api/agents/{aid}/{runs,resident-runs,persona,digest,inbox,
outbox,conversation,model,auto-wake,retire,conversations}`, `/api/agents/{aid}` (rename),
`/api/conversations/{convId}/{turns,end}`. Tests: conversation mount/teardown, turn send,
terminal open, agent detail. Gates: conversation + terminal parity (this is the package that
proves the WebSocket terminal bridge is untouched).

**P4 — Dashboard / home.**
Ports: `home-state.js`, `home-render.js`, `home-github.js`, `home.css`. API (frozen): snapshot
+ `/api/github/repos`. Tests: needs-you queue ordering, activity feed, bare-`/`→`/projects`
redirect in multi-project stacks. Gates: needs-you parity; feed parity.

**P5 — Requests.**
Ports: `requests-state.js`, `requests-actions.js`, `requests.css`. API (frozen):
`/api/requests/{rid}/{respond,close,escalate,accept-task,reject-task,convert-to-task,nudge}`.
Tests: each lifecycle transition, request chains. Gates: lifecycle parity; `nudged:true/false`
copy distinction preserved.

**P6 — Metrics (cloud extension).**
Ports: `metrics-state.js`, `metrics-render.js`, `metrics.css`. API: `…/metrics?days=7|30`
(cloud-only; not iOS-consumed — verify it stays additive). Tests: stat tiles, cost table, daily
bars, 7/30 toggle. Lands in `orcha-cloud/portal/src/cloud/metrics/`. Gates: metrics parity;
registers as an extension gated on the metrics capability.

**P7 — Settings (+ members, push/Slack cloud tabs).**
Ports: `settings.js`, `settings-tabs.js`, `settings-key-*.js`, `settings-models.js`,
`settings-provider-keys.js`, `settings-appearance.js` (picker UI; token logic already in P0),
`settings-members.js` (→ cloud), `settings.css`. API (frozen for prefs/models/keys; members +
push/Slack are cloud additive). Tests: tab switch + hidden-tab grant gating, key CRUD, model
select, member management (cloud), skin/theme picker, pairing. Gates: three-tab parity; grant
gating (`manage_keys` hides workspace tab) preserved; members/push/Slack land as cloud settings
tabs via `registerSettingsTab`.

**P8 — Projects + Onboarding + Device.**
Ports: `projects-state.js`, `projects-boot.js`, `projects.css`; the onboarding module set
(`onboarding-*.js`, its own shell, `onboarding-layout.css`, `onboarding-detail.css`);
`device.html` pairing page. API: `/api/onboarding/propose`, `/api/device-tokens`,
`/auth/device`, `/auth/callback`. Tests: projects grid + default star; onboarding wizard
happy-path; device pairing token mint. Gates: onboarding wizard parity (it's a distinct flow —
port as an isolated route subtree with its own shell); device pairing works (the `orcha://` lane
is contract — do not change it).

---

## 3. Parallel-safety rules for the fleet

Learned discipline (dozens of `*-wt` worktrees already exist; collisions are the enemy):

1. **One worktree per package**, branched off `origin/main` of the correct repo. Never two
   agents in the same worktree.
2. **File ownership is exclusive per phase.** Each package's "files to port" list (§2.1) is its
   sandbox. No two in-flight packages touch the same file. Shared pieces (conversation,
   terminal) are owned by exactly one package (P3) and consumed by others only *after* it merges.
3. **The route manifest is a serialization point.** Only one package flips its route at a time
   (the flip is a one-line change; conflicts there are trivial to rebase). A package is not
   "done" until its manifest flip is merged.
4. **`@orcha/ui` and `@orcha/portal-core` changes are gated through P0/P1.** After Phase 0,
   changes to the shared packages are rare and reviewed; a page package that needs a new
   primitive files it as a small separate PR against the package, merged before the page depends
   on it. Pages never fork the shared packages.
5. **Every package is independently shippable AND deployable.** Because the route split means a
   merged package immediately serves its page as SPA while everything else stays legacy, each
   merge is a deployable increment. No package waits on a later one to be releasable.
6. **The api-contract suite is every package's gate**, so a backend-touching package can't ship
   a mobile-breaking change even if another package is mid-flight.

---

## 4. Double-maintenance policy (the coexistence window)

- **A page is legacy-frozen OR SPA-live, never both.** The route manifest guarantees exactly one
  implementation serves each path.
- **A page freezes the moment its port opens.** When a package starts, its legacy files enter
  **freeze**: bugfixes to that page during its port land in the **SPA branch** (fix it once, in
  the thing that's about to be live), unless the bug is production-critical *and* the SPA page
  isn't live yet — then the legacy fix ships and the agent rebases the port onto it.
- **Bugfixes to still-legacy (not-yet-started) pages land in legacy** as normal, on `main`;
  the eventual port inherits them.
- **Shared-backend fixes** (route modules) land once, on `main`, gated by the api-contract suite;
  both the legacy page and any ported page pick them up (both hit the same API).
- **Legacy files are deleted only in a final cleanup PR per page**, after the SPA page has been
  live and stable for one release — never in the porting PR itself (keeps rollback cheap, §6).

---

## 5. Upstream / cloud sequencing per phase (keeping the fork thin)

The governing rule from `docs/open-core-sdk-plan.md`: **generic goes upstream (open-orcha);
cloud-specific goes in `orcha-cloud/portal/src/cloud/`; core is never patched.**

| Phase | Lands in open-orcha | Lands in orcha-cloud | Fork-thinness effect |
|---|---|---|---|
| P0 shell | The 4 packages, registry, shell, api-client, `@orcha/ui`, Docker serve stage | cloud app skeleton importing the packages + auth wrapper | Establishes the import boundary; legacy shared-frontend `M`-count starts dropping as pages move |
| P1 github | github-hub base page + DiffViewer (generic) | github cloud twin (if any) as extension | High-value generic surface upstreamed |
| P2 tasks | tasks page + `taskDetailSection` API | cloud task-detail sections (e.g. cost card) as extension | Registry validated by a real cloud injection |
| P3 agents | agents + conversation + terminal (generic) | — | Big shared chunk upstreamed once |
| P4 home | dashboard (generic) | cloud dashboard widgets (if any) as extension | — |
| P5 requests | requests (generic) | — | — |
| P6 metrics | metrics *capability hook* (generic gate) | **metrics page itself** (cloud surface) as extension | Proves a whole page can live cloud-side via the registry |
| P7 settings | settings shell + tab registry + appearance/keys/models (generic) | **members**, **push/Slack** tabs as `registerSettingsTab` extensions | The hardest-coupled legacy layer moves to registry; `M`-count for settings → ~0 |
| P8 projects/onboarding/device | all generic | — | — |

**Exit-metric per phase:** the SDK-plan `M`-count for portal-frontend shared files trends
toward zero as each page moves from a patched shared file to a registered module. That number is
the honest scorecard.

---

## 6. Rollback per phase

Route-level split makes rollback **per page and near-instant**:

- **Any page package:** revert the one-line route-manifest flip → the path immediately serves the
  legacy HTML again (its files were frozen, not deleted, until §4 cleanup). No data migration, no
  API change to undo. This is the whole reason legacy files aren't deleted in the porting PR.
- **P0 shell:** the shell is served at SPA-owned routes only; with zero pages flipped, reverting
  the shell deploy returns the portal to the pure MPA. The Docker serve change is additive (a
  catch-all + a StaticFiles mount); reverting the image tag restores the prior container.
- **A cloud extension (P6/P7):** unregister it (remove the `registerExtension` call) → the surface
  vanishes, base portal unaffected. Because extensions can't patch core, removing one can't break
  core.
- **The api-contract suite is the pre-rollback tripwire:** a mobile-breaking change can't reach
  production to *need* a rollback — it fails CI first.

---

## 7. Effort estimate (agent-days)

Rough, honest, includes tests + parity + review-cycle churn (not just happy-path coding). An
"agent-day" is one focused agent session-day including verification.

| Package | Agent-days | Notes |
|---|---:|---|
| P0 Shell + 4 packages + api-client + serve | **10** | Riskiest infra; monorepo, generation pipeline, registry, Docker. Front-loaded cost. |
| P1 GitHub hub + DiffViewer | **5** | Componentful but clean; also proves the registry + `@orcha/ui`. |
| P2 Tasks | **6** | Hardest page: SSE run log, thread, diffs, detail sections, modal. |
| P3 Agents + conversation + terminal | **6** | Big shared chunk (conversation + terminal). |
| P4 Dashboard / home | **3** | Composes over P2–P5 data. |
| P5 Requests | **3** | Clean lifecycle page. |
| P6 Metrics (cloud) | **2** | Read-only, isolated; first full cloud-side page. |
| P7 Settings + members + push/Slack | **5** | Most tabs/coupling; registry-heavy. |
| P8 Projects + onboarding + device | **4** | Onboarding's own shell adds cost. |
| Contract suite + no-patch guard + CI wiring | **2** | Built alongside P0/P1, tracked separately. |
| Final cleanup PRs (delete frozen legacy per page) | **2** | Post-stability, batched. |
| **Total** | **~48 agent-days** | Sequential critical path is shorter — P4–P8 parallelize heavily once P0–P3 land. |

**Parallelization:** P0 → P1/P2 are the critical spine (~21 days serial, since P1/P2 validate
the shared packages). Once P3 lands, P4–P8 fan out in parallel across the fleet, so wall-clock is
well under the 48-agent-day sum — roughly **P0 (10) + P1 (5) + P2/P3 (~6 overlapped) + one
parallel wave for P4–P8 (~6) + cleanup (2) ≈ 4–5 wall-clock weeks** at fleet width 3–4.

---

## 8. Sequencing summary (the fleet's marching order)

1. **P0 shell** — solo, must be green (api-contract + shell parity) before anything fans out.
2. **P1 github** then **P2 tasks** — the spine that validates registry + `@orcha/ui` + SSE.
   Ship the extension registry as *stable* only after P1 and P2 exercise it.
3. **P3 agents** — the shared conversation/terminal chunk.
4. **P4 home, P5 requests, P6 metrics, P7 settings, P8 projects/onboarding/device** — parallel
   wave, each an independent worktree, each flipping its route manifest on merge.
5. **Cleanup** — delete frozen legacy per page after one stable release; watch the SDK-plan
   `M`-count fall to near-zero.

Throughout: the JSON API stays frozen for mobile, every package is independently
shippable/deployable, and no core file is ever patched by a cloud extension.
