"""A replacement worker can recover the thread even after wake events were cleared."""

from datetime import datetime, timezone
from uuid import UUID


async def test_forward_cursor_recovers_ties_and_new_messages(client, make_task, db):
    task = await make_task("Long test", "Use the saved result")
    tid = task["id"]
    stamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ids = [str(UUID(int=i)) for i in range(1, 6)]
    for mid in ids:
        db.execute(
            "INSERT INTO task_messages(id,task_id,body,created_at) VALUES (%s,%s,%s,%s)",
            (mid, tid, "Guidance " + mid, stamp),
        )
    cursor = {"after": "1970-01-01T00:00:00Z", "after_id": str(UUID(int=0)), "limit": 2}
    seen = []
    while True:
        response = await client.get(f"/api/tasks/{tid}/messages", params=cursor)
        assert response.status_code == 200, response.text
        page = response.json()
        assert page["task"]["definition_of_done"] == "Use the saved result"
        seen.extend(row["message_id"] for row in page["messages"])
        cursor.update(after=page["next_after"], after_id=page["next_after_id"])
        if not page["has_more"]:
            break
    assert seen == ids
    empty = (await client.get(f"/api/tasks/{tid}/messages", params=cursor)).json()
    assert empty["messages"] == []
    assert empty["next_after_id"] == ids[-1]
    later = str(UUID(int=6))
    db.execute("INSERT INTO task_messages(id,task_id,body,created_at) VALUES (%s,%s,%s,%s)",
               (later, tid, "Later guidance", stamp))
    page = (await client.get(f"/api/tasks/{tid}/messages", params=cursor)).json()
    assert [row["message_id"] for row in page["messages"]] == [later]


async def test_forward_paging_does_not_touch_worker_activity(client, make_task, make_agent, db):
    agent = await make_agent("Waiting worker")
    tid = (await make_task("Wait", "Recover guidance", assignee_alias="Waiting worker"))["id"]
    before = db.execute("SELECT last_heartbeat_at,turns_used FROM agents WHERE id=%s", (agent["agent_id"],))
    response = await client.get(f"/api/tasks/{tid}/messages", params={
        "after": "1970-01-01T00:00:00Z", "after_id": str(UUID(int=0)),
    })
    assert response.status_code == 200
    assert db.execute("SELECT last_heartbeat_at,turns_used FROM agents WHERE id=%s", (agent["agent_id"],)) == before


async def test_forward_cursor_rejects_ambiguous_inputs(client, make_task):
    tid = (await make_task("Wait", "Read complete thread"))["id"]
    stamp, mid = "2026-01-01T00:00:00Z", str(UUID(int=1))
    for params in [
        {"after": stamp}, {"after_id": mid},
        {"after": stamp, "after_id": mid, "before": stamp},
        {"after": stamp, "after_id": "invalid"},
        {"after": stamp, "after_id": mid, "limit": -1},
        {"after": "2026-01-01T00:00:00", "after_id": mid},
    ]:
        response = await client.get(f"/api/tasks/{tid}/messages", params=params)
        assert response.status_code == 400, response.text


async def test_generated_openapi_describes_thread_recovery(client):
    schema = (await client.get("/openapi.json")).json()
    route = schema["paths"]["/api/tasks/{tid}/messages"]["get"]
    assert {"after", "after_id"} <= {p["name"] for p in route["parameters"]}
    response = route["responses"]["200"]["content"]["application/json"]["schema"]
    properties = schema["components"]["schemas"][response["$ref"].split("/")[-1]]["properties"]
    assert {"messages", "task", "next_after", "next_after_id"} <= properties.keys()
