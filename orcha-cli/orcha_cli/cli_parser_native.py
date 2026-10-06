"""Parser entries for the native runtime (GH #258 PR 6): `orcha serve` and `orcha logs`;
PR 11: `orcha backup` and `orcha restore`; PR 10: `orcha service` and `orcha doctor`."""
from __future__ import annotations

from collections.abc import Callable


def register_native_commands(sub, handlers: dict[str, Callable]) -> None:
    serve = sub.add_parser(
        "serve",
        help="supervise a native-runtime project's portal, notifier and terminal bridge "
        "in the foreground (restarts crashed children; `orcha up` starts it for you)",
    )
    serve.add_argument("--project-dir", default=None, help="project root (default: the current directory)")
    serve.add_argument("--no-bridge", action="store_true", help="do not run the terminal bridge")
    serve.set_defaults(func=handlers["serve"])

    logs = sub.add_parser("logs", help="show a native-runtime project's logs (.orcha/logs/)")
    logs.add_argument("child", nargs="?", choices=("serve", "portal", "notifier", "bridge"),
                      help="one log (default: all that exist)")
    logs.add_argument("-f", "--follow", action="store_true", help="keep printing new lines")
    logs.add_argument("-n", "--lines", type=int, default=50, help="lines of history to print (default 50)")
    logs.add_argument("--project-dir", default=None, help="project root (default: the current directory)")
    logs.set_defaults(func=handlers["logs"])

    bak = sub.add_parser(
        "backup",
        help="copy a native project's database to .orcha/backups/ (safe while Orcha runs; "
        "keeps the newest 10)",
    )
    bak.add_argument("--out", default=None, help="write the backup to this file instead (no pruning)")
    bak.add_argument("--keep", type=int, default=10, help="backups to keep in .orcha/backups (default 10)")
    bak.add_argument("--json", action="store_true", help="machine-readable output (one JSON object)")
    bak.add_argument("--project-dir", default=None, help="project root (default: the current directory)")
    bak.set_defaults(func=handlers["backup"])

    res = sub.add_parser(
        "restore",
        help="replace a native project's database with a backup (Orcha must be stopped; "
        "the replaced database is kept next to it)",
    )
    res.add_argument("file", help="the backup file to restore")
    res.add_argument("--json", action="store_true", help="machine-readable output (one JSON object)")
    res.add_argument("--project-dir", default=None, help="project root (default: the current directory)")
    res.set_defaults(func=handlers["restore"])

    svc = sub.add_parser(
        "service",
        help="the macOS background service (launchd) that keeps a native project's Orcha "
        "running, also after a reboot: install | uninstall | status",
    )
    svc.add_argument("action", choices=("install", "uninstall", "status"))
    svc.add_argument("--json", action="store_true", help="machine-readable output (one JSON object)")
    svc.add_argument("--project-dir", default=None, help="project root (default: the current directory)")
    svc.set_defaults(func=handlers["service"])

    doc = sub.add_parser(
        "doctor",
        help="check this machine and project (runtime, ports, service, claude/codex/git, "
        "SQLite, disk, recent logs) — paste the output into a bug report",
    )
    doc.add_argument("--json", action="store_true", help="machine-readable output (one JSON object)")
    doc.add_argument("--project-dir", default=None, help="project root (default: the current directory)")
    doc.set_defaults(func=handlers["doctor"])
