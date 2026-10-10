"""Verdikt auto-fix: send it to Verdikt → it fails → send it back to the agent → the agent
reworks → send it to Verdikt → … until it passes or a stop condition fires (mig 068).

The loop, as code:

  * A run counts only when it was auto-triggered while auto-fix applied to its task
    (`verdikt_runs.autofix`, set by `mark_run`). Auto-fix applies when the project turned it on
    ("When Verdikt fails, send it back to the agent automatically") or the task's override is
    'on' — and only while Verdikt runs automatically (trigger 'ui_changes' / 'always').
  * `evaluate` judges each such run exactly once (`autofix_done_at`, a per-task advisory lock,
    and a UNIQUE Verdikt-run key on the attempt row): attempt N of M.
      - fail  → the task goes needs_verification → in_progress (the same transition a human
                reject makes), as the system identity `system:verdikt` — never a person. A
                structured message (failed criteria first: expected vs actual, screenshot links,
                the report, the URL tested) lands on the task thread and in the assignee's
                `task_verified` rework event, which wakes them through the normal bus.
                When the agent marks it done again a new verification round begins and the
                existing auto-trigger fires once for it (forced while a loop runs, so a rework
                that touched no UI file is still checked).
      - pass  → the loop stops; the task STAYS in needs_verification for a human (a loop never
                completes a task — never self-certify) and the human is told
                "Verdikt passed on attempt N — ready for your review".
  * Stop conditions (each recorded in plain words, the human notified, the task left in
    needs_verification): pass · the attempt limit · no progress (the rework changed no code, or
    the same criteria failed with the same result twice in a row) · any non-fail outcome
    (blocked / unprocessable / warning / unavailable / timeout / cancelled / failed to run —
    never counted as a test fail) · the assignee's budget hard stop or paused wakes · a person
    accepting / rejecting / cancelling / reassigning the task · Stop auto-fix · turned off.
  * `sweep` is the background check: it refreshes in-flight Verdikt runs and applies the loop,
    so a fail at 3am still closes the loop. The portal runs it on a timer
    (application_lifecycle.start_verdikt_sweeper) and the host notifier calls
    POST /api/containers/{cid}/verdikt/sweep while runs are in flight — both idempotent.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Callable

from portal_backend import public_errors, sql
from portal_backend import verdikt_integration as vi

ACTOR = "system:verdikt"
MARKER = "[Verdikt auto-fix]"
DEFAULT_MAX = 3
MAX_LIMIT = 10
AUTO_MODES = ("ui_changes", "always")
SWEEP_BATCH = 50

STOP_LABEL = {
    "pass": "Verdikt passed",
    "attempt_limit": "Attempt limit reached",
    "no_diff": "No progress",
    "same_failure": "No progress",
    "non_fail": "Verdikt didn't give a fail",
    "budget": "Budget limit",
    "agent_paused": "Agent paused",
    "human": "A person stepped in",
    "stopped_by_human": "Stopped",
    "turned_off": "Turned off",
    "no_assignee": "No one to send it back to",
}


# ------------------------------------------------------------------ settings

def settings_fields(row: dict | None) -> dict:
    row = row or {}
    return {
        "autofix_enabled": bool(row.get("autofix_enabled")),
        "autofix_max_attempts": int(row.get("autofix_max_attempts") or DEFAULT_MAX),
    }


def mode_applies(settings: dict | None) -> bool:
    s = settings or {}
    return bool(s.get("enabled") and s.get("base_url") and s.get("verdikt_project")
                and (s.get("trigger_mode") or "manual") in AUTO_MODES)


def task_override(cur, tid: str) -> str | None:
    cur.execute("SELECT mode FROM verdikt_task_autofix WHERE task_id=%s", (tid,))
    row = cur.fetchone()
    return row["mode"] if row else None


def effective(settings: dict | None, override: str | None) -> tuple[bool, str]:
    """(auto-fix applies to the task, why — in plain words)."""
    s = settings or {}
    if not (s.get("enabled") and s.get("base_url") and s.get("verdikt_project")):
        return False, "Verdikt isn't set up for this project"
    if (s.get("trigger_mode") or "manual") not in AUTO_MODES:
        return False, "Auto-fix needs Verdikt to run automatically (Settings › Verdikt › When)"
    if override == "off":
        return False, "Auto-fix is off for this task"
    if override == "on":
        return True, "Auto-fix is on for this task"
    if s.get("autofix_enabled"):
        return True, "Auto-fix is on for this project"
    return False, "Auto-fix is off for this project"


# ------------------------------------------------------------------ loop rows

def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def running_loop(cur, tid: str) -> dict | None:
    cur.execute("SELECT * FROM verdikt_autofix_loops WHERE task_id=%s AND status='running' LIMIT 1", (tid,))
    row = cur.fetchone()
    return dict(row) if row else None


def latest_loop(cur, tid: str) -> dict | None:
    cur.execute("SELECT * FROM verdikt_autofix_loops WHERE task_id=%s ORDER BY started_at DESC LIMIT 1", (tid,))
    row = cur.fetchone()
    return dict(row) if row else None


def loop_attempts(cur, loop_id) -> list[dict]:
    cur.execute("SELECT * FROM verdikt_autofix_attempts WHERE loop_id=%s ORDER BY attempt ASC", (loop_id,))
    return [dict(r) for r in cur.fetchall()]


def is_running(tid: str) -> bool:
    """Own connection; never raises (used after a commit, e.g. to hold back a push)."""
    try:
        from portal_backend.database import db_cursor

        with db_cursor() as (_, cur):
            return running_loop(cur, str(tid)) is not None
    except Exception:  # noqa: BLE001
        return False


def _last_human_verdict_at(cur, tid: str):
    cur.execute(
        """SELECT max(created_at) AS at FROM events
            WHERE entity_type='task' AND entity_id=%s AND event_type='verified' AND actor_type='human'""",
        (tid,),
    )
    row = cur.fetchone()
    return row["at"] if row else None


def may_start_loop(cur, tid: str) -> bool:
    """A new loop may start unless one already ran in this review cycle — i.e. since the last
    time a person accepted/rejected the task. (A loop that stopped — on a pass, the limit, or
    Stop auto-fix — never restarts by itself; a person's reject begins a new cycle.)"""
    at = _last_human_verdict_at(cur, tid)
    cur.execute(
        f"""SELECT 1 FROM verdikt_autofix_loops WHERE task_id=%s
             AND ({sql.ts_param()} IS NULL OR started_at > {sql.ts_param()}) LIMIT 1""",
        (tid, at, at),
    )
    return cur.fetchone() is None


def mark_run(cur, task: dict, run_id) -> bool:
    """Flag a freshly created AUTO run as part of the loop when auto-fix applies to the task."""
    tid = str(task["id"])
    settings = vi.settings_row(cur, str(task["container_id"]))
    on, _why = effective(settings, task_override(cur, tid))
    if on:
        cur.execute("UPDATE verdikt_runs SET autofix=true WHERE id=%s", (run_id,))
    return on


def force_trigger(cur, tid: str) -> bool:
    """While a loop runs, the next verification round is always checked (the rework may not
    touch a UI file, which the 'ui_changes' policy alone would skip)."""
    return running_loop(cur, tid) is not None


# ------------------------------------------------------------------ signatures

def _norm(t) -> str:
    return re.sub(r"\s+", " ", str(t or "").strip().lower())


def failed_criteria(run: dict) -> list[dict]:
    out = []
    for c in vi._as_list(run.get("criteria")):
        if isinstance(c, dict) and c.get("outcome") == "fail":
            out.append({"text": c.get("text"), "expected": c.get("expected"), "actual": c.get("actual"),
                        "evidence_seq": c.get("evidence_seq"), "dod_index": c.get("dod_index")})
    return out


def failure_signature(run: dict) -> str:
    """The set of failed criteria with what Verdikt actually saw — equal twice in a row means
    the rework didn't move anything."""
    failed = failed_criteria(run)
    if failed:
        parts = sorted(f"{_norm(f['text'])}\x1f{_norm(f['actual'])}" for f in failed)
    else:
        parts = ["reason\x1f" + _norm(run.get("reason"))]
    return hashlib.sha1("\x1e".join(parts).encode()).hexdigest()


def change_snapshot(cur, task: dict) -> dict:
    """The current round's code changes: {signature, files, summary, href, run_ids,
    known}. `signature` covers each captured diff's content (diffs are cumulative against the
    base, so an unchanged diff means the rework changed nothing) and the file list; a run still
    going contributes its live file list. `known` is False when a run's changes couldn't be read."""
    from portal_backend import evidence_pack

    pack, _ = evidence_pack.ensure_pack(cur, task, reason="autofix")
    ch = pack.get("changes") or {}
    run_ids = [r["run_id"] for r in pack.get("runs") or [] if (r.get("lane") or "work") == "work"]
    h = hashlib.sha1()
    for f in ch.get("list") or []:
        h.update(f"{f.get('path')}:{f.get('status')}:{f.get('additions')}:{f.get('deletions')}\n".encode())
    if run_ids:
        cur.execute(f"SELECT run_id, diff FROM worker_runs WHERE {sql.in_list('run_id')} ORDER BY started_at",
                    (sql.list_param(run_ids),))
        for r in cur.fetchall():
            h.update(hashlib.sha1((r.get("diff") or "").encode()).hexdigest().encode())
    href = next((l["href"] for l in reversed(pack.get("links") or [])
                 if l.get("kind") in ("live_changes", "captured_diff")), None)
    files = int(ch.get("files") or 0)
    return {
        "signature": h.hexdigest() if files else "none",
        "files": files,
        "summary": ch.get("summary"),
        "href": href,
        "run_ids": run_ids,
        "known": not (ch.get("unavailable_runs") or []),
        "round_started_at": pack.get("round_started_at"),
    }


# ------------------------------------------------------------------ the agent's message

def _abs(url: str | None) -> str | None:
    if not url:
        return None
    from portal_backend.slack_notify import portal_base_url

    base = portal_base_url()
    return base + url if base and url.startswith("/") else url


def build_message(task: dict, run: dict, *, attempt: int, max_attempts: int, changes: dict | None = None) -> str:
    """The rework directive the agent gets (task thread + its task_verified event): concise,
    the failed criteria first, each with expected vs actual and its screenshot."""
    pub = vi.run_public(run) or {}
    shots = pub.get("screenshots") or []
    by_seq = {s.get("seq"): s for s in shots if s.get("kind") == "evidence"}
    failed = failed_criteria(run)
    crit = vi._as_list(run.get("criteria"))
    passed = sum(1 for c in crit if isinstance(c, dict) and c.get("outcome") == "pass")
    left = max_attempts - attempt
    lines = [
        f"Verdikt failed this task on attempt {attempt} of {max_attempts}. Embodent sent it back to you "
        f"automatically (auto-fix, {ACTOR}) — fix what failed below, then mark the task done again. "
        + (f"Verdikt will check it again ({left} more check{'s' if left != 1 else ''} before a person takes over)."
           if left > 0 else "This is the last automatic check."),
        "",
        "Failed criteria:" if failed else "What failed:",
    ]
    used = set()
    if failed:
        for i, f in enumerate(failed, 1):
            lines.append(f"{i}. {f['text']}")
            if f.get("expected"):
                lines.append(f"   Expected: {f['expected']}")
            if f.get("actual"):
                lines.append(f"   Actual: {f['actual']}")
            shot = by_seq.get(f.get("evidence_seq"))
            if shot:
                used.add(shot["url"])
                lines.append(f"   Screenshot: {_abs(shot['url'])}")
    else:
        lines.append(f"- {run.get('reason') or 'Verdikt reported a fail without per-criterion detail'}")
    if crit:
        lines.append(f"Passed: {passed} of {len(crit)} criteria.")
    if run.get("reason") and failed:
        lines.append(f"Verdikt's summary: {run['reason']}")
    extra = [s for s in shots if s["url"] not in used][: max(0, 3 - len(used))]
    if extra:
        lines.append("Other screenshots: " + " · ".join(_abs(s["url"]) for s in extra))
    lines.append("")
    if pub.get("report_url"):
        lines.append(f"Report: {_abs(pub['report_url'])}")
    prev = (run.get("_preview") or {}) if isinstance(run.get("_preview"), dict) else {}
    tested = run.get("locator") or prev.get("verdikt_url")
    if tested:
        lines.append(f"Tested: {run.get('target_kind') or 'web'}:{tested}"
                     + (" (a preview of your branch)" if prev else ""))
    if changes and changes.get("href"):
        lines.append(f"Your changes on this attempt: {_abs(changes['href'])}")
    lines.append(f"Task: {task.get('title') or ''} ({str(task['id'])[:8]})")
    return "\n".join(lines).strip()


# ------------------------------------------------------------------ transitions

def _post(cur, tid: str, text: str) -> None:
    # author NULL: a system line on the thread (never attributed to a person)
    cur.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s, NULL, %s)",
                (tid, f"{MARKER} {text}"))


def _stop(cur, loop: dict, task: dict, kind: str, reason: str, *, by: str | None = None,
          notify: bool = True, attempt: int | None = None) -> Callable[[], None] | None:
    """Close a running loop (idempotent). Returns the after-commit notification, if any."""
    cur.execute(
        """UPDATE verdikt_autofix_loops SET status='stopped', stop_kind=%s, stop_reason=%s, stopped_by=%s,
                  stopped_at=now(), updated_at=now()
            WHERE id=%s AND status='running' RETURNING id""",
        (kind, reason[:1000], by, loop["id"]),
    )
    if not cur.fetchone():
        return None
    from portal_backend.agent_status import log_event

    cid, tid = str(task["container_id"]), str(task["id"])
    log_event(cur, cid, "human" if by else "system", by, "task", tid, "verdikt_autofix_stopped",
              {"actor": by or ACTOR, "loop": str(loop["id"]), "stop_kind": kind, "reason": reason,
               "attempt": attempt, "max_attempts": loop["max_attempts"]})
    _post(cur, tid, f"Stopped: {reason}")
    if not notify:
        return None
    from portal_backend.events import publish_event
    from portal_backend import notification_prefs as np

    for h in np.container_humans(cur, cid):
        publish_event(cur, cid, str(h["id"]), "verdikt_autofix_stopped",
                      {"task_id": tid, "title": task.get("title"), "message": reason, "stop_kind": kind,
                       "attempt": attempt, "max_attempts": loop["max_attempts"]})

    def _after():
        from portal_backend.push_outbox import push_task_verify
        from portal_backend.slack_notify import notify_task_needs_verification

        push_task_verify(cid, tid, body=f"{task.get('title') or 'Task'} — {reason}")
        notify_task_needs_verification(cid, tid)
    return _after


def _blocked(cur, task: dict, agent_ids: list[str]) -> tuple[str, str] | None:
    """Why the task can't go back to its agent right now: (stop_kind, reason) or None."""
    from portal_backend.budget_routes import agent_budget_block

    if not agent_ids:
        return "no_assignee", "nobody is assigned to the task to send it back to"
    cid = str(task["container_id"])
    cur.execute("SELECT status, wakes_enabled FROM containers WHERE id=%s", (cid,))
    c = cur.fetchone() or {}
    if c.get("status") and c["status"] != "active":
        return "agent_paused", f"the project is {c['status']}, so the agent can't be woken"
    if c.get("wakes_enabled") is False:
        return "agent_paused", "agent wakes are turned off for this project"
    cur.execute(
        f"""SELECT a.id, a.alias, coalesce(r.wake_enabled, true) AS wake_enabled
             FROM agents a LEFT JOIN agent_reachability r ON r.agent_id = a.id
            WHERE {sql.in_list('a.id')}""",
        (sql.list_param(agent_ids),),
    )
    for a in cur.fetchall():
        if not a["wake_enabled"]:
            return "agent_paused", f"{a['alias']} is paused (wakes off)"
        why = agent_budget_block(cur, cid, str(a["id"]))
        if why:
            return "budget", f"{a['alias']} hit a budget hard stop ({why})"
    return None


def _send_back(cur, task: dict, run: dict, loop: dict, attempt: int, changes: dict, agent_ids: list[str]) -> dict:
    from portal_backend.agent_status import log_event, recompute_agent_status
    from portal_backend.events import publish_event
    from portal_backend.review_routing import supersede_pending_prereview

    cid, tid = str(task["container_id"]), str(task["id"])
    cur.execute("UPDATE tasks SET status='in_progress' WHERE id=%s AND status='needs_verification' RETURNING id", (tid,))
    if not cur.fetchone():
        return {}
    supersede_pending_prereview(cur, cid, tid, reason="verdikt_auto_rework")
    cur.execute(
        "UPDATE agent_tasks SET assignment_status='working' "
        f"WHERE task_id=%s AND assignment_status='done' AND {sql.in_list('agent_id')} RETURNING agent_id",
        (tid, sql.list_param(agent_ids)),
    )
    restored = [str(r["agent_id"]) for r in cur.fetchall()]
    for aid in restored:
        recompute_agent_status(cur, aid)
    msg = build_message(task, run, attempt=attempt, max_attempts=loop["max_attempts"], changes=changes)
    _post(cur, tid, msg)
    failed = [{k: f.get(k) for k in ("text", "expected", "actual")} for f in failed_criteria(run)]
    log_event(cur, cid, "system", None, "task", tid, "verdikt_auto_rework",
              {"actor": ACTOR, "attempt": attempt, "max_attempts": loop["max_attempts"],
               "loop": str(loop["id"]), "verdikt_run": str(run["id"]), "failed": failed,
               "reassigned_to_agent_ids": restored})
    log_event(cur, cid, "system", None, "task", tid, "status_changed",
              {"to": "in_progress", "reason": "verdikt_auto_rework", "actor": ACTOR, "attempt": attempt})
    for aid in restored:
        # the same rework directive a human reject sends — labelled as the system's
        publish_event(cur, cid, aid, "task_verified", {
            "task_id": tid, "approved": False, "feedback": msg, "by": ACTOR,
            "verdikt_auto_rework": True, "attempt": attempt, "max_attempts": loop["max_attempts"],
        })
    return {"restored": restored, "message": msg}


def _outcome(run: dict) -> str:
    if run["status"] == "completed" and run.get("verdict") in ("pass", "fail"):
        return run["verdict"]
    if run["status"] == "completed":
        return run.get("verdict") or "no verdict"
    return run["status"]


_NON_FAIL_TEXT = {
    "blocked": "Verdikt was blocked and couldn't finish the check",
    "unprocessable": "Verdikt couldn't process the scenario",
    "warning": "Verdikt only raised warnings (not a fail)",
    "no verdict": "Verdikt finished without a verdict",
    "unavailable": "Verdikt was unavailable",
    "timeout": "Verdikt didn't answer in time",
    "cancelled": "the Verdikt run was cancelled",
    "failed": "the Verdikt run failed to run",
}


def evaluate(cur, run: dict) -> list[Callable[[], None]]:
    """Judge one finished auto-fix run (caller holds the task's autofix lock). Returns the
    after-commit callbacks (notifications). Idempotent."""
    tid, rid = str(run["task_id"]), str(run["id"])
    cur.execute("UPDATE verdikt_runs SET autofix_done_at=now() WHERE id=%s AND autofix_done_at IS NULL RETURNING id",
                (rid,))
    if not cur.fetchone():
        return []
    cur.execute("SELECT 1 FROM verdikt_autofix_attempts WHERE verdikt_run_id=%s", (rid,))
    if cur.fetchone():
        return []
    cur.execute("SELECT id, container_id, title, description, definition_of_done, status, result "
                "FROM tasks WHERE id=%s " + sql.for_update(), (tid,))
    task = cur.fetchone()
    if not task:
        return []
    task = dict(task)
    loop = running_loop(cur, tid)
    if task["status"] != "needs_verification":
        return []  # someone already moved it (their action ends any loop itself)
    changes = change_snapshot(cur, task)
    from portal_backend.evidence_pack import _ts

    start, created = _ts(changes.get("round_started_at")), _ts(run.get("created_at"))
    if start and created and created < start:
        return []  # it judged the previous claim, not this round's work
    settings = vi.settings_row(cur, str(task["container_id"]))
    on, why = effective(settings, task_override(cur, tid))
    outcome = _outcome(run)
    if loop is None:
        if not on or outcome != "fail" or not may_start_loop(cur, tid):
            return []
        mx = int((settings or {}).get("autofix_max_attempts") or DEFAULT_MAX)
        cur.execute(
            """INSERT INTO verdikt_autofix_loops (task_id, container_id, status, max_attempts)
               VALUES (%s, %s, 'running', %s) ON CONFLICT DO NOTHING RETURNING *""",
            (tid, str(task["container_id"]), max(1, min(MAX_LIMIT, mx))),
        )
        row = cur.fetchone()
        loop = dict(row) if row else running_loop(cur, tid)
        if not loop:
            return []
    prev = loop_attempts(cur, loop["id"])
    n = len(prev) + 1
    last = prev[-1] if prev else None
    fsig = failure_signature(run) if outcome == "fail" else None
    pub_failed = [{k: f.get(k) for k in ("text", "expected", "actual")} for f in failed_criteria(run)]
    ch = {"summary": changes.get("summary"), "files": changes.get("files"), "href": changes.get("href"),
          "run_ids": changes.get("run_ids")}

    def attempt_row(action: str):
        cur.execute(
            """INSERT INTO verdikt_autofix_attempts (loop_id, task_id, attempt, verdikt_run_id, outcome, action,
                                                    failure_signature, change_signature, failed, changes)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (verdikt_run_id) DO NOTHING RETURNING id""",
            (loop["id"], tid, n, rid, outcome, action, fsig, changes.get("signature"),
             json.dumps(pub_failed, default=str), json.dumps(ch, default=str)),
        )
        return cur.fetchone() is not None

    mx = loop["max_attempts"]
    if not on:
        if not attempt_row("stopped"):
            return []
        cb = _stop(cur, loop, task, "turned_off", f"Auto-fix was turned off ({why.lower()}) — over to you", attempt=n)
        return [cb] if cb else []
    if outcome == "pass":
        if not attempt_row("passed"):
            return []
        cb = _stop(cur, loop, task, "pass", f"Verdikt passed on attempt {n} of {mx} — ready for your review", attempt=n)
        return [cb] if cb else []
    if outcome != "fail":
        if not attempt_row("stopped"):
            return []
        text = _NON_FAIL_TEXT.get(outcome, f"Verdikt answered '{outcome}'")
        detail = (run.get("error") or "").strip()
        reason = f"{text} on attempt {n} of {mx}" + (f" ({detail[:200]})" if detail else "") + \
            " — that isn't a test fail, so auto-fix stopped and handed it to you"
        cb = _stop(cur, loop, task, "non_fail", reason, attempt=n)
        return [cb] if cb else []
    # a real fail
    stop: tuple[str, str] | None = None
    if last and last["outcome"] == "fail" and last["failure_signature"] == fsig:
        k = len(pub_failed) or 1
        stop = ("same_failure", f"No progress: the same {k} criteri{'on' if k == 1 else 'a'} failed with the same "
                                f"result on attempts {n - 1} and {n} — over to you")
    elif last and changes.get("known") and last.get("change_signature") and \
            last["change_signature"] == changes.get("signature"):
        stop = ("no_diff", f"No progress: attempt {n} has exactly the same code changes as attempt {n - 1} — "
                           "the rework didn't change anything")
    elif n >= mx:
        stop = ("attempt_limit", f"Verdikt failed {n} of {mx} attempts — the attempt limit is reached, over to you")
    agents: list[str] = []
    if not stop:
        cur.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s AND assignment_status='done'", (tid,))
        agents = [str(r["agent_id"]) for r in cur.fetchall()]
        b = _blocked(cur, task, agents)
        if b:
            stop = (b[0], f"Couldn't send it back after attempt {n} of {mx}: {b[1]}")
    if stop:
        if not attempt_row("stopped"):
            return []
        cb = _stop(cur, loop, task, stop[0], stop[1], attempt=n)
        return [cb] if cb else []
    if not attempt_row("reworked"):
        return []
    cur.execute("UPDATE verdikt_autofix_loops SET updated_at=now() WHERE id=%s", (loop["id"],))
    vi.with_preview(cur, run)
    _send_back(cur, task, run, loop, n, changes, agents)
    return []


def _lock(cur, tid: str) -> None:
    cur.execute(sql.xact_lock("%s"), ("verdikt-autofix:" + str(tid),))


def process_task(tid: str) -> int:
    """Judge every finished, not-yet-judged auto-fix run of the task, in order. Own
    transaction; notifications after the commit. Returns how many were judged. Never raises."""
    from portal_backend.database import db_cursor

    after: list[Callable[[], None]] = []
    n = 0
    try:
        with db_cursor() as (conn, cur):
            _lock(cur, tid)
            cur.execute(
                """SELECT * FROM verdikt_runs WHERE task_id=%s AND autofix AND autofix_done_at IS NULL
                     AND status NOT IN ('queued','running') ORDER BY created_at ASC""",
                (tid,),
            )
            for run in [dict(r) for r in cur.fetchall()]:
                after += evaluate(cur, run)
                n += 1
            conn.commit()
    except Exception:  # noqa: BLE001 — the loop must never break a read or the sweep
        return n
    for cb in after:
        try:
            cb()
        except Exception:  # noqa: BLE001
            pass
    return n


def on_rework_done(tid: str, pack: dict) -> bool:
    """The agent marked the task done again while a loop runs: stop right away when the rework
    produced no code change at all (nothing in this round). Returns True when it stopped."""
    from portal_backend.database import db_cursor

    after = None
    try:
        with db_cursor() as (conn, cur):
            _lock(cur, tid)
            loop = running_loop(cur, tid)
            if not loop:
                return False
            cur.execute("SELECT id, container_id, title, status FROM tasks WHERE id=%s", (tid,))
            task = cur.fetchone()
            if not task or task["status"] != "needs_verification":
                return False
            ch = pack.get("changes") or {}
            if not loop_attempts(cur, loop["id"]):
                return False
            if int(ch.get("files") or 0) == 0 and not (ch.get("unavailable_runs") or []):
                n = len(loop_attempts(cur, loop["id"]))
                after = _stop(cur, loop, dict(task), "no_diff",
                              f"No progress: the agent marked it done again after attempt {n} without changing "
                              "any code — over to you", attempt=n)
            conn.commit()
    except Exception:  # noqa: BLE001
        return False
    if after:
        try:
            after()
        except Exception:  # noqa: BLE001
            pass
        return True
    return False


def stop_unstartable(tid: str, detail: str) -> bool:
    """The rework came back but no Verdikt run could be started for it (no target, Verdikt
    switched off …): the loop can't continue — stop it and tell the human. Never raises."""
    from portal_backend.database import db_cursor

    after = None
    try:
        with db_cursor() as (conn, cur):
            _lock(cur, tid)
            loop = running_loop(cur, tid)
            if not loop:
                return False
            cur.execute("SELECT id, container_id, title, status FROM tasks WHERE id=%s", (tid,))
            task = cur.fetchone()
            if not task:
                return False
            n = len(loop_attempts(cur, loop["id"]))
            after = _stop(cur, loop, dict(task), "non_fail",
                          f"Verdikt couldn't be started for attempt {n + 1}: {detail} — over to you", attempt=n)
            conn.commit()
    except Exception:  # noqa: BLE001
        return False
    if after:
        try:
            after()
        except Exception:  # noqa: BLE001
            pass
    return after is not None


def stop_where_off(cur, cid: str, actor_id: str | None, *, tid: str | None = None) -> int:
    """After a settings / override change: end every running loop of the project (or of one
    task) that auto-fix no longer applies to. In the caller's transaction; no notification —
    the person who changed it knows."""
    settings = vi.settings_row(cur, cid)
    cur.execute(
        f"""SELECT l.*, t.title, t.container_id AS cid FROM verdikt_autofix_loops l JOIN tasks t ON t.id=l.task_id
            WHERE l.container_id=%s AND l.status='running' AND ({sql.uuid_param()} IS NULL OR l.task_id={sql.uuid_param()})""",
        (cid, tid, tid),
    )
    n = 0
    for loop in [dict(r) for r in cur.fetchall()]:
        on, why = effective(settings, task_override(cur, str(loop["task_id"])))
        if on:
            continue
        task = {"id": loop["task_id"], "container_id": cid, "title": loop["title"]}
        _stop(cur, loop, task, "turned_off", f"Auto-fix was turned off ({why[0].lower() + why[1:]})", by=actor_id,
              notify=False, attempt=len(loop_attempts(cur, loop["id"])) or None)
        n += 1
    return n


def end_for_person(cur, task: dict, actor_id: str | None, what: str, *, actor_kind: str = "human") -> bool:
    """A person (or the orchestrator) acted on the task — accepted / rejected / cancelled /
    reassigned it: the loop ends, in the caller's transaction. No notification (they did it)."""
    tid = str(task["id"])
    loop = running_loop(cur, tid)
    if not loop:
        return False
    alias = None
    if actor_id:
        cur.execute("SELECT alias FROM agents WHERE id=%s", (actor_id,))
        r = cur.fetchone()
        alias = r["alias"] if r else None
    who = alias or ("a person" if actor_kind == "human" else "the orchestrator")
    by = actor_id if actor_kind == "human" else None
    _stop(cur, loop, task, "human", f"{who} {what} the task — auto-fix ended", by=by, notify=False)
    return True


def stop_by_person(cur, task: dict, actor_id: str) -> dict | None:
    loop = running_loop(cur, str(task["id"]))
    if not loop:
        return None
    cur.execute("SELECT alias FROM agents WHERE id=%s", (actor_id,))
    r = cur.fetchone()
    n = len(loop_attempts(cur, loop["id"]))
    _stop(cur, loop, task, "stopped_by_human", f"{(r or {}).get('alias') or 'A person'} stopped auto-fix",
          by=actor_id, notify=False, attempt=n or None)
    cur.execute("SELECT * FROM verdikt_autofix_loops WHERE id=%s", (loop["id"],))
    return dict(cur.fetchone())


# ------------------------------------------------------------------ the background check

def sweep(cid: str | None = None) -> dict:
    """Refresh in-flight Verdikt runs (throttled per run) and apply the loop to finished ones.
    Idempotent and cheap when nothing is in flight. Never raises."""
    from portal_backend.database import db_cursor

    out = {"in_flight": 0, "refreshed": 0, "judged": 0, "loops_running": 0}
    try:
        with db_cursor() as (_, cur):
            cur.execute(
                f"""SELECT r.id FROM verdikt_runs r WHERE r.status IN ('queued','running')
                     AND ({sql.uuid_param()} IS NULL OR r.container_id={sql.uuid_param()})
                   ORDER BY r.last_polled_at ASC NULLS FIRST LIMIT %s""",
                (cid, cid, SWEEP_BATCH),
            )
            open_ids = [str(r["id"]) for r in cur.fetchall()]
        for rid in open_ids:
            try:
                with db_cursor() as (conn, cur):
                    cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (rid,))
                    run = cur.fetchone()
                    if not run or run["status"] not in vi.OPEN_STATUSES:
                        continue
                    s = vi.settings_row(cur, str(run["container_id"])) or {}
                    vi.refresh_run(cur, dict(run), timeout_minutes=int(s.get("timeout_minutes") or 30))
                    conn.commit()
                    out["refreshed"] += 1
            except Exception:  # noqa: BLE001 — one bad run never stalls the rest
                continue
        with db_cursor() as (_, cur):
            cur.execute(
                f"""SELECT DISTINCT task_id FROM verdikt_runs WHERE autofix AND autofix_done_at IS NULL
                     AND status NOT IN ('queued','running') AND ({sql.uuid_param()} IS NULL OR container_id={sql.uuid_param()})
                   LIMIT %s""",
                (cid, cid, SWEEP_BATCH),
            )
            pending = [str(r["task_id"]) for r in cur.fetchall()]
        for tid in pending:
            out["judged"] += process_task(tid)
        with db_cursor() as (_, cur):
            cur.execute(
                f"""SELECT (SELECT count(*) FROM verdikt_runs WHERE status IN ('queued','running')
                              AND ({sql.uuid_param()} IS NULL OR container_id={sql.uuid_param()})) AS open,
                          (SELECT count(*) FROM verdikt_autofix_loops WHERE status='running'
                              AND ({sql.uuid_param()} IS NULL OR container_id={sql.uuid_param()})) AS loops""",
                (cid, cid, cid, cid),
            )
            row = cur.fetchone()
            out["in_flight"] = int(row["open"])
            out["loops_running"] = int(row["loops"])
    except Exception as e:  # noqa: BLE001
        public_errors.log_exception("verdikt sweep", e)
        out["error"] = "the Verdikt sweep failed — see the portal log"
    return out


# ------------------------------------------------------------------ serialization

def attempt_public(a: dict, tid: str) -> dict:
    rid = str(a["verdikt_run_id"])
    base = f"/api/tasks/{tid}/verdikt/runs/{rid}"
    ch = a.get("changes") or {}
    return {
        "attempt": a["attempt"],
        "outcome": a["outcome"],
        "action": a["action"],
        "verdikt_run": rid,
        "report_url": f"{base}/report",
        "open_url": f"/api/tasks/{tid}/verdikt/open?run={rid}",
        "failed": a.get("failed") or [],
        "changes": {"summary": ch.get("summary"), "files": ch.get("files"), "href": ch.get("href")},
        "created_at": _iso(a.get("created_at")),
    }


def _current(cur, loop: dict) -> bool:
    """The loop belongs to the task's current review cycle (no person has accepted/rejected the
    task since it started) — an older loop's outcome says nothing about the work now."""
    if loop["status"] == "running":
        return True
    at = _last_human_verdict_at(cur, str(loop["task_id"]))
    return at is None or loop["started_at"] > at


def loop_public(loop: dict | None, attempts: list[dict], *, current: bool = True) -> dict | None:
    if not loop:
        return None
    tid = str(loop["task_id"])
    return {
        "id": str(loop["id"]),
        "status": loop["status"],
        "current": current,
        "max_attempts": loop["max_attempts"],
        "attempts_made": len(attempts),
        # while running, the attempt being worked on / checked now
        "current_attempt": min(len(attempts) + 1, loop["max_attempts"]) if loop["status"] == "running" else len(attempts),
        "stop_kind": loop.get("stop_kind"),
        "stop_label": STOP_LABEL.get(loop.get("stop_kind") or ""),
        "stop_reason": loop.get("stop_reason"),
        "stopped_by": str(loop["stopped_by"]) if loop.get("stopped_by") else None,
        "started_at": _iso(loop.get("started_at")),
        "stopped_at": _iso(loop.get("stopped_at")),
        "attempts": [attempt_public(a, tid) for a in attempts],
    }


def state(cur, task: dict) -> dict:
    """{effective, why, override, project{enabled, max_attempts, applies}, loop|null}."""
    tid = str(task["id"])
    settings = vi.settings_row(cur, str(task["container_id"]))
    ov = task_override(cur, tid)
    on, why = effective(settings, ov)
    loop = latest_loop(cur, tid)
    f = settings_fields(settings)
    return {
        "task_id": tid,
        "effective": on,
        "why": why,
        "override": ov or "inherit",
        "project": {"enabled": f["autofix_enabled"], "max_attempts": f["autofix_max_attempts"],
                    "applies": mode_applies(settings)},
        "loop": loop_public(loop, loop_attempts(cur, loop["id"]), current=_current(cur, loop)) if loop else None,
    }


def summary(cur, tid: str) -> dict | None:
    """A compact loop line for the evidence summary / Needs-you rows, or None."""
    loop = latest_loop(cur, tid)
    if not loop or not _current(cur, loop):
        return None
    n = len(loop_attempts(cur, loop["id"]))
    return {"status": loop["status"], "attempts_made": n, "max_attempts": loop["max_attempts"],
            "current_attempt": min(n + 1, loop["max_attempts"]) if loop["status"] == "running" else n,
            "stop_kind": loop.get("stop_kind"), "stop_label": STOP_LABEL.get(loop.get("stop_kind") or ""),
            "stop_reason": loop.get("stop_reason")}

