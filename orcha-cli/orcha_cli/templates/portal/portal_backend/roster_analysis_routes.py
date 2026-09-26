"""HOST-side roster analysis (Orcha Cloud local run, docs/orcha-cloud-local-run.md):
storage + serving for a RICHER project analysis than roster_suggest_routes.py's fast
workspace scan produces. That endpoint derives a roster from file presence alone
(os.scandir, <500ms, no model call); THIS endpoint is where the desktop app stores
the result AFTER it spawns the user's local `claude` CLI host-side to actually read
the project and produce a project summary + recommended agents with rationale. The
portal never runs the analysis itself — it only stores/serves whatever the host-side
analyzer PUTs, one row per container (upsert; latest analysis wins, no history).

Two routes:
  PUT .../roster/analysis  — store (upsert) the analysis. Human-gated exactly like
                              roster/suggest/accept (trusted_actor + enforce_grant
                              ("manage_agents")): this is agent-roster planning data,
                              same authority tier as actually creating the agents.
  GET .../roster/analysis  — member-read gated; honest {available: false} shape when
                              no analysis has been stored yet (never a 404 — "nothing
                              stored" is a normal, expected state for a project that
                              hasn't run the desktop analyzer).
"""

import json

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container as _require_container
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.identity_routes import enforce_grant as _enforce_grant
from portal_backend.identity_routes import require_member_read as _require_member_read
from portal_backend.identity_routes import trusted_actor as _trusted_actor

SUMMARY_MAX_CHARS = 4000
MAX_SUGGESTIONS = 8


class RosterAnalysisSuggestion(BaseModel):
    alias: str = Field(..., max_length=64)
    role: str = Field(..., max_length=200)
    focus: str = Field(..., max_length=1000)
    is_main: "bool | None" = None
    rationale: "str | None" = Field(default=None, max_length=1000)


class RosterAnalysisPut(BaseModel):
    summary: str = Field(..., max_length=SUMMARY_MAX_CHARS)
    suggestions: list[RosterAnalysisSuggestion] = Field(
        ..., min_length=1, max_length=MAX_SUGGESTIONS
    )
    source: str = Field(..., max_length=100)
    model: "str | None" = Field(default=None, max_length=200)
    actor_agent_id: "str | None" = Field(
        default=None,
        description="acting human's UUID when no trusted proxy identity is present",
    )


@app.put("/api/containers/{cid}/roster/analysis", status_code=200)
def put_roster_analysis(cid: str, body: RosterAnalysisPut, request: Request):
    """Store (upsert) a host-produced roster analysis. HUMAN-AUTHORITY gated — same
    tier as accepting roster suggestions into real agents (roster_suggest_routes.
    accept_roster_suggestions): this data will drive agent-roster decisions, so it
    gets the same trusted_actor + enforce_grant('manage_agents') gate, not a lighter
    one. A second PUT overwrites the prior analysis wholesale (no history kept —
    see the migration's docstring)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        body.actor_agent_id = _trusted_actor(cur, request, cid, body.actor_agent_id)
        _enforce_grant(cur, request, cid, "manage_agents")

        suggestions_payload = [s.model_dump() for s in body.suggestions]
        cur.execute(
            """INSERT INTO roster_analysis
                   (container_id, summary, suggestions, source, model, created_at, updated_at)
               VALUES (%s, %s, %s::jsonb, %s, %s, now(), now())
               ON CONFLICT (container_id) DO UPDATE SET
                   summary=EXCLUDED.summary,
                   suggestions=EXCLUDED.suggestions,
                   source=EXCLUDED.source,
                   model=EXCLUDED.model,
                   updated_at=now()
               RETURNING updated_at""",
            (cid, body.summary, json.dumps(suggestions_payload), body.source, body.model),
        )
        updated_at = cur.fetchone()["updated_at"]
        conn.commit()
    return {"stored": True, "updated_at": updated_at}


@app.get("/api/containers/{cid}/roster/analysis", status_code=200)
def get_roster_analysis(cid: str, request: Request):
    """The stored roster analysis for this container, or an honest
    {"available": False} when none has been stored yet — never a 404: "no analysis
    yet" is the normal state before the desktop analyzer has run, not an error."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        _require_member_read(cur, request, cid)
        cur.execute(
            """SELECT summary, suggestions, source, model, updated_at
               FROM roster_analysis WHERE container_id=%s""",
            (cid,),
        )
        row = cur.fetchone()
    if not row:
        return {"available": False}
    return {
        "available": True,
        "summary": row["summary"],
        "suggestions": row["suggestions"],
        "source": row["source"],
        "model": row["model"],
        "updated_at": row["updated_at"],
    }
