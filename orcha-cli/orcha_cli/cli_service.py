"""`orcha service install|uninstall|status` — keep a native project's `orcha serve` running
under launchd (GH #258 plan R3, PR 10). macOS only: Orcha ships as a Mac app (owner,
2026-10-06), so there is no systemd unit.

The unit is a per-user LaunchAgent, ``~/Library/LaunchAgents/io.openorcha.<project>.plist``:
no admin rights, starts at login (so it survives a reboot) and runs whether or not the app
or a terminal is open. ``ProgramArguments[0]`` is the interpreter running this CLI (plan
R-D2), so the Mac app's bundled Python and a ``uv tool`` venv both work.

launchd hands agents an almost empty PATH, and the notifier must find ``claude``,
``codex``, ``git`` and ``gh``. ``install`` captures the login shell's PATH
(``$SHELL -ilc``), puts ``~/.local/bin``, ``/opt/homebrew/bin`` and ``/usr/local/bin`` in
front, and stores it in the plist. ``orcha up`` re-runs ``install`` so a tool installed
later is picked up; the running service is only restarted when the plist changed.

``KeepAlive`` is ``{SuccessfulExit: false}`` rather than the plan's ``<true/>``: launchd
restarts ``serve`` after a crash (or while another ``serve`` still owns the project, which
exits 1), but a clean stop — macOS logging out, or SIGTERM — is not undone every 10 s.

All three subcommands take ``--json`` (one JSON object) for the Mac app.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import plistlib
import re
import subprocess
import sys
from typing import Optional

from orcha_cli import cli_runtime_mode, cli_serve_support, cli_stacks_registry

PLATFORM = sys.platform  # tests set this; the service is macOS only
LABEL_PREFIX = "io.openorcha."
EXTRA_PATH = ("~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin")
FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
PATH_MARK = "__ORCHA_PATH__"
SHELL_TIMEOUT_SECS = 15
LAUNCHCTL_NOT_FOUND = 113  # `launchctl print` for a service that is not loaded


class ServiceError(RuntimeError):
    """The command stopped; the message says why and what to do."""


def supported() -> bool:
    return PLATFORM == "darwin"


def _require_macos() -> None:
    if not supported():
        raise ServiceError("the background service is macOS only; on this machine start "
                           "Orcha with `orcha up` (or run `orcha serve` yourself)")


def project_name(root: pathlib.Path, cfg: Optional[dict] = None) -> str:
    cfg = cli_runtime_mode.read_config(root) if cfg is None else cfg
    return cfg.get("project_name") or pathlib.Path(root).name


def label(name: str) -> str:
    return f"{LABEL_PREFIX}{name}"


def plist_path(name: str) -> pathlib.Path:
    return pathlib.Path.home() / "Library" / "LaunchAgents" / f"{label(name)}.plist"


def _domain() -> str:
    return f"gui/{os.getuid()}"


def _launchctl(*args: str, check: bool = False) -> subprocess.CompletedProcess:
    proc = subprocess.run(["launchctl", *args], capture_output=True, text=True)
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise ServiceError(f"`launchctl {' '.join(args)}` failed ({proc.returncode}): {detail}")
    return proc


# --- PATH capture ----------------------------------------------------------------------


def capture_path(shell: Optional[str] = None) -> str:
    """The login shell's PATH with the usual install dirs in front, de-duplicated. Markers
    around the value keep anything an rc file prints out of it."""
    shell = shell or os.environ.get("SHELL") or "/bin/zsh"
    captured = ""
    try:
        proc = subprocess.run(
            [shell, "-ilc", f'printf "{PATH_MARK}%s{PATH_MARK}" "$PATH"'],
            capture_output=True, text=True, stdin=subprocess.DEVNULL,
            timeout=SHELL_TIMEOUT_SECS,
        )
        found = re.search(f"{PATH_MARK}(.*?){PATH_MARK}", proc.stdout or "", re.S)
        captured = found.group(1) if found else ""
    except (OSError, subprocess.SubprocessError):
        captured = ""
    captured = captured or os.environ.get("PATH") or FALLBACK_PATH
    seen, parts = set(), []
    for part in [os.path.expanduser(p) for p in EXTRA_PATH] + captured.split(":"):
        if part and part not in seen:
            seen.add(part)
            parts.append(part)
    return ":".join(parts)


# --- the plist -------------------------------------------------------------------------


def render(root: pathlib.Path, name: str, *, python: str, path_env: str, home: str) -> dict:
    root = pathlib.Path(root)
    log = str(cli_serve_support.log_path(root, "launchd"))
    return {
        "Label": label(name),
        "ProgramArguments": [python, "-m", "orcha_cli", "serve", "--project-dir", str(root)],
        "WorkingDirectory": str(root),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        "StandardOutPath": log,
        "StandardErrorPath": log,
        "EnvironmentVariables": {"PATH": path_env, "HOME": home, "LANG": "en_US.UTF-8"},
    }


def render_bytes(plist: dict) -> bytes:
    return plistlib.dumps(plist, fmt=plistlib.FMT_XML, sort_keys=True)


def read_plist(name: str) -> Optional[dict]:
    try:
        return plistlib.loads(plist_path(name).read_bytes())
    except (OSError, ValueError, plistlib.InvalidFileException):
        return None


# --- launchctl -------------------------------------------------------------------------


def _parse_print(text: str) -> dict:
    def grab(key: str) -> Optional[str]:
        found = re.search(rf"^\s*{re.escape(key)} = (.+)$", text, re.M)
        return found.group(1).strip() if found else None

    pid = grab("pid")
    return {"state": grab("state"), "pid": int(pid) if pid and pid.isdigit() else None,
            "last_exit": grab("last exit code")}


def loaded_status(name: str) -> dict:
    """``launchctl print`` for the project's service: loaded or not, state, pid."""
    proc = _launchctl("print", f"{_domain()}/{label(name)}")
    if proc.returncode != 0:
        return {"loaded": False, "state": None, "pid": None, "last_exit": None}
    return {"loaded": True, **_parse_print(proc.stdout or "")}


def status(root: pathlib.Path) -> dict:
    root = pathlib.Path(root).resolve()
    name = project_name(root)
    base = {"supported": supported(), "label": label(name), "plist": str(plist_path(name))}
    if not supported():
        return {**base, "installed": False, "loaded": False, "state": None, "pid": None,
                "last_exit": None, "path_env": None, "program": None}
    plist = read_plist(name) or {}
    return {**base, "installed": plist_path(name).exists(), **loaded_status(name),
            "path_env": (plist.get("EnvironmentVariables") or {}).get("PATH"),
            "program": (plist.get("ProgramArguments") or [None])[0]}


def installed(root: pathlib.Path) -> bool:
    return supported() and plist_path(project_name(pathlib.Path(root).resolve())).exists()


def install(root: pathlib.Path, *, python: Optional[str] = None,
            path_env: Optional[str] = None) -> dict:
    """Write the plist and load it. Idempotent: when the plist is unchanged and already
    loaded nothing is restarted; when it changed, the old one is unloaded first."""
    _require_macos()
    root = pathlib.Path(root).resolve()
    cfg = cli_runtime_mode.read_config(root)
    if not cli_runtime_mode.is_native_project(root, cfg):
        raise ServiceError(f"{root} is not a native Orcha project, so there is nothing for "
                           "the background service to run")
    name = project_name(root, cfg)
    body = render_bytes(render(root, name, python=python or sys.executable,
                               path_env=path_env or capture_path(),
                               home=str(pathlib.Path.home())))
    target = plist_path(name)
    unchanged = target.exists() and target.read_bytes() == body
    was_loaded = loaded_status(name)["loaded"]
    if unchanged and was_loaded:
        return {"label": label(name), "plist": str(target), "changed": False, "loaded": True}
    cli_serve_support.logs_dir(root).mkdir(parents=True, exist_ok=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    tmp.write_bytes(body)
    os.replace(tmp, target)
    if was_loaded:
        _launchctl("bootout", f"{_domain()}/{label(name)}")
    _launchctl("bootstrap", _domain(), str(target), check=True)
    return {"label": label(name), "plist": str(target), "changed": not unchanged, "loaded": True}


def start(root: pathlib.Path) -> None:
    """Start the loaded service if it is not running (never kills a running one)."""
    _launchctl("kickstart", f"{_domain()}/{label(project_name(pathlib.Path(root).resolve()))}")


def stop(root: pathlib.Path) -> bool:
    """Unload the service for this login session (it loads again at the next login).
    True when it was loaded."""
    if not supported():
        return False
    name = project_name(pathlib.Path(root).resolve())
    if not loaded_status(name)["loaded"]:
        return False
    _launchctl("bootout", f"{_domain()}/{label(name)}")
    return True


def uninstall(root: pathlib.Path) -> dict:
    _require_macos()
    root = pathlib.Path(root).resolve()
    name = project_name(root)
    was_loaded = stop(root)
    target = plist_path(name)
    existed = target.exists()
    if existed:
        target.unlink()
    unregistered = cli_stacks_registry.unregister(name)
    return {"label": label(name), "plist": str(target), "removed": existed,
            "was_loaded": was_loaded, "unregistered": unregistered}


def install_if_supported(root: pathlib.Path) -> Optional[dict]:
    """``orcha init`` / ``migrate-runtime`` hook: install on macOS, skip elsewhere."""
    return install(root) if supported() else None


# --- command -------------------------------------------------------------------------


def _emit(as_json: bool, ok: bool, payload: dict, human: str) -> None:
    if as_json:
        print(json.dumps({"event": "result" if ok else "error", "ok": ok, **payload}), flush=True)
    elif ok:
        print(human, flush=True)
    else:
        print(f"error: {human}", file=sys.stderr, flush=True)


def _human_status(res: dict) -> str:
    if not res["supported"]:
        return "background service: not available on this OS (macOS only)"
    if not res["installed"]:
        return f"background service: not installed ({res['plist']}); `orcha service install`"
    state = res["state"] or ("not loaded" if not res["loaded"] else "?")
    pid = f", pid {res['pid']}" if res["pid"] else ""
    return (f"background service: installed, {state}{pid}\n"
            f"  label:   {res['label']}\n  plist:   {res['plist']}\n"
            f"  python:  {res['program']}\n  PATH:    {res['path_env']}")


def cmd_service(args: argparse.Namespace) -> None:
    root = pathlib.Path(args.project_dir or pathlib.Path.cwd()).resolve()
    try:
        if args.action == "install":
            res = install(root)
            human = (f"[orcha] ✓ background service {'installed' if res['changed'] else 'already up to date'}"
                     f" ({res['plist']}); Orcha now starts at login")
        elif args.action == "uninstall":
            res = uninstall(root)
            human = (f"[orcha] ✓ background service removed ({res['plist']})" if res["removed"]
                     else "[orcha] no background service was installed for this project")
        else:
            res = status(root)
            human = _human_status(res)
    except ServiceError as exc:
        _emit(args.json, False, {"error": str(exc)}, str(exc))
        sys.exit(1)
    _emit(args.json, True, res, human)
