# Open-core SDK plan — consuming open-orcha as a dependency instead of a fork

**Status:** approved direction (2026-08-01) · Phase 0 in effect · Phase 1 issues filed upstream
**Problem owner:** hussein-quant · **Doc owner:** whoever touches the fork boundary next

## The problem

orcha-cloud is a fork of open-orcha/orcha with cloud commits on top. Every upstream
change must be merged into the fork (conflict-prone in shared files), and every
cloud feature that is generic must be re-built as an upstream PR ("double PRs").
The question this doc answers: can orcha-cloud consume open-orcha as an SDK — a
pinned dependency plus a cloud package — so upstream releases become version bumps
instead of merges?

## Evidence: where the divergence actually lives

Measured at 2026-08-01 (merge-base `98c1992`, upstream `origin/main` vs `cloud/main`):

| Kind | Files | Meaning |
|---|---|---|
| Added | 168 | Cleanly separable: `deploy/` (perimeter, provisioner, timers), new routes, welcome page, cloud docs, new tests |
| **Modified** | **177** | **The coupling.** 48 `portal_backend`, 37 CLI core, 35 portal frontend, 32 iOS, 18 tests |
| Deleted | 30 | Mostly vendored assets replaced by self-hosted ones |

The 177 modified shared files are why upstream merges hurt (field example: upstream
#191's CSS file-split silently broke the Swiss light theme in the fork). A straight
`pip install`-style swap is not possible today — but the modifications follow three
patterns, each with a known seam.

## The three coupling patterns and their seams

### 1. Identity/authorization threading (backend — most of the 48 edits)

Cloud weaves `trusted_actor()` (proxy-verified GitHub identity) and
`enforce_grant()` (roles owner/member/viewer + grants, mig 039) into ~30
pre-existing endpoints.

**Seam:** upstream grows a *pluggable auth provider* interface: a request-scoped
`actor_resolver(request, cid, fallback_actor_id)` and an
`authorize(actor, action, cid)` hook with default permissive implementations
(today's self-host behavior, bit-identical). Cloud injects its GitHub-identity +
grants implementations at app assembly. Every self-hoster wanting SSO/OIDC or
per-member permissions benefits — this is an attractive upstream feature on its
own, not vendor plumbing. *(Filed upstream — see "Phase 1 issues" below.)*

### 2. Portal frontend edits (35 files — the hard layer)

The portal is vanilla JS with no plugin system, so cloud edits shared files
directly (members UI, identity chips, projects hub, pairing, prefs). This is
where fork maintenance bleeds most.

**Seam:** an upstream *portal extension convention*: (a) core loads an optional
`extensions/` bundle after its own modules; (b) stable registries/hook points on
the existing page namespaces (`TasO`-style) — nav items, settings tabs, card
row-actions, detail-page sections; (c) a documented "extensions may not patch
core files" rule enforced by a guard test. Cloud's UI moves into its bundle
incrementally. *(Filed upstream.)*

### 3. Migration numbering (cheap, urgent)

Cloud migrations 034–043 share upstream's single sequence; upstream's next 034
collides. **Seam:** downstream migration namespacing — a second migrations
directory with its own tracking table (`cloud_schema_migrations`), applied after
core's. No upstream cooperation strictly required (the runner change is small and
generic; still worth upstreaming so every distribution gets it). *(Filed upstream;
cloud adopts a namespaced directory immediately regardless.)*

### What is already SDK-shaped

- `deploy/` (auth perimeter, GitHub App tooling, provisioner, timers): zero
  coupling — shell + compose around the portal's public API.
- New backend routes (device tokens, push, metrics, user prefs, members):
  FastAPI routers compose; they only *entangle* via pattern 1.
- CLI-core edits (37): mixed — several already upstreamed (markdown, sandbox
  mounts lineage); the rest are either genuinely generic (upstream them) or
  belong behind a persona/config seam that already exists (workspace-gated
  guidance blocks).
- iOS (32 modified): out of scope for the first SDK pass; later it becomes an
  upstream Swift package + a cloud app target.

## The honest limits

- **Double PRs don't fully disappear.** Generic *fixes* should still go upstream
  — that's open-core citizenship. What disappears is (a) re-porting upstream's
  evolution into the fork and (b) cloud-porting our own upstream features.
- **Seams freeze interfaces.** Flipping now, mid-feature-storm, would constrain
  upstream velocity exactly when it's most valuable. The flip happens when the
  seams have existed for a few releases and stopped moving.

## Phases

**Phase 0 — fork discipline (in effect now, costs nothing):**
- New cloud backend code lands in separated modules (`portal_backend/cloud_*.py`
  or a `cloud/` package); new frontend code in `static/cloud/`; shared-file edits
  only when composition is impossible, each marked `# CLOUD:` for future extraction.
- Adopt the namespaced migrations directory for all future cloud migrations.
- Upstream merges continue on a regular cadence; the shrinking shared-file diff
  is the progress metric (track the `M` count from the command in the appendix).

**Phase 1 — land the seams upstream (opportunistic, ordered by ROI):**
1. Auth provider interface (kills the biggest class of shared-file edits)
2. Portal extension convention (kills the hardest class)
3. Migration namespacing (kills the collision risk)
Each ships as a normal open-orcha contribution with default behavior unchanged.

**Phase 2 — the flip (after seams stabilize):**
- orcha-cloud pins `orcha-cli` as a dependency; the repo shrinks to the cloud
  package (auth impl, grants, cloud routes, UI bundle, `deploy/`, iOS target).
- Upstream release → bump pin → run cloud smoke suite → deploy. No merges.
- Exit criterion for the flip: two consecutive upstream releases consumed with
  zero shared-file conflicts under Phase 0 discipline.

## Appendix — divergence measurement

```sh
MB=$(git merge-base origin/main cloud/main)
git diff --name-status $MB cloud/main | awk '{print $1}' | sort | uniq -c
git diff --name-status $MB cloud/main | grep '^M' | awk '{print $2}' | sort   # the shrink list
```
