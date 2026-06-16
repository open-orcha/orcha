"""R2 — END-TO-END resident/terminal SMOKE GATE (real-seam test).

WHY THIS EXISTS
---------------
Every other test of the live-terminal seam either mocks the network (test_terminal_bridge.py:
`_wire_handle` stubs `_get_json`, `claim_live_lease`, `spawn_pty`, …) or tests pure CLI logic
(test_r1_live_embodiment.py). That blind spot is the "untested-seam" bug class — e.g. #154
(bridge read the PATCH-only bare `/api/agents/{id}` instead of `/persona` → 405 → "always
busy"), #147 (PTY booted AS the actor not the target). A `_get_json`-agnostic mock *hid* #154.

This gate drives the WHOLE wire with as little mocked as possible:
  * a REAL uvicorn server on an ephemeral port against the test DB (the bridge's urllib calls
    hit real route handlers + real lease SQL),
  * a REAL PTY fork of `orcha use <alias>` → real `cmd_use` → real `_exec_live_session`,
  * only the `claude` leaf is substituted, via the `ORCHA_LIVE_EXEC` test seam — a stub that
    records the argv/cwd/env it was launched with, so we can prove the boot decision.

The single seam NOT exercised here is the websocket transport itself (framing is unit-tested
in test_terminal_bridge.py, and `websockets` is a lazy runtime-only dep absent from the test
venv). We drive `handle_connection` directly with a fake ws, exactly as the unit tests do —
but with the network + process side-effects REAL.

Marked `@pytest.mark.smoke` so it can run as a required merge gate (`pytest -m smoke`).
"""
import asyncio
import json
import os
import pathlib
import socket
import sys
import threading
import time

import httpx
import psycopg
import pytest
from psycopg.rows import dict_row

import main  # noqa: E402 — conftest set DATABASE_URL + sys.path before this import
from orcha_cli import terminal_bridge as tb

REPO = pathlib.Path(__file__).resolve().parent.parent
WORKTREE_CLI = REPO / "orcha-cli"
TEST_URL = os.environ["DATABASE_URL"]

pytestmark = pytest.mark.smoke


# ---------------------------------------------------------------------------
# real HTTP server (module-scoped): the bridge's urllib calls hit this for real
# ---------------------------------------------------------------------------
def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def live_server():
    import uvicorn
    port = _free_port()
    # lifespan off: the test DB is already migrated by conftest; the startup migrate hook
    # (httpx ASGITransport never runs it either) would just re-run idempotently.
    config = uvicorn.Config(main.app, host="127.0.0.1", port=port,
                            log_level="warning", lifespan="off")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError("uvicorn did not start within 10s")
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=5)


# ---------------------------------------------------------------------------
# DB helpers (read lease state the API doesn't expose for assertions)
# ---------------------------------------------------------------------------
def _wake_state(aid):
    with psycopg.connect(TEST_URL, row_factory=dict_row, autocommit=True) as conn:
        rows = conn.execute(
            "SELECT lease_kind, wake_lease_until FROM agent_wake_state WHERE agent_id=%s", (aid,)
        ).fetchall()
    return rows[0] if rows else None


def _lease_is_live(aid):
    row = _wake_state(aid)
    if not row or not row.get("wake_lease_until"):
        return False
    from datetime import datetime, timezone
    return row["lease_kind"] == "live" and row["wake_lease_until"] > datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# arena setup: container + a human actor + an AI target, via the REAL server
# ---------------------------------------------------------------------------
def _make_arena(base_url):
    with httpx.Client(base_url=base_url, timeout=10) as c:
        r = c.post("/api/containers", json={"name": "smoke-arena"})
        assert r.status_code == 201, r.text
        cid = r.json()["container_id"]
        r = c.post(f"/api/containers/{cid}/agents",
                   json={"alias": "Boss", "role": "operator", "kind": "human"})
        assert r.status_code in (200, 201), r.text
        human = r.json()
        r = c.post(f"/api/containers/{cid}/agents",
                   json={"alias": "Vault", "role": "eng", "kind": "ai",
                         "prompt": "You are Vault, an engineer."})
        assert r.status_code in (200, 201), r.text
        target = r.json()
    return cid, human["agent_id"], target["agent_id"]


# ---------------------------------------------------------------------------
# the PTY-launch environment: an `orcha` shim → this worktree's CLI, plus the
# ORCHA_LIVE_EXEC stub that records how the live session was launched
# ---------------------------------------------------------------------------
def _git(args, cwd):
    import subprocess
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t",
                    "-c", "commit.gpgsign=false", *args],
                   cwd=str(cwd), check=True, capture_output=True)


def _init_git_base(base_cwd):
    """A REAL git repo with an `origin` whose `main` is checked-out-able — so
    notifier._provision_worktree takes the PRODUCTION path (`git worktree add origin/main`)
    instead of the (None, None) fallback. Review feedback on #164: a non-git base_cwd silently
    exercised the fallback, so the gate couldn't catch a worktree/overlay regression."""
    remote = base_cwd.parent / "origin.git"
    _git(["init", "--bare", str(remote)], base_cwd.parent)   # (older git lacks `-b`; push sets main)
    base_cwd.mkdir(parents=True, exist_ok=True)
    _git(["init"], base_cwd)
    _git(["symbolic-ref", "HEAD", "refs/heads/main"], base_cwd)   # first commit lands on main
    _git(["remote", "add", "origin", str(remote)], base_cwd)
    (base_cwd / "README.md").write_text("orcha smoke arena\n")
    _git(["add", "README.md"], base_cwd)
    _git(["commit", "-m", "init"], base_cwd)
    _git(["push", "-u", "origin", "main"], base_cwd)


def _setup_launch_env(tmp_path, monkeypatch, base_url, target_aid):
    base_cwd = tmp_path / "proj"
    _init_git_base(base_cwd)
    # The runtime config lives in base/.claude but is NOT committed — exactly like production
    # (`.claude/` is gitignored), so a worktree checked out from origin/main lacks it and ONLY
    # _overlay_runtime_config can put it there. settings.json carries the SessionEnd snapshot hook
    # (#162) — the stub asserts it landed in the spawned cwd.
    (base_cwd / ".claude" / "orcha-tabs").mkdir(parents=True)
    (base_cwd / ".claude" / "orcha.json").write_text(json.dumps({"api_base_url": base_url}))
    (base_cwd / ".claude" / "orcha-tabs" / "Vault.json").write_text(
        json.dumps({"alias": "Vault", "agent_id": target_aid, "container_id": "c"}))
    (base_cwd / ".claude" / "settings.json").write_text(json.dumps(
        {"hooks": {"SessionEnd": [{"hooks": [{"type": "command", "command": "orcha snapshot"}]}]}}))

    bindir = tmp_path / "bin"
    bindir.mkdir()
    # `orcha` shim → this worktree's CLI (so the test exercises the code under review,
    # not whatever `orcha` happens to be installed globally).
    shim = bindir / "orcha"
    shim.write_text(
        "#!/bin/sh\n"
        f'exec "{sys.executable}" -m orcha_cli "$@"\n')
    shim.chmod(0o755)

    marker = tmp_path / "live_launch.json"
    # the ORCHA_LIVE_EXEC stub: record argv/cwd/selected-env + whether the overlay seeded the
    # runtime config into THIS cwd (the worktree), then read one stdin line + exit. The overlay
    # presence is captured here because the worktree is torn down on close.
    stub = bindir / "claude_stub.py"
    stub.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        f"open({str(marker)!r}, 'w').write(json.dumps({{\n"
        "    'argv': sys.argv,\n"
        "    'cwd': os.getcwd(),\n"
        "    'alias': os.environ.get('ORCHA_ALIAS'),\n"
        "    'live': os.environ.get('ORCHA_LIVE'),\n"
        "    'cold': os.environ.get('ORCHA_LIVE_COLD'),\n"
        "    'resume_sid': os.environ.get('ORCHA_LIVE_RESUME_SID'),\n"
        "    'settings_present': os.path.exists('.claude/settings.json'),\n"
        "    'orcha_json_present': os.path.exists('.claude/orcha.json'),\n"
        "    'tabs_present': os.path.exists('.claude/orcha-tabs/Vault.json'),\n"
        "}))\n"
        "sys.stdout.write('STUB-LIVE-READY\\n'); sys.stdout.flush()\n"
        "try:\n"
        "    sys.stdin.readline()\n"
        "except Exception:\n"
        "    pass\n")
    stub.chmod(0o755)

    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("PYTHONPATH", str(WORKTREE_CLI))
    # ORCHA_LIVE_EXEC must name a single shutil.which-able program (matching `claude`); wrap the
    # python stub in a tiny exec shim and point the seam at its absolute path.
    monkeypatch.setenv("ORCHA_LIVE_EXEC", str(_python_exec_wrapper(bindir, stub)))
    return str(base_cwd), marker


def _python_exec_wrapper(bindir, stub):
    """ORCHA_LIVE_EXEC must be a single executable on PATH/abs-path (shutil.which-able). Wrap the
    python stub in a tiny exec shim so the seam stays 'one program name', matching `claude`."""
    wrapper = bindir / "claude"
    wrapper.write_text(
        "#!/bin/sh\n"
        f'exec "{sys.executable}" "{stub}" "$@"\n')
    wrapper.chmod(0o755)
    return wrapper


# ---------------------------------------------------------------------------
# fake ws: keeps the session open until the stub has booted (deterministic), then ends
# ---------------------------------------------------------------------------
class _FakeWS:
    def __init__(self, path, marker, max_wait=8.0):
        self.path = path
        self.sent = []
        self.closed = None  # close code
        self._marker = marker
        self._max_wait = max_wait
        self._done = False

    async def send(self, msg):
        self.sent.append(msg)

    async def close(self, code=None):
        self.closed = code if code is not None else True

    def __aiter__(self):
        return self

    async def __anext__(self):
        # Hold the session open until the launched stub has recorded its marker (or timeout),
        # so teardown doesn't SIGHUP the child before it execs. Then end the client stream.
        if self._done:
            raise StopAsyncIteration
        deadline = time.monotonic() + self._max_wait
        while time.monotonic() < deadline:
            if self._marker.exists():
                break
            await asyncio.sleep(0.1)
        self._done = True
        raise StopAsyncIteration

    def states(self):
        return [json.loads(s).get("state") for s in self.sent
                if '"type": "status"' in s or '"type":"status"' in s]

    def connected_frame(self):
        for s in self.sent:
            try:
                f = json.loads(s)
            except ValueError:
                continue
            if f.get("type") == "status" and f.get("state") == "connected":
                return f
        return None


# ===========================================================================
# THE GATE
# ===========================================================================
@pytest.mark.asyncio
async def test_live_terminal_full_seam_cold_boot(live_server, tmp_path, monkeypatch):
    """connect (human actor) → /persona → live lease (DB) → ISOLATED WORKTREE off origin/main
    (overlay seeds .claude incl. settings.json, #162) → PTY `orcha use` → stub boots AS the
    TARGET, cold → close PARKS warm (ISS-67/B1) → explicit retire releases the lease. The whole
    wire, only the `claude` leaf stubbed."""
    cid, human_aid, target_aid = _make_arena(live_server)
    base_cwd, marker = _setup_launch_env(tmp_path, monkeypatch, live_server, target_aid)

    ws = _FakeWS(f"/terminal?agent_id={target_aid}&actor_agent_id={human_aid}", marker)
    await tb.handle_connection(ws, live_server, base_cwd, quiet=True)

    # 1. the client saw a real 'connected' status, and it ran in a PROVISIONED worktree (not the
    #    in-place fallback) — review feedback on #164: a non-git base silently took the fallback.
    assert "connected" in ws.states(), f"no connected status; sent={ws.sent}"
    conn = ws.connected_frame()
    assert conn and conn.get("worktree") is True, f"expected an isolated worktree; frame={conn}"

    # 2. the PTY actually launched the live session AS THE TARGET (not the human actor) — #147 guard
    assert marker.exists(), "the live session never launched (PTY/orcha-use/cmd_use chain broke)"
    rec = json.loads(marker.read_text())
    assert rec["alias"] == "Vault", f"booted as {rec['alias']!r}, expected the TARGET 'Vault'"
    assert rec["live"] == "1"
    assert rec["cold"] == "1", "claim returned cold→ stub should see a cold boot"
    # ran in the ISOLATED worktree, not the shared base checkout
    assert ".orcha-worktrees" in rec["cwd"] and rec["cwd"] != base_cwd, \
        f"live session should run in the isolated worktree, ran in {rec['cwd']!r}"
    # cold boot builds `claude --append-system-prompt <prefix>` (or bare on no prefix); never --resume
    assert "--resume" not in rec["argv"], "cold boot must not --resume"

    # 3. the worktree overlay seeded the runtime config — INCLUDING settings.json (the SessionEnd
    #    snapshot hook, #162). Without it, snapshot-on-close silently never fires (the bug this
    #    gate guards alongside #162). orcha.json + the binding must land too (else cmd_use can't
    #    even resolve the agent).
    assert rec["settings_present"] is True, \
        "settings.json NOT overlaid into the worktree → SessionEnd snapshot hook missing (#162 regressed)"
    assert rec["orcha_json_present"] is True, "orcha.json not overlaid into the worktree"
    assert rec["tabs_present"] is True, "agent binding not overlaid into the worktree"

    # 4. ISS-67/B1: a browser-close PARKS the session warm (claude stays alive) rather than
    #    releasing — so a reopen is instant. The lease stays LIVE through the grace window.
    assert _lease_is_live(target_aid), "a warm park must keep the lease LIVE (not release on close)"
    assert target_aid in tb._WARM_SESSIONS, "session should be parked warm after the browser-close"

    # 5. the REAL teardown→release path still works over the wire: retiring the parked session (grace
    #    expiry / shutdown) kills the PTY, tears down the worktree, and releases the lease for real.
    sess = tb._WARM_SESSIONS.pop(target_aid, None)
    sess.cancel_expiry()
    tb._retire_warm(sess, quiet=True)
    assert not _lease_is_live(target_aid), "live lease not released after the warm session retired"


@pytest.mark.asyncio
async def test_live_terminal_rejects_non_human_actor(live_server, tmp_path, monkeypatch):
    """A non-human actor is refused at the REAL /persona check (4403) — no lease, no spawn."""
    cid, human_aid, target_aid = _make_arena(live_server)
    base_cwd, marker = _setup_launch_env(tmp_path, monkeypatch, live_server, target_aid)

    # actor = the AI target itself (kind != human)
    ws = _FakeWS(f"/terminal?agent_id={target_aid}&actor_agent_id={target_aid}", marker, max_wait=1.5)
    await tb.handle_connection(ws, live_server, base_cwd, quiet=True)

    assert ws.closed == 4403, f"expected 4403 close, got {ws.closed}"
    assert any("lease_denied" in s and "not human" in s for s in ws.sent)
    assert not marker.exists(), "no PTY should have launched for a non-human actor"
    assert not _lease_is_live(target_aid), "no lease should be held after a denied connect"


@pytest.mark.asyncio
async def test_live_terminal_second_connect_is_busy(live_server, tmp_path, monkeypatch):
    """The live lease is single-flight: a second connect while one is held → 4409 lease_denied
    against the REAL wake-claim SQL (no second PTY)."""
    cid, human_aid, target_aid = _make_arena(live_server)
    base_cwd, marker = _setup_launch_env(tmp_path, monkeypatch, live_server, target_aid)

    # hold the lease via the REAL claim path, as a first session would
    first = tb.claim_live_lease(live_server, target_aid)
    assert first and first.get("claimed"), f"precondition: first claim should succeed; got {first}"
    assert _lease_is_live(target_aid)

    ws = _FakeWS(f"/terminal?agent_id={target_aid}&actor_agent_id={human_aid}", marker, max_wait=1.5)
    await tb.handle_connection(ws, live_server, base_cwd, quiet=True)

    assert ws.closed == 4409, f"expected 4409 busy, got {ws.closed}"
    assert any("lease_denied" in s for s in ws.sent)
    assert not marker.exists(), "no second PTY should launch while the lease is held"


def _live_worktrees(base_cwd):
    """The live-terminal worktree dirs (.orcha-worktrees/live-*) under the base checkout."""
    wt = pathlib.Path(base_cwd) / ".orcha-worktrees"
    return sorted(p.name for p in wt.glob("live-*")) if wt.exists() else []


@pytest.mark.asyncio
async def test_live_terminal_browser_close_parks_then_reattaches(live_server, tmp_path, monkeypatch):
    """ISS-67/B1+B2 over the FULL wire (real server, real PTY, real git worktree): a browser-close
    while claude is alive PARKS the session — lease stays LIVE, the stable worktree persists, the PTY
    is NOT killed — and a reopen REATTACHES the SAME session: no second PTY spawn, no second claim, no
    second worktree, and a connected{reattached:true} frame. Only the `claude` leaf is stubbed."""
    cid, human_aid, target_aid = _make_arena(live_server)
    base_cwd, marker = _setup_launch_env(tmp_path, monkeypatch, live_server, target_aid)

    try:
        # connect #1 → real lease + STABLE worktree + real PTY boots; ws ends while the stub is alive
        ws1 = _FakeWS(f"/terminal?agent_id={target_aid}&actor_agent_id={human_aid}", marker)
        await tb.handle_connection(ws1, live_server, base_cwd, quiet=True)
        assert marker.exists(), "first connect should have launched the live PTY"
        c1 = ws1.connected_frame()
        assert c1 and c1.get("worktree") is True and not c1.get("reattached")
        assert any('"detached"' in s for s in ws1.sent), "browser-close should PARK (detached frame)"

        # PARK invariants: lease still LIVE (not released), the warm session is registered, ONE worktree
        assert _lease_is_live(target_aid), "a warm park must keep the lease LIVE (not release it)"
        assert target_aid in tb._WARM_SESSIONS, "session should be parked warm"
        assert _live_worktrees(base_cwd) == [f"live-{_safe_target_slug(target_aid)}"] or \
            len(_live_worktrees(base_cwd)) == 1, "exactly one stable live worktree"
        worktrees_after_1 = _live_worktrees(base_cwd)
        mtime_after_1 = marker.stat().st_mtime

        # connect #2 → REATTACH: no new PTY (marker untouched), no new worktree, reattached frame
        ws2 = _FakeWS(f"/terminal?agent_id={target_aid}&actor_agent_id={human_aid}", marker)
        await tb.handle_connection(ws2, live_server, base_cwd, quiet=True)
        c2 = ws2.connected_frame()
        assert c2 and c2.get("reattached") is True, f"reopen must reattach; frame={c2}"
        assert c2.get("cold") is False, "a reattach is warm (no cold re-injection)"
        assert marker.stat().st_mtime == mtime_after_1, "reattach must NOT re-launch the PTY (marker rewritten)"
        assert _live_worktrees(base_cwd) == worktrees_after_1, "reattach must NOT create a second worktree"
        assert _lease_is_live(target_aid), "lease still LIVE after reattach"
    finally:
        # retire the parked session (kill the stub PTY + release the lease) so nothing leaks past the test
        sess = tb._WARM_SESSIONS.pop(target_aid, None)
        if sess is not None:
            sess.cancel_expiry()
            tb._retire_warm(sess, quiet=True)


def _safe_target_slug(aid):
    from orcha_cli import notifier
    return notifier._safe_ref("Vault")   # the arena's target alias is always 'Vault'
