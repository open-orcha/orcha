"""Conversation-thread STORE (E3 persistence / V1 prereq).

A human opens an ACTIVE conversation with an AI agent (≤1 per agent). Turns are appended
with a server-assigned per-conversation seq. A HUMAN turn is persisted then publishes a
targeted `conversation_turn` event (the bridge to Forge's resident manager). An AGENT turn
(one per stream-json `result`) links to its worker_run via run_id; the live token stream
lives in worker_run_lines (ISS-39), not here.
"""
import uuid

import pytest


async def _start(client, aid, human_id):
    r = await client.post(f"/api/agents/{aid}/conversations", json={"actor_agent_id": human_id})
    assert r.status_code in (200, 201), r.text
    return r.json()


async def _append(client, conv_id, role, author, content, **kw):
    body = {"role": role, "author_agent_id": author, "content": content, **kw}
    return await client.post(f"/api/conversations/{conv_id}/turns", json=body)


# ---------- start / get-or-create ----------

@pytest.mark.asyncio
async def test_start_is_idempotent_one_active(client, container, make_agent):
    human = await make_agent("Kedar", "human", kind="human")
    ai = await make_agent("Vox", "eng")
    a = await _start(client, ai["agent_id"], human["agent_id"])
    assert a["created"] is True
    b = await _start(client, ai["agent_id"], human["agent_id"])
    assert b["created"] is False and b["conversation"]["id"] == a["conversation"]["id"]


@pytest.mark.asyncio
async def test_start_requires_human_actor_and_ai_target(client, container, make_agent):
    bot = await make_agent("Bot", "eng")
    ai = await make_agent("Target", "eng")
    human = await make_agent("H", "human", kind="human")
    # non-human opener -> 403
    r = await client.post(f"/api/agents/{ai['agent_id']}/conversations",
                          json={"actor_agent_id": bot["agent_id"]})
    assert r.status_code == 403, r.text
    # target is a human -> 400
    r2 = await client.post(f"/api/agents/{human['agent_id']}/conversations",
                           json={"actor_agent_id": human["agent_id"]})
    assert r2.status_code == 400, r2.text


# ---------- append turns / seq / event ----------

@pytest.mark.asyncio
async def test_human_turn_persists_and_publishes_event(client, container, make_agent, db):
    human = await make_agent("Kedar2", "human", kind="human")
    ai = await make_agent("Vox2", "eng")
    aid = ai["agent_id"]
    conv = (await _start(client, aid, human["agent_id"]))["conversation"]
    r = await _append(client, conv["id"], "human", human["agent_id"], "hello agent")
    assert r.status_code == 201, r.text
    turn = r.json()["turn"]
    assert turn["seq"] == 1 and turn["role"] == "human" and turn["content"] == "hello agent"
    # the bridge event is published to the agent, AFTER persistence (seq present in payload)
    evs = [e for e in db.event_rows(aid) if e["event_name"] == "conversation_turn"]
    assert evs and evs[-1]["payload"]["seq"] == 1
    assert evs[-1]["payload"]["conversation_id"] == conv["id"]


@pytest.mark.asyncio
async def test_seq_is_monotonic_and_ordered(client, container, make_agent, db):
    human = await make_agent("Kedar3", "human", kind="human")
    ai = await make_agent("Vox3", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    # a worker_run for the agent turn's live stream (per-turn run_id)
    run = db.execute("INSERT INTO worker_runs (agent_id, status) VALUES (%s,'running') RETURNING run_id", (aid,))[0]["run_id"]
    h1 = (await _append(client, cid, "human", human["agent_id"], "q1")).json()["turn"]
    a1 = (await _append(client, cid, "agent", aid, "answer 1", run_id=str(run),
                        meta={"subtype": "success", "num_turns": 1})).json()["turn"]
    assert h1["seq"] == 1 and a1["seq"] == 2
    assert a1["run_id"] == str(run) and a1["meta"]["subtype"] == "success"
    # list ordered oldest->newest; after_seq pages
    lst = (await client.get(f"/api/conversations/{cid}/turns")).json()["turns"]
    assert [t["seq"] for t in lst] == [1, 2]
    page = (await client.get(f"/api/conversations/{cid}/turns?after_seq=1")).json()["turns"]
    assert [t["seq"] for t in page] == [2]


@pytest.mark.asyncio
async def test_turn_role_author_integrity(client, container, make_agent):
    human = await make_agent("Kedar4", "human", kind="human")
    ai = await make_agent("Vox4", "eng")
    other = await make_agent("Other4", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    # agent turn by a non-agent -> 403
    r = await _append(client, cid, "agent", other["agent_id"], "nope")
    assert r.status_code == 403, r.text
    # human turn by a non-human -> 403
    r2 = await _append(client, cid, "human", ai["agent_id"], "nope")
    assert r2.status_code == 403, r2.text


@pytest.mark.asyncio
async def test_agent_turn_requires_valid_owned_run(client, container, make_agent, db):
    """[P2 review] an agent turn must carry a run_id owned by THIS agent — else the wrong
    live stream (worker_run_lines) attaches. Missing -> 400, unknown -> 404, mismatch -> 403."""
    human = await make_agent("KedarR", "human", kind="human")
    ai = await make_agent("VoxR", "eng")
    other = await make_agent("OtherR", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    # missing run_id
    r = await _append(client, cid, "agent", aid, "no run")
    assert r.status_code == 400 and "requires run_id" in r.text
    # unknown run
    r2 = await _append(client, cid, "agent", aid, "ghost run", run_id=str(uuid.uuid4()))
    assert r2.status_code == 404, r2.text
    # run owned by a DIFFERENT agent
    other_run = db.execute("INSERT INTO worker_runs (agent_id, status) VALUES (%s,'running') RETURNING run_id",
                           (other["agent_id"],))[0]["run_id"]
    r3 = await _append(client, cid, "agent", aid, "wrong owner", run_id=str(other_run))
    assert r3.status_code == 403 and "different agent" in r3.text
    # the agent's own run -> ok
    my_run = db.execute("INSERT INTO worker_runs (agent_id, status) VALUES (%s,'running') RETURNING run_id",
                        (aid,))[0]["run_id"]
    r4 = await _append(client, cid, "agent", aid, "answer", run_id=str(my_run))
    assert r4.status_code == 201, r4.text


@pytest.mark.asyncio
async def test_start_returns_existing_via_on_conflict(client, container, make_agent, db):
    """[P2 review] the lost-create race path must return the winner, not 500. Simulate by
    pre-inserting an active conversation, then create — the ON CONFLICT DO NOTHING no-ops
    and we return the existing active row (created=False), no aborted-txn 500."""
    human = await make_agent("KedarC", "human", kind="human")
    ai = await make_agent("VoxC", "eng")
    aid = ai["agent_id"]
    cont = container["id"]
    existing = db.execute(
        "INSERT INTO conversations (container_id, agent_id, started_by) VALUES (%s,%s,%s) RETURNING id",
        (cont, aid, human["agent_id"]))[0]["id"]
    r = await client.post(f"/api/agents/{aid}/conversations", json={"actor_agent_id": human["agent_id"]})
    assert r.status_code in (200, 201), r.text
    assert r.json()["created"] is False
    assert r.json()["conversation"]["id"] == str(existing)


@pytest.mark.asyncio
async def test_append_to_ended_conversation_409(client, container, make_agent):
    human = await make_agent("Kedar5", "human", kind="human")
    ai = await make_agent("Vox5", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    await client.post(f"/api/conversations/{cid}/end", json={"actor_agent_id": human["agent_id"]})
    r = await _append(client, cid, "human", human["agent_id"], "after end")
    assert r.status_code == 409, r.text


@pytest.mark.asyncio
async def test_append_unknown_conversation_404(client, container, make_agent):
    human = await make_agent("Kedar6", "human", kind="human")
    r = await _append(client, str(uuid.uuid4()), "human", human["agent_id"], "x")
    assert r.status_code == 404, r.text


# ---------- session / end / reads ----------

@pytest.mark.asyncio
async def test_set_session_id(client, container, make_agent):
    human = await make_agent("Kedar7", "human", kind="human")
    ai = await make_agent("Vox7", "eng")
    cid = (await _start(client, ai["agent_id"], human["agent_id"]))["conversation"]["id"]
    sid = str(uuid.uuid4())
    r = await client.post(f"/api/conversations/{cid}/session", json={"session_id": sid})
    assert r.status_code == 200 and r.json()["session_id"] == sid
    assert (await client.get(f"/api/conversations/{cid}")).json()["conversation"]["session_id"] == sid


@pytest.mark.asyncio
async def test_end_is_idempotent_and_frees_slot(client, container, make_agent):
    human = await make_agent("Kedar8", "human", kind="human")
    ai = await make_agent("Vox8", "eng")
    aid = ai["agent_id"]
    c1 = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    r1 = await client.post(f"/api/conversations/{c1}/end", json={"actor_agent_id": human["agent_id"]})
    assert r1.status_code == 200 and r1.json()["status"] == "ended"
    r2 = await client.post(f"/api/conversations/{c1}/end", json={"actor_agent_id": human["agent_id"]})
    assert r2.json().get("already_ended") is True
    # slot freed: a NEW active conversation can be opened (partial-unique only blocks active)
    c2 = await _start(client, aid, human["agent_id"])
    assert c2["created"] is True and c2["conversation"]["id"] != c1


@pytest.mark.asyncio
async def test_get_agent_conversation_recent_turns(client, container, make_agent):
    human = await make_agent("Kedar9", "human", kind="human")
    ai = await make_agent("Vox9", "eng")
    aid = ai["agent_id"]
    assert (await client.get(f"/api/agents/{aid}/conversation")).json()["conversation"] is None
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    await _append(client, cid, "human", human["agent_id"], "hi")
    payload = (await client.get(f"/api/agents/{aid}/conversation")).json()
    assert payload["conversation"]["id"] == cid
    assert [t["content"] for t in payload["turns"]] == ["hi"]


# ---------- E3: resident-manager discovery scan ----------

async def _active(client, cid, conv_id):
    r = await client.get(f"/api/containers/{cid}/active-conversations")
    assert r.status_code == 200, r.text
    body = r.json()
    return body, next((c for c in body["conversations"] if c["conversation_id"] == conv_id), None)


@pytest.mark.asyncio
async def test_active_conversations_flags_pending_human_turn(client, container, make_agent, db):
    """E3: a conversation whose LAST turn is human is `pending_human` (work for the resident);
    once the agent answers it flips false. Reports last_turn_seq for the daemon's idempotent
    in-memory cursor, and session_id (NULL until the resident pins one)."""
    human = await make_agent("KedarAC", "human", kind="human")
    ai = await make_agent("VoxAC", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    # brand-new conversation, no turns yet → not pending, seq 0, no session pinned
    _, cand = await _active(client, container["id"], cid)
    assert cand is not None and cand["pending_human"] is False
    assert cand["last_turn_seq"] == 0 and cand["last_turn_role"] is None
    assert cand["session_id"] is None and cand["agent_id"] == aid
    # human asks → pending_human, seq advances
    await _append(client, cid, "human", human["agent_id"], "ping")
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_human"] is True and cand["last_turn_seq"] == 1
    assert cand["last_turn_role"] == "human"
    # the resident answers (per-turn run) → no longer pending
    run = db.execute("INSERT INTO worker_runs (agent_id, status) VALUES (%s,'running') RETURNING run_id",
                     (aid,))[0]["run_id"]
    await _append(client, cid, "agent", aid, "pong", run_id=str(run))
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_human"] is False and cand["last_turn_seq"] == 2
    assert cand["last_turn_role"] == "agent"


@pytest.mark.asyncio
async def test_active_conversations_reports_conversation_ack_ts(client, container, make_agent):
    """The conversation manager consumes `conversation_turn` outside the normal wake-scan path, so
    it needs the event high-water mark to ack after posting the agent's reply."""
    human = await make_agent("KedarACTS", "human", kind="human")
    ai = await make_agent("VoxACTS", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]

    await _append(client, cid, "human", human["agent_id"], "ping")
    _, cand = await _active(client, container["id"], cid)
    assert cand["conversation_ack_ts"] is not None

    r = await client.post(f"/api/agents/{aid}/wake-ack",
                          json={"kind": "resident_conversation_turn",
                                "event": "conversation_turn",
                                "delivered_ts": cand["conversation_ack_ts"]})
    assert r.status_code == 200, r.text
    _, cand2 = await _active(client, container["id"], cid)
    assert cand2["conversation_ack_ts"] is None


@pytest.mark.asyncio
async def test_active_conversations_excludes_ended(client, container, make_agent):
    """E3: an ended conversation drops out of the discovery scan (the agent's slot is freed)."""
    human = await make_agent("KedarAE", "human", kind="human")
    ai = await make_agent("VoxAE", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    await _append(client, cid, "human", human["agent_id"], "still here?")
    _, cand = await _active(client, container["id"], cid)
    assert cand is not None and cand["pending_human"] is True
    await client.post(f"/api/conversations/{cid}/end", json={"actor_agent_id": human["agent_id"]})
    _, cand = await _active(client, container["id"], cid)
    assert cand is None              # ended → not surfaced


def _seed_event(db, cid, aid, name, ts, payload="{}"):
    import json as _json
    body = payload if isinstance(payload, str) else _json.dumps(payload)
    db.execute(
        "INSERT INTO agent_events (container_id, target_id, event_key, event_name, ts, payload) "
        "VALUES (%s,%s,%s,%s,%s,%s::jsonb)", (cid, aid, aid, name, ts, body))


@pytest.mark.asyncio
async def test_active_conversations_reports_pending_inbox(client, container, make_agent, db):
    """ISS-74: the scan reports `pending_inbox` — NON-conversation events queued for the resident's
    agent past its wake cursor — so the daemon can drain them INTO the warm session (a resident holds
    the single-embodiment lease, so ordinary ephemeral wakes are suppressed). conversation_turn and
    digest_snapshotted are EXCLUDED (the resident handles convo turns itself; digest is self-echo)."""
    human = await make_agent("KedarPI", "human", kind="human")
    ai = await make_agent("VoxPI", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    # 3 real inbox events (counted) + 2 excluded ones
    _seed_event(db, container["id"], aid, "task_message", 10.0)
    _seed_event(db, container["id"], aid, "decision_made", 20.0)
    _seed_event(db, container["id"], aid, "request_created", 30.0)
    _seed_event(db, container["id"], aid, "conversation_turn", 40.0)   # excluded (resident handles it)
    _seed_event(db, container["id"], aid, "digest_snapshotted", 50.0)  # excluded (self-echo)
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_inbox"] == 3                                  # only the non-convo, non-digest events
    assert cand["inbox_ack_ts"] == 30.0                               # max ts among the COUNTED events


@pytest.mark.asyncio
async def test_active_conversations_excludes_selfecho_request_closed(client, container, make_agent, db):
    """ISS-75 (#188) + ISS-77 (#200): `request_closed` is the SOLE drain exclusion — it SELF-ECHOES
    (closing a request emits another request_closed), so counting it re-drains the warm resident every
    tick (the #185 runaway). It carries no drain surface, so excluding it loses nothing. ISS-77 CORRECTION:
    `request_answered` is NO LONGER excluded — it does not self-echo and is a genuine 'my request was
    answered → wake + act' signal, so it now COUNTS like task_message."""
    human = await make_agent("KedarRA", "human", kind="human")
    ai = await make_agent("VoxRA", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    _seed_event(db, container["id"], aid, "task_message", 10.0)        # actionable → counts
    _seed_event(db, container["id"], aid, "request_answered", 20.0)    # ISS-77: now COUNTS (was excluded)
    _seed_event(db, container["id"], aid, "request_closed", 30.0)      # ISS-75: still excluded (self-echo)
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_inbox"] == 2                                  # task_message + request_answered
    assert cand["inbox_ack_ts"] == 20.0                               # ack mark excludes ONLY the self-echo


@pytest.mark.asyncio
async def test_active_conversations_drains_on_request_answered(client, container, make_agent, db):
    """ISS-77 (#200): a resident whose ONLY queued event is `request_answered` MUST drain (the bug:
    it was excluded as an audit echo, so a resident whose request got answered never woke to act on
    the answer). Teeth: under the old ISS-75 exclusion this was pending_inbox=0; it is now 1."""
    human = await make_agent("KedarRX", "human", kind="human")
    ai = await make_agent("VoxRX", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    _seed_event(db, container["id"], aid, "request_answered", 20.0)
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_inbox"] == 1 and cand["inbox_ack_ts"] == 20.0


@pytest.mark.asyncio
async def test_active_conversations_request_closed_only_inbox_is_zero(client, container, make_agent, db):
    """ISS-75 + ISS-77: the #185-runaway guard, now narrowed to its true cause. A resident whose ONLY
    queued event is the SELF-ECHOING `request_closed` drains ZERO times (no runaway regression)."""
    human = await make_agent("KedarAO", "human", kind="human")
    ai = await make_agent("VoxAO", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    _seed_event(db, container["id"], aid, "request_closed", 30.0)
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_inbox"] == 0 and cand["inbox_ack_ts"] is None
    assert cand["inbox_messages"] == []


@pytest.mark.asyncio
async def test_active_conversations_surfaces_directed_messages(client, container, make_agent, db):
    """ISS-74 (review fix): `prompt` and `task_message` carry content with NO inbox surface — they
    are delivered ONLY by injecting the text. The scan surfaces them in `inbox_messages` (so the
    drain can quote them) using the SAME framing/batch semantics as wake_scan, and acks no further
    than the surfaced batch — never marking a directed message delivered without its content."""
    human = await make_agent("KedarDM", "human", kind="human")
    ai = await make_agent("VoxDM", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    _seed_event(db, container["id"], aid, "prompt", 10.0, {"message": "please rebase onto main"})
    _seed_event(db, container["id"], aid, "task_message", 20.0, {"task_id": "T-9", "preview": "ping on T-9"})
    _seed_event(db, container["id"], aid, "decision_made", 30.0)   # no surface — read from inbox/thread
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_inbox"] == 3
    assert cand["inbox_messages"] == [
        "please rebase onto main",
        "[task-thread message on task T-9] ping on T-9 — READ that task's thread and RESPOND on it"]
    assert cand["inbox_ack_ts"] == 30.0           # nothing truncated → ack through the max counted ts


@pytest.mark.asyncio
async def test_pending_inbox_respects_delivered_cursor(client, container, make_agent, db):
    """ISS-74: pending_inbox only counts events PAST the agent's wake cursor (agent_wake_state.
    delivered_ts) — once the daemon acks a drain (advancing delivered_ts), they stop counting."""
    human = await make_agent("KedarPC", "human", kind="human")
    ai = await make_agent("VoxPC", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    _seed_event(db, container["id"], aid, "task_message", 10.0)
    _seed_event(db, container["id"], aid, "request_created", 20.0)
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_inbox"] == 2 and cand["inbox_ack_ts"] == 20.0
    # ISS-78 (A2): the resident idle-YIELDS and an ephemeral worker drains the backlog, acking the
    # wake cursor through ts=20 (same server cursor math — pending_inbox counts only events past it).
    await client.post(f"/api/agents/{aid}/wake-ack",
                      json={"kind": "ephemeral", "delivered_ts": 20.0, "release_lease": True})
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_inbox"] == 0                                  # all caught up
    # a NEW event past the cursor counts again
    _seed_event(db, container["id"], aid, "decision_made", 25.0)
    _, cand = await _active(client, container["id"], cid)
    assert cand["pending_inbox"] == 1 and cand["inbox_ack_ts"] == 25.0


@pytest.mark.asyncio
async def test_active_conversations_surfaces_pinned_session(client, container, make_agent):
    """E3: once the resident pins its claude --session-id, the scan surfaces it so a respawn
    can --resume the same session."""
    import uuid as _uuid
    human = await make_agent("KedarAS", "human", kind="human")
    ai = await make_agent("VoxAS", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    sid = str(_uuid.uuid4())
    await client.post(f"/api/conversations/{cid}/session", json={"session_id": sid})
    _, cand = await _active(client, container["id"], cid)
    assert cand["session_id"] == sid


# ---------- ISS-70: cross-embodiment digest re-sync (cold_required) ----------

def _seed_digest(db, cid, aid, snapshot_ts):
    db.execute("INSERT INTO agent_memory_digests (container_id, agent_id, snapshot_ts) "
               "VALUES (%s,%s,%s)", (cid, aid, snapshot_ts))


_FUTURE_TS = 9_999_999_999.0   # year 2286 — safely AFTER any real now() pin


@pytest.mark.asyncio
async def test_cold_required_true_when_digest_newer_than_pin(client, container, make_agent, db):
    """ISS-70: a digest written by ANOTHER embodiment AFTER the resident pinned its session must
    force a one-shot cold boot (the warm --resume never re-reads the digest). The session endpoint
    stamps session_pinned_at=now(); a digest with a later snapshot_ts → cold_required true."""
    import uuid as _uuid
    human = await make_agent("KedarCT", "human", kind="human")
    ai = await make_agent("VoxCT", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    await client.post(f"/api/conversations/{cid}/session", json={"session_id": str(_uuid.uuid4())})
    _seed_digest(db, container["id"], aid, _FUTURE_TS)             # digest snapshot_ts > pin
    _, cand = await _active(client, container["id"], cid)
    assert cand["cold_required"] is True


@pytest.mark.asyncio
async def test_cold_required_false_when_pin_newer_than_digest(client, container, make_agent, db):
    """ISS-70: a digest OLDER than the pin (already absorbed at the cold boot that set the pin)
    must NOT force a cold boot — the resident warm-resumes normally. Self-limiting property."""
    import uuid as _uuid
    human = await make_agent("KedarCF", "human", kind="human")
    ai = await make_agent("VoxCF", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    _seed_digest(db, container["id"], aid, 100.0)                  # ancient digest (< now() pin)
    await client.post(f"/api/conversations/{cid}/session", json={"session_id": str(_uuid.uuid4())})
    _, cand = await _active(client, container["id"], cid)
    assert cand["cold_required"] is False


@pytest.mark.asyncio
async def test_cold_required_true_when_session_pinned_but_timestamp_null(client, container, make_agent, db):
    """ISS-70 backfill: a conversation pinned BEFORE this migration has session_id set but
    session_pinned_at NULL. Treat as 'needs one cold boot' so the digest is re-injected once,
    rather than trusting an un-timestamped warm session indefinitely."""
    import uuid as _uuid
    human = await make_agent("KedarCN", "human", kind="human")
    ai = await make_agent("VoxCN", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    # simulate a pre-ISS-70 pin: session set, no pin timestamp
    db.execute("UPDATE conversations SET session_id=%s, session_pinned_at=NULL WHERE id=%s",
               (str(_uuid.uuid4()), cid))
    _, cand = await _active(client, container["id"], cid)
    assert cand["cold_required"] is True


@pytest.mark.asyncio
async def test_cold_required_false_when_no_session_pinned(client, container, make_agent, db):
    """ISS-70: with no pinned session the boot is cold ANYWAY (notifier's `not session_id`), so the
    signal stays clean/false even when a digest exists — it only governs the warm-resume override."""
    import uuid as _uuid
    human = await make_agent("KedarCZ", "human", kind="human")
    ai = await make_agent("VoxCZ", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    _seed_digest(db, container["id"], aid, _FUTURE_TS)            # digest exists but no session pinned
    _, cand = await _active(client, container["id"], cid)
    assert cand["session_id"] is None and cand["cold_required"] is False


@pytest.mark.asyncio
async def test_session_endpoint_stamps_pinned_at_and_reclears_cold(client, container, make_agent, db):
    """ISS-70 self-limiting loop: the session POST stamps session_pinned_at. After a forced cold
    boot re-pins (now() > the digest snapshot_ts), cold_required flips back to false — exactly one
    cold boot per new digest, then warm-resume resumes."""
    import uuid as _uuid
    human = await make_agent("KedarCL", "human", kind="human")
    ai = await make_agent("VoxCL", "eng")
    aid = ai["agent_id"]
    cid = (await _start(client, aid, human["agent_id"]))["conversation"]["id"]
    await client.post(f"/api/conversations/{cid}/session", json={"session_id": str(_uuid.uuid4())})
    assert db.execute("SELECT session_pinned_at FROM conversations WHERE id=%s",
                      (cid,))[0]["session_pinned_at"] is not None
    # a digest lands after that pin → cold_required true
    _seed_digest(db, container["id"], aid, _FUTURE_TS)
    _, cand = await _active(client, container["id"], cid)
    assert cand["cold_required"] is True
    # the forced cold boot re-pins a fresh session (re-stamping session_pinned_at=now())...
    # simulate the digest snapshot_ts now being in the PAST relative to the new pin
    db.execute("DELETE FROM agent_memory_digests WHERE agent_id=%s", (aid,))
    _seed_digest(db, container["id"], aid, 100.0)
    await client.post(f"/api/conversations/{cid}/session", json={"session_id": str(_uuid.uuid4())})
    _, cand = await _active(client, container["id"], cid)
    assert cand["cold_required"] is False                         # cleared → warm-resume resumes
