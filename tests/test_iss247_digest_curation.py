"""#247 item-3 — cold-boot conversation-history CURATION.

Pure unit tests, no network / no live key: the summarizer is injected via the ``summarize=``
override, so the threshold gate, the curated render (summary + recent-verbatim), the per-turn
cap, and the ABSOLUTE fail-open contract are all exercised deterministically. Plus: the
'curation' use-case resolves to a bounded Sonnet spec and is kept OFF the #294 settings page;
and the notifier's ``_cold_boot_history`` prefers curation and fails open.
"""
import pytest

from orcha_cli import digest_curation as C
from orcha_cli import llm_util as L


def _t(role, content):
    return {"role": role, "content": content}


# ----------------------------------------------------------------- threshold gate


def test_under_threshold_is_mechanical_and_zero_llm_call():
    """Short history → the mechanical block verbatim, and the summarizer is NEVER called."""
    calls = []
    turns = [_t("human", "hi"), _t("agent", "hello"), _t("human", "thanks")]
    out = C.curate_history(turns, summarize=lambda older: calls.append(older) or "X")
    assert calls == []                       # zero LLM call below threshold
    assert out.startswith("## Conversation so far")
    assert "[Summary of earlier conversation]" not in out   # not curated
    assert "You: hello" in out and "Human: thanks" in out


def test_too_few_turns_never_summarizes_even_if_huge():
    """Over the char threshold but <= recent_turns → nothing OLDER to summarize. Keep all turns
    verbatim (per-turn capped) — NO summarizer call, and crucially NO mechanical oldest-drop."""
    calls = []
    turns = [_t("human", "x" * 20000)]       # 1 turn, way over chars, but nothing older
    out = C.curate_history(turns, recent_turns=8,
                           summarize=lambda older: calls.append(1) or "S")
    assert calls == []
    assert "[Summary of earlier conversation]" not in out
    assert out.startswith("## Conversation so far")          # the single turn is kept, not dropped


def test_threshold_aligned_to_mechanical_budget_no_silent_drop_band():
    """BLOCKER-2 / P1 regression: the curation gate's RENDERED-char budget MUST be <= the
    mechanical char budget, so curation never engages LATER than the mechanical drop — there is NO
    band (content- or rendering-overhead) where the formatter silently drops before curation."""
    from orcha_cli import conversation_prefix as P
    assert C.CURATION_CHAR_THRESHOLD <= P.HISTORY_CHAR_BUDGET


def test_band_above_mech_budget_curates_oldest_instead_of_dropping():
    """Gate's exact repro: 10 turns ~1000 chars each = ~10000 total — ABOVE the mechanical 8000
    budget but BELOW the OLD 12000 threshold. With the threshold now aligned, curation ENGAGES:
    the oldest turns are summarized (represented), never silently mechanical-dropped."""
    turns = [_t("human" if i % 2 == 0 else "agent", f"MSG{i}- " + "z" * 1000) for i in range(10)]
    seen = {}

    def fake_summarize(older):
        seen["older"] = [o["content"] for o in older]
        return "SUMMARY of the earliest turns"

    out = C.curate_history(turns, summarize=fake_summarize)   # DEFAULT threshold (= mech budget)

    assert "[Summary of earlier conversation]" in out         # curated, not mechanical-dropped
    assert "SUMMARY of the earliest turns" in out
    # the OLDEST turns (MSG0/MSG1) are represented in the summarizer input — NOT silently dropped
    assert any("MSG0-" in c for c in seen["older"])
    assert any("MSG1-" in c for c in seen["older"])
    # every newer turn survives verbatim in the block
    assert "MSG9-" in out


def test_content_under_budget_but_rendered_over_still_curates():
    """Gate #321 2nd-pass P1: the gate must judge the MECHANICAL render, not a raw content sum.
    18 turns of ~440 content chars = content_sum 7920 (<= the 8000 budget, so the OLD content-sum
    gate skipped curation) BUT the rendered block is 8239 (> budget, so the mechanical formatter
    silently oldest-DROPS MSG0). With the gate now on rendered length, curation ENGAGES instead —
    the oldest turn is summarized (represented), never silently dropped."""
    from orcha_cli import conversation_prefix as P

    turns = [_t("human" if i % 2 == 0 else "agent",
                f"MSG{i}- " + "z" * (440 - len(f"MSG{i}- "))) for i in range(18)]
    content_sum = sum(len(t["content"]) for t in turns)
    assert content_sum <= P.HISTORY_CHAR_BUDGET            # OLD content-sum gate would SKIP curation
    assert P.would_truncate(turns)                         # but mechanical render IS lossy...
    assert "MSG0-" not in P.format_conversation_history(turns)  # ...it drops the oldest turn

    seen = {}

    def fake_summarize(older):
        seen["older"] = [o["content"] for o in older]
        return "SUMMARY of the earliest turns"

    out = C.curate_history(turns, summarize=fake_summarize)   # DEFAULT gate budget (= mech budget)

    assert "[Summary of earlier conversation]" in out      # curated, NOT mechanical-dropped
    assert any("MSG0-" in c for c in seen["older"])         # the oldest turn is represented


def test_would_truncate_predicate_matches_formatter_loss():
    """Direct unit on the single-source-of-truth predicate the gate delegates to: it is True
    exactly when format_conversation_history would drop a whole turn or truncate content."""
    from orcha_cli import conversation_prefix as P

    assert P.would_truncate([]) is False
    assert P.would_truncate([_t("human", "short"), _t("agent", "also short")]) is False
    # over rendered budget → lossy (oldest dropped)
    assert P.would_truncate([_t("human", "a" * 9000)]) is True
    # more than max_turns → lossy (older whole turns dropped) even when each turn is tiny
    assert P.would_truncate([_t("human", "x") for _ in range(P.MAX_HISTORY_TURNS + 1)]) is True


# --------------------------------------------------------------- curated render


def test_over_threshold_curates_summary_plus_recent_verbatim():
    # 12 turns, each big enough to clear the threshold; keep last 4 verbatim, summarize first 8.
    # Distinct MSG<i>- tokens so we can prove older went to the summarizer, recent stayed verbatim.
    turns = [_t("human" if i % 2 == 0 else "agent", f"MSG{i}- " + "y" * 1500) for i in range(12)]
    seen_older = {}

    def fake_summarize(older):
        seen_older["n"] = len(older)
        seen_older["last_old"] = older[-1]["content"]
        return "EARLIER: the human stated the goal and we made progress."

    out = C.curate_history(turns, recent_turns=4, summarize=fake_summarize)  # DEFAULT gate budget

    assert out.startswith("## Conversation so far (curated")
    assert "[Summary of earlier conversation]" in out
    assert "EARLIER: the human stated the goal" in out
    # older 8 turns went to the summarizer, NOT rendered verbatim
    assert seen_older["n"] == 8
    assert "MSG0-" not in out and "MSG7-" not in out
    # the most-recent 4 turns ARE verbatim, in order
    assert out.index("MSG8-") < out.index("MSG9-") < out.index("MSG10-") < out.index("MSG11-")


def test_recent_turn_is_capped_to_prevent_prompt_blowup():
    older = [_t("human", "a" * 2000) for _ in range(9)]
    huge_recent = _t("agent", "Z" * 50000)
    out = C.curate_history(older + [huge_recent], recent_turns=1,
                           summarize=lambda o: "sum")
    assert "truncated to fit the prompt-cache budget" in out
    # the rendered recent turn is bounded, not the full 50k
    assert out.count("Z") <= C.RECENT_TURN_CHAR_CAP + 10


# -------------------------------------------------------------- ABSOLUTE fail-open


def _big_turns(n=12):
    return [_t("human" if i % 2 == 0 else "agent", f"t{i} " + "q" * 1500) for i in range(n)]


def test_fail_open_on_summarize_error_returns_mechanical():
    def boom(older):
        raise RuntimeError("llm down")
    out = C.curate_history(_big_turns(), recent_turns=4, summarize=boom)
    # mechanical block (NOT curated, NOT empty) — recent turns present, no summary label. (The
    # mechanical formatter trims OLDEST-first under its own char budget, so t0 may be dropped;
    # what matters is we got the mechanical block back, not the curated one.)
    assert out.startswith("## Conversation so far")
    assert "[Summary of earlier conversation]" not in out
    assert "t11" in out          # mechanical keeps the most-recent turns verbatim


def test_fail_open_on_empty_summary_returns_mechanical():
    out = C.curate_history(_big_turns(), recent_turns=4,
                           summarize=lambda older: "   ")
    assert out.startswith("## Conversation so far")
    assert "[Summary of earlier conversation]" not in out


def test_curate_history_never_raises_even_if_mechanical_also_fails():
    def boom_sum(older):
        raise RuntimeError("llm down")

    def boom_mech(turns):
        raise RuntimeError("mechanical down too")
    # both paths blow up → total contract returns '' instead of raising into a boot
    out = C.curate_history(_big_turns(), recent_turns=4,
                           summarize=boom_sum, mechanical=boom_mech)
    assert out == ""


def test_empty_input_returns_blank():
    assert C.curate_history([]) == ""
    assert C.curate_history(None) == ""
    assert C.curate_history([_t("human", "   "), {"role": "agent"}, "garbage"]) == ""


# ----------------------------------------------------- llm_util 'curation' use-case


def test_curation_use_case_is_bounded_sonnet():
    spec = L.resolve_spec("curation")
    assert spec.provider == "anthropic" and spec.model == L.MODEL_SONNET
    # ON the cold-boot latency path → small token budget + tight timeout so it can fail open fast
    assert spec.max_tokens <= 512
    assert spec.timeout_s <= 20.0


def test_curation_is_not_on_the_settings_page_v1():
    """v1 keeps curation OUT of the user-facing registry (plan Q3) — settings page unchanged."""
    keys = {uc["key"] for uc in L.USE_CASE_REGISTRY}
    assert "curation" not in keys
    assert "curation" not in {row["key"] for row in L.use_case_registry()}


# ------------------------------------------------------ notifier seam (fail-open wiring)


def test_default_summarize_uses_curation_use_case(monkeypatch):
    """The default summarizer routes through llm_util.classify('curation', ...)."""
    captured = {}

    def fake_classify(use_case, *, system, user, schema, **kw):
        captured["use_case"] = use_case
        captured["schema"] = schema
        return {"summary": "ok"}

    monkeypatch.setattr(L, "classify", fake_classify)
    out = C._default_summarize([_t("human", "the original ask"), _t("agent", "did it")])
    assert out == "ok"
    assert captured["use_case"] == "curation"
    assert captured["schema"]["required"] == ["summary"]


def test_notifier_cold_boot_history_prefers_curation_and_fails_open(monkeypatch):
    from orcha_cli import notifier as N

    # The mechanical formatter is the SINGLE fallback seam. Curation receives it as mechanical=…
    # (so its own fail-open routes through the SAME formatter tests patch) — hence the lambdas
    # below accept **kw. This is the BLOCKER-1 fix: curation is additive, not a parallel path.
    monkeypatch.setattr(N, "_format_history", lambda turns: "MECH-BLOCK")

    # curation present + returns a block → that block is used verbatim
    monkeypatch.setattr(N, "_curate_history", lambda turns, **kw: "CURATED-BLOCK")
    assert N._cold_boot_history([_t("human", "x")]) == "CURATED-BLOCK"

    # curation raises → fall back to the patched mechanical formatter (same seam)
    monkeypatch.setattr(N, "_curate_history",
                        lambda turns, **kw: (_ for _ in ()).throw(RuntimeError("x")))
    assert N._cold_boot_history([_t("human", "x")]) == "MECH-BLOCK"

    # curation returns falsy → also degrades to the formatter
    monkeypatch.setattr(N, "_curate_history", lambda turns, **kw: "")
    assert N._cold_boot_history([_t("human", "x")]) == "MECH-BLOCK"

    # curation actually USES the injected mechanical (its internal fail-open hits the SAME seam):
    # a long history whose summarizer is unavailable falls back through mechanical= → "MECH-BLOCK".
    captured = {}
    monkeypatch.setattr(N, "_curate_history",
                        lambda turns, **kw: kw["mechanical"](turns) if "mechanical" in kw
                        else captured.setdefault("nomech", True))
    assert N._cold_boot_history([_t("human", "x")]) == "MECH-BLOCK"
    assert "nomech" not in captured                       # mechanical WAS injected

    # formatter ABSENT → NO history block, even with curation present (unchanged contract)
    monkeypatch.setattr(N, "_format_history", None)
    monkeypatch.setattr(N, "_curate_history", lambda turns, **kw: "CURATED-BLOCK")
    assert N._cold_boot_history([_t("human", "x")]) == ""
