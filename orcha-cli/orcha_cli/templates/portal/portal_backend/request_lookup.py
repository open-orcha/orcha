"""Load request rows with optional transaction locking."""

from fastapi import HTTPException


def require_request(cur, rid, for_update=False):
    # for_update locks the request row for the rest of the transaction. State-mutating
    # endpoints (respond/close/accept-task) MUST pass it: without the lock, two
    # overlapping at-least-once retries both read status='open' under READ COMMITTED
    # and both mutate — accept-task would spawn TWO tasks, respond would overwrite the
    # first answer. With FOR UPDATE the loser blocks until the winner commits, then
    # re-reads the committed terminal state and takes the idempotent branch.
    cur.execute(
        """SELECT id, container_id, type, status, requester_id, target_id,
                  payload, response, expires_at, parent_request_id, chain_depth,
                  detail, spawned_task_id, rejection_reason, originating_task_id
           FROM requests WHERE id=%s"""
        + (" FOR UPDATE" if for_update else ""),
        (rid,),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, f"request {rid} not found")
    return r
