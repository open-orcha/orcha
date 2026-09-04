# Orcha Cloud — repo overview (private)

This repo is the single home for Orcha Cloud: the full Orcha codebase (with the
not-yet-public sandbox runner) plus the cloud layer's docs and deployment code.

The open-core boundary: everything inside a team VM is open-source Orcha; the
fleet layer (auth, TLS, provisioning, billing, upgrades) is this repo and stays
closed.

**Start here for BYOC: [`docs/byoc-guide.md`](byoc-guide.md)** — the single
comprehensive guide (what BYOC is, architecture, automated-vs-manual matrix,
setup walkthrough, operations, security posture).

## State

- **Sandbox runner (sub-project 1): COMPLETE** — reviewed end-to-end, final
  verdict READY FOR DOGFOOD. Spec: `docs/superpowers/specs/2026-07-29-orcha-cloud-remote-runner-design.md`;
  plan + tracked follow-ups: `docs/superpowers/plans/2026-07-29-remote-runner.md`;
  operator docs: `docs/sandbox-mode.md`.
- **Auth perimeter (pulled forward into v1):** next up — Caddy TLS + GitHub-OAuth
  login for browsers + bearer-token lane for the iOS app and agents. Design doc
  forthcoming under `docs/`. No Tailscale.
- **Base:** this tree = public `open-orcha/orcha` main @ `98c1992` (incl. the
  #191 modularization refactor and #193) + the runner ported onto the modular
  layout (branch `feat/remote-runner-modular`, port reviewed and approved,
  full suite 1717 green) + `CLAUDE_CODE_OAUTH_TOKEN` passthrough for BYOC
  subscription auth. This branch is the future OSS PR, pending the dogfood
  week.

## Product tiers (three flows)

1. **Self-host (free, OSS)** — today's Orcha, DIY on your laptop or server.
2. **BYOC — bring your own VPC (paid)** — the customer hands us a VM in their
   cloud (SSH or a bootstrap script); our provisioner installs Docker +
   orcha-cli, brings up the stack, applies fleet upgrades, and fronts it with
   the auth perimeter. Everything on their VM is OSS Orcha; the product is the
   orchestration, upgrades, auth, and fleet visibility. Billing: platform fee
   (per workspace/seat) — we don't sell the machine. **Subscription-friendly:**
   the customer's own Claude Code subscription is legitimate here (their box,
   their seat). Sandbox containers get subscription auth via `claude
   setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in the daemon env (runner
   ENV_PASSTHROUGH — small change tracked on the runner backlog). Caveats: a
   token binds one individual seat with personal rate limits — fine for
   testing/small teams, not team-scale production throughput.
3. **Full cloud (paid)** — our rented VMs, all-inclusive; billing includes
   sandbox compute-hours.

The `deploy/` scripts for the dogfood box double as the BYOC bootstrap — same
compose, same proxy, pointed at whoever's machine. Provisioner consequence for
the control-plane spec: target arbitrary customer VMs, not only our pool.

## Layout

- `orcha-cli/` — the CLI + portal templates (Orcha proper, incl. sandbox mode)
- `docs/` — specs, plans, operator docs, cloud design docs
- `deploy/` — per-box deployment: bootstrap, auth perimeter (Caddy +
  oauth2-proxy), and the box-side systemd timers — `github-token-refresh`
  (workspace App tokens), `sync-members` (portal roster → OAuth allowlist), and
  `provision-projects` (portal-created projects get a workspace + notifier
  runtime; registry at `/opt/orcha-work/workspaces.list`). See
  `deploy/README.md` for setup and the provisioning behavior.
