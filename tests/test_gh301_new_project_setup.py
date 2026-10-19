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

import pathlib

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
