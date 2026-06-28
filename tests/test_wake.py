"""Epic A — wake & self-movement tests.

Covers the reachability registry, the server-side wake-scan decision (the
auto-start / wake truth table), the wake-ack cursor + cooldown, the targeted
task_ready emission on dep-unblock, and the notifier's pure transport selection.

Uses the same committed-isolation harness as the bus tests (conftest.py): the
wake-scan reads agent_events from the same connection, so committed rows are
visible. Transport side-effects (tmux/claude) are never executed here — we test
the pure decision/selection functions and shim liveness.
"""
import json
import pathlib
import sys

import pytest

# notifier lives in the CLI package, not on the portal path conftest sets up.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import notifier  # noqa: E402


# ---------- reachability registry ----------

@pytest.mark.asyncio
async def test_reachability_defaults_to_wake_on(client, make_agent):
    a = await make_agent("A")
    aid = a["agent_id"]
    r = await client.get(f"/api/agents/{aid}/reachability")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["recorded"] is False        # no row yet
    assert d["wake_enabled"] is True     # but wake is ON by default
    assert d["tmux_target"] is None      # and unreachable until a pane is recorded


@pytest.mark.asyncio
async def test_reachability_partial_upsert_preserves_optout(client, make_agent):
    aid = (await make_agent("A"))["agent_id"]
    # SessionStart records a pane.
    r = await client.post(f"/api/agents/{aid}/reachability",
                          json={"tmux_target": "main:0.1", "headless_cwd": "/proj"})
    assert r.json()["tmux_target"] == "main:0.1"
    assert r.json()["wake_enabled"] is True
    # Human opts out (wake_enabled only) — must NOT clobber the pane.
    r = await client.post(f"/api/agents/{aid}/reachability", json={"wake_enabled": False})
    d = r.json()
    assert d["wake_enabled"] is False
    assert d["tmux_target"] == "main:0.1"      # preserved
    assert d["headless_cwd"] == "/proj"        # preserved
    # A later SessionStart refresh of the pane must NOT silently re-enable wakes.
    r = await client.post(f"/api/agents/{aid}/reachability", json={"tmux_target": "main:2.0"})
    d = r.json()
    assert d["tmux_target"] == "main:2.0"
    assert d["wake_enabled"] is False          # opt-out sticks


# ---------- wake-scan decision (the truth table) ----------

async def _scan(client, cid, aid, *, cooldown=15.0, min_idle=30.0):
    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": cooldown, "min_idle": min_idle})
    assert r.status_code == 200, r.text
    body = r.json()
    cand = next((c for c in body["candidates"] if c["agent_id"] == aid), None)
    return body, cand


def _emit_event(db, *, container_id, agent_id, event_name, ts, payload=None):
    db.execute(
        """INSERT INTO agent_events (container_id, target_id, event_key, event_name, ts, payload)
           VALUES (%s, %s, %s, %s, %s, %s::jsonb)""",
        (container_id, agent_id, agent_id, event_name, ts, json.dumps(payload or {})),
    )


@pytest.mark.asyncio
async def test_pending_event_on_idle_agent_should_wake(client, container, make_agent, make_request):
    a = await make_agent("A")
    b = await make_agent("B")
    # A asks B → request_created event keyed to B. B has no heartbeat → idle.
    await make_request(a["agent_id"], "need input", target_alias="B")
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["should_wake"] is True
    assert cand["pending_events"] >= 1
    assert cand["latest_event"] == "request_created"


# ---------- ISS-77 (#200): event-driven wakes regardless of task status ----------

@pytest.mark.asyncio
async def test_request_answered_wakes_requester(client, container, make_agent, make_request):
    """ISS-77 (#200): `request_answered` is a genuine 'my request was answered → wake + act' signal
    (it does NOT self-echo), so a dev whose request gets answered wakes. It is never suppressed as a
    non-waking audit echo on the ephemeral wake path (only digest_snapshotted is)."""
    b = await make_agent("B")
    c = await make_agent("C")
    # B asks C; C answers → request_answered keyed to B (the requester).
    req = await make_request(b["agent_id"], "need a hand", target_alias="C")
    r = await client.post(f"/api/requests/{req['id']}/respond",
                          json={"responder_agent_id": c["agent_id"], "response": "here"})
    assert r.status_code == 200, r.text
    _, cand = await _scan(client, container["id"], b["agent_id"], min_idle=0)
    assert cand["latest_event"] == "request_answered"
    assert cand["should_wake"] is True


@pytest.mark.asyncio
async def test_in_progress_task_does_not_suppress_event_wake(client, container, make_agent, make_task, make_request):
    """ISS-77 (#200): an in_progress task must NOT suppress a wake on a genuine pending event. Events
    drive wakes, not task status. A dev holding an in_progress task (with NO ready auto-start target)
    still wakes when a real event lands — here `request_answered` (its own request got answered)."""
    b = await make_agent("B")
    c = await make_agent("C")
    # A standalone assigned task with no deps is claimed in_progress at create, so it is NOT a
    # ready auto-start target. The ONLY thing that can wake B here is the pending event.
    await make_task("build it", "done", assignee_alias="B")
    req = await make_request(b["agent_id"], "need a hand", target_alias="C")
    r = await client.post(f"/api/requests/{req['id']}/respond",
                          json={"responder_agent_id": c["agent_id"], "response": "here"})
    assert r.status_code == 200, r.text
    _, cand = await _scan(client, container["id"], b["agent_id"], min_idle=0)
    assert cand["auto_start_task_ids"] == []        # the in_progress task is NOT an auto-start target
    assert cand["latest_event"] == "request_answered"
    assert cand["should_wake"] is True              # the event wakes despite the in_progress task


@pytest.mark.asyncio
async def test_wake_scan_includes_ranked_notification_manifest(
        client, container, make_agent, make_task, make_request):
    """#247 B1: wake_scan consumes the notification registry and returns a rank-ordered manifest.

    The locked rule is visible here: a human-origin request outranks a P0 task event. The task's
    object priority still rides along for tie-breaking inside its own rank.
    """
    b = await make_agent("B")
    c = await make_agent("C")
    human = await make_agent("Operator", kind="human")

    task = await make_task("urgent task", "done", assignee_alias="B", priority=0)
    await make_request(human["agent_id"], "operator needs an answer", target_alias="B", priority=80)
    req = await make_request(b["agent_id"], "is the review clean?", target_alias="C", priority=5)
    r = await client.post(f"/api/requests/{req['id']}/respond",
                          json={"responder_agent_id": c["agent_id"], "response": "clean"})
    assert r.status_code == 200, r.text

    _, cand = await _scan(client, container["id"], b["agent_id"], min_idle=0)
    manifest = cand["notifications"]
    assert cand["pending_events"] == 3
    assert [n["event_name"] for n in manifest[:3]] == [
        "request_created", "task_assigned", "request_answered"]
    assert [n["rank"] for n in manifest[:3]] == [3, 4, 6]
    assert manifest[0]["actor_kind"] == "human"
    assert manifest[1]["deeplink"] == {"kind": "task", "id": task["id"]}
    assert manifest[1]["object_priority"] == 0
    assert manifest[1]["surface"] == f"task:{task['id']}"


@pytest.mark.asyncio
async def test_wake_scan_ranks_before_manifest_limit(client, container, make_agent, db):
    """Lens rework: a newer high-rank interrupt must not be hidden behind an older low-rank flood.

    The manifest limit is a prompt-size cap, not a pre-ranking fetch cap.
    """
    b = await make_agent("B")
    aid = b["agent_id"]
    db.execute(
        """INSERT INTO agent_events (container_id, target_id, event_key, event_name, ts, payload)
           SELECT %s, %s, %s, 'request_answered', gs::float,
                  jsonb_build_object('request_id', 'old-' || gs::text, 'preview', 'old')
           FROM generate_series(1, 525) AS gs""",
        (container["id"], aid, aid),
    )
    _emit_event(db, container_id=container["id"], agent_id=aid, event_name="prompt",
                ts=1000.0, payload={"message": "stop and read this first"})

    _, cand = await _scan(client, container["id"], aid, min_idle=0)
    manifest = cand["notifications"]
    assert cand["pending_events"] == 526
    assert manifest[0]["event_name"] == "prompt"
    assert manifest[0]["rank"] == 1
    assert cand["notifications_truncated"] is True


# ---------- A3: prompt-event (wake an agent with a directed message) ----------

@pytest.mark.asyncio
async def test_prompt_event_wakes_agent_and_carries_message(client, container, make_agent):
    """A3: POST /prompt publishes a wakeable `prompt` event; wake-scan surfaces the message text
    for the daemon to inject, and /wait delivers it to an interactive listener."""
    b = await make_agent("B")
    aid = b["agent_id"]
    r = await client.post(f"/api/agents/{aid}/prompt", json={"message": "re-check the failing test"})
    assert r.status_code == 201, r.text
    assert r.json()["event"] == "prompt"

    _, cand = await _scan(client, container["id"], aid)
    assert cand["should_wake"] is True                       # an idle agent with a prompt wakes
    assert cand["pending_events"] >= 1
    assert cand["latest_event"] == "prompt"
    assert cand["prompt_messages"] == ["re-check the failing test"]   # surfaced for the worker

    # an interactive listener sees it via /wait, with the message in the payload
    w = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 1})
    evt = w.json()
    assert evt["event"] == "prompt" and evt["message"] == "re-check the failing test"


@pytest.mark.asyncio
async def test_prompt_records_sender_and_validates(client, container, make_agent):
    a = await make_agent("A")
    b = await make_agent("B")
    r = await client.post(f"/api/agents/{b['agent_id']}/prompt",
                          json={"message": "poke", "from_agent_id": a["agent_id"]})
    assert r.status_code == 201, r.text
    w = await client.get(f"/api/agents/{b['agent_id']}/wait", params={"since_ts": 0, "timeout": 1})
    assert w.json()["from_agent_id"] == a["agent_id"]
    # bad from_agent_id → 400; empty message → 422 (min_length)
    assert (await client.post(f"/api/agents/{b['agent_id']}/prompt",
                              json={"message": "x", "from_agent_id": "not-a-uuid"})).status_code == 400
    assert (await client.post(f"/api/agents/{b['agent_id']}/prompt",
                              json={"message": ""})).status_code == 422


@pytest.mark.asyncio
async def test_prompt_unknown_agent_404(client, make_agent):
    import uuid
    r = await client.post(f"/api/agents/{uuid.uuid4()}/prompt", json={"message": "hi"})
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_all_pending_prompts_surfaced_no_silent_drop(client, container, make_agent):
    """A3 P2: the daemon acks ALL pending events at once (max_event_ts), so wake-scan must surface
    EVERY pending prompt — a row cap would let prompts past it be acked-away unseen (no prompt
    inbox to recover them)."""
    b = await make_agent("B")
    aid = b["agent_id"]
    for i in range(11):
        r = await client.post(f"/api/agents/{aid}/prompt", json={"message": f"msg-{i}"})
        assert r.status_code == 201, r.text
    _, cand = await _scan(client, container["id"], aid)
    assert len(cand["prompt_messages"]) == 11                       # all surfaced, none dropped
    assert cand["prompt_messages"][0] == "msg-0"                    # oldest-first
    assert cand["prompt_messages"][-1] == "msg-10"
    assert cand["ack_through_ts"] == cand["max_event_ts"]          # nothing truncated → ack all


@pytest.mark.asyncio
async def test_prompt_batch_capped_by_size_then_delivered_next_wake(client, container, make_agent):
    """A3 P2: a big prompt backlog must NOT all concatenate into one argv (spawn would fail and
    retry forever). wake-scan caps the batch by aggregate size and acks only through the last
    INCLUDED prompt; the rest stay pending and arrive on the next wake (forward progress, no loss)."""
    b = await make_agent("B")
    aid = b["agent_id"]
    big = "x" * 3990
    for i in range(8):                                              # 8 * ~3994 = ~31952 > 24000 cap
        r = await client.post(f"/api/agents/{aid}/prompt", json={"message": f"P{i}-{big}"})
        assert r.status_code == 201, r.text

    _, cand = await _scan(client, container["id"], aid)
    n1 = len(cand["prompt_messages"])
    assert 0 < n1 < 8                                               # truncated to a bounded batch
    assert sum(len(m) for m in cand["prompt_messages"]) <= 24_000   # aggregate within argv budget
    assert cand["ack_through_ts"] < cand["max_event_ts"]           # ack stops at last included

    # the daemon acks only through ack_through_ts → the remainder is still pending
    await client.post(f"/api/agents/{aid}/wake-ack",
                      json={"kind": "ephemeral", "delivered_ts": cand["ack_through_ts"]})
    _, cand2 = await _scan(client, container["id"], aid)
    assert len(cand2["prompt_messages"]) >= 1                       # remainder delivered next wake
    assert cand2["prompt_messages"][0] not in cand["prompt_messages"]   # new ones (progress, no loss)


# ---------- ISS-55 / ISS-56: task-thread messages wake AND surface + attribute ----------

@pytest.mark.asyncio
async def test_task_message_surfaced_into_wake_prompt(client, container, make_agent, make_task):
    """ISS-55: a teammate/human note on a task thread wakes the assignee — and its content is now
    SURFACED into the wake prompt (was prompt-only) so the woken worker reads + answers the thread
    instead of no-op'ing. ISS-56: wake-scan carries the triggering event's task_id so the
    event-wake worker_run is attributed to that task (not NULL/invisible)."""
    b = await make_agent("B")
    aid = b["agent_id"]
    # A task B is assigned to, then a HUMAN posts a note on its thread (author_agent_id omitted) →
    # publishes a `task_message` event keyed to B.
    t = await make_task("ship the thing", "done when shipped", assignee_alias="B")
    tid = t["id"]
    r = await client.post(f"/api/tasks/{tid}/messages", json={"body": "please rebase onto main"})
    assert r.status_code == 201, r.text

    _, cand = await _scan(client, container["id"], aid, min_idle=0)
    assert cand["should_wake"] is True
    assert cand["latest_event"] == "task_message"
    # ISS-86: the assignment itself surfaces a `task_assigned` directed message; the thread note
    # adds the `task_message` directed message. BOTH surface; the task_message is the one framed
    # with the body + RESPOND directive.
    msgs = cand["prompt_messages"]
    assert any("new task assigned" in m for m in msgs)             # ISS-86 task_assigned surface
    surfaced = next(m for m in msgs if "please rebase onto main" in m)
    assert tid in surfaced
    assert "RESPOND on it" in surfaced
    # ISS-56: the run gets attributed to this task
    assert cand["wake_task_id"] == tid
    # end-to-end: build_wake_prompt injects them as directed messages for the worker to act on
    p = notifier.build_wake_prompt(cand)
    assert "DIRECTED MESSAGE" in p and "please rebase onto main" in p


@pytest.mark.asyncio
async def test_prompt_only_wake_has_no_task_id(client, container, make_agent):
    """Regression: a pure A3 `prompt` wake (no task thread) still surfaces the message but leaves
    wake_task_id None — only task_message events attribute a task."""
    aid = (await make_agent("B"))["agent_id"]
    r = await client.post(f"/api/agents/{aid}/prompt", json={"message": "look at the logs"})
    assert r.status_code == 201, r.text
    _, cand = await _scan(client, container["id"], aid, min_idle=0)
    assert cand["prompt_messages"] == ["look at the logs"]
    assert cand["wake_task_id"] is None


@pytest.mark.asyncio
async def test_mixed_prompt_and_task_message_backlog_both_surfaced(client, container, make_agent, make_task):
    """A mixed backlog (an A3 prompt, the assignment's task_assigned, AND a task_message) surfaces
    ALL THREE oldest-first, and the latest task event sets wake_task_id."""
    b = await make_agent("B")
    aid = b["agent_id"]
    r1 = await client.post(f"/api/agents/{aid}/prompt", json={"message": "first: a poke"})
    assert r1.status_code == 201, r1.text
    t = await make_task("thread task", "dod", assignee_alias="B")   # → task_assigned (ISS-86)
    tid = t["id"]
    r2 = await client.post(f"/api/tasks/{tid}/messages", json={"body": "second: a thread note"})
    assert r2.status_code == 201, r2.text

    _, cand = await _scan(client, container["id"], aid, min_idle=0)
    msgs = cand["prompt_messages"]
    assert len(msgs) == 3
    assert msgs[0] == "first: a poke"                              # A3 prompt, verbatim, oldest
    assert any("new task assigned" in m for m in msgs)            # ISS-86 task_assigned surface
    assert any("second: a thread note" in m for m in msgs)       # task_message, framed
    assert cand["wake_task_id"] == tid


# ---------- ISS-86 / #245: create-and-assign wakes a cold agent ----------

@pytest.mark.asyncio
async def test_create_and_assign_does_not_suppress_wake(client, container, make_agent, make_task, db):
    """ISS-86/#245 (GAP A): create-and-assign must NOT bump the cold assignee's heartbeat. The bug
    was that create_task did, shrinking idle_seconds so wake-scan read the freshly-assigned cold
    agent as ACTIVE and suppressed the task_assigned wake for ~min_idle. With the bump gone, a
    just-assigned agent (no prior heartbeat) is still idle at the DEFAULT min_idle and wakes."""
    b = await make_agent("B")
    await make_task("build the widget", "done when shipped", assignee_alias="B")
    # The assignment did not stamp last_heartbeat_at (it stays NULL → idle).
    row = db.execute("SELECT last_heartbeat_at FROM agents WHERE id=%s", (b["agent_id"],))
    assert row[0]["last_heartbeat_at"] is None
    # default min_idle=30: the cold assignee is still idle → should_wake (was suppressed by the bump)
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["should_wake"] is True
    assert cand["latest_event"] == "task_assigned"


@pytest.mark.asyncio
async def test_create_and_assign_surfaces_task_assigned_directed_message(
        client, container, make_agent, make_task):
    """ISS-86/#245 (Option C): a create-and-assign task lands `in_progress`, so it is NOT a `ready`
    auto-start target /orcha-next would list. wake-scan now SURFACES the `task_assigned` event as a
    directed message (framed by the task's status) so the woken worker knows WHICH task to begin and
    how — and the run is attributed to it (ISS-56)."""
    b = await make_agent("B")
    t = await make_task("build the widget", "done when shipped", assignee_alias="B")
    tid = t["id"]
    _, cand = await _scan(client, container["id"], b["agent_id"], min_idle=0)
    assert cand["should_wake"] is True
    assert cand["latest_event"] == "task_assigned"
    assert cand["auto_start_task_ids"] == []                       # in_progress → NOT an auto-start
    assert len(cand["prompt_messages"]) == 1
    surfaced = cand["prompt_messages"][0]
    assert tid in surfaced and "build the widget" in surfaced
    assert "in_progress" in surfaced and "/orcha-next will NOT list it" in surfaced
    assert cand["wake_task_id"] == tid                             # ISS-56 attribution
    # build_wake_prompt injects it as a directed message for the worker to act on
    p = notifier.build_wake_prompt(cand)
    assert "DIRECTED MESSAGE FOR YOU" in p and "build the widget" in p


@pytest.mark.asyncio
async def test_task_assigned_for_finished_task_not_surfaced(client, container, make_agent, make_task, db):
    """ISS-86/#245 (Option C): a `task_assigned` whose task was completed/cancelled before the wake
    surfaces NOTHING (no stale 'new task' directive) but is still acked — the cursor advances past
    it so it does not wedge. Teeth: flipping the task to a live status would re-surface it."""
    b = await make_agent("B")
    t = await make_task("obsolete work", "n/a", assignee_alias="B")
    db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (t["id"],))
    _, cand = await _scan(client, container["id"], b["agent_id"], min_idle=0)
    assert cand["prompt_messages"] == []                           # nothing stale surfaced
    assert cand["wake_task_id"] is None                            # no attribution to a dead task
    assert cand["ack_through_ts"] == cand["max_event_ts"]          # but acked (advances past it)


@pytest.mark.asyncio
async def test_paused_container_suppresses_wakes(client, container, make_agent, make_request):
    human = await make_agent("H", kind="human")
    a = await make_agent("A")
    b = await make_agent("B")
    await make_request(a["agent_id"], "need input", target_alias="B")
    r = await client.post(f"/api/containers/{container['id']}/status",
                          json={"status": "paused", "actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    body, cand = await _scan(client, container["id"], b["agent_id"])
    assert body["active"] is False
    assert cand["should_wake"] is False        # respects /orcha-pause


@pytest.mark.asyncio
async def test_wake_disabled_opt_out(client, container, make_agent, make_request):
    a = await make_agent("A")
    b = await make_agent("B")
    await client.post(f"/api/agents/{b['agent_id']}/reachability", json={"wake_enabled": False})
    await make_request(a["agent_id"], "need input", target_alias="B")
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["should_wake"] is False
    assert "disabled" in cand["reason"]


@pytest.mark.asyncio
async def test_active_agent_not_woken_until_idle(client, container, make_agent, make_request):
    a = await make_agent("A")
    # B registers WITH an initial task → heartbeat bumped now → looks active.
    b = await make_agent("B", initial_task={"title": "t", "definition_of_done": "d"})
    await make_request(a["agent_id"], "need input", target_alias="B")
    _, cand = await _scan(client, container["id"], b["agent_id"], min_idle=30)
    assert cand["should_wake"] is False        # recent heartbeat → cooperative, don't barge in
    assert "active" in cand["reason"]
    # With min_idle=0 the idle gate is off → it should wake.
    _, cand = await _scan(client, container["id"], b["agent_id"], min_idle=0)
    assert cand["should_wake"] is True


@pytest.mark.asyncio
async def test_wake_ack_advances_cursor(client, container, make_agent, make_request):
    a = await make_agent("A")
    b = await make_agent("B")
    await make_request(a["agent_id"], "q1", target_alias="B")
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["pending_events"] == 1
    # Daemon acks delivery up to the latest event ts.
    r = await client.post(f"/api/agents/{b['agent_id']}/wake-ack",
                          json={"delivered_ts": cand["max_event_ts"], "kind": "tmux",
                                "event": "request_created"})
    assert r.status_code == 200, r.text
    # Re-scan: that event is now behind the cursor.
    _, cand2 = await _scan(client, container["id"], b["agent_id"], cooldown=0)
    assert cand2["pending_events"] == 0
    assert cand2["should_wake"] is False
    # A new event after the cursor re-arms the wake.
    await make_request(a["agent_id"], "q2", target_alias="B")
    _, cand3 = await _scan(client, container["id"], b["agent_id"], cooldown=0)
    assert cand3["pending_events"] == 1
    assert cand3["should_wake"] is True


@pytest.mark.asyncio
async def test_wake_ack_cooldown_debounce(client, container, make_agent, make_request):
    a = await make_agent("A")
    b = await make_agent("B")
    await make_request(a["agent_id"], "q", target_alias="B")
    # Unreachable ack (no delivery) still stamps last_woken_at for the cooldown.
    await client.post(f"/api/agents/{b['agent_id']}/wake-ack",
                      json={"kind": "unreachable", "event": "request_created"})
    _, cand = await _scan(client, container["id"], b["agent_id"], cooldown=600)
    assert cand["in_cooldown"] is True
    assert cand["should_wake"] is False
    # Cooldown=0 lifts the debounce; the event is still pending (cursor not advanced).
    _, cand = await _scan(client, container["id"], b["agent_id"], cooldown=0)
    assert cand["pending_events"] == 1
    assert cand["should_wake"] is True


@pytest.mark.asyncio
async def test_wake_ack_cursor_never_moves_backwards(client, make_agent):
    aid = (await make_agent("A"))["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-ack", json={"delivered_ts": 1000.0, "kind": "tmux"})
    r = await client.post(f"/api/agents/{aid}/wake-ack", json={"delivered_ts": 5.0, "kind": "tmux"})
    assert r.json()["delivered_ts"] == 1000.0   # GREATEST guard


# ---------- auto-start target detection + targeted task_ready ----------

@pytest.mark.asyncio
async def test_assigned_ready_task_is_autostart_target(client, container, make_agent, make_task):
    b = await make_agent("B")
    # A standalone task assigned to B with no deps is in_progress (claimed at create),
    # so it is NOT a ready auto-start target. Make one that is ready instead: create
    # unassigned-ready then... simplest: a task assigned via the dep-unblock path below.
    # Here assert the trivial case: no ready assigned tasks => empty list.
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert cand["auto_start_task_ids"] == []


@pytest.mark.asyncio
async def test_targeted_task_ready_wakes_owner_on_unblock(client, container, make_agent, make_task, db):
    human = await make_agent("H", kind="human")
    a = await make_agent("A")
    b = await make_agent("B")
    # D (assigned to A) blocks T (assigned to B).
    d = await make_task("D", "done-d", assignee_alias="A")
    t = await make_task("T", "done-t", assignee_alias="B", depends_on=[d["id"]])
    # T starts pending (blocked on D); no per-agent signal to B yet.
    _, cand = await _scan(client, container["id"], b["agent_id"])
    assert t["id"] not in cand["auto_start_task_ids"]
    # A finishes D; human verifies → D completed, T unblocks to 'ready'.
    await client.post(f"/api/tasks/{d['id']}/done",
                      json={"agent_id": a["agent_id"], "result": "ok"})
    r = await client.post(f"/api/tasks/{d['id']}/verify",
                          json={"approve": True, "actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    assert t["id"] in r.json()["unblocked"]
    # A targeted task_ready landed on B (not just the container-wide one).
    rows = db.event_rows(b["agent_id"])
    ready = [e for e in rows if e["event_name"] == "task_ready"]
    assert ready, "expected a task_ready event keyed to the assignee"
    assert ready[-1]["payload"].get("assigned") is True
    assert ready[-1]["payload"].get("task_id") == t["id"]
    # And the scan now lists T as an auto-start target for B. (min_idle=0 models "B has been idle
    # a while," the real-world case. ISS-86/#245: assignment no longer bumps B's heartbeat, so the
    # idle gate doesn't suppress this wake either way.)
    _, cand = await _scan(client, container["id"], b["agent_id"], min_idle=0)
    assert t["id"] in cand["auto_start_task_ids"]
    assert cand["should_wake"] is True


# ---------- notifier pure functions (no real terminals) ----------

def test_build_wake_prompt_is_safe_and_directive():
    p = notifier.build_wake_prompt(
        {"alias": "Forge", "pending_events": 2, "auto_start_task_ids": ["x"]})
    assert "Forge" in p
    # R2.4: one-shot worker — a single inbox pass then EXIT, NOT the /orcha-listen
    # long-poll watch loop that caused the runaway pileup.
    assert "ONE-SHOT" in p
    assert "EXIT" in p
    assert "do NOT enter the `/orcha-listen`" in p
    assert "/orcha-next --alias Forge" in p
    assert "needs_verification" in p           # never self-certify, baked into the prompt
    # R2.2: drain the FULL backlog (all items, until empty), not just the first.
    assert "FULL inbox" in p
    assert "EMPTY" in p
    # GH #33: after claiming, the worker is told to read the full task body (description +
    # definition_of_done) and honor loops — not work off the title alone.
    assert "definition_of_done" in p
    assert "loop" in p


def test_build_wake_prompt_surfaces_directed_message():
    """A3: a prompt-event's message is injected verbatim so the worker acts on it specifically."""
    p = notifier.build_wake_prompt(
        {"alias": "Forge", "pending_events": 1,
         "prompt_messages": ["re-check the failing test and report back"]})
    assert "DIRECTED MESSAGE FOR YOU" in p
    assert '"re-check the failing test and report back"' in p
    # still a one-shot drain-then-exit worker
    assert "ONE-SHOT" in p and "EXIT" in p


def test_build_wake_prompt_directed_message_on_task_steers_to_full_body():
    """GH #33: when a directed-message wake resolves a task (wake_task_id set — the task-thread
    message path), the worker is told to read the FULL task body (description + definition_of_done)
    riding in its 'Your task' section, not act on the message preview / title alone."""
    p = notifier.build_wake_prompt(
        {"alias": "Forge", "pending_events": 1, "wake_task_id": "t-42",
         "prompt_messages": ["see my note on the thread"]})
    assert "DIRECTED MESSAGE FOR YOU" in p
    assert "definition_of_done" in p
    assert "Your task" in p and "title alone" in p
    # no task resolved → no body directive (a plain inbox-only directed message)
    p2 = notifier.build_wake_prompt(
        {"alias": "Forge", "pending_events": 1, "prompt_messages": ["ping"]})
    assert "Your task" not in p2


def test_build_wake_prompt_renders_ranked_manifest():
    p = notifier.build_wake_prompt(
        {"alias": "Forge", "pending_events": 2,
         "notifications": [
             {"rank": 3, "rank_label": "human_conversation", "surface": "request:R-human",
              "actor_alias": "Kedar", "object_priority": 80, "preview": "operator needs an answer"},
             {"rank": 4, "rank_label": "task", "surface": "task:T-urgent",
              "actor_alias": "Helm", "object_priority": 0, "preview": "urgent task"},
         ]})
    assert "RANKED WAKE MANIFEST" in p
    assert "rank 3 human-conversation -> request:R-human from Kedar p=80" in p
    assert p.index("rank 3 human-conversation") < p.index("rank 4 task")
    assert "FULL inbox" in p and "EMPTY" in p


def test_build_wake_prompt_task_request_steers_into_work():
    """#359: a TASK-request in the manifest must steer the worker to ACCEPT + DO the work, not
    deflect it. It surfaces distinctly ('task-request-in') and the don't-claim guidance is replaced
    by an accept-and-progress directive — otherwise the warm drain answers/defers it and the work
    never spawns."""
    p = notifier.build_wake_prompt(
        {"alias": "Ledger", "pending_events": 1,
         "notifications": [
             {"rank": 5, "rank_label": "request_in", "surface": "request:R-build",
              "actor_alias": "Helm", "object_priority": 10, "preview": "BUILD fix for issue #359",
              "is_task_request": True},
         ]})
    # surfaced as work, not a generic request-in
    assert "rank 5 task-request-in -> request:R-build from Helm p=10" in p
    # steered into the work
    assert "/orcha-accept-task" in p
    assert "SPAWNS the task" in p
    assert "deflects the work" in p
    # the deflecting don't-claim guidance is overridden when a task-request is pending
    assert "assignment is the only task trigger" not in p
    assert "FULL inbox" in p and "EMPTY" in p


def test_build_wake_prompt_info_request_is_not_steered_into_a_task():
    """Guard the #359 carve-out: an ORDINARY (info) request must NOT trigger the accept-task
    directive or the task-request label — only `is_task_request` items do."""
    p = notifier.build_wake_prompt(
        {"alias": "Ledger", "pending_events": 1,
         "notifications": [
             {"rank": 5, "rank_label": "request_in", "surface": "request:R-ask",
              "actor_alias": "Helm", "object_priority": 10, "preview": "quick question"},
         ]})
    assert "rank 5 request-in -> request:R-ask" in p
    assert "task-request-in" not in p
    assert "/orcha-accept-task" not in p
    # falls back to the generic don't-claim guidance (no task-request, no auto-start)
    assert "assignment is the only task trigger" in p


def test_build_wake_prompt_no_directed_section_without_prompts():
    p = notifier.build_wake_prompt({"alias": "Forge", "pending_events": 1})
    assert "DIRECTED MESSAGE" not in p
    assert "/orcha-next --alias Forge" not in p
    assert "assignment is the only task trigger" in p


def test_build_wake_prompt_handles_multiple_directed_messages():
    p = notifier.build_wake_prompt(
        {"alias": "Forge", "pending_events": 2, "prompt_messages": ["first ask", "second ask"]})
    assert "DIRECTED MESSAGES FOR YOU" in p          # plural
    assert '(prompt 1) "first ask"' in p and '(prompt 2) "second ask"' in p


def test_sidecar_drain_prompt_surfaces_directed_messages():
    """#247 B3 Gate P1b: `prompt`/`task_message`/`task_assigned` events have NO inbox surface — the
    drain sidecar must be FED their content (else acking the cursor silently drops them). The lean
    drain prompt quotes each directed message verbatim while staying a one-shot, no-task-start worker."""
    p = notifier.build_resident_sidecar_drain_prompt(
        "Vox", 2, ["read task T-7's thread and RESPOND", "ack the decision on T-9"])
    assert "DIRECTED MESSAGES FOR YOU" in p                              # plural
    assert '(message 1) "read task T-7\'s thread and RESPOND"' in p
    assert '(message 2) "ack the decision on T-9"' in p
    assert "do not claim or start a task" in p.lower()                   # still lean: NO task auto-start
    assert "/orcha-listen" in p                                          # still one-shot, no watch loop


def test_sidecar_drain_prompt_no_directed_section_without_messages():
    """No directed messages (only request/decision events that DO have an inbox surface) → no quoted
    block; the sidecar just drains the backlog count. Singular vs plural framing also exercised above."""
    p = notifier.build_resident_sidecar_drain_prompt("Vox", 3)
    assert "DIRECTED MESSAGE" not in p
    p1 = notifier.build_resident_sidecar_drain_prompt("Vox", 1, ["the only ask"])
    assert "DIRECTED MESSAGE FOR YOU" in p1 and '(message 1) "the only ask"' in p1


def test_resident_drain_prompt_builder_removed():
    """ISS-78 (A2): the in-session resident drain is gone — the warm resident idle-YIELDS and an
    ordinary ephemeral worker drains the backlog via build_wake_prompt in its own session — so the
    dedicated drain-prompt builder no longer exists (its removal proves the in-session path is dead)."""
    assert not hasattr(notifier, "build_resident_drain_prompt")


def test_select_transport_prefers_live_tmux(monkeypatch):
    monkeypatch.setattr(notifier, "tmux_pane_live", lambda t: True)
    assert notifier.select_transport({"tmux_target": "m:0.0", "headless_cwd": "/p"}) == "tmux"


def test_select_transport_falls_back_to_ephemeral(monkeypatch):
    monkeypatch.setattr(notifier, "tmux_pane_live", lambda t: False)
    assert notifier.select_transport({"tmux_target": "m:0.0", "headless_cwd": "/p"}) == "ephemeral"
    assert notifier.select_transport({"headless_cwd": "/p"}) == "ephemeral"


def test_select_transport_unreachable_when_no_route(monkeypatch):
    monkeypatch.setattr(notifier, "tmux_pane_live", lambda t: False)
    assert notifier.select_transport({"tmux_target": None, "headless_cwd": None}) == "unreachable"


def test_dry_run_transports_never_execute():
    # dry_run must not shell out and must report a command repr.
    sent, cmd = notifier.send_tmux("m:0.0", "hi", dry_run=True)
    assert sent is False and "send-keys" in cmd
    sent, cmd, proc = notifier.spawn_headless("/proj", "hi", None, dry_run=True)
    assert sent is False and "claude -p" in cmd and proc is None


# ---------- headless worker boots AS the agent (persona + digest injection) ----------

@pytest.mark.asyncio
async def test_persona_endpoint_returns_system_prompt(client, make_agent):
    a = await make_agent("Tim", prompt="You are Tim, the PM.")
    r = await client.get(f"/api/agents/{a['agent_id']}/persona")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["system_prompt"] == "You are Tim, the PM."
    assert d["alias"] == "Tim" and d["role"]


@pytest.mark.asyncio
async def test_persona_endpoint_404_unknown_agent(client):
    import uuid
    r = await client.get(f"/api/agents/{uuid.uuid4()}/persona")
    assert r.status_code == 404


def test_format_persona_combines_persona_and_digest():
    out = notifier.format_persona(
        {"system_prompt": "You are Tim."},
        {"digest": {"current_focus": "wake epic", "decisions": ["ship A first"]}})
    assert "You are Tim." in out
    assert "Where you left off" in out
    assert "prior reasoning, not live truth" in out
    assert "source of truth before acting or deciding there is nothing to do" in out
    assert "Current focus: wake epic" in out
    assert "ship A first" in out


def test_format_persona_handles_missing_pieces():
    assert notifier.format_persona(None, None) is None
    # #325: a persona (booting AS an agent) now always rides the plain-language guardrail,
    # so the output is the system prompt + the guardrail, not the bare prompt.
    p_only = notifier.format_persona({"system_prompt": "P"}, {"digest": None})
    assert p_only.startswith("P")
    assert "plain-language guardrail" in p_only
    # digest only, no persona → still produces the digest section (and NO guardrail, since
    # we're not booting as a real agent without a persona).
    only_dig = notifier.format_persona(None, {"digest": {"current_focus": "X"}})
    assert only_dig and "Current focus: X" in only_dig
    assert "plain-language guardrail" not in only_dig


def test_format_persona_always_injects_human_comms_guardrail():
    """#325: every wake that boots AS an agent carries the plain-language guardrail —
    even with no digest yet — so a fresh agent doesn't address humans in internal jargon."""
    out = notifier.format_persona({"system_prompt": "You are Tim."}, None)
    assert "You are Tim." in out
    assert "Talking to humans" in out
    assert "No bare UUIDs" in out


def test_format_persona_surfaces_audience_register_ahead_of_facts():
    """#325: the digest's `audience` slice renders as 'Who you're talking to', and lands
    BEFORE the 'Where you left off' facts so the conversational register frames the work."""
    out = notifier.format_persona(
        {"system_prompt": "You are Tim."},
        {"digest": {"current_focus": "wake epic",
                    "audience": "Talking to Kedar — non-engineer; wants plain answers."}})
    assert "Who you're talking to" in out
    assert "non-engineer" in out
    # register comes ahead of the facts
    assert out.index("Who you're talking to") < out.index("Where you left off")


def test_format_persona_omits_audience_section_when_absent():
    """#325: a digest without `audience` (e.g. a pre-#325 row) renders no register section."""
    out = notifier.format_persona(
        {"system_prompt": "You are Tim."},
        {"digest": {"current_focus": "wake epic"}})
    assert "Who you're talking to" not in out
    assert "Current focus: wake epic" in out


def test_spawn_headless_injects_persona_and_alias(monkeypatch, tmp_path):
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured.update(argv=argv, cwd=cwd, env=env)
            self.pid = 4321

    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    sent, _, proc = notifier.spawn_headless(str(tmp_path), "wake!", None, dry_run=False,
                                      alias="Tim", system_prompt="You are Tim.")
    assert sent is True and proc.pid == 4321   # the Popen handle is returned, not the bare pid
    argv = captured["argv"]
    assert argv[:3] == ["claude", "-p", "wake!"]
    assert "--append-system-prompt" in argv
    assert argv[argv.index("--append-system-prompt") + 1] == "You are Tim."
    assert "--dangerously-skip-permissions" in argv   # unattended: no tty to answer prompts
    assert captured["env"].get("ORCHA_ALIAS") == "Tim"   # worker resolves AS Tim
    assert captured["cwd"] == str(tmp_path)


def test_spawn_headless_passes_model(monkeypatch, tmp_path):
    """GAP A: the worker boots on the agent's selected model via `--model <id>`."""
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured["argv"] = argv
            self.pid = 1

    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    notifier.spawn_headless(str(tmp_path), "wake!", None, dry_run=False,
                            alias="Tim", model="claude-fable-5")
    argv = captured["argv"]
    assert "--model" in argv
    assert argv[argv.index("--model") + 1] == "claude-fable-5"
    # no model → no --model token (claude's own default)
    notifier.spawn_headless(str(tmp_path), "wake!", None, dry_run=False, alias="Tim")
    assert "--model" not in captured["argv"]


def test_spawn_headless_includes_partial_messages(monkeypatch, tmp_path):
    """ISS-#251: the headless Claude worker must boot with --include-partial-messages so its
    stream-json log emits token/thinking deltas DURING a turn. Without them a worker generating
    or thinking for >stall_secs goes log-silent and the stall watchdog SIGKILLs it mid-work."""
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured["argv"] = argv
            self.pid = 1

    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    notifier.spawn_headless(str(tmp_path), "wake!", None, dry_run=False, alias="Tim")
    argv = captured["argv"]
    assert "--include-partial-messages" in argv
    # it must accompany stream-json output (the flag is only meaningful there)
    assert "--output-format" in argv and argv[argv.index("--output-format") + 1] == "stream-json"


def test_spawn_headless_codex_runtime(monkeypatch, tmp_path):
    """Codex-backed models use the Codex automation surface, with persona prepended."""
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured.update(argv=argv, cwd=cwd, env=env, kw=kw)
            self.pid = 1

    monkeypatch.setattr(notifier.shutil, "which", lambda x: f"/usr/bin/{x}")
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    sent, _, proc = notifier.spawn_headless(
        str(tmp_path), "wake!", "--dangerously-skip-permissions --search",
        dry_run=False, alias="Tim", system_prompt="You are Tim.",
        model="gpt-5.5", runtime="codex")
    assert sent is True and proc.pid == 1
    argv = captured["argv"]
    assert argv[:3] == ["codex", "exec", "--json"]
    assert "--dangerously-bypass-approvals-and-sandbox" in argv
    assert "--dangerously-skip-permissions" not in argv
    assert "--model" in argv and argv[argv.index("--model") + 1] == "gpt-5.5"
    assert "--search" in argv
    assert argv[-1].startswith("You are Tim.")
    assert "## Orcha Wake Instruction\nwake!" in argv[-1]
    assert captured["env"]["ORCHA_ALIAS"] == "Tim"
    assert captured["env"]["ORCHA_AGENT_RUNTIME"] == "codex"
    assert captured["kw"]["stdin"] == notifier.subprocess.DEVNULL


def test_spawn_headless_codex_resume_reattaches_session(monkeypatch, tmp_path):
    """#286: a Codex resume_session_id builds `codex exec resume <sid> ...` and feeds the BARE
    prompt — the persona/history live in the restored rollout, so they are NOT prepended."""
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured.update(argv=argv, cwd=cwd, env=env, kw=kw)
            self.pid = 7

    monkeypatch.setattr(notifier.shutil, "which", lambda x: f"/usr/bin/{x}")
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    sent, repr_, proc = notifier.spawn_headless(
        str(tmp_path), "just the new turn", None, dry_run=False, alias="Tim",
        system_prompt="You are Tim.", model="gpt-5.5", runtime="codex",
        resume_session_id="11111111-2222-3333-4444-555555555555")
    assert sent is True and proc.pid == 7
    argv = captured["argv"]
    # the `resume <sid>` pair sits right after `exec`, before the shared flags
    assert argv[:4] == ["codex", "exec", "resume", "11111111-2222-3333-4444-555555555555"]
    assert "--json" in argv and "--model" in argv
    # BARE prompt — persona is NOT prepended on resume (it's in the rollout)
    assert argv[-1] == "just the new turn"
    assert "You are Tim." not in argv[-1]
    assert "resume 11111111-2222-3333-4444-555555555555" in repr_


def test_spawn_headless_codex_cold_has_no_resume_token(monkeypatch, tmp_path):
    """#286 mutation tooth: with NO resume_session_id the Codex argv stays the cold form (no
    `resume` token) and the persona IS prepended — proving resume is gated on the id."""
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured.update(argv=argv)
            self.pid = 8

    monkeypatch.setattr(notifier.shutil, "which", lambda x: f"/usr/bin/{x}")
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    notifier.spawn_headless(str(tmp_path), "wake!", None, dry_run=False, alias="Tim",
                            system_prompt="You are Tim.", model="gpt-5.5", runtime="codex")
    argv = captured["argv"]
    assert "resume" not in argv
    assert argv[:3] == ["codex", "exec", "--json"]
    assert argv[-1].startswith("You are Tim.")          # cold still prepends persona


def test_spawn_headless_codex_uses_app_fallback_when_not_on_path(monkeypatch, tmp_path):
    codex = tmp_path / "codex"
    codex.write_text("#!/bin/sh\n")
    codex.chmod(0o755)
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured.update(argv=argv, cwd=cwd, env=env, kw=kw)
            self.pid = 1

    monkeypatch.setattr(notifier.shutil, "which", lambda x: None)
    monkeypatch.setattr(notifier, "_CODEX_EXEC_FALLBACKS", (str(codex),))
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    sent, _, proc = notifier.spawn_headless(
        str(tmp_path), "wake!", None, dry_run=False, alias="Tim",
        model="gpt-5.5", runtime="codex")
    assert sent is True and proc.pid == 1
    assert captured["argv"][:3] == [str(codex), "exec", "--json"]


def test_spawn_headless_dry_run_shows_model():
    sent, repr_, _ = notifier.spawn_headless("/proj", "wake", None, dry_run=True,
                                             alias="Tim", model="claude-fable-5")
    assert sent is False and "--model claude-fable-5" in repr_


def test_spawn_headless_codex_dry_run_shows_runtime():
    sent, repr_, _ = notifier.spawn_headless("/proj", "wake", None, dry_run=True,
                                             alias="Tim", model="gpt-5.5", runtime="codex",
                                             system_prompt="x")
    assert sent is False
    assert "codex exec --json" in repr_
    assert "--model gpt-5.5" in repr_
    assert "prompt includes persona" in repr_


def test_spawn_headless_flags_override_default_permission(monkeypatch, tmp_path):
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured["argv"] = argv
            self.pid = 4321

    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    # a headless_flags that sets its own permission mode must NOT also get the default
    notifier.spawn_headless(str(tmp_path), "wake", "--permission-mode plan", dry_run=False, alias="T")
    argv = captured["argv"]
    assert "--permission-mode" in argv
    assert "--dangerously-skip-permissions" not in argv   # no double permission flag


def test_spawn_headless_dry_run_shows_persona_and_alias():
    sent, repr_, _ = notifier.spawn_headless("/proj", "wake", None, dry_run=True,
                                          alias="Tim", system_prompt="x")
    assert sent is False
    assert "ORCHA_ALIAS=Tim" in repr_
    assert "append-system-prompt" in repr_


# ---------- daemon lifecycle: restart on init, stop on down ----------

def test_stop_daemon_noop_when_not_running(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text('{"api_base_url":"http://x"}')
    assert notifier.stop_daemon(tmp_path, quiet=True) is False   # nothing to stop


def test_ensure_daemon_restart_stops_old_then_starts_fresh(monkeypatch, tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text('{"api_base_url":"http://x"}')
    (tmp_path / ".claude" / ".orcha-notifier.pid").write_text("99999")  # pretend one runs
    killed, spawned = [], []
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: pid == 99999 and 99999 not in killed)
    monkeypatch.setattr(notifier.os, "kill", lambda pid, sig: killed.append(pid))
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/orcha")

    class FakePopen:
        def __init__(self, *a, **k):
            self.pid = 4242
            spawned.append(a)

    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    ok = notifier.ensure_daemon(tmp_path, quiet=True, restart=True)
    assert ok is True
    assert 99999 in killed   # stale daemon stopped first (so the new one binds the new container)
    assert spawned           # fresh daemon spawned


# ---------- container-global singleton (incident 2026-06-10: cross-worktree double-spawn) ----------

def _worktree(tmp_path, name, cid="cid-1"):
    wt = tmp_path / name
    (wt / ".claude").mkdir(parents=True)
    (wt / ".claude" / "orcha.json").write_text(
        '{"api_base_url":"http://x","current_container_id":"%s"}' % cid)
    return wt


def _patch_global_pid_dir(monkeypatch, tmp_path):
    gdir = tmp_path / "global-pids"
    monkeypatch.setattr(notifier, "_global_pid_path",
                        lambda cid: gdir / f"notifier-{cid}.pid")
    # keep these tests hermetic: the [P2 #224] pre-claim probe must not hit the network
    # ("the API knows the container" is the default; refusal cases override per-test)
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "ok")
    return gdir


def test_ensure_daemon_refuses_cross_worktree_duplicate(monkeypatch, tmp_path):
    """A daemon started from worktree A must block --ensure from worktree B (same container)."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt_a, wt_b = _worktree(tmp_path, "Orcha"), _worktree(tmp_path, "Orcha-agent")
    gdir.mkdir()
    (gdir / "notifier-cid-1.pid").write_text(f"77777\n{wt_a}")  # daemon alive, from A
    # #276 rework: the global-claim liveness decision now goes through `_daemon_pid_live` (zombie/
    # reuse-aware), not bare `_pid_alive` — mock it so pid 77777 reads as our live daemon without
    # shelling out to a real `ps` (whose subprocess.run would also trip the Popen spy below).
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: pid == 77777)
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: pid == 77777)
    spawned = []
    monkeypatch.setattr(notifier.subprocess, "Popen",
                        lambda *a, **k: spawned.append(a))
    ok = notifier.ensure_daemon(wt_b, quiet=True)   # B has NO per-cwd pidfile
    assert ok is True       # "already running" — satisfied, not an error
    assert not spawned      # and crucially: NO second daemon


def test_ensure_daemon_spawn_claims_container(monkeypatch, tmp_path):
    """A fresh spawn writes the container-keyed claim so other worktrees see it, and the
    spawned argv carries --container so `ps` is self-explanatory (#218 hardening)."""
    _patch_global_pid_dir(monkeypatch, tmp_path)
    wt = _worktree(tmp_path, "Orcha")
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/orcha")
    argvs = []

    class FakePopen:
        def __init__(self, argv, *a, **k):
            self.pid = 4242
            argvs.append(argv)

    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    assert notifier.ensure_daemon(wt, quiet=True) is True
    claim = notifier._global_pid_path("cid-1").read_text().splitlines()
    assert claim[0] == "4242" and claim[1] == str(wt)
    assert argvs and argvs[0][-2:] == ["--container", "cid-1"]   # ps-legible + pgrep-able


def test_ensure_daemon_stale_container_claim_respawns(monkeypatch, tmp_path):
    """A claim naming a DEAD pid must not block a fresh spawn."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt = _worktree(tmp_path, "Orcha")
    gdir.mkdir()
    (gdir / "notifier-cid-1.pid").write_text("66666\n/gone")    # dead daemon's claim
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: pid == 4242)
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/orcha")
    spawned = []

    class FakePopen:
        def __init__(self, *a, **k):
            self.pid = 4242
            spawned.append(a)

    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    assert notifier.ensure_daemon(wt, quiet=True) is True
    assert spawned          # stale claim ignored → fresh daemon


def test_ensure_daemon_restart_kills_cross_worktree_daemon(monkeypatch, tmp_path):
    """restart=True must also stop a daemon another worktree started for this container."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt_a, wt_b = _worktree(tmp_path, "Orcha"), _worktree(tmp_path, "Orcha-agent")
    gdir.mkdir()
    (gdir / "notifier-cid-1.pid").write_text(f"77777\n{wt_a}")
    killed, spawned = [], []
    monkeypatch.setattr(notifier, "_pid_alive",
                        lambda pid: pid == 77777 and 77777 not in killed)
    monkeypatch.setattr(notifier.os, "kill", lambda pid, sig: killed.append(pid))
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/orcha")

    class FakePopen:
        def __init__(self, *a, **k):
            self.pid = 4242
            spawned.append(a)

    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    assert notifier.ensure_daemon(wt_b, quiet=True, restart=True) is True
    assert 77777 in killed  # the other worktree's daemon was stopped
    assert spawned          # then a fresh one spawned


def test_ensure_daemon_yields_to_inflight_concurrent_claim(monkeypatch, tmp_path):
    """[P1] An EMPTY fresh claim = another --ensure between its O_EXCL create and pid
    write — yield (no spawn), don't treat it as stale and steal it."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt = _worktree(tmp_path, "Orcha")
    gdir.mkdir()
    (gdir / "notifier-cid-1.pid").write_text("")     # fresh + unparseable: in-flight claimer
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: False)
    spawned = []
    monkeypatch.setattr(notifier.subprocess, "Popen",
                        lambda *a, **k: spawned.append(a))
    assert notifier.ensure_daemon(wt, quiet=True) is True   # satisfied — someone's starting it
    assert not spawned                                       # crucially: we did NOT also spawn
    assert (gdir / "notifier-cid-1.pid").exists()            # and did NOT steal their claim


def test_ensure_daemon_clears_lingering_unreadable_claim(monkeypatch, tmp_path):
    """[P1] An unparseable claim that is NOT fresh is debris (a claimer that died between
    create and write) — clear it and spawn."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt = _worktree(tmp_path, "Orcha")
    gdir.mkdir()
    claim = gdir / "notifier-cid-1.pid"
    claim.write_text("")
    notifier.os.utime(claim, (1, 1))                 # ancient mtime → lingering, not in-flight
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: pid == 4242)
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/orcha")
    spawned = []

    class FakePopen:
        def __init__(self, *a, **k):
            self.pid = 4242
            spawned.append(a)

    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    assert notifier.ensure_daemon(wt, quiet=True) is True
    assert spawned
    assert claim.read_text().splitlines()[0] == "4242"


def test_ensure_daemon_releases_claim_on_spawn_failure(monkeypatch, tmp_path):
    """[P1] The claim is taken BEFORE Popen; a failed spawn must release it, or every
    later --ensure sees a live claimant (this parent) and the daemon never starts."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt = _worktree(tmp_path, "Orcha")
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/orcha")

    def boom(*a, **k):
        raise OSError("no exec")

    monkeypatch.setattr(notifier.subprocess, "Popen", boom)
    assert notifier.ensure_daemon(wt, quiet=True) is False
    assert not (gdir / "notifier-cid-1.pid").exists()        # claim released


def test_claim_container_atomic_single_winner(monkeypatch, tmp_path):
    """[P1] Two claimers racing the same container: exactly ONE wins the O_EXCL create;
    the loser sees the winner's live provisional pid and yields."""
    _patch_global_pid_dir(monkeypatch, tmp_path)
    # #276 rework: `_claim_container` now vets the existing claimant via `_daemon_pid_live` (not
    # bare `_pid_alive`) — without this mock the real `_ps_inspect` would see the pytest process
    # (not a "notifier") on our own pid and reject it as foreign, so the loser would wrongly re-win.
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: pid == notifier.os.getpid())
    monkeypatch.setattr(notifier, "_daemon_pid_live", lambda pid, cid=None: pid == notifier.os.getpid())
    won1, holder1 = notifier._claim_container("cid-1")
    assert won1 is True and holder1 is None                  # first claimer wins
    won2, holder2 = notifier._claim_container("cid-1")
    assert won2 is False                                     # second claimer loses...
    assert holder2 == (notifier.os.getpid(), "")             # ...to the live provisional claimant


def test_stop_daemon_clears_container_claim(monkeypatch, tmp_path):
    """Stopping the daemon drops the container claim so a follow-up --ensure can spawn."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt = _worktree(tmp_path, "Orcha")
    (wt / ".claude" / ".orcha-notifier.pid").write_text("88888")
    gdir.mkdir()
    (gdir / "notifier-cid-1.pid").write_text(f"88888\n{wt}")
    killed = []
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: pid == 88888 and 88888 not in killed)
    monkeypatch.setattr(notifier.os, "kill", lambda pid, sig: killed.append(pid))
    assert notifier.stop_daemon(wt, quiet=True) is True
    assert not (gdir / "notifier-cid-1.pid").exists()


def test_ensure_daemon_refuses_missing_container_before_claiming(monkeypatch, tmp_path):
    """[P2 #224 review] the MANAGED path (--ensure) must refuse a definitively-missing
    container BEFORE writing any pidfile/claim — not return success with a pidfile + claim
    pointing at a child that immediately refused, burying the error in the daemon log."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt = _worktree(tmp_path, "Orcha")
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "missing")
    spawned = []
    monkeypatch.setattr(notifier.subprocess, "Popen",
                        lambda *a, **k: spawned.append(a))
    assert notifier.ensure_daemon(wt, quiet=True) is False       # refused, loudly via stderr
    assert not spawned                                           # no child
    assert not (gdir / "notifier-cid-1.pid").exists()            # no container claim
    assert not (wt / ".claude" / ".orcha-notifier.pid").exists() # no per-cwd pidfile


def test_ensure_daemon_proceeds_when_api_unreachable(monkeypatch, tmp_path):
    """[P2 #224 review] a merely-unreachable API (orcha up still booting) must NOT block
    --ensure — the child daemon re-probes with retries; only a definitive 404 refuses."""
    _patch_global_pid_dir(monkeypatch, tmp_path)
    wt = _worktree(tmp_path, "Orcha")
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "unreachable")
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/orcha")
    spawned = []

    class FakePopen:
        def __init__(self, *a, **k):
            self.pid = 4242
            spawned.append(a)

    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    assert notifier.ensure_daemon(wt, quiet=True) is True
    assert spawned                                               # boot race tolerated


def test_probe_container_distinguishes_missing_from_unreachable(monkeypatch):
    """[#218 hardening] only a definitive HTTP 404 is 'missing'; a dead/booting API is
    'unreachable' (tolerated); any 2xx (and other HTTP errors — API alive) is 'ok'."""
    import urllib.error, io

    def _mk(exc=None):
        def _urlopen(url, timeout=None):
            if exc:
                raise exc
            class _R:
                def __enter__(self): return self
                def __exit__(self, *a): return False
                def read(self): return b"{}"
            return _R()
        return _urlopen

    monkeypatch.setattr(notifier.urllib.request, "urlopen", _mk())
    assert notifier._probe_container("http://x", "cid") == "ok"
    monkeypatch.setattr(notifier.urllib.request, "urlopen",
                        _mk(urllib.error.HTTPError("u", 404, "nf", {}, io.BytesIO())))
    assert notifier._probe_container("http://x", "cid") == "missing"
    monkeypatch.setattr(notifier.urllib.request, "urlopen",
                        _mk(urllib.error.HTTPError("u", 500, "ise", {}, io.BytesIO())))
    assert notifier._probe_container("http://x", "cid") == "ok"      # API alive — don't refuse
    monkeypatch.setattr(notifier.urllib.request, "urlopen",
                        _mk(urllib.error.URLError("refused")))
    assert notifier._probe_container("http://x", "cid") == "unreachable"


def test_daemon_refuses_to_start_for_missing_container(monkeypatch, tmp_path):
    """[#218 hardening] a daemon whose container 404s at its API exits loudly instead of
    becoming a permanent no-op that looks alive in ps (stale-orcha.json postmortem)."""
    import argparse
    monkeypatch.setattr(notifier.pathlib.Path, "cwd", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(notifier, "_api_and_cid", lambda cwd, api, cid: ("http://x", "ghost-cid"))
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "missing")
    args = argparse.Namespace(ensure=False, once=False, api_base=None, container=None,
                              dry_run=False, cooldown=15.0, min_idle=30.0, quiet=True,
                              lease_ttl=1200.0, interval=2.0)
    with pytest.raises(SystemExit) as e:
        notifier.cmd_notifier(args)
    assert "does not exist" in str(e.value)
    assert not (tmp_path / ".claude" / ".orcha-notifier.pid").exists()   # refused BEFORE claiming


def test_stop_daemon_stops_cross_worktree_daemon(monkeypatch, tmp_path):
    """[P2 #218] `orcha down` from worktree B (no LOCAL pidfile) must still stop a daemon
    started from worktree A — found via the container-global claim. Left alive it polls a
    stack that is going away, and its live claim blocks --ensure after `down -v && up`.

    ISS-22: stop_daemon now BLOCKS until the daemon actually exits (it used to SIGTERM and
    return immediately). Model the daemon dying on SIGTERM (`77777 not in killed`) so the
    bounded wait observes the exit and returns after a single SIGTERM — no SIGKILL escalation."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt_a, wt_b = _worktree(tmp_path, "Orcha"), _worktree(tmp_path, "Orcha-agent")
    gdir.mkdir()
    (gdir / "notifier-cid-1.pid").write_text(f"77777\n{wt_a}")   # A's daemon, alive
    killed = []
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: pid == 77777 and 77777 not in killed)
    monkeypatch.setattr(notifier.os, "kill", lambda pid, sig: killed.append(pid))
    assert notifier.stop_daemon(wt_b, quiet=True) is True        # B has NO per-cwd pidfile
    assert killed == [77777], "the A-started daemon must be SIGTERMed exactly once (it exits, no SIGKILL)"
    assert not (gdir / "notifier-cid-1.pid").exists()            # claim cleared


def test_stop_daemon_clears_stale_claim_without_kill(monkeypatch, tmp_path):
    """[P2 #218] A claim naming a DEAD pid is debris: stop_daemon clears it (so it can't
    confuse a later --ensure) but reports nothing-was-stopped and kills nothing."""
    gdir = _patch_global_pid_dir(monkeypatch, tmp_path)
    wt = _worktree(tmp_path, "Orcha")
    gdir.mkdir()
    (gdir / "notifier-cid-1.pid").write_text("66666\n/gone")     # dead daemon's claim
    killed = []
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(notifier.os, "kill", lambda pid, sig: killed.append(pid))
    assert notifier.stop_daemon(wt, quiet=True) is False         # nothing live to stop
    assert killed == []
    assert not (gdir / "notifier-cid-1.pid").exists()            # debris cleaned


@pytest.mark.asyncio
async def test_terminal_config_exposes_ws_url(client):
    """S3 §3b: the frontend discovers the host-side PTY bridge URL here (not location.host)."""
    r = await client.get("/api/terminal/config")
    assert r.status_code == 200, r.text
    assert r.json()["ws_url"].startswith("ws")
