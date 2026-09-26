"""Container, credential, model-setting, and onboarding API schemas."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

from portal_backend.limits import MAX_DESC_LEN, MAX_NAME_LEN, MAX_PAYLOAD_LEN


class ContainerCreate(BaseModel):
    name: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    # Multi-project (mig 037): the portal's "New project" flow passes additional=true to
    # create ANOTHER container in this stack (seeding its founding human owner). Without
    # it the historical `orcha init` 1:1:1 contract holds: a second create is a 409.
    additional: bool = Field(
        default=False,
        description="create an additional project even when one already exists "
        "(portal multi-project); omitted/false keeps the 1:1:1 init contract",
    )


class ContainerCreateResponse(BaseModel):
    container_id: str
    root_task_id: str
    # Multi-project additions (additive — CLI callers read container_id only).
    name: Optional[str] = None
    # The seeded founding human (additional=true only); null on the init path,
    # where the CLI registers the human itself via POST .../agents.
    human_agent_id: Optional[str] = None


class ContainerReset(BaseModel):
    # DESTRUCTIVE: `confirm` must equal the current container name.
    actor_agent_id: str
    confirm: str


class ContainerGithubBinding(BaseModel):
    """PUT /api/containers/{cid}/github — bind the container to a code source.

    `repo` is either the plain owner/name of a repository the GitHub App/PAT can
    reach (the portal's Connect-repo modal offers exactly that list), OR the literal
    sentinel `"local"` — Addendum 2's "this project's own working tree" binding,
    served by `portal_backend.local_git` instead of the GitHub API (the route layer
    additionally requires `local_git.available()` before accepting it — this schema
    only enforces SHAPE, not availability). null unbinds. The pattern accepts
    exactly one owner segment + one name segment, or the bare word "local".
    """

    repo: Optional[str] = Field(
        default=None,
        pattern=r"^(local|[\w.-]+/[\w.-]+)$",
        max_length=MAX_NAME_LEN,
        description="GitHub repo as owner/name, or the sentinel 'local'; null = unbind",
    )


class ContainerStatusUpdate(BaseModel):
    status: str = Field(..., description="active|paused|completed|cancelled|failed")
    actor_agent_id: str = Field(
        ...,
        description="UUID of the human agent performing the action (kind='human')",
    )


class LlmKeyUpdate(BaseModel):
    """#294 Item 1: store a per-container Anthropic API key (PUT .../settings/llm-key).
    HUMAN-AUTHORITY gated + audit-logged — writing a credential is a human action, mirroring
    /status and /auto-wake (Orcha#30). The key is sealed by secret_box before it touches the
    DB; the plaintext is never persisted and never returned."""

    actor_agent_id: str = Field(
        ...,
        description="UUID of the human agent performing the action (kind='human')",
    )
    api_key: str = Field(
        ...,
        min_length=1,
        max_length=512,
        description="the Anthropic API key (plaintext, sealed server-side)",
    )


class LlmKeyActor(BaseModel):
    """Actor-only body for DELETE .../settings/llm-key (human-authority gated)."""

    actor_agent_id: str = Field(
        ...,
        description="UUID of the human agent performing the action (kind='human')",
    )


class LlmKeyTest(BaseModel):
    """#294 Item 1: server-side credential ping (POST .../settings/llm-key/test). HUMAN-AUTHORITY
    gated. `api_key` is OPTIONAL — supply a candidate to test BEFORE saving (the setup flow), or
    omit to test the currently-resolved key (env override > stored)."""

    actor_agent_id: str = Field(
        ...,
        description="UUID of the human agent performing the action (kind='human')",
    )
    api_key: Optional[str] = Field(
        default=None,
        max_length=512,
        description="candidate key to test; omit to test the stored/resolved key",
    )


class GithubPatUpdate(BaseModel):
    """Orcha Cloud local run gap #1: store a per-container GitHub personal access token
    (PUT .../settings/github-pat). HUMAN-AUTHORITY gated + audit-logged — writing a
    credential is a human action, mirroring /settings/llm-key. The token is sealed by
    secret_box before it touches the DB; the plaintext is never persisted and never
    returned."""

    actor_agent_id: str = Field(
        ...,
        description="UUID of the human agent performing the action (kind='human')",
    )
    token: str = Field(
        ...,
        min_length=1,
        max_length=512,
        description="the GitHub personal access token (plaintext, sealed server-side)",
    )


class GithubPatActor(BaseModel):
    """Actor-only body for DELETE .../settings/github-pat (human-authority gated)."""

    actor_agent_id: str = Field(
        ...,
        description="UUID of the human agent performing the action (kind='human')",
    )


class GithubPatTest(BaseModel):
    """Server-side credential ping (POST .../settings/github-pat/test). HUMAN-AUTHORITY
    gated. `token` is OPTIONAL — supply a candidate to test BEFORE saving (the setup
    flow), or omit to test the currently-resolved token (env override > stored)."""

    actor_agent_id: str = Field(
        ...,
        description="UUID of the human agent performing the action (kind='human')",
    )
    token: Optional[str] = Field(
        default=None,
        max_length=512,
        description="candidate token to test; omit to test the stored/resolved token",
    )


class ModelSettingOverride(BaseModel):
    """One per-use-case model override in a PUT .../settings/models body (SPEC-SETTINGS §3).
    `provider`+`model` both present = override that use-case; a use-case OMITTED from the body
    (or sent with both null) is reset to the shipped default. Validated against the #290 catalog
    server-side (llm_util.is_catalog_choice) so a stubbed provider / bogus model can't be stored."""

    key: str = Field(
        ...,
        max_length=64,
        description="the registered use-case key (e.g. 'triage', 'onboarding')",
    )
    provider: Optional[str] = Field(
        default=None,
        max_length=64,
        description="provider id from the catalog; null = reset",
    )
    model: Optional[str] = Field(
        default=None,
        max_length=128,
        description="model id from the catalog; null = reset",
    )


class ModelSettingsUpdate(BaseModel):
    """#294: replace the FULL set of per-container model overrides (SPEC-SETTINGS §2.2 — one PUT
    writes the full overridden set). HUMAN-AUTHORITY gated + audit-logged, like /settings/llm-key
    and /auto-wake — a model swap is a deliberate cost/quality decision. Any registered use-case
    NOT in `use_cases` is reset to its shipped default."""

    actor_agent_id: str = Field(
        ...,
        description="UUID of the human agent performing the action (kind='human')",
    )
    use_cases: list[ModelSettingOverride] = Field(
        default_factory=list,
        description="the full set of overrides to persist",
    )


class ProposeDialogueTurn(BaseModel):
    """One turn in the SPEC-292 turn-based clarify loop."""

    role: Literal["assistant", "user"]
    content: str = Field(..., max_length=MAX_PAYLOAD_LEN)


class ProposeBody(BaseModel):
    """SPEC-292 request body for POST /api/onboarding/propose."""

    cid: str = Field(..., description="container id for the workspace being staffed")
    goal: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    dialogue: list[ProposeDialogueTurn] = Field(default_factory=list)
