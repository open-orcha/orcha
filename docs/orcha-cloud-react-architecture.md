# Orcha Cloud frontend architecture — open Orcha as the SDK base

> Model: **open Orcha is the base; Cloud is an overlay.** The React portal
> frontend ships in open Orcha (`templates/portal/frontend/`) and Cloud vendors
> it **verbatim**, owning exactly two seams. Upstream changes flow into Cloud
> with one script run — no fork-merge archaeology.

## Ownership map

| Path (under `templates/portal/`) | Owner | Notes |
|---|---|---|
| `frontend/src/**` (everything not listed below) | **open Orcha** | never hand-edited in Cloud — replaced wholesale on sync |
| `frontend/src/extensions.ts` | **Cloud** | the registry: premium routes + nav; a route sharing a path with an open page **overrides** it (access-model landing owns `/`) |
| `frontend/src/cloud/**` | **Cloud** | premium pages: projects, metrics, github, device, members (+ their css) |
| `static/styles.css` + `static/styles/**` + `static/fonts/**` | **Cloud** | the premium skin — the open shell links `/assets/styles.css` at runtime, so Cloud's modular entrypoint (same class contract) skins the shared base |
| `static/dist/**` | build artifact | rebuilt after every sync or cloud change; committed (image builds need no node) |
| `portal_backend/**`, `main.py` | **Cloud** | premium API surface (Slack, members, github, metrics, device); page routes serve `dist/index.html` |
| `static/vendor/**` | open Orcha | xterm, synced with the frontend |

## Updating from open Orcha

```bash
tools/sync-open-frontend.sh [path-to-open-orcha-checkout]
# then: review the diff, run the verification battery, commit.
```

The script copies `frontend/` (minus `node_modules`, minus the two Cloud-owned
seams) + `static/vendor/` from the open checkout, reinstalls if the lockfile
changed, rebuilds `static/dist/`, and runs the frontend suite. Cloud-owned
files are never touched, so the diff is pure upstream delta.

Verification battery after a sync:

```bash
cd orcha-cli/orcha_cli/templates/portal/frontend
npx tsc --noEmit && npx vitest run && npm run build
cd <repo root> && .venv-test/bin/pytest   # cloud suite
```

## Why not a package dependency (yet)

The end state is open Orcha publishing the frontend as an npm package (and
`orcha-cli` as a pip dependency) so Cloud pins versions instead of vendoring.
Vendor-with-a-script is the stepping stone: it establishes the ownership
boundary and the one-command update flow now, without blocking on open-orcha
release infrastructure. When packages exist, `sync-open-frontend.sh` retires
into a version bump.

## Extension seam contract (open side)

Open Orcha guarantees (see its `frontend/src/extensions.ts` header):
- `extensions.routes` mount extra pages; same-path routes override open pages.
- `extensions.nav` adds sidebar entries (between Requests and Settings).
- Registered components render inside the providers and wrap in `<Shell>`.

Anything Cloud needs beyond this (e.g. a Settings-section injection point,
snapshot-shape extensions) gets added to the seam **upstream first**, then
consumed here — the seam only ever widens, so syncs stay conflict-free.

## Premium deltas checklist

`docs/react-portal-premium-deltas.md` inventories every cloud-only behavior on
the shared surfaces at adoption time. Anything not yet re-implemented in
`src/cloud/**` or upstreamed is tracked there — nothing premium disappears
silently.
