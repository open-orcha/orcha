"""Project-level worktree routing: persistence, API exposure, and final cwd policy."""

import pathlib
import time
from types import SimpleNamespace

import pytest
from orcha_cli import (
    notifier,
    notifier_checkpoint,
    notifier_codex_conversation,
    notifier_reaper_completion,
    notifier_wake_worker,
)


async def _set(client, cid, human_id, disabled):
    return await client.post(
        f"/api/containers/{cid}/worktrees",
        json={"disabled": disabled, "actor_agent_id": human_id},
    )


@pytest.mark.asyncio
async def test_setting_defaults_off_and_is_exposed_everywhere(
    client, container, make_agent, db
):
    human = await make_agent("operator", kind="human")
    ai = await make_agent("builder")

    row = db.execute(
        "SELECT worktrees_disabled FROM containers WHERE id=%s", (container["id"],)
    )[0]
    assert row["worktrees_disabled"] is False

    snapshot = (await client.get(f"/api/containers/{container['id']}")).json()
    assert snapshot["container"]["worktrees_disabled"] is False
    persona = (await client.get(f"/api/agents/{ai['agent_id']}/persona")).json()
    assert persona["worktrees_disabled"] is False

    conv = (
        await client.post(
            f"/api/agents/{ai['agent_id']}/conversations",
            json={"actor_agent_id": human["agent_id"]},
        )
    ).json()["conversation"]
    conversations = (
        await client.get(f"/api/containers/{container['id']}/active-conversations")
    ).json()
    assert conversations["worktrees_disabled"] is False
    candidate = next(
        c for c in conversations["conversations"] if c["conversation_id"] == conv["id"]
    )
    assert candidate["worktrees_disabled"] is False


@pytest.mark.asyncio
async def test_human_can_toggle_setting_on_and_off(
    client, container, make_agent, make_task, db
):
    human = await make_agent("operator", kind="human")
    ai = await make_agent("builder")
    await make_task("assigned run", "done", assignee_alias="builder")

    enabled = await _set(client, container["id"], human["agent_id"], True)
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["worktrees_disabled"] is True
    assert (
        db.execute(
            "SELECT worktrees_disabled FROM containers WHERE id=%s", (container["id"],)
        )[0]["worktrees_disabled"]
        is True
    )

    scan = (
        await client.get(
            f"/api/containers/{container['id']}/wake-scan",
            params={"cooldown": 0, "min_idle": 0},
        )
    ).json()
    assert scan["worktrees_disabled"] is True
    candidate = next(c for c in scan["candidates"] if c["agent_id"] == ai["agent_id"])
    assert candidate["worktrees_disabled"] is True

    disabled = await _set(client, container["id"], human["agent_id"], False)
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["worktrees_disabled"] is False
    assert (
        db.execute(
            "SELECT worktrees_disabled FROM containers WHERE id=%s", (container["id"],)
        )[0]["worktrees_disabled"]
        is False
    )


@pytest.mark.asyncio
async def test_setting_write_is_human_gated(client, container, make_agent, db):
    ai = await make_agent("builder")
    response = await _set(client, container["id"], ai["agent_id"], True)
    assert response.status_code == 403, response.text
    assert (
        db.execute(
            "SELECT worktrees_disabled FROM containers WHERE id=%s", (container["id"],)
        )[0]["worktrees_disabled"]
        is False
    )


@pytest.mark.parametrize(
    "trigger",
    [
        {"auto_start_task_ids": ["task-assignment"]},
        {"context_task_id": "task-thread-message"},
        {"latest_event": "request_created"},
        {"latest_event": "request_escalated"},
        {"wake_task_id": "retry-or-resume"},
        {"auto_wake_due": True},
        {"self_wake_due": True},
    ],
    ids=[
        "assignment",
        "task-thread-message",
        "request",
        "escalation",
        "retry-resume",
        "automatic-wake",
        "self-wake",
    ],
)
def test_disabled_setting_bypasses_all_worktree_provisioning_paths(trigger):
    """Every work-lane cause converges on _worktree_for before a process is spawned."""
    calls = []
    services = SimpleNamespace(
        _provision_task_worktree=lambda *args: calls.append(("task", args)),
        _provision_worktree=lambda *args: calls.append(("agent", args)),
    )
    candidate = {
        "headless_cwd": "/project/main",
        "alias": "builder",
        "pending_events": 2,
        "worktrees_disabled": True,
        **trigger,
    }

    assert notifier_wake_worker._worktree_for(
        candidate,
        candidate.get("auto_start_task_ids") or [],
        {},
        False,
        services,
    ) == (None, None, False)
    assert calls == []


def test_turning_setting_off_restores_normal_task_worktree_routing():
    calls = []
    services = SimpleNamespace(
        _provision_task_worktree=lambda *args: (
            calls.append(("task", args))
            or ("/project/.orcha-worktrees/task", "orcha/task")
        ),
        _provision_worktree=lambda *args: (
            calls.append(("agent", args))
            or ("/project/.orcha-worktrees/agent", "orcha/agent")
        ),
    )
    candidate = {
        "headless_cwd": "/project/main",
        "alias": "builder",
        "context_task_id": "task-1",
        "pending_events": 1,
        "worktrees_disabled": False,
    }

    assert notifier_wake_worker._worktree_for(candidate, [], {}, False, services) == (
        "/project/.orcha-worktrees/task",
        "orcha/task",
        True,
    )
    assert [kind for kind, _args in calls] == ["task"]


class _Proc:
    pid = 4321


def test_main_routed_task_exit_captures_base_checkout_diff():
    captured = []
    finished = []
    worker = {
        "proc": SimpleNamespace(pid=4321, returncode=0),
        "run_id": "run-1",
        "base_cwd": "/project/main",
        "worktree": None,
        "task_bound": True,
        "task_worktree": False,
        "respawn_ctx": {"task_id": "task-1"},
    }
    live = {"agent-1": worker}
    services = SimpleNamespace(
        RUNTIME_CODEX="codex",
        _capture_diff=lambda cwd: captured.append(cwd) or "main diff",
        _normalize_runtime=lambda runtime: runtime,
        _finish_run=lambda *args, **kwargs: finished.append((args, kwargs)) or True,
        _reap_sandbox_artifacts=lambda *args: None,
        _teardown_worktree=lambda *args: None,
        _post_json=lambda *args: {},
        _retire_headless=lambda _api, workers, aid: workers.pop(aid, None),
    )

    notifier_reaper_completion.handle_exited(
        "http://orcha",
        "agent-1",
        worker,
        live,
        {},
        {},
        0,
        True,
        services,
    )

    assert captured == ["/project/main"]
    assert finished[0][0][5] == "main diff"


def test_main_routed_conversation_completion_captures_base_checkout_diff():
    captured = []
    finished = []
    resident = {
        "agent_id": "agent-1",
        "current_run_id": "run-1",
        "base_cwd": "/project/main",
        "worktree": None,
    }
    services = SimpleNamespace(
        _capture_diff=lambda cwd: captured.append(cwd) or "main diff",
        _finish_run=lambda *args, **kwargs: finished.append((args, kwargs)) or True,
        _reap_sandbox_artifacts=lambda *args: None,
        _post_json=lambda *args: {},
        _conversation_ack_body=lambda kind, **kwargs: {"kind": kind, **kwargs},
    )

    posted = notifier_codex_conversation.finish(
        "http://orcha",
        "conversation-1",
        resident,
        services,
        post_reply=False,
    )

    assert posted is False
    assert captured == ["/project/main"]
    assert finished[0][0][5] == "main diff"


def _orphan_recovery_services(monkeypatch, row):
    captured = []
    finished = []
    posts = []
    events = []

    def post_json(url, body=None, **_kwargs):
        events.append(("post", url))
        posts.append((url, body))
        return {}

    def capture_diff(cwd):
        events.append(("capture", cwd))
        captured.append(cwd)
        return "main diff"

    def finish_run(*args, **kwargs):
        events.append(("finish", args[1]))
        finished.append((args, kwargs))
        return True

    rows = row if isinstance(row, list) else [row]
    monkeypatch.setattr(
        notifier, "_get_json", lambda *_args, **_kwargs: {"runs": rows}
    )
    monkeypatch.setattr(notifier, "_post_json", post_json)
    monkeypatch.setattr(notifier, "_capture_diff", capture_diff)
    monkeypatch.setattr(notifier, "_finish_run", finish_run)
    monkeypatch.setattr(notifier._sandbox, "daemon_reachable", lambda: True)
    monkeypatch.setattr(notifier._sandbox, "managed_containers", lambda _cid: [])
    return captured, finished, posts, events


def test_restart_recovered_main_routed_sandbox_exit_captures_base_checkout_diff(
    monkeypatch,
):
    row = {
        "run_id": "run-1",
        "agent_id": "agent-1",
        "pid": 4321,
        "wake_kind": "sandbox",
        "sandbox_container_id": "orcha-run-main",
        "worktree": None,
        "base_cwd": "/project/main",
        "log_path": "/project/main/run.log",
    }
    captured, finished, _posts, _events = _orphan_recovery_services(monkeypatch, row)
    monkeypatch.setattr(
        notifier._sandbox,
        "probe",
        lambda _name: SimpleNamespace(running=False, exit_code=0, oom_killed=False),
    )
    monkeypatch.setattr(notifier._sandbox, "remove", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        notifier._sandbox, "remove_api_config", lambda *_args, **_kwargs: None
    )

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == ["/project/main"]
    assert finished[0][0][5] == "main diff"


def test_restart_recovered_main_routed_host_exit_captures_before_lease_release(
    monkeypatch,
):
    row = {
        "run_id": "run-1",
        "agent_id": "agent-1",
        "pid": 4321,
        "wake_kind": "ephemeral",
        "lane": "work",
        "worktree": None,
        "base_cwd": "/project/main",
        "log_path": "/project/main/run.log",
    }
    captured, finished, posts, events = _orphan_recovery_services(monkeypatch, row)
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda _pid: False)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == ["/project/main"]
    assert finished[0][0][5] == "main diff"
    assert any(
        url.endswith("/wake-ack") and body["release_lease"] is True
        for url, body in posts
    )
    assert events.index(("finish", "run-1")) < next(
        index
        for index, event in enumerate(events)
        if event[0] == "post" and event[1].endswith("/wake-ack")
    )


def test_restart_recovery_keeps_lease_when_run_snapshot_cannot_be_saved(monkeypatch):
    row = {
        "run_id": "run-1",
        "agent_id": "agent-1",
        "pid": 4321,
        "wake_kind": "ephemeral",
        "lane": "work",
        "worktree": None,
        "base_cwd": "/project/main",
    }
    captured, _finished, posts, _events = _orphan_recovery_services(
        monkeypatch, row
    )
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda _pid: False)
    monkeypatch.setattr(notifier, "_finish_run", lambda *_args, **_kwargs: False)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 0
    assert captured == ["/project/main"]
    assert not any(url.endswith("/wake-ack") for url, _body in posts)


def test_restart_recovery_does_not_capture_checkout_used_by_live_sibling(monkeypatch):
    rows = [
        {
            "run_id": "dead-run",
            "agent_id": "agent-1",
            "pid": 4321,
            "wake_kind": "ephemeral",
            "lane": "work",
            "worktree": None,
            "base_cwd": "/project/main",
        },
        {
            "run_id": "live-run",
            "agent_id": "agent-1",
            "pid": 8765,
            "wake_kind": "checkpoint_respawn",
            "lane": "work",
            "worktree": None,
            "base_cwd": "/project/main",
        },
    ]
    captured, finished, posts, _events = _orphan_recovery_services(
        monkeypatch, rows
    )
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda pid: pid == 8765)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == []
    assert len(finished) == 1
    assert finished[0][0][1] == "dead-run"
    assert finished[0][0][5] is None
    assert not any(url.endswith("/wake-ack") for url, _body in posts)


@pytest.mark.parametrize(
    ("wake_kind", "lane"),
    [("live", "work"), ("resident", "conversation")],
)
def test_restart_recovery_treats_pathless_live_runs_as_checkout_owners(
    monkeypatch, wake_kind, lane
):
    rows = [
        {
            "run_id": "dead-run",
            "agent_id": "agent-1",
            "pid": 4321,
            "wake_kind": "ephemeral",
            "lane": "work",
            "worktree": None,
            "base_cwd": "/project/main",
        },
        {
            "run_id": "live-run",
            "agent_id": "agent-2",
            "pid": 8765,
            "wake_kind": wake_kind,
            "lane": lane,
            # Exact legacy live-terminal / host-resident payload: neither
            # checkout field was recorded before this fix.
            "worktree": None,
            "base_cwd": None,
        },
    ]
    captured, finished, _posts, _events = _orphan_recovery_services(
        monkeypatch, rows
    )
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda pid: pid == 8765)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == []
    assert len(finished) == 1
    assert finished[0][0][1] == "dead-run"
    assert finished[0][0][5] is None


def test_restart_recovery_captures_when_live_sibling_uses_another_checkout(
    monkeypatch,
):
    rows = [
        {
            "run_id": "dead-run",
            "agent_id": "agent-1",
            "pid": 4321,
            "wake_kind": "ephemeral",
            "lane": "work",
            "worktree": "/project/dead-worktree",
            "base_cwd": "/project/main",
        },
        {
            "run_id": "live-run",
            "agent_id": "agent-1",
            "pid": 8765,
            "wake_kind": "checkpoint_respawn",
            "lane": "work",
            "worktree": "/project/live-worktree",
            "base_cwd": "/project/main",
        },
    ]
    captured, finished, _posts, _events = _orphan_recovery_services(
        monkeypatch, rows
    )
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda pid: pid == 8765)

    assert notifier.reap_orphaned_runs("http://orcha", "container-1") == 1
    assert captured == ["/project/dead-worktree"]
    assert len(finished) == 1
    assert finished[0][0][1] == "dead-run"
    assert finished[0][0][5] == "main diff"


def _checkpoint_services(*, disabled, spawned, provisioned):
    posts = []

    def get_json(url):
        if url.endswith("/runs?limit=20"):
            return {"runs": [{"run_id": "run-1", "task_id": "task-1"}]}
        if url.endswith("/persona"):
            return {"worktrees_disabled": disabled}
        return None

    def post_json(url, body):
        posts.append((url, body))
        return {"run_id": "run-2"} if url.endswith("/runs") else {}

    return SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        HARD_CAP_RESPAWN_MAX=3,
        pathlib=pathlib,
        time=time,
        _kill_worker=lambda *args, **kwargs: None,
        _capture_diff=lambda worktree: "saved diff" if worktree else None,
        _handoff_worktree_changes=lambda *args: True,
        _finish_run=lambda *args, **kwargs: True,
        _reap_sandbox_artifacts=lambda *args, **kwargs: None,
        _get_json=get_json,
        _revoke_or_defer=lambda *args, **kwargs: None,
        _mint_embodiment_token=lambda *args, **kwargs: "token-2",
        _build_persona=lambda *args, **kwargs: "persona",
        spawn_headless=lambda cwd, *args, **kwargs: (
            spawned.append(cwd) or (True, "command", _Proc())
        ),
        _post_json=post_json,
        posts=posts,
        _retire_headless=lambda _api, live, aid: live.pop(aid, None),
        _provision_task_worktree=lambda *args: (
            provisioned.append(("task", args))
            or ("/project/.orcha-worktrees/task-1", "orcha/task-1")
        ),
        _provision_worktree=lambda *args: (
            provisioned.append(("agent", args))
            or ("/project/.orcha-worktrees/agent", "orcha/agent")
        ),
    )


def _checkpoint_worker(*, disabled, worktree, branch, task_worktree):
    return {
        "proc": _Proc(),
        "run_id": "run-1",
        "log_path": None,
        "base_cwd": "/project/main",
        "worktree": worktree,
        "branch": branch,
        "task_bound": True,
        "task_worktree": task_worktree,
        "worktrees_disabled": disabled,
        "cap": 1200,
        "respawns": 0,
        "agent_id": "agent-1",
        "respawn_ctx": {
            "prompt": "continue",
            "alias": "builder",
            "task_id": "task-1",
            "worktrees_disabled": disabled,
        },
    }


def test_checkpoint_resume_rechecks_toggle_and_moves_to_main_without_cleanup():
    spawned, provisioned = [], []
    services = _checkpoint_services(
        disabled=True, spawned=spawned, provisioned=provisioned
    )
    worker = _checkpoint_worker(
        disabled=False,
        worktree="/project/.orcha-worktrees/task-1",
        branch="orcha/task-1",
        task_worktree=True,
    )
    live = {"agent-1": worker}

    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha", "agent-1", worker, live, True, services
    )

    assert spawned == ["/project/main"]
    assert provisioned == []
    assert live["agent-1"]["worktree"] is None
    assert live["agent-1"]["task_worktree"] is False
    assert live["agent-1"]["worktrees_disabled"] is True


def test_checkpoint_resume_rechecks_toggle_off_and_restores_task_routing():
    spawned, provisioned = [], []
    services = _checkpoint_services(
        disabled=False, spawned=spawned, provisioned=provisioned
    )
    worker = _checkpoint_worker(
        disabled=True, worktree=None, branch=None, task_worktree=False
    )
    live = {"agent-1": worker}

    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha", "agent-1", worker, live, True, services
    )

    assert spawned == ["/project/.orcha-worktrees/task-1"]
    assert [kind for kind, _args in provisioned] == ["task"]
    assert live["agent-1"]["task_worktree"] is True
    assert live["agent-1"]["worktrees_disabled"] is False


def test_checkpoint_handoff_conflict_stops_and_posts_visible_failure():
    spawned, provisioned = [], []
    services = _checkpoint_services(
        disabled=True, spawned=spawned, provisioned=provisioned
    )
    services._handoff_worktree_changes = lambda *args: False
    worker = _checkpoint_worker(
        disabled=False,
        worktree="/project/.orcha-worktrees/agent",
        branch="orcha/agent",
        task_worktree=False,
    )
    live = {"agent-1": worker}

    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha", "agent-1", worker, live, True, services
    )

    assert spawned == []
    assert "agent-1" not in live
    assert any(
        url.endswith("/tasks/task-1/messages")
        and "no replacement worker was started" in body["body"]
        for url, body in services.posts
    )
    assert any(
        url.endswith("/wake-ack")
        and body["kind"] == "worker_checkpoint_handoff_failed"
        and body["release_lease"] is True
        for url, body in services.posts
    )


def _checkpoint_repo(tmp_path):
    main = tmp_path / "main"
    main.mkdir()
    assert notifier._run_git(["init"], cwd=main)[0] == 0
    assert (
        notifier._run_git(["symbolic-ref", "HEAD", "refs/heads/main"], cwd=main)[0] == 0
    )
    assert (
        notifier._run_git(["config", "user.email", "test@example.com"], cwd=main)[0]
        == 0
    )
    assert notifier._run_git(["config", "user.name", "Test"], cwd=main)[0] == 0
    (main / "base.txt").write_text("base\n")
    assert notifier._run_git(["add", "base.txt"], cwd=main)[0] == 0
    assert notifier._run_git(["commit", "-m", "base"], cwd=main)[0] == 0
    origin = tmp_path / "origin.git"
    assert (
        notifier._run_git(["clone", "--bare", str(main), str(origin)], cwd=tmp_path)[0]
        == 0
    )
    assert notifier._run_git(["remote", "add", "origin", str(origin)], cwd=main)[0] == 0
    assert notifier._run_git(["fetch", "origin"], cwd=main)[0] == 0
    return main


def _real_checkpoint_services(*, disabled, spawned):
    services = _checkpoint_services(disabled=disabled, spawned=spawned, provisioned=[])
    services._capture_diff = notifier._capture_diff
    services._handoff_worktree_changes = notifier._handoff_worktree_changes
    services._provision_task_worktree = notifier._provision_task_worktree
    services._provision_worktree = notifier._provision_worktree
    return services


def test_checkpoint_toggle_to_main_carries_in_progress_files(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    (pathlib.Path(worktree) / "wip.txt").write_text("from task worktree\n")
    worker = _checkpoint_worker(
        disabled=False, worktree=worktree, branch=branch, task_worktree=True
    )
    worker["base_cwd"] = str(main)
    live = {"agent-1": worker}
    spawned = []

    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha",
        "agent-1",
        worker,
        live,
        True,
        _real_checkpoint_services(disabled=True, spawned=spawned),
    )

    assert spawned == [str(main)]
    assert (main / "wip.txt").read_text() == "from task worktree\n"


def test_checkpoint_toggle_back_to_worktree_carries_main_files(tmp_path):
    main = _checkpoint_repo(tmp_path)
    (main / "wip.txt").write_text("from main checkout\n")
    worker = _checkpoint_worker(
        disabled=True, worktree=None, branch=None, task_worktree=False
    )
    worker["base_cwd"] = str(main)
    live = {"agent-1": worker}
    spawned = []

    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha",
        "agent-1",
        worker,
        live,
        True,
        _real_checkpoint_services(disabled=False, spawned=spawned),
    )

    destination = pathlib.Path(spawned[0])
    assert destination != main
    assert (destination / "wip.txt").read_text() == "from main checkout\n"


def test_checkpoint_toggle_round_trip_reuses_preserved_task_worktree(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    (pathlib.Path(worktree) / "wip.txt").write_text("preserved round trip\n")
    worker = _checkpoint_worker(
        disabled=False, worktree=worktree, branch=branch, task_worktree=True
    )
    worker["base_cwd"] = str(main)
    live = {"agent-1": worker}
    spawned = []

    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha",
        "agent-1",
        worker,
        live,
        True,
        _real_checkpoint_services(disabled=True, spawned=spawned),
    )
    assert spawned == [str(main)]
    assert (main / "wip.txt").read_text() == "preserved round trip\n"

    main_worker = live["agent-1"]
    spawned.clear()
    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha",
        "agent-1",
        main_worker,
        live,
        True,
        _real_checkpoint_services(disabled=False, spawned=spawned),
    )

    assert spawned == [worktree]
    assert live["agent-1"]["worktree"] == worktree
    assert live["agent-1"]["task_worktree"] is True
    assert (pathlib.Path(worktree) / "wip.txt").read_text() == "preserved round trip\n"


def test_checkpoint_repeated_toggle_after_initial_clean_handoff(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_task_worktree(str(main), "builder", "task-1")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is True
    main_file = main / "wip.txt"
    main_file.write_text("first main edit\n")

    assert notifier._handoff_worktree_changes(str(main), worktree) is True
    task_file = pathlib.Path(worktree) / "wip.txt"
    assert task_file.read_text() == "first main edit\n"
    task_file.write_text("later task edit\n")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is True
    assert main_file.read_text() == "later task edit\n"


def test_checkpoint_toggle_round_trip_keeps_main_checkout_deletion(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    task_file = pathlib.Path(worktree) / "wip.txt"
    task_file.write_text("delete during round trip\n")
    worker = _checkpoint_worker(
        disabled=False, worktree=worktree, branch=branch, task_worktree=True
    )
    worker["base_cwd"] = str(main)
    live = {"agent-1": worker}
    spawned = []

    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha",
        "agent-1",
        worker,
        live,
        True,
        _real_checkpoint_services(disabled=True, spawned=spawned),
    )
    assert (main / "wip.txt").read_text() == "delete during round trip\n"
    (main / "wip.txt").unlink()

    main_worker = live["agent-1"]
    spawned.clear()
    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha",
        "agent-1",
        main_worker,
        live,
        True,
        _real_checkpoint_services(disabled=False, spawned=spawned),
    )

    assert spawned == [worktree]
    assert live["agent-1"]["worktree"] == worktree
    assert live["agent-1"]["task_worktree"] is True
    assert not task_file.exists()


def test_checkpoint_toggle_round_trip_replaces_old_task_files(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    old_task_file = pathlib.Path(worktree) / "old-task.txt"
    old_task_file.write_text("old task work\n")
    worker = _checkpoint_worker(
        disabled=False, worktree=worktree, branch=branch, task_worktree=True
    )
    worker["base_cwd"] = str(main)
    live = {"agent-1": worker}
    spawned = []

    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha",
        "agent-1",
        worker,
        live,
        True,
        _real_checkpoint_services(disabled=True, spawned=spawned),
    )
    assert (main / "old-task.txt").read_text() == "old task work\n"
    (main / "old-task.txt").unlink()
    (main / "new-task.txt").write_text("replacement task work\n")

    main_worker = live["agent-1"]
    spawned.clear()
    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha",
        "agent-1",
        main_worker,
        live,
        True,
        _real_checkpoint_services(disabled=False, spawned=spawned),
    )

    destination = pathlib.Path(worktree)
    assert spawned == [worktree]
    assert live["agent-1"]["worktree"] == worktree
    assert live["agent-1"]["task_worktree"] is True
    assert not (destination / "old-task.txt").exists()
    assert (destination / "new-task.txt").read_text() == "replacement task work\n"


def test_handoff_does_not_delete_unknown_destination_work(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, _branch = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
    task_file = pathlib.Path(worktree) / "task-work.txt"
    task_file.write_text("agent work\n")
    human_file = main / "human-work.txt"
    human_file.write_text("independent main checkout work\n")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is False
    assert task_file.read_text() == "agent work\n"
    assert human_file.read_text() == "independent main checkout work\n"
    assert not (main / "task-work.txt").exists()


def test_handoff_does_not_claim_unknown_identical_main_checkout(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, _branch = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
    main_file = main / "shared.txt"
    task_file = pathlib.Path(worktree) / "shared.txt"
    main_file.write_text("independently created\n")
    task_file.write_text("independently created\n")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is True
    task_file.write_text("later task edit\n")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is False
    assert main_file.read_text() == "independently created\n"
    assert task_file.read_text() == "later task edit\n"


def test_round_trip_preserves_new_independent_destination_work(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, _branch = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
    destination = pathlib.Path(worktree)
    old_task_file = destination / "old-task.txt"
    old_task_file.write_text("old task work\n")

    assert notifier._handoff_worktree_changes(worktree, str(main)) is True
    (main / "old-task.txt").unlink()
    (main / "new-task.txt").write_text("replacement task work\n")
    independent_file = destination / "human-work.txt"
    independent_file.write_text("independent destination work\n")

    assert notifier._handoff_worktree_changes(str(main), worktree) is True
    assert not old_task_file.exists()
    assert (destination / "new-task.txt").read_text() == "replacement task work\n"
    assert independent_file.read_text() == "independent destination work\n"
