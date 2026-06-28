"""GH #56 — bind protocols & close request loops.

Covers the request↔task lifecycle changes that make the loop self-closing and the protocol
act, layered on the #56 backbone (originating_task_id + the accepted→answered waypoint):

- Point 2  — _render_protocol marks review_chain/handoff_to/notes BINDING, autonomy ADVISORY.
- Point 3  — requests.originating_task_id is agent-supplied + server-validated (FLAG 2b); null
             passes; the request_answered event carries it (FLAG 2a a); wake-scan attaches the
             answer-wake to it (FLAG 2a b); the protocol load keys off it (FLAG 2a d).
- Point 4  — an `accepted` request can be answered (accepted→answered), and the REQUESTER (not the
             accepter) closes it (answered→closed).
- Point 5  — the backstop auto-answers a stranded `accepted` request when the accepter's spawned
             task reaches a terminal state without a hand report-back.
"""
import sys


def _task_payload(title="do work", dod="done"):
    return {"title": title, "definition_of_done": dod, "priority": 100}


# ===================== Point 2 — protocol render (pure notifier fn) =====================

def test_render_protocol_marks_binding_and_advisory():
    """TOOTH (Point 2): the wake-injected protocol frames review_chain / handoff_to / notes as
    BINDING imperatives the agent must act on, and autonomy as ADVISORY (the real gate is the
    container setting). The values still render verbatim."""
    import orcha_cli.notifier as notifier
    out = notifier._render_protocol({"protocol": {
        "review_chain": "Reviewer -> kedar",
        "handoff_to": "WebsiteAgent",
        "autonomy": "ship small fixes",
        "notes": "loop until clean",
    }})
    assert out is not None
    assert "BINDING" in out                       # review_chain / handoff_to / notes are binding
    assert "ADVISORY" in out                      # autonomy is explicitly advisory
    # the autonomy label, not the others, carries the advisory marker
    autonomy_line = [ln for ln in out.splitlines() if "ship small fixes" in ln][0]
    assert "ADVISORY" in autonomy_line
    review_line = [ln for ln in out.splitlines() if "Reviewer -> kedar" in ln][0]
    assert "BINDING" in review_line
    # values survive
    for v in ("Reviewer -> kedar", "WebsiteAgent", "ship small fixes", "loop until clean"):
        assert v in out


def test_render_protocol_none_when_empty():
    assert sys.modules.get("orcha_cli.notifier") or True  # import guard
    import orcha_cli.notifier as notifier
    assert notifier._render_protocol({"protocol": None}) is None


def test_render_task_body_surfaces_full_spec():
    """GH #33: the wake-injected task section carries title + description + definition_of_done so a
    woken worker acts on the complete spec, not the title alone — and is told to honor loops."""
    import orcha_cli.notifier as notifier
    out = notifier._render_task_body({
        "task_id": "t-1", "title": "loop the thing",
        "description": "Run the loop 5 times; each pass appends a line.",
        "definition_of_done": "all 5 iterations logged", "protocol": None,
    })
    assert out is not None
    assert "Run the loop 5 times" in out
    assert "all 5 iterations logged" in out
    assert "loop" in out and "title alone" in out  # directive to not work off the title


def test_render_task_body_none_when_no_task_or_title_only():
    """No resolved task → no section (cold/idle wake). A title with no description/DoD adds nothing
    over what the worker already has, so it is also suppressed."""
    import orcha_cli.notifier as notifier
    assert notifier._render_task_body({"task_id": None, "protocol": None}) is None
    assert notifier._render_task_body(None) is None
    assert notifier._render_task_body({"task_id": "t-1", "title": "just a title"}) is None


def test_format_persona_injects_task_body():
    """GH #33: the full task body rides in the appended system prompt on every resolved-task wake."""
    import orcha_cli.notifier as notifier
    out = notifier.format_persona(
        {"system_prompt": "You are Eng."}, None,
        {"task_id": "t-1", "title": "loop it", "description": "loop 5x",
         "definition_of_done": "5 lines logged", "protocol": None})
    assert out is not None
    assert "Your task" in out and "loop 5x" in out and "5 lines logged" in out
    assert notifier._render_protocol(None) is None


# ===================== Point 3 — originating_task_id validation (FLAG 2b) =====================

async def test_originating_task_id_valid_when_requester_participates(
        client, container, make_agent, make_task, db):
    a = await make_agent("areq", "eng")
    t = await make_task("a's task", "done", assignee_alias="areq")
    r = await client.post(f"/api/containers/{container['id']}/requests", json={
        "requester_agent_id": a["agent_id"], "payload": "q", "type": "info",
        "target_alias": "areq", "originating_task_id": t["id"]})
    assert r.status_code == 201, r.text
    assert r.json()["originating_task_id"] == t["id"]
    rows = db.execute("SELECT originating_task_id FROM requests WHERE id=%s", (r.json()["request_id"],))
    assert str(rows[0]["originating_task_id"]) == t["id"]


async def test_originating_task_id_rejected_when_foreign(
        client, container, make_agent, make_task):
    """A supplied id the requester does NOT participate in is rejected (400) — a stale/foreign id
    would otherwise route the answer's wake to the wrong task, silently."""
    a = await make_agent("areq", "eng")
    b = await make_agent("bother", "eng")
    foreign = await make_task("b's task", "done", assignee_alias="bother")
    r = await client.post(f"/api/containers/{container['id']}/requests", json={
        "requester_agent_id": a["agent_id"], "payload": "q", "type": "info",
        "target_alias": "bother", "originating_task_id": foreign["id"]})
    assert r.status_code == 400
    assert "participates in" in r.text


async def test_originating_task_id_invalid_uuid_rejected(client, container, make_agent):
    a = await make_agent("areq", "eng")
    b = await make_agent("bb", "eng")
    r = await client.post(f"/api/containers/{container['id']}/requests", json={
        "requester_agent_id": a["agent_id"], "payload": "q", "type": "info",
        "target_alias": "bb", "originating_task_id": "not-a-uuid"})
    assert r.status_code == 400


async def test_originating_task_id_null_passes(client, container, make_agent, db):
    a = await make_agent("areq", "eng")
    b = await make_agent("bb", "eng")
    r = await client.post(f"/api/containers/{container['id']}/requests", json={
        "requester_agent_id": a["agent_id"], "payload": "q", "type": "info", "target_alias": "bb"})
    assert r.status_code == 201
    rows = db.execute("SELECT originating_task_id FROM requests WHERE id=%s", (r.json()["request_id"],))
    assert rows[0]["originating_task_id"] is None


# ===================== Point 3 — answer carries it (FLAG 2a a) =====================

async def test_request_answered_event_carries_originating_task_id(
        client, container, make_agent, make_task, make_request, db):
    a = await make_agent("areq", "eng")
    b = await make_agent("bb", "eng")
    t = await make_task("a's task", "done", assignee_alias="areq")
    req = await make_request(a["agent_id"], "look into Y", target_alias="bb",
                             originating_task_id=t["id"])
    r = await client.post(f"/api/requests/{req['request_id']}/respond",
                          json={"responder_agent_id": b["agent_id"], "response": "here is Y"})
    assert r.status_code == 200, r.text
    evs = db.event_rows(a["agent_id"])
    answered = [e for e in evs if e["event_name"] == "request_answered"]
    assert answered, "requester should get a request_answered event"
    assert str(answered[-1]["payload"]["originating_task_id"]) == t["id"]


# ===================== Point 4 — accepted → answered → closed =====================

async def test_accepted_request_can_be_answered_then_requester_closes(
        client, container, make_agent, make_request, db):
    a = await make_agent("areq", "eng")
    b = await make_agent("bb", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task=_task_payload())
    rid = req["request_id"]
    acc = await client.post(f"/api/requests/{rid}/accept-task",
                            json={"responder_agent_id": b["agent_id"], "note": "on it"})
    assert acc.status_code == 200 and acc.json()["status"] == "accepted"
    # accepter posts the real result → accepted → answered (Point 4)
    ans = await client.post(f"/api/requests/{rid}/respond",
                            json={"responder_agent_id": b["agent_id"], "response": "X is built, see PR"})
    assert ans.status_code == 200, ans.text
    assert db.execute("SELECT status FROM requests WHERE id=%s", (rid,))[0]["status"] == "answered"
    # the accepter must NOT be able to close — only the requester closes (answered → closed)
    bad = await client.post(f"/api/requests/{rid}/close", json={"requester_agent_id": b["agent_id"]})
    assert bad.status_code == 403
    good = await client.post(f"/api/requests/{rid}/close", json={"requester_agent_id": a["agent_id"]})
    assert good.status_code == 200
    assert db.execute("SELECT status FROM requests WHERE id=%s", (rid,))[0]["status"] == "closed"


# ===================== Point 6 — accept does not wake the requester =====================

async def test_accept_task_does_not_wake_requester(
        client, container, make_agent, make_request, db):
    a = await make_agent("areq", "eng")
    b = await make_agent("bb", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task=_task_payload())
    await client.post(f"/api/requests/{req['request_id']}/accept-task",
                      json={"responder_agent_id": b["agent_id"], "note": "on it"})
    # No wake-worthy event toward the requester from the accept alone (only the answer wakes).
    evs = db.event_rows(a["agent_id"])
    assert not [e for e in evs if e["event_name"] in ("task_request_accepted", "request_answered")]


# ===================== Point 5 — backstop auto-answers a stranded accept =====================

async def test_backstop_auto_answers_when_accepter_task_terminal(
        client, container, make_agent, make_task, make_request, db):
    """If the accepter's spawned task reaches needs_verification/completed while the request is
    STILL 'accepted' (no report-back), the backstop auto-answers it so the requester's loop closes.
    The wake event is flagged backstop=true and an auto_answered audit row is logged."""
    a = await make_agent("areq", "eng")
    b = await make_agent("bb", "eng")
    a_task = await make_task("a's originating task", "done", assignee_alias="areq")
    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task=_task_payload(), originating_task_id=a_task["id"])
    rid = req["request_id"]
    acc = await client.post(f"/api/requests/{rid}/accept-task",
                            json={"responder_agent_id": b["agent_id"], "note": "on it"})
    spawned = acc.json()["spawned_task_id"]
    # accepter marks the spawned task done WITHOUT reporting back → backstop fires.
    done = await client.post(f"/api/tasks/{spawned}/done",
                             json={"agent_id": b["agent_id"], "result": "did it"})
    assert done.status_code == 200, done.text
    assert db.execute("SELECT status FROM requests WHERE id=%s", (rid,))[0]["status"] == "answered"
    # requester got a backstop-flagged answer carrying the originating task link
    evs = [e for e in db.event_rows(a["agent_id"]) if e["event_name"] == "request_answered"]
    assert evs and evs[-1]["payload"].get("backstop") is True
    assert str(evs[-1]["payload"]["originating_task_id"]) == a_task["id"]
    # audit row logged so a leaking primary path is observable
    audit = db.execute(
        "SELECT 1 FROM events WHERE entity_id=%s AND event_type='auto_answered'", (rid,))
    assert audit, "backstop should log an auto_answered audit row"


# ===================== Point 3 (FLAG 2a d) — protocol load keys off the link =====================

async def test_protocol_endpoint_honors_task_id_hint(
        client, container, make_agent, make_task):
    """With a task_id hint the agent participates in, /protocol returns THAT task's protocol —
    not a guess at the agent's one in_progress task (the wrong-protocol-with-many-in-progress fix)."""
    agent = await make_agent("multi", "eng")
    t1 = await make_task("task one", "done", assignee_alias="multi")
    t2 = await make_task("task two", "done", assignee_alias="multi")
    await client.patch(f"/api/tasks/{t1['id']}/protocol",
                       json={"actor_agent_id": agent["agent_id"], "notes": "rules for ONE"})
    await client.patch(f"/api/tasks/{t2['id']}/protocol",
                       json={"actor_agent_id": agent["agent_id"], "notes": "rules for TWO"})
    r1 = await client.get(f"/api/agents/{agent['agent_id']}/protocol", params={"task_id": t1["id"]})
    r2 = await client.get(f"/api/agents/{agent['agent_id']}/protocol", params={"task_id": t2["id"]})
    assert r1.json()["task_id"] == t1["id"] and r1.json()["protocol"]["notes"] == "rules for ONE"
    assert r2.json()["task_id"] == t2["id"] and r2.json()["protocol"]["notes"] == "rules for TWO"


async def test_protocol_endpoint_ignores_foreign_task_id_hint(
        client, container, make_agent, make_task):
    """A hint the agent does NOT participate in is ignored (no protocol leak) — it falls back to the
    in_progress guess, which is empty here, so the protocol is null."""
    agent = await make_agent("noparticipate", "eng")
    other = await make_agent("owner", "eng")
    foreign = await make_task("owner's task", "done", assignee_alias="owner")
    await client.patch(f"/api/tasks/{foreign['id']}/protocol",
                       json={"actor_agent_id": other["agent_id"], "notes": "secret rules"})
    r = await client.get(f"/api/agents/{agent['agent_id']}/protocol", params={"task_id": foreign["id"]})
    assert r.status_code == 200
    assert r.json()["protocol"] is None  # foreign protocol never leaks; fell back to the (empty) guess


async def test_protocol_endpoint_carries_full_task_body(
        client, container, make_agent, make_task):
    """GH #33: the /protocol endpoint — the surface fetched fresh on EVERY wake and injected into
    the persona — carries the resolved task's FULL body (title + description + definition_of_done),
    so the request-answer (originating-link) and in-progress direct-assignment paths both surface
    the complete spec, not just the title. Body rides even when no protocol is set."""
    agent = await make_agent("bodyreader", "eng")
    t = await make_task("loop the thing", "all 5 iterations logged", assignee_alias="bodyreader",
                        description="Run the loop 5 times; each pass appends a line.")
    # via the explicit originating-task hint (the request-answer wake path)
    r = await client.get(f"/api/agents/{agent['agent_id']}/protocol", params={"task_id": t["id"]})
    body = r.json()
    assert body["task_id"] == t["id"]
    assert body["title"] == "loop the thing"
    assert body["description"] == "Run the loop 5 times; each pass appends a line."
    assert body["definition_of_done"] == "all 5 iterations logged"
    assert body["protocol"] is None  # body rides independent of whether a protocol is set


# ===================== Point 3 (FLAG 2a b) — wake-scan attaches the answer to the task =====================

async def test_wake_scan_attaches_answer_wake_to_originating_task(
        client, container, make_agent, make_task, make_request, db):
    """After an answer comes back, wake-scan surfaces the requester with wake_task_id set to the
    request's originating_task_id — so run-attribution stamps the wake against that task's thread."""
    a = await make_agent("areq", "eng")
    b = await make_agent("bb", "eng")
    t = await make_task("a's task", "done", assignee_alias="areq")
    req = await make_request(a["agent_id"], "look into Y", target_alias="bb",
                             originating_task_id=t["id"])
    await client.post(f"/api/requests/{req['request_id']}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "answer"})
    scan = await client.get(f"/api/containers/{container['id']}/wake-scan",
                            params={"cooldown": 0, "min_idle": 0})
    assert scan.status_code == 200, scan.text
    cand = [c for c in scan.json()["candidates"] if c["agent_id"] == a["agent_id"]][0]
    assert cand["wake_task_id"] == t["id"]
