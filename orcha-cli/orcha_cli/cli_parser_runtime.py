"""Define notifier, terminal, and container-control CLI subcommands."""

from __future__ import annotations

import argparse
from collections.abc import Callable


def register_runtime_commands(
    sub: argparse._SubParsersAction,
    handlers: dict[str, Callable],
) -> None:
    """Register reachability, daemon, bridge, and container state commands."""
    reach = sub.add_parser(
        "reachability",
        help="Epic A: record this session's bound-agent reachability (headless_cwd + tmux "
        "pane if any) so the notifier daemon can wake it. Registered as a SessionStart "
        "hook by init; also run by /orcha-register-agent. Silent no-op outside an Orcha project.",
    )
    reach.add_argument(
        "--alias",
        default=None,
        help="binding to record (overrides $ORCHA_ALIAS and single-binding fallback)",
    )
    reach.add_argument("--quiet", action="store_true", help="suppress output")
    reach.set_defaults(func=handlers["reachability"])

    enable = sub.add_parser(
        "enable-hook",
        help="register the SessionStart + SessionEnd + PostToolUse hooks in this "
        "folder's .claude/settings.json (idempotent). orcha init/connect do "
        "this automatically; use this for folders that pre-date Orcha#33.",
    )
    enable.set_defaults(func=handlers["enable-hook"])

    notifier = sub.add_parser(
        "notifier",
        help="Epic A wake daemon — wakes IDLE agents out-of-band (tmux send-keys or "
        "`claude -p`) when they have pending events or an assigned ready task, so "
        "they resume without a human nudge. `--once` is the phase-0 cron stopgap; "
        "no flag runs the long-running daemon. NON-AI; never self-certifies.",
    )
    notifier.add_argument(
        "--once",
        action="store_true",
        help="run a single scan-and-wake tick and exit (the cron stopgap)",
    )
    notifier.add_argument(
        "--ensure",
        action="store_true",
        help="start the daemon detached iff one isn't already running (idempotent "
        "singleton; used by `orcha init`/`up` + the SessionStart hook)",
    )
    notifier.add_argument(
        "--restart",
        action="store_true",
        help="ISS-22: stop the running daemon for this project's container "
        "(bounded wait, SIGKILL after an ~8s grace) then start a FRESH one — "
        "use after host-CLI/runtime changes",
    )
    notifier.add_argument(
        "--stop",
        action="store_true",
        help="ISS-22: stop the notifier daemon for this project's container and exit "
        "(no-op with a clear message if none is running). Distinct from `orcha "
        "down`, which tears down the whole stack",
    )
    notifier.add_argument(
        "--dry-run",
        action="store_true",
        help="print wake decisions + the exact transport command WITHOUT "
        "sending keystrokes, spawning claude, or advancing any cursor",
    )
    notifier.add_argument(
        "--interval",
        type=float,
        default=2.0,
        help="daemon loop seconds between scans (default 2.0; ignored with --once)",
    )
    notifier.add_argument(
        "--cooldown",
        type=float,
        default=15.0,
        help="per-agent seconds to wait before re-waking (debounce; default 15)",
    )
    notifier.add_argument(
        "--min-idle",
        type=float,
        default=30.0,
        help="only wake an agent whose last heartbeat is older than this many "
        "seconds, i.e. it looks idle/quiescent (default 30)",
    )
    notifier.add_argument(
        "--lease-ttl",
        type=float,
        default=1200.0,
        help="R2.4 single-flight + ISS-31 hard-cap backstop: seconds a headless "
        "worker's exclusive wake lease is held (no second worker spawns until "
        "it exits/is-killed, releasing early). Generous so a slow-but-progressing "
        "worker isn't reaped mid-work; default 1200 (20 min)",
    )
    notifier.add_argument(
        "--stall-secs",
        type=float,
        default=120.0,
        help="ISS-31: kill a headless worker only if its stream-json log hasn't grown "
        "for this many seconds (genuinely stalled) — NOT at a fixed deadline, so "
        "a worker that's still producing output runs to completion (default 120)",
    )
    notifier.add_argument(
        "--api-base",
        default=None,
        help="override the API base URL (default: from .claude/orcha.json)",
    )
    notifier.add_argument(
        "--container",
        default=None,
        help="override the container_id (default: current_container_id)",
    )
    notifier.add_argument(
        "--quiet", action="store_true", help="suppress per-tick output"
    )
    notifier.set_defaults(func=handlers["notifier"])

    bridge = sub.add_parser(
        "terminal-bridge",
        help="S3 §3b: run the host-side PTY/websocket bridge for the LIVE embedded-terminal "
        "embodiment. The portal's xterm panel connects here; the bridge claims the agent's "
        "`live` lease, provisions an isolated worktree, spawns `orcha use <agent>` in a PTY, "
        "and relays stdio. Localhost/trusted-local only.",
    )
    bridge.add_argument("--host", default=None, help="bind host (default 127.0.0.1)")
    bridge.add_argument(
        "--port", type=int, default=None, help="bind port (default 8765)"
    )
    bridge.add_argument(
        "--api-base",
        default=None,
        help="override the API base URL (default: from .claude/orcha.json)",
    )
    bridge.add_argument(
        "--quiet", action="store_true", help="suppress per-session output"
    )
    bridge.add_argument(
        "--ensure",
        action="store_true",
        help="idempotent singleton spawn (used by up/init/SessionStart); returns immediately",
    )
    bridge.set_defaults(func=handlers["terminal-bridge"])

    sbx = sub.add_parser(
        "sandbox",
        help="opt-in sandbox mode: run agent wakes inside an isolated `orcha/runner` Docker "
        "container instead of directly on the host (see docs/sandbox-mode.md).",
    )
    sbx.add_argument(
        "action",
        choices=["on", "off", "status", "build-image"],
        help="on/off toggle .claude/orcha.json's sandbox.enabled (preserving other config); "
        "status prints the effective sandbox config; build-image builds the orcha/runner "
        "image from the CLI's installed template (no project required).",
    )
    sbx.set_defaults(func=handlers["sandbox"])

    pause = sub.add_parser(
        "pause",
        help="pause an Orcha container (the project/milestone entity in the current project's DB). "
        "Uses .claude/orcha.json from CWD to find the API.",
    )
    pause.add_argument(
        "container_id",
        nargs="?",
        default=None,
        help="UUID of the Orcha container; defaults to current_container_id from .claude/orcha.json",
    )
    pause.set_defaults(func=handlers["pause"])

    resume = sub.add_parser(
        "resume",
        help="resume a paused Orcha container (sets status back to active)",
    )
    resume.add_argument(
        "container_id",
        nargs="?",
        default=None,
        help="UUID of the Orcha container; defaults to current_container_id from .claude/orcha.json",
    )
    resume.set_defaults(func=handlers["resume"])

    stop = sub.add_parser(
        "stop",
        help="mark an Orcha container completed (or --cancel for cancelled). "
        "NOTE: this does NOT stop the Docker stack — use `orcha down` for that.",
    )
    stop.add_argument(
        "container_id",
        nargs="?",
        default=None,
        help="UUID of the Orcha container; defaults to current_container_id from .claude/orcha.json",
    )
    stop.add_argument(
        "--cancel", action="store_true", help="mark cancelled instead of completed"
    )
    stop.set_defaults(func=handlers["stop"])
