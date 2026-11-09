"""The final decision, one pure function: what lets a task finish without a person, and each thing
that stops it."""

import pytest

from portal_backend import evidence_parse as ep
from portal_backend import qa_final_decision as fd

TESTER, AUTHOR = "tester", "author"
PASSED = {"status": "passed", "passed": 3, "failed": 0, "skipped": 0, "errors": 0, "suites": 1, "unit": "tests", "latest": []}


def qa_line(index=0, text="The total is right", session="s1", request="r1", **extra):
    return {"index": index, "text": text, "status": "proven", "basis": "qa", "strong": True, "evidence": "QA pass",
            "qa_session_id": session, "qa_request_id": request, **extra}


def tests_line(index=0, text="Tests pass"):
    return {"index": index, "text": text, "status": "proven", "basis": "tests", "strong": True, "evidence": "3 tests passed"}


def facts(*items, **over):
    base = {"setting": fd.QUALITY, "subject": "work", "turned_on_by": "owner", "authors": {AUTHOR}, "verdict_agents": {"s1": TESTER},
            "pack": {"dod": {"items": list(items or [qa_line()])}, "flags": [], "tests": {"status": "none"}, "changes": {}}}
    return {**base, **over}


def codes(out):
    return [r["code"] for r in out["reasons"]]


def test_every_line_strongly_proven_by_someone_else_finishes():
    out = fd.decide(facts())
    assert out == {"finish": True, "reasons": [], "lines": []}


def test_a_backend_task_finishes_on_tests_alone_with_no_qa_run():
    assert fd.decide(facts(tests_line()))["finish"]


def test_the_default_setting_never_finishes():
    assert codes(fd.decide(facts(setting=fd.PERSON))) == ["setting_person"]
    assert not fd.decide({})["finish"]


def test_a_mixed_task_goes_to_a_person_with_the_lines_listed():
    weak = {"index": 1, "text": "Docs updated", "status": "proven", "basis": "changes", "strong": False, "evidence": "Docs changed: a.md"}
    out = fd.decide(facts(qa_line(), weak))
    assert codes(out) == ["line_weak"] and [x["index"] for x in out["lines"]] == [1]
    assert out["lines"][0]["why"] == "weak" and out["reasons"][0]["lines"][0]["text"] == "Docs updated"


@pytest.mark.parametrize("item, code", [
    ({"status": "not_proven", "basis": "tests"}, "line_not_proven"),
    ({"status": "needs_human", "basis": "none"}, "line_needs_human"),
    ({"status": "proven", "basis": "changes", "strong": False}, "line_weak"),
    ({"status": "proven", "basis": "qa"}, "line_weak"),  # a pack from before `strong`
])
def test_a_line_that_is_not_strongly_proven_stops_it(item, code):
    assert codes(fd.decide(facts({"index": 0, "text": "A line", **item}))) == [code]


def test_a_verdict_by_the_author_does_not_count():
    assert codes(fd.decide(facts(verdict_agents={"s1": AUTHOR}))) == ["line_own_verdict"]


def test_a_verdict_by_nobody_known_does_not_count():
    assert codes(fd.decide(facts(verdict_agents={}))) == ["line_own_verdict"]


def test_the_agents_own_claim_never_counts():
    claimed = {"index": 0, "text": "It works", "status": "needs_human", "basis": "none", "claim": "I checked it, it works"}
    assert codes(fd.decide(facts(claimed))) == ["line_needs_human"]


def test_proof_older_than_the_finished_work_does_not_count():
    assert codes(fd.decide(facts(stale_requests=["r1"]))) == ["line_stale_proof"]
    assert codes(fd.decide(facts(tests_line(), tests_stale=True))) == ["line_stale_proof"]


@pytest.mark.parametrize("over, code", [
    ({"pack": None}, "no_pack"),
    ({"pack": {"dod": {"items": []}, "flags": []}}, "no_lines"),
    ({"open_runs": 1}, "run_open"),
    ({"stopped": ["The agent stopped."]}, "run_stopped"),
    ({"blocked": 1}, "run_blocked"),
    ({"failed": 1}, "run_failed"),
    ({"inconclusive": 2}, "inconclusive"),
    ({"findings": [{"id": "f", "severity": "major", "title": "It broke"}]}, "open_findings"),
    ({"drafts": 3}, "drafts"),
    ({"proved_nothing": 1}, "proved_nothing"),
    ({"own_check": True}, "own_check"),
    ({"no_outcome": True}, "no_outcome"),
    ({"turned_on_by": None}, "no_owner"),
])
def test_each_refusal_stops_it_and_says_why(over, code):
    out = fd.decide(facts(**over))
    assert not out["finish"] and code in codes(out) and all(r["text"] for r in out["reasons"])


def test_a_risk_flag_stops_it_and_names_the_flag():
    pack = {"dod": {"items": [qa_line()]}, "flags": [{"kind": "migration", "label": "Migration"}], "tests": {}, "changes": {}}
    out = fd.decide(facts(pack=pack))
    assert codes(out) == ["risk_flags"] and "Migration" in out["reasons"][0]["text"]


def test_changes_it_could_not_read_stop_it_since_its_risks_are_unknown():
    pack = {"dod": {"items": [qa_line()]}, "flags": [], "tests": {}, "changes": {"unavailable_runs": [{"run_id": "r"}]}}
    assert codes(fd.decide(facts(pack=pack))) == ["changes_unknown"]


def test_a_qa_steps_own_run_changes_nothing_so_unread_changes_do_not_stop_it():
    pack = {"dod": {"items": [qa_line()]}, "flags": [], "tests": {}, "changes": {"unavailable_runs": [{"run_id": "r"}]}}
    assert fd.decide(facts(pack=pack, tester=True))["finish"]
    pack = {**pack, "flags": [{"kind": "auth", "label": "Auth"}]}
    assert codes(fd.decide(facts(pack=pack, tester=True))) == ["risk_flags"]


def test_failing_tests_stop_it_even_when_every_line_passed_qa():
    pack = {"dod": {"items": [qa_line()]}, "flags": [], "tests": {"status": "failed"}, "changes": {}}
    assert codes(fd.decide(facts(pack=pack))) == ["tests_failing"]


def test_a_run_task_answers_for_its_run_only():
    run = {"setting": fd.QUALITY, "subject": "run", "turned_on_by": "owner"}
    assert fd.decide(run)["finish"]
    assert codes(fd.decide({**run, "drafts": 1})) == ["drafts"]


def test_a_clean_fail_goes_back_and_what_a_person_must_see_does_not():
    assert fd.send_back(facts(failed=1))
    assert not fd.send_back(facts(failed=1, setting=fd.PERSON))
    assert not fd.send_back(facts())
    assert fd.send_back(facts(failed=1, findings=[{"id": "f", "severity": "major"}]))  # a fail with findings goes back to be fixed
    for over in ({"own_check": True}, {"stopped": ["x"]}, {"drafts": 1}, {"inconclusive": 1}, {"blocked": 1}):
        assert not fd.send_back(facts(failed=1, **over)), over


# ---------------------------------------------------------------- strength in assess_dod

def assess(items, tests=None, paths=(), **kw):
    return ep.assess_dod(items, tests=tests or {"status": "none"}, changes={}, changed_paths=list(paths), **kw)


def test_tests_that_ran_and_passed_are_strong():
    item = assess(["All tests pass"], PASSED)[0]
    assert item["status"] == "proven" and item["basis"] == "tests" and item["strong"]


def test_a_changed_file_is_proven_for_display_and_weak():
    named = assess(["`src/total.py` is updated"], paths=["src/total.py"])[0]
    migration = assess(["Add a migration"], paths=["migrations/097_x.sql"])[0]
    docs = assess(["Update the docs"], paths=["docs/a.md"])[0]
    for item in (named, migration, docs):
        assert item["status"] == "proven" and not item["strong"], item


def test_new_tests_are_strong_only_once_they_ran_and_passed():
    assert not assess(["Add tests for the total"], paths=["tests/test_total.py"])[0]["strong"]
    assert assess(["Add tests for the total"], PASSED, paths=["tests/test_total.py"])[0]["strong"]


def test_a_qa_pass_is_strong_and_names_its_session():
    key = ep._line_key("The total is right")
    item = assess(["The total is right"], qa_lines={key: {"verdict": "pass", "session_id": "s1", "request_id": "r1"}})[0]
    assert item["strong"] and item["qa_session_id"] == "s1"
    failed = assess(["The total is right"], qa_lines={key: {"verdict": "fail", "session_id": "s1"}})[0]
    assert failed["status"] == "not_proven" and not failed["strong"]


def test_a_person_must_look_is_never_strong():
    assert not assess(["The screen feels right"])[0]["strong"]
