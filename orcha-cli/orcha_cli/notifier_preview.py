"""Preview environments for Verdikt runs — the host side (portal: verdikt_preview.py, mig 064).

Verdikt tests something already running. When a project has a preview command, a Verdikt run
for a task first needs the task's own change built and served. The portal can't do that (it
may run in Docker); this daemon can — it owns the agent worktrees on the host. Each daemon
tick (`service_previews`):

  1. claims the oldest requested preview of the project
     (`POST /api/containers/{cid}/verdikt/previews/claim`);
  2. resolves the task's checkout — its recorded worktree if it is this project's checkout or
     one of its `.orcha-worktrees/*`, else a throwaway detached worktree of its branch — picks
     a free port, and runs the command there with `/bin/sh -c` in its own process group,
     output to `~/.orcha/previews/<id>.log`;
  3. polls the ready check (`http://127.0.0.1:{port}{ready_path}`, any answer below 400) from
     a thread and reports `ready` (the portal then hands Verdikt the URL) or `failed` with a
     plain reason and the last log lines;
  4. heartbeats every few seconds with the log tail; the portal answers whether to stop
     (the Verdikt run finished / was cancelled / the TTL passed). The TTL is also enforced
     here, so a preview never outlives it even if the portal is gone;
  5. stops the process group (TERM, then KILL), removes a throwaway worktree, and reports
     `stopped`. On daemon exit every preview is stopped; one left by a crashed daemon is
     found by its pid file and stopped on the next start.

Security: the command is a project setting (owners / manage_repo only) and runs as this
daemon's user. The ONLY substitutions are `{port}` (an int chosen here), `{worktree}` and
`{branch}` — validated and `shlex.quote`d. No task text is ever put into the shell. Worktree
paths must resolve inside this project's checkout; the branch must be a plain ref name that
exists locally. Orcha's own secrets (ORCHA_*, model API keys) are not passed to the command.

Never raises into the daemon loop. Skipped in --dry-run and when the daemon has no project
checkout (explicit --api-base/--container mode).
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Callable, Optional

MAX_ACTIVE = 3
HEARTBEAT_EVERY_S = 5.0
READY_POLL_S = 0.5
KILL_GRACE_S = 5.0
LOG_TAIL_BYTES = 64 * 1024
LOG_TAIL_LINES = 80
PORT_MIN, PORT_MAX = 1024, 65535
_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
_ID = re.compile(r"^[0-9a-fA-F-]{36}$")
# never handed to a project's preview command (it runs the agent's branch code)
_SECRET_ENV = re.compile(r"^(ORCHA_.*|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|GEMINI_API_KEY|XAI_API_KEY)$")


class PreviewError(Exception):
    """A preview could not be started; the message is shown to people as-is."""


def log_dir() -> pathlib.Path:
    d = os.environ.get("ORCHA_PREVIEW_DIR")
    return pathlib.Path(d) if d else pathlib.Path.home() / ".orcha" / "previews"


# ------------------------------------------------------------------ validation / rendering

def valid_branch(branch: Optional[str]) -> bool:
    b = branch or ""
    return bool(_BRANCH.match(b)) and ".." not in b and "//" not in b and "@{" not in b \
        and not b.endswith((".lock", "/", "."))


def valid_port(port) -> bool:
    return isinstance(port, int) and not isinstance(port, bool) and PORT_MIN <= port <= PORT_MAX


def render_command(command: str, *, port: int, worktree: str, branch: Optional[str]) -> str:
    """Substitute the three placeholders — and nothing else — into the project's command."""
    if not valid_port(port):
        raise PreviewError(f"invalid port {port!r}")
    if branch and not valid_branch(branch):
        raise PreviewError("the task's branch name isn't a plain git ref")
    return (command.replace("{port}", str(port))
            .replace("{worktree}", shlex.quote(worktree))
            .replace("{branch}", shlex.quote(branch or "")))


def free_port(bind: Callable[[], int] | None = None) -> int:
    """A port nothing listens on right now (the OS picks one), within PORT_MIN..PORT_MAX."""
    for _ in range(20):
        if bind:
            port = bind()
        else:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", 0))
                port = s.getsockname()[1]
        if valid_port(port):
            return port
    raise PreviewError("no free port was available")


def preview_env(port: int) -> dict:
    env = {k: v for k, v in os.environ.items() if not _SECRET_ENV.match(k)}
    env["PORT"] = str(port)
    env["ORCHA_PREVIEW"] = "1"  # a hint for scripts; ORCHA_* secrets were dropped above
    return env


def _git(args, cwd, timeout=60.0):
    try:
        p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, str(e)


_SHELL_CHARS = re.compile(r"[^A-Za-z0-9 ._/@+,:=%~-]")


def _plain_path(path: str) -> str:
    """Refuse a path with shell syntax in it ($, `, quotes, ;, |, &, parentheses, newlines …).
    {worktree} is shell-quoted anyway, but a project command may put it inside double quotes,
    where a quoted `$(…)` would still run — so such a path never reaches the command at all."""
    if _SHELL_CHARS.search(path):
        raise PreviewError("the task's worktree path contains shell characters, so it won't be run")
    return path


def resolve_checkout(claim: dict, project_cwd: str, *, git=_git) -> tuple[str, Optional[str]]:
    """(directory to run in, throwaway worktree to remove afterwards or None). Raises
    PreviewError with plain words when the task's change can't be found safely."""
    base = os.path.realpath(project_cwd)
    trees = os.path.join(base, ".orcha-worktrees")
    recorded_base = claim.get("base_cwd")
    if recorded_base and os.path.realpath(recorded_base) != base:
        raise PreviewError(f"the task ran in {recorded_base}, but this notifier serves {base}")
    wt = claim.get("worktree")
    if wt:
        rp = os.path.realpath(wt)
        inside = rp == base or (os.path.dirname(rp) == trees and os.path.basename(rp) != "")
        if not inside:
            raise PreviewError(f"the task's worktree {wt} is outside this project's checkout")
        if os.path.isdir(rp) and os.path.exists(os.path.join(rp, ".git")):
            return _plain_path(rp), None
    branch = claim.get("branch")
    if not branch:
        raise PreviewError("the task's worktree is gone and no branch was recorded")
    if not valid_branch(branch):
        raise PreviewError("the task's branch name isn't a plain git ref")
    code, _ = git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], base)
    if code != 0:
        raise PreviewError(f"the task's worktree is gone and its branch '{branch}' isn't in {base}")
    pid = str(claim.get("id") or "")
    if not _ID.match(pid):
        raise PreviewError("invalid preview id")
    temp = _plain_path(os.path.join(trees, f"preview-{pid[:8]}"))
    if os.path.exists(temp):
        git(["worktree", "remove", "--force", temp], base)
    code, out = git(["worktree", "add", "--detach", temp, f"refs/heads/{branch}"], base)
    if code != 0:
        raise PreviewError(f"could not check out branch '{branch}' for the preview: {out[-300:]}")
    return temp, temp


def read_tail(path, max_lines: int = LOG_TAIL_LINES) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - LOG_TAIL_BYTES))
            data = f.read().decode("utf-8", "replace")
    except OSError:
        return ""
    lines = data.splitlines()
    return "\n".join(lines[-max_lines:])


def check_ready(port: int, path: str, timeout: float = 2.0) -> tuple[bool, Optional[str]]:
    """(answered below 400, last answer for the message)."""
    url = f"http://127.0.0.1:{int(port)}{path if path.startswith('/') else '/' + path}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            code = getattr(r, "status", None) or r.getcode()
            return code < 400, f"HTTP {code}"
    except urllib.error.HTTPError as e:
        return e.code < 400, f"HTTP {e.code}"
    except (urllib.error.URLError, OSError, ValueError) as e:
        return False, None if isinstance(e, (ConnectionRefusedError, urllib.error.URLError)) else str(e)


# ------------------------------------------------------------------ one preview

class Preview:
    def __init__(self, claim: dict, *, cwd: str, temp_worktree: Optional[str], base: str, port: int,
                 proc, log_path: pathlib.Path, clock=time.monotonic):
        self.id = claim["id"]
        self.claim = claim
        self.cwd = cwd
        self.temp_worktree = temp_worktree
        self.base = base
        self.port = port
        self.proc = proc
        self.log_path = log_path
        self.ready_path = claim.get("ready_path") or "/"
        self.timeout_s = float(claim.get("timeout_seconds") or 120)
        self.ttl_s = float(claim.get("ttl_minutes") or 60) * 60.0
        self.clock = clock
        self.started = clock()
        self.status = "starting"
        self.result: Optional[tuple] = None  # set by the ready thread: ("ready",) / ("failed", why)
        self.last_heartbeat = 0.0
        self.thread: Optional[threading.Thread] = None

    def tail(self) -> str:
        return read_tail(self.log_path)

    def wait_ready(self, *, checker=check_ready, sleep=time.sleep, stop: Optional[threading.Event] = None):
        """Poll the ready check until it answers, the process exits, or the timeout passes."""
        last = None
        deadline = self.clock() + self.timeout_s
        while self.clock() < deadline:
            if stop is not None and stop.is_set():
                return
            code = self.proc.poll()
            if code is not None:
                self.result = ("failed", f"the preview command exited with code {code} before it answered")
                return
            ok, answer = checker(self.port, self.ready_path)
            if answer:
                last = answer
            if ok:
                self.result = ("ready",)
                return
            sleep(READY_POLL_S)
        self.result = ("failed", f"it didn't answer {self.ready_path} on port {self.port} within "
                                 f"{int(self.timeout_s)}s" + (f" (last answer: {last})" if last else ""))


def _pidfile(pid_id: str) -> pathlib.Path:
    return log_dir() / f"{pid_id}.pid"


def start_preview(claim: dict, project_cwd: str, *, popen=subprocess.Popen, git=_git, port_picker=free_port,
                  clock=time.monotonic) -> Preview:
    """Run the claimed preview command. Raises PreviewError (plain words)."""
    if not _ID.match(str(claim.get("id") or "")):
        raise PreviewError("invalid preview id")
    command = claim.get("command") or ""
    if not command.strip() or any(c in command for c in ("\x00", "\n", "\r")):
        raise PreviewError("the preview command is empty or not a single line")
    cwd, temp = resolve_checkout(claim, project_cwd, git=git)
    try:
        port = port_picker()
        rendered = render_command(command, port=port, worktree=cwd, branch=claim.get("branch"))
        d = log_dir()
        d.mkdir(parents=True, exist_ok=True)
        log_path = d / f"{claim['id']}.log"
        with open(log_path, "ab") as logf:
            logf.write(f"$ {rendered}\n  (in {cwd}, port {port})\n".encode())
            logf.flush()
            proc = popen(["/bin/sh", "-c", rendered], cwd=cwd, env=preview_env(port), stdin=subprocess.DEVNULL,
                         stdout=logf, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            _pidfile(claim["id"]).write_text(json.dumps({"pid": proc.pid, "started": _proc_started(proc.pid),
                                                          "command": rendered,
                                                          "container": claim.get("container_id")}))
        except OSError:
            pass
    except PreviewError:
        _remove_worktree(project_cwd, temp, git)
        raise
    except OSError as e:
        _remove_worktree(project_cwd, temp, git)
        raise PreviewError(f"could not start the preview command: {e}") from e
    return Preview(claim, cwd=cwd, temp_worktree=temp, base=os.path.realpath(project_cwd), port=port, proc=proc,
                   log_path=log_path, clock=clock)


def _proc_started(pid: int) -> Optional[str]:
    try:
        out = subprocess.run(["ps", "-p", str(int(pid)), "-o", "lstart="], capture_output=True, text=True,
                             timeout=5).stdout.strip()
        return out or None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _remove_worktree(project_cwd, temp, git=_git):
    if temp:
        git(["worktree", "remove", "--force", temp], os.path.realpath(project_cwd))


def kill_group(proc, *, grace: float = KILL_GRACE_S) -> None:
    """TERM the preview's whole process group (the shell and everything it started), then KILL."""
    if proc is None or proc.poll() is not None:
        return
    try:
        pgid = os.getpgid(proc.pid)
    except OSError:
        pgid = None
    try:
        if pgid:
            os.killpg(pgid, signal.SIGTERM)
        else:
            proc.terminate()
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(pgid, signal.SIGKILL) if pgid else proc.kill()
        except OSError:
            pass
        try:
            proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            pass
    except OSError:
        pass


def stop_preview(p: Preview, *, git=_git) -> None:
    kill_group(p.proc)
    _remove_worktree(p.base, p.temp_worktree, git)
    try:
        _pidfile(p.id).unlink()
    except OSError:
        pass


# ------------------------------------------------------------------ the daemon hook

class PreviewState:
    """Previews this daemon is running, keyed by preview id."""

    def __init__(self):
        self.active: dict[str, Preview] = {}
        self.recovered = False


def _default_post(url, body, timeout=8.0):
    from .notifier_host import _post_json

    return _post_json(url, body, timeout=timeout)


def recover_orphans(api_base: str, cid: str, *, post=_default_post, quiet: bool = True) -> int:
    """Stop previews a previous daemon of THIS project left running (their pid files survive a
    crash; files of other projects' daemons are left alone)."""
    n = 0
    try:
        files = list(log_dir().glob("*.pid"))
    except OSError:
        return 0
    for f in files:
        pid_id = f.stem
        try:
            info = json.loads(f.read_text())
            if info.get("container") != cid:
                continue
            pid = int(info["pid"])
            # the same process (pid + start time), not a reused pid → stop its whole group
            if info.get("started") and _proc_started(pid) == info["started"]:
                os.killpg(pid, signal.SIGTERM)
                n += 1
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            pass
        try:
            f.unlink()
        except OSError:
            pass
        if _ID.match(pid_id):
            post(f"{api_base}/api/verdikt/previews/{pid_id}/stopped",
                 {"reason": "the notifier restarted", "log_tail": read_tail(log_dir() / f"{pid_id}.log")})
    if n and not quiet:
        print(f"[notifier] stopped {n} preview(s) left by a previous daemon")
    return n


def service_previews(api_base: str, cid: str, state: PreviewState, project_cwd: Optional[str], *,
                     quiet: bool = True, dry_run: bool = False, post=_default_post, start=start_preview,
                     stop=stop_preview, clock=time.monotonic, claimed_by: Optional[str] = None) -> None:
    """One daemon tick of preview work. Never raises."""
    if dry_run or not project_cwd:
        return
    try:
        if not state.recovered:
            state.recovered = True
            recover_orphans(api_base, cid, post=post, quiet=quiet)
        _advance(api_base, state, post=post, stop=stop, clock=clock, quiet=quiet)
        if len(state.active) < MAX_ACTIVE:
            _claim(api_base, cid, state, project_cwd, post=post, start=start, quiet=quiet, clock=clock,
                   claimed_by=claimed_by or f"{socket.gethostname()} pid {os.getpid()}")
    except Exception as e:  # noqa: BLE001 — a preview hiccup must never stall agent wakes
        if not quiet:
            print(f"[notifier] preview error (continuing): {type(e).__name__}: {e}", file=sys.stderr)


def _claim(api_base, cid, state, project_cwd, *, post, start, quiet, claimed_by, clock=time.monotonic):
    res = post(f"{api_base}/api/containers/{cid}/verdikt/previews/claim", {"claimed_by": claimed_by})
    claim = (res or {}).get("preview") if isinstance(res, dict) else None
    if not claim:
        return
    claim = {**claim, "container_id": cid}
    try:
        p = start(claim, project_cwd)
    except PreviewError as e:
        post(f"{api_base}/api/verdikt/previews/{claim.get('id')}/failed", {"error": str(e)})
        if not quiet:
            print(f"[notifier] preview {str(claim.get('id'))[:8]} failed: {e}")
        return
    p.clock, p.started = clock, clock()  # the TTL runs on the daemon's clock
    state.active[p.id] = p
    p.thread = threading.Thread(target=p.wait_ready, name=f"preview-ready-{p.id[:8]}", daemon=True)
    p.thread.start()
    if not quiet:
        print(f"[notifier] preview {p.id[:8]} starting on port {p.port} in {p.cwd}")


def _finish(api_base, state, p, route, body, *, post, stop):
    stop(p)
    state.active.pop(p.id, None)
    post(f"{api_base}/api/verdikt/previews/{p.id}/{route}", {**body, "log_tail": p.tail()})


def _advance(api_base, state, *, post, stop, clock, quiet):
    for p in list(state.active.values()):
        now = clock()
        if p.status == "starting" and p.result:
            if p.result[0] == "ready":
                p.status = "ready"
                p.last_heartbeat = now
                res = post(f"{api_base}/api/verdikt/previews/{p.id}/ready",
                           {"port": p.port, "log_tail": p.tail()}, timeout=60.0)
                if not quiet:
                    print(f"[notifier] preview {p.id[:8]} ready on port {p.port}")
                if isinstance(res, dict) and res.get("stop"):
                    _finish(api_base, state, p, "stopped", {"reason": res.get("reason") or "stop requested"},
                            post=post, stop=stop)
            else:
                _finish(api_base, state, p, "failed", {"error": p.result[1]}, post=post, stop=stop)
            continue
        if now - p.started >= p.ttl_s:
            _finish(api_base, state, p, "stopped",
                    {"reason": f"it reached its time limit ({int(p.ttl_s // 60)} min)"}, post=post, stop=stop)
            continue
        if p.status == "ready":
            code = p.proc.poll()
            if code is not None:
                _finish(api_base, state, p, "stopped",
                        {"reason": f"the preview process exited with code {code}", "exited": True},
                        post=post, stop=stop)
                continue
        if now - p.last_heartbeat >= HEARTBEAT_EVERY_S:
            p.last_heartbeat = now
            res = post(f"{api_base}/api/verdikt/previews/{p.id}/heartbeat", {"log_tail": p.tail()})
            if isinstance(res, dict) and res.get("stop"):
                _finish(api_base, state, p, "stopped", {"reason": res.get("reason") or "stop requested"},
                        post=post, stop=stop)
                if not quiet:
                    print(f"[notifier] preview {p.id[:8]} stopped: {res.get('reason')}")


def stop_all(api_base: str, state: PreviewState, reason: str = "the notifier stopped", *,
             post=_default_post, stop=stop_preview) -> None:
    """Daemon exit: stop every preview this daemon runs. Never raises."""
    for p in list(state.active.values()):
        try:
            _finish(api_base, state, p, "stopped", {"reason": reason}, post=post, stop=stop)
        except Exception:  # noqa: BLE001
            state.active.pop(p.id, None)
