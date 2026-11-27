"""The test browser for web QA (Playwright's Chromium headless shell), downloaded the first time
someone tests a website. The Mac app does not ship it: it lands in Playwright's own cache
(`~/Library/Caches/ms-playwright`), outside the signed app, and always matches the Playwright of the
Python that runs this (`python -m playwright install chromium-headless-shell`).

- `installed()`: whether the browser the web driver launches is on disk.
- `status()`: `{installed, state, percent, size, error, message}` for the Quality tab and the
  agents. `state`: `missing`, `downloading`, `ready` or `failed`.
- `start()`: begin the download in its own process (it outlives the caller) unless the browser is
  there or a download already runs; one download at a time across the portal and every agent's
  tool server (a lock file). Answers `status()`.
- `waiting_text()` / `failed_text()`: what an agent's `start_session` answers meanwhile.

Progress goes to `~/.orcha/tools/browser-setup.json`. Standard library only.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Optional

BROWSER = "chromium-headless-shell"
SIZE_WORDS = "about 100 MB"
#: Playwright writes this file into a browser's folder once its download is complete.
COMPLETE_MARKER = "INSTALLATION_COMPLETE"
CHECK_TIMEOUT_S = 30.0
INSTALL_TIMEOUT_S = 30 * 60.0
TIMEOUT_WORDS = "The download took more than 30 minutes and was stopped. Check the internet connection, then try again."
_PROGRESS = re.compile(r"(\d{1,3})%\s+of\s+([\d.]+\s*[KMG]i?B)")
_LOCATION = re.compile(r"Install location:\s*(\S.*)$", re.MULTILINE)


def tools_dir() -> pathlib.Path:
    return pathlib.Path.home() / ".orcha" / "tools"


def status_path() -> pathlib.Path:
    return tools_dir() / "browser-setup.json"


def lock_path() -> pathlib.Path:
    return tools_dir() / "browser-setup.lock"


def log_path() -> pathlib.Path:
    return tools_dir() / "browser-setup.log"


def playwright_cmd(*args: str) -> list[str]:
    """Playwright's own command line, run by this Python (so the browser matches its version)."""
    return [sys.executable, "-m", "playwright", *args]


def playwright_available() -> bool:
    import importlib.util

    return importlib.util.find_spec("playwright") is not None


def install_locations() -> Optional[list[pathlib.Path]]:
    """Where Playwright puts the browser (`install --dry-run`); None when it cannot tell."""
    try:
        p = subprocess.run(playwright_cmd("install", "--dry-run", BROWSER), capture_output=True, text=True,
                           timeout=CHECK_TIMEOUT_S, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    found = [pathlib.Path(m.strip()) for m in _LOCATION.findall(p.stdout or "")]
    return found if p.returncode == 0 and found else None


def installed() -> bool:
    if not playwright_available():
        return False
    places = install_locations()
    return bool(places) and all((place / COMPLETE_MARKER).is_file() for place in places)


def _read() -> dict[str, Any]:
    try:
        got = json.loads(status_path().read_text())
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(**fields: Any) -> dict[str, Any]:
    row = {**_read(), **fields, "updated_at": time.time()}
    tools_dir().mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=tools_dir(), prefix=".browser-setup.")
    with os.fdopen(fd, "w") as f:
        json.dump(row, f)
    os.replace(tmp, status_path())
    return row


@contextlib.contextmanager
def _lock(blocking: bool = False):
    """The download lock: yields True when this process holds it, False when another one does."""
    tools_dir().mkdir(parents=True, exist_ok=True)
    with open(lock_path(), "a") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def downloading() -> bool:
    with _lock() as mine:
        return not mine


def plain_error(output: str) -> str:
    """Playwright's failure as one sentence a person can act on."""
    text = output or ""
    if re.search(r"ENOSPC|no space left", text, re.IGNORECASE):
        return "Not enough disk space: the test browser needs about 300 MB free."
    if re.search(r"ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|socket hang up|network", text, re.IGNORECASE):
        return "No internet connection, or a network filter blocks the download."
    if re.search(r"EACCES|permission denied", text, re.IGNORECASE):
        return "Embodent can't write to the browser folder (~/Library/Caches/ms-playwright)."
    last = next((line.strip() for line in reversed(text.splitlines()) if line.strip()), "")
    return f"The download stopped: {last[:200]}" if last else "The download stopped."


def status() -> dict[str, Any]:
    row = _read()
    if not playwright_available():
        return {"installed": False, "state": "failed", "percent": None, "size": None,
                "error": "The web test tools are missing from this install.", "message": None}
    if downloading():
        return {"installed": False, "state": "downloading", "percent": row.get("percent"), "size": row.get("size"),
                "error": None, "message": f"Downloading the test browser ({SIZE_WORDS}, one time)"}
    if installed():
        return {"installed": True, "state": "ready", "percent": 100, "size": row.get("size"), "error": None, "message": None}
    if row.get("state") == "failed":
        return {"installed": False, "state": "failed", "percent": None, "size": None, "error": row.get("error"), "message": None}
    return {"installed": False, "state": "missing", "percent": None, "size": None, "error": None,
            "message": f"The test browser ({SIZE_WORDS}) downloads the first time you test a website"}


def start() -> dict[str, Any]:
    """Begin the download unless it is done or running; answer `status()`."""
    current = status()
    if current["state"] in ("ready", "downloading") or not playwright_available():
        return current
    tools_dir().mkdir(parents=True, exist_ok=True)
    _write(state="downloading", percent=0, size=None, error=None, started_at=time.time())
    _spawn_runner()
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline and not downloading():
        time.sleep(0.1)  # the runner takes the lock as it starts
    return {**status(), "state": "downloading"} if not installed() else status()


def runner_cmd() -> list[str]:
    return [sys.executable, "-m", "orcha_cli.qa.browser_setup", "run"]


def _spawn_runner() -> None:
    """The download in its own process group, so it outlives the portal request or agent call."""
    with open(log_path(), "a") as log:
        subprocess.Popen(runner_cmd(), stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)


def _stop(proc: subprocess.Popen) -> None:
    """End the installer and everything it started (Playwright's Python entrypoint runs Node)."""
    with contextlib.suppress(OSError):
        os.killpg(proc.pid, signal.SIGKILL)
    with contextlib.suppress(OSError):
        proc.kill()
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=5.0)


def run() -> int:
    """The download itself (the process `start()` spawns): holds the lock, writes progress. The
    installer gets `INSTALL_TIMEOUT_S` in all: silent, or with its output closed, it is still ended
    then, the download recorded as failed and the lock released, so the next session tries again."""
    with _lock() as mine:
        if not mine:
            return 0  # another download runs
        if installed():
            _write(state="ready", percent=100, error=None)
            return 0
        _write(state="downloading", percent=0, error=None)
        tail: list[str] = []
        try:
            proc = subprocess.Popen(playwright_cmd("install", BROWSER), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
        except OSError as e:
            _write(state="failed", percent=None, error=plain_error(str(e)))
            return 1

        def read() -> None:
            # The percent only goes up: after the browser, Playwright downloads a small second file
            # (ffmpeg) whose own 0-100% would make the number jump back. The size stays the browser's.
            assert proc.stdout is not None
            best = 0
            with contextlib.suppress(OSError, ValueError):
                for line in proc.stdout:
                    tail[:] = (tail + [line.rstrip()])[-40:]
                    m = _PROGRESS.search(line)
                    if m and (pct := min(100, int(m.group(1)))) > best:
                        best = pct
                        _write(state="downloading", percent=pct, size=m.group(2))

        reader = threading.Thread(target=read, name="browser-setup-output", daemon=True)
        reader.start()
        try:
            code: Optional[int] = proc.wait(timeout=INSTALL_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            code = None
        finally:
            if proc.poll() is None:
                _stop(proc)
        reader.join(timeout=5.0)
        if code is None:
            _write(state="failed", percent=None, error=TIMEOUT_WORDS)
            return 1
        if code == 0 and installed():
            _write(state="ready", percent=100, error=None)
            return 0
        _write(state="failed", percent=None, error=plain_error("\n".join(tail)))
        return 1


def waiting_text(st: dict[str, Any]) -> str:
    done = f", {st['percent']}% done" if st.get("percent") is not None else ""
    return (f"waiting: downloading the test browser (one time, {SIZE_WORDS}){done}. This is no failure and it has "
            "used no budget, so report no failure. Call start_session again in about 30 seconds with the same "
            "arguments; the session starts once the download is complete.")


def failed_text(st: dict[str, Any]) -> str:
    return (f"error: the test browser could not be downloaded: {st.get('error') or 'unknown reason'} "
            "Call start_session again to try again, or ask a person to press Try again in the Quality tab.")


def ensure_for_session() -> Optional[str]:
    """None when the browser is there; else start (or join) the download and answer for the agent."""
    if installed():
        return None
    st = status()
    if st["state"] == "failed":
        if playwright_available():
            _write(state="missing", error=None)  # the next call tries again
        return failed_text(st)
    st = start()
    if st["state"] == "ready":
        return None
    if st["state"] == "failed":
        return failed_text(st)
    return waiting_text(st)


if __name__ == "__main__":
    if sys.argv[1:] == ["run"]:
        raise SystemExit(run())
    print(json.dumps(status(), indent=2))
