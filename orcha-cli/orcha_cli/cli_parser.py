"""Assemble the Orcha CLI parser from responsibility-focused command groups."""

from __future__ import annotations

import argparse
from collections.abc import Callable

from .cli_parser_project import register_project_commands
from .cli_parser_runtime import register_runtime_commands
from .cli_parser_session import register_session_commands


def build_parser(
    version: str, handlers: dict[str, Callable]
) -> argparse.ArgumentParser:
    """Build the public ``orcha`` argument parser with the supplied command handlers."""
    parser = argparse.ArgumentParser(
        prog="orcha", description="Orcha installer + lifecycle."
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {version}")
    sub = parser.add_subparsers(dest="cmd", required=True)
    register_project_commands(sub, handlers)
    register_session_commands(sub, handlers)
    register_runtime_commands(sub, handlers)
    return parser
