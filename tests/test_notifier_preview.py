"""The notifier's preview runner (orcha_cli/notifier_preview.py, mig 064) — with REAL processes.

A preview starts on a free port in the task's worktree, the ready check succeeds or times out,
the whole process group is killed after the Verdikt run and on the TTL, output is captured to
a log whose tail is reported, a daemon restart cleans up leftovers, and nothing from the task
can reach the shell (only {port}/{worktree}/{branch} are substituted, validated and quoted).
The last test runs the real portal routes + this runner + the fake Verdikt end to end.
"""
import asyncio
import json
import os
import pathlib
import shlex
import signal
import subprocess
import sys
import time
import urllib.request

import pytest
from fastapi.testclient import TestClient

from orcha_cli import notifier_command
from orcha_cli import notifier_preview as npv
from conftest import ts_ago

PY = shlex.quote(sys.executable)
SERVE = f"{PY} -m http.server {{port}} --bind 127.0.0.1"
PID = "0a1b2c3d-0000-4000-8000-00000000abcd"


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A project checkout with one agent worktree (`.orcha-worktrees/task-pixel-1`) whose branch
    serves a page the main checkout doesn't have."""
    monkeypatch.setenv("ORCHA_PREVIEW_DIR", str(tmp_path / "previews"))
    base = tmp_path / "acme"
    base.mkdir()
    _git(["init", "-q", "-b", "main"], base)
    _git(["config", "user.email", "t@t"], base)
    _git(["config", "user.name", "t"], base)
    (base / "index.html").write_text("<h1>main</h1>")
    _git(["add", "."], base)
    _git(["commit", "-qm", "main"], base)
    wt = base / ".orcha-worktrees" / "task-pixel-1"
    _git(["worktree", "add", "-q", "-b", "orcha/task-pixel-1", str(wt)], base)
    (wt / "index.html").write_text("<h1>the agent's change</h1>")
    _git(["commit", "-qam", "change"], wt)
    return {"base": str(base), "wt": str(wt), "tmp": tmp_path}


def _claim(repo, **kw):
    c = {"id": PID, "task_id": "t1", "verdikt_run_id": "r1", "command": SERVE, "ready_path": "/",
         "timeout_seconds": 20, "ttl_minutes": 60, "worktree": repo["wt"], "branch": "orcha/task-pixel-1",
         "base_cwd": repo["base"]}
    c.update(kw)
    return c


class Portal:
    """A fake portal for the notifier: hands out one claim, records every report."""

    def __init__(self, claim=None, heartbeat=None):
        self.claims = [claim] if claim else []
        self.calls = []
        self.heartbeat = heartbeat or {"stop": False, "reason": None}

    def post(self, url, body, timeout=8.0):
        route = url.split("/api/", 1)[1]
        self.calls.append((route, body))
        if route.endswith("/verdikt/previews/claim"):
            return {"preview": self.claims.pop(0) if self.claims else None}
        if route.endswith("/heartbeat"):
            return self.heartbeat
        if route.endswith("/ready"):
            return {"stop": False}
        return {"ok": True}

    def routes(self):
        return [r.rsplit("/", 1)[-1] for r, _ in self.calls]

    def last(self, name):
        return next(b for r, b in reversed(self.calls) if r.endswith("/" + name))


def _tick_until(state, portal, repo, pred, *, timeout=20.0, clock=time.monotonic):
    end = time.time() + timeout
    while time.time() < end:
        npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post, clock=clock)
        if pred():
            return True
        time.sleep(0.2)
    return pred()


def _get(url, timeout=2.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read().decode()


def _dead(pid) -> bool:
    try:
        os.killpg(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except PermissionError:
        return False


# ------------------------------------------------------------------ pure pieces

def test_render_command_substitutes_only_the_three_placeholders_quoted():
    cmd = "cd {worktree} && echo {branch} {title} ${HOME} && serve -l {port}"
    out = npv.render_command(cmd, port=41001, worktree="/w/a b;touch x", branch="orcha/task-1")
    assert out == "cd '/w/a b;touch x' && echo orcha/task-1 {title} ${HOME} && serve -l 41001"
    assert shlex.split(out)[1] == "/w/a b;touch x"
    for port in (0, 80, 65536, "41001", True, None):
        with pytest.raises(npv.PreviewError):
            npv.render_command(cmd, port=port, worktree="/w", branch=None)
    for bad in ("$(touch pwned)", "a;b", "a b", "-x", "a..b", "a//b", "a@{1}", "x.lock", "`id`", "a\nb"):
        assert not npv.valid_branch(bad), bad
        with pytest.raises(npv.PreviewError):
            npv.render_command(cmd, port=41001, worktree="/w", branch=bad)
    assert npv.valid_branch("orcha/task-pixel-0a1b2c3d4e5f") and npv.valid_branch("feature/x_y.z")


def test_free_port_is_a_valid_unused_port():
    p = npv.free_port()
    assert npv.PORT_MIN <= p <= npv.PORT_MAX
    seq = iter([80, 0, 41999])
    assert npv.free_port(bind=lambda: next(seq)) == 41999
    with pytest.raises(npv.PreviewError):
        npv.free_port(bind=lambda: 22)


def test_resolve_checkout_confines_paths(repo, tmp_path):
    assert npv.resolve_checkout(_claim(repo), repo["base"]) == (os.path.realpath(repo["wt"]), None)
    assert npv.resolve_checkout(_claim(repo, worktree=repo["base"]), repo["base"])[0] == os.path.realpath(repo["base"])
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    for wt in (str(outside), repo["base"] + "/.orcha-worktrees/../../elsewhere", "/etc",
               repo["base"] + "/.orcha-worktrees/task-pixel-1/sub"):
        with pytest.raises(npv.PreviewError, match="outside this project's checkout"):
            npv.resolve_checkout(_claim(repo, worktree=wt), repo["base"])
    # a symlink out of the project is caught by realpath
    link = pathlib.Path(repo["base"]) / ".orcha-worktrees" / "task-evil"
    link.symlink_to(outside)
    with pytest.raises(npv.PreviewError, match="outside"):
        npv.resolve_checkout(_claim(repo, worktree=str(link)), repo["base"])
    with pytest.raises(npv.PreviewError, match="this notifier serves"):
        npv.resolve_checkout(_claim(repo, base_cwd=str(outside)), repo["base"])
    with pytest.raises(npv.PreviewError, match="no branch was recorded"):
        npv.resolve_checkout(_claim(repo, worktree=None, branch=None), repo["base"])
    with pytest.raises(npv.PreviewError, match="isn't in"):
        npv.resolve_checkout(_claim(repo, worktree=None, branch="orcha/nope"), repo["base"])
    marker = pathlib.Path(repo["base"]) / "pwned"
    with pytest.raises(npv.PreviewError, match="plain git ref"):
        npv.resolve_checkout(_claim(repo, worktree=None, branch="$(touch pwned)"), repo["base"])
    assert not marker.exists()


def test_a_removed_worktree_is_rebuilt_from_its_branch_and_cleaned_up(repo):
    gone = repo["base"] + "/.orcha-worktrees/task-gone"
    cwd, temp = npv.resolve_checkout(_claim(repo, worktree=gone), repo["base"])
    assert temp == cwd and cwd.endswith("/.orcha-worktrees/preview-0a1b2c3d")
    assert "the agent's change" in pathlib.Path(cwd, "index.html").read_text()
    npv._remove_worktree(repo["base"], temp)
    assert not os.path.exists(temp)


# ------------------------------------------------------------------ real processes

def test_preview_starts_on_a_free_port_reports_ready_and_is_killed_after_the_run(repo):
    portal = Portal(_claim(repo))
    state = npv.PreviewState()
    assert _tick_until(state, portal, repo, lambda: "ready" in portal.routes())
    p = state.active[PID]
    body = portal.last("ready")
    assert body["port"] == p.port and npv.PORT_MIN <= p.port <= npv.PORT_MAX
    # it serves the TASK's worktree, not the main checkout
    assert _get(f"http://127.0.0.1:{p.port}/") == "<h1>the agent's change</h1>"
    # the log is captured; its tail goes with every report
    log = pathlib.Path(os.environ["ORCHA_PREVIEW_DIR"]) / f"{PID}.log"
    assert log.read_text().startswith("$ ") and f"port {p.port}" in log.read_text()
    assert (pathlib.Path(os.environ["ORCHA_PREVIEW_DIR"]) / f"{PID}.pid").exists()
    time.sleep(0.3)
    p.last_heartbeat = 0
    npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post)
    hb = portal.last("heartbeat")
    assert '"GET / HTTP/1.1" 200' in hb["log_tail"]
    # the Verdikt run finished → the portal says stop → the whole group is killed
    portal.heartbeat = {"stop": True, "reason": "the Verdikt run is completed"}
    p.last_heartbeat = 0
    npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post)
    assert PID not in state.active
    assert p.proc.poll() is not None and _dead(p.proc.pid)
    assert portal.last("stopped")["reason"] == "the Verdikt run is completed"
    assert not (pathlib.Path(os.environ["ORCHA_PREVIEW_DIR"]) / f"{PID}.pid").exists()
    with pytest.raises(OSError):
        _get(f"http://127.0.0.1:{p.port}/", timeout=1)


def test_ready_check_times_out_with_the_last_answer(repo):
    # a server that answers, but not on the ready path
    portal = Portal(_claim(repo, ready_path="/health", timeout_seconds=2))
    state = npv.PreviewState()
    assert _tick_until(state, portal, repo, lambda: "failed" in portal.routes())
    err = portal.last("failed")["error"]
    assert err.startswith("it didn't answer /health on port ") and "within 2s (last answer: HTTP 404)" in err
    assert not state.active
    # a command that never listens
    portal = Portal(_claim(repo, command="sleep 30 # {port}", timeout_seconds=1))
    state = npv.PreviewState()
    assert _tick_until(state, portal, repo, lambda: "failed" in portal.routes())
    assert "within 1s" in portal.last("failed")["error"] and "last answer" not in portal.last("failed")["error"]


def test_a_command_that_exits_fails_with_its_code_and_log(repo):
    portal = Portal(_claim(repo, command="echo 'npm ERR! missing script: build' {port}; exit 3"))
    state = npv.PreviewState()
    assert _tick_until(state, portal, repo, lambda: "failed" in portal.routes())
    body = portal.last("failed")
    assert body["error"] == "the preview command exited with code 3 before it answered"
    assert "npm ERR! missing script: build" in body["log_tail"]


def test_bad_checkout_is_reported_not_run(repo):
    portal = Portal(_claim(repo, worktree="/etc", command="touch /tmp/never-{port}"))
    state = npv.PreviewState()
    npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post)
    assert portal.routes() == ["claim", "failed"] and "outside" in portal.last("failed")["error"]
    assert not state.active


def test_ttl_kills_the_whole_process_group(repo):
    now = [1000.0]
    # the shell starts a background child too: the TTL must take it down with the server
    cmd = "sleep 300 & " + SERVE
    portal = Portal(_claim(repo, command=cmd, ttl_minutes=1))
    state = npv.PreviewState()
    assert _tick_until(state, portal, repo, lambda: "ready" in portal.routes(), clock=lambda: now[0])
    p = state.active[PID]
    pgid = os.getpgid(p.proc.pid)
    assert pgid == p.proc.pid  # its own group, not the daemon's
    now[0] += 61
    npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post, clock=lambda: now[0],
                         quiet=False)
    assert "stopped" in portal.routes(), portal.calls
    assert portal.last("stopped")["reason"] == "it reached its time limit (1 min)", portal.calls
    assert _dead(pgid)
    out = subprocess.run(["pgrep", "-g", str(pgid)], capture_output=True, text=True).stdout.strip()
    assert out == ""


def test_a_preview_that_dies_is_reported_as_stopped(repo):
    portal = Portal(_claim(repo))
    state = npv.PreviewState()
    assert _tick_until(state, portal, repo, lambda: "ready" in portal.routes())
    p = state.active[PID]
    os.killpg(p.proc.pid, signal.SIGKILL)
    p.proc.wait(5)
    npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post)
    st = portal.last("stopped")
    assert st["exited"] is True and st["reason"] == "the preview process exited with code -9"


def test_no_shell_injection_from_task_data_and_no_secrets(repo, monkeypatch):
    """Task text in the claim is never used; a worktree/branch with shell syntax is refused before
    anything runs (even a command that puts {worktree} inside double quotes stays safe); Orcha's
    secrets are not in the command's environment."""
    monkeypatch.setenv("ORCHA_SECRET_KEY", "super-secret")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-x")
    careless = "echo \"wt=[{worktree}] br=[{branch}] key=[$ORCHA_SECRET_KEY$ANTHROPIC_API_KEY] port=[$PORT]\"; "
    evil = repo["base"] + "/.orcha-worktrees/task-$(touch pwned);touch pwned2"
    _git(["worktree", "add", "-q", "-b", "orcha/evil", evil], repo["base"])
    portal = Portal(_claim(repo, worktree=evil, branch="orcha/evil", command=careless + SERVE))
    state = npv.PreviewState()
    npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post)
    assert portal.routes() == ["claim", "failed"] and "shell characters" in portal.last("failed")["error"]
    # a removed worktree with an injected branch name: refused too
    portal = Portal(_claim(repo, worktree=None, branch="x;touch pwned5", command=careless + SERVE))
    npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post)
    assert "plain git ref" in portal.last("failed")["error"]
    # a normal worktree, with task text riding along in the claim: literal values, no secrets
    claim = _claim(repo, command=careless + "cd {worktree} && " + SERVE,
                   title="$(touch pwned3)", description="`touch pwned4`")
    portal = Portal(claim)
    assert _tick_until(state, portal, repo, lambda: "ready" in portal.routes())
    p = state.active[PID]
    log = p.tail()
    assert f"wt=[{os.path.realpath(repo['wt'])}] br=[orcha/task-pixel-1] key=[] port=[{p.port}]" in log
    assert "super-secret" not in log and "sk-ant" not in log
    for name in ("pwned", "pwned2", "pwned3", "pwned4", "pwned5"):
        for d in (repo["base"], evil, repo["wt"], os.getcwd()):
            assert not os.path.exists(os.path.join(d, name)), (d, name)
    npv.stop_all("http://portal", state, post=portal.post)
    assert portal.last("stopped")["reason"] == "the notifier stopped" and not state.active


def test_restart_recovers_this_projects_orphans_only(repo):
    d = pathlib.Path(os.environ["ORCHA_PREVIEW_DIR"])
    d.mkdir(parents=True, exist_ok=True)
    mine = subprocess.Popen(["/bin/sh", "-c", "sleep 300"], start_new_session=True)
    theirs = subprocess.Popen(["/bin/sh", "-c", "sleep 301"], start_new_session=True)
    other_id = "0a1b2c3d-0000-4000-8000-0000000000ff"
    stale = subprocess.Popen(["/bin/sh", "-c", "sleep 302"], start_new_session=True)
    stale_id = "0a1b2c3d-0000-4000-8000-0000000000ee"
    (d / f"{PID}.pid").write_text(json.dumps({"pid": mine.pid, "started": npv._proc_started(mine.pid),
                                              "command": "sleep 300", "container": "cid-1"}))
    (d / f"{other_id}.pid").write_text(json.dumps({"pid": theirs.pid, "started": npv._proc_started(theirs.pid),
                                                   "command": "sleep 301", "container": "cid-2"}))
    # a pid file whose pid now belongs to a different process (reused pid): never killed
    (d / f"{stale_id}.pid").write_text(json.dumps({"pid": stale.pid, "started": "Thu Jan  1 00:00:00 1970",
                                                   "command": "x", "container": "cid-1"}))
    try:
        portal = Portal()
        state = npv.PreviewState()
        npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post)
        mine.wait(5)
        assert mine.returncode is not None
        assert theirs.poll() is None  # another project's daemon owns that one
        assert stale.poll() is None   # not the process that was started
        assert (f"verdikt/previews/{PID}/stopped", {"reason": "the notifier restarted", "log_tail": ""}) in portal.calls
        assert (d / f"{other_id}.pid").exists() and not (d / f"{PID}.pid").exists()
        # only once per daemon
        npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post)
        assert [r for r in portal.routes() if r == "stopped"] == ["stopped", "stopped"]
    finally:
        for proc in (mine, theirs, stale):
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(5)


def test_dry_run_and_no_checkout_do_nothing(repo):
    portal = Portal(_claim(repo))
    state = npv.PreviewState()
    npv.service_previews("http://portal", "cid-1", state, repo["base"], post=portal.post, dry_run=True)
    npv.service_previews("http://portal", "cid-1", state, None, post=portal.post)
    assert portal.calls == [] and not state.active


def test_errors_never_escape_into_the_daemon(repo):
    def boom(*a, **k):
        raise RuntimeError("portal exploded")
    npv.service_previews("http://portal", "cid-1", npv.PreviewState(), repo["base"], post=boom)


def test_the_daemon_loop_wires_previews():
    import inspect

    src = inspect.getsource(notifier_command.cmd_notifier)
    assert src.count("_preview.service_previews(") == 1
    assert "_preview.stop_all(api_base, previews)" in src
    assert src.index("_preview.service_previews(") > src.index("maybe_sweep_expired(api_base, cid, services, quiet=args.quiet,\n                                                   dry_run")


# ------------------------------------------------------------------ end to end (portal + notifier)

async def test_end_to_end_portal_notifier_and_verdikt(client, container, make_agent, make_task, work_headers, db, repo):
    """The real portal routes, this runner (real processes) and the fake Verdikt: Verdikt is
    handed the running preview of the task's worktree, and the preview is stopped once the
    Verdikt run completes."""
    import main
    from fake_verdikt import FakeVerdikt
    from test_evidence_verdikt import _nv_task

    fake = FakeVerdikt()
    fake.base = fake.start()
    fake.add_project("shop-web")
    try:
        hid, _w, tid = await _nv_task(client, make_agent, make_task, work_headers, db=db)
        db.execute("UPDATE worker_runs SET worktree=%s, base_cwd=%s, branch='orcha/task-pixel-1' WHERE task_id=%s",
                   (repo["wt"], repo["base"], tid))
        cid = container["id"]
        r = await client.put(f"/api/containers/{cid}/verdikt", json={
            "actor_agent_id": hid, "enabled": True, "base_url": fake.base, "verdikt_project": "shop-web",
            "target_locator": "http://localhost:3000/", "preview_command": SERVE, "preview_timeout_seconds": 20})
        assert r.status_code == 200, r.text
        run = (await client.post(f"/api/tasks/{tid}/verdikt/runs", json={"actor_agent_id": hid})).json()
        assert run["preview"]["status"] == "requested"

        tc = TestClient(main.app)

        def post(url, body, timeout=8.0):
            resp = tc.post(url.split("http://portal", 1)[1], json=body)
            assert resp.status_code == 200, resp.text
            return resp.json()

        state = npv.PreviewState()

        def tick():
            npv.service_previews("http://portal", cid, state, repo["base"], post=post)

        async def until(pred, timeout=20.0):
            end = time.time() + timeout
            while time.time() < end:
                await asyncio.to_thread(tick)
                v = (await client.get(f"/api/tasks/{tid}/verdikt/runs")).json()["runs"][0]
                if pred(v):
                    return v
                await asyncio.sleep(0.2)
            raise AssertionError(f"timed out; last: {v['status']} / {v['preview']}")

        v = await until(lambda v: v["verdikt_request_id"] is not None)
        p = v["preview"]
        assert p["status"] == "ready" and v["locator"] == f"http://127.0.0.1:{p['port']}/"
        req = fake.tables["run_requests"][-1]
        assert req["locator"] == v["locator"]
        # what Verdikt's worker would open is the task's change
        assert _get(req["locator"]) == "<h1>the agent's change</h1>"
        proc = state.active[p["id"]].proc
        fake.complete(req["id"], "pass", [])
        db.execute(f"UPDATE verdikt_runs SET last_polled_at = {ts_ago(60)} WHERE id=%s", (run["id"],))
        for pv in state.active.values():
            pv.last_heartbeat = 0
        v = await until(lambda v: v["preview"]["status"] == "stopped")
        assert v["status"] == "completed" and v["verdict"] == "pass"
        assert "completed" in v["preview"]["stop_reason"]
        assert proc.poll() is not None and not state.active
        log = (await client.get(f"/api/tasks/{tid}/verdikt/runs/{run['id']}/preview/log")).json()
        assert any("GET / HTTP/1.1" in ln for ln in log["lines"])
    finally:
        npv.stop_all("http://portal", locals().get("state") or npv.PreviewState(), post=lambda *a, **k: None)
        fake.stop()
