"""Orcha QA storage helpers (migration 093; contract: docs/orcha-qa-plan.md).

Row loading and public shapes for every qa_* table, the actor rules the QA routes share, and
the session-side writes that are more than one statement: steps (idempotent on seq), frames
on disk, the flow queue and its walks. The map lives in qa_map, scenarios in qa_scenarios.

Ids are minted here (uuid4) and rows are read back with a SELECT, so the same code runs on
SQLite and Postgres. JSON columns are written as json.dumps text and come back decoded on both
engines (psycopg decodes JSONB, the SQLite adapter decodes columns declared JSONB).
"""

from __future__ import annotations

import datetime as _dt
import json
import pathlib
import re
import uuid
from typing import Any, Iterable, Optional

from fastapi import HTTPException, Request

from portal_backend import sql
from portal_backend.attachment_config import attachments_dir
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.identity_routes import require_member_read, trusted_actor

PLATFORMS = ("ios", "android", "web")
WEB_VIEWPORTS = ("desktop", "mobile")
SESSION_KINDS = ("map", "explore", "draft", "check")
SESSION_STATUSES = ("running", "done", "failed", "cancelled", "abandoned")
STEP_KINDS = ("screen", "tap", "type", "swipe", "press", "open_url", "launch", "terminate", "wait", "note")
SEVERITIES = ("blocker", "major", "minor", "trivial")
BLOCKED_KINDS = ("needs_sign_in", "needs_data", "needs_permission", "paywall", "external", "crash", "other")
CRITICALITY_POINTS = {"high": 30, "medium": 20, "low": 10}
WALK_OUTCOMES = ("passed", "failed", "unreachable", "abandoned")
MISSION_STATUSES = ("active", "covered", "partial", "blocked", "bug")
LENSES = ("works", "usable", "resilient", "accessible", "visual", "copy", "fast")
VERDICTS = ("pass", "fail", "blocked", "inconclusive")
#: A session that failed before its first step never ran (it could not get a device, say): it is
#: not a run a person should see, or count.
STARTED_SQL = ("NOT (qa_sessions.status='failed' AND qa_sessions.kind<>'draft' AND NOT EXISTS "
               "(SELECT 1 FROM qa_steps st WHERE st.session_id=qa_sessions.id))")
#: A flow whose last walk failed within this many days ranks "failed recently".
FAILED_RECENTLY_DAYS = 7
MAX_FRAME_BYTES = 4 * 1024 * 1024
FRAME_TYPE = "image/jpeg"


# ---------------------------------------------------------------- small helpers

def new_id() -> str:
    return str(uuid.uuid4())


def now() -> _dt.datetime:
    return sql.utcnow()


VERDICT_ORDER = {"fail": 0, "blocked": 1, "inconclusive": 2, "pass": 3}


def newest_verdicts(rows: Iterable[dict]) -> list[dict]:
    """From rows newest first: each criterion's newest verdict per Examples row, by criterion and
    worst first. An Examples table runs a criterion once per row: a row that passes never hides
    one that failed."""
    seen: dict[tuple, dict] = {}
    for r in rows:
        seen.setdefault((int(r["criterion_index"]), r.get("example_row")), r)
    return sorted(seen.values(), key=lambda v: (int(v["criterion_index"]), VERDICT_ORDER.get(v["verdict"], 9)))


def dumps(value: Any) -> str:
    return json.dumps(value, default=str)


def iso(value: Any) -> Any:
    if isinstance(value, _dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=_dt.timezone.utc)
        return value.astimezone(_dt.timezone.utc).isoformat()
    return value


def _json(value: Any, default: Any) -> Any:
    if isinstance(value, (bytes, bytearray)):
        value = value.decode()
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return default
    return default if value is None else value


#: JSON columns per table and the value each reads back as when NULL.
_JSON_COLS = {
    "paths": [], "sources": [], "evidence": {}, "detail": {}, "counts": {}, "args": {},
    "frame_ids": [], "steps": [], "data": {}, "rank_reasons": [], "finding_ids": [],
    "criteria": [], "checks": [], "needs": [], "tags": [], "depends_on": [], "proposed": {}, "extra": {},
    "seed": [], "cleanup": [], "events": [], "check_repairs": [], "snapshot": {}, "row_values": {},
    "scenario_ids": [], "acceptance": [], "finding_ids": [],
}
#: JSON columns that are NULL until written (sessions).
_NULLABLE_JSON = ("briefing", "charter", "result", "rect", "model", "examples", "check_fix", "timing", "crawl_queue", "build", "triage",
                  "conditions")


def public(row: Optional[dict], drop: Iterable[str] = ()) -> Optional[dict]:
    """A row as the API returns it: ids as text, times as ISO text, JSON decoded."""
    if row is None:
        return None
    out = {}
    skip = set(drop)
    # qa_findings.detail is TEXT (the agent's prose plus a web events block), not JSON.
    text_detail = "severity" in row
    for k, v in dict(row).items():
        if k in skip:
            continue
        if k == "detail" and text_detail:
            v = v.decode() if isinstance(v, (bytes, bytearray)) else v
        elif k in _JSON_COLS:
            v = _json(v, _JSON_COLS[k])
        elif k in _NULLABLE_JSON:
            v = _json(v, None)
        elif isinstance(v, uuid.UUID):
            v = str(v)
        elif k in ("fresh", "shared") and v is not None:  # booleans: SQLite hands back 0 or 1
            v = bool(v)
        out[k] = iso(v)
    return out


def slug(text: str, limit: int = 80) -> str:
    """`Sign in with Apple` / `SignInView` -> `sign-in-with-apple` / `sign-in-view`."""
    t = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", str(text or "").strip())
    t = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1-\2", t)
    t = re.sub(r"[^A-Za-z0-9]+", "-", t).strip("-").lower()
    return t[:limit].strip("-")


def internal_request() -> Request:
    """A header-less request: the task-creation handler's trusted_actor keeps the already
    resolved person or agent as the creator (the routines pattern)."""
    return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "query_string": b""})


def require_uuid(value: Optional[str], what: str) -> None:
    if not valid_uuid(value):
        raise HTTPException(400, f"{what} is not a valid UUID")


def require_platform(platform: Optional[str]) -> str:
    if platform not in PLATFORMS:
        raise HTTPException(400, "platform must be ios, android or web")
    return str(platform)


# ---------------------------------------------------------------- who may act

def container_read(cur, request: Request, cid: str) -> None:
    require_uuid(cid, "container_id")
    require_container(cur, cid)
    require_member_read(cur, request, cid)


def actor(cur, request: Request, cid: str, claimed: Optional[str]) -> dict:
    """The live member of this container that performs a QA write: the proxy identity when
    one is trusted, else the body's actor_agent_id (the house convention). Returns
    {id, kind, alias}."""
    if claimed and not valid_uuid(claimed):
        raise HTTPException(400, "actor_agent_id is not a valid UUID")
    aid = trusted_actor(cur, request, cid, claimed)
    if not aid:
        raise HTTPException(400, "actor_agent_id is required")
    cur.execute("SELECT id, kind, alias, container_id, terminated_at FROM agents WHERE id=%s", (str(aid),))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {aid} not found")
    if str(row["container_id"]) != str(cid):
        raise HTTPException(403, "that agent belongs to another project")
    if row["terminated_at"] is not None:
        raise HTTPException(409, "agent is retired and cannot perform this action")
    return {"id": str(row["id"]), "kind": row["kind"], "alias": row["alias"]}


def human(cur, request: Request, cid: str, claimed: Optional[str], doing: str) -> dict:
    """`actor`, and only a person: approving scenarios, deciding suggestions and editing
    targets are human decisions, like verifying a task."""
    who = actor(cur, request, cid, claimed)
    if who["kind"] != "human":
        raise HTTPException(403, f"only a person can {doing}")
    require_kind(cur, who["id"], ("human",))
    return who


# ---------------------------------------------------------------- loading rows

def _load(cur, table: str, rid: str, what: str) -> dict:
    require_uuid(rid, f"{what} id")
    cur.execute(f"SELECT * FROM {table} WHERE id=%s", (rid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"{what} {rid} not found")
    return dict(row)


def load_session(cur, sid: str) -> dict:
    return _load(cur, "qa_sessions", sid, "QA session")


def load_frame(cur, fid: str) -> dict:
    return _load(cur, "qa_frames", fid, "frame")


def load_finding(cur, fid: str) -> dict:
    return _load(cur, "qa_findings", fid, "finding")


def load_flow(cur, fid: str) -> dict:
    return _load(cur, "qa_flows", fid, "flow")


def load_walk(cur, wid: str) -> dict:
    return _load(cur, "qa_walks", wid, "walk")


def load_scenario(cur, sid: str) -> dict:
    return _load(cur, "qa_scenarios", sid, "scenario")


def load_suggestion(cur, sid: str) -> dict:
    return _load(cur, "qa_scenario_suggestions", sid, "suggestion")


def require_task_in(cur, cid: str, tid: Optional[str]) -> Optional[str]:
    if not tid:
        return None
    require_uuid(tid, "task_id")
    cur.execute("SELECT container_id FROM tasks WHERE id=%s", (tid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"task {tid} not found")
    if str(row["container_id"]) != str(cid):
        raise HTTPException(400, "that task belongs to another project")
    return str(tid)


def require_frames_in(cur, cid: str, frame_ids: Iterable[str]) -> list[str]:
    ids = [str(f) for f in dict.fromkeys(frame_ids or [])]
    for f in ids:
        require_uuid(f, "frame")
    if not ids:
        return []
    cur.execute(f"SELECT id, container_id FROM qa_frames WHERE {sql.in_list('id')}", (sql.list_param(ids),))
    found = {str(r["id"]): str(r["container_id"]) for r in cur.fetchall()}
    for f in ids:
        if found.get(f) != str(cid):
            raise HTTPException(400, f"frame {f} is not a frame of this project")
    return ids


# ---------------------------------------------------------------- sessions

def target(cur, cid: str, platform: str) -> Optional[dict]:
    cur.execute("SELECT * FROM qa_targets WHERE container_id=%s AND platform=%s", (cid, platform))
    row = cur.fetchone()
    return dict(row) if row else None


def create_session(cur, cid: str, who: dict, *, kind: str, platform: str, task_id: Optional[str],
                   device_name: Optional[str], device_udid: Optional[str], app_id: Optional[str],
                   budget_minutes: Optional[int], goal: Optional[str], draft_sources: Optional[str] = None) -> dict:
    from portal_backend import qa_explorations as qx

    claimed = qx.claim_queued(cur, cid, who, kind=kind, platform=platform, task_id=task_id, device_name=device_name,
                              device_udid=device_udid, app_id=app_id, budget_minutes=budget_minutes, goal=goal,
                              draft_sources=draft_sources)
    if claimed:
        return claimed
    t = target(cur, cid, platform) or {}
    sid = new_id()
    series, previous = qx.series_of(cur, cid, kind, platform, goal)
    cur.execute(
        """INSERT INTO qa_sessions (id, container_id, kind, platform, task_id, agent_id, device_name,
                                    device_udid, app_id, status, budget_minutes, goal, started_at, last_seen_at,
                                    series_id, previous_session_id, draft_sources)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'running',%s,%s,%s,%s,%s,%s,%s)""",
        (sid, cid, kind, platform, task_id, who["id"], device_name or t.get("device_name"), device_udid,
         app_id or t.get("app_id"), budget_minutes, goal, now(), now(), series or sid, previous, draft_sources),
    )
    return load_session(cur, sid)


def session_digests(cur, sids: list[str]) -> dict[str, dict]:
    """Per session id: its findings, walks and drafts, its screenshot steps and its step count."""
    out: dict[str, dict] = {sid: {"findings": [], "walks": [], "drafts": [], "shots": [], "steps_count": 0} for sid in sids}
    if not sids:
        return out
    cond, param = sql.in_list("session_id"), (sql.list_param(sids),)
    cur.execute(f"SELECT * FROM qa_findings WHERE {cond} ORDER BY created_at", param)
    for r in cur.fetchall():
        out[str(r["session_id"])]["findings"].append(public(r))
    cur.execute(f"SELECT * FROM qa_walks WHERE {cond} ORDER BY started_at", param)
    for r in cur.fetchall():
        out[str(r["session_id"])]["walks"].append(public(r))
    cur.execute(f"SELECT id, session_id, name, status, category FROM qa_scenarios WHERE {cond} ORDER BY created_at", param)
    for r in cur.fetchall():
        out[str(r["session_id"])]["drafts"].append({"id": str(r["id"]), "name": r["name"], "status": r["status"], "category": r["category"]})
    cur.execute(f"SELECT session_id, seq, frame_id, screen_hash FROM qa_steps WHERE {cond} ORDER BY seq", param)
    for r in cur.fetchall():
        d = out[str(r["session_id"])]
        d["steps_count"] += 1
        if r["frame_id"]:
            d["shots"].append({"seq": r["seq"], "frame_id": str(r["frame_id"]), "screen_hash": r["screen_hash"]})
    from portal_backend import qa_explorations as qx

    for sid, rows in qx.measured_of(cur, sids).items():
        out[sid]["measured"] = rows
    return out


def session_detail(cur, s: dict) -> dict:
    sid = str(s["id"])
    out = public(s)
    with_names(cur, [out])
    cur.execute(
        """SELECT w.*, f.name AS flow_name, f.key AS flow_key FROM qa_walks w
             JOIN qa_flows f ON f.id = w.flow_id
            WHERE w.session_id=%s ORDER BY w.started_at""",
        (sid,),
    )
    out["walks"] = [public(r) for r in cur.fetchall()]
    cur.execute("SELECT * FROM qa_findings WHERE session_id=%s ORDER BY created_at", (sid,))
    out["findings"] = with_names(cur, [public(r) for r in cur.fetchall()])
    cur.execute("SELECT count(*) AS n, max(seq) AS last FROM qa_steps WHERE session_id=%s", (sid,))
    r = cur.fetchone()
    out["steps_count"] = int(r["n"] or 0)
    out["last_seq"] = r["last"]
    cur.execute("SELECT count(*) AS n FROM qa_frames WHERE session_id=%s", (sid,))
    out["frames_count"] = int(cur.fetchone()["n"] or 0)
    cur.execute("SELECT * FROM qa_scenarios WHERE session_id=%s ORDER BY created_at", (sid,))
    out["drafts"] = [public(r) for r in cur.fetchall()]
    cur.execute("SELECT * FROM qa_verdicts WHERE session_id=%s ORDER BY created_at", (sid,))
    out["verdicts"] = [public(r) for r in cur.fetchall()]
    from portal_backend import qa_explorations as qx

    out["measured"] = qx.measured_of(cur, [sid])[sid]
    out["run_again"] = qx.again_plan(cur, str(s["container_id"]), s.get("task_id")) if s["status"] in qx.STOPPED else None
    return out


def with_names(cur, rows: list[dict]) -> list[dict]:
    """Add `agent_alias` and `task_title` (and `filed_task_title` on a finding) to public
    session / finding rows, in place. A finding's agent is its session's."""
    rows = [r for r in rows if r]
    session_ids = [r["session_id"] for r in rows if "agent_id" not in r and r.get("session_id")]
    session_agent: dict[str, Optional[str]] = {}
    if session_ids:
        cur.execute(f"SELECT id, agent_id FROM qa_sessions WHERE {sql.in_list('id')}",
                    (sql.list_param(list(dict.fromkeys(session_ids))),))
        session_agent = {str(r["id"]): (str(r["agent_id"]) if r["agent_id"] else None) for r in cur.fetchall()}
    agent_of = {id(r): (r.get("agent_id") if "agent_id" in r else session_agent.get(str(r.get("session_id"))))
                for r in rows}
    agent_ids = [a for a in agent_of.values() if a]
    task_ids = [t for r in rows for t in (r.get("task_id"), r.get("filed_task_id")) if t]
    aliases, titles = {}, {}
    if agent_ids:
        cur.execute(f"SELECT id, alias FROM agents WHERE {sql.in_list('id')}",
                    (sql.list_param(list(dict.fromkeys(agent_ids))),))
        aliases = {str(r["id"]): r["alias"] for r in cur.fetchall()}
    if task_ids:
        cur.execute(f"SELECT id, title FROM tasks WHERE {sql.in_list('id')}",
                    (sql.list_param(list(dict.fromkeys(task_ids))),))
        titles = {str(r["id"]): r["title"] for r in cur.fetchall()}
    for r in rows:
        r["agent_alias"] = aliases.get(str(agent_of[id(r)])) if agent_of[id(r)] else None
        r["task_title"] = titles.get(str(r["task_id"])) if r.get("task_id") else None
        if "filed_task_id" in r:
            r["filed_task_title"] = titles.get(str(r["filed_task_id"])) if r.get("filed_task_id") else None
    from portal_backend import qa_explorations as qx

    qx.add_state(cur, rows)
    from portal_backend import qa_run_tasks

    qa_run_tasks.add_run_ids(cur, rows)
    return rows


def validate_charter(charter: Any) -> Any:
    """A charter is `{missions: [...]}` (or the list itself); each mission's status must be one
    the contract names, and its lens one of the seven."""
    missions = charter.get("missions") if isinstance(charter, dict) else charter
    if missions is None:
        return charter
    if not isinstance(missions, list):
        raise HTTPException(400, "the charter's missions must be a list")
    if len(missions) > 12:
        raise HTTPException(400, "a charter has at most 12 missions")
    for m in missions:
        if not isinstance(m, dict) or not str(m.get("title") or "").strip():
            raise HTTPException(400, "every mission needs a title")
        if m.get("status") is not None and m["status"] not in MISSION_STATUSES:
            raise HTTPException(400, f"a mission's status must be one of {', '.join(MISSION_STATUSES)}")
        if m.get("lens") is not None and m["lens"] not in LENSES:
            raise HTTPException(400, f"a mission's lens must be one of {', '.join(LENSES)}")
        if m.get("journey_id") is not None and not isinstance(m["journey_id"], str):
            raise HTTPException(400, "a mission's journey_id must be the id of a journey in the briefing")
    return charter


def end_open_walks(cur, sid: str, reason: str) -> None:
    """A session that ends leaves no walk walking: each is abandoned and its flow re-queued."""
    cur.execute("SELECT id, flow_id FROM qa_walks WHERE session_id=%s AND status='walking'", (sid,))
    for w in cur.fetchall():
        cur.execute("UPDATE qa_walks SET status='abandoned', reason=%s, ended_at=%s WHERE id=%s",
                    (reason, now(), str(w["id"])))
        cur.execute("UPDATE qa_flows SET status='queued', updated_at=%s WHERE id=%s AND status='walking'",
                    (now(), str(w["flow_id"])))


# ---------------------------------------------------------------- frames

def frame_dir(cid: str, sid: str) -> pathlib.Path:
    return attachments_dir() / "qa" / str(cid) / str(sid)


def frame_file(row: dict) -> Optional[pathlib.Path]:
    """The frame's file under the attachments dir, or None when its stored path escapes it."""
    base = attachments_dir().resolve()
    p = (base / str(row["path"])).resolve()
    try:
        p.relative_to(base)
    except ValueError:
        return None
    return p


def jpeg_size(data: bytes) -> tuple[Optional[int], Optional[int]]:
    """(width, height) from a JPEG's start-of-frame marker, or (None, None)."""
    i, n = 2, len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = int.from_bytes(data[i + 2:i + 4], "big")
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h = int.from_bytes(data[i + 5:i + 7], "big")
            w = int.from_bytes(data[i + 7:i + 9], "big")
            return (w or None), (h or None)
        if length < 2:
            break
        i += 2 + length
    return None, None


def store_frame(cur, s: dict, data: bytes, screen_hash: Optional[str], facts: Optional[dict] = None) -> dict:
    """`facts`: what the CLI read from the frame as it took it (fingerprint, appearance, blank)."""
    facts = facts or {}
    cid, sid = str(s["container_id"]), str(s["id"])
    fid = new_id()
    rel = f"qa/{cid}/{sid}/{fid}.jpg"
    d = frame_dir(cid, sid)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f".{fid}.part"
    tmp.write_bytes(data)
    tmp.replace(d / f"{fid}.jpg")
    w, h = jpeg_size(data)
    cur.execute(
        """INSERT INTO qa_frames (id, container_id, session_id, path, width, height, screen_hash, created_at,
                                  fingerprint, appearance, blank)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (fid, cid, sid, rel, w, h, screen_hash, now(), facts.get("fingerprint"), facts.get("appearance"), facts.get("blank")),
    )
    return {"frame_id": fid, "width": w, "height": h}


# ---------------------------------------------------------------- steps

def add_steps(cur, s: dict, steps: list[dict]) -> dict:
    """Insert a batch; a seq the session already has is skipped (the MCP server resends a
    batch it could not confirm), never overwritten."""
    cid, sid = str(s["container_id"]), str(s["id"])
    frames = [st["frame_id"] for st in steps if st.get("frame_id")]
    require_frames_in(cur, cid, frames)
    inserted = 0
    for st in steps:
        cur.execute(
            """INSERT INTO qa_steps (id, container_id, session_id, seq, kind, args, result, screen_key,
                                     screen_hash, frame_id, at, duration_ms, timing)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (session_id, seq) DO NOTHING""",
            (new_id(), cid, sid, st["seq"], st["kind"], dumps(st.get("args") or {}), st.get("result"),
             st.get("screen_key"), st.get("screen_hash"), st.get("frame_id"), st.get("at") or now(),
             st.get("duration_ms"), dumps(st["timing"]) if st.get("timing") else None),
        )
        inserted += max(cur.rowcount, 0)
    cur.execute("UPDATE qa_sessions SET last_seen_at=%s WHERE id=%s", (now(), sid))
    return {"inserted": inserted, "skipped": len(steps) - inserted}


def last_seq(cur, sid: str) -> Optional[int]:
    cur.execute("SELECT max(seq) AS last FROM qa_steps WHERE session_id=%s", (sid,))
    r = cur.fetchone()
    return r["last"] if r else None


# ---------------------------------------------------------------- flows and walks

def upsert_flows(cur, cid: str, platform: str, flows: list[dict], source: str) -> list[dict]:
    """Upsert by key (from the name when missing). A flow's walking history (status, last
    walk, score) is kept; what it is (name, steps, data, ...) is replaced."""
    out = []
    for f in flows:
        key = slug(f.get("key") or f["name"]) or slug(f["name"])
        if not key:
            raise HTTPException(400, f"flow {f['name']!r} has no usable key")
        cur.execute("SELECT id FROM qa_flows WHERE container_id=%s AND platform=%s AND key=%s",
                    (cid, platform, key))
        row = cur.fetchone()
        values = (f["name"], f.get("persona"), f.get("criticality") or "medium", dumps(f.get("steps") or []),
                  dumps(f.get("data") or {}), source)
        if row:
            fid = str(row["id"])
            cur.execute(
                """UPDATE qa_flows SET name=%s, persona=%s, criticality=%s, steps=%s, data=%s, source=%s,
                          updated_at=%s WHERE id=%s""",
                (*values, now(), fid),
            )
        else:
            fid = new_id()
            cur.execute(
                """INSERT INTO qa_flows (id, container_id, platform, key, name, persona, criticality, steps,
                                         data, source, status, created_at, updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'queued',%s,%s)""",
                (fid, cid, platform, key, *values, now(), now()),
            )
        out.append(public(load_flow(cur, fid)))
    return out


def rank_flow(flow: dict, *, covered: bool, at: _dt.datetime) -> tuple[int, list[str]]:
    """The contract's queue score: never walked +40, failed recently +30, criticality
    +30/+20/+10, uncovered +10."""
    score, reasons = 0, []
    if not flow.get("last_walked_at"):
        score += 40
        reasons.append("never walked (+40)")
    last = flow.get("last_walked_at")
    if isinstance(last, str):
        last = _dt.datetime.fromisoformat(last)
    if flow.get("status") == "failed" and last is not None:
        if last.tzinfo is None:
            last = last.replace(tzinfo=_dt.timezone.utc)
        if at - last <= _dt.timedelta(days=FAILED_RECENTLY_DAYS):
            score += 30
            reasons.append("failed recently (+30)")
    pts = CRITICALITY_POINTS.get(str(flow.get("criticality") or "medium"), 20)
    score += pts
    reasons.append(f"{flow.get('criticality') or 'medium'} criticality (+{pts})")
    if not covered:
        score += 10
        reasons.append("no scenario covers it yet (+10)")
    return score, reasons


def next_walk(cur, s: dict) -> dict:
    """Start the session's next walk: the best-ranked flow of its platform that is queued or
    failed and not walked in this session yet. A walk still walking is returned as it is."""
    cid, sid = str(s["container_id"]), str(s["id"])
    cur.execute("SELECT * FROM qa_walks WHERE session_id=%s AND status='walking' ORDER BY started_at LIMIT 1",
                (sid,))
    open_walk = cur.fetchone()
    if open_walk:
        return {"walk": public(open_walk), "flow": public(load_flow(cur, str(open_walk["flow_id"]))),
                "resumed": True}
    cur.execute(
        """SELECT f.* FROM qa_flows f
            WHERE f.container_id=%s AND f.platform=%s AND f.status IN ('queued','failed')
              AND NOT EXISTS (SELECT 1 FROM qa_walks w WHERE w.flow_id=f.id AND w.session_id=%s)
            ORDER BY f.created_at, f.key""",
        (cid, s["platform"], sid),
    )
    flows = [dict(r) for r in cur.fetchall()]
    if not flows:
        return {"walk": None, "flow": None}
    cur.execute(
        f"""SELECT DISTINCT flow_id FROM qa_walks
             WHERE scenario_id IS NOT NULL AND {sql.in_list('flow_id')}""",
        (sql.list_param([str(f["id"]) for f in flows]),),
    )
    covered = {str(r["flow_id"]) for r in cur.fetchall()}
    at = now()
    best, best_score = None, -1
    for f in flows:
        score, reasons = rank_flow(f, covered=str(f["id"]) in covered, at=at)
        cur.execute("UPDATE qa_flows SET score=%s, rank_reasons=%s WHERE id=%s",
                    (score, dumps(reasons), str(f["id"])))
        if score > best_score:  # ties keep the oldest flow (the ORDER BY above)
            best, best_score = f, score
    steps = _json(best.get("steps"), [])
    walk_steps = [_walk_step_row(i, (st.get("text") if isinstance(st, dict) else str(st)),
                                 (st.get("check") if isinstance(st, dict) else None))
                  for i, st in enumerate(steps)]
    wid = new_id()
    start = last_seq(cur, sid)
    cur.execute(
        """INSERT INTO qa_walks (id, container_id, session_id, flow_id, status, steps, start_seq, started_at)
           VALUES (%s,%s,%s,%s,'walking',%s,%s,%s)""",
        (wid, cid, sid, str(best["id"]), dumps(walk_steps), (start + 1) if start is not None else 1, at),
    )
    cur.execute("UPDATE qa_flows SET status='walking', last_walk_id=%s, updated_at=%s WHERE id=%s",
                (wid, at, str(best["id"])))
    return {"walk": public(load_walk(cur, wid)), "flow": public(load_flow(cur, str(best["id"]))),
            "resumed": False}


def _walk_step_row(index: int, text: Optional[str], expected: Optional[str] = None) -> dict:
    return {"index": index, "text": text, "expected": expected, "reached": False, "result": None, "checked": [],
            "finding_id": None, "frame_id": None, "seq": None, "screen_key": None, "at": None}


def walk_step(cur, w: dict, step: dict) -> dict:
    """Record step `index` (0-based) of a walk. An index past the flow's last step (or any
    index when the flow has none) is appended, so an agent-defined walk can still pass; the
    "last step reached" rule then looks at the last step recorded."""
    steps = _json(w.get("steps"), [])
    i = step["index"]
    if i < 0:
        raise HTTPException(400, "walk steps are numbered from 0")
    while len(steps) <= i:  # an agent-defined step (or a gap before it) joins the walk
        steps.append(_walk_step_row(len(steps), None))
    if step.get("finding_id"):
        f = load_finding(cur, step["finding_id"])
        if str(f["container_id"]) != str(w["container_id"]):
            raise HTTPException(400, "that finding belongs to another project")
    if step.get("frame_id"):
        require_frames_in(cur, str(w["container_id"]), [step["frame_id"]])
    cur_step = dict(steps[i]) if isinstance(steps[i], dict) else {"index": i, "text": str(steps[i])}
    for k in ("reached", "result", "checked", "finding_id", "frame_id", "seq", "screen_key", "text", "expected"):
        if k in step and step[k] is not None and not (k in ("text", "expected") and not str(step[k]).strip()):
            cur_step[k] = step[k]
    cur_step["at"] = iso(now())
    steps[i] = cur_step
    finding_ids = list(dict.fromkeys([*_json(w.get("finding_ids"), []),
                                      *([step["finding_id"]] if step.get("finding_id") else [])]))
    cur.execute("UPDATE qa_walks SET steps=%s, finding_ids=%s WHERE id=%s",
                (dumps(steps), dumps(finding_ids), str(w["id"])))
    return load_walk(cur, str(w["id"]))


def end_walk(cur, w: dict, outcome: str, reason: Optional[str], blocked_kind: Optional[str],
             end_seq: Optional[int] = None) -> dict:
    steps = _json(w.get("steps"), [])
    if outcome == "passed":
        if not steps or not (isinstance(steps[-1], dict) and steps[-1].get("reached")):
            raise HTTPException(409, "a walk passes only once its last step is reached")
    if outcome == "unreachable" and not blocked_kind:
        blocked_kind = "other"
    at = now()
    cur.execute(
        """UPDATE qa_walks SET status=%s, reason=%s, blocked_kind=%s, end_seq=%s, ended_at=%s WHERE id=%s""",
        (outcome, reason, blocked_kind, end_seq if end_seq is not None else last_seq(cur, str(w["session_id"])), at,
         str(w["id"])),
    )
    flow_status = "queued" if outcome == "abandoned" else outcome
    cur.execute("UPDATE qa_flows SET status=%s, last_walked_at=%s, updated_at=%s WHERE id=%s",
                (flow_status, at if outcome != "abandoned" else None, at, str(w["flow_id"])))
    if outcome == "abandoned":
        # an abandoned walk was never finished: keep the flow's previous walk time
        cur.execute(
            """UPDATE qa_flows SET last_walked_at=(SELECT max(ended_at) FROM qa_walks
                                                    WHERE flow_id=%s AND status<>'abandoned')
                WHERE id=%s""",
            (str(w["flow_id"]), str(w["flow_id"])),
        )
    return load_walk(cur, str(w["id"]))
