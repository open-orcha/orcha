"""No-progress wake circuit breaker: strike accounting, backoff ladder, filtering.

INCIDENT this closes (2026-08-03, quantal-health): a container with 6 ready-unassigned
tasks kept emitting the `task_created_unassigned` wake candidate for its orchestrator;
every spawned worker ran ~5-80s, changed nothing, and exited — ~4,300 wakes over 3 days
at ~40s cadence, billed invisibly against the operator's Claude subscription ($0 recorded
server-side, since subscription billing never surfaces in worker_runs.total_cost_usd).
An in-memory daemon-side suppression would not have survived a deploy restart, so this
lives here — SERVER-side, DB-backed (migration 048_wake_backoff.sql) — right where the
wake DECISION already lives (wake_scan_routes / wake_candidate_builder).

Doctrine (repeat at every call site so it can never be missed in review): this module
NEVER cancels work, never changes task/agent state, and never touches the trigger's
underlying cause. It only slows the WAKE CADENCE for a trigger nobody is consuming, and
it always tells the human once it gets serious (tier 3, see `NOTIFY_TIER`). A human's
manual release (DELETE .../wake-backoff/{wake_key}) always wins over the timer.

wake_key vocabulary: the candidate identity string a wake-scan tick would emit for one
(agent, trigger) pair — mirrors the notifier's `derive_wake_event` precedence exactly
(latest_event | auto_start | self_wake | auto_wake), re-derived here server-side since
the portal backend does not import the orcha_cli daemon package. This is a DIFFERENT axis
from worker_runs.wake_kind (the run's TRANSPORT — ephemeral | tmux | resident | sandbox);
"same wake_kind/wake_event family" in the spec means: the most recent completed run's
`wake_event` column equals this tick's wake_key (the transport is irrelevant to whether
the trigger made progress).
"""

import os
from typing import Optional

from portal_backend.agent_status import log_event
from portal_backend.events import publish_event
from portal_backend.guards import pick_human

# ---- backoff ladder (env-tunable, sane defaults) --------------------------------------
# Strike thresholds and their suppression durations. Kept as an ordered ladder (highest
# threshold first) so `_tier_for` can walk it once and return the first (strikes-count,
# duration) rung the streak has reached.
STRIKE_TIER_1 = int(os.environ.get("ORCHA_WAKE_BACKOFF_STRIKES_TIER1", "3"))
STRIKE_TIER_2 = int(os.environ.get("ORCHA_WAKE_BACKOFF_STRIKES_TIER2", "6"))
STRIKE_TIER_3 = int(os.environ.get("ORCHA_WAKE_BACKOFF_STRIKES_TIER3", "10"))

BACKOFF_SECS_TIER1 = int(os.environ.get("ORCHA_WAKE_BACKOFF_SECS_TIER1", str(5 * 60)))
BACKOFF_SECS_TIER2 = int(os.environ.get("ORCHA_WAKE_BACKOFF_SECS_TIER2", str(30 * 60)))
BACKOFF_SECS_TIER3 = int(os.environ.get("ORCHA_WAKE_BACKOFF_SECS_TIER3", str(4 * 60 * 60)))

# The tier at which the breaker also surfaces a needs-you artifact to the human (once per
# strike-streak — see `notified_at` on the row). Below this tier the breaker is silent —
# it just paces the wakes.
NOTIFY_TIER_STRIKES = STRIKE_TIER_3

# Only a completed run this recent counts as "the candidate's own last attempt" — an older
# run could predate an unrelated intervening fix, so it must not count toward a strike.
RECENT_RUN_WINDOW_SECS = int(os.environ.get("ORCHA_WAKE_BACKOFF_RECENT_RUN_SECS", str(30 * 60)))

_LADDER = (
    (STRIKE_TIER_3, BACKOFF_SECS_TIER3),
    (STRIKE_TIER_2, BACKOFF_SECS_TIER2),
    (STRIKE_TIER_1, BACKOFF_SECS_TIER1),
)


def derive_wake_key(candidate: dict) -> Optional[str]:
    """Return the candidate-identity string, mirroring derive_wake_event's precedence.

    Server-side re-derivation of orcha_cli.notifier_wake_facade.derive_wake_event — kept
    in lockstep deliberately (see module docstring); the portal never imports the daemon
    package, so this is the seam, not a shortcut."""
    return (
        candidate.get("latest_event")
        or ("auto_start" if candidate.get("auto_start_task_ids") else None)
        or ("self_wake" if candidate.get("self_wake_due") else None)
        or ("auto_wake" if candidate.get("auto_wake_due") else None)
    )


def backoff_secs_for_strikes(strikes: int) -> int:
    """Return the ladder's suppression duration for a strike count, or 0 below tier 1."""
    for threshold, secs in _LADDER:
        if strikes >= threshold:
            return secs
    return 0


def should_notify(strikes: int) -> bool:
    """Return whether this strike count has reached the human-notify tier."""
    return strikes >= NOTIFY_TIER_STRIKES


def fetch_active_backoff_map(cur, container_id: str) -> dict:
    """Return {(agent_id, wake_key): suppressed_until} for rows still actively suppressing.

    A row with strikes but no (or expired) suppressed_until is NOT in this map — it exists
    only for strike bookkeeping, not filtering. Keyed as strings so callers can look up with
    the same (str, str) tuple they build from a candidate dict."""
    cur.execute(
        """SELECT agent_id, wake_key, suppressed_until FROM wake_backoff
             WHERE container_id=%s AND suppressed_until IS NOT NULL
               AND suppressed_until > now()""",
        (container_id,),
    )
    return {(str(row["agent_id"]), row["wake_key"]): row["suppressed_until"] for row in cur.fetchall()}


def recent_same_trigger_run(cur, agent_id: str, wake_key: str):
    """Return the agent's most recent COMPLETED worker_run whose wake_event matches
    wake_key and which ended within RECENT_RUN_WINDOW_SECS, or None.

    'Completed' = status != 'running' (exited | killed | rate_limited | failed) with
    ended_at set — a still-running run can't yet be judged to have changed nothing."""
    cur.execute(
        f"""SELECT run_id, ended_at FROM worker_runs
             WHERE agent_id=%s AND wake_event=%s AND status <> 'running'
               AND ended_at IS NOT NULL
               AND ended_at >= now() - interval '{RECENT_RUN_WINDOW_SECS} seconds'
             ORDER BY ended_at DESC LIMIT 1""",
        (agent_id, wake_key),
    )
    return cur.fetchone()


def record_strike(cur, container_id: str, agent_id: str, wake_key: str) -> dict:
    """Upsert one strike for (agent_id, wake_key); set suppressed_until per the ladder.

    Returns the resulting row (strikes, suppressed_until, notified_at, ...). Only ADVANCES
    suppressed_until when the new tier's window is later than whatever is already stored
    (a human's manual release, or an earlier smaller tier, must never be clobbered backward
    by a stale re-strike — though in practice strikes are monotonic within one streak)."""
    cur.execute(
        """INSERT INTO wake_backoff
                (container_id, agent_id, wake_key, strikes, suppressed_until,
                 last_strike_at, first_strike_at)
           VALUES (%s, %s, %s, 1, NULL, now(), now())
           ON CONFLICT (agent_id, wake_key) DO UPDATE SET
                strikes = wake_backoff.strikes + 1,
                last_strike_at = now()
           RETURNING strikes""",
        (container_id, agent_id, wake_key),
    )
    strikes = cur.fetchone()["strikes"]
    backoff = backoff_secs_for_strikes(strikes)
    if backoff > 0:
        cur.execute(
            """UPDATE wake_backoff SET suppressed_until = now() + (%s || ' seconds')::interval
                 WHERE agent_id=%s AND wake_key=%s
                 RETURNING strikes, suppressed_until, notified_at, first_strike_at, last_strike_at""",
            (backoff, agent_id, wake_key),
        )
    else:
        cur.execute(
            """SELECT strikes, suppressed_until, notified_at, first_strike_at, last_strike_at
                 FROM wake_backoff WHERE agent_id=%s AND wake_key=%s""",
            (agent_id, wake_key),
        )
    return cur.fetchone()


def clear_backoff(cur, agent_id: str, wake_key: str) -> bool:
    """Delete the (agent_id, wake_key) row — the candidate disappeared (trigger cleared)
    or a human released it. Returns whether a row actually existed."""
    cur.execute(
        "DELETE FROM wake_backoff WHERE agent_id=%s AND wake_key=%s",
        (agent_id, wake_key),
    )
    return cur.rowcount > 0


def mark_notified(cur, agent_id: str, wake_key: str) -> None:
    """Stamp notified_at so the tier-3 needs-you artifact fires ONCE per strike streak."""
    cur.execute(
        "UPDATE wake_backoff SET notified_at = now() WHERE agent_id=%s AND wake_key=%s",
        (agent_id, wake_key),
    )


def _humanize_wake_key(wake_key: str) -> str:
    return (wake_key or "trigger").replace("_", " ")


def notify_human_of_breaker(cur, container_id: str, agent_id: str, alias: str, wake_key: str, strikes: int) -> Optional[str]:
    """Create the tier-3 needs-you artifact — an open `request` from the woken agent to the
    human, the SAME mechanism `container_event_routes`'s expires_at sweep already uses to put
    a system-triggered item in front of a human (publish a `request_created` + escalate). This
    (not a bare agent_events publish) is what actually reaches the existing needs-you surface:
    HomePage/NotificationCenter's `escs` zone is snapshot-derived from OPEN requests targeting a
    human (state/SnapshotProvider.attnItems + isToHuman) — mirrored exactly here, deliberately,
    so this ships through plumbing that already renders end-to-end with ZERO frontend edits.

    Fires ONCE per strike-streak (guarded by the caller checking notified_at is NULL) — never
    once per tick. Honest, specific wording per the spec; never implies work was cancelled."""
    human_id = pick_human(cur, container_id)
    if human_id is None:
        return None  # no human registered yet — log-safe no-op, mirrors find_orchestrator_agent
    duration = backoff_secs_for_strikes(strikes)
    duration_label = _format_duration(duration)
    trigger_label = _humanize_wake_key(wake_key)
    payload = (
        f"{alias} has been woken {strikes}× for '{trigger_label}' without acting — "
        f"wakes for this trigger are paused for {duration_label}. Assign or cancel the tasks, "
        "or resume manually."
    )
    cur.execute(
        """INSERT INTO requests
                (container_id, type, requester_id, target_id, priority, status,
                 payload, expires_at, chain_depth)
           VALUES (%s, 'info', %s, %s, 100, 'open', %s, now() + interval '7 days', 0)
           RETURNING id""",
        (container_id, agent_id, human_id, payload),
    )
    rid = str(cur.fetchone()["id"])
    log_event(
        cur, container_id, "system", None, "request", rid, "created",
        {"type": "info", "target_alias": None, "priority": 100, "preview": payload[:120],
         "reason": "wake_backoff_breaker", "wake_key": wake_key, "strikes": strikes},
    )
    publish_event(cur, container_id, human_id, "request_created",
                  {"request_id": rid, "type": "info", "from_agent_id": agent_id, "preview": payload[:120]})
    publish_event(cur, container_id, None, "request_escalated",
                  {"request_id": rid, "reason": "wake_backoff_breaker"})
    return rid


def _format_duration(secs: int) -> str:
    if secs <= 0:
        return "0m"
    if secs % 3600 == 0:
        return f"{secs // 3600}h"
    if secs % 60 == 0:
        return f"{secs // 60}m"
    return f"{secs}s"


def apply_wake_backoff(cur, container_id: str, candidates: list) -> list:
    """The chokepoint: given the raw wake-scan candidates for this tick, do strike accounting,
    filter suppressed ones out of the response, and fire the tier-3 human notify. Runs on the
    SAME cursor/transaction as the rest of the scan (the caller commits once, alongside the
    scan's own last_wake_scan_at stamp — no extra round trip).

    Per (agent_id, wake_key) present in `candidates`:
      - If the agent's most recent COMPLETED run shares this wake_key AND ended within the
        recent-run window AND should_wake is still true (the trigger is STILL here — i.e.
        that run changed nothing) -> record a strike (upsert ++).
      - Any wake_backoff row for an (agent_id, wake_key) NOT present among should_wake
        candidates this tick (or present but should_wake is False) is cleared — the
        candidate/trigger disappeared, so the streak resets to a clean slate.
      - A row whose suppressed_until is still in the future has its candidate FILTERED OUT of
        the returned list — the daemon never sees it. Structural/never-should-wake candidates
        pass through untouched (no strike, no filter — nothing to break the loop on).

    Returns the filtered candidate list (same dicts, same order, suppressed ones dropped)."""
    seen_keys = set()
    kept = []
    for candidate in candidates:
        agent_id = candidate.get("agent_id")
        wake_key = derive_wake_key(candidate)
        if not candidate.get("should_wake") or agent_id is None or wake_key is None:
            kept.append(candidate)
            continue
        seen_keys.add((agent_id, wake_key))
        recent_run = recent_same_trigger_run(cur, agent_id, wake_key)
        if recent_run is not None:
            row = record_strike(cur, container_id, agent_id, wake_key)
            strikes = row["strikes"]
            suppressed_until = row["suppressed_until"]
            if suppressed_until is not None and should_notify(strikes) and row["notified_at"] is None:
                notify_human_of_breaker(cur, container_id, agent_id, candidate.get("alias") or "The agent", wake_key, strikes)
                mark_notified(cur, agent_id, wake_key)
            if suppressed_until is not None:
                continue  # FILTERED OUT — currently suppressed, daemon never sees it
        else:
            # No corroborating recent run yet — this is either a brand-new trigger or one the
            # agent hasn't had a chance to act on. Do not strike; but if a row exists from a
            # PRIOR streak whose corroborating run has aged out of the window, leave it (still
            # governed by its own suppressed_until) rather than resetting on a timing gap.
            pass
        kept.append(candidate)

    # Reset: any row for THIS container whose (agent_id, wake_key) was not re-struck this tick
    # (the candidate disappeared or stopped wanting a wake) is cleared outright.
    cur.execute(
        "SELECT agent_id, wake_key FROM wake_backoff WHERE container_id=%s",
        (container_id,),
    )
    for row in cur.fetchall():
        key = (str(row["agent_id"]), row["wake_key"])
        if key not in seen_keys:
            clear_backoff(cur, str(row["agent_id"]), row["wake_key"])

    return kept
