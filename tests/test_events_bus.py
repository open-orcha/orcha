"""#22 — tests/test_events_bus.py — durable event bus (Orcha#25).

Exercises the DB-backed `agent_events` bus that replaced the in-process ring
buffer: per-key delivery, the `since_ts` replay cursor (an event is delivered
once, then `/wait` times out), the two-key agent+container fan-out, durability
across connections, SSE, and that every state-changing endpoint publishes the
right event.

ISOLATION: every test here drives a REAL publish through the API and reads it
back via `next_event()` / `GET /wait` or `db.event_rows()`. `_wait_for_event`
polls `agent_events` from a SEPARATE worker-thread connection that cannot see an
uncommitted test transaction, so the whole module runs under
`@pytest.mark.committed` (real commit + TRUNCATE teardown) per the #22 fixture
contract.

Fixtures/helpers come from tests/conftest.py:
  fixtures:  client, db, container
  factories: make_agent, make_task, make_request   (async; raise on non-2xx)
  helpers:   next_event(client, aid, *, since_ts, timeout), read_sse(client, path, *, timeout)
"""
import asyncio
import json

from conftest import next_event

# Isolation note: the #22 conftest runs every test in committed mode (it uses a
# dedicated test DB and TRUNCATEs between tests, not transactional rollback), which
# is exactly what the durable bus needs — _wait_for_event reads agent_events from a
# separate worker-thread connection that can't see an uncommitted tx. So there is
# no per-test marker to apply here; committed isolation is the default.


async def _read_sse(path, *, timeout=2.0):
    """Read an SSE stream with a hard timeout (the endpoint streams forever).

    httpx.ASGITransport buffers the whole response, so it hangs on an infinite SSE
    stream; instead we drive the ASGI app directly, capturing `http.response.start`
    (status + headers) and body chunks until `timeout`, then parse the `data:`
    frames. Self-contained because the conftest does not ship the `read_sse` helper
    the #22 v2 contract described. Returns {status, headers, events}.
    """
    import main  # importable: conftest put the portal dir on sys.path at collection

    state = {"status": None, "headers": {}}
    body = bytearray()
    scope = {
        "type": "http", "http_version": "1.1", "method": "GET", "path": path,
        "raw_path": path.encode(), "query_string": b"", "headers": [],
        "scheme": "http", "server": ("test", 80), "client": ("test", 1),
    }

    async def receive():           # no request body; then idle (stay "connected")
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            state["status"] = message["status"]
            state["headers"] = {k.decode().lower(): v.decode() for k, v in message.get("headers", [])}
        elif message["type"] == "http.response.body":
            body.extend(message.get("body", b""))

    try:
        await asyncio.wait_for(main.app(scope, receive, send), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass

    events = []
    for line in body.decode(errors="ignore").splitlines():
        if line.startswith("data:"):
            try:
                events.append(json.loads(line[len("data:"):].strip()))
            except json.JSONDecodeError:
                pass
    return {"status": state["status"], "headers": state["headers"], "events": events}


async def _drain_last(client, agent_id, *, since_ts=0.0, max_events=8):
    """Walk an agent's stream forward, returning the LAST non-timeout event seen
    (or None). Mirrors how a real consumer advances its since_ts cursor."""
    last = None
    cursor = since_ts
    for _ in range(max_events):
        evt = await next_event(client, agent_id, since_ts=cursor)
        if evt["event"] == "timeout":
            break
        last = evt
        cursor = evt["ts"]
    return last


# --------------------------------------------------------------------------- #
# A. since_ts cursor / replay-safety (the core Orcha#25 fix)
# --------------------------------------------------------------------------- #

async def test_event_delivered_once_then_timeout(client, make_agent, make_request):
    """A published event is delivered exactly once: next_event(since_ts=0) returns
    it; re-polling with since_ts=event.ts yields a timeout — no infinite replay."""
    target = await make_agent("Target", "bus-tester")
    asker = await make_agent("Asker", "bus-tester")
    await make_request(asker["agent_id"], "ping?", target_alias="Target")

    evt = await next_event(client, target["agent_id"], since_ts=0.0)
    assert evt["event"] == "request_created"
    assert isinstance(evt["ts"], (int, float))

    again = await next_event(client, target["agent_id"], since_ts=evt["ts"])
    assert again["event"] == "timeout"


async def test_three_events_replay_in_order_on_reconnect(client, make_agent, make_request):
    """Three events published with NO listener are all delivered, in (ts,id) order,
    by walking since_ts forward on reconnect — then a timeout."""
    target = await make_agent("T3", "bus-tester")
    asker = await make_agent("R3", "bus-tester")
    for i in range(3):
        await make_request(asker["agent_id"], f"q{i}", target_alias="T3")

    seen_ts = []
    cursor = 0.0
    for _ in range(3):
        evt = await next_event(client, target["agent_id"], since_ts=cursor)
        assert evt["event"] == "request_created"
        seen_ts.append(evt["ts"])
        cursor = evt["ts"]

    assert seen_ts == sorted(seen_ts)      # strictly in ts order
    assert len(set(seen_ts)) == 3          # three distinct events, none replayed
    assert (await next_event(client, target["agent_id"], since_ts=cursor))["event"] == "timeout"


async def test_since_ts_is_a_strict_boundary(client, make_agent, make_request):
    """ts == since_ts is NOT returned (strict `>` in _wait_for_event); only ts > since_ts."""
    target = await make_agent("Tb", "bus-tester")
    asker = await make_agent("Rb", "bus-tester")
    await make_request(asker["agent_id"], "q", target_alias="Tb")

    evt = await next_event(client, target["agent_id"], since_ts=0.0)
    # exact boundary: passing the event's own ts excludes it -> timeout
    boundary = await next_event(client, target["agent_id"], since_ts=evt["ts"])
    assert boundary["event"] == "timeout"


async def test_wait_timeout_shape_when_no_events(client, make_agent):
    """No events for the key -> {'event': 'timeout', 'ts': <float>}."""
    idle = await make_agent("Idle", "bus-tester")
    evt = await next_event(client, idle["agent_id"], since_ts=0.0)
    assert evt["event"] == "timeout"
    assert isinstance(evt["ts"], (int, float))


# --------------------------------------------------------------------------- #
# B. two-key fan-out (row-level via db.event_rows)
# --------------------------------------------------------------------------- #

async def test_agent_plus_container_two_key_fanout(db, make_agent, make_request, container):
    """A target+container publish (request_created) writes TWO agent_events rows:
    event_key=<agent_id> AND event_key='c:<cid>', with identical event_name/ts/payload.
    (Not observable via /wait, which streams one key — assert at the row level.)"""
    target = await make_agent("Tf", "bus-tester")
    asker = await make_agent("Rf", "bus-tester")
    await make_request(asker["agent_id"], "fan", target_alias="Tf")

    cid = container["id"]
    agent_rows = [r for r in db.event_rows(target["agent_id"]) if r["event_name"] == "request_created"]
    cont_rows = [r for r in db.event_rows(f"c:{cid}") if r["event_name"] == "request_created"]

    assert len(agent_rows) == 1
    assert len(cont_rows) == 1
    a, c = agent_rows[0], cont_rows[0]
    assert a["ts"] == c["ts"]                         # same publish -> same ts
    assert a["payload"] == c["payload"]               # same body
    assert str(a["target_id"]) == target["agent_id"]  # agent-key row is targeted
    assert c["target_id"] is None                     # container-key row is untargeted


async def test_container_only_event_has_no_agent_key_row(client, db, make_agent, make_request, container):
    """An escalation publishes request_escalated container-wide (target=None): a
    c:<cid> row exists and there is NO request_escalated row under the requester's key."""
    requester = await make_agent("Esc", "bus-tester")
    target = await make_agent("EscT", "bus-tester")
    await make_agent("EscH", "reviewer", kind="human")  # escalate -> _pick_human needs one
    req = await make_request(requester["agent_id"], "will escalate", target_alias="EscT")

    resp = await client.post(
        f"/api/requests/{req['id']}/escalate",
        json={"requester_agent_id": requester["agent_id"]},
    )
    assert resp.status_code == 200

    cid = container["id"]
    cont = [r for r in db.event_rows(f"c:{cid}") if r["event_name"] == "request_escalated"]
    assert len(cont) == 1
    assert cont[0]["target_id"] is None
    assert not [r for r in db.event_rows(requester["agent_id"]) if r["event_name"] == "request_escalated"]


# --------------------------------------------------------------------------- #
# C. every state-changing endpoint publishes the correct event
# --------------------------------------------------------------------------- #

async def test_assignment_publishes_task_assigned(client, make_agent, make_task):
    owner = await make_agent("TA", "bus-tester")
    t = await make_task("do x", "x is done", assignee_alias="TA")
    evt = await next_event(client, owner["agent_id"], since_ts=0.0)
    assert evt["event"] == "task_assigned"
    assert evt.get("task_id") == t["id"]


async def test_respond_publishes_request_answered_to_requester(client, make_agent, make_request):
    requester = await make_agent("QA_R", "bus-tester")
    target = await make_agent("QA_T", "bus-tester")
    req = await make_request(requester["agent_id"], "q?", target_alias="QA_T")

    resp = await client.post(
        f"/api/requests/{req['id']}/respond",
        json={"responder_agent_id": target["agent_id"], "response": "a!"},
    )
    assert resp.status_code == 200

    # request_created went to the TARGET; the REQUESTER's first event is request_answered.
    evt = await next_event(client, requester["agent_id"], since_ts=0.0)
    assert evt["event"] == "request_answered"
    assert evt.get("request_id") == req["id"]


async def test_close_publishes_request_closed_to_target(client, make_agent, make_request):
    requester = await make_agent("CL_R", "bus-tester")
    target = await make_agent("CL_T", "bus-tester")
    req = await make_request(requester["agent_id"], "q?", target_alias="CL_T")
    await client.post(
        f"/api/requests/{req['id']}/respond",
        json={"responder_agent_id": target["agent_id"], "response": "a"},
    )
    resp = await client.post(
        f"/api/requests/{req['id']}/close",
        json={"requester_agent_id": requester["agent_id"]},
    )
    assert resp.status_code == 200

    # target stream: request_created then request_closed -> last is request_closed.
    last = await _drain_last(client, target["agent_id"])
    assert last is not None and last["event"] == "request_closed"


async def test_verify_approve_publishes_task_verified(client, make_agent, make_task):
    worker = await make_agent("VW", "bus-tester")
    human = await make_agent("VH", "reviewer", kind="human")
    t = await make_task("ship", "shipped", assignee_alias="VW")

    d = await client.post(
        f"/api/tasks/{t['id']}/done",
        json={"agent_id": worker["agent_id"], "result": "shipped"},
    )
    assert d.status_code == 200
    v = await client.post(
        f"/api/tasks/{t['id']}/verify",
        json={"approve": True, "actor_agent_id": human["agent_id"]},
    )
    assert v.status_code == 200

    # worker stream: task_assigned then task_verified(approved=True) -> last.
    last = await _drain_last(client, worker["agent_id"])
    assert last is not None and last["event"] == "task_verified"
    assert last.get("approved") is True


async def test_dependency_readied_publishes_task_ready(client, db, make_agent, make_task, container):
    """Verifying task A satisfies B's dependency -> B readied -> task_ready published
    container-wide (target=None) carrying B's id."""
    worker = await make_agent("DepW", "bus-tester")
    human = await make_agent("DepH", "reviewer", kind="human")
    a = await make_task("A", "A done", assignee_alias="DepW")
    b = await make_task("B", "B done", depends_on=[a["id"]])  # pending on A

    await client.post(
        f"/api/tasks/{a['id']}/done",
        json={"agent_id": worker["agent_id"], "result": "x"},
    )
    await client.post(
        f"/api/tasks/{a['id']}/verify",
        json={"approve": True, "actor_agent_id": human["agent_id"]},
    )

    cid = container["id"]
    ready = [r for r in db.event_rows(f"c:{cid}") if r["event_name"] == "task_ready"]
    assert any((r["payload"] or {}).get("task_id") == b["id"] for r in ready)


# --------------------------------------------------------------------------- #
# D. durability (DB-backed, not in-process buffer)
# --------------------------------------------------------------------------- #

async def test_events_persist_and_cross_connection(client, db, make_agent, make_request):
    """A published event is committed to agent_events (durable) AND visible from a
    SEPARATE connection — the /wait reader runs in its own worker-thread db_cursor(),
    so seeing the event there proves it is not in-process buffer state. This is the
    unit-level stand-in for "survives a portal restart": the data lives in Postgres,
    not memory."""
    target = await make_agent("Dur", "bus-tester")
    asker = await make_agent("DurR", "bus-tester")
    await make_request(asker["agent_id"], "persist", target_alias="Dur")

    # row is in the table
    assert any(r["event_name"] == "request_created" for r in db.event_rows(target["agent_id"]))
    # and served by /wait, which uses a different connection than the writer
    evt = await next_event(client, target["agent_id"], since_ts=0.0)
    assert evt["event"] == "request_created"


# --------------------------------------------------------------------------- #
# E. R2.2 — a task-thread message wakes the task's OTHER assignees
# --------------------------------------------------------------------------- #

async def test_task_message_wakes_other_assignees(client, db, make_agent, make_task):
    """Posting a task message publishes a targeted `task_message` event to every
    assignee EXCEPT the author, so a teammate's note wakes them out-of-band. Before
    R2.2 this emitted nothing and collaboration notes silently stranded."""
    a = await make_agent("MsgA", "eng")
    b = await make_agent("MsgB", "eng")
    task = await make_task("shared", "dod", assignee_alias="MsgA")
    tid = task["id"]
    # add B as a second assignee of the same task
    db.execute("INSERT INTO agent_tasks (agent_id, task_id, assignment_status) "
               "VALUES (%s, %s, 'working')", (b["agent_id"], tid))

    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": a["agent_id"], "body": "heads up team"})
    assert r.status_code == 201, r.text

    # B (the other assignee) is woken: exactly one task_message event keyed to B
    b_msgs = [x for x in db.event_rows(b["agent_id"]) if x["event_name"] == "task_message"]
    assert len(b_msgs) == 1, "the other assignee should get exactly one wake event"
    assert (b_msgs[0]["payload"] or {}).get("task_id") == tid
    assert (b_msgs[0]["payload"] or {}).get("from_agent_id") == a["agent_id"]
    # and it is delivered by /wait
    evt = await next_event(client, b["agent_id"], since_ts=0.0)
    assert evt["event"] == "task_message"

    # A (the author) is NOT woken for their own message
    a_msgs = [x for x in db.event_rows(a["agent_id"]) if x["event_name"] == "task_message"]
    assert a_msgs == [], "the author must not wake themselves"


# --------------------------------------------------------------------------- #
# E. SSE
# --------------------------------------------------------------------------- #

async def test_sse_serves_text_event_stream(client, make_agent, make_request, container):
    """GET /api/containers/{cid}/events serves Content-Type text/event-stream and
    delivers a previously published container-wide event as a parsed frame."""
    cid = container["id"]
    requester = await make_agent("SseR", "bus-tester")
    target = await make_agent("SseT", "bus-tester")
    await make_request(requester["agent_id"], "sse", target_alias="SseT")

    out = await _read_sse(f"/api/containers/{cid}/events", timeout=2.0)
    assert out["status"] == 200
    assert out["headers"].get("content-type", "").startswith("text/event-stream")
    # request_created fans out to c:<cid>, so the container stream should carry it.
    assert "request_created" in [e.get("event") for e in out["events"]]
