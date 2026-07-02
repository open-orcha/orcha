"""SPEC-4 — per-task `protocol` field + PATCH route (Ledger, task 0909bb66).

A task carries an optional free-text working agreement `protocol`
{review_chain, handoff_to, autonomy, notes} (all OPTIONAL strings; `autonomy` is FREE
TEXT, NOT an L1/L2/L3 enum). It is set at create-time or via the human-gated, audited
PATCH /api/tasks/{tid}/protocol, and surfaces in the container snapshot, the /tasks list,
and the worker's claim/wake payload so the working agent reads it on wake.

Each test is mutation-checked: it asserts the live behaviour AND that the contract
(human gate / partial-merge / surfacing) is what makes it pass — flip the prod line and
the matching assertion goes red.
"""
import pytest

pytestmark = pytest.mark.asyncio


async def _human(make_agent):
    h = await make_agent("Boss", kind="human")
    return h["id"] if "id" in h else h.get("agent_id")


# ── 1. human-authority gate (mirrors /verify) ─────────────────────────────────
async def test_patch_protocol_gate_and_audit(client, make_agent, make_task):
    """The gate: a non-human actor is 403'd (TEETH: drop _require_kind(...,("human",))
    in update_task_protocol and this 403 → 200)."""
    ai = await make_agent("Worker", kind="ai")
    ai_id = ai.get("id") or ai.get("agent_id")
    human_id = await _human(make_agent)
    t = await make_task("Gate task", "done")

    # non-human → 403
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": ai_id, "autonomy": "L2-ish"})
    assert r.status_code == 403, r.text

    # missing/!uuid actor → 400
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": "not-a-uuid", "autonomy": "x"})
    assert r.status_code == 400, r.text

    # human actor → 200, echoes the merged protocol
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": human_id, "autonomy": "review every step"})
    assert r.status_code == 200, r.text
    assert r.json()["protocol"] == {"autonomy": "review every step"}


# ── 2. partial merge preserves omitted keys ───────────────────────────────────
async def test_patch_protocol_is_a_partial_merge(client, make_agent, make_task):
    """TEETH: change the merge to a full-replace (drop {**existing}) and the preserved
    review_chain assertion below goes red."""
    human_id = await _human(make_agent)
    t = await make_task("Merge task", "done")

    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": human_id,
                                 "review_chain": "dev->Lens->Gate", "handoff_to": "Helm"})
    assert r.status_code == 200, r.text

    # send ONLY autonomy — review_chain + handoff_to must survive
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": human_id, "autonomy": "free text, not an enum"})
    assert r.status_code == 200, r.text
    assert r.json()["protocol"] == {
        "review_chain": "dev->Lens->Gate", "handoff_to": "Helm",
        "autonomy": "free text, not an enum",
    }

    # empty body (no protocol fields) → 400
    r = await client.patch(f"/api/tasks/{t['id']}/protocol", json={"actor_agent_id": human_id})
    assert r.status_code == 400, r.text

    # clear a key with "" — stored as empty, others preserved
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": human_id, "handoff_to": ""})
    assert r.status_code == 200, r.text
    assert r.json()["protocol"]["handoff_to"] == ""
    assert r.json()["protocol"]["review_chain"] == "dev->Lens->Gate"


# ── 3. surfaces in the snapshot + /tasks list ─────────────────────────────────
async def test_protocol_surfaces_in_snapshot_and_task_list(client, container, make_agent, make_task):
    """TEETH: remove `t.protocol` from _task_list_sql and BOTH the snapshot and the
    /tasks-list assertions go red (they share that one builder)."""
    cid = container["id"]
    human_id = await _human(make_agent)
    t = await make_task("Surfaced task", "done")
    await client.patch(f"/api/tasks/{t['id']}/protocol",
                       json={"actor_agent_id": human_id, "notes": "read me on wake"})

    snap = (await client.get(f"/api/containers/{cid}")).json()
    row = next(x for x in snap["tasks"] if x["id"] == t["id"])
    assert row["protocol"] == {"notes": "read me on wake"}

    lst = (await client.get(f"/api/containers/{cid}/tasks")).json()
    row2 = next(x for x in lst["tasks"] if x["id"] == t["id"])
    assert row2["protocol"] == {"notes": "read me on wake"}


async def test_unset_protocol_is_null_not_empty_object(client, container, make_task):
    """A task with no protocol set carries `protocol: null` (drives Glass's empty state)."""
    cid = container["id"]
    t = await make_task("No protocol", "done")
    snap = (await client.get(f"/api/containers/{cid}")).json()
    row = next(x for x in snap["tasks"] if x["id"] == t["id"])
    assert row["protocol"] is None


# ── 4. worker reads its protocol on claim/wake ────────────────────────────────
async def test_protocol_rides_the_worker_claim_payload(client, container, make_agent, make_task, work_headers):
    """The whole point: the claiming/woken agent gets its protocol in the /next payload.
    TEETH: drop `protocol` from agent_next's SELECT or return dict → this goes red."""
    cid = container["id"]
    human_id = await _human(make_agent)
    worker = await make_agent("Picker", kind="ai")
    wid = worker.get("id") or worker.get("agent_id")
    t = await make_task("Claimable", "done")  # no assignee → status 'ready'
    await client.patch(f"/api/tasks/{t['id']}/protocol",
                       json={"actor_agent_id": human_id, "review_chain": "dev->Gate->Helm"})
    ar = await client.post(f"/api/tasks/{t['id']}/assign",
                           json={"actor_agent_id": human_id, "agent_id": wid})
    assert ar.status_code == 200 and ar.json()["status"] == "ready", ar.text

    r = await client.post(f"/api/agents/{wid}/next",
                          headers=await work_headers(wid))
    assert r.status_code == 200, r.text
    claimed = r.json()["task"]
    assert claimed["id"] == t["id"]
    assert claimed["protocol"] == {"review_chain": "dev->Gate->Helm"}


# ── 5. create-time protocol persists ──────────────────────────────────────────
async def test_protocol_set_at_create_time(client, container):
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/tasks", json={
        "title": "Born with a protocol", "definition_of_done": "done",
        "protocol": {"autonomy": "L1-style", "notes": "created with it"},
    })
    assert r.status_code == 201, r.text
    tid = r.json().get("task_id") or r.json().get("id")

    snap = (await client.get(f"/api/containers/{cid}")).json()
    row = next(x for x in snap["tasks"] if x["id"] == tid)
    assert row["protocol"] == {"autonomy": "L1-style", "notes": "created with it"}


async def test_create_without_protocol_stays_null(client, container):
    """Create with no protocol block → NULL (not '{}'), so the unset contract holds."""
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/tasks",
                          json={"title": "Plain", "definition_of_done": "done"})
    tid = r.json().get("task_id") or r.json().get("id")
    snap = (await client.get(f"/api/containers/{cid}")).json()
    row = next(x for x in snap["tasks"] if x["id"] == tid)
    assert row["protocol"] is None


# ── 6. per-field length cap ───────────────────────────────────────────────────
async def test_protocol_field_length_capped(client, make_agent, make_task):
    human_id = await _human(make_agent)
    t = await make_task("Long", "done")
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": human_id, "notes": "x" * 4001})
    # the app maps a max_length overflow to a 413 body_too_long (global handler), not a raw 422
    assert r.status_code == 413, r.text
    assert r.json()["field"] == "notes"
