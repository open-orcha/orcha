"""S3 R1 — host-side live-terminal PTY/websocket bridge (§3b).

Covers the TESTABLE CORE (env contract, frame protocol, client-frame routing, worktree
safe-teardown, lease lifecycle calls). The thin async `serve_bridge`/`handle_connection`
glue needs a real websocket + PTY and is exercised end-to-end manually; the units it
composes are all tested here. `websockets` is NOT imported (the bridge lazy-imports it),
so these run without the runtime dep.
"""
import os

import pytest

from orcha_cli import terminal_bridge as tb
from orcha_cli import notifier


# ---------- ENV contract (Vault req 9f5caa8e) ----------

def test_build_spawn_env_cold():
    env = tb.build_spawn_env("Vault", cold=True, base_env={})
    assert env["ORCHA_ALIAS"] == "Vault"
    assert env["ORCHA_LIVE"] == "1"
    assert env["ORCHA_LIVE_COLD"] == "1"
    assert "ORCHA_LIVE_RESUME_SID" not in env          # no resume sid on a cold boot


def test_build_spawn_env_resume():
    env = tb.build_spawn_env("Vault", cold=False, session_id="sess-123", base_env={})
    assert env["ORCHA_LIVE_COLD"] == "0"
    assert env["ORCHA_LIVE_RESUME_SID"] == "sess-123"


def test_build_spawn_env_resume_without_sid_omits_var():
    env = tb.build_spawn_env("V", cold=False, session_id=None, base_env={})
    assert env["ORCHA_LIVE_COLD"] == "0"
    assert "ORCHA_LIVE_RESUME_SID" not in env          # nothing to resume → don't set it


def test_build_spawn_env_inherits_and_overrides_base():
    env = tb.build_spawn_env("A", cold=True, base_env={"PATH": "/x", "ORCHA_ALIAS": "stale"})
    assert env["PATH"] == "/x"                          # inherits host env
    assert env["ORCHA_ALIAS"] == "A"                    # but we own ORCHA_ALIAS


def test_build_spawn_env_pins_model_and_runtime():
    """#297: the bridge hands the agent's resolved model+runtime down to cmd_use via env so the
    live boot pins the selection without a SECOND fail-open /persona round-trip."""
    env = tb.build_spawn_env("Vault", cold=True, base_env={},
                             model="claude-sonnet-4-6", runtime="claude")
    assert env["ORCHA_LIVE_MODEL"] == "claude-sonnet-4-6"
    assert env["ORCHA_LIVE_RUNTIME"] == "claude"


def test_build_spawn_env_human_target_omits_model_but_sets_runtime():
    """#297: a human target carries model=None (no --model) but runtime='claude' — RUNTIME is set
    whenever the bridge resolved a target, so cmd_use can tell a bridge-spawn from a direct use."""
    env = tb.build_spawn_env("Boss", cold=True, base_env={}, model=None, runtime="claude")
    assert "ORCHA_LIVE_MODEL" not in env               # no model → don't pass --model
    assert env["ORCHA_LIVE_RUNTIME"] == "claude"


def test_build_spawn_env_omits_stale_model_runtime_when_unresolved():
    """#297: a direct (non-bridge) spawn passes neither — and any stale ORCHA_LIVE_* inherited
    from base_env must be popped so cmd_use re-resolves from /persona instead of trusting a leak."""
    env = tb.build_spawn_env("Vault", cold=True,
                             base_env={"ORCHA_LIVE_MODEL": "leak", "ORCHA_LIVE_RUNTIME": "codex"})
    assert "ORCHA_LIVE_MODEL" not in env
    assert "ORCHA_LIVE_RUNTIME" not in env


# ---------- JSON frame protocol ----------

def test_make_and_parse_frame_roundtrip():
    raw = tb.make_frame("stdout", data="hello")
    d = tb.parse_frame(raw)
    assert d == {"type": "stdout", "data": "hello"}


def test_parse_frame_rejects_malformed_and_typeless():
    assert tb.parse_frame("not json") is None
    assert tb.parse_frame("[1,2,3]") is None           # not an object
    assert tb.parse_frame('{"data":"x"}') is None      # no type


# ---------- client-frame routing ----------

def test_apply_client_frame_stdin_writes_to_fd():
    r, w = os.pipe()
    try:
        action = tb.apply_client_frame({"type": "stdin", "data": "ls\n"}, w)
        assert action == "stdin"
        assert os.read(r, 64) == b"ls\n"
    finally:
        os.close(r)
        os.close(w)


def test_apply_client_frame_resize_calls_set_winsize(monkeypatch):
    calls = []
    monkeypatch.setattr(tb, "set_winsize", lambda fd, cols, rows: calls.append((fd, cols, rows)))
    action = tb.apply_client_frame({"type": "resize", "cols": 120, "rows": 40}, 7)
    assert action == "resize"
    assert calls == [(7, 120, 40)]


def test_apply_client_frame_ignores_unknown_and_empty():
    assert tb.apply_client_frame({"type": "bogus"}, 1) == "ignored"
    assert tb.apply_client_frame({"type": "stdin", "data": ""}, 1) == "ignored"
    assert tb.apply_client_frame(None, 1) == "ignored"


def test_set_winsize_bad_fd_is_safe():
    assert tb.set_winsize(-1, 80, 24) is False         # never raises on a bad fd


# ---------- worktree safe-teardown (live keeps uncommitted human work) ----------

def test_safe_teardown_preserves_dirty_worktree(monkeypatch):
    """A live human may leave uncommitted edits — NEVER force-remove a dirty worktree."""
    monkeypatch.setattr(notifier, "_run_git", lambda args, **k: (0, " M somefile.py\n"))
    removed = []
    monkeypatch.setattr(notifier, "_teardown_worktree",
                        lambda *a, **k: removed.append(a))
    disp = tb.safe_teardown_worktree("/base", "/base/.orcha-worktrees/x", "orcha/wk-x")
    assert disp == "preserved-dirty"
    assert removed == []                               # teardown NOT called on dirty


def test_safe_teardown_removes_clean_worktree(monkeypatch):
    monkeypatch.setattr(notifier, "_run_git", lambda args, **k: (0, ""))   # clean status
    removed = []
    monkeypatch.setattr(notifier, "_teardown_worktree",
                        lambda *a, **k: removed.append(a))
    disp = tb.safe_teardown_worktree("/base", "/base/.orcha-worktrees/x", "orcha/wk-x")
    assert disp == "removed"
    assert removed == [("/base", "/base/.orcha-worktrees/x", "orcha/wk-x")]


def test_safe_teardown_noop_without_worktree():
    assert tb.safe_teardown_worktree("/base", None, None) == "noop"


# ---------- lease lifecycle calls (reuse E1 single-flight via the API) ----------

def test_claim_renew_release_post_the_right_payloads(monkeypatch):
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or {"claimed": True})
    tb.claim_live_lease("http://x", "AID")
    tb.renew_live_lease("http://x", "AID")
    tb.release_live_lease("http://x", "AID")
    claim_url, claim_body = posts[0]
    assert claim_url.endswith("/api/agents/AID/wake-claim")
    assert claim_body["kind"] == "live" and claim_body["lease_kind"] == "live"
    assert claim_body["preempt"] is False                 # ISS-69(b): default no-preempt claim
    renew_url, renew_body = posts[1]
    assert renew_url.endswith("/api/agents/AID/wake-renew")
    assert renew_body["lease_kind"] == "live"
    rel_url, rel_body = posts[2]
    assert rel_url.endswith("/api/agents/AID/wake-ack")
    assert rel_body["release_lease"] is True and rel_body["kind"] == "live"


# ---------- handle_connection glue (the two review [P1]s) ----------

class _FakeWS:
    """Minimal async websocket double: yields the queued client frames then ends; records
    sends; can be told to raise on send to simulate an already-closed socket. `close_code`
    models the code the client passed to ws.close() — CLOSE_NOW_CODE = explicit user close,
    None = uncoded closure (nav away / drop) [P1 #218]."""
    def __init__(self, path, incoming=None, send_raises=False, close_code=None):
        self.path = path
        self._incoming = list(incoming or [])
        self.sent = []
        self.closed = False
        self.close_code = close_code
        # send_raises models a browser-close: the initial 'connected' send works, then the
        # socket drops so every later send (the finally's status frames) raises.
        self._send_raises = send_raises
        self._sends = 0

    async def send(self, msg):
        self._sends += 1
        if self._send_raises and self._sends > 1:
            raise ConnectionError("socket closed")
        self.sent.append(msg)

    async def close(self, code=None):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._incoming:
            return self._incoming.pop(0)
        raise StopAsyncIteration


def _wire_handle(monkeypatch):
    """Stub the network + process side-effects so handle_connection runs in-proc."""
    def _get(url, **k):
        # Real-route guard: ONLY /persona answers (the bare /api/agents/{id} is PATCH-only → 405 →
        # None in production). If the bridge ever reads the bare route again, these return None and
        # the connection is rejected — catching the regression a _get_json-agnostic mock would hide.
        if url.endswith("/agents/HUMAN/persona"):
            return {"agent_id": "HUMAN", "kind": "human", "alias": "Boss", "role": "operator"}
        if url.endswith("/agents/AID/persona"):
            return {"agent_id": "AID", "kind": "ai", "alias": "Vault", "role": "eng"}
        return None
    monkeypatch.setattr(notifier, "_get_json", _get)
    # acquire_live_lease (the real one) runs and calls this; the happy path returns claimed → connect.
    monkeypatch.setattr(tb, "claim_live_lease",
                        lambda api, aid, preempt=False: {"claimed": True, "cold": True, "session_id": None})
    monkeypatch.setattr(notifier, "_provision_worktree", lambda base, alias: (None, None))
    # ISS-67/B2: handle_connection now provisions the STABLE live worktree (not _provision_worktree);
    # stub it here too so no test does real git in base_cwd. Individual tests may re-stub if needed.
    monkeypatch.setattr(notifier, "_provision_live_worktree", lambda base, alias: (None, None))
    spawned = []
    monkeypatch.setattr(tb, "spawn_pty",
                        lambda alias, cold, sid, cwd, **k: spawned.append(alias) or (4321, os.open(os.devnull, os.O_RDONLY)))
    killed = []
    monkeypatch.setattr(tb, "terminate_pty",
                        lambda pid, fd, **k: killed.append(pid) or os.close(fd))
    released = []
    monkeypatch.setattr(tb, "release_live_lease", lambda api, aid: released.append(aid))
    # ISS-73: start_live_run/finish_live_run POST via notifier._post_json on every connection;
    # stub it so the tests never hit the network and can assert the run was recorded + finished.
    posts = []

    def _post(url, body, **k):
        posts.append((url, body))
        if url.endswith("/runs"):
            return {"run_id": "live-run-1", "status": "running"}
        return {}
    monkeypatch.setattr(notifier, "_post_json", _post)
    return spawned, killed, released, posts


@pytest.mark.asyncio
async def test_handle_connection_boots_as_target_agent_not_actor(monkeypatch):
    """[P1] the PTY must boot AS the target agent (alias from aid), never the human actor."""
    spawned, killed, released, posts = _wire_handle(monkeypatch)
    ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN")
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    assert spawned == ["Vault"], "spawned orcha use for the TARGET agent, not the actor 'Boss'"
    assert released == ["AID"]


@pytest.mark.asyncio
async def test_handle_connection_passes_target_model_runtime_to_spawn(monkeypatch):
    """#297: the TARGET /persona fetch already carries the agent's resolved model+runtime; the spawn
    must hand them through so the PTY pins the agent's selection (no second fail-open round-trip)."""
    _wire_handle(monkeypatch)
    # re-stub /persona so the AI target carries an explicit model + runtime (the resolved persona)
    def _get(url, **k):
        if url.endswith("/agents/HUMAN/persona"):
            return {"agent_id": "HUMAN", "kind": "human", "alias": "Boss"}
        if url.endswith("/agents/AID/persona"):
            return {"agent_id": "AID", "kind": "ai", "alias": "Vault",
                    "model": "gpt-5.5", "model_runtime": "codex"}
        return None
    monkeypatch.setattr(notifier, "_get_json", _get)
    captured = {}
    monkeypatch.setattr(tb, "spawn_pty",
                        lambda alias, cold, sid, cwd, **k: captured.update(alias=alias, **k)
                        or (4321, os.open(os.devnull, os.O_RDONLY)))
    ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN")
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    assert captured["alias"] == "Vault"
    assert captured["model"] == "gpt-5.5"             # the resolved model flows to the PTY
    assert captured["runtime"] == "codex"             # ...as does the runtime (Codex resumes as codex)


@pytest.mark.asyncio
async def test_handle_connection_human_target_normalizes_runtime_to_claude(monkeypatch):
    """#297 (Lens P2): a HUMAN target's /persona carries model=None AND model_runtime=None
    (runtime is only set when model is truthy). The bridge must still mark the spawn as resolved by
    normalizing runtime→'claude' so ORCHA_LIVE_RUNTIME is set (cmd_use's trust marker → no 2nd
    fail-open /persona refetch, no spurious '#297 could not resolve model' warn). model stays None →
    no --model. A raw passthrough (the pre-fix bug) would hand runtime=None to spawn_pty."""
    _wire_handle(monkeypatch)
    def _get(url, **k):
        if url.endswith("/agents/HUMAN/persona"):
            return {"agent_id": "HUMAN", "kind": "human", "alias": "Boss"}
        # the TARGET is a human → no model, no model_runtime (mirrors /persona main.py:2565-2566)
        if url.endswith("/agents/AID/persona"):
            return {"agent_id": "AID", "kind": "human", "alias": "Pat", "role": "operator"}
        return None
    monkeypatch.setattr(notifier, "_get_json", _get)
    captured = {}
    monkeypatch.setattr(tb, "spawn_pty",
                        lambda alias, cold, sid, cwd, **k: captured.update(alias=alias, **k)
                        or (4321, os.open(os.devnull, os.O_RDONLY)))
    ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN")
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    assert captured["alias"] == "Pat"
    assert captured["model"] is None                  # human has no model → no --model pinned
    assert captured["runtime"] == "claude"            # ...but the runtime is normalized, not None


@pytest.mark.asyncio
async def test_handle_connection_releases_lease_even_if_socket_already_closed(monkeypatch):
    """[P1] a browser-close drops the socket → status sends raise; teardown + lease release
    must STILL run (else the claude process + lease leak until TTL)."""
    spawned, killed, released, posts = _wire_handle(monkeypatch)
    ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN", send_raises=True)
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    assert killed == [4321], "PTY terminated despite failed status send"
    assert released == ["AID"], "lease released despite failed status send"


@pytest.mark.asyncio
async def test_handle_connection_rejects_non_human_actor(monkeypatch):
    _wire_handle(monkeypatch)
    monkeypatch.setattr(notifier, "_get_json",
                        lambda url, **k: {"id": "X", "kind": "ai", "alias": "Bot"})
    ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=X")
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    assert ws.closed is True
    assert any('"lease_denied"' in s and "not human" in s for s in ws.sent)


# ---------- ISS-73: live session recorded as a worker_run (audit trail) ----------

def test_start_live_run_posts_live_kind_and_returns_run_id(monkeypatch):
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or {"run_id": "R1"})
    rid = tb.start_live_run("http://x", "AID")
    assert rid == "R1"
    url, body = posts[0]
    assert url.endswith("/api/agents/AID/runs")
    assert body == {"wake_kind": "live", "wake_event": "live_terminal"}


def test_start_live_run_best_effort_returns_none_on_failed_post(monkeypatch):
    """A failed /runs POST (None) must NOT raise — run bookkeeping can't block a live session."""
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: None)
    assert tb.start_live_run("http://x", "AID") is None


def test_finish_live_run_posts_transcript_as_output(monkeypatch):
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or {})
    tb.finish_live_run("http://x", "R1", "exited", output="hello world")
    url, body = posts[0]
    assert url.endswith("/api/runs/R1/finish")
    assert body["status"] == "exited" and body["output"] == "hello world"


def test_finish_live_run_tail_caps_long_output(monkeypatch):
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or {})
    big = "x" * (tb.LIVE_RUN_OUTPUT_CAP + 5000)
    tb.finish_live_run("http://x", "R1", output=big)
    out = posts[0][1]["output"]
    assert out.startswith("...[truncated]...\n")
    assert len(out) == len("...[truncated]...\n") + tb.LIVE_RUN_OUTPUT_CAP   # kept the tail only


def test_finish_live_run_noop_without_run_id(monkeypatch):
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append(1) or {})
    tb.finish_live_run("http://x", None, output="ignored")
    assert posts == []                                    # nothing recorded → nothing to finish


@pytest.mark.asyncio
async def test_handle_connection_records_and_finishes_live_run(monkeypatch):
    """End-to-end glue: a live session records a wake_kind='live' worker_run on connect and
    finishes it (status='exited') on close — so it lands in run history (ISS-73)."""
    spawned, killed, released, posts = _wire_handle(monkeypatch)
    ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN")
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    starts = [b for (u, b) in posts if u.endswith("/api/agents/AID/runs")]
    finishes = [(u, b) for (u, b) in posts if u.endswith("/api/runs/live-run-1/finish")]
    assert starts == [{"wake_kind": "live", "wake_event": "live_terminal"}]
    assert len(finishes) == 1 and finishes[0][1]["status"] == "exited"


@pytest.mark.asyncio
async def test_handle_connection_finishes_run_even_if_socket_already_closed(monkeypatch):
    """A browser-close (status sends raise) must still finish the run — same guarantee as the
    lease release (both live in the close-handoff finally)."""
    spawned, killed, released, posts = _wire_handle(monkeypatch)
    ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN", send_raises=True)
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    assert any(u.endswith("/api/runs/live-run-1/finish") for (u, b) in posts)


# ---------- ISS-67/B1: grace-window keepalive (warm-session reattach) ----------

@pytest.fixture(autouse=True)
def _clear_warm_registry():
    """The warm registry is process-global; clear it around every test so a parked session can't
    leak into the next test (or a reattach pick up a stale entry)."""
    tb._WARM_SESSIONS.clear()
    yield
    for aid in list(tb._WARM_SESSIONS):
        s = tb._WARM_SESSIONS.pop(aid, None)
        if s is not None:
            s.cancel_expiry()


def test_pid_alive_true_for_self_false_for_absent():
    assert tb._pid_alive(os.getpid()) is True
    assert tb._pid_alive(2_000_000_000) is False             # absurd pid → not alive


def test_wait_readable_distinguishes_data_timeout_and_eof():
    r, w = os.pipe()
    try:
        assert tb._wait_readable(r, timeout=0.05) is False   # no data, write end open → timeout
        os.write(w, b"x")
        assert tb._wait_readable(r, timeout=0.5) is True     # data pending → readable
        os.read(r, 1)
        os.close(w)                                          # EOF: a closed write end is "readable"
        assert tb._wait_readable(r, timeout=0.5) is True
    finally:
        os.close(r)
        try:
            os.close(w)
        except OSError:
            pass


def test_retire_warm_terminates_teardown_releases_and_finishes(monkeypatch):
    """_retire_warm (grace expiry / PTY death / shutdown) must kill the PTY, safe-teardown the
    worktree, release the lease, and finish the run — the close handoff, all best-effort."""
    killed, released, teardown, finished = [], [], [], []
    monkeypatch.setattr(tb, "terminate_pty", lambda pid, fd, **k: killed.append(pid))
    monkeypatch.setattr(tb, "safe_teardown_worktree",
                        lambda base, wt, br: teardown.append((wt, br)) or "removed")
    monkeypatch.setattr(tb, "release_live_lease", lambda api, aid: released.append(aid))
    monkeypatch.setattr(tb, "finish_live_run",
                        lambda api, rid, status="exited", **k: finished.append((rid, status)))
    sess = tb._WarmSession("AID", "Vault", "http://x", "/base", 4321, 7,
                           "/wt/live-Vault", "orcha/live-Vault", "run-1", {"chunks": ["hi"], "len": 2})
    disp = tb._retire_warm(sess, quiet=True)
    assert disp == "removed"
    assert killed == [4321] and released == ["AID"]
    assert teardown == [("/wt/live-Vault", "orcha/live-Vault")]
    assert finished == [("run-1", "exited")]


def _wire_warm_handle(monkeypatch, pid, fd):
    """Like _wire_handle but spawns a caller-supplied (real-live) pid+fd so the park-vs-teardown
    liveness check is deterministic, and a long grace so the expiry task never fires mid-test."""
    spawned, killed, released, posts = _wire_handle(monkeypatch)
    monkeypatch.setattr(tb, "spawn_pty", lambda alias, cold, sid, cwd, **k: spawned.append(alias) or (pid, fd))
    monkeypatch.setattr(notifier, "_provision_live_worktree", lambda base, alias: (None, None))
    monkeypatch.setattr(tb, "LIVE_GRACE_SECS", 1000)         # don't let expiry retire during the test
    return spawned, killed, released, posts


@pytest.mark.asyncio
async def test_browser_close_parks_warm_then_reopen_reattaches(monkeypatch):
    """The core B1 win: a browser-close while claude is alive PARKS the session (no release/teardown);
    the next reopen REATTACHES the SAME PTY — no second spawn, no re-claim — and replays the screen."""
    import subprocess
    proc = subprocess.Popen(["sleep", "60"])                # a real, live pid to back the PTY
    r, w = os.pipe()                                        # write end held open → relay sees no EOF
    try:
        spawned, killed, released, posts = _wire_warm_handle(monkeypatch, proc.pid, r)

        # connect #1 → relay ends (no client frames) while the PTY is alive → PARK warm
        ws1 = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN")
        await tb.handle_connection(ws1, "http://x", "/base", quiet=True)
        assert spawned == ["Vault"]                         # spawned once
        assert released == [], "a warm park must NOT release the lease"
        assert killed == [], "a warm park must NOT kill the PTY"
        assert "AID" in tb._WARM_SESSIONS                   # parked
        assert any('"detached"' in s for s in ws1.sent)     # client told it's parked

        # connect #2 (same agent) → REATTACH the warm PTY: no second spawn, connected{reattached:true}
        ws2 = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN")
        await tb.handle_connection(ws2, "http://x", "/base", quiet=True)
        assert spawned == ["Vault"], "reattach must NOT spawn a second PTY"
        conn = [s for s in ws2.sent if '"connected"' in s]
        assert conn and '"reattached": true' in conn[0], f"expected a reattach connect; got {conn}"
        assert "AID" in tb._WARM_SESSIONS                   # parked again after #2 closed
    finally:
        proc.terminate()
        proc.wait()
        os.close(w)
        try:
            os.close(r)
        except OSError:
            pass


@pytest.mark.asyncio
async def test_explicit_user_close_tears_down_instead_of_parking(monkeypatch):
    """[P1 #218] The Close button sends CLOSE_NOW_CODE — that session must snapshot + teardown +
    release NOW, even though the PTY is alive. Parking it would hold the lease (agent unwakeable)
    for the whole grace window on an INTENTIONAL close."""
    import subprocess
    proc = subprocess.Popen(["sleep", "60"])                # live pid: the park branch WOULD trigger
    r, w = os.pipe()
    try:
        spawned, killed, released, posts = _wire_warm_handle(monkeypatch, proc.pid, r)
        ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN", close_code=tb.CLOSE_NOW_CODE)
        await tb.handle_connection(ws, "http://x", "/base", quiet=True)
        assert released == ["AID"], "explicit close must release the lease immediately"
        assert killed == [proc.pid], "explicit close must terminate the PTY (fires SessionEnd snapshot)"
        assert "AID" not in tb._WARM_SESSIONS, "explicit close must NOT park"
        assert any('"closed"' in s for s in ws.sent)        # client told the session ended
        assert not any('"detached"' in s for s in ws.sent)  # and NOT that it was parked


        # a follow-up uncoded closure (same wiring) still parks — the two paths stay distinct
        ws2 = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN")
        await tb.handle_connection(ws2, "http://x", "/base", quiet=True)
        assert "AID" in tb._WARM_SESSIONS                   # nav-away/drop still parks warm
    finally:
        proc.terminate()
        proc.wait()
        os.close(w)
        try:
            os.close(r)
        except OSError:
            pass


@pytest.mark.asyncio
async def test_dead_pty_tears_down_instead_of_parking(monkeypatch):
    """If claude already exited (pid not alive) at detach, there is nothing to keep warm → the
    session tears down + releases immediately (no stranded warm entry)."""
    spawned, killed, released, posts = _wire_handle(monkeypatch)   # fake pid 4321 (not a live process)
    monkeypatch.setattr(notifier, "_provision_live_worktree", lambda base, alias: (None, None))
    ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN")
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    assert released == ["AID"], "a dead PTY must release the lease, not park"
    assert "AID" not in tb._WARM_SESSIONS
    assert killed == [4321]


@pytest.mark.asyncio
async def test_expire_warm_retires_after_grace(monkeypatch):
    """A parked session with NO reopen within the grace window is retired (lease released) by the
    expiry task. Uses a tiny grace so the task fires immediately."""
    import asyncio
    released = []
    monkeypatch.setattr(tb, "terminate_pty", lambda pid, fd, **k: None)
    monkeypatch.setattr(tb, "safe_teardown_worktree", lambda base, wt, br: "removed")
    monkeypatch.setattr(tb, "release_live_lease", lambda api, aid: released.append(aid))
    monkeypatch.setattr(tb, "finish_live_run", lambda *a, **k: None)
    monkeypatch.setattr(tb, "renew_live_lease", lambda api, aid: None)
    monkeypatch.setattr(tb, "LIVE_GRACE_SECS", 0.05)
    monkeypatch.setattr(tb, "LIVE_RENEW_SECS", 0.01)
    sess = tb._WarmSession("AID", "Vault", "http://x", "/base", os.getpid(), -1,
                           None, None, "run-1", {"chunks": [], "len": 0})
    tb._park_warm(sess, quiet=True)
    assert "AID" in tb._WARM_SESSIONS
    await asyncio.sleep(0.2)                                # let the grace window elapse
    assert released == ["AID"], "grace expired with no reopen → must retire + release"
    assert "AID" not in tb._WARM_SESSIONS


@pytest.mark.asyncio
async def test_reattach_cancels_expiry_so_no_double_teardown(monkeypatch):
    """Taking a warm session (reattach) cancels its expiry task, so the grace timeout never retires a
    session that's been readopted (no double release/teardown)."""
    import asyncio
    released = []
    monkeypatch.setattr(tb, "terminate_pty", lambda pid, fd, **k: None)
    monkeypatch.setattr(tb, "safe_teardown_worktree", lambda base, wt, br: "removed")
    monkeypatch.setattr(tb, "release_live_lease", lambda api, aid: released.append(aid))
    monkeypatch.setattr(tb, "finish_live_run", lambda *a, **k: None)
    monkeypatch.setattr(tb, "renew_live_lease", lambda api, aid: None)
    monkeypatch.setattr(tb, "LIVE_GRACE_SECS", 0.05)
    monkeypatch.setattr(tb, "LIVE_RENEW_SECS", 0.01)
    sess = tb._WarmSession("AID", "Vault", "http://x", "/base", os.getpid(), -1,
                           None, None, "run-1", {"chunks": [], "len": 0})
    tb._park_warm(sess, quiet=True)
    taken = tb._take_warm("AID")                            # reattach grabs it before grace elapses
    taken.cancel_expiry()
    await asyncio.sleep(0.2)
    assert released == [], "a reattached session must NOT be retired by the cancelled expiry task"


# ---------- ISS-69(b): acquire_live_lease preempt-yield retry ----------

def _seq_claim(monkeypatch, responses):
    """Patch claim_live_lease to return `responses` in order (last repeats). Records preempt args."""
    calls = []

    def _claim(api, aid, preempt=False):
        calls.append(preempt)
        return responses[min(len(calls) - 1, len(responses) - 1)]
    monkeypatch.setattr(tb, "claim_live_lease", _claim)
    # make the retry loop spin fast (no real 1s sleeps)
    monkeypatch.setattr(tb, "PREEMPT_RETRY_INTERVAL_SECS", 0.001)
    monkeypatch.setattr(tb, "PREEMPT_RETRY_TOTAL_SECS", 0.01)
    return calls


@pytest.mark.asyncio
async def test_acquire_immediate_win_skips_yielding(monkeypatch):
    """A claim that wins outright never emits the 'yielding' frame and never retries."""
    calls = _seq_claim(monkeypatch, [{"claimed": True, "cold": True}])
    yielded = []
    claim = await tb.acquire_live_lease("http://x", "AID", preempt=True,
                                        on_yielding=lambda: yielded.append(1))
    assert claim["claimed"] is True
    assert yielded == []                                  # no handoff needed
    assert calls == [True]                                # one claim, preempt forwarded


@pytest.mark.asyncio
async def test_acquire_yields_then_wins(monkeypatch):
    """Blocked by an idle resident (yield_pending) → emit 'yielding' ONCE, retry, then win when the
    daemon has released the resident's lease."""
    calls = _seq_claim(monkeypatch, [
        {"claimed": False, "reason": "yield_pending", "lease_kind": "resident"},
        {"claimed": False, "reason": "yield_pending", "lease_kind": "resident"},
        {"claimed": True, "cold": True},
    ])
    yielded = []

    async def _on_yield():
        yielded.append(1)
    claim = await tb.acquire_live_lease("http://x", "AID", preempt=True, on_yielding=_on_yield)
    assert claim["claimed"] is True                       # eventually won after the resident yielded
    assert yielded == [1]                                 # 'yielding' announced exactly once
    assert len(calls) >= 3 and all(c is True for c in calls)


@pytest.mark.asyncio
async def test_acquire_non_yieldable_returns_immediately(monkeypatch):
    """A non-resident holder (ephemeral / another live terminal) is NOT yield_pending → return at once,
    no 'yielding' frame, no retry loop."""
    calls = _seq_claim(monkeypatch, [
        {"claimed": False, "reason": "a worker is already live (single-flight lease held)",
         "lease_kind": "ephemeral"}])
    yielded = []
    claim = await tb.acquire_live_lease("http://x", "AID", preempt=True,
                                        on_yielding=lambda: yielded.append(1))
    assert claim["claimed"] is False and claim["reason"] != "yield_pending"
    assert yielded == [] and calls == [True]              # no announce, single attempt


@pytest.mark.asyncio
async def test_acquire_budget_exhausted_returns_last_denial(monkeypatch):
    """If the resident never yields within the budget (e.g. it stays mid-turn), acquire gives up and
    returns the last claimed:false so the caller renders lease_denied."""
    calls = _seq_claim(monkeypatch, [
        {"claimed": False, "reason": "yield_pending", "lease_kind": "resident"}])  # always pending
    yielded = []

    async def _on_yield():
        yielded.append(1)
    claim = await tb.acquire_live_lease("http://x", "AID", preempt=True, on_yielding=_on_yield)
    assert claim["claimed"] is False and claim["reason"] == "yield_pending"
    assert yielded == [1]                                 # announced once, then exhausted
    assert len(calls) >= 2                                # initial + at least one retry


# ---------- S3 R1 integration: accept the frontend's /api/agents/<aid>/terminal path ----------



def test_ensure_bridge_skips_inside_live_embodiment(monkeypatch, tmp_path):
    """A live terminal (ORCHA_LIVE) must NOT spawn another bridge (a managed embodiment doesn't
    manage the bridge — mirrors the notifier daemon skip)."""
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text("{}")
    monkeypatch.setenv("ORCHA_LIVE", "1")
    started = []
    monkeypatch.setattr(tb.os, "kill", lambda *a: (_ for _ in ()).throw(OSError()))  # no live pid
    assert tb.ensure_bridge(tmp_path, quiet=True) is False
    assert started == []


def test_ensure_bridge_noop_when_not_orcha_project(tmp_path):
    assert tb.ensure_bridge(tmp_path, quiet=True) is False    # no .claude/orcha.json


# ---------- review [P1]: bridge lifecycle (restart on init, stop on down) ----------

def test_stop_bridge_sigterms_and_clears_pidfile(monkeypatch, tmp_path):
    (tmp_path / ".claude").mkdir()
    tb._bridge_pid_path(tmp_path).write_text("4321")
    monkeypatch.setattr(tb, "bridge_running", lambda cwd: 4321)
    killed = []
    monkeypatch.setattr(tb.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    assert tb.stop_bridge(tmp_path, quiet=True) is True
    import signal as _sig
    assert killed == [(4321, _sig.SIGTERM)]
    assert not tb._bridge_pid_path(tmp_path).exists()       # pidfile cleared


def test_ensure_bridge_restart_stops_old_first(monkeypatch, tmp_path):
    """review [P1]: ensure_bridge(restart=True) (orcha init) stops a running bridge first so a
    re-init binds a fresh bridge to the new container — else the old one strands the port/api_base."""
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text("{}")
    stopped = []
    monkeypatch.setattr(tb, "stop_bridge", lambda cwd, quiet=False: stopped.append(cwd))
    monkeypatch.setattr(tb, "bridge_running", lambda cwd: 999)   # one still 'running' after stop → no spawn
    assert tb.ensure_bridge(tmp_path, quiet=True, restart=True) is True
    assert stopped == [tmp_path]                                 # stopped before (re)checking


def test_ensure_bridge_no_restart_does_not_stop(monkeypatch, tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text("{}")
    stopped = []
    monkeypatch.setattr(tb, "stop_bridge", lambda cwd, quiet=False: stopped.append(cwd))
    monkeypatch.setattr(tb, "bridge_running", lambda cwd: 999)
    tb.ensure_bridge(tmp_path, quiet=True)                       # default restart=False
    assert stopped == []


# ---------- review [P1]: websockets v15 compat (path moved to ws.request.path) ----------

class _Req:
    def __init__(self, path): self.path = path


class _FakeWS15(_FakeWS):
    """websockets v15 ServerConnection: NO `.path`; the request target is on `.request.path`."""
    def __init__(self, path, **kw):
        super().__init__(path, **kw)
        self.request = _Req(path)
        del self.path


def test_ws_path_reads_legacy_and_v15_shapes():
    legacy = _FakeWS("/terminal?agent_id=A&actor_agent_id=H")
    assert tb._ws_path(legacy) == "/terminal?agent_id=A&actor_agent_id=H"
    v15 = _FakeWS15("/terminal?agent_id=A&actor_agent_id=H")
    assert tb._ws_path(v15) == "/terminal?agent_id=A&actor_agent_id=H"
    assert tb._ws_path(_FakeWS15("")) == ""


@pytest.mark.asyncio
async def test_handle_connection_reads_v15_request_path(monkeypatch):
    """With a websockets v15 connection (path on .request.path), the bridge still resolves
    agent_id/actor — NOT rejected with 'agent_id + actor_agent_id required'."""
    spawned, killed, released, posts = _wire_handle(monkeypatch)
    ws = _FakeWS15("/terminal?agent_id=AID&actor_agent_id=HUMAN")
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    assert spawned == ["Vault"]              # got the target agent → spawned (not rejected)
    assert released == ["AID"]


@pytest.mark.asyncio
async def test_handle_connection_reads_persona_route_not_bare_agent(monkeypatch):
    """Regression (S3 live bug): the bridge must read GET /api/agents/<id>/persona, NOT the bare
    /api/agents/<id> (PATCH-only → 405 → None → actor looked not-human → lease_denied-before-claim,
    the 'pairing always busy' bug). Assert the actual URLs hit /persona."""
    spawned, killed, released, posts = _wire_handle(monkeypatch)
    seen = []
    real_get = notifier._get_json
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: seen.append(url) or real_get(url, **k))
    ws = _FakeWS("/terminal?agent_id=AID&actor_agent_id=HUMAN")
    await tb.handle_connection(ws, "http://x", "/base", quiet=True)
    assert any(u.endswith("/agents/HUMAN/persona") for u in seen)
    assert any(u.endswith("/agents/AID/persona") for u in seen)
    assert not any(u.endswith("/agents/HUMAN") or u.endswith("/agents/AID") for u in seen)  # never the bare 405 route
    assert spawned == ["Vault"] and released == ["AID"]               # reached the spawn (not rejected)
