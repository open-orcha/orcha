"""A task's Quality report: what was tested, on what, with which result, and what was not covered.

`collect(cur, tid)` gathers it from the task and the Quality tasks it was handed to. `markdown(data)`
writes it for a person (a Jira ticket's attachment); the same data travels inside the file, in a
fenced `orcha-quality-report` block, so Embodent can import it. `bundle(...)` is a zip with the
report, its data and the screenshots it points at.

`parse(...)` reads a report or a bundle back. What it reads is someone else's account of a run:
the import shows it as reported, never as proof for this project. Nothing secret goes in: test
accounts by their persona and needs, never a password; Examples values never.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from collections import Counter
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import qa_conditions
from portal_backend import qa_store as qs
from portal_backend import sql

SCHEMA = "orcha-quality-report"
VERSION = 1
FENCE = re.compile(r"```" + SCHEMA + r"\s*\n(.*?)\n```", re.S)
MAX_FRAMES = 300
MAX_GAPS = 200
#: An import is read whole: a report this large is no report.
MAX_IMPORT_BYTES = 80 * 1024 * 1024
MAX_UNZIPPED_BYTES = 200 * 1024 * 1024
_FRAME_NAME = re.compile(r"^frames/[0-9a-f-]{36}\.jpg$")
VERDICT_WORD = {"pass": "Passed", "fail": "Failed", "blocked": "Blocked", "inconclusive": "Not sure", None: "Not judged"}
GLYPH = {"pass": "✓", "fail": "✗", "blocked": "■", "inconclusive": "?", None: "·"}
PLATFORM_WORD = {"ios": "iOS", "android": "Android", "web": "Web"}


def _worst(verdicts: list[Optional[str]]) -> Optional[str]:
    judged = [v for v in verdicts if v]
    return min(judged, key=lambda v: qs.VERDICT_ORDER.get(v, 9)) if judged else None


def _task_ids(cur, tid: str) -> list[str]:
    cur.execute("SELECT qa_task_id FROM qa_requests WHERE source_task_id=%s AND qa_task_id IS NOT NULL", (tid,))
    return sorted({tid, *(str(r["qa_task_id"]) for r in cur.fetchall())})


def _secret_free(value: Any) -> Any:
    """Examples values and anything marked secret never leave the project."""
    if isinstance(value, str):
        return "<secret>" if value.startswith("secret:") else value
    if isinstance(value, list):
        return [_secret_free(v) for v in value]
    if isinstance(value, dict):
        return {k: _secret_free(v) for k, v in value.items()}
    return value


def collect(cur, tid: str) -> dict[str, Any]:
    """The report's data for task `tid`. Raises 404 when the task has no Quality work."""
    cur.execute("SELECT t.*, c.name AS project_name FROM tasks t JOIN containers c ON c.id=t.container_id WHERE t.id=%s", (tid,))
    task = cur.fetchone()
    if not task:
        raise HTTPException(404, f"task {tid} not found")
    task = dict(task)
    cid = str(task["container_id"])
    ids = _task_ids(cur, tid)
    in_tasks = (sql.list_param(ids),)
    cur.execute(f"SELECT * FROM qa_sessions WHERE {sql.in_list('task_id')} AND kind <> 'draft' ORDER BY started_at", in_tasks)
    sessions = qs.with_names(cur, [qs.public(r) for r in cur.fetchall()])
    if not sessions:
        raise HTTPException(404, "This task has no Quality runs yet, so there is nothing to report.")
    sids = [s["id"] for s in sessions]
    in_sessions = (sql.list_param(sids),)

    # Scenarios: each criterion's newest verdict.
    cur.execute(f"""SELECT v.*, s.name, s.platform AS scenario_platform, s.criteria, s.tags, s.persona, s.needs, s.category,
                           s.conditions AS scenario_conditions
                      FROM qa_verdicts v JOIN qa_scenarios s ON s.id=v.scenario_id
                     WHERE {sql.in_list('v.session_id')} ORDER BY v.created_at DESC""", in_sessions)
    by_scenario: dict[str, list[dict]] = {}
    for r in cur.fetchall():
        row = qs.public(r)
        by_scenario.setdefault(row["scenario_id"], []).append(row)
    scenarios = []
    for sid, rows in by_scenario.items():
        newest = qs.newest_verdicts(rows)
        head = rows[0]
        criteria = list(head.get("criteria") or [])
        checks = [{"index": int(v["criterion_index"]), "text": criteria[int(v["criterion_index"])] if int(v["criterion_index"]) < len(criteria) else "",
                   "verdict": v["verdict"], "note": v.get("note"), "example_row": v.get("example_row"), "frame_ids": list(v.get("frame_ids") or [])}
                  for v in newest]
        scenarios.append({"id": sid, "name": head["name"], "platform": head["scenario_platform"], "category": head.get("category"),
                          "conditions": qa_conditions.clean(head.get("scenario_conditions")),
                          "tags": list(head.get("tags") or []), "persona": head.get("persona"), "needs": _secret_free(list(head.get("needs") or [])),
                          "criteria": criteria, "verdict": _worst([c["verdict"] for c in checks]), "checks": checks})
    scenarios.sort(key=lambda s: (qs.VERDICT_ORDER.get(s["verdict"] or "", 9), s["name"]))

    # What the task's own definition of done asked, line by line.
    cur.execute(f"SELECT * FROM qa_requests WHERE source_task_id=%s OR qa_task_id=%s ORDER BY created_at DESC", (tid, tid))
    requests = [qs.public(r) for r in cur.fetchall()]
    lines: list[dict] = []
    if requests:
        req = requests[0]
        cur.execute("SELECT * FROM qa_acceptance_verdicts WHERE request_id=%s ORDER BY created_at DESC", (req["id"],))
        newest: dict[int, dict] = {}
        for r in cur.fetchall():
            newest.setdefault(int(r["line_index"]), qs.public(r))
        lines = [{"index": i, "text": text, "verdict": (newest.get(i) or {}).get("verdict"), "note": (newest.get(i) or {}).get("note"),
                  "frame_ids": list((newest.get(i) or {}).get("frame_ids") or [])} for i, text in enumerate(req.get("acceptance") or [])]

    cur.execute(f"SELECT * FROM qa_findings WHERE {sql.in_list('session_id')} ORDER BY created_at", in_sessions)
    findings = [{"id": f["id"], "severity": f["severity"], "title": f["title"], "expected": f.get("expected"), "actual": f.get("actual"),
                 "status": f["status"], "screen_key": f.get("screen_key"), "frame_ids": list(f.get("frame_ids") or [])}
                for f in (qs.public(r) for r in cur.fetchall())]

    # Where it went: the screens it saw, by feature.
    cur.execute(f"""SELECT DISTINCT q.platform, st.screen_key FROM qa_steps st JOIN qa_sessions q ON q.id=st.session_id
                     WHERE {sql.in_list('st.session_id')} AND st.kind='screen' AND st.screen_key IS NOT NULL""", in_sessions)
    seen = [(r["platform"], r["screen_key"]) for r in cur.fetchall()]
    screens: list[dict] = []
    if seen:
        cur.execute("""SELECT n.platform, n.key, n.label, n.feature_key, n.frame_id, f.name AS feature_name FROM qa_map_nodes n
                         LEFT JOIN qa_features f ON f.container_id=n.container_id AND f.key=n.feature_key
                        WHERE n.container_id=%s AND n.kind='screen'""", (cid,))
        nodes = {(r["platform"], r["key"]): qs.public(r) for r in cur.fetchall()}
        for platform, key in seen:
            n = nodes.get((platform, key)) or {}
            screens.append({"platform": platform, "key": key, "label": n.get("label") or key, "feature": n.get("feature_name") or n.get("feature_key"),
                            "frame_id": n.get("frame_id")})
    screens.sort(key=lambda s: (s["feature"] or "~", s["label"]))

    platforms = sorted({s["platform"] for s in sessions})
    run_ids = {s["id"] for s in scenarios}
    cur.execute(f"""SELECT id, name, platform FROM qa_scenarios WHERE container_id=%s AND status='validated'
                     AND {sql.in_list('platform')} ORDER BY platform, name""", (cid, sql.list_param(platforms)))
    gaps = [dict(r) | {"id": str(r["id"])} for r in cur.fetchall() if str(r["id"]) not in run_ids]

    cur.execute(f"SELECT platform, app_id, app_name FROM qa_targets WHERE container_id=%s AND {sql.in_list('platform')}", (cid, sql.list_param(platforms)))
    apps = {r["platform"]: {"app_id": r["app_id"], "app_name": r["app_name"]} for r in cur.fetchall()}

    from portal_backend import qa_handoff

    build = dict((requests[0].get("build") if requests else None) or qa_handoff.step_build(cur, task) or {})
    if "branch" not in build:
        cur.execute(f"SELECT branch FROM worker_runs WHERE {sql.in_list('task_id')} AND branch IS NOT NULL ORDER BY started_at DESC LIMIT 1", in_tasks)
        run = cur.fetchone()
        if run:
            build["branch"] = run["branch"]
    build.pop("notes", None)

    accounts = sorted({(s.get("persona") or "", ", ".join(map(str, s.get("needs") or []))) for s in scenarios} - {("", "")})
    tally = Counter(s["verdict"] or "none" for s in scenarios)
    return {
        "schema": SCHEMA, "version": VERSION, "generated_at": qs.now().isoformat(), "generator": "Embodent",
        "task": {"id": tid, "title": task["title"], "status": task["status"], "project": task["project_name"],
                 "definition_of_done": task.get("definition_of_done") or ""},
        "result": _worst([s["verdict"] for s in scenarios] + [l["verdict"] for l in lines]) if (scenarios or lines) else None,
        "build": build,
        "runs": [{"id": s["id"], "kind": s["kind"], "platform": s["platform"], "device": s.get("device_name"), "app_id": s.get("app_id"),
                  "app_build": s.get("build_label"), "appearance": s.get("device_appearance"), "agent": s.get("agent_alias"), "status": s["status"],
                  "conditions": qa_conditions.clean(s.get("conditions")),
                  "started_at": s.get("started_at"), "ended_at": s.get("ended_at")} for s in sessions],
        "setup": {"platforms": platforms, "apps": apps, "devices": sorted({s.get("device_name") for s in sessions if s.get("device_name")}),
                  "accounts": [{"persona": p or None, "needs": n or None} for p, n in accounts]},
        "lines": lines, "scenarios": scenarios, "findings": findings, "screens": screens,
        "features": sorted({s["feature"] for s in screens if s["feature"]}),
        "gaps": gaps[:MAX_GAPS], "gaps_total": len(gaps),
        "tally": {"scenarios": len(scenarios), "passed": tally.get("pass", 0), "failed": tally.get("fail", 0),
                  "blocked": tally.get("blocked", 0) + tally.get("inconclusive", 0), "findings": len(findings)},
    }


# ---------------------------------------------------------------- markdown

def _cell(text: Any) -> str:
    return str(text if text is not None else "").replace("|", "\\|").replace("\n", " ").strip()


def markdown(data: dict[str, Any]) -> str:
    t, b, setup, tally = data["task"], data.get("build") or {}, data["setup"], data["tally"]
    out = [f"# Quality report: {t['title']}", "",
           f"{t['project']} · generated {str(data['generated_at'])[:16].replace('T', ' ')} UTC by Embodent", "",
           "| | |", "|---|---|",
           f"| Result | **{VERDICT_WORD.get(data.get('result'), 'Not judged')}** |",
           f"| Platforms | {', '.join(PLATFORM_WORD.get(p, p) for p in setup['platforms'])} |",
           f"| Devices | {_cell(', '.join(setup['devices']) or 'Not recorded')} |"]
    builds = sorted({r["app_build"] for r in data["runs"] if r.get("app_build")})
    if builds:
        out.append(f"| App build | {_cell(', '.join(builds))} |")
    for key, word in (("branch", "Branch"), ("commit", "Commit"), ("url", "Where it ran"), ("app_path", "App")):
        if b.get(key):
            out.append(f"| {word} | `{_cell(b[key])}` |")
    out.append(f"| Scenarios | {tally['scenarios']} run: {tally['passed']} passed, {tally['failed']} failed, {tally['blocked']} blocked |")
    out.append(f"| Findings | {tally['findings']} |")

    if data["lines"]:
        out += ["", "## What the task asked", ""]
        out += [f"- {GLYPH.get(l['verdict'])} {l['text']}" + (f": {l['note']}" if l.get("note") else "") for l in data["lines"]]
    if data["scenarios"]:
        out += ["", "## Scenarios run", "", "| Scenario | Platform | Result | Checks |", "|---|---|---|---|"]
        for s in data["scenarios"]:
            passed = sum(1 for c in s["checks"] if c["verdict"] == "pass")
            under = "; ".join(qa_conditions.words(s.get("conditions"), s["platform"]))
            out.append(f"| {_cell(s['name'])}{' (' + _cell(under) + ')' if under else ''} | {PLATFORM_WORD.get(s['platform'], s['platform'])} | {VERDICT_WORD.get(s['verdict'])} | {passed} of {len(s['checks'])} |")
        failing = [s for s in data["scenarios"] if s["verdict"] != "pass"]
        if failing:
            out += ["", "### Not passed", ""]
            for s in failing:
                out.append(f"**{s['name']}**" + (f" (conditions: {'; '.join(qa_conditions.words(s.get('conditions'), s['platform']))})" if s.get("conditions") else ""))
                out += [f"- {GLYPH.get(c['verdict'])} {c['text']}" + (f": {c['note']}" if c.get("note") else "") for c in s["checks"]]
                out.append("")
    if data["findings"]:
        out += ["", "## Findings", ""]
        for f in data["findings"]:
            out.append(f"- **{f['severity'].title()}**: {f['title']}" + (f". Expected: {f['expected']}" if f.get("expected") else "")
                       + (f". Saw: {f['actual']}" if f.get("actual") else ""))
    out += ["", "## Setup", ""]
    for p, app in sorted(setup["apps"].items()):
        out.append(f"- {PLATFORM_WORD.get(p, p)} app: {app.get('app_name') or ''} `{app.get('app_id') or 'not set'}`".replace("  ", " "))
    run_conditions = {"; ".join(qa_conditions.words(r.get("conditions"), r.get("platform"))) for r in data["runs"] if r.get("conditions")}
    for said in sorted(run_conditions):
        out.append(f"- Conditions: {said}")
    if setup["accounts"]:
        out.append("- Test accounts (names only; ask the team for access):")
        out += [f"  - {a['persona'] or 'Any user'}" + (f": {a['needs']}" if a.get("needs") else "") for a in setup["accounts"]]
    if data["features"] or data["screens"]:
        out += ["", "## Covered", "", f"{len(data['screens'])} screens across {len(data['features'])} features."]
        if data["features"]:
            out.append("Features: " + ", ".join(data["features"]) + ".")
    if data["gaps_total"]:
        out += ["", "## Not covered", "", f"{data['gaps_total']} approved scenarios were not run:", ""]
        out += [f"- {g['name']} ({PLATFORM_WORD.get(g['platform'], g['platform'])})" for g in data["gaps"]]
        if data["gaps_total"] > len(data["gaps"]):
            out.append(f"- and {data['gaps_total'] - len(data['gaps'])} more")
    out += ["", "## Import it", "",
            "In Embodent open Quality, Runs, Import report, and pick this file (or its .zip bundle, which also has the screenshots). "
            "It shows as reported: re-run it there to prove it.", "",
            f"```{SCHEMA}", json.dumps(data, default=str, ensure_ascii=False), "```", ""]
    return "\n".join(out)


def frame_ids(data: dict[str, Any]) -> list[str]:
    """Every screenshot the report points at, the evidence first, then the screens."""
    ids: list[str] = []
    for l in data.get("lines") or []:
        ids += l.get("frame_ids") or []
    for s in data.get("scenarios") or []:
        for c in s.get("checks") or []:
            ids += c.get("frame_ids") or []
    for f in data.get("findings") or []:
        ids += f.get("frame_ids") or []
    ids += [s["frame_id"] for s in data.get("screens") or [] if s.get("frame_id")]
    return list(dict.fromkeys(str(i) for i in ids))[:MAX_FRAMES]


def bundle(cur, data: dict[str, Any], cid: str) -> bytes:
    """A zip: report.md, report.json and `frames/<id>.jpg` for each screenshot still on disk."""
    buf = io.BytesIO()
    kept: list[str] = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for fid in frame_ids(data):
            cur.execute("SELECT * FROM qa_frames WHERE id=%s AND container_id=%s", (fid, cid))
            row = cur.fetchone()
            path = qs.frame_file(dict(row)) if row else None
            if path is not None and path.is_file():
                z.write(path, f"frames/{fid}.jpg", compress_type=zipfile.ZIP_STORED)
                kept.append(fid)
        out = dict(data, frames=kept)
        z.writestr("report.json", json.dumps(out, default=str, ensure_ascii=False, indent=1))
        z.writestr("report.md", markdown(out))
    return buf.getvalue()


def file_stem(data: dict[str, Any]) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", data["task"]["title"].lower()).strip("-")[:60] or "task"
    return f"quality-report-{slug}"


# ---------------------------------------------------------------- import

def _check(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise HTTPException(400, "This is not an Embodent Quality report.")
    if int(data.get("version") or 0) > VERSION:
        raise HTTPException(400, "This report comes from a newer Embodent. Update, then import it again.")
    for key in ("task", "scenarios", "setup"):
        if key not in data:
            raise HTTPException(400, f"This report is incomplete: it has no {key}.")
    return data


def parse(raw: bytes) -> tuple[dict[str, Any], dict[str, bytes]]:
    """A report's data and its screenshots, from a `.md` or a `.zip` bundle."""
    if len(raw) > MAX_IMPORT_BYTES:
        raise HTTPException(413, "This file is too large to be a Quality report.")
    if raw[:2] == b"PK":
        try:
            z = zipfile.ZipFile(io.BytesIO(raw))
        except zipfile.BadZipFile:
            raise HTTPException(400, "This zip file cannot be read.") from None
        if sum(i.file_size for i in z.infolist()) > MAX_UNZIPPED_BYTES:
            raise HTTPException(413, "This bundle unpacks too large to be a Quality report.")
        names = set(z.namelist())
        if "report.json" in names:
            data = json.loads(z.read("report.json"))
        elif "report.md" in names:
            data = _from_markdown(z.read("report.md").decode("utf-8", "replace"))
        else:
            raise HTTPException(400, "This bundle has no report in it.")
        frames = {n.split("/")[1][:-4]: z.read(n) for n in names if _FRAME_NAME.match(n)}
        return _check(data), frames
    return _check(_from_markdown(raw.decode("utf-8", "replace"))), {}


def _from_markdown(text: str) -> dict[str, Any]:
    found = FENCE.search(text)
    if not found:
        raise HTTPException(400, "This file has no Embodent report data in it. Export the report again from the task.")
    try:
        return json.loads(found.group(1))
    except ValueError:
        raise HTTPException(400, "This report's data was changed and cannot be read.") from None


def report_dir(cid: str, rid: str):
    from portal_backend.attachment_config import attachments_dir

    return attachments_dir() / "qa" / str(cid) / "reports" / str(rid)


def save(cur, cid: str, who: dict, data: dict[str, Any], frames: dict[str, bytes], file_name: Optional[str]) -> dict[str, Any]:
    rid = qs.new_id()
    folder = report_dir(cid, rid)
    folder.mkdir(parents=True, exist_ok=True)
    kept = []
    for fid, body in frames.items():
        if body[:3] == b"\xff\xd8\xff":  # a JPEG, nothing else
            (folder / f"{fid}.jpg").write_bytes(body)
            kept.append(fid)
    data = dict(data, frames=kept)
    cur.execute("""INSERT INTO qa_reports (id, container_id, title, file_name, data, imported_by_agent_id, created_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (rid, cid, str(data["task"].get("title") or "Quality report")[:300], (file_name or "")[:300] or None,
                 json.dumps(data, default=str, ensure_ascii=False), who["id"], qs.now()))
    return load(cur, rid)


def matched(cur, cid: str, data: dict[str, Any]) -> dict[str, Optional[str]]:
    """Each reported scenario's id in this project (by id, else by platform and name), or None."""
    out: dict[str, Optional[str]] = {}
    for s in data.get("scenarios") or []:
        cur.execute("""SELECT id FROM qa_scenarios WHERE container_id=%s AND (id=%s OR (platform=%s AND name=%s))
                        ORDER BY CASE WHEN id=%s THEN 0 ELSE 1 END LIMIT 1""",
                    (cid, s["id"] if qs.valid_uuid(s.get("id")) else None, s.get("platform"), s.get("name"),
                     s["id"] if qs.valid_uuid(s.get("id")) else None))
        row = cur.fetchone()
        out[str(s["id"])] = str(row["id"]) if row else None
    return out


def load(cur, rid: str) -> dict[str, Any]:
    cur.execute("SELECT r.*, a.alias AS imported_by FROM qa_reports r LEFT JOIN agents a ON a.id=r.imported_by_agent_id WHERE r.id=%s", (rid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"report {rid} not found")
    row = dict(row)
    data = json.loads(row["data"])
    cid = str(row["container_id"])
    return {"id": str(row["id"]), "container_id": cid, "title": row["title"], "file_name": row["file_name"],
            "imported_by": row["imported_by"], "created_at": qs.iso(row["created_at"]),
            "data": data, "matched": matched(cur, cid, data)}


def add_drafts(cur, cid: str, who: dict, rid: str) -> list[str]:
    """The reported scenarios this project lacks, as drafts a person approves. Returns their ids."""
    report = load(cur, rid)
    if report["container_id"] != cid:
        raise HTTPException(404, f"report {rid} not found")
    made = []
    for s in report["data"].get("scenarios") or []:
        if report["matched"].get(str(s["id"])) or s.get("platform") not in PLATFORM_WORD:
            continue
        sid = qs.new_id()
        cur.execute("""INSERT INTO qa_scenarios (id, container_id, platform, name, category, persona, description, criteria, tags, needs,
                                                 source, status, created_by_agent_id, created_at, updated_at, conditions)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'authored','draft',%s,%s,%s,%s)""",
                    (sid, cid, s["platform"], str(s["name"])[:300], s.get("category"), s.get("persona"),
                     f"Imported from the Quality report \"{report['title']}\".", qs.dumps(s.get("criteria") or []),
                     qs.dumps(s.get("tags") or []), qs.dumps(s.get("needs") or []), who["id"], qs.now(), qs.now(),
                     qa_conditions.dumps(s.get("conditions"))))
        made.append(sid)
    return made
