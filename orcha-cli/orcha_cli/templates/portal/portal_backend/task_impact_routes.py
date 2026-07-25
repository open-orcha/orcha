"""Describe the downstream impact of closing a task without mutating it."""

from fastapi import HTTPException

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_task as _require_task
from portal_backend.guards import valid_uuid as _valid_uuid


@app.get("/api/tasks/{tid}/close-implications")
def close_implications(tid: str):
    """Epic B P2 (READ-ONLY): the blast radius of authoritatively closing/completing
    a task, so the portal can show a confirm summary BEFORE the human acts. Pure
    SELECTs — mutates nothing. Aggregates: downstream tasks (and whether completing
    THIS one would unblock each), agents actively working it, the request that
    spawned it (provenance), and still-open requests its assignees have in flight
    (would be orphaned). `completes_container` flags the root task, whose approval
    completes the whole container (see verify_task).
    """
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        t = _require_task(cur, tid)

        # 1) downstream tasks that depend on this one, with a would-unblock test:
        #    completing THIS task readies a downstream only if all its OTHER deps
        #    are already completed and it's still pending.
        cur.execute(
            """SELECT d.id, d.title, d.status
               FROM task_dependencies td JOIN tasks d ON d.id = td.task_id
               WHERE td.depends_on_id = %s ORDER BY d.created_at""",
            (tid,),
        )
        downstream, would_unblock, still_blocked = [], 0, 0
        for d in cur.fetchall():
            did = str(d["id"])
            cur.execute(
                """SELECT 1 FROM task_dependencies x JOIN tasks dep ON dep.id = x.depends_on_id
                   WHERE x.task_id = %s AND x.depends_on_id <> %s AND dep.status <> 'completed'
                   LIMIT 1""",
                (did, tid),
            )
            unblocks = cur.fetchone() is None and d["status"] == "pending"
            if unblocks:
                would_unblock += 1
            elif d["status"] in ("pending", "blocked"):
                still_blocked += 1
            downstream.append(
                {
                    "task_id": did,
                    "title": d["title"],
                    "status": d["status"],
                    "would_unblock": unblocks,
                }
            )

        # 2) agents actively working it
        cur.execute(
            """SELECT a.id, a.alias, at.assignment_status
               FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
               WHERE at.task_id = %s AND at.assignment_status IN ('assigned','accepted','working')
               ORDER BY a.alias""",
            (tid,),
        )
        in_flight = [
            {
                "agent_id": str(r["id"]),
                "alias": r["alias"],
                "assignment_status": r["assignment_status"],
            }
            for r in cur.fetchall()
        ]

        # 3) provenance: the request (if any) that spawned this task
        cur.execute(
            """SELECT r.id, r.status, ra.alias AS requester_alias
               FROM requests r LEFT JOIN agents ra ON ra.id = r.requester_id
               WHERE r.spawned_task_id = %s LIMIT 1""",
            (tid,),
        )
        sr = cur.fetchone()
        spawned_from = (
            {
                "request_id": str(sr["id"]),
                "requester_alias": sr["requester_alias"],
                "status": sr["status"],
            }
            if sr
            else None
        )

        # 4) still-open requests this task's assignees have in flight (orphan risk)
        cur.execute(
            """SELECT r.id, r.status, r.payload, ra.alias AS requester_alias, ta.alias AS target_alias
               FROM requests r
               LEFT JOIN agents ra ON ra.id = r.requester_id
               LEFT JOIN agents ta ON ta.id = r.target_id
               WHERE r.status IN ('open','answered')
                 AND r.requester_id IN (SELECT agent_id FROM agent_tasks WHERE task_id = %s)
               ORDER BY r.created_at""",
            (tid,),
        )
        open_reqs = [
            {
                "request_id": str(r["id"]),
                "status": r["status"],
                "requester_alias": r["requester_alias"],
                "target_alias": r["target_alias"],
                "preview": (r["payload"] or "")[:120],
            }
            for r in cur.fetchall()
        ]

    return {
        "task_id": tid,
        "title": t["title"],
        "status": t["status"],
        "is_root": t["is_root"],
        "downstream_tasks": downstream,
        "in_flight_agents": in_flight,
        "spawned_from_request": spawned_from,
        "open_requests_from_assignees": open_reqs,
        "summary": {
            "downstream_total": len(downstream),
            "would_unblock": would_unblock,
            "still_blocked": still_blocked,
            "in_flight_agents": len(in_flight),
            "open_requests": len(open_reqs),
            "completes_container": bool(t["is_root"]),
        },
    }
