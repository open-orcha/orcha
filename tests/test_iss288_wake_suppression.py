"""#288 — wake-suppression for no-action events.

The cost of a wake is the ephemeral subprocess SPAWN, not the poll. A no-action wake (a bare
terminal/FYI event, or a pure-ack answer) must NOT spawn a worker — it should be suppressed and
(for an answered request) auto-closed. Resident/tmux wakes are cheap and are NEVER gated.

The decision splits across two PURE, fail-open seams plus the plumbing that feeds them:
  - main._triage_hint_for      — classifies a single pending event into a suppression hint (server).
  - notifier.decide_wake_suppression — given a hint + a triage_fn, decides suppress-vs-wake (daemon).
  - GET /wake-scan             — attaches the hint ONLY when the sole pending signal is one event.
  - POST /requests/{rid}/triage-close — system-actor auto-close of a pure-ack answered request.

Helm's NON-NEGOTIABLE teeth (each has a test below that BITES):
  (1) a BARE FYI                          -> skip (structural, no LLM)
  (2) the SAME FYI type WITH a human note -> wakes (bareness rule: triage the note, fail-open)
  (3) request_answered pure-ack           -> triage-close + skip
  (4) request_answered with follow-up     -> wakes
  (5) triage_wake error                   -> fail-open wakes

Committed-isolation harness (see test_wake.py): wake-scan reads committed rows from the shared
autocommit connection; we drive non-API state through the `db` fixture.
"""
import pathlib
import sys
import uuid

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import notifier  # noqa: E402
import main  # noqa: E402


# ===========================================================================================
# decide_wake_suppression — the daemon's PURE fail-open decision (teeth 1,3,4,5)
# ===========================================================================================

def _cand(hint):
    return {"agent_id": str(uuid.uuid4()), "alias": "X", "triage_hint": hint}


def test_no_hint_always_wakes():
    """No triage_hint (the common case + the whole bypass set) -> wake (None)."""
    assert notifier.decide_wake_suppression(_cand(None)) is None
    assert notifier.decide_wake_suppression({"alias": "X"}) is None


def test_structural_bare_fyi_suppresses_without_calling_llm():
    """TOOTH 1: a bare structural FYI suppresses deterministically — triage_fn is NEVER called."""
    calls = []
    def boom(_text):  # must not run for a structural hint
        calls.append(_text)
        raise AssertionError("triage_fn called for a structural (bare) hint")
    hint = {"tier": "structural", "event_name": "request_closed", "request_id": None}
    out = notifier.decide_wake_suppression(_cand(hint), triage_fn=boom)
    assert out is not None and out["tier"] == "structural"
    assert out["request_id"] is None
    assert calls == []


def test_llm_pure_ack_suppresses_and_carries_request_id():
    """TOOTH 3: request_answered pure-ack (triage wake=False) -> suppress, with the request_id so
    the caller can auto-close it."""
    rid = str(uuid.uuid4())
    hint = {"tier": "llm", "event_name": "request_answered", "request_id": rid, "text": "thanks!"}
    out = notifier.decide_wake_suppression(
        _cand(hint), triage_fn=lambda t: {"wake": False, "reason": "pure ack"})
    assert out is not None and out["tier"] == "llm"
    assert out["request_id"] == rid
    assert out["reason"] == "pure ack"


def test_llm_followup_wakes():
    """TOOTH 4: an answer that triage says is a real follow-up (wake=True) -> wake (None)."""
    hint = {"tier": "llm", "event_name": "request_answered", "request_id": "r", "text": "now do Y"}
    out = notifier.decide_wake_suppression(
        _cand(hint), triage_fn=lambda t: {"wake": True, "reason": "actionable"})
    assert out is None


def test_llm_error_fails_open_to_wake():
    """TOOTH 5: any triage exception -> fail-open wake (None). A flaky LLM can NEVER suppress."""
    def boom(_t):
        raise RuntimeError("timeout")
    hint = {"tier": "llm", "event_name": "request_answered", "request_id": "r", "text": "x"}
    assert notifier.decide_wake_suppression(_cand(hint), triage_fn=boom) is None


def test_llm_malformed_verdict_fails_open():
    """The bool(None) trap: a missing/null/non-bool `wake` is malformed -> wake (only explicit
    False suppresses)."""
    hint = {"tier": "llm", "event_name": "request_answered", "request_id": "r", "text": "x"}
    for verdict in ({}, {"wake": None}, {"wake": 0}, {"wake": "no"}, None, "nope"):
        assert notifier.decide_wake_suppression(_cand(hint), triage_fn=lambda t, v=verdict: v) is None


def test_unknown_tier_wakes():
    hint = {"tier": "weird", "event_name": "request_answered"}
    assert notifier.decide_wake_suppression(_cand(hint)) is None


# ===========================================================================================
# _triage_hint_for — server-side bareness classification (tooth 2 + the FYI truth table)
# ===========================================================================================

def test_hint_request_closed_is_bare_structural():
    h = main._triage_hint_for("request_closed", {"request_id": "r"})
    assert h["tier"] == "structural" and h["bare"] is True
    assert h["request_id"] is None   # already closed — nothing to auto-close


def test_hint_task_verified_approved_bare_structural():
    h = main._triage_hint_for("task_verified", {"approved": True})
    assert h["tier"] == "structural" and h["bare"] is True


def test_hint_task_verified_approved_with_note_is_llm():
    """TOOTH 2: the SAME FYI type WITH a human note flips to LLM triage — never a silent skip."""
    h = main._triage_hint_for("task_verified", {"approved": True, "feedback": "nice, ship a follow-up"})
    assert h["tier"] == "llm" and h["bare"] is False
    assert h["text"] == "nice, ship a follow-up"


def test_hint_task_verified_rejected_always_wakes():
    """A REJECTED verify (approved=False) is a rework signal — no hint, always wake."""
    assert main._triage_hint_for("task_verified", {"approved": False, "feedback": "fix X"}) is None
    assert main._triage_hint_for("task_verified", {"approved": False}) is None


def test_hint_suggestion_refuse_bare_structural():
    h = main._triage_hint_for("agent_suggestion_decided", {"kind": "refuse"})
    assert h["tier"] == "structural" and h["bare"] is True


def test_hint_suggestion_refuse_with_reason_is_llm():
    """TOOTH 2 (variant): a refuse carrying a human reason -> LLM triage, not a silent skip."""
    h = main._triage_hint_for("agent_suggestion_decided", {"kind": "refuse", "reason": "do it yourself"})
    assert h["tier"] == "llm" and h["text"] == "do it yourself"


def test_hint_suggestion_create_always_wakes():
    """create/reassign means a new agent/target now owns it — the requester should wake."""
    assert main._triage_hint_for("agent_suggestion_decided", {"kind": "create"}) is None
    assert main._triage_hint_for("agent_suggestion_decided", {"kind": "reassign"}) is None


def test_hint_request_answered_is_llm_with_request_id_and_text():
    h = main._triage_hint_for("request_answered", {"request_id": "r", "preview": "p"},
                              full_answer="the full answer text")
    assert h["tier"] == "llm" and h["request_id"] == "r"
    assert h["text"] == "the full answer text"          # prefers the full answer over the preview


def test_hint_request_answered_falls_back_to_preview():
    h = main._triage_hint_for("request_answered", {"request_id": "r", "preview": "p"})
    assert h["text"] == "p"


def test_hint_unknown_event_is_none():
    assert main._triage_hint_for("task_message", {"task_id": "t"}) is None
    assert main._triage_hint_for("request_created", {"type": "task"}) is None


# ===========================================================================================
# wake-scan plumbing — the hint is attached ONLY for a single FYI/answer signal
# ===========================================================================================

async def _scan_cand(client, cid, aid):
    r = await client.get(f"/api/containers/{cid}/wake-scan", params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    return next((c for c in r.json()["candidates"] if c["agent_id"] == aid), None)


@pytest.mark.asyncio
async def test_wakescan_attaches_llm_hint_for_lone_answer(client, container, make_agent, make_request):
    """A requester whose ONLY pending event is request_answered gets a tier='llm' hint carrying the
    originating request_id + the FULL answer text (not just the 120-char preview)."""
    a = await make_agent("Asker")
    b = await make_agent("Teller")
    req = await make_request(a["agent_id"], "what is the status?", target_alias="Teller")
    long_answer = "ack. " + ("x" * 300)
    rr = await client.post(f"/api/requests/{req['id']}/respond",
                           json={"responder_agent_id": b["agent_id"], "response": long_answer})
    assert rr.status_code == 200, rr.text

    cand = await _scan_cand(client, container["id"], a["agent_id"])
    assert cand["should_wake"] is True
    assert cand["latest_event"] == "request_answered"
    h = cand["triage_hint"]
    assert h is not None and h["tier"] == "llm"
    assert h["request_id"] == req["id"]
    assert h["text"] == long_answer                      # full answer, > 120 chars


@pytest.mark.asyncio
async def test_wakescan_no_hint_when_a_ready_task_is_also_pending(
        client, container, make_agent, make_request, make_task, db):
    """BYPASS: an assigned-READY task alongside the answer -> NO hint (real work present, always
    wake). We force the task to 'ready' and advance the cursor past its task_assigned event so the
    ONLY fresh event is the answer — isolating the auto_tasks guard (not the multi-event guard)."""
    a = await make_agent("Asker")
    b = await make_agent("Teller")
    t = await make_task("real work", "done", assignee_alias="Asker")   # in_progress + task_assigned
    db.execute("UPDATE tasks SET status='ready' WHERE id=%s", (t["id"],))
    # advance Asker's wake cursor to NOW so the earlier task_assigned event is already delivered
    db.execute("INSERT INTO agent_wake_state (agent_id, delivered_ts) "
               "VALUES (%s, extract(epoch from now())) "
               "ON CONFLICT (agent_id) DO UPDATE SET delivered_ts=EXCLUDED.delivered_ts",
               (a["agent_id"],))
    req = await make_request(a["agent_id"], "q", target_alias="Teller")
    await client.post(f"/api/requests/{req['id']}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "ok"})

    cand = await _scan_cand(client, container["id"], a["agent_id"])
    assert cand["pending_events"] == 1                   # only the fresh request_answered
    assert t["id"] in cand["auto_start_task_ids"]        # a ready task is present
    assert cand["triage_hint"] is None                  # so no suppression hint


@pytest.mark.asyncio
async def test_wakescan_no_hint_when_multiple_events_pending(
        client, container, make_agent, make_request):
    """BYPASS: >1 pending event -> NO hint. wake-scan exposes only the LATEST name, so a second
    event might hide actionable work; be conservative and always wake."""
    a = await make_agent("Asker")
    b = await make_agent("Teller")
    # two answered asks -> two request_answered events pending for Asker
    for q in ("q1", "q2"):
        req = await make_request(a["agent_id"], q, target_alias="Teller")
        await client.post(f"/api/requests/{req['id']}/respond",
                          json={"responder_agent_id": b["agent_id"], "response": "ok"})

    cand = await _scan_cand(client, container["id"], a["agent_id"])
    assert cand["pending_events"] == 2
    assert cand["triage_hint"] is None


@pytest.mark.asyncio
async def test_wakescan_approval_with_note_carries_feedback_end_to_end(
        client, container, make_agent, make_task, db):
    """ROUTE-LEVEL TOOTH (Gate 2nd-pass: the approval EMIT dropped the note). #288 non-negotiable:
    a human /verify APPROVE that carries a note must never be suppressed. This drives the real
    route — POST /api/tasks/{tid}/verify {approve:true, feedback:...} — then runs wake-scan over the
    assignee's resulting SOLE pending event and asserts the triage_hint is tier='llm' carrying the
    note text (not a bare structural skip). The helper-only tooth above
    (test_hint_task_verified_approved_with_note_is_llm) classifies a synthetic payload; this one
    proves the route actually PUTS the feedback into the task_verified event payload.

    MUTATION: drop `feedback` from the approval branch's _publish_event payload (main.py ~3973) and
    the emitted event has no feedback -> _triage_hint_for sees it bare -> tier='structural'/bare=True
    -> the tier=='llm' / text==note asserts go RED. Restored -> GREEN."""
    worker = await make_agent("Worker")
    human = await make_agent("Boss", kind="human")
    t = await make_task("ship it", "shipped", assignee_alias="Worker")
    # Drive to needs_verification (the assignee would normally /done it).
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (t["id"],))
    db.execute("UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s", (t["id"],))
    # Advance Worker's wake cursor to NOW so the earlier task_assigned event is already delivered and
    # the ONLY fresh event after the verify is task_verified (the narrow single-signal hint window).
    db.execute("INSERT INTO agent_wake_state (agent_id, delivered_ts) "
               "VALUES (%s, extract(epoch from now())) "
               "ON CONFLICT (agent_id) DO UPDATE SET delivered_ts=EXCLUDED.delivered_ts",
               (worker["agent_id"],))

    note = "approved — now also wire the follow-up X before closing out"
    rv = await client.post(f"/api/tasks/{t['id']}/verify",
                           json={"approve": True, "feedback": note,
                                 "actor_agent_id": human["agent_id"]})
    assert rv.status_code == 200, rv.text

    cand = await _scan_cand(client, container["id"], worker["agent_id"])
    assert cand is not None
    assert cand["pending_events"] == 1                    # only the fresh task_verified
    assert cand["latest_event"] == "task_verified"
    h = cand["triage_hint"]
    assert h is not None and h["tier"] == "llm" and h["bare"] is False
    assert h["text"] == note                              # the human note survived the route emit


# ===========================================================================================
# POST /requests/{rid}/triage-close — system-actor auto-close + #289 stamp
# ===========================================================================================

@pytest.mark.asyncio
async def test_triage_close_closes_answered_request_as_system(
        client, container, make_agent, make_request, db):
    a = await make_agent("Asker")
    b = await make_agent("Teller")
    req = await make_request(a["agent_id"], "q", target_alias="Teller")
    await client.post(f"/api/requests/{req['id']}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "thanks"})

    r = await client.post(f"/api/requests/{req['id']}/triage-close",
                          json={"triage_reason": "pure ack"})
    assert r.status_code == 200, r.text
    assert r.json()["auto"] is True

    # request is closed
    row = db.execute("SELECT status FROM requests WHERE id=%s", (req["id"],))[0]
    assert row["status"] == "closed"

    # audit row records actor_type='system' (NOT the requester/answerer — #271) + the #289 stamp
    ev = db.execute(
        "SELECT actor_type, actor_id, detail FROM events "
        "WHERE entity_id=%s AND event_type='closed' ORDER BY created_at DESC LIMIT 1",
        (req["id"],))[0]
    assert ev["actor_type"] == "system" and ev["actor_id"] is None
    assert ev["detail"]["auto"] is True and ev["detail"]["reason"] == "triage_skip"
    assert ev["detail"]["triage_reason"] == "pure ack"

    # the request_closed agent_event carries the same auto stamp for #289 measurability
    aev = db.execute(
        "SELECT payload FROM agent_events WHERE event_name='request_closed' "
        "AND event_key=%s ORDER BY ts DESC LIMIT 1", (b["agent_id"],))[0]
    assert aev["payload"]["auto"] is True
    assert aev["payload"]["reason"] == "triage_skip"


@pytest.mark.asyncio
async def test_triage_close_refuses_open_request(client, container, make_agent, make_request):
    """It closes ONLY a pure-ack ANSWERED request — an OPEN request is refused (409). This is the
    state gate that stops it being abused to force-close arbitrary requests."""
    a = await make_agent("Asker")
    await make_agent("Teller")
    req = await make_request(a["agent_id"], "q", target_alias="Teller")   # stays open (unanswered)
    r = await client.post(f"/api/requests/{req['id']}/triage-close", json={"triage_reason": "x"})
    assert r.status_code == 409, r.text


@pytest.mark.asyncio
async def test_triage_close_idempotent_on_closed(client, container, make_agent, make_request):
    a = await make_agent("Asker")
    b = await make_agent("Teller")
    req = await make_request(a["agent_id"], "q", target_alias="Teller")
    await client.post(f"/api/requests/{req['id']}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "ok"})
    r1 = await client.post(f"/api/requests/{req['id']}/triage-close", json={"triage_reason": "a"})
    assert r1.status_code == 200
    r2 = await client.post(f"/api/requests/{req['id']}/triage-close", json={"triage_reason": "b"})
    assert r2.status_code == 200 and r2.json().get("already_closed") is True


# ===========================================================================================
# _suppress_wake — the daemon applies a suppression (triage-close + cursor advance, NO spawn)
# ===========================================================================================

def test_suppress_wake_posts_triage_close_and_acks(monkeypatch):
    """Tier-1 suppression: POST triage-close for the request_id, then advance the cursor via
    wake-ack(kind='skipped'). No spawn is involved (this function never spawns)."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **kw: posts.append((url, body)) or {})
    cand = {"agent_id": "agent-1", "alias": "X", "ack_through_ts": 123.0, "max_event_ts": 999.0}
    notifier._suppress_wake("http://api", cand, "request_answered",
                            {"tier": "llm", "reason": "pure ack", "request_id": "req-9"}, quiet=True)
    urls = [u for u, _ in posts]
    assert "http://api/api/requests/req-9/triage-close" in urls
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "skipped"
    assert ack["delivered_ts"] == 123.0                  # prefers ack_through_ts
    assert ack["release_lease"] is False


def test_suppress_wake_structural_skips_triage_close(monkeypatch):
    """Tier-0 structural suppression carries request_id=None -> NO triage-close, only the ack."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **kw: posts.append((url, body)) or {})
    cand = {"agent_id": "agent-1", "alias": "X", "ack_through_ts": None, "max_event_ts": 5.0}
    notifier._suppress_wake("http://api", cand, "request_closed",
                            {"tier": "structural", "reason": "bare request_closed", "request_id": None},
                            quiet=True)
    urls = [u for u, _ in posts]
    assert not any("triage-close" in u for u in urls)
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["delivered_ts"] == 5.0                    # falls back to max_event_ts


# ===========================================================================================
# tick() transport guard — D3: suppression is EPHEMERAL-SPAWN-ONLY (notifier.py:1733)
# A live tmux/resident pane is cheap to wake and must NEVER be suppressed, even when it
# carries a triage_hint that WOULD qualify an ephemeral spawn for suppression.
# ===========================================================================================

def test_tick_tmux_candidate_is_never_suppressed(monkeypatch):
    """TOOTH (Gate 2nd-pass gap): the #288 gate is `if kind == "ephemeral" and not dry_run`. Drop
    the `kind == "ephemeral"` clause and a suppressible-hint candidate on a LIVE tmux pane gets
    silently suppressed instead of woken. This test drives tick() with a tmux candidate whose hint
    is a bare structural FYI (which decide_wake_suppression WOULD suppress) and asserts:
      - send_tmux IS invoked (the pane is woken),
      - the suppression seam (decide_wake_suppression / _suppress_wake) is NEVER consulted,
      - no triage-close is posted.
    MUTATION: removing the `kind == "ephemeral"` clause makes tick call decide_wake_suppression for
    this tmux candidate -> the boom below raises -> RED. Restored -> the seam is skipped -> GREEN."""
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "B",
            "should_wake": True, "headless_cwd": None, "tmux_target": "orcha:B",
            "wake_enabled": True, "pending_events": 1, "auto_start_task_ids": [],
            "reason": "wake", "latest_event": "request_closed", "max_event_ts": 5.0,
            "headless_flags": None,
            # a hint decide_wake_suppression WOULD turn into a suppress verdict for an ephemeral spawn
            "triage_hint": {"tier": "structural", "event_name": "request_closed", "request_id": None}}
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"active": True, "candidates": [cand]})
    monkeypatch.setattr(notifier, "select_transport", lambda c: "tmux")

    def _boom_decide(*a, **k):
        raise AssertionError("decide_wake_suppression consulted for a tmux candidate — D3 violated")

    def _boom_suppress(*a, **k):
        raise AssertionError("_suppress_wake called for a tmux candidate — D3 violated")
    monkeypatch.setattr(notifier, "decide_wake_suppression", _boom_decide)
    monkeypatch.setattr(notifier, "_suppress_wake", _boom_suppress)
    sent_to = []
    monkeypatch.setattr(notifier, "send_tmux",
                        lambda target, prompt, dry_run: sent_to.append(target) or (True, "tmux-cmd"))
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})

    out = notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True)

    assert sent_to == ["orcha:B"]                         # the live pane WAS woken (not suppressed)
    assert out["woke"][0]["sent"] is True
    assert out["woke"][0]["kind"] == "tmux"
    assert not any("triage-close" in u for u, _ in posts)  # suppression path never entered
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "tmux"                          # delivered via tmux, not "skipped"
