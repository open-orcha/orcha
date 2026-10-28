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
    submit_result,
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


def test_readiness_skips_unselected_branches_and_waits_on_loop_decisions():
    from portal_backend.workflow_scheduling import stored_status, waiting_on

    def task(tid, status="completed", **extra):
        return {"id": tid, "status": status, "work_revision": 1,
                "preparation_state": "prepared", **extra}

    acc = {
        tid: {"work_revision": 1, "evidence_valid": True, "actor_kind": "human"}
        for tid in ("a", "b")
    }
    deps = {"join": ["a", "c"], "c": ["b"], "after": ["b"]}
    tasks = {
        "a": task("a"),
        "b": task("b", awaiting_loop_decision="limit_reached"),
        "c": task("c", "not_ready", route_state="not_selected"),
        "join": task("join", "pending"),
        "after": task("after", "pending"),
    }
    # The unselected branch is skipped because another prerequisite was selected.
    assert waiting_on(tasks["join"], deps, tasks, acc) == []
    assert stored_status(tasks["join"], deps, tasks, acc) == "ready"
    # An accepted step whose loop waits for the owner holds its dependents.
    assert waiting_on(tasks["after"], deps, tasks, acc) == ["b"]
    assert stored_status(tasks["after"], deps, tasks, acc) == "pending"


def finish(fixture, w, tid, outcome=None, findings=()):
    """Worker submits; optionally reports an outcome; the owner accepts."""
    from portal_backend import workflow_service as ws

    execute = fixture[-1]
    e, ref = submit_result(fixture, w, tid)
    if outcome:
        execute(
            "report_outcome",
            {"outcome": outcome, "findings": [{"text": f} for f in findings]},
            w["id"],
            tid,
        )
    execute("accept", {"evidence": ref}, w["id"], tid)
    with db_cursor() as (_, cur):
        ws.WorkflowService(cur, fixture[4]).release_confirmed(
            e["id"], e["generation"], "process exit"
        )
    with db_cursor(readonly=True) as (_, cur):
        return ws.WorkflowService(cur, fixture[4]).detail(w["id"], fixture[1])


def test_changes_requested_starts_round_two_on_the_same_steps(setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    write, review, publish = (ids[k] for k in ("Write the launch post", "Review the post", "Publish"))
    before = {t["id"]: t["work_revision"] for t in w["tasks"]}
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review, "changes requested", ["Too long"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[write]["work_revision"] == before[write] + 1
    assert byid[review]["work_revision"] == before[review] + 1
    assert byid[write]["can_start"] and not byid[publish]["can_start"]
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT round_number,trigger_kind,end_reason,inputs FROM workflow_group_rounds r JOIN workflow_repeat_groups g ON g.id=r.group_id WHERE g.workflow_id=%s ORDER BY round_number",
            (w["id"],),
        )
        rounds = cur.fetchall()
    assert [(r["round_number"], r["trigger_kind"], r["end_reason"]) for r in rounds] == [
        (1, "initial", "return"), (2, "return", None)
    ]
    inputs = rounds[1]["inputs"]
    inputs = json.loads(inputs) if isinstance(inputs, str) else inputs
    assert [f["text"] for f in inputs["findings"]] == ["Too long"]
    # Round 2 approves: the loop ends and Publish can start.
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review, "Approved")
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[publish]["can_start"]


def test_round_limit_asks_the_owner_instead_of_starting_another_round(setup_workflow, flexible):
    execute = setup_workflow[-1]
    draft = loop_draft(setup_workflow[2])
    draft["repeat_groups"][0]["max_rounds"] = 1
    w = prepare_and_start(setup_workflow, execute("create", draft))
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    write, review = ids["Write the launch post"], ids["Review the post"]
    before = {t["id"]: t["work_revision"] for t in w["tasks"]}
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review, "Changes requested", ["Still too long"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[review]["status"] == "completed"
    assert byid[write]["work_revision"] == before[write]
    assert not byid[ids["Publish"]]["can_start"]
    assert "loop_decision_pending" in {b["code"] for b in w["completion"]["blockers"]}
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT state FROM workflow_repeat_groups WHERE workflow_id=%s", (w["id"],))
        assert cur.fetchone()["state"] == "limit_reached"
        cur.execute("SELECT awaiting_loop_decision FROM tasks WHERE id=%s", (review,))
        assert cur.fetchone()["awaiting_loop_decision"] == "limit_reached"


def test_turn_allowance_counts_worker_turns_and_blocks_when_used(setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = prepare_and_start(
        setup_workflow, execute("create", loop_draft(setup_workflow[2], turn_allowance=1))
    )
    write = next(t["id"] for t in w["tasks"] if t["title"] == "Write the launch post")
    w = finish(setup_workflow, w, write)
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT turns_used FROM workflows WHERE id=%s", (w["id"],))
        assert cur.fetchone()["turns_used"] == 1
    review = next(t for t in w["tasks"] if t["title"] == "Review the post")
    assert "allowance_exhausted" in {b["code"] for b in review["blockers"]}
