"""Orcha QA scenarios: propose, revise, status, suggestions and the markdown export.

The human gate (docs/orcha-qa-plan.md): an agent drafts, a person validates. So:

- `propose` creates a draft, or updates the draft of the same name; a scenario that is no
  longer a draft (validated, paused, retired) is never changed by a proposal: the proposal
  becomes a suggestion a person accepts or dismisses.
- `revise` lets an agent change a draft only (anything else files a suggestion, as above); a
  person may change any field, the status included.
- `set_status` and `decide` are for people only (the routes check the actor's kind).

Every change is a version (`qa_scenario_versions`): `save_version` runs after each write here, so
History can list and restore them. A scenario's lifecycle (`set_status`, migration 095) adds
quarantine (stored as validated with `quarantined_at`: it runs, a failure does not fail the check
run, and clean passes release it), an until date, an issue to wait on and what replaced it.

The export is a minimal renderer (`# name`, metadata lines, numbered criteria); the full
format is the CLI's `orcha_cli/qa/scenario_format.py`.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
import secrets as _secrets
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import qa_examples, qa_store as qs
from portal_backend import qa_conditions
from portal_backend import sql

try:
    import secret_box
except ImportError:
    from orcha_cli import secret_box

STATUSES = ("draft", "validated", "paused", "retired")
#: What a person can pick: `quarantined` is stored as validated with `quarantined_at` set.
EFFECTIVE_STATUSES = ("draft", "validated", "quarantined", "paused", "retired")
SOURCES = ("authored", "generated", "walk")
EVIDENCE_STATUSES = ("verified", "unconfirmed", "code_only")
#: Fields a proposal or a revision may set (status is separate: people only).
FIELDS = ("name", "platform", "category", "persona", "description", "criteria", "checks", "data", "needs", "tags",
          "depends_on", "source", "walk_id", "session_id", "task_id", "fresh", "permissions", "session", "shared",
          "examples", "seed", "cleanup", "events", "conditions")
JSON_FIELDS = frozenset({"criteria", "checks", "data", "needs", "tags", "depends_on", "examples", "seed", "cleanup", "events"})
#: What a version keeps: a scenario's editable surface.
SNAPSHOT_FIELDS = ("name", "category", "persona", "session", "description", "criteria", "status", "status_reason",
                   "depends_on", "data", "needs", "tags", "checks", "seed", "cleanup", "events", "examples", "fresh",
                   "permissions", "shared", "platform", "conditions")
#: Clean passes (a check where every criterion passed) that release a quarantined scenario.
QUARANTINE_RELEASE_CLEAN = 5
#: The newest checks a scenario's health reads.
HEALTH_WINDOW = 10


# ---------------------------------------------------------------- reading

def effective(row: dict) -> str:
    """The status a person reads: `quarantined` is validated with `quarantined_at` set."""
    status = str(row.get("status") or "draft")
    return "quarantined" if status == "validated" and row.get("quarantined_at") else status


def counts_for_coverage(row: dict) -> bool:
    return effective(row) in ("validated", "quarantined", "paused")


def evidence_of(cur, scenario_id: str) -> list[dict]:
    cur.execute("SELECT * FROM qa_scenario_evidence WHERE scenario_id=%s ORDER BY criterion_index, created_at",
                (scenario_id,))
    return [qs.public(r) for r in cur.fetchall()]


def detail(cur, row: dict) -> dict:
    """A scenario with its evidence, the frames that evidence shows, its walk (and flow), its
    open suggestions and its latest verdict per criterion."""
    sid = str(row["id"])
    out = qs.public(row)
    out["evidence"] = evidence_of(cur, sid)
    frame_ids = [e["frame_id"] for e in out["evidence"] if e.get("frame_id")]
    walk = None
    if row.get("walk_id"):
        cur.execute("SELECT * FROM qa_walks WHERE id=%s", (str(row["walk_id"]),))
        w = cur.fetchone()
        if w:
            walk = qs.public(w)
            cur.execute("SELECT id, key, name FROM qa_flows WHERE id=%s", (str(w["flow_id"]),))
            walk["flow"] = qs.public(cur.fetchone())
            frame_ids += [st.get("frame_id") for st in walk["steps"] if isinstance(st, dict) and st.get("frame_id")]
    out["walk"] = walk
    frames = []
    ids = list(dict.fromkeys(f for f in frame_ids if f))
    if ids:
        cur.execute(f"SELECT id, width, height, created_at FROM qa_frames WHERE {sql.in_list('id')}",
                    (sql.list_param(ids),))
        by_id = {str(r["id"]): qs.public(r) for r in cur.fetchall()}
        frames = [{**by_id[f], "url": f"/api/qa/frames/{f}"} for f in ids if f in by_id]
    out["frames"] = frames
    cur.execute("SELECT * FROM qa_scenario_suggestions WHERE scenario_id=%s AND status='proposal' ORDER BY created_at",
                (sid,))
    out["suggestions"] = [qs.public(r) for r in cur.fetchall()]
    cur.execute("SELECT * FROM qa_verdicts WHERE scenario_id=%s ORDER BY created_at DESC", (sid,))
    out["verdicts"] = qs.newest_verdicts([qs.public(r) for r in cur.fetchall()])
    out["lint"] = lint_notes(out)
    return out


def lint_notes(row: dict) -> list[dict]:
    """The scenario format's style notes, in plain words ([] in a portal image without the CLI).
    Never blocks anything."""
    fmt = _v3_format()
    if fmt is None:
        return []
    data = {str(k): str(v) for k, v in (row.get("data") or {}).items()}
    notes = fmt.lint_scenario(fmt.from_row(row), data or None)
    return [{"severity": n.severity, "message": n.message, "criterion": n.criterion} for n in notes]


def list_scenarios(cur, cid: str, platform: Optional[str], status: Optional[str]) -> list[dict]:
    q, args = "SELECT * FROM qa_scenarios WHERE container_id=%s", [cid]
    if platform:
        q += " AND (platform=%s OR shared=%s)"
        args += [platform, True]
    if status:
        q += " AND status=%s"
        args.append(status)
    cur.execute(q + " ORDER BY platform, name", tuple(args))
    rows = [qs.public(r) for r in cur.fetchall()]
    cur.execute("""SELECT v.*, x.platform AS run_platform FROM qa_verdicts v JOIN qa_sessions x ON x.id = v.session_id
                    WHERE v.container_id=%s ORDER BY v.created_at DESC""", (cid,))
    latest: dict[str, list[dict]] = {}
    by_kind: dict[str, dict[str, list[dict]]] = {}
    tries: dict[str, dict[str, list[dict]]] = {}
    for r in cur.fetchall():
        row = qs.public(r)
        sid = str(r["scenario_id"])
        latest.setdefault(sid, []).append(row)
        by_kind.setdefault(sid, {}).setdefault(str(r["run_platform"]), []).append(row)
        tries.setdefault(sid, {}).setdefault(str(r["session_id"]), []).append(row)
    for s in rows:
        s["verdicts"] = qs.newest_verdicts(latest.get(s["id"], []))
        n = len(s.get("criteria") or [])
        s["by_platform"] = {k: platform_result(n, qs.newest_verdicts(v)) for k, v in by_kind.get(s["id"], {}).items()}
        s["health"] = health_word(n, tries.get(s["id"], {}))
    return rows


def rollup(criteria: int, verdicts: list[dict]) -> Optional[str]:
    """One word for the newest verdict per criterion: any failure wins, then blocked, then
    inconclusive; it passed only when every criterion passed."""
    if not verdicts:
        return None
    words = {v["verdict"] for v in verdicts}
    for word in ("fail", "blocked", "inconclusive"):
        if word in words:
            return word
    return "pass" if len({v["criterion_index"] for v in verdicts}) >= criteria else "inconclusive"


def platform_result(criteria: int, verdicts: list[dict]) -> dict:
    """A scenario's newest result on one platform: `{outcome, at, reason}`, the reason being the
    note of what stopped it (the Platform fit note reads "criteria don't fit" there)."""
    outcome = rollup(criteria, verdicts)
    notes = [v.get("note") for v in verdicts if v["verdict"] == outcome and v.get("note")]
    at = max((str(v.get("created_at") or "") for v in verdicts), default=None)
    return {"outcome": outcome, "at": at, "reason": notes[0] if notes and outcome != "pass" else None}


def attempts_of(criteria: int, sessions: dict[str, list[dict]]) -> list[dict]:
    """One attempt per check session, newest first: `{session_id, at, outcome, note}`."""
    out = []
    for sid, verdicts in sessions.items():
        result = platform_result(criteria, qs.newest_verdicts(sorted(verdicts, key=lambda x: str(x.get("created_at") or ""), reverse=True)))
        out.append({"session_id": sid, "at": result["at"] or "", "outcome": result["outcome"], "note": result["reason"]})
    return sorted(out, key=lambda a: a["at"], reverse=True)


def health_word(criteria: int, sessions: dict[str, list[dict]]) -> Optional[str]:
    """`flaky`: passes and fails turn and turn about in the newest checks; `failing`: its newest
    checks failed; `healthy`: its newest check passed; None until it was checked."""
    tries = [a["outcome"] for a in attempts_of(criteria, sessions)[:HEALTH_WINDOW] if a["outcome"] in ("pass", "fail")]
    if not tries:
        return None
    flips = sum(1 for a, b in zip(tries, tries[1:]) if a != b)
    if flips >= 2:
        return "flaky"
    return "healthy" if tries[0] == "pass" else "failing"


# ---------------------------------------------------------------- checking what is sent

def _links(cur, cid: str, fields: dict) -> dict:
    """Validate walk/session/task ids against the project; a walk names its session, a
    session its task, when those are not sent."""
    out = dict(fields)
    if out.get("walk_id"):
        w = qs.load_walk(cur, out["walk_id"])
        if str(w["container_id"]) != cid:
            raise HTTPException(400, "that walk belongs to another project")
        if not out.get("session_id"):
            out["session_id"] = str(w["session_id"])
    if out.get("session_id"):
        s = qs.load_session(cur, out["session_id"])
        if str(s["container_id"]) != cid:
            raise HTTPException(400, "that QA session belongs to another project")
        if not out.get("task_id") and s.get("task_id"):
            out["task_id"] = str(s["task_id"])
    if out.get("task_id"):
        qs.require_task_in(cur, cid, out["task_id"])
    if out.get("source") is not None and out["source"] not in SOURCES:
        raise HTTPException(400, f"source must be one of {', '.join(SOURCES)}")
    return out


def _check_checks(checks: Optional[list[dict]], n_criteria: int) -> None:
    """`checks` is [{criterion_index: int|null, line}]; an index must name a criterion."""
    for c in checks or []:
        i = c.get("criterion_index") if isinstance(c, dict) else None
        if i is not None and not 0 <= int(i) < n_criteria:
            raise HTTPException(400, f"a check names criterion {i}; this scenario has criteria 0 to {n_criteria - 1}")


def _check_evidence(cur, cid: str, evidence: Optional[list[dict]], n_criteria: int) -> None:
    if evidence is None:
        return
    for e in evidence:
        i = e["criterion_index"]
        if not 0 <= i < n_criteria:
            raise HTTPException(400, f"evidence names criterion {i}; this scenario has criteria 0 to {n_criteria - 1}")
        if e["status"] not in EVIDENCE_STATUSES:
            raise HTTPException(400, f"evidence status must be one of {', '.join(EVIDENCE_STATUSES)}")
    qs.require_frames_in(cur, cid, [e["frame_id"] for e in evidence if e.get("frame_id")])


def _write_evidence(cur, cid: str, scenario_id: str, evidence: Optional[list[dict]]) -> None:
    """The evidence sent replaces the scenario's evidence (it is the drafter's whole account)."""
    if evidence is None:
        return
    cur.execute("DELETE FROM qa_scenario_evidence WHERE scenario_id=%s", (scenario_id,))
    for e in evidence:
        cur.execute(
            """INSERT INTO qa_scenario_evidence (id, container_id, scenario_id, criterion_index, status, frame_id,
                                                 code_ref, note, created_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (qs.new_id(), cid, scenario_id, e["criterion_index"], e["status"], e.get("frame_id"),
             e.get("code_ref"), e.get("note"), qs.now()),
        )


def _apply(cur, scenario_id: str, fields: dict) -> None:
    sets, args = [], []
    for k in FIELDS:
        if k not in fields:
            continue
        sets.append(f"{k}=%s")
        args.append(qs.dumps(fields[k]) if k in JSON_FIELDS else qa_conditions.dumps(fields[k]) if k == "conditions" else fields[k])
    if not sets:
        return
    sets.append("updated_at=%s")
    args.append(qs.now())
    try:
        cur.execute(f"UPDATE qa_scenarios SET {', '.join(sets)} WHERE id=%s", (*args, scenario_id))
    except Exception as e:  # noqa: BLE001 - a rename onto another scenario's name
        if sql.is_unique_violation(e):
            raise HTTPException(409, "another scenario of this platform already has that name") from e
        raise


def _link_walk(cur, scenario_id: str, walk_id: Optional[str]) -> None:
    if walk_id:
        cur.execute("UPDATE qa_walks SET scenario_id=%s WHERE id=%s", (scenario_id, walk_id))


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, default=str)


def _suggest(cur, row: dict, who: dict, proposed: dict, reason: Optional[str], session_id: Optional[str]) -> dict:
    """File (or find the identical open) suggestion against a scenario that is not a draft."""
    cid, sid = str(row["container_id"]), str(row["id"])
    proposed = {k: v for k, v in proposed.items() if v is not None}
    cur.execute("SELECT * FROM qa_scenario_suggestions WHERE scenario_id=%s AND status='proposal'", (sid,))
    for r in cur.fetchall():
        if _canonical(qs._json(r["proposed"], {})) == _canonical(proposed):
            return qs.public(r)
    gid = qs.new_id()
    cur.execute(
        """INSERT INTO qa_scenario_suggestions (id, container_id, scenario_id, proposed, reason, status, session_id,
                                                agent_id, created_at)
           VALUES (%s,%s,%s,%s,%s,'proposal',%s,%s,%s)""",
        (gid, cid, sid, qs.dumps(proposed), reason, session_id, who["id"], qs.now()),
    )
    return qs.public(qs.load_suggestion(cur, gid))


# ---------------------------------------------------------------- versions

def _snapshot(row: dict) -> dict:
    pub = qs.public(row)
    return {k: pub.get(k) for k in SNAPSHOT_FIELDS}


def save_version(cur, sid: str, who: Optional[dict], note: Optional[str] = None) -> Optional[int]:
    """Append the scenario as it is now, unless nothing a version keeps changed. `note` is the
    History line of a status change; it is not a field and a restore leaves it out."""
    snapshot = _snapshot(qs.load_scenario(cur, sid))
    cur.execute("SELECT version, snapshot FROM qa_scenario_versions WHERE scenario_id=%s ORDER BY version DESC LIMIT 1", (sid,))
    last = cur.fetchone()
    if last:
        was = qs._json(last["snapshot"], {})
        if not note and _canonical({k: was.get(k) for k in SNAPSHOT_FIELDS}) == _canonical(snapshot):
            return None
    number = int(last["version"]) + 1 if last else 1
    if note:
        snapshot["status_note"] = note
    row = qs.load_scenario(cur, sid)
    cur.execute(
        """INSERT INTO qa_scenario_versions (id, container_id, scenario_id, version, snapshot, saved_by_agent_id, saved_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s)""",
        (qs.new_id(), str(row["container_id"]), sid, number, qs.dumps(snapshot), who["id"] if who else None, qs.now()),
    )
    return number


def _baseline_version(cur, sid: str, who: Optional[dict]) -> None:
    """A scenario from before versions keeps what it was: its first change saves that first."""
    cur.execute("SELECT 1 AS one FROM qa_scenario_versions WHERE scenario_id=%s LIMIT 1", (sid,))
    if cur.fetchone() is None:
        save_version(cur, sid, who)


def _save(cur, sid: str, who: dict, fields: dict) -> None:
    if not any(k in fields for k in FIELDS):
        return
    _baseline_version(cur, sid, who)
    _apply(cur, sid, fields)
    save_version(cur, sid, who)


#: Fields a new draft may carry beyond the columns `propose` always writes.
EXTRA_FIELDS = ("fresh", "permissions", "session", "shared", "examples", "seed", "cleanup", "events", "conditions")


class _SecretStore:
    """Where a sealed Examples cell's value lives: `qa_example_secrets`, encrypted, read only by the person
    who holds the eye on it (the reveal route) and by a check run's agent, never by a list."""

    def __init__(self, cur, cid: str, sid: str) -> None:
        self.cur, self.cid, self.sid = cur, cid, sid

    def store(self, kind: str, value: str) -> tuple[str, str]:
        if not secret_box.master_key_present():
            raise HTTPException(503, "encrypted storage is disabled: ORCHA_SECRET_KEY is not set in the "
                                     "portal environment, so a secret value can't be kept.")
        ref = "sec_" + _secrets.token_hex(12)
        self.cur.execute("INSERT INTO qa_example_secrets (id, container_id, scenario_id, value, created_at) VALUES (%s,%s,%s,%s,%s)",
                         (ref, self.cid, self.sid, secret_box.seal(value), qs.now()))
        return ref, ""


def _sealed(cur, cid: str, sid: str, fields: dict) -> dict:
    """`fields` with the plain values of an Examples table's secret columns moved to
    `qa_example_secrets`: the table keeps `secret:sec_<id>`, so a value never reaches the list, a
    version, an export or a suggestion."""
    if fields.get("examples") is None:
        return fields
    try:
        return {**fields, "examples": qa_examples.seal(fields["examples"], _SecretStore(cur, cid, sid))}
    except qa_examples.ExamplesError as e:
        raise HTTPException(400, str(e)) from e


# ---------------------------------------------------------------- writes

def propose(cur, cid: str, who: dict, platform: str, fields: dict, evidence: Optional[list[dict]],
            reason: Optional[str]) -> dict:
    fields = _links(cur, cid, fields)
    cur.execute("SELECT * FROM qa_scenarios WHERE container_id=%s AND platform=%s AND name=%s",
                (cid, platform, fields["name"]))
    row = cur.fetchone()
    if row is None:
        _check_checks(fields.get("checks"), len(fields["criteria"]))
        _check_evidence(cur, cid, evidence, len(fields["criteria"]))
        sid = qs.new_id()
        source = fields.get("source") or ("walk" if fields.get("walk_id") else "authored")
        cur.execute(
            """INSERT INTO qa_scenarios (id, container_id, platform, name, category, persona, description, criteria,
                                         checks, data, needs, tags, depends_on, source, status, walk_id, session_id,
                                         task_id, created_by_agent_id, created_at, updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'draft',%s,%s,%s,%s,%s,%s)""",
            (sid, cid, platform, fields["name"], fields.get("category"), fields.get("persona"),
             fields.get("description"), qs.dumps(fields["criteria"]), qs.dumps(fields.get("checks") or []),
             qs.dumps(fields.get("data") or {}), qs.dumps(fields.get("needs") or []),
             qs.dumps(fields.get("tags") or []), qs.dumps(fields.get("depends_on") or []), source,
             fields.get("walk_id"), fields.get("session_id"), fields.get("task_id"), who["id"], qs.now(), qs.now()),
        )
        extras = {k: fields[k] for k in EXTRA_FIELDS if k in fields}
        _apply(cur, sid, _sealed(cur, cid, sid, extras))
        save_version(cur, sid, who)
        _write_evidence(cur, cid, sid, evidence)
        _link_walk(cur, sid, fields.get("walk_id"))
        return {"outcome": "created", "scenario": detail(cur, qs.load_scenario(cur, sid))}
    row = dict(row)
    sid = str(row["id"])
    if row["status"] != "draft":
        proposed = {k: v for k, v in _sealed(cur, cid, sid, fields).items() if k in FIELDS}
        if evidence is not None:
            proposed["evidence"] = evidence
        suggestion = _suggest(cur, row, who, proposed, reason, fields.get("session_id"))
        return {"outcome": "suggested", "scenario": detail(cur, qs.load_scenario(cur, sid)), "suggestion": suggestion}
    _check_checks(fields.get("checks"), len(fields["criteria"]))
    _check_evidence(cur, cid, evidence, len(fields["criteria"]))
    _save(cur, sid, who, _sealed(cur, cid, sid, fields))
    _write_evidence(cur, cid, sid, evidence)
    _link_walk(cur, sid, fields.get("walk_id"))
    return {"outcome": "updated", "scenario": detail(cur, qs.load_scenario(cur, sid))}


def revise(cur, row: dict, who: dict, fields: dict, evidence: Optional[list[dict]], status: Optional[str],
           reason: Optional[str]) -> dict:
    cid, sid = str(row["container_id"]), str(row["id"])
    is_human = who["kind"] == "human"
    if status is not None and not is_human:
        raise HTTPException(403, "only a person can change a scenario's status")
    fields = _links(cur, cid, fields)
    if not is_human and row["status"] != "draft":
        proposed = dict(_sealed(cur, cid, sid, fields))
        if evidence is not None:
            proposed["evidence"] = evidence
        if not proposed:
            raise HTTPException(400, "nothing to change")
        suggestion = _suggest(cur, row, who, proposed, reason, fields.get("session_id"))
        return {"outcome": "suggested", "scenario": detail(cur, row), "suggestion": suggestion}
    criteria = fields.get("criteria", qs._json(row.get("criteria"), []))
    _check_checks(fields.get("checks", qs._json(row.get("checks"), [])), len(criteria))
    _check_evidence(cur, cid, evidence, len(criteria))
    _save(cur, sid, who, _sealed(cur, cid, sid, fields))
    _write_evidence(cur, cid, sid, evidence)
    _link_walk(cur, sid, fields.get("walk_id"))
    if status is not None and status != row["status"]:
        set_status(cur, cid, who, [sid], status, reason)
    return {"outcome": "updated", "scenario": detail(cur, qs.load_scenario(cur, sid))}


def _clean_status(status: str, until: Optional[str], issue: Optional[str], replaced_by: Optional[str], cid: str, cur) -> tuple:
    """The until date, issue and replacement a change may carry (paused and retired only)."""
    until, issue, replaced_by = until or None, (issue or "").strip() or None, replaced_by or None
    if status != "paused":
        until = issue = None
    elif until:
        until = str(until)[:10]
        try:
            day = _dt.date.fromisoformat(until)
        except ValueError:
            raise HTTPException(400, "until: a date (YYYY-MM-DD)") from None
        if day <= _dt.datetime.now(_dt.timezone.utc).date():
            raise HTTPException(400, "until: a date after today")
    if issue and not _ISSUE.search(issue):
        raise HTTPException(400, "issue: a task of this project, #42, owner/repo#42 or a GitHub issue link")
    if status != "retired":
        replaced_by = None
    elif replaced_by:
        qs.require_uuid(replaced_by, "replaced_by")
        if str(qs.load_scenario(cur, replaced_by)["container_id"]) != cid:
            raise HTTPException(400, "replaced_by: a scenario of this project")
    return until, issue, replaced_by


_ISSUE = re.compile(r"^[0-9a-f-]{36}$|github\.com/[\w.-]+/[\w.-]+/(issues|pull)/\d+|^(?:[\w.-]+/[\w.-]+)?#\d+$", re.I)


def status_note(status: str, reason: Optional[str], until: Optional[str], issue: Optional[str],
                replaced_name: Optional[str] = None) -> str:
    """The History note of a change: "Paused: Flag off until 2026-11-01", "Retired: Removed
    (replaced by Add to cart)"."""
    bits = [reason.strip()] if reason and reason.strip() else []
    if until:
        bits.append(f"until {until}")
    if issue:
        bits.append(f"or {issue} closes" if until else f"until {issue} closes")
    tail = f" (replaced by {replaced_name})" if replaced_name else ""
    label = status.capitalize()
    return f"{label}: {' '.join(bits)}{tail}" if bits else f"{label}{tail}"


def set_status(cur, cid: str, who: dict, ids: list[str], status: str, reason: Optional[str],
               until: Optional[str] = None, issue: Optional[str] = None, replaced_by: Optional[str] = None) -> list[dict]:
    """People only (the route checks). Validating records who and when; going back to draft
    forgets it. Quarantined is validated with `quarantined_at` set: the clean passes counted so
    far survive a change of its reason, and leaving quarantine releases it. A retired scenario
    keeps what replaced it, a paused one its until date and its issue."""
    if status not in EFFECTIVE_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(EFFECTIVE_STATUSES)}")
    until, issue, replaced_by = _clean_status(status, until, issue, replaced_by, cid, cur)
    rows = []
    for i in dict.fromkeys(ids):
        r = qs.load_scenario(cur, i)
        if str(r["container_id"]) != cid:
            raise HTTPException(404, f"scenario {i} not found in this project")
        rows.append(r)
    at = qs.now()
    replaced_name = str(qs.load_scenario(cur, replaced_by)["name"]) if replaced_by else None
    note = status_note(status, reason, until, issue, replaced_name)
    for r in rows:
        sid = str(r["id"])
        _baseline_version(cur, sid, who)
        stored = "validated" if status == "quarantined" else status
        sets: dict[str, Any] = {"status": stored, "status_reason": None if status == "quarantined" else reason,
                                "status_until": until, "status_issue": issue, "replaced_by": replaced_by, "updated_at": at}
        if status == "quarantined":
            sets.update({"quarantined_at": r.get("quarantined_at") or at, "quarantine_reason": reason or "Flaky"})
            if not r.get("quarantined_at"):
                sets["quarantine_clean_runs"] = 0
        elif r.get("quarantined_at"):
            sets.update({"quarantined_at": None, "quarantine_reason": None, "quarantine_clean_runs": 0,
                         "quarantine_released_at": at})
        if stored == "validated" and r["status"] != "validated":
            sets.update({"validated_by_agent_id": who["id"], "validated_at": at})
        elif stored == "draft":
            sets.update({"validated_by_agent_id": None, "validated_at": None})
        _update(cur, sid, sets)
        save_version(cur, sid, who, note)
    return [qs.public(qs.load_scenario(cur, str(r["id"]))) for r in rows]


def _update(cur, sid: str, sets: dict[str, Any]) -> None:
    keys = list(sets)
    cur.execute(f"UPDATE qa_scenarios SET {', '.join(f'{k}=%s' for k in keys)} WHERE id=%s",
                (*[sets[k] for k in keys], sid))


def paused_due(cur, cid: str) -> list[tuple[dict, str]]:
    """Paused scenarios whose until date has arrived, or whose task is finished: (row, why). A read."""
    cur.execute("SELECT * FROM qa_scenarios WHERE container_id=%s AND status='paused'", (cid,))
    rows = [dict(r) for r in cur.fetchall()]
    today = _dt.datetime.now(_dt.timezone.utc).date().isoformat()
    out = []
    for r in rows:
        until, issue, why = str(r.get("status_until") or "")[:10], str(r.get("status_issue") or ""), None
        if until and until <= today:
            why = f"{until} arrived"
        elif re.fullmatch(r"[0-9a-f-]{36}", issue, re.I):
            cur.execute("SELECT title, status FROM tasks WHERE id=%s", (issue,))
            task = cur.fetchone()
            if task and task["status"] in ("completed", "cancelled"):
                why = f"task \"{task['title']}\" finished"
        if why:
            out.append((r, why))
    return out


def resume_due(cur, cid: str) -> None:
    """Paused scenarios that are due go back to validated on their own. A GitHub issue is a person's
    to check: the portal does not read it."""
    for r, why in paused_due(cur, cid):
        _update(cur, str(r["id"]), {"status": "validated", "status_reason": None, "status_until": None,
                                    "status_issue": None, "updated_at": qs.now()})
        save_version(cur, str(r["id"]), None, f"Resumed automatically: {why}")


def after_verdict(cur, row: dict) -> None:
    """A quarantined scenario's clean passes, counted again from its verdicts since it went in:
    a check where every criterion passed, newest first, until one that did not. Enough of them
    release it (it fails a check run again); a person can release it sooner."""
    if not row.get("quarantined_at"):
        return
    sid, at = str(row["id"]), row["quarantined_at"]
    criteria = len(qs._json(row.get("criteria"), []))
    cur.execute("SELECT * FROM qa_verdicts WHERE scenario_id=%s ORDER BY created_at DESC", (sid,))
    sessions: dict[str, list[dict]] = {}
    for v in cur.fetchall():
        if str(qs.iso(v["created_at"])) >= str(qs.iso(at)):
            sessions.setdefault(str(v["session_id"]), []).append(qs.public(v))
    clean = 0
    for attempt in attempts_of(criteria, sessions):
        if attempt["outcome"] != "pass":
            break
        clean += 1
    if clean >= QUARANTINE_RELEASE_CLEAN:
        _update(cur, sid, {"quarantined_at": None, "quarantine_reason": None, "quarantine_clean_runs": 0,
                           "quarantine_released_at": qs.now(), "updated_at": qs.now()})
        save_version(cur, sid, None, f"Released automatically: {clean} clean passes")
    else:
        _update(cur, sid, {"quarantine_clean_runs": clean})


def list_suggestions(cur, cid: str, status: Optional[str]) -> list[dict]:
    q = """SELECT g.*, s.name AS scenario_name, s.platform AS scenario_platform
             FROM qa_scenario_suggestions g JOIN qa_scenarios s ON s.id = g.scenario_id
            WHERE g.container_id=%s"""
    args: list[Any] = [cid]
    if status:
        q += " AND g.status=%s"
        args.append(status)
    cur.execute(q + " ORDER BY g.created_at DESC", tuple(args))
    return [qs.public(r) for r in cur.fetchall()]


def decide(cur, g: dict, who: dict, decision: str) -> dict:
    """Accept (apply the proposed fields to the scenario, which keeps its status) or dismiss."""
    if g["status"] != "proposal":
        raise HTTPException(409, f"this suggestion was already {g['status']}")
    cid, scenario_id = str(g["container_id"]), str(g["scenario_id"])
    if decision == "accept":
        proposed = qs._json(g.get("proposed"), {})
        fields = {k: v for k, v in proposed.items() if k in FIELDS}
        row = qs.load_scenario(cur, scenario_id)
        criteria = fields.get("criteria", qs._json(row.get("criteria"), []))
        evidence = proposed.get("evidence")
        _check_checks(fields.get("checks", qs._json(row.get("checks"), [])), len(criteria))
        _check_evidence(cur, cid, evidence, len(criteria))
        _save(cur, scenario_id, who, _sealed(cur, cid, scenario_id, fields))
        _write_evidence(cur, cid, scenario_id, evidence)
        _link_walk(cur, scenario_id, fields.get("walk_id"))
    cur.execute("""UPDATE qa_scenario_suggestions SET status=%s, decided_by_agent_id=%s, decided_at=%s
                    WHERE id=%s""",
                ("accepted" if decision == "accept" else "dismissed", who["id"], qs.now(), str(g["id"])))
    return {"suggestion": qs.public(qs.load_suggestion(cur, str(g["id"]))),
            "scenario": detail(cur, qs.load_scenario(cur, scenario_id))}


# ---------------------------------------------------------------- export

def _line(label: str, value: Any) -> Optional[str]:
    if value in (None, "", [], {}):
        return None
    if isinstance(value, list):
        value = ", ".join(str(v) for v in value)
    elif isinstance(value, dict):
        value = ", ".join(f"{k}={v}" for k, v in value.items())
    return f"- {label}: {value}"


def _v3_format():
    """The CLI's scenario markdown v3 module when this portal runs in the CLI's interpreter (a
    native `orcha portal`); None in a portal image without the CLI."""
    try:
        from orcha_cli.qa import scenario_format
    except ImportError:
        return None
    return scenario_format


def export(rows: list[dict]) -> str:
    """Scenario markdown v3 (`render_file`) when the CLI's format module is importable, else the
    minimal renderer below."""
    fmt = _v3_format()
    if fmt is None:
        return export_markdown(rows)
    data: dict[str, Any] = {}
    for r in rows:
        data.update({str(k): v for k, v in (r.get("data") or {}).items()})
    return fmt.render_file([fmt.from_row(r) for r in rows], data=data or None)


def _checks_of(r: dict) -> tuple[list[str], dict[int, list[str]]]:
    scenario, per = [], {}
    for c in r.get("checks") or []:
        if not isinstance(c, dict) or not str(c.get("line") or "").strip():
            continue
        if c.get("criterion_index") is None:
            scenario.append(str(c["line"]))
        else:
            per.setdefault(int(c["criterion_index"]), []).append(str(c["line"]))
    return scenario, per


def export_markdown(rows: list[dict]) -> str:
    """Minimal scenario markdown: `# name`, metadata lines, the description, numbered criteria
    with their `Check:` lines (scenario-level checks before the criteria)."""
    parts = []
    for r in rows:
        lines = [f"# {r['name']}", ""]
        meta = [_line("Platform", r.get("platform")), _line("Category", r.get("category")),
                _line("Persona", r.get("persona")), _line("Status", r.get("status")),
                _line("Tags", r.get("tags")), _line("Needs", r.get("needs")),
                _line("Depends on", r.get("depends_on")), _line("Data", r.get("data"))]
        lines += [m for m in meta if m]
        if r.get("description"):
            lines += ["", str(r["description"]).strip()]
        lines.append("")
        scenario_checks, per = _checks_of(r)
        lines += [f"Check: {x}" for x in scenario_checks]
        for i, c in enumerate(r.get("criteria") or []):
            lines.append(f"{i + 1}. {c}")
            lines += [f"   Check: {x}" for x in per.get(i, [])]
        parts.append("\n".join(lines).rstrip() + "\n")
    return "\n".join(parts)
