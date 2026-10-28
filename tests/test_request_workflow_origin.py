"""GH #350 (workflow redesign spec §7.1): request reads expose their ORIGIN task and the
container request list can be scoped to one workflow.

`originating_task_id` (mig 028) is the task the requester was working on when it asked; it is
distinct from `spawned_task_id` / `task_link` (the task a request CREATED). The workflow
decision list in the redesign needs both the link on every row and a server-resolved
`?workflow=` filter so that a request raised from an unlinked task is never attributed to a
workflow by guesswork.
"""

from uuid import uuid4

import pytest

from portal_backend.database import db_cursor
from conftest import ts_from_now
from test_workflows import create, setup_workflow  # noqa: F401 (fixture re-export)

OWNER = {"X-Auth-Request-User": "owner"}


def _request_row(cid, requester, target, payload, *, origin=None):
    with db_cursor() as (_, cur):
        cur.execute(
            f"""INSERT INTO requests (container_id, type, requester_id, target_id, priority,
                                      status, payload, expires_at, chain_depth,
                                      originating_task_id)
                VALUES (%s, 'info', %s, %s, 100, 'open', %s, {ts_from_now(3600)}, 0, %s)
                RETURNING id""",
            (cid, requester, target, payload, origin),
        )
        return str(cur.fetchone()["id"])


@pytest.mark.asyncio
async def test_request_rows_carry_origin_link_and_workflow_filter_scopes_them(
    client, setup_workflow
):
    cid, actor, worker, _other, _hooks, _execute = setup_workflow
    owner = actor.id
    w = create(setup_workflow, count=2)
    wid = w["id"]
    member_task = next(task["id"] for task in w["tasks"] if task["title"] == "Task 0")

    # A task OUTSIDE the workflow, so an origin link alone must not imply membership.
    r = await client.post(
        f"/api/containers/{cid}/tasks",
        json={"title": "Loose task", "definition_of_done": "Done", "priority": 100,
              "assignee_alias": "Worker", "depends_on": []},
        headers=OWNER,
    )
    assert r.status_code == 201, r.text
    loose_task = r.json().get("task_id") or r.json()["id"]

    linked = _request_row(cid, worker, owner, "Question from a workflow task", origin=member_task)
    loose = _request_row(cid, worker, owner, "Question from a loose task", origin=loose_task)
    unlinked = _request_row(cid, worker, owner, "Taskless question")

    # Every row in the plain list carries the link (null when raised outside any task).
    r = await client.get(f"/api/containers/{cid}/requests", headers=OWNER)
    assert r.status_code == 200, r.text
    by_id = {row["id"]: row for row in r.json()["requests"]}
    assert set(by_id) == {linked, loose, unlinked}
    assert by_id[linked]["originating_task_id"] == member_task
    assert by_id[linked]["origin_task"]["task_id"] == member_task
    assert by_id[linked]["origin_task"]["workflow_id"] == wid
    assert by_id[linked]["origin_task"]["title"] == "Task 0"
    assert by_id[loose]["originating_task_id"] == loose_task
    assert by_id[loose]["origin_task"]["workflow_id"] is None
    assert by_id[unlinked]["originating_task_id"] is None
    assert by_id[unlinked]["origin_task"] is None
    # The origin link is NOT the spawned-task link.
    assert by_id[linked]["task_link"] is None

    # ?workflow= keeps only requests whose origin task is a CURRENT member of that workflow.
    r = await client.get(f"/api/containers/{cid}/requests", params={"workflow": wid}, headers=OWNER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [row["id"] for row in body["requests"]] == [linked]
    assert body["total"] == 1 and body["has_more"] is False

    # Scoping composes with the status filter and keeps the count honest.
    r = await client.get(
        f"/api/containers/{cid}/requests",
        params={"workflow": wid, "status": "closed"},
        headers=OWNER,
    )
    assert r.status_code == 200 and r.json()["total"] == 0 and r.json()["requests"] == []

    # The single read exposes the same link.
    r = await client.get(f"/api/requests/{linked}", headers=OWNER)
    assert r.status_code == 200, r.text
    assert r.json()["originating_task_id"] == member_task
    assert r.json()["container_id"] == cid
    r = await client.get(f"/api/requests/{unlinked}", headers=OWNER)
    assert r.status_code == 200 and r.json()["originating_task_id"] is None


@pytest.mark.asyncio
async def test_workflow_filter_rejects_unknown_or_foreign_workflows(client, setup_workflow):
    cid = setup_workflow[0]
    r = await client.get(f"/api/containers/{cid}/requests", params={"workflow": "nope"}, headers=OWNER)
    assert r.status_code == 400
    r = await client.get(
        f"/api/containers/{cid}/requests", params={"workflow": str(uuid4())}, headers=OWNER
    )
    assert r.status_code == 404

    # A workflow that exists in ANOTHER project is not visible through this project's list.
    other_cid = str(uuid4())
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO containers(id,name) VALUES (%s,'Elsewhere')", (other_cid,))
    w = create(setup_workflow, count=1)
    r = await client.get(
        f"/api/containers/{other_cid}/requests", params={"workflow": w["id"]}, headers=OWNER
    )
    assert r.status_code in (403, 404)
