# Orcha Portal — HTML → React migration plan (backend intact)

> Goal: migrate the portal frontend — 6 vanilla HTML pages + shared JS modules
> (~8,200 lines under `orcha-cli/orcha_cli/templates/portal/static/`) — to a
> **React 18 + TypeScript + Vite** app, while keeping the **FastAPI backend 100%
> intact**: same `/api` routes, same request/response bodies, same SSE streams,
> same Docker image build. The API contract's source of truth stays
> `/openapi.json` (see CLAUDE.md); this migration never edits an API route.
> Strategy: **strangler fig** — pages flip from vanilla to React one PR at a
> time; both stacks coexist behind the same FastAPI page routes until the last
> vanilla page is gone.

## Why now / why React

- `app.js` (1,511 lines) is a hand-rolled shell: 3s snapshot polling with a
  scroll/selection-preserving `patch()`, SSE run streams, delegated event
  wiring, and innerHTML string templating. Every new widget (e.g. the
  files-changed diff viewer) re-implements state-preservation that
  React gives for free via the VDOM.
- The desktop app (`desktop/`, Electron + React + TS + electron-vite, spec
  `docs/superpowers/specs/2026-06-11-desktop-app-design.md`) already set the
  React + Vitest + @testing-library/react precedent in this repo.
- `docs/portal-redesign-ref/_HANDOFF-README.md` explicitly anticipated this:
  the HTML prototypes are the design medium, to be recreated "in whatever
  technology makes sense (React, Vue, native)".

## Hard constraints

1. **Backend intact.** No `/api/*` route, body, or status code changes. The
   only allowed `main.py` edits are which HTML file a *page* route returns
   (`/`, `/onboarding`, `/settings`, `/agents`, `/requests`, `/tasks`,
   main.py:7603-7662) and, at the end, static-serving cleanup. Anything that
   would surface through `/openapi.json` is out of scope.
2. **No visual regression.** The token layer in `styles.css` (dark/light/auto
   via `[data-theme]` CSS custom properties) is kept verbatim; React components
   consume the same variables and class conventions. Pixel parity per page
   before its vanilla twin is deleted.
3. **Same deploy shape.** The portal Docker image bakes static files; the
   built React bundle lands under `static/dist/` (already served by the
   `/assets` StaticFiles mount, main.py:276). `docker compose build portal`
   stays the whole deploy story. No separate frontend container, no SSR.
4. **Working agreements hold.** Agent work stops at `needs_verification`;
   review protocol per `docs/orcha-review-protocol.md`; one page-flip per PR.

## Target architecture

```
orcha-cli/orcha_cli/templates/portal/
├── main.py                  # FastAPI — UNCHANGED except page-route file swaps
├── frontend/                # NEW — Vite + React + TS workspace
│   ├── package.json         # react, react-dom, react-router-dom, vite, vitest, ...
│   ├── vite.config.ts       # build.outDir → ../static/dist, base '/assets/dist/'
│   ├── tsconfig.json
│   ├── index.html           # SPA shell (becomes every page's HTML at the end)
│   └── src/
│       ├── main.tsx         # router: /, /tasks, /agents, /requests, /settings, /onboarding
│       ├── api/             # typed client over /api (shapes hand-derived from /openapi.json)
│       ├── hooks/           # useSnapshot (3s poll), useRunStream (SSE), useActingHuman, useTheme
│       ├── shell/           # Sidebar, Topbar, acting-as picker, notification center, modal, toast
│       ├── components/      # pills, badges, avatar, diff viewer (dfv), run card, log feed
│       └── pages/           # one dir per page, migrated in phase order
└── static/                  # vanilla originals — deleted page-by-page as React takes over
    └── dist/                # vite build output (baked into the image like any static file)
```

- **State:** React Query is NOT introduced; the portal's existing model (one
  container snapshot polled every 3s, mutated in place) maps to a single
  `useSnapshot()` context provider + plain `fetch` mutations. Keep it boring.
- **SSE:** `useRunStream(agentId, runId)` wraps the existing `EventSource`
  reconnect/monotonic-seq logic from `app.js` (`startRunStream`) as a hook.
- **Diff viewer:** the dfv widget ports to a `<FilesChanged>`
  component — same parser, tree, and CSS classes; React state replaces the
  keyed `diffViews` Map.
- **Terminal:** `terminal.js` + `vendor/xterm.js` wrap in a `<TerminalPane>`
  component (xterm has first-class imperative React usage; no rewrite).

## Phases (one PR each, independently shippable)

- **Phase 0 — scaffold.** `frontend/` workspace builds a placeholder React
  app into `static/dist/`; nothing user-visible changes (no page route touched).
  CI gains a `frontend` job (install, typecheck, vitest, build). Dockerfile
  gains a node build stage that produces `static/dist/` (with a fallback: if
  `dist/` is pre-built and committed, image build needs no node).
  *Verify:* `npm run build` emits dist; existing pytest suite still green;
  portal image builds and serves `/assets/dist/index.html`.
- **Phase 1 — Settings** (smallest page, 128-line HTML + settings.js 539).
  `/settings` returns the React shell; API-key CRUD + model config reach
  parity. *Verify:* Vitest component tests for key mutation gating (PR #315
  human-gate) + manual parity pass; `settings.html`/`settings.js` deleted.
- **Phase 2 — Requests** (335 + shared request-card logic). Priority ordering,
  render caps + "Load more" (ISS-68 PR-3), approve/deny actions.
- **Phase 3 — Home** (457). Action queue, attention grid, status pills.
- **Phase 4 — Agents** (869). Roster, agent detail, autonomy ladder (#298),
  model/runtime segments, persona editor.
- **Phase 5 — Tasks** (884 + conversation.js 837 + terminal.js 238 — the big
  one; split into 5a list/detail, 5b conversation + attachments, 5c runs feed:
  SSE stream, stop-run gate (SPEC-2 T2), files-changed viewer, terminal pane).
- **Phase 6 — Onboarding** (312 + onboarding.js 1,086; guided roster propose
  flow with its SSE clarify loop).
- **Phase 7 — decommission.** Delete `app.js`/`data.js` and remaining vanilla
  files; all page routes serve the SPA shell; `index.html` owns routing;
  update the static-content pytest suites (see below); update
  `docs/orcha-portal-design-brief.md` note that the vanilla mandate is retired.

## Test migration (the suites that pin the vanilla files)

`tests/test_d0_design_system.py`, `test_b1_run_feed.py`, `test_d6_live_feed.py`,
`test_iss68_frontend_lazy.py`, `test_iss44_linkify.py` (and friends) assert on
the *contents of the vanilla static files* and eval `app.js` under node. Each
phase that deletes a vanilla file must port the equivalent assertions to
Vitest/@testing-library (frontend CI) and trim the pytest side in the same PR —
never leave a pytest asserting on a deleted file, and never delete an assertion
without its Vitest replacement landing in the same diff.

## Deploy note

The portal image bakes files: after a change merges, rebuild the stack's portal
image (`docker compose build portal && up -d` in the project's `.orcha/`) and
hard-refresh — Phase 0's hashed Vite filenames give React pages proper asset
cache-busting.

## Status

All phases landed, 2026-08-05:

- [x] Plan authored (this doc)
- [x] Phase 0 — scaffold
- [x] Phases 1-6 — all six pages at vanilla parity (executed as one parallel
      page-port wave rather than sequential PRs; includes the live-terminal
      port, so no classic fallback remained necessary)
- [x] Phase 7 — decommission vanilla: page routes serve the SPA shell
      (BrowserRouter, clean URLs preserved), the 12 vanilla html/js files
      deleted (styles.css + vendor/ + dist/ remain), pytest suites migrated
      (node harnesses ported to Vitest; API/DB assertions untouched)
