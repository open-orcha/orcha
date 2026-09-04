"""Agent registration schemas and its optional initial-task contract."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

from portal_backend.limits import (
    MAX_DESC_LEN,
    MAX_DOD_LEN,
    MAX_NAME_LEN,
    MAX_PROMPT_LEN,
)


class InitialTask(BaseModel):
    title: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100


# GitHub usernames: alphanumeric + inner hyphens, max 39 chars (github.com rules).
# Defined ahead of AgentCreate so both it and MemberCreate can share it.
_GITHUB_LOGIN_PATTERN = r"^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$"


class AgentCreate(BaseModel):
    alias: str = Field(..., max_length=64)
    role: str = Field(..., max_length=200)
    prompt: Optional[str] = Field(
        default=None,
        description=(
            "System prompt that defines this agent "
            "(required for kind='ai'; omit for 'human')"
        ),
        max_length=MAX_PROMPT_LEN,
    )
    kind: str = Field(default="ai", pattern="^(ai|human)$")
    model: Optional[str] = Field(default=None, max_length=64)
    initial_task: Optional[InitialTask] = None
    # PR attribution (docs/agent-prs.md): a human's GitHub handle + preferred git
    # author email, so agent-opened PRs on tasks they trigger can @mention them
    # and carry a Co-authored-by trailer. Meaningful for kind='human' only; both
    # optional and backfill-safe (the OAuth binding rule can fill github_login
    # later for cloud deployments).
    github_login: Optional[str] = Field(
        default=None, pattern=_GITHUB_LOGIN_PATTERN, max_length=39,
        description="the human's GitHub username (kind='human')",
    )
    git_email: Optional[str] = Field(
        default=None, max_length=254,
        description="preferred git author email for Co-authored-by trailers",
    )


class AgentCreateResponse(BaseModel):
    agent_id: str
    alias: str
    container_id: str
    initial_task: Optional[dict] = None


class MemberCreate(BaseModel):
    """POST /api/containers/{cid}/members — owner invites a GitHub user (collab v1).

    `actor_agent_id` is the trust-off fallback actor (see identity_routes.require_owner);
    with a trusted proxy identity it may be omitted — the header IS the actor."""

    github_login: str = Field(
        ...,
        pattern=_GITHUB_LOGIN_PATTERN,
        max_length=39,
        description="GitHub username to invite (matched case-insensitively)",
    )
    role: Literal["owner", "member", "viewer"] = Field(
        default="member", description="project role for the invited member"
    )
    actor_agent_id: Optional[str] = Field(
        default=None,
        description="acting human's UUID when no trusted proxy identity is present",
    )


class MemberRoleUpdate(BaseModel):
    """PATCH /api/containers/{cid}/members/{aid} — change a member's role and/or
    replace their grant set (access model, mig 039). PARTIAL: only supplied fields
    change; at least one must be supplied. Grants changes are owner-only; role
    changes to/from owner are owner-only; other role moves are owner-or-
    manage_members (member_routes enforces)."""

    role: Optional[Literal["owner", "member", "viewer"]] = None
    grants: Optional[list[Literal[
        "manage_keys", "manage_members", "manage_repo",
        "manage_autonomy", "manage_agents", "assign_reviewers",
    ]]] = Field(
        default=None,
        description="full replacement grant set for the member (owner-only)",
    )
    actor_agent_id: Optional[str] = Field(
        default=None,
        description="acting human's UUID when no trusted proxy identity is present",
    )


class MemberRemove(BaseModel):
    """Optional actor-only body for DELETE .../members/{aid} (trust-off fallback)."""

    actor_agent_id: Optional[str] = Field(
        default=None,
        description="acting human's UUID when no trusted proxy identity is present",
    )


class DeviceTokenCreate(BaseModel):
    """POST /api/device-tokens — mint a per-device bearer token (Orcha Cloud).

    The acting identity comes exclusively from the trusted proxy header (there is
    no actor_agent_id fallback: device tokens only exist behind the cloud proxy)."""

    label: Optional[str] = Field(
        default=None,
        max_length=120,
        description="human-readable device label (e.g. \"Hussein's iPhone\")",
    )
