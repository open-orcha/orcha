"""Define project lifecycle subcommands for the Orcha command-line parser."""

from __future__ import annotations

import argparse
from collections.abc import Callable


def register_project_commands(
    sub: argparse._SubParsersAction,
    handlers: dict[str, Callable],
) -> None:
    """Register project creation, stack lifecycle, and connection commands."""
    init = sub.add_parser("init", help="bootstrap Orcha in the current directory")
    init.add_argument(
        "--name", default=None, help="project name (default: CWD basename)"
    )
    init.add_argument(
        "--api-port",
        type=int,
        default=None,
        help="host port for API (default: first free 8000+)",
    )
    init.add_argument(
        "--db-port",
        type=int,
        default=None,
        help="host port for DB (default: first free 5432+)",
    )
    init.add_argument(
        "--bridge-port",
        type=int,
        default=None,
        help="host port for the live-terminal bridge (default: first free 8765+)",
    )
    init.add_argument("--force", action="store_true", help="overwrite existing .orcha/")
    init.add_argument(
        "--reset-data",
        action="store_true",
        help="DESTRUCTIVE: drop this project's Postgres volume before starting so the DB "
        "comes up empty (wipes the old container + all agents/tasks/requests). "
        "Use with --force for a genuinely pristine re-init.",
    )
    init.add_argument(
        "--objective",
        default=None,
        help="high-level objective for the auto-created container (default: project dir name)",
    )
    init.add_argument(
        "--no-container",
        action="store_true",
        help="skip auto-container creation (advanced: scripted setups)",
    )
    init.add_argument(
        "--as",
        dest="as_user",
        default=None,
        help="alias for the first human agent (default: $USER or 'operator')",
    )
    init.set_defaults(func=handlers["init"])

    up = sub.add_parser(
        "up",
        help="start the stack (CWD's .orcha/, or --project <name> from anywhere)",
    )
    up.add_argument(
        "--project",
        default=None,
        help="target a specific project by name (sans 'orcha-' prefix); works from any directory",
    )
    up.set_defaults(func=handlers["up"])

    down = sub.add_parser(
        "down",
        help="stop the stack (CWD's .orcha/, or --project <name> from anywhere)",
    )
    down.add_argument(
        "-v", "--volumes", action="store_true", help="also drop the DB volume"
    )
    down.add_argument(
        "--project",
        default=None,
        help="target a specific project by name (sans 'orcha-' prefix); works from any directory",
    )
    down.set_defaults(func=handlers["down"])

    migrate = sub.add_parser(
        "migrate",
        help="R1: apply any pending DB migrations (migrations/*.sql) to the live DB now, "
        "without a wipe. The portal also runs them on startup, so `orcha up` migrates "
        "automatically; use this for an explicit, on-demand apply.",
    )
    migrate.set_defaults(func=handlers["migrate"])

    upgrade = sub.add_parser(
        "upgrade",
        help="upgrade an existing project to the installed CLI's templates (re-render compose, "
        "re-copy portal/migrations/skills, rebuild portal) WITHOUT a data wipe. Use after a "
        "CLI reinstall so an existing project gets new portal code + compose (e.g. the R1 "
        "migration runner); then `orcha up`/startup migrates the live volume.",
    )
    upgrade.set_defaults(func=handlers["upgrade"])

    update = sub.add_parser(
        "update",
        help="ONE command to apply a code change to a running project (idempotent; safe to "
        "re-run when nothing changed): reinstall the host CLI from source if editable, "
        "re-copy portal/migrations/skills + rebuild the portal with NO data wipe, apply "
        "pending migrations on startup, re-register hooks, and restart the notifier daemon "
        "+ terminal bridge so new host code takes effect — no manual kill/respawn.",
    )
    update.add_argument(
        "--no-self",
        action="store_true",
        help="skip the host-CLI reinstall/re-exec (just upgrade the project + restart daemons)",
    )
    update.add_argument(
        "--no-bridge",
        action="store_true",
        help="don't restart the live-terminal bridge (headless host with no terminal panel)",
    )
    update.set_defaults(func=handlers["update"])

    status = sub.add_parser("status", help="show stack status + config")
    status.set_defaults(func=handlers["status"])

    list_stacks = sub.add_parser(
        "ls",
        help="list running orcha Docker stacks with their (single) container (across all projects)",
    )
    list_stacks.set_defaults(func=handlers["ls"])

    connect = sub.add_parser(
        "connect",
        help="point THIS folder at an existing orcha stack (so /orcha-* skills here "
        "target that stack's container). Use `orcha ls` to find <project-name>.",
    )
    connect.add_argument(
        "project_name", help="stack to adopt (the PROJECT column from `orcha ls`)"
    )
    connect.add_argument(
        "--as",
        dest="as_user",
        default=None,
        help="register an additional human (kind='human') with this alias in one step",
    )
    connect.set_defaults(func=handlers["connect"])
