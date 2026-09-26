"""Share task completion, dependency unblocking, and digest recalibration."""

import json
import time

from portal_backend.agent_status import log_event
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.request_backstop import (
    backstop_stranded_request as _backstop_stranded_request,
)


def _no_digest_curator():
    return None


_digest_curate_getter = _no_digest_curator


def configure_compatibility(digest_curate_getter):
    """Bind the optional facade-owned digest curator for compatibility."""
    global _digest_curate_getter
    _digest_curate_getter = digest_curate_getter


def _recalibrate_agent_digest_on_close(
    cur, container_id, agent_id, task_id, task_title, *, verification_pending
):
    """GH #35: when a task closes, prune the owning agent's LATEST memory digest so the next wake
    doesn't rehydrate the finished task's stale open threads / task-scoped decisions. Durable
    learnings are preserved; current focus is reset only when it pointed at the closed task; a
    still-pending human-verification thread is kept when the task only reached needs_verification.

    Append-only: writes a NEW recalibrated snapshot (the prior full digest stays in
    agent_memory_digests history — this demotes, it never hard-deletes the record). Best-effort and
    silent no-op when the curator copy is absent, the agent has no digest yet, or nothing in the
    digest referenced the task (so a completion never spawns a churn row for nothing)."""
    digest_curate = _digest_curate_getter()
    if digest_curate is None or not _valid_uuid(agent_id):
        return
    cur.execute(
        """SELECT current_focus, decisions, learnings, open_threads, audience
             FROM agent_memory_digests
            WHERE agent_id=%s ORDER BY snapshot_ts DESC LIMIT 1""",
        (agent_id,),
    )
    row = cur.fetchone()
    if not row:
        return
    inner = {
        "current_focus": row["current_focus"],
        "decisions": row["decisions"] or [],
        "learnings": row["learnings"] or [],
        "open_threads": row["open_threads"] or [],
    }
    recal = digest_curate.recalibrate_digest(
        inner, str(task_id), task_title or "", verification_pending=verification_pending
    )
    # No-op guard: only persist a new snapshot if the recalibration actually changed something.
    if (
        recal.get("open_threads") == inner["open_threads"]
        and recal.get("decisions") == inner["decisions"]
        and recal.get("current_focus") == inner["current_focus"]
    ):
        return
    ts = time.time()
    cur.execute(
        """INSERT INTO agent_memory_digests
             (container_id, agent_id, snapshot_ts, current_focus,
              decisions, learnings, open_threads, audience)
           VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s)
           RETURNING id""",
        (
            str(container_id),
            agent_id,
            ts,
            recal.get("current_focus"),
            json.dumps(recal.get("decisions") or []),
            json.dumps(recal.get("learnings") or []),
            json.dumps(recal.get("open_threads") or []),
            row["audience"],
        ),
    )
    did = cur.fetchone()["id"]
    log_event(
        cur,
        container_id,
        "system",
        None,
        "agent",
        agent_id,
        "digest_snapshotted",
        {
            "digest_id": did,
            "recalibrated": True,
            "task_id": str(task_id),
            "reason": "task_closed",
        },
    )
    # ISS-58: container-scoped only (non-waking) — a snapshot is a dashboard notification, not work.
    _publish_event(
        cur,
        str(container_id),
        None,
        "digest_snapshotted",
        {
            "digest_id": did,
            "snapshot_ts": ts,
            "agent_id": agent_id,
            "recalibrated": True,
        },
    )


def _recalibrate_task_owners(
    cur, container_id, tid, task_title, *, verification_pending
):
    """GH #35: recalibrate EVERY owning assignee's digest for a task that just closed. Owners come
    from agent_tasks (done/working rows both count — the assignment row survives completion)."""
    cur.execute("SELECT DISTINCT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))
    for r in cur.fetchall():
        _recalibrate_agent_digest_on_close(
            cur,
            container_id,
            str(r["agent_id"]),
            tid,
            task_title,
            verification_pending=verification_pending,
        )


def _complete_and_unblock(cur, container_id, tid):
    """#298: the SHARED completion mechanics used by BOTH the human /verify (approve branch) and
    the full-autonomy /done path. Extracted so the two cannot drift — a single edit here changes
    both completion routes (a drift tooth in the tests proves it). Mechanics ONLY: it marks the
    task completed, unblocks every downstream task whose deps are now all satisfied (publishing the
    container-wide + per-assignee `task_ready` wakes), and completes the container if THIS was the
    root. It does NOT emit the verified / task_verified audit + wake events — each caller owns its
    own audit trail (a human verification vs an engine auto-completion are different events).
    Returns the list of newly-unblocked downstream task ids."""
    # GH #56 (Point 5): if THIS task was the accepter's spawned task and its originating request is
    # still 'accepted' (forgot to report back), auto-answer it now so the loop never strands. Covers
    # both completion routes that funnel through here (full-autonomy /done and the human /verify
    # approve branch). Usually a no-op (the request was already answered by the report-back).
    _backstop_stranded_request(cur, container_id, tid)
    cur.execute(
        "UPDATE tasks SET status='completed', completed_at=now() WHERE id=%s", (tid,)
    )
    cur.execute("DELETE FROM agent_self_wake WHERE task_id=%s", (tid,))
    # unblock downstream tasks whose deps are now all completed
    cur.execute(
        """SELECT DISTINCT td.task_id
           FROM task_dependencies td
           WHERE td.depends_on_id = %s""",
        (tid,),
    )
    downstream = [str(r["task_id"]) for r in cur.fetchall()]
    unblocked = []
    for dst in downstream:
        cur.execute(
            """SELECT 1
               FROM task_dependencies td
               JOIN tasks dep ON dep.id = td.depends_on_id
               WHERE td.task_id=%s AND dep.status <> 'completed'
               LIMIT 1""",
            (dst,),
        )
        if not cur.fetchone():
            cur.execute(
                "UPDATE tasks SET status='ready' WHERE id=%s AND status='pending'",
                (dst,),
            )
            if cur.rowcount:
                unblocked.append(dst)
                log_event(
                    cur,
                    container_id,
                    "system",
                    None,
                    "task",
                    dst,
                    "status_changed",
                    {"to": "ready", "reason": "deps satisfied"},
                )
    for dst in unblocked:
        # Container-wide task_ready (dashboards / unassigned-pool pickup).
        _publish_event(cur, str(container_id), None, "task_ready", {"task_id": dst})
        # Epic A: a newly-ready ASSIGNED task ALSO gets a task_ready targeted at its assignee
        # so the daemon can wake its owner to auto-start it.
        cur.execute(
            "SELECT DISTINCT agent_id FROM agent_tasks WHERE task_id=%s", (dst,)
        )
        for ar in cur.fetchall():
            _publish_event(
                cur,
                str(container_id),
                str(ar["agent_id"]),
                "task_ready",
                {"task_id": dst, "assigned": True},
            )

    # Did this complete the root? If so, complete the container.
    cur.execute("SELECT is_root, container_id, title FROM tasks WHERE id=%s", (tid,))
    tr = cur.fetchone()
    if tr["is_root"]:
        cur.execute(
            "UPDATE containers SET status='completed', completed_at=now() "
            "WHERE id=%s AND status<>'completed'",
            (tr["container_id"],),
        )
        if cur.rowcount:
            log_event(
                cur,
                tr["container_id"],
                "system",
                None,
                "container",
                tr["container_id"],
                "status_changed",
                {"to": "completed", "reason": "root task verified"},
            )
    # GH #35: this is the SHARED terminal-completion path (full-autonomy /done + human /verify
    # approve). Recalibrate each owner's digest so the next wake doesn't rehydrate this finished
    # task's stale open threads / decisions. Completion is terminal — verification is NOT pending.
    _recalibrate_task_owners(
        cur, container_id, tid, tr["title"], verification_pending=False
    )
    return unblocked
