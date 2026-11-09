"""Orcha QA onboarding (migration 094; docs/orcha-qa-plan.md, "Onboarding"; a port of the original
`onboarding_map/orchestrate.py`, `store.py` and `snapshot.py`).

`act` is what a person's click does: it records the choice on the row and makes sure a thread is
advancing the phases, then answers at once. The thread calls `advance` until nothing is running:

1. **found**: the "We found" sheet (`orcha_cli.qa.onboarding.read_folder`). No model, no device,
   no network. Then it waits for `confirm`, which saves `qa_targets` from the picks.
2. **code_map**: `orcha_cli.qa.codemap.build_payload` for each picked platform, merged through
   `qa_map.import_map` (source `code`).
3. **tests**: the team's UI tests tied to the screens they talk about (source `tests`).
4. **live** waits for Run (`run_live`) or Skip (`skip_live`): the pass spends money and holds a
   device. Run creates a normal Orcha task for the picked agent (`/orcha-qa-map`) and follows it.
5. **coverage**: what the map says is covered and what is not, riskiest gap first.
6. **bring_in** (`/orcha-qa-draft`) and **first_run** (`/orcha-qa-check`) wait for the person,
   and each is a task the phase follows.

Every phase writes its state to `phases`, keyed as the UI reads it (`state`: pending, running,
done, skipped, failed, with `started_at`, `ended_at`, `note`, `estimate_usd`, plus `counts` and
`task_id`). One phase failing is written down and the flow goes on. A thread that died (a restart)
is replaced on the next read: a running free phase runs again (it is idempotent), a task phase
follows the task it already created.

`snapshot` adds what the UI's map shows, in its `OnboardingMap` shape, read from the map.
Nothing here changes a task's status: an agent's task ends at `needs_verification`, which is where
its phase moves on; a person still verifies the task.
"""

from __future__ import annotations

import datetime as _dt
import importlib
import os
import pathlib
import threading
import time
import traceback
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import HTTPException

from portal_backend import qa_explorations, qa_growth, qa_handoff, qa_map, qa_read_cache, qa_scenarios, qa_store as qs
from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.database import db_cursor
from portal_backend.limits import MAX_DESC_LEN, MAX_DOD_LEN, MAX_NAME_LEN
from portal_backend.qa_handoff import person_run_line

PHASES = ("found", "code_map", "tests", "live", "coverage", "bring_in", "first_run", "done")
STATES = ("pending", "running", "done", "skipped", "failed")
TERMINAL = frozenset({"done", "skipped", "failed"})
ACTIONS = ("start", "confirm", "run_live", "skip_live", "bring_in", "first_run", "skip", "restart")
AUTO = ("found", "code_map", "tests", "live", "coverage")
ASK = "ask"
POLL_S = 3.0
TESTS_SECONDS = 20.0
#: What a first run of the smoke set checks: a first look, not the whole suite.
SMOKE_SIZE = 10
#: How long a click may take to create its task before the thread stops waiting for it.
CLAIM_SECONDS = 30.0
MAX_DRAFT_GAPS = 10
MAX_DEVICE_LEN = 100
#: A worker that exited without a session may still resume; this long after, the phase says so
#: and fails, so a person can run it again instead of watching it wait.
WORKER_GONE_SECONDS = 180.0
#: How long what a device has installed is kept: the page polls, and the read runs commands.
INSTALLED_SECONDS = 60.0
#: Task statuses after which a phase stops following its task (the work is in).
TASK_DONE = frozenset({"needs_verification", "completed"})
TASK_STOPPED = frozenset({"cancelled"})
NOT_AVAILABLE = ("This portal can't read the project folder, so apps can't be detected here. "
                 "Add them by hand in the app settings.")
NO_FOLDER = "The project folder isn't available to this portal, so apps can't be detected. Add them by hand in the app settings."
SKIP_LIVE_NOTE = "Skipped. The map stays as the code and tests drew it."
PLATFORM_WORD = {"ios": "iOS", "android": "Android", "web": "the web"}

_threads: dict[str, threading.Thread] = {}
_threads_lock = threading.Lock()


# ---------------------------------------------------------------- what this portal can read

def detector() -> Optional[Any]:
    """`orcha_cli.qa.onboarding` when this portal runs in the CLI's interpreter, else None (a
    container portal)."""
    try:
        return importlib.import_module("orcha_cli.qa.onboarding")
    except ImportError:
        return None


def _codemap() -> Any:
    return importlib.import_module("orcha_cli.qa.codemap")


def repo_dir() -> Optional[pathlib.Path]:
    raw = (os.environ.get("ORCHA_LOCAL_REPO_DIR") or "").strip()
    path = pathlib.Path(raw) if raw else None
    return path if path is not None and path.is_dir() else None


def unavailable() -> Optional[str]:
    """Why `start` cannot run here, as a sentence for the person; None when it can."""
    if detector() is None:
        return NOT_AVAILABLE
    return None if repo_dir() is not None else NO_FOLDER


# ---------------------------------------------------------------- the row

def _fresh_phases() -> dict[str, dict[str, Any]]:
    return {p: {"state": "pending"} for p in PHASES}


def _empty(cid: str) -> dict[str, Any]:
    return {"container_id": cid, "phase": "found", "state": "idle", "found": {}, "options": {},
            "phases": _fresh_phases(), "error": None, "updated_at": None, "updated_by_agent_id": None}


def _load(cur, cid: str, *, lock: bool = False) -> Optional[dict[str, Any]]:
    cur.execute(f"SELECT * FROM qa_onboarding WHERE container_id=%s{sql.for_update() if lock else ''}", (cid,))
    row = cur.fetchone()
    if row is None:
        return None
    out = dict(row)
    out["found"] = qs._json(out.get("found"), {})
    out["options"] = qs._json(out.get("options"), {})
    out["phases"] = {**_fresh_phases(), **qs._json(out.get("phases"), {})}
    return out


def _ensure(cur, cid: str) -> dict[str, Any]:
    cur.execute(
        """INSERT INTO qa_onboarding (container_id, phase, state, phases, updated_at) VALUES (%s,'found','idle',%s,%s)
           ON CONFLICT (container_id) DO NOTHING""",
        (cid, qs.dumps(_fresh_phases()), qs.now()),
    )
    row = _load(cur, cid, lock=True)
    assert row is not None
    return row


def current_phase(phases: dict[str, Any]) -> str:
    """The first phase running, else the first one not settled."""
    for p in PHASES:
        if (phases.get(p) or {}).get("state") == "running":
            return p
    for p in PHASES:
        if (phases.get(p) or {}).get("state") not in TERMINAL:
            return p
    return "done"


def row_state(phases: dict[str, Any]) -> str:
    states = {p: (phases.get(p) or {}).get("state", "pending") for p in PHASES}
    if "running" in states.values():
        return "running"
    if states["done"] in TERMINAL:
        return "done"
    if states["found"] == "failed":
        return "failed"
    return "idle" if states["found"] == "pending" else "waiting"


def _save(cur, row: dict[str, Any], *, actor: Optional[str] = None) -> None:
    phase, state = current_phase(row["phases"]), row_state(row["phases"])
    row["phase"], row["state"] = phase, state
    cur.execute(
        """UPDATE qa_onboarding SET phase=%s, state=%s, found=%s, options=%s, phases=%s, error=%s, updated_at=%s,
                  updated_by_agent_id=COALESCE(%s, updated_by_agent_id) WHERE container_id=%s""",
        (phase, state, qs.dumps(row["found"]), qs.dumps(row["options"]), qs.dumps(row["phases"]), row.get("error"),
         qs.now(), actor, row["container_id"]),
    )


def _set(row: dict[str, Any], name: str, **fields: Any) -> None:
    """Change one phase on an in-memory row: the times follow its state; None removes a field."""
    part = dict(row["phases"].get(name) or {"state": "pending"})
    state = fields.get("state")
    now = qs.iso(qs.now())
    if state == "running" and part.get("state") != "running":
        part["started_at"], part["ended_at"] = now, None
    elif state in TERMINAL and part.get("state") not in TERMINAL:
        part["ended_at"] = now
        part.setdefault("started_at", now)
    part.update(fields)
    row["phases"][name] = {k: v for k, v in part.items() if v is not None}


def _state(row: dict[str, Any], name: str) -> str:
    return (row["phases"].get(name) or {}).get("state", "pending")


def _write_phase(cid: str, name: str, **fields: Any) -> Optional[dict[str, Any]]:
    """One phase's change from the thread: only while that phase is running, so a person's Skip
    or Restart is never written over. Returns the row, or None when the phase moved on."""
    with db_cursor() as (conn, cur):
        row = _load(cur, cid, lock=True)
        if row is None or _state(row, name) != "running":
            return None
        _set(row, name, **fields)
        _save(cur, row)
        conn.commit()
    return row


def _after(cid: str, name: str) -> None:
    """Start the next automatic phase after `name` ended, past any the person skipped. A live
    pass that waits for a click stays pending; `found` waits for `confirm`."""
    with db_cursor() as (conn, cur):
        row = _load(cur, cid, lock=True)
        if row is None:
            return
        if name in AUTO and name != "found":
            for nxt in AUTO[AUTO.index(name) + 1:]:
                state = _state(row, nxt)
                if state == "pending":
                    if nxt == "live":
                        live = row["options"].get("live", ASK)
                        if live == ASK:
                            break
                        if live is False:
                            _set(row, "live", state="skipped", note=SKIP_LIVE_NOTE)
                            continue
                    _set(row, nxt, state="running")
                    break
                if state == "running":
                    break
        if name == "first_run" and _state(row, "first_run") == "done":
            _set(row, "done", state="done")
        _save(cur, row)
        conn.commit()


# ---------------------------------------------------------------- the thread

def ensure_runner(cid: str) -> bool:
    """A thread advancing this project's phases, unless one is. A thread that died with the
    portal is gone from this table, so the next read starts another."""
    with _threads_lock:
        t = _threads.get(cid)
        if t is not None and t.is_alive():
            return False
        t = threading.Thread(target=_run, args=(cid,), daemon=True, name=f"qa-onboarding-{cid[:8]}")
        _threads[cid] = t
        t.start()
    return True


def _run(cid: str) -> None:
    try:
        while True:
            step = advance(cid)
            if step == "idle":
                return
            if step == "wait":
                time.sleep(POLL_S)
    except Exception:  # noqa: BLE001 - the next read starts another thread; never kill the portal
        print(f"[qa-onboarding] the thread for {cid} stopped:\n{traceback.format_exc()}", flush=True)


def advance(cid: str) -> str:
    """One step of the phase that is running: `more` (go on now), `wait` (a task is under way) or
    `idle` (nothing runs until the person acts)."""
    with db_cursor(readonly=True) as (_, cur):
        row = _load(cur, cid)
    if row is None:
        return "idle"
    name = next((p for p in PHASES if _state(row, p) == "running"), None)
    if name is None:
        return "idle"
    try:
        return STEPS[name](cid, row)
    except Exception as e:  # noqa: BLE001 - one phase failing is written down; the flow goes on
        print(f"[qa-onboarding] the {name} phase failed:\n{traceback.format_exc()}", flush=True)
        detail = getattr(e, "detail", None) or str(e).strip() or type(e).__name__
        _write_phase(cid, name, state="failed", note=str(detail).splitlines()[0][:200])
        _after(cid, name)
        return "more"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def step_found(cid: str, row: dict[str, Any]) -> str:
    why = unavailable()
    if why:
        raise RuntimeError(why)
    sheet = detector().read_folder(repo_dir())
    counts = {"platforms": len(sheet.get("platforms") or []), "apps": len(sheet.get("apps") or []),
              "tests": sum(int(t.get("count") or 0) for t in sheet.get("tests") or [])}
    with db_cursor() as (conn, cur):
        now = _load(cur, cid, lock=True)
        if now is None or _state(now, "found") != "running":
            return "idle"
        now["found"] = sheet
        _set(now, "found", state="done", counts=counts,
             note=f"{_plural(counts['platforms'], 'platform')}, {_plural(counts['tests'], 'UI test')}")
        _save(cur, now)
        conn.commit()
    return "idle"


def _picked(row: dict[str, Any]) -> list[str]:
    return [str(k) for k in row["options"].get("platforms") or [] if k in qs.PLATFORMS]


def step_code_map(cid: str, row: dict[str, Any]) -> str:
    root = repo_dir()
    if root is None:
        raise RuntimeError(NO_FOLDER)
    codemap = _codemap()
    totals: dict[str, int] = {}
    agent = row.get("updated_by_agent_id")
    for platform in _picked(row):
        payload = codemap.build_payload(root, platform)  # reads files: outside any transaction
        for k, v in codemap.counts(payload).items():
            totals[k] = totals.get(k, 0) + int(v)
        with db_cursor() as (conn, cur):
            qa_map.import_map(cur, cid, platform, "code", nodes=payload.get("nodes") or [],
                              edges=payload.get("edges") or [], features=(payload.get("features") or [])[:30],
                              replace_source=True, agent_id=str(agent) if agent else None)
            conn.commit()
    note = f"{_plural(totals.get('screens', 0), 'screen')}, {_plural(totals.get('endpoints', 0), 'endpoint')}"
    if _write_phase(cid, "code_map", state="done", counts=totals, note=note) is not None:
        _after(cid, "code_map")
    return "more"


def test_flows(tests: list[Any], links: dict[str, list[dict[str, Any]]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """What the map's Tests layer draws: each UI test is a flow, with a `steps` edge to each screen it
    reaches, in the order its text names them. A test tied to no screen is still a flow."""
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    for t in tests:
        key = f"{t.path}#{t.name}"[:300]
        nodes.append({"kind": "flow", "key": key, "label": t.name[:300],
                      "evidence": [{"framework": t.framework, "name": t.name, "path": t.path, "line": t.line}],
                      "detail": {"framework": t.framework, "name": t.name}})
        reached = [k for k, found in links.items() if any(f["path"] == t.path and f["name"] == t.name for f in found)]
        reached.sort(key=lambda k: (t.body.find(k) if k in t.body else len(t.body), k))
        edges += [{"kind": "steps", "from_kind": "flow", "from_key": key, "to_key": k, "detail": {"order": i}}
                  for i, k in enumerate(reached)]
    return nodes, edges


FRAMEWORK_PLATFORM = {"xcuitest": "ios", "espresso": "android", "playwright": "web", "cypress": "web"}


def tests_on(tests: list[Any], platform: str) -> list[Any]:
    """The tests that can reach this platform's screens: an XCUITest proves nothing about Android.
    A framework that runs anywhere (Maestro, Detox, Gherkin) counts on each."""
    return [t for t in tests if FRAMEWORK_PLATFORM.get(t.framework, platform) == platform]


def step_tests(cid: str, row: dict[str, Any]) -> str:
    root = repo_dir()
    if root is None:
        raise RuntimeError(NO_FOLDER)
    tests_scan = importlib.import_module("orcha_cli.qa.onboarding.tests_scan")
    risk = importlib.import_module("orcha_cli.qa.onboarding.risk")
    inv = tests_scan.scan(root, deadline=time.monotonic() + TESTS_SECONDS)
    ui = [t for t in inv.tests if t.framework in tests_scan.UI_FRAMEWORKS and tests_scan.has_screens(t)]
    linked = 0
    tied: set[tuple[str, str]] = set()
    agent = row.get("updated_by_agent_id")
    for platform in _picked(row):
        with db_cursor(readonly=True) as (_, cur):
            screens = [n for (kind, _k), n in qa_map._nodes(cur, cid, platform).items() if kind == "screen"]
        own = tests_on(ui, platform)
        links = risk.link_tests(own, screens)
        linked += len(links)
        tied |= {(f["path"], f["name"]) for found in links.values() for f in found}
        nodes = [{"kind": "screen", "key": key, "evidence": found[:30]} for key, found in links.items()]
        flows, steps = test_flows(own, links)
        with db_cursor() as (conn, cur):
            qa_map.import_map(cur, cid, platform, "tests", nodes=nodes + flows, edges=steps, features=[], replace_source=True,
                              agent_id=str(agent) if agent else None)
            conn.commit()
    counts = {"tests": len(ui), "screens": linked}
    note = f"{_plural(len(tied), 'UI test')} tied to {_plural(linked, 'screen')}"
    if _write_phase(cid, "tests", state="done", counts=counts, note=note) is not None:
        _after(cid, "tests")
    return "more"


def _runs(cur, tid: str) -> list[dict[str, Any]]:
    """The worker runs that worked this task."""
    cur.execute("""SELECT status, started_at, ended_at, total_cost_usd FROM worker_runs
                    WHERE task_id=%s OR run_id IN (SELECT run_id FROM worker_run_tasks WHERE task_id=%s)""", (tid, tid))
    return [dict(r) for r in cur.fetchall()]


def _time(value: Any) -> Optional[_dt.datetime]:
    if isinstance(value, str):
        try:
            value = _dt.datetime.fromisoformat(value)
        except ValueError:
            return None
    if isinstance(value, _dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
    return None


#: `blocked_reason` of a task nobody can pick up: the UI answers it with Add a QA agent.
NO_AGENT = "no agent"
NO_AGENT_NOTE = "No AI agent can pick this up yet. Add a QA agent to start it."


def _blocked(cur, tid: str, task: dict[str, Any], sessions: int, device_wait: Optional[str] = None,
             stopped: Optional[str] = None) -> dict[str, Any]:
    """Why a phase's task is not moving, in words: `{reason, request_id, gone, stopped}`. What the
    task's agent is waiting for comes first, then a device another run holds, then a plan nobody
    approved, then a worker that left or never came. `gone`: its worker exited long enough ago that
    nothing will pick it up. `stopped`: why its session ended short. A task with a session running
    and nothing asked is not blocked."""
    cur.execute("""SELECT r.id, r.payload, a.alias FROM requests r JOIN agents a ON a.id=r.requester_id
                    WHERE r.originating_task_id=%s AND r.status='open' ORDER BY r.created_at DESC LIMIT 1""", (tid,))
    asked = cur.fetchone()
    if asked:
        text = " ".join(str(asked["payload"] or "").split())
        return {"reason": f"{asked['alias']} is waiting for an answer: {text[:160]}", "request_id": str(asked["id"]), "gone": False}
    if device_wait:
        return {"reason": device_wait, "gone": False}
    if sessions:
        return {}
    if qa_explorations.active_assignee(cur, tid) is None:
        return {"reason": NO_AGENT, "gone": False}
    cur.execute("SELECT 1 AS hit FROM decisions WHERE subject_type='plan_approval' AND subject_id=%s LIMIT 1", (tid,))
    decided = cur.fetchone()
    cur.execute("""SELECT a.alias FROM task_messages m JOIN agents a ON a.id=m.author_id
                    WHERE m.task_id=%s AND a.kind='ai' ORDER BY m.created_at LIMIT 1""", (tid,))
    author = cur.fetchone()
    if task["status"] == "in_progress" and author and not decided and task.get("autonomy") != "on":
        return {"reason": f"{author['alias']} posted its plan and is waiting for approval.", "gone": False}
    runs = _runs(cur, tid)
    if not runs:
        return {"reason": "The task has not been picked up: no worker has started it yet.", "gone": False}
    if any(r["ended_at"] is None for r in runs):
        return {}
    ended = max((t for t in (_time(r["ended_at"]) for r in runs) if t), default=None)
    gone = ended is not None and (qs.now() - ended).total_seconds() >= WORKER_GONE_SECONDS
    return {"reason": stopped or "The agent's worker exited without starting a QA session.", "gone": gone, "stopped": bool(stopped)}


def _task_row(cid: str, tid: str) -> tuple[Optional[dict[str, Any]], dict[str, int], Optional[str], dict[str, Any]]:
    """The phase's task, what its QA sessions did so far, the newest session's status, and what
    is holding it up with its cost so far (`cost_usd`, what its runs reported)."""
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT id, status, autonomy FROM tasks WHERE id=%s AND container_id=%s", (tid, cid))
        task = cur.fetchone()
        cur.execute(f"SELECT * FROM qa_sessions WHERE task_id=%s AND {qs.STARTED_SQL} ORDER BY started_at DESC", (tid,))
        sessions = [dict(s) for s in cur.fetchall()]
        cur.execute("SELECT count(*) AS n FROM qa_findings WHERE task_id=%s", (tid,))
        findings = int(cur.fetchone()["n"] or 0)
        live = [s for s in sessions if s["status"] == "running" and (s["claimed_at"] or not s["queued_at"])]
        wait = next((w for w in map(qa_explorations.waits_for, sessions) if w), None)
        stopped = qa_explorations.stop_reason(sessions[0]) if sessions else None
        facts = _blocked(cur, tid, dict(task), len(live), (wait or {}).get("reason"), stopped) if task else {}
        if task and (facts.get("gone") or facts.get("stopped")):
            facts["run_again"] = qa_explorations.again_plan(cur, cid, tid)
        cost = sum(float(r["total_cost_usd"] or 0) for r in _runs(cur, tid))
    latest = sessions[0]["status"] if sessions else None
    facts["cost_usd"] = round(cost, 2) if cost else None
    return (dict(task) if task else None), {"sessions": len(sessions), "findings": findings}, latest, facts


def _creating(part: dict[str, Any]) -> bool:
    """A person's click is creating this phase's task right now (`claim`): leave it to them. A
    claim that old is a click that died with the portal."""
    at = part.get("creating")
    if not at:
        return False
    try:
        return (qs.now() - _dt.datetime.fromisoformat(str(at))).total_seconds() < CLAIM_SECONDS
    except ValueError:
        return False


def _follow(cid: str, row: dict[str, Any], name: str, working: str, finished: str) -> str:
    """A task phase: moves on when the task's work is in, stops with the task."""
    part = row["phases"].get(name) or {}
    tid = part.get("task_id")
    qa_explorations.sweep_abandoned(cid)
    if not tid:
        if _creating(part):
            return "wait"
        _write_phase(cid, name, state="failed", note="This step has no task to follow. Run it again.", creating=None)
        _after(cid, name)
        return "more"
    task, counts, session, facts = _task_row(cid, str(tid))
    cost, reason, request, again = facts.get("cost_usd"), facts.get("reason"), facts.get("request_id"), facts.get("run_again")
    clear = {"blocked_reason": None, "request_id": None, "cost_usd": cost, "run_again": None}
    if task is None:
        _write_phase(cid, name, state="failed", note="Its task is gone. Run it again.", counts=counts, **clear)
    elif task["status"] in TASK_DONE:
        _write_phase(cid, name, state="done", note=finished, counts=counts, **clear)
    elif task["status"] in TASK_STOPPED:
        _write_phase(cid, name, state="skipped", note="Stopped: its task was cancelled.", counts=counts, **clear)
    elif facts.get("gone"):
        _write_phase(cid, name, state="failed", note=reason, counts=counts, blocked_reason=reason, request_id=None, cost_usd=cost,
                     run_again=again)
    else:
        note = NO_AGENT_NOTE if reason == NO_AGENT else reason or ("The task is waiting for an agent" if task["status"] != "in_progress" and not session else (
            f"{working} (session {session})" if session else working))
        if (part.get("note"), part.get("counts"), part.get("blocked_reason"), part.get("request_id"), part.get("cost_usd"), part.get("run_again")) != (note, counts, reason, request, cost, again):
            _write_phase(cid, name, note=note, counts=counts, blocked_reason=reason, request_id=request, cost_usd=cost, run_again=again)
        return "wait"
    _after(cid, name)
    return "more"


def step_live(cid: str, row: dict[str, Any]) -> str:
    part = row["phases"].get("live") or {}
    if not part.get("task_id"):
        if _creating(part):
            return "wait"
        # `live: true` on confirm: the person asked for the pass when its turn comes.
        _write_phase(cid, "live", creating=qs.iso(qs.now()))
        _start_task_phase(cid, "live", row["updated_by_agent_id"], {})
        return "wait"
    return _follow(cid, row, "live", "An agent is mapping the app", "What it saw is on the map")


def step_coverage(cid: str, row: dict[str, Any]) -> str:
    with db_cursor(readonly=True) as (_, cur):
        snap = snapshot(cur, row)
    summary = snap["summary"]
    note = (f"{summary['screens'] - summary['uncovered']} of {_plural(summary['screens'], 'screen')} covered, "
            f"{_plural(len(summary['untested_critical']), 'critical gap')}")
    if _write_phase(cid, "coverage", state="done", counts=summary, note=note) is not None:
        _after(cid, "coverage")
    return "more"


def _take_baseline(cid: str) -> None:
    """Coverage Growth counts from here: the map with the team's tests in. Growth is a reading of the
    map, so it never stops the flow."""
    try:
        with db_cursor() as (conn, cur):
            qa_growth.ensure_baseline(cur, cid, "onboarding")
            conn.commit()
    except Exception:  # noqa: BLE001 - see the docstring
        traceback.print_exc()


def step_bring_in(cid: str, row: dict[str, Any]) -> str:
    moved = _follow(cid, row, "bring_in", "An agent is drafting scenarios", "The drafts are in. A person approves them.")
    if moved == "more":
        _take_baseline(cid)
    return moved


def step_first_run(cid: str, row: dict[str, Any]) -> str:
    return _follow(cid, row, "first_run", "An agent is checking the scenarios", "The first run is in")


def step_done(cid: str, row: dict[str, Any]) -> str:
    _write_phase(cid, "done", state="done")
    _take_baseline(cid)
    return "idle"


STEPS = {"found": step_found, "code_map": step_code_map, "tests": step_tests, "live": step_live,
         "coverage": step_coverage, "bring_in": step_bring_in, "first_run": step_first_run, "done": step_done}


# ---------------------------------------------------------------- task phases

def _assignee(cur, cid: str, agent_id: Optional[str]) -> Optional[str]:
    if not agent_id:
        return None
    qs.require_uuid(str(agent_id), "agent_id")
    cur.execute("SELECT alias, container_id, terminated_at FROM agents WHERE id=%s", (str(agent_id),))
    a = cur.fetchone()
    if not a or str(a["container_id"]) != cid:
        raise HTTPException(404, "That agent is not a member of this project.")
    if a["terminated_at"] is not None:
        raise HTTPException(409, "That agent is retired.")
    return a["alias"]


def _device_words(options: dict[str, Any]) -> str:
    """The device a person picked, as the task says it: `start_session` takes it as `device`."""
    device = options.get("device")
    picked = device.get("name") or device.get("viewport") if isinstance(device, dict) else None
    name = " ".join(str(picked or "").split())[:MAX_DEVICE_LEN]
    return f" Device: pass device=\"{name}\" to start_session." if name else ""


def _task_texts(name: str, row: dict[str, Any], options: dict[str, Any], saved: Optional[dict[str, str]] = None,
                who: Optional[str] = None) -> tuple[str, str, str]:
    """The task's title, body and definition of done. `saved`: the project's QA targets by platform,
    what the session will open; the app the scan guessed is only the fallback. `who`: the person
    whose click this is: the task says it is the approval of the plan."""
    found = row.get("found") or {}
    kind = options.get("platform") or detector_primary(found, row["options"])
    where = PLATFORM_WORD.get(str(kind), str(kind))
    app = (saved or {}).get(str(kind)) or next((p.get("app_id") for p in found.get("platforms") or [] if p.get("kind") == kind), None)
    on = f" Platform: {kind}" + (f", app {app}." if app else ".") + _device_words(options)
    said = person_run_line(who) + " " if who is not None else ""
    if name == "live":
        depth = options.get("depth") or "overview"
        title = f"QA onboarding: map the app on {where}"
        body = (f"{said}Run /orcha-qa-map for this project.{on} Depth: {depth}: "
                + ("the entry screen and each main area, one look each."
                   if depth == "overview" else "the riskiest gaps first, then every screen not seen yet.")
               )
        dod = f"The app on {where} is mapped: what the session saw is on the QA map, and what it could not reach is marked blocked."
    elif name == "bring_in":
        # The agent tags with the map's key (`/cart`), never the UI's id (`screen:web:/cart`).
        gaps = [str(g).split(":", 2)[-1] for g in options.get("gap_screen_ids") or []]
        title = "QA onboarding: draft scenarios for the gaps"
        lines = [f"{said}Run /orcha-qa-draft for this project.{on}"]
        if gaps:
            lines.append("Draft scenarios for these uncovered screens, riskiest first: " + ", ".join(str(g) for g in gaps) + ".")
        lines.append("Tag each draft `screen:<key>` with the screen it covers.")
        body = "\n".join(lines)
        dod = "Draft scenarios are proposed for the gaps; a person approves them."
    else:
        title = f"QA onboarding: first run on {where}"
        target, several = options.get("scenario_id"), options.get("scenario_ids")
        body = (f"{said}Run /orcha-qa-check for this project.{on} "
                + (f"Check scenario {target}." if target else
                   f"Check these scenarios, riskiest first: {', '.join(several)}." if several else "Check the validated scenarios.")
                + " One verdict per criterion.")
        dod = "Every criterion of the scenarios checked has a verdict."
    return title[:MAX_NAME_LEN], body[:MAX_DESC_LEN], dod[:MAX_DOD_LEN]


def detector_primary(found: dict[str, Any], options: dict[str, Any]) -> Optional[str]:
    want = options.get("platform")
    kinds = [p.get("kind") for p in found.get("platforms") or []]
    picked = [k for k in options.get("platforms") or [] if k in kinds] or kinds
    return str(want) if want in kinds else (str(picked[0]) if picked else None)


def _start_task_phase(cid: str, name: str, actor_id: Optional[Any], options: dict[str, Any]) -> None:
    """Create the phase's normal Orcha task (the file-as-task path) and store it on the phase. The
    caller has claimed the phase (`running`), so a double click cannot create two. A refusal puts
    the phase back and reaches the person."""
    from portal_backend import task_creation_routes
    from portal_backend.schemas import TaskCreateBody

    try:
        with db_cursor(readonly=True) as (_, cur):
            row = _load(cur, cid)
            assert row is not None
            alias = _assignee(cur, cid, options.get("agent_id") or row["options"].get("agent_id") or qa_handoff.qa_agent_id(cur, cid))
            cur.execute("SELECT platform, app_id FROM qa_targets WHERE container_id=%s", (cid,))
            saved = {str(t["platform"]): str(t["app_id"]) for t in cur.fetchall() if t["app_id"]}
            cur.execute("SELECT alias FROM agents WHERE id=%s AND kind='human'", (str(actor_id),))
            person = cur.fetchone()
        title, body, dod = _task_texts(name, row, options, saved, person["alias"] if person else None)
        created = task_creation_routes.create_task(
            cid, TaskCreateBody(title=title, description=body, definition_of_done=dod,
                                created_by_agent_id=str(actor_id) if actor_id else None, assignee_alias=alias),
            qs.internal_request(),
        )
    except HTTPException:
        with db_cursor() as (conn, cur):
            now = _load(cur, cid, lock=True)
            if now is not None:
                _set(now, name, state="pending", started_at=None, ended_at=None, note=None, creating=None)
                _save(cur, now)
                conn.commit()
        raise
    with db_cursor() as (conn, cur):
        from portal_backend import qa_run_tasks

        qa_run_tasks.mark(cur, cid, str(created["task_id"]), "onboarding", kind={"live": "map", "bring_in": "draft", "first_run": "check"}.get(name))
        if person:  # the click that started this is the plan's approval
            qa_handoff.approve_plan(cur, str(created["task_id"]), str(actor_id), person_run_line(person["alias"]))
        now = _load(cur, cid, lock=True)
        if now is not None:
            who = f" to {alias}" if alias else "; no agent picked, so it waits in the queue"
            _set(now, name, task_id=str(created["task_id"]), note=f"Task created{who}", creating=None)
            _save(cur, now)
            conn.commit()


def _go_on(cur, cid: str, row: dict[str, Any], name: str) -> Optional[dict[str, Any]]:
    """Run again on a phase whose task is still open: what `again_plan` says, so the click goes on
    with that task. None when there is none: the click creates one."""
    tid = (row["phases"].get(name) or {}).get("task_id")
    plan = qa_explorations.again_plan(cur, cid, str(tid)) if tid else None
    return plan if plan and plan["task_id"] else None


def _carry_on(cur, cid: str, who: dict[str, Any], plan: dict[str, Any]) -> None:
    qa_handoff.approve_plan(cur, plan["task_id"], who["id"], person_run_line(who.get("alias") or ""))
    qa_explorations.resume_task(cur, cid, plan["task_id"], plan, who)


def _reassign(cid: str, tid: str, who: dict[str, Any], agent_id: str) -> None:
    """A person picked an agent for a task that goes on: the normal assignment moves it."""
    from portal_backend import task_assignment_routes
    from portal_backend.schemas.task_operations import AssignTask

    task_assignment_routes.assign_task(tid, AssignTask(actor_agent_id=who["id"], agent_id=str(agent_id), reassign=True), qs.internal_request())


def waiting_tasks(cur, cid: str) -> list[str]:
    """QA's open tasks nobody has: the ones a phase, a QA request or a queued session follows."""
    cur.execute("SELECT phases FROM qa_onboarding WHERE container_id=%s", (cid,))
    row = cur.fetchone()
    phases = qs._json(row["phases"], {}) if row else {}
    ids = {str(p["task_id"]) for p in phases.values() if isinstance(p, dict) and p.get("task_id")}
    cur.execute("SELECT qa_task_id AS id FROM qa_requests WHERE container_id=%s AND qa_task_id IS NOT NULL AND finished_at IS NULL", (cid,))
    ids |= {str(r["id"]) for r in cur.fetchall()}
    cur.execute("""SELECT task_id AS id FROM qa_sessions WHERE container_id=%s AND status='running' AND task_id IS NOT NULL
                     AND queued_at IS NOT NULL AND claimed_at IS NULL""", (cid,))
    ids |= {str(r["id"]) for r in cur.fetchall()}
    waiting = []
    for tid in sorted(ids):
        cur.execute("SELECT status, is_root FROM tasks WHERE id=%s", (tid,))
        t = cur.fetchone()
        if t and t["status"] in ("ready", "pending") and not t["is_root"] and qa_explorations.active_assignee(cur, tid) is None:
            waiting.append(tid)
    return waiting


def give_waiting_tasks(cid: str, who: dict[str, Any], agent_id: str) -> list[str]:
    """Assign every waiting QA task to `agent_id` through the normal assignment, which wakes it. No
    task is created: a phase that was waiting follows the one it has."""
    from portal_backend import task_assignment_routes
    from portal_backend.schemas.task_operations import AssignTask

    with db_cursor(readonly=True) as (_, cur):
        tasks = waiting_tasks(cur, cid)
    for tid in tasks:
        task_assignment_routes.assign_task(tid, AssignTask(actor_agent_id=who["id"], agent_id=agent_id), qs.internal_request())
    if tasks:
        with db_cursor() as (conn, cur):
            cur.execute(f"""UPDATE qa_sessions SET agent_id=%s WHERE agent_id IS NULL AND status='running'
                             AND queued_at IS NOT NULL AND claimed_at IS NULL AND {sql.in_list('task_id')}""", (agent_id, sql.list_param(tasks)))
            conn.commit()
    with db_cursor(readonly=True) as (_, cur):
        row = _load(cur, cid)
    if row is not None and row["state"] == "running":
        ensure_runner(cid)
    return tasks


# ---------------------------------------------------------------- what a click does

def _clean_web(pick: dict[str, Any]) -> None:
    url = str(pick.get("app_id") or "").strip()
    if url:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise HTTPException(400, "A web app's address is the http(s) URL to open.")
    device = str(pick.get("device_name") or "").strip()
    if device and device not in qs.WEB_VIEWPORTS:
        raise HTTPException(400, "A web app's device is desktop or mobile.")


def _picks(row: dict[str, Any], options: dict[str, Any]) -> list[dict[str, Any]]:
    """The platforms to set up: the person's list (`[{kind, app_id?, app_name?, device_name?,
    build_path?}]`, or plain kinds), each over what was found, else everything found."""
    found = {p.get("kind"): p for p in (row.get("found") or {}).get("platforms") or []}
    raw = options.get("platforms")
    if raw is None:
        raw = list(found)
    if not isinstance(raw, list):
        raise HTTPException(400, "platforms is a list of the platforms to set up.")
    out = []
    for item in raw:
        pick = {"kind": item} if isinstance(item, str) else dict(item) if isinstance(item, dict) else {}
        kind = pick.get("kind")
        if kind not in qs.PLATFORMS:
            raise HTTPException(400, "A platform is ios, android or web.")
        seen = found.get(kind) or {}
        merged = {"kind": kind, "app_id": pick.get("app_id") or seen.get("app_id"),
                  "app_name": pick.get("app_name"), "device_name": pick.get("device_name"),
                  "build_path": pick.get("build_path"), "path": seen.get("path")}
        if kind == "web":
            _clean_web(merged)
        out.append(merged)
    return out


def _save_targets(cur, cid: str, picks: list[dict[str, Any]], actor: str) -> None:
    """Upsert `qa_targets`: what is picked wins, and what the person set before and left empty
    here (a build path, notes) stays."""
    for p in picks:
        cur.execute(
            """INSERT INTO qa_targets (container_id, platform, app_id, app_name, device_name, build_path, updated_at,
                                       updated_by_agent_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (container_id, platform) DO UPDATE SET
                 app_id=COALESCE(EXCLUDED.app_id, qa_targets.app_id),
                 app_name=COALESCE(EXCLUDED.app_name, qa_targets.app_name),
                 device_name=COALESCE(EXCLUDED.device_name, qa_targets.device_name),
                 build_path=COALESCE(EXCLUDED.build_path, qa_targets.build_path),
                 updated_at=EXCLUDED.updated_at, updated_by_agent_id=EXCLUDED.updated_by_agent_id""",
            (cid, p["kind"], p.get("app_id"), p.get("app_name"), p.get("device_name"), p.get("build_path"), qs.now(), actor),
        )


def _pick_live_platform(row: dict[str, Any], kind: Any) -> None:
    """The platform a person chose for the live pass: what the Map step says and what the run opens.
    No choice, or one that is not among the picks, leaves the first picked platform in charge."""
    picks = row["options"].get("platforms")
    if kind in qs.PLATFORMS and (not picks or kind in picks):
        row["options"]["platform"] = kind
        row["found"]["live_platform"] = {"kind": kind, "why": "You picked it on the We found sheet."}
    else:
        row["options"].pop("platform", None)
        row["found"].pop("live_platform", None)


def _answer(row: dict[str, Any]) -> dict[str, Any]:
    return {"project_id": row["container_id"], "container_id": row["container_id"], "phase": row["phase"],
            "state": row["state"], "phases": public_phases(row["phases"]), "error": row.get("error")}


def _reread(cid: str) -> dict[str, Any]:
    with db_cursor(readonly=True) as (_, cur):
        row = _load(cur, cid)
    assert row is not None
    return row


def act(cid: str, who: dict[str, Any], action: str, options: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Do what the person clicked and answer the phases at once. A step that cannot happen now
    answers 409 with a sentence that says why."""
    options = dict(options or {})
    actor = who["id"]
    if action == "start":
        why = unavailable()
        if why:
            raise HTTPException(409, why)
    task_phase: Optional[str] = None
    importing = False
    went_on: Optional[dict[str, Any]] = None
    with db_cursor() as (conn, cur):
        row = _ensure(cur, cid)
        phases_running = any(_state(row, p) == "running" for p in PHASES)
        if action == "start":
            if phases_running:
                return _answer_after(row, cid)
            keep = {k: row["options"][k] for k in ("agent_id",) if k in row["options"]}
            row.update(found={}, options={**keep, **_kept(options)}, phases=_fresh_phases(), error=None)
            _set(row, "found", state="running")
        elif action == "confirm":
            if _state(row, "found") != "done":
                raise HTTPException(409, "Look at what was found first: the found step has not finished.")
            if phases_running:
                return _answer_after(row, cid)
            picks = _picks(row, options)
            if not picks:
                raise HTTPException(409, "Nothing to map: no platform was found or picked.")
            _save_targets(cur, cid, picks, actor)
            log_event(cur, cid, "human", actor, "container", cid, "qa_onboarding_confirmed",
                      {"platforms": [p["kind"] for p in picks]})
            live = options.get("live", ASK)
            row["options"].update({"platforms": [p["kind"] for p in picks], "live": live if live in (ASK, True, False) else ASK})
            _pick_live_platform(row, options.get("platform"))
            if options.get("agent_id"):
                _assignee(cur, cid, options["agent_id"])
                row["options"]["agent_id"] = str(options["agent_id"])
            for p in ("code_map", "tests", "live", "coverage"):
                _set(row, p, state="pending", started_at=None, ended_at=None, note=None, counts=None, task_id=None)
            _set(row, "live", estimate_usd=_estimate_live())
            _set(row, "code_map", state="running")
        elif action == "skip_live":
            if _state(row, "live") in ("done", "failed"):
                raise HTTPException(409, "The live pass has already ended.")
            row["options"]["live"] = False
            _set(row, "live", state="skipped", note=SKIP_LIVE_NOTE)
            if _state(row, "tests") == "done" and _state(row, "coverage") == "pending":
                _set(row, "coverage", state="running")
        elif action == "run_live":
            if _state(row, "live") == "running":
                return _answer_after(row, cid)
            if _state(row, "tests") != "done":
                raise HTTPException(409, "Map the code and tests first.")
            depth = options.get("depth") if options.get("depth") in ("overview", "deeper") else "overview"
            if options.get("platform") and options["platform"] not in qs.PLATFORMS:
                raise HTTPException(400, "A platform is ios, android or web.")
            options["depth"] = depth
            row["options"].update({"live": True, "live_depth": depth})
            if options.get("platform"):
                _pick_live_platform(row, options["platform"])
            if options.get("agent_id"):
                row["options"]["agent_id"] = str(options["agent_id"])
            went_on = _go_on(cur, cid, row, "live")
            _set(row, "live", state="running", note=None, task_id=(went_on or {}).get("task_id"), counts=None, estimate_usd=_estimate_live(depth),
                 creating=None if went_on else qs.iso(qs.now()), blocked_reason=None, request_id=None, cost_usd=None, run_again=None)
            if _state(row, "coverage") in TERMINAL:
                _set(row, "coverage", state="pending", started_at=None, ended_at=None, note=None, counts=None)
            task_phase = None if went_on else "live"
        elif action == "bring_in":
            if _state(row, "tests") != "done":
                raise HTTPException(409, "Map the app first: the tests step has not finished.")
            if _state(row, "bring_in") == "running":
                return _answer_after(row, cid)
            snap = snapshot(cur, row)
            gaps = [str(g) for g in options.get("gap_screen_ids") or []] or snap["bring_in"]["draft"]["gap_screen_ids"]
            known = {s["id"] for s in snap["screens"]}
            gaps = [g for g in gaps if g in known][:MAX_DRAFT_GAPS]
            options["gap_screen_ids"] = gaps
            migrate = options.get("migrate", True) is not False
            wants_drafts = options.get("draft", True) is not False
            if not wants_drafts and not migrate:
                raise HTTPException(409, "Pick what to bring in: the existing tests, drafts for the gaps, or both.")
            row["options"]["bring_in"] = {k: options[k] for k in ("migrate", "draft", "frameworks", "areas") if k in options}
            row["options"]["draft_gaps"] = gaps
            went_on = _go_on(cur, cid, row, "bring_in") if gaps and wants_drafts else None
            _set(row, "bring_in", state="running", note=None, task_id=(went_on or {}).get("task_id"), counts=None,
                 creating=None if went_on else qs.iso(qs.now()), blocked_reason=None, request_id=None, run_again=None,
                 estimate_usd=snap["bring_in"]["draft"]["estimate_usd"] if gaps and wants_drafts else 0.0)
            # Only drafting for the gaps takes an agent. Your tests come in right here, for free.
            task_phase = "bring_in" if gaps and wants_drafts and not went_on else None
            importing = migrate
        elif action == "first_run":
            if _state(row, "first_run") == "running":
                return _answer_after(row, cid)
            scenario_id = options.get("scenario_id")
            if scenario_id:
                sc = qs.load_scenario(cur, str(scenario_id))
                if str(sc["container_id"]) != cid:
                    raise HTTPException(404, "No such scenario in this project.")
                options["platform"] = options.get("platform") or sc["platform"]
            elif options.get("suite") not in (None, "smoke"):
                raise HTTPException(400, 'A first run takes a scenario_id or the suite "smoke".')
            elif _state(row, "bring_in") != "done":
                raise HTTPException(409, "Bring your tests in first: the smoke suite is what that brings.")
            else:
                options["scenario_ids"] = snapshot(cur, row)["smoke"]["scenario_ids"]
            row["options"]["first_run"] = {k: options[k] for k in ("scenario_id", "scenario_ids", "suite", "platform") if options.get(k)}
            went_on = _go_on(cur, cid, row, "first_run")
            _set(row, "first_run", state="running", note=None, task_id=(went_on or {}).get("task_id"), counts=None,
                 creating=None if went_on else qs.iso(qs.now()), blocked_reason=None, request_id=None, run_again=None)
            _set(row, "done", state="pending", started_at=None, ended_at=None)
            task_phase = None if went_on else "first_run"
        elif action == "skip":
            for p in PHASES[:-1]:
                if _state(row, p) not in TERMINAL:
                    _set(row, p, state="skipped", note="Skipped.")
            _set(row, "done", state="done")
        elif action == "restart":
            keep = {k: row["options"][k] for k in ("agent_id",) if k in row["options"]}
            row.update(found={}, options=keep, phases=_fresh_phases(), error=None)
        else:
            raise HTTPException(400, f"Unknown action: {action}.")
        _save(cur, row, actor=actor)
        if went_on:
            _carry_on(cur, cid, who, went_on)
        conn.commit()
    imported = _import_tests(cid, who, row, options) if importing else None
    if went_on and options.get("agent_id"):
        _reassign(cid, went_on["task_id"], who, str(options["agent_id"]))
    if task_phase:
        _start_task_phase(cid, task_phase, actor, options)
    elif action == "bring_in" and not went_on:
        _finish_import(cid, imported)
    if action == "skip":  # leaving the flow finishes it: there is no phase left to take this
        _take_baseline(cid)
    row = _reread(cid)
    if row["state"] == "running":
        ensure_runner(cid)
    return _answer(row)


def _import_tests(cid: str, who: dict[str, Any], row: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
    """Every detected UI test as a draft scenario pointing at its file, now, in this click: no
    model, no agent, no cost (`test_import.convert_sources`). `frameworks` narrows it."""
    root = repo_dir()
    if root is None:
        return {"imported": 0, "error": NO_FOLDER}
    tests_scan = importlib.import_module("orcha_cli.qa.onboarding.tests_scan")
    risk = importlib.import_module("orcha_cli.qa.onboarding.risk")
    importer = importlib.import_module("orcha_cli.qa.onboarding.test_import")
    inv = tests_scan.scan(root, deadline=time.monotonic() + TESTS_SECONDS)
    wanted = set(options.get("frameworks") or [])
    ui = [t for t in inv.tests if t.framework in tests_scan.UI_FRAMEWORKS and tests_scan.has_screens(t)
          and (not wanted or t.framework in wanted)]
    picked = _picked(row)
    if not picked:
        kind = detector_primary(row.get("found") or {}, row["options"])
        picked = [kind] if kind else []
    screens_of: dict[tuple[str, str, str], list[str]] = {}
    with db_cursor(readonly=True) as (_, cur):
        for platform in picked:
            screens = [n for (kind, _k), n in qa_map._nodes(cur, cid, platform).items() if kind == "screen"]
            for key, links in risk.link_tests(ui, screens).items():
                for link in links:
                    screens_of.setdefault((platform, link["path"], link["name"]), []).append(key)
    rows = importer.convert_sources(ui, picked, screens_of)
    counts = {"imported": 0, "suggested": 0, "detected": len(ui), "errors": 0}
    with db_cursor() as (conn, cur):
        for r in rows:
            try:
                got = qa_scenarios.propose(cur, cid, who, r["platform"], r["fields"], r["evidence"], "Brought in from the team's own test.")
            except HTTPException:
                counts["errors"] += 1
                continue
            counts["suggested" if got["outcome"] == "suggested" else "imported"] += 1
        log_event(cur, cid, "human", who["id"], "container", cid, "qa_tests_imported", counts)
        conn.commit()
    return counts


def _finish_import(cid: str, counts: Optional[dict[str, Any]]) -> None:
    """Nothing left for an agent: the phase ends now, at no cost."""
    if counts and counts.get("error"):
        _write_phase(cid, "bring_in", state="failed", note=counts["error"], creating=None)
    else:
        n = int((counts or {}).get("imported") or 0)
        _write_phase(cid, "bring_in", state="done", note=f"{_plural(n, 'test')} brought in as drafts", counts=counts,
                     creating=None, cost_usd=None)
    _after(cid, "bring_in")
    _take_baseline(cid)


def _answer_after(row: dict[str, Any], cid: str) -> dict[str, Any]:
    """Already under way: follow it."""
    ensure_runner(cid)
    return _answer(row)


def _kept(options: dict[str, Any]) -> dict[str, Any]:
    return {k: options[k] for k in ("live", "platform", "agent_id") if k in options}


def _estimate_live(depth: str = "overview") -> Optional[float]:
    try:
        return float(importlib.import_module("orcha_cli.qa.onboarding.estimates").crawl(depth))
    except ImportError:
        return None


# ---------------------------------------------------------------- reading

def public_phases(phases: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for p in PHASES:
        part = phases.get(p) if isinstance(phases.get(p), dict) else {}
        entry: dict[str, Any] = {"state": part.get("state") if part.get("state") in STATES else "pending"}
        for k in ("started_at", "ended_at", "note", "task_id", "counts", "blocked_reason", "request_id", "run_again"):
            if part.get(k):
                entry[k] = part[k]
        for k in ("cost_usd", "estimate_usd"):
            if isinstance(part.get(k), (int, float)):
                entry[k] = round(float(part[k]), 2)
        out[p] = entry
    return out


def _risk_module() -> Optional[Any]:
    try:
        return importlib.import_module("orcha_cli.qa.onboarding.risk")
    except ImportError:
        return None


def screen_id(platform: str, key: str) -> str:
    return f"screen:{platform}:{key}"


def _coverage(tests: list[Any], scenarios: list[Any]) -> str:
    if tests and scenarios:
        return "both"
    return "your_tests" if tests else ("qa" if scenarios else "none")


def _scenario_screens(cur, cid: str) -> dict[tuple[str, str], list[dict[str, Any]]]:
    """(platform, screen key) -> the scenarios that cover it: tagged `screen:<key>`, or walked
    through it."""
    cur.execute("SELECT * FROM qa_scenarios WHERE container_id=%s AND status<>'retired'", (cid,))
    rows = [dict(r) for r in cur.fetchall()]
    walks: dict[str, list[str]] = {}
    cur.execute("SELECT id, steps FROM qa_walks WHERE container_id=%s AND scenario_id IS NOT NULL", (cid,))
    for w in cur.fetchall():
        walks[str(w["id"])] = [str(s.get("screen_key")) for s in qs._json(w["steps"], []) if isinstance(s, dict) and s.get("screen_key")]
    out: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for r in rows:
        tags = [str(t) for t in qs._json(r.get("tags"), [])]
        keys = {t[len("screen:"):] for t in tags if t.startswith("screen:")}
        keys |= set(walks.get(str(r.get("walk_id")), []))
        origin = "traced" if r.get("source") == "walk" else "imported" if any(t.startswith("test:") for t in tags) else "drafted"
        entry = {"id": str(r["id"]), "name": r["name"], "status": r["status"], "origin": origin}
        for k in keys:
            out.setdefault((r["platform"], k), []).append(entry)
    return out


def _first_runs(cur, row: dict[str, Any], first: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The first run's verdict, for the screen its scenario sits on."""
    pick = (row["options"].get("first_run") or {}).get("scenario_id") or (first or {}).get("scenario_id")
    tid = (row["phases"].get("first_run") or {}).get("task_id")
    if not pick or not tid:
        return None
    cur.execute(
        """SELECT v.verdict, v.note, s.id AS session_id FROM qa_verdicts v JOIN qa_sessions s ON s.id=v.session_id
            WHERE s.task_id=%s AND v.scenario_id=%s ORDER BY v.created_at""",
        (str(tid), str(pick)),
    )
    rows = cur.fetchall()
    state = _state(row, "first_run")
    if not rows:
        # No verdict yet: the session already streams, as soon as the agent has started it.
        cur.execute("SELECT id FROM qa_sessions WHERE task_id=%s ORDER BY started_at DESC LIMIT 1", (str(tid),))
        session = cur.fetchone()
        return {"scenario_id": str(pick), "run_id": str(session["id"]) if session else "", "verdict": "running" if state == "running" else "queued"}
    bad = next((r for r in rows if r["verdict"] in ("fail", "blocked")), None)
    verdict = "fail" if bad else ("running" if state == "running" else "pass")
    out = {"scenario_id": str(pick), "run_id": str(rows[0]["session_id"]), "verdict": verdict}
    if state != "running":
        out["outcome"] = "failed" if bad else "passed"
    if bad and bad["note"]:
        out["finding"] = str(bad["note"])[:200]
    return out


def _map_part(cur, row: dict[str, Any]) -> dict[str, Any]:
    """The heavy part of the snapshot, from the map alone: `screens`, `edges`, `files`, `gaps` and
    `summary`. A screen's `coverage` is `your_tests`, `qa` (a QA scenario covers it), `both` or
    `none`. Cached per map version by `_map_of`: callers must not change what it returns."""
    cid = str(row["container_id"])
    risk = _risk_module()
    by_scenario = _scenario_screens(cur, cid)
    screens: list[dict[str, Any]] = []
    edges: list[dict[str, str]] = []
    files: dict[str, list[str]] = {}
    gaps: list[dict[str, Any]] = []
    picked = [str(k) for k in row["options"].get("platforms") or []] or list(qs.PLATFORMS)
    for platform in picked:
        nodes = list(qa_map._nodes(cur, cid, platform).values())
        rows_e = list(qa_map._edges(cur, cid, platform).values())
        shown = [n for n in nodes if n["kind"] == "screen"]
        graph = risk.Graph(nodes, rows_e) if risk else None
        risks = risk.rank(graph, shown) if risk else {}
        ids = {str(n["id"]): screen_id(platform, n["key"]) for n in shown}
        for e in rows_e:
            a, b = ids.get(str(e["from_node_id"])), ids.get(str(e["to_node_id"]))
            kind = {"navigates": "nav", "calls": "calls", "reads": "reads", "writes": "writes"}.get(e["kind"])
            if a and b and a != b and kind:
                edges.append({"from": a, "to": b, "kind": kind})
        by_file = risk.code_calls(graph) if risk else {}
        for n in shown:
            sid = ids[str(n["id"])]
            sources = n.get("sources") or []
            seen_live = n["state"] == "seen"
            evidence = n.get("evidence") or {}
            tests = [{**t, "line": t.get("line")} for t in (evidence.get("tests") or []) if isinstance(t, dict) and t.get("name")]
            scen = by_scenario.get((platform, n["key"]), [])
            r = risks.get(str(n["id"]))
            own_files = risk.screen_files(n) if risk else []
            for f in own_files:
                files.setdefault(f, []).append(sid)
            calls = [ep["key"] for ep in risk.screen_calls(graph, n, by_file)] if risk else []
            screen: dict[str, Any] = {
                "id": sid, "name": n["label"], "platform": platform,
                "source": "both" if seen_live and ("code" in sources or "tests" in sources) else ("live" if seen_live else "code"),
                "files": own_files, "endpoints": calls, "coverage": _coverage(tests, scen), "tests": tests,
                "scenarios": scen, "risk": r.json() if r else {"score": 5, "reasons": []},
            }
            if str(n["key"]).startswith("/"):
                screen["route"] = n["key"]
            if n.get("frame_id"):
                screen["thumbnail"] = f"/api/qa/frames/{n['frame_id']}"
            screens.append(screen)
            if screen["coverage"] == "none":
                gaps.append({"screen_id": sid, "risk": screen["risk"]["score"],
                             "reason": (screen["risk"]["reasons"] or ["Nothing covers it"])[0]})
    gaps.sort(key=lambda g: (-g["risk"], g["screen_id"]))
    critical = risk.CRITICAL if risk else 50
    by_cov = [s["coverage"] for s in screens]
    summary = {"screens": len(screens), "covered_by_tests": sum(c in ("your_tests", "both") for c in by_cov),
               "covered_by_qa": sum(c in ("qa", "both") for c in by_cov),
               "uncovered": by_cov.count("none"), "untested_critical": [g["screen_id"] for g in gaps if g["risk"] >= critical]}
    return {"screens": screens, "edges": edges, "files": [{"path": p, "screen_ids": v} for p, v in sorted(files.items())],
            "gaps": gaps, "summary": summary}


#: The keys of `_map_part`: what a poll leaves out when its `since` still stands.
MAP_KEYS = ("screens", "edges", "files", "gaps", "summary")


def _picked(row: dict[str, Any]) -> tuple[str, ...]:
    return tuple(str(k) for k in row["options"].get("platforms") or []) or tuple(qs.PLATFORMS)


def snapshot_version(cur, row: dict[str, Any]) -> str:
    """What the map part depends on, read in a few milliseconds."""
    return f"{qa_read_cache.map_version(cur, str(row['container_id']))}.{'-'.join(_picked(row))}"


def _map_of(cur, row: dict[str, Any], version: str) -> dict[str, Any]:
    return qa_read_cache.get(("onboarding", str(row["container_id"])), version, lambda: _map_part(cur, row))


def _run_part(cur, row: dict[str, Any], part: dict[str, Any]) -> dict[str, Any]:
    """What changes while a phase runs, on top of the map part: a few small reads, so a poll can
    carry it. `first_run_screen` says which screen `first_run` belongs on."""
    cid = str(row["container_id"])
    screens, gaps = part["screens"], part["gaps"]
    found = row.get("found") or {}
    # A drafting task and a first run are on one platform: the one the pass was on, the first picked otherwise.
    here = row["options"].get("platform") or detector_primary(found, row["options"])
    gap_ids = [g["screen_id"] for g in gaps if not here or g["screen_id"].startswith(f"screen:{here}:")][:MAX_DRAFT_GAPS]
    est = _estimates()
    first = _first_test(cur, cid, screens, est, here)
    first_result = _first_runs(cur, row, first)
    projected = _state(row, "bring_in") != "done"
    # Only what exists: First run is reached by skipping too, and a skipped draft adds nothing.
    smoke = _smoke_ids(cur, cid, screens, here)
    count = len(smoke)
    seconds = est[0]
    return {
        "first_run_screen": {"screen_id": first["screen_id"], "first_run": first_result} if first_result and first and first.get("screen_id") else None,
        "bring_in": {"migrate": [{"framework": t.get("framework"), "count": t.get("count")} for t in found.get("tests") or []],
                     "imported": _imported_count(cur, cid),
                     "draft": {"gap_screen_ids": gap_ids, "estimate_usd": _estimate_draft(len(gap_ids)) if gap_ids else 0.0}},
        "first_test": first,
        "smoke": {"count": count, "estimate_usd": _estimate_check(count), "estimate_seconds": seconds * count,
                  "projected": projected, "scenario_ids": smoke},
        "live_run": _live_run(cur, row, screens), "billing": {"run": None, "draft": None},
    }


def snapshot(cur, row: dict[str, Any]) -> dict[str, Any]:
    """What the map shows, in the UI's `OnboardingMap` shape (`pages/qa/onboarding/contract.ts`):
    `screens`, `edges`, `files`, `gaps`, `summary`, `bring_in`, `first_test`, `smoke`, `live_run`,
    `billing`."""
    part = _map_of(cur, row, snapshot_version(cur, row))
    run = _run_part(cur, row, part)
    return {**part, **run, "screens": _with_first_run(part["screens"], run["first_run_screen"])}


def _with_first_run(screens: list[dict[str, Any]], first: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    """The screens with the first run on its screen, leaving the cached list as it was."""
    if not first:
        return screens
    return [{**s, "first_run": first["first_run"]} if s["id"] == first["screen_id"] else s for s in screens]


def _imported_count(cur, cid: str) -> int:
    """Scenarios that came from the team's tests, with or without a screen on the map."""
    cur.execute("SELECT tags FROM qa_scenarios WHERE container_id=%s AND status<>'retired'", (cid,))
    return sum(1 for r in cur.fetchall() if any(str(t).startswith("test:") for t in qs._json(r["tags"], [])))


def _estimates() -> tuple[int, float]:
    try:
        return importlib.import_module("orcha_cli.qa.onboarding.estimates").scenario()
    except ImportError:
        return 120, 0.15


def _estimate_draft(gaps: int = 1) -> float:
    try:
        return float(importlib.import_module("orcha_cli.qa.onboarding.estimates").drafting(gaps))
    except ImportError:
        return round(0.60 * gaps, 2)


def _estimate_check(scenarios: int = 1) -> float:
    try:
        return float(importlib.import_module("orcha_cli.qa.onboarding.estimates").check(scenarios))
    except ImportError:
        return round(1.00 + 0.30 * scenarios, 2)


def _smoke_ids(cur, cid: str, screens: list[dict[str, Any]], platform: Optional[str] = None) -> list[str]:
    """The smoke set, on `platform` when it has one: validated before draft and the riskiest screens
    first, each screen once before any gets a second."""
    placed = sorted(((s, sc) for s in screens for sc in s["scenarios"] if not platform or s.get("platform") == platform),
                    key=lambda p: (p[1]["status"] != "validated", -p[0]["risk"]["score"], p[1]["name"]))
    seen: set[str] = set()
    first: list[str] = []
    second: list[str] = []
    for s, sc in placed:
        (second if s["id"] in seen else first).append(str(sc["id"]))
        seen.add(s["id"])
    ids = list(dict.fromkeys(first + second))
    if not ids:
        rows = qa_scenarios.list_scenarios(cur, cid, platform, "validated") or qa_scenarios.list_scenarios(cur, cid, platform, "draft")
        ids = [str(r["id"]) for r in rows]
    return ids[:SMOKE_SIZE]


def _first_test(cur, cid: str, screens: list[dict[str, Any]], est: tuple[int, float], platform: Optional[str] = None) -> Optional[dict[str, Any]]:
    """The scenario to run first, on `platform` when it has one: a validated one before a draft, on
    the riskiest screen."""
    placed = sorted(((s, sc) for s in screens for sc in s["scenarios"]),
                    key=lambda p: (p[1]["status"] != "validated", -p[0]["risk"]["score"], p[1]["name"]))
    seconds = est[0]
    if platform:
        here = [p for p in placed if p[0].get("platform") == platform]
        if here:
            placed = here
        else:
            rows = qa_scenarios.list_scenarios(cur, cid, platform, "validated") or qa_scenarios.list_scenarios(cur, cid, platform, "draft")
            if rows:
                r = rows[0]
                return {"scenario_id": r["id"], "name": r["name"], "platform": r.get("platform"), "estimate_seconds": seconds,
                        "estimate_usd": _estimate_check(1), "why": "The first scenario on this platform"}
    if placed:
        s, sc = placed[0]
        return {"scenario_id": sc["id"], "name": sc["name"], "screen_id": s["id"], "platform": s.get("platform"),
                "estimate_seconds": seconds, "estimate_usd": _estimate_check(1),
                "why": f"It covers {s['name']}: {(s['risk']['reasons'] or ['a screen people use'])[0]}"}
    rows = qa_scenarios.list_scenarios(cur, cid, None, "validated") or qa_scenarios.list_scenarios(cur, cid, None, "draft")
    if not rows:
        return None
    r = rows[0]
    return {"scenario_id": r["id"], "name": r["name"], "platform": r.get("platform"), "estimate_seconds": seconds,
            "estimate_usd": _estimate_check(1), "why": "The first scenario of this project"}


def _live_run(cur, row: dict[str, Any], screens: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    part = row["phases"].get("live") or {}
    tid = part.get("task_id")
    if not tid:
        return None
    cur.execute("SELECT status FROM tasks WHERE id=%s", (str(tid),))
    task = cur.fetchone()
    status = (task or {}).get("status") or "failed"
    words = {"needs_verification": "completed", "completed": "completed", "cancelled": "cancelled",
             "in_progress": "running", "failed": "failed"}
    cur.execute("SELECT id, platform FROM qa_sessions WHERE task_id=%s ORDER BY started_at DESC LIMIT 1", (str(tid),))
    session = cur.fetchone()
    platform = (session or {}).get("platform") or row["options"].get("platform") or detector_primary(row.get("found") or {}, row["options"])
    on = [s for s in screens if s.get("platform") == platform]
    depth = row["options"].get("live_depth") or "overview"
    # An overview aims at nine areas and can see more screens than that; a deeper pass aims at them all.
    targets = len(on) if depth == "deeper" else min(9, len(on))
    out: dict[str, Any] = {"request_id": str(tid), "status": words.get(str(status), "queued"), "depth": depth, "targets": targets,
                           "reached": min(targets, sum(s["source"] in ("live", "both") for s in on))}
    if session:
        out["run_id"] = str(session["id"])
    if platform:
        out["platform"] = platform
    return out


_installed: dict[tuple[str, str, str], tuple[float, Optional[dict[str, Any]]]] = {}


def _installed_read(platform: str, app_id: str, device: str, *, wait: bool = True) -> Optional[dict[str, Any]]:
    """What is installed, read off the device at most once a minute. It runs a device command, so
    never inside a transaction. `wait=False`, for a poll: what is known now, with a fresh read left
    to a thread."""
    key, now = (platform, app_id, device), time.monotonic()
    hit = _installed.get(key)
    if hit and now - hit[0] < INSTALLED_SECONDS:
        return hit[1]
    if not wait:
        _installed[key] = (now, hit[1] if hit else None)  # one thread at a time; it overwrites this
        threading.Thread(target=_read_installed, args=(key,), daemon=True, name="qa-installed-read").start()
        return hit[1] if hit else None
    return _read_installed(key)


def _read_installed(key: tuple[str, str, str]) -> Optional[dict[str, Any]]:
    platform, app_id, device = key
    now = time.monotonic()
    try:
        listing = importlib.import_module("orcha_cli.qa.device.listing")
    except ImportError:
        return None
    got = listing.installed_build(platform, app_id, device or None)
    _installed[key] = (now, got)
    return got


def _live_target(cur, cid: str, row: dict[str, Any]) -> Optional[dict[str, Any]]:
    """What the live pass opens, from the database alone: `live_build` without the device's facts."""
    if _state(row, "live") in TERMINAL:
        return None
    platform = row["options"].get("platform") or detector_primary(row.get("found") or {}, row["options"])
    if not platform:
        return None
    t = qs.target(cur, cid, str(platform)) or {}
    app = t.get("app_id") or next((p.get("app_id") for p in (row.get("found") or {}).get("platforms") or []
                                   if p.get("kind") == platform), None)
    if not app:
        return None
    if platform == "web":
        return {"source": "url", "platform": "web", "app_id": app}
    return {"source": "installed", "platform": platform, "app_id": app, "_device": str(t.get("device_name") or "")}


def live_build(target: Optional[dict[str, Any]], *, wait: bool = True) -> Optional[dict[str, Any]]:
    """Which build the live pass opens. Orcha does not build the app: a phone pass opens what is
    installed on the device, a web pass opens the target's URL. `version`, `build`, `installed_at`
    and `device` are there when the device could be read. None once the pass has ended. After the
    transaction: it may run a device command."""
    if not target or target["source"] == "url":
        return target
    device = target["_device"]
    return {k: v for k, v in target.items() if k != "_device"} | (_installed_read(target["platform"], target["app_id"], device, wait=wait) or {})


def devices(everything: bool = False) -> dict[str, Any]:
    """`GET C/devices`: the booted simulators and attached Android devices, read the way a session
    finds them; `everything`: all the picker offers (`listing.inventory`). A container portal cannot
    see the machine's devices: `available` is False."""
    try:
        listing = importlib.import_module("orcha_cli.qa.device.listing")
    except ImportError:
        return {"devices": [], "available": False}
    return {"devices": listing.inventory() if everything else listing.available(), "available": True}


def read(cid: str, *, since: Optional[str] = None, row_only: bool = False) -> dict[str, Any]:
    """`GET C/onboarding`: the row with the map's snapshot. A row left running by a thread that
    died is picked up here. The page polls this, so what a poll needs stays small:

    `since`: the `snapshot_version` the client holds. While it stands the answer leaves out the map
    part (`MAP_KEYS`) and says `snapshot_unchanged`, and the client keeps what it has. Either way
    the map part is computed at most once per map version.
    `row_only`: the row and its phases, nothing of the snapshot, for a page that asks only where
    onboarding stands."""
    qa_explorations.sweep_abandoned(cid)
    target = None
    with db_cursor(readonly=True) as (_, cur):
        row = _load(cur, cid) or _empty(cid)
        version = snapshot_version(cur, row)
        out: dict[str, Any] = {"snapshot_version": version}
        if not row_only:
            part = _map_of(cur, row, version)
            run = _run_part(cur, row, part)
            target = _live_target(cur, cid, row)
            if since == version:
                out.update(run, snapshot_unchanged=True)
            else:
                out.update(part, **run, screens=_with_first_run(part["screens"], run["first_run_screen"]))
    if not row_only:
        out["live_build"] = live_build(target, wait=since != version)
    if row["state"] == "running":
        ensure_runner(cid)
    return {"project_id": cid, "container_id": cid, "phase": row["phase"], "state": row["state"],
            "phases": public_phases(row["phases"]), "found": row["found"], "options": row["options"],
            "error": row.get("error"), "updated_at": qs.iso(row.get("updated_at")),
            "updated_by_agent_id": str(row["updated_by_agent_id"]) if row.get("updated_by_agent_id") else None,
            "unavailable": unavailable(), **out}
