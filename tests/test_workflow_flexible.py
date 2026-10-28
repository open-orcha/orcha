"""Flexible workflows (semantics version 2): outcomes, next-step rules and repeat groups.

Uses the real isolated database and the same ContractHooks as test_workflows.
"""

import json

import pytest
from fastapi import HTTPException

from portal_backend import workflow_routing
from portal_backend.database import db_cursor
from portal_backend.workflow_graph import validate_flow

from test_workflows import (  # noqa: F401 (fixture re-export)
    create,
    prepare_and_start,
    setup_workflow,
)


@pytest.fixture
def flexible(monkeypatch):
    monkeypatch.setenv(workflow_routing.FLAG, "1")


def loop_draft(worker, **extra):
    """Write -> Review -> Publish, with Write and Review in one repeat group."""
    return {
        "title": "Launch post",
        "goal": "A reviewed launch post",
        "tasks": [
            {
                "client_key": "write",
                "title": "Write the launch post",
                "definition_of_done": "A draft post",
                "assignee_id": worker,
            },
            {
                "client_key": "review",
                "title": "Review the post",
                "definition_of_done": "A verdict with findings",
                "assignee_id": worker,
                "depends_on": ["write"],
                "outcomes": [
                    {"name": "Approved", "kind": "success"},
                    {"name": "Changes requested", "kind": "changes"},
                ],
                "routes": [
                    {"outcome": "Approved", "destination": "exit_group"},
                    {
                        "outcome": "Changes requested",
                        "destination": "return",
                        "destination_task": "write",
                    },
                ],
            },
            {
                "client_key": "publish",
                "title": "Publish",
                "definition_of_done": "Published",
                "assignee_id": worker,
                "depends_on": ["review"],
            },
        ],
        "repeat_groups": [
            {
                "name": "Draft and review",
                "member_tasks": ["write", "review"],
                "review_task": "review",
                "exit_outcome": "Approved",
                "max_rounds": 3,
            }
        ],
        **extra,
    }


def code(fn, *args, **kwargs):
    with pytest.raises(HTTPException) as err:
        fn(*args, **kwargs)
    return err.value.detail["code"]


def test_switch_off_refuses_flexible_drafts_and_keeps_version_one(setup_workflow, monkeypatch):
    monkeypatch.delenv(workflow_routing.FLAG, raising=False)
    execute = setup_workflow[-1]
    worker = setup_workflow[2]
    assert code(execute, "create", loop_draft(worker)) == "flexible_disabled"
    w = create(setup_workflow)
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT semantics_version FROM workflows WHERE id=%s", (w["id"],))
        assert cur.fetchone()["semantics_version"] == 1


def test_create_stores_the_flow_and_start_freezes_a_definition(setup_workflow, flexible):
    execute = setup_workflow[-1]
    worker = setup_workflow[2]
    w = execute("create", loop_draft(worker, turn_allowance=12))
    byname = {t["title"]: t["id"] for t in w["tasks"]}
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT semantics_version,turn_allowance,definition_version FROM workflows WHERE id=%s",
            (w["id"],),
        )
        assert dict(cur.fetchone()) == {
            "semantics_version": 2,
            "turn_allowance": 12,
            "definition_version": 0,
        }
    w = prepare_and_start(setup_workflow, w)
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT version,reason,snapshot FROM workflow_definition_versions WHERE workflow_id=%s",
            (w["id"],),
        )
        rows = cur.fetchall()
        assert [(r["version"], r["reason"]) for r in rows] == [(1, "start")]
        snap = rows[0]["snapshot"]
        snap = json.loads(snap) if isinstance(snap, str) else snap
        assert snap["repeat_groups"][0]["member_tasks"] == [
            byname["Write the launch post"],
            byname["Review the post"],
        ]
        cur.execute(
            "SELECT g.current_round,r.round_number,r.trigger_kind FROM workflow_repeat_groups g JOIN workflow_group_rounds r ON r.group_id=g.id WHERE g.workflow_id=%s",
            (w["id"],),
        )
        assert [tuple(r.values()) if hasattr(r, "values") else tuple(r) for r in cur.fetchall()] == [
            (1, 1, "initial")
        ]
        cur.execute(
            "SELECT COUNT(*) AS n FROM workflow_step_instances i JOIN tasks t ON t.id=i.task_id WHERE t.workflow_id=%s",
            (w["id"],),
        )
        assert cur.fetchone()["n"] == 2


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (lambda d: d["tasks"][1]["routes"].pop(), "outcome_without_route"),
        (
            lambda d: d["tasks"][1]["routes"].append(
                {"outcome": "Approved", "destination": "next"}
            ),
            "route_conflict",
        ),
        (
            lambda d: d["tasks"][1]["routes"][1].update(destination_task="publish"),
            "return_outside_group",
        ),
        (
            lambda d: d["repeat_groups"][0].update(exit_outcome="Shipped"),
            "group_exit_unknown",
        ),
        (
            lambda d: d["tasks"][0].update(
                outcomes=[{"name": "Done"}],
                routes=[{"outcome": "Done", "destination": "step", "destination_task": "publish"}],
            ),
            "branch_not_dependent",
        ),
        (
            lambda d: d["tasks"][1]["routes"][1].update(destination="ask_owner", destination_task=None),
            "group_without_return",
        ),
    ],
)
def test_preview_and_create_refuse_the_same_invalid_flow(
    setup_workflow, flexible, mutate, expected
):
    cid, _, worker, _, hooks, execute = setup_workflow
    draft = loop_draft(worker)
    mutate(draft)
    from portal_backend import workflow_service as ws

    with db_cursor(readonly=True) as (_, cur):
        assert code(ws.WorkflowService(cur, hooks).preview_draft, cid, draft) == expected
    assert code(execute, "create", draft) == expected
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT COUNT(*) AS n FROM workflows WHERE container_id=%s", (cid,))
        assert cur.fetchone()["n"] == 0


def test_validate_flow_is_pure_and_keeps_prerequisites_acyclic():
    deps = {"a": [], "b": ["a"], "c": ["b"]}
    outcomes = {"c": [{"name": "Go"}, {"name": "Again"}]}
    routes = {
        "c": [
            {"outcome": "Go", "destination": "exit_group", "destination_task": None},
            {"outcome": "Again", "destination": "return", "destination_task": "a"},
        ]
    }
    groups = [
        {"name": "Loop", "member_tasks": ["a", "b", "c"], "review_task": "c",
         "exit_outcome": "Go", "max_rounds": 5}
    ]
    assert validate_flow(set(deps), deps, outcomes, routes, groups)["group_of"] == {
        "a": "Loop", "b": "Loop", "c": "Loop"
    }
    # A member that does not lead to the review step cannot repeat with it.
    stray = [{**groups[0], "member_tasks": ["a", "c"], "review_task": "a"}]
    with pytest.raises(HTTPException):
        validate_flow(set(deps), deps, outcomes, routes, stray)
