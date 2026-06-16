"""V1 — pure conversation-history prefix formatter (cache-friendly cold-boot injection).

The resident reuses Anthropic's server-side prompt cache only while the injected prefix is
byte-stable, so this asserts the invariants: oldest→newest, deterministic, append-only,
bounded (last-N + char-budget, oldest trimmed first), empty→"".
"""
from orcha_cli.conversation_prefix import (
    format_conversation_history, MAX_HISTORY_TURNS, HISTORY_CHAR_BUDGET,
)


def _t(role, content):
    return {"role": role, "content": content}


def test_empty_returns_blank():
    assert format_conversation_history([]) == ""
    assert format_conversation_history(None) == ""
    # all-empty-content turns also collapse to ""
    assert format_conversation_history([_t("human", "   "), _t("agent", "")]) == ""


def test_renders_oldest_to_newest_with_role_labels():
    out = format_conversation_history([_t("human", "hi"), _t("agent", "hello"), _t("human", "thanks")])
    assert out.startswith("## Conversation so far")
    # ordering preserved oldest->newest; agent = "You", human = "Human"
    assert out.index("Human: hi") < out.index("You: hello") < out.index("Human: thanks")


def test_keeps_only_last_n_turns():
    turns = [_t("human", f"msg{i}") for i in range(MAX_HISTORY_TURNS + 5)]
    out = format_conversation_history(turns)
    assert "msg4" not in out and "msg5" in out          # first 5 dropped (kept last N=20)
    assert out.count("Human:") == MAX_HISTORY_TURNS


def test_char_budget_trims_oldest_first():
    turns = [_t("human", "x" * 1000) for _ in range(20)]   # ~20k chars >> budget
    out = format_conversation_history(turns, char_budget=3500)
    assert len(out) <= 3500
    # only the most-recent turns survive (oldest dropped first)
    assert out.count("Human: " + "x" * 1000) <= 4


def test_lone_oversized_turn_truncated_to_budget():
    # [P2 review] a single huge turn must NOT blow the budget — truncate deterministically.
    out = format_conversation_history([_t("human", "y" * 5000)], char_budget=1000)
    assert len(out) <= 1000                             # budget enforced
    assert "truncated" in out                           # stable marker present
    assert "y" * 5000 not in out                        # content was trimmed
    # deterministic: same input → same (truncated) output
    again = format_conversation_history([_t("human", "y" * 5000)], char_budget=1000)
    assert out == again


def test_deterministic_same_input_same_output():
    turns = [_t("human", "a"), _t("agent", "b"), _t("human", "c")]
    assert format_conversation_history(turns) == format_conversation_history(turns)


def test_no_volatile_tokens_in_block():
    # the block must not embed ids/timestamps that would change turn-over-turn and bust cache
    turns = [{"role": "human", "content": "hi", "id": "abc", "seq": 1,
              "created_at": "2026-06-06T00:00:00Z", "run_id": "xyz"}]
    out = format_conversation_history(turns)
    for volatile in ("abc", "xyz", "2026-06-06", "seq"):
        assert volatile not in out
