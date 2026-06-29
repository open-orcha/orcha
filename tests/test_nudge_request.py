"""#60 — the STANDALONE, state-routed request nudge.

A nudge is a wake-up for whoever owns the NEXT ACTION on a request, fully decoupled from
closing it. It NEVER changes the request's state (the handler SELECTs only). Recipient is
state-routed:
  • open      → the TARGET (still owes the answer)
  • answered  → the REQUESTER (must act on the answer or close it)
Accepted (now a task) and the terminal states (rejected / converted_to_task / closed) are not
actionable → 409, no poke. Human-only (403 otherwise). When the next action is owned by a human
(escalated-to-human, a human target/requester) there's no agent to poke → 200 {nudged:false}.
"""
import time

import pytest

pytestmark = pytest.mark.asyncio

from conftest import next_event


async def _wait_prompt(client, agent_id, *, since_ts=0.0, timeout=3):
    """The first directed `prompt` (the #60 nudge poke) for this agent newer than since_ts,
    skipping request_created / request_closed / decision_made / etc. Returns
    {"event":"timeout", ...} if none arrives."""
    ev = await next_event(client, agent_id, since_ts=since_ts, timeout=timeout)
    while ev["event"] not in ("prompt", "timeout"):
        ev = await next_event(client, agent_id, since_ts=ev["ts"], timeout=timeout)
    return ev


def _status(db, rid):
    return db.execute("SELECT status FROM requests WHERE id=%s", (rid,))[0]["status"]


async def _open_request(client, make_agent, make_request):
    """An OPEN info request from AI owner → AI target (the target owes an answer)."""
    owner = await make_agent("Owner", kind="ai")
    target = await make_agent("Target", kind="ai")
    req = await make_request(owner["agent_id"], "please advise", target_alias="Target")
    return owner, target, req["id"]


async def _answered_request(client, make_agent, make_request):
    """An ANSWERED info request (owner asked, target answered → requester now owes the next move)."""
    owner, target, rid = await _open_request(client, make_agent, make_request)
    r = await client.post(f"/api/requests/{rid}/respond",
                          json={"responder_agent_id": target["agent_id"], "response": "advice"})
    assert r.status_code == 200, r.text
    return owner, target, rid


async def _task_request(client, make_agent, make_request):
    """An OPEN task request from AI owner → AI target (acceptable / rejectable)."""
    owner = await make_agent("Owner", kind="ai")
    target = await make_agent("Target", kind="ai")
    req = await make_request(owner["agent_id"], "do the thing", target_alias="Target",
                             type="task", task={"title": "T", "definition_of_done": "done when X"})
    return owner, target, req["id"]


async def _rich_task_request(client, make_agent, make_request):
    """An OPEN task request carrying a FULL ask (description, definition of done, protocol) so the
    nudge's task-context block has every field to render."""
    owner = await make_agent("Owner", kind="ai")
    target = await make_agent("Target", kind="ai")
    req = await make_request(
        owner["agent_id"], "do the thing", target_alias="Target", type="task",
        task={"title": "Ship the widget", "description": "build and test the widget",
              "definition_of_done": "tests pass and PR open",
              "protocol": {"review_chain": "Target -> Code Reviewer -> human",
                           "handoff_to": "human", "autonomy": "high",
                           "notes": "do not merge"}})
    return owner, target, req["id"]


async def _answered_task_request(client, make_agent, make_request):
    """A task request taken all the way to ANSWERED: target accepts, then posts its result
    (accepted → answered), so the REQUESTER now owns the next move."""
    owner, target, rid = await _rich_task_request(client, make_agent, make_request)
    a = await client.post(f"/api/requests/{rid}/accept-task",
                          json={"responder_agent_id": target["agent_id"]})
    assert a.status_code == 200, a.text
    rsp = await client.post(f"/api/requests/{rid}/respond",
                            json={"responder_agent_id": target["agent_id"], "response": "done"})
    assert rsp.status_code == 200, rsp.text
    return owner, target, rid


# ---------- the two live routes (poke + state invariance) ----------

async def test_open_nudges_target_state_unchanged(client, make_agent, make_request, db):
    """open → the TARGET is poked; status stays 'open'; the prompt carries the nudger, rid8,
    a payload preview and the optional note."""
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _open_request(client, make_agent, make_request)
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": human["agent_id"], "note": "customer is waiting"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["nudged"] is True and d["nudged_role"] == "target"
    assert d["nudged_agent_id"] == target["agent_id"]
    assert d["status"] == "open"
    # the target gets a wake-framed directed prompt
    pev = await _wait_prompt(client, target["agent_id"])
    assert pev["event"] == "prompt", pev
    assert pev["from_agent_id"] == human["agent_id"]
    assert "Boss" in pev["message"]
    assert rid[:8] in pev["message"]
    assert "please advise" in pev["message"]
    assert "customer is waiting" in pev["message"]
    # SELECT-only: the request's state is untouched
    assert _status(db, rid) == "open"


async def test_answered_nudges_requester_state_unchanged(client, make_agent, make_request, db):
    """answered → the REQUESTER is poked; status stays 'answered'."""
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _answered_request(client, make_agent, make_request)
    base = time.time()
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["nudged"] is True and d["nudged_role"] == "requester"
    assert d["nudged_agent_id"] == owner["agent_id"]
    assert d["status"] == "answered"
    pev = await _wait_prompt(client, owner["agent_id"], since_ts=base)
    assert pev["event"] == "prompt", pev
    assert rid[:8] in pev["message"]
    # the TARGET (no longer owing anything) is NOT poked
    tev = await _wait_prompt(client, target["agent_id"], since_ts=base, timeout=1)
    assert tev["event"] == "timeout", tev
    assert _status(db, rid) == "answered"


# ---------- task-aware routing (accept/reject verbs + full task context) ----------

async def test_open_task_request_pokes_target_to_accept_reject_with_context(
        client, make_agent, make_request, db):
    """open + type='task' → the TARGET is poked to ACCEPT/REJECT (not 'respond'), and the poke
    re-delivers the full task ask (title / description / definition of done / protocol) so the
    woken agent can decide even though the original request_created event was consumed."""
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _rich_task_request(client, make_agent, make_request)
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["nudged"] is True and d["nudged_role"] == "target"
    assert d["nudged_agent_id"] == target["agent_id"]
    pev = await _wait_prompt(client, target["agent_id"])
    assert pev["event"] == "prompt", pev
    msg = pev["message"]
    # task verbs, NOT the info-request "respond"
    assert "/orcha-accept-task" in msg and "/orcha-reject-task" in msg
    assert "/orcha-respond" not in msg
    # full task context is re-delivered into the poke
    assert "Ship the widget" in msg
    assert "build and test the widget" in msg
    assert "tests pass and PR open" in msg
    assert "Target -> Code Reviewer -> human" in msg   # protocol review_chain
    assert "do not merge" in msg                        # protocol notes
    # SELECT-only: still open
    assert _status(db, rid) == "open"


async def test_answered_task_request_pokes_requester_to_act_or_close(
        client, make_agent, make_request, db):
    """answered + type='task' → the REQUESTER is poked to act on the result or close it; the poke
    names the task and points at /orcha-close (not /orcha-respond / accept-reject)."""
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _answered_task_request(client, make_agent, make_request)
    base = time.time()
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["nudged"] is True and d["nudged_role"] == "requester"
    assert d["nudged_agent_id"] == owner["agent_id"]
    pev = await _wait_prompt(client, owner["agent_id"], since_ts=base)
    assert pev["event"] == "prompt", pev
    msg = pev["message"]
    assert "Ship the widget" in msg
    assert "/orcha-close" in msg
    assert "/orcha-accept-task" not in msg
    assert _status(db, rid) == "answered"


# ---------- human owns the next action → clean no-op (no poke, no state change) ----------

async def test_escalated_to_human_is_noop(client, make_agent, make_request, db):
    """An escalated request stays 'open' but is retargeted to the human, so the next action is a
    human's → 200 {nudged:false}, no poke, status unchanged."""
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _open_request(client, make_agent, make_request)
    e = await client.post(f"/api/requests/{rid}/escalate",
                          json={"requester_agent_id": owner["agent_id"]})
    assert e.status_code == 200, e.text
    base = time.time()
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["nudged"] is False and d["nudged_agent_id"] is None
    assert d["status"] == "open"
    pev = await _wait_prompt(client, human["agent_id"], since_ts=base, timeout=1)
    assert pev["event"] == "timeout", pev
    assert _status(db, rid) == "open"


async def test_no_target_at_birth_is_noop(client, make_agent, make_request, db):
    """A request created with no target is escalate-to-human at birth (target = the human), so the
    next action is a human's → 200 {nudged:false}, no poke."""
    human = await make_agent("Boss", kind="human")
    owner = await make_agent("Owner", kind="ai")
    req = await make_request(owner["agent_id"], "anyone?")  # no target_alias → human
    base = time.time()
    r = await client.post(f"/api/requests/{req['id']}/nudge",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["nudged"] is False
    pev = await _wait_prompt(client, human["agent_id"], since_ts=base, timeout=1)
    assert pev["event"] == "timeout", pev


# ---------- non-actionable states → 409, no poke, no state change ----------

async def test_accepted_returns_409_and_is_unchanged(client, make_agent, make_request, db):
    """accepted → the request became a task; nudge the task, not the request. 409, status stays
    'accepted', spawned_task_id intact, no poke."""
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _task_request(client, make_agent, make_request)
    a = await client.post(f"/api/requests/{rid}/accept-task",
                          json={"responder_agent_id": target["agent_id"]})
    assert a.status_code == 200, a.text
    spawned = a.json().get("spawned_task_id")
    base = time.time()
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 409, r.text
    assert "task" in r.json()["detail"].lower()
    assert _status(db, rid) == "accepted"
    row = db.execute("SELECT spawned_task_id FROM requests WHERE id=%s", (rid,))[0]
    assert str(row["spawned_task_id"]) == str(spawned)
    pev = await _wait_prompt(client, target["agent_id"], since_ts=base, timeout=1)
    assert pev["event"] == "timeout", pev


async def test_rejected_returns_409(client, make_agent, make_request, db):
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _task_request(client, make_agent, make_request)
    j = await client.post(f"/api/requests/{rid}/reject-task",
                          json={"responder_agent_id": target["agent_id"], "reason": "not me"})
    assert j.status_code == 200, j.text
    base = time.time()
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 409, r.text
    assert "rejected" in r.json()["detail"]
    assert _status(db, rid) == "rejected"
    pev = await _wait_prompt(client, owner["agent_id"], since_ts=base, timeout=1)
    assert pev["event"] == "timeout", pev


async def test_converted_to_task_returns_409(client, make_agent, make_request, db):
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _answered_request(client, make_agent, make_request)
    c = await client.post(f"/api/requests/{rid}/convert-to-task",
                          json={"requester_agent_id": owner["agent_id"],
                                "title": "follow up", "definition_of_done": "done when Y"})
    assert c.status_code == 200, c.text
    base = time.time()
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 409, r.text
    assert "converted_to_task" in r.json()["detail"]
    assert _status(db, rid) == "converted_to_task"
    pev = await _wait_prompt(client, owner["agent_id"], since_ts=base, timeout=1)
    assert pev["event"] == "timeout", pev


async def test_closed_returns_409(client, make_agent, make_request, db):
    human = await make_agent("Boss", kind="human")
    owner, target, rid = await _answered_request(client, make_agent, make_request)
    cl = await client.post(f"/api/requests/{rid}/close",
                           json={"requester_agent_id": owner["agent_id"]})
    assert cl.status_code == 200, cl.text
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 409, r.text
    assert "closed" in r.json()["detail"]
    assert _status(db, rid) == "closed"


# ---------- actor gate ----------

async def test_non_human_actor_forbidden(client, make_agent, make_request, db):
    """Nudging is a human operator action — an AI actor gets 403, and nothing is poked."""
    owner, target, rid = await _open_request(client, make_agent, make_request)
    base = time.time()
    r = await client.post(f"/api/requests/{rid}/nudge",
                          json={"actor_agent_id": owner["agent_id"]})  # AI actor
    assert r.status_code == 403, r.text
    assert _status(db, rid) == "open"
    pev = await _wait_prompt(client, target["agent_id"], since_ts=base, timeout=1)
    assert pev["event"] == "timeout", pev
