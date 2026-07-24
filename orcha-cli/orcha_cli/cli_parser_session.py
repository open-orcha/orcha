"""Define agent session and hook subcommands for the Orcha command-line parser."""

from __future__ import annotations

import argparse
from collections.abc import Callable


def register_session_commands(
    sub: argparse._SubParsersAction,
    handlers: dict[str, Callable],
) -> None:
    """Register watcher, session, continuity, and self-wake commands."""
    poll = sub.add_parser(
        "poll-inbox",
        help="PostToolUse hook entry — drains the background watcher's queue into "
        "Claude's next-turn context (Orcha#33). Cheap file read, not an API "
        "call; the actual polling lives in `orcha watch`.",
    )
    poll.add_argument(
        "--alias",
        default=None,
        help="binding to use (overrides $ORCHA_ALIAS and single-binding fallback)",
    )
    poll.add_argument(
        "--min-interval",
        type=float,
        default=5.0,
        help="[deprecated] accepted for back-compat with older settings.json; ignored "
        "now that polling moved to `orcha watch`",
    )
    poll.set_defaults(func=handlers["poll-inbox"])

    conv_guard = sub.add_parser(
        "conv-guard",
        help="PreToolUse hook entry (GH #91/#90) — when ORCHA_CONVERSATION_WORKER=1, denies the "
        "task-claim/mutation path (/orcha-next, /orcha-accept-task, /orcha-done, "
        "/orcha-self-wake, Edit/Write/NotebookEdit) so a conversation embodiment stays a "
        "responder. No-op otherwise.",
    )
    conv_guard.set_defaults(func=handlers["conv-guard"])

    watch = sub.add_parser(
        "watch",
        help="background per-session poller (Orcha#33). Polls inbox + answered "
        "outbox every --interval seconds; queues new items for the PostToolUse "
        "hook to surface. SessionStart hook spawns `orcha watch --detach`; "
        "SessionEnd kills it via `orcha unwatch`.",
    )
    watch.add_argument(
        "--alias",
        default=None,
        help="binding to watch (overrides $ORCHA_ALIAS and single-binding fallback)",
    )
    watch.add_argument(
        "--interval",
        type=float,
        default=10.0,
        help="seconds between API polls (default 10.0)",
    )
    watch.add_argument(
        "--detach",
        action="store_true",
        help="fork to background and exit the parent immediately (used by SessionStart)",
    )
    watch.set_defaults(func=handlers["watch"])

    unwatch = sub.add_parser(
        "unwatch",
        help="SessionEnd partner — SIGTERMs any `orcha watch` running in this folder.",
    )
    unwatch.set_defaults(func=handlers["unwatch"])

    rehydrate = sub.add_parser(
        "rehydrate",
        help="Epic C SessionStart brief — detect the stack, rebind the alias, and "
        "print a 'where we left off' summary (tasks + inbox/outbox + memory "
        "digest) into Claude's context. Runs ALONGSIDE `orcha watch`; silent "
        "no-op outside an Orcha project.",
    )
    rehydrate.add_argument(
        "--alias",
        default=None,
        help="binding to rehydrate (overrides $ORCHA_ALIAS and single-binding fallback)",
    )
    rehydrate.set_defaults(func=handlers["rehydrate"])

    use = sub.add_parser(
        "use",
        help="print `export ORCHA_ALIAS=<alias>` for eval into your shell "
        '(ssh-agent idiom): `eval "$(orcha use Vault)"` so /orcha-* skills '
        "resolve to that agent without --alias.",
    )
    use.add_argument(
        "alias", help="the registered agent alias this shell should act as"
    )
    use.set_defaults(func=handlers["use"])

    snapshot = sub.add_parser(
        "snapshot",
        help="Epic C / C1: digest write-on-exit. Registered as a SessionEnd hook; a "
        "woken headless worker (ORCHA_HEADLESS_WORKER=1) snapshots a continuity "
        "digest before exiting. Immediate no-op for interactive tabs (they author "
        "via /orcha-snapshot). Reads the hook JSON payload on stdin.",
    )
    snapshot.add_argument(
        "--alias",
        default=None,
        help="binding to snapshot (overrides $ORCHA_ALIAS and single-binding fallback)",
    )
    snapshot.set_defaults(func=handlers["snapshot"])

    claim_guard = sub.add_parser(
        "task-claim-guard",
        help="GH #152 SessionEnd hook — audits the session's last reply for a "
        "task-creation claim ('I created/started task <id>') that never actually "
        "persisted, and hard-fails loudly (digest override + thread flag / human "
        "escalation) on a mismatch. Fast no-op when no claim is present.",
    )
    claim_guard.add_argument(
        "--alias",
        default=None,
        help="binding to audit (overrides $ORCHA_ALIAS and single-binding fallback)",
    )
    claim_guard.set_defaults(func=handlers["task-claim-guard"])

    self_wake = sub.add_parser(
        "self-wake",
        help="schedule or cancel a one-shot resume wake for an in-progress task",
    )
    self_wake.add_argument(
        "task_id",
        nargs="?",
        help="task id to resume; for cancellation, may also be passed after --cancel",
    )
    self_wake.add_argument(
        "--in",
        dest="delay",
        default=None,
        help="delay before waking, such as 90s, 10m, or 2h",
    )
    self_wake.add_argument(
        "--context",
        default=None,
        help="short non-empty wait-point to inject into the wake",
    )
    self_wake.add_argument(
        "--cancel",
        dest="cancel_task_id",
        nargs="?",
        const="",
        help="cancel this task's scheduled self-wake",
    )
    self_wake.add_argument(
        "--all",
        action="store_true",
        help="with --cancel, cancel every scheduled self-wake for the acting agent",
    )
    self_wake.add_argument(
        "--alias",
        default=None,
        help="binding to use (overrides $ORCHA_ALIAS and single-binding fallback)",
    )
    self_wake.set_defaults(func=handlers["self-wake"])
