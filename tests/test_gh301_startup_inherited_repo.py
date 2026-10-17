"""GH #301: conversation startup in empty or inherited Git repositories.

LearnChat's project folder had no Git metadata of its own but sat inside an empty
repository in ~/Documents. Both Claude and Codex conversation starts then claimed the
lease, failed to create a resident checkout, released the lease and retried every few
seconds — silently under --quiet, with the agent flickering Busy and the human never
answered. These tests drive the real ``service_residents`` tick against real Git
fixtures in disposable folders; only the HTTP helpers and the provider spawns are faked.
"""

from __future__ import annotations

import asyncio
import io
import json
import pathlib
import re
import subprocess

import pytest

from orcha_cli import notifier
from orcha_cli import notifier_startup_preflight as preflight


def _git(cwd, *args) -> str:
    return subprocess.run(
        [
            "git",
            "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.invalid",
            "-c", "init.defaultBranch=main",
            "-c", "commit.gpgsign=false",
            *args,
        ],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


@pytest.fixture(autouse=True)
def _git_ceiling(monkeypatch, tmp_path):
    # Git discovery must stop at the fixture root, whatever repository the test host is in.
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))


class Proc:
    def __init__(self, pid=4301):
        self.pid = pid
        self.returncode = None
        self.stdin = io.BytesIO()

    def poll(self):
        return self.returncode

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


TURNS = [
    {"seq": 1, "role": "human", "content": "first question"},
    {"seq": 2, "role": "human", "content": "are you there?"},
]


CONV_EXTRA: dict = {}


def _conv(runtime):
    return {
        **CONV_EXTRA,
        "conversation_id": "C301",
        "agent_id": "A301",
        "agent_alias": "Atlas",
        "model_runtime": runtime,
        "model": "gpt-5.5" if runtime == "codex" else "claude-opus-5-5",
        "session_id": None,
        "pending_human": True,
        "last_turn_seq": 2,
        "conversation_ack_ts": 7.0,
    }


def _wire(monkeypatch, runtime):
    """Fake the portal API for one pending conversation; record posts and spawns."""
    posts, spawns = [], []

    def _get(url, **_):
        if "active-conversations" in url:
            return {"conversations": [_conv(runtime)]}
        if "/turns" in url:
            match = re.search(r"after_seq=(\d+)", url)
            after = int(match.group(1)) if match else 0
            return {"turns": [t for t in TURNS if t["seq"] > after]}
        if "/conversation" in url:
            return {"conversation": {"id": "C301"}, "turns": TURNS}
        return None

    def _post(url, body, **_):
        posts.append((url, body))
        if "wake-claim" in url:
            return {"claimed": True, "lease_kind": body.get("lease_kind")}
        if "embodiment-tokens" in url:
            return {"run_token": "TOK-301"}
        if url.endswith("/runs"):
            return {"run_id": "RUN-301", "status": "running"}
        return {}

    def _spawn(cwd, *args, **kwargs):
        spawns.append(cwd)
        return True, "repr", Proc()

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "PERSONA")
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_reap_dead_pid_resident_runs", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "spawn_headless", _spawn)
    monkeypatch.setattr(notifier, "spawn_resident", _spawn)
    return posts, spawns


def _tick(base_cwd, live, quiet=True):
    notifier.service_residents(
        "http://x", "cid", live, quiet=quiet, base_cwd=str(base_cwd)
    )


def _claims(posts):
    return [body for url, body in posts if url.endswith("/wake-claim")]


def _acks(posts):
    return [body for url, body in posts if url.endswith("/wake-ack")]


def _snapshot(root: pathlib.Path) -> dict:
    """Every file under root (including .git) with its bytes — proves nothing was touched."""
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _empty_parent_with_project(tmp_path):
    documents = tmp_path / "Documents"
    documents.mkdir(parents=True)
    _git(documents, "init", "-q")
    (documents / "taxes.txt").write_text("parent file\n")
    project = documents / "Research" / "LearnChat"
    project.mkdir(parents=True)
    (project / "notes.md").write_text("project file\n")
    return documents, project


RUNTIMES = pytest.mark.parametrize("runtime", ["codex", "claude"])


@RUNTIMES
def test_empty_ancestor_repo_blocks_before_lease_and_names_it(
    monkeypatch, tmp_path, capsys, runtime
):
    documents, project = _empty_parent_with_project(tmp_path)
    before = _snapshot(documents)
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}

    _tick(project, live, quiet=True)

    assert spawns == [] and live == {}
    assert _claims(posts) == [], "a blocked repository must not take the chat lease (no Busy)"
    (ack,) = _acks(posts)
    assert ack["release_lease"] is False
    assert ack["lane"] == "conversation"
    assert "delivered_ts" not in ack, "pending human turns must stay pending"
    assert str(documents) in ack["detail"] and "no commits" in ack["detail"]
    assert "git init" in ack["detail"]
    # Quiet mode still surfaces the reason once on stderr.
    assert "conversation startup blocked for Atlas" in capsys.readouterr().err
    # The parent repository and every parent/project file are byte-for-byte unchanged.
    assert _snapshot(documents) == before
    assert not (project / ".orcha-worktrees").exists()
    assert not (documents / ".orcha-worktrees").exists()


@RUNTIMES
def test_committed_ancestor_repo_also_blocks_and_parent_git_is_untouched(
    monkeypatch, tmp_path, runtime
):
    # A parent WITH history must not get a branch or worktree entry either.
    documents, project = _empty_parent_with_project(tmp_path)
    _git(documents, "add", "taxes.txt")
    _git(documents, "commit", "-q", "-m", "parent history")
    before = _snapshot(documents)
    refs_before = _git(documents, "for-each-ref")
    worktrees_before = _git(documents, "worktree", "list", "--porcelain")
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}

    _tick(project, live, quiet=True)

    assert spawns == [] and live == {}
    assert _claims(posts) == []
    (ack,) = _acks(posts)
    assert ack["release_lease"] is False and "delivered_ts" not in ack
    assert str(documents) in ack["detail"] and "saved history" in ack["detail"]
    assert _git(documents, "for-each-ref") == refs_before
    assert _git(documents, "worktree", "list", "--porcelain") == worktrees_before
    assert _snapshot(documents) == before
    assert not (documents / ".orcha-worktrees").exists()


@RUNTIMES
def test_empty_project_repo_reports_missing_first_commit(monkeypatch, tmp_path, runtime):
    project = tmp_path / "proj"
    project.mkdir()
    _git(project, "init", "-q")
    (project / "app.py").write_text("print(1)\n")
    _git(project, "add", "app.py")  # staged, never committed — the InfraAgent case
    before = _snapshot(project)
    posts, spawns = _wire(monkeypatch, runtime)

    _tick(project, {})

    assert spawns == [] and _claims(posts) == []
    (ack,) = _acks(posts)
    assert "no commits yet" in ack["detail"] and "first commit" in ack["detail"]
    assert _snapshot(project) == before, "staged files and the index stay exactly as they were"


@RUNTIMES
def test_non_git_folder_still_starts_in_the_folder(monkeypatch, tmp_path, runtime):
    project = tmp_path / "plain"
    project.mkdir()
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}

    _tick(project, live)

    assert spawns == [str(project)]
    assert len(_claims(posts)) == 1
    assert live["C301"]["worktree"] is None
    assert not [ack for ack in _acks(posts) if ack.get("detail")]


@RUNTIMES
def test_legacy_worktrees_disabled_flag_never_runs_an_uncommitted_repo_in_place(
    monkeypatch, tmp_path, runtime
):
    # Worktrees are always on now (migration 072); a stale flag from an older server must
    # not reopen editing a repository in place.
    monkeypatch.setitem(CONV_EXTRA, "worktrees_disabled", True)
    project = tmp_path / "in-place"
    project.mkdir()
    _git(project, "init", "-q")
    before = _snapshot(project)
    posts, spawns = _wire(monkeypatch, runtime)
    _tick(project, {})
    assert spawns == [] and _claims(posts) == []
    (ack,) = _acks(posts)
    assert "first commit" in ack["detail"]
    assert _snapshot(project) == before

    preflight._BACKOFF.clear()  # same conversation id: skip the retry wait for part two
    documents, learnchat = _empty_parent_with_project(tmp_path / "second")
    before = _snapshot(documents)
    posts, spawns = _wire(monkeypatch, runtime)
    _tick(learnchat, {})
    assert spawns == [] and _claims(posts) == []
    (ack,) = _acks(posts)
    assert str(documents) in ack["detail"]
    assert _snapshot(documents) == before


@RUNTIMES
def test_local_repo_without_origin_main_starts_from_head(monkeypatch, tmp_path, runtime):
    project = tmp_path / "local-only"
    project.mkdir()
    _git(project, "init", "-q")
    (project / "README.md").write_text("hi\n")
    _git(project, "add", "README.md")
    _git(project, "commit", "-q", "-m", "first")
    head = _git(project, "rev-parse", "HEAD").strip()
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}

    _tick(project, live)

    (worktree,) = spawns
    assert worktree != str(project)
    assert pathlib.Path(worktree, "README.md").read_text() == "hi\n"
    assert _git(worktree, "rev-parse", "HEAD").strip() == head
    assert live["C301"]["branch"] == "orcha/resident-C301"
    assert not [ack for ack in _acks(posts) if ack.get("detail")]


def test_repo_with_origin_main_still_prefers_origin_main(monkeypatch, tmp_path):
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", str(remote))
    project = tmp_path / "cloned"
    project.mkdir()
    _git(project, "init", "-q")
    _git(project, "symbolic-ref", "HEAD", "refs/heads/main")  # older Git ignores init.defaultBranch
    (project / "a.txt").write_text("main\n")
    _git(project, "add", "a.txt")
    _git(project, "commit", "-q", "-m", "on main")
    _git(project, "remote", "add", "origin", str(remote))
    _git(project, "push", "-q", "origin", "main")
    origin_main = _git(project, "rev-parse", "main").strip()
    _git(project, "checkout", "-q", "-b", "local-side")
    (project / "a.txt").write_text("side\n")
    _git(project, "commit", "-q", "-am", "local only")
    posts, spawns = _wire(monkeypatch, "codex")

    _tick(project, {})

    (worktree,) = spawns
    assert _git(worktree, "rev-parse", "HEAD").strip() == origin_main


def test_failures_back_off_and_reason_prints_once(monkeypatch, tmp_path, capsys):
    _documents, project = _empty_parent_with_project(tmp_path)
    posts, spawns = _wire(monkeypatch, "codex")
    clock = [1000.0]
    monkeypatch.setattr(preflight.time, "time", lambda: clock[0])

    _tick(project, {})
    _tick(project, {})  # immediately again: inside the 5s backoff → nothing at all
    assert len(_acks(posts)) == 1

    clock[0] += 5.1
    _tick(project, {})
    assert len(_acks(posts)) == 2
    clock[0] += 5.1  # second backoff is 10s → still waiting
    _tick(project, {})
    assert len(_acks(posts)) == 2
    clock[0] += 5.0
    _tick(project, {})
    assert len(_acks(posts)) == 3

    for _ in range(20):
        clock[0] += preflight.BACKOFF_MAX_SECS + 1
        _tick(project, {})
    assert preflight._BACKOFF["C301"]["next_attempt"] - clock[0] == pytest.approx(
        preflight.BACKOFF_MAX_SECS
    )
    err = capsys.readouterr().err
    assert err.count("conversation startup blocked for Atlas") == 1
    assert spawns == [] and _claims(posts) == []


def test_backoff_stays_capped_after_thousands_of_failures():
    # Days of a blocked repository must keep retrying every 2 minutes, not overflow
    # the doubling (2**1024 is past float range) and raise on every later tick.
    now = 1000.0
    for _ in range(5000):
        delay, _changed = preflight.record_failure("C301-long", "blocked", now=now)
        now += delay
    assert delay == preflight.BACKOFF_MAX_SECS
    assert preflight._BACKOFF["C301-long"]["failures"] == 5000
    assert preflight.in_backoff("C301-long", now=now - 1)
    assert not preflight.in_backoff("C301-long", now=now + 0.1)


@RUNTIMES
def test_recovers_after_first_commit_without_duplicate_start(
    monkeypatch, tmp_path, runtime
):
    project = tmp_path / "proj"
    project.mkdir()
    _git(project, "init", "-q")
    (project / "app.py").write_text("print(1)\n")
    posts, spawns = _wire(monkeypatch, runtime)
    clock = [1000.0]
    monkeypatch.setattr(preflight.time, "time", lambda: clock[0])
    live = {}

    _tick(project, live)
    assert spawns == []

    _git(project, "add", "app.py")
    _git(project, "commit", "-q", "-m", "first commit")
    clock[0] += preflight.BACKOFF_FIRST_SECS + 0.1
    _tick(project, live)
    assert len(spawns) == 1 and "C301" in live
    assert "C301" not in preflight._BACKOFF

    if runtime == "codex":
        # A live worker for this conversation means the next tick never starts another.
        _tick(project, live)
        assert len(spawns) == 1


def test_isolation_failure_after_claim_releases_lease_with_reason(monkeypatch, tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    _git(project, "init", "-q")
    (project / "x").write_text("x\n")
    _git(project, "add", "x")
    _git(project, "commit", "-q", "-m", "c")
    posts, spawns = _wire(monkeypatch, "codex")
    monkeypatch.setattr(notifier, "_provision_resident_worktree", lambda *a: (None, None))

    _tick(project, {})

    assert spawns == [] and len(_claims(posts)) == 1
    (ack,) = _acks(posts)
    assert ack["kind"] == "codex_conversation_failed"
    assert ack["release_lease"] is True
    assert "will not run in the shared folder" in ack["detail"]
    assert "delivered_ts" not in ack


async def test_wake_ack_detail_is_stored_on_the_woken_audit_row(client, make_agent, db):
    agent = await make_agent("Atlas")
    reason = "Git found an empty repository in a parent folder"
    response = await client.post(
        f"/api/agents/{agent['agent_id']}/wake-ack",
        json={
            "kind": "codex_conversation_failed",
            "event": "conversation_turn",
            "lane": "conversation",
            "release_lease": False,
            "detail": reason,
        },
    )
    assert response.status_code == 200, response.text
    rows = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='woken'",
        (agent["agent_id"],),
    )
    assert rows and rows[-1]["detail"]["detail"] == reason
    too_long = await client.post(
        f"/api/agents/{agent['agent_id']}/wake-ack",
        json={"kind": "x", "lane": "conversation", "detail": "y" * 1001},
    )
    assert too_long.status_code in (413, 422)  # oversized fields are refused, never truncated


@RUNTIMES
async def test_blocked_message_stays_pending_and_is_answered_once_after_recovery(
    client, container, make_agent, db, monkeypatch, tmp_path, runtime
):
    """End to end against the real server and database: the notifier only sees what the
    server reports. A blocked start leaves the human turn pending (the reason is saved on
    the woken row); after the fix exactly one worker starts; once its reply is persisted
    and the worker has exited, the refreshed server state starts nothing again."""
    human = await make_agent("Kedar301", "human", kind="human")
    ai = await make_agent("Atlas301")
    aid = ai["agent_id"]
    started = await client.post(
        f"/api/agents/{aid}/conversations", json={"actor_agent_id": human["agent_id"]}
    )
    conv_id = started.json()["conversation"]["id"]
    turn = await client.post(
        f"/api/conversations/{conv_id}/turns",
        json={"role": "human", "author_agent_id": human["agent_id"], "content": "hello?"},
    )
    assert turn.status_code == 201, turn.text

    server = {}

    async def refresh():
        active = (await client.get(f"/api/containers/{container['id']}/active-conversations")).json()
        cand = next(c for c in active["conversations"] if c["conversation_id"] == conv_id)
        server["active"] = {"conversations": [{**cand, "model_runtime": runtime}]}
        server["conversation"] = (await client.get(f"/api/agents/{aid}/conversation?limit=200")).json()
        return cand

    posts, spawns = _wire(monkeypatch, runtime)

    def _get(url, **_):
        if "active-conversations" in url:
            return server["active"]
        if "/conversation" in url:
            return server["conversation"]
        return None

    monkeypatch.setattr(notifier, "_get_json", _get)
    clock = [1000.0]
    monkeypatch.setattr(preflight.time, "time", lambda: clock[0])
    documents, project = _empty_parent_with_project(tmp_path)
    parent_before = _snapshot(documents / ".git")
    live = {}

    # Blocked: no lease claim, a reason ack the server stores, and the turn stays pending.
    assert (await refresh())["pending_human"] is True
    _tick(project, live)
    assert _claims(posts) == [] and spawns == []
    (ack,) = _acks(posts)
    stored = await client.post(f"/api/agents/{aid}/wake-ack", json=ack)
    assert stored.status_code == 200, stored.text
    cand = await refresh()
    assert cand["pending_human"] is True and cand["last_turn_seq"] == 1
    woken = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='woken'", (aid,)
    )
    assert "parent folder" in woken[-1]["detail"]["detail"]

    # Fixed: the project gets its own first commit; one worker starts for the pending turn.
    _git(project, "init", "-q")
    _git(project, "add", "notes.md")
    _git(project, "commit", "-q", "-m", "first commit")
    clock[0] += preflight.BACKOFF_FIRST_SECS + 0.1
    _tick(project, live)
    assert len(spawns) == 1 and conv_id in live

    # The worker replies once (persisted), then its process exits.
    run = db.execute(
        "INSERT INTO worker_runs (agent_id, status) VALUES (%s,'running') RETURNING run_id",
        (aid,),
    )[0]["run_id"]
    reply = await client.post(
        f"/api/conversations/{conv_id}/turns",
        json={"role": "agent", "author_agent_id": aid, "content": "hi", "run_id": str(run)},
    )
    assert reply.status_code == 201, reply.text
    cand = await refresh()
    assert cand["pending_human"] is False and cand["last_turn_seq"] == 2
    live.clear()  # worker process finished
    for _ in range(3):
        clock[0] += preflight.BACKOFF_MAX_SECS + 1
        _tick(project, live)
    assert len(spawns) == 1
    turns = server["conversation"]["turns"]
    assert [t["role"] for t in turns] == ["human", "agent"]
    assert _snapshot(documents / ".git") == parent_before


@RUNTIMES
async def test_recovery_runs_the_real_reply_and_finish_path_once(
    client, container, make_agent, db, monkeypatch, tmp_path, runtime
):
    """Every notifier GET/POST goes to the real server (wake claim, run records, reply turn,
    lease release); only the provider is a stand-in: a real child process plus the output a
    provider leaves behind (Claude's stream `result` line, Codex's last-message file). The
    blocked turn stays pending, one worker answers it once after the fix, its exit is seen
    by the real tick (no live.clear()), the lease is released, and nothing restarts."""
    human = await make_agent("Kedar301b", "human", kind="human")
    ai = await make_agent("Atlas301b")
    aid = ai["agent_id"]
    started = await client.post(
        f"/api/agents/{aid}/conversations", json={"actor_agent_id": human["agent_id"]}
    )
    conv_id = started.json()["conversation"]["id"]
    turn = await client.post(
        f"/api/conversations/{conv_id}/turns",
        json={"role": "human", "author_agent_id": human["agent_id"], "content": "hello?"},
    )
    assert turn.status_code == 201, turn.text

    loop = asyncio.get_running_loop()
    calls: list = []

    def _call(method, url, body=None):
        path = url.split("://", 1)[-1]
        path = path[path.index("/"):]
        coro = client.post(path, json=body) if method == "POST" else client.get(path)
        resp = asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=30)
        calls.append((method, path.split("?")[0], resp.status_code))
        if resp.status_code >= 400:
            return None  # the real helper returns None on HTTP errors
        data = resp.json()
        if "active-conversations" in path and isinstance(data, dict):
            # The fixture agent has no provider configured; pick this run's provider.
            for c in data.get("conversations", []):
                c["model_runtime"] = runtime
        return data

    procs: list = []

    def _spawn(cwd, *args, **kwargs):
        proc = subprocess.Popen(["sleep", "120"], stdin=subprocess.PIPE)
        procs.append(proc)
        return True, "sleep-stand-in", proc

    monkeypatch.setattr(notifier, "_get_json", lambda url, **_: _call("GET", url))
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **_: _call("POST", url, body))
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "PERSONA")
    monkeypatch.setattr(notifier, "spawn_headless", _spawn)
    monkeypatch.setattr(notifier, "spawn_resident", _spawn)
    clock = [1000.0]
    monkeypatch.setattr(preflight.time, "time", lambda: clock[0])
    documents, project = _empty_parent_with_project(tmp_path)
    parent_before = _snapshot(documents / ".git")
    live: dict = {}

    async def tick():
        await asyncio.to_thread(
            notifier.service_residents,
            "http://test", container["id"], live, quiet=True, base_cwd=str(project),
        )

    async def pending():
        active = (await client.get(f"/api/containers/{container['id']}/active-conversations")).json()
        return next(c for c in active["conversations"] if c["conversation_id"] == conv_id)

    def conv_lease():
        rows = db.execute(
            "SELECT conv_lease_until FROM agent_wake_state WHERE agent_id=%s", (aid,)
        )
        return rows[0]["conv_lease_until"] if rows else None

    def agent_turns():
        return db.execute(
            "SELECT role, content FROM conversation_turns WHERE conversation_id=%s ORDER BY seq",
            (conv_id,),
        )

    try:
        # Blocked: the real tick stores its reason, claims nothing, the turn stays pending.
        await tick()
        assert procs == [] and not [c for c in calls if c[1].endswith("/wake-claim")]
        assert (await pending())["pending_human"] is True
        woken = db.execute(
            "SELECT detail FROM events WHERE entity_id=%s AND event_type='woken'", (aid,)
        )
        assert "parent folder" in json.dumps(woken[-1]["detail"])

        # Fixed: one worker starts through the real claim and run-record calls.
        _git(project, "init", "-q")
        _git(project, "add", "notes.md")
        _git(project, "commit", "-q", "-m", "first commit")
        clock[0] += preflight.BACKOFF_FIRST_SECS + 0.1
        await tick()
        assert len(procs) == 1 and conv_id in live
        resident = live[conv_id]
        assert resident.get("current_run_id")
        assert conv_lease() is not None  # the real claim holds the conversation lease

        # The provider produces its reply; the real tick reads and posts it.
        if runtime == "codex":
            reply = pathlib.Path(resident["last_message_path"])
            reply.parent.mkdir(parents=True, exist_ok=True)  # the real spawn opens this folder
            reply.write_text("hi from codex")
            procs[0].terminate()
            procs[0].wait(timeout=10)
        else:
            log = pathlib.Path(resident["log_path"])
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a") as fh:
                fh.write(json.dumps({"type": "result", "subtype": "success",
                                     "result": "hi from claude", "session_id": "S301",
                                     "num_turns": 1}) + "\n")
        await tick()
        if runtime == "claude":
            # The resident stays up after replying; then its process exits.
            procs[0].terminate()
            procs[0].wait(timeout=10)
        for _ in range(3):
            clock[0] += preflight.BACKOFF_MAX_SECS + 1
            await tick()

        rows = agent_turns()
        assert [r["role"] for r in rows] == ["human", "agent"], rows
        assert rows[1]["content"].startswith("hi from ")
        assert (await pending())["pending_human"] is False
        assert len(procs) == 1, "a finished conversation must not restart a worker"
        assert conv_id not in live
        posted = [c for c in calls if c[0] == "POST" and c[1].endswith("/turns")]
        assert len(posted) == 1 and posted[0][2] == 201
        claims = [c for c in calls if c[1].endswith("/wake-claim")]
        assert len(claims) == 1 and claims[0][2] == 200
        assert conv_lease() is None, "the finished worker must release the lease"
        runs = db.execute("SELECT status FROM worker_runs WHERE agent_id=%s", (aid,))
        assert runs and all(r["status"] != "running" for r in runs), runs
        assert _snapshot(documents / ".git") == parent_before
    finally:
        for proc in procs:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
