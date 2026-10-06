"""Assemble the compact container snapshot polled by the portal."""

from fastapi import HTTPException, Request

from portal_backend import sql
from portal_backend.application import app
from portal_backend.autonomy import effective_autonomy
from portal_backend.database import db_cursor
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.identity_routes import require_member_read as _require_member_read
from portal_backend.request_ownership import (
    REQUEST_CLOSE_COLUMNS,
    REQUEST_ESCALATION_COLUMNS,
    REQUEST_ESCALATION_JOIN,
    _annotate_request_ownership,
)
from portal_backend.task_list_query import _task_list_sql


# The portal's "a host runtime serves this project" window (frontend
# pages/agents/presence.ts WAKES_SERVED_WINDOW_MS = 2 min) — kept in lockstep.
RUNTIME_SERVED_WINDOW_SECS = 120


def _wakes_paused_reason(container, agent):
    """Why NEW wakes are refused for this agent right now, else None.

    Mirrors wake_claim's refusal order exactly: the project is not active
    (``project_status``), the project-wide kill-switch is off
    (``project_wakes_off``), or this agent opted out (``agent_wakes_off``).
    Humans are never woken, so they are never "paused"."""
    if agent.get("kind") == "human":
        return None
    if container["status"] != "active":
        return "project_status"
    if not container["wakes_enabled"]:
        return "project_wakes_off"
    if agent.get("wake_enabled") is False:
        return "agent_wakes_off"
    return None


@app.get("/api/containers/{cid}")
def get_container(
    cid: str, request: Request, task_limit: int = 1000, request_limit: int = 1000
):
    """The portal's 5s poll. ISS-68 (#167): the snapshot no longer ships each task's full
    message THREAD (~277KB re-sent every poll) — tasks carry a compact `message_summary`
    {count,last} + `plan_message` (the approval card renders the plan thread-free), and the
    full thread is lazy-fetched on expand via GET /api/tasks/{tid}/messages. Tasks/requests
    are priority-ordered and capped at task_limit/request_limit (the portal passes the count
    it has loaded so the poll refreshes that window; `task_total`/`request_total` gate
    'load more'). `task_open_total`/`request_open_total` (additive) are the non-terminal /
    'open'-status counts — the ONE authoritative source for both the sidebar nav badges and
    the page-header counts, so the two can never read differently again (GH sidebar/iOS count
    mismatch: the header said '62 tasks' while the sidebar badge said '0' — different
    semantics, same-looking number). Defaults are generous so non-portal callers still get
    the full set."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    task_limit = max(1, min(task_limit, 1000))
    request_limit = max(1, min(request_limit, 1000))
    with db_cursor(readonly=True) as (_, cur):  # the 3 s dashboard poll: no write lock
        # Access model: reads are project-isolated — a trusted non-member is 403'd
        # (trust off / no header, and the unmapped bootstrap state, unchanged).
        _require_member_read(cur, request, cid)
        cur.execute(
            f"""SELECT id, name, description, status, root_task_id,
                      max_auto_agents, max_tasks, execution_mode, wakes_enabled,
                      -- mig 056 agent limit: the live AI agents created from suggestions,
                      -- i.e. what max_auto_agents is checked against (Settings → Execution)
                      (SELECT COUNT(*) FROM agents ag
                        WHERE ag.container_id = containers.id AND ag.terminated_at IS NULL
                          AND ag.kind = 'ai' AND ag.is_auto_created) AS auto_agents_in_use,
                      autonomy_level, autonomy_enforced, worktrees_disabled, github_repo,
                      -- mig 050 (D14): the project's cosmetic icon (NULL = default glyph)
                      icon,
                      -- mig 057: where finished work goes for verification + AI pre-review
                      review_route, ai_manager_prereview,
                      -- mig 037: the notifier's last wake-scan poll — recent means a
                      -- host daemon serves THIS project's wakes (switcher/notice signal).
                      last_wake_scan_at,
                      -- Additive (agent-status parity): the SERVER's reading of "is a host
                      -- runtime serving this project" (a wake-scan within the portal's 2-min
                      -- window, on the DB clock — no browser clock skew) so the header, the
                      -- roster, the board and the sidebar all read ONE fact.
                      (last_wake_scan_at IS NOT NULL
                       AND last_wake_scan_at > %s) AS runtime_served,
                      {sql.age_secs("last_wake_scan_at")} AS wake_scan_age_secs,
                      created_at, completed_at
               FROM containers WHERE id=%s""",
            (sql.ago(RUNTIME_SERVED_WINDOW_SECS), cid),
        )
        c = cur.fetchone()
        if not c:
            raise HTTPException(404, f"container {cid} not found")

        # Item 6 (review): single-pass aggregation instead of correlated subquery per agent.
        # D7: additionally surface model (D7), wake_enabled (reachability join),
        # current_task (the actively-worked task) and last_active (latest of heartbeat /
        # worker-run start) so the redesign can render agent cards without extra calls.
        # GH #258 S2b: dialect spellings built once, outside the SQL text.
        neg_inf = sql.ts_neg_infinity()
        prompt_preview_expr = sql.left("a.system_prompt", 160)
        # Postgres GREATEST ignores NULLs, SQLite max() does not: COALESCE each operand to
        # -infinity, and NULLIF restores the all-NULL -> NULL result (never beat, never ran).
        last_active_expr = "NULLIF(" + sql.greatest(
            f"COALESCE(a.last_heartbeat_at, {neg_inf})",
            "COALESCE((SELECT max(wr.started_at) FROM worker_runs wr"
            f" WHERE wr.agent_id = a.id), {neg_inf})",
        ) + f", {neg_inf})"
        payload_preview_expr = sql.left("r.payload", 120)
        cur.execute(
            f"""SELECT a.id, a.alias, a.role, a.kind, a.turns_used, a.turn_budget,
                      a.last_heartbeat_at, a.is_auto_created, a.created_at, a.terminated_at,
                      a.model, a.reasoning_effort,
                      -- Collab v1: GitHub identity + project role so the portal renders
                      -- member chips/avatars and owner-only affordances off the same poll.
                      a.github_login, a.member_role,
                      -- mig 052 (org chart): who this agent reports to (NULL = root). Humans
                      -- set it via PUT /api/agents/{{aid}}/reports-to; escalations walk it.
                      a.reports_to_agent_id AS reports_to,
                      -- mig 043: this agent's per-agent autonomy override (NULL = inherit the
                      -- container level). The roster card renders a small badge when non-NULL;
                      -- the effective level is computed below (container-enforced aware).
                      a.autonomy_override,
                      -- #266: the configured clock-driven auto-wake cadence (NULL = off) so the
                      -- portal can render/edit it on the agent card without a second call.
                      a.auto_wake_interval_secs,
                      -- A short glanceable prompt preview for the agent view; the FULL
                      -- system_prompt stays on GET /api/agents/{{aid}}/persona (lazy-loaded
                      -- on expand) so we don't ride 8KB x N prompts on every roster poll.
                      {prompt_preview_expr} AS prompt_preview,
                      COALESCE(r.wake_enabled, true) AS wake_enabled,
                      -- Additive (agent-status parity): the newest worker_run whose row says
                      -- 'running' — the SAME predicate GET /api/agents/{{aid}}/runs reports as
                      -- running (so the roster/board can agree with the workspace header,
                      -- which reads that list) — REGARDLESS of lease. `lease_live` says
                      -- whether the agent's lane lease is still live; a false value marks a
                      -- probable orphan the host reaper has not reconciled yet (active_run,
                      -- below, stays lease-gated and unchanged).
                      -- L13b: worktree/base_cwd ride along -- the board gates "Live changes"
                      -- on a readable checkout, like the workspace's hasCheckout().
                      (SELECT {sql.json_object(
                                  "'run_id'", "rr.run_id",
                                  "'lane'", "rr.lane",
                                  "'wake_kind'", "rr.wake_kind",
                                  "'runtime'", "rr.runtime",
                                  "'task_id'", "rr.task_id",
                                  "'task_title'", "rt.title",
                                  "'started_at'", "rr.started_at",
                                  "'worktree'", "rr.worktree",
                                  "'base_cwd'", "rr.base_cwd",
                                  "'lease_live'",
                                  sql.json_bool(
                                      "CASE WHEN rr.lane = 'conversation'"
                                      " THEN COALESCE(ws.conv_lease_until > now(), false)"
                                      " ELSE COALESCE(ws.wake_lease_until > now(), false) END"
                                  ))}
                         FROM worker_runs rr
                         LEFT JOIN tasks rt ON rt.id = rr.task_id
                        WHERE rr.agent_id = a.id AND rr.status = 'running'
                        ORDER BY rr.started_at DESC LIMIT 1) AS running_run,
                      {last_active_expr} AS last_active,
                      (SELECT {sql.json_object("'task_id'", "t2.id", "'title'", "t2.title")}
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
                      (SELECT {sql.json_object(
                                  "'run_id'", "wr.run_id",
                                  "'wake_event'", "wr.wake_event",
                                  "'wake_kind'", "wr.wake_kind",
                                  "'runtime'", "wr.runtime",
                                  "'task_id'", "wr.task_id",
                                  "'task_title'", "t3.title",
                                  "'has_conversation'", sql.json_bool("wr.conversation_id IS NOT NULL"),
                                  "'started_at'", "wr.started_at")}
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
                      {sql.age_secs("a.last_heartbeat_at")} AS heartbeat_age_secs,
                      COALESCE(w.waiting_on, '[]') AS waiting_on
               FROM agents a
               LEFT JOIN agent_reachability r ON r.agent_id = a.id
               LEFT JOIN agent_wake_state ws ON ws.agent_id = a.id
               -- GH #258 S2b: no ORDER BY inside the aggregate (SQLite < 3.44). One row per
               -- requester with open requests; its list is aggregated from a per-requester
               -- subquery that orders by created_at, so the GROUP BY never reorders it.
               LEFT JOIN (
                   SELECT q.requester_id,
                          (SELECT {sql.json_array_agg("s.x")} FROM (
                               SELECT {sql.json_object(
                                   "'request_id'", "r.id",
                                   "'target_alias'", "COALESCE(t.alias, '(escalated to human)')",
                                   "'payload_preview'", payload_preview_expr,
                                   "'chain_depth'", "r.chain_depth",
                                   "'created_at'", "r.created_at",
                                   "'expires_at'", "r.expires_at",
                               )} AS x
                                 FROM requests r LEFT JOIN agents t ON t.id = r.target_id
                                WHERE r.status='open' AND r.container_id=%s
                                  AND r.requester_id = q.requester_id
                                ORDER BY r.created_at) s) AS waiting_on
                   FROM requests q
                   WHERE q.status='open' AND q.container_id=%s
                   GROUP BY q.requester_id
               ) w ON w.requester_id = a.id
               WHERE a.container_id=%s AND a.terminated_at IS NULL
               ORDER BY a.created_at""",
            (cid, cid, cid),
        )
        agents = cur.fetchall()

        # mig 043: surface each agent's EFFECTIVE autonomy level alongside its raw override, using
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
            # Additive (agent-status parity): the explicit PAUSE fact, so no surface
            # guesses it. Pause semantics, per the enforcement code: a pause only
            # REFUSES NEW wake claims (wake_lease_claim_routes.wake_claim: container
            # not active / wakes_enabled=false / agent wake_enabled=false). It never
            # stops a run already in flight — that run keeps working until it exits.
            _a["wakes_paused_reason"] = _wakes_paused_reason(c, _a)
            _a["wakes_paused"] = _a["wakes_paused_reason"] is not None
            _a["pause_stops_running_run"] = False

        # ISS-68: TRIMMED, priority-ordered, capped task rows (same shape as GET
        # /api/containers/{cid}/tasks — message_summary + plan_message, NO full thread).
        # GH #(sidebar/iOS count mismatch): task_open_total rides the SAME count(*) pass
        # (one extra FILTER column, not a second query) — non-terminal statuses (everything
        # but completed/cancelled). This is the one authoritative "open tasks" number; the
        # sidebar badge AND the page header both read it so they can never diverge again.
        # Parity r2: the container's ROOT task is excluded — it is the project itself, not
        # a unit of work (the hub list, the onboarding checklist and every task board
        # already skip it), so a brand-new project reads "0 open tasks", not 1.
        cur.execute(
            """SELECT count(*) AS n,
                      count(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled')
                                         AND NOT t.is_root) AS open_n
               FROM tasks t WHERE t.container_id = %s""",
            (cid,),
        )
        _task_counts = cur.fetchone()
        task_total = _task_counts["n"]
        task_open_total = _task_counts["open_n"]
        task_order = (
            "ORDER BY CASE t.status WHEN 'needs_verification' THEN 0 "
            "WHEN 'in_progress' THEN 1 ELSE 2 END, t.priority, t.created_at"
        )
        cur.execute(
            _task_list_sql("t.container_id = %s", task_order), (cid, task_limit, 0)
        )
        tasks = cur.fetchall()

        # ISS-68: priority-ordered (open→answered→closed), capped request rows.
        # request_open_total mirrors task_open_total above: same query, one extra FILTER
        # column, the single authoritative "open requests" number for badge + header.
        cur.execute(
            """SELECT count(*) AS n,
                      count(*) FILTER (WHERE status = 'open') AS open_n
               FROM requests WHERE container_id = %s""",
            (cid,),
        )
        _request_counts = cur.fetchone()
        request_total = _request_counts["n"]
        request_open_total = _request_counts["open_n"]
        cur.execute(
            f"""SELECT id, type, status, priority, requester_id, target_id,
                      payload, response, rejection_reason, spawned_task_id,
                      expires_at, created_at, responded_at, closed_at,
                      parent_request_id, chain_depth, detail,
                      -- D7: resolve the spawned task into a light link so the portal can
                      -- navigate request → task without a second call. (Shape pending Tim;
                      -- default = the spawned task.) NULL when the request spawned none.
                      (SELECT {sql.json_object("'task_id'", "st.id", "'title'", "st.title", "'status'", "st.status")}
                         FROM tasks st WHERE st.id = requests.spawned_task_id) AS task_link,
                      -- ISS-47: alias of the agent who owns the next action (open→target,
                      -- answered→requester) so the mixed all-request view is unambiguous.
                      (SELECT a.alias FROM agents a
                         WHERE a.id = CASE requests.status WHEN 'open' THEN requests.target_id
                                                           WHEN 'answered' THEN requests.requester_id END)
                        AS owner_alias,
                      -- UR-08: the requester/target aliases resolved here — the snapshot
                      -- roster omits retired agents, so the client can't map their ids
                      -- (a retired requester used to render as the acting human). Retired
                      -- rows still resolve; *_retired flags them.
                      (SELECT ra.alias FROM agents ra WHERE ra.id = requests.requester_id)
                        AS requester_alias,
                      (SELECT ra.kind FROM agents ra WHERE ra.id = requests.requester_id)
                        AS requester_kind,
                      (SELECT ra.terminated_at IS NOT NULL FROM agents ra
                         WHERE ra.id = requests.requester_id) AS requester_retired,
                      (SELECT ta.alias FROM agents ta WHERE ta.id = requests.target_id)
                        AS target_alias,
                      (SELECT ta.terminated_at IS NOT NULL FROM agents ta
                         WHERE ta.id = requests.target_id) AS target_retired,
                      """
            + REQUEST_ESCALATION_COLUMNS
            + ","
            + REQUEST_CLOSE_COLUMNS
            + """
               FROM requests"""
            + REQUEST_ESCALATION_JOIN
            + """
               WHERE container_id=%s
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
        # Additive (GH sidebar/iOS count mismatch): non-terminal task count / open request
        # count. Older cached snapshots (or callers that predate this field) simply lack
        # the key — every consumer treats absence as "fall back to prior behavior".
        "task_open_total": task_open_total,
        "request_open_total": request_open_total,
    }
