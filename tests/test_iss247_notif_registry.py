"""#247 KEYSTONE — per-agent typed notification registry (classify-over-the-bus).

Three layers, mirroring the build:
  1. the PURE classifier truth-table — every published event_name maps to the expected
     {type, zone, priority}, plus the request_created human/agent split, the unknown-degrade,
     and the suppressed set;
  2. a DRIFT TOOTH — every event_name actually published in main.py is accounted for by the
     taxonomy (a new event type added without a classification decision fails here), and the
     priority ladder stays ordered to the locked #247 contract;
  3. the READ-API routes — feed shape, newest-first + keyset paging that survives suppressed
     rows, zone filter, actor resolution, and the monotonic read cursor.
"""
import re
import pathlib

import pytest

import main


# ---------------------------------------------------------------------------
# 1. classifier truth-table (pure, no DB)
# ---------------------------------------------------------------------------

P = main  # alias for the priority constants

# event_name -> (type, zone, priority). request_created is split out (dynamic) below.
TRUTH = {
    "prompt":                   ("directed",         "needs_you", P._NOTIF_PRI_INTERRUPT),
    "task_verified":            ("task_verified",    "earlier",   P._NOTIF_PRI_OWN_WORK),
    "task_request_rejected":    ("agent_blocked",    "needs_you", P._NOTIF_PRI_OWN_WORK),
    "task_request_accepted":    ("request_answered", "earlier",   P._NOTIF_PRI_OWN_WORK),
    "agent_suggestion_decided": ("plan_decided",     "earlier",   P._NOTIF_PRI_OWN_WORK),
    "decision_made":            ("plan_decided",     "earlier",   P._NOTIF_PRI_OWN_WORK),
    "request_escalated":        ("escalation",       "needs_you", P._NOTIF_PRI_HUMAN_CONVO),
    "agent_suggested":          ("agent_suggested",  "needs_you", P._NOTIF_PRI_HUMAN_CONVO),
    "task_assigned":            ("task_assigned",    "earlier",   P._NOTIF_PRI_TASK),
    "task_ready":               ("task_ready",       "earlier",   P._NOTIF_PRI_TASK),
    "task_message":             ("task_message",     "earlier",   P._NOTIF_PRI_TASK),
    "task_unassigned":          ("task_unassigned",  "earlier",   P._NOTIF_PRI_TASK),
    "request_answered":         ("request_answered", "earlier",   P._NOTIF_PRI_ANSWER),
    "request_closed":           ("request_closed",   "earlier",   P._NOTIF_PRI_CLOSE),
}


@pytest.mark.parametrize("event_name,expected", TRUTH.items())
def test_classifier_truth_table(event_name, expected):
    exp_type, exp_zone, exp_pri = expected
    n = main._classify_notification(event_name, {})
    assert n is not None
    assert (n["type"], n["zone"], n["priority"]) == (exp_type, exp_zone, exp_pri)


def test_request_created_splits_on_requester_kind():
    """A human requester is a live-human-convo rung; an agent requester is request-in."""
    agent = main._classify_notification("request_created", {"request_id": "r1"},
                                        requester_is_human=False)
    assert agent["zone"] == "needs_you"
    assert agent["type"] == "request_created"
    assert agent["priority"] == P._NOTIF_PRI_REQUEST_IN

    human = main._classify_notification("request_created", {"request_id": "r1"},
                                        requester_is_human=True)
    assert human["zone"] == "needs_you"
    assert human["type"] == "escalation"
    assert human["priority"] == P._NOTIF_PRI_HUMAN_CONVO
    # the human-convo rung must outrank the plain request-in rung
    assert human["priority"] < agent["priority"]


def test_request_created_flags_task_request():
    """#359: the classifier marks a task-REQUEST (request_created with payload type=='task') so the
    wake manifest/prompt can steer the worker into accepting + doing the work instead of deflecting
    it. An info-request and every non-request event are NOT flagged."""
    task = main._classify_notification("request_created",
                                       {"request_id": "r1", "type": "task"})
    assert task["is_task_request"] is True
    # still the ordinary request-in rung — the flag is orthogonal to priority/zone/type
    assert task["type"] == "request_created"
    assert task["priority"] == P._NOTIF_PRI_REQUEST_IN

    info = main._classify_notification("request_created",
                                       {"request_id": "r1", "type": "info"})
    assert info["is_task_request"] is False
    # missing type → not a task-request (graceful)
    assert main._classify_notification("request_created", {"request_id": "r1"})["is_task_request"] is False
    # a human-targeted request_created is never a task-request spawn path
    assert main._classify_notification("request_created", {"request_id": "r1", "type": "task"},
                                       requester_is_human=True)["is_task_request"] is True
    # non-request events never carry the flag, even if their payload happens to have type=='task'
    assert main._classify_notification("task_message", {"task_id": "T", "type": "task"})["is_task_request"] is False


def test_suppressed_events_return_none():
    for ev in main._NOTIF_SUPPRESSED:
        assert main._classify_notification(ev, {}) is None
    # the two we care about explicitly
    assert main._classify_notification("digest_snapshotted", {}) is None
    assert main._classify_notification("conversation_turn", {"turn_id": "t"}) is None


def test_unknown_event_degrades_gracefully():
    n = main._classify_notification("some_brand_new_event", {"foo": "bar"})
    assert n is not None
    assert n["type"] == "some_brand_new_event"
    assert n["zone"] == "earlier"
    assert n["priority"] == P._NOTIF_PRI_UNKNOWN
    assert n["deeplink"] is None


def test_deeplink_extraction_per_kind():
    assert main._classify_notification("task_verified", {"task_id": "T9"})["deeplink"] == {
        "kind": "task", "id": "T9"}
    assert main._classify_notification("request_answered", {"request_id": "R9"})["deeplink"] == {
        "kind": "request", "id": "R9"}
    assert main._classify_notification("decision_made", {"decision_id": "D9"})["deeplink"] == {
        "kind": "decision", "id": "D9"}
    # prompt has no deeplink id field
    assert main._classify_notification("prompt", {"message": "hi"})["deeplink"] is None
    # a deeplink-kind event with the id field MISSING degrades to no deeplink (not a crash)
    assert main._classify_notification("task_verified", {})["deeplink"] is None


def test_actor_and_preview_extraction():
    n = main._classify_notification("task_message",
                                    {"task_id": "T", "from_agent_id": "A1", "preview": "hello"})
    assert n["actor_ref"] == "A1"
    assert n["preview"] == "hello"
    # by_agent_id is the fallback actor field (task_request_accepted)
    n2 = main._classify_notification("task_request_accepted",
                                     {"request_id": "R", "by_agent_id": "A2"})
    assert n2["actor_ref"] == "A2"
    # no actor field present → None (Q2 read-time degrade, no backfill)
    assert main._classify_notification("request_closed", {"request_id": "R"})["actor_ref"] is None


# ---------------------------------------------------------------------------
# 2. drift tooth — taxonomy must cover every published event, ladder stays ordered
# ---------------------------------------------------------------------------

def _published_event_names():
    """Every event_name string literal handed to _publish_event in main.py."""
    src = pathlib.Path(main.__file__).read_text()
    # _publish_event(cur, <cid>, <target>, "EVENT_NAME", ...) — the 4th positional arg
    names = set(re.findall(r'_publish_event\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*"([a-z_]+)"', src))
    assert names, "regex failed to find any published event names — adjust the pattern"
    return names


def test_every_published_event_is_classified():
    """A new event type added to main.py without a classification decision fails HERE.

    Every published event_name must be either: in the taxonomy, in the suppressed set, or the
    dynamically-handled request_created. (An unknown name still degrades gracefully at runtime,
    but the registry OWNER should make a deliberate zone/priority choice — this tooth forces it.)"""
    handled = set(main._NOTIF_TAXONOMY) | set(main._NOTIF_SUPPRESSED) | {"request_created"}
    missing = _published_event_names() - handled
    assert not missing, f"event_name(s) published but unclassified in the #247 taxonomy: {missing}"


def test_priority_ladder_is_strictly_ordered():
    """The contract ladder (Helm sign-off), highest priority first. Reordering breaks this."""
    ladder = [
        P._NOTIF_PRI_INTERRUPT,    # interrupt / stop
        P._NOTIF_PRI_OWN_WORK,     # approval | rejection on own work
        P._NOTIF_PRI_HUMAN_CONVO,  # live human convo
        P._NOTIF_PRI_TASK,         # task-assignment | thread-msg
        P._NOTIF_PRI_REQUEST_IN,   # request-in
        P._NOTIF_PRI_ANSWER,       # answer-to-request
        P._NOTIF_PRI_CLOSE,        # human close / cancel
        P._NOTIF_PRI_UNKNOWN,      # graceful-degrade tail
    ]
    assert ladder == sorted(ladder), "priority constants drifted out of contract-ladder order"
    assert len(set(ladder)) == len(ladder), "ladder rungs must be distinct"
    assert [P._notification_rank(p) for p in ladder[:7]] == [1, 2, 3, 4, 5, 6, 7]
    assert P._notification_rank(P._NOTIF_PRI_UNKNOWN) == 8


# ---------------------------------------------------------------------------
# 3. read-API routes
# ---------------------------------------------------------------------------

async def _emit(db, *, event_key, event_name, ts, payload=None, container_id=None, target_id=None):
    """Insert one agent_events row directly (the bus shape), as _publish_event would."""
    import json as _json
    db.execute(
        """INSERT INTO agent_events (container_id, target_id, event_key, event_name, ts, payload)
           VALUES (%s, %s, %s, %s, %s, %s::jsonb)""",
        (container_id, target_id, event_key, event_name, ts, _json.dumps(payload or {})),
    )


@pytest.mark.asyncio
async def test_feed_classifies_and_orders_newest_first(client, container, make_agent, db):
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_assigned", ts=100.0, payload={"task_id": "T1"})
    await _emit(db, event_key=aid, event_name="request_answered", ts=200.0,
                payload={"request_id": "R1", "preview": "done"})
    r = await client.get(f"/api/agents/{aid}/notifications")
    assert r.status_code == 200, r.text
    body = r.json()
    feed = body["notifications"]
    assert [n["ts"] for n in feed] == [200.0, 100.0]            # newest first
    assert feed[0]["type"] == "request_answered"
    assert feed[0]["zone"] == "earlier"
    assert feed[1]["type"] == "task_assigned"


@pytest.mark.asyncio
async def test_suppressed_rows_never_surface(client, container, make_agent, db):
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="conversation_turn", ts=10.0, payload={"turn_id": "x"})
    await _emit(db, event_key=aid, event_name="digest_snapshotted", ts=20.0, payload={})
    await _emit(db, event_key=aid, event_name="task_message", ts=30.0,
                payload={"task_id": "T", "preview": "hi"})
    feed = (await client.get(f"/api/agents/{aid}/notifications")).json()["notifications"]
    assert [n["event_name"] for n in feed] == ["task_message"]


@pytest.mark.asyncio
async def test_zone_filter(client, container, make_agent, db):
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="prompt", ts=1.0, payload={"message": "do x"})
    await _emit(db, event_key=aid, event_name="request_answered", ts=2.0, payload={"request_id": "R"})
    needs = (await client.get(f"/api/agents/{aid}/notifications?zone=needs_you")).json()["notifications"]
    assert [n["event_name"] for n in needs] == ["prompt"]
    earlier = (await client.get(f"/api/agents/{aid}/notifications?zone=earlier")).json()["notifications"]
    assert [n["event_name"] for n in earlier] == ["request_answered"]


@pytest.mark.asyncio
async def test_read_cursor_marks_read_flag(client, container, make_agent, db):
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=100.0, payload={"task_id": "T"})
    await _emit(db, event_key=aid, event_name="task_message", ts=200.0, payload={"task_id": "T"})
    # before reading, everything is unread
    feed = (await client.get(f"/api/agents/{aid}/notifications")).json()["notifications"]
    assert all(n["read"] is False for n in feed)
    # mark read up to ts=100
    r = await client.post(f"/api/agents/{aid}/notifications/read", json={"through_ts": 100.0})
    assert r.status_code == 200
    assert r.json()["read_through_ts"] == 100.0
    feed = (await client.get(f"/api/agents/{aid}/notifications")).json()["notifications"]
    by_ts = {n["ts"]: n["read"] for n in feed}
    assert by_ts == {200.0: False, 100.0: True}


@pytest.mark.asyncio
async def test_mark_all_read_jumps_to_newest(client, container, make_agent, db):
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=5.0, payload={"task_id": "T"})
    await _emit(db, event_key=aid, event_name="task_message", ts=9.0, payload={"task_id": "T"})
    r = await client.post(f"/api/agents/{aid}/notifications/read", json={})  # omit through_ts
    assert r.json()["read_through_ts"] == 9.0
    feed = (await client.get(f"/api/agents/{aid}/notifications")).json()["notifications"]
    assert all(n["read"] for n in feed)


@pytest.mark.asyncio
async def test_read_cursor_is_monotonic(client, container, make_agent, db):
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=100.0, payload={"task_id": "T"})
    await client.post(f"/api/agents/{aid}/notifications/read", json={"through_ts": 100.0})
    # a stale client tries to move the cursor BACKWARD — must be ignored
    r = await client.post(f"/api/agents/{aid}/notifications/read", json={"through_ts": 50.0})
    assert r.json()["read_through_ts"] == 100.0


@pytest.mark.asyncio
async def test_paging_survives_a_flood_of_suppressed_rows(client, container, make_agent, db):
    """A page-worth of conversation_turn (suppressed) BETWEEN two real rows must not strand the
    older real row behind a null cursor — next_before_ts must keep paging."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=1.0, payload={"task_id": "old"})
    for i in range(50):
        await _emit(db, event_key=aid, event_name="conversation_turn", ts=10.0 + i, payload={})
    await _emit(db, event_key=aid, event_name="task_message", ts=1000.0, payload={"task_id": "new"})
    # limit=1, fetch_cap=4 → first page sees only the newest real row, then a window of suppressed
    page1 = (await client.get(f"/api/agents/{aid}/notifications?limit=1")).json()
    assert [n["preview"] or n["deeplink"]["id"] for n in page1["notifications"]] == ["new"]
    assert page1["next_before_ts"] is not None
    # walk pages until the older real row surfaces (it must, not be lost behind the flood)
    seen = {n["deeplink"]["id"] for n in page1["notifications"]}
    before_ts = page1["next_before_ts"]
    before_id = page1["next_before_id"]
    for _ in range(60):
        if before_ts is None:
            break
        url = f"/api/agents/{aid}/notifications?limit=1&before_ts={before_ts}&before_id={before_id}"
        pg = (await client.get(url)).json()
        seen |= {n["deeplink"]["id"] for n in pg["notifications"]}
        before_ts, before_id = pg["next_before_ts"], pg["next_before_id"]
    assert seen == {"new", "old"}


@pytest.mark.asyncio
async def test_paging_never_drops_co_ts_rows_at_a_boundary(client, container, make_agent, db):
    """Gate 2nd-pass blocker: a page boundary that falls INSIDE a group of rows sharing one ts must
    not strand the co-ts rows below the cut. ORDER BY is (ts DESC, id DESC); a ts-only cursor
    (ts < before_ts) would silently skip the same-ts rows with a smaller id. The compound (ts, id)
    keyset must page through ALL of them with zero drops and zero dupes — limit (2) is deliberately
    smaller than the co-ts group (5) so every boundary lands mid-group."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    # 5 REAL (non-suppressed) rows ALL at the identical ts=100.0 — distinct ids, distinct task_ids.
    for i in range(5):
        await _emit(db, event_key=aid, event_name="task_message", ts=100.0,
                    payload={"task_id": f"co{i}", "preview": f"co{i}"})
    collected = []
    before_ts, before_id, guard = None, None, 0
    while True:
        guard += 1
        assert guard < 20, "pagination did not terminate"
        qs = "limit=2"
        if before_ts is not None:
            qs += f"&before_ts={before_ts}"
        if before_id is not None:
            qs += f"&before_id={before_id}"
        pg = (await client.get(f"/api/agents/{aid}/notifications?{qs}")).json()
        collected += [n["deeplink"]["id"] for n in pg["notifications"]]
        before_ts, before_id = pg["next_before_ts"], pg["next_before_id"]
        if before_ts is None:
            break
    assert sorted(collected) == [f"co{i}" for i in range(5)]   # every co-ts row surfaced
    assert len(collected) == len(set(collected))               # zero duplicates across pages


@pytest.mark.asyncio
async def test_actor_alias_resolved_at_read_time(client, container, make_agent, db):
    recv = await make_agent("Recv")
    sender = await make_agent("Sender")
    aid = recv["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=1.0,
                payload={"task_id": "T", "from_agent_id": sender["agent_id"], "preview": "yo"})
    n = (await client.get(f"/api/agents/{aid}/notifications")).json()["notifications"][0]
    assert n["actor_ref"] == sender["agent_id"]
    assert n["actor_alias"] == "Sender"
    assert n["actor_kind"] == "ai"   # canonical agents.kind value ('ai' | 'human')


@pytest.mark.asyncio
async def test_request_created_human_vs_agent_via_route(client, container, make_agent, db):
    recv = await make_agent("Recv")
    human = await make_agent("Operator", kind="human")
    agent = await make_agent("Worker")
    aid = recv["agent_id"]
    await _emit(db, event_key=aid, event_name="request_created", ts=1.0,
                payload={"request_id": "R1", "from_agent_id": agent["agent_id"], "preview": "a"})
    await _emit(db, event_key=aid, event_name="request_created", ts=2.0,
                payload={"request_id": "R2", "from_agent_id": human["agent_id"], "preview": "h"})
    feed = (await client.get(f"/api/agents/{aid}/notifications")).json()["notifications"]
    by_preview = {n["preview"]: n for n in feed}
    assert by_preview["a"]["priority"] == main._NOTIF_PRI_REQUEST_IN
    assert by_preview["a"]["type"] == "request_created"
    assert by_preview["a"]["actor_kind"] == "ai"   # ORIGIN tiebreak for the wake ranker
    assert by_preview["h"]["priority"] == main._NOTIF_PRI_HUMAN_CONVO
    assert by_preview["h"]["type"] == "escalation"
    assert by_preview["h"]["actor_kind"] == "human"


@pytest.mark.asyncio
async def test_validation_errors(client, container, make_agent, db):
    a = await make_agent("Recv")
    aid = a["agent_id"]
    assert (await client.get("/api/agents/not-a-uuid/notifications")).status_code == 400
    assert (await client.get(f"/api/agents/{aid}/notifications?zone=bogus")).status_code == 400
    assert (await client.post("/api/agents/not-a-uuid/notifications/read", json={})).status_code == 400


@pytest.mark.asyncio
async def test_feed_only_returns_my_own_events(client, container, make_agent, db):
    """The feed is strictly per-recipient: another agent's events never bleed in."""
    me = await make_agent("Me")
    other = await make_agent("Other")
    await _emit(db, event_key=me["agent_id"], event_name="task_message", ts=1.0, payload={"task_id": "mine"})
    await _emit(db, event_key=other["agent_id"], event_name="task_message", ts=2.0, payload={"task_id": "theirs"})
    feed = (await client.get(f"/api/agents/{me['agent_id']}/notifications")).json()["notifications"]
    assert [n["deeplink"]["id"] for n in feed] == ["mine"]
