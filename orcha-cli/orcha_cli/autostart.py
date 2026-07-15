"""Login-persistent autostart for the notifier daemon.

`orcha notifier --ensure` is idempotent but only helps while something calls it —
a SessionStart hook, `orcha init`/`up`. After a laptop reboot with no interactive
session open, nothing respawns the daemon and wakes silently stop until someone
types `orcha notifier --ensure` by hand.

On macOS we close that gap with a per-container launchd LaunchAgent
(`~/Library/LaunchAgents/io.openorcha.notifier.<container_id>.plist`) that runs the
SAME idempotent ensure at login (RunAtLoad) and every _START_INTERVAL seconds
thereafter — a cron-style watchdog, so a killed daemon is also respawned within a
minute. launchd is deliberately NOT handed the daemon itself to supervise (no
KeepAlive on a foreground `orcha notifier`): the ensure path already owns the
single-instance machinery (per-cwd pidfile + container-global claim, notifier.py),
and a second supervisor would fight it — KeepAlive on a fast-exiting ensure job
would just make launchd throttle-loop.

Lifecycle: installed (idempotently) whenever `ensure_daemon` succeeds — init, up,
SessionStart hook, manual --ensure; removed by `orcha notifier --stop` and
`orcha down` (via stop_daemon), so an explicit stop stays stopped instead of being
resurrected by the watchdog 60s later.

Linux: no launchd — install is a no-op. `orcha up` and the SessionStart hook still
ensure the daemon at runtime; docs/notifier-autostart.md carries a sample systemd
user unit for reboot parity. Opt out anywhere with ORCHA_NO_AUTOSTART=1.
"""
from __future__ import annotations

import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
from typing import Optional

_LABEL_PREFIX = "io.openorcha.notifier"
_START_INTERVAL = 60  # seconds between watchdog ensure runs (crash-recovery bound)


# ---------- small seams (monkeypatchable in tests; never touch the real host there) ----------

def _platform() -> str:
    return sys.platform


def _which(name: str) -> Optional[str]:
    return shutil.which(name)


def _launch_agents_dir() -> pathlib.Path:
    return pathlib.Path.home() / "Library" / "LaunchAgents"


def _launchctl(*args: str) -> Optional[subprocess.CompletedProcess]:
    """Run launchctl, capturing output. None on any execution failure (missing binary,
    timeout, sandbox) — callers treat None like a non-zero exit and stay best-effort."""
    try:
        return subprocess.run(["launchctl", *args], capture_output=True, text=True, timeout=10.0)
    except Exception:
        return None


# ---------- naming ----------

def autostart_label(container_id: str) -> str:
    return f"{_LABEL_PREFIX}.{container_id}"


def plist_path(container_id: str) -> pathlib.Path:
    return _launch_agents_dir() / f"{autostart_label(container_id)}.plist"


def autostart_supported() -> bool:
    if os.environ.get("ORCHA_NO_AUTOSTART"):
        return False
    if _platform() != "darwin":
        return False
    return _which("launchctl") is not None


# ---------- plist construction ----------

def _ensure_argv() -> list:
    """The watchdog command: the same idempotent ensure everything else uses.
    Absolute path — launchd jobs run with a minimal PATH."""
    exe = _which("orcha")
    if exe:
        return [exe, "notifier", "--ensure", "--quiet"]
    return [sys.executable, "-m", "orcha_cli", "notifier", "--ensure", "--quiet"]


def _build_plist(cwd: pathlib.Path, container_id: str) -> bytes:
    log = str(cwd / ".claude" / ".orcha-notifier-autostart.log")
    return plistlib.dumps({
        "Label": autostart_label(container_id),
        "ProgramArguments": _ensure_argv(),
        "WorkingDirectory": str(cwd),
        "RunAtLoad": True,
        "StartInterval": _START_INTERVAL,
        "StandardOutPath": log,
        "StandardErrorPath": log,
    })


def _plist_workdir(raw: bytes) -> Optional[pathlib.Path]:
    try:
        wd = plistlib.loads(raw).get("WorkingDirectory")
        return pathlib.Path(wd) if wd else None
    except Exception:
        return None


def _valid_root_for(root: pathlib.Path, container_id: str) -> bool:
    """Is `root` still a live checkout of the project bound to this container?"""
    try:
        import json
        cfg = json.loads((root / ".claude" / "orcha.json").read_text())
        return cfg.get("current_container_id") == container_id
    except (OSError, ValueError):
        return False


# ---------- launchctl verbs ----------

def _gui_domain() -> str:
    return f"gui/{os.getuid()}"


def _loaded(label: str) -> bool:
    out = _launchctl("print", f"{_gui_domain()}/{label}")
    return out is not None and out.returncode == 0


def _bootstrap(path: pathlib.Path, container_id: str, quiet: bool) -> bool:
    out = _launchctl("bootstrap", _gui_domain(), str(path))
    ok = out is not None and out.returncode == 0
    if not ok and not quiet:
        detail = (out.stderr or out.stdout or "").strip() if out else "launchctl unavailable"
        print(f"[notifier] warn: could not load login autostart ({detail})", file=sys.stderr)
    return ok


def _bootout(container_id: str) -> None:
    _launchctl("bootout", f"{_gui_domain()}/{autostart_label(container_id)}")


# ---------- public API ----------

def install_autostart(cwd: pathlib.Path, container_id: Optional[str], quiet: bool = True) -> bool:
    """Idempotently install + load the LaunchAgent watchdog for this container.

    Cheap when nothing changed (one read + one `launchctl print`), so it is safe to
    call from every ensure_daemon — including the SessionStart hook. Best-effort by
    contract: any failure returns False and must never break ensure/up.
    """
    if not container_id or not autostart_supported():
        return False
    try:
        path = plist_path(container_id)
        desired = _build_plist(cwd, container_id)
        if path.exists():
            existing = path.read_bytes()
            if existing == desired:
                return True if _loaded(autostart_label(container_id)) else \
                    _bootstrap(path, container_id, quiet)
            # Content differs. If the installed agent points at ANOTHER checkout that is
            # still a valid root for this container (multi-worktree projects), keep it —
            # ensure calls race in from every worktree and the agent must not churn
            # between them (only one daemon per container exists anyway).
            other = _plist_workdir(existing)
            if other and other != cwd and _valid_root_for(other, container_id):
                return True if _loaded(autostart_label(container_id)) else \
                    _bootstrap(path, container_id, quiet)
        path.parent.mkdir(parents=True, exist_ok=True)
        _bootout(container_id)  # unload any old definition before replacing it
        path.write_bytes(desired)
        ok = _bootstrap(path, container_id, quiet)
        if ok and not quiet:
            print(f"[notifier] login autostart installed ({path.name})")
        return ok
    except Exception as e:
        if not quiet:
            print(f"[notifier] warn: autostart install failed ({e})", file=sys.stderr)
        return False


def uninstall_autostart(container_id: Optional[str], quiet: bool = True) -> bool:
    """Unload + remove the LaunchAgent so an explicit stop STAYS stopped.

    Gated like install (darwin + launchctl + not opted out); returns True iff an
    agent was actually unloaded or a plist removed."""
    if not container_id or not autostart_supported():
        return False
    try:
        out = _launchctl("bootout", f"{_gui_domain()}/{autostart_label(container_id)}")
        removed = out is not None and out.returncode == 0
        path = plist_path(container_id)
        if path.exists():
            path.unlink()
            removed = True
        if removed and not quiet:
            print(f"[notifier] login autostart removed ({autostart_label(container_id)})")
        return removed
    except Exception as e:
        if not quiet:
            print(f"[notifier] warn: autostart removal failed ({e})", file=sys.stderr)
        return False
