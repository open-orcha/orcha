"""Close accepted requests stranded by terminal task transitions."""

from portal_backend.agent_status import log_event
from portal_backend.events import publish_event as _publish_event


def backstop_stranded_request(cur, container_id, tid):
    """GH #56 (Point 5): the safety net that keeps a request loop from silently stranding. The
    PRIMARY close-the-loop path is the accepter reporting back by hand (the auto-injected Point 4.4
    report-back note tells it to). This net only catches the case where the accepter's spawned task
    reaches a terminal state (needs_verification / completed) while its originating request is STILL
    'accepted' — i.e. the agent finished but never reported back. We auto-answer the request so the
    requester wakes on its originating_task_id and reads the result anyway.

    DESIGN INTENT (kedar): this should RARELY fire. We log_event an `auto_answered` audit row each
    time it does, with backstop=true on the wake event, so a leaking primary path is observable
    (count the backstop fires vs total answers). A reviewer can grep for it.

    Returns the list of request ids it auto-answered (usually empty)."""
    cur.execute(
        """SELECT id, requester_id, originating_task_id, type FROM requests
           WHERE spawned_task_id=%s AND status='accepted' FOR UPDATE""",
        (tid,),
    )
    stranded = cur.fetchall()
    fired = []
    for req in stranded:
        rid = str(req["id"])
        note = (
            f"[auto-answered by the #56 backstop] the accepter's task {tid} reached a terminal "
            f"state without an explicit report-back. See that task for the result/output."
        )
        cur.execute(
            "UPDATE requests SET status='answered', response=%s, responded_at=now() WHERE id=%s",
            (note, rid),
        )
        _publish_event(
            cur,
            str(container_id),
            str(req["requester_id"]),
            "request_answered",
            {
                "request_id": rid,
                "preview": note[:120],
                "originating_task_id": (
                    str(req["originating_task_id"])
                    if req["originating_task_id"]
                    else None
                ),
                "backstop": True,
            },
        )
        log_event(
            cur,
            container_id,
            "system",
            None,
            "request",
            rid,
            "auto_answered",
            {
                "reason": "backstop: accepter task reached terminal state while request "
                "still 'accepted' (no report-back)",
                "task_id": str(tid),
            },
        )
        fired.append(rid)
    return fired
