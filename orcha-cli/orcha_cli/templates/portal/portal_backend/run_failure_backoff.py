"""Persistent, per-agent retry protection, accounted once at run completion.

The reserved wake_backoff key is independent of changing trigger names. Three failed
automatic work runs open the circuit until a human uses the existing release endpoint.
No task state, event acknowledgements, or live processes are changed by this module.
"""

import json
from datetime import timezone

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.events import publish_event
from portal_backend.guards import find_actionable_human
from portal_backend.run_failure_text import last_error

FAILURE_KEY = "run_failure"
FAILURE_LIMIT = 3
BASE_DELAY = 30
MAX_DELAY = 15 * 60


def failure_state(cur, aid):
    cur.execute(
        "SELECT *, (suppressed_until > now()) AS cooling FROM wake_backoff "
        "WHERE agent_id=%s AND wake_key=%s", (aid, FAILURE_KEY),
    )
    return cur.fetchone()


def failure_block(cur, aid):
    state = failure_state(cur, aid)
    if not state:
        return None
    if state["strikes"] >= FAILURE_LIMIT:
        return "Automatic work paused after repeated failures. Fix the cause, then resume in Activity."
    if state["cooling"]:
        return "Waiting before retrying a failed run."
    return None


def notify_failure(cur, cid, aid, state, error=None):
    if state["strikes"] < FAILURE_LIMIT or state["notified_at"] is not None:
        return
    human = find_actionable_human(cur, cid, grant="manage_autonomy")
    if not human:
        return  # a later scan can deliver the notice when a human is available
    cur.execute("SELECT alias FROM agents WHERE id=%s", (aid,))
    alias = cur.fetchone()["alias"]
    if error is None:
        cur.execute(
            "SELECT output FROM worker_runs WHERE agent_id=%s AND lane='work' "
            "AND (status IN ('failed','rate_limited') OR (status='exited' AND exit_code <> 0)) "
            "ORDER BY ended_at DESC LIMIT 1", (aid,),
        )
        run = cur.fetchone()
        error = last_error(run["output"]) if run else None
    payload = (
        f"{alias}'s automatic work is paused after {state['strikes']} consecutive failed runs. "
        f"Last error: {error or 'The worker failed without recording an error.'} "
        "Fix the cause, then choose Resume automatic work on this request or in Activity. "
        "Answering or nudging alone does not resume it. Pending work is saved."
    )
    # Claim the notice atomically: two scans can observe the same unnotified pause.
    cur.execute("UPDATE wake_backoff SET notified_at=now() WHERE agent_id=%s AND wake_key=%s "
                "AND notified_at IS NULL RETURNING agent_id", (aid, FAILURE_KEY))
    if cur.fetchone() is None:
        return
    cur.execute(
        """INSERT INTO requests
           (container_id, type, requester_id, target_id, priority, status, payload, expires_at, chain_depth)
           VALUES (%s, 'info', %s, %s, 100, 'open', %s, %s, 0) RETURNING id""",
        (cid, aid, human, payload, sql.from_now(7 * 86400)),
    )
    rid = str(cur.fetchone()["id"])
    log_event(cur, cid, "system", None, "request", rid, "created",
              {"reason": "run_failure_breaker", "agent_id": aid, "preview": payload[:120]})
    publish_event(cur, cid, human, "request_created",
                  {"request_id": rid, "type": "info", "from_agent_id": aid, "preview": payload[:120]})


def record_run_outcome(cur, run, body):
    # The caller locks the run and invokes us only for its first terminal finish.
    if run.get("lane") != "work" or run.get("conversation_id") or run["wake_kind"] == "live":
        return
    aid = str(run["agent_id"])
    # Serialize finishes for this agent (SQLite already holds BEGIN IMMEDIATE).
    cur.execute("SELECT container_id FROM agents WHERE id=%s" + sql.for_update(), (aid,))
    cid = str(cur.fetchone()["container_id"])
    if body.status == "exited" and body.exit_code == 0:
        cur.execute("DELETE FROM wake_backoff WHERE agent_id=%s AND wake_key=%s AND strikes < %s",
                    (aid, FAILURE_KEY, FAILURE_LIMIT))
        return
    # Provider failures can end with a zero or missing process exit code (Codex 429).
    # The terminal failure classification is authoritative in that case.
    if body.status not in ("failed", "rate_limited") and not (
        body.status == "exited" and body.exit_code not in (None, 0)
    ):
        return
    cur.execute(
        """INSERT INTO wake_backoff (container_id, agent_id, wake_key, strikes)
           VALUES (%s, %s, %s, 1) ON CONFLICT (agent_id, wake_key)
           DO UPDATE SET strikes=wake_backoff.strikes+1, last_strike_at=now()
           RETURNING strikes""", (cid, aid, FAILURE_KEY),
    )
    strikes = cur.fetchone()["strikes"]
    delay = min(MAX_DELAY, BASE_DELAY * 2 ** min(strikes - 1, 10))
    cur.execute("UPDATE wake_backoff SET suppressed_until=%s WHERE agent_id=%s AND wake_key=%s",
                (sql.from_now(delay) if strikes < FAILURE_LIMIT else None, aid, FAILURE_KEY))
    notify_failure(cur, cid, aid, failure_state(cur, aid), last_error(body.output))


def apply_failure_backoff(cur, cid, candidates, *, notify=True):
    for candidate in candidates:
        aid = candidate["agent_id"]
        state = failure_state(cur, aid)
        if state and notify:
            notify_failure(cur, cid, aid, state)
        reason = failure_block(cur, aid)
        if reason:
            candidate.update(should_wake=False, reason=reason,
                             failure_paused=state["strikes"] >= FAILURE_LIMIT,
                             retry_after=state["suppressed_until"])
    return candidates


def _utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _detail(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def failure_pause_notice(cur, rid):
    """Resolve a pause notice to its agent and pause instance from server records only.

    Only notify_failure writes the system audit row matched here, so notices sent before
    this link existed resolve the same way and request text is never parsed. The pause
    instance is the run_failure row that began before the notice was sent; a release
    deletes that row, so a later pause cannot be resumed through an earlier notice.
    state: paused (this notice's pause is active), resumed, or superseded (a newer pause).
    """
    cur.execute("SELECT container_id, requester_id, created_at FROM requests WHERE id=%s", (rid,))
    notice = cur.fetchone()
    if not notice:
        return None
    cur.execute(
        "SELECT detail FROM events WHERE entity_type='request' AND entity_id=%s "
        "AND event_type='created' AND actor_type='system'", (rid,),
    )
    aid = next((d.get("agent_id") for d in (_detail(row["detail"]) for row in cur.fetchall())
                if d.get("reason") == "run_failure_breaker"), None)
    if not aid or str(aid) != str(notice["requester_id"]):
        return None
    cur.execute("SELECT alias, container_id FROM agents WHERE id=%s", (aid,))
    agent = cur.fetchone()
    if not agent or str(agent["container_id"]) != str(notice["container_id"]):
        return None
    pause = failure_state(cur, aid)
    if pause is None or pause["strikes"] < FAILURE_LIMIT:
        state = "resumed"
    elif _utc(pause["first_strike_at"]) <= _utc(notice["created_at"]):
        state = "paused"
    else:
        state = "superseded"
    return {"agent_id": str(aid), "alias": agent["alias"], "container_id": str(notice["container_id"]),
            "state": state, "pause": pause}


def failure_pause_status(cur, aid):
    """What an answer or nudge must tell the human when the agent it would wake is
    failure-paused: the reply is saved, nothing starts, and where to resume."""
    pause = failure_state(cur, aid) if aid else None
    if pause is None or pause["strikes"] < FAILURE_LIMIT:
        return None
    cur.execute("SELECT alias, container_id FROM agents WHERE id=%s", (aid,))
    agent = cur.fetchone()
    nid = active_notice_ids(cur, str(agent["container_id"])).get(str(aid))
    where = "on its pause notice" if nid else "in Activity"
    return {
        "paused": True,
        "agent_id": str(aid),
        "notice_request_id": nid,
        "message": (f"Saved, but {agent['alias']}'s automatic work is still paused and it will not "
                    f"start. Choose Resume automatic work {where} when the cause is fixed."),
        "resume_path": f"/api/requests/{nid}/resume-automatic-work" if nid else None,
    }


def resume_from_notice(cur, rid, actor_id):
    """Clear only the pause this notice reported. Requests, events, acknowledgements,
    budgets, stop controls, other pacing rows and task state are left as they are."""
    notice = failure_pause_notice(cur, rid)
    if notice is None:
        return None
    # Serialize with record_run_outcome (SQLite already holds BEGIN IMMEDIATE), then re-read.
    cur.execute("SELECT id FROM agents WHERE id=%s" + sql.for_update(), (notice["agent_id"],))
    notice = failure_pause_notice(cur, rid)
    if notice["state"] != "paused":
        return {**notice, "resumed": False}
    # The agent lock is held and the instance was re-verified above.
    cur.execute(
        "DELETE FROM wake_backoff WHERE agent_id=%s AND wake_key=%s AND strikes >= %s RETURNING strikes",
        (notice["agent_id"], FAILURE_KEY, FAILURE_LIMIT),
    )
    deleted = cur.fetchone()
    if deleted:
        log_event(cur, notice["container_id"], "human", actor_id, "agent", notice["agent_id"],
                  "wake_backoff_released",
                  {"wake_key": FAILURE_KEY, "strikes_at_release": deleted["strikes"], "request_id": rid})
    return {**notice, "state": "resumed" if deleted else notice["state"], "resumed": deleted is not None}


def active_notice_ids(cur, cid):
    """agent_id -> the pause notice that can resume that agent's current pause."""
    cur.execute(
        "SELECT entity_id, detail FROM events WHERE container_id=%s AND entity_type='request' "
        "AND event_type='created' AND actor_type='system' ORDER BY created_at DESC", (cid,),
    )
    found = {}
    for row in cur.fetchall():
        if _detail(row["detail"]).get("reason") != "run_failure_breaker":
            continue
        notice = failure_pause_notice(cur, str(row["entity_id"]))
        if notice and notice["state"] == "paused":
            found.setdefault(notice["agent_id"], str(row["entity_id"]))
    return found
