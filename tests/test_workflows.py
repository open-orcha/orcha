"""Workflow invariants on the real isolated database, plus pure admission cases.

Runtime/evidence integration belongs to separate adapters. ContractHooks replaces
those leaves only; graph, locks, revisions, receipts and lifecycle use real SQL.
"""

import json

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException

from portal_backend import sql, workflow_service as ws
from portal_backend.database import db_cursor, run_migrations
from portal_backend.workflow_graph import dependency_closure, validate_graph
from portal_backend.workflow_scheduling import (
    OWNER_GATES,
    progress_and_completion,
    release_deadline,
    stored_status,
    task_display,
    workflow_eligibility,
)


def uid():
    return str(uuid4())


class ContractHooks(ws.WorkflowHooks):
    def __init__(self):
        self.evidence = {}
        self.stops = []
        self.owner_captures = []
        self.import_captures = []

    def availability(self, cur, task):
        cur.execute(
            "SELECT agent_id FROM agent_tasks WHERE task_id=%s AND assignment_status<>'done'",
            (task["id"],),
        )
        assignees = cur.fetchall()
        if not assignees:
            return {"available": False, "reason": "Choose an assignee."}
        return {"available": True, "reason": None}

    def validate_evidence(self, cur, task, reference):
        item = self.evidence.get(reference["evidence_set_id"])
        if (
            not item
            or item[0] != str(task["id"])
            or item[1] != task["work_revision"]
            or item[2] != reference
        ):
            raise HTTPException(409, {"code": "evidence_version_stale"})
        return reference

    def authorize_completion(self, cur, task, actor, reference):
        if actor["kind"] != "human":
            raise HTTPException(403, {"code": "human_approval_required"})
        return {"autonomy": "off", "autonomy_revision": 1}

    def completion_permission(self, cur, task, actor):
        human = actor["kind"] == "human"
        return {
            "allowed": human,
            "reason": None if human else "human_approval_required",
        }

    def request_stop(self, cur, execution, actor, origin, reason):
        self.stops.append((execution["id"], origin))

    def capture_outside(self, cur, task, evidence, execution):
        assert evidence["submitted_by"], "capture_outside needs the durable submitter"
        return self.save(
            task, source="outside", kind="outside_result",
            **self.capturer(cur, evidence["submitted_by"]),
        )

    def capture_import(
        self, cur, task, evidence, execution, actor, reviewed_result_digest
    ):
        assert execution["source_kind"] == "import_review" and not execution["run_id"]
        if reviewed_result_digest != ws.result_digest(task["result"]):
            raise HTTPException(409, {"code": "import_result_changed"})
        self.import_captures.append(
            (str(task["id"]), str(actor["id"]), reviewed_result_digest)
        )
        return self.save(
            task, source="import", kind="import_result",
            **self.capturer(cur, actor["id"]),
        )

    def capture_owner(self, cur, task, evidence, execution, actor):
        self.owner_captures.append((str(task["id"]), str(actor["id"]), evidence))
        return self.save(
            task, source="owner", kind="owner_result",
            **self.capturer(cur, actor["id"]),
        )

    def capturer(self, cur, actor_id):
        cur.execute("SELECT id,alias,kind FROM agents WHERE id=%s", (actor_id,))
        actor = cur.fetchone()
        return {
            "captured_by": str(actor["id"]),
            "captured_by_alias": actor["alias"],
            "captured_by_kind": actor["kind"],
        }

    def save(
        self,
        task,
        *,
        captured_by=None,
        captured_by_alias=None,
        captured_by_kind=None,
        source=None,
        kind=None,
    ):
        ref = {
            "evidence_set_id": uid(),
            "items": [
                {
                    "item_id": uid(),
                    "deliverable_id": uid(),
                    "deliverable_version": 1,
                    "sha256": "a" * 64,
                    **({"source": source, "kind": kind} if source and kind else {}),
                    **(
                        {
                            "captured_by": captured_by,
                            "captured_by_alias": captured_by_alias,
                            "captured_by_kind": captured_by_kind,
                        }
                        if captured_by
                        else {}
                    ),
                }
            ],
        }
        self.evidence[ref["evidence_set_id"]] = (
            str(task["id"]),
            task["work_revision"],
            deepcopy(ref),
        )
        return ref


@pytest.fixture
def setup_workflow(monkeypatch):
    monkeypatch.setattr(ws, "WORKFLOWS_INTEGRATED", True)
    cid, owner, worker, other = uid(), uid(), uid(), uid()
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO containers(id,name) VALUES (%s,'Workflow tests')", (cid,)
        )
        for aid, alias, kind, role in [
            (owner, "Owner", "human", "owner"),
            (worker, "Worker", "ai", "member"),
            (other, "Other", "human", "member"),
        ]:
            cur.execute(
                "INSERT INTO agents(id,container_id,alias,role,kind,member_role,github_login) VALUES (%s,%s,%s,'test',%s,%s,%s)",
                (
                    aid,
                    cid,
                    alias,
                    kind,
                    role,
                    alias.lower() if kind == "human" else None,
                ),
            )
    hooks = ContractHooks()
    actor = ws.WorkflowActor(owner, True)

    def execute(op, body, wid=None, tid=None, acting=None):
        with db_cursor() as (_, cur):
            svc = ws.WorkflowService(cur, hooks)
            if wid and "expected_revision" not in body:
                body = {"expected_revision": svc.workflow(wid)["revision"], **body}
            if tid and "expected_work_revision" not in body:
                body = {
                    "expected_work_revision": svc.task(wid, tid)["work_revision"],
                    **body,
                }
            body = {"idempotency_key": uid(), "reason": "test reason", **body}
            return svc.mutate(cid, acting or actor, op, body, wid=wid, tid=tid)

    return cid, actor, worker, other, hooks, execute


def create(fixture, *, mode="serial", count=2, dependencies=None):
    _, _, worker, _, _, execute = fixture
    tasks = [
        {
            "client_key": f"t{i}",
            "title": f"Task {i}",
            "definition_of_done": "A concrete result",
            "assignee_id": worker,
            "depends_on": (dependencies or {}).get(i, []),
        }
        for i in range(count)
    ]
    return execute(
        "create",
        {
            "title": "Release",
            "goal": "A usable result",
            "execution_mode": mode,
            "tasks": tasks,
        },
    )


def prepare_and_start(fixture, w):
    execute = fixture[-1]
    for t in list(w["tasks"]):
        w = execute("prepare", {}, w["id"], t["id"])
    return execute(
        "start",
        {
            "task_ids": [t["id"] for t in w["tasks"]],
            "task_revisions": {t["id"]: t["work_revision"] for t in w["tasks"]},
        },
        w["id"],
    )


def submit_result(fixture, w, tid):
    _, _, worker, _, hooks, _ = fixture
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        e = svc.reserve_turn(tid, ws.WorkflowActor(worker, True, True), run_id=uid())
        t = svc.task(w["id"], tid)
        ref = hooks.save(t)
        cur.execute(
            "UPDATE workflow_executions SET state='running',current_evidence_set_id=%s,evidence_state='saved' WHERE id=%s",
            (ref["evidence_set_id"], e["id"]),
        )
        svc.submit_for_review(tid, e["id"], e["generation"], ref)
    return e, ref


def test_graph_closure_includes_dependents_and_prerequisites():
    assert dependency_closure(
        ["build"], {"review": ["build"], "publish": ["review"], "alone": []}
    ) == {"build", "review", "publish"}


@pytest.mark.parametrize(
    "deps,code",
    [
        ({"a": ["a"]}, "self_dependency"),
        ({"a": ["b", "b"]}, "duplicate_dependency"),
        ({"a": ["b", "c", "d", "e"]}, "dependency_limit"),
        ({"a": ["missing"]}, "dependency_outside_workflow"),
        ({"a": ["b"], "b": ["c"], "c": ["a"]}, "dependency_cycle"),
    ],
)
def test_invalid_graphs(deps, code):
    with pytest.raises(HTTPException) as err:
        validate_graph("abcde", deps)
    assert err.value.detail["code"] == code


def test_save_prepare_and_start_selected_preserves_other_holds(setup_workflow):
    w = create(setup_workflow)
    execute = setup_workflow[-1]
    assert not w["launch_enabled"] and all(
        t["status"] == "not_ready" for t in w["tasks"]
    )
    a, b = w["tasks"]
    for t in (a, b):
        w = execute("prepare", {}, w["id"], t["id"])
    w = execute("hold", {}, w["id"], a["id"])
    revisions = {t["id"]: t["work_revision"] for t in w["tasks"]}
    w = execute("start", {"task_ids": [a["id"]], "task_revisions": revisions}, w["id"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert not byid[a["id"]]["start_hold"] and byid[a["id"]]["human_hold_by"]
    assert byid[b["id"]]["start_hold"]
    assert not any(t["can_start"] for t in w["tasks"])


def add_task(fixture, w, key, *, depends_on=()):
    """The owner adds one prepared-looking task to a Workflow; it joins as a held draft."""
    worker = fixture[2]
    w = fixture[-1](
        "add_tasks",
        {
            "tasks": [
                {
                    "client_key": key,
                    "title": f"Task {key}",
                    "definition_of_done": "A concrete result",
                    "assignee_id": worker,
                    "depends_on": list(depends_on),
                }
            ]
        },
        w["id"],
    )
    return w, next(t for t in w["tasks"] if t["title"] == f"Task {key}")


def test_a_task_prepared_after_start_needs_no_second_release(setup_workflow):
    """A fourth task joins a finished Workflow: preparing it is the owner's go-ahead."""
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    first = w["tasks"][0]
    e, ref = submit_result(setup_workflow, w, first["id"])
    w = execute("accept", {"evidence": ref}, w["id"], first["id"])
    with db_cursor() as (_, cur):
        ws.WorkflowService(cur, setup_workflow[4]).release_confirmed(
            e["id"], e["generation"], "process exit"
        )
    w, new = add_task(setup_workflow, w, "late", depends_on=[first["id"]])
    assert new["start_hold"] and not new["can_start"]
    assert {b["code"] for b in new["blockers"]} >= {"task_draft", "start_hold"}
    w = execute("prepare", {}, w["id"], new["id"])
    new = next(t for t in w["tasks"] if t["id"] == new["id"])
    assert not new["start_hold"] and new["can_start"] and new["status"] == "ready"
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT detail FROM workflow_history WHERE workflow_id=%s AND task_id=%s AND event='workflow_task_prepared'",
            (w["id"], new["id"]),
        )
        detail = cur.fetchone()["detail"]
    detail = json.loads(detail) if isinstance(detail, str) else detail
    assert detail["released"] is True


@pytest.mark.parametrize("mode", ["serial", "parallel"])
def test_a_task_prepared_after_start_still_waits_for_prerequisites_and_holds(
    setup_workflow, mode
):
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, create(setup_workflow, mode=mode, count=1))
    first = w["tasks"][0]
    w, waits = add_task(setup_workflow, w, "waits", depends_on=[first["id"]])
    w, held = add_task(setup_workflow, w, "held")
    w = execute("hold", {}, w["id"], held["id"])
    for tid in (waits["id"], held["id"]):
        w = execute("prepare", {}, w["id"], tid)
    byid = {t["id"]: t for t in w["tasks"]}
    # The start hold is gone, but nothing else is waived.
    assert not byid[waits["id"]]["start_hold"] and not byid[waits["id"]]["can_start"]
    assert [b["code"] for b in byid[waits["id"]]["blockers"]] == ["prerequisites"]
    assert not byid[held["id"]]["start_hold"] and byid[held["id"]]["human_hold_by"]
    assert not byid[held["id"]]["can_start"]
    assert [b["code"] for b in byid[held["id"]]["blockers"]] == ["human_hold"]


def test_preparing_never_releases_what_start_left_held_or_a_paused_workflow(
    setup_workflow,
):
    execute = setup_workflow[-1]
    w = create(setup_workflow, count=3)
    chosen, unselected, draft = (t["id"] for t in w["tasks"])
    for tid in (chosen, unselected):
        w = execute("prepare", {}, w["id"], tid)
    w = execute(
        "start",
        {
            "task_ids": [chosen],
            "task_revisions": {t["id"]: t["work_revision"] for t in w["tasks"]},
        },
        w["id"],
    )
    # Prepared before Start and not selected: editing and re-preparing keeps the hold.
    w = execute("prepare", {"title": "Reworded"}, w["id"], unselected)
    byid = {t["id"]: t for t in w["tasks"]}
    assert byid[unselected]["start_hold"] and not byid[unselected]["can_start"]
    # Never prepared before Start: preparing it now is its go-ahead.
    assert byid[draft]["start_hold"]
    w = execute("pause", {}, w["id"])
    with pytest.raises(HTTPException) as err:
        execute("prepare", {}, w["id"], draft)
    assert err.value.detail["code"] == "workflow_not_active"
    w = execute("resume", {}, w["id"])
    w = execute("prepare", {}, w["id"], draft)
    byid = {t["id"]: t for t in w["tasks"]}
    assert not byid[draft]["start_hold"] and byid[unselected]["start_hold"]


def test_a_task_prepared_after_start_wakes_its_agent(setup_workflow, monkeypatch):
    sent = []
    monkeypatch.setattr(
        ws,
        "publish_event",
        lambda cur, c, aid, kind, data: sent.append((kind, data.get("task_id"))),
    )
    execute = setup_workflow[-1]
    w = prepare_and_start(setup_workflow, create(setup_workflow, mode="parallel", count=1))
    w, new = add_task(setup_workflow, w, "late")

    def woken():
        return sum(1 for kind, t in sent if kind == "task_ready" and str(t) == str(new["id"]))

    assert woken() == 0  # a held draft is not offered to its agent
    execute("prepare", {}, w["id"], new["id"])
    assert woken() == 1  # preparing is the go-ahead: the agent is woken, no Release needed


def test_tasks_that_join_a_started_workflow_by_import_or_move_follow_the_same_rule(
    setup_workflow,
):
    """Only a task that still needs its first prepare is released by it; one that
    arrives already prepared keeps its hold until someone releases it."""
    cid, _, worker, _, hooks, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, mode="parallel", count=1))
    bare, ready = uid(), uid()
    with db_cursor() as (_, cur):
        for tid, title, criteria in ((bare, "Bare", ""), (ready, "Ready", "Done")):
            cur.execute(
                "INSERT INTO tasks(id,container_id,title,definition_of_done,status) VALUES (%s,%s,%s,%s,'ready')",
                (tid, cid, title, criteria),
            )
        cur.execute("INSERT INTO agent_tasks(agent_id,task_id) VALUES (%s,%s)", (worker, ready))
    with db_cursor(readonly=True) as (_, cur):
        preview = ws.WorkflowService(cur, hooks).preview_import(cid, [bare, ready])
    w = execute("import", {"task_ids": [bare, ready], "preview_digest": preview["preview_digest"]}, w["id"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert (byid[bare]["preparation_state"], byid[bare]["start_hold"]) == ("draft", True)
    assert (byid[ready]["preparation_state"], byid[ready]["start_hold"]) == ("prepared", True)
    w = execute("prepare", {"definition_of_done": "A concrete result", "assignee_id": worker}, w["id"], bare)
    w = execute("prepare", {}, w["id"], ready)
    byid = {t["id"]: t for t in w["tasks"]}
    assert not byid[bare]["start_hold"] and byid[bare]["can_start"]
    assert byid[ready]["start_hold"] and not byid[ready]["can_start"]

    # A task moved in from another Workflow keeps its preparation: a draft is still
    # released by its first prepare, one prepared there arrives held.
    source = create(setup_workflow, mode="parallel", count=2)
    draft, prepared = (t["id"] for t in source["tasks"])
    execute("prepare", {}, source["id"], prepared)
    execute(
        "move",
        {
            "task_ids": [draft, prepared],
            "destination_workflow_id": w["id"],
            "destination_revision": w["revision"],
        },
        source["id"],
    )
    for tid in (draft, prepared):
        w = execute("prepare", {}, w["id"], tid)
    byid = {t["id"]: t for t in w["tasks"]}
    assert not byid[draft]["start_hold"] and byid[draft]["can_start"]
    assert byid[prepared]["start_hold"] and not byid[prepared]["can_start"]


def test_mutation_receipt_is_atomic_and_replay_precedes_revision_check(setup_workflow):
    w = create(setup_workflow)
    execute = setup_workflow[-1]
    b = {
        "expected_revision": w["revision"],
        "idempotency_key": "same",
        "title": "New name",
    }
    first = execute("patch", b, w["id"])
    assert execute("patch", b, w["id"]) == first
    with pytest.raises(HTTPException) as err:
        execute("patch", {**b, "title": "Different"}, w["id"])
    assert err.value.detail["code"] == "idempotency_conflict"


def test_invalid_batch_rolls_back_workflow_and_all_tasks(setup_workflow):
    with pytest.raises(HTTPException):
        create(setup_workflow, dependencies={0: ["t1"], 1: ["t0"]})
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT count(*) AS n FROM workflows")
        assert cur.fetchone()["n"] == 0
        cur.execute("SELECT count(*) AS n FROM tasks")
        assert cur.fetchone()["n"] == 0


def test_import_requires_both_directions_and_preserves_manual_hold(setup_workflow):
    cid, actor, worker, _, hooks, execute = setup_workflow
    a, b = uid(), uid()
    with db_cursor() as (_, cur):
        for tid, title, state in [(a, "Build", "not_ready"), (b, "Review", "pending")]:
            cur.execute(
                "INSERT INTO tasks(id,container_id,title,definition_of_done,status) VALUES (%s,%s,%s,'A result',%s)",
                (tid, cid, title, state),
            )
            cur.execute(
                "INSERT INTO agent_tasks(agent_id,task_id) VALUES (%s,%s)",
                (worker, tid),
            )
        cur.execute(
            "INSERT INTO task_dependencies(task_id,depends_on_id) VALUES (%s,%s)",
            (b, a),
        )
    w = create(setup_workflow, count=0)
    with db_cursor(readonly=True) as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        preview = svc.preview_import(cid, [a])
        assert preview["required_task_ids"] == [b]
        preview = svc.preview_import(cid, [a, b])
    w = execute(
        "import",
        {"task_ids": [a, b], "preview_digest": preview["preview_digest"]},
        w["id"],
    )
    imported = next(t for t in w["tasks"] if t["id"] == a)
    assert (
        imported["human_hold_by"] == actor.id
        and imported["start_hold"]
        and imported["status"] == "not_ready"
    )


def test_import_starts_only_ticked_waiting_tasks_in_a_started_workflow(setup_workflow):
    cid, actor, worker, _, hooks, execute = setup_workflow
    tick, untick, held = uid(), uid(), uid()
    with db_cursor() as (_, cur):
        for tid, state in [(tick, "pending"), (untick, "pending"), (held, "not_ready")]:
            cur.execute(
                "INSERT INTO tasks(id,container_id,title,definition_of_done,status) VALUES (%s,%s,%s,'A result',%s)",
                (tid, cid, state, state),
            )
            cur.execute(
                "INSERT INTO agent_tasks(agent_id,task_id) VALUES (%s,%s)",
                (worker, tid),
            )
    ids = [tick, untick, held]
    preparing = create(setup_workflow, mode="parallel", count=1)
    w = prepare_and_start(
        setup_workflow, create(setup_workflow, mode="parallel", count=1)
    )

    def preview(wid):
        with db_cursor(readonly=True) as (_, cur):
            svc = ws.WorkflowService(cur, hooks)
            return svc.preview_import(cid, ids, svc.workflow(wid))

    assert not any(t["releasable"] for t in preview(preparing["id"])["task_impacts"])
    started = preview(w["id"])
    assert {t["id"]: t["releasable"] for t in started["task_impacts"]} == {
        tick: True,
        untick: True,
        held: False,
    }
    body = {"task_ids": ids, "preview_digest": started["preview_digest"]}
    for wid, release, code in [
        (preparing["id"], [tick], "workflow_not_started"),
        (w["id"], [held], "release_not_allowed"),
    ]:
        with pytest.raises(HTTPException) as err:
            execute("import", dict(body, release_task_ids=release), wid)
        assert err.value.detail["code"] == code
    w = execute("import", dict(body, release_task_ids=[tick]), w["id"])
    byid = {t["id"]: t for t in w["tasks"]}
    assert not byid[tick]["start_hold"] and byid[tick]["can_start"]
    assert byid[untick]["start_hold"] and not byid[untick]["can_start"]
    assert byid[held]["start_hold"] and byid[held]["human_hold_by"] == actor.id
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT detail FROM workflow_history WHERE workflow_id=%s AND event='workflow_tasks_imported'",
            (w["id"],),
        )
        detail = cur.fetchone()["detail"]
    detail = json.loads(detail) if isinstance(detail, str) else detail
    assert detail["released_task_ids"] == [tick]


def test_import_names_blocked_tasks_and_audits_original_states(setup_workflow):
    cid, actor, worker, _, hooks, execute = setup_workflow
    held, blocked = uid(), uid()
    with db_cursor() as (_, cur):
        for tid, state in [(held, "not_ready"), (blocked, "blocked")]:
            cur.execute(
                "INSERT INTO tasks(id,container_id,title,definition_of_done,status) VALUES (%s,%s,%s,'A result',%s)",
                (tid, cid, state, state),
            )
    w = create(setup_workflow, count=1)
    with db_cursor(readonly=True) as (_, cur):
        preview = ws.WorkflowService(cur, hooks).preview_import(cid, [held, blocked])
    w = execute(
        "import",
        {"task_ids": [held, blocked], "preview_digest": preview["preview_digest"]},
        w["id"],
    )
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT id,human_hold_reason FROM tasks WHERE id IN (%s,%s)",
            (held, blocked),
        )
        reasons = {str(r["id"]): r["human_hold_reason"] for r in cur.fetchall()}
        cur.execute(
            "SELECT detail FROM workflow_history WHERE workflow_id=%s AND event='workflow_tasks_imported'",
            (w["id"],),
        )
        detail = cur.fetchone()["detail"]
    assert reasons == {
        str(held): "On hold before it joined this workflow",
        str(blocked): "Blocked before it joined this workflow",
    }
    detail = json.loads(detail) if isinstance(detail, str) else detail
    assert detail["original_states"] == {
        str(held): "not_ready",
        str(blocked): "blocked",
    }

    tid = next(t["id"] for t in w["tasks"] if t["id"] not in (held, blocked))
    w = execute("prepare", {}, w["id"], tid)
    revision = next(t["work_revision"] for t in w["tasks"] if t["id"] == tid)
    w = execute(
        "start", {"task_ids": [tid], "task_revisions": {tid: revision}}, w["id"]
    )
    submit_result(setup_workflow, w, tid)
    execute("reject", {}, w["id"], tid)
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT detail FROM workflow_history WHERE task_id=%s AND event='workflow_task_rejected'",
            (tid,),
        )
        detail = cur.fetchone()["detail"]
    detail = json.loads(detail) if isinstance(detail, str) else detail
    assert detail["work_revision"] >= 1


def test_serial_turn_waits_for_both_acceptance_and_worker_exit(setup_workflow):
    w = prepare_and_start(setup_workflow, create(setup_workflow))
    a, b = w["tasks"]
    e, ref = submit_result(setup_workflow, w, a["id"])
    w = setup_workflow[-1]("accept", {"evidence": ref}, w["id"], a["id"])
    assert w["progress"]["accepted"] == 1
    assert not next(t for t in w["tasks"] if t["id"] == b["id"])["can_start"]
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, setup_workflow[4])
        svc.release_confirmed(e["id"], e["generation"], "process exit")
        assert svc.detail(w["id"])["tasks"][1]["can_start"]


def test_worker_exit_does_not_release_review_turn(setup_workflow):
    w = prepare_and_start(setup_workflow, create(setup_workflow))
    e, _ = submit_result(setup_workflow, w, w["tasks"][0]["id"])
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, setup_workflow[4])
        released = svc.release_confirmed(e["id"], e["generation"], "process exit")
        assert released["state"] == "awaiting_review" and released["worker_stopped_at"]
        assert not svc.detail(w["id"])["tasks"][1]["can_start"]


@pytest.mark.parametrize("gate", [None, *sorted(OWNER_GATES)])
@pytest.mark.parametrize("admit", [False, True])
def test_outside_evidence_withdrawal_preserves_owner_gate(setup_workflow, gate, admit):
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    cid, actor, _, _, hooks, execute = setup_workflow
    with db_cursor() as (_, cur):
        cur.execute(
            "UPDATE tasks SET awaiting_owner_decision=%s,status='not_ready' WHERE id=%s",
            (gate, tid),
        )
    w = execute(
        "external_result",
        {"evidence": {"narrative": "Produced outside Orcha"}},
        w["id"],
        tid,
    )
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        if admit:
            svc.reserve_turn(tid, actor)
        evidence = svc.one(
            "SELECT id FROM task_outside_evidence WHERE task_id=%s", (tid,)
        )
    w = execute("withdraw_evidence", {"evidence_id": evidence["id"]}, w["id"], tid)
    task = w["tasks"][0]
    assert task["awaiting_owner_decision"] == (gate or "evidence_withdrawn")
    assert task["status"] == "not_ready" and not task["can_start"]
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        svc.reconcile(w["id"])
        assert svc.task(w["id"], tid)["awaiting_owner_decision"] == (
            gate or "evidence_withdrawn"
        )


def test_outside_result_for_an_older_task_version_is_not_admitted(setup_workflow):
    _, actor, _, _, hooks, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]

    def submit():
        execute(
            "external_result",
            {"evidence": {"narrative": "Done elsewhere"}},
            w["id"],
            tid,
        )
        with db_cursor(readonly=True) as (_, cur):
            return ws.WorkflowService(cur, hooks).one(
                "SELECT id FROM task_outside_evidence WHERE task_id=%s AND state='pending'",
                (tid,),
            )["id"]

    evidence = submit()
    # Editing the never-started task's prerequisites makes a new task version.
    execute("dependencies", {"depends_on": []}, w["id"], tid)
    # The board says why it cannot start before anyone tries (plan 9 eligibility).
    with db_cursor(readonly=True) as (_, cur):
        row = ws.WorkflowService(cur, hooks).detail(w["id"])["tasks"][0]
    assert not row["can_start"]
    assert [b["code"] for b in row["blockers"]] == ["evidence_version_stale"]
    assert row["display_state"]["label"].startswith(
        "Outside result waiting - The outside result is for an older version"
    )
    with pytest.raises(HTTPException) as err:
        with db_cursor() as (_, cur):
            ws.WorkflowService(cur, hooks).reserve_turn(tid, actor)
    assert err.value.detail["code"] == "not_eligible"
    assert [b["code"] for b in err.value.detail["blockers"]] == [
        "evidence_version_stale"
    ]
    # Resubmitting against the current version lets it be reviewed.
    execute("withdraw_evidence", {"evidence_id": evidence}, w["id"], tid)
    submit()
    with db_cursor() as (_, cur):
        e = ws.WorkflowService(cur, hooks).reserve_turn(tid, actor)
    assert e["source_kind"] == "evidence_review"


def test_losing_claimant_is_told_not_eligible_and_others_are_refused(setup_workflow):
    _, actor, worker, other, hooks, execute = setup_workflow
    w = prepare_and_start(
        setup_workflow, create(setup_workflow, mode="parallel", count=2)
    )
    plain, outside = (t["id"] for t in w["tasks"])
    execute(
        "external_result",
        {"evidence": {"narrative": "Done elsewhere"}},
        w["id"],
        outside,
    )

    def claim(tid, acting, run_id=None):
        with pytest.raises(HTTPException) as err:
            with db_cursor() as (_, cur):
                ws.WorkflowService(cur, hooks).reserve_turn(tid, acting, run_id=run_id)
        return err.value

    agent = ws.WorkflowActor(worker, True, True)
    # The worker loses to the waiting outside result; the owner to the worker.
    lost = claim(outside, agent, run_id=uid())
    assert lost.status_code == 409 and lost.detail["code"] == "not_eligible"
    assert [b["code"] for b in lost.detail["blockers"]] == ["owner_evidence_pending"]
    lost = claim(plain, actor)
    assert lost.status_code == 409 and lost.detail["code"] == "not_eligible"
    assert [b["code"] for b in lost.detail["blockers"]] == ["evidence_not_pending"]
    # Someone who is neither the assignee nor the owner is still refused.
    member = ws.WorkflowActor(other, True)
    assert claim(plain, member, run_id=uid()).detail["code"] == "assignee_required"
    assert claim(outside, member).detail["code"] == "workflow_owner_required"


def test_outside_result_submitter_or_owner_may_withdraw_it(setup_workflow):
    _, first_owner, worker, other, hooks, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    new_owner = ws.WorkflowActor(other, True)

    def submit(acting):
        execute(
            "external_result",
            {"evidence": {"narrative": "Done elsewhere"}},
            w["id"],
            tid,
            acting=acting,
        )
        with db_cursor(readonly=True) as (_, cur):
            return ws.WorkflowService(cur, hooks).one(
                "SELECT id FROM task_outside_evidence WHERE task_id=%s AND state='pending'",
                (tid,),
            )["id"]

    evidence = submit(first_owner)
    execute("transfer_owner", {"new_owner_id": other}, w["id"])
    # The former owner submitted it, so they may still withdraw it.
    _, tasks, _ = actions_for(setup_workflow, w["id"], first_owner)
    action = tasks[tid]["withdraw_evidence"]
    assert action["enabled"] and action["permission"] == "workflow_owner_or_submitter"
    execute("withdraw_evidence", {"evidence_id": evidence}, w["id"], tid)

    evidence = submit(new_owner)
    # Neither owner nor submitter (a project owner, or an agent) is refused.
    _, tasks, _ = actions_for(setup_workflow, w["id"], first_owner)
    assert tasks[tid]["withdraw_evidence"]["reason"] == "workflow_owner_required"
    for acting in (first_owner, ws.WorkflowActor(worker, True, True)):
        with pytest.raises(HTTPException) as err:
            execute(
                "withdraw_evidence",
                {"evidence_id": evidence},
                w["id"],
                tid,
                acting=acting,
            )
        assert err.value.detail["code"] == "workflow_owner_required"
    _, tasks, _ = actions_for(setup_workflow, w["id"], new_owner)
    assert tasks[tid]["withdraw_evidence"]["enabled"]
    w = execute(
        "withdraw_evidence", {"evidence_id": evidence}, w["id"], tid, acting=new_owner
    )
    assert w["tasks"][0]["awaiting_owner_decision"] == "evidence_withdrawn"


def test_outside_result_needs_a_person_even_when_autonomy_allows_agents(
    setup_workflow, monkeypatch
):
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    cid, actor, worker, _, hooks, execute = setup_workflow
    monkeypatch.setattr(
        hooks,
        "authorize_completion",
        lambda cur, task, person, ref: {"autonomy": "on", "autonomy_revision": 2},
    )
    monkeypatch.setattr(
        hooks,
        "completion_permission",
        lambda cur, task, person: {"allowed": True, "reason": None},
    )
    w = execute(
        "external_result",
        {"evidence": {"narrative": "Produced outside Orcha"}},
        w["id"],
        tid,
    )
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        e = svc.reserve_turn(tid, actor)
        ref = hooks.evidence[str(e["current_evidence_set_id"])][2]
    agent = ws.WorkflowActor(worker, True, True)
    _, by_agent, _ = actions_for(setup_workflow, w["id"], agent)
    assert by_agent[tid]["accept"]["reason"] == "human_approval_required"
    with pytest.raises(HTTPException) as err:
        execute("accept", {"evidence": ref}, w["id"], tid, acting=agent)
    assert err.value.detail["code"] == "human_approval_required"
    w = execute("accept", {"evidence": ref}, w["id"], tid)
    assert next(t for t in w["tasks"] if t["id"] == tid)["status"] == "completed"
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT detail FROM workflow_history WHERE task_id=%s AND event='workflow_task_accepted'",
            (tid,),
        )
        detail = cur.fetchone()["detail"]
    assert detail["supplier_id"] == actor.id
    assert detail["supplier_alias"] == "Owner"
    assert detail["supplier_kind"] == "human"
    assert detail["same_person_supplier"] is True


def test_rejection_does_not_reactivate_assignee(setup_workflow):
    w = prepare_and_start(setup_workflow, create(setup_workflow))
    tid = w["tasks"][0]["id"]
    e, _ = submit_result(setup_workflow, w, tid)
    w = setup_workflow[-1]("reject", {}, w["id"], tid)
    assert (
        next(t for t in w["tasks"] if t["id"] == tid)["awaiting_owner_decision"]
        == "changes_requested"
    )
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, setup_workflow[4])
        svc.release_confirmed(e["id"], e["generation"], "stopped")
        assert svc.task(w["id"], tid)["status"] == "not_ready"
        assert svc.detail(w["id"])["tasks"][1]["can_start"]


def test_cancel_preserves_accepted_result_and_holds_unconfirmed_worker(setup_workflow):
    w = prepare_and_start(setup_workflow, create(setup_workflow))
    tid = w["tasks"][0]["id"]
    sleeping = w["tasks"][1]["id"]
    e, ref = submit_result(setup_workflow, w, tid)
    w = setup_workflow[-1]("accept", {"evidence": ref}, w["id"], tid)
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO agent_self_wake(agent_id,task_id,resume_at,context) VALUES (%s,%s,%s,'continue later')",
            (setup_workflow[2], sleeping, ws.sql.utcnow()),
        )
    w = setup_workflow[-1]("cancel", {}, w["id"])
    assert w["status"] == "cancelled" and w["progress"]["accepted"] == 1
    assert w["tasks"][0]["display_state"]["label"] == "Stopping - accepted"
    with db_cursor(readonly=True) as (_, cur):
        svc = ws.WorkflowService(cur, setup_workflow[4])
        assert svc.live_turn(tid)["id"] == e["id"]
        cur.execute(
            "SELECT count(*) AS n FROM agent_self_wake WHERE task_id=%s", (sleeping,)
        )
        assert cur.fetchone()["n"] == 0


def test_late_result_after_cancel_is_refused_as_stale_generation(setup_workflow):
    _, _, worker, _, hooks, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        e = svc.reserve_turn(tid, ws.WorkflowActor(worker, True, True), run_id=uid())
        ref = hooks.save(svc.task(w["id"], tid))
        cur.execute(
            "UPDATE workflow_executions SET state='running',current_evidence_set_id=%s,evidence_state='saved' WHERE id=%s",
            (ref["evidence_set_id"], e["id"]),
        )
    w = execute("cancel", {}, w["id"])
    assert w["status"] == "cancelled"
    with pytest.raises(HTTPException) as err:
        with db_cursor() as (_, cur):
            ws.WorkflowService(cur, hooks).submit_for_review(
                tid, e["id"], e["generation"], ref
            )
    assert err.value.detail["code"] == "stale_generation"


def test_plain_retry_restores_only_the_latest_assignee(setup_workflow):
    cid, _, worker, _, hooks, execute = setup_workflow
    second = uid()
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO agents(id,container_id,alias,role,kind,member_role) VALUES (%s,%s,'Second','test','ai','member')",
            (second, cid),
        )
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    e, _ = submit_result(setup_workflow, w, tid)
    execute("reject", {}, w["id"], tid)
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        svc.release_confirmed(e["id"], e["generation"], "exited")
    w = execute("retry", {"assignee_id": second}, w["id"], tid)
    with db_cursor() as (_, cur):
        # The replacement finished and the owner sent the task back again.
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s", (tid,)
        )
        cur.execute(
            "UPDATE tasks SET awaiting_owner_decision='changes_requested' WHERE id=%s",
            (tid,),
        )
    execute("retry", {}, w["id"], tid)
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT agent_id FROM agent_tasks WHERE task_id=%s AND assignment_status='assigned'",
            (tid,),
        )
        assert [str(r["agent_id"]) for r in cur.fetchall()] == [str(second)]


def test_start_hold_is_released_only_by_start(setup_workflow):
    _, _, _, _, _, execute = setup_workflow
    w = create(setup_workflow, count=2)
    a, b = (t["id"] for t in w["tasks"])
    for tid in (a, b):
        w = execute("prepare", {}, w["id"], tid)
    _, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert tasks[b]["release"]["reason"] == "workflow_not_started"
    with db_cursor(readonly=True) as (_, cur):
        revision = ws.WorkflowService(cur, setup_workflow[4]).task(w["id"], b)[
            "work_revision"
        ]
    with pytest.raises(HTTPException) as err:
        execute(
            "release",
            {"task_ids": [b], "holds": ["start"], "task_revisions": {b: revision}},
            w["id"],
        )
    assert err.value.detail["code"] == "workflow_not_started"


def test_labels_follow_the_plan_label_map_with_names(setup_workflow):
    execute = setup_workflow[-1]
    w = create(setup_workflow, count=3, dependencies={1: ["t0"]})
    for t in w["tasks"]:
        w = execute("prepare", {}, w["id"], t["id"])

    def labels(view):
        return {t["title"]: t["display_state"]["label"] for t in view["tasks"]}

    assert set(labels(w).values()) == {"Prepared · waiting for Start"}
    by_title = {t["title"]: t for t in w["tasks"]}
    w = execute("hold", {}, w["id"], by_title["Task 2"]["id"])
    assert labels(w)["Task 2"] == "Prepared · waiting for Start · on hold by Owner"
    w = execute(
        "start",
        {
            "task_ids": [by_title["Task 1"]["id"]],
            "task_revisions": {
                t["id"]: t["work_revision"]
                for t in w["tasks"]
                if t["title"] == "Task 1"
            },
        },
        w["id"],
    )
    got = labels(w)
    # Unselected tasks wait for release once the workflow has started; a task
    # whose prerequisite is not accepted names it.
    assert got["Task 0"] == "Prepared · awaiting release"
    assert got["Task 1"] == "Waiting for Task 0"
    assert got["Task 2"] == "Prepared · awaiting release · on hold by Owner"
    w = execute("withdraw", {"reason": "Not needed"}, w["id"], by_title["Task 2"]["id"])
    row = next(t for t in w["tasks"] if t["title"] == "Task 2")
    assert row["display_state"]["label"] == "Withdrawn by Owner: Not needed"
    assert row["withdrawn_by"] == str(setup_workflow[1].id)
    assert row["withdrawn_reason"] == "Not needed"


def test_lost_release_warning_is_permanent_and_list_mark_clears():
    lost = {"state": "released_lost", "first_stop_at": None}
    newer = {"state": "running", "first_stop_at": None}
    task = {
        "id": "t",
        "status": "not_ready",
        "awaiting_owner_decision": "stopped_by_owner",
    }
    shown = task_display(task, lost)
    assert shown["label"] == "Stopped by owner · owner decides"
    assert shown["warning"] and shown["list_warning"]
    # A new attempt clears the list mark; the inspector warning stays.
    shown = task_display(dict(task, status="in_progress"), newer, lost_release=True)
    assert shown["warning"] and not shown["list_warning"]
    # Withdrawal, or a finished or cancelled workflow, clears the list mark too.
    assert not task_display(dict(task, withdrawn_at="x"), lost)["list_warning"]
    shown = task_display(task, lost, workflow_open=False)
    assert shown["warning"] and not shown["list_warning"]


def test_task_notices_go_to_the_verifier_where_set(setup_workflow, monkeypatch):
    cid, actor, worker, other, hooks, execute = setup_workflow
    sent = []
    monkeypatch.setattr(
        ws,
        "publish_event",
        lambda cur, c, aid, kind, data: sent.append((str(aid), kind)),
    )
    w = prepare_and_start(setup_workflow, create(setup_workflow))
    checked, plain = w["tasks"][0]["id"], w["tasks"][1]["id"]
    with db_cursor() as (_, cur):
        cur.execute(
            "UPDATE tasks SET reviewer_agent_id=%s WHERE id=%s", (other, checked)
        )
    sent.clear()
    submit_result(setup_workflow, w, checked)
    awaiting = [
        aid for aid, kind in sent if kind == "workflow_task_awaiting_acceptance"
    ]
    assert awaiting == [str(other)]
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        wf = svc.workflow(w["id"])
        sent.clear()
        svc.notice(wf, "workflow_attention", checked, 99)
        # Attention names an owner-only decision: the owner keeps it too.
        assert sorted(sent) == sorted(
            [(str(other), "workflow_attention"), (str(actor.id), "workflow_attention")]
        )
        sent.clear()
        svc.notice(wf, "workflow_task_awaiting_acceptance", plain, 99)
        svc.notice(wf, "workflow_ready_to_finish", "workflow", 99)
        assert sent == [
            (str(actor.id), "workflow_task_awaiting_acceptance"),
            (str(actor.id), "workflow_ready_to_finish"),
        ]


def test_owner_attention_covers_recovery_lost_worker_and_choose_assignee(
    setup_workflow, monkeypatch
):
    _, actor, worker, _, hooks, execute = setup_workflow
    sent = []
    monkeypatch.setattr(
        ws,
        "publish_event",
        lambda cur, c, aid, kind, data: (
            sent.append((str(aid), data.get("task_id"), data.get("reason")))
            if kind == "workflow_attention"
            else None
        ),
    )
    w = prepare_and_start(
        setup_workflow, create(setup_workflow, mode="parallel", count=2)
    )
    running, unassigned = (t["id"] for t in w["tasks"])
    owner = str(actor.id)

    def reconcile():
        with db_cursor() as (_, cur):
            ws.WorkflowService(cur, hooks).reconcile(w["id"])

    with db_cursor() as (_, cur):
        e = ws.WorkflowService(cur, hooks).reserve_turn(
            running, ws.WorkflowActor(worker, True, True), run_id=uid()
        )
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s",
            (unassigned,),
        )
    sent.clear()
    reconcile()
    reconcile()
    assert sent == [(owner, unassigned, "choose_assignee")]
    # A stop the worker never confirmed, silent past the release deadline.
    long_ago = datetime.now(timezone.utc) - timedelta(hours=2)
    with db_cursor() as (_, cur):
        cur.execute(
            "UPDATE workflow_executions SET state='stopping',first_stop_at=%s,last_runner_contact_at=%s WHERE id=%s",
            (long_ago, long_ago, e["id"]),
        )
    sent.clear()
    reconcile()
    reconcile()
    assert sent == [(owner, running, "lost_worker")]
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO worker_runs(run_id,agent_id,status,started_at,ended_at) VALUES (%s,%s,'failed',%s,%s)",
            (e["run_id"], worker, long_ago, long_ago),
        )
        cur.execute(
            "UPDATE workflow_executions SET state='running',first_stop_at=NULL WHERE id=%s",
            (e["id"],),
        )
    sent.clear()
    reconcile()
    reconcile()
    assert sent == [(owner, running, "recovery_needed")]
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT state FROM workflow_executions WHERE id=%s", (e["id"],))
        assert cur.fetchone()["state"] == "recovery_needed"


def test_task_is_woken_again_each_time_it_can_start_again(setup_workflow, monkeypatch):
    cid, actor, worker, other, hooks, execute = setup_workflow
    sent = []
    monkeypatch.setattr(
        ws,
        "publish_event",
        lambda cur, c, aid, kind, data: sent.append((kind, data.get("task_id"))),
    )
    w = prepare_and_start(setup_workflow, create(setup_workflow))
    first, second = (t["id"] for t in w["tasks"])

    def woken(tid):
        return sum(1 for kind, t in sent if kind == "task_ready" and str(t) == str(tid))

    # One task at a time: only the first candidate is offered.
    assert (woken(first), woken(second)) == (1, 0)
    w = execute("hold", {}, w["id"], first)
    assert (woken(first), woken(second)) == (1, 1)
    revisions = {t["id"]: t["work_revision"] for t in w["tasks"]}
    w = execute(
        "release",
        {"task_ids": [first], "task_revisions": revisions, "holds": ["human"]},
        w["id"],
    )
    # Released at the same work revision, the first task is offered again (its
    # worker is woken a second time) and the second waits for its turn.
    assert next(t for t in w["tasks"] if t["id"] == first)["can_start"]
    assert (woken(first), woken(second)) == (2, 1)
    # While it stays startable, further changes do not wake it again.
    execute("patch", {"title": "Release v2"}, w["id"])
    assert (woken(first), woken(second)) == (2, 1)
    e, ref = submit_result(setup_workflow, w, first)
    execute("accept", {"evidence": ref}, w["id"], first)
    with db_cursor() as (_, cur):
        ws.WorkflowService(cur, hooks).release_confirmed(
            e["id"], e["generation"], "exited"
        )
    assert woken(second) == 2


def test_check_routes_preview_what_each_task_would_become(setup_workflow):
    _, actor, worker, _, hooks, execute = setup_workflow
    w = create(setup_workflow, mode="parallel", count=3, dependencies={2: ["t0"]})
    by_title = {t["title"]: t["id"] for t in w["tasks"]}
    a, draft, after = (by_title[f"Task {i}"] for i in range(3))
    for tid in (a, after):
        w = execute("prepare", {}, w["id"], tid)

    def check(kind, task_ids=(), holds=("start",)):
        with db_cursor(readonly=True) as (_, cur):
            impact = ws.WorkflowService(cur, hooks).impact(
                w["id"], actor, kind, list(task_ids), list(holds)
            )["impact"]
        return impact, {t["task_id"]: t for t in impact["tasks"]}

    # Start defaults to every prepared task; drafts stay held and say why.
    impact, rows = check("start")
    assert impact["task_revisions"] == {t["id"]: t["work_revision"] for t in w["tasks"]}
    assert {tid for tid, r in rows.items() if r["selected"]} == {a, after}
    assert rows[a]["resulting_status"] == "ready" and rows[a]["can_start"]
    assert rows[after]["resulting_status"] == "waiting_for_prerequisites"
    assert rows[draft]["resulting_status"] == "blocked"
    assert "task_draft" in [b["code"] for b in rows[draft]["blockers"]]
    _, rows = check("start", [draft])
    assert rows[draft]["refusal"]["code"] == "task_not_prepared"
    # The preview wrote nothing.
    with db_cursor(readonly=True) as (_, cur):
        assert not ws.WorkflowService(cur, hooks).workflow(w["id"])["launch_enabled"]

    w = execute(
        "start",
        {"task_ids": [a], "task_revisions": {a: rows[a]["work_revision"]}},
        w["id"],
    )
    w = execute("hold", {}, w["id"], a)
    _, rows = check("release", [a], ["human"])
    assert rows[a]["resulting_status"] == "ready" and rows[a]["can_start"]
    _, rows = check("release", [a])
    assert rows[a]["resulting_status"] == "blocked"
    assert "human_hold" in [b["code"] for b in rows[a]["blockers"]]
    _, rows = check("release", [after])
    assert rows[after]["resulting_status"] == "waiting_for_prerequisites"
    w = execute(
        "release",
        {
            "task_ids": [a],
            "holds": ["human"],
            "task_revisions": {a: rows[a]["work_revision"]},
        },
        w["id"],
    )

    # Cancellation names the worker to stop and the accepted result kept.
    e, ref = submit_result(setup_workflow, w, a)
    impact, _ = check("cancellation")
    assert impact["workers_to_stop"] == [
        {"task_id": a, "agent_id": worker, "name": "Worker"}
    ]
    execute("accept", {"evidence": ref}, w["id"], a)
    impact, _ = check("cancellation")
    assert impact["accepted_retained"] == [a]
    assert impact["counts_by_state"] == {"completed": 1, "not_ready": 2}


def test_withdraw_cannot_remove_last_or_accepted_task(setup_workflow):
    w = create(setup_workflow, count=1)
    _, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert tasks[w["tasks"][0]["id"]]["withdraw"]["reason"] == "last_required_task"
    with pytest.raises(HTTPException) as err:
        setup_workflow[-1]("withdraw", {}, w["id"], w["tasks"][0]["id"])
    assert err.value.detail["code"] == "last_required_task"


def test_finish_needs_separate_goal_and_objective_acceptance(setup_workflow):
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    e, ref = submit_result(setup_workflow, w, tid)
    execute = setup_workflow[-1]
    w = execute("accept", {"evidence": ref}, w["id"], tid)
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, setup_workflow[4])
        svc.release_confirmed(e["id"], e["generation"], "exited")
    with pytest.raises(HTTPException):
        execute("finish", {}, w["id"])
    w = execute(
        "accept_goal",
        {
            "evidence": {
                "narrative": "Goal checked",
                "task_revisions": {tid: w["tasks"][0]["work_revision"]},
                "evidence_sets": [ref],
            }
        },
        w["id"],
    )
    assert w["completion"]["can_finish"]
    w = execute("finish", {}, w["id"])
    assert w["status"] == "completed"
    with pytest.raises(HTTPException):
        execute("patch", {"title": "Rewrite history"}, w["id"])


def test_nonowner_cannot_change_workflow(setup_workflow):
    w = create(setup_workflow)
    with pytest.raises(HTTPException) as err:
        setup_workflow[-1](
            "patch",
            {"title": "Other member"},
            w["id"],
            acting=ws.WorkflowActor(setup_workflow[3], True),
        )
    assert err.value.status_code == 403


def test_lost_release_clock_uses_authenticated_contact_and_same_display_predicate():
    now = datetime(2026, 10, 25, 11, 0, tzinfo=timezone.utc)
    e = {
        "state": "stopping",
        "first_stop_at": now,
        "last_runner_contact_at": now - timedelta(hours=1),
    }
    t = {"status": "not_ready", "awaiting_owner_decision": "stopped_by_owner"}
    assert release_deadline(e) == now + timedelta(minutes=30)
    assert not task_display(t, e, now=now + timedelta(minutes=29, seconds=59))[
        "release_available"
    ]
    assert task_display(t, e, now=now + timedelta(minutes=30))["release_available"]
    e["last_runner_contact_at"] = now + timedelta(minutes=10)
    assert release_deadline(e) == now + timedelta(minutes=40)
    assert not task_display(t, e, now=now + timedelta(minutes=30))["release_available"]


@pytest.mark.asyncio
async def test_disabled_capability_blocks_write_even_with_spoofed_human(
    client, setup_workflow, monkeypatch
):
    monkeypatch.setattr(ws, "WORKFLOWS_INTEGRATED", False)
    cid = setup_workflow[0]
    response = await client.post(
        f"/api/containers/{cid}/workflows",
        json={"title": "Spoof", "goal": "No", "idempotency_key": "spoof"},
        headers={"X-Auth-Request-User": "owner"},
    )
    assert (
        response.status_code == 503
        and response.json()["detail"]["code"] == "integration_required"
    )


@pytest.mark.asyncio
async def test_local_member_can_create_and_proxy_identity_ignores_local_claim(
    client, setup_workflow, monkeypatch
):
    cid = setup_workflow[0]
    owner = setup_workflow[1].id
    other = setup_workflow[3]
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    monkeypatch.delenv("ORCHA_BIND", raising=False)
    response = await client.post(
        f"/api/containers/{cid}/workflows",
        json={"title": "Local", "goal": "A local result", "idempotency_key": "local"},
        headers={"X-Orcha-Local-Actor": owner},
    )
    assert response.status_code == 201, response.text
    assert response.json()["owner_human_id"] == owner

    monkeypatch.setenv("ORCHA_BIND", "lan")
    response = await client.post(
        f"/api/containers/{cid}/workflows",
        json={"title": "LAN", "goal": "A LAN result", "idempotency_key": "lan"},
        headers={
            "Host": "192.168.1.20",
            "Origin": "http://192.168.1.20",
            "X-Orcha-Local-Actor": owner,
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["owner_human_id"] == owner

    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    response = await client.post(
        f"/api/containers/{cid}/workflows",
        json={"title": "Hosted", "goal": "A hosted result", "idempotency_key": "hosted"},
        headers={
            "Host": "localhost",
            "Origin": "http://localhost",
            "X-Orcha-Local-Actor": other,
            "X-Auth-Request-User": "owner",
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["owner_human_id"] == owner


@pytest.mark.asyncio
async def test_local_workflow_claim_allows_local_and_lan_but_rejects_invalid_members(
    client, setup_workflow, monkeypatch
):
    cid, owner, worker, _, _, _ = setup_workflow
    viewer, other_cid, outsider = uid(), uid(), uid()
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO containers(id,name) VALUES (%s,'Other project')", (other_cid,))
        cur.execute(
            "INSERT INTO agents(id,container_id,alias,role,kind,member_role) VALUES (%s,%s,'Viewer','test','human','viewer')",
            (viewer, cid),
        )
        cur.execute(
            "INSERT INTO agents(id,container_id,alias,role,kind,member_role) VALUES (%s,%s,'Outsider','test','human','owner')",
            (outsider, other_cid),
        )
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    monkeypatch.delenv("ORCHA_BIND", raising=False)
    monkeypatch.delenv("WORKFLOWS_FLEXIBLE", raising=False)
    local = {}

    for actor_id, reason in [
        (worker, "human_required"),
        (viewer, "verified_member_required"),
        (outsider, "verified_member_required"),
    ]:
        response = await client.get(
            f"/api/containers/{cid}/workflows/capability",
            headers={**local, "X-Orcha-Local-Actor": actor_id},
        )
        assert response.status_code == 200
        assert response.json() == {
            "workflow_read": True,
            "workflow_human_write": False,
            "reason": reason,
            "flexible_workflows": False,
            "semantics_versions_supported": [1],
        }

    for bind, headers in [
        (None, {"X-Orcha-Local-Actor": owner.id}),
        ("loopback", {"Host": "localhost", "X-Orcha-Local-Actor": owner.id}),
        (
            "lan",
            {
                "Host": "192.168.1.20",
                "Origin": "http://192.168.1.20",
                "X-Orcha-Local-Actor": owner.id,
            },
        ),
    ]:
        if bind is None:
            monkeypatch.delenv("ORCHA_BIND", raising=False)
        else:
            monkeypatch.setenv("ORCHA_BIND", bind)
        response = await client.get(
            f"/api/containers/{cid}/workflows/capability", headers=headers
        )
        assert response.json() == {
            "workflow_read": True,
            "workflow_human_write": True,
            "reason": None,
            "flexible_workflows": False,
            "semantics_versions_supported": [1],
        }

    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.delenv("ORCHA_BIND", raising=False)
    response = await client.get(
        f"/api/containers/{cid}/workflows/capability",
        headers={**local, "X-Orcha-Local-Actor": owner.id},
    )
    assert response.json()["reason"] == "verified_sign_in_required"


@pytest.mark.asyncio
async def test_workflow_plan_decision_requires_local_live_non_viewer(
    client, setup_workflow, monkeypatch
):
    cid, owner, worker, _, _, _ = setup_workflow
    workflow = create(setup_workflow, count=1)
    task_id = workflow["tasks"][0]["id"]
    viewer, retired = uid(), uid()
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO agents(id,container_id,alias,role,kind,member_role) VALUES (%s,%s,'Viewer','test','human','viewer')",
            (viewer, cid),
        )
        cur.execute(
            """INSERT INTO agents(id,container_id,alias,role,kind,member_role,terminated_at)
               VALUES (%s,%s,'Retired','test','human','owner',now())""",
            (retired, cid),
        )
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    monkeypatch.setenv("ORCHA_BIND", "lan")
    local = {"Host": "192.168.1.20", "Origin": "http://192.168.1.20"}

    def decision(actor_id):
        return {
            "subject_type": "plan_approval",
            "subject_id": task_id,
            "decision": "approve",
            "actor_agent_id": actor_id,
            "target_agent_id": worker,
        }

    for actor_id in (viewer, retired):
        response = await client.post(
            "/api/decisions", json=decision(actor_id), headers=local
        )
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "verified_member_required"

    response = await client.post(
        "/api/decisions",
        json=decision(owner.id),
        headers={**local, "X-Orcha-Local-Actor": viewer},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "actor_mismatch"

    response = await client.post(
        "/api/decisions", json=decision(owner.id), headers=local
    )
    assert response.status_code == 201, response.text


def admission_fixture():
    w = {
        "status": "active",
        "container_status": "active",
        "owner_live": True,
        "launch_enabled": True,
        "execution_mode": "parallel",
        "limit_reached": False,
    }
    tasks = {
        name: {
            "id": name,
            "title": name,
            "priority": i,
            "created_at": "2026-01-01",
            "work_revision": 1,
            "preparation_state": "prepared",
            "start_hold": False,
            "status": "ready",
        }
        for i, name in enumerate(["build", "independent", "review", "review2"])
    }
    tasks["build"]["status"] = "completed"
    acceptances = {
        "build": {"work_revision": 1, "actor_kind": "human", "evidence_valid": True}
    }
    deps = {"build": [], "independent": [], "review": ["build"], "review2": ["build"]}
    available = {tid: {"available": True} for tid in tasks}
    return w, tasks, deps, acceptances, [], {}, available


def test_ready_exclusive_candidate_closes_parallel_admission_without_starving():
    args = admission_fixture()
    result = workflow_eligibility(*args)
    assert result["review"]["can_start"]
    assert not result["review2"]["can_start"] and not result["independent"]["can_start"]
    args[-1]["review"] = {"available": False}
    args[-1]["review2"] = {"available": False}
    assert workflow_eligibility(*args)["independent"]["can_start"]


def test_dependent_task_waits_for_shared_turns_and_cancellation_never_resolves_dependency():
    args = admission_fixture()
    args[4].append(
        {"task_id": "independent", "state": "awaiting_review", "exclusive": False}
    )
    assert not workflow_eligibility(*args)["review"]["can_start"]
    args[4].clear()
    args[1]["build"]["status"] = "cancelled"
    assert not workflow_eligibility(*args)["review"]["can_start"]
    assert workflow_eligibility(*args)["independent"]["can_start"]


def test_independent_tasks_can_overlap_only_in_parallel_mode():
    args = admission_fixture()
    args[2]["review"] = []
    args[2]["review2"] = []
    assert sum(row["can_start"] for row in workflow_eligibility(*args).values()) == 3
    args[0]["execution_mode"] = "serial"
    assert sum(row["can_start"] for row in workflow_eligibility(*args).values()) == 1


def test_concurrent_serial_reservations_have_one_winner(setup_workflow):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    w = prepare_and_start(setup_workflow, create(setup_workflow))
    actor = ws.WorkflowActor(setup_workflow[2], True, True)
    barrier = Barrier(2)

    def reserve(task):
        barrier.wait(timeout=5)
        try:
            with db_cursor() as (_, cur):
                return ws.WorkflowService(cur, setup_workflow[4]).reserve_turn(
                    task["id"], actor, run_id=uid()
                )["id"]
        except HTTPException:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, w["tasks"]))
    assert sum(result is not None for result in results) == 1
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT count(*) AS n FROM workflow_executions WHERE state='reserved'"
        )
        assert cur.fetchone()["n"] == 1


def test_concurrent_imports_cannot_overwrite_membership(setup_workflow):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    cid, actor, worker, _, hooks, execute = setup_workflow
    tid = uid()
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO tasks(id,container_id,title,definition_of_done,status) VALUES (%s,%s,'Import','Done','ready')",
            (tid, cid),
        )
    workflows = [create(setup_workflow, count=0) for _ in range(2)]
    with db_cursor(readonly=True) as (_, cur):
        preview = ws.WorkflowService(cur, hooks).preview_import(cid, [tid])
    barrier = Barrier(2)

    def take(w):
        barrier.wait(timeout=5)
        try:
            execute(
                "import",
                {"task_ids": [tid], "preview_digest": preview["preview_digest"]},
                w["id"],
            )
            return w["id"]
        except HTTPException:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(take, workflows))
    winner = next(x for x in results if x)
    assert sum(x is not None for x in results) == 1
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT workflow_id FROM tasks WHERE id=%s", (tid,))
        assert str(cur.fetchone()["workflow_id"]) == winner


def test_move_requires_closed_component_and_allows_human_source_owner(setup_workflow):
    _, _, _, other, _, execute = setup_workflow
    source = create(setup_workflow, dependencies={1: ["t0"]})
    dest = create(setup_workflow, count=0)
    with db_cursor() as (_, cur):
        cur.execute(
            "UPDATE workflows SET owner_human_id=%s WHERE id=%s",
            (other, dest["id"]),
        )
    ids = [t["id"] for t in source["tasks"]]
    body = {
        "task_ids": ids[:1],
        "destination_workflow_id": dest["id"],
        "destination_revision": dest["revision"],
    }
    with pytest.raises(HTTPException) as err:
        execute("move", body, source["id"])
    assert err.value.detail["code"] == "dependency_closure"
    with pytest.raises(HTTPException) as err:
        execute(
            "move",
            {**body, "task_ids": ids},
            source["id"],
            acting=ws.WorkflowActor(other, True),
        )
    assert err.value.detail["code"] == "workflow_owner_required"
    source = execute("move", {**body, "task_ids": ids}, source["id"])
    assert not source["tasks"]
    with db_cursor(readonly=True) as (_, cur):
        detail = ws.WorkflowService(cur, setup_workflow[4]).detail(dest["id"])
        assert {t["id"] for t in detail["tasks"]} == set(ids)
        assert all(t["start_hold"] for t in detail["tasks"])
        # created and received can share a timestamp tick; assert presence, not tie order
        assert "workflow_tasks_received" in {a["event"] for a in detail["activity"]}


def test_workflow_draft_preview_is_read_only_and_binds_new_task_content(setup_workflow):
    cid, _, worker, _, hooks, execute = setup_workflow
    draft = {
        "title": "Draft",
        "goal": "Goal",
        "tasks": [{"client_key": "one", "title": "One", "assignee_id": worker}],
    }
    with db_cursor(readonly=True) as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        preview = svc.preview_draft(cid, draft)
        assert svc.one("SELECT count(*) AS n FROM workflows")["n"] == 0
    with pytest.raises(HTTPException) as err:
        execute(
            "create",
            {**draft, "title": "Changed", "preview_digest": preview["preview_digest"]},
        )
    assert err.value.detail["code"] == "preview_changed"
    created = execute("create", {**draft, "preview_digest": preview["preview_digest"]})
    assert created["created_task_ids"]["one"] == created["tasks"][0]["id"]


def test_retained_project_history_does_not_consume_the_workflow_task_limit(
    setup_workflow,
):
    cid, _, worker, _, _, execute = setup_workflow
    with db_cursor() as (_, cur):
        cur.execute("UPDATE containers SET max_tasks=200 WHERE id=%s", (cid,))
        for index in range(205):
            cur.execute(
                "INSERT INTO tasks(id,container_id,title,definition_of_done,status) "
                "VALUES (%s,%s,%s,'Retained result',%s)",
                (
                    uid(),
                    cid,
                    f"Retained task {index}",
                    "completed" if index % 2 == 0 else "cancelled",
                ),
            )

    workflow = create(setup_workflow, count=1)
    actions = {row["action"]: row for row in workflow["available_actions"]}
    assert actions["add_tasks"]["enabled"]
    assert actions["import"]["enabled"]

    workflow = execute("patch", {"task_limit": 1}, workflow["id"])
    assert workflow["task_limit"] == 1
    with pytest.raises(HTTPException) as err:
        execute(
            "add_tasks",
            {
                "tasks": [
                    {
                        "client_key": "over-workflow-limit",
                        "title": "One task too many",
                        "definition_of_done": "A concrete result",
                        "assignee_id": worker,
                    }
                ]
            },
            workflow["id"],
        )
    assert err.value.detail["code"] == "task_limit"


@pytest.mark.asyncio
async def test_workflow_task_search_is_bounded_selected_and_project_authorized(
    client, setup_workflow, monkeypatch
):
    cid = setup_workflow[0]
    selected_id = uid()
    other_cid, other_task = uid(), uid()
    with db_cursor() as (_, cur):
        for index in range(8):
            task_id = selected_id if index == 3 else uid()
            cur.execute(
                "INSERT INTO tasks(id,container_id,title,definition_of_done,status) "
                "VALUES (%s,%s,%s,'Searchable','ready')",
                (task_id, cid, f"Search match {index}"),
            )
        cur.execute(
            "INSERT INTO containers(id,name) VALUES (%s,'Other project')", (other_cid,)
        )
        cur.execute(
            "INSERT INTO tasks(id,container_id,title,definition_of_done,status) "
            "VALUES (%s,%s,'Search match elsewhere','Searchable','ready')",
            (other_task, other_cid),
        )

    url = f"/api/containers/{cid}/workflow-task-search"
    response = await client.get(
        url,
        params=[
            ("query", "Search match"),
            ("selected", selected_id),
            ("selected", other_task),
        ],
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["results"]) == 5
    assert [row["id"] for row in payload["selected"]] == [selected_id]
    assert selected_id not in {row["id"] for row in payload["results"]}
    assert all(row["title"].startswith("Search match") for row in payload["results"])

    empty = await client.get(
        url, params=[("query", "no such task"), ("selected", selected_id)]
    )
    assert empty.status_code == 200
    assert empty.json()["results"] == []
    assert [row["id"] for row in empty.json()["selected"]] == [selected_id]

    literal_wildcard = await client.get(url, params={"query": "%"})
    assert literal_wildcard.status_code == 200
    assert literal_wildcard.json()["results"] == []
    over_limit = await client.get(url, params={"query": "Search", "limit": 6})
    assert over_limit.status_code == 422

    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    refused = await client.get(
        url, headers={"X-Auth-Request-User": "not-a-project-member"}
    )
    assert refused.status_code == 403
    allowed = await client.get(url, headers={"X-Auth-Request-User": "owner"})
    assert allowed.status_code == 200


@pytest.mark.asyncio
async def test_workflow_task_search_returns_string_ids_for_workflow_owned_tasks(
    client, setup_workflow
):
    # PostgreSQL hands back UUID objects; both lists must reach the string schema.
    cid = setup_workflow[0]
    w = create(setup_workflow, count=2)
    chosen, other = w["tasks"][0], w["tasks"][1]
    response = await client.get(
        f"/api/containers/{cid}/workflow-task-search",
        params=[("query", "Task"), ("selected", chosen["id"])],
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["selected"] == [
        {
            "id": chosen["id"],
            "title": chosen["title"],
            "status": payload["selected"][0]["status"],
            "is_root": False,
            "workflow_id": w["id"],
        }
    ]
    assert [row["id"] for row in payload["results"]] == [other["id"]]
    assert payload["results"][0]["workflow_id"] == w["id"]
    for row in payload["selected"] + payload["results"]:
        assert isinstance(row["id"], str)
        assert isinstance(row["workflow_id"], str)


def test_review_rounds_are_fresh_acyclic_pairs_and_receipt_replay_is_exact(
    setup_workflow,
):
    cid, actor, worker, _, hooks, execute = setup_workflow
    w = prepare_and_start(
        setup_workflow, create(setup_workflow, dependencies={1: ["t0"]})
    )
    by_title = {t["title"]: t for t in w["tasks"]}
    build, review = by_title["Task 0"], by_title["Task 1"]
    e, ref = submit_result(setup_workflow, w, build["id"])
    execute("accept", {"evidence": ref}, w["id"], build["id"])
    with db_cursor() as (_, cur):
        ws.WorkflowService(cur, hooks).release_confirmed(
            e["id"], e["generation"], "exited"
        )
    body = {
        "loop_key": "release",
        "review_task_id": review["id"],
        "reviewed_task_id": build["id"],
        "reviewed_artifact": ref,
        "outcome": "changes_requested",
        "correction": {
            "client_key": "fix",
            "title": "Fix feedback",
            "definition_of_done": "Address report",
            "assignee_id": worker,
        },
        "next_review": {
            "client_key": "again",
            "title": "Review again",
            "definition_of_done": "Review correction",
            "assignee_id": worker,
        },
        "idempotency_key": "round-one",
    }
    with db_cursor(readonly=True) as (_, cur):
        body["expected_revision"] = ws.WorkflowService(cur, hooks).workflow(w["id"])[
            "revision"
        ]
    out = execute("review_round", body, w["id"])
    assert execute("review_round", body, w["id"]) == out
    assert len(out["tasks"]) == 4 and len(out["review_rounds"]) == 2
    recorded, waiting = sorted(out["review_rounds"], key=lambda r: r["round_number"])
    # The recorded outcome names the exact task and work revision it judged (server-side).
    built = next(t for t in out["tasks"] if t["id"] == build["id"])
    assert recorded["reviewed_task_id"] == build["id"]
    assert recorded["reviewed_work_revision"] == built["work_revision"]
    assert recorded["reviewed_artifact"] == ref
    # A round still waiting for its review has not judged anything yet.
    assert waiting["outcome"] is None
    assert (waiting["reviewed_task_id"], waiting["reviewed_work_revision"]) == (
        None,
        None,
    )
    with pytest.raises(Exception):
        with db_cursor() as (_, cur):
            cur.execute(
                "UPDATE workflow_review_rounds SET outcome='accepted' WHERE id=%s",
                (waiting["id"],),
            )
    tasks = {t["title"]: t for t in out["tasks"]}
    assert tasks["Fix feedback"]["depends_on"] == [review["id"]]
    assert tasks["Review again"]["depends_on"] == [tasks["Fix feedback"]["id"]]
    validate_graph(
        {t["id"] for t in out["tasks"]},
        {t["id"]: t["depends_on"] for t in out["tasks"]},
    )


@pytest.mark.parametrize(
    "reached,other,too_low,raised",
    [
        ("task_limit", "round_limit", 3, 4),
        ("round_limit", "task_limit", 1, 2),
    ],
)
def test_limit_gate_clears_only_when_the_reached_limit_is_raised(
    setup_workflow, reached, other, too_low, raised
):
    cid, actor, worker, _, hooks, execute = setup_workflow
    w = prepare_and_start(
        setup_workflow, create(setup_workflow, dependencies={1: ["t0"]})
    )
    w = execute("patch", {reached: too_low}, w["id"])
    by_title = {t["title"]: t for t in w["tasks"]}
    build, review = by_title["Task 0"], by_title["Task 1"]
    e, ref = submit_result(setup_workflow, w, build["id"])
    execute("accept", {"evidence": ref}, w["id"], build["id"])
    with db_cursor() as (_, cur):
        ws.WorkflowService(cur, hooks).release_confirmed(
            e["id"], e["generation"], "exited"
        )
    out = execute(
        "review_round",
        {
            "loop_key": "release",
            "review_task_id": review["id"],
            "reviewed_task_id": build["id"],
            "reviewed_artifact": ref,
            "outcome": "changes_requested",
            "correction": {
                "client_key": "fix",
                "title": "Fix feedback",
                "definition_of_done": "Address report",
                "assignee_id": worker,
            },
            "next_review": {
                "client_key": "again",
                "title": "Review again",
                "definition_of_done": "Review correction",
                "assignee_id": worker,
            },
        },
        w["id"],
    )
    # Another round, or one more correction/review pair, would pass the limit:
    # nothing is added and the still-Active workflow shows the named gate.
    assert out["status"] == "active" and out["limit_reached"] is True
    assert len(out["tasks"]) == 2
    # Raising the other limit, or re-saving the reached one, leaves the gate.
    out = execute("patch", {other: 9}, w["id"])
    assert out["limit_reached"] is True
    out = execute("patch", {reached: too_low}, w["id"])
    assert out["limit_reached"] is True
    out = execute("patch", {reached: raised}, w["id"])
    assert out["limit_reached"] is False


def test_inconclusive_review_is_replaced_only_after_the_review_is_retried(
    setup_workflow,
):
    _, _, _, _, hooks, execute = setup_workflow
    w = prepare_and_start(
        setup_workflow, create(setup_workflow, dependencies={1: ["t0"]})
    )
    by_title = {t["title"]: t for t in w["tasks"]}
    build, review = by_title["Task 0"], by_title["Task 1"]
    for tid in (build["id"], review["id"]):
        e, ref = submit_result(setup_workflow, w, tid)
        execute("accept", {"evidence": ref}, w["id"], tid)
        with db_cursor() as (_, cur):
            ws.WorkflowService(cur, hooks).release_confirmed(
                e["id"], e["generation"], "exited"
            )
        if tid == build["id"]:
            built = ref

    def record(outcome, key):
        body = {
            "loop_key": "release",
            "review_task_id": review["id"],
            "reviewed_task_id": build["id"],
            "reviewed_artifact": built,
            "outcome": outcome,
            "idempotency_key": key,
        }
        with db_cursor(readonly=True) as (_, cur):
            body["expected_revision"] = ws.WorkflowService(cur, hooks).workflow(
                w["id"]
            )["revision"]
        return execute("review_round", body, w["id"])

    out = record("inconclusive", "broken")
    (first,) = out["review_rounds"]
    assert (first["outcome"], first["review_work_revision"]) == (
        "inconclusive",
        review["work_revision"],
    )
    # The same review run cannot be re-judged; it must be retried first.
    with pytest.raises(HTTPException) as err:
        record("accepted", "same-run")
    assert err.value.detail["code"] == "review_outcome_recorded"
    execute("retry", {}, w["id"], review["id"])
    out = record("accepted", "after-retry")
    (again,) = out["review_rounds"]
    assert again["id"] == first["id"] and again["outcome"] == "accepted"
    assert again["review_work_revision"] == review["work_revision"] + 1
    # A conclusive outcome is never replaced, even after another retry.
    e, ref = submit_result(setup_workflow, w, review["id"])
    execute("accept", {"evidence": ref}, w["id"], review["id"])
    with db_cursor() as (_, cur):
        ws.WorkflowService(cur, hooks).release_confirmed(
            e["id"], e["generation"], "exited"
        )
    execute("retry", {}, w["id"], review["id"])
    with pytest.raises(HTTPException) as err:
        record("changes_requested", "late")
    assert err.value.detail["code"] == "review_outcome_recorded"
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT detail FROM workflow_history WHERE workflow_id=%s AND event='workflow_review_outcome' ORDER BY created_at,id",
            (w["id"],),
        )
        history = [
            p if isinstance(p, dict) else json.loads(p)
            for p in (r["detail"] for r in cur.fetchall())
        ]
    assert [(h["outcome"], h["replaced_outcome"]) for h in history] == [
        ("inconclusive", None),
        ("accepted", "inconclusive"),
    ]


def test_objective_edit_invalidates_its_acceptance_and_goal(setup_workflow):
    _, _, _, _, _, execute = setup_workflow
    w = execute(
        "create",
        {
            "title": "Objectives",
            "goal": "Goal",
            "objectives": [{"title": "Tested", "criteria": "Tests pass"}],
        },
    )
    oid = w["objectives"][0]["id"]
    basis = {"narrative": "Checked"}
    w = execute("accept_objective", {"objective_id": oid, "evidence": basis}, w["id"])
    w = execute("accept_goal", {"evidence": basis}, w["id"])
    assert w["progress"]["objectives_accepted"] == 1
    w = execute(
        "edit_objective",
        {"objective_id": oid, "title": "Tested", "criteria": "Additional checks pass"},
        w["id"],
    )
    assert (
        w["progress"]["objectives_accepted"] == 0
        and w["goal_accepted_revision"] is None
    )


def test_replay_of_accepted_result_never_rebinds_evidence_after_retry(setup_workflow):
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    e, ref = submit_result(setup_workflow, w, tid)
    execute = setup_workflow[-1]
    w = execute("accept", {"evidence": ref}, w["id"], tid)
    with db_cursor() as (_, cur):
        ws.WorkflowService(cur, setup_workflow[4]).release_confirmed(
            e["id"], e["generation"], "exited"
        )
    w = execute("retry", {}, w["id"], tid)
    assert w["progress"]["accepted"] == 0
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT evidence_set_id,work_revision FROM workflow_task_acceptances WHERE task_id=%s",
            (tid,),
        )
        old = cur.fetchone()
        assert (
            str(old["evidence_set_id"]) == ref["evidence_set_id"]
            and old["work_revision"] < w["tasks"][0]["work_revision"]
        )


def test_owner_replaces_only_current_missing_evidence_after_worker_ends(setup_workflow):
    cid, actor, worker, other, hooks, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    with db_cursor() as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        e = svc.reserve_turn(tid, ws.WorkflowActor(worker, True, True), run_id=uid())
        old = hooks.save(svc.task(w["id"], tid))
        cur.execute(
            "UPDATE workflow_executions SET state='running',current_evidence_set_id=%s,evidence_state='saved' WHERE id=%s",
            (old["evidence_set_id"], e["id"]),
        )
    basis = {"narrative": "Replacement from the saved files"}

    def refused(code, **kw):
        with pytest.raises(HTTPException) as err:
            execute("add_evidence", {"evidence": basis}, w["id"], tid, **kw)
        assert err.value.detail["code"] == code

    refused("missing_evidence_required")
    with db_cursor() as (_, cur):
        cur.execute(
            "UPDATE workflow_executions SET evidence_state='missing' WHERE id=%s",
            (e["id"],),
        )
    refused("worker_live")
    now = ws.sql.utcnow()
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO worker_runs(run_id,agent_id,status,started_at,ended_at) VALUES (%s,%s,'exited',%s,%s)",
            (e["run_id"], worker, now, now),
        )
    refused("workflow_owner_required", acting=ws.WorkflowActor(other, True))
    w = execute("add_evidence", {"evidence": basis}, w["id"], tid)
    assert [c[:2] for c in hooks.owner_captures] == [(tid, actor.id)]
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT current_evidence_set_id,evidence_state FROM workflow_executions WHERE id=%s",
            (e["id"],),
        )
        row = cur.fetchone()
        assert str(row["current_evidence_set_id"]) != old["evidence_set_id"]
        assert row["evidence_state"] == "saved"
        cur.execute(
            "SELECT COUNT(*) AS n FROM workflow_task_acceptances WHERE task_id=%s",
            (tid,),
        )
        assert cur.fetchone()["n"] == 0
        cur.execute(
            "SELECT detail FROM workflow_history WHERE task_id=%s AND event='workflow_evidence_replaced'",
            (tid,),
        )
        assert cur.fetchone()
    refused("missing_evidence_required")


def test_owner_evidence_replacement_refuses_finished_or_stale_basis(setup_workflow):
    cid, actor, worker, other, hooks, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=2))
    first, second = (t["id"] for t in w["tasks"])
    stale = {
        "narrative": "Uses the other task",
        "task_revisions": {second: 999},
    }
    with pytest.raises(HTTPException) as err:
        execute("add_evidence", {"evidence": stale}, w["id"], first)
    assert err.value.detail["code"] in {
        "evidence_version_stale",
        "missing_evidence_required",
    }
    e, ref = submit_result(setup_workflow, w, first)
    w = execute("accept", {"evidence": ref}, w["id"], first)
    with pytest.raises(HTTPException) as err:
        execute("add_evidence", {"evidence": {"narrative": "late"}}, w["id"], first)
    assert err.value.detail["code"] == "task_terminal"
    assert hooks.owner_captures == []


def test_completed_import_needs_explicit_human_acceptance_of_exact_result(
    setup_workflow,
):
    cid, actor, worker, other, hooks, execute = setup_workflow
    done, empty = uid(), uid()
    with db_cursor() as (_, cur):
        shipped = json.dumps({"result": "Shipped build 1.2", "by_agent_id": None})
        for tid, result in [(done, shipped), (empty, None)]:
            cur.execute(
                "INSERT INTO tasks(id,container_id,title,definition_of_done,status,result) VALUES (%s,%s,%s,'A result','completed',%s)",
                (tid, cid, "Done " + tid[:4], result),
            )
    w = create(setup_workflow, count=0)
    with db_cursor(readonly=True) as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        blocked = svc.preview_import(cid, [empty])
        assert [b["code"] for b in blocked["blockers"]] == ["import_result_missing"]
        preview = svc.preview_import(cid, [done])
    impact = preview["task_impacts"][0]
    assert impact["requires_acceptance"] and impact[
        "result_digest"
    ] == ws.result_digest({"result": "Shipped build 1.2", "by_agent_id": None})
    # The person sees the exact saved result and criteria the digest covers.
    assert (impact["result_text"], impact["definition_of_done"]) == (
        "Shipped build 1.2",
        "A result",
    )
    stale = {"task_ids": [done], "preview_digest": preview["preview_digest"]}
    with db_cursor() as (_, cur):
        cur.execute(
            "UPDATE tasks SET result=%s WHERE id=%s",
            (json.dumps({"result": "Shipped build 1.3", "by_agent_id": worker}), done),
        )
    with db_cursor(readonly=True) as (_, cur):
        preview = ws.WorkflowService(cur, hooks).preview_import(cid, [done])
    impact = preview["task_impacts"][0]
    assert preview["preview_digest"] != stale["preview_digest"]
    assert impact["result_text"] == "Shipped build 1.3"
    assert impact["result_by_agent_id"] == worker
    with db_cursor() as (_, cur):
        cur.execute(
            "UPDATE tasks SET completed_at=%s WHERE id=%s", (sql.utcnow(), done)
        )
    with db_cursor(readonly=True) as (_, cur):
        preview = ws.WorkflowService(cur, hooks).preview_import(cid, [done])
    impact = preview["task_impacts"][0]
    assert impact["completed_at"]
    with pytest.raises(HTTPException) as err:
        execute("import", dict(stale, acceptances={}), w["id"])
    assert err.value.detail["code"] == "preview_changed"
    body = {"task_ids": [done], "preview_digest": preview["preview_digest"]}

    def refused(code, acceptances):
        with pytest.raises(HTTPException) as err:
            execute("import", dict(body, acceptances=acceptances), w["id"])
        assert err.value.detail["code"] == code
        with db_cursor(readonly=True) as (_, cur):
            cur.execute("SELECT workflow_id FROM tasks WHERE id=%s", (done,))
            assert cur.fetchone()["workflow_id"] is None

    basis = {"narrative": "I read the shipped build notes"}
    refused("import_acceptance_required", {})
    refused(
        "import_result_changed",
        {done: {"reviewed_result_digest": "b" * 64, "evidence": basis}},
    )
    w = execute(
        "import",
        dict(
            body,
            acceptances={
                done: {
                    "reviewed_result_digest": impact["result_digest"],
                    "evidence": basis,
                }
            },
        ),
        w["id"],
    )
    assert hooks.import_captures == [(done, actor.id, impact["result_digest"])]
    assert w["progress"]["accepted"] == 1
    acceptance = w["tasks"][0]["acceptance"]
    assert acceptance["actor_alias"] == "Owner"
    assert acceptance["actor_kind"] == "human"
    assert acceptance["work_revision"] == w["tasks"][0]["work_revision"]
    assert acceptance["autonomy_at_acceptance"] == "off"
    assert acceptance["acceptance_source"] == "import"
    assert acceptance["evidence_set_id"]
    assert acceptance["evidence_items"][0]["sha256"] == "a" * 64
    assert acceptance["evidence_items"][0]["captured_by"] == actor.id
    assert acceptance["evidence_items"][0]["captured_by_alias"] == "Owner"
    assert acceptance["evidence_items"][0]["captured_by_kind"] == "human"
    assert acceptance["evidence_items"][0]["source"] == "import"
    assert acceptance["evidence_items"][0]["kind"] == "import_result"
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT actor_id,actor_kind,acceptance_source FROM workflow_task_acceptances WHERE task_id=%s",
            (done,),
        )
        row = cur.fetchone()
        assert (str(row["actor_id"]), row["actor_kind"], row["acceptance_source"]) == (
            actor.id,
            "human",
            "import",
        )
        cur.execute(
            "SELECT source_kind,state,run_id,evidence_state FROM workflow_executions WHERE task_id=%s",
            (done,),
        )
        e = cur.fetchone()
        assert (e["source_kind"], e["state"], e["run_id"], e["evidence_state"]) == (
            "import_review",
            "released",
            None,
            "saved",
        )


def actions_for(fixture, wid, acting, hooks=None):
    """(workflow actions, {task_id: task actions}, {objective_id: actions}) by name."""
    with db_cursor(readonly=True) as (_, cur):
        w = ws.WorkflowService(cur, hooks or fixture[4]).detail(wid, acting)
    by_name = lambda items: {a["action"]: a for a in items}
    return (
        by_name(w["available_actions"]),
        {t["id"]: by_name(t["available_actions"]) for t in w["tasks"]},
        {o["id"]: by_name(o["available_actions"]) for o in w["objectives"]},
    )


def test_actions_split_workflow_owner_from_project_owner_safety_hold(setup_workflow):
    _, project_owner, worker, other, _, execute = setup_workflow
    w = create(setup_workflow, count=2, dependencies={1: ["t0"]})
    a, b = (w["created_task_ids"][k] for k in ("t0", "t1"))
    w = execute("transfer_owner", {"new_owner_id": other}, w["id"])
    workflow_owner = ws.WorkflowActor(other, True)
    for t in (a, b):
        w = execute("prepare", {}, w["id"], t, acting=workflow_owner)

    wf, tasks, _ = actions_for(setup_workflow, w["id"], project_owner)
    # A project owner keeps only safety-hold and ownership recovery authority.
    assert wf["transfer_owner"]["enabled"]
    assert wf["transfer_owner"]["permission"] == "workflow_or_project_owner"
    for name in ("start", "patch", "finish", "cancel", "accept_goal", "move"):
        assert wf[name]["reason"] == "workflow_owner_required", name
    assert tasks[a]["hold"]["enabled"]
    assert tasks[a]["hold"]["permission"] == "workflow_or_project_owner"
    for name in ("stop", "reissue_stop", "release_lost_worker", "withdraw", "retry"):
        assert tasks[a][name]["permission"] == "workflow_owner", name
        assert tasks[a][name]["reason"] == "workflow_owner_required", name
    # The start hold belongs to the workflow owner, never to a project owner.
    assert tasks[a]["release"] == {
        "action": "release",
        "enabled": False,
        "reason": "hold_owner_required",
        "permission": "workflow_or_project_owner",
        "holds": [],
    }

    w = execute("hold", {}, w["id"], a, acting=project_owner)
    _, tasks, _ = actions_for(setup_workflow, w["id"], project_owner)
    assert tasks[a]["release"]["enabled"] and tasks[a]["release"]["holds"] == ["human"]
    assert tasks[a]["hold"]["enabled"]  # re-saving one's own hold reason
    _, by_workflow_owner, _ = actions_for(setup_workflow, w["id"], workflow_owner)
    # Before Start only Start lifts start holds (§14.1), so only the safety hold is offered.
    assert by_workflow_owner[a]["release"]["holds"] == ["human"]

    revision = next(t["work_revision"] for t in w["tasks"] if t["id"] == a)
    release = {"task_ids": [a], "task_revisions": {a: revision}}
    with pytest.raises(HTTPException) as err:
        execute(
            "release", dict(release, holds=["start"]), w["id"], acting=project_owner
        )
    assert err.value.detail["code"] == "workflow_owner_required"
    w = execute(
        "release", dict(release, holds=["human"]), w["id"], acting=project_owner
    )
    _, tasks, _ = actions_for(setup_workflow, w["id"], project_owner)
    assert tasks[a]["release"]["reason"] == "hold_owner_required"

    # Another person's hold blocks a second hold, matching op_hold.
    w = execute("hold", {}, w["id"], b, acting=workflow_owner)
    _, tasks, _ = actions_for(setup_workflow, w["id"], project_owner)
    assert tasks[b]["hold"]["reason"] == "hold_exists"
    assert tasks[b]["release"]["reason"] == "hold_owner_required"


def test_actions_match_server_refusals_for_scope_and_evidence(setup_workflow):
    execute = setup_workflow[-1]
    w = create(setup_workflow, count=3, dependencies={1: ["t0"]})
    a, b, c = (w["created_task_ids"][k] for k in ("t0", "t1", "t2"))
    wf, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert tasks[a]["withdraw"]["reason"] == "task_has_dependents"
    with pytest.raises(HTTPException) as err:
        execute("withdraw", {}, w["id"], a)
    assert err.value.detail["code"] == "task_has_dependents"
    assert tasks[c]["withdraw"]["enabled"] and tasks[c]["dependencies"]["enabled"]
    assert tasks[c]["move"]["enabled"]
    assert tasks[a]["withdraw_evidence"]["reason"] == "evidence_not_pending"
    assert tasks[a]["add_evidence"]["reason"] == "missing_evidence_required"
    assert tasks[a]["resolve_loop"]["reason"] == "review_loop_unavailable"
    assert tasks[a]["accept"]["reason"] == "not_awaiting_review"
    assert tasks[a]["stop"]["reason"] == "no_running_worker"
    for name in ("patch", "accept_goal", "review_round", "add_tasks", "import"):
        assert wf[name]["enabled"], name
    w = execute("withdraw", {}, w["id"], c)
    _, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert tasks[c]["withdraw"]["reason"] == "withdrawal_not_allowed"
    assert tasks[c]["move"]["reason"] == "task_history_present"

    for t in (a, b):
        w = execute("prepare", {}, w["id"], t)
    revisions = {t["id"]: t["work_revision"] for t in w["tasks"] if t["id"] != c}
    w = execute("start", {"task_ids": [a, b], "task_revisions": revisions}, w["id"])
    _, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert tasks[a]["submit_outside_result"]["enabled"]
    w = execute(
        "external_result",
        {"evidence": {"narrative": "Done elsewhere"}, "produced_by": "Outside team"},
        w["id"],
        a,
    )
    _, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert tasks[a]["submit_outside_result"]["reason"] == "owner_evidence_pending"
    assert tasks[a]["withdraw_evidence"]["enabled"]
    assert tasks[a]["retry"]["reason"] == "owner_decision_required"
    assert ws.WorkflowHooks().completion_permission(None, {}, {}) == {
        "allowed": False,
        "reason": "approval_integration_required",
    }


def test_accept_and_stop_actions_follow_live_turn_and_approval_hook(setup_workflow):
    _, _, _, other, _, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    e, ref = submit_result(setup_workflow, w, tid)
    _, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert tasks[tid]["accept"]["enabled"] and tasks[tid]["reject"]["enabled"]
    assert tasks[tid]["accept"]["permission"] == "task_approval"
    assert tasks[tid]["stop"]["enabled"]
    assert tasks[tid]["hold"]["reason"] == "reservation_live"
    # Another verified human may reject; accept is decided by the approval hook.
    _, by_member, _ = actions_for(
        setup_workflow, w["id"], ws.WorkflowActor(other, True)
    )
    assert by_member[tid]["reject"]["enabled"]
    assert by_member[tid]["stop"]["reason"] == "workflow_owner_required"
    _, unintegrated, _ = actions_for(
        setup_workflow, w["id"], setup_workflow[1], hooks=ws.WorkflowHooks()
    )
    assert unintegrated[tid]["accept"]["reason"] == "approval_integration_required"
    w = execute("stop", {}, w["id"], tid)
    _, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert tasks[tid]["stop"]["reason"] == "stop_already_requested"
    assert tasks[tid]["reissue_stop"]["enabled"]
    assert tasks[tid]["release_lost_worker"]["reason"] == "release_not_yet_available"
    with pytest.raises(HTTPException) as err:
        execute("release_lost_worker", {"reason": "silent"}, w["id"], tid)
    assert err.value.detail["code"] == "release_not_yet_available"
    when = err.value.detail["release_available_at"]
    assert "T" in when and when.endswith("+00:00")


@pytest.mark.parametrize(
    "state,code", [("missing", "evidence_missing"), ("pending", "evidence_not_saved")]
)
def test_accept_requires_saved_evidence(setup_workflow, state, code):
    _, _, _, _, _, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, count=1))
    tid = w["tasks"][0]["id"]
    e, ref = submit_result(setup_workflow, w, tid)
    with db_cursor() as (_, cur):
        cur.execute(
            "UPDATE workflow_executions SET evidence_state=%s WHERE id=%s",
            (state, e["id"]),
        )
    _, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert tasks[tid]["accept"]["reason"] == code
    with pytest.raises(HTTPException) as err:
        execute("accept", {"evidence": ref}, w["id"], tid)
    assert err.value.detail["code"] == code
    with db_cursor() as (_, cur):
        cur.execute(
            "UPDATE workflow_executions SET evidence_state='saved' WHERE id=%s",
            (e["id"],),
        )
    w = execute("accept", {"evidence": ref}, w["id"], tid)
    assert next(t for t in w["tasks"] if t["id"] == tid)["status"] == "completed"


def test_actions_respect_pause_agents_objectives_and_disabled_capability(
    setup_workflow, monkeypatch
):
    cid, _, worker, _, _, execute = setup_workflow
    w = execute(
        "create",
        {
            "title": "Objectives",
            "goal": "Goal",
            "tasks": [
                {
                    "client_key": "t0",
                    "title": "Task",
                    "definition_of_done": "Result",
                    "assignee_id": worker,
                }
            ],
            "objectives": [{"title": "Tested", "criteria": "Tests pass"}],
        },
    )
    oid = w["objectives"][0]["id"]
    tid = w["tasks"][0]["id"]
    agent = ws.WorkflowActor(worker, True, True)
    wf, _, _ = actions_for(setup_workflow, w["id"], agent)
    assert wf["add_tasks"]["reason"] == "workflow_not_started"
    assert wf["review_round"]["reason"] == "workflow_not_started"
    assert wf["patch"]["reason"] == "workflow_owner_required"
    _, _, objectives = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert objectives[oid]["accept_objective"]["enabled"]
    assert objectives[oid]["edit_objective"]["enabled"]

    w = prepare_and_start(setup_workflow, w)
    wf, _, _ = actions_for(setup_workflow, w["id"], agent)
    assert wf["add_tasks"]["enabled"] and wf["review_round"]["enabled"]
    outsider = uid()
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO agents(id,container_id,alias,role,kind,member_role) VALUES (%s,%s,'Outsider','test','ai','member')",
            (outsider, cid),
        )
    wf, _, _ = actions_for(
        setup_workflow, w["id"], ws.WorkflowActor(outsider, True, True)
    )
    for name in ("add_tasks", "review_round"):
        assert wf[name]["reason"] == "workflow_participation_required", name
    w = execute("pause", {}, w["id"])
    wf, tasks, objectives = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert wf["resume"]["enabled"] and wf["patch"]["enabled"]
    for name in ("start", "finish", "add_tasks", "import", "move", "review_round"):
        assert wf[name]["reason"] == "workflow_not_active", name
    assert tasks[tid]["release"]["reason"] == "workflow_not_active"
    assert tasks[tid]["dependencies"]["reason"] == "workflow_not_active"
    assert objectives[oid]["accept_objective"]["enabled"]
    with db_cursor() as (_, cur):
        cur.execute("UPDATE containers SET status='paused' WHERE id=%s", (cid,))
    wf, tasks, _ = actions_for(setup_workflow, w["id"], setup_workflow[1])
    assert (
        wf["resume"]["reason"] == tasks[tid]["hold"]["reason"] == "project_not_active"
    )
    assert wf["transfer_owner"]["enabled"]
    with db_cursor() as (_, cur):
        cur.execute("UPDATE containers SET status='active' WHERE id=%s", (cid,))

    monkeypatch.setattr(ws, "WORKFLOWS_INTEGRATED", False)
    wf, tasks, objectives = actions_for(setup_workflow, w["id"], setup_workflow[1])
    every = [*wf.values(), *tasks[tid].values(), *objectives[oid].values()]
    assert every and all(
        not a["enabled"] and a["reason"] == "integration_required" for a in every
    )
