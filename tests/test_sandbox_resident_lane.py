# tests/test_sandbox_resident_lane.py
"""Resident lane in sandbox mode (remote-runner un-deferral): spawn_resident wraps
its warm stream-json argv in `docker run -i` (stdin=PIPE contract preserved through
the docker client), fails loudly on preflight, stamps spawn_info; the boot threads
the container into the resident handle, each fed turn's run row records it, and
every resident termination path reaps container + per-run api-config."""
import io
import json
import re

from orcha_cli import notifier, sandbox
from orcha_cli import notifier_resident_live as _live_mod
from orcha_cli import notifier_resident_turn as _turn_mod

_DEAD_PID = 2_000_000        # > macOS max pid → os.kill always ProcessLookupError


def _sandbox_project(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({
        "api_base_url": "http://127.0.0.1:8000",
        "current_container_id": "CIDTEST",
        "sandbox": {"enabled": True},
    }))
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "docker-compose.yml").write_text("name: orcha-proj\n")
    return tmp_path


class CapturePopen:
    """Records argv + kwargs of a Popen call; exposes a writable stdin + a pid."""
    last = None

    def __init__(self, argv, **kw):
        CapturePopen.last = {"argv": argv, "kw": kw}
        self.argv = argv
        self.pid = 31337
        self.stdin = io.BytesIO()
        self.returncode = None

    def poll(self):
        return self.returncode


class ResidentProc:
    def __init__(self, alive=True, pid=4321):
        self.pid = pid
        self.returncode = None if alive else 0
        self.stdin = io.BytesIO()
    def poll(self):
        return self.returncode
    def kill(self):
        self.returncode = -9
    def terminate(self):
        self.returncode = -15
    def wait(self, timeout=None):
        return self.returncode


# ---------- spawn_resident: the docker-run -i wrap ----------

def test_build_docker_argv_interactive_inserts_dash_i():
    cfg = sandbox.SandboxConfig(enabled=True)
    argv = sandbox.build_docker_argv(
        ["claude", "-p"], cfg=cfg, name="orcha-run-x", workspace="/w",
        network=None, api_config_mount="/w/a.json", interactive=True)
    assert argv[:3] == ["docker", "run", "-i"]
    # default (one-shot wakes) stays exactly as before: no -i anywhere
    argv2 = sandbox.build_docker_argv(
        ["claude", "-p"], cfg=cfg, name="orcha-run-x", workspace="/w",
        network=None, api_config_mount="/w/a.json")
    assert argv2[:3] == ["docker", "run", "--name"] and "-i" not in argv2


def test_dry_run_repr_shows_docker_run_dash_i(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: None)  # #75: not under test here
    ok, repr_, proc = notifier.spawn_resident(str(proj), alias="Vox", dry_run=True)
    assert ok is False and proc is None
    assert "docker run -i" in repr_ and "orcha-run-" in repr_
    assert sandbox.DEFAULT_IMAGE in repr_


def test_sandbox_spawn_keeps_stdin_pipe_and_needs_no_host_claude(tmp_path, monkeypatch):
    """The whole point of the lane: `docker run -i` keeps the client's stdin piped
    to the container, so the notifier's stdin=PIPE turn feed survives the wrap —
    and a cloud box needs NO host claude install (the guard is sandbox-aware)."""
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: None)  # #75: not under test here
    monkeypatch.setattr(notifier.shutil, "which", lambda x: None)   # no host binary
    monkeypatch.setattr(notifier.subprocess, "Popen", CapturePopen)
    info = {}
    ok, repr_, proc = notifier.spawn_resident(str(proj), alias="Vox", spawn_info=info)
    assert ok is True and proc is not None
    argv = CapturePopen.last["argv"]
    assert argv[:3] == ["docker", "run", "-i"]
    assert CapturePopen.last["kw"]["stdin"] is notifier.subprocess.PIPE
    assert info["sandbox_container_id"].startswith("orcha-run-")
    assert argv[argv.index("--name") + 1] == info["sandbox_container_id"]
    # inner argv after the image: bare binary + the warm stream-json session
    tail = argv[argv.index(sandbox.DEFAULT_IMAGE) + 1:]
    assert tail[:2] == ["claude", "-p"]
    assert "--input-format" in tail and "stream-json" in tail
    # the sandbox-scoped api config was written and is mounted over the spawn
    # cwd's orcha.json (path-identical mounting: cwd == the root here)
    api_cfg = str(proj / ".orcha" / "sandbox" / f"{info['sandbox_container_id']}.json")
    assert (proj / ".orcha" / "sandbox" / f"{info['sandbox_container_id']}.json").exists()
    assert f"{api_cfg}:{proj}/.claude/orcha.json:ro" in argv


def test_preflight_failure_fails_resident_loudly_without_popen(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: "docker daemon unreachable")
    def _boom(*a, **k):
        raise AssertionError("must not spawn any process")
    monkeypatch.setattr(notifier.subprocess, "Popen", _boom)
    ok, repr_, proc = notifier.spawn_resident(str(proj), alias="Vox")
    assert ok is False and proc is None
    assert "sandbox unavailable" in repr_ and "docker daemon unreachable" in repr_


def test_api_config_write_failure_fails_resident_without_popen(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: None)  # #75: not under test here
    def _oserr(*a, **k):
        raise OSError("read-only filesystem")
    monkeypatch.setattr(sandbox, "write_api_config", _oserr)
    def _boom(*a, **k):
        raise AssertionError("must not spawn any process")
    monkeypatch.setattr(notifier.subprocess, "Popen", _boom)
    ok, repr_, proc = notifier.spawn_resident(str(proj), alias="Vox")
    assert ok is False and proc is None
    assert "sandbox unavailable" in repr_ and "api config" in repr_


def test_resident_spawn_stamps_project_cid_label(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: None)  # #75: not under test here
    captured = {}
    real_build = sandbox.build_docker_argv
    def _spy(inner_argv, **kw):
        captured["argv"] = real_build(inner_argv, **kw)
        captured["kw"] = kw
        return captured["argv"]
    monkeypatch.setattr(sandbox, "build_docker_argv", _spy)
    notifier.spawn_resident(str(proj), alias="Vox", dry_run=True)
    assert "--label orcha.cid=CIDTEST" in " ".join(captured["argv"])
    assert captured["kw"]["interactive"] is True


def test_resident_sandbox_inner_argv_uses_bare_binary(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: None)  # #75: not under test here
    monkeypatch.setattr(notifier, "_resolve_runtime_executable",
                        lambda runtime: "/opt/host/bin/claude")
    captured = {}
    real_build = sandbox.build_docker_argv
    def _spy(inner_argv, **kw):
        captured["inner"] = list(inner_argv)
        return real_build(inner_argv, **kw)
    monkeypatch.setattr(sandbox, "build_docker_argv", _spy)
    notifier.spawn_resident(str(proj), alias="Vox", dry_run=True)
    assert captured["inner"][0] == "claude"


def test_resident_sandbox_repr_never_leaks_persona(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: None)  # #75: not under test here
    ok, repr_, _ = notifier.spawn_resident(
        str(proj), alias="Vox", system_prompt="PERSONAxDIGESTxPAYLOAD", dry_run=True)
    assert "PERSONAxDIGESTxPAYLOAD" not in repr_
    assert "docker run -i" in repr_


def test_resident_dry_run_writes_nothing_into_project(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    before = {str(p) for p in proj.rglob("*")}
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: None)  # #75: not under test here
    notifier.spawn_resident(str(proj), alias="Vox", dry_run=True)
    assert not (proj / ".orcha" / "sandbox").exists()
    assert {str(p) for p in proj.rglob("*")} == before


def test_resident_host_mode_untouched(tmp_path, monkeypatch):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(
        {"api_base_url": "http://127.0.0.1:8000"}))
    ok, repr_, proc = notifier.spawn_resident(str(tmp_path), alias="Vox", dry_run=True)
    assert "docker run" not in repr_ and "claude -p" in repr_


# ---------- boot + feed: the container rides the handle and each turn's run row ----------

def _wire(monkeypatch, *, active, turns=None, claim=True):
    """Route notifier's HTTP helpers for a service_residents tick (house harness)."""
    posts = []

    def _get(url, **k):
        if "active-conversations" in url:
            return {"conversations": active}
        if "/turns" in url:
            m = re.search(r"after_seq=(\d+)", url)
            after = int(m.group(1)) if m else 0
            return {"turns": [t for t in (turns or []) if t.get("seq", 0) > after]}
        if "/conversation" in url:
            return {"conversation": {"id": "C1"}, "turns": turns or []}
        return None

    def _post(url, body, **k):
        posts.append((url, body))
        if "wake-claim" in url:
            return {"claimed": claim, "lease_kind": "resident"}
        if "embodiment-tokens" in url:
            return {"run_token": "TOK-1"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-1", "status": "running"}
        return {}

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "PERSONA")
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    return posts


def test_resident_boot_threads_container_into_handle_and_turn_run_row(monkeypatch, tmp_path):
    """END-TO-END through service_residents with the REAL spawn_resident (fake Popen):
    the boot stamps sandbox_container_id into the live handle, and the fed turn's run
    row carries it — with wake_kind kept 'resident' (that is what exempts the row
    from the one-shot deadline stop) plus base_cwd for the sweep's config reads."""
    proj = _sandbox_project(tmp_path)
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 1, "role": "human", "content": "hello"}])
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: None)  # #75: not under test here
    monkeypatch.setattr(notifier, "_is_git_repo", lambda p: False)  # spawn in base_cwd
    monkeypatch.setattr(notifier.subprocess, "Popen", CapturePopen)
    live = {}

    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(proj))

    sbx = live["C1"]["sandbox_container_id"]
    assert sbx and sbx.startswith("orcha-run-")
    assert CapturePopen.last["argv"][:3] == ["docker", "run", "-i"]
    run_post = next(b for u, b in posts if u.endswith("/runs"))
    assert run_post["wake_kind"] == "resident"           # NOT rewritten to 'sandbox'
    assert run_post["sandbox_container_id"] == sbx
    assert run_post["base_cwd"] == str(proj)
    assert live["C1"]["awaiting_result"] is True


def test_resident_boot_host_mode_run_row_has_no_container(monkeypatch, tmp_path):
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 1, "role": "human", "content": "hello"}])
    proc = ResidentProc()
    monkeypatch.setattr(notifier, "spawn_resident",
                        lambda *a, **k: (True, "repr", proc))
    live = {}
    notifier.service_residents("http://x", "cid", live, quiet=True, base_cwd=str(tmp_path))
    run_post = next(b for u, b in posts if u.endswith("/runs"))
    assert "sandbox_container_id" not in run_post
    assert live["C1"]["sandbox_container_id"] is None


def test_resident_preflight_failure_releases_lane_and_surfaces_reason(monkeypatch, tmp_path, capsys):
    """Fail LOUD (spec §3.2) end-to-end: sandbox mode + failing preflight → the boot
    never Popens, releases the conversation lane, registers no resident, and the
    '(sandbox unavailable: …)' reason lands in the notifier's output instead of the
    conversation silently queueing forever."""
    proj = _sandbox_project(tmp_path)
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": None, "pending_human": True, "last_turn_seq": 1}
    posts = _wire(monkeypatch, active=[conv],
                  turns=[{"seq": 1, "role": "human", "content": "hello"}])
    monkeypatch.setattr(sandbox, "preflight",
                        lambda cfg, ws: "runner image orcha/runner:0.5 not present")
    monkeypatch.setattr(notifier, "_is_git_repo", lambda p: False)  # spawn in base_cwd
    def _boom(*a, **k):
        raise AssertionError("must not spawn any process")
    monkeypatch.setattr(notifier.subprocess, "Popen", _boom)
    live = {}

    notifier.service_residents("http://x", "cid", live, quiet=False, base_cwd=str(proj))

    assert live == {}
    assert any("wake-ack" in u and b.get("kind") == "resident_failed"
               and b.get("release_lease") and b.get("lane") == "conversation"
               for u, b in posts)
    out = capsys.readouterr().out
    assert "sandbox unavailable" in out and "runner image" in out


# ---------- termination paths: every resident close reaps its container ----------

def _sandbox_reap_fakes(monkeypatch):
    calls = {"remove": [], "remove_api_config": []}
    monkeypatch.setattr(notifier._sandbox, "remove",
                        lambda n, force=False: calls["remove"].append((n, force)))
    monkeypatch.setattr(notifier._sandbox, "remove_api_config",
                        lambda cwd, n: calls["remove_api_config"].append((str(cwd), n)))
    return calls


def test_close_resident_reaps_container_and_api_config(tmp_path, monkeypatch):
    """The idle-timeout kill path (_close_resident, reason='idle') — the container is
    spawned without --rm by design, so the close must remove it (force: the kill only
    took down the docker client) and its per-run api-config."""
    calls = _sandbox_reap_fakes(monkeypatch)
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda u, b=None, **k: posts.append((u, b)) or {})
    monkeypatch.setattr(notifier, "_kill_worker", lambda p, **k: p.kill())
    resident = {"proc": ResidentProc(), "agent_id": "A1", "alias": "Vox",
                "base_cwd": str(tmp_path), "worktree": None, "current_run_id": None,
                "log_path": None, "sandbox_container_id": "orcha-run-warm"}
    notifier._close_resident("http://x", resident, reason="idle")
    assert calls["remove"] == [("orcha-run-warm", True)]
    assert calls["remove_api_config"] == [(str(tmp_path), "orcha-run-warm")]
    assert any("wake-ack" in u and b.get("kind") == "resident_idle" for u, b in posts)


def test_close_resident_host_mode_never_touches_docker(tmp_path, monkeypatch):
    calls = _sandbox_reap_fakes(monkeypatch)
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: {})
    monkeypatch.setattr(notifier, "_kill_worker", lambda p, **k: p.kill())
    resident = {"proc": ResidentProc(), "agent_id": "A1", "alias": "Vox",
                "base_cwd": str(tmp_path), "current_run_id": None, "log_path": None}
    notifier._close_resident("http://x", resident, reason="idle")
    assert calls["remove"] == [] and calls["remove_api_config"] == []


def test_close_resident_keeps_container_when_finish_post_fails(tmp_path, monkeypatch):
    """I5: a mid-turn close whose finish stamp did NOT land must keep the exited
    container as evidence — the container-liveness sweep re-stamps + removes it."""
    calls = _sandbox_reap_fakes(monkeypatch)
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: None)
    monkeypatch.setattr(notifier, "_kill_worker", lambda p, **k: p.kill())
    resident = {"proc": ResidentProc(), "agent_id": "A1", "alias": "Vox",
                "base_cwd": str(tmp_path), "current_run_id": "RUN-5",
                "log_path": None, "sandbox_container_id": "orcha-run-warm"}
    notifier._close_resident("http://x", resident, reason="idle")
    assert calls["remove"] == [] and calls["remove_api_config"] == []


def test_close_resident_reaps_live_sidecar_container_too(tmp_path, monkeypatch):
    """A close that kills a still-running drain sidecar must reap the sidecar's
    container as well: it is row-less by design AND label-exempt from the orphan
    pass, so nothing else would EVER remove it."""
    calls = _sandbox_reap_fakes(monkeypatch)
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: {})
    monkeypatch.setattr(notifier, "_kill_worker", lambda p, **k: p.kill())
    sidecar = {"proc": ResidentProc(), "sandbox_container_id": "orcha-run-side",
               "base_cwd": str(tmp_path)}
    resident = {"proc": ResidentProc(), "agent_id": "A1", "alias": "Vox",
                "base_cwd": str(tmp_path), "current_run_id": None, "log_path": None,
                "sidecar": sidecar}
    notifier._close_resident("http://x", resident, reason="idle")
    assert ("orcha-run-side", True) in calls["remove"]
    assert resident["sidecar"] is None


def test_resident_self_exit_reaps_container_after_stamp(tmp_path, monkeypatch):
    """_handle_exited (the docker client exited on its own): finish the in-flight
    turn's row from the real returncode, THEN reap the container."""
    calls = _sandbox_reap_fakes(monkeypatch)
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda u, b=None, **k: posts.append((u, b)) or {})
    resident = {"proc": ResidentProc(alive=False), "agent_id": "A1", "alias": "Vox",
                "base_cwd": str(tmp_path), "worktree": None, "current_run_id": "RUN-9",
                "log_path": None, "cold": True, "booted_ts": 0,
                "sandbox_container_id": "orcha-run-warm"}
    _live_mod._handle_exited(notifier, "http://x", "C1", resident, {"C1": resident}, True)
    assert any("/runs/RUN-9/finish" in u for u, _ in posts)
    assert calls["remove"] == [("orcha-run-warm", True)]
    assert calls["remove_api_config"] == [(str(tmp_path), "orcha-run-warm")]


def test_stop_turn_reaps_container_after_stamp(tmp_path, monkeypatch):
    """A human stop mid-turn kills the docker client and stamps the row — the
    container must be reaped right there (force-rm; it may still be running)."""
    calls = _sandbox_reap_fakes(monkeypatch)
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda u, b=None, **k: posts.append((u, b)) or {})
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_kill_worker", lambda p, **k: p.kill())
    monkeypatch.setattr(notifier, "_post_conversation_reply", lambda *a, **k: True)
    monkeypatch.setattr(notifier, "_capture_diff", lambda w: None)
    resident = {"proc": ResidentProc(), "agent_id": "A1", "alias": "Vox",
                "base_cwd": str(tmp_path), "worktree": None, "current_run_id": "RUN-7",
                "log_path": None, "sandbox_container_id": "orcha-run-warm"}
    _turn_mod.stop_turn(notifier, "http://x", "C1", resident, {"C1": resident},
                        {"stop_requested": True, "stop_run_id": "RUN-7",
                         "stop_requested_by": "hussein"}, True)
    assert any("/runs/RUN-7/finish" in u for u, _ in posts)
    assert calls["remove"] == [("orcha-run-warm", True)]


# ---------- the pid-keyed resident reaper leaves container-backed rows alone ----------

def test_dead_pid_resident_reaper_leaves_sandbox_rows_to_container_sweep(monkeypatch):
    """A resident row with a sandbox_container_id is CONTAINER-backed: its docker
    client pid dying (daemon restart) says nothing about the session. The pid-keyed
    per-agent reaper must not finish it (the container-liveness sweep owns it), and
    while it is open the lane's lease is shielded — the dead HOST row is finished
    as a sibling instead of releasing the lease."""
    posts = []
    monkeypatch.setattr(notifier, "_get_json", lambda u, **k: {"runs": [
        {"run_id": "SBX", "pid": _DEAD_PID, "status": "running",
         "sandbox_container_id": "orcha-run-warm"},
        {"run_id": "HOST", "pid": _DEAD_PID, "status": "running",
         "sandbox_container_id": None}]})
    monkeypatch.setattr(notifier, "_post_json",
                        lambda u, b=None, **k: posts.append((u, b)) or {})
    n = notifier._reap_dead_pid_resident_runs("http://x", "A1")
    assert n == 1
    assert any("/runs/HOST/finish" in u for u, _ in posts)
    assert not any("/runs/SBX/finish" in u for u, _ in posts)
    assert not any("wake-ack" in u for u, _ in posts)     # lease KEPT (sandbox sibling)


def test_dead_pid_resident_reaper_noop_when_only_sandbox_rows(monkeypatch):
    posts = []
    monkeypatch.setattr(notifier, "_get_json", lambda u, **k: {"runs": [
        {"run_id": "SBX", "pid": _DEAD_PID, "status": "running",
         "sandbox_container_id": "orcha-run-warm"}]})
    monkeypatch.setattr(notifier, "_post_json",
                        lambda u, b=None, **k: posts.append((u, b)) or {})
    assert notifier._reap_dead_pid_resident_runs("http://x", "A1") == 0
    assert posts == []
