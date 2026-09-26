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
    notifier_resident_claude_start,
    notifier_wake_worker,
    terminal_bridge_api,
    terminal_bridge_connection,
)
from orcha_cli.notifier_routing_handoff import carry_previous_checkout


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
        _handoff_worktree_changes=lambda *args, **kwargs: True,
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
    services._handoff_worktree_changes = lambda *args, **kwargs: False
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
    worktree, branch = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
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


def test_checkpoint_carries_task_files_main_to_worktree_to_main(tmp_path):
    main = _checkpoint_repo(tmp_path)
    main_file = main / "wip.txt"
    main_file.write_text("edited in main checkout\n")
    spawned = []
    history = {
        "runs": [
            {
                "run_id": "run-1",
                "task_id": "task-1",
                "worktree": None,
                "base_cwd": str(main),
            }
        ]
    }
    routing = {"disabled": False}
    services = _real_checkpoint_services(disabled=False, spawned=spawned)

    def get_json(url):
        if url.endswith("/runs?limit=20"):
            return history
        if url.endswith("/persona"):
            return {"worktrees_disabled": routing["disabled"]}
        return None

    def post_json(url, body):
        services.posts.append((url, body))
        if url.endswith("/runs"):
            run = {"run_id": f"run-{len(history['runs']) + 1}", **body}
            history["runs"].insert(0, run)
            return {"run_id": run["run_id"]}
        return {}

    services._get_json = get_json
    services._post_json = post_json
    worker = _checkpoint_worker(
        disabled=True, worktree=None, branch=None, task_worktree=False
    )
    worker["base_cwd"] = str(main)
    live = {"agent-1": worker}

    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha", "agent-1", worker, live, True, services
    )

    task_worker = live["agent-1"]
    task_file = pathlib.Path(task_worker["worktree"]) / main_file.name
    assert spawned == [task_worker["worktree"]]
    assert task_file.read_text() == "edited in main checkout\n"
    task_file.write_text("edited later in task worktree\n")

    routing["disabled"] = True
    notifier_checkpoint.checkpoint_and_respawn(
        "http://orcha", "agent-1", task_worker, live, True, services
    )

    assert spawned == [task_worker["worktree"], str(main)]
    assert live["agent-1"]["worktree"] is None
    assert main_file.read_text() == "edited later in task worktree\n"


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
    worktree, _branch = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )

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


def test_handoff_does_not_overwrite_unknown_ignored_destination(tmp_path):
    main = _checkpoint_repo(tmp_path)
    (main / ".gitignore").write_text(".env\n")
    assert notifier._run_git(["add", ".gitignore"], cwd=main)[0] == 0
    assert notifier._run_git(
        ["commit", "-m", "ignore local environment"], cwd=main
    )[0] == 0
    assert notifier._run_git(["push", "origin", "main"], cwd=main)[0] == 0
    worktree, _branch = notifier._provision_worktree(str(main), "builder")
    source_file = pathlib.Path(worktree) / ".env"
    destination_file = main / ".env"
    source_file.write_text("SOURCE=worker\n")
    destination_file.write_text("SOURCE=human\n")
    before_index = notifier._run_git(
        ["diff", "--cached", "--binary"], cwd=str(main)
    )[1]

    assert notifier._handoff_worktree_changes(worktree, str(main)) is False
    assert source_file.read_text() == "SOURCE=worker\n"
    assert destination_file.read_text() == "SOURCE=human\n"
    assert (
        notifier._run_git(["diff", "--cached", "--binary"], cwd=str(main))[1]
        == before_index
    )


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


def test_ordinary_task_wakes_carry_checkpointed_state_across_repeated_toggles(
    tmp_path,
):
    """Separate later wakes must resume the newest task file view in either mode."""
    main = _checkpoint_repo(tmp_path)
    worktree, _branch = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
    task_file = pathlib.Path(worktree) / "continued.txt"
    task_file.write_text("saved by first task wake\n")
    assert notifier._run_git(["add", "continued.txt"], cwd=worktree)[0] == 0
    assert notifier._run_git(["commit", "-m", "checkpoint"], cwd=worktree)[0] == 0

    previous = {
        "task_id": "task-1",
        "worktree": worktree,
        "base_cwd": str(main),
    }
    services = SimpleNamespace(
        _get_json=lambda _url: {"runs": [previous]},
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
    )
    assert carry_previous_checkout(
        "http://orcha",
        "agent-1",
        str(main),
        services,
        task_id="task-1",
    )
    main_file = main / "continued.txt"
    assert main_file.read_text() == "saved by first task wake\n"

    main_file.write_text("edited by main-checkout wake\n")
    previous = {
        "task_id": "task-1",
        "worktree": None,
        "base_cwd": str(main),
    }
    assert carry_previous_checkout(
        "http://orcha",
        "agent-1",
        worktree,
        services,
        task_id="task-1",
    )
    assert task_file.read_text() == "edited by main-checkout wake\n"

    task_file.write_text("edited by later worktree wake\n")
    previous = {
        "task_id": "task-1",
        "worktree": worktree,
        "base_cwd": str(main),
    }
    assert carry_previous_checkout(
        "http://orcha",
        "agent-1",
        str(main),
        services,
        task_id="task-1",
    )
    assert main_file.read_text() == "edited by later worktree wake\n"


@pytest.mark.asyncio
async def test_ordinary_wake_carries_task_files_main_to_worktree_to_main(
    client, make_agent, make_task, tmp_path
):
    """The real run feed must prove ownership across separate routing modes."""
    agent = await make_agent("builder")
    task = await make_task("continue work", "files carried", assignee_alias="builder")
    main = _checkpoint_repo(tmp_path)
    main_file = main / "ordinary-wake.txt"
    main_file.write_text("saved by main-checkout wake\n")

    started = await client.post(
        f"/api/agents/{agent['agent_id']}/runs",
        json={
            "wake_kind": "ephemeral",
            "wake_event": "task_message",
            "task_id": task["id"],
            "lane": "work",
            "worktree": None,
            "branch": None,
            "base_cwd": str(main),
        },
    )
    assert started.status_code == 201, started.text
    history = (await client.get(f"/api/agents/{agent['agent_id']}/runs")).json()
    assert history["runs"][0]["lane"] == "work"

    spawned = []
    live_workers = {}

    def post_json(url, _body):
        if url.endswith("/wake-claim"):
            return {"claimed": True}
        if url.endswith("/runs"):
            return {"run_id": "unpersisted-test-run"}
        return {}

    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _get_json=lambda _url: history,
        _post_json=post_json,
        _build_persona=lambda *args, **kwargs: "persona",
        _provision_task_worktree=notifier._provision_task_worktree,
        _provision_worktree=notifier._provision_worktree,
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _handoff_branch_changes=notifier._handoff_branch_changes,
        _mint_embodiment_token=lambda *args: "token",
        _revoke_or_defer=lambda *args: None,
        _teardown_worktree=lambda *args: None,
        spawn_headless=lambda cwd, *args, **kwargs: (
            spawned.append(cwd) or (True, "command", _Proc())
        ),
    )
    result = notifier_wake_worker.spawn(
        "http://orcha",
        {
            "agent_id": agent["agent_id"],
            "alias": "builder",
            "headless_cwd": str(main),
            "context_task_id": task["id"],
            "pending_events": 1,
            "worktrees_disabled": False,
        },
        prompt="continue task",
        event="task_message",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers=live_workers,
        services=services,
    )
    assert result["sent"] is True
    worktree = pathlib.Path(spawned[-1])
    assert worktree != main
    assert (worktree / main_file.name).read_text() == "saved by main-checkout wake\n"

    worktree_file = worktree / main_file.name
    worktree_file.write_text("edited by later worktree wake\n")
    worker = live_workers[agent["agent_id"]]
    continued = await client.post(
        f"/api/agents/{agent['agent_id']}/runs",
        json={
            "wake_kind": "ephemeral",
            "wake_event": "task_message",
            "task_id": task["id"],
            "lane": "work",
            "worktree": worker["worktree"],
            "branch": worker["branch"],
            "base_cwd": str(main),
        },
    )
    assert continued.status_code == 201, continued.text
    history = (await client.get(f"/api/agents/{agent['agent_id']}/runs")).json()
    assert history["runs"][0]["worktree"] == str(worktree)

    spawned.clear()
    live_workers.clear()
    result = notifier_wake_worker.spawn(
        "http://orcha",
        {
            "agent_id": agent["agent_id"],
            "alias": "builder",
            "headless_cwd": str(main),
            "context_task_id": task["id"],
            "pending_events": 1,
            "worktrees_disabled": True,
        },
        prompt="continue task in main",
        event="task_message",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers=live_workers,
        services=services,
    )

    assert result["sent"] is True
    assert spawned == [str(main)]
    assert main_file.read_text() == "edited by later worktree wake\n"


def test_ordinary_task_wake_handoff_failure_stops_before_spawn(monkeypatch):
    posts = []
    spawned = []
    monkeypatch.setattr(
        notifier_wake_worker, "carry_previous_checkout", lambda *args, **kwargs: False
    )

    def post_json(url, body):
        posts.append((url, body))
        return {"claimed": True} if url.endswith("/wake-claim") else {}

    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _post_json=post_json,
        _build_persona=lambda *args, **kwargs: "persona",
        _provision_task_worktree=lambda *args: ("/project/task", "orcha/task"),
        _provision_worktree=lambda *args: ("/project/agent", "orcha/agent"),
        spawn_headless=lambda *args, **kwargs: spawned.append(args),
    )
    candidate = {
        "agent_id": "agent-1",
        "alias": "builder",
        "headless_cwd": "/project/main",
        "context_task_id": "task-1",
        "pending_events": 1,
        "worktrees_disabled": True,
    }

    result = notifier_wake_worker.spawn(
        "http://orcha",
        candidate,
        prompt="continue",
        event="task_message",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers={},
        services=services,
    )

    assert result["sent"] is False
    assert spawned == []
    assert any(
        url.endswith("/tasks/task-1/messages")
        and "no worker was started" in body["body"]
        for url, body in posts
    )
    assert any(
        url.endswith("/wake-ack")
        and body["kind"] == "worker_routing_handoff_failed"
        and body["release_lease"] is True
        for url, body in posts
    )


def test_resident_toggle_carries_preserved_worktree_state_to_main(
    monkeypatch, tmp_path
):
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_resident_worktree(str(main), "conv-1")
    (pathlib.Path(worktree) / "resident.txt").write_text("resident work\n")
    spawned = []
    live = {
        "conv-1": {
            "worktree": worktree,
            "branch": branch,
            "base_cwd": str(main),
            "worktrees_disabled": False,
            "serviced_seq": 0,
        }
    }
    candidate = {
        "agent_id": "agent-1",
        "agent_alias": "builder",
        "last_turn_seq": 1,
        "worktrees_disabled": True,
    }
    posts = []

    def post_json(url, body):
        posts.append((url, body))
        if url.endswith("/wake-claim"):
            return {"claimed": True}
        if url.endswith("/runs"):
            return {"run_id": "run-2"}
        return {}

    services = SimpleNamespace(
        WAKE_LEASE_TTL_SECS=120,
        RUNTIME_CLAUDE="claude",
        _RESIDENT_RESUME_FAILED=set(),
        _close_resident=lambda *args, **kwargs: None,
        _reap_dead_pid_resident_runs=lambda *args, **kwargs: None,
        _post_json=post_json,
        _get_json=lambda url: (
            {"turns": []} if url.endswith("conversation?limit=200") else None
        ),
        _build_persona=lambda *args, **kwargs: "persona",
        _format_history=None,
        _resident_log_path=lambda *args: None,
        _is_git_repo=lambda _cwd: True,
        _provision_resident_worktree=lambda *args: pytest.fail(
            "disabled routing must not provision"
        ),
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _mint_embodiment_token=lambda *args: "token",
        spawn_resident=lambda cwd, **kwargs: (
            spawned.append(cwd) or (True, "command", _Proc())
        ),
    )
    monkeypatch.setattr(
        notifier_resident_claude_start._feed_service,
        "feed",
        lambda *args, **kwargs: None,
    )

    notifier_resident_claude_start.start_or_feed_candidate(
        services,
        "http://orcha",
        "conv-1",
        candidate,
        live,
        set(),
        base_cwd=str(main),
        quiet=True,
        dry_run=False,
    )

    assert spawned == [str(main)]
    assert (main / "resident.txt").read_text() == "resident work\n"


@pytest.mark.asyncio
async def test_live_terminal_carries_state_main_to_worktree_to_main(
    tmp_path, monkeypatch
):
    main = _checkpoint_repo(tmp_path)
    history = {"runs": []}
    spawned = []

    def post_json(url, body):
        assert url.endswith("/api/agents/agent-1/runs")
        run = {"run_id": f"run-{len(history['runs']) + 1}", **body}
        history["runs"].insert(0, run)
        return {"run_id": run["run_id"]}

    monkeypatch.setattr(terminal_bridge_api.notifier, "_post_json", post_json)

    class Bridge:
        async def acquire_live_lease(self, *args, **kwargs):
            return {"claimed": True, "cold": True, "session_id": None}

        def release_live_lease(self, *args):
            pytest.fail("successful handoff must keep the live lease")

        def mint_live_token(self, *args):
            return "token"

        def spawn_pty(self, alias, cold, session_id, cwd, **kwargs):
            spawned.append(cwd)
            return 4321, 9

        def start_live_run(self, *args, **kwargs):
            return terminal_bridge_api.start_live_run(*args, **kwargs)

        def make_frame(self, kind, **kwargs):
            return {"kind": kind, **kwargs}

    class Notifier:
        _handoff_worktree_changes = staticmethod(notifier._handoff_worktree_changes)
        _get_json = staticmethod(lambda _url: history)
        _provision_live_worktree = staticmethod(notifier._provision_live_worktree)

    class Ws:
        async def send(self, frame):
            assert frame["kind"] == "status"
            assert frame["state"] == "connected"

        async def close(self, code=None):
            pytest.fail("successful handoff must not close the socket")

    first = await terminal_bridge_connection._start_session(
        Bridge(),
        Notifier(),
        Ws(),
        "http://orcha",
        str(main),
        "agent-1",
        "builder",
        None,
        "claude",
        True,
        False,
        None,
    )

    assert first is not None
    assert spawned == [str(main)]
    main_file = main / "terminal.txt"
    main_file.write_text("edited in main terminal\n")

    second = await terminal_bridge_connection._start_session(
        Bridge(),
        Notifier(),
        Ws(),
        "http://orcha",
        str(main),
        "agent-1",
        "builder",
        None,
        "claude",
        False,
        False,
        None,
        str(main),
    )

    assert second is not None
    worktree = pathlib.Path(second["worktree"])
    assert spawned[-1] == str(worktree)
    worktree_file = worktree / main_file.name
    assert worktree_file.read_text() == "edited in main terminal\n"
    worktree_file.write_text("edited in worktree terminal\n")

    third = await terminal_bridge_connection._start_session(
        Bridge(),
        Notifier(),
        Ws(),
        "http://orcha",
        str(main),
        "agent-1",
        "builder",
        None,
        "claude",
        True,
        False,
        None,
        str(worktree),
    )

    assert third is not None
    assert spawned[-1] == str(main)
    assert main_file.read_text() == "edited in worktree terminal\n"


@pytest.mark.asyncio
async def test_live_terminal_carries_committed_branch_after_clean_worktree_retired(
    tmp_path, monkeypatch
):
    main = _checkpoint_repo(tmp_path)
    history = {"runs": []}
    spawned = []

    def post_json(url, body):
        assert url.endswith("/api/agents/agent-1/runs")
        run = {"run_id": f"run-{len(history['runs']) + 1}", **body}
        history["runs"].insert(0, run)
        return {"run_id": run["run_id"]}

    monkeypatch.setattr(terminal_bridge_api.notifier, "_post_json", post_json)

    class Bridge:
        async def acquire_live_lease(self, *args, **kwargs):
            return {"claimed": True, "cold": True, "session_id": None}

        def release_live_lease(self, *args):
            pytest.fail("successful handoff must keep the live lease")

        def mint_live_token(self, *args):
            return "token"

        def spawn_pty(self, alias, cold, session_id, cwd, **kwargs):
            spawned.append(cwd)
            return 4321, 9

        def start_live_run(self, *args, **kwargs):
            return terminal_bridge_api.start_live_run(*args, **kwargs)

        def make_frame(self, kind, **kwargs):
            return {"kind": kind, **kwargs}

    class Notifier:
        _get_json = staticmethod(lambda _url: history)
        _handoff_worktree_changes = staticmethod(notifier._handoff_worktree_changes)
        _handoff_branch_changes = staticmethod(notifier._handoff_branch_changes)
        _provision_live_worktree = staticmethod(notifier._provision_live_worktree)

    class Ws:
        async def send(self, frame):
            assert frame["kind"] == "status"
            assert frame["state"] == "connected"

        async def close(self, code=None):
            pytest.fail("successful handoff must not close the socket")

    first = await terminal_bridge_connection._start_session(
        Bridge(),
        Notifier(),
        Ws(),
        "http://orcha",
        str(main),
        "agent-1",
        "builder",
        None,
        "claude",
        False,
        False,
        None,
    )

    assert first is not None
    worktree, branch = first["worktree"], first["branch"]
    assert history["runs"][0]["worktree"] == worktree
    assert history["runs"][0]["branch"] == branch

    terminal_file = pathlib.Path(worktree) / "committed-terminal.txt"
    terminal_file.write_text("committed terminal work\n")
    assert notifier._run_git(["add", terminal_file.name], cwd=worktree)[0] == 0
    assert notifier._run_git(
        ["commit", "-m", "save terminal work"], cwd=worktree
    )[0] == 0
    assert notifier._safe_teardown_worktree(str(main), worktree, branch) == "removed"
    assert not pathlib.Path(worktree).exists()

    session = await terminal_bridge_connection._start_session(
        Bridge(),
        Notifier(),
        Ws(),
        "http://orcha",
        str(main),
        "agent-1",
        "builder",
        None,
        "claude",
        True,
        False,
        None,
    )

    assert session is not None
    assert spawned == [worktree, str(main)]
    assert (main / terminal_file.name).read_text() == "committed terminal work\n"


def test_handoff_ownership_prevents_one_task_replacing_another(tmp_path):
    main = _checkpoint_repo(tmp_path)
    first_worktree, _ = notifier._provision_task_worktree(
        str(main), "builder", "task-1"
    )
    second_worktree, _ = notifier._provision_task_worktree(
        str(main), "builder", "task-2"
    )
    (pathlib.Path(first_worktree) / "first.txt").write_text("first task\n")
    (pathlib.Path(second_worktree) / "second.txt").write_text("second task\n")

    assert notifier._handoff_worktree_changes(
        first_worktree, str(main), owner_key="task:task-1"
    )
    assert (
        notifier._handoff_worktree_changes(
            second_worktree, str(main), owner_key="task:task-2"
        )
        is False
    )

    assert (main / "first.txt").read_text() == "first task\n"
    assert not (main / "second.txt").exists()
    assert (pathlib.Path(second_worktree) / "second.txt").read_text() == "second task\n"


def test_rejected_handoff_does_not_change_destination_index(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, _ = notifier._provision_task_worktree(str(main), "builder", "task-1")
    (pathlib.Path(worktree) / "task.txt").write_text("task work\n")
    (main / "human.txt").write_text("independent work\n")
    before_status = notifier._run_git(["status", "--porcelain=v1"], cwd=str(main))[1]
    before_index = notifier._run_git(["diff", "--cached", "--binary"], cwd=str(main))[1]

    assert (
        notifier._handoff_worktree_changes(
            worktree, str(main), owner_key="task:task-1"
        )
        is False
    )

    assert (
        notifier._run_git(["status", "--porcelain=v1"], cwd=str(main))[1]
        == before_status
    )
    assert (
        notifier._run_git(["diff", "--cached", "--binary"], cwd=str(main))[1]
        == before_index
    )
    assert (main / "human.txt").read_text() == "independent work\n"
    assert not (main / "task.txt").exists()


def test_taskless_prompt_wake_carries_main_state_back_to_worktree(tmp_path):
    main = _checkpoint_repo(tmp_path)
    (main / "prompt-work.txt").write_text("saved by direct prompt\n")
    spawned = []
    posts = []

    def post_json(url, body):
        posts.append((url, body))
        if url.endswith("/wake-claim"):
            return {"claimed": True}
        if url.endswith("/runs"):
            return {"run_id": "run-2"}
        return {}

    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _post_json=post_json,
        _get_json=lambda url: {
            "runs": [
                {
                    "run_id": "run-1",
                    "task_id": None,
                    "conversation_id": None,
                    "wake_kind": "ephemeral",
                    "lane": "work",
                    "worktree": None,
                    "base_cwd": str(main),
                }
            ]
        },
        _build_persona=lambda *args, **kwargs: "persona",
        _provision_task_worktree=lambda *args: pytest.fail(
            "taskless prompt must not provision a task worktree"
        ),
        _provision_worktree=notifier._provision_worktree,
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _mint_embodiment_token=lambda *args: "token",
        _revoke_or_defer=lambda *args: None,
        _teardown_worktree=notifier._teardown_worktree,
        spawn_headless=lambda cwd, *args, **kwargs: (
            spawned.append(cwd) or (True, "command", _Proc())
        ),
    )
    candidate = {
        "agent_id": "agent-1",
        "alias": "builder",
        "headless_cwd": str(main),
        "pending_events": 1,
        "latest_event": "prompt",
        "worktrees_disabled": False,
    }

    result = notifier_wake_worker.spawn(
        "http://orcha",
        candidate,
        prompt="continue direct work",
        event="prompt",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers={},
        services=services,
    )

    assert result["sent"] is True
    assert spawned and pathlib.Path(spawned[0]) != main
    assert (pathlib.Path(spawned[0]) / "prompt-work.txt").read_text() == (
        "saved by direct prompt\n"
    )
    assert not any("/tasks/None/" in url for url, _body in posts)


def test_taskless_prompt_success_preserves_ignored_files_for_later_switch_to_main(
    tmp_path,
):
    main = _checkpoint_repo(tmp_path)
    (main / ".gitignore").write_text(".env\n")
    assert notifier._run_git(["add", ".gitignore"], cwd=main)[0] == 0
    assert notifier._run_git(
        ["commit", "-m", "ignore local environment"], cwd=main
    )[0] == 0
    assert notifier._run_git(["push", "origin", "main"], cwd=main)[0] == 0
    history = {"runs": []}
    spawned = []
    live_workers = {}

    def post_json(url, body):
        if url.endswith("/wake-claim"):
            return {"claimed": True}
        if url.endswith("/runs"):
            run = {"run_id": f"run-{len(history['runs']) + 1}", **body}
            history["runs"].insert(0, run)
            return {"run_id": run["run_id"]}
        return {}

    next_pid = iter((4321, 4322))

    def spawn_headless(cwd, *args, **kwargs):
        spawned.append(cwd)
        return True, "command", SimpleNamespace(pid=next(next_pid), returncode=0)

    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        RUNTIME_CODEX="codex",
        pathlib=pathlib,
        _post_json=post_json,
        _get_json=lambda _url: history,
        _build_persona=lambda *args, **kwargs: "persona",
        _provision_task_worktree=lambda *args: pytest.fail(
            "taskless prompt must not provision a task worktree"
        ),
        _provision_worktree=notifier._provision_worktree,
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _handoff_branch_changes=notifier._handoff_branch_changes,
        _mint_embodiment_token=lambda *args: "token",
        _revoke_or_defer=lambda *args: None,
        _teardown_worktree=notifier._teardown_worktree,
        _safe_teardown_worktree=notifier._safe_teardown_worktree,
        _capture_diff=notifier._capture_diff,
        _normalize_runtime=lambda runtime: runtime or "claude",
        _finish_run=lambda *args, **kwargs: True,
        _reap_sandbox_artifacts=lambda *args: None,
        _retire_headless=lambda _api, workers, aid: workers.pop(aid, None),
        spawn_headless=spawn_headless,
    )
    candidate = {
        "agent_id": "agent-1",
        "alias": "builder",
        "headless_cwd": str(main),
        "pending_events": 1,
        "latest_event": "prompt",
        "worktrees_disabled": False,
    }

    first = notifier_wake_worker.spawn(
        "http://orcha",
        candidate,
        prompt="create direct-prompt work",
        event="prompt",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers=live_workers,
        services=services,
    )

    assert first["sent"] is True
    worker = live_workers["agent-1"]
    source = pathlib.Path(worker["worktree"])
    assert history["runs"][0]["task_id"] is None
    (source / ".env").write_text("PROMPT_SETTING=complete\n")

    notifier_reaper_completion.handle_exited(
        "http://orcha",
        "agent-1",
        worker,
        live_workers,
        {},
        {},
        0,
        True,
        services,
    )

    assert source.exists()
    assert (source / ".env").read_text() == "PROMPT_SETTING=complete\n"
    assert live_workers == {}

    second = notifier_wake_worker.spawn(
        "http://orcha",
        {**candidate, "worktrees_disabled": True},
        prompt="continue direct-prompt work",
        event="prompt",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers=live_workers,
        services=services,
    )

    assert second["sent"] is True
    assert spawned == [str(source), str(main)]
    assert (main / ".env").read_text() == "PROMPT_SETTING=complete\n"


def test_safe_teardown_preserves_worktree_when_cleanliness_check_fails(
    monkeypatch,
):
    removed = []
    monkeypatch.setattr(notifier, "_run_git", lambda *args, **kwargs: (1, ""))
    monkeypatch.setattr(
        notifier, "_teardown_worktree", lambda *args: removed.append(args)
    )

    assert (
        notifier._safe_teardown_worktree("/project", "/project/worker", "orcha/worker")
        == "preserved-dirty"
    )
    assert removed == []


def test_safe_teardown_excludes_only_orcha_runtime_overlay(tmp_path):
    main = _checkpoint_repo(tmp_path)
    (main / ".gitignore").write_text(
        ".claude/orcha.json\n"
        ".claude/orcha-tabs/\n"
        ".claude/commands/orcha-*.md\n"
        ".agents/skills/orcha-*/\n"
    )
    assert notifier._run_git(["add", ".gitignore"], cwd=main)[0] == 0
    assert notifier._run_git(["commit", "-m", "ignore runtime overlay"], cwd=main)[0] == 0
    assert notifier._run_git(["push", "origin", "main"], cwd=main)[0] == 0

    (main / ".claude" / "orcha-tabs").mkdir(parents=True)
    (main / ".claude" / "commands").mkdir(parents=True)
    (main / ".claude" / "orcha.json").write_text("{}")
    (main / ".claude" / "orcha-tabs" / "builder.json").write_text("{}")
    (main / ".claude" / "commands" / "orcha-status.md").write_text("status")
    skill = main / ".agents" / "skills" / "orcha-status" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("status")

    worktree, branch = notifier._provision_worktree(str(main), "builder")
    assert pathlib.Path(worktree, ".claude", "orcha.json").exists()
    assert pathlib.Path(worktree, ".agents", "skills", "orcha-status").exists()

    assert notifier._safe_teardown_worktree(str(main), worktree, branch) == "removed"
    assert not pathlib.Path(worktree).exists()


@pytest.mark.asyncio
async def test_direct_prompt_with_active_task_remains_taskless_and_carries_files(
    client, make_agent, make_task, tmp_path
):
    agent = await make_agent("builder")
    await make_task("separate active task", "done", assignee_alias="builder")
    main = _checkpoint_repo(tmp_path)
    (main / "direct-prompt.txt").write_text("taskless prompt work\n")

    started = await client.post(
        f"/api/agents/{agent['agent_id']}/runs",
        json={
            "wake_kind": "ephemeral",
            "wake_event": "prompt",
            "lane": "work",
            "base_cwd": str(main),
        },
    )
    assert started.status_code == 201, started.text
    assert started.json()["task_id"] is None
    finished = await client.post(
        f"/api/runs/{started.json()['run_id']}/finish",
        json={"status": "exited"},
    )
    assert finished.status_code == 200, finished.text
    history = (await client.get(f"/api/agents/{agent['agent_id']}/runs")).json()
    assert history["runs"][0]["task_id"] is None

    spawned = []

    def post_json(url, _body):
        if url.endswith("/wake-claim"):
            return {"claimed": True}
        if url.endswith("/runs"):
            return {"run_id": "run-2"}
        return {}

    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _get_json=lambda _url: history,
        _post_json=post_json,
        _build_persona=lambda *args, **kwargs: "persona",
        _provision_task_worktree=lambda *args: pytest.fail(
            "taskless prompt must not provision a task worktree"
        ),
        _provision_worktree=notifier._provision_worktree,
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _handoff_branch_changes=notifier._handoff_branch_changes,
        _mint_embodiment_token=lambda *args: "token",
        _revoke_or_defer=lambda *args: None,
        _teardown_worktree=notifier._teardown_worktree,
        spawn_headless=lambda cwd, *args, **kwargs: (
            spawned.append(cwd) or (True, "command", _Proc())
        ),
    )
    result = notifier_wake_worker.spawn(
        "http://orcha",
        {
            "agent_id": agent["agent_id"],
            "alias": "builder",
            "headless_cwd": str(main),
            "pending_events": 1,
            "latest_event": "prompt",
            "worktrees_disabled": False,
        },
        prompt="continue direct work",
        event="prompt",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers={},
        services=services,
    )
    assert result["sent"] is True
    assert len(spawned) == 1
    assert (pathlib.Path(spawned[0]) / "direct-prompt.txt").read_text() == (
        "taskless prompt work\n"
    )


def test_taskless_prompt_handoff_failure_stops_without_invalid_task_post(monkeypatch):
    posts = []
    spawned = []
    monkeypatch.setattr(
        notifier_wake_worker, "carry_previous_checkout", lambda *args, **kwargs: False
    )

    def post_json(url, body):
        posts.append((url, body))
        return {"claimed": True} if url.endswith("/wake-claim") else {}

    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _post_json=post_json,
        _build_persona=lambda *args, **kwargs: "persona",
        _provision_task_worktree=lambda *args: pytest.fail(
            "taskless prompt must not provision a task worktree"
        ),
        _provision_worktree=lambda *args: ("/project/agent", "orcha/agent"),
        spawn_headless=lambda *args, **kwargs: spawned.append(args),
    )
    candidate = {
        "agent_id": "agent-1",
        "alias": "builder",
        "headless_cwd": "/project/main",
        "pending_events": 1,
        "latest_event": "prompt",
        "worktrees_disabled": False,
    }

    result = notifier_wake_worker.spawn(
        "http://orcha",
        candidate,
        prompt="continue direct work",
        event="prompt",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers={},
        services=services,
    )

    assert result["sent"] is False
    assert spawned == []
    assert not any("/tasks/" in url for url, _body in posts)
    assert any(
        url.endswith("/wake-ack")
        and body["kind"] == "worker_routing_handoff_failed"
        and body["release_lease"] is True
        for url, body in posts
    )


# --- Stale checkout records must not block wakes forever -------------------------


def _deleted_branch_history(tmp_path):
    """Provision, then cleanly retire, a task worktree so only its run record survives."""
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    assert worktree and branch
    assert notifier._safe_teardown_worktree(str(main), worktree, branch) == "removed"
    assert not pathlib.Path(worktree).exists()
    assert (
        notifier._run_git(
            ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=main
        )[0]
        != 0
    ), "a commit-less worker branch is deleted with its worktree"
    history = {
        "runs": [
            {
                "run_id": "run-1",
                "task_id": "task-1",
                "lane": "work",
                "worktree": worktree,
                "branch": branch,
                "base_cwd": str(main),
            }
        ]
    }
    return main, history


@pytest.mark.parametrize("disabled", [True, False])
def test_wake_carries_nothing_when_recorded_branch_was_already_deleted(
    tmp_path, disabled
):
    """Regression: worktree gone + branch deleted + branch name still on the run row.

    The recovery path used to diff a ref that no longer existed, fail closed, and
    pause every later wake for that task with no operator recourse.
    """
    main, history = _deleted_branch_history(tmp_path)
    services = SimpleNamespace(
        _get_json=lambda _url: history,
        _run_git=notifier._run_git,
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _handoff_branch_changes=notifier._handoff_branch_changes,
    )
    destination = (
        str(main)
        if disabled
        else notifier._provision_task_worktree(str(main), "builder", "task-1")[0]
    )

    assert carry_previous_checkout(
        "http://orcha", "agent-1", destination, services, task_id="task-1", lane="work"
    ) is True


def test_wake_still_recovers_from_a_retained_branch_that_exists(tmp_path):
    main = _checkpoint_repo(tmp_path)
    worktree, branch = notifier._provision_task_worktree(str(main), "builder", "task-1")
    (pathlib.Path(worktree) / "kept.txt").write_text("committed work\n")
    assert notifier._run_git(["add", "kept.txt"], cwd=worktree)[0] == 0
    assert notifier._run_git(["commit", "-m", "keep"], cwd=worktree)[0] == 0
    assert notifier._safe_teardown_worktree(str(main), worktree, branch) == "removed"
    history = {
        "runs": [
            {
                "task_id": "task-1",
                "lane": "work",
                "worktree": worktree,
                "branch": branch,
                "base_cwd": str(main),
            }
        ]
    }
    services = SimpleNamespace(
        _get_json=lambda _url: history,
        _run_git=notifier._run_git,
        _handoff_worktree_changes=notifier._handoff_worktree_changes,
        _handoff_branch_changes=notifier._handoff_branch_changes,
    )

    assert carry_previous_checkout(
        "http://orcha", "agent-1", str(main), services, task_id="task-1", lane="work"
    ) is True
    assert (main / "kept.txt").read_text() == "committed work\n"


def test_branch_recovery_still_runs_when_existence_is_unknowable():
    """Services without git access keep the previous (recovery-attempt) behaviour."""
    calls = []
    history = {
        "runs": [
            {
                "task_id": "task-1",
                "lane": "work",
                "worktree": "/gone/worktree",
                "branch": "orcha/task-builder-task-1",
                "base_cwd": "/project/main",
            }
        ]
    }
    services = SimpleNamespace(
        _get_json=lambda _url: history,
        _handoff_branch_changes=lambda *args, **kwargs: calls.append(args) or True,
    )

    assert carry_previous_checkout(
        "http://orcha", "agent-1", "/project/main", services, task_id="task-1"
    ) is True
    assert calls == [("/project/main", "orcha/task-builder-task-1", "/project/main")]


def test_handoff_failure_notice_is_not_repeated_every_tick(monkeypatch):
    notifier_wake_worker.reset_notice_state()
    posts = []
    monkeypatch.setattr(
        notifier_wake_worker, "carry_previous_checkout", lambda *args, **kwargs: False
    )

    def post_json(url, body):
        posts.append((url, body))
        return {"claimed": True} if url.endswith("/wake-claim") else {}

    services = SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _post_json=post_json,
        _build_persona=lambda *args, **kwargs: "persona",
        _provision_task_worktree=lambda *args: ("/project/task", "orcha/task"),
        _provision_worktree=lambda *args: ("/project/agent", "orcha/agent"),
        spawn_headless=lambda *args, **kwargs: pytest.fail("must not spawn"),
    )
    candidate = {
        "agent_id": "agent-1",
        "alias": "builder",
        "headless_cwd": "/project/main",
        "context_task_id": "task-1",
        "pending_events": 1,
        "worktrees_disabled": True,
    }
    results = [
        notifier_wake_worker.spawn(
            "http://orcha",
            candidate,
            prompt="continue",
            event="task_message",
            dry_run=False,
            quiet=True,
            lease_ttl=120,
            live_workers={},
            services=services,
        )
        for _ in range(3)
    ]

    assert all(result["handoff_failed"] is True for result in results)
    notices = [body for url, body in posts if url.endswith("/tasks/task-1/messages")]
    assert len(notices) == 1
    assert "retries every" in notices[0]["body"]
    acks = [body for url, body in posts if url.endswith("/wake-ack")]
    assert len(acks) == 3


def test_handoff_failure_holds_candidate_down(monkeypatch):
    from orcha_cli import notifier_wake_candidate

    monkeypatch.setattr(
        notifier_wake_worker,
        "spawn",
        lambda *args, **kwargs: {
            "sent": False,
            "command": "checkout handoff failed",
            "resume_rendered": False,
            "lane": "work",
            "handoff_failed": True,
        },
    )
    monkeypatch.setattr(
        notifier_wake_candidate, "_grade_ephemeral", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        notifier_wake_candidate, "_ack_delivery", lambda *args, **kwargs: None
    )
    services = SimpleNamespace(
        build_wake_prompt=lambda candidate: "prompt",
        select_transport=lambda candidate: "ephemeral",
        derive_wake_event=lambda candidate: "task_message",
    )
    context = {"agent_hold_until": {}, "hold_now": 1000.0}
    candidate = {
        "agent_id": "agent-1",
        "alias": "builder",
        "should_wake": True,
        "reason": "task_message",
    }

    record = notifier_wake_candidate.process_candidate(
        "http://orcha",
        candidate,
        context=context,
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers={},
        services=services,
    )

    assert record["sent"] is False
    assert context["agent_hold_until"]["agent-1"] == pytest.approx(
        1000.0 + notifier_wake_worker.HANDOFF_FAILURE_HOLD_SECS
    )
    context["hold_now"] = 1001.0
    assert notifier_wake_candidate._held(candidate, context, True) is True
    context["hold_now"] = 1000.0 + notifier_wake_worker.HANDOFF_FAILURE_HOLD_SECS
    assert notifier_wake_candidate._held(candidate, context, True) is False


# --- Guardrail: worktrees off while several tasks share the main checkout ------


def _shared_checkout_services(posts, spawned):
    def post_json(url, body):
        posts.append((url, body))
        if url.endswith("/wake-claim"):
            return {"claimed": True}
        if url.endswith("/runs"):
            return {"run_id": "run-x"}
        return {}

    return SimpleNamespace(
        HARD_CAP_MIN_SECS=1200,
        WAKE_LEASE_TTL_SECS=120,
        pathlib=pathlib,
        _post_json=post_json,
        _build_persona=lambda *args, **kwargs: "persona",
        _provision_task_worktree=lambda *args: pytest.fail("worktrees are disabled"),
        _provision_worktree=lambda *args: pytest.fail("worktrees are disabled"),
        _mint_embodiment_token=lambda *args: "token",
        _revoke_or_defer=lambda *args: None,
        _teardown_worktree=lambda *args: None,
        spawn_headless=lambda cwd, *args, **kwargs: (
            spawned.append(cwd) or (True, "command", _Proc())
        ),
    )


def _sibling(task_id, *, alias="other", worktree=None, base_cwd="/project/main"):
    return {
        "wake_task_id": task_id,
        "worktree": worktree,
        "base_cwd": base_cwd,
        "respawn_ctx": {"alias": alias},
    }


def test_shared_checkout_siblings_only_count_other_tasks_in_main():
    candidate = {
        "agent_id": "agent-1",
        "headless_cwd": "/project/main",
        "worktrees_disabled": True,
    }
    live_workers = {
        "agent-1": _sibling("task-9"),  # ourselves
        "agent-2": _sibling("task-2"),  # different task, shared main
        "agent-3": _sibling("task-1"),  # same task: allowed, no advisory
        "agent-4": _sibling("task-4", worktree="/project/.orcha-worktrees/x"),
        "agent-5": _sibling("task-5", base_cwd="/elsewhere"),
        "agent-6": _sibling(None),
    }

    siblings = notifier_wake_worker.shared_checkout_siblings(
        live_workers, candidate, "task-1"
    )

    assert [s["agent_id"] for s in siblings] == ["agent-2"]
    assert siblings[0]["alias"] == "other"
    candidate["worktrees_disabled"] = False
    assert notifier_wake_worker.shared_checkout_siblings(
        live_workers, candidate, "task-1"
    ) == []


def test_shared_checkout_advisory_posted_once_and_wake_proceeds(monkeypatch):
    notifier_wake_worker.reset_notice_state()
    monkeypatch.setattr(
        notifier_wake_worker, "carry_previous_checkout", lambda *args, **kwargs: True
    )
    posts, spawned = [], []
    services = _shared_checkout_services(posts, spawned)
    live_workers = {"agent-2": _sibling("task-2", alias="reviewer")}
    candidate = {
        "agent_id": "agent-1",
        "alias": "builder",
        "headless_cwd": "/project/main",
        "context_task_id": "task-1",
        "pending_events": 1,
        "worktrees_disabled": True,
    }

    for _ in range(2):
        result = notifier_wake_worker.spawn(
            "http://orcha",
            candidate,
            prompt="continue",
            event="task_message",
            dry_run=False,
            quiet=True,
            lease_ttl=120,
            live_workers=live_workers,
            services=services,
        )
        assert result["sent"] is True

    assert spawned == ["/project/main", "/project/main"]
    advisories = [
        body
        for url, body in posts
        if url.endswith("/tasks/task-1/messages") and "worktrees are disabled" in body["body"]
    ]
    assert len(advisories) == 1
    assert advisories[0]["author_agent_id"] == "agent-1"
    assert "reviewer (task task-2)" in advisories[0]["body"]
    assert "Enable worktrees" in advisories[0]["body"]
    assert "file lock" in advisories[0]["body"]


def test_no_advisory_when_alone_or_when_worktrees_are_on(monkeypatch):
    notifier_wake_worker.reset_notice_state()
    monkeypatch.setattr(
        notifier_wake_worker, "carry_previous_checkout", lambda *args, **kwargs: True
    )
    posts, spawned = [], []
    services = _shared_checkout_services(posts, spawned)
    candidate = {
        "agent_id": "agent-1",
        "alias": "builder",
        "headless_cwd": "/project/main",
        "context_task_id": "task-1",
        "pending_events": 1,
        "worktrees_disabled": True,
    }

    notifier_wake_worker.spawn(
        "http://orcha",
        candidate,
        prompt="continue",
        event="task_message",
        dry_run=False,
        quiet=True,
        lease_ttl=120,
        live_workers={"agent-3": _sibling("task-1", alias="pair")},
        services=services,
    )
    assert not any(url.endswith("/tasks/task-1/messages") for url, _ in posts)
