"""Persistent, per-agent retry protection, accounted once at run completion.

The reserved wake_backoff key is independent of changing trigger names. Three failed
automatic work runs open the circuit until a human uses the existing release endpoint.
No task state, event acknowledgements, or live processes are changed by this module.
"""

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
        "Fix the cause, then open Activity and choose Resume automatic work. Pending work is saved."
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
