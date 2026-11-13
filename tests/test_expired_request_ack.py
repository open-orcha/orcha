"""GH #300: expiry escalation must consume the original recipient's notice."""

import pytest

from portal_backend.database import db_cursor
from portal_backend.wake_manifest import _wake_notification_manifest


@pytest.mark.parametrize("keep_older_request", [False, True])
async def test_expiry_acks_old_target_without_consuming_other_work(
    client, container, make_agent, make_request, db, keep_older_request
):
    human = await make_agent("owner", kind="human")
    agent = await make_agent("worker")
    aid = agent["agent_id"]
    hid = human["agent_id"]
    older_id = None
    if keep_older_request:
        older = await make_request(hid, "Which option?", target_alias="worker")
        older_id = older["id"]
    expired = await make_request(hid, "Which date?", target_alias="worker")
    rid = expired["id"]
    db.execute("UPDATE requests SET expires_at=%s WHERE id=%s", (db.ago(60), rid))
    notices = [e for e in db.event_rows(aid) if e["event_name"] == "request_created"]
    expired_notice = next(e for e in notices if e["payload"]["request_id"] == rid)

    # Give the cursor check deterministic ordering, independent of clock resolution.
    for notice in notices:
        db.execute("UPDATE agent_events SET ts=%s WHERE id=%s",
                   (20.0 if notice["id"] == expired_notice["id"] else 10.0, notice["id"]))
    db.execute(
        "INSERT INTO agent_wake_state (agent_id, delivered_ts) VALUES (%s, 0) "
        "ON CONFLICT (agent_id) DO UPDATE SET delivered_ts=0", (aid,),
    )
    with db_cursor() as (_, cur):
        before, _ = _wake_notification_manifest(cur, aid, 0)
    assert any(item["deeplink"] == {"kind": "request", "id": rid} for item in before)

    response = await client.post(
        f"/api/containers/{container['id']}/sweep", params={"actor_agent_id": hid}
    )
    assert response.status_code == 200, response.text
    assert response.json()["request_ids"] == [rid]
    row = db.execute("SELECT target_id, status FROM requests WHERE id=%s", (rid,))[0]
    assert str(row["target_id"]) == hid
    assert row["status"] == "open"
    acked = db.execute("SELECT event_id FROM agent_event_acks WHERE agent_id=%s", (aid,))
    assert {row["event_id"] for row in acked} == {expired_notice["id"]}
    floor = db.execute("SELECT delivered_ts FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]["delivered_ts"]
    assert floor < 10 if keep_older_request else floor >= 20
    with db_cursor() as (_, cur):
        after, _ = _wake_notification_manifest(cur, aid, floor)
    remaining = [item["deeplink"]["id"] for item in after if item["event_name"] == "request_created"]
    assert remaining == ([older_id] if keep_older_request else [])

    repeated = await client.post(
        f"/api/containers/{container['id']}/sweep", params={"actor_agent_id": hid}
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["escalated_count"] == 0
    human_notices = [e for e in db.event_rows(hid)
                     if e["event_name"] == "request_created" and e["payload"]["request_id"] == rid]
    assert len(human_notices) == 1
