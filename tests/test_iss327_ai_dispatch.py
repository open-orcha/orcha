"""#327 — let the AI orchestrator dispatch (assign / reassign / cancel / edit-protocol).

THE GAP this closes: create_task already lets any kind='ai' actor assign a task at create-time
(`assignee_alias` is not human-gated), yet the SAME state change on an EXISTING task — assign,
reassign, cancel-another's, edit-protocol — was locked behind a human. That was an internal
inconsistency, not a real privilege boundary. Option A (Kedar-approved) opens those three gates
to kind='ai' with NO migration, holding the AI actor to the SAME safeguards create_task enforces
(container-active, not-retired) and keeping ONE genuine privilege guard: `autonomy` (the human's
risk dial) stays human-only.

Each test is mutation-checked — it names the prod line whose flip turns the assertion red.
"""
import pytest

pytestmark = pytest.mark.asyncio

from conftest import next_event


async def _wait(client, agent_id, event_name, *, timeout=3):
    ev = await next_event(client, agent_id, since_ts=0, timeout=timeout)
    while ev["event"] not in (event_name, "timeout"):
        ev = await next_event(client, agent_id, since_ts=ev["ts"], timeout=timeout)
    return ev


# ── assign / reassign ─────────────────────────────────────────────────────────

async def test_ai_reassign_releases_prior_and_attributes_kind(client, make_agent, make_task, db):
    """#327: an AI orchestrator reassigning a task already owned by someone else releases the
    prior assignee and the task_unassigned event is attributed by_kind='ai' (not by_human_id).
    TEETH: revert the task_unassigned payload to {by_human_id} → the by_kind assert KeyErrors;
    revert the assign gate to ('human',) → the reassign 200 → 403."""
    orch = await make_agent("Orchestrator", kind="ai")
    dev1 = await make_agent("dev1", kind="ai")
    dev2 = await make_agent("dev2", kind="ai")
    t = await make_task("hot-potato", "done", assignee_alias="dev1")   # dev1 working
    r = await client.post(f"/api/tasks/{t['id']}/assign",
                          json={"actor_agent_id": orch["agent_id"],
                                "agent_id": dev2["agent_id"], "reassign": True})
    assert r.status_code == 200, r.text
    assert r.json()["released_prior"] == [dev1["agent_id"]]
    # dev1 is woken with a kind-attributed task_unassigned
    ev = await _wait(client, dev1["agent_id"], "task_unassigned")
    assert ev["event"] == "task_unassigned"
    assert ev.get("by_kind") == "ai" and ev.get("by_id") == orch["agent_id"]
    # dev2 now holds the active assignment
    assert db.execute(
        "SELECT 1 FROM agent_tasks WHERE task_id=%s AND agent_id=%s "
        "AND assignment_status IN ('assigned','accepted','working')",
        (t["id"], dev2["agent_id"])) != []


async def test_ai_assign_blocked_on_paused_container_but_human_ok(client, container, make_agent, make_task, db):
    """#327 safeguard parity with create_task: an AI actor can't dispatch on a paused container
    (409), but a human still can. TEETH: drop the new _require_container_active call in
    assign_task → the AI 409 becomes 200."""
    cid = container["id"]
    human = await make_agent("Boss", kind="human")
    orch = await make_agent("Orchestrator", kind="ai")
    dev = await make_agent("dev", kind="ai")
    t = await make_task("loose", "done")
    db.execute("UPDATE containers SET status='paused' WHERE id=%s", (cid,))
    # AI dispatch is blocked while paused …
    r = await client.post(f"/api/tasks/{t['id']}/assign",
                          json={"actor_agent_id": orch["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 409, r.text
    # … the human stays authoritative
    r = await client.post(f"/api/tasks/{t['id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 200, r.text


async def test_retired_ai_cannot_assign(client, make_agent, make_task, db):
    """#327 safeguard parity: a retired AI actor can't dispatch (409). TEETH: drop the new
    _reject_if_retired call in assign_task → 409 becomes 200."""
    orch = await make_agent("Orchestrator", kind="ai")
    dev = await make_agent("dev", kind="ai")
    t = await make_task("x", "done")
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (orch["agent_id"],))
    r = await client.post(f"/api/tasks/{t['id']}/assign",
                          json={"actor_agent_id": orch["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 409, r.text


# ── edit-protocol ─────────────────────────────────────────────────────────────

async def test_ai_edits_coordination_protocol_but_not_autonomy(client, make_agent, make_task, db):
    """#327: an AI orchestrator may edit the coordination dials (review_chain/handoff_to/notes)
    — audited as 'ai' — but `autonomy` stays human-only. TEETH: drop the autonomy guard → the
    AI-autonomy 403 becomes 200; revert the protocol gate to ('human',) → the notes 200 → 403."""
    orch = await make_agent("Orchestrator", kind="ai")
    human = await make_agent("Boss", kind="human")
    t = await make_task("Protocol task", "done")

    # AI may set the coordination keys
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": orch["agent_id"],
                                 "review_chain": "dev->Lens->Gate", "notes": "carry on"})
    assert r.status_code == 200, r.text
    assert r.json()["protocol"]["review_chain"] == "dev->Lens->Gate"
    # audited under the AI's kind
    assert db.execute(
        "SELECT actor_type FROM events WHERE entity_id=%s AND event_type='protocol_updated' "
        "ORDER BY id DESC LIMIT 1", (t["id"],))[0]["actor_type"] == "ai"

    # AI editing autonomy → 403 (the one privilege guard)
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": orch["agent_id"], "autonomy": "L1"})
    assert r.status_code == 403, r.text
    # a mixed edit that TOUCHES autonomy is rejected wholesale (no partial apply)
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": orch["agent_id"],
                                 "notes": "sneaky", "autonomy": "L1"})
    assert r.status_code == 403, r.text
    assert db.execute("SELECT protocol FROM tasks WHERE id=%s",
                      (t["id"],))[0]["protocol"].get("autonomy") is None

    # the human keeps the autonomy dial
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": human["agent_id"], "autonomy": "review every step"})
    assert r.status_code == 200, r.text
    assert r.json()["protocol"]["autonomy"] == "review every step"


async def test_ai_protocol_edit_blocked_on_paused_container(client, container, make_agent, make_task, db):
    """#327 safeguard parity: an AI can't edit a protocol on a paused container (409). TEETH:
    drop the new _require_container_active call in update_task_protocol → 409 becomes 200."""
    cid = container["id"]
    orch = await make_agent("Orchestrator", kind="ai")
    t = await make_task("Protocol task", "done")
    db.execute("UPDATE containers SET status='paused' WHERE id=%s", (cid,))
    r = await client.patch(f"/api/tasks/{t['id']}/protocol",
                           json={"actor_agent_id": orch["agent_id"], "notes": "x"})
    assert r.status_code == 409, r.text
