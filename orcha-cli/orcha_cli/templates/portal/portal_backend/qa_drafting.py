"""Orcha QA drafting (migration 095): what a drafting session said and read, and the explorers it
works with.

A drafting session (`qa_sessions.kind = 'draft'`) says what it does in `qa_session_messages`: its
notes, the files it reads, the searches it makes, its plan, each draft as it lands, its revisions,
and what it asks an explorer. An explore session of the same task is that explorer: the two share a
board, read here, and the explorer's screens come from its recorded steps, so nothing is posted
twice. A request runs open -> claimed -> answered, or timed_out / cancelled.

`board` is the one read of the drafting page and of the drafter's `read_screens` tool.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import qa_store as qs
from portal_backend import sql

#: Message kinds an agent posts directly. A request, an answer and a person's feedback have routes.
AGENT_KINDS = ("note", "read", "search", "draft", "plan", "correction")
#: Lines kept for the activity log and the stage.
RECENT_LINES = 40
#: The newest explorations a drafter reads, and the most screenshots the stage shows of them.
EXPLORATIONS_READ = 3
FRAMES_MAX = 12
#: A request waits this long for the explorer; once claimed it has this long to answer.
REQUEST_TIMEOUT_S = 240
ANSWER_TIMEOUT_S = 180
#: At most this many requests wait for one explorer at a time.
MAX_OPEN_REQUESTS = 3
OPEN_REQUESTS = ("open", "claimed")

_DESTRUCTIVE = re.compile(
    r"\b(delete|remove|erase|destroy|wipe|purge|drop|pay|purchase|buy|checkout|check out|place (?:the |an )?order|"
    r"transfer|send money|refund|cancel (?:the |my )?(?:subscription|account|order)|deactivate|unsubscribe|"
    r"reset (?:the )?(?:password|account)|sign out everywhere|close (?:the |my )?account)\b",
    re.IGNORECASE,
)


def destructive_reason(text: Optional[str]) -> Optional[str]:
    """Why a request asks for something destructive (the explorer then only looks), or None."""
    m = _DESTRUCTIVE.search(text or "")
    return f"it asks to {m.group(0).lower()}" if m else None


# ---------------------------------------------------------------- messages

def public_message(row: dict) -> dict:
    out = qs.public(row, drop=("container_id",))
    out["body"] = qs._json(row.get("body"), {})
    return out


def add_message(cur, s: dict, who: Optional[dict], kind: str, title: str, *, body: Optional[dict] = None,
                scenario_id: Optional[str] = None, frame_id: Optional[str] = None, reply_to: Optional[str] = None,
                status: Optional[str] = None) -> dict:
    sid = str(s["id"])
    cur.execute("SELECT max(seq) AS last FROM qa_session_messages WHERE session_id=%s", (sid,))
    last = cur.fetchone()["last"]
    mid = qs.new_id()
    cur.execute(
        """INSERT INTO qa_session_messages (id, container_id, session_id, seq, kind, title, body, scenario_id, frame_id,
                                            reply_to, status, agent_id, created_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (mid, str(s["container_id"]), sid, int(last or 0) + 1, kind, title, qs.dumps(body or {}), scenario_id, frame_id,
         reply_to, status, who["id"] if who else None, qs.now()),
    )
    cur.execute("SELECT * FROM qa_session_messages WHERE id=%s", (mid,))
    return public_message(cur.fetchone())


def load_message(cur, mid: str) -> dict:
    return qs._load(cur, "qa_session_messages", mid, "message")


def _messages(cur, sids: list[str]) -> list[dict]:
    if not sids:
        return []
    cur.execute(f"SELECT * FROM qa_session_messages WHERE {sql.in_list('session_id')} ORDER BY created_at, seq",
                (sql.list_param(sids),))
    return [public_message(r) for r in cur.fetchall()]


# ---------------------------------------------------------------- the session's partners

def partners(cur, s: dict) -> list[dict]:
    """The explore sessions of a draft session's task, or the draft sessions of an explore
    session's, oldest first. A session with no task has none."""
    if not s.get("task_id") or s.get("kind") not in ("draft", "explore"):
        return []
    other = "explore" if s["kind"] == "draft" else "draft"
    cur.execute("SELECT * FROM qa_sessions WHERE container_id=%s AND task_id=%s AND kind=%s ORDER BY started_at, id",
                (str(s["container_id"]), str(s["task_id"]), other))
    return [dict(r) for r in cur.fetchall()]


def _request_status(status: Any) -> str:
    return {"running": "running", "done": "completed", "failed": "failed"}.get(str(status), "cancelled")


def _explorer(cur, e: dict) -> dict:
    """What the page reads of one explorer: its row, its screenshots, why it ended early."""
    sid = str(e["id"])
    cur.execute("SELECT seq, frame_id, screen_key FROM qa_steps WHERE session_id=%s AND kind='screen' ORDER BY seq", (sid,))
    rows = cur.fetchall()
    frames = [{"seq": r["seq"], "frame_path": str(r["frame_id"])} for r in rows if r["frame_id"]]
    cur.execute("SELECT count(*) AS n FROM qa_steps WHERE session_id=%s AND kind <> 'screen'", (sid,))
    actions = int(cur.fetchone()["n"] or 0)
    cur.execute("""SELECT title, frame_ids FROM qa_findings WHERE session_id=%s AND severity='blocker' ORDER BY created_at""", (sid,))
    blockers = [qs.public(r) for r in cur.fetchall()]
    frame_ids = blockers[0]["frame_ids"] if blockers else []
    result = qs._json(e.get("result"), None) or {}
    return {
        "id": sid, "status": _request_status(e["status"]), "session_status": e["status"], "device": e.get("device_name"),
        "target_kind": e["platform"], "locator": e.get("app_id") or "", "goal": e.get("goal"),
        "minutes": e.get("budget_minutes"), "created_at": qs.iso(e["started_at"]), "started_at": qs.iso(e["started_at"]),
        "finished_at": qs.iso(e.get("ended_at")), "error": result.get("error") or result.get("reason"),
        "screens": len({r["screen_key"] for r in rows if r["screen_key"]}), "frames": frames, "actions": actions,
        "blockers": len(blockers), "blocker_title": blockers[0]["title"] if blockers else None,
        "blocker_frame": str(frame_ids[0]) if frame_ids else None,
    }


def _session(s: dict, explorers: list[dict]) -> Optional[dict]:
    """The two agents as one session, the way the page's line reads it; None without an explorer."""
    if not explorers:
        return None
    going = any(e["status"] == "running" for e in explorers)
    done = any(e["status"] == "completed" for e in explorers)
    explorer_status = "running" if going else "finished" if done else "failed"
    status = {"running": "live", "done": "finished"}.get(s["status"], "stopped")
    note = None
    if status == "live" and explorer_status == "failed":
        status = "code_only"
        why = next((e["error"] for e in explorers if e.get("error")), None)
        note = f"The explorer stopped{f': {why}' if why else ''}: drafting from the code only."
    deadlines = [_dt.datetime.fromisoformat(e["started_at"]) + _dt.timedelta(minutes=e["minutes"])
                 for e in explorers if e.get("minutes") and e.get("started_at")]
    return {
        "id": str(s["id"]), "status": status, "explorer_status": explorer_status, "pairing": None, "note": note,
        "explorer_joined_at": min(e["started_at"] for e in explorers), "deadline_at": qs.iso(max(deadlines)) if deadlines else None,
    }


def _screens(cur, sids: list[str], labels: bool) -> list[dict]:
    """Each session's screens, the first sighting of each, as board events."""
    if not sids:
        return []
    cur.execute(f"""SELECT id, session_id, seq, screen_key, screen_hash, frame_id, args, at FROM qa_steps
                     WHERE {sql.in_list('session_id')} AND kind='screen' ORDER BY at, seq""", (sql.list_param(sids),))
    seen: set[tuple[str, str]] = set()
    out = []
    for r in cur.fetchall():
        args = qs._json(r["args"], {})
        name = str(args.get("title") or r["screen_key"] or "A screen")
        key = (str(r["session_id"]), str(r["screen_key"] or r["screen_hash"] or name))
        if key in seen:
            continue
        seen.add(key)
        anchors = [str(a) for a in args.get("anchors") or []]
        body: dict[str, Any] = {"name": name, "named": False, "route": args.get("route"),
                                "summary": f"buttons: {', '.join(anchors[:4])}" if anchors else None}
        if labels:
            body["labels"] = list(dict.fromkeys(anchors + [str(t) for t in args.get("texts") or []]))[:25]
        out.append({"id": f"screen:{r['id']}", "session_id": str(r["session_id"]), "seq": r["seq"], "kind": "screen", "title": name,
                    "body": body, "frame_id": str(r["frame_id"]) if r["frame_id"] else None, "scenario_id": None,
                    "status": None, "reply_to": None, "created_at": qs.iso(r["at"])})
    return out


# ---------------------------------------------------------------- what the page reads

def _past_explorations(cur, cid: str) -> list[dict]:
    """The completed explorations a drafter reads, newest first, each with at least one step."""
    cur.execute("""SELECT s.* FROM qa_sessions s
                    WHERE s.container_id=%s AND s.kind='explore' AND s.status='done'
                      AND EXISTS (SELECT 1 FROM qa_steps st WHERE st.session_id = s.id)
                    ORDER BY s.started_at DESC""", (cid,))
    return [dict(r) for r in cur.fetchall()]


def _even(total: int, n: int) -> list[int]:
    """`n` indices spread evenly over 0..total-1 (always including the first)."""
    if total <= 0 or n <= 0:
        return []
    if total <= n:
        return list(range(total))
    step = total / n
    return sorted({min(total - 1, int(i * step)) for i in range(n)})


def _stage_frames(cur, sessions: list[dict]) -> list[dict]:
    """A few screenshots spread across each of the explorations a drafter reads."""
    picked = sessions[:EXPLORATIONS_READ]
    if not picked:
        return []
    cur.execute(f"""SELECT session_id, frame_id FROM qa_steps WHERE {sql.in_list('session_id')}
                     AND kind='screen' AND frame_id IS NOT NULL ORDER BY seq""",
                (sql.list_param([str(s["id"]) for s in picked]),))
    by_session: dict[str, list[str]] = {}
    for r in cur.fetchall():
        by_session.setdefault(str(r["session_id"]), []).append(str(r["frame_id"]))
    per = max(2, FRAMES_MAX // len(picked))
    out = []
    for s in picked:
        paths = by_session.get(str(s["id"]), [])
        out += [{"path": paths[i], "kind": s["platform"], "run_id": str(s["id"])} for i in _even(len(paths), per)]
    return out


def sources_summary(cur, cid: str) -> dict:
    """What the source picker says: how many explorations can be drafted from, the newest one,
    per platform, and the screenshots of the ones a drafting would read."""
    sessions = _past_explorations(cur, cid)
    kinds: list[dict] = []
    for s in sessions:
        row = next((k for k in kinds if k["kind"] == s["platform"]), None)
        if row:
            row["count"] += 1
        else:
            kinds.append({"kind": s["platform"], "count": 1, "latest": qs.iso(s["started_at"])})
    kinds.sort(key=lambda k: k["latest"] or "", reverse=True)
    kinds.sort(key=lambda k: k["count"], reverse=True)
    return {
        "count": len(sessions), "latest": qs.iso(sessions[0]["started_at"]) if sessions else None,
        "latestKind": sessions[0]["platform"] if sessions else None, "reports": sum(1 for s in sessions if s.get("report_md")),
        "kinds": kinds, "frames": _stage_frames(cur, sessions),
    }


def _activity(s: dict, messages: list[dict]) -> dict:
    """What the drafter is doing, from what it said: the stage's note, log and counters."""
    own = [m for m in messages if m["session_id"] == str(s["id"])]
    recent: list[str] = []
    read_files: list[str] = []
    searches = 0
    for m in own:
        if m["kind"] == "read":
            recent.append(f"Reading {m['title']}")
            if m["title"] not in read_files:
                read_files.append(m["title"])
        elif m["kind"] == "search":
            searches += int(m["body"].get("count") or 1)
            recent.append(m["title"])
        elif m["kind"] == "draft":
            recent.append(f"Drafting: {m['title']}")
        elif m["kind"] in ("note", "plan"):
            recent.append(m["title"])
    last = own[-1]["created_at"] if own else None
    phase = {"read": "reading", "search": "scanning", "draft": "drafting"}.get(own[-1]["kind"], "thinking") if own else "starting"
    return {"phase": phase, "note": recent[-1] if recent else "", "recent": recent[-RECENT_LINES:], "reads": len(read_files),
            "searches": searches, "read_files": read_files[-RECENT_LINES:], "started_at": qs.iso(s["started_at"]),
            "updated_at": qs.iso(s.get("ended_at")) or last or qs.iso(s.get("last_seen_at"))}


def _evidence(cur, ids: list[str]) -> list[dict]:
    """Every draft's evidence, with the screen each frame shows and the step it was seen at."""
    if not ids:
        return []
    cur.execute(f"""SELECT e.*, st.seq AS step, st.args AS step_args, st.session_id AS step_session FROM qa_scenario_evidence e
                    LEFT JOIN qa_steps st ON st.frame_id = e.frame_id AND st.kind='screen'
                    WHERE {sql.in_list('e.scenario_id')} ORDER BY e.criterion_index, e.created_at""", (sql.list_param(ids),))
    out: dict[str, dict] = {}
    for r in cur.fetchall():
        rid = str(r["id"])
        if rid in out:
            continue
        args = qs._json(r["step_args"], {})
        row = qs.public(r, drop=("step_args", "step_session", "container_id", "evidence"))
        row.update({"screen_name": args.get("title") or None, "route": args.get("route") or None,
                    "run_id": str(r["step_session"]) if r["step_session"] else None})
        out[rid] = row
    return list(out.values())


def _scenario_messages(cur, ids: list[str]) -> tuple[list[dict], dict[str, list[dict]]]:
    """Every draft's revisions and the feedback people left on it, from any session."""
    if not ids:
        return [], {}
    cur.execute(f"""SELECT * FROM qa_session_messages WHERE {sql.in_list('scenario_id')}
                     AND kind IN ('correction', 'feedback') ORDER BY created_at, seq""", (sql.list_param(ids),))
    corrections, feedback = [], {}
    for m in (public_message(r) for r in cur.fetchall()):
        if m["kind"] == "correction":
            corrections.append(m)
        else:
            feedback.setdefault(m["scenario_id"], []).append({"text": m["title"], "at": m["created_at"]})
    return corrections, feedback


def requests_past_time(cur, sids: list[str]) -> list[str]:
    """Requests past their time, by id. A read, so a polled board can ask before it takes the write lock."""
    if not sids:
        return []
    cur.execute(f"SELECT * FROM qa_session_messages WHERE kind='request' AND {sql.in_list('session_id')}", (sql.list_param(sids),))
    at = qs.now()
    out = []
    for r in cur.fetchall():
        limit = {"open": REQUEST_TIMEOUT_S, "claimed": ANSWER_TIMEOUT_S}.get(r["status"])
        made = _aware(r["created_at"])
        if limit and made and (at - made).total_seconds() > limit:
            out.append(str(r["id"]))
    return out


def sweep_requests(cur, sids: list[str]) -> None:
    """Requests past their time stop waiting, lazily on every board read, so nothing needs a ticker."""
    for rid in requests_past_time(cur, sids):
        cur.execute("UPDATE qa_session_messages SET status='timed_out' WHERE id=%s", (rid,))


def _aware(value: Any) -> Optional[_dt.datetime]:
    if isinstance(value, str):
        try:
            value = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, _dt.datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)


def board(cur, s: dict, labels: bool = False, *, sweep: bool = True) -> dict:
    """The drafting page's one read of a draft session, and the drafter's `read_screens`. `labels`
    adds each screen's exact labels, and the screens of the past explorations it reads."""
    sid, cid = str(s["id"]), str(s["container_id"])
    explorers = [_explorer(cur, e) for e in partners(cur, s)]
    explorer_ids = [e["id"] for e in explorers]
    if sweep:
        sweep_requests(cur, [sid])
    messages = _messages(cur, [sid] + explorer_ids)
    screens = _screens(cur, explorer_ids, labels)
    events = sorted(messages + screens, key=lambda m: (m["created_at"] or "", m["seq"]))
    for i, m in enumerate(events, start=1):
        m["board_seq"] = i
    reads_past = s.get("draft_sources") in ("exploration", "both")
    # Only this platform's: a web drafter has no use for iOS screens or their labels.
    past = [p for p in _past_explorations(cur, cid) if p["platform"] == s["platform"]] if reads_past and not explorers else []
    explorer_drafts: list[dict] = []
    if explorer_ids:
        cur.execute(f"SELECT * FROM qa_scenarios WHERE {sql.in_list('session_id')} ORDER BY created_at", (sql.list_param(explorer_ids),))
        explorer_drafts = [qs.public(r) for r in cur.fetchall()]
    cur.execute("SELECT id FROM qa_scenarios WHERE session_id=%s", (sid,))
    ids = [str(r["id"]) for r in cur.fetchall()] + [d["id"] for d in explorer_drafts]
    corrections, feedback = _scenario_messages(cur, ids)
    out = {
        "session": _session(s, explorers), "explorers": explorers, "events": events, "evidence": _evidence(cur, ids),
        "corrections": corrections, "feedback": feedback, "explorer_drafts": explorer_drafts,
        "activity": _activity(s, messages), "sources": s.get("draft_sources"), "frames": _stage_frames(cur, past),
        "explorations": sources_summary(cur, cid) if reads_past else None,
    }
    if labels:
        out["past_screens"] = _screens(cur, [str(p["id"]) for p in past[:EXPLORATIONS_READ]], True)
    return out


# ---------------------------------------------------------------- requests

def ask(cur, s: dict, who: dict, question: str, flow: Optional[str]) -> dict:
    """Queue a request for the running explorer of the draft session's task. {request, look_only}
    or a 409 that says why: the drafter then carries on from the code."""
    if s["kind"] != "draft":
        raise HTTPException(409, "only a drafting session asks an explorer")
    going = [e for e in partners(cur, s) if e["status"] == "running"]
    if not going:
        raise HTTPException(409, "no explorer is running on this task")
    sid = str(s["id"])
    sweep_requests(cur, [sid])
    cur.execute("SELECT count(*) AS n FROM qa_session_messages WHERE session_id=%s AND kind='request' AND status IN ('open','claimed')", (sid,))
    waiting = int(cur.fetchone()["n"] or 0)
    if waiting >= MAX_OPEN_REQUESTS * len(going):
        raise HTTPException(409, f"{waiting} requests are already waiting for the explorer")
    caution = destructive_reason(question)
    row = add_message(cur, s, who, "request", question.strip()[:1000], body={"flow": flow, "look_only": caution}, status="open")
    return {"request": row, "look_only": caution}


def next_request(cur, explorer: dict, who: dict) -> Optional[dict]:
    """The oldest request waiting for this explorer, claimed for it; None when none waits."""
    if explorer["kind"] != "explore":
        raise HTTPException(409, "only an exploration session takes a drafter's request")
    drafters = [str(d["id"]) for d in partners(cur, explorer)]
    if not drafters:
        return None
    sweep_requests(cur, drafters)
    cur.execute(f"""SELECT * FROM qa_session_messages WHERE {sql.in_list('session_id')} AND kind='request' AND status='open'
                     ORDER BY created_at, seq""", (sql.list_param(drafters),))
    row = cur.fetchone()
    if not row:
        return None
    cur.execute("UPDATE qa_session_messages SET status='claimed' WHERE id=%s AND status='open'", (str(row["id"]),))
    return public_message({**dict(row), "status": "claimed"})


def answer(cur, req: dict, explorer: dict, who: dict, text: str, frame_id: Optional[str], found: bool) -> dict:
    if req["kind"] != "request":
        raise HTTPException(409, "that message is not a request")
    if req["status"] not in OPEN_REQUESTS:
        raise HTTPException(409, f"that request is {req['status']}")
    question = str(req["title"])
    row = add_message(cur, explorer, who, "answer", text.strip()[:2000], body={"question": question, "found": found},
                      frame_id=frame_id, reply_to=str(req["id"]))
    cur.execute("UPDATE qa_session_messages SET status='answered' WHERE id=%s", (str(req["id"]),))
    return row
