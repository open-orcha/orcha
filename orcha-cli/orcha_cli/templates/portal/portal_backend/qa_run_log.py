"""One timeline for a QA run, in plain words: what is happening now, what happened before, and why
it waits. It stores nothing: every line is read from where it already lives.

  the task                who created it, how it ended
  worker_runs             picked up, finished, stopped and why, what it cost
  the worker's log        what the agent says and does, tailed from `worker_runs.log_path`
  managed_jobs            `orcha job` commands: the app build, with its status
  qa_sessions             the line for a device, the session, how it ended
  the device lock         who holds the device, from the lock's owner file (nothing here runs `ps`)
  qa_steps, qa_findings, qa_verdicts, requests
  this machine            memory and load, when they are clearly the cause

It is polled every few seconds on a machine that may be overloaded, so a read is one short read-only
transaction with the file work outside it, the log is read from where the last read stopped, at most
`READ_BYTES` at a time, and whatever would start a process happens on a thread, at most every
`FREE_TTL_S`. Nothing here takes a write lock.

An entry's `id` is stable, so a page merges what it has with what a poll brings: a line can change
(a run of "Reading the code" counts up, the holder of a device changes) without being repeated.
`after` is the `cursor` of the previous answer; a poll overlaps the last `OVERLAP_S` seconds because
steps reach the portal in batches, after the time they happened.
"""

from __future__ import annotations

import ctypes
import datetime as dt
import importlib
import json
import os
import re
import sys
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import qa_explorations, qa_onboarding, qa_store as qs
from portal_backend.agent_config_history_routes import redact
from portal_backend.database import db_cursor

LEVELS = ("info", "wait", "warn", "error", "done")
#: What one answer carries at most: the newest ones. A long run's first read stays small.
MAX_ENTRIES = 500
#: What a tail keeps of one worker log.
MAX_LOG_ENTRIES = 400
MAX_STEPS = 400
MAX_STEPS_AFTER = 80
#: The newest sessions and worker runs of a task that are read in full.
MAX_SESSIONS = 4
MAX_RUNS = 8
MAX_TAILED_RUNS = 3
OVERLAP_S = 120
#: One read of a worker log, and the most that is looked at when a log is opened late.
READ_BYTES = 512 * 1024
#: A longer line is a tool result or a stream delta, not something a person reads. It is skipped unparsed.
MAX_LINE_BYTES = 96 * 1024
MAX_TAILS = 12
MAX_TEXT = 220
MAX_DETAIL = 240
FREE_TTL_S = 30.0
PRESSURE_TTL_S = 30.0
#: A run this quiet on a machine under pressure: the machine is the likely cause.
QUIET_S = 45
PRESSURE_REPEAT_S = 600
SWAP_FULL = 0.85
LOAD_PER_CPU = 6.0

_SECRET_WORDS = [
    re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]{12,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"),
    re.compile(r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}"),
    re.compile(r"(?i)\b(pass(?:word|wd|code)?|secret|token|api[_-]?key|authorization)\b(\s*[=:]\s*)\S+"),
]


_OLD_NAME = re.compile(r"verdikt", re.I)


def plain(text: Any, limit: int = MAX_TEXT) -> Optional[str]:
    """Text a person can read: no secret, no code block, no Markdown marks, one line. None for
    anything that is not prose (JSON, a code block and nothing else)."""
    if not isinstance(text, str) or not text.strip():
        return None
    t, _ = redact(text)
    for pat in _SECRET_WORDS:
        t = pat.sub(lambda m: f"{m.group(1)}{m.group(2)}[redacted]" if m.groups() else "[redacted]", t)
    t = re.sub(r"```.*?(?:```|\Z)", " ", t, flags=re.S)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"(^|\s)#{1,6}\s+", r"\1", t)
    t = t.replace("**", "").replace("__", "").replace("`", "")
    t = _OLD_NAME.sub("Embodent", " ".join(t.split()))
    if not t or t[0] in "{[<" and any(c in t for c in '":='):
        return None
    return t if len(t) <= limit else t[: limit - 1].rstrip() + "…"


def clock(seconds: float) -> str:
    """`2:14`, `1:02:09`."""
    s = max(0, int(seconds))
    h, m = s // 3600, s // 60 % 60
    return f"{h}:{m:02d}:{s % 60:02d}" if h else f"{m}:{s % 60:02d}"


def when(value: Any) -> Optional[dt.datetime]:
    """A stored time as an aware datetime, or None."""
    if isinstance(value, dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
    if isinstance(value, str) and value:
        try:
            got = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return got if got.tzinfo else got.replace(tzinfo=dt.timezone.utc)
    return None


def _entry(eid: str, at: Any, level: str, kind: str, text: str, detail: Optional[str] = None, *,
           doing: Optional[str] = None, touched: Any = None) -> Optional[dict[str, Any]]:
    stamp = when(at)
    if stamp is None:
        return None
    row = {"id": eid, "at": stamp, "level": level, "kind": kind, "text": text, "touched": when(touched) or stamp}
    if detail:
        row["detail"] = detail
    if doing:
        row["doing"] = doing
    return row


# ---------------------------------------------------------------- what the agent does, in words

_READING = ("Reading the code", "reading the code")
_BUILDING = ("Building the app", "building the app")
#: Tool -> (what the line says, what the headline says after the agent's name).
_TOOLS = {
    "Read": _READING, "Grep": _READING, "Glob": _READING, "LS": _READING, "NotebookRead": _READING,
    "Edit": ("Changing files", "changing files"), "Write": ("Changing files", "changing files"),
    "NotebookEdit": ("Changing files", "changing files"),
    "WebFetch": ("Looking something up", "looking something up"), "WebSearch": ("Looking something up", "looking something up"),
    "Skill": ("Loading its instructions", "loading its instructions"),
    "Task": ("Asked a helper", "working with a helper"), "Agent": ("Asked a helper", "working with a helper"),
}
#: Nothing a person would care to read about.
_QUIET_TOOLS = {"TodoWrite", "ToolSearch", "TaskOutput", "TaskStop", "BashOutput", "KillShell", "TaskCreate", "TaskUpdate",
                "TaskList", "TaskGet", "CronCreate", "CronDelete", "CronList", "Monitor"}
#: Device actions and reads: `qa_steps` has them, with the screen they happened on.
_STEP_TOOLS = {"screen", "tap", "long_press", "type_text", "type_secret", "clear_text", "swipe", "swipe_coords", "press",
               "open_url", "launch_app", "terminate_app", "wait", "go", "find", "crawl_next", "note_impression", "verdict"}
_MCP_TOOLS = {
    "start_session": ("Asked for a device", "asking for a device"),
    "end_session": ("Finishing the session", "finishing the session"),
    "capture_evidence": ("Captured evidence", "capturing evidence"),
    "start_scenario": ("Started a scenario", "working through a scenario"),
    "get_scenario": ("Read a scenario", "reading the scenarios"), "list_project": ("Read the project's scenarios", "reading the scenarios"),
    "read_map": ("Read the app map", "reading the app map"), "map_features": ("Read the app map", "reading the app map"),
    "map_blocked": ("Read the app map", "reading the app map"), "read_screens": ("Read the app map", "reading the app map"),
    "submit_briefing": ("Wrote its briefing", "writing its briefing"), "post_plan": ("Wrote its plan", "writing its plan"),
    "charter_update": ("Updated its charter", "working through its charter"),
    "next_flow": ("Picked the next flow", "working through a flow"), "walk_step": ("Walked a flow", "working through a flow"),
    "end_walk": ("Finished a flow", "working through a flow"),
    "propose_scenario": ("Wrote a draft scenario", "drafting scenarios"), "revise_scenario": ("Revised a draft scenario", "drafting scenarios"),
    "draft_progress": ("Updated its drafting progress", "drafting scenarios"),
    "triage_finding": ("Sorted a finding", "sorting findings"), "ask_explorer": ("Asked the explorer a question", "waiting for the explorer"),
    "next_request": ("Looked for a question to answer", "working through requests"), "answer_request": ("Answered a question", "working through requests"),
}
_BUILD_COMMAND = re.compile(r"\b(xcodebuild|xcrun\s+swift\s+build|swift\s+build|gradlew|gradle\s|flutter\s+(?:build|run)|fastlane|"
                            r"(?:npm|pnpm|yarn)\s+(?:run\s+)?build|expo\s+(?:run|prebuild)|react-native\s+run|pod\s+install)")
_DEVICE_COMMAND = re.compile(r"\b(simctl|adb|idb)\b")
_READ_COMMAND = re.compile(r"^\s*(cd\s+\S+\s*(&&|;)\s*)?(ls|cat|head|tail|grep|rg|find|sed|awk|wc|git)\b")
_ORCHA_COMMAND = re.compile(r"(^|[\s;&|])orcha\s|/api/(agents|tasks|containers|requests)/")


def _bash_words(command: str) -> tuple[str, str, str]:
    """What a shell command is for: `(line, headline, kind)`. The command itself is never shown."""
    if _BUILD_COMMAND.search(command):
        return (*_BUILDING, "build")
    if _DEVICE_COMMAND.search(command):
        return "Checked the device", "checking the device", "tool"
    if _ORCHA_COMMAND.search(command):
        return "Updated its task", "updating its task", "tool"
    if _READ_COMMAND.search(command):
        return (*_READING, "tool")
    return "Ran a command", "running a command", "tool"


def tool_words(name: Any, args: Any) -> Optional[dict[str, Any]]:
    """A tool call as a log line, or None when a person need not read it."""
    if not isinstance(name, str) or name in _QUIET_TOOLS:
        return None
    args = args if isinstance(args, dict) else {}
    if name == "Bash":
        line, doing, kind = _bash_words(str(args.get("command") or ""))
        return {"kind": kind, "text": line, "doing": doing, "detail": plain(args.get("description"), MAX_DETAIL)}
    if name.startswith("mcp__"):
        tool = name.rsplit("__", 1)[-1]
        if tool in _STEP_TOOLS:
            return None
        line, doing = _MCP_TOOLS.get(tool) or (f"Used {tool.replace('_', ' ')}", f"using {tool.replace('_', ' ')}")
        return {"kind": "tool", "text": line, "doing": doing}
    words = _TOOLS.get(name)
    if words is None:
        return {"kind": "tool", "text": f"Used {name}", "doing": f"using {name}"}
    return {"kind": "tool", "text": words[0], "doing": words[1]}


def _claude_lines(o: dict[str, Any]) -> list[dict[str, Any]]:
    """The lines of one Claude stream-json event."""
    kind = o.get("type")
    at = o.get("timestamp")
    if kind == "assistant":
        if o.get("parent_tool_use_id"):
            return []  # a helper's own steps
        out: list[dict[str, Any]] = []
        for block in (o.get("message") or {}).get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                said = plain(block.get("text"))
                if said:
                    out.append({"kind": "agent", "text": said, "at": at})
            elif block.get("type") == "tool_use":
                row = tool_words(block.get("name"), block.get("input"))
                if row:
                    out.append({**row, "at": at})
        return out
    if kind == "result" and o.get("is_error"):
        said = plain(o.get("result")) or "The agent stopped with an error."
        return [{"kind": "error", "level": "error", "text": said, "at": at}]
    if kind == "rate_limit_event" and (o.get("rate_limit_info") or {}).get("status") == "rejected":
        return [{"kind": "limit", "level": "warn", "text": "The agent hit a rate limit and has to wait", "at": at}]
    if kind == "system" and o.get("subtype") == "api_retry":
        return [{"kind": "limit", "level": "warn", "text": "The model did not answer, so the agent is trying again", "at": at}]
    return []


def _codex_lines(o: dict[str, Any]) -> list[dict[str, Any]]:
    """The lines of one Codex event: `item.completed` with an agent message or a tool call."""
    item = o.get("item") if isinstance(o.get("item"), dict) else {}
    kind = item.get("type") or item.get("item_type")
    if kind in ("agent_message", "assistant_message"):
        said = plain(item.get("text"))
        return [{"kind": "agent", "text": said}] if said else []
    if kind == "command_execution":
        line, doing, tag = _bash_words(str(item.get("command") or ""))
        return [{"kind": tag, "text": line, "doing": doing}]
    if kind == "mcp_tool_call":
        row = tool_words(f"mcp__{item.get('server') or 'tools'}__{item.get('tool') or 'tool'}", None)
        return [row] if row else []
    if kind == "file_change":
        return [{"kind": "tool", "text": "Changing files", "doing": "changing files"}]
    return []


_WANTED = re.compile(rb'"(?:type|subtype)"\s*:\s*"(?:assistant|result|rate_limit_event|api_retry|item\.completed)"')


def lines_of(raw: bytes) -> list[dict[str, Any]]:
    """What one line of a worker log says. Most of a log is stream deltas and tool results: they are
    told apart by their first bytes, so they are never parsed."""
    if not _WANTED.search(raw[:96]):
        return []
    try:
        o = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(o, dict):
        return []
    return _codex_lines(o) if str(o.get("type", "")).startswith("item.") else _claude_lines(o)


# ---------------------------------------------------------------- tailing a worker log

@dataclass
class _Tail:
    path: str
    offset: int = 0
    opened: bool = False
    #: The end of a line that has not arrived whole yet.
    partial: bytes = b""
    #: Skipping a line that grew past `MAX_LINE_BYTES`, up to its end.
    skipping: bool = False
    rows: list[dict[str, Any]] = field(default_factory=list)
    last_at: Optional[dt.datetime] = None
    lock: threading.Lock = field(default_factory=threading.Lock)


_tails: "OrderedDict[str, _Tail]" = OrderedDict()
_tails_guard = threading.Lock()


def _tail_of(path: str) -> _Tail:
    with _tails_guard:
        tail = _tails.get(path)
        if tail is None:
            tail = _tails[path] = _Tail(path)
            while len(_tails) > MAX_TAILS:
                _tails.popitem(last=False)
        _tails.move_to_end(path)
        return tail


def _add_lines(tail: _Tail, rid: str, offset: int, found: list[dict[str, Any]], started: Optional[dt.datetime]) -> None:
    now = qs.now()
    for i, row in enumerate(found):
        # A line with no time (Codex) read as it happens is as old as this read.
        at = when(row.get("at")) or (now if tail.opened else (tail.last_at or started or now))
        tail.last_at = at
        last = tail.rows[-1] if tail.rows else None
        if last and last.get("kind") == row.get("kind") == "tool" and last.get("base") == row["text"]:
            last["n"] = last.get("n", 1) + 1
            last["text"] = f"{row['text']} ({last['n']})"
            last["touched"], last["last"] = now, at
            continue
        tail.rows.append(_entry(f"log:{rid[:8]}:{offset}:{i}", at, row.get("level") or "info", row.get("kind") or "agent", row["text"],
                                row.get("detail"), doing=row.get("doing"), touched=now) | {"base": row["text"], "last": at})
    del tail.rows[:-MAX_LOG_ENTRIES]


def _read_more(tail: _Tail, rid: str, started: Optional[dt.datetime]) -> None:
    """Read what was added to the log since the last read: at most `READ_BYTES`, the newest when
    there is more. A log that shrank was replaced: start over."""
    try:
        size = os.stat(tail.path).st_size
    except OSError:
        return
    if size < tail.offset:
        tail.offset, tail.partial, tail.skipping, tail.opened = 0, b"", False, False
        tail.rows.clear()
    if size == tail.offset:
        tail.opened = True
        return
    start = tail.offset
    late = size - start > READ_BYTES
    if late:
        start = size - READ_BYTES
    try:
        with open(tail.path, "rb") as f:
            f.seek(start)
            data = f.read(READ_BYTES)
    except OSError:
        return
    end = start + len(data)
    pos = start - len(tail.partial)
    if late:
        # Landed inside a line: what is before its end is dropped.
        tail.partial, tail.skipping = b"", False
        cut = data.find(b"\n")
        data = data[cut + 1:] if cut >= 0 else b""
        pos = end - len(data)
    parts = (tail.partial + data).split(b"\n")
    tail.partial = parts.pop()
    for raw in parts:
        if tail.skipping:
            tail.skipping = False
        elif len(raw) <= MAX_LINE_BYTES:
            found = lines_of(raw)
            if found:
                _add_lines(tail, rid, pos, found, started)
        pos += len(raw) + 1
    if len(tail.partial) > MAX_LINE_BYTES:
        tail.partial, tail.skipping = b"", True
    tail.offset = end
    tail.opened = True


def log_rows(path: Optional[str], rid: str, started: Any, ended: bool) -> list[dict[str, Any]]:
    """The agent's own lines of one worker run. A read in progress is not waited for: its lines
    arrive on the next poll. A run that ended and whose log is gone (or is on another machine) is
    read once from what it stored when it ended."""
    usable = bool(path) and str(path).endswith(".log")
    tail = _tail_of(str(path) if usable else f"run:{rid}")
    if tail.lock.acquire(blocking=False):
        try:
            if usable and os.path.exists(tail.path):
                _read_more(tail, rid, when(started))
            elif ended and not tail.opened:
                tail.opened = True
                _read_stored(tail, rid, when(started))
        finally:
            tail.lock.release()
    return list(tail.rows)


def _read_stored(tail: _Tail, rid: str, started: Optional[dt.datetime]) -> None:
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT output FROM worker_runs WHERE run_id=%s", (rid,))
        row = cur.fetchone()
    output = (row or {}).get("output") if row else None
    if not output:
        return
    pos = 0
    for raw in output[-READ_BYTES:].encode("utf-8", "replace").split(b"\n"):
        if len(raw) <= MAX_LINE_BYTES:
            found = lines_of(raw)
            if found:
                _add_lines(tail, rid, pos, found, started)
        pos += len(raw) + 1


# ---------------------------------------------------------------- this machine

def _swap() -> Optional[tuple[int, int]]:
    """`(used, total)` swap bytes, read without starting a process."""
    try:
        if sys.platform == "darwin":
            class Usage(ctypes.Structure):
                _fields_ = [("total", ctypes.c_uint64), ("avail", ctypes.c_uint64), ("used", ctypes.c_uint64),
                            ("pagesize", ctypes.c_uint32), ("encrypted", ctypes.c_int)]
            got, size = Usage(), ctypes.c_size_t(ctypes.sizeof(Usage))
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.sysctlbyname(b"vm.swapusage", ctypes.byref(got), ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
                return None
            return int(got.used), int(got.total)
        with open("/proc/meminfo", encoding="ascii") as f:
            info = {k.strip(): v for k, _, v in (ln.partition(":") for ln in f)}
        total = int(info["SwapTotal"].split()[0]) * 1024
        return total - int(info["SwapFree"].split()[0]) * 1024, total
    except (OSError, ValueError, KeyError, IndexError, AttributeError):
        return None


def read_pressure() -> Optional[dict[str, str]]:
    """What is wrong with this machine right now, when something clearly is."""
    word = "This Mac" if sys.platform == "darwin" else "This machine"
    try:
        load = os.getloadavg()[0]
    except OSError:
        load = 0.0
    cpus = os.cpu_count() or 1
    swap = _swap()
    facts = [f"Load {load:.0f} on {cpus} cores"] if load else []
    if swap and swap[1] >= 1 << 30:
        facts.insert(0, f"Swap {swap[0] / swap[1]:.0%} full")
        if swap[0] / swap[1] >= SWAP_FULL:
            return {"text": f"{word} is short of memory, so everything is slow", "detail": " · ".join(facts)}
    if load / cpus >= LOAD_PER_CPU:
        return {"text": f"{word} is overloaded, so everything is slow", "detail": " · ".join(facts)}
    return None


_pressure: tuple[float, Optional[dict[str, str]]] = (0.0, None)


def machine_pressure() -> Optional[dict[str, str]]:
    global _pressure
    at, got = _pressure
    if time.monotonic() - at >= PRESSURE_TTL_S or at == 0.0:
        got = read_pressure()
        _pressure = (time.monotonic(), got)
    return got


# ---------------------------------------------------------------- the device

def _locks() -> Any:
    """The machine's device locks; None on a portal that cannot see the machine."""
    try:
        return importlib.import_module("orcha_cli.qa.device.locks")
    except ImportError:
        return None


def device_holder(device: str, told: Optional[str]) -> dict[str, Any]:
    """Who holds `device`, read from the lock's owner file, with what the tool server told as the
    fallback. `{by, detail, since}`, and `by` None when no lock is on it. A lock with no owner file was
    not taken by a run: that is said as it is, naming the device."""
    locks = _locks()
    if locks is None:
        return {"by": told, "detail": None, "since": None}
    path = locks.lock_path(device)
    try:
        taken = path.stat().st_mtime
    except OSError:
        return {"by": None, "detail": None, "since": None}
    owner = locks.owner_of(path)
    since = float((owner or {}).get("claimed_at") or taken)
    held = clock(time.time() - since)
    if owner is None:
        return {"by": "another tool", "since": since,
                "detail": f"{device} has been locked for {held} by something that left no owner record: Xcode or another tool outside Embodent, not a run."}
    by = locks.held_words(owner)
    return {"by": by, "since": since, "detail": f"{by} has had {device} for {held}."}


_free: dict[str, Any] = {"at": 0.0, "rows": [], "busy": False}


def _read_free() -> None:
    try:
        listing = importlib.import_module("orcha_cli.qa.device.listing")
        _free["rows"] = listing.available()
    except Exception:  # noqa: BLE001 - no device list is no offer: nothing depends on it
        _free["rows"] = []
    finally:
        _free["at"], _free["busy"] = time.monotonic(), False


def free_device(platform: str, wanted: list[str]) -> Optional[str]:
    """Another booted device nobody holds, for a run stuck on `wanted`. The list starts processes
    (`simctl`, `adb`), so it is read on a thread at most every `FREE_TTL_S`: a poll never waits for
    it, and the offer shows on the next one."""
    if platform not in ("ios", "android"):
        return None
    if not _free["busy"] and (time.monotonic() - _free["at"] >= FREE_TTL_S or _free["at"] == 0.0):
        _free["busy"] = True
        threading.Thread(target=_read_free, name="qa-run-log-devices", daemon=True).start()
    for d in _free["rows"]:
        name = d.get("name") if d.get("kind") == "ios" else d.get("serial")
        if d.get("kind") == platform and name and name not in wanted and not d.get("held_by"):
            return str(name)
    return None


# ---------------------------------------------------------------- reading the rows

#: A finished session's `result` is its whole report: only one that waits or stopped short says anything here.
_SESSION = ("id, container_id, kind, platform, task_id, agent_id, device_name, status, started_at, ended_at, last_seen_at, queued_at, claimed_at, "
            "CASE WHEN status='done' THEN NULL ELSE result END AS result")


def _session_rows(cur, task_id: Optional[str], session_id: Optional[str]) -> list[dict[str, Any]]:
    """Every session, also one that failed before its first step: that failure is the news."""
    if session_id:
        cur.execute(f"SELECT {_SESSION} FROM qa_sessions WHERE id=%s", (session_id,))
    else:
        cur.execute(f"SELECT {_SESSION} FROM qa_sessions WHERE task_id=%s ORDER BY started_at DESC LIMIT {MAX_SESSIONS}", (task_id,))
    return [dict(s) for s in cur.fetchall()]


def read_rows(cur, task_id: Optional[str], session_id: Optional[str], has_after: bool) -> dict[str, Any]:
    """Everything the timeline is made of, in one read-only transaction. Nothing here touches a file."""
    sessions = _session_rows(cur, task_id, session_id)
    # A session speaks for itself: the read check was made on its project, not on a task it was given.
    tid = task_id if not session_id else (str(sessions[0]["task_id"]) if sessions and sessions[0].get("task_id") else None)
    out: dict[str, Any] = {"task": None, "sessions": sessions, "runs": [], "jobs": [], "requests": [], "assignee": None, "blocked": {},
                           "steps": [], "findings": [], "verdicts": [], "aliases": {}, "step_totals": {}}
    if tid:
        cur.execute("""SELECT t.id, t.container_id, t.title, t.status, t.autonomy, t.created_at, t.completed_at, a.alias AS creator, a.kind AS creator_kind
                         FROM tasks t LEFT JOIN agents a ON a.id=t.created_by_agent_id WHERE t.id=%s""", (tid,))
        row = cur.fetchone()
        out["task"] = dict(row) if row else None
        cur.execute(f"""SELECT r.run_id, r.status, r.exit_code, r.kill_reason, r.total_cost_usd, r.started_at, r.ended_at, r.log_path, a.alias
                          FROM worker_runs r JOIN agents a ON a.id=r.agent_id
                         WHERE r.task_id=%s OR r.run_id IN (SELECT run_id FROM worker_run_tasks WHERE task_id=%s)
                         ORDER BY r.started_at DESC LIMIT {MAX_RUNS}""", (tid, tid))
        out["runs"] = [dict(r) for r in cur.fetchall()]
        cur.execute("""SELECT j.job_id, j.state, j.reserved_at, (SELECT max(o.created_at) FROM managed_job_outcomes o WHERE o.job_id=j.job_id) AS ended_at
                         FROM managed_jobs j WHERE j.task_id=%s ORDER BY j.reserved_at DESC LIMIT 6""", (tid,))
        out["jobs"] = [dict(r) for r in cur.fetchall()]
        cur.execute("""SELECT r.id, r.status, r.payload, r.created_at, r.responded_at, a.alias FROM requests r JOIN agents a ON a.id=r.requester_id
                        WHERE r.originating_task_id=%s ORDER BY r.created_at DESC LIMIT 20""", (tid,))
        out["requests"] = [dict(r) for r in cur.fetchall()]
        if out["task"]:
            out["assignee"] = qa_explorations.active_assignee(cur, tid)
    open_runs = [r for r in out["runs"] if r["status"] == "running" and r["ended_at"] is None]
    if out["task"] and str(out["task"]["status"]) in qa_explorations.OPEN_TASK and not open_runs:
        # Why it stands still, in the words the onboarding uses.
        live = [s for s in sessions if s["status"] == "running" and (s["claimed_at"] or not s["queued_at"])]
        out["blocked"] = qa_onboarding._blocked(cur, str(tid), out["task"], len(live))
    for s in sessions:
        sid = str(s["id"])
        limit = MAX_STEPS_AFTER if has_after else MAX_STEPS
        cur.execute(f"""SELECT seq, kind, args, substr(result, 1, 200) AS result, at FROM qa_steps
                         WHERE session_id=%s ORDER BY seq DESC LIMIT {limit}""", (sid,))
        out["steps"] += [{**r, "session_id": sid} for r in map(dict, cur.fetchall())]
        cur.execute("SELECT count(*) AS n FROM qa_steps WHERE session_id=%s", (sid,))
        out["step_totals"][sid] = int(cur.fetchone()["n"] or 0)
        cur.execute("SELECT id, severity, title, status, created_at FROM qa_findings WHERE session_id=%s ORDER BY created_at DESC LIMIT 100", (sid,))
        out["findings"] += [dict(r) for r in cur.fetchall()]
        cur.execute("""SELECT v.id, v.verdict, v.criterion_index, v.note, v.created_at, sc.name FROM qa_verdicts v
                         LEFT JOIN qa_scenarios sc ON sc.id=v.scenario_id WHERE v.session_id=%s ORDER BY v.created_at DESC LIMIT 100""", (sid,))
        out["verdicts"] += [dict(r) for r in cur.fetchall()]
    agent_ids = sorted({str(s["agent_id"]) for s in sessions if s.get("agent_id")})
    for aid in agent_ids[:4]:
        cur.execute("SELECT alias FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
        if row:
            out["aliases"][aid] = row["alias"]
    return out


def container_of(cur, task_id: Optional[str], session_id: Optional[str]) -> str:
    """The project a run belongs to, for the read check."""
    if session_id:
        return str(qs.load_session(cur, session_id)["container_id"])
    cur.execute("SELECT container_id FROM tasks WHERE id=%s", (task_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "task not found")
    return str(row["container_id"])


# ---------------------------------------------------------------- rows into lines

_KILL_WORDS = {
    "stalled": "it stopped producing anything for too long", "hard_cap": "it ran past its time limit", "human_stop": "a person stopped it",
    "managed_checkpoint": "it paused while a background job runs", "sandbox_container_vanished": "its sandbox went away",
    "sandbox_oom": "its sandbox ran out of memory", "host_process_missing_after_notifier_restart": "its process was gone after a restart",
}
_KIND_WORDS = {"map": "mapping", "explore": "exploring", "draft": "drafting", "check": "checking"}
_VERDICT_WORDS = {"pass": "passed", "fail": "failed", "blocked": "blocked", "inconclusive": "could not be judged"}
_VERDICT_LEVEL = {"pass": "done", "fail": "error", "blocked": "warn", "inconclusive": "warn"}
_JOB_ENDS = {"completed": ("finished", "info"), "interrupted": ("was interrupted", "warn"), "exhausted": ("ran out of time", "warn"),
             "unknown": ("ended, but its result is unknown", "warn")}
OPEN_JOB = ("reserved", "running")


def kill_words(reason: Any) -> str:
    try:
        parsed = json.loads(reason) if isinstance(reason, str) else reason
    except ValueError:
        parsed = reason
    cause = parsed.get("cause") if isinstance(parsed, dict) else parsed
    words = _KILL_WORDS.get(str(cause))
    if words:
        return words
    return (isinstance(cause, str) and plain(cause.replace("_", " "), 120)) or "it was stopped before it finished"


def _cost(value: Any) -> Optional[str]:
    return f"${float(value):.2f}" if value else None


def _run_lines(r: dict[str, Any]) -> list[Optional[dict[str, Any]]]:
    rid, who = str(r["run_id"]), r["alias"]
    out = [_entry(f"run:{rid}:start", r["started_at"], "info", "run", f"{who} picked it up")]
    if r["ended_at"] is None and r["status"] == "running":
        return out
    cost = _cost(r.get("total_cost_usd"))
    spent = f" · {cost}" if cost else ""
    status = r["status"]
    if status == "killed":
        out.append(_entry(f"run:{rid}:end", r["ended_at"], "warn", "run", f"{who} was stopped: {kill_words(r.get('kill_reason'))}{spent}"))
    elif status == "rate_limited":
        out.append(_entry(f"run:{rid}:end", r["ended_at"], "warn", "run", f"{who} hit a rate limit and stopped{spent}"))
    elif status == "failed" or r.get("exit_code"):
        code = f"Exit code {r['exit_code']}" if r.get("exit_code") is not None else None
        out.append(_entry(f"run:{rid}:end", r["ended_at"], "error", "run", f"{who} stopped with an error{spent}", code))
    else:
        out.append(_entry(f"run:{rid}:end", r["ended_at"], "info", "run", f"{who} finished this turn{spent}"))
    return out


def _target(args: dict[str, Any], result: Optional[str]) -> Optional[str]:
    """What an action was on, in words: an element's text or name, never a ref or a coordinate."""
    t = args.get("target")
    if isinstance(result, str):
        said = re.search(r'"([^"\n]{1,60})"', result)
    else:
        said = None
    if isinstance(t, str) and t:
        if t.startswith("id="):
            t = t[3:].replace("_", " ").replace("-", " ")
        if not re.fullmatch(r"e\d+|-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?", t):
            return plain(t, 60)
    return plain(said.group(1), 60) if said else None


def step_words(kind: str, args: dict[str, Any], result: Optional[str]) -> Optional[str]:
    """A device step as a line. Typed text is never repeated."""
    what = _target(args, result)
    if kind == "tap":
        verb = "Long-pressed" if args.get("long_press_ms") else "Tapped"
        return f"{verb} {what}" if what else f"{verb} the screen"
    if kind == "type":
        if args.get("clear"):
            return f"Cleared {what}" if what else "Cleared a field"
        return f"Typed into {what}" if what else "Typed into a field"
    if kind == "swipe":
        return f"Swiped {args['direction']}" if args.get("direction") else "Swiped"
    if kind == "press":
        return f"Pressed {plain(args.get('key'), 30) or 'a key'}"
    if kind == "open_url":
        return "Opened a link"
    if kind == "launch":
        return "Opened the app"
    if kind == "terminate":
        return "Closed the app"
    if kind == "note" and args.get("conditions"):
        return plain(args.get("title"), 160) or "Conditions"
    if kind == "note" and args.get("title"):
        title = plain(args.get("title"), 160)
        return f"Noted: {title}" if title else None
    return None  # looking at the screen and waiting are not news; a finding and a verdict have their own lines


def _starting_of(s: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The stage of opening the device the tool server last gave, while it opens it."""
    if not s or s.get("status") != "running":
        return None
    got = qs._json(s.get("result"), None) or {}
    text = plain(got.get("starting"), 120)
    return {"text": text, "since": got.get("since") or s.get("started_at")} if text else None


def _session_lines(s: dict[str, Any], totals: dict[str, int], wait: Optional[dict[str, Any]], now: dt.datetime) -> list[Optional[dict[str, Any]]]:
    sid = str(s["id"])
    device = (s.get("device_name") or "").replace("_", " ") if s.get("platform") != "web" else "a browser"
    on = f" on {device}" if device else ""
    word = _KIND_WORDS.get(s.get("kind"), "working")
    out: list[Optional[dict[str, Any]]] = []
    queued, claimed = when(s.get("queued_at")), when(s.get("claimed_at"))
    starting = _starting_of(s)
    if wait:
        out.append(_entry(f"session:{sid}:wait", queued or s.get("started_at"), "wait", "device", wait["text"], wait.get("detail"), touched=now))
    elif queued and not claimed and s.get("status") == "running" and not starting:
        out.append(_entry(f"session:{sid}:queued", queued, "wait", "session", "In line for an agent to pick it up"))
    elif queued and claimed:
        out.append(_entry(f"session:{sid}:start", claimed, "info", "session", f"Started {word}{on}, after waiting {clock((claimed - queued).total_seconds())}"))
    else:
        out.append(_entry(f"session:{sid}:start", s.get("started_at"), "info", "session", f"Started {word}{on}"))
    if starting:
        out.append(_entry(f"session:{sid}:starting", starting["since"], "info", "device", starting["text"], touched=now))
    status = s.get("status")
    if status != "running":
        steps = totals.get(sid, 0)
        told = f"{steps} step{'' if steps == 1 else 's'}"
        ended = s.get("ended_at") or s.get("last_seen_at") or s.get("started_at")
        if status == "done":
            out.append(_entry(f"session:{sid}:end", ended, "done", "session", f"The session finished · {told}"))
        else:
            why = plain(qa_explorations.stop_reason(s)) or "It stopped before it finished"
            out.append(_entry(f"session:{sid}:end", ended, "error" if status == "failed" else "warn", "session", why, told))
    return out


def _wait_of(s: dict[str, Any]) -> Optional[dict[str, Any]]:
    """What a session in line for a device waits for, in words, with who holds it now."""
    facts = qa_explorations.waits_for(s)
    if not facts:
        return None
    device = str(facts.get("device") or "a device")
    place = int(facts.get("position") or 1)
    holder = device_holder(device, facts.get("used_by")) if facts.get("device") else {"by": facts.get("used_by"), "detail": None}
    by = holder.get("by")
    ahead = place - 1
    text = (f"Waiting for {device} · held by {by}" if by else
            f"Waiting for {device} · next in line" if not ahead else
            f"Waiting for {device} · {ahead} other run{'' if ahead == 1 else 's'} ahead")
    return {"text": text, "detail": holder.get("detail"), "device": device, "devices": [str(d) for d in facts.get("devices") or [device]],
            "held_by": by}


# ---------------------------------------------------------------- the timeline

def _moving_to(s: dict[str, Any], wait: dict[str, Any]) -> Optional[str]:
    """A person asked this queued session to use another device: `POST .../use-device`."""
    name = s.get("device_name")
    return str(name) if name and name not in wait["devices"] else None


def _lines(rows: dict[str, Any], wait: Optional[dict[str, Any]], logs: dict[str, list[dict[str, Any]]], now: dt.datetime) -> list[dict[str, Any]]:
    """Every line of the run, oldest first."""
    out: list[Optional[dict[str, Any]]] = []
    task = rows["task"]
    if task:
        who = task.get("creator")
        words = f"{who} started this run" if who else "This run was started"
        out.append(_entry("task:created", task["created_at"], "info", "task", words))
        if task["status"] == "cancelled":
            out.append(_entry("task:end", task.get("completed_at") or now, "warn", "task", "The run was cancelled", touched=task.get("completed_at")))
    for r in rows["runs"]:
        out += _run_lines(r)
    log_lines = [row for rid in logs for row in logs[rid]]
    out += log_lines
    build = any(row.get("kind") == "build" for row in log_lines)
    label = "The build" if build else "A background job"
    for j in rows["jobs"]:
        jid = str(j["job_id"])
        out.append(_entry(f"job:{jid}:start", j["reserved_at"], "info", "job", f"{label} started"))
        if j["state"] in _JOB_ENDS:
            ended, level = _JOB_ENDS[j["state"]]
            out.append(_entry(f"job:{jid}:end", j.get("ended_at") or j["reserved_at"], level, "job", f"{label} {ended}"))
    for s in rows["sessions"]:
        waiting = wait if wait and wait.get("session_id") == str(s["id"]) else None
        out += _session_lines(s, rows["step_totals"], waiting, now)
    for st in rows["steps"]:
        args = qs._json(st.get("args"), {}) or {}
        args = args if isinstance(args, dict) else {}
        words = step_words(st["kind"], args, st.get("result"))
        if not words:
            continue
        if st["kind"] == "note" and args.get("conditions"):
            # What conditions did on the device, each item in words: a person checks it happened.
            items = [plain(x, 200) for x in args.get("items") or [] if x]
            unmet = any(str(x).startswith("not met") for x in items)
            out.append(_entry(f"step:{st['session_id'][:8]}:{st['seq']}", st["at"], "warn" if unmet else "info", "conditions",
                              words, "; ".join(items)[:MAX_DETAIL] or None, doing="setting up the device"))
            continue
        failed = isinstance(st.get("result"), str) and st["result"].startswith("error")
        out.append(_entry(f"step:{st['session_id'][:8]}:{st['seq']}", st["at"], "warn" if failed else "info", "step",
                          f"{words} failed" if failed else words, plain(st["result"], MAX_DETAIL) if failed else None, doing="testing the app"))
    for f in rows["findings"]:
        if f.get("status") == "dismissed":
            continue
        serious = f.get("severity") in ("blocker", "major")
        out.append(_entry(f"finding:{f['id']}", f["created_at"], "warn" if serious else "info", "finding",
                          f"Found a {f.get('severity')} problem: {plain(f.get('title'), 160) or 'see the findings'}"))
    for v in rows["verdicts"]:
        name = plain(v.get("name"), 120) or "A scenario"
        out.append(_entry(f"verdict:{v['id']}", v["created_at"], _VERDICT_LEVEL.get(v["verdict"], "info"), "verdict",
                          f"{name}, check {int(v.get('criterion_index') or 0) + 1}: {_VERDICT_WORDS.get(v['verdict'], v['verdict'])}", plain(v.get("note"), MAX_DETAIL)))
    for q in rows["requests"]:
        asked = plain(q.get("payload"), 180)
        words = f"{q['alias']} asked: {asked}" if asked else f"{q['alias']} asked a question"
        out.append(_entry(f"request:{q['id']}", q["created_at"], "wait" if q["status"] == "open" else "info", "request", words))
        if q.get("responded_at"):
            out.append(_entry(f"request:{q['id']}:answer", q["responded_at"], "info", "request", "The question was answered"))
    return sorted((e for e in out if e), key=lambda e: e["at"])


def _is_live(rows: dict[str, Any]) -> bool:
    task = rows["task"]
    if any(s.get("status") == "running" for s in rows["sessions"]):
        return True
    if any(r["status"] == "running" and r["ended_at"] is None for r in rows["runs"]):
        return True
    if any(j["state"] in OPEN_JOB for j in rows["jobs"]):
        return True
    return bool(task) and str(task["status"]) in qa_explorations.OPEN_TASK


def _taken_over(session: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The takeover of this session, when a person is driving its device right now."""
    from portal_backend import qa_live_routes

    st = qa_live_routes._LIVE.get(str(session["id"])) if session else None
    return st.takeover if st else None


def _headline(rows: dict[str, Any], wait: Optional[dict[str, Any]], lines: list[dict[str, Any]], live: bool) -> dict[str, Any]:
    """What is true right now, for the line a person reads first."""
    task, sessions, runs = rows["task"], rows["sessions"], rows["runs"]
    open_run = next((r for r in runs if r["status"] == "running" and r["ended_at"] is None), None)
    session = sessions[0] if sessions else None
    who = (open_run or {}).get("alias") or (rows["assignee"] or {}).get("alias") or rows["aliases"].get(str((session or {}).get("agent_id"))) or "The agent"
    if live:
        asked = next((q for q in rows["requests"] if q["status"] == "open"), None)
        if asked:
            return {"state": "blocked", "level": "wait", "text": f"{asked['alias']} is waiting for an answer", "since": asked["created_at"], "request_id": str(asked["id"])}
        taken = _taken_over(session)
        if taken:
            return {"state": "waiting", "level": "wait", "text": f"A person has the device: {who} waits until it is handed back", "since": taken.get("since") or (session or {}).get("started_at")}
        if wait:
            return {"state": "waiting", "level": "wait", "text": wait["text"], "since": (session or {}).get("queued_at"), "device": wait["device"], "held_by": wait["held_by"]}
        starting = _starting_of(session)
        if starting:
            return {"state": "working", "level": "info", "text": starting["text"], "since": starting["since"]}
        doing = next((e for e in reversed(lines) if e.get("doing") and e["kind"] != "run"), None)
        job = next((j for j in rows["jobs"] if j["state"] in OPEN_JOB), None)
        if job:
            build = any(e["kind"] == "build" for e in lines)
            return {"state": "building" if build else "working", "level": "info", "since": job["reserved_at"],
                    "text": "Building the app" if build else "A background job is running"}
        if open_run:
            if doing and doing["kind"] == "build":
                return {"state": "building", "level": "info", "text": "Building the app", "since": doing["at"]}
            if doing and doing["at"] >= when(open_run["started_at"]):
                return {"state": "working", "level": "info", "text": f"{who} is {doing['doing']}", "since": doing["at"]}
            return {"state": "working", "level": "info", "text": f"{who} is starting up", "since": open_run["started_at"]}
        if session and session.get("status") == "running":
            if session.get("queued_at") and not session.get("claimed_at"):
                return {"state": "waiting", "level": "wait", "text": f"Waiting for {who} to pick it up", "since": session["queued_at"]}
            return {"state": "working", "level": "info", "text": f"{who} is {doing['doing'] if doing else 'starting up'}", "since": doing["at"] if doing else session.get("started_at")}
        reason = (rows["blocked"] or {}).get("reason")
        if reason == qa_onboarding.NO_AGENT:
            return {"state": "blocked", "level": "warn", "text": qa_onboarding.NO_AGENT_NOTE, "since": (task or {}).get("created_at")}
        if reason:
            return {"state": "blocked", "level": "wait", "text": reason.rstrip("."), "since": lines[-1]["at"] if lines else (task or {}).get("created_at")}
        return {"state": "waiting", "level": "wait", "text": f"Waiting for {who} to start", "since": (task or {}).get("created_at")}
    if session and session.get("status") == "done":
        return {"state": "done", "level": "done", "text": "This run finished", "since": session.get("ended_at")}
    if session and session.get("status") in qa_explorations.STOPPED:
        word = "failed" if session["status"] == "failed" else "stopped"
        return {"state": "ended", "level": "error" if word == "failed" else "warn", "text": f"This run {word}", "since": session.get("ended_at")}
    if task and task["status"] == "cancelled":
        return {"state": "ended", "level": "warn", "text": "This run was cancelled", "since": task.get("completed_at")}
    return {"state": "done", "level": "done", "text": "This run finished", "since": (task or {}).get("completed_at")}


def compose(rows: dict[str, Any], after: Optional[str]) -> dict[str, Any]:
    """The answer of `GET /api/qa/run-log`, from what `read_rows` read. The files are read here,
    outside the database transaction."""
    now = qs.now()
    sessions = rows["sessions"]
    live = _is_live(rows)
    wait: Optional[dict[str, Any]] = None
    if live and sessions:
        for s in sessions:
            got = _wait_of(s)
            if got:
                wait = {**got, "session_id": str(s["id"]), "moving_to": _moving_to(s, got), "platform": s.get("platform")}
                if wait["moving_to"]:
                    wait["text"] = f"Moving to {wait['moving_to']} · the agent picks this up within 30 seconds"
                break
    logs: dict[str, list[dict[str, Any]]] = {}
    for r in rows["runs"][:MAX_TAILED_RUNS]:
        logs[str(r["run_id"])] = log_rows(r.get("log_path"), str(r["run_id"]), r["started_at"], r["ended_at"] is not None)
    lines = _lines(rows, wait, logs, now)
    headline = _headline(rows, wait, lines, live)
    if wait:
        headline["session_id"] = wait["session_id"]
        if not wait["moving_to"]:
            headline["free_device"] = free_device(str(wait["platform"]), wait["devices"])
        else:
            headline["moving_to"] = wait["moving_to"]
    if live:
        quiet = (now - max(e.get("last") or e["at"] for e in lines)).total_seconds() if lines else QUIET_S
        hurt = machine_pressure() if wait or quiet >= QUIET_S else None
        if hurt:
            bucket = int(now.timestamp()) // PRESSURE_REPEAT_S
            lines.append(_entry(f"machine:{bucket}", dt.datetime.fromtimestamp(bucket * PRESSURE_REPEAT_S, dt.timezone.utc), "warn", "machine",
                                hurt["text"], hurt["detail"], touched=now))
            lines.sort(key=lambda e: e["at"])
    seen = when(after)
    shown = lines
    if seen is not None:
        since = seen - dt.timedelta(seconds=OVERLAP_S)
        shown = [e for e in lines if e["touched"] >= since]
    truncated = seen is None and len(shown) > MAX_ENTRIES
    shown = shown[-MAX_ENTRIES:]
    # The session a page moves to: not one that failed before its first step, there is nothing to watch.
    session = next((s for s in sessions if s.get("status") == "running" or rows["step_totals"].get(str(s["id"]))), None)
    return {
        "entries": [_public(e) for e in shown],
        "cursor": qs.iso(now),
        "now": {**headline, "since": qs.iso(when(headline.get("since")))},
        "live": live,
        "truncated": truncated,
        "task_id": str(rows["task"]["id"]) if rows["task"] else None,
        "session_id": str(session["id"]) if session else None,
        "platform": session.get("platform") if session else None,
    }


def _public(e: dict[str, Any]) -> dict[str, Any]:
    out = {k: e[k] for k in ("id", "level", "kind", "text")}
    out["at"] = qs.iso(e["at"])
    if e.get("detail"):
        out["detail"] = e["detail"]
    return out
