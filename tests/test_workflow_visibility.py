"""GH #350 (workflow redesign spec §4.14 / §7.1): reversible workflow deactivation.

Hide is a presentation state for FINISHED work: a completed or cancelled workflow with no
live worker turn leaves the usual list and ordinary task views; restore brings it back. It
never stops work, never cancels, never detaches or rewrites tasks, and restore never starts
anything. Both mutations are revision-bound, idempotent (receipts) and owner-only.
"""

import pytest
from fastapi import HTTPException

from portal_backend import workflow_service as ws
from portal_backend.database import db_cursor
from test_workflows import (  # noqa: F401 (fixture re-export)
    create,
    prepare_and_start,
    setup_workflow,
    submit_result,
    uid,
)

def local(actor_id):
    """Local (non-proxy) deployments identify the acting human by id header."""
    return {"X-Orcha-Local-Actor": actor_id}


def actions(w):
    return {a["action"]: a for a in w["available_actions"]}


def test_hide_requires_finished_workflow_and_no_live_turn(setup_workflow):
    cid, actor, _worker, _other, hooks, execute = setup_workflow
    w = create(setup_workflow)
    assert w["hidden"] is False and w["hidden_at"] is None
    hide = actions(w)["hide"]
    assert (hide["enabled"], hide["reason"], hide["permission"]) == (
        False,
        "workflow_not_finished",
        "workflow_or_project_owner",
    )
    assert actions(w)["restore"]["reason"] == "workflow_visible"
    with db_cursor(readonly=True) as (_, cur):
        check = ws.WorkflowService(cur, hooks).visibility_check(w["id"])
    assert check["can_hide"] is False and check["can_restore"] is False
    assert [b["code"] for b in check["blockers"]] == ["workflow_not_finished"]
    with pytest.raises(HTTPException) as err:
        execute("hide", {}, w["id"])
    assert err.value.detail["code"] == "workflow_not_finished"

    # A cancelled workflow whose worker has not confirmed its stop is still not hideable.
    w = prepare_and_start(setup_workflow, create(setup_workflow))
    submit_result(setup_workflow, w, w["tasks"][0]["id"])
    w = execute("cancel", {}, w["id"])
    assert w["status"] == "cancelled"
    with db_cursor(readonly=True) as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        assert svc.live_turns(w["id"]) >= 1
        check = svc.visibility_check(w["id"])
    assert check["can_hide"] is False
    assert "worker_live" in [b["code"] for b in check["blockers"]]
    assert actions(w)["hide"]["reason"] == "worker_live"


def test_hide_and_restore_keep_every_task_record_and_never_start_work(setup_workflow):
    cid, actor, worker, other, hooks, execute = setup_workflow
    w = create(setup_workflow)
    w = execute("cancel", {}, w["id"])
    before = {
        t["id"]: (t["status"], t["work_revision"], t["depends_on"]) for t in w["tasks"]
    }
    assert actions(w)["hide"]["enabled"] is True

    hidden = execute("hide", {"reason": "Superseded"}, w["id"])
    assert hidden["hidden"] is True and hidden["hidden_at"] is not None
    assert hidden["hidden_by_alias"] == "Owner" and hidden["hidden_reason"] == "Superseded"
    assert hidden["status"] == "cancelled"  # lifecycle status is untouched
    assert hidden["revision"] == w["revision"] + 1
    assert actions(hidden)["hide"]["reason"] == "workflow_hidden"
    assert actions(hidden)["restore"]["enabled"] is True
    assert {
        t["id"]: (t["status"], t["work_revision"], t["depends_on"]) for t in hidden["tasks"]
    } == before
    # SQLite timestamps can tie within a millisecond; UUID tie-breaking is not event order.
    assert sum(e["event"] == "workflow_hidden" for e in hidden["activity"]) == 1

    # Same key + same body = the saved receipt, not a second change.
    with db_cursor(readonly=True) as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        receipt = svc.receipt(cid, actor, "hide", svc.rows(
            "SELECT idempotency_key FROM workflow_operation_receipts WHERE workflow_id=%s AND operation='hide'",
            (w["id"],),
        )[0]["idempotency_key"])
    assert receipt["result"]["hidden"] is True

    # Stale revision is refused; the hidden state does not change.
    with pytest.raises(HTTPException) as err:
        execute("restore", {"expected_revision": w["revision"]}, w["id"])
    assert err.value.detail["code"] == "revision_changed"

    restored = execute("restore", {}, w["id"])
    assert restored["hidden"] is False and restored["hidden_at"] is None
    assert restored["hidden_by_alias"] is None and restored["hidden_reason"] is None
    assert restored["status"] == "cancelled"
    assert {
        t["id"]: (t["status"], t["work_revision"], t["depends_on"]) for t in restored["tasks"]
    } == before
    assert sum(e["event"] == "workflow_restored" for e in restored["activity"]) == 1
    with db_cursor(readonly=True) as (_, cur):
        svc = ws.WorkflowService(cur, hooks)
        assert svc.live_turns(w["id"]) == 0  # restore never started a worker
    with pytest.raises(HTTPException) as err:
        execute("restore", {}, w["id"])
    assert err.value.detail["code"] == "workflow_visible"


def test_only_the_workflow_or_project_owner_may_hide(setup_workflow):
    cid, actor, worker, other, hooks, execute = setup_workflow
    w = execute("cancel", {}, create(setup_workflow)["id"])
    stranger = ws.WorkflowActor(other, True)  # a member human who owns nothing
    with pytest.raises(HTTPException) as err:
        execute("hide", {}, w["id"], acting=stranger)
    assert err.value.status_code == 403
    with pytest.raises(HTTPException):
        execute("hide", {}, w["id"], acting=ws.WorkflowActor(worker, False))
    with db_cursor() as (_, cur):
        cur.execute("UPDATE agents SET member_role='owner' WHERE id=%s", (other,))
    assert execute("hide", {}, w["id"], acting=stranger)["hidden"] is True


@pytest.mark.asyncio
async def test_hidden_workflows_leave_the_list_and_task_views_until_restored(
    client, setup_workflow
):
    cid, actor, worker, other, hooks, execute = setup_workflow
    OWNER, OTHER = local(actor.id), local(other)
    kept = create(setup_workflow)
    w = execute("cancel", {}, create(setup_workflow)["id"])
    tid = w["tasks"][0]["id"]

    r = await client.get(f"/api/workflows/{w['id']}/visibility-check", headers=OWNER)
    assert r.status_code == 200 and r.json()["can_hide"] is True, r.text
    assert r.json()["task_count"] == 2 and r.json()["title"] == "Release"

    r = await client.post(
        f"/api/workflows/{w['id']}/hide",
        json={"expected_revision": w["revision"], "idempotency_key": uid(), "reason": "Old"},
        headers=OWNER,
    )
    assert r.status_code == 200 and r.json()["hidden"] is True, r.text

    async def ids(**params):
        r = await client.get(f"/api/containers/{cid}/workflows", params=params, headers=OWNER)
        assert r.status_code == 200, r.text
        return {x["id"] for x in r.json()["workflows"]}

    assert await ids() == {kept["id"]}
    assert await ids(visibility="hidden") == {w["id"]}
    assert await ids(visibility="all") == {kept["id"], w["id"]}
    assert await ids(visibility="hidden", status="cancelled") == {w["id"]}
    r = await client.get(f"/api/containers/{cid}/workflows", params={"visibility": "nope"}, headers=OWNER)
    assert r.status_code == 422

    # A direct link still reads (read-only hidden page), with Restore offered to the owner.
    r = await client.get(f"/api/workflows/{w['id']}", headers=OWNER)
    assert r.status_code == 200 and r.json()["hidden"] is True
    assert actions(r.json())["restore"]["enabled"] is True
    r = await client.get(f"/api/workflows/{w['id']}", headers=OTHER)
    assert r.status_code == 200 and actions(r.json())["restore"]["enabled"] is False

    # Task rows flag hidden membership but keep the task itself.
    r = await client.get(f"/api/containers/{cid}/tasks", params={"limit": 100}, headers=OWNER)
    assert r.status_code == 200, r.text
    rows = {t["id"]: t for t in r.json()["tasks"]}
    assert rows[tid]["workflow_id"] == w["id"] and rows[tid]["workflow_hidden"] is True
    assert rows[kept["tasks"][0]["id"]]["workflow_hidden"] is False
    assert rows[tid]["status"] == "cancelled"

    r = await client.get(f"/api/workflows/{w['id']}/visibility-check", headers=OWNER)
    assert r.json()["can_restore"] is True and r.json()["can_hide"] is False

    r = await client.post(
        f"/api/workflows/{w['id']}/restore",
        json={"expected_revision": r.json()["revision"], "idempotency_key": uid()},
        headers=OWNER,
    )
    assert r.status_code == 200 and r.json()["hidden"] is False, r.text
    assert await ids() == {kept["id"], w["id"]}
    r = await client.get(f"/api/containers/{cid}/tasks", params={"limit": 100}, headers=OWNER)
    assert {t["id"]: t for t in r.json()["tasks"]}[tid]["workflow_hidden"] is False
