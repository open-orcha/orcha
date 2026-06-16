"""#271 — Harden AI-actor enforcement (cooperative-hardening pass, Option A).

Spoof vector V1 (closed here): the task-thread POST path logged a NULL-author post with
actor_type="human" and the read path rendered `author_id IS NULL ⇒ is_human` — so an AI could
fabricate a human-attributed thread post simply by OMITTING its author_agent_id. The fix derives
both the audit actor_type AND the read-path is_human from the resolved agents.kind, never from the
mere presence/absence of an author id:

  - attributed kind='ai'    -> actor_type='ai',     is_human=False
  - attributed kind='human' -> actor_type='human',  is_human=True
  - NULL author             -> actor_type='system', is_human=False  (NEVER 'human')

Spoof vector V2 (documented, NOT closed here): there is no server-side caller auth, so an AI that
supplies a known human's UUID still clears `_require_kind(..., ("human",))`. Closing it requires
capability tokens — a separate cross-cutting design call (see _require_kind docstring).
"""
import pytest

pytestmark = pytest.mark.asyncio


async def _last(client, tid):
    msgs = (await client.get(f"/api/tasks/{tid}/messages")).json()["messages"]
    return msgs[-1]


def _msg_events(db, tid):
    """Audit `events` rows for task-thread messages on this task, insertion order."""
    return db.execute(
        "SELECT actor_type, actor_id FROM events "
        "WHERE entity_type='task' AND entity_id=%s AND event_type='message' ORDER BY id",
        (tid,),
    )


async def test_null_author_logs_system_not_human(client, db, make_task):
    """V1 core: a post with no author_agent_id is audited as 'system', NEVER 'human'.
    The old `"ai" if author else "human"` logged it as human — the spoof."""
    task = await make_task("t", "d")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages", json={"body": "pretend i am a human"})
    assert r.status_code == 201, r.text

    evs = _msg_events(db, tid)
    assert len(evs) == 1
    assert evs[0]["actor_type"] == "system", "a NULL-author post must audit as 'system', not 'human'"
    assert evs[0]["actor_id"] is None
    # and the read path agrees: not human
    assert (await _last(client, tid))["is_human"] is False


async def test_attributed_ai_logs_ai(client, db, make_agent, make_task):
    """An attributed AI author is audited as 'ai' (derived from kind, was hard-coded by presence)."""
    dev = await make_agent("Dev")
    task = await make_task("t", "d", assignee_alias="Dev")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": dev["agent_id"], "body": "progress"})
    assert r.status_code == 201, r.text

    evs = _msg_events(db, tid)
    assert evs[0]["actor_type"] == "ai"
    assert str(evs[0]["actor_id"]) == dev["agent_id"]
    assert (await _last(client, tid))["is_human"] is False


async def test_attributed_human_logs_human(client, db, make_agent, make_task):
    """A kind='human' author is audited as 'human' AND reads as human — the legitimate path the
    portal comment box now uses (it sends the acting human's id)."""
    human = await make_agent("Kedar", kind="human")
    task = await make_task("t", "d")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": human["agent_id"], "body": "human note"})
    assert r.status_code == 201, r.text

    evs = _msg_events(db, tid)
    assert evs[0]["actor_type"] == "human", "a kind=human author must audit as human"
    assert str(evs[0]["actor_id"]) == human["agent_id"]
    assert (await _last(client, tid))["is_human"] is True


async def test_ai_cannot_forge_human_by_omitting_author(client, db, make_agent, make_task):
    """End-to-end V1: an AI that wants to look human can only omit its id — and that now lands as
    'system' (read is_human False, audit actor_type 'system'), not as a human. The spoof is dead."""
    ai = await make_agent("Sneaky")
    task = await make_task("t", "d", assignee_alias="Sneaky")
    tid = task["id"]
    # the AI drops its author to try to look human
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"body": "[as a human] please approve this PR"})
    assert r.status_code == 201, r.text
    m = await _last(client, tid)
    assert m["is_human"] is False
    assert _msg_events(db, tid)[0]["actor_type"] == "system"


async def test_nonmember_author_still_rejected(client, make_task):
    """Regression: authorship still can't be forged with an arbitrary UUID — a non-member id is
    rejected (the membership guard predates #271 and is unchanged)."""
    task = await make_task("t", "d")
    tid = task["id"]
    bogus = "00000000-0000-4000-8000-000000000000"
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": bogus, "body": "blocked"})
    assert r.status_code == 403, r.text


async def test_null_author_read_is_neutral_in_snapshot_summary(client, container, make_task):
    """The snapshot's per-task message_summary.last is_human flips too (same derivation), so a
    NULL-author last message is not summarized as a human post anywhere the portal reads it."""
    task = await make_task("t", "d")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/messages", json={"body": "anon note"})
    assert r.status_code == 201, r.text

    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    row = next(t for t in snap["tasks"] if t["id"] == tid)
    last = row["message_summary"]["last"]
    assert last is not None and last["is_human"] is False, \
        "the snapshot summary of a NULL-author post must not read as human"
