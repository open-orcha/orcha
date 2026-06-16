"""#287 — memory-digest curation (write-side dedup + boot-copy trim + LLM tail-summary).

Pure unit tests, no network and no DB: the deterministic curation paths exercise directly, and
the LLM summary path is driven through an injected `summarizer` callable. Covers the two seams:
`dedup_digest` (stored row — Tier-0 compaction) and `curate_injected_digest` / `curate_inner`
(boot copy — dedup + clip + recency cap + byte ceiling + tail summary), plus the honesty
invariants (stored row untouched, fields never emptied, summary clearly marked).
"""
from orcha_cli import digest_curate as C


# --------------------------------------------------------------- write-side dedup


def test_dedup_collapses_exact_duplicates_keeping_most_recent():
    digest = {"decisions": [{"text": "ship A"}, {"text": "ship B"}, {"text": "ship A"}]}
    out = C.dedup_digest(digest)
    # exact dup collapses to ONE; order preserved oldest→newest with the most-recent kept
    assert out["decisions"] == [{"text": "ship B"}, {"text": "ship A"}]


def test_dedup_normalises_whitespace_and_case():
    digest = {"learnings": [{"text": "Use  the   Seam"}, {"text": "use the seam"}]}
    out = C.dedup_digest(digest)
    assert len(out["learnings"]) == 1


def test_dedup_drops_empty_and_whitespace_entries():
    digest = {"open_threads": [{"text": "  "}, {"text": ""}, {"text": "real"}, ""]}
    out = C.dedup_digest(digest)
    assert out["open_threads"] == [{"text": "real"}]


def test_dedup_handles_bare_strings():
    digest = {"decisions": ["x", "x", "y"]}
    assert C.dedup_digest(digest)["decisions"] == ["x", "y"]


def test_dedup_leaves_current_focus_untouched_and_input_unmutated():
    digest = {"current_focus": "raw focus", "decisions": [{"text": "a"}, {"text": "a"}]}
    out = C.dedup_digest(digest)
    assert out["current_focus"] == "raw focus"
    # input not mutated
    assert digest["decisions"] == [{"text": "a"}, {"text": "a"}]


def test_dedup_idempotent():
    digest = {"decisions": [{"text": "a"}, {"text": "a"}, {"text": "b"}]}
    once = C.dedup_digest(digest)
    twice = C.dedup_digest(once)
    assert once == twice


def test_dedup_non_dict_passthrough():
    assert C.dedup_digest(None) is None
    assert C.dedup_digest("nope") == "nope"


# ---------------------------------------------------------- boot-copy: clip + cap


def test_clip_caps_runaway_entry():
    long = "z" * 1000
    out = C.curate_inner({"decisions": [{"text": long}]})
    txt = out["decisions"][0]["text"]
    assert len(txt) == C.CLIP_CHARS
    assert txt.endswith("…")


def test_recency_cap_keeps_last_n_and_summarises_tail_deterministically():
    items = [{"text": f"d{i}"} for i in range(20)]          # 20 > keep(15)
    out = C.curate_inner({"decisions": items})
    # one summary breadcrumb + the 15 most-recent verbatim
    assert len(out["decisions"]) == 16
    summary = out["decisions"][0]["text"]
    assert "older" in summary and "omitted" in summary       # honest deterministic fallback
    assert out["decisions"][-1] == {"text": "d19"}           # newest kept verbatim
    assert out["decisions"][1] == {"text": "d5"}             # oldest KEPT is d5 (20-15)


def test_under_cap_unchanged_no_summary():
    items = [{"text": f"d{i}"} for i in range(5)]
    out = C.curate_inner({"decisions": items})
    assert out["decisions"] == items                          # no summary entry added


def test_open_threads_uses_its_own_smaller_cap():
    items = [{"text": f"t{i}"} for i in range(14)]            # 14 > keep(10)
    out = C.curate_inner({"open_threads": items})
    assert len(out["open_threads"]) == 11                     # 1 summary + 10 recent


def test_field_never_emptied_to_nothing():
    items = [{"text": f"d{i}"} for i in range(50)]
    out = C.curate_inner({"decisions": items}, ceiling=10)    # absurdly tight ceiling
    # ceiling trims aggressively but always keeps the summary + ≥1 verbatim entry
    assert len(out["decisions"]) >= 2
    assert out["decisions"][-1] == {"text": "d49"}           # newest survives


def test_byte_ceiling_enforced():
    items = [{"text": "y" * 300} for _ in range(15)]          # ~ at cap, big entries
    out = C.curate_inner({"decisions": items}, ceiling=2000)
    assert C._serialised_size(out) <= 2000


def test_curate_inner_does_not_mutate_input():
    items = [{"text": f"d{i}"} for i in range(20)]
    snapshot = [dict(e) for e in items]
    C.curate_inner({"decisions": items})
    assert items == snapshot


# ------------------------------------------------------------ LLM summary path


def test_injected_summarizer_used_when_provided():
    items = [{"text": f"d{i}"} for i in range(20)]
    calls = {}

    def fake_summarizer(field, tail):
        calls["field"] = field
        calls["n"] = len(tail)
        return "compressed gist of the old stuff"

    out = C.curate_inner({"decisions": items}, summarizer=fake_summarizer)
    assert calls == {"field": "decisions", "n": 5}            # tail = 20 - 15
    summary = out["decisions"][0]["text"]
    assert "compressed gist" in summary
    assert "auto-summarised" in summary                       # honesty marker present


def test_summarizer_failure_falls_back_to_breadcrumb():
    items = [{"text": f"d{i}"} for i in range(20)]

    def boom(field, tail):
        raise RuntimeError("llm down")

    out = C.curate_inner({"decisions": items}, summarizer=boom)
    # never raises; deterministic breadcrumb instead of dropping continuity
    assert "omitted" in out["decisions"][0]["text"]


def test_summarizer_returning_empty_falls_back_to_breadcrumb():
    items = [{"text": f"d{i}"} for i in range(20)]
    out = C.curate_inner({"decisions": items}, summarizer=lambda f, t: "  ")
    assert "omitted" in out["decisions"][0]["text"]


def test_llm_summarizer_no_client_returns_none(monkeypatch):
    monkeypatch.setattr(C, "_llm_util", None)
    assert C.llm_summarizer("decisions", [{"text": "x"}]) is None


def test_llm_summarizer_empty_tail_returns_none():
    assert C.llm_summarizer("decisions", []) is None


# ------------------------------------------------------- envelope wrapper


def test_curate_injected_digest_wraps_envelope():
    items = [{"text": f"d{i}"} for i in range(20)]
    env = {"digest": {"current_focus": "f", "decisions": items}}
    out = C.curate_injected_digest(env)
    assert len(out["digest"]["decisions"]) == 16
    assert out["digest"]["current_focus"] == "f"


def test_curate_injected_digest_null_passthrough():
    assert C.curate_injected_digest({"digest": None}) == {"digest": None}
    assert C.curate_injected_digest(None) is None
    assert C.curate_injected_digest({}) == {}
