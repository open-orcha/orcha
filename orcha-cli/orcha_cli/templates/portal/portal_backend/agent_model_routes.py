"""Routes for agent model and reasoning-effort selection."""

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent as _require_agent
from portal_backend.identity_routes import enforce_grant as _enforce_grant
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.schemas.agent_state import (
    AgentModelUpdate,
    AgentReasoningEffortUpdate,
)


def _model_ids():
    return set()


def _reasoning_effort_ids():
    return set()


def _reasoning_effort_ids_by_model():
    return {}


def configure_catalogs(
    model_ids, reasoning_effort_ids, reasoning_effort_ids_by_model
):
    """Supply facade-owned catalog getters for compatibility monkeypatches."""
    global _model_ids, _reasoning_effort_ids, _reasoning_effort_ids_by_model
    _model_ids = model_ids
    _reasoning_effort_ids = reasoning_effort_ids
    _reasoning_effort_ids_by_model = reasoning_effort_ids_by_model


@app.post("/api/agents/{aid}/model", status_code=200)
def set_agent_model(aid: str, body: AgentModelUpdate, request: Request):
    """B8.1: update the LLM model an agent runs on. Persists agents.model (set at
    registration in D7) and flows through the D7 read payload (agent.model). The model
    must be a curated id (AVAILABLE_MODELS) — kept curated per kedar; new providers
    are added there as supported. Humans carry no model (400). Spawning the worker
    WITH this model (--model) is Forge's B8.2, separate from this persistence."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if body.model not in _model_ids():
        raise HTTPException(
            400,
            f"model '{body.model}' is not a known model; "
            f"choose one of {sorted(_model_ids())}",
        )
    with db_cursor() as (conn, cur):
        agent = _require_agent(cur, aid)
        # Per-project identity: a model swap is a member action (403 non-member).
        _trusted_actor(cur, request, str(agent["container_id"]), None)
        # Access model: model/effort swaps are owner-or-manage_agents.
        _enforce_grant(cur, request, str(agent["container_id"]), "manage_agents")
        cur.execute("SELECT kind, model, reasoning_effort FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
        if row["kind"] == "human":
            raise HTTPException(400, "humans carry no model")
        old_model = row["model"]
        old_effort = row["reasoning_effort"]
        supported_efforts = _reasoning_effort_ids_by_model().get(body.model, set())
        new_effort = old_effort if old_effort in supported_efforts else None
        cur.execute(
            "UPDATE agents SET model=%s, reasoning_effort=%s WHERE id=%s RETURNING model",
            (body.model, new_effort, aid),
        )
        new_model = cur.fetchone()["model"]
        cold_reset = []
        if new_model != old_model:
            cur.execute(
                "UPDATE conversations SET session_id=NULL "
                "WHERE agent_id=%s AND status='active' AND session_id IS NOT NULL "
                "RETURNING id",
                (aid,),
            )
            cold_reset = [str(conversation["id"]) for conversation in cur.fetchall()]
        log_event(
            cur,
            agent["container_id"],
            "human",
            None,
            "agent",
            aid,
            "model_changed",
            {
                "model": new_model,
                "previous_model": old_model,
                "reasoning_effort": new_effort,
                "previous_reasoning_effort": old_effort,
                "cold_reset_conversations": cold_reset,
            },
        )
        conn.commit()
    return {
        "agent_id": aid,
        "model": new_model,
        "reasoning_effort": new_effort,
        "cold_reset_conversations": cold_reset,
    }


@app.post("/api/agents/{aid}/reasoning-effort", status_code=200)
def set_agent_reasoning_effort(aid: str, body: AgentReasoningEffortUpdate, request: Request):
    """GH #51: set the reasoning effort an agent's worker spawns at. Persists
    agents.reasoning_effort and flows through the read payload + wake-scan candidate, where the
    daemon passes it to the worker (`claude --effort <level>`, or Codex model_reasoning_effort).
    Must be supported by the agent's selected model, or null to clear back to the runtime default.
    Humans carry no effort (400). Unlike a model swap, effort applies per-spawn (it is not baked
    into a warm session), so no cold reset is needed — the next worker spawn picks it up."""
    if not _valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = _require_agent(cur, aid)
        # Per-project identity: an effort change is a member action (403 non-member).
        _trusted_actor(cur, request, str(agent["container_id"]), None)
        # Access model: model/effort swaps are owner-or-manage_agents.
        _enforce_grant(cur, request, str(agent["container_id"]), "manage_agents")
        cur.execute("SELECT kind, model, reasoning_effort FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
        if row["kind"] == "human":
            raise HTTPException(400, "humans carry no reasoning effort")
        supported = _reasoning_effort_ids_by_model().get(row["model"], set())
        if (
            body.reasoning_effort is not None
            and body.reasoning_effort not in supported
        ):
            raise HTTPException(
                400,
                f"reasoning_effort '{body.reasoning_effort}' is not valid for "
                f"model '{row['model']}'; choose one of {sorted(supported)}",
            )
        old_effort = row["reasoning_effort"]
        cur.execute(
            "UPDATE agents SET reasoning_effort=%s WHERE id=%s RETURNING reasoning_effort",
            (body.reasoning_effort, aid),
        )
        new_effort = cur.fetchone()["reasoning_effort"]
        log_event(
            cur,
            agent["container_id"],
            "human",
            None,
            "agent",
            aid,
            "reasoning_effort_changed",
            {"reasoning_effort": new_effort, "previous_reasoning_effort": old_effort},
        )
        conn.commit()
    return {"agent_id": aid, "reasoning_effort": new_effort}
