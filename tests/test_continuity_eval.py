"""#284 continuity-eval harness — unit + mutation-teeth coverage.

The harness (tools/efficiency/continuity_eval.py) is the QUALITY axis companion to #289's
control_baseline.py: it scores how much of an agent's snapshotted memory digest survives into
the boot context the resumed agent sees, rendered by the REAL notifier.format_persona.

These tests route the real renderer (not a stub) so they double as the guard #286/#287 need:
if a future efficiency fix stops carrying digest content forward, the scored recall falls and
the relevant test goes RED. Each `test_each_field_*` is a mutation tooth — drop a field from the
scorer's accounting (or from format_persona's output) and that field's test fails.

Pure-logic, no DB / no live stack — runs in the default unit suite.
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))  # repo root for tools.*
from tools.efficiency import continuity_eval as ce  # noqa: E402
from orcha_cli.notifier import format_persona  # noqa: E402  (conftest puts orcha-cli on sys.path)


def _rich():
    return next(f for f in ce.CONTINUITY_FIXTURES if f["name"] == "rich")


# --- the real-renderer coupling: today's format_persona carries everything → 1.0 baseline ---

def test_real_renderer_full_recall_is_one():
    """The whole point of the baseline: through the REAL renderer, every fixture's digest is
    fully carried forward today. If format_persona stops emitting the digest, this goes RED —
    which is exactly the regression #286/#287 must not introduce silently."""
    rec = ce.evaluate()
    assert rec["mode"] == "offline"
    assert rec["fixtures"] == len(ce.CONTINUITY_FIXTURES)
    assert rec["overall_score"] == 1.0
    for r in rec["per_fixture"]:
        assert r["continuity_score"] == 1.0, f"{r['name']} regressed: {r}"


def test_score_uses_format_persona_output_not_raw_digest():
    """score_boot is fed the rendered boot text, and a fully-rendered rich digest scores 1.0."""
    fx = _rich()
    boot = format_persona(fx["persona"], {"digest": fx["digest"]})
    assert ce.score_boot(fx["digest"], boot)["continuity_score"] == 1.0


# --- mutation teeth: every digest field must be counted and must move the score ---

def test_dropped_open_threads_localizes_and_drops_score():
    fx = _rich()
    full = format_persona(fx["persona"], {"digest": fx["digest"]})
    trimmed = full.split("- Open threads:")[0].rstrip()   # a "curation" that drops the threads
    s = ce.score_boot(fx["digest"], trimmed)
    assert s["continuity_score"] < 1.0
    assert s["per_field"]["open_threads"]["recall"] < s["per_field"]["decisions"]["recall"]


def test_each_field_independently_moves_the_score():
    """Drop each field's distinctive content from the boot in turn; the score must fall every
    time. A scorer that forgot a field (e.g. ignored open_threads) would pass the others but
    fail here for the forgotten one."""
    fx = _rich()
    full = format_persona(fx["persona"], {"digest": fx["digest"]})
    base = ce.score_boot(fx["digest"], full)["continuity_score"]
    assert base == 1.0
    for field in ("current_focus", "decisions", "learnings", "open_threads"):
        # erase that field's unique tokens from the rendered boot
        damaged = full
        for _, text in ce._fact_texts({field: fx["digest"][field]} if field != "current_focus"
                                       else {"current_focus": fx["digest"]["current_focus"]}):
            for tok in ce._tokens(text):
                damaged = damaged.replace(tok, "x" * len(tok))
        score = ce.score_boot(fx["digest"], damaged)["continuity_score"]
        assert score < base, f"erasing {field} did not lower the score — field not counted"


def test_total_amnesia_scores_zero():
    fx = _rich()
    assert ce.score_boot(fx["digest"], "")["continuity_score"] == 0.0


def test_empty_digest_is_vacuously_one():
    empty = {"current_focus": None, "decisions": [], "learnings": [], "open_threads": []}
    s = ce.score_boot(empty, "")
    assert s["facts"] == 0
    assert s["continuity_score"] == 1.0


def test_unicode_and_long_content_survives_rendering():
    fx = next(f for f in ce.CONTINUITY_FIXTURES if f["name"] == "unicode_and_long")
    boot = format_persona(fx["persona"], {"digest": fx["digest"]})
    assert ce.score_boot(fx["digest"], boot)["continuity_score"] == 1.0


# --- fact extraction shapes ---

def test_fact_texts_handles_dicts_bare_strings_and_focus():
    digest = {
        "current_focus": "the focus",
        "decisions": [{"text": "a dict decision"}, "a bare-string decision"],
        "learnings": [{"ref": "ref-only learning"}],   # ref falls back when no text
        "open_threads": [{"text": ""}, {"text": "real thread"}],  # blank entries dropped
    }
    facts = ce._fact_texts(digest)
    fields = [f for f, _ in facts]
    assert fields.count("current_focus") == 1
    assert fields.count("decisions") == 2
    assert fields.count("learnings") == 1
    assert fields.count("open_threads") == 1   # the blank one is dropped


def test_boot_size_is_measured():
    s = ce.score_boot({"current_focus": "x"}, "abcd" * 10)
    assert s["boot_chars"] == 40
    assert s["boot_tokens_est"] == 10   # ceil(40/4)


# --- diff headline logic ---

def _result_file(tmp_path, name, overall, mean_boot, per_fixture):
    rec = {"label": name, "overall_score": overall, "mean_boot_chars": mean_boot,
           "per_fixture": per_fixture}
    p = tmp_path / f"{name}.json"
    p.write_text(json.dumps(rec))
    return p


def test_diff_flags_regression(tmp_path, capsys):
    before = _result_file(tmp_path, "pre", 1.0, 600,
                           [{"name": "rich", "continuity_score": 1.0, "boot_chars": 600}])
    after = _result_file(tmp_path, "post", 0.8, 400,
                          [{"name": "rich", "continuity_score": 0.8, "boot_chars": 400}])
    ce.cmd_diff(argparse.Namespace(files=[str(before), str(after)]))
    out = capsys.readouterr().out
    assert "CONTINUITY REGRESSED" in out
    assert "REGRESSED" in out  # per-fixture line too


def test_diff_flags_win(tmp_path, capsys):
    before = _result_file(tmp_path, "pre", 1.0, 600,
                          [{"name": "rich", "continuity_score": 1.0, "boot_chars": 600}])
    after = _result_file(tmp_path, "post", 1.0, 400,
                         [{"name": "rich", "continuity_score": 1.0, "boot_chars": 400}])
    ce.cmd_diff(argparse.Namespace(files=[str(before), str(after)]))
    out = capsys.readouterr().out
    assert "continuity held" in out
    assert "REGRESSED" not in out


def test_run_writes_result_and_prints_overall(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(ce, "RESULT_DIR", tmp_path / "continuity")
    ce.cmd_run(argparse.Namespace(label="unit", api_base=None, agent_id=None))
    out = capsys.readouterr().out
    assert "OVERALL continuity_score: 1.000" in out
    saved = list((tmp_path / "continuity").glob("*.json"))
    assert len(saved) == 1
    rec = json.loads(saved[0].read_text())
    assert rec["overall_score"] == 1.0 and rec["mode"] == "offline"
