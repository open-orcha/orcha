"""Task-request state machine (Orcha#22): accept/reject, suggest-agent, decide, cap."""
import asyncio


def _task_payload(title="do work", dod="done"):
    return {"title": title, "definition_of_done": dod, "priority": 100}


async def test_accept_task_spawns_and_assigns(client, make_agent, make_request, db):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "please build X", target_alias="b",
                             type="task", task=_task_payload())
    r = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                          json={"responder_agent_id": b["agent_id"], "note": "on it"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "accepted" and body["spawned_task_id"]
    # the spawned task is assigned to the accepter
    rows = db.execute("SELECT 1 FROM agent_tasks WHERE agent_id=%s AND task_id=%s",
                      (b["agent_id"], body["spawned_task_id"]))
    assert rows, "accepted task should be assigned to the responder"


async def test_accept_task_carries_protocol_into_spawned_task(client, make_agent, make_request, db):
    """GH #55: a task request may carry a `protocol` block (rides in the request's `detail`
    JSONB). On accept, the spawned task's protocol is populated from it — so the accepter reads
    the loop rules on the very wake this accept triggers, with NO follow-up PATCH.

    GH #56 (Point 4.4): the carried fields ride verbatim, EXCEPT `notes`, onto which accept now
    PREPENDS a report-back instruction (so the accepter learns to report back from the protocol it
    reads every wake). Report-back leads; the carried notes follow — review P2: prepending keeps
    the report-back line from being tail-truncated away when carried notes are near the field cap."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    task = _task_payload()
    task["protocol"] = {"review_chain": "b -> a -> human", "handoff_to": "a",
                        "autonomy": "ship small fixes", "notes": "loop until clean"}
    req = await make_request(a["agent_id"], "build X with loop rules", target_alias="b",
                             type="task", task=task)
    r = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                          json={"responder_agent_id": b["agent_id"], "note": "on it"})
    assert r.status_code == 200, r.text
    tid = r.json()["spawned_task_id"]
    rows = db.execute("SELECT protocol FROM tasks WHERE id=%s", (tid,))
    proto = rows[0]["protocol"]
    assert proto, "spawned task should carry the request's protocol"
    assert proto["review_chain"] == "b -> a -> human"
    assert proto["handoff_to"] == "a"
    assert proto["autonomy"] == "ship small fixes"
    # GH #56 Point 4.4 (review P2): report-back leads, carried notes preserved as the suffix.
    assert proto["notes"].startswith("REPORT BACK")
    assert proto["notes"].rstrip().endswith("loop until clean")
    assert req["request_id"] in proto["notes"]


async def test_accept_task_without_protocol_injects_report_back(client, make_agent, make_request, db):
    """GH #56 (Point 4.4): a task request with no protocol still spawns a task whose protocol
    carries the auto-injected report-back instruction in `notes` (so the accepter learns to report
    back). No other fields are set — only `notes` is populated. The report-back is decoupled from
    /orcha-done and names the request to post back to."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="b",
                             type="task", task=_task_payload())
    r = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                          json={"responder_agent_id": b["agent_id"], "note": "on it"})
    assert r.status_code == 200, r.text
    rows = db.execute("SELECT protocol FROM tasks WHERE id=%s", (r.json()["spawned_task_id"],))
    proto = rows[0]["protocol"]
    assert proto is not None and "REPORT BACK" in proto["notes"]
    assert req["request_id"] in proto["notes"]
    assert "orcha-done" in proto["notes"].lower()  # explicitly decoupled from /orcha-done
    # only notes is populated — the other SPEC-4 fields stay unset
    assert not proto.get("review_chain") and not proto.get("handoff_to")


async def test_accept_task_response_echoes_report_back(client, make_agent, make_request, db):
    """GH #56 review P1: the SAME worker session that accepts a task-request keeps working it
    without reloading the spawned task's protocol, so the report-back note in protocol.notes is
    invisible on that wake. The accept RESPONSE must echo the report-back instruction (and the
    request id to post it back to) so /orcha-accept-task can surface it in-session."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="b",
                             type="task", task=_task_payload())
    r = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                          json={"responder_agent_id": b["agent_id"], "note": "on it"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "REPORT BACK" in body["report_back"]
    assert req["request_id"] in body["report_back"]
    assert body["report_back_request_id"] == req["request_id"]


async def test_accept_task_report_back_survives_max_length_notes(client, make_agent, make_request, db):
    """GH #56 review P2: a carried `notes` near the 4 KB per-field cap must NOT tail-truncate the
    report-back instruction away — it's the mechanism that tells the accepter to answer the request.
    With max-length notes, the spawned protocol must still LEAD with REPORT BACK and stay within the
    field cap, keeping (a prefix of) the carried notes after it."""
    from orcha_cli.templates.portal.main import MAX_PROTOCOL_FIELD_LEN
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    task = _task_payload()
    huge = "X" * MAX_PROTOCOL_FIELD_LEN  # exactly fills the field on its own
    task["protocol"] = {"notes": huge}
    req = await make_request(a["agent_id"], "build X", target_alias="b",
                             type="task", task=task)
    r = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                          json={"responder_agent_id": b["agent_id"], "note": "on it"})
    assert r.status_code == 200, r.text
    rows = db.execute("SELECT protocol FROM tasks WHERE id=%s", (r.json()["spawned_task_id"],))
    notes = rows[0]["protocol"]["notes"]
    assert notes.startswith("REPORT BACK")            # never dropped
    assert req["request_id"] in notes                 # the post-back target survives intact
    assert len(notes) <= MAX_PROTOCOL_FIELD_LEN       # still within the cap


async def test_accept_task_idempotent_no_duplicate_task(client, make_agent, make_request, db):
    """R2.3: re-accepting an already-accepted task request returns the SAME spawned
    task_id (200) and does NOT create a second task — safe under at-least-once replay."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="b",
                             type="task", task=_task_payload())
    rid = req["request_id"]
    r1 = await client.post(f"/api/requests/{rid}/accept-task",
                           json={"responder_agent_id": b["agent_id"], "note": "on it"})
    assert r1.status_code == 200 and r1.json()["status"] == "accepted"
    tid = r1.json()["spawned_task_id"]
    r2 = await client.post(f"/api/requests/{rid}/accept-task",
                           json={"responder_agent_id": b["agent_id"], "note": "retry"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["status"] == "accepted"
    assert r2.json()["spawned_task_id"] == tid          # same task, not a new one
    assert r2.json().get("already_accepted") is True
    # GH #56 review P-retry: a retry (first accept response lost) is the ONLY thing the same
    # worker session sees, so it MUST also carry the report-back instruction — identical to
    # the fresh accept's — or the worker misses it and falls through to the Point 5 backstop.
    assert "REPORT BACK" in r2.json()["report_back"]
    assert rid in r2.json()["report_back"]
    assert r2.json()["report_back_request_id"] == rid
    assert r2.json()["report_back"] == r1.json()["report_back"]   # fresh and retry agree exactly
    # exactly ONE task was spawned from this request
    rows = db.execute("SELECT count(*) AS n FROM tasks WHERE title=%s", ("do work",))
    assert rows[0]["n"] == 1, "retry must not spawn a duplicate task"
    # a non-target accepting is still a genuine 403
    intruder = await make_agent("c", "eng")
    bad = await client.post(f"/api/requests/{rid}/accept-task",
                            json={"responder_agent_id": intruder["agent_id"], "note": "x"})
    assert bad.status_code == 403, bad.text


async def test_accept_task_concurrent_retries_spawn_one_task(client, make_agent, make_request, db):
    """R2.3 under OVERLAP (not just sequential): N concurrent accept-task retries must
    spawn EXACTLY ONE task. The read-then-write was racy — two callers could both read
    status='open' and both spawn — so `_require_request(for_update=True)` now locks the
    row; the losers block, re-read 'accepted', and return the SAME spawned_task_id."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build", target_alias="b",
                             type="task", task=_task_payload(title="raceX"))
    rid = req["request_id"]

    async def accept():
        return await client.post(f"/api/requests/{rid}/accept-task",
                                 json={"responder_agent_id": b["agent_id"], "note": "go"})

    results = await asyncio.gather(*[accept() for _ in range(5)])
    assert all(r.status_code == 200 for r in results), [r.status_code for r in results]
    ids = {r.json()["spawned_task_id"] for r in results}
    assert len(ids) == 1, f"all concurrent retries must return the SAME task, got {ids}"
    rows = db.execute("SELECT count(*) AS n FROM tasks WHERE title=%s", ("raceX",))
    assert rows[0]["n"] == 1, f"exactly one task may be spawned under overlap, got {rows[0]['n']}"


async def test_respond_concurrent_retries_one_winner(client, make_agent, make_request, db):
    """R2.3 under OVERLAP: N concurrent responses must not both write. One wins; the
    rest return the winner's answer (already_answered) — the row lock makes the
    'original answer preserved' guarantee hold under overlap, not just sequentially."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]

    async def respond(i):
        return await client.post(f"/api/requests/{rid}/respond",
                                 json={"responder_agent_id": b["agent_id"], "response": f"ans{i}"})

    results = await asyncio.gather(*[respond(i) for i in range(5)])
    assert all(r.status_code == 200 for r in results)
    winners = [r for r in results if not r.json().get("already_answered")]
    assert len(winners) == 1, "exactly one responder writes; the rest are idempotent no-ops"
    # every idempotent reply echoes the single stored answer
    stored = db.execute("SELECT response FROM requests WHERE id=%s", (rid,))[0]["response"]
    for r in results:
        if r.json().get("already_answered"):
            assert r.json()["response"] == stored


async def test_accept_vs_reject_concurrent_one_wins_consistent_state(client, make_agent, make_request, db):
    """Competing mutations on the SAME request must also serialize: a concurrent
    accept-task and reject-task can't BOTH win. Before the lock, reject (unlocked) could
    overwrite a locked accept -> status='rejected' WITH spawned_task_id set and a live
    assigned task. Now every mutator takes FOR UPDATE, so exactly one wins and the row
    is internally consistent."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build", target_alias="b",
                             type="task", task=_task_payload(title="raceAR"))
    rid = req["request_id"]

    async def accept():
        return await client.post(f"/api/requests/{rid}/accept-task",
                                 json={"responder_agent_id": b["agent_id"], "note": "go"})

    async def reject():
        return await client.post(f"/api/requests/{rid}/reject-task",
                                 json={"responder_agent_id": b["agent_id"], "reason": "no"})

    acc, rej = await asyncio.gather(accept(), reject())
    # exactly one mutation succeeded; the loser hit the now-terminal state with 409
    codes = sorted([acc.status_code, rej.status_code])
    assert codes == [200, 409], f"exactly one winner expected, got {codes}"

    row = db.execute("SELECT status, spawned_task_id FROM requests WHERE id=%s", (rid,))[0]
    ntasks = db.execute("SELECT count(*) AS n FROM tasks WHERE title=%s", ("raceAR",))[0]["n"]
    if row["status"] == "accepted":
        assert row["spawned_task_id"] is not None and ntasks == 1
    else:
        assert row["status"] == "rejected"
        assert row["spawned_task_id"] is None and ntasks == 0   # no orphaned task


async def test_reject_task_records_reason(client, make_agent, make_request):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build Y", target_alias="b",
                             type="task", task=_task_payload())
    r = await client.post(f"/api/requests/{req['request_id']}/reject-task",
                          json={"responder_agent_id": b["agent_id"], "reason": "out of scope"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rejected" and r.json()["reason"] == "out of scope"


async def test_suggest_agent_stores_detail(client, make_agent, make_request, db):
    human = await make_agent("human", "operator", kind="human")
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build Z", target_alias="b",
                             type="task", task=_task_payload())
    await client.post(f"/api/requests/{req['request_id']}/reject-task",
                      json={"responder_agent_id": b["agent_id"], "reason": "not me"})
    s = await client.post(f"/api/requests/{req['request_id']}/suggest-agent",
                          json={"requester_agent_id": a["agent_id"],
                                "proposed_alias": "specialist", "proposed_role": "z-expert",
                                "proposed_prompt": "You are a Z expert.",
                                "rationale": "need Z skills"})
    assert s.status_code == 200, s.text
    rows = db.execute("SELECT detail FROM requests WHERE id=%s", (req["request_id"],))
    assert rows and rows[0]["detail"] is not None


async def test_decide_suggestion_create(client, container, make_agent, make_request, db):
    db.execute("UPDATE containers SET max_auto_agents=20 WHERE id=%s", (container["id"],))
    human = await make_agent("human", "operator", kind="human")
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build", target_alias="b",
                             type="task", task=_task_payload())
    await client.post(f"/api/requests/{req['request_id']}/reject-task",
                      json={"responder_agent_id": b["agent_id"], "reason": "no"})
    await client.post(f"/api/requests/{req['request_id']}/suggest-agent",
                      json={"requester_agent_id": a["agent_id"], "proposed_alias": "newbot",
                            "proposed_role": "eng", "proposed_prompt": "p", "rationale": "r"})
    d = await client.post(f"/api/agent-suggestions/{req['request_id']}/decide",
                          json={"kind": "create", "actor_agent_id": human["agent_id"]})
    assert d.status_code == 200, d.text
    assert d.json()["kind"] == "create"
    rows = db.execute("SELECT 1 FROM agents WHERE alias='newbot'")
    assert rows, "decide(create) should create the proposed agent"


async def test_decide_suggestion_refuse(client, make_agent, make_request):
    human = await make_agent("human", "operator", kind="human")
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build", target_alias="b",
                             type="task", task=_task_payload())
    await client.post(f"/api/requests/{req['request_id']}/reject-task",
                      json={"responder_agent_id": b["agent_id"], "reason": "no"})
    await client.post(f"/api/requests/{req['request_id']}/suggest-agent",
                      json={"requester_agent_id": a["agent_id"], "proposed_alias": "nope",
                            "proposed_role": "eng", "proposed_prompt": "p", "rationale": "r"})
    d = await client.post(f"/api/agent-suggestions/{req['request_id']}/decide",
                          json={"kind": "refuse", "reason": "not needed",
                                "actor_agent_id": human["agent_id"]})
    assert d.status_code == 200 and d.json()["kind"] == "refuse"


async def test_decide_is_human_only(client, make_agent, make_request):
    human = await make_agent("human", "operator", kind="human")
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "build", target_alias="b",
                             type="task", task=_task_payload())
    await client.post(f"/api/requests/{req['request_id']}/reject-task",
                      json={"responder_agent_id": b["agent_id"], "reason": "no"})
    await client.post(f"/api/requests/{req['request_id']}/suggest-agent",
                      json={"requester_agent_id": a["agent_id"], "proposed_alias": "x",
                            "proposed_role": "eng", "proposed_prompt": "p", "rationale": "r"})
    d = await client.post(f"/api/agent-suggestions/{req['request_id']}/decide",
                          json={"kind": "create", "actor_agent_id": a["agent_id"]})
    assert d.status_code == 403, d.text


async def test_max_auto_agents_cap(client, container, make_agent, make_request, db):
    # cap the container so no new agent can be created
    db.execute("UPDATE containers SET max_auto_agents=3 WHERE id=%s", (container["id"],))
    human = await make_agent("human", "operator", kind="human")
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")  # now at 3 agents == cap
    req = await make_request(a["agent_id"], "build", target_alias="b",
                             type="task", task=_task_payload())
    await client.post(f"/api/requests/{req['request_id']}/reject-task",
                      json={"responder_agent_id": b["agent_id"], "reason": "no"})
    await client.post(f"/api/requests/{req['request_id']}/suggest-agent",
                      json={"requester_agent_id": a["agent_id"], "proposed_alias": "overflow",
                            "proposed_role": "eng", "proposed_prompt": "p", "rationale": "r"})
    d = await client.post(f"/api/agent-suggestions/{req['request_id']}/decide",
                          json={"kind": "create", "actor_agent_id": human["agent_id"]})
    assert d.status_code == 409, "creating past max_auto_agents must be rejected"
