"""Who has the final say on a finished task: one pure decision, no database (contract:
docs/orcha-qa-plan.md, "Who has the final say").

`qa_settings.final_decision` is `person` by default: nothing finishes here. Under `quality` a task
finishes without a person only when every line of its definition of done has strong proof from
someone other than its author, its evidence pack is clean and no run says otherwise. A QA pass alone
never finishes work it did not cover. `decide` returns the reasons, so a person sees what is left;
`qa_run_tasks` gathers the facts and does what it says.

A subject of `work` is a real task; `run` is a run task with no work of its own to prove, so only
what its run did counts.
"""

from __future__ import annotations

from typing import Any

PERSON = "person"
QUALITY = "quality"
SETTINGS = (PERSON, QUALITY)
#: A run these came out of goes to a person, even when it failed.
_PERSON_ONLY = ("run_stopped", "run_blocked", "inconclusive", "drafts", "own_check")
_LINE_WORDS = {
    "not_proven": "not proven",
    "needs_human": "needs a person to look",
    "weak": "only a changed file shows it, and that is not proof it works",
    "own_verdict": "the verdict came from the agent that did the work",
    "stale_proof": "the proof is older than the finished work",
}


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _run_reasons(f: dict) -> list[dict]:
    """What the runs on this task say, whatever the evidence pack says."""
    out: list[dict] = []
    if f.get("open_runs"):
        out.append({"code": "run_open", "text": "A QA run on this task is still going."})
    for why in f.get("stopped") or []:
        out.append({"code": "run_stopped", "text": f"A QA run stopped before it finished: {why}"})
    if f.get("blocked"):
        out.append({"code": "run_blocked", "text": "A QA run was blocked, so it proves nothing yet."})
    if f.get("failed"):
        out.append({"code": "run_failed", "text": "A QA run failed."})
    if f.get("inconclusive"):
        out.append({"code": "inconclusive", "text": f"{_plural(f['inconclusive'], 'verdict')} came back inconclusive."})
    if f.get("unjudged"):
        out.append({"code": "unjudged", "text": f"{_plural(f['unjudged'], 'line or scenario')} nobody judged."})
    if f.get("findings"):
        out.append({"code": "open_findings", "text": f"{_plural(len(f['findings']), 'blocker or major finding')} still open.",
                    "findings": f["findings"]})
    if f.get("drafts"):
        out.append({"code": "drafts", "text": f"{_plural(f['drafts'], 'drafted scenario')} a person has to review."})
    if f.get("proved_nothing"):
        out.append({"code": "proved_nothing", "text": "A check ran no scenarios or proved none of its lines."})
    if f.get("own_check"):
        out.append({"code": "own_check", "text": "The agent that did the work also ran the check."})
    if f.get("no_outcome"):
        out.append({"code": "no_outcome", "text": "This step has no reported outcome yet."})
    return out


def _line_refusal(item: dict, f: dict) -> str | None:
    """Why this definition-of-done line cannot finish the task, or None. The agent's own `claim`
    is never read: only the status the evidence gave it."""
    status = item.get("status")
    if status == "needs_human":
        return "needs_human"
    if status != "proven":
        return "not_proven"
    if not item.get("strong"):
        return "weak"
    if item.get("basis") == "qa":
        by = (f.get("verdict_agents") or {}).get(item.get("qa_session_id"))
        if not by or by in (f.get("authors") or ()):
            return "own_verdict"
        if item.get("qa_request_id") in (f.get("stale_requests") or ()):
            return "stale_proof"
    elif f.get("tests_stale"):
        return "stale_proof"
    return None


def _pack_reasons(f: dict) -> tuple[list[dict], list[dict]]:
    pack = f.get("pack")
    if not pack:
        return [{"code": "no_pack", "text": "This task has no evidence pack, so nothing here can prove it."}], []
    out: list[dict] = []
    items = (pack.get("dod") or {}).get("items") or []
    if not items:
        out.append({"code": "no_lines", "text": "This task has no definition of done, so there is nothing to prove."})
    refused: list[dict] = []
    for item in items:
        why = _line_refusal(item, f)
        if why:
            refused.append({"index": item.get("index"), "text": item.get("text"), "status": item.get("status"),
                            "basis": item.get("basis"), "strong": bool(item.get("strong")), "evidence": item.get("evidence"),
                            "why": why, "why_text": _LINE_WORDS[why]})
    for why, words in _LINE_WORDS.items():
        lines = [r for r in refused if r["why"] == why]
        if lines:
            out.append({"code": f"line_{why}", "text": f"{_plural(len(lines), 'line')}: {words}.", "lines": lines})
    flags = pack.get("flags") or []
    if flags:
        out.append({"code": "risk_flags", "text": f"{_plural(len(flags), 'risk flag')} on this change: "
                    + ", ".join(str(x.get("label") or x.get("kind")) for x in flags[:4]) + ".", "flags": flags})
    # A QA step's own run tests the work and changes none of it: the work's risks were judged on its own step.
    if (pack.get("changes") or {}).get("unavailable_runs") and not f.get("tester"):
        out.append({"code": "changes_unknown", "text": "Some of this task's changes could not be read, so its risks are unknown."})
    if (pack.get("tests") or {}).get("status") == "failed":
        out.append({"code": "tests_failing", "text": "The latest test run is failing."})
    return out, refused


def decide(facts: dict[str, Any]) -> dict[str, Any]:
    """`{finish, reasons: [{code, text, ...}], lines}`. `finish` is true only when `reasons` is
    empty; `lines` are the definition-of-done lines that stop it, for the person who takes over."""
    reasons: list[dict] = []
    lines: list[dict] = []
    if facts.get("setting") != QUALITY:
        reasons.append({"code": "setting_person", "text": "A person has the final say in this project."})
    elif not facts.get("turned_on_by"):
        reasons.append({"code": "no_owner", "text": "Nobody current is on record as having let Quality decide."})
    reasons += _run_reasons(facts)
    if facts.get("subject", "work") == "work":
        from_pack, lines = _pack_reasons(facts)
        reasons += from_pack
    return {"finish": not reasons, "reasons": reasons, "lines": lines}


def send_back(facts: dict[str, Any]) -> bool:
    """Whether a failed run goes straight back to the agent or the fix step under `quality`. What
    must reach a person stays with a person, so nothing sends it round again unseen."""
    if facts.get("setting") != QUALITY or not facts.get("turned_on_by") or not facts.get("failed"):
        return False
    return not any(r["code"] in _PERSON_ONLY for r in _run_reasons(facts))
