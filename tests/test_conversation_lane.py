"""GH #91+#90 — conversation/work lane split on the single-flight lease.

The one per-agent embodiment lease is split into two independent slots: a CONVERSATION lane (warm
resident chat / Codex conversation) and a WORK lane (task ephemerals, live terminal). The two may
be held at once, but at most one lease per lane. The crux for #91: a live conversation lease must
STOP suppressing work-lane task wakes, so a resident can dispatch a task and a work worker executes
it concurrently. The crux for #90's uncapped signal: an owed, unaccepted task request wakes the
work lane on its own (has_pending_task_request), independent of the capped event manifest.
"""
import pytest

pytestmark = pytest.mark.asyncio


def _cand(scan, aid):
    for c in scan["candidates"]:
        if c["agent_id"] == aid:
            return c
    raise AssertionError(f"no candidate for {aid}")


async def _claim(client, aid, lane, *, lease_kind=None, ttl=300):
    body = {"lease_ttl": ttl, "lane": lane}
    if lease_kind:
        body["lease_kind"] = lease_kind
    return await client.post(f"/api/agents/{aid}/wake-claim", json=body)


# ---------- two lanes coexist ----------

async def test_two_lanes_coexist(client, make_agent):
    a = await make_agent("A")
    aid = a["agent_id"]
    r_conv = await _claim(client, aid, "conversation", lease_kind="resident")
    assert r_conv.status_code == 200 and r_conv.json()["claimed"] is True, r_conv.text
    r_work = await _claim(client, aid, "work", lease_kind="ephemeral")
    assert r_work.status_code == 200 and r_work.json()["claimed"] is True, r_work.text


async def test_same_lane_second_claim_loses(client, make_agent):
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid, "work", lease_kind="ephemeral")).json()["claimed"] is True
    assert (await _claim(client, aid, "work", lease_kind="ephemeral")).json()["claimed"] is False


# ---------- the core #91 guard: a conversation lease does NOT suppress a work wake ----------

async def test_conversation_lease_does_not_suppress_work_wake(client, make_agent, make_task):
    a = await make_agent("A")
    aid = a["agent_id"]
    await make_task("bg work", "done", assignee_alias="A")   # a ready work task -> work should_wake
    # hold a live conversation lease
    assert (await _claim(client, aid, "conversation", lease_kind="resident")).json()["claimed"]
    cid = a["container_id"]
    scan = (await client.get(f"/api/containers/{cid}/wake-scan",
                             params={"cooldown": 0, "min_idle": 0})).json()
    assert _cand(scan, aid)["should_wake"] is True   # work lane wakes despite the conv lease


async def test_work_lease_still_suppresses_work_wake(client, make_agent, make_task):
    a = await make_agent("A")
    aid = a["agent_id"]
    cid = a["container_id"]
    await make_task("bg work", "done", assignee_alias="A")
    assert (await _claim(client, aid, "work", lease_kind="ephemeral")).json()["claimed"]
    scan = (await client.get(f"/api/containers/{cid}/wake-scan",
                             params={"cooldown": 0, "min_idle": 0})).json()
    assert _cand(scan, aid)["should_wake"] is False   # single-flight on the work lane holds


# ---------- lane-scoped release ----------

async def test_release_is_lane_scoped(client, make_agent):
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await _claim(client, aid, "conversation", lease_kind="resident")).json()["claimed"]
    assert (await _claim(client, aid, "work", lease_kind="ephemeral")).json()["claimed"]
    # release the work lane only
    r = await client.post(f"/api/agents/{aid}/wake-ack",
                          json={"kind": "ephemeral", "release_lease": True, "lane": "work"})
    assert r.status_code == 200, r.text
    # work lane is free again (reclaimable); conversation lane still held
    assert (await _claim(client, aid, "work", lease_kind="ephemeral")).json()["claimed"] is True
    assert (await _claim(client, aid, "conversation", lease_kind="resident")).json()["claimed"] is False


# ---------- the uncapped owed-task-request signal ----------

async def test_open_task_request_sets_pending_signal_and_wakes_work(
        client, make_agent, make_request):
    a = await make_agent("A")
    b = await make_agent("B")
    aid = a["agent_id"]
    cid = a["container_id"]
    await make_request(b["agent_id"], "please do work", target_alias="A", type="task",
                       task={"title": "T", "definition_of_done": "done when X"})
    scan = (await client.get(f"/api/containers/{cid}/wake-scan",
                             params={"cooldown": 0, "min_idle": 0})).json()
    c = _cand(scan, aid)
    assert c.get("has_pending_task_request") is True
    assert c["should_wake"] is True


async def test_no_task_request_leaves_pending_signal_false(client, make_agent):
    a = await make_agent("A")
    scan = (await client.get(f"/api/containers/{a['container_id']}/wake-scan",
                             params={"cooldown": 0, "min_idle": 0})).json()
    assert _cand(scan, a["agent_id"]).get("has_pending_task_request") is False
