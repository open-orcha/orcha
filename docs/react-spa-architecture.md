# Orcha portal — React SPA architecture (target state)

**Status:** approved direction (2026-08-02) · execution blueprint for an agent fleet
**Problem owner:** hussein-quant · **Doc owner:** whoever touches the portal boundary next
**Companion:** `docs/react-spa-migration-plan.md` (the strangler sequencing that gets us here)

> **Naming note (out of scope):** this doc says **"Orcha"** throughout. A possible
> cloud-product rename is a separate decision and does not change any package name,
> route, or contract described here.

---

## 0. Why this doc exists

The portal today is a **multi-page vanilla-JS app** (MPA) with **no build step, no
component model, and no client-side plugin system**. Every sidebar click is a real
browser navigation to a distinct FastAPI-served HTML document. Cloud-vs-self-host
differences are realized by **env-var gating** (`ORCHA_TRUST_PROXY_USER`) plus edits to
shared files — the exact coupling `docs/open-core-sdk-plan.md` measures as **35 modified
portal-frontend files**, "the hard layer," "where fork maintenance bleeds most."

This document specifies the target: **open-orcha publishes reusable frontend packages; the
cloud app is a thin importer.** It is the concrete realization of **seam #2** from the
open-core SDK plan — the "portal extension convention" — built as a first-class TypeScript
extension registry rather than the "`TasO`-style hook points on page namespaces" that plan
sketched. It respects, and does not re-open, **seam #1** (pluggable auth provider) and
**seam #3** (migration namespacing).

**The one hard constraint that shapes everything:** the JSON API contract the iOS app
consumes is **frozen**. This is a frontend rewrite plus additive backend changes. See §3.

---

## 1. Ground truth (what exists today)

Verified in the worktree, 2026-08-02. Portal root: `orcha-cli/orcha_cli/templates/portal/`.

| Layer | Today | Files |
|---|---|---|
| Backend | FastAPI, single shared `app` singleton; ~114 route modules self-register on import via `route_registry.py`; `main.py` is the composition root | `portal_backend/*.py`, `main.py`, `application.py`, `route_registry.py` |
| Page serving | One FastAPI route per page → `serve_page("<name>.html")`; **no SPA fallback**, no catch-all | `dashboard_routes.py`, `static_pages.py` |
| Frontend | MPA. 10 HTML pages, each loads the same ~15-file base JS stack (plain `<script>` globals, no modules/bundler) then page-specific files | `static/*.html`, `static/modules/*.js`, `static/pages/*.js` |
| State | One mutable snapshot `window.ORCHA`, mutated in place; 3s poll + SSE push refresh | `static/modules/app-state.js`, `static/data.js` |
| Streaming | Two `EventSource` consumers: container events (push refresh) + per-run NDJSON log stream | `static/data.js`, `static/modules/app-run-stream.js` |
| Theming | 2 axes: **theme** (dark/light/auto via `data-theme`) × **skin** (classic/swiss/minimal via `data-skin`), both from `localStorage`, mirrored to `/api/prefs` | `static/styles/tokens.css`, `skin-minimal.css`, `responsive.css`, `modules/settings-appearance.js` |
| Diff | A plain-HTML `renderDiff(unifiedDiffString)` — no side-by-side, no Monaco | `static/modules/app-patch-log.js` |
| "Extension seam" | **Does not exist.** New pages = edit the hardcoded `nv[]` array in `mountShell` (`app-shell.js:281`) + add a server route. New settings tabs = add a `[data-tab]` DOM node | — |
| Tests | Dependency-free node tests | `tests/portal/` (43 files) |

**The 10 pages** (route → HTML): `/`→home, `/tasks`, `/agents`, `/requests`, `/metrics`,
`/settings`, `/projects`, `/github`, `/onboarding`, `/device`. (The task brief said "8"; the
count including onboarding + device is 10. Both are in scope for parity but onboarding and
device are special-cased — see the migration plan.)

**Two facts that change the plan's shape versus the brief's assumptions:**

1. **`window.OrchaExt` does not exist.** The brief asked to "map each hook from the existing
   `window.OrchaExt` seam." There is no such seam in shipped code — it is the *planned*
   seam #2. So the SPA registry is **greenfield**, not a port. What it must *preserve* is the
   **seam philosophy**: base pages are composable; cloud adds surfaces without patching core.
   The closest existing analogues we carry forward are (a) the `nv[]` nav array, (b) the
   settings `data-tab` convention, (c) the server-side page-route list, and (d) runtime
   `actingGrant()`/`identity()` capability gates. Each maps to an explicit registry call in §5.

2. **`auth_provider.py` does not exist.** Identity resolution is env-gated functions in
   `identity_routes.py` (`trusted_actor`, `require_grant`, `enforce_grant`, `proxy_login`),
   switched by `ORCHA_TRUST_PROXY_USER`. The pluggable auth provider is seam #1, unbuilt.
   **This doc does not build it.** The SPA consumes identity exactly as the phone does —
   `GET /api/me` returns `{identity, trusted, grants}` — and gates affordances off `grants`.
   The frontend rewrite is decoupled from the backend seam work; they can land independently.

---

## 2. Target architecture

### 2.1 The package graph

open-orcha (upstream) publishes a **pnpm workspace monorepo** of four packages. The cloud
repo imports them and adds a thin app + its cloud routes.

```
open-orcha/  (upstream monorepo — pnpm workspace)
├── packages/
│   ├── api-client/      @orcha/api-client   — generated TS client from openapi.json
│   ├── ui/              @orcha/ui           — tokens, 3 skins, primitives, diff viewer
│   ├── portal-core/     @orcha/portal-core  — shell, router, base pages, EXTENSION REGISTRY
│   └── portal-app/      (open-core's own thin app: imports the three above; ships in the
│                          orcha-cli container as the self-host portal)
│
orcha-cloud/  (this repo — thin importer)
└── portal/
    ├── package.json     depends on @orcha/{api-client,ui,portal-core} (pinned)
    ├── src/main.tsx     imports portal-core, registers cloud extensions, mounts
    └── src/cloud/       members, metrics, github-hub, push/Slack settings, auth wrapper
```

- **`@orcha/api-client`** — a **generated** TypeScript client. `openapi-typescript` +
  `openapi-fetch` run against `/openapi.json` (the declared source of truth per CLAUDE.md) in
  CI; the output is committed and published. Types and path signatures come *from the spec*, so
  the client cannot drift from the backend. Cloud and self-host share one client; cloud-only
  routes appear because they are in the cloud backend's spec, gated at runtime by capability.

- **`@orcha/ui`** — the **design system**: `tokens.css` (ported verbatim — see §6), the three
  skins, and framework components that consume *only* CSS variables (StatusPill, Avatar, Modal,
  Toast, SkeletonRow, and the **DiffViewer**, the diff renderer promoted to a real component).
  Zero business logic, zero API calls. This is the analogue of iOS `Components/` (`Kit.swift`,
  `StatusPill.swift`, `DiffViewer.swift`) — the two platforms deliberately mirror each other.

- **`@orcha/portal-core`** — the portal **shell + router + base pages + the extension
  registry**. Base pages (home, tasks, agents, requests, settings, projects, onboarding,
  device) are shipped as **composable route modules**, each registering itself through the same
  registry a third party would use. This is the dogfood guarantee: if base pages register the
  same way extensions do, the extension API is real, not a second-class bolt-on.

- **Cloud app (`orcha-cloud/portal/`)** — `main.tsx` imports `portal-core`, calls
  `registerExtension()` for each cloud surface (members, metrics, github-hub, push/Slack
  settings tabs), wraps the shell in the cloud auth boundary, and mounts. **This is the entire
  fork surface on the frontend** — a handful of files under `src/cloud/`, no edits to core.

### 2.2 The backend is unchanged in shape

FastAPI stays. Cloud still imports the open app and adds routes (`route_registry.py` pattern
is untouched). The **only** backend change this rewrite requires is **how the built bundle is
served** (§7) plus any **additive** endpoints a ported page needs (§3.3). The identity seam,
migration runner, and route modules are out of scope. This keeps the fork thin: the frontend
split does not force the seam-#1/seam-#3 work, and vice-versa.

### 2.3 Data flow

```
Component  ─useQuery→  @orcha/api-client  ─fetch→  FastAPI  (bearer/cookie identity)
    ↑                        │
    └──TanStack Query cache──┘   (staleTime tuned; invalidation on mutations + SSE events)

Live updates:  <EventSource>  /api/containers/{cid}/events  → query invalidation (replaces the 3s poll)
Run logs:      <EventSource>  /api/agents/{aid}/runs/{rid}/stream → append to a run-log store
```

The 3s snapshot poll is **replaced** by TanStack Query + SSE-driven invalidation — fewer full
refetches, same freshness. The two `EventSource` streams port 1:1; **no websocket
rearchitecture** (see §9, not-now list).

---

## 3. HARD CONSTRAINT — the mobile API contract is FROZEN

The iOS app (`ios/Orcha`) and its tests consume the JSON API directly. **Zero breaking
changes** to any endpoint iOS touches. This is not a guideline; it is a CI gate.

### 3.1 The frozen surface (enumerated from `ios/Orcha/Data/OrchaApiClient*.swift`)

Every path below is exercised by the shipped iOS client. Method, path template, and the
request/response fields iOS reads are the contract. **None may change shape.**

**Reads (GET):**

| Path | iOS caller |
|---|---|
| `/api/containers` | `listContainers` |
| `/api/containers/{cid}` (`?task_limit`,`?request_limit`) | `snapshot` |
| `/api/containers/{cid}/members` | `members` |
| `/api/containers/{cid}/github/issues` | `githubIssues` |
| `/api/containers/{cid}/github/pulls` | `githubPulls` |
| `/api/containers/{cid}/github/issues/{n}` | `githubIssueDetail` |
| `/api/containers/{cid}/github/pulls/{n}` | `githubPullDetail` |
| `/api/tasks/{tid}/messages` (`?limit`,`?before`,`?before_id`) | `taskMessages` |
| `/api/tasks/{tid}/runs` (`?limit`) | `taskRuns` |
| `/api/agents/{aid}/runs` (`?limit`) | `agentRuns` |
| `/api/agents/{aid}/resident-runs` | `residentRuns` |
| `/api/agents/{aid}/persona` | `persona` |
| `/api/agents/{aid}/digest` | `digest` |
| `/api/agents/{aid}/inbox` · `/outbox` | `inbox` · `outbox` |
| `/api/agents/{aid}/conversation` (`?limit`) | `conversation` |
| `/api/conversations/{convId}/turns` (`?after_seq`,`?limit`) | `conversationTurns` |
| `/api/agents/{aid}/runs/{rid}/stream` (SSE: `data:{seq,line}` … `{seq,done,status}`) | `runStream`, `runStreamText` |
| `/api/models` | `models` |
| `/api/me` (`?cid`) → `{identity, trusted}` (+ `bind_first_unmapped_human` side effect) | `me` |
| `/api/prefs` → `{prefs}` | `getPrefs` |
| `/api/github/repos` → `{available, repos}` | `githubRepos` |

**Writes (POST/PUT/PATCH):**

| Method · Path | Body keys iOS sends | iOS caller |
|---|---|---|
| POST `/api/tasks/{tid}/messages` | `author_agent_id`,`body` | `postTaskMessage` |
| POST `/api/tasks/{tid}/cancel` | `actor_agent_id`,`reason` | `cancelTask` |
| POST `/api/tasks/{tid}/verify` | `approve`,`feedback`,`actor_agent_id` | `verifyTask` |
| PUT `/api/tasks/{tid}/reviewer` | `actor_agent_id`,`reviewer_agent_id` | `setTaskReviewer` |
| POST `/api/decisions` | `subject_type`,`subject_id`,`decision`,`reason`,`actor_agent_id`,`target_agent_id` | `decidePlan` |
| POST `/api/requests/{rid}/respond` · `/close` · `/escalate` · `/accept-task` · `/reject-task` · `/convert-to-task` · `/nudge` | per-call actor + payload | `respondRequest` … `nudgeRequest` |
| POST `/api/containers/{cid}/wakes` | `enabled`,`actor_agent_id` | `setWakes` |
| POST `/api/containers/{cid}/autonomy` | `level`,`actor_agent_id` | `setAutonomy` |
| PUT `/api/containers/{cid}/github` | `repo` | `setGithubRepo` |
| POST `/api/containers/{cid}/tasks` | `title`,`description`,`definition_of_done`,`priority`,`created_by_agent_id`,`assignee_alias`,`depends_on`,`not_ready` | `createTask` |
| POST `/api/containers/{cid}/github/start` | `kind`,`number`,`title`,`body_excerpt`,`html_url`,`assignee_agent_id`,`created_by_agent_id` | `startGithubItem` |
| POST `/api/agents/{aid}/model` | `model` | `updateAgentModel` |
| PATCH `/api/agents/{aid}/auto-wake` | `actor_agent_id`,`interval_secs` | `updateAutoWake` |
| PATCH `/api/agents/{aid}` | `actor_agent_id`,`alias` | `renameAgent` |
| POST `/api/agents/{aid}/retire` | `actor_agent_id` | `retireAgent` |
| POST `/api/agents/{aid}/conversations` | `actor_agent_id` | `startConversation` |
| POST `/api/conversations/{convId}/turns` | `role`,`author_agent_id`,`content` | `sendTurn` |
| POST `/api/conversations/{convId}/end` | `actor_agent_id` | `endConversation` |
| POST `/api/runs/{rid}/stop` | `actor_agent_id` | `stopRun` |
| PUT `/api/prefs` | `{prefs:{…}}` | `putPrefs` |

**Non-`/api` surfaces iOS depends on:** `/auth/device` and `/auth/callback` (the `orcha://`
device-pairing OAuth lane), and the `Bearer` auth perimeter's 401/HTML fall-through behavior
(`perimeterIntercepted`). The SPA must not change these routes or the perimeter's error shape.

**Contract subtleties the tests already lock (do not regress):**
- `/api/github/repos` and all github-hub reads return **`200 {available:false}`** on the off
  state — never a 5xx. iOS treats a thrown error very differently from `available:false`.
- On writes, **nil optional keys are dropped** client-side; the server defaults absent keys.
  `{}` and `{"repo": null}` both unbind. Additive fields must keep this "older client omits
  the key" tolerance.
- `/api/me` runs `bind_first_unmapped_human` as a side effect (founding `root` → arriving
  GitHub user). This behavior is contract, not incidental.

### 3.2 Enforcement mechanism — the api-contract test suite

A **snapshot suite** (`tests/api-contract/`) that:

1. **Generates** `openapi.json` from the FastAPI app in CI (`python -c "import json,main;
   json.dump(main.app.openapi(), …)"`).
2. **Extracts** the request/response **schemas** for every path in the frozen list of §3.1
   (the list is checked in as `tests/api-contract/frozen-paths.json`, one entry per
   iOS-consumed path+method, derived by parsing `OrchaApiClient*.swift`).
3. **Compares** each against a committed golden snapshot (`__snapshots__/`) and **fails CI on
   any breaking diff**, where *breaking* is defined by the additive-only rules in §3.3.
4. Runs on every PR that touches `portal_backend/`, `main.py`, or the migrations dir.

A companion **generator test** re-parses `OrchaApiClient*.swift` and asserts the frozen-path
list is complete — so if iOS starts consuming a new endpoint, the list (and its snapshot) must
be updated deliberately, in the same PR, by a human. This closes the "iOS silently grows a
dependency the guard doesn't know about" gap.

**Why snapshot the spec, not hit the running server:** the spec is generated from the route
declarations and Pydantic models, so it is the exact shape a client decodes. Snapshotting it
catches a renamed field, a tightened type, a removed optional, or a changed status code at
diff-review time, deterministically, with no DB or network.

### 3.3 Additive-only evolution rules (what a diff may and may not do)

**Allowed (non-breaking):**
- Add a **new** endpoint (new path, or new method on a path).
- Add an **optional** request field (with a server default) — older clients omit it.
- Add a field to a **response** body — clients that whitelist (iOS and the web `mapSnapshot`
  both do) ignore it.
- Add a new enum *value* the client already handles as "unknown/default."
- Widen a type in a backward-compatible direction (e.g. required→optional in a response is
  fine; the reverse is not).

**Forbidden (breaking — CI red):**
- Remove or rename any path, method, field, or query param in §3.1.
- Make an existing optional request field required, or narrow a response field's type.
- Change a status code the client branches on (401 perimeter, `200 {available:false}`,
  403/409/422 mapped to specific iOS error copy).
- Change SSE frame shape (`{seq,line}` / `{seq,done,status}`) or the `/api/prefs` `{prefs}`
  envelope.

**Where new UI needs new data:** add a **new additive endpoint** or optional field — never
reshape a frozen one. The web SPA and iOS then evolve on the same additive contract.

---

## 4. Toolchain

One choice per slot, with rationale. No survey.

- **Vite + React 19 + TypeScript (strict).** Vite is the default for new React SPAs: instant
  HMR, native ESM dev, Rollup production builds, first-class library mode for publishing the
  packages. React 19 gives us the modern compiler, Actions, and `use()` without ceremony.
  TS `strict` is non-negotiable — the generated api-client's types are the whole point of the
  frozen-contract story; loose TS would throw that away.

- **TanStack Router + TanStack Query.** Router: fully type-safe routes with typed params/search
  — the URL becomes part of the type system, which matters because the extension registry
  *adds* routes at runtime and we want those typed. It also has first-class code-splitting per
  route, which is how each ported page ships as an independent chunk (the strangler unit).
  Query: the snapshot-poll + SSE-invalidation model maps onto Query's cache + `invalidateQueries`
  exactly; it deletes the hand-rolled 3s `setInterval` and fail-streak logic in `data.js`.

- **Vitest + Playwright.** Vitest shares Vite's transform pipeline, so unit/component tests run
  under the same config as the app (no second toolchain) and replace the current dependency-free
  node tests 1:1 in spirit. Playwright drives the per-page acceptance flows (the migration
  plan's parity gates) across the three skins and both themes headlessly in CI.

- **pnpm workspace monorepo (in open-orcha).** pnpm's content-addressed store + strict
  `node_modules` make a four-package workspace cheap and correct; `workspace:*` protocol links
  the packages during dev and pins published versions in the cloud repo. This is the mechanism
  that makes "upstream publishes, cloud imports" real. `changesets` handles versioning +
  changelogs at publish time.

- **`openapi-typescript` + `openapi-fetch`** for `@orcha/api-client` (generation, §2.1).
- **`changesets`** for release management of the four packages.

---

## 5. Extension / plugin API (seam #2, made first-class)

This is the heart of "keep the fork thin." A third party — or the cloud app — adds portal
surfaces **only** through this registry; **core files are never patched** (the guard rule from
the SDK plan, enforced by a lint/test). Base pages register the same way, so the API is
dogfooded.

### 5.1 The registry

`@orcha/portal-core` exports a single `registerExtension(ext: OrchaExtension)` plus typed
registration helpers. An extension is a declarative bundle:

```ts
// @orcha/portal-core
export interface OrchaExtension {
  id: string;                         // "cloud", "acme-billing" — namespace for its surfaces
  routes?: RouteRegistration[];       // new top-level pages
  navItems?: NavItemRegistration[];   // sidebar entries
  settingsTabs?: SettingsTabRegistration[];
  taskDetailSections?: TaskDetailSection[];   // cards injected into the task detail pane
  capabilityGate?: (caps: Capabilities) => boolean;  // hide the whole ext when unavailable
}

export function registerExtension(ext: OrchaExtension): void;
```

Each surface type maps **explicitly** to a thing the current portal does by editing a
hardcoded structure. This is the "carry the seam philosophy over" requirement, made concrete:

| Registry API | Replaces (today) | Signature |
|---|---|---|
| `registerRoute` | a new `@app.get(...)` page route + new HTML file | `{ path: string; element: LazyComponent; loader?; guard?: (caps) => boolean }` |
| `registerNavItem` | appending to the `nv[]` array in `app-shell.js:281` | `{ key; to; icon; label; badge?: (snapshot) => number; attn?: (snapshot) => bool; order?; guard?: (caps) => bool }` |
| `registerSettingsTab` | adding a `<span data-tab>` in `settings.html:69` + a `.set-wrap` card | `{ key; label; element: LazyComponent; order?; guard?: (caps) => bool }` |
| `registerTaskDetailSection` | (new capability — no analogue; today the task pane is one monolith) | `{ key; title?; element: (task) => ReactNode; order?; guard?: (task, caps) => bool }` |

`registerRoute`/`registerNavItem`/`registerSettingsTab`/`registerTaskDetailSection` are thin
wrappers over `registerExtension` for the common single-surface case.

### 5.2 Capability gating (how "cloud-only" is expressed)

Extensions never check `if (cloud)`. They gate on **capabilities** derived from the API — the
same runtime signal the current portal uses (`actingGrant()`, `identity()`, `trusted`):

```ts
interface Capabilities {
  trusted: boolean;                  // from GET /api/me — cloud proxy identity present
  grants: string[];                  // manage_keys, manage_members, manage_repo, …
  features: Record<string, boolean>; // github: /api/github/repos !== available:false, slack: …
  identity: Identity | null;
}
```

A `useCapabilities()` hook exposes this to components; the shell resolves it once from
`/api/me` (+ cheap probes) at boot and refreshes on identity change. **Cloud registers all its
surfaces unconditionally** and gates each on `trusted` / a grant / a feature — so the *same
build* degrades to self-host behavior when `trusted:false`, exactly as `app.js`'s standalone
fallback does today (`identity: () => null`, `actingGrant: () => …`).

### 5.3 The core→extension load order and the no-patch rule

`portal-core` mounts its base extensions first, then calls a well-known
`window.__orchaExtensions?.forEach(registerExtension)` (or, in the cloud app, `main.tsx`
imports and registers them directly). The **"extensions may not patch core files"** rule (SDK
plan §2b) is enforced by: (a) extensions depend on `@orcha/portal-core` as a normal package —
they cannot reach into its internals; (b) a CI guard asserts the cloud `src/` contains no
imports of core *internal* paths, only the public entry. This is what lets an upstream release
be a version bump, not a merge.

### 5.4 Third-party sufficiency

The four registration types + capability gating + the published `@orcha/ui` primitives + the
generated `@orcha/api-client` are enough for a third party to ship a portal add-on (e.g. a
"Billing" tab, a "Compliance" nav item with a page, a task-detail "Cost breakdown" card)
**without forking**. That is the acceptance bar for calling seam #2 done.

---

## 6. Theming — how the 3 skins + tokens port

**The token CSS survives unchanged.** `tokens.css` is a set of CSS custom properties on
`:root`/`[data-theme]`; the three skins override the same variables under
`html[data-skin="..."]`. React components consume the variables (via CSS Modules or a thin
styled layer) — **no runtime theme engine, no CSS-in-JS color computation.** This is the same
zero-component-change property the current portal has, and it keeps the SPA byte-compatible with
iOS's `Palette.swift` intent.

**What moves into `@orcha/ui`:**
- `tokens.css` (the classic default layer) → `@orcha/ui/tokens.css`, imported once at app root.
- `skin-minimal.css`, the swiss overrides (today embedded in `responsive.css`) → discrete
  `skins/minimal.css`, `skins/swiss.css`. Splitting swiss out of `responsive.css` also fixes
  the exact class of bug the SDK plan cites (upstream #191's CSS split "silently broke the
  Swiss light theme in the fork").
- Skin/theme selection: the pre-paint inline script (reads `localStorage['orcha:skin']` /
  `['orcha:theme']`, sets `data-skin`/`data-theme` before first paint to kill FOUC) ports
  verbatim into `index.html`. The runtime picker becomes a `useSkin()`/`useTheme()` hook that
  sets the attribute + writes `localStorage` + `PUT /api/prefs` (server mirror unchanged).

**Two axes preserved:** theme (`data-theme` = dark/light/auto) × skin (`data-skin` =
classic[none]/swiss/minimal). `classic` remains the default with **no** `data-skin` attribute.

**Minimal-skin parity table** (the minimal skin is the strictest consumer — if components read
only tokens, it just works). Each row is a component × the tokens it must consume:

| Component | Tokens consumed (all skins override these) | Minimal-skin structural note |
|---|---|---|
| Shell / sidebar | `--bg`, `--surface`, `--border`, `--text`, `--muted` | hides `.nav .lbl` decorative labels |
| StatusPill | `--ok/-soft/-line`, `--warn…`, `--danger…`, `--info…`, `--idle…` | mono chips (swiss); champagne accent (minimal) |
| Buttons | `--accent`, `--accent-ink`, `--accent-soft`, `--ring` | radius 12px (minimal), 0 (swiss) |
| Cards | `--surface-2/-3`, `--raised`, `--shadow…`, `--border-2` | radius 18px (minimal) |
| DiffViewer | `--diff-add/-bg`, `--diff-del/-bg`, `--diff-hunk/-bg` | same tokens, all skins |
| Typography | body font set on `:root`; `.mono` = JetBrains Mono | minimal → Hanken Grotesk; swiss → Space Grotesk |
| Focus ring | `--ring` (`0 0 0 3px var(--accent-glow)`) | unchanged |

**Honest note:** radii, spacing, and typography are **not** tokenized today (they're literal
per-component CSS, overridden per-skin). The port is a good moment to promote radii/spacing to
tokens, but that is **optional polish, not required for parity** — doing it changes every skin
file and risks pixel regressions, so it is scoped as a follow-up, not a migration blocker.

---

## 7. Deployment

### 7.1 What changes, minimally

Today: statics are **baked into the uvicorn image** (`COPY . .`), the portal serves its own
HTML per route, and Caddy **only reverse-proxies** (four lanes: `@team`, `@bearer` device
tokens, `/oauth2/*`, catch-all browser OAuth → `portal:8000`). No static file_server in Caddy.

Target: the SPA is **one built bundle** (`index.html` + hashed `/assets/*`). Two viable serve
points; **pick: serve the bundle from the FastAPI container** (option A), because it keeps the
auth perimeter and the whole Caddy config **byte-for-byte unchanged** — Caddy still just
reverse-proxies, identity still rides `X-Auth-Request-User`, device-token and team lanes are
untouched. That is the lowest-risk change and it keeps `deploy/` (the zero-coupling,
SDK-shaped layer) out of the blast radius.

**The backend change (additive, small):**
- Build the SPA in the portal Docker image (multi-stage: node build → copy `dist/` into the
  python image). The `dist/` is served by FastAPI `StaticFiles(directory="dist", html=True)`
  mounted at `/`, **plus a catch-all** that returns `index.html` for any non-`/api`,
  non-`/auth`, non-`/oauth2`, non-`/assets` path (client-side routing deep links). This is the
  single new route the rewrite requires; it does not exist today.
- The existing `/assets` StaticFiles mount (`application.py:10`) is superseded by the SPA's
  hashed-asset serving; keep it during the strangler window (legacy pages still reference it).
- `/api/*` routing, the perimeter, SSE endpoints, device tokens — **unchanged**.

**Option B (rejected for v1):** serve `dist/` from Caddy via a `file_server` block, proxy only
`/api/*` and `/auth/*` to the portal. Cleaner separation long-term, but it edits the auth
Caddyfile (the perimeter), touching the most security-sensitive file for no v1 benefit. Revisit
post-migration if we want the CDN story.

### 7.2 The welcome page stays a static artifact

`deploy/auth/welcome/` (built by `build.py` from `sections/*.html`) is **not** part of the SPA.
It is the marketing/sign-in landing, served ahead of the auth perimeter. It stays exactly as it
is — a hand-built static artifact wired (today, by hand on the reference box) at `/welcome`. The
SPA rewrite does not touch it. This keeps the "welcome page stays a static artifact" constraint
literal.

### 7.3 Stack-dir / compose

`docker-compose.yml.j2`'s `portal` service (`build: ./portal`, `{{api_port}}:8000`) is
unchanged except that `./portal/Dockerfile` gains the node build stage. All the env passthrough
(`ORCHA_TRUST_PROXY_USER`, terminal WS URL, github token files, secret key) is untouched. `db`
service, migrations mount, and the `001_init` initdb split are untouched.

---

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **A backend change breaks the frozen mobile contract** and ships because the guard has a gap (e.g. iOS grew a dependency the frozen list doesn't cover). | §3.2 generator test re-parses `OrchaApiClient*.swift` and fails if the frozen-path list is stale; human sign-off required to update snapshots. iOS test suite (`ios/OrchaTests/*ParityTests.swift`) is a second net. |
| 2 | **The extension registry ossifies wrong** — cloud needs a surface the four types don't cover, and we either patch core (fork bleeds again) or bolt on a fifth type badly. | Ship the registry only after the two most componentful pages (github-hub, tasks) are ported *through it*, so the API is validated by real cloud surfaces before it's frozen. `taskDetailSection` exists specifically because cloud injects into the task pane. |
| 3 | **Double maintenance during the multi-month window** — bugs must be fixed in both the legacy MPA page and the ported SPA page until a page is fully cut over. | Strangler policy (migration plan §): a page is either legacy-frozen or SPA-live, never both; bugfixes land in whichever owns the live route; the shell routes each path to exactly one implementation. |
| 4 | **Skin/theme regressions** — porting `tokens.css` + 3 skins into components is exactly the CSS-split class of bug that already burned the fork (Swiss light theme, upstream #191). | Playwright visual checks across 3 skins × 2 themes per page as an acceptance gate; splitting swiss out of `responsive.css` removes the specific fragility; minimal-skin parity table (§6) is the checklist. |
| 5 | **Fork-thinness erodes** — cloud starts editing core packages "just this once" and the `M`-file count climbs back, defeating the whole exercise. | The no-patch guard (§5.3): CI asserts cloud `src/` imports only public package entries; the SDK plan's `M`-count shrink command stays the tracked metric; every deviation is a `# CLOUD:`-marked, reviewed exception. |

---

## 9. Explicitly not now

To keep the blast radius honest, this rewrite does **not** include:

- **No backend rewrite.** FastAPI, the ~114 route modules, the composition-root pattern, and
  the identity gates all stay. Only bundle-serving changes.
- **No Go / Rust / other-language rewrite** of anything.
- **No iOS changes.** `ios/Orcha` is frozen-contract-only. Not one Swift file changes.
- **No realtime/websocket rearchitecture.** The two `EventSource` streams (container events,
  run logs) port as-is. The browser terminal's WebSocket bridge is untouched.
- **No auth-provider seam (seam #1) work.** The SPA consumes identity via `/api/me`; building
  the pluggable provider is a separate backend track.
- **No migration-namespacing (seam #3) work.** Orthogonal to the frontend.
- **No design redesign.** Pixel-and-behavior parity with the current portal is the bar; visual
  improvement is a later, separately-scoped effort.
- **No cloud-product rename.** Out of scope; noted here and in the migration plan.

---

## 10. Success criteria

1. open-orcha publishes `@orcha/{api-client,ui,portal-core}`; the self-host portal is a thin
   app importing them.
2. The cloud repo's entire frontend fork is `orcha-cloud/portal/src/cloud/` — no patched core
   files; the SDK-plan `M`-count for portal-frontend trends to near-zero.
3. The api-contract suite is green and gating; a breaking change to any §3.1 path fails CI.
4. All 10 pages reach behavior parity across 3 skins × 2 themes (Playwright-verified).
5. A third party can ship a portal extension (route + nav + settings tab + task section)
   without forking, using only published packages.
