"""Own the notifier subcommand lifecycle and long-running service loop."""

from __future__ import annotations


def cmd_notifier(args, *, services) -> None:
    """Run one notifier tick or the managed long-running daemon loop."""
    os = services.os
    signal = services.signal
    sys = services.sys
    time = services.time
    json = services.json
    pathlib = services.pathlib
    _DAEMON_LIVENESS_INTERVAL = services._DAEMON_LIVENESS_INTERVAL
    _load_master_key_from_env_file = services._load_master_key_from_env_file
    stop_daemon = services.stop_daemon
    ensure_daemon = services.ensure_daemon
    _api_and_cid = services._api_and_cid
    tick = services.tick
    _probe_container = services._probe_container
    _pid_path = services._pid_path
    _write_global_pid = services._write_global_pid
    reconcile_codex_conversation_runs = services.reconcile_codex_conversation_runs
    reap_workers = services.reap_workers
    reap_orphan_leases = services.reap_orphan_leases
    reap_orphaned_runs = services.reap_orphaned_runs
    reap_terminal_task_worktrees = services.reap_terminal_task_worktrees
    service_residents = services.service_residents
    _container_vanished = services._container_vanished
    _global_pid_path = services._global_pid_path
    cwd = pathlib.Path.cwd()
    # Make ORCHA_SECRET_KEY available so the daemon can unseal wake-path provider keys carried
    # (sealed) on the wake-scan. `orcha up` brings the daemon up without exporting it, so load it
    # from <project>/.orcha/.env here (best-effort; absent ⇒ daemon stays on its env keys).
    _load_master_key_from_env_file()

    # ISS-22 explicit operator verbs (NOT hooks — never auto-fired in a managed embodiment, so
    # they are not gated on ORCHA_HEADLESS_WORKER/ORCHA_LIVE the way --ensure is). Scoped to the
    # notifier daemon for THIS project's container — distinct from `orcha down` (whole stack).
    if getattr(args, "stop", False):
        stopped = stop_daemon(cwd, quiet=args.quiet)
        if not args.quiet and not stopped:
            print("[notifier] no running daemon for this project — nothing to stop")
        return
    if getattr(args, "restart", False):
        # stop the running daemon (bounded wait, SIGKILL after grace) then spawn a fresh one
        ensure_daemon(cwd, quiet=args.quiet, restart=True)
        return

    # `--ensure`: idempotent singleton spawn (used by init/up/SessionStart). Returns
    # immediately; the spawned child runs the loop below.
    if getattr(args, "ensure", False):
        # ISS-21 + R1/S3: a managed embodiment must NOT manage the daemon — skip the
        # SessionStart `notifier --ensure` hook inside a headless wake worker
        # (ORCHA_HEADLESS_WORKER, spawn_headless) or an S3 live terminal (ORCHA_LIVE, PTY bridge).
        if os.environ.get("ORCHA_HEADLESS_WORKER") or os.environ.get("ORCHA_LIVE"):
            if not args.quiet:
                kind = "headless worker" if os.environ.get("ORCHA_HEADLESS_WORKER") else "live terminal session"
                print(f"[notifier] {kind} — skipping notifier --ensure (managed embodiment doesn't manage the daemon)")
            return
        ensure_daemon(cwd, quiet=args.quiet)
        return

    api_base, cid = _api_and_cid(cwd, args.api_base, args.container)

    # Reachability backfill (PR #126) records headless_cwd = the daemon's cwd, then spawns a worker
    # there that must find THIS project's .claude config + orcha skills to drain the wake. Only
    # enable it when cwd is the project root FOR THE RESOLVED TARGET — i.e. its .claude/orcha.json
    # names the same api_base + container we're waking. Existence alone is NOT enough: in the
    # explicit --api-base/--container "run from anywhere" mode (systemd/demo) the daemon can be
    # launched from an UNRELATED Orcha project root whose cwd/config/skills belong to a different
    # container — backfilling that into the target container spawns a misconfigured worker and acks
    # the event as delivered yet undrained, LOSING the wake. On a mismatch (or no/!readable config)
    # we pass None and skip the pre-pass. The normal no-override daemon path resolves api_base+cid
    # FROM this same config, so it always matches and backfill stays on. [review P1 x2]
    project_cwd = None
    _cfg_path = cwd / ".claude" / "orcha.json"
    if _cfg_path.exists():
        try:
            _cfg = json.loads(_cfg_path.read_text())
            if ((_cfg.get("api_base_url") or "").rstrip("/") == api_base
                    and _cfg.get("current_container_id") == cid):
                project_cwd = str(cwd)
        except (OSError, ValueError):
            project_cwd = None

    if args.once:
        # --once is fire-and-forget: no live_workers, no reap_workers, so NOTHING releases
        # the single-flight lease early — only its TTL does. The 1200s hard-cap default is a
        # DAEMON concept (the watchdog manages long runs); in --once it would become a 20-min
        # wake-suppression window. Cap --once at a short lease so the stopgap stays responsive
        # (honors an explicitly-lower --lease-ttl).
        once_ttl = min(getattr(args, "lease_ttl", 1200.0), 300.0)
        tick(api_base, cid, dry_run=args.dry_run, cooldown=args.cooldown,
             min_idle=args.min_idle, quiet=args.quiet, lease_ttl=once_ttl, base_cwd=project_cwd)
        return

    # [#218 hardening] Refuse to start a daemon for a container this API definitively does
    # not know (HTTP 404) — that daemon would be a permanent no-op that still looks alive in
    # ps (stale orcha.json after a port/stack reshuffle, 2026-06-10 postmortem). A merely
    # UNREACHABLE API is tolerated after brief retries: `orcha up` may still be booting, and
    # wake-on-boot must not brick on a race. Runs BEFORE any pid/claim file is written.
    probe = _probe_container(api_base, cid)
    for _ in range(5):
        if probe != "unreachable":
            break
        time.sleep(2.0)
        probe = _probe_container(api_base, cid)
    if probe == "missing":
        sys.exit(f"[notifier] container {cid} does not exist at {api_base} — refusing to start "
                 f"a no-op daemon. This usually means a stale .claude/orcha.json (api_base_url/"
                 f"current_container_id from a previous stack). Fix the config or re-run "
                 f"`orcha connect <project>`.")

    stop = {"flag": False}

    def _handle(signum, frame):
        stop["flag"] = True

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)
    # Own the PID file so `--ensure` / `daemon_running` detect this loop and never
    # double-spawn (even when started directly rather than via ensure_daemon).
    pid_file = _pid_path(cwd)
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()))
    # own the container-keyed file too (cid resolved above) — a directly-started daemon
    # (not via --ensure) must still be visible to --ensure from OTHER worktrees
    _write_global_pid(cid, os.getpid(), cwd)
    if not args.quiet:
        print(f"[notifier] daemon up (pid {os.getpid()}) — scanning {api_base} every {args.interval}s "
              f"(cooldown={args.cooldown}s, min-idle={args.min_idle}s). Ctrl-C to stop.")
    live_workers: dict = {}   # {agent_id: pid} — for releasing leases on worker exit
    live_residents: dict = {}  # {conversation_id: resident-state} — E3 warm conversation sessions
    # GH#110: DAEMON-SCOPE continuity state (survives the per-reap live_workers.pop, so it persists
    # across a wake→fail→re-wake). failed_drains bounds the withheld-cursor task-worker path;
    # agent_hold_until is the Codex rate-limit cooldown that keeps tick from re-waking a still-
    # limited agent. Reset on daemon restart (a fresh N / cleared holds), which is acceptable.
    failed_drains: dict = {}       # {(agent_id, task_id): consecutive failed/rate-limited drains}
    agent_hold_until: dict = {}    # {agent_id: epoch-secs until the rate-limit hold-down lifts}
    swept_tasks: set = set()       # GH#110 §2c: terminal tasks whose durable worktree we reclaimed
    reconcile_codex_conversation_runs(api_base, cid, live_residents, quiet=args.quiet,
                                      base_cwd=str(cwd))
    # Issue #36: seed the liveness clock now (the startup probe just ran) so the first in-loop
    # re-check fires ~_DAEMON_LIVENESS_INTERVAL later, not redundantly on iteration one.
    last_liveness = time.monotonic()
    try:
        while not stop["flag"]:
            # Issue #36: the daemon resolved (api_base, cid) ONCE at startup and never re-checks.
            # When its container is later REPLACED (`orcha up` / `init --force`) or its orcha.json
            # goes stale, it would poll a now-404 container forever — an orphan that still reads as
            # a live `orcha notifier` in ps (the #36 postmortem found 4 daemons, 3 on dead
            # containers). Re-run the SAME definitive probe the startup refusal uses, on a slow
            # cadence, and self-terminate on a DEFINITIVE 'missing' (HTTP 404). A transient
            # 'unreachable' (API mid-restart during `orcha up`) is tolerated — see _container_vanished.
            now = time.monotonic()
            if now - last_liveness >= _DAEMON_LIVENESS_INTERVAL:
                last_liveness = now
                if _container_vanished(api_base, cid):
                    if not args.quiet:
                        print(f"[notifier] container {cid} no longer exists at {api_base} (HTTP "
                              f"404) — self-terminating this orphaned daemon (issue #36). The "
                              f"container was likely replaced (orcha up / init) or "
                              f".claude/orcha.json points at a previous stack.", file=sys.stderr)
                    break
            try:
                # Release leases of workers that finished since the last tick, BEFORE
                # scanning, so a just-finished agent with fresh work is wakeable now.
                reap_workers(api_base, live_workers, args.quiet,
                             stall_secs=getattr(args, "stall_secs", 120.0),
                             failed_drains=failed_drains, agent_hold_until=agent_hold_until)
                # ISS-60(B): TTL-independent backstop for an orphan lease that outlived its
                # embodiment (daemon restart / externally-spawned resident the in-memory
                # live_workers/live_residents maps no longer track, so neither reap path above
                # releases it). Heartbeat-keyed, so it never touches a live (heartbeating) one.
                reap_orphan_leases(api_base, cid, args.quiet)
                # #342: container-wide dead-pid sweep — reconcile orphaned EPHEMERAL (and any) runs
                # left status='running' by a PRIOR daemon whose Popen handles this process never
                # inherited. Keyed on the host os.kill(pid,0) (not lease/heartbeat state), so it
                # catches a run whose lease already expired — the gap reap_orphan_leases (live-lease
                # only) and the per-agent resident reaper (active-conversation only) both miss. Shield
                # THIS daemon's genuinely-live workers + residents from a racing os.kill.
                live_pids = frozenset(
                    w["proc"].pid for w in live_workers.values() if w.get("proc") is not None
                ) | frozenset(
                    r["proc"].pid for r in live_residents.values() if r.get("proc") is not None
                )
                reap_orphaned_runs(api_base, cid, live_pids, quiet=args.quiet)
                # GH#110 §2c: reclaim durable per-(agent+task) worktrees whose task went terminal
                # (completed/cancelled) so orcha/task-* trees don't accumulate forever — conservative
                # (never touches a live worktree, preserves any dirty tree, keeps committed/PR
                # branches). Daemon-scope swept_tasks bounds it to one pass per terminal task.
                reap_terminal_task_worktrees(api_base, cid, project_cwd, live_workers,
                                             swept_tasks, args.quiet, failed_drains=failed_drains)
                # E3: drive warm resident conversation sessions (capture replies, feed new turns,
                # idle-reap) BEFORE tick() — a live resident holds the embodiment lease, so the
                # ephemeral scan correctly suppresses a double-spawn for the same agent.
                service_residents(api_base, cid, live_residents, quiet=args.quiet,
                                  dry_run=args.dry_run, base_cwd=str(cwd))
                tick(api_base, cid, dry_run=args.dry_run, cooldown=args.cooldown,
                     min_idle=args.min_idle, quiet=args.quiet,
                     lease_ttl=getattr(args, "lease_ttl", 1200.0),
                     live_workers=live_workers, base_cwd=project_cwd,
                     agent_hold_until=agent_hold_until)
            except Exception as e:  # a daemon must not die on a transient error
                if not args.quiet:
                    print(f"[notifier] tick error (continuing): {e}", file=sys.stderr)
            slept = 0.0
            while slept < args.interval and not stop["flag"]:
                time.sleep(min(0.25, args.interval - slept))
                slept += 0.25
    finally:
        try:
            if pid_file.read_text().strip() == str(os.getpid()):
                pid_file.unlink()
        except (FileNotFoundError, ValueError, OSError):
            pass
        # drop the container claim too — but only if it's still OURS (a restart may
        # already have handed it to a replacement daemon)
        try:
            gp = _global_pid_path(cid)
            if gp.read_text().splitlines()[0].strip() == str(os.getpid()):
                gp.unlink()
        except (FileNotFoundError, ValueError, IndexError, OSError):
            pass
    if not args.quiet:
        print("[notifier] stopped.")
