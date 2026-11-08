"""What the map and the atlas read and write beside `C/map` and `C/atlas` (qa_routes):

  GET  C/perf?days=&platform=     screen timings from the recorded steps (Slowest screens, Speed)
  GET  C/perf/settings            speed budgets and thresholds (members read)
  PUT  C/perf/settings            change them (a person)
  POST C/map/builds               a build has started: the map shows it while the code is read
  PUT  /api/qa/sessions/{sid}/crawl-queue   a planned crawl's queue as `crawl_next` moves it
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field

from portal_backend import qa_map, qa_perf, qa_store as qs
from portal_backend.application import app
from portal_backend.database import db_cursor


class ActorBody(BaseModel):
    actor_agent_id: Optional[str] = None


class CrawlQueueBody(ActorBody):
    queue: dict


class BuildStartBody(ActorBody):
    platform: Literal["ios", "android", "web"]
    source: Literal["code"] = "code"


class PerfSettingsBody(ActorBody):
    change: dict = Field(default_factory=dict)


@app.get("/api/containers/{cid}/qa/perf")
def get_qa_perf(cid: str, request: Request, days: int = Query(default=30, ge=1, le=365), platform: Optional[str] = Query(default=None)):
    if platform is not None:
        qs.require_platform(platform)
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return qa_perf.read_perf(cur, cid, days, platform)


@app.get("/api/containers/{cid}/qa/perf/settings")
def get_qa_perf_settings(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return qa_perf.read_settings(cur, cid)


@app.put("/api/containers/{cid}/qa/perf/settings")
def put_qa_perf_settings(cid: str, body: PerfSettingsBody, request: Request):
    change, why = qa_perf.validate(body.change)
    if change is None:
        raise HTTPException(400, why)
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "change the speed budgets")
        out = qa_perf.write_settings(cur, cid, who, change)
        conn.commit()
    return out


@app.post("/api/containers/{cid}/qa/map/builds", status_code=201)
def start_qa_map_build(cid: str, body: BuildStartBody, request: Request):
    """A running build row; `POST map/import` for that source ends it. Agents and people both."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        bid = qa_map.start_build(cur, cid, body.platform, body.source, who["id"])
        conn.commit()
    return {"build_id": bid}


@app.put("/api/qa/sessions/{sid}/crawl-queue")
def put_qa_crawl_queue(sid: str, body: CrawlQueueBody, request: Request):
    """The queue as the tool server holds it, replaced whole on every move. A session that ended
    keeps the queue it had."""
    with db_cursor() as (conn, cur):
        s = qs.load_session(cur, sid)
        qs.container_read(cur, request, str(s["container_id"]))
        qs.actor(cur, request, str(s["container_id"]), body.actor_agent_id)
        if s["status"] != "running":
            raise HTTPException(409, f"this QA session already ended ({s['status']})")
        cur.execute("UPDATE qa_sessions SET crawl_queue=%s, last_seen_at=%s WHERE id=%s", (qs.dumps(body.queue), qs.now(), sid))
        conn.commit()
    return {"ok": True}
