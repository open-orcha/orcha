"""Orchestrate the host CLI, project, notifier, and bridge update phases."""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
from collections.abc import Callable
from typing import Any, Optional


def _rerun_updated_cli(args: Any) -> None:
    """Re-enter the update command after replacing the installed CLI."""
    executable = shutil.which("orcha") or "orcha"
    forward = [executable, "update", "--no-self"]
    if args.no_bridge:
        forward.append("--no-bridge")
    sys.exit(subprocess.run(forward).returncode)


def _self_update(
    args: Any,
    *,
    source_root: Callable[[], Optional[pathlib.Path]],
    brew_keg: Callable[[], Optional[str]],
    reinstall_cli: Callable[[pathlib.Path], bool],
    brew_upgrade: Callable[[str], bool],
) -> None:
    """Refresh a source or Homebrew installation, then re-enter when successful."""
    source = source_root()
    keg = None if source else brew_keg()
    if source is not None:
        if reinstall_cli(source):
            print(
                "[orcha] ✓ host CLI reinstalled — re-running update under the new code ...\n"
            )
            _rerun_updated_cli(args)
        print(
            "[orcha] warn: CLI self-reinstall failed — continuing with the "
            "currently-installed code.",
            file=sys.stderr,
        )
        return
    if keg is not None:
        if brew_upgrade(keg):
            print(
                "[orcha] ✓ host CLI upgraded via brew — re-running update under the "
                "new code ...\n"
            )
            _rerun_updated_cli(args)
        print("[orcha] continuing with the currently-installed CLI.")
        return
    print(
        "[orcha] host CLI is a packaged install — update it via your package "
        "manager (e.g. `uv tool upgrade orcha-cli` or `pip install -U orcha-cli`), "
        "then re-run `orcha update`. Skipping CLI self-update."
    )


def update_command(
    args: Any,
    *,
    source_root: Callable[[], Optional[pathlib.Path]],
    brew_keg: Callable[[], Optional[str]],
    reinstall_cli: Callable[[pathlib.Path], bool],
    brew_upgrade: Callable[[str], bool],
    upgrade: Callable[[Any], None],
    ensure_notifier: Callable[..., None],
) -> None:
    """Apply an idempotent host and project update without changing project data."""
    cwd = pathlib.Path.cwd()
    if not (cwd / ".orcha" / "docker-compose.yml").exists() or not (
        cwd / ".claude" / "orcha.json"
    ).exists():
        sys.exit(
            "error: no .orcha/ + .claude/orcha.json here — run `orcha update` from an "
            "existing project directory (or `orcha init` to bootstrap a new one)."
        )

    if not args.no_self:
        _self_update(
            args,
            source_root=source_root,
            brew_keg=brew_keg,
            reinstall_cli=reinstall_cli,
            brew_upgrade=brew_upgrade,
        )

    upgrade(args)
    try:
        ensure_notifier(cwd, restart=True)
    except Exception as exc:
        print(
            f"[orcha] warn: notifier daemon restart failed ({exc}); "
            "start it with `orcha notifier --ensure`",
            file=sys.stderr,
        )

    if not args.no_bridge:
        try:
            from orcha_cli.terminal_bridge import ensure_bridge

            ensure_bridge(cwd, restart=True)
        except Exception as exc:
            print(
                f"[orcha] warn: terminal bridge restart failed ({exc}); "
                "start it with `orcha terminal-bridge --ensure`",
                file=sys.stderr,
            )

    print(
        "[orcha] ✓ update complete — portal rebuilt, hooks current, "
        "daemon + bridge restarted."
    )
