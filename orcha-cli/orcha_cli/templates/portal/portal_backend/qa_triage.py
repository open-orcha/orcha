"""Orcha QA triage (migration 096; contract: docs/orcha-qa-plan.md, "Triage"; a port of the original
`runs/triage.py`, `runs/reproduce.py` and `severity/{rubric,review,store}.py`).

A finding is a claim, not a fix order. A triage agent re-runs only the failing part, at least three
times ("fails 3 of 3" and "fails 1 of 3" are different bugs), reads the code, re-rates the severity
with the rubric and finds the root cause; `triage_finding` records it here. There are no model calls
in this module: the agent does the thinking, and this is what its diagnosis does, automatically.

    product_bug blocker/major  stays open, confirmed: it goes to the fix step, or is filed
    product_bug minor/trivial  filed as a backlog task; it does not block
    test_issue                 a suggestion on the scenario for a person
    flaky                      the scenario is quarantined with the rate
    environment                the request ends blocked; a person is told what is missing
    agent_error                the finding is dismissed with the reason
    duplicate                  merged into the open finding it repeats
    not_a_bug                  a person's call only: kept in `qa_memory`, never reported again

`decide` rolls the diagnoses up to the request's outcome: `fix`, `clear` or `needs_person`. Like every
QA result it never verifies a task. A validated scenario is never edited: quarantine is the one
automatic change to one, and the suggestion waits for a person.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import qa_scenarios, qa_store as qs
from portal_backend import sql
from portal_backend.agent_status import log_event

CLASSIFICATIONS = ("product_bug", "test_issue", "environment", "flaky", "agent_error", "duplicate", "not_a_bug")
#: What an agent may conclude. `not_a_bug` is a person's call.
AGENT_CLASSIFICATIONS = tuple(c for c in CLASSIFICATIONS if c != "not_a_bug")
#: Diagnoses that rest on re-running the failure.
REPRODUCED_BY_RUNNING = ("product_bug", "test_issue", "flaky")
MIN_ATTEMPTS = 3
CONFIRMED_SEVERITIES = ("blocker", "major")
DEFAULT_MAX_PER_RUN = 2
AUTO_TRIAGE = ("off", "critical", "all")
#: The levels, most severe first (the original's `cosmetic` is Orcha's `trivial`).
LEVELS = ("blocker", "major", "minor", "trivial")

RUBRIC = """\
Rate severity by impact on the people and agents who use the app, not by whether the screen \
technically works. Ask:

1. task: can the user, or another actor (an agent, a teammate, a background job), finish what they came to do?
2. stuck: is something stuck with no way out: no control that frees it, and no timeout, retry, reminder or escalation that ever fires?
3. data: is data lost, wrong where it is kept, or silently not saved? (A screen that shows an old value until it is reopened, while what was saved is right, is friction, not lost data.)
4. purpose: is the core purpose of a feature broken (an expiry that never expires, a reminder that never fires, a filter that filters nothing)?
5. reach: how many users or flows does it reach: a main path, or one corner of one screen?
6. workaround: is there a workaround a normal user would find without being told?
7. security: is it security or privacy relevant (data shown to the wrong person, a secret in the open, an action allowed that should be refused)?

- blocker: a crash or hang, data loss or corruption, nobody can get past it on a main path, or a \
security or privacy breach.
- major: a feature does not do its job, or someone is stuck and nothing will ever free them, even \
when the screen looks fine and other paths work.
- minor: it works, with friction a user gets past on their own, and nothing is lost or stuck.
- trivial: visual or copy only; nothing behaves differently.

When in doubt: if a person or an agent stays stuck until someone notices by hand, it is at least \
major. A time-based failure (an expiry, a reminder, a retry or a timeout that never happens) breaks \
the feature's purpose and is major, even when nothing on screen shows an error. "Works with \
friction" applies only when the thing does finish. Reach and a known workaround move a rating by \
one level at most, and never lower a stuck actor, lost data or a security problem below major."""


def rate_words(reproductions: Optional[int], attempts: Optional[int]) -> Optional[str]:
    """"fails 3 of 3"."""
    return None if not attempts else f"fails {reproductions or 0} of {attempts}"


def _check(classification: str, reproduced: Optional[bool], attempts: Optional[int], reproductions: Optional[int],
           duplicate_of: Optional[str]) -> None:
    if classification not in AGENT_CLASSIFICATIONS:
        if classification == "not_a_bug":
            raise HTTPException(403, "Only a person can mark a finding not a bug.")
        raise HTTPException(400, f"classification must be one of {', '.join(AGENT_CLASSIFICATIONS)}")
    if classification == "duplicate" and not duplicate_of:
        raise HTTPException(400, "A duplicate names the finding it repeats (duplicate_of).")
    if classification not in REPRODUCED_BY_RUNNING:
        return
    if (attempts or 0) < MIN_ATTEMPTS:
        raise HTTPException(400, f"Attempt it at least {MIN_ATTEMPTS} times: \"fails 3 of 3\" and \"fails 1 of 3\" are different bugs.")
    if reproductions is None or not 0 <= reproductions <= attempts:
        raise HTTPException(400, "reproductions counts the attempts that failed, from 0 to attempts.")
    if reproduced is not None and reproduced != (reproductions > 0):
        raise HTTPException(400, "reproduced and reproductions disagree.")
    if classification == "product_bug" and not reproductions:
        raise HTTPException(400, "A product bug that never reproduced is not confirmed: call it flaky, or an agent error.")
    if classification == "flaky" and not 0 < reproductions < attempts:
        raise HTTPException(400, "Flaky means it failed some of the attempts, not all and not none.")


def _scenario_of(cur, f: dict, named: Optional[str]) -> Optional[dict]:
    """The scenario behind a finding: as named, as filed, or the one scenario its session failed."""
    sid = named or f.get("scenario_id")
    if not sid:
        cur.execute("SELECT DISTINCT scenario_id FROM qa_verdicts WHERE session_id=%s AND verdict='fail'", (str(f["session_id"]),))
        rows = cur.fetchall()
        sid = rows[0]["scenario_id"] if len(rows) == 1 else None
    if not sid:
        return None
    qs.require_uuid(str(sid), "scenario_id")
    row = qs.load_scenario(cur, str(sid))
    if str(row["container_id"]) != str(f["container_id"]):
        raise HTTPException(400, "that scenario belongs to another project")
    return row


def _quarantine(cur, row: dict, attempts: int, reproductions: int) -> bool:
    """A flaky scenario stops failing a gate alone, with the rate as its reason. Its clean runs
    bring it back; only a validated scenario can be quarantined."""
    if row.get("quarantined_at") or row["status"] != "validated":
        return False
    qa_scenarios._update(cur, str(row["id"]), {
        "quarantined_at": qs.now(), "quarantine_reason": f"Flaky: {rate_words(reproductions, attempts)}", "quarantine_clean_runs": 0,
        "updated_at": qs.now()})
    return True


def _rerate(cur, f: dict, severity: Optional[str], reason: Optional[str]) -> None:
    """The rubric's rating, beside the original. A person's rating stays theirs."""
    if not severity or severity == f["severity"] or f.get("severity_by") == "person":
        return
    if severity not in LEVELS:
        raise HTTPException(400, f"severity must be one of {', '.join(LEVELS)}")
    cur.execute("""UPDATE qa_findings SET severity=%s, severity_original=COALESCE(severity_original, %s), severity_reported=COALESCE(severity_reported, %s),
                          severity_by='triage', severity_reason=%s WHERE id=%s""",
                (severity, f["severity"], f["severity"], reason, str(f["id"])))


def record_diagnosis(cur, f: dict, who: dict, *, classification: str, reproduced: Optional[bool], attempts: Optional[int],
                     reproductions: Optional[int], root_cause: Optional[str], severity: Optional[str] = None,
                     duplicate_of: Optional[str] = None, note: Optional[str] = None, scenario_id: Optional[str] = None,
                     frame_ids: Optional[list[str]] = None, needs_person: bool = False) -> dict:
    """Store one diagnosis and do what it means. Returns the finding plus `action`: what happened,
    and `file` true when the route must file the task once this transaction is committed."""
    _check(classification, reproduced, attempts, reproductions, duplicate_of)
    fid, cid = str(f["id"]), str(f["container_id"])
    frames = qs.require_frames_in(cur, cid, frame_ids or [])
    _rerate(cur, f, severity, root_cause or note)
    target = None
    if duplicate_of:
        qs.require_uuid(duplicate_of, "duplicate_of")
        target = qs.load_finding(cur, duplicate_of)
        if str(target["container_id"]) != cid or str(target["id"]) == fid:
            raise HTTPException(400, "A duplicate repeats another finding of this project.")
        while target.get("duplicate_of"):
            target = qs.load_finding(cur, str(target["duplicate_of"]))
    scenario = _scenario_of(cur, f, scenario_id) if classification in ("flaky", "test_issue") else None
    diagnosis = {"classification": classification, "reproduced": reproduced if reproduced is not None else (bool(reproductions) if reproductions is not None else None),
                 "attempts": attempts, "reproductions": reproductions, "rate": rate_words(reproductions, attempts),
                 "root_cause": root_cause, "note": note, "evidence_frame_ids": frames, "needs_person": bool(needs_person),
                 "by_agent_id": who["id"], "at": qs.iso(qs.now())}
    action, status = "kept", None
    level = severity if severity in LEVELS and f.get("severity_by") != "person" else f["severity"]
    file_it = False
    if classification == "product_bug" and level in CONFIRMED_SEVERITIES:
        action = "confirmed"
    elif classification == "product_bug":
        action, file_it = "backlog", f["status"] == "open"
    elif classification == "test_issue":
        action = "no_scenario"
        if scenario is not None:
            qa_scenarios._suggest(cur, scenario, who, {}, f"Triage: this finding is the test's, not the app's: {root_cause or note or f['title']}", str(f["session_id"]))
            action = "suggested"
    elif classification == "flaky":
        action = "no_scenario"
        if scenario is not None:
            action = "quarantined" if _quarantine(cur, scenario, attempts or 0, reproductions or 0) else "already_quarantined"
    elif classification == "environment":
        action = "blocked"
    elif classification == "agent_error":
        action, status = "dismissed", "dismissed"
    elif classification == "duplicate":
        action, status = "merged", "dismissed"
        merged = dict(qs._json(target.get("triage"), None) or {})
        merged["merged_from"] = [*merged.get("merged_from", []), fid]
        cur.execute("UPDATE qa_findings SET triage=%s WHERE id=%s", (qs.dumps(merged), str(target["id"])))
    diagnosis["action"] = action
    if scenario is not None:
        diagnosis["scenario_id"] = str(scenario["id"])
    cur.execute("UPDATE qa_findings SET triage=%s, duplicate_of=%s, status=COALESCE(%s, status) WHERE id=%s",
                (qs.dumps(diagnosis), str(target["id"]) if target else None, status, fid))
    log_event(cur, cid, "human" if who["kind"] == "human" else "ai", who["id"], "qa_finding", fid, "qa_finding_triaged",
              {"classification": classification, "action": action, "rate": diagnosis["rate"], "severity": level})
    return {**(qs.public(qs.load_finding(cur, fid)) or {}), "action": action, "file": file_it}


def mark_not_a_bug(cur, f: dict, who: dict, reason: str) -> dict:
    """A person's call: the finding is dismissed, and the memory keeps that behaviour from being
    reported again."""
    fid, cid = str(f["id"]), str(f["container_id"])
    text = f"Not a bug: {f['title']}. {reason.strip()}"
    cur.execute("""INSERT INTO qa_memory (id, container_id, kind, text, finding_id, scenario_id, screen_key, created_by_agent_id, created_at)
                   VALUES (%s,%s,'not_a_bug',%s,%s,%s,%s,%s,%s)""",
                (qs.new_id(), cid, text, fid, f.get("scenario_id"), f.get("screen_key"), who["id"], qs.now()))
    triage = {**(qs._json(f.get("triage"), None) or {}), "classification": "not_a_bug", "note": reason.strip(), "action": "remembered",
              "by_agent_id": who["id"], "at": qs.iso(qs.now())}
    cur.execute("UPDATE qa_findings SET triage=%s, status='dismissed' WHERE id=%s", (qs.dumps(triage), fid))
    log_event(cur, cid, "human", who["id"], "qa_finding", fid, "qa_finding_not_a_bug", {"reason": reason.strip()})
    return qs.public(qs.load_finding(cur, fid)) or {}


def memory(cur, cid: str) -> list[dict]:
    cur.execute("SELECT * FROM qa_memory WHERE container_id=%s ORDER BY created_at DESC", (cid,))
    return [qs.public(r) or {} for r in cur.fetchall()]


def add_memory(cur, cid: str, who: dict, kind: str, text: str, *, scenario_id: Optional[str], screen_key: Optional[str]) -> dict:
    mid = qs.new_id()
    cur.execute("""INSERT INTO qa_memory (id, container_id, kind, text, scenario_id, screen_key, created_by_agent_id, created_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""", (mid, cid, kind, text.strip(), scenario_id, screen_key, who["id"], qs.now()))
    cur.execute("SELECT * FROM qa_memory WHERE id=%s", (mid,))
    return qs.public(cur.fetchone()) or {}


def counts_against_gate(f: dict) -> bool:
    """A blocker or major finding fails a request until triage says it is not the app's bug."""
    triage = qs._json(f.get("triage"), None) or {}
    return not triage.get("classification") or triage["classification"] == "product_bug"


def rows_of(cur, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    cur.execute(f"SELECT * FROM qa_findings WHERE {sql.in_list('id')} ORDER BY created_at", (sql.list_param(ids),))
    return [dict(r) for r in cur.fetchall()]


def decide(cur, req: dict) -> tuple[str, str, dict]:
    """A triage request rolled up: `(status, decision, result)`. `fix`: a confirmed blocker or major
    remains, and only those go on. `needs_person`: a finding has no diagnosis, the agent called it a
    judgement call, or the environment stopped it (the request then ends blocked). `clear`: nothing
    left blocks. Reading only: it never verifies anything."""
    rows = rows_of(cur, [str(i) for i in qs._json(req.get("finding_ids"), [])])
    diagnoses = [{"id": str(f["id"]), "title": f["title"], "severity": f["severity"], "severity_original": f.get("severity_original"),
                  "expected": f.get("expected"), "actual": f.get("actual"), "frame_ids": qs._json(f.get("frame_ids"), []),
                  **{k: v for k, v in (qs._json(f.get("triage"), None) or {}).items() if k != "by_agent_id"}} for f in rows]
    undone = [d for d in diagnoses if not d.get("classification")]
    environment = [d for d in diagnoses if d.get("classification") == "environment"]
    judgement = [d for d in diagnoses if d.get("needs_person")]
    confirmed = [d for d in diagnoses if d.get("classification") == "product_bug" and d["severity"] in CONFIRMED_SEVERITIES]
    if environment or not rows:
        status, decision = "blocked", "needs_person"
    elif undone:
        status, decision = "blocked", "needs_person"
    elif judgement:
        status, decision = "blocked", "needs_person"
    elif confirmed:
        status, decision = "failed", "fix"
    else:
        status, decision = "passed", "clear"
    bits = [f"Triage of {len(rows)} finding{'s' if len(rows) != 1 else ''}: {decision.replace('_', ' ')}"]
    if confirmed:
        bits.append(f"{len(confirmed)} confirmed")
    if undone:
        bits.append(f"{len(undone)} not diagnosed")
    if environment:
        bits.append("missing: " + "; ".join(str(d.get("root_cause") or d.get("note") or d["title"]) for d in environment)[:300])
    result = {"summary": ": ".join(bits[:1]) + (": " + ", ".join(bits[1:]) if len(bits) > 1 else "") + ".", "lines": [], "scenarios": [],
              "diagnoses": diagnoses, "confirmed_ids": [d["id"] for d in confirmed], "finding_ids": [d["id"] for d in diagnoses],
              "findings": [], "draft_ids": [], "session_ids": [], "failing_findings": len(confirmed)}
    return status, decision, result


def confirmed_findings(result: dict) -> list[dict]:
    """Only what triage confirmed, for `round_context`: reproduction and root cause in the text. The
    screenshots go in the note, so the stall rule can compare the text of two rounds."""
    out = []
    for d in result.get("diagnoses") or []:
        if d["id"] not in (result.get("confirmed_ids") or []):
            continue
        parts = [d["title"]]
        if d.get("rate"):
            parts.append(str(d["rate"]))
        if d.get("root_cause"):
            parts.append(f"root cause: {d['root_cause']}")
        if d.get("expected"):
            parts.append(f"expected: {d['expected']}")
        out.append({"id": d["id"][:80], "text": "; ".join(parts)[:3900], "severity": d["severity"]})
    return out[:50]


def confirmed_note(result: dict) -> str:
    frames = [x for d in result.get("diagnoses") or [] if d["id"] in (result.get("confirmed_ids") or [])
              for x in [*d.get("frame_ids", []), *d.get("evidence_frame_ids", [])]]
    note = result.get("summary") or ""
    if frames:
        note += " Screenshots: " + " ".join(f"/api/qa/frames/{x}" for x in dict.fromkeys(frames))
    return note[:4000]


def for_auto(cur, req: dict, conf: dict, result: dict) -> list[str]:
    """The failed request's findings automatic triage takes: none when it is off."""
    mode = conf.get("auto_triage") or "off"
    if mode == "off" or req["kind"] == "triage" or req["status"] != "failed":
        return []
    wanted = [f for f in result.get("findings") or [] if mode == "all" or f["severity"] in CONFIRMED_SEVERITIES]
    return [f["id"] for f in wanted][:int(conf.get("max_per_run") or DEFAULT_MAX_PER_RUN)]


def inbox(cur, cid: str, limit: int = 100) -> dict:
    """The Triage inbox: untriaged, needs a person, recently decided."""
    # A finding a person filed as a task has its decision, with or without a diagnosis.
    cols = "f.*, s.platform AS platform"
    join = "FROM qa_findings f LEFT JOIN qa_sessions s ON s.id=f.session_id"
    cur.execute(f"SELECT {cols} {join} WHERE f.container_id=%s AND f.status='open' AND f.triage IS NULL ORDER BY f.created_at DESC LIMIT %s", (cid, limit))
    untriaged = [qs.public(r) or {} for r in cur.fetchall()]
    cur.execute(f"SELECT {cols} {join} WHERE f.container_id=%s AND (f.triage IS NOT NULL OR f.status='filed') ORDER BY f.created_at DESC LIMIT %s", (cid, limit))
    decided = [qs.public(r) or {} for r in cur.fetchall()]
    needs = [f for f in decided if (f["triage"] or {}).get("needs_person") or (f["triage"] or {}).get("classification") == "environment"]
    rest = [f for f in decided if f not in needs]
    qs.with_names(cur, untriaged + decided)
    return {"untriaged": untriaged, "needs_person": needs, "decided": rest}
