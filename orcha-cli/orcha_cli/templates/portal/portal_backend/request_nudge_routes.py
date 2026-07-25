"""Nudge request owners with full task context when action is overdue."""

from fastapi import HTTPException

from portal_backend.agent_status import bump_agent, log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import poke_path_forward as _poke_path_forward
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    require_container_active as _require_container_active,
    require_kind as _require_kind,
    valid_uuid as _valid_uuid,
)
from portal_backend.request_lookup import require_request
from portal_backend.schemas.requests import NudgeBody


def _task_request_context_block(detail) -> str:
    """#60: render a TASK request's ask — title / description / definition of done / protocol —
    into a nudge poke. A task request stores its ask in the JSONB `detail` column (see
    create_request); the only event that ever carried it (`request_created`) is consumed once
    the recipient drains its inbox. So an agent woken later by a context-less poke could not see
    what the task even is — it could not meaningfully accept or reject. This re-delivers the full
    ask verbatim in the wake prompt itself. Returns "" when there's nothing to show."""
    if not isinstance(detail, dict) or not detail:
        return ""
    lines = []
    title = (detail.get("title") or "").strip()
    if title:
        lines.append(f"Task: {title}")
    desc = (detail.get("description") or "").strip()
    if desc:
        lines.append(f"What's being asked: {desc}")
    dod = (detail.get("definition_of_done") or "").strip()
    if dod:
        lines.append(f"Definition of done: {dod}")
    proto = detail.get("protocol")
    if isinstance(proto, dict):
        proto_bits = []
        for key in ("review_chain", "handoff_to", "autonomy", "notes"):
            val = proto.get(key)
            val = val.strip() if isinstance(val, str) else val
            if val:
                proto_bits.append(f"{key.replace('_', ' ')}: {val}")
        if proto_bits:
            lines.append("Protocol — " + "; ".join(proto_bits))
    return ("\n\n" + "\n".join(lines)) if lines else ""


@app.post("/api/requests/{rid}/nudge", status_code=200)
def nudge_request(rid: str, body: NudgeBody):
    """#60: a STANDALONE wake-up for whoever owns the NEXT ACTION on a request — fully
    DECOUPLED from close. It NEVER changes the request's state (the handler does a SELECT
    only, never an UPDATE), so state invariance holds on every branch. The recipient is
    state-routed:
      • open      → the TARGET (they still owe the answer)
      • answered  → the REQUESTER (they must act on the answer or close it)
    Accepted (now a task — nudge the task, not the request) and the terminal states
    (rejected / converted_to_task / closed) are not actionable here → 409, no poke. Routing
    is total over the request status enum.

    Task-aware: for a type='task' request the poke is shaped to the actual next action — an OPEN
    task request directs the TARGET to accept/reject (not answer) and re-delivers the full task ask
    (title / description / definition of done / protocol) from the JSONB detail, since the original
    request_created event is consumed on first drain and an info-style "respond" prompt would be
    both the wrong verb and missing the context the agent needs to decide.

    Human-only (an operator wake action; the portal viewer is always human, the CLI resolves
    the acting human → else 403). When the routed recipient is a human (e.g. an escalated-to-
    human request, where the next action genuinely sits with a person) or the actor themselves,
    there's no agent to wake via a poke → 200 {nudged:false} as a clean no-op (no error, no
    state change). Delivery reuses the A3 `prompt` poke (`_poke_path_forward`): a directed
    prompt is surfaced verbatim into the recipient's wake/drain turn AND counts as pending work
    in wake-scan, so the agent re-engages."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.actor_agent_id):
        raise HTTPException(400, "actor_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = require_request(
            cur, rid
        )  # SELECT-only (no FOR UPDATE): a nudge never mutates the request
        _require_container_active(cur, str(r["container_id"]), body.actor_agent_id)
        # Human-only: a nudge is an operator wake action.
        cur.execute(
            "SELECT kind, alias FROM agents WHERE id=%s", (body.actor_agent_id,)
        )
        arow = cur.fetchone()
        if not arow:
            raise HTTPException(404, f"agent {body.actor_agent_id} not found")
        if arow["kind"] != "human":
            raise HTTPException(403, "only a human may nudge a request")
        actor_alias = arow["alias"] or "a human"
        status = r["status"]
        # State routing — total over REQUEST_STATUSES.
        if status == "open":
            recipient_id, role = r["target_id"], "target"
        elif status == "answered":
            recipient_id, role = r["requester_id"], "requester"
        elif status == "accepted":
            # The next action moved from the request to the spawned task — nudge the task.
            raise HTTPException(
                409,
                "this request was accepted and became a task — "
                "nudge the task, not the request",
            )
        else:  # rejected, converted_to_task, closed — terminal, nothing to nudge
            raise HTTPException(409, f"nothing to nudge: request is '{status}'")
        # No distinct AI to wake: the next action sits with a human (escalated-to-human, a
        # human target/requester, or a null target) or with the nudger themselves → clean no-op.
        recipient_id = str(recipient_id) if recipient_id else None
        recipient_is_human = False
        if recipient_id:
            cur.execute("SELECT kind FROM agents WHERE id=%s", (recipient_id,))
            rrow = cur.fetchone()
            recipient_is_human = bool(rrow) and rrow["kind"] == "human"
        if (
            not recipient_id
            or recipient_is_human
            or recipient_id == body.actor_agent_id
        ):
            return {
                "request_id": rid,
                "status": status,
                "nudged": False,
                "nudged_role": role,
                "nudged_agent_id": None,
                "reason": "a human owns the next action — nothing to wake",
            }
        # Wake-framed, state-appropriate directed prompt naming the nudger + rid8 + a 1-line preview.
        # Task-aware: an OPEN *task* request is accepted/rejected (NOT answered), and the poke carries
        # the full task ask (title / description / definition of done / protocol) so the woken agent
        # can decide even though the original request_created event was consumed on first drain.
        short_rid = rid[:8]
        is_task = r["type"] == "task"
        payload_preview = (str(r["payload"] or "").strip().splitlines() or [""])[0][
            :120
        ]
        if role == "target":
            if is_task:
                message = (
                    f"{actor_alias} nudged you about an OPEN task request you have not picked up "
                    f"yet. Request {short_rid}. Please accept it (/orcha-accept-task) or reject it "
                    f"(/orcha-reject-task)." + _task_request_context_block(r["detail"])
                )
            else:
                message = (
                    f"{actor_alias} nudged you about an OPEN request you still owe an answer on. "
                    f'Request {short_rid}: "{payload_preview}". Please respond to it (/orcha-respond).'
                )
        else:  # requester, on an answered request
            if is_task:
                detail = r["detail"] if isinstance(r["detail"], dict) else {}
                title = (detail.get("title") or "").strip()
                what = f' ("{title[:120]}")' if title else ""
                message = (
                    f"{actor_alias} nudged you: a task request you sent{what} has been ANSWERED "
                    f"and is waiting on you to act on the result or close it (/orcha-close). "
                    f"Request {short_rid}."
                )
            else:
                message = (
                    f"{actor_alias} nudged you: a request you sent has been ANSWERED and is waiting "
                    f"on you to act on the answer or close it. "
                    f'Request {short_rid}: "{payload_preview}".'
                )
        note = (body.note or "").strip()
        if note:
            message += f" Note from {actor_alias}: {note}"
        _poke_path_forward(
            cur, str(r["container_id"]), recipient_id, body.actor_agent_id, message
        )
        # Audit only — NO status UPDATE, NO turn bump (an external poke, like triage-close).
        log_event(
            cur,
            r["container_id"],
            "human",
            body.actor_agent_id,
            "request",
            rid,
            "nudged",
            {"by_human": True, "role": role},
        )
        conn.commit()
    return {
        "request_id": rid,
        "status": status,
        "nudged": True,
        "nudged_role": role,
        "nudged_agent_id": recipient_id,
    }
