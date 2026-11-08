"""What the QA onboarding reads beside its row (qa_routes keeps `C/onboarding` itself):

  GET C/devices                          booted simulators and attached Android devices (members read)
  GET /api/qa/sessions/{sid}/steps/latest   the newest steps, newest first, for the live panel

Reads only: no route here boots, creates or claims a device.
"""

from __future__ import annotations

from fastapi import Query, Request

from portal_backend import qa_onboarding, qa_store as qs
from portal_backend.application import app
from portal_backend.database import db_cursor


@app.get("/api/containers/{cid}/qa/devices")
def get_qa_devices(cid: str, request: Request, all: bool = False):
    """`{devices, available}`: what a QA session on this machine could use now; with `all`, every
    device the picker offers: paired phones with what each needs, stopped simulators and emulators.
    `available` is false on a portal that cannot see the machine's devices."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
    return qa_onboarding.devices(everything=all)


@app.get("/api/qa/sessions/{sid}/steps/latest")
def latest_qa_steps(sid: str, request: Request, limit: int = Query(default=8, ge=1, le=50)):
    """The session's newest steps, newest first. `GET .../steps` reads from the start of the
    session, so a long one would never show its current screen."""
    with db_cursor(readonly=True) as (_, cur):
        s = qs.load_session(cur, sid)
        qs.container_read(cur, request, str(s["container_id"]))
        cur.execute("SELECT * FROM qa_steps WHERE session_id=%s ORDER BY seq DESC LIMIT %s", (sid, limit))
        return {"steps": [qs.public(r) for r in cur.fetchall()]}
