"""GH #72 — a drain turn must never swallow a request-answered event that unblocks the recipient's
own task work.

The bug: when an answer (e.g. a plan-review "CLEAN") arrives while a short-lived "drain"/sidecar body
is alive, that body is (correctly) forbidden from starting task work — but it still ADVANCES the wake
cursor past the answer and/or auto-closes the request. That erases the only "unhandled" trigger, so
after the live body exits NO fresh worker ever spawns to do the unblocked work. The loop goes silent
on a green light (timing-dependent: it only strikes when a body happened to be alive).

The fix (Option A — park the cursor; Code Reviewer-CLEAN): an "actionable" answer — a
`request_answered`/`request_closed` whose request is a `task` and this agent is the original
REQUESTER, OR an event carrying `originating_task_id` — is EXEMPT from the $0 drain paths:
  - wake_scan attaches NO #288/#307 suppression hint for it (→ a real worker full-boots), and
  - active_conversations PARKS the resident drain sidecar's cursor strictly BEFORE it (→ it stays
    pending and the post-exit wake gate spawns a real worker), reporting `drainable_inbox` so the
    daemon skips a sidecar that would drain nothing.

Each test below BITES: reverting the corresponding guard flips an assertion red. (NB: distinct from
the internal ISS-72 interrupt-stop work in test_iss72_interrupt_stop.py — this is GitHub issue #72.)
"""
import io
import json
import pathlib
import re
import sys
import uuid

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import notifier  # noqa: E402
import main  # noqa: E402


# ===========================================================================================
# helpers
# ===========================================================================================
_TASK = {"title": "review my plan", "definition_of_done": "reply CLEAN or NEEDS CHANGES"}


async def _answer_request(client, req_id, responder_id, response="CLEAN — sound to implement"):
    r = await client.post(f"/api/requests/{req_id}/respond",
                          json={"responder_agent_id": responder_id, "response": response})
    assert r.status_code == 200, r.text
    return r


async def _scan_cand(client, cid, aid, *, cooldown=0, min_idle=0):
    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": cooldown, "min_idle": min_idle})
    assert r.status_code == 200, r.text
    body = r.json()
    return body, next((c for c in body["candidates"] if c["agent_id"] == aid), None)


async def _open_conversation(client, db, cid, aid, started_by):
    return db.execute(
        "INSERT INTO conversations (container_id, agent_id, started_by) VALUES (%s,%s,%s) RETURNING id",
        (cid, aid, started_by))[0]["id"]


async def _active_cand(client, cid, conv_id):
    r = await client.get(f"/api/containers/{cid}/active-conversations")
    assert r.status_code == 200, r.text
    return next((c for c in r.json()["conversations"]
                 if c["conversation_id"] == str(conv_id)), None)


# ===========================================================================================
# (1) wake_scan: a task-request answer is EXEMPT from #288/#307 suppression — a real worker spawns
# ===========================================================================================

@pytest.mark.asyncio
async def test_wakescan_exempts_actionable_task_answer_from_suppression(
        client, container, make_agent, make_request):
    """A requester whose SOLE pending event is an answer to its own TASK request gets NO triage_hint
    (so decide_wake_tier returns 'full' → a real worker boots), and is flagged actionable. A plain
    INFO answer in the same scan STILL carries a hint (the exemption is scoped, not a blanket).

    TEETH: drop `and actionable_answer_ts is None` from wake_scan's triage_hint guard and the task
    asker's hint comes back tier='llm' → the `triage_hint is None` assert goes red."""
    asker_task = await make_agent("PlanAsker")
    asker_info = await make_agent("InfoAsker")
    teller = await make_agent("Reviewer")
    # a TASK request (no originating_task_id) — the novel exemption branch
    rt = await make_request(asker_task["agent_id"], "review my plan", target_alias="Reviewer",
                            type="task", task=_TASK)
    await _answer_request(client, rt["id"], teller["agent_id"])
    # a plain INFO request — the control (still suppressible)
    ri = await make_request(asker_info["agent_id"], "what's the status?", target_alias="Reviewer")
    await _answer_request(client, ri["id"], teller["agent_id"], response="all good, thanks")

    _, ct = await _scan_cand(client, container["id"], asker_task["agent_id"])
    assert ct is not None and ct["should_wake"] is True
    assert ct["pending_events"] == 1 and ct["latest_event"] == "request_answered"
    assert ct["actionable_answer_pending"] is True
    assert ct["triage_hint"] is None        # EXEMPT — a real worker must act on the CLEAN, not a drain

    _, ci = await _scan_cand(client, container["id"], asker_info["agent_id"])
    assert ci is not None and ci["actionable_answer_pending"] is False
    assert ci["triage_hint"] is not None and ci["triage_hint"]["tier"] == "llm"   # scope: info still suppressible


@pytest.mark.asyncio
async def test_wakescan_actionable_via_originating_task_id(
        client, container, make_agent, make_request, make_task):
    """The OR-signal: an INFO answer that carries an `originating_task_id` is ALSO actionable (the
    answer's wake is meant to resume that task)."""
    asker = await make_agent("Asker2")
    teller = await make_agent("Teller2")
    t = await make_task("my work", "done", assignee_alias="Asker2")    # asker participates
    req = await make_request(asker["agent_id"], "quick q on my task", target_alias="Teller2",
                             originating_task_id=t["id"])
    await _answer_request(client, req["id"], teller["agent_id"], response="here you go")

    _, c = await _scan_cand(client, container["id"], asker["agent_id"])
    assert c is not None and c["actionable_answer_pending"] is True


# ===========================================================================================
# (2) tick(): the repro — a pure-ack-looking TASK answer SPAWNS a real worker, not a drain-close
# ===========================================================================================

@pytest.mark.asyncio
async def test_tick_spawns_real_worker_for_task_answer_instead_of_suppressing(
        client, container, make_agent, make_request, db, monkeypatch):
    """REPRO (Code Reviewer must-address a): even when the answer text reads like a pure ack (triage
    would say wake=False), an answer to THIS agent's own task request must SPAWN a real worker after
    the live body exits — NOT be auto-closed/drained away. Drives the real wake-scan, then runs tick()
    with the triage fn forced to 'pure ack'.

    TEETH: revert the wake_scan exemption and tick suppresses instead — spawn_headless is never
    called and a /triage-close is POSTed → both asserts below flip red."""
    asker = await make_agent("LoopDriver")
    reviewer = await make_agent("Reviewer3")
    req = await make_request(asker["agent_id"], "review my plan", target_alias="Reviewer3",
                             type="task", task=_TASK)
    await _answer_request(client, req["id"], reviewer["agent_id"], response="thanks!")

    # Capture the REAL wake-scan the daemon would read, then feed it to tick via _get_json.
    scan = (await client.get(f"/api/containers/{container['id']}/wake-scan",
                             params={"cooldown": 0, "min_idle": 0})).json()

    posts = []

    def _get(url, **k):
        return scan if "wake-scan" in url else None

    def _post(url, body, **k):
        posts.append((url, body))
        return {"claimed": True} if "wake-claim" in url else {}

    spawns = []

    class _Proc:
        pid = 4321

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawns.append((a, k)) or (True, "claude -p", _Proc()))
    # Force the triage verdict to a PURE ACK — without the fix this is what would suppress the answer.
    monkeypatch.setattr(notifier, "_triage_wake",
                        lambda *a, **k: {"wake": False, "reason": "pure ack"})

    notifier.tick("http://x", container["id"], dry_run=False, cooldown=0, min_idle=0, quiet=True)

    asker_spawns = [s for s in spawns if s[1].get("alias") == "LoopDriver"]
    assert len(asker_spawns) == 1, "a real worker must SPAWN for the asker's unblocking task answer"
    assert not any("triage-close" in u for u, _ in posts), "the unblocking answer must NOT be auto-closed"
    # nothing was drain-suppressed: every wake-ack is a real delivery, never a 'skipped' drain ack
    assert not any(b.get("kind") == "skipped" for u, b in posts if u.endswith("/wake-ack"))
    # the request is left ANSWERED for the spawned worker to act on (never drain-closed)
    assert db.execute("SELECT status FROM requests WHERE id=%s", (req["id"],))[0]["status"] == "answered"


# ===========================================================================================
# (3)(4) active_conversations: park the resident drain sidecar's cursor before an actionable answer
# ===========================================================================================

@pytest.mark.asyncio
async def test_active_conversations_parks_cursor_when_only_answer_pending(
        client, container, make_agent, make_request, db):
    """A warm resident whose SOLE queued inbox event is an answer to its own task request: nothing is
    safely drainable (drainable_inbox==0) and the cursor is NOT advanced (inbox_ack_ts is None) — so
    the daemon skips a no-op sidecar and the trigger survives for the post-exit ephemeral wake.

    TEETH: revert the active_conversations clamp and inbox_ack_ts jumps to the answer's ts with
    drainable_inbox==1 → both asserts flip red."""
    human = await make_agent("KedarG", "human", kind="human")
    asker = await make_agent("ResAsker")
    reviewer = await make_agent("ResReviewer")
    conv = await _open_conversation(client, db, container["id"], asker["agent_id"], human["agent_id"])
    req = await make_request(asker["agent_id"], "review my plan", target_alias="ResReviewer",
                             type="task", task=_TASK)
    await _answer_request(client, req["id"], reviewer["agent_id"])

    c = await _active_cand(client, container["id"], conv)
    assert c is not None
    assert c["pending_inbox"] == 1                # the answer IS queued for the resident
    assert c["drainable_inbox"] == 0             # ...but nothing is safe for a (task-forbidden) sidecar
    assert c["inbox_ack_ts"] is None            # so the cursor never advances past the answer


@pytest.mark.asyncio
async def test_active_conversations_drains_before_answer_but_parks_it(
        client, container, make_agent, make_request, db):
    """A MIX: a directed message queued BEFORE an actionable answer. The sidecar may drain the message
    (drainable_inbox==1) but must PARK the cursor at the message's ts — strictly before the answer —
    never advancing past the answer."""
    human = await make_agent("KedarG2", "human", kind="human")
    asker = await make_agent("MixAsker")
    reviewer = await make_agent("MixReviewer")
    conv = await _open_conversation(client, db, container["id"], asker["agent_id"], human["agent_id"])
    req = await make_request(asker["agent_id"], "review my plan", target_alias="MixReviewer",
                             type="task", task=_TASK)
    await _answer_request(client, req["id"], reviewer["agent_id"])
    # the answer event's ts → drop a directed 'prompt' message strictly BEFORE it
    answer_ts = db.execute(
        "SELECT max(ts) AS mx FROM agent_events WHERE event_key=%s AND event_name='request_answered'",
        (asker["agent_id"],))[0]["mx"]
    msg_ts = answer_ts - 5.0
    db.execute(
        """INSERT INTO agent_events (container_id, target_id, event_key, event_name, ts, payload)
           VALUES (%s,%s,%s,'prompt',%s,%s::jsonb)""",
        (container["id"], asker["agent_id"], asker["agent_id"], msg_ts,
         json.dumps({"message": "heads up: rebase first"})))

    c = await _active_cand(client, container["id"], conv)
    assert c is not None
    assert c["pending_inbox"] == 2               # the prompt + the answer
    assert c["drainable_inbox"] == 1            # only the prompt is safe to drain
    assert c["inbox_ack_ts"] == msg_ts          # parked AT the prompt — strictly before the answer
    assert c["inbox_ack_ts"] < answer_ts


# ===========================================================================================
# (5)(6) notifier service_residents: skip a no-op sidecar; still drain a real backlog (parked)
# ===========================================================================================

class _ResProc:
    def __init__(self, pid=4321):
        self.pid = pid
        self.returncode = None
        self.stdin = io.BytesIO()
        self.killed = False

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


def _wire_resident_drain(monkeypatch, active):
    posts, sigs = [], []

    def _get(url, **k):
        return {"conversations": active} if "active-conversations" in url else None

    def _post(url, body, **k):
        posts.append((url, body))
        if url.endswith("/wake-renew"):
            return {"renewed": True, "lease_kind": "resident", "preempt_requested": False}
        return {}

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "PERSONA")
    monkeypatch.setattr(notifier.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(notifier.os, "killpg", lambda pgid, sig: sigs.append((pgid, sig)))
    monkeypatch.setattr(notifier, "_RESIDENT_DRAIN_YIELD", {})
    return posts, sigs


def _live_resident(tmp_path, proc):
    import time
    return {"C1": {"proc": proc, "agent_id": "A1", "conversation_id": "C1", "alias": "Vox",
                   "log_path": tmp_path / "c.ndjson", "session_id": "sess-9", "session_pinned": True,
                   "cold": False, "serviced_seq": 2, "current_run_id": None, "run_id": None,
                   "awaiting_result": False, "turn_scan_offset": 0, "base_cwd": str(tmp_path),
                   "lines_offset": 0, "lines_buf": b"", "lines_seq": 1, "last_activity_ts": time.time()}}


def test_resident_drain_skips_sidecar_when_only_answer_pending(monkeypatch, tmp_path):
    """#72 idempotency / anti-infinite-loop (Code Reviewer must-address b): an idle warm resident whose
    only queued event is an unblocking answer (drainable_inbox==0) spawns NO drain sidecar — draining
    nothing would be a per-tick thrash and would risk acking the trigger away. The lease is kept and
    the answer waits for the post-exit ephemeral wake.

    TEETH: revert the notifier gate (`drainable > 0` → `inbox > 0`) and a sidecar IS spawned for a
    zero-drainable inbox → `len(spawns)==0` flips red."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 1, "drainable_inbox": 0, "inbox_ack_ts": None, "inbox_messages": []}
    posts, sigs = _wire_resident_drain(monkeypatch, [conv])
    spawns = []
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawns.append((a, k)) or (True, "repr", _ResProc(pid=9999)))
    proc = _ResProc()
    live = _live_resident(tmp_path, proc)

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path), quiet=True)

    assert spawns == []                         # NO sidecar — nothing safe to drain
    assert "C1" in live and proc.killed is False   # warm resident + lease KEPT
    assert not sigs                             # not yielded/torn down
    assert not any("/wake-ack" in u for u, _ in posts)   # lease never released on this account


def test_resident_drain_sidecar_parks_before_answer_on_mix(monkeypatch, tmp_path):
    """Regression: a real drainable backlog ahead of an actionable answer STILL spawns a sidecar, and
    it parks the cursor at the server-clamped `inbox_ack_ts` (strictly before the answer)."""
    conv = {"conversation_id": "C1", "agent_id": "A1", "agent_alias": "Vox",
            "session_id": "sess-9", "pending_human": False, "last_turn_seq": 2,
            "pending_inbox": 2, "drainable_inbox": 1, "inbox_ack_ts": 30.0,
            "model": "claude-opus-4-8",
            "inbox_messages": ["[task-thread message on task T-7] rebase first — RESPOND on it"]}
    posts, sigs = _wire_resident_drain(monkeypatch, [conv])
    sidecar = _ResProc(pid=9999)
    spawns = []
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawns.append((a, k)) or (True, "repr", sidecar))
    proc = _ResProc()
    live = _live_resident(tmp_path, proc)

    notifier.service_residents("http://x", "cid", live, base_cwd=str(tmp_path), quiet=True)

    assert len(spawns) == 1                              # the drainable backlog IS drained
    assert "C1" in live and proc.killed is False         # warm resident + lease KEPT
    assert live["C1"]["sidecar"]["ack_ts"] == 30.0      # parked at the clamp — before the answer
