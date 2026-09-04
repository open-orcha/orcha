"""FAST project-aware roster suggestion for local-run onboarding (Addendum 2 local
source + the LLM onboarding roster flow in onboarding_routes.py/onboarding_prompt.py).

WHY a separate fast path, not a reuse of /api/onboarding/propose: that route is
correct for "describe your goal in prose, let the model draft a roster" but it always
costs an LLM round-trip (seconds, a provider key, a streaming connection). The moment
this endpoint targets is different — a project folder was JUST mounted (`orcha up` on
an existing repo), and the UI wants an instant, opinionated starting roster derived
from files that are ALREADY on disk, with no model call and no API key required. Target
<500ms end to end; the scan itself is bounded to roster_signals.TIME_BUDGET_SECONDS
(200ms) so it can never be the slow part of that budget.

Two routes:
  GET  .../roster/suggest         — read-only, derives suggestions from the workspace.
  POST .../roster/suggest/accept  — creates the accepted suggestions as real agents,
                                     reusing register_agent (agent_registration_routes)
                                     directly rather than re-implementing creation, so
                                     alias-uniqueness / owner-bootstrap / grant checks
                                     stay in exactly one place.

Signal source: the WORKING TREE at ORCHA_LOCAL_REPO_DIR via `roster_signals.scan_workspace`
(os.scandir, NOT git — see that module's docstring for why: an uncommitted brand-new
project must still get a roster). `local_git.available()`/`local_git._env_dir()` are
reused only for the env var + directory-exists check, not for any git operation.
"""

import logging
import os

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from portal_backend import local_git
from portal_backend.agent_registration_routes import register_agent
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container as _require_container
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.identity_routes import enforce_grant as _enforce_grant
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.identity_routes import require_member_read as _require_member_read
from portal_backend.roster_signals import build_roster, detect_signals, scan_workspace
from portal_backend.schemas import AgentCreate

ROSTER_LOG = logging.getLogger("orcha.roster_suggest")

MAX_ACCEPT_SUGGESTIONS = 5  # mirrors roster_signals: 1 main + MAX_SPECIALISTS(4)


def _workspace_available() -> bool:
    """Deliberately LIGHTER than local_git.available(): this endpoint reads the
    WORKING TREE directly (os.scandir, never git), so a project that hasn't run
    `git init` yet — a genuinely brand-new, uncommitted folder — must still work.
    local_git.available() requires a `.git` directory AND the git binary; neither is
    relevant here. Only the env var + a readable directory are required."""
    path = (os.environ.get("ORCHA_LOCAL_REPO_DIR") or "").strip()
    if not path:
        return False
    return os.path.isdir(path)


# ---------- GET .../roster/suggest ----------


@app.get("/api/containers/{cid}/roster/suggest")
def suggest_roster(cid: str, request: Request, refresh: int = 0):
    """Instant, file-derived roster suggestion for a freshly-provisioned project.

    `refresh` is RESERVED (documented, not implemented): a future pass may accept
    `?refresh=1` to trigger an LLM-enriched re-suggestion layered on top of this fast
    result. Today it is accepted and ignored — a no-op — so the UI can wire the query
    param ahead of that work without a breaking contract change later.

    Honest shapes: no local workspace mounted (or it's empty/unreadable) ->
    {"available": False, "suggestions": [], ...} so the caller falls back to the
    manual roster-building flow instead of showing a fabricated suggestion.
    """
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        _require_member_read(cur, request, cid)

    if not _workspace_available():
        return {
            "available": False,
            "source": None,
            "project_kind": "unknown",
            "signals": [],
            "suggestions": [],
        }

    workspace_dir = local_git._env_dir()
    scan = scan_workspace(workspace_dir)
    signals, evidence = detect_signals(scan)

    if not scan["entries"]:
        # An empty or unreadable directory is a distinct, honest "nothing to suggest
        # from" case — not an error. The mount existing but being empty is normal for
        # a genuinely brand-new project with no files yet.
        return {
            "available": False,
            "source": None,
            "project_kind": "unknown",
            "signals": [],
            "suggestions": [],
        }

    project_kind, suggestions = build_roster(signals, evidence)
    return {
        "available": True,
        "source": "workspace",
        "project_kind": project_kind,
        "signals": sorted(signals),
        "suggestions": suggestions,
    }


# ---------- POST .../roster/suggest/accept ----------


class RosterSuggestionAccept(BaseModel):
    alias: str = Field(..., max_length=64)
    role: str = Field(..., max_length=200)
    focus: str = Field(..., max_length=1000)


class RosterAcceptBody(BaseModel):
    suggestions: list[RosterSuggestionAccept] = Field(..., min_length=1, max_length=MAX_ACCEPT_SUGGESTIONS)
    actor_agent_id: "str | None" = Field(
        default=None,
        description="acting human's UUID when no trusted proxy identity is present",
    )


def _prompt_for(role: str, focus: str) -> str:
    """A minimal but real system prompt seeded from the suggestion's role/focus —
    register_agent requires a non-empty prompt for kind='ai'; this keeps the accepted
    agent usable immediately rather than blank, editable later like any other agent."""
    return (
        f"You are the {role} on this project. {focus}. "
        "Use Orcha requests for teamwork and stop at needs_verification — "
        "a human verifies your work; never self-certify."
    )


@app.post("/api/containers/{cid}/roster/suggest/accept", status_code=201)
def accept_roster_suggestions(cid: str, body: RosterAcceptBody, request: Request):
    """Create the accepted suggestions as real agents via the SAME creation path
    register_agent (agent_registration_routes.py) already uses — this route does not
    reimplement agent creation, alias-uniqueness, or the first-human/owner convention;
    it only maps {alias, role, focus} -> the AgentCreate body register_agent expects
    and reuses its handler function directly (in-process call, not an HTTP round-trip).

    Human-gated like other mutations: the SAME actor resolution
    (trusted_actor + enforce_grant('manage_agents')) register_agent itself applies is
    checked here too, so a caller can't bypass the gate by hitting accept instead of
    the underlying route directly — and so a 403 surfaces before any agent is created,
    not partway through the batch.
    """
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        # Same human-gate register_agent applies; checked up front so a caller can't
        # partially succeed before hitting the 403 that register_agent would raise
        # per-item anyway.
        body.actor_agent_id = _trusted_actor(cur, request, cid, body.actor_agent_id)
        _enforce_grant(cur, request, cid, "manage_agents")

    created = []
    for suggestion in body.suggestions:
        agent_body = AgentCreate(
            alias=suggestion.alias,
            role=suggestion.role,
            prompt=_prompt_for(suggestion.role, suggestion.focus),
            kind="ai",
        )
        result = register_agent(cid, agent_body, request)
        created.append({"agent_id": result.agent_id, "alias": result.alias})

    ROSTER_LOG.info(
        "POST /api/containers/%s/roster/suggest/accept created=%d aliases=%s",
        cid, len(created), [c["alias"] for c in created],
    )
    return {"created": created}
