"""#307 — graded wake: the cheapest sufficient substrate per wake event.

#288 already gives us T0 (structural skip) + T1 (cheap triage suppress) + T3 (full embodiment).
This adds the missing **T2 "cheap-act"** rung: a routine next-hop handoff (ack an answered request,
ack an approved verify) that today wastefully boots a full Opus worker is instead completed on the
cheap 'ack' substrate WITHOUT a spawn — but ONLY when the container is at autonomy_level='full'.
At the default ('plan'/'pr') the daemon LOGS the would-be T2 (the #284 token measurement reads it)
and falls through to a full boot, so prod behaviour is byte-identical until full autonomy is chosen.

Seams under test (all PURE / fail-open):
  - main._triage_hint_for         — tags a routine event with a `t2` action (server).
  - llm_util.handoff_ack          — the cheap judge-AND-compose call; FAIL-CLOSED (escalate).
  - notifier.decide_wake_tier     — grades a candidate into structural|llm|act|full (daemon).
  - notifier._apply_wake_act      — completes the handoff via existing routes, else escalates.
  - notifier.tick()               — the autonomy gate + the #284 log + spawn-vs-no-spawn fork.

NON-NEGOTIABLE teeth (each BITES a specific mutation, noted in the test):
  (A) decide_wake_tier NEVER downgrades a #288 suppress into an act    (suppress passthrough)
  (B) a routine handoff that #288 would full-boot grades `act`         (the boot-saving rung)
  (C) handoff_ack FAILS CLOSED (ack=False) on error/uncertainty        (never auto-ack real work)
  (D) _apply_wake_act ESCALATES (returns False) when the cheap model won't ack  (no dropped work)
  (E) tick gates the act behind autonomy='full' — default = log-only + full boot (no behaviour change)
  (F) when T2 acts, NO spawn happens and the cursor advances
"""
import json
import pathlib
import sys
import types
import uuid

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import notifier  # noqa: E402
from orcha_cli import llm_util as L  # noqa: E402
import main  # noqa: E402


# ===========================================================================================
# decide_wake_tier — grades a candidate into the cheapest sufficient substrate
# ===========================================================================================

def _cand(hint, **extra):
    c = {"agent_id": str(uuid.uuid4()), "alias": "X", "triage_hint": hint}
    c.update(extra)
    return c


def test_tier_structural_passthrough_suppress():
    """TOOTH A: a bare structural hint grades 'structural' (suppress) — decide_wake_tier returns the
    #288 verdict VERBATIM, never an 'act'. MUTATION: if decide_wake_tier ignored the suppress verdict
    and looked at t2 first, a structural FYI could become a write. Here it stays a suppress."""
    hint = {"tier": "structural", "event_name": "request_closed", "request_id": None}
    out = notifier.decide_wake_tier(_cand(hint))
    assert out["tier"] == "structural"


def test_tier_llm_skip_passthrough_suppress():
    """TOOTH A: llm hint + triage 'skip' -> tier 'llm' (suppress), NOT 'act'. A pure-ack answer is
    already handled by #288 T1; T2 must not steal it into a redundant write."""
    rid = str(uuid.uuid4())
    hint = {"tier": "llm", "event_name": "request_answered", "request_id": rid, "text": "thanks!",
            "t2": {"action": "ack_close", "request_id": rid}}
    out = notifier.decide_wake_tier(_cand(hint), triage_fn=lambda t: {"wake": False, "reason": "ack"})
    assert out["tier"] == "llm" and out["request_id"] == rid


def test_tier_act_on_routine_handoff_that_would_full_boot():
    """TOOTH B (the rung): llm hint where triage says WAKE (would full-boot today) BUT the event
    carries a t2 action -> tier 'act'. This is the only place a full boot is converted to a cheap
    act. MUTATION: drop the t2 branch in decide_wake_tier -> this grades 'full' -> RED."""
    tid = str(uuid.uuid4())
    hint = {"tier": "llm", "event_name": "task_verified", "request_id": None, "text": "great work",
            "t2": {"action": "ack_verify", "task_id": tid}}
    out = notifier.decide_wake_tier(_cand(hint), triage_fn=lambda t: {"wake": True, "reason": "note"})
    assert out["tier"] == "act"
    assert out["action"] == "ack_verify" and out["task_id"] == tid
    assert out["text"] == "great work"


def test_tier_full_when_no_hint():
    """No hint (task work, multi-event backlog, a directed message) -> tier 'full'. The conservative
    default: anything not positively classified earns a full embodiment."""
    assert notifier.decide_wake_tier(_cand(None))["tier"] == "full"
    assert notifier.decide_wake_tier({"alias": "X"})["tier"] == "full"


def test_tier_full_on_unknown_t2_action():
    """FAIL-OPEN: a t2 tag naming an action the daemon doesn't implement -> tier 'full' (boot), never
    a silent no-op. MUTATION: accept any truthy t2 -> an unknown action would skip the spawn -> work
    silently dropped. Here an unknown action escalates to a full boot."""
    hint = {"tier": "llm", "event_name": "task_verified", "text": "x",
            "t2": {"action": "delete_everything"}}
    out = notifier.decide_wake_tier(_cand(hint), triage_fn=lambda t: {"wake": True, "reason": "n"})
    assert out["tier"] == "full"


def test_tier_full_when_triage_wakes_and_no_t2_tag():
    """A novel llm event with NO t2 tag and triage=wake -> tier 'full' (today's behaviour preserved
    for everything we haven't tagged as routine)."""
    hint = {"tier": "llm", "event_name": "request_answered", "request_id": "r", "text": "please fix"}
    out = notifier.decide_wake_tier(_cand(hint), triage_fn=lambda t: {"wake": True, "reason": "fu"})
    assert out["tier"] == "full"


# ===========================================================================================
# main._triage_hint_for — the server tags routine events with a t2 action
# ===========================================================================================

def test_hint_task_verified_approved_note_tags_ack_verify():
    h = main._triage_hint_for("task_verified", {"approved": True, "feedback": "nice", "task_id": "t-1"})
    assert h["tier"] == "llm"
    assert h["t2"] == {"action": "ack_verify", "task_id": "t-1"}


def test_hint_request_answered_tags_ack_close():
    h = main._triage_hint_for("request_answered", {"request_id": "r-1", "preview": "k"})
    assert h["tier"] == "llm"
    assert h["t2"] == {"action": "ack_close", "request_id": "r-1"}


def test_hint_approved_without_note_has_no_t2():
    """A bare approval is structural (already T0-suppressed) — no t2 tag, nothing to act on."""
    h = main._triage_hint_for("task_verified", {"approved": True, "task_id": "t-1"})
    assert h["tier"] == "structural" and "t2" not in h


# ===========================================================================================
# llm_util.handoff_ack — the cheap judge-AND-compose call, FAIL-CLOSED
# ===========================================================================================

class _FakeProv(L.Provider):
    name = "fake"
    def __init__(self, tool_input=None, raise_exc=None):
        self._inp, self._raise = tool_input, raise_exc
    def complete(self, *, spec, system, messages, tools=None, tool_choice=None, api_key=None):
        if self._raise:
            raise self._raise
        return {"text": "", "tool_calls": [{"name": "emit_result", "input": self._inp}],
                "usage": {}, "stop_reason": "tool_use"}


def test_handoff_ack_routine_acks_and_composes():
    prov = _FakeProv({"ack": True, "text": "Got it — thanks, closing the loop."})
    out = L.handoff_ack("the answer text", provider=prov)
    assert out == {"ack": True, "text": "Got it — thanks, closing the loop."}


def test_handoff_ack_non_routine_escalates():
    """ack=False -> {ack:False} (escalate to a full boot)."""
    prov = _FakeProv({"ack": False, "text": "needs real work"})
    assert L.handoff_ack("please rebase and re-run", provider=prov) == {"ack": False, "text": ""}


def test_handoff_ack_error_fails_closed():
    """TOOTH C: ANY error -> {ack:False}. This is the MIRROR of triage's fail-OPEN — a flaky cheap
    model must never auto-ack something that might need real work. MUTATION: fail-open to ack=True
    here would let an LLM outage silently swallow handoffs -> this asserts ack is False."""
    prov = _FakeProv(raise_exc=RuntimeError("boom"))
    assert L.handoff_ack("x", provider=prov) == {"ack": False, "text": ""}


def test_handoff_ack_true_but_empty_text_escalates():
    """ack=True with no composed line is unusable -> escalate (ack=False). Guards the bool(None) /
    empty-string trap the same way triage_wake does."""
    prov = _FakeProv({"ack": True, "text": "   "})
    assert L.handoff_ack("x", provider=prov) == {"ack": False, "text": ""}


def test_handoff_ack_malformed_missing_ack_escalates():
    """A missing/non-bool `ack` must NOT coerce to True (or to a skip). Escalate."""
    prov = _FakeProv({"text": "hi"})
    assert L.handoff_ack("x", provider=prov) == {"ack": False, "text": ""}


# ===========================================================================================
# notifier._apply_wake_act — complete the handoff via existing routes, else escalate
# ===========================================================================================

def _fake_llm(decision=None, raise_exc=None):
    def handoff_ack(text, *, config=None):
        if raise_exc:
            raise raise_exc
        return decision
    return types.SimpleNamespace(handoff_ack=handoff_ack)


def test_apply_act_ack_close_posts_triage_close_and_cursor(monkeypatch):
    """TOOTH F: ack_close -> POST triage-close with the composed line, THEN advance the cursor; True."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})
    monkeypatch.setattr(notifier, "_llm_util", _fake_llm({"ack": True, "text": "thanks, closing"}))
    cand = {"agent_id": "a-1", "alias": "X", "ack_through_ts": 7.0, "max_event_ts": 9.0}
    verdict = {"tier": "act", "action": "ack_close", "request_id": "r-9", "text": "the answer"}
    ok = notifier._apply_wake_act("http://api", cand, "request_answered", verdict, quiet=True)
    assert ok is True
    urls = [u for u, _ in posts]
    assert "http://api/api/requests/r-9/triage-close" in urls
    tc = next(b for u, b in posts if "triage-close" in u)
    assert tc["triage_reason"] == "thanks, closing"
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "skipped" and ack["delivered_ts"] == 7.0


def test_apply_act_ack_verify_posts_task_message_and_cursor(monkeypatch):
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})
    monkeypatch.setattr(notifier, "_llm_util", _fake_llm({"ack": True, "text": "acknowledged, thanks!"}))
    cand = {"agent_id": "a-1", "alias": "X", "ack_through_ts": None, "max_event_ts": 4.0}
    verdict = {"tier": "act", "action": "ack_verify", "task_id": "t-2", "text": "great work"}
    ok = notifier._apply_wake_act("http://api", cand, "task_verified", verdict, quiet=True)
    assert ok is True
    msg = next((b for u, b in posts if u.endswith("/api/tasks/t-2/messages")), None)
    assert msg is not None
    assert msg["author_agent_id"] == "a-1" and msg["body"] == "acknowledged, thanks!"
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["delivered_ts"] == 4.0      # falls back to max_event_ts


def test_apply_act_escalates_when_model_declines(monkeypatch):
    """TOOTH D: handoff_ack ack=False -> NO write, NO cursor advance, returns False (escalate).
    MUTATION: if _apply_wake_act wrote before checking the ack verdict, a non-routine handoff would
    be silently acked. Here zero posts go out and it returns False (-> the caller full-boots)."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})
    monkeypatch.setattr(notifier, "_llm_util", _fake_llm({"ack": False, "text": ""}))
    cand = {"agent_id": "a-1", "alias": "X", "max_event_ts": 1.0}
    verdict = {"tier": "act", "action": "ack_close", "request_id": "r-9", "text": "please fix the bug"}
    ok = notifier._apply_wake_act("http://api", cand, "request_answered", verdict, quiet=True)
    assert ok is False and posts == []


def test_apply_act_no_llm_client_escalates(monkeypatch):
    """No cheap substrate available -> escalate (False), no writes."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})
    monkeypatch.setattr(notifier, "_llm_util", None)
    verdict = {"tier": "act", "action": "ack_close", "request_id": "r-9", "text": "x"}
    ok = notifier._apply_wake_act("http://api", {"agent_id": "a", "alias": "X"},
                                  "request_answered", verdict, quiet=True)
    assert ok is False and posts == []


def test_apply_act_write_failure_escalates_without_cursor(monkeypatch):
    """The cheap model acked but the write FAILED (_post_json None) -> return False and DON'T advance
    the cursor (so the event re-grades next tick and ultimately full-boots — never lost)."""
    posts = []
    def fake_post(url, body, **k):
        posts.append(url)
        return None if "triage-close" in url else {}
    monkeypatch.setattr(notifier, "_post_json", fake_post)
    monkeypatch.setattr(notifier, "_llm_util", _fake_llm({"ack": True, "text": "closing"}))
    cand = {"agent_id": "a-1", "alias": "X", "max_event_ts": 1.0}
    verdict = {"tier": "act", "action": "ack_close", "request_id": "r-9", "text": "x"}
    ok = notifier._apply_wake_act("http://api", cand, "request_answered", verdict, quiet=True)
    assert ok is False
    assert not any(u.endswith("/wake-ack") for u in posts)   # cursor NOT advanced after a failed write


def test_apply_act_missing_target_id_escalates(monkeypatch):
    posts = []
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append(url) or {})
    monkeypatch.setattr(notifier, "_llm_util", _fake_llm({"ack": True, "text": "hi"}))
    verdict = {"tier": "act", "action": "ack_close", "request_id": None, "text": "x"}
    ok = notifier._apply_wake_act("http://api", {"agent_id": "a", "alias": "X"},
                                  "request_answered", verdict, quiet=True)
    assert ok is False and posts == []


# ===========================================================================================
# tick() — the autonomy gate + the #284 measurement log + spawn-vs-no-spawn fork
# ===========================================================================================

def _ephemeral_t2_cand():
    return {"agent_id": "00000000-0000-0000-0000-000000000007", "alias": "Inv",
            "should_wake": True, "headless_cwd": "/tmp/x", "tmux_target": None,
            "wake_enabled": True, "pending_events": 1, "auto_start_task_ids": [],
            "reason": "wake", "latest_event": "task_verified", "max_event_ts": 5.0,
            "headless_flags": None, "model": "claude-opus-4-8", "model_runtime": "claude",
            "triage_hint": {"tier": "llm", "event_name": "task_verified", "text": "great work",
                            "t2": {"action": "ack_verify", "task_id": "t-7"}}}


def _wire_tick(monkeypatch, scan, *, ack_decision):
    """Common tick() wiring: ephemeral transport, a triage that WAKES (so the event would full-boot
    today), a cheap model returning `ack_decision`, and recorded spawns + posts."""
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: scan)
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "build_wake_prompt", lambda c: "PROMPT")
    monkeypatch.setattr(notifier, "derive_wake_event", lambda c: "task_verified")
    monkeypatch.setattr(notifier, "_build_persona", lambda api, aid: None)
    monkeypatch.setattr(notifier, "_triage_wake", lambda text, config=None: {"wake": True, "reason": "note"})
    monkeypatch.setattr(notifier, "_llm_util", _fake_llm(ack_decision))
    spawns = []
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: spawns.append(a) or (True, "claude-cmd", None))
    posts = []
    def fake_post(url, body, **k):
        posts.append((url, body))
        return {"claimed": True} if url.endswith("/wake-claim") else {}
    monkeypatch.setattr(notifier, "_post_json", fake_post)
    return spawns, posts


def test_tick_t2_acts_under_full_autonomy(monkeypatch):
    """TOOTH F: autonomy='full' + a routine handoff -> the cheap-act fires (task message posted),
    NO spawn, the cursor advances. MUTATION: drop the `if tier == 'act'` branch -> a spawn happens."""
    scan = {"active": True, "autonomy_level": "full", "ack_model": None,
            "candidates": [_ephemeral_t2_cand()]}
    spawns, posts = _wire_tick(monkeypatch, scan, ack_decision={"ack": True, "text": "thanks!"})
    out = notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True)
    assert spawns == []                                                  # NO full embodiment
    assert any(u.endswith("/api/tasks/t-7/messages") for u, _ in posts)  # cheap-act write went out
    assert out["woke"][0]["suppressed"] == "act" and out["woke"][0]["sent"] is False


def test_tick_t2_log_only_under_default_autonomy(monkeypatch, capsys):
    """TOOTH E (the gate): autonomy='plan' (the DEFAULT) -> the cheap-act NEVER fires, a full boot
    happens (today's behaviour), AND a graded_wake measurement record is logged for #284.
    MUTATION: drop the `_t2_enabled` guard (always act) -> a spawn would NOT happen -> RED here.

    REGRESSION (Gate 2nd-pass): the daemon NEVER configures the logging module and runs --quiet, so
    the record must reach STDOUT (the daemon's captured log) at runtime — assert against real stdout
    (capsys) here, NOT caplog (which forcibly attaches a handler the runtime never has). This tooth
    goes RED against a `logging.getLogger(...).info(...)` impl whose INFO record is dropped."""
    scan = {"active": True, "autonomy_level": "plan", "ack_model": None,
            "candidates": [_ephemeral_t2_cand()]}
    spawns, posts = _wire_tick(monkeypatch, scan, ack_decision={"ack": True, "text": "thanks!"})
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True)
    assert len(spawns) == 1                                              # full boot DID happen
    assert not any("/api/tasks/t-7/messages" in u for u, _ in posts)     # cheap-act did NOT fire
    # The #284 record must land on stdout even though the daemon runs --quiet (it is NOT gated).
    line = next(ln for ln in capsys.readouterr().out.splitlines() if "graded_wake" in ln)
    rec = json.loads(line.split("graded_wake", 1)[1])
    assert rec["event"] == "graded_wake" and rec["tier"] == "act"
    assert rec["acted"] is False and rec["would_boot"] is True
    assert rec["autonomy_level"] == "plan" and rec["action"] == "ack_verify"


def test_tick_t2_escalates_to_full_boot_when_model_declines(monkeypatch):
    """FAIL-SAFE: autonomy='full' but the cheap model judges the handoff non-routine (ack=False) ->
    full boot, no dropped work. The cheapest-SUFFICIENT contract: cheap when sufficient, escalate
    when not."""
    scan = {"active": True, "autonomy_level": "full", "ack_model": None,
            "candidates": [_ephemeral_t2_cand()]}
    spawns, posts = _wire_tick(monkeypatch, scan, ack_decision={"ack": False, "text": ""})
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True)
    assert len(spawns) == 1                                              # escalated to a full boot
    assert not any("/api/tasks/t-7/messages" in u for u, _ in posts)


# ===========================================================================================
# wake-scan endpoint — the server surfaces the T2 gate + the cheap-act model (integration tooth)
# ===========================================================================================

async def test_wakescan_surfaces_autonomy_and_ack_model(client, container):
    """INTEGRATION tooth: the real GET /wake-scan response carries `autonomy_level` (the T2 gate)
    and `ack_model` (the cheap-act model override) so the daemon grades + routes without a second
    round-trip. A fresh container defaults to autonomy_level='plan' (gate CLOSED — zero behaviour
    change) and ack_model=None (#290 default Haiku). MUTATION: drop EITHER key from wake_scan's
    return dict -> the daemon reads None, the gate is unreadable, T2 silently never acts -> RED."""
    r = await client.get(f"/api/containers/{container['id']}/wake-scan",
                         params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["autonomy_level"] == "plan"          # the gate defaults CLOSED (mig021 default)
    assert "ack_model" in body and body["ack_model"] is None
