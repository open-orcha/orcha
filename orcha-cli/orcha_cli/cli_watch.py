"""Run and stop the per-session background inbox watcher."""
from __future__ import annotations

import argparse
import json
import os
import pathlib

def cmd_watch(args: argparse.Namespace, services) -> None:
    """Orcha#33: per-session background watcher (polls every 10s by default).

    Polls `/api/agents/<aid>/inbox` + `/api/agents/<aid>/outbox?status=answered`
    for the bound AI agent. Items whose request_id isn't in `seen_ids` get
    queued for the next PostToolUse hook fire (which is just a file read —
    no API call from inside Claude's reasoning loop).

    Process model:
      • `--detach`: fork, parent returns immediately (so SessionStart can finish);
        child runs the loop. macOS/Linux only.
      • Exits when the parent Claude process dies (PID watch). Belt: also exits
        on SIGTERM from `orcha unwatch`.

    Silent no-op for: no .claude/orcha.json, no resolvable binding, kind='human'
    (humans don't get the automated nag), an existing live watcher for this alias.
    """
    if services._skip_managed_embodiment_hook("watch"):   # ISS-21: the poller would wedge a one-shot worker
        return
    import signal
    import time

    cwd = pathlib.Path.cwd()
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        return
    try:
        config = json.loads(config_path.read_text())
        api_base = config.get("api_base_url")
        if not api_base:
            return
    except Exception:
        return

    binding = services._resolve_any_binding(cwd, args.alias)
    if not binding or binding.get("kind") == "human":
        return
    agent_id = binding.get("agent_id")
    alias = binding.get("alias")
    if not agent_id or not alias:
        return

    pid_path = services._watch_pid_path(cwd, alias)
    # If a live watcher is already running for this alias, this is a no-op.
    if pid_path.exists():
        try:
            old_pid = int(pid_path.read_text().strip())
            os.kill(old_pid, 0)
            return  # already running
        except (ValueError, ProcessLookupError, PermissionError):
            try:
                pid_path.unlink()
            except FileNotFoundError:
                pass

    parent_pid = os.getppid()

    if args.detach:
        # Fork; parent returns so the hook command completes promptly.
        try:
            pid = os.fork()
        except OSError:
            # No fork on this platform — fall through and run inline.
            pid = 0
        if pid > 0:
            return
        # Child: detach from controlling terminal so the loop survives session end
        # gracefully (we still rely on parent_pid watch to actually exit).
        try:
            os.setsid()
        except OSError:
            pass

    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(str(os.getpid()))

    stop_requested = False

    def _handle_term(signum, frame):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)

    inbox_url = f"{api_base}/api/agents/{agent_id}/inbox"
    outbox_url = f"{api_base}/api/agents/{agent_id}/outbox?status=answered"
    try:
        while not stop_requested:
            # Exit cleanly when Claude (the parent) is gone — keeps stale watchers
            # from accumulating across `claude` invocations in the same folder.
            try:
                os.kill(parent_pid, 0)
            except ProcessLookupError:
                break

            inbox = services._get_json(inbox_url, timeout=3.0) or {}
            outbox = services._get_json(outbox_url, timeout=3.0) or {}

            state = services._read_watch_state(cwd, alias)
            seen = set(state["seen_ids"])
            queued = state["queued"]
            had_new = False

            for r in inbox.get("open_requests") or []:
                rid = r.get("id")
                if rid and rid not in seen:
                    queued.append({
                        "channel": "inbox",
                        "id": rid,
                        "type": r.get("type", "info"),
                        "priority": r.get("priority"),
                        "from": r.get("requester_alias"),
                        "preview": (r.get("payload") or "")[:160],
                        "chain_depth": r.get("chain_depth") or 0,
                        "created_at": r.get("created_at"),
                    })
                    seen.add(rid)
                    had_new = True

            for r in outbox.get("outgoing_requests") or outbox.get("requests") or []:
                rid = r.get("id")
                if rid and rid not in seen:
                    queued.append({
                        "channel": "outbox-answered",
                        "id": rid,
                        "type": r.get("type", "info"),
                        "to": r.get("target_alias"),
                        "preview": (r.get("payload") or "")[:160],
                        "answer_preview": (r.get("response") or "")[:160],
                        "responded_at": r.get("responded_at"),
                    })
                    seen.add(rid)
                    had_new = True

            if had_new:
                services._atomic_write_json(services._watch_state_path(cwd, alias), {
                    "seen_ids": sorted(seen),
                    "queued": queued,
                })

            # Sleep in short slices so SIGTERM is responsive.
            slept = 0.0
            while slept < args.interval and not stop_requested:
                time.sleep(min(0.5, args.interval - slept))
                slept += 0.5
                try:
                    os.kill(parent_pid, 0)
                except ProcessLookupError:
                    stop_requested = True
                    break
    finally:
        try:
            current = int(pid_path.read_text().strip())
            if current == os.getpid():
                pid_path.unlink()
        except (FileNotFoundError, ValueError, PermissionError):
            pass


def cmd_unwatch(_: argparse.Namespace) -> None:
    """Orcha#33: SessionEnd partner — SIGTERM the watcher(s) in this folder.

    Targets the per-alias PID files written by `orcha watch`. Silent no-op if
    no PID file exists or the pid is stale.
    """
    import signal
    cwd = pathlib.Path.cwd()
    claude_dir = cwd / ".claude"
    if not claude_dir.exists():
        return
    for pid_path in claude_dir.glob(".orcha-watch-*.pid"):
        try:
            pid = int(pid_path.read_text().strip())
        except (ValueError, OSError):
            try:
                pid_path.unlink()
            except FileNotFoundError:
                pass
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            pid_path.unlink()
        except FileNotFoundError:
            pass
