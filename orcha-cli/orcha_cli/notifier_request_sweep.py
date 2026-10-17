"""Expired-request escalation hook — rides the notifier's existing wake tick (no new daemon).

An ask whose ``expires_at`` has passed while an AI agent still holds it must move up the
chain to a human automatically (EX-01). The escalation itself — org-chart routing, audit
events, SSE — lives server-side in ``POST /api/containers/{cid}/sweep``
(portal_backend/container_event_routes.py); before this hook only the hand-run
``/orcha-sweep`` skill ever called it, so expiry was display-only.

Once per ``SWEEP_EVERY_SECS`` per container this module pokes that endpoint on the
headerless daemon lane. The route needs a human ``actor_agent_id`` (it only validates the
kind; the escalation target is chosen independently by the org chart), so the actor is
the project's first owner, else its first live human, from ``GET /members``.

Never raises: an escalation hiccup must not stall agent wakes. Skipped in --dry-run.
"""
from __future__ import annotations

import sys
import time
from typing import Optional

SWEEP_EVERY_SECS = 60.0
_LAST_SWEEP: dict = {}


def _monotonic() -> float:
    return time.monotonic()


def _sweep_actor(api_base, container_id, services) -> Optional[str]:
    """Pick a human to stand as the sweep's actor: an owner first, else any live human."""
    listing = services._get_json(f"{api_base}/api/containers/{container_id}/members")
    members = (listing or {}).get("members") if isinstance(listing, dict) else None
    if not members:
        return None
    humans = [m for m in members if isinstance(m, dict) and m.get("agent_id")]
    for member in humans:
        if member.get("member_role") == "owner" and not member.get("pending"):
            return str(member["agent_id"])
    for member in humans:
        if member.get("member_role") != "viewer" and not member.get("pending"):
            return str(member["agent_id"])
    return str(humans[0]["agent_id"]) if humans else None


def maybe_sweep_expired(api_base, container_id, services, *, quiet=False, dry_run=False):
    """Escalate expired AI-held asks for one container, throttled; returns the reply or None."""
    if dry_run:
        return None
    now = _monotonic()
    last = _LAST_SWEEP.get(container_id)
    if last is not None and now - last < SWEEP_EVERY_SECS:
        return None
    _LAST_SWEEP[container_id] = now
    try:
        actor = _sweep_actor(api_base, container_id, services)
        if not actor:
            return None
        result = services._post_json(
            f"{api_base}/api/containers/{container_id}/sweep?actor_agent_id={actor}", {}
        )
    except Exception as error:  # noqa: BLE001 - never stall the wake tick
        if not quiet:
            print(f"[notifier] request sweep failed (continuing): {error}", file=sys.stderr)
        return None
    if not quiet and isinstance(result, dict) and result.get("escalated_count"):
        print(
            f"[notifier] escalated {result['escalated_count']} expired request(s) to a human: "
            + ", ".join(str(rid)[:8] for rid in result.get("request_ids") or [])
        )
    return result
