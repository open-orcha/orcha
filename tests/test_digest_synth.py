"""V2 — pure fallback digest synthesiser (pre-kill, when the agent-authored drain fails).

Asserts the honesty + shape invariants: never fabricates decisions/learnings, always marks
itself auto-synthesised, captures an unanswered final human turn as a loose end, is
deterministic, bounds content, and returns the exact C1 DigestSnapshot keys so Forge can POST
it verbatim to /api/agents/{aid}/digest.
"""
from orcha_cli.digest_synth import (
    synthesize_digest, MAX_RECENT_TURNS, FOCUS_CHARS, THREAD_CHARS,
)


def _t(role, content):
    return {"role": role, "content": content}


KEYS = {"current_focus", "decisions", "learnings", "open_threads"}


def test_returns_exact_c1_digest_keys():
    d = synthesize_digest([_t("human", "hi"), _t("agent", "hello")])
    assert set(d) == KEYS


def test_never_fabricates_reasoning():
    # decisions/learnings are NEVER synthesised — a machine can't author the agent's reasoning.
    d = synthesize_digest([_t("agent", "I decided to refactor X because Y and learned Z")])
    assert d["decisions"] == [] and d["learnings"] == []


def test_every_field_is_marked_auto_synthesised():
    d = synthesize_digest([_t("agent", "did work")])
    assert "auto-synthesised" in d["current_focus"]
    assert any("auto-synthesised" in th["text"] for th in d["open_threads"])


def test_empty_input_still_leaves_a_marked_breadcrumb():
    for empty in ([], None, [_t("human", "   "), _t("agent", "")], ["garbage", 5, None]):
        d = synthesize_digest(empty)
        assert set(d) == KEYS
        assert "auto-synthesised" in d["current_focus"]
        assert d["decisions"] == [] and d["learnings"] == []
        assert d["open_threads"] and "auto-synthesised" in d["open_threads"][0]["text"]


def test_unanswered_final_human_turn_becomes_open_thread():
    d = synthesize_digest([_t("agent", "earlier reply"), _t("human", "please also do the thing")])
    threads = " ".join(th["text"] for th in d["open_threads"])
    assert "Unanswered human message at reap" in threads
    assert "please also do the thing" in threads
    assert "mid-reply" in d["current_focus"]


def test_final_agent_turn_becomes_current_focus():
    d = synthesize_digest([_t("human", "do it"), _t("agent", "finished building the parser")])
    assert "Last worked on" in d["current_focus"]
    assert "finished building the parser" in d["current_focus"]
    # no unanswered-human thread when the agent had the last word
    assert not any("Unanswered human" in th["text"] for th in d["open_threads"])


def test_deterministic_same_input_same_output():
    turns = [_t("human", "a"), _t("agent", "b"), _t("human", "c")]
    assert synthesize_digest(turns) == synthesize_digest(turns)


def test_content_is_bounded():
    d = synthesize_digest([_t("agent", "x" * 5000)])
    assert len(d["current_focus"]) <= FOCUS_CHARS            # FOCUS_CHARS is the TOTAL budget
    d2 = synthesize_digest([_t("agent", "ok"), _t("human", "y" * 5000)])
    longest = max(len(th["text"]) for th in d2["open_threads"])
    assert longest <= THREAD_CHARS + 48                      # thread cap + label slack


def test_only_recent_turns_considered():
    # an early turn beyond the window must not drive current_focus
    turns = [_t("agent", f"turn{i}") for i in range(MAX_RECENT_TURNS + 5)]
    d = synthesize_digest(turns)
    assert "turn0" not in d["current_focus"]
    assert f"turn{MAX_RECENT_TURNS + 4}" in d["current_focus"]   # the newest does
