"""Orchestrate the host CLI, project, notifier, and bridge update phases."""
# ruff: noqa: BLE001, PLW1510

from __future__ import annotations

import importlib.metadata as pkg_meta
import importlib.resources as pkg_res
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from orcha_cli import cli_runtime_mode


def source_root() -> pathlib.Path | None:
    """Return the editable orcha-cli source root, if this is a source install."""
    try:
        package_dir = pathlib.Path(str(pkg_res.files("orcha_cli")))
    except Exception:
        return None
    root = package_dir.parent
    return root if (root / "pyproject.toml").exists() else None


def brew_keg() -> str | None:
    """Return the Homebrew formula name when the executable resolves into a keg."""
    executable = shutil.which("orcha")
    if not executable:
        return None
    parts = pathlib.Path(executable).resolve().parts
    for index, part in enumerate(parts[:-1]):
        if part == "Cellar":
            return parts[index + 1]
    return None


DIST_NAME = "orcha-cli"
_EXTRA_MARKER = re.compile(r"""^extra\s*==\s*['"]([^'"]+)['"]$""")
_REQUIREMENT_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _installed_dist() -> Any:
    try:
        return pkg_meta.distribution(DIST_NAME)
    except Exception:
        return None


def installed_extras() -> list[str]:
    """Return the optional extras (e.g. ``qa``) whose requirements are all installed.

    ``orcha update`` reinstalls the CLI; without this it dropped extras such as the QA
    tools. An extra counts only when every requirement guarded solely by its marker is
    present here, so a CLI installed without it never gains it.
    """
    dist = _installed_dist()
    if dist is None:
        return []
    by_extra: dict[str, set[str]] = {}
    try:
        for requirement in dist.requires or []:
            spec, _, marker = requirement.partition(";")
            extra = _EXTRA_MARKER.match(marker.strip())
            name = _REQUIREMENT_NAME.match(spec)
            if extra and name:
                by_extra.setdefault(extra.group(1), set()).add(_normalize(name.group(1)))
        if not by_extra:
            return []
        present = {
            _normalize(d.metadata.get("Name") or "") for d in pkg_meta.distributions()
        }
    except Exception as exc:
        print(f"[orcha] warn: could not read installed extras ({exc})", file=sys.stderr)
        return []
    return sorted(extra for extra, names in by_extra.items() if names <= present)


def frozen_checkout() -> pathlib.Path | None:
    """Return the orcha-cli checkout a non-editable local-directory install was copied from.

    A plain ``uv tool install <checkout>`` (no ``--editable``) freezes a copy, so later
    merges never reach the live CLI. ``direct_url.json`` still names the folder it came
    from; when that folder is still an orcha-cli checkout, ``orcha update`` relinks to it.
    """
    dist = _installed_dist()
    if dist is None:
        return None
    try:
        info = json.loads(dist.read_text("direct_url.json") or "null")
    except (OSError, ValueError):
        return None
    if not isinstance(info, dict):
        return None
    dir_info = info.get("dir_info")
    if not isinstance(dir_info, dict) or dir_info.get("editable"):
        return None
    url = urllib.parse.urlparse(str(info.get("url") or ""))
    if url.scheme != "file" or url.netloc not in ("", "localhost"):
        return None
    root = pathlib.Path(urllib.request.url2pathname(url.path))
    if (root / "pyproject.toml").is_file() and (root / "orcha_cli").is_dir():
        return root
    return None


def reinstall_cli(source: pathlib.Path, extras: list[str] | None = None) -> bool:
    """Reinstall the host CLI editable from ``source`` with uv, falling back to pip.

    The currently installed extras (e.g. ``[qa]``) are carried over.
    """
    chosen = installed_extras() if extras is None else extras
    target = f"{source}[{','.join(chosen)}]" if chosen else str(source)
    uv = shutil.which("uv")
    command = (
        [uv, "tool", "install", "--reinstall", "--editable", target]
        if uv
        else [sys.executable, "-m", "pip", "install", "-e", target]
    )
    print(f"[orcha] reinstalling host CLI from {source}\n        $ {' '.join(command)}")
    try:
        return subprocess.run(command).returncode == 0
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"[orcha] warn: could not launch reinstall ({exc})", file=sys.stderr)
        return False


def upgrade_brew(keg: str) -> bool:
    """Upgrade an unpinned Homebrew installation."""
    if "@" in keg:
        print(
            f"[orcha] host CLI is pinned to versioned formula {keg} — skipping "
            f"self-upgrade (to track releases again: brew uninstall {keg} && "
            "brew install open-orcha/orcha/orcha)."
        )
        return False
    brew = shutil.which("brew")
    if not brew:
        print(
            "[orcha] warn: Homebrew install detected but `brew` is not on PATH; "
            "fix your PATH (or reinstall Homebrew), then "
            "`brew upgrade open-orcha/orcha/orcha`.",
            file=sys.stderr,
        )
        return False
    command = [brew, "upgrade", f"open-orcha/orcha/{keg}"]
    print(f"[orcha] upgrading host CLI via Homebrew\n        $ {' '.join(command)}")
    try:
        return subprocess.run(command).returncode == 0
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"[orcha] warn: could not launch brew ({exc})", file=sys.stderr)
        return False


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
    source_root: Callable[[], pathlib.Path | None],
    brew_keg: Callable[[], str | None],
    reinstall_cli: Callable[[pathlib.Path], bool],
    brew_upgrade: Callable[[str], bool],
    frozen_checkout: Callable[[], pathlib.Path | None] | None = None,
) -> None:
    """Refresh a source or Homebrew installation, then re-enter when successful."""
    if os.environ.get("ORCHA_SIDECAR") == "1":
        # GH #258 D3: the CLI bundled inside the desktop app is replaced only by an app
        # update — never by uv/brew/pip, which would split the app from its runtime.
        print(
            "[orcha] this command line comes with the Embodent app — update the app to "
            "update it. Skipping CLI self-update."
        )
        return
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
    checkout = frozen_checkout() if frozen_checkout is not None else None
    if checkout is not None:
        print(
            f"[orcha] host CLI is a frozen copy of {checkout} — relinking it to that "
            "checkout so updates reach it ..."
        )
        if reinstall_cli(checkout):
            print(
                "[orcha] ✓ host CLI relinked — re-running update under the new code ...\n"
            )
            _rerun_updated_cli(args)
        print(
            "[orcha] warn: could not relink the host CLI — continuing with the "
            "currently-installed code.",
            file=sys.stderr,
        )
        return
    print(
        "[orcha] host CLI is a packaged install — update it via your package "
        "manager (e.g. `uv tool upgrade orcha-cli` or `pip install -U orcha-cli`), "
        "then re-run `orcha update`. Skipping CLI self-update."
    )


def update_command(
    args: Any,
    *,
    source_root: Callable[[], pathlib.Path | None],
    brew_keg: Callable[[], str | None],
    reinstall_cli: Callable[[pathlib.Path], bool],
    brew_upgrade: Callable[[str], bool],
    upgrade: Callable[[Any], None],
    ensure_notifier: Callable[..., None],
    frozen_checkout: Callable[[], pathlib.Path | None] | None = None,
) -> None:
    """Apply an idempotent host and project update without changing project data."""
    cwd = pathlib.Path.cwd()
    missing = (
        "error: no .orcha/ + .claude/orcha.json here — run `orcha update` from an "
        "existing project directory (or `orcha init` to bootstrap a new one)."
    )
    runtime = cli_runtime_mode.require_project(cwd, missing)
    if not (cwd / ".claude" / "orcha.json").exists():
        sys.exit(missing)

    if not args.no_self:
        _self_update(
            args,
            source_root=source_root,
            brew_keg=brew_keg,
            reinstall_cli=reinstall_cli,
            brew_upgrade=brew_upgrade,
            frozen_checkout=frozen_checkout,
        )

    upgrade(args)
    if runtime == cli_runtime_mode.NATIVE:
        # `orcha serve` owns the notifier and bridge; upgrade already restarted it.
        print("[orcha] ✓ update complete — hooks current, orcha serve restarted.")
        return
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
    from orcha_cli.cli_migrate_runtime import docker_nudge

    print(docker_nudge())
