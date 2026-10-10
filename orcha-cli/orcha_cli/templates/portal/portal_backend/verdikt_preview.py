"""Preview environments for Verdikt runs (migration 064).

Verdikt only tests something already running at a target. With a project PREVIEW COMMAND set
(Settings → Integrations → Verdikt), a Verdikt run for a task first gets the task's own change
built and served:

  1. the portal records a `verdikt_previews` row (`requested`) next to the Verdikt run, with
     the task's worktree / branch / checkout taken from its latest recorded run;
  2. the host notifier daemon (orcha_cli/notifier_preview.py — it owns the agent worktrees on
     the host; the portal may run in Docker and can't run host commands) claims it
     (`starting`), runs the command in that worktree on a free port, polls the ready check and
     reports `ready` with the port — or `failed` with plain words and the last log lines;
  3. on `ready` the portal hands Verdikt `http://127.0.0.1:{port}{path}` (see `verdikt_url`)
     and the run continues exactly as before;
  4. the notifier heartbeats while the preview runs (pushing the log tail, and driving the
     Verdikt poll) and stops it once the Verdikt run is over, it was cancelled, or its TTL
     passed → `stopped`.

No preview command → nothing here runs and Verdikt tests the configured URL, as before. A URL
typed when triggering also skips the preview (the person asked for that URL).

Security: the command is a project setting only owners / `manage_repo` members can change; it
runs as the notifier's user. The only values substituted into it are `{port}` (an int the
notifier chose), `{worktree}` and `{branch}` (validated and shell-quoted by the notifier). No
task text ever reaches the shell.
"""

from __future__ import annotations

import re
import urllib.parse
from datetime import datetime, timedelta, timezone

OPEN = ("requested", "starting", "ready")
CLAIM_TIMEOUT_S = 120          # a request no notifier picked up within this is failed honestly
REPORT_GRACE_S = 60            # a claimed preview that stops reporting for timeout+this is failed
MAX_COMMAND = 2000
MAX_LOG_TAIL = 16_000
LOG_TAIL_LINES = 80
PLACEHOLDERS = ("{port}", "{worktree}", "{branch}")
_READY_PATH = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,199}$")
# CSI sequences, and OSC sequences up to their BEL. An OSC body never spans another ESC
# (a new escape starts there), which also keeps the scan linear: a log full of unterminated
# `ESC ]` can't make each one rescan the rest of the text.
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*\x07")


# ------------------------------------------------------------------ settings validation

def validate_command(cmd: str | None) -> str | None:
    """A preview command, or None. One line, no NUL, and it must learn its port: `{port}` or
    the PORT environment variable the notifier sets."""
    c = (cmd or "").strip()
    if not c:
        return None
    if len(c) > MAX_COMMAND:
        raise ValueError(f"the preview command is too long (max {MAX_COMMAND} characters)")
    if any(ch in c for ch in ("\x00", "\n", "\r")):
        raise ValueError("the preview command must be one line (chain steps with &&)")
    if "{port}" not in c and not re.search(r"\$\{?PORT\b", c):
        raise ValueError("the preview command must serve on {port} (or read $PORT) so Embodent knows where it is")
    return c


def validate_ready_path(p: str | None) -> str:
    v = (p or "").strip() or "/"
    if not _READY_PATH.match(v) or "/../" in v + "/" or "//" in v:
        raise ValueError("the ready check must be a path on the preview, like / or /health")
    return v


def settings_fields(row: dict | None) -> dict:
    row = row or {}
    return {
        "preview_command": row.get("preview_command"),
        "preview_ready_path": row.get("preview_ready_path") or "/",
        "preview_timeout_seconds": int(row.get("preview_timeout_seconds") or 120),
        "preview_ttl_minutes": int(row.get("preview_ttl_minutes") or 60),
    }


def wants_preview(settings: dict | None, locator_override: str | None) -> bool:
    s = settings or {}
    return bool(s.get("preview_command")) and (s.get("target_kind") or "web") == "web" and not locator_override


# ------------------------------------------------------------------ the task's checkout

def task_checkout(cur, tid: str) -> dict:
    """Where the task's change lives on the host: the latest run of the current verification
    round that recorded a worktree or branch ({worktree, branch, base_cwd}, any may be None)."""
    from portal_backend import evidence_pack

    runs, _start = evidence_pack._round_runs(cur, tid)
    for r in reversed(runs):
        if r.get("worktree") or r.get("branch"):
            return {"worktree": r.get("worktree"), "branch": r.get("branch"), "base_cwd": r.get("base_cwd")}
    return {"worktree": None, "branch": None, "base_cwd": None}


def verdikt_url(settings: dict | None, port: int) -> str:
    """The URL Verdikt's worker opens. Verdikt's worker drives Chromium on the machine it runs
    on, and a preview-backed run needs the notifier and the Verdikt worker on the SAME machine
    (the supported local setup: the Mac app or `bin/qa-worker`), so it is loopback. The path
    and query of the configured target URL are kept (…/login stays /login on the preview)."""
    path = "/"
    loc = (settings or {}).get("target_locator")
    if loc:
        p = urllib.parse.urlsplit(loc)
        path = (p.path or "/") + (f"?{p.query}" if p.query else "")
    return f"http://127.0.0.1:{int(port)}{path}"


# ------------------------------------------------------------------ rows

def _now():
    return datetime.now(timezone.utc)


def create(cur, task: dict, settings: dict, run_row: dict) -> dict:
    """Record the preview request for a freshly inserted Verdikt run. A task with no recorded
    worktree or branch gets a `failed` preview right away (nothing to build)."""
    co = task_checkout(cur, str(task["id"]))
    f = settings_fields(settings)
    status, error = "requested", None
    if not co["worktree"] and not co["branch"]:
        status = "failed"
        error = "no worktree or branch was recorded for this task's runs, so there is nothing to build"
    cur.execute(
        """INSERT INTO verdikt_previews (task_id, container_id, verdikt_run_id, status, command, ready_path,
                                         timeout_seconds, ttl_minutes, worktree, branch, base_cwd, error,
                                         stopped_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
        (str(task["id"]), str(task["container_id"]), str(run_row["id"]), status, f["preview_command"],
         f["preview_ready_path"], f["preview_timeout_seconds"], f["preview_ttl_minutes"], co["worktree"],
         co["branch"], co["base_cwd"], error, _now() if status == "failed" else None),
    )
    return dict(cur.fetchone())


def for_run(cur, rid) -> dict | None:
    cur.execute("SELECT * FROM verdikt_previews WHERE verdikt_run_id=%s ORDER BY created_at DESC LIMIT 1", (str(rid),))
    row = cur.fetchone()
    return dict(row) if row else None


def update(cur, pid, **fields) -> dict:
    cols = [f"{k}=%s" for k in fields] + ["updated_at=now()"]
    cur.execute(f"UPDATE verdikt_previews SET {', '.join(cols)} WHERE id=%s RETURNING *", (*fields.values(), str(pid)))
    return dict(cur.fetchone())


def clean_tail(text: str | None) -> str | None:
    """The last LOG_TAIL_LINES lines of a log, without terminal escapes, capped in size."""
    if not text:
        return None
    t = _ANSI.sub("", str(text)).replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    lines = [ln[:500] for ln in t.split("\n")]
    while lines and not lines[-1].strip():
        lines.pop()
    out = "\n".join(lines[-LOG_TAIL_LINES:])
    return out[-MAX_LOG_TAIL:] or None


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def expires_at(p: dict):
    start = p.get("claimed_at") or p.get("created_at")
    return start + timedelta(minutes=int(p.get("ttl_minutes") or 60)) if start else None


def public(p: dict | None) -> dict | None:
    if not p:
        return None
    base = f"/api/tasks/{p['task_id']}/verdikt/runs/{p['verdikt_run_id']}/preview"
    tail = p.get("log_tail") or ""
    return {
        "id": str(p["id"]),
        "status": p["status"],
        "port": p.get("port"),
        "verdikt_url": p.get("verdikt_url"),
        # the browser link: a portal redirect to the preview at the host the portal was opened on
        "open_url": base if p["status"] == "ready" and p.get("port") else None,
        "log_url": base + "/log",
        "branch": p.get("branch"),
        "worktree_name": (p.get("worktree") or "").rstrip("/").rsplit("/", 1)[-1] or None,
        "ready_path": p.get("ready_path") or "/",
        "error": p.get("error"),
        "log_tail": "\n".join(tail.split("\n")[-12:]) if tail else None,
        "stop_reason": p.get("stop_reason"),
        "created_at": _iso(p.get("created_at")),
        "claimed_at": _iso(p.get("claimed_at")),
        "ready_at": _iso(p.get("ready_at")),
        "stopped_at": _iso(p.get("stopped_at")),
        "expires_at": _iso(expires_at(p)),
    }


# ------------------------------------------------------------------ lifecycle (portal side)

def request_stop(cur, p: dict, reason: str) -> dict:
    """Ask for a preview to stop. One nobody claimed yet is simply closed; a running one is
    flagged and the notifier stops it on its next heartbeat."""
    if p["status"] == "requested":
        return update(cur, p["id"], status="stopped", stop_reason=reason, stopped_at=_now())
    if p["status"] in ("starting", "ready") and not p.get("stop_requested_at"):
        return update(cur, p["id"], stop_requested_at=_now(), stop_reason=reason)
    return p


def stop_for_run(cur, rid, reason: str) -> None:
    p = for_run(cur, rid)
    if p and p["status"] in OPEN:
        request_stop(cur, p, reason)


def stop_decision(p: dict, run: dict | None) -> str | None:
    """Why this preview should stop now, or None to keep it running."""
    from portal_backend.verdikt_integration import OPEN_STATUSES

    if p.get("stop_requested_at"):
        return p.get("stop_reason") or "stop requested"
    if run is None:
        return "its Verdikt run no longer exists"
    if run["status"] not in OPEN_STATUSES:
        return f"the Verdikt run is {run['status']}"
    exp = expires_at(p)
    if exp and _now() >= exp:
        return f"it reached its time limit ({int(p.get('ttl_minutes') or 60)} min)"
    return None


def fail_run(cur, run: dict, error: str) -> None:
    from portal_backend import verdikt_integration as vi

    if run and run["status"] in vi.OPEN_STATUSES and not run.get("verdikt_request_id"):
        vi._update(cur, str(run["id"]), status="failed", error=error[:2000], finished_at=_now())


def reconcile(cur, run: dict, p: dict, *, timeout_minutes: int) -> dict:
    """refresh_run for a preview-backed run that Verdikt hasn't got yet (no request id): turn a
    dead preview into an honest run state. Returns the (possibly updated) run row."""
    from portal_backend import verdikt_integration as vi

    now = _now()
    st = p["status"]
    if st == "requested" and now - p["created_at"] > timedelta(seconds=CLAIM_TIMEOUT_S):
        msg = ("no notifier picked up the preview request — is `orcha notifier` running on the machine "
               "with this project's checkout?")
        update(cur, p["id"], status="failed", error=msg, stopped_at=now)
        fail_run(cur, run, "Preview failed: " + msg)
    elif st == "starting":
        seen = p.get("last_seen_at") or p.get("claimed_at") or p["created_at"]
        if now - seen > timedelta(seconds=int(p.get("timeout_seconds") or 120) + REPORT_GRACE_S):
            msg = "the notifier stopped reporting on the preview"
            update(cur, p["id"], status="failed", error=msg, stopped_at=now)
            fail_run(cur, run, "Preview failed: " + msg)
    elif st == "failed":
        fail_run(cur, run, "Preview failed: " + (p.get("error") or "unknown error"))
    elif st == "stopped":
        fail_run(cur, run, "The preview stopped before Verdikt got it" +
                 (f" ({p['stop_reason']})" if p.get("stop_reason") else ""))
    elif st == "ready" and p.get("ready_at") and now - p["ready_at"] > timedelta(minutes=2):
        fail_run(cur, run, "the handoff to Verdikt did not complete")
    cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (run["id"],))
    run = dict(cur.fetchone())
    if run["status"] in vi.OPEN_STATUSES and now - run["created_at"] > timedelta(minutes=timeout_minutes):
        vi._update(cur, str(run["id"]), status="timeout",
                   error=f"no result within {timeout_minutes} min (the preview never became ready)", finished_at=now)
        cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (run["id"],))
        run = dict(cur.fetchone())
    if run["status"] not in vi.OPEN_STATUSES:
        p2 = for_run(cur, run["id"])
        if p2 and p2["status"] in OPEN:
            request_stop(cur, p2, f"the Verdikt run is {run['status']}")
    return run


def retarget_handoff(handoff: dict, url: str, branch: str | None) -> dict:
    """Point the scenario description's `Target:` line at the preview."""
    h = dict(handoff or {})
    label = f"Target: web:{url} (a preview of {'branch ' + branch if branch else 'the task'}, served by Embodent)"
    desc = h.get("description") or ""
    h["description"] = re.sub(r"(?m)^Target: .*$", label, desc) if re.search(r"(?m)^Target: ", desc) else \
        (desc + "\n" + label).strip()
    h["preview_url"] = url
    return h
