"""Assemble the compact container snapshot polled by the portal."""

from fastapi import HTTPException

from portal_backend.application import app
from portal_backend.autonomy import effective_autonomy
from portal_backend.database import db_cursor
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.request_ownership import _annotate_request_ownership
from portal_backend.task_list_query import _task_list_sql


@app.get("/api/containers/{cid}")
def get_container(cid: str, task_limit: int = 1000, request_limit: int = 1000):
    """The portal's 5s poll. ISS-68 (#167): the snapshot no longer ships each task's full
    message THREAD (~277KB re-sent every poll) — tasks carry a compact `message_summary`
    {count,last} + `plan_message` (the approval card renders the plan thread-free), and the
    full thread is lazy-fetched on expand via GET /api/tasks/{tid}/messages. Tasks/requests
    are priority-ordered and capped at task_limit/request_limit (the portal passes the count
    it has loaded so the poll refreshes that window; `task_total`/`request_total` gate
    'load more'). Defaults are generous so non-portal callers still get the full set."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    task_limit = max(1, min(task_limit, 1000))
    request_limit = max(1, min(request_limit, 1000))
    with db_cursor() as (_, cur):
        cur.execute(
            """SELECT id, name, description, status, root_task_id,
                      max_auto_agents, max_tasks, execution_mode, wakes_enabled,
                      autonomy_level, autonomy_enforced,
                      created_at, completed_at
               FROM containers WHERE id=%s""",
            (cid,),
        )
        c = cur.fetchone()
        if not c:
            raise HTTPException(404, f"container {cid} not found")

        # Item 6 (review): single-pass aggregation instead of correlated subquery per agent.
        # D7: additionally surface model (D7), wake_enabled (reachability join),
        # current_task (the actively-worked task) and last_active (latest of heartbeat /
        # worker-run start) so the redesign can render agent cards without extra calls.
        cur.execute(
            """SELECT a.id, a.alias, a.role, a.kind, a.turns_used, a.turn_budget,
                      a.last_heartbeat_at, a.is_auto_created, a.created_at, a.terminated_at,
                      a.model, a.reasoning_effort,
                      -- mig 034: this agent's per-agent autonomy override (NULL = inherit the
                      -- container level). The roster card renders a small badge when non-NULL;
                      -- the effective level is computed below (container-enforced aware).
                      a.autonomy_override,
                      -- #266: the configured clock-driven auto-wake cadence (NULL = off) so the
                      -- portal can render/edit it on the agent card without a second call.
                      a.auto_wake_interval_secs,
                      -- A short glanceable prompt preview for the agent view; the FULL
                      -- system_prompt stays on GET /api/agents/{aid}/persona (lazy-loaded
                      -- on expand) so we don't ride 8KB x N prompts on every roster poll.
                      LEFT(a.system_prompt, 160) AS prompt_preview,
                      COALESCE(r.wake_enabled, true) AS wake_enabled,
                      GREATEST(
                          a.last_heartbeat_at,
                          (SELECT max(wr.started_at) FROM worker_runs wr WHERE wr.agent_id = a.id)
                      ) AS last_active,
                      (SELECT json_build_object('task_id', t2.id, 'title', t2.title)
                         FROM agent_tasks at2 JOIN tasks t2 ON t2.id = at2.task_id
                        WHERE at2.agent_id = a.id AND at2.assignment_status = 'working'
                        ORDER BY at2.assigned_at DESC LIMIT 1) AS current_task,
                      -- #340 regression fix (scope sharpened, Kedar live-test 2026-06-15):
                      -- the activity label must reflect the agent's LIVE run, NOT the persistent
                      -- task-claim. current_task (above) is an agent_tasks 'working' row, cleared
                      -- only on /orcha-done — it DIVERGES from live reality: an agent woken as a
                      -- conversation-turn / inbox-drain worker run (worker_runs.task_id NULL,
                      -- creating NO 'working' row — commits 6c40247/5995982) read IDLE even mid-run,
                      -- AND an agent carrying a STALE 'working' row (wrong-agent auto-claim bug)
                      -- showed that stale task while its live run was actually a checkpoint/request.
                      -- Surface the agent's live worker_run so the frontend can drive the label off
                      -- it (and fall back to current_task ONLY when no run is live). GATED on a LIVE
                      -- lease (the same predicate as `embodiment`/`status` below) so a STALE 'running'
                      -- orphan whose lease has already expired does NOT show a perpetual-busy label —
                      -- it correctly reads idle, consistent with the live-recomputed `status`. When
                      -- the live run IS a task, task_id + task_title are carried so the card shows the
                      -- worked task directly (no dependence on current_task matching).
                      (SELECT json_build_object(
                                  'run_id', wr.run_id,
                                  'wake_event', wr.wake_event,
                                  'wake_kind', wr.wake_kind,
                                  'runtime', wr.runtime,
                                  'task_id', wr.task_id,
                                  'task_title', t3.title,
                                  'has_conversation', wr.conversation_id IS NOT NULL,
                                  'started_at', wr.started_at)
                         FROM worker_runs wr
                         LEFT JOIN tasks t3 ON t3.id = wr.task_id
                        WHERE wr.agent_id = a.id AND wr.status = 'running'
                          -- GH #91/#90: keep active_run on the SAME lane surfaced by embodiment.
                          -- Work wins when both lanes are live; otherwise a live conversation lease
                          -- surfaces its conversation run. Without this, a newer resident run could
                          -- bind the portal's activity/terminal state while the row reports a WORK
                          -- embodiment.
                          AND (
                              (ws.wake_lease_until IS NOT NULL AND ws.wake_lease_until > now()
                               AND wr.lane = 'work')
                              OR (
                                  NOT (ws.wake_lease_until IS NOT NULL AND ws.wake_lease_until > now())
                                  AND ws.conv_lease_until IS NOT NULL AND ws.conv_lease_until > now()
                                  AND wr.lane = 'conversation'
                              )
                          )
                        ORDER BY wr.started_at DESC LIMIT 1) AS active_run,
                      -- §3b: the agent's current EMBODIMENT (the live single-flight lease kind, else
                      -- 'idle') so the portal can render the live-session indicator + lock/guard the
                      -- conversation panel and the 'Open terminal' action. idle|ephemeral|resident|live.
                      -- GH #91/#90: read BOTH lanes — a WORK lease surfaces its kind (ephemeral|live);
                      -- otherwise a live CONVERSATION lease surfaces 'resident' (the warm chat session).
                      CASE WHEN ws.wake_lease_until IS NOT NULL AND ws.wake_lease_until > now()
                           THEN ws.lease_kind
                           WHEN ws.conv_lease_until IS NOT NULL AND ws.conv_lease_until > now()
                           THEN ws.conv_lease_kind ELSE 'idle' END AS embodiment,
                      -- ISS-16/#89: LIVENESS-derived status, emitted UNDER `status` (the stored
                      -- agents.status column is left untouched as internal truth — internal callers
                      -- unaffected). The stored value flips to 'working' on task assignment
                      -- (recompute_agent_status, ownership-only) and recomputes ONLY at mutation
                      -- points, so it STICKS at 'working' long after the worker exits (Dock/Page
                      -- sticky-'Working' bug). Here we recompute it LIVE at query time — mirroring
                      -- recompute_agent_status's exact priority but GATING 'working' on a live
                      -- single-flight lease, so an owned-but-not-embodied task reads 'idle':
                      --   terminated       -> never auto-flip (defensive; terminated rows are filtered
                      --                       out by the WHERE below, kept for parity with recompute)
                      --   awaiting_request -> has >=1 open OUTGOING request (the `w` join below) —
                      --                       ABOVE working, matching recompute_agent_status priority
                      --   working          -> owns an active task (assigned/accepted/working) AND has
                      --                       a LIVE lease now (same predicate as `embodiment` above)
                      --   idle             -> none of the above (incl. a live lease with no task, OR
                      --                       an owned task with no live embodiment — the sticky-fix)
                      -- All four are existing stored-enum values recompute_agent_status already emits
                      -- and the frontend already styles — no new badge string, no migration, no
                      -- frontend change. Endpoint has no response_model -> untyped dict -> no OpenAPI
                      -- drift (the `status` field's documented type is unchanged: still a string).
                      CASE
                          WHEN a.status = 'terminated' THEN 'terminated'
                          WHEN w.waiting_on IS NOT NULL THEN 'awaiting_request'
                          -- GH #91/#90: 'working' needs an owned task AND a LIVE lease in EITHER lane
                          -- (a resident conversation is as embodied as a work worker).
                          WHEN ((ws.wake_lease_until IS NOT NULL AND ws.wake_lease_until > now())
                                OR (ws.conv_lease_until IS NOT NULL AND ws.conv_lease_until > now()))
                               AND EXISTS (SELECT 1 FROM agent_tasks at3
                                            WHERE at3.agent_id = a.id
                                              AND at3.assignment_status IN ('assigned','accepted','working'))
                               THEN 'working'
                          ELSE 'idle'
                      END AS status,
                      -- ISS-16/#89: RAW heartbeat freshness (seconds since the last keep-alive ping;
                      -- NULL if the agent never beat). No threshold — humans/clients decide what
                      -- 'stale' means; a 'stalled' badge that needs a threshold rides ISS-31 (Q2).
                      EXTRACT(EPOCH FROM (now() - a.last_heartbeat_at)) AS heartbeat_age_secs,
                      COALESCE(w.waiting_on, '[]'::json) AS waiting_on
               FROM agents a
               LEFT JOIN agent_reachability r ON r.agent_id = a.id
               LEFT JOIN agent_wake_state ws ON ws.agent_id = a.id
               LEFT JOIN (
                   SELECT r.requester_id,
                          json_agg(json_build_object(
                              'request_id', r.id,
                              'target_alias', COALESCE(t.alias, '(escalated to human)'),
                              'payload_preview', LEFT(r.payload, 120),
                              'chain_depth', r.chain_depth,
                              'created_at', r.created_at,
                              'expires_at', r.expires_at
                          ) ORDER BY r.created_at) AS waiting_on
                   FROM requests r LEFT JOIN agents t ON t.id = r.target_id
                   WHERE r.status='open' AND r.container_id=%s
                   GROUP BY r.requester_id
               ) w ON w.requester_id = a.id
               WHERE a.container_id=%s AND a.terminated_at IS NULL
               ORDER BY a.created_at""",
            (cid, cid),
        )
        agents = cur.fetchall()

        # mig 034: surface each agent's EFFECTIVE autonomy level alongside its raw override, using
        # the ONE shared rule (container level if the container enforces it for everyone, else the
        # agent's override, else the container level). Additive per-agent field — the container's
        # own autonomy_level/autonomy_enforced remain on `c` unchanged, so no existing field shifts
        # meaning. The roster reads `autonomy_override` for the badge and `effective_autonomy` for
        # the "acts as" label; the container carries the lock (autonomy_enforced) glyph.
        _cl = c["autonomy_level"]
        _ce = bool(c["autonomy_enforced"])
        for _a in agents:
            _a["effective_autonomy"] = effective_autonomy(
                _cl, _ce, _a.get("autonomy_override")
            )

        # ISS-68: TRIMMED, priority-ordered, capped task rows (same shape as GET
        # /api/containers/{cid}/tasks — message_summary + plan_message, NO full thread).
        cur.execute(
            "SELECT count(*) AS n FROM tasks t WHERE t.container_id = %s", (cid,)
        )
        task_total = cur.fetchone()["n"]
        task_order = (
            "ORDER BY CASE t.status WHEN 'needs_verification' THEN 0 "
            "WHEN 'in_progress' THEN 1 ELSE 2 END, t.priority, t.created_at"
        )
        cur.execute(
            _task_list_sql("t.container_id = %s", task_order), (cid, task_limit, 0)
        )
        tasks = cur.fetchall()

        # ISS-68: priority-ordered (open→answered→closed), capped request rows.
        cur.execute(
            "SELECT count(*) AS n FROM requests WHERE container_id = %s", (cid,)
        )
        request_total = cur.fetchone()["n"]
        cur.execute(
            """SELECT id, type, status, priority, requester_id, target_id,
                      payload, response, rejection_reason, spawned_task_id,
                      expires_at, created_at, responded_at, closed_at,
                      parent_request_id, chain_depth, detail,
                      -- D7: resolve the spawned task into a light link so the portal can
                      -- navigate request → task without a second call. (Shape pending Tim;
                      -- default = the spawned task.) NULL when the request spawned none.
                      (SELECT json_build_object('task_id', st.id, 'title', st.title, 'status', st.status)
                         FROM tasks st WHERE st.id = requests.spawned_task_id) AS task_link,
                      -- ISS-47: alias of the agent who owns the next action (open→target,
                      -- answered→requester) so the mixed all-request view is unambiguous.
                      (SELECT a.alias FROM agents a
                         WHERE a.id = CASE requests.status WHEN 'open' THEN requests.target_id
                                                           WHEN 'answered' THEN requests.requester_id END)
                        AS owner_alias
               FROM requests WHERE container_id=%s
               ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,
                        priority, created_at DESC, id
               LIMIT %s OFFSET 0""",
            (cid, request_limit),
        )
        requests = _annotate_request_ownership(cur.fetchall())

    return {
        "container": c,
        "agents": agents,
        "tasks": tasks,
        "requests": requests,
        "task_total": task_total,
        "request_total": request_total,
    }
