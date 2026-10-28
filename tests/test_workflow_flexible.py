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
    # The owner raises the allowance and the review can take its turn.
    w = execute("patch", {"turn_allowance": 5}, w["id"])
    review = next(t for t in w["tasks"] if t["title"] == "Review the post")
    assert "allowance_exhausted" not in {b["code"] for b in review["blockers"]}


def test_owner_raises_the_limit_and_the_loop_continues(setup_workflow, flexible):
    execute = setup_workflow[-1]
    draft = loop_draft(setup_workflow[2])
    draft["repeat_groups"][0]["max_rounds"] = 1
    w = prepare_and_start(setup_workflow, execute("create", draft))
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    write, review = ids["Write the launch post"], ids["Review the post"]
    before = {t["id"]: t["work_revision"] for t in w["tasks"]}
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review, "Changes requested", ["Still too long"])
    assert code(execute, "loop_decision", {"kind": "pick_outcome", "task_id": review}, w["id"]) == "decision_not_available"
    w = execute(
        "loop_decision",
        {"kind": "raise_limit", "task_id": review, "new_max_rounds": 2, "note": "One more try"},
        w["id"],
    )
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[write]["work_revision"] == before[write] + 1 and byid[write]["can_start"]
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT subject_kind,chosen,original_outcome FROM workflow_owner_decisions WHERE workflow_id=%s",
            (w["id"],),
        )
        assert [tuple(dict(r).values()) for r in cur.fetchall()] == [
            ("limit_reached", "raise_limit", "Changes requested")
        ]
        cur.execute(
            "SELECT trigger_kind,inputs FROM workflow_group_rounds r JOIN workflow_repeat_groups g ON g.id=r.group_id WHERE g.workflow_id=%s AND r.round_number=2",
            (w["id"],),
        )
        row = cur.fetchone()
        inputs = json.loads(row["inputs"]) if isinstance(row["inputs"], str) else row["inputs"]
        assert row["trigger_kind"] == "owner_raise_limit" and inputs["owner_note"] == "One more try"


def test_detail_shows_the_flow_rounds_and_allowance(setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    assert w["semantics_version"] == 2 and w["definition_version"] == 1
    assert (w["turn_allowance"], w["turns_used"]) == (40, 0)
    assert w["capability"]["flexible_workflows"] is True
    assert w["capability"]["semantics_versions_supported"] == [1, 2]
    [group] = w["repeat_groups"]
    assert (group["current_round"], group["state"], group["max_rounds"]) == (1, "open", 3)
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    write, review = ids["Write the launch post"], ids["Review the post"]
    byid = {t["id"]: t for t in w["tasks"]}
    assert [o["name"] for o in byid[review]["outcomes"]] == ["Approved", "Changes requested"]
    assert {r["destination"] for r in byid[review]["routes"]} == {"exit_group", "return"}
    assert byid[write]["repeat_group_id"] == group["id"] and byid[write]["round"] == 1
    assert byid[ids["Publish"]]["repeat_group_id"] is None
    assert byid[ids["Publish"]]["round"] is None
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review, "Changes requested", ["Too long"])
    assert w["repeat_groups"][0]["current_round"] == 2
    assert {t["id"]: t["round"] for t in w["tasks"]}[write] == 2
    assert w["turns_used"] == 2


def test_version_one_detail_has_no_flow(setup_workflow, monkeypatch):
    monkeypatch.delenv(workflow_routing.FLAG, raising=False)
    execute = setup_workflow[-1]
    draft = loop_draft(setup_workflow[2])
    draft.pop("repeat_groups")
    for t in draft["tasks"]:
        t.pop("outcomes", None), t.pop("routes", None)
    w = execute("create", draft)
    assert w["semantics_version"] == 1 and w["repeat_groups"] == []
    assert w["capability"]["flexible_workflows"] is False
    assert w["capability"]["semantics_versions_supported"] == [1]
    assert all(t["outcomes"] == [] and t["round"] is None for t in w["tasks"])


def test_owner_accepts_anyway_at_the_limit_and_dependents_proceed(setup_workflow, flexible):
    execute = setup_workflow[-1]
    draft = loop_draft(setup_workflow[2])
    draft["repeat_groups"][0]["max_rounds"] = 1
    w = prepare_and_start(setup_workflow, execute("create", draft))
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    write, review = ids["Write the launch post"], ids["Review the post"]
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review, "Changes requested", ["Still too long"])
    w = execute("loop_decision", {"kind": "accept_override", "task_id": review}, w["id"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[ids["Publish"]]["can_start"]
    assert byid[review]["awaiting_loop_decision"] is None
    assert w["repeat_groups"][0]["state"] == "exited"
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT chosen,original_outcome FROM workflow_owner_decisions WHERE workflow_id=%s",
            (w["id"],),
        )
        assert tuple(dict(cur.fetchone()).values()) == ("accept_override", "Changes requested")


def test_owner_stops_the_loop_and_later_steps_are_not_needed(setup_workflow, flexible):
    execute = setup_workflow[-1]
    draft = loop_draft(setup_workflow[2])
    draft["repeat_groups"][0]["max_rounds"] = 1
    w = prepare_and_start(setup_workflow, execute("create", draft))
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    write, review = ids["Write the launch post"], ids["Review the post"]
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review, "Changes requested", ["Still too long"])
    w = execute("loop_decision", {"kind": "stop", "task_id": review}, w["id"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[ids["Publish"]]["route_state"] == "not_selected"
    assert not byid[ids["Publish"]]["can_start"]
    assert w["repeat_groups"][0]["state"] == "stopped"
    assert "loop_decision_pending" not in {b["code"] for b in w["completion"]["blockers"]}


def test_round_two_prompt_carries_the_findings_and_the_rule(setup_workflow, flexible):
    from orcha_cli.notifier_protocol import _render_workflow
    from portal_backend.workflow_prompt import workflow_for_prompt

    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    write, review = ids["Write the launch post"], ids["Review the post"]

    def prompt(tid):
        with db_cursor(readonly=True) as (_, cur):
            cur.execute("SELECT * FROM tasks WHERE id=%s", (tid,))
            context = workflow_for_prompt(cur, dict(cur.fetchone()))
        return context, _render_workflow(context)

    context, text = prompt(review)
    assert [o["name"] for o in context["round_context"]["outcomes"]] == ["Approved", "Changes requested"]
    assert "report exactly one outcome: 'Approved', 'Changes requested'" in text
    assert f"/api/tasks/{review}/outcome" in text
    assert "round 1 of at most 3" in text and "Address this feedback" not in text
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review, "Changes requested", ["Too long", "No call to action"])
    context, text = prompt(write)
    group = context["round_context"]["group"]
    assert (group["round"], group["is_review_step"]) == (2, False)
    assert [f["text"] for f in group["this_round"]["findings"]] == ["Too long", "No call to action"]
    assert "round 2 of at most 3" in text
    assert "outcome was 'Changes requested'" in text and "   - No call to action" in text
    assert "Round 1 ended (return)" in text
    assert "report exactly one outcome" not in text  # Write declares no outcomes


def test_version_one_prompt_has_no_round_context(setup_workflow, monkeypatch):
    from portal_backend.workflow_prompt import workflow_for_prompt

    monkeypatch.delenv(workflow_routing.FLAG, raising=False)
    execute = setup_workflow[-1]
    draft = loop_draft(setup_workflow[2])
    draft.pop("repeat_groups")
    for t in draft["tasks"]:
        t.pop("outcomes", None), t.pop("routes", None)
    w = execute("create", draft)
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (w["tasks"][0]["id"],))
        assert "round_context" not in workflow_for_prompt(cur, dict(cur.fetchone()))


@pytest.mark.asyncio
async def test_round_context_endpoint_matches_the_prompt(client, setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    write, review = ids["Write the launch post"], ids["Review the post"]
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review, "Changes requested", ["Too long"])
    headers = {"X-Orcha-Local-Actor": setup_workflow[1].id}
    body = (await client.get(f"/api/tasks/{write}/round-context", headers=headers)).json()
    assert body["task_id"] == write and body["outcomes"] == []
    assert body["group"]["round"] == 2
    assert [f["text"] for f in body["group"]["this_round"]["findings"]] == ["Too long"]
    body = (await client.get(f"/api/tasks/{ids['Publish']}/round-context", headers=headers)).json()
    assert body == {"task_id": ids["Publish"], "outcomes": [], "group": None}


def flow_body(ids, *, max_rounds=3, publish_outcomes=(), exit_outcome="Approved", write_outcomes=()):
    """The loop draft's flow in task-id space, for PUT /api/workflows/{wid}/flow."""
    write, review, publish = ids
    steps = [
        {
            "task_id": review,
            "outcomes": [
                {"name": "Approved", "kind": "success"},
                {"name": "Changes requested", "kind": "changes"},
            ],
            "routes": [
                {"outcome": "Approved", "destination": "exit_group", "destination_task": None},
                {"outcome": "Changes requested", "destination": "return", "destination_task": write},
            ],
        }
    ]
    if write_outcomes:
        steps.append(
            {
                "task_id": write,
                "outcomes": [{"name": n, "kind": "custom"} for n in write_outcomes],
                "routes": [{"outcome": n, "destination": "next", "destination_task": None} for n in write_outcomes],
            }
        )
    if publish_outcomes:
        steps.append(
            {
                "task_id": publish,
                "outcomes": [{"name": n, "kind": "custom"} for n in publish_outcomes],
                "routes": [{"outcome": n, "destination": "next", "destination_task": None} for n in publish_outcomes],
            }
        )
    return {
        "steps": steps,
        "repeat_groups": [
            {
                "name": "Draft and review",
                "member_tasks": [write, review],
                "review_task": review,
                "exit_outcome": exit_outcome,
                "max_rounds": max_rounds,
                "escalation_owner_id": None,
                "stall_rule": "findings_and_artifact",
            }
        ],
    }


def loop_ids(w):
    by = {t["title"]: t["id"] for t in w["tasks"]}
    return by["Write the launch post"], by["Review the post"], by["Publish"]


def definition_reasons(wid):
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT version,reason FROM workflow_definition_versions WHERE workflow_id=%s ORDER BY version",
            (wid,),
        )
        return [(r["version"], r["reason"]) for r in cur.fetchall()]


def test_flow_edit_before_start_replaces_the_rules(setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = execute("create", loop_draft(setup_workflow[2]))
    ids = loop_ids(w)
    w = execute("flow", flow_body(ids, max_rounds=4, publish_outcomes=["Live"]), w["id"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert [o["name"] for o in byid[ids[2]]["outcomes"]] == ["Live"]
    assert w["repeat_groups"][0]["max_rounds"] == 4
    # Nothing has started, so no definition version is written yet.
    assert definition_reasons(w["id"]) == []


def test_flow_edit_after_start_freezes_started_steps_only(setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    ids = loop_ids(w)
    w = finish(setup_workflow, w, ids[0])
    # The group has a started step: its shape and the started step's rules stay.
    for body in (
        flow_body(ids, exit_outcome="Changes requested"),
        flow_body(ids, write_outcomes=["Drafted"]),
    ):
        assert code(execute, "flow", body, w["id"]) == "step_started"
    # Raising the round limit and giving the unstarted Publish step outcomes is fine.
    w = execute("flow", flow_body(ids, max_rounds=6, publish_outcomes=["Live"]), w["id"])
    assert w["repeat_groups"][0]["max_rounds"] == 6
    assert w["repeat_groups"][0]["current_round"] == 1
    assert [o["name"] for o in {t["id"]: t for t in w["tasks"]}[ids[2]]["outcomes"]] == ["Live"]
    assert definition_reasons(w["id"]) == [(1, "start"), (2, "edit")]


def test_flow_edit_names_what_is_frozen():
    started = {"w"}
    old = (
        {"r": [{"name": "Ok", "kind": "success"}]},
        {"r": [{"outcome": "Ok", "destination": "exit_group"}]},
        [{"name": "G", "member_tasks": ["w", "r"], "review_task": "r", "exit_outcome": "Ok", "max_rounds": 3, "current_round": 2}],
    )
    same = (old[0], old[1], [{**old[2][0], "max_rounds": 5}])
    assert workflow_routing.frozen_changes(started, old, same) == []
    lower = (old[0], old[1], [{**old[2][0], "max_rounds": 1}])
    assert workflow_routing.frozen_changes(started, old, lower) == [
        {"group": "G", "reason": "below_current_round"}
    ]
    gone = (old[0], old[1], [])
    assert workflow_routing.frozen_changes(started, old, gone) == [
        {"group": "G", "reason": "group_removed"}
    ]
    # A step that has not started can change freely, even inside an untouched flow.
    assert workflow_routing.frozen_changes(set(), old, gone) == []


def test_flow_edit_needs_version_two(setup_workflow, flexible, monkeypatch):
    execute = setup_workflow[-1]
    monkeypatch.delenv(workflow_routing.FLAG, raising=False)
    w = create(setup_workflow)
    monkeypatch.setenv(workflow_routing.FLAG, "1")
    assert code(execute, "flow", {"steps": [], "repeat_groups": []}, w["id"]) == "flexible_disabled"


def test_adding_a_step_after_start_records_an_edit(setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    execute(
        "add_tasks",
        {
            "tasks": [
                {
                    "client_key": "announce",
                    "title": "Announce",
                    "definition_of_done": "Announced",
                    "assignee_id": setup_workflow[2],
                    "depends_on": [],
                }
            ]
        },
        w["id"],
    )
    assert definition_reasons(w["id"]) == [(1, "start"), (2, "edit")]


def branch_draft(worker):
    """Triage branches to Fix or Document; Close waits on whichever ran."""
    step = lambda key, title, deps=(), **extra: {  # noqa: E731
        "client_key": key,
        "title": title,
        "definition_of_done": "Done",
        "assignee_id": worker,
        "depends_on": list(deps),
        **extra,
    }
    return {
        "title": "Support ticket",
        "goal": "A handled ticket",
        "tasks": [
            step(
                "triage",
                "Triage",
                outcomes=[{"name": "Bug", "kind": "custom"}, {"name": "Question", "kind": "custom"}],
                routes=[
                    {"outcome": "Bug", "destination": "step", "destination_task": "fix"},
                    {"outcome": "Question", "destination": "step", "destination_task": "docs"},
                ],
            ),
            step("fix", "Fix", ["triage"]),
            step("docs", "Document", ["triage"]),
            step("close", "Close", ["fix", "docs"]),
        ],
    }


def test_branch_runs_one_path_and_the_join_waits_only_for_it(setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", branch_draft(setup_workflow[2])))
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    w = finish(setup_workflow, w, ids["Triage"], "Bug")
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[ids["Document"]]["route_state"] == "not_selected"
    assert "not_selected" in {b["code"] for b in byid[ids["Document"]]["blockers"]}
    assert byid[ids["Fix"]]["can_start"] and not byid[ids["Close"]]["can_start"]
    w = finish(setup_workflow, w, ids["Fix"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[ids["Close"]]["can_start"]
    w = finish(setup_workflow, w, ids["Close"])
    # The unselected step does not hold up the finish; only the goal is left.
    assert {b["code"] for b in w["completion"]["blockers"]} == {"goal_unaccepted"}


def test_branch_that_selects_nothing_downstream_skips_the_join(setup_workflow, flexible):
    execute = setup_workflow[-1]
    draft = branch_draft(setup_workflow[2])
    draft["tasks"][3]["depends_on"] = ["docs"]
    w = prepare_and_start(setup_workflow, execute("create", draft))
    ids = {t["title"]: t["id"] for t in w["tasks"]}
    w = finish(setup_workflow, w, ids["Triage"], "Bug")
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[ids["Close"]]["route_state"] == "not_selected"


def test_same_findings_on_changed_work_do_not_stall(setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    write, review, publish = loop_ids(w)
    for _ in range(2):
        w = finish(setup_workflow, w, write)
        w = finish(setup_workflow, w, review, "Changes requested", ["Too long"])
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT state,current_round FROM workflow_repeat_groups WHERE workflow_id=%s", (w["id"],))
        assert dict(cur.fetchone()) == {"state": "open", "current_round": 3}


def test_same_findings_on_unchanged_work_stall_the_loop(setup_workflow, flexible, monkeypatch):
    execute = setup_workflow[-1]
    hooks = setup_workflow[4]
    save = hooks.save

    def same_file(task, **kwargs):
        ref = save(task, **kwargs)
        for r in (ref, hooks.evidence[ref["evidence_set_id"]][2]):
            for item in r["items"]:
                item["deliverable_id"] = "post-" + str(task["id"])
        return ref

    monkeypatch.setattr(hooks, "save", same_file)
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    write, review, publish = loop_ids(w)
    for _ in range(2):
        w = finish(setup_workflow, w, write)
        w = finish(setup_workflow, w, review, "Changes requested", ["Too long"])
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT state,current_round FROM workflow_repeat_groups WHERE workflow_id=%s", (w["id"],))
        g = cur.fetchone()
        cur.execute("SELECT awaiting_loop_decision FROM tasks WHERE id=%s", (review,))
        waiting = cur.fetchone()["awaiting_loop_decision"]
    assert (g["state"], g["current_round"], waiting) == ("stalled", 2, "stalled")
    # The owner resumes with a note: round 3 starts and carries it.
    w = execute("loop_decision", {"kind": "resume_stalled", "task_id": review, "note": "Cut the intro"}, w["id"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[write]["can_start"] and byid[write]["round"] == 3
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT subject_kind,chosen FROM workflow_owner_decisions WHERE workflow_id=%s", (w["id"],))
        assert [(r["subject_kind"], r["chosen"]) for r in cur.fetchall()] == [("stalled", "resume_stalled")]


def test_accepting_without_an_outcome_waits_for_the_owner_to_pick_one(setup_workflow, flexible):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    write, review, publish = loop_ids(w)
    w = finish(setup_workflow, w, write)
    w = finish(setup_workflow, w, review)
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[review]["awaiting_loop_decision"] == "missing_outcome"
    assert not byid[publish]["can_start"]
    assert code(execute, "loop_decision", {"kind": "raise_limit", "task_id": review, "new_max_rounds": 5}, w["id"]) == "decision_not_available"
    w = execute("loop_decision", {"kind": "pick_outcome", "task_id": review, "outcome": "Approved"}, w["id"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[review]["awaiting_loop_decision"] is None
    assert byid[publish]["can_start"]


def test_outcome_reports_are_fenced_to_the_current_work_and_worker(setup_workflow, flexible):
    from portal_backend import workflow_service as ws

    execute = setup_workflow[-1]
    worker = setup_workflow[2]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(worker)))
    write, review, publish = loop_ids(w)
    w = finish(setup_workflow, w, write)
    e, ref = submit_result(setup_workflow, w, review)
    old_revision = {t["id"]: t for t in w["tasks"]}[review]["work_revision"]
    # An AI that does not hold the step's turn cannot report for it.
    from test_workflows import uid

    other_ai = uid()
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO agents(id,container_id,alias,role,kind,member_role) VALUES (%s,%s,'Helper','test','ai','member')",
            (other_ai, setup_workflow[0]),
        )
    assert code(
        execute,
        "report_outcome",
        {"outcome": "Approved"},
        w["id"],
        review,
        acting=ws.WorkflowActor(other_ai, True, True),
    ) == "reporter_ineligible"
    execute("report_outcome", {"outcome": "Changes requested", "findings": [{"text": "Too long"}]}, w["id"], review)
    execute("accept", {"evidence": ref}, w["id"], review)
    # Round 2 bumped the review's work revision: a late report for round 1 is refused.
    assert code(
        execute,
        "report_outcome",
        {"outcome": "Approved", "expected_work_revision": old_revision},
        w["id"],
        review,
    ) == "work_revision_changed"


def test_switching_off_pauses_version_two_runs(setup_workflow, flexible, monkeypatch):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, execute("create", loop_draft(setup_workflow[2])))
    monkeypatch.delenv(workflow_routing.FLAG, raising=False)
    from portal_backend import workflow_service as ws

    with db_cursor(readonly=True) as (_, cur):
        d = ws.WorkflowService(cur, setup_workflow[4]).detail(w["id"], setup_workflow[1])
    write = {t["id"]: t for t in d["tasks"]}[loop_ids(d)[0]]
    assert not write["can_start"]
    assert "flexible_unsupported" in {b["code"] for b in write["blockers"]}
