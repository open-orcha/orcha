"""Project-level worktree routing: persistence, API exposure, and final cwd policy."""

from types import SimpleNamespace

import pytest

from orcha_cli import notifier_wake_worker


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
    assert db.execute(
        "SELECT worktrees_disabled FROM containers WHERE id=%s", (container["id"],)
    )[0]["worktrees_disabled"] is True

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
    assert db.execute(
        "SELECT worktrees_disabled FROM containers WHERE id=%s", (container["id"],)
    )[0]["worktrees_disabled"] is False


@pytest.mark.asyncio
async def test_setting_write_is_human_gated(client, container, make_agent, db):
    ai = await make_agent("builder")
    response = await _set(client, container["id"], ai["agent_id"], True)
    assert response.status_code == 403, response.text
    assert db.execute(
        "SELECT worktrees_disabled FROM containers WHERE id=%s", (container["id"],)
    )[0]["worktrees_disabled"] is False


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
        _provision_task_worktree=lambda *args: calls.append(("task", args))
        or ("/project/.orcha-worktrees/task", "orcha/task"),
        _provision_worktree=lambda *args: calls.append(("agent", args))
        or ("/project/.orcha-worktrees/agent", "orcha/agent"),
    )
    candidate = {
        "headless_cwd": "/project/main",
        "alias": "builder",
        "context_task_id": "task-1",
        "pending_events": 1,
        "worktrees_disabled": False,
    }

    assert notifier_wake_worker._worktree_for(
        candidate, [], {}, False, services
    ) == ("/project/.orcha-worktrees/task", "orcha/task", True)
    assert [kind for kind, _args in calls] == ["task"]
