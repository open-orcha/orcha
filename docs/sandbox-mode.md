# Sandbox mode

Sandbox mode runs agent wakes inside a disposable, resource-capped Docker
container instead of as a raw process on the notifier's host. The agent can no
longer read `~/.ssh`, browser profiles, or unrelated repos on the machine
running `orcha` — its filesystem view is only its own workspace (plus a
read-only api-config mount). On the network it keeps ordinary outbound access
(for the LLM provider API) and joins the stack's compose network to reach the
portal; restricting network egress is a tracked follow-up, not yet shipped.
Sandbox runs survive a notifier restart (the daemon re-adopts them via the
container name recorded on the run row instead of orphaning them), so closing
the laptop or running `orcha update` no longer kills in-flight work. Sandbox mode is
**opt-in per workspace** — host mode (a plain `claude -p` / `codex exec`
process, unchanged) remains the default.

## Enabling it

```bash
orcha sandbox status         # show the effective config (defaults filled in)
orcha sandbox on             # flip sandbox.enabled = true in .claude/orcha.json
orcha sandbox off            # flip it back
```

`on`/`off` do a read-modify-write of `.claude/orcha.json` — every other
top-level key, and any sandbox sub-keys you've already set (a custom `image`,
`memory`, and so on), are preserved untouched.

Sandbox mode needs three things present before wakes will succeed:

1. **Docker running** and reachable on the host (or VM) the notifier runs on.
2. **A provider API key in the daemon's environment.** The container receives
   credentials ONLY via env passthrough from the process that starts the
   notifier daemon (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
   `ORCHA_LLM_API_KEY`) — interactive host OAuth login state (`claude login` /
   `codex login`) does **not** reach the container. Export the key in the
   environment that starts the daemon, or sandbox wakes will fail auth.
   Subscription (BYOC) users can export a long-lived `claude setup-token`
   token as `CLAUDE_CODE_OAUTH_TOKEN` instead — it rides the same passthrough.
   `orcha sandbox status` warns when none of these is set.
3. **The runner image present** — either build it locally:

   ```bash
   orcha sandbox build-image
   ```

   which builds `orcha/runner:0.5` from the CLI's installed template (no
   project directory required), or pull the published image once it's
   available in a registry:

   ```bash
   docker pull orcha/runner:0.5
   ```

## Config reference

All keys live under the `sandbox` block in `.claude/orcha.json`. Unset keys
fall back to the defaults below; `orcha sandbox status` always prints the
effective (defaults-filled-in) config.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. `false` = host mode, unchanged. |
| `image` | `orcha/runner:0.5` | The Docker image each wake runs. |
| `memory` | `4g` | `docker run --memory` cap per container. |
| `cpus` | `2` | `docker run --cpus` cap per container. |
| `pids_limit` | `512` | `docker run --pids-limit` cap per container. |
| `max_runtime_secs` | `7200` (2h) | Wall-clock deadline; the reaper `docker stop`s a container still running past it. |
| `network` | *(derived)* | Docker network to attach the container to. If unset, derived as `<compose-name>_default` from `.orcha/docker-compose.yml`'s `name:` line — i.e. the stack's own compose network. Set explicitly only to override that. |

## Concurrency cap — budgeting the box (issue #75)

Nothing used to bound how many sandbox containers ran **at once**. During the
2026-08-01 OOM incident (F1), six agents each with a ready task spawned six
sandboxes within 11 seconds; an in-sandbox `npm ci` pushed the swapless 3.7 GB
box into a global kernel OOM at 14:52:56, and the machine thrashed to death.

The notifier now enforces a **box-wide budget on concurrent managed
containers**, checked at the *last moment* before every spawn (both one-shot
wakes and resident boots — a resident is a container too). Excess candidates are
**deferred**, not lost: they stay eligible and spawn on a later tick once a slot
frees. Work serializes; it never OOMs the box.

- **Ground truth, host-wide.** The count is live `orcha.managed` containers from
  `docker ps` across *every* workspace and daemon on the host (drain sidecars,
  `orcha.sidecar=1`, are excluded — they own no run row). It is **not**
  `orcha.cid`-scoped, so two Orcha stacks on one machine share one honest budget
  against the same physical RAM, and racing daemons can't double-book between
  ticks. A docker hiccup fails **open** (allow the spawn) — the reaper, not the
  cap, is the backstop for a genuine runaway.
- **Memory-derived default.** With no override, the cap self-adjusts to the box:

  ```
  max(1, (host_mem_mb - 2048) // sandbox_mem_mb)
  ```

  `host_mem_mb` is read from `/proc/meminfo` (`MemTotal`); the 2048 MiB reserve
  covers portal + db + system; `sandbox_mem_mb` is this workspace's `memory` cap
  (the same `sandbox.memory` key above). So the incident box (3.7 GB RAM, 4 GB
  per sandbox) budgets exactly **1** — precisely the bound the six-in-11s herd
  blew past. A 32 GB box with 4 GB sandboxes budgets 7, and so on. Floors at 1
  (a machine can always run one). On a host with no `/proc/meminfo` (non-Linux
  dev machines) it falls back to a fixed default of **2**.
- **Env override wins.** Set `ORCHA_MAX_CONCURRENT_SANDBOXES` in the notifier
  daemon's environment to a positive integer to pin the cap explicitly
  (garbage / values `< 1` are ignored, falling back to the derived default).
- **Deferral is logged once** per tick per deferred candidate (`[notifier]
  cap-deferred wake for <alias> …`) — visibility without per-second noise.

**Fairness (no starvation).** The server-side wake-scan already orders
candidates `ORDER BY created_at` (oldest agent first); a deferred candidate
stays eligible and re-competes in that same stable order next tick, so the
oldest waiting agent is served first — no queue of our own is needed.

## How it works

Each wake becomes one `docker run` instead of one host `Popen`:

- The container is named `orcha-run-<12 hex chars>` and labeled
  `orcha.managed=1`, `orcha.container_name=<name>`, and
  `orcha.cid=<current_container_id>` (the project's own container id from
  `.claude/orcha.json`) — the labels the reaper uses to find, adopt, and
  scope-limit its sweeps to *this* project's containers, even on a host
  running several Orcha stacks side by side.
- The project's workspace ROOT is bind-mounted **path-identically** — the same
  absolute path inside the container as on the host (e.g.
  `-v /opt/orcha-work/myproj:/opt/orcha-work/myproj`) — and `-w` is set to the
  actual spawn directory (the root, or a per-conversation/task git worktree
  under `<root>/.orcha-worktrees/`). Path-identity is load-bearing: a worktree's
  `.git` is a pointer *file* containing a host-absolute `gitdir:` path into the
  root checkout, and the git credential helper + `gh` wrapper read the root's
  `.orcha/github-token` — all of which would dangle under any path remap. The
  spawner also stamps `ORCHA_WORKSPACE_ROOT=<root>` into the container env,
  which is how the `gh` wrapper and credential helper locate the token file
  (both fall back to walking up from `$PWD` when the env is absent).
- A sandbox-scoped copy of `.claude/orcha.json` (with `api_base_url` rewritten
  to `http://portal:8000`) is bind-mounted read-only over the copy the agent
  reads: the spawn directory's `.claude/orcha.json` (and, for worktree spawns,
  the root's copy as well). The host's copy points at `localhost:<port>`, which
  is unreachable from inside a container, so this override is what lets the
  orcha skills (curl/Bash calls to the API) work unmodified.
- **Agent session state persists across containers**: the container's
  `~/.claude` (the agent CLI's home — session transcripts, hook and
  cross-session state) is bind-mounted from `<workspace-root>/.orcha/agent-home`
  on the host. That is what lets a resident conversation's pinned session
  `--resume` after a container restart — previously each container booted with
  an empty `~/.claude` and every resume died with "No conversation found with
  session ID". One-shot wakes share the same per-workspace home, so hook state
  and session context accrete across wakes. The dir is created (and best-effort
  chowned to the uid-1000 runner) *before* `docker run`; if it cannot be
  created the wake fails loudly rather than silently dropping the mount.
- The container joins the stack's compose network (`network`, above, unless
  overridden), so those same skill calls resolve `http://portal:8000` to the
  real portal service — no host networking, no published ports needed.
- Secrets and identity (`ORCHA_ALIAS`, `ORCHA_RUN_TOKEN`, `ANTHROPIC_API_KEY`,
  etc.) ride the **client process's environment** via `docker run -e KEY`
  (docker inherits the value from the process invoking it) — they are never
  written into argv, so they never show up in `ps` output on the host.

**The hard rule:** if Docker is unavailable, the runner image is missing, or
disk is low, the wake **fails loudly with a visible reason**. There is no
fallback path that quietly runs the wake on the host instead — de-sandboxing
is never something that happens silently on your behalf.

## Failure modes

| Situation | What happens |
|---|---|
| Docker daemon down / not installed | Preflight fails before the container starts; the wake fails with that reason surfaced (never falls back to host mode). |
| Runner image missing | Preflight fails with `runner image <image> not present — run \`docker pull <image>\` (or \`orcha sandbox build-image\`)`. |
| Disk low (< 5 GiB free on the workspace volume) | Preflight fails with an insufficient-disk reason before spawning. |
| Out of memory | Docker OOM-kills the container; the reaper reads `OOMKilled` from `docker inspect` and stamps the run `killed` with reason "out of memory — raise sandbox.memory". |
| Too many concurrent sandboxes | The spawn is **deferred** (not failed): the box is already at its concurrency budget (see *Concurrency cap* above). The candidate stays eligible and spawns on a later tick once a slot frees; the notifier logs one `cap-deferred` line. Raise the budget with `ORCHA_MAX_CONCURRENT_SANDBOXES` or move to a bigger box. |
| Past its runtime deadline | A container still `running` older than `max_runtime_secs` gets `docker stop`'d by the reaper; the *next* sweep stamps the run from its real exit code once it has actually exited. |
| Orphaned container | A live, managed container with no open `worker_runs` row referencing it gets stopped (never removed) by the reaper's per-sweep orphan pass — scoped to this project's `orcha.cid` label, so it never touches another stack's containers on the same host. |
| Notifier/daemon restart mid-run | The sweep treats a live container whose row is still `running` as **adopted**, not orphaned — it is left alone and reconciled from its real state on a later sweep. Runs are never killed just because the daemon that spawned them restarted. |
| Docker daemon itself unreachable during a sweep | The sweep reconciles nothing that tick (no probes, no finishes, no stops) — an unreachable daemon is treated as "unknown", not "everything's gone", so it can never mass-kill in-flight runs. |
| Workspace volumes | Never auto-deleted, in any of the above. A stopped/removed container's workspace persists so its state survives the reap. |

## Notes

- **Containers run as a non-root user (uid 1000, the image's `node` user)** —
  Claude Code hard-refuses `--dangerously-skip-permissions` under root, and
  least-privilege is the right default anyway. On Linux hosts the bind-mounted
  workspace must therefore be **writable by uid 1000** (chown it, as the BYOC
  provisioner does); Docker Desktop on macOS/Windows maps ownership
  transparently, so laptop self-hosters need no chown.
- **The runner image bundles the latest Claude Code and Codex CLIs as of
  build time** (`npm install -g @anthropic-ai/claude-code @openai/codex` in
  the Dockerfile) — it does not auto-update. Re-run `orcha sandbox
  build-image` (or re-pull the published tag) to refresh them.
- **Durability**: because a sandbox run is reconciled from its recorded
  container name on the run row rather than from a live process handle, a
  notifier restart re-adopts every live sandbox run it finds — nothing needs
  to be resumed manually. (The `orcha.*` labels serve the orphan pass: finding
  live containers no open run row references.)
