"""GH #301 follow-up: a new project's first chat when its folder has no usable Git.

Sample sat inside an empty ``~/Documents`` repository with no repository of its own. The
merged startup check correctly refused to branch in that parent, but the chat only said
"answered on the next wake" and there was no way to fix it from Orcha. These tests cover
the explanation the chat now receives and the one deliberate, project-local setup a human
can ask for — with real Git fixtures in disposable folders, for both Claude and Codex.
Only the HTTP helpers and the provider spawns are faked in the notifier tests; the API
tests run against the real server and database.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import subprocess

import pytest

from orcha_cli import notifier
from orcha_cli import notifier_startup_preflight as preflight
from test_gh301_startup_inherited_repo import (  # noqa: F401  (autouse fixture)
    CONV_EXTRA,
    RUNTIMES,
    _acks,
    _claims,
    _empty_parent_with_project,
    _git,
    _git_ceiling,
    _snapshot,
    _tick,
    _wire,
)


@pytest.fixture(autouse=True)
def _no_setup_request():
    CONV_EXTRA.clear()
    preflight._SETUP_DONE.clear()
    yield
    CONV_EXTRA.clear()
    preflight._SETUP_DONE.clear()


def _setup_results(posts):
    return [b for u, b in posts if u.endswith("/conversation/repository-setup/result")]


def _outside(root: pathlib.Path, project: pathlib.Path) -> dict:
    """Snapshot of root without the project folder (which setup is allowed to change)."""
    rel = str(project.relative_to(root))
    return {
        k: v
        for k, v in _snapshot(root).items()
        if k != rel and not k.startswith(rel + "/")
    }


def _request_setup(at=500.0):
    CONV_EXTRA["setup_requested_at"] = at


def _index(project) -> list[str]:
    return sorted(_git(project, "diff", "--cached", "--name-only").split())


# ------------------------------------------------------------------ notifier + real Git


@RUNTIMES
def test_inherited_empty_parent_offers_setup_and_setup_starts_one_worker(
    monkeypatch, tmp_path, runtime
):
    documents, project = _empty_parent_with_project(tmp_path)
    parent_git = _snapshot(documents / ".git")
    outside = _outside(documents, project)
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}

    _tick(project, live)
    (ack,) = _acks(posts)
    assert ack["blocker"] == "ancestor_repo" and ack["setup_available"] is True
    assert preflight.SETUP_LABEL in ack["detail"]
    assert _claims(posts) == [] and spawns == [] and _setup_results(posts) == []
    assert not (project / ".git").exists(), "nothing changes without the human's click"

    # The human clicks "Set up Git for this project": acted on at once, mid-backoff.
    _request_setup()
    _tick(project, live)
    (result,) = _setup_results(posts)
    assert result["ok"] is True and result["requested_at"] == 500.0
    assert "Created a Git repository in the project folder" in result["detail"]
    assert (project / ".git").is_dir()
    assert _git(project, "rev-parse", "--show-toplevel").strip() == str(project.resolve())
    assert _git(project, "log", "--format=%s").strip() == preflight.EMPTY_COMMIT_MESSAGE
    assert _git(project, "ls-tree", "-r", "HEAD").strip() == "", "the first commit is empty"
    assert (project / "notes.md").read_text() == "project file\n"
    assert len(_claims(posts)) == 1 and len(spawns) == 1
    assert spawns[0] != str(project), "the worker runs in its own checkout"

    # Parent repository: .git and every file outside the project folder byte-identical.
    assert _snapshot(documents / ".git") == parent_git
    assert _outside(documents, project) == outside

    # Same request again (still listed until the server records the result): no rerun,
    # and with the worker live, no duplicate launch.
    _tick(project, live)
    assert len(_setup_results(posts)) == 1 and len(spawns) == 1


@RUNTIMES
def test_parent_with_history_gets_project_local_setup_and_keeps_its_refs(
    monkeypatch, tmp_path, runtime
):
    documents, project = _empty_parent_with_project(tmp_path)
    _git(documents, "add", "taxes.txt")
    _git(documents, "commit", "-q", "-m", "parent history")
    refs = _git(documents, "show-ref")
    worktrees = _git(documents, "worktree", "list", "--porcelain")
    parent_git = _snapshot(documents / ".git")
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}

    _tick(project, live)
    (ack,) = _acks(posts)
    assert ack["blocker"] == "ancestor_repo" and ack["setup_available"] is True
    assert "saved history" in ack["detail"]

    _request_setup()
    _tick(project, live)
    (result,) = _setup_results(posts)
    assert result["ok"] is True
    assert len(spawns) == 1
    assert _git(documents, "show-ref") == refs
    assert _git(documents, "worktree", "list", "--porcelain") == worktrees
    assert _snapshot(documents / ".git") == parent_git


@RUNTIMES
def test_parent_tracking_the_project_folder_refuses_setup(monkeypatch, tmp_path, runtime):
    documents, project = _empty_parent_with_project(tmp_path)
    _git(documents, "add", ".")
    _git(documents, "commit", "-q", "-m", "parent tracks the project folder too")
    before = _snapshot(documents)
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}

    _tick(project, live)
    (ack,) = _acks(posts)
    assert ack["blocker"] == "ancestor_repo" and ack["setup_available"] is False
    assert "already tracks files inside the project folder" in ack["detail"]
    assert preflight.SETUP_LABEL not in ack["detail"]

    # A stale or forged request still cannot make Orcha split the parent's history.
    _request_setup()
    _tick(project, live)
    (result,) = _setup_results(posts)
    assert result["ok"] is False
    assert "already tracks files inside the project folder" in result["detail"]
    assert spawns == [] and _claims(posts) == []
    assert not (project / ".git").exists()
    assert _snapshot(documents) == before


@RUNTIMES
def test_empty_project_repo_gets_an_empty_first_commit_and_keeps_staged_work(
    monkeypatch, tmp_path, runtime
):
    project = tmp_path / "Fresh"
    project.mkdir()
    _git(project, "init", "-q")
    (project / "app.py").write_text("print('staged')\n")
    (project / "draft.txt").write_text("not staged\n")
    _git(project, "add", "app.py")
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}

    _tick(project, live)
    (ack,) = _acks(posts)
    assert ack["blocker"] == "no_commit" and ack["setup_available"] is True

    _request_setup()
    _tick(project, live)
    (result,) = _setup_results(posts)
    assert result["ok"] is True and result["detail"].startswith("Created an empty first commit")
    assert _git(project, "ls-tree", "-r", "HEAD").strip() == ""
    # The staged file is still staged (not committed), the other file still untracked.
    assert _index(project) == ["app.py"]
    assert "?? draft.txt" in _git(project, "status", "--porcelain")
    assert (project / "app.py").read_text() == "print('staged')\n"
    assert len(spawns) == 1


@RUNTIMES
def test_fresh_non_git_folder_starts_without_any_setup(monkeypatch, tmp_path, runtime):
    project = tmp_path / "Plain"
    project.mkdir()
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}
    _request_setup()  # even a stray request changes nothing in a non-Git folder

    _tick(project, live)
    assert spawns == [str(project)]
    assert not (project / ".git").exists()
    (result,) = _setup_results(posts)
    assert result["ok"] is True and "nothing was changed" in result["detail"]


@RUNTIMES
def test_usable_local_only_repo_starts_without_setup(monkeypatch, tmp_path, runtime):
    project = tmp_path / "Local"
    project.mkdir()
    _git(project, "init", "-q")
    (project / "a.txt").write_text("a\n")
    _git(project, "add", "a.txt")
    _git(project, "commit", "-q", "-m", "local history")
    head = _git(project, "rev-parse", "HEAD")
    posts, spawns = _wire(monkeypatch, runtime)
    live = {}

    _tick(project, live)
    assert len(spawns) == 1 and _setup_results(posts) == []
    assert _git(project, "rev-parse", "HEAD") == head


def test_setup_refuses_when_the_branch_appears_mid_setup(monkeypatch, tmp_path):
    """update-ref with an empty old value never overwrites a branch someone just made."""
    project = tmp_path / "Race"
    project.mkdir()
    _git(project, "init", "-q")
    services = notifier
    real = preflight._worktree_base.run_git

    def racing(args, cwd=None, **kw):
        if args[:1] == ["update-ref"]:
            (project / "f").write_text("x")
            _git(project, "add", "f")
            _git(project, "commit", "-q", "-m", "someone else")
        return real(args, cwd=cwd, **kw)

    monkeypatch.setattr(notifier, "_run_git", racing, raising=False)
    ok, detail = preflight.setup_project_repository(str(project), services)
    assert ok is False and "nothing was committed" in detail
    assert _git(project, "log", "--format=%s").strip() == "someone else"


# ------------------------------------------------------------------ API (real server + DB)


async def _blocked_chat(client, make_agent, *, setup_available=True, blocker="ancestor_repo"):
    human = await make_agent("KedarSetup", "human", kind="human")
    ai = await make_agent("AtlasSetup")
    aid = ai["agent_id"]
    conv = (
        await client.post(
            f"/api/agents/{aid}/conversations", json={"actor_agent_id": human["agent_id"]}
        )
    ).json()["conversation"]
    turn = await client.post(
        f"/api/conversations/{conv['id']}/turns",
        json={"role": "human", "author_agent_id": human["agent_id"], "content": "hello?"},
    )
    assert turn.status_code == 201, turn.text
    ack = await client.post(
        f"/api/agents/{aid}/wake-ack",
        json={
            "kind": "codex_conversation_failed",
            "event": "conversation_turn",
            "lane": "conversation",
            "release_lease": False,
            "detail": "Sample is not its own Git repository.",
            "blocker": blocker,
            "setup_available": setup_available,
        },
    )
    assert ack.status_code == 200, ack.text
    return human["agent_id"], aid, conv["id"]


async def test_conversation_reads_carry_the_startup_block_until_a_worker_starts(
    client, make_agent, db
):
    _human, aid, conv_id = await _blocked_chat(client, make_agent)
    read = (await client.get(f"/api/agents/{aid}/conversation")).json()
    block = read["startup_blocked"]
    assert block["reason"] == "Sample is not its own Git repository."
    assert block["blocker"] == "ancestor_repo" and block["setup_available"] is True
    assert block["setup"] is None
    assert (await client.get(f"/api/conversations/{conv_id}")).json()["startup_blocked"] == block

    # A conversation worker starting after the block clears it (truthful, not sticky).
    db.execute(
        "INSERT INTO worker_runs (agent_id, status, lane) VALUES (%s,'running','conversation')",
        (aid,),
    )
    assert (await client.get(f"/api/agents/{aid}/conversation")).json()["startup_blocked"] is None


async def test_no_block_once_the_agent_has_answered(client, make_agent, db):
    _human, aid, conv_id = await _blocked_chat(client, make_agent)
    run = db.execute(
        "INSERT INTO worker_runs (agent_id, status) VALUES (%s,'exited') RETURNING run_id",
        (aid,),
    )[0]["run_id"]
    reply = await client.post(
        f"/api/conversations/{conv_id}/turns",
        json={"role": "agent", "author_agent_id": aid, "content": "hi", "run_id": str(run)},
    )
    assert reply.status_code == 201, reply.text
    assert (await client.get(f"/api/agents/{aid}/conversation")).json()["startup_blocked"] is None


async def test_setup_request_flows_to_the_notifier_and_back(client, container, make_agent):
    human, aid, conv_id = await _blocked_chat(client, make_agent)
    url = f"/api/agents/{aid}/conversation/repository-setup"

    first = await client.post(url, json={"actor_agent_id": human})
    assert first.status_code == 202, first.text
    assert first.json()["created"] is True and first.json()["setup"]["state"] == "requested"
    again = await client.post(url, json={"actor_agent_id": human})
    assert again.status_code == 202 and again.json()["created"] is False

    async def candidate():
        active = (
            await client.get(f"/api/containers/{container['id']}/active-conversations")
        ).json()
        return next(c for c in active["conversations"] if c["conversation_id"] == conv_id)

    requested_at = (await candidate())["setup_requested_at"]
    assert requested_at is not None

    done = await client.post(
        f"{url}/result",
        json={"ok": True, "detail": "Created an empty first commit.", "requested_at": requested_at},
    )
    assert done.status_code == 201, done.text
    assert (await candidate())["setup_requested_at"] is None
    block = (await client.get(f"/api/agents/{aid}/conversation")).json()["startup_blocked"]
    assert block["setup"]["state"] == "done"
    assert block["setup"]["detail"] == "Created an empty first commit."


async def test_setup_request_is_refused_when_it_cannot_help(client, make_agent):
    human, aid, _conv = await _blocked_chat(client, make_agent, setup_available=False)
    url = f"/api/agents/{aid}/conversation/repository-setup"
    assert (await client.post(url, json={"actor_agent_id": human})).status_code == 409
    # Only a human can ask for a change to the project folder.
    assert (await client.post(url, json={"actor_agent_id": aid})).status_code in (400, 403)


async def test_isolation_failure_is_shown_without_a_setup_offer(client, make_agent):
    human, aid, _conv = await _blocked_chat(
        client, make_agent, setup_available=None, blocker="isolation_failed"
    )
    block = (await client.get(f"/api/agents/{aid}/conversation")).json()["startup_blocked"]
    assert block["blocker"] == "isolation_failed" and block["setup_available"] is False
    url = f"/api/agents/{aid}/conversation/repository-setup"
    assert (await client.post(url, json={"actor_agent_id": human})).status_code == 409


@RUNTIMES
async def test_setup_click_recovers_through_the_real_path_with_one_reply(
    client, container, make_agent, db, monkeypatch, tmp_path, runtime
):
    """The first-use path end to end: every notifier GET/POST goes to the real server and
    only the provider is a stand-in (a real child process plus its reply output). The chat
    read names the block and offers setup; the human's click (a real API call) is carried
    out by the next tick without waiting out the backoff; one worker answers the waiting
    turn once, retires normally, releases the lease and nothing starts again. The parent
    repository's .git and every file outside the project folder stay byte-identical."""
    human = await make_agent("KedarSetupE2E", "human", kind="human")
    ai = await make_agent("AtlasSetupE2E")
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
    outside_before = _outside(documents, project)
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

        # The chat read explains it and offers the project-local setup.
        block = (await client.get(f"/api/agents/{aid}/conversation")).json()["startup_blocked"]
        assert block["blocker"] == "ancestor_repo" and block["setup_available"] is True
        assert str(documents) in block["reason"]
        assert not (project / ".git").exists()

        # The human clicks "Set up Git for this project"; the next tick (still inside
        # the backoff window — no clock change) does it and starts one worker.
        click = await client.post(
            f"/api/agents/{aid}/conversation/repository-setup",
            json={"actor_agent_id": human["agent_id"]},
        )
        assert click.status_code == 202, click.text
        await tick()
        results = [c for c in calls if c[1].endswith("/repository-setup/result")]
        assert results == [("POST", f"/api/agents/{aid}/conversation/repository-setup/result", 201)]
        assert (project / ".git").is_dir()
        assert len(procs) == 1 and conv_id in live
        assert (await client.get(f"/api/agents/{aid}/conversation")).json()["startup_blocked"] is None
        assert (await pending())["setup_requested_at"] is None
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
        assert _outside(documents, project) == outside_before
        assert len([c for c in calls if c[1].endswith("/repository-setup/result")]) == 1
    finally:
        for proc in procs:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
