"""What the scenario screens read and do beyond the record itself: History, Restore, Delete, the
release from quarantine, the corrections runs propose for a check line, the recorded path built
from walks, attached files and the reveal of a sealed Examples cell.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import qa_scenarios, qa_store as qs

try:
    import secret_box
except ImportError:
    from orcha_cli import secret_box

#: Most recent results read for corrections.
RECENT_FIXES = 20
#: What a walk's step trace counts as an action of the path.
ACTION_KINDS = ("tap", "type", "swipe", "press", "open_url")
MAX_FILE_BYTES = 25 * 1024 * 1024


# ---------------------------------------------------------------- History

def versions(cur, sid: str) -> list[dict]:
    cur.execute("SELECT * FROM qa_scenario_versions WHERE scenario_id=%s ORDER BY version DESC", (sid,))
    return [qs.public(r) for r in cur.fetchall()]


def restore(cur, row: dict, who: dict, version: int) -> dict:
    """Put that version's fields back and save that as a new version. The lifecycle status is left
    alone when either side is paused or retired: it changes through the Status menu, with a
    reason. A status note is History text, not a field."""
    sid, cid = str(row["id"]), str(row["container_id"])
    cur.execute("SELECT snapshot FROM qa_scenario_versions WHERE scenario_id=%s AND version=%s", (sid, version))
    got = cur.fetchone()
    if got is None:
        raise HTTPException(404, f"this scenario has no version {version}")
    snap = qs._json(got["snapshot"], {})
    fields = {k: snap[k] for k in qa_scenarios.SNAPSHOT_FIELDS if k in snap and k in qa_scenarios.FIELDS}
    aside = ("paused", "retired")
    status = snap.get("status")
    qa_scenarios._baseline_version(cur, sid, who)
    try:
        qa_scenarios._apply(cur, sid, fields)
    except HTTPException:
        raise
    if status and status != row["status"] and status not in aside and row["status"] not in aside:
        qa_scenarios.set_status(cur, cid, who, [sid], status, None)
    number = qa_scenarios.save_version(cur, sid, who)
    return {"scenario": qa_scenarios.detail(cur, qs.load_scenario(cur, sid)), "version": number}


# ---------------------------------------------------------------- Delete and quarantine

def delete(cur, row: dict) -> None:
    """The scenario and its version history go (its evidence, verdicts and suggestions with them);
    what depended on it stops depending on it, walks forget it, files leave the disk."""
    sid, cid = str(row["id"]), str(row["container_id"])
    cur.execute("SELECT path FROM qa_scenario_files WHERE scenario_id=%s", (sid,))
    paths = [str(r["path"]) for r in cur.fetchall()]
    cur.execute("UPDATE qa_walks SET scenario_id=NULL WHERE scenario_id=%s", (sid,))
    cur.execute("SELECT id, depends_on FROM qa_scenarios WHERE container_id=%s AND id<>%s", (cid, sid))
    name = str(row["name"]).strip().lower()
    for p in cur.fetchall():
        deps = qs._json(p.get("depends_on"), [])
        kept = [d for d in deps if d != sid and str(d).strip().lower() != name]
        if len(kept) != len(deps):
            cur.execute("UPDATE qa_scenarios SET depends_on=%s WHERE id=%s", (qs.dumps(kept), str(p["id"])))
    cur.execute("DELETE FROM qa_scenarios WHERE id=%s", (sid,))
    for path in paths:
        pathlib.Path(path).unlink(missing_ok=True)


def release(cur, row: dict, who: dict) -> dict:
    sid = str(row["id"])
    if not row.get("quarantined_at"):
        return qs.public(row)
    qa_scenarios._baseline_version(cur, sid, who)
    at = qs.now()
    qa_scenarios._update(cur, sid, {"quarantined_at": None, "quarantine_reason": None, "quarantine_clean_runs": 0,
                                    "quarantine_released_at": at, "updated_at": at})
    qa_scenarios.save_version(cur, sid, who, "Released from quarantine")
    return qs.public(qs.load_scenario(cur, sid))


# ---------------------------------------------------------------- check corrections

def check_fix_rows(cur, sid: str) -> dict:
    """What the screen derives its offers from: the corrections of the newest sessions (`rows`,
    newest first, `criteria[i]` holding `check_fix` and `check_repairs`) and those dismissed."""
    cur.execute("""SELECT session_id, criterion_index, check_fix, check_repairs, created_at FROM qa_verdicts
                    WHERE scenario_id=%s ORDER BY created_at DESC""", (sid,))
    runs: dict[str, dict[int, dict]] = {}
    for r in cur.fetchall():
        fix, repairs = qs._json(r["check_fix"], None), qs._json(r["check_repairs"], [])
        if not fix and not repairs:
            continue
        run = runs.setdefault(str(r["session_id"]), {})
        i = int(r["criterion_index"])
        if i not in run:
            run[i] = {"check_fix": fix, "check_repairs": repairs}
    rows = []
    for run_id, per in list(runs.items())[:RECENT_FIXES]:
        rows.append({"run_id": run_id, "criteria": [per.get(i) for i in range(max(per) + 1)]})
    cur.execute("SELECT criterion_index, expression, proposed FROM qa_check_fix_dismissals WHERE scenario_id=%s", (sid,))
    return {"rows": rows, "dismissed": [dict(r) for r in cur.fetchall()]}


def dismiss_fix(cur, row: dict, who: dict, criterion_index: int, expression: str, proposed: str) -> None:
    sid = str(row["id"])
    cur.execute("""SELECT 1 AS one FROM qa_check_fix_dismissals
                    WHERE scenario_id=%s AND criterion_index=%s AND expression=%s AND proposed=%s""",
                (sid, criterion_index, expression, proposed))
    if cur.fetchone() is None:
        cur.execute("""INSERT INTO qa_check_fix_dismissals (id, container_id, scenario_id, criterion_index, expression, proposed,
                                                            dismissed_by_agent_id, created_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (qs.new_id(), str(row["container_id"]), sid, criterion_index, expression, proposed, who["id"], qs.now()))


def example_rows(cur, row: dict) -> list[dict]:
    """The newest result of each Examples row, from the verdicts that named it. Rows that never
    ran are absent."""
    sid = str(row["id"])
    criteria = len(qs._json(row.get("criteria"), []))
    cur.execute("SELECT * FROM qa_verdicts WHERE scenario_id=%s AND example_row IS NOT NULL ORDER BY created_at DESC", (sid,))
    by: dict[int, dict[str, list[dict]]] = {}
    for v in cur.fetchall():
        by.setdefault(int(v["example_row"]), {}).setdefault(str(v["session_id"]), []).append(qs.public(v))
    out = []
    for index in sorted(by):
        newest = qa_scenarios.attempts_of(criteria, by[index])[0]
        out.append({"index": index, "outcome": newest["outcome"], "reason": newest["note"], "run_id": newest["session_id"], "at": newest["at"]})
    return out


# ---------------------------------------------------------------- the recorded path

def _describe(step: dict) -> str:
    """"tap Button 'Sign in'", "type Maria into TextField 'Name'"."""
    args = step.get("args") or {}
    target = args.get("target") if isinstance(args.get("target"), dict) else {}
    name = target.get("label") or target.get("spec") or (args.get("target") if isinstance(args.get("target"), str) else "") or ""
    role = target.get("role") or ""
    what = f"{role + ' ' if role else ''}'{name}'" if name else role
    kind = str(step.get("kind") or "")
    if kind == "type":
        return f"type {args.get('text') or ''}" + (f" into {what}" if what else "")
    if kind == "open_url":
        return f"open {args.get('url') or ''}"
    if kind == "swipe":
        return f"swipe {args.get('direction') or ''}".strip()
    if kind == "press":
        return f"press {args.get('key') or ''}".strip()
    return f"{kind} {what}".strip()


def _quoted(text: str) -> list[str]:
    return [a or b for a, b in re.findall(r'"([^"]{2,})"|“([^”]{2,})”', text)]


def _walks_of(cur, row: dict) -> list[dict]:
    """The scenario's walks that reached the end, newest first, one per platform."""
    sid = str(row["id"])
    cur.execute("""SELECT w.*, x.platform AS run_platform FROM qa_walks w JOIN qa_sessions x ON x.id = w.session_id
                    WHERE (w.scenario_id=%s OR w.id=%s) ORDER BY w.started_at DESC""", (sid, str(row.get("walk_id") or sid)))
    out: dict[str, dict] = {}
    for w in cur.fetchall():
        out.setdefault(str(w["run_platform"]), qs.public(w))
    return list(out.values())


def traces(cur, row: dict) -> list[dict]:
    """A scenario's recorded path per platform, from the walk it came from: one segment per
    criterion (its checks, what a check run said about it) with the walk's actions under the
    criterion they led to (by the frame its evidence shows)."""
    sid = str(row["id"])
    pub = qs.public(row)
    criteria = [str(c) for c in pub.get("criteria") or []]
    checks: dict[int, list[str]] = {}
    for c in pub.get("checks") or []:
        if isinstance(c, dict) and c.get("criterion_index") is not None:
            checks.setdefault(int(c["criterion_index"]), []).append(str(c.get("line")))
    cur.execute("SELECT * FROM qa_verdicts WHERE scenario_id=%s ORDER BY created_at", (sid,))
    verdicts = [qs.public(r) for r in cur.fetchall()]
    evidence = qa_scenarios.evidence_of(cur, sid)
    out = []
    for w in _walks_of(cur, row):
        q, args = "SELECT * FROM qa_steps WHERE session_id=%s", [w["session_id"]]
        if w.get("start_seq") is not None:
            q += " AND seq>=%s"
            args.append(w["start_seq"])
        if w.get("end_seq") is not None:
            q += " AND seq<=%s"
            args.append(w["end_seq"])
        cur.execute(q + " ORDER BY seq", tuple(args))
        steps = [qs.public(r) for r in cur.fetchall()]
        seq_of_frame = {s["frame_id"]: s["seq"] for s in steps if s.get("frame_id")}
        ends: dict[int, int] = {}
        for e in evidence:
            if e.get("frame_id") in seq_of_frame:
                ends[int(e["criterion_index"])] = max(ends.get(int(e["criterion_index"]), -1), seq_of_frame[e["frame_id"]])
        actions, owner = [], {}
        for s in steps:
            if s.get("kind") not in ACTION_KINDS:
                continue
            index = len(actions)
            crit = next((i for i in sorted(ends) if s["seq"] <= ends[i]), max(ends) if ends else 0)
            owner.setdefault(crit, []).append(index)
            args_ = s.get("args") or {}
            actions.append({"index": index, "kind": s["kind"], "label": _describe(s), "criterion": crit,
                            "valueKind": "literal" if s["kind"] == "type" else None, "secret": bool(args_.get("secret")),
                            "twin": None, "templated": False})
        platform = w["run_platform"]
        mine = [v for v in verdicts if v["session_id"] != w["session_id"]]
        ok_total = fail_total = 0
        segments = []
        for i, text in enumerate(criteria):
            said = [v for v in mine if int(v["criterion_index"]) == i]
            ok, fail = sum(1 for v in said if v["verdict"] == "pass"), sum(1 for v in said if v["verdict"] == "fail")
            ok_total, fail_total = ok_total + ok, fail_total + fail
            shown = next((e for e in evidence if int(e["criterion_index"]) == i), None)
            last = said[-1]["verdict"] if said else None
            state = "evicted" if last == "fail" else "verified" if last == "pass" or (shown and shown["status"] == "verified") else "unverified"
            acts = owner.get(i, [])
            segments.append({"index": i, "text": text, "fromAction": acts[0] if acts else -1, "toAction": acts[-1] if acts else -1,
                             "state": state, "checks": checks.get(i, []), "expectTexts": _quoted(text), "okCount": ok, "failCount": fail,
                             "verifiedRunId": said[-1]["session_id"] if said and last == "pass" else None})
        stop = next((v for v in reversed(mine) if v["verdict"] in ("fail", "blocked")), None)
        out.append({"id": w["id"], "targetKind": platform, "runId": w["session_id"], "recordedAt": w.get("ended_at") or w.get("started_at"),
                    "lastReplayedAt": mine[-1]["created_at"] if mine else None, "okCount": ok_total, "failCount": fail_total,
                    "lastStop": {"reason": "criterion_" + stop["verdict"], "detail": stop.get("note"), "criterion": int(stop["criterion_index"])} if stop else None,
                    "policy": None, "startUrl": None, "viewport": None, "actions": actions, "segments": segments})
    return out


def forget_path(cur, row: dict, platform: Optional[str]) -> None:
    """Re-record: the walk stays in its session, the scenario forgets it."""
    sid = str(row["id"])
    for w in _walks_of(cur, row):
        if platform and w["run_platform"] != platform:
            continue
        cur.execute("UPDATE qa_walks SET scenario_id=NULL WHERE id=%s", (w["id"],))
        if row.get("walk_id") and str(row["walk_id"]) == w["id"]:
            cur.execute("UPDATE qa_scenarios SET walk_id=NULL WHERE id=%s", (sid,))


# ---------------------------------------------------------------- files and secrets

def files(cur, sid: str) -> list[dict]:
    cur.execute("SELECT id, scenario_id, file_name, size_bytes, created_at FROM qa_scenario_files WHERE scenario_id=%s ORDER BY created_at", (sid,))
    return [qs.public(r) for r in cur.fetchall()]


def file_dir(cid: str, sid: str) -> pathlib.Path:
    return qs.frame_dir(cid, "files") / sid


def add_file(cur, row: dict, name: str, data: bytes) -> dict:
    if not data:
        raise HTTPException(400, "the file is empty")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, f"a file is at most {MAX_FILE_BYTES // (1024 * 1024)} MB")
    sid, cid = str(row["id"]), str(row["container_id"])
    fid = qs.new_id()
    safe = re.sub(r"[^\w.\- ]+", "_", pathlib.Path(name or "file").name)[:120] or "file"
    folder = file_dir(cid, sid)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{fid}-{safe}"
    path.write_bytes(data)
    cur.execute("""INSERT INTO qa_scenario_files (id, container_id, scenario_id, file_name, size_bytes, path, created_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""", (fid, cid, sid, safe, len(data), str(path), qs.now()))
    return files(cur, sid)[-1]


def delete_file(cur, fid: str) -> dict:
    qs.require_uuid(fid, "file")
    cur.execute("SELECT * FROM qa_scenario_files WHERE id=%s", (fid,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(404, "no such file")
    cur.execute("DELETE FROM qa_scenario_files WHERE id=%s", (fid,))
    pathlib.Path(str(row["path"])).unlink(missing_ok=True)
    return dict(row)


def reveal(cur, row: dict, ref: str) -> str:
    """One sealed cell of this scenario's own table, for the person holding the eye on it."""
    table = qs._json(row.get("examples"), None)
    target = f"secret:{ref}"
    if not isinstance(table, dict) or not any(target in [str(c) for c in r] for r in table.get("rows") or []):
        raise HTTPException(404, "that value is not in this scenario's table")
    cur.execute("SELECT value FROM qa_example_secrets WHERE id=%s AND scenario_id=%s", (ref, str(row["id"])))
    got = cur.fetchone()
    if got is None:
        raise HTTPException(404, "that value is gone")
    if not secret_box.master_key_present():
        raise HTTPException(503, "encrypted storage is disabled: ORCHA_SECRET_KEY is not set in the portal "
                                 "environment, so a secret value can't be read.")
    return secret_box.unseal(str(got["value"]))
