"""Workflow invariants on the real isolated database, plus pure admission cases.

Runtime/evidence integration belongs to separate adapters. ContractHooks replaces
those leaves only; graph, locks, revisions, receipts and lifecycle use real SQL.
"""

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

    def request_stop(self, cur, execution, actor, origin, reason):
        self.stops.append((execution["id"], origin))

    def capture_outside(self, cur, task, evidence, execution):
        return self.save(task)

    def save(self, task):
        ref = {
            "evidence_set_id": uid(),
            "items": [
                {
                    "item_id": uid(),
                    "deliverable_id": uid(),
                    "deliverable_version": 1,
                    "sha256": "a" * 64,
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
    e, ref = submit_result(setup_workflow, w, tid)
    w = setup_workflow[-1]("accept", {"evidence": ref}, w["id"], tid)
    w = setup_workflow[-1]("cancel", {}, w["id"])
    assert w["status"] == "cancelled" and w["progress"]["accepted"] == 1
    assert w["tasks"][0]["display_state"]["label"] == "Stopping - accepted"
    with db_cursor(readonly=True) as (_, cur):
        svc = ws.WorkflowService(cur, setup_workflow[4])
        assert svc.live_turn(tid)["id"] == e["id"]


def test_withdraw_cannot_remove_last_or_accepted_task(setup_workflow):
    w = create(setup_workflow, count=1)
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
async def test_local_human_id_is_never_identity_and_proxy_member_works(
    client, setup_workflow, monkeypatch
):
    cid = setup_workflow[0]
    body = {"title": "Create", "goal": "A result", "idempotency_key": "create"}
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    response = await client.post(
        f"/api/containers/{cid}/workflows",
        json=body,
        headers={"X-Auth-Request-User": "owner"},
    )
    assert response.status_code == 403
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    response = await client.post(
        f"/api/containers/{cid}/workflows",
        json=body,
        headers={"X-Auth-Request-User": "owner"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["owner_human_id"] == setup_workflow[1].id
