"""GH #58 — drain all handleable notifications in one run instead of one wake per notification.

Builds on #56's originating-task binding. The server classifies each pending bus event into a
*drain bucket* (`_drain_class`), records a per-(agent,event) ack in `agent_event_acks` (migration
030), and advances the wake cursor to the CONTIGUOUS FLOOR (the ts just below the oldest
still-unhandled waking event) so an event a run could NOT handle re-surfaces instead of being
high-watered past. wake-scan returns the `handled_event_ids` a run may mark + the `context_task_id`
it is bound to; the daemon posts the ids to `/events/ack-handled` on a clean exit.

Coverage:
- _drain_class maps every emitted event_name to exactly one bucket (incl. the subject/status splits).
- /events/ack-handled records per-event acks and advances the contiguous floor (leaves a hole).
- wake-scan drains all SAME-task rows + FYI in one run; LEAVES cross-task task_bound rows pending,
  and re-binds them when a later scan's context is that task.
- NEW_WORK (a `ready` task_assigned) is consumed at the /next claim, not by a drain.
- the two R5-required cross-run cases: a REJECTED verify (DIRECTIVE) and a plan-approval
  decision_made (TASK_BOUND) are never FYI-acked by an unrelated run.
"""
import main


# ----------------------------- helpers -----------------------------

def _cand(scan_json, agent_id):
    """The wake-scan candidate dict for one agent."""
    cands = [c for c in scan_json["candidates"] if c["agent_id"] == agent_id]
    assert cands, f"no wake-scan candidate for {agent_id}"
    return cands[0]


async def _scan(client, cid):
    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    return r.json()


def _event_id(db, agent_id, event_name, *, task_id=None, subject_id=None):
    """The newest agent_events.id for a (key, name) optionally filtered by payload task/subject id."""
    rows = db.execute(
        "SELECT id, payload FROM agent_events WHERE event_key=%s AND event_name=%s ORDER BY id",
        (agent_id, event_name))
    for r in reversed(rows):
        pl = r["payload"] or {}
        if task_id is not None and str(pl.get("task_id")) != str(task_id):
            continue
        if subject_id is not None and str(pl.get("subject_id")) != str(subject_id):
            continue
        return r["id"]
    raise AssertionError(f"no {event_name} event for {agent_id} (task={task_id} subject={subject_id})")


# ===================== _drain_class — the bucket taxonomy =====================

async def test_drain_class_maps_every_event(client, container, make_agent, make_task, make_request, db):
    """Every emitted event_name lands in exactly one bucket — including the status/subject splits
    that R5 hardened (task_assigned by status, task_verified by approved, decision_made by subject)."""
    x = await make_agent("x", "eng")
    ready_t = await make_task("ready one", "done")                 # no assignee → ready
    inprog_t = await make_task("inprog one", "done", assignee_alias="x")   # assignee → in_progress
    info_req = await make_request(x["agent_id"], "q?", target_alias="x", type="info")
    task_req = await make_request(x["agent_id"], "build", target_alias="x",
                                  type="task", task={"title": "t", "definition_of_done": "d"})

    with main.db_cursor() as (conn, cur):
        dc = lambda name, pl=None, **kw: main._drain_class(cur, name, pl, **kw)["bucket"]
        tid_of = lambda name, pl=None, **kw: main._drain_class(cur, name, pl, **kw)["task_id"]

        # NON_WAKING — self-echo / live chat
        assert dc("conversation_turn") == main._DRAIN_NON_WAKING
        # TASK_BOUND
        assert dc("task_message", {"task_id": inprog_t["id"]}) == main._DRAIN_TASK_BOUND
        assert str(tid_of("task_message", {"task_id": inprog_t["id"]})) == inprog_t["id"]
        # request_answered: with a LIVE originating task → TASK_BOUND; without → taskless
        assert dc("request_answered", {"originating_task_id": inprog_t["id"]}) == main._DRAIN_TASK_BOUND
        assert dc("request_answered", {}) == main._DRAIN_TASKLESS_ACTIONABLE
        assert dc("request_answered", {"originating_task_id": "00000000-0000-0000-0000-000000000000"}) \
            == main._DRAIN_TASKLESS_ACTIONABLE
        # request_created: task-type → NEW_WORK; info-type → taskless
        assert dc("request_created", {"type": "task", "request_id": task_req["request_id"]}) \
            == main._DRAIN_NEW_WORK
        assert dc("request_created", {"type": "info", "request_id": info_req["request_id"]}) \
            == main._DRAIN_TASKLESS_ACTIONABLE
        # prompt — taskless actionable
        assert dc("prompt", {"message": "hi"}) == main._DRAIN_TASKLESS_ACTIONABLE
        # task_assigned: ready → NEW_WORK; in_progress → DIRECTIVE; gone → FYI
        assert dc("task_assigned", {"task_id": ready_t["id"]}) == main._DRAIN_NEW_WORK
        assert dc("task_assigned", {"task_id": inprog_t["id"]}) == main._DRAIN_DIRECTIVE
        assert dc("task_assigned", {"task_id": "00000000-0000-0000-0000-000000000000"}) == main._DRAIN_FYI
        # task_ready: targeted + live → NEW_WORK; untargeted broadcast → FYI
        assert dc("task_ready", {"task_id": ready_t["id"]}, target_id=x["agent_id"]) == main._DRAIN_NEW_WORK
        assert dc("task_ready", {"task_id": ready_t["id"]}, target_id=None) == main._DRAIN_FYI
        # task_verified: rejected → DIRECTIVE (rework); approved → FYI
        assert dc("task_verified", {"task_id": inprog_t["id"], "approved": False}) == main._DRAIN_DIRECTIVE
        assert dc("task_verified", {"task_id": inprog_t["id"], "approved": True}) == main._DRAIN_FYI
        # decision_made: plan_approval on a live task → TASK_BOUND(subject); task_close / other → FYI
        assert dc("decision_made", {"subject_type": "plan_approval", "subject_id": inprog_t["id"]}) \
            == main._DRAIN_TASK_BOUND
        assert dc("decision_made", {"subject_type": "task_close", "subject_id": inprog_t["id"]}) \
            == main._DRAIN_FYI
        assert dc("decision_made", {"subject_type": "dummy", "subject_id": "x"}) == main._DRAIN_FYI
        # the residual FYI bucket + graceful degrade on an unknown name
        assert dc("task_unassigned", {"task_id": inprog_t["id"]}) == main._DRAIN_FYI
        assert dc("status_changed", {}) == main._DRAIN_FYI
        assert dc("some_unknown_future_event", {}) == main._DRAIN_FYI


# ===================== /events/ack-handled — per-event ack + contiguous floor =====================

async def test_ack_handled_advances_contiguous_floor_leaving_a_hole(
        client, container, make_agent, make_task, db):
    """Acking events 1 and 3 of a 1-2-3 backlog (event 2 LEFT unhandled) advances the cursor to the
    ts just below event 2 — so event 2 still re-surfaces and event 3, though above the cursor, is
    excluded by its per-event ack. The old GREATEST(max_ts) high-water would have skipped event 2."""
    x = await make_agent("x", "eng")
    t = await make_task("thread", "done", assignee_alias="x")
    poster = await make_agent("poster", "eng")
    # three task_message events for x, in ts order
    ids = []
    for i in range(3):
        await client.post(f"/api/tasks/{t['id']}/messages",
                          json={"author_agent_id": poster["agent_id"], "body": f"note {i}"})
    rows = db.execute("SELECT id, ts FROM agent_events WHERE event_key=%s AND event_name='task_message' "
                      "ORDER BY ts, id", (x["agent_id"],))
    assert len(rows) == 3
    ids = [r["id"] for r in rows]
    # assigning the task at creation emits a task_assigned DIRECTIVE whose ts sits BELOW the three
    # messages; it is a genuine unhandled waking event, so include it in the ack set — otherwise it
    # (not the middle message) is the oldest unhandled row and the floor never reaches the hole.
    assign_id = _event_id(db, x["agent_id"], "task_assigned", task_id=t["id"])

    # ack the assignment + the FIRST and THIRD messages, leaving the MIDDLE one unhandled
    r = await client.post(f"/api/agents/{x['agent_id']}/events/ack-handled",
                          json={"event_ids": [assign_id, ids[0], ids[2]]})
    assert r.status_code == 200, r.text

    # all three acked ids are recorded
    acked = {row["event_id"] for row in db.execute(
        "SELECT event_id FROM agent_event_acks WHERE agent_id=%s", (x["agent_id"],))}
    assert acked == {assign_id, ids[0], ids[2]}
    # cursor parked just below the still-unhandled middle event (a HOLE), not past it
    floor = db.execute("SELECT delivered_ts FROM agent_wake_state WHERE agent_id=%s",
                       (x["agent_id"],))[0]["delivered_ts"]
    assert floor == rows[0]["ts"]               # == ts of event 1, strictly below event 2's ts
    assert floor < rows[1]["ts"]
    # the wake-scan now surfaces ONLY the unhandled middle event
    cand = _cand(await _scan(client, container["id"]), x["agent_id"])
    assert cand["pending_events"] == 1


async def test_ack_handled_is_scoped_to_own_key(client, container, make_agent, make_task, db):
    """A daemon can only ack its OWN agent's events: ack-handled is keyed on the agent, so passing a
    foreign agent's event id is a no-op (the SELECT … WHERE event_key=aid filters it out)."""
    x = await make_agent("x", "eng")
    y = await make_agent("y", "eng")
    t = await make_task("y thread", "done", assignee_alias="y")
    poster = await make_agent("poster", "eng")
    await client.post(f"/api/tasks/{t['id']}/messages",
                      json={"author_agent_id": poster["agent_id"], "body": "for y"})
    y_evid = _event_id(db, y["agent_id"], "task_message", task_id=t["id"])
    # x tries to ack y's event id → ignored
    r = await client.post(f"/api/agents/{x['agent_id']}/events/ack-handled",
                          json={"event_ids": [y_evid]})
    assert r.status_code == 200
    assert db.execute("SELECT 1 FROM agent_event_acks WHERE agent_id=%s", (x["agent_id"],)) == []
    assert db.execute("SELECT 1 FROM agent_event_acks WHERE agent_id=%s", (y["agent_id"],)) == []


# ===================== wake-scan — drain SAME-task in one run + FYI =====================

async def test_drain_all_same_task_plus_fyi_in_one_run(
        client, container, make_agent, make_task, db):
    """C1: an already-awake run whose context is task A marks EVERY pending row whose task is A
    (the task_messages) PLUS the FYI row handled in a single scan — handled_event_ids carries them
    all, and acking them clears the whole backlog in one pass (not one wake per row)."""
    x = await make_agent("x", "eng")
    human = await make_agent("kedar", "lead", kind="human")
    poster = await make_agent("poster", "eng")
    a = await make_task("task A", "done")                          # ready → auto-start → context
    await client.post(f"/api/tasks/{a['id']}/assign",
                      json={"actor_agent_id": human["agent_id"], "agent_id": x["agent_id"]})
    # two task-thread messages on A
    await client.post(f"/api/tasks/{a['id']}/messages",
                      json={"author_agent_id": poster["agent_id"], "body": "m1"})
    await client.post(f"/api/tasks/{a['id']}/messages",
                      json={"author_agent_id": poster["agent_id"], "body": "m2"})
    # an FYI: a task_close decision routed to x
    await client.post("/api/decisions", json={
        "subject_type": "task_close", "subject_id": a["id"], "decision": "approve",
        "actor_agent_id": human["agent_id"], "target_agent_id": x["agent_id"]})

    cand = _cand(await _scan(client, container["id"]), x["agent_id"])
    assert cand["context_task_id"] == a["id"]
    msg_ids = [r["id"] for r in db.execute(
        "SELECT id FROM agent_events WHERE event_key=%s AND event_name='task_message'", (x["agent_id"],))]
    fyi_id = _event_id(db, x["agent_id"], "decision_made", subject_id=a["id"])
    handled = set(cand["handled_event_ids"])
    assert set(msg_ids) <= handled                      # both same-task messages drain in this run
    assert fyi_id in handled                            # the FYI drains too
    # the assignment NEW_WORK is NOT in the drain set (it's consumed at the /next claim)
    assign_id = _event_id(db, x["agent_id"], "task_assigned", task_id=a["id"])
    assert assign_id not in handled


# ===================== wake-scan — cross-task LEFT UNHANDLED, then re-binds =====================

async def test_cross_task_left_unhandled_then_rebinds(
        client, container, make_agent, make_task, db):
    """C2: with context bound to task B (a ready assigned task), task A's task_message is TASK_BOUND
    to A != B → LEFT UNHANDLED (it stays pending). When B is claimed (context falls to A via the
    surfaced task event), a fresh scan now marks A's message handled — the row re-binds to A's run,
    never lost, never mis-acked by B's run."""
    x = await make_agent("x", "eng")
    human = await make_agent("kedar", "lead", kind="human")
    poster = await make_agent("poster", "eng")
    a = await make_task("task A", "done", assignee_alias="x")      # in_progress (NOT a ready target)
    b = await make_task("task B", "done")                          # ready
    await client.post(f"/api/tasks/{b['id']}/assign",
                      json={"actor_agent_id": human["agent_id"], "agent_id": x["agent_id"]})
    await client.post(f"/api/tasks/{a['id']}/messages",
                      json={"author_agent_id": poster["agent_id"], "body": "rebase A onto main"})
    a_msg = _event_id(db, x["agent_id"], "task_message", task_id=a["id"])

    cand = _cand(await _scan(client, container["id"]), x["agent_id"])
    assert cand["context_task_id"] == b["id"]                      # ready B wins the context
    assert a_msg not in set(cand["handled_event_ids"])            # cross-task → LEFT UNHANDLED

    # claim B → B in_progress, no ready targets left; context falls to A (the surfaced task event)
    claim = await client.post(f"/api/agents/{x['agent_id']}/next")
    assert claim.status_code == 200 and claim.json()["task"]["id"] == b["id"]
    cand2 = _cand(await _scan(client, container["id"]), x["agent_id"])
    assert cand2["context_task_id"] == a["id"]
    assert a_msg in set(cand2["handled_event_ids"])              # now drains in A's run (re-bound)


# ===================== NEW_WORK — consumed at the /next claim, not by a drain =====================

async def test_new_work_acked_at_next_claim_not_other_task(
        client, container, make_agent, make_task, db):
    """C-newwork: a `ready` task_assigned is NEW_WORK — never drained; the /next CLAIM consumes it.
    Claiming task B acks B's assignment but LEAVES task C's assignment pending for its own claim."""
    x = await make_agent("x", "eng")
    human = await make_agent("kedar", "lead", kind="human")
    b = await make_task("B", "done", priority=1)                  # lower number = claimed first
    c = await make_task("C", "done", priority=2)
    for t in (b, c):
        await client.post(f"/api/tasks/{t['id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": x["agent_id"]})
    b_assign = _event_id(db, x["agent_id"], "task_assigned", task_id=b["id"])
    c_assign = _event_id(db, x["agent_id"], "task_assigned", task_id=c["id"])

    claim = await client.post(f"/api/agents/{x['agent_id']}/next")
    assert claim.status_code == 200 and claim.json()["task"]["id"] == b["id"]

    acked = {r["event_id"] for r in db.execute(
        "SELECT event_id FROM agent_event_acks WHERE agent_id=%s", (x["agent_id"],))}
    assert b_assign in acked                                      # the claim consumed B's NEW_WORK
    assert c_assign not in acked                                  # C waits for its own claim


async def test_request_created_acked_when_closed_before_accept(
        client, container, make_agent, make_request, db):
    """A TASK request_created is NEW_WORK consumed at the accept/reject seam; if a human FORCE-CLOSES
    it before the target acts (authoritative abandon — the only valid close-before-answer path), the
    close terminally resolves the target's pending request_created so it stops pinning their cursor."""
    human = await make_agent("kedar", "lead", kind="human")
    a = await make_agent("areq", "eng")
    b = await make_agent("bb", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task={"title": "t", "definition_of_done": "d"})
    rid = req["request_id"]
    b_created = _event_id(db, b["agent_id"], "request_created")
    r = await client.post(f"/api/requests/{rid}/close",
                          json={"requester_agent_id": human["agent_id"], "reason": "no longer needed"})
    assert r.status_code == 200, r.text
    acked = {row["event_id"] for row in db.execute(
        "SELECT event_id FROM agent_event_acks WHERE agent_id=%s", (b["agent_id"],))}
    assert b_created in acked


# ===================== R5 cross-run: REJECTED verify is never FYI-acked =====================

async def test_rejected_verify_left_unhandled_until_clean_completion(
        client, container, make_agent, make_task, db):
    """R5 GAP A: a REJECTED verify is a rework START-DIRECTIVE for the restored assignee, NOT an FYI.
    A run bound to a DIFFERENT task must NOT mark it handled (that would clear the rework wake before
    the assignee sees it). It stops re-surfacing only at the assignee's CLEAN completion (/done)."""
    x = await make_agent("x", "eng")
    human = await make_agent("kedar", "lead", kind="human")
    a = await make_task("task A", "done", assignee_alias="x")     # in_progress, x working
    # x finishes → needs_verification; human REJECTS → task A back to in_progress, x restored
    await client.post(f"/api/tasks/{a['id']}/done",
                      json={"agent_id": x["agent_id"], "result": "draft"})
    rej = await client.post(f"/api/tasks/{a['id']}/verify",
                            json={"approve": False, "feedback": "redo the edge case",
                                  "actor_agent_id": human["agent_id"]})
    assert rej.status_code == 200 and rej.json()["status"] == "in_progress"
    verified_ev = _event_id(db, x["agent_id"], "task_verified", task_id=a["id"])

    # a DIFFERENT-task run (context = ready task B) drains its inbox — must LEAVE the rework pending
    b = await make_task("task B", "done")
    await client.post(f"/api/tasks/{b['id']}/assign",
                      json={"actor_agent_id": human["agent_id"], "agent_id": x["agent_id"]})
    cand = _cand(await _scan(client, container["id"]), x["agent_id"])
    assert cand["context_task_id"] == b["id"]
    assert verified_ev not in set(cand["handled_event_ids"])      # DIRECTIVE → never run-acked

    # the rework directive resolves only when x cleanly completes A again
    await client.post(f"/api/tasks/{a['id']}/done",
                      json={"agent_id": x["agent_id"], "result": "edge case fixed"})
    acked = {r["event_id"] for r in db.execute(
        "SELECT event_id FROM agent_event_acks WHERE agent_id=%s", (x["agent_id"],))}
    assert verified_ev in acked                                   # cleared at the /done seam


# ===================== R5 cross-run: plan-approval decision is never FYI-acked =====================

async def test_plan_decision_left_unhandled_cross_task_but_fyi_decisions_drain(
        client, container, make_agent, make_task, db):
    """R5 GAP B: a plan_approval decision_made is the SOLE wake for "proceed/revise" (the thread
    mirror emits no task_message bus event), so it is TASK_BOUND on its subject task — a different
    task's run must NOT FYI-ack it. In the SAME backlog, a task_close decision and a task_unassigned
    ARE FYI and DO drain. Claiming away the other ready work re-binds the plan decision to A's run."""
    x = await make_agent("x", "eng")
    human = await make_agent("kedar", "lead", kind="human")
    a = await make_task("task A (plan)", "done", assignee_alias="x")   # in_progress; plan subject
    b = await make_task("task B", "done")                              # ready → context
    await client.post(f"/api/tasks/{b['id']}/assign",
                      json={"actor_agent_id": human["agent_id"], "agent_id": x["agent_id"]})
    # the plan-approval decision on A (TASK_BOUND on A)
    await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": a["id"], "decision": "approve",
        "reason": "ship it", "actor_agent_id": human["agent_id"], "target_agent_id": x["agent_id"]})
    plan_ev = _event_id(db, x["agent_id"], "decision_made", subject_id=a["id"])
    # an FYI decision (task_close) + an FYI task_unassigned in the same backlog
    u = await make_task("task U", "done", assignee_alias="x")
    await client.post(f"/api/tasks/{u['id']}/unassign", json={"actor_agent_id": human["agent_id"]})
    unassigned_ev = _event_id(db, x["agent_id"], "task_unassigned", task_id=u["id"])
    await client.post("/api/decisions", json={
        "subject_type": "task_close", "subject_id": u["id"], "decision": "approve",
        "actor_agent_id": human["agent_id"], "target_agent_id": x["agent_id"]})
    close_ev = _event_id(db, x["agent_id"], "decision_made", subject_id=u["id"])

    cand = _cand(await _scan(client, container["id"]), x["agent_id"])
    assert cand["context_task_id"] == b["id"]
    handled = set(cand["handled_event_ids"])
    assert plan_ev not in handled                       # plan decision on A is left for A's own run
    assert unassigned_ev in handled                     # task_unassigned is FYI → drains
    assert close_ev in handled                          # task_close decision is FYI → drains

    # claim B → context falls to A (its surfaced task_assigned) → the plan decision now drains
    await client.post(f"/api/agents/{x['agent_id']}/next")
    cand2 = _cand(await _scan(client, container["id"]), x["agent_id"])
    assert cand2["context_task_id"] == a["id"]
    assert plan_ev in set(cand2["handled_event_ids"])
