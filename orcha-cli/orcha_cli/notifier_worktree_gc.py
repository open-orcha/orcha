"""Agent-worktree housekeeping inside the notifier daemon (portal side: agent_worktree_routes,
migration 067; the classification and every git operation live in ``worktree_gc``).

Worktrees live on the HOST, so — like Verdikt previews — the portal only records settings and
requests and this daemon does the git work and reports back. Each daemon tick
(``service_worktrees``, never raises):

  1. every ~10 s claims pending requests from the portal
     (``POST /api/containers/{cid}/agent-worktrees/claim``) — the answer also carries the
     project's settings (auto clean-up on/off, grace days) and the worktrees a running run or
     preview uses — runs them (remove / save output / clean up / refresh) and reports each
     result;
  2. when auto clean-up is on, sweeps every worktree under ``.orcha-worktrees`` — on the first
     pass after start (so worktrees that existed before an upgrade are handled too) and then
     hourly — applying the rules below;
  3. reports an inventory (state, size, age, files) every 10 minutes and after any change,
     which Settings › Agent worktrees displays.

Rules (``plan_row``):
  * ``clean``      wake worktrees go right away (also straight after their run —
                   ``after_run``); a per-task worktree when its task is completed/cancelled
                   (it is the task's durable checkout while the task is open); resident /
                   live-terminal worktrees once idle for a day (they are recreated on demand).
  * ``has-output`` the output is attached to the task as deliverables (or, with no task, copied
                   to ``.orcha/saved-output/<branch>/``) and the worktree is kept for the grace
                   period, counted from the later of the task's end (or last activity when there
                   is no task) and when this daemon first saw it — then removed.
  * ``unmerged`` / ``in-use`` / ``not-quorate``: never removed automatically.
Every removal is logged as a project event.
"""

from __future__ import annotations

import os
import socket
import sys
import time
from typing import Callable, Optional

from . import notifier_deliverables
from . import worktree_gc as gc

CLAIM_EVERY_S = 10.0
SWEEP_EVERY_S = 3600.0
FIRST_SWEEP_DELAY_S = 30.0
REPORT_EVERY_S = 600.0
CLEAN_IDLE_S = 24 * 3600.0
TERMINAL = ("completed", "cancelled")
DEFAULT_SETTINGS = {"auto_cleanup": True, "grace_days": 7}


class GcState:
    """Daemon-scope memory for the housekeeper."""

    def __init__(self):
        self.settings: Optional[dict] = None
        self.remote_busy: set[str] = set()
        self.started = time.monotonic()
        self.last_claim = 0.0
        self.last_sweep: Optional[float] = None
        self.last_report = 0.0
        self.report_due = True
        self.size_cache: dict = {}
        self.project_cwd: Optional[str] = None
        self.api_base: Optional[str] = None
        self.cid: Optional[str] = None


STATE = GcState()  # the reaper's after_run hook reads the settings the loop last fetched


def _default_post(url, body, timeout=8.0):
    from .notifier_host import _post_json

    return _post_json(url, body, timeout=timeout)


def _default_get(url, timeout=8.0):
    from .notifier_host import _get_json

    return _get_json(url, timeout=timeout)


def upload_deliverable(api_base: str) -> Callable[[str, str, str, Optional[str]], bool]:
    """An uploader for ``worktree_gc.preserve_output``: the same deliverables endpoint the
    run-end collector uses (201 = stored or an identical version already there)."""

    def _upload(task_id, logical, full, run_id):
        with open(full, "rb") as f:
            data = f.read()
        status, _ = notifier_deliverables._post_multipart(
            f"{api_base}/api/tasks/{task_id}/deliverables",
            {"path": logical, "run_id": run_id},
            os.path.basename(full),
            data,
        )
        return status == 201

    return _upload


def _claimed_by() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


def local_busy(live_workers=None, live_residents=None, previews=None, *, exclude=None) -> set[str]:
    """Worktrees this daemon's own workers, residents and previews are using."""
    busy: set[str] = set()
    for worker in (live_workers or {}).values():
        if worker is exclude:
            continue
        if worker.get("worktree"):
            busy.add(worker["worktree"])
    for resident in (live_residents or {}).values():
        if resident.get("worktree"):
            busy.add(resident["worktree"])
    for p in (getattr(previews, "active", None) or {}).values():
        cwd = getattr(p, "cwd", None)
        if cwd:
            busy.add(cwd)
    return busy


def _log(quiet: bool, msg: str) -> None:
    if not quiet:
        print(f"[notifier] worktrees: {msg}", file=sys.stderr)


def report_event(api_base, cid, result: dict, trigger: str, *, post=_default_post) -> None:
    """Log one removal (or refused removal) as a project event."""
    preserved = result.get("preserved") or {}
    try:
        post(f"{api_base}/api/containers/{cid}/agent-worktrees/events", {
            "kind": "removed" if result.get("outcome") == "removed" else "kept",
            "trigger": trigger,
            "path": result.get("path"),
            "branch": result.get("branch"),
            "state": result.get("state"),
            "reason": (result.get("reason") or "")[:500],
            "freed_bytes": int(result.get("freed_bytes") or 0),
            "branch_deleted": bool(result.get("branch_deleted")),
            "attached": len(preserved.get("attached") or []),
            "saved": len(preserved.get("saved") or []),
            "saved_to": preserved.get("saved_to"),
        })
    except Exception:  # noqa: BLE001 - logging must never break the housekeeping
        pass


def fetch_context(api_base, cid, rows, *, post=_default_post) -> dict:
    """{path: {task_id, task_status, task_ended_at(epoch), run_id, running}} from worker_runs."""
    if not rows:
        return {}
    res = post(f"{api_base}/api/containers/{cid}/agent-worktrees/context",
               {"paths": [r["path"] for r in rows][:500],
                "task_refs": {r["path"]: r["task_ref"] for r in rows if r.get("task_ref")}})
    items = (res or {}).get("items") if isinstance(res, dict) else None
    return items if isinstance(items, dict) else {}


def _epoch(iso: Optional[str]) -> Optional[float]:
    if not iso:
        return None
    try:
        import datetime as dt

        return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _last_activity(row) -> Optional[float]:
    return _epoch(row.get("last_activity_at"))


def plan_row(row: dict, ctx: Optional[dict], settings: dict, first_seen: float,
             now: float) -> tuple[str, str]:
    """('remove'|'preserve'|'keep', why) for one inventory row under the automatic rules."""
    state = row["state"]
    if state in (gc.STATE_NOT_QUORATE, gc.STATE_IN_USE, gc.STATE_UNMERGED):
        return "keep", row.get("reason") or state
    ctx = ctx or {}
    if ctx.get("running"):
        return "keep", "a run is still recorded as running in it"
    task_id = ctx.get("task_id")
    task_status = ctx.get("task_status")
    task_done = task_status in TERMINAL
    idle = now - (_last_activity(row) or now)
    kind = row.get("kind")
    if state == gc.STATE_CLEAN:
        if kind == "wake":
            return "remove", "clean wake worktree"
        if kind == "task" and task_id:
            return ("remove", f"clean, task {task_status}") if task_done else \
                ("keep", "the task is still open — its durable checkout")
        if idle >= CLEAN_IDLE_S:
            return "remove", f"clean and idle {int(idle // 3600)}h"
        return "keep", "clean but used within the last day"
    # has-output
    grace = max(0, int(settings.get("grace_days", 7))) * 86400
    if task_id and not task_done:
        return "preserve", "task still open — output attached, worktree kept"
    ended = _epoch(ctx.get("task_ended_at")) if task_id else _last_activity(row)
    start = max(first_seen, ended or first_seen)
    if now - start >= grace:
        return "remove", "output saved; grace period over"
    left = int((grace - (now - start)) // 3600)
    return "preserve", f"output saved; removed in ~{left}h (grace period)"


def _remove(project_cwd, api_base, cid, row, ctx, busy, *, trigger, quiet, post, upload,
            allow_unmerged=False, keep_branch=False) -> dict:
    task_id = (ctx or {}).get("task_id")
    run_id = (ctx or {}).get("run_id") if (ctx or {}).get("run_task_id") in (None, task_id) else None
    result = gc.remove_worktree(project_cwd, row["path"], busy=busy, allow_unmerged=allow_unmerged,
                                keep_branch=keep_branch, task_id=task_id, run_id=run_id,
                                upload=upload)
    if result.get("outcome") == "removed":
        _log(quiet, f"removed {row['name']} ({result.get('reason')}; "
                    f"{gc.human_bytes(result.get('freed_bytes'))} freed; branch {result.get('branch_note')})")
    else:
        _log(quiet, f"kept {row['name']} — {result.get('reason')}")
    report_event(api_base, cid, result, trigger, post=post)
    return result


def sweep(api_base, cid, project_cwd, state: GcState, busy: set[str], *, quiet=True,
          post=_default_post, upload=None, now=None) -> dict:
    """One pass over every worktree under .orcha-worktrees (pre-existing ones included)."""
    now = time.time() if now is None else now
    settings = state.settings or DEFAULT_SETTINGS
    summary = {"removed": [], "preserved": [], "kept": [], "freed_bytes": 0}
    rows = gc.inventory(project_cwd, busy=busy, measure=True, size_cache=state.size_cache)
    if rows is None:
        return summary
    seen = gc.first_seen(project_cwd, rows, now=now)
    contexts = fetch_context(api_base, cid, rows, post=post)
    upload = upload or upload_deliverable(api_base)
    for row in rows:
        ctx = contexts.get(row["path"])
        action, why = plan_row(row, ctx, settings, seen.get(row["path"], now), now)
        if action == "remove":
            res = _remove(project_cwd, api_base, cid, row, ctx, busy, trigger="sweep",
                          quiet=quiet, post=post, upload=upload)
            if res.get("outcome") == "removed":
                summary["removed"].append(row["path"])
                summary["freed_bytes"] += int(res.get("freed_bytes") or 0)
            else:
                summary["kept"].append(row["path"])
        elif action == "preserve":
            kept = gc.preserve_output(project_cwd, row, task_id=(ctx or {}).get("task_id"),
                                      upload=upload)
            summary["preserved"].append(row["path"])
            if kept["attached"] or kept["saved"]:
                _log(quiet, f"saved output of {row['name']}: {len(kept['attached'])} attached to "
                            f"the task, {len(kept['saved'])} copied to {kept['saved_to'] or '-'} ({why})")
        else:
            summary["kept"].append(row["path"])
    if summary["removed"]:
        state.report_due = True
    return summary


def after_run(api_base: str, worker: dict, live_workers=None, *, quiet=True,
              post=_default_post, get=_default_get, upload=None) -> Optional[dict]:
    """Right after a run ends: remove its worktree when clean (wake worktrees, or a task's once
    the task is over) and attach a has-output worktree's files to its task. Never raises."""
    try:
        settings = STATE.settings
        worktree = worker.get("worktree")
        base = worker.get("base_cwd")
        if not settings or not settings.get("auto_cleanup") or not worktree or not base:
            return None
        if not gc.is_managed_path(base, worktree) or not os.path.isdir(worktree):
            return None
        # The portal's busy list was fetched while THIS run was still running; its own entry is
        # stale now (the process check below still protects anything alive in the folder).
        busy = local_busy(live_workers, exclude=worker) | (STATE.remote_busy - {worktree})
        if _still_running(worker):
            busy.add(worktree)
        wts = [w for w in (gc.managed_worktrees(base) or []) if gc._real(w["path"]) == gc._real(worktree)]
        if not wts:
            return None
        root = gc.worktrees_root(base)
        busy |= {c for c in gc.process_cwds() if c.startswith(root)}
        row = gc.classify(base, wts[0], busy=busy, measure=False)
        task_id = (worker.get("respawn_ctx") or {}).get("task_id")
        upload = upload or upload_deliverable(api_base)
        cid = STATE.cid
        if row["state"] == gc.STATE_CLEAN:
            remove = row.get("kind") == "wake"
            if row.get("kind") == "task" and task_id:
                task = get(f"{api_base}/api/tasks/{task_id}") or {}
                status = (task.get("task") or task).get("status") if isinstance(task, dict) else None
                remove = status in TERMINAL
            if remove:
                ctx = {"task_id": task_id, "run_id": worker.get("run_id"), "run_task_id": task_id}
                return _remove(base, api_base, cid, row, ctx, busy, trigger="after_run",
                               quiet=quiet, post=post, upload=upload)
            return None
        if row["state"] == gc.STATE_HAS_OUTPUT and task_id:
            kept = gc.preserve_output(base, row, task_id=task_id, run_id=worker.get("run_id"),
                                      upload=upload)
            if kept["attached"] or kept["saved"]:
                _log(quiet, f"attached {len(kept['attached'])} file(s) from {row['name']} to task "
                            f"{task_id}" + (f"; {len(kept['saved'])} copied to {kept['saved_to']}"
                                            if kept["saved"] else ""))
            return {"outcome": "preserved", **kept}
        return None
    except Exception as exc:  # noqa: BLE001 - never break the reaper
        _log(quiet, f"after-run clean-up skipped: {exc}")
        return None


def _still_running(worker) -> bool:
    proc = worker.get("proc")
    try:
        return proc is not None and proc.poll() is None
    except Exception:  # noqa: BLE001
        return False


# ------------------------------------------------------------------ requests from the portal

def run_action(api_base, cid, project_cwd, action: dict, busy: set[str], *, quiet=True,
               post=_default_post, upload=None, state: Optional[GcState] = None) -> dict:
    """Carry out one claimed request; returns the result body reported back."""
    kind = action.get("action")
    upload = upload or upload_deliverable(api_base)
    if kind == "refresh":
        return {"status": "done", "result": {"refreshed": True}}
    rows = gc.inventory(project_cwd, busy=busy, measure=True,
                        size_cache=(state.size_cache if state else None)) or []
    contexts = fetch_context(api_base, cid, rows, post=post)
    by_path = {gc._real(r["path"]): r for r in rows}
    if kind in ("remove", "save_output"):
        row = by_path.get(gc._real(action.get("path") or ""))
        if not row:
            return {"status": "failed", "error": "that worktree is no longer there"}
        ctx = contexts.get(row["path"])
        if kind == "save_output":
            kept = gc.preserve_output(project_cwd, row, task_id=(ctx or {}).get("task_id"),
                                      upload=upload)
            if kept["failed"]:
                return {"status": "failed", "error": "some files couldn't be saved: " +
                        ", ".join(f["path"] for f in kept["failed"][:5]), "result": kept}
            return {"status": "done", "result": kept}
        res = _remove(project_cwd, api_base, cid, row, ctx, busy, trigger="manual", quiet=quiet,
                      post=post, upload=upload,
                      allow_unmerged=bool(action.get("confirm_unmerged")),
                      keep_branch=bool(action.get("keep_branch")))
        ok = res.get("outcome") == "removed"
        return {"status": "done" if ok else "failed", "result": res,
                "error": None if ok else res.get("reason")}
    if kind == "clean_up":
        return {"status": "done", "result": bulk_clean(
            project_cwd, rows, contexts, busy,
            include_output=bool(action.get("include_output", True)),
            unmerged_paths=action.get("unmerged_paths") or [],
            api_base=api_base, cid=cid, quiet=quiet, post=post, upload=upload)}
    return {"status": "failed", "error": f"unknown action {kind!r}"}


def bulk_clean(project_cwd, rows, contexts, busy, *, include_output=True, unmerged_paths=(),
               api_base=None, cid=None, quiet=True, post=_default_post, upload=None,
               dry_run=False, trigger="manual") -> dict:
    """"Clean up existing worktrees": clean → removed; has-output → output saved to the task
    (or saved-output), then removed; unmerged → kept unless listed in ``unmerged_paths``
    (then the worktree goes and the branch stays); in-use / not-quorate → skipped."""
    wanted_unmerged = {gc._real(p) for p in unmerged_paths}
    out = {"removed": [], "kept": [], "skipped": [], "freed_bytes": 0, "dry_run": dry_run}
    for row in rows:
        state = row["state"]
        entry = {"path": row["path"], "name": row["name"], "branch": row["branch"], "state": state,
                 "size_bytes": row.get("size_bytes"), "reason": row.get("reason")}
        if state in (gc.STATE_IN_USE, gc.STATE_NOT_QUORATE):
            out["skipped"].append(entry)
            continue
        allow_unmerged = keep_branch = False
        if state == gc.STATE_UNMERGED:
            if gc._real(row["path"]) not in wanted_unmerged:
                out["kept"].append(dict(entry, reason="unmerged commits — kept"))
                continue
            allow_unmerged = keep_branch = True
        if state == gc.STATE_HAS_OUTPUT and not include_output:
            out["kept"].append(dict(entry, reason="has output — kept"))
            continue
        if dry_run:
            out["removed"].append(dict(entry, would=True, saves=row.get("output", []) + row.get("modified", []),
                                       keep_branch=keep_branch))
            out["freed_bytes"] += int(row.get("size_bytes") or 0)
            continue
        ctx = contexts.get(row["path"])
        if api_base and cid:
            res = _remove(project_cwd, api_base, cid, row, ctx, busy, trigger=trigger, quiet=quiet,
                          post=post, upload=upload, allow_unmerged=allow_unmerged,
                          keep_branch=keep_branch)
        else:
            res = gc.remove_worktree(project_cwd, row["path"], busy=busy,
                                     allow_unmerged=allow_unmerged, keep_branch=keep_branch,
                                     task_id=(ctx or {}).get("task_id"), upload=upload)
        if res.get("outcome") == "removed":
            out["removed"].append(dict(entry, branch_note=res.get("branch_note"),
                                       preserved=res.get("preserved")))
            out["freed_bytes"] += int(res.get("freed_bytes") or 0)
        else:
            out["kept"].append(dict(entry, reason=res.get("reason")))
    return out


# ------------------------------------------------------------------ the daemon tick

def report_inventory(api_base, cid, project_cwd, state: GcState, busy: set[str], *,
                     post=_default_post) -> Optional[list]:
    rows = gc.inventory(project_cwd, busy=busy, measure=True, size_cache=state.size_cache)
    if rows is None:
        return None
    contexts = fetch_context(api_base, cid, rows, post=post)
    for row in rows:
        ctx = contexts.get(row["path"]) or {}
        row["task_id"] = ctx.get("task_id")
        row["task_title"] = ctx.get("task_title")
        row["task_status"] = ctx.get("task_status")
        row["agent"] = row.get("agent") or ctx.get("agent")
    post(f"{api_base}/api/containers/{cid}/agent-worktrees/inventory", {
        "host": socket.gethostname(),
        "base_cwd": project_cwd,
        "items": rows,
    }, timeout=15.0)
    state.last_report = time.monotonic()
    state.report_due = False
    return rows


def service_worktrees(api_base: str, cid: str, state: GcState, project_cwd: Optional[str], *,
                      live_workers=None, live_residents=None, previews=None, quiet: bool = True,
                      dry_run: bool = False, post=_default_post, upload=None,
                      clock=time.monotonic) -> None:
    """The per-tick entry point (see the module docstring). Never raises."""
    if dry_run or not project_cwd:
        return
    try:
        state.project_cwd, state.api_base, state.cid = project_cwd, api_base, cid
        now = clock()
        actions = []
        if now - state.last_claim >= CLAIM_EVERY_S:
            state.last_claim = now
            res = post(f"{api_base}/api/containers/{cid}/agent-worktrees/claim",
                       {"claimed_by": _claimed_by()})
            if isinstance(res, dict):
                settings = res.get("settings")
                if isinstance(settings, dict):
                    state.settings = {"auto_cleanup": bool(settings.get("auto_cleanup", True)),
                                      "grace_days": int(settings.get("grace_days", 7))}
                state.remote_busy = {p for p in (res.get("busy_worktrees") or []) if p}
                actions = [a for a in (res.get("actions") or []) if isinstance(a, dict)]
        busy = local_busy(live_workers, live_residents, previews) | state.remote_busy
        for action in actions:
            try:
                body = run_action(api_base, cid, project_cwd, action, busy, quiet=quiet,
                                  post=post, upload=upload, state=state)
            except Exception as exc:  # noqa: BLE001
                body = {"status": "failed", "error": f"{exc}"[:500]}
            post(f"{api_base}/api/agent-worktrees/actions/{action.get('id')}/result", body)
            state.report_due = True
        if state.settings and state.settings.get("auto_cleanup"):
            due = (state.last_sweep is None and now - state.started >= FIRST_SWEEP_DELAY_S) or \
                  (state.last_sweep is not None and now - state.last_sweep >= SWEEP_EVERY_S)
            if due:
                state.last_sweep = now
                sweep(api_base, cid, project_cwd, state, busy, quiet=quiet, post=post, upload=upload)
        if state.settings is not None and (state.report_due or now - state.last_report >= REPORT_EVERY_S):
            report_inventory(api_base, cid, project_cwd, state, busy, post=post)
    except Exception as exc:  # noqa: BLE001 - a daemon must not die on housekeeping
        _log(quiet, f"housekeeping error (continuing): {exc}")
