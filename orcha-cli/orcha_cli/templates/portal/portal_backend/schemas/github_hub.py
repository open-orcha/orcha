"""GitHub-hub request contracts (Feature A)."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

from portal_backend.limits import MAX_DESC_LEN, MAX_NAME_LEN


class GithubStartBody(BaseModel):
    """POST /api/containers/{cid}/github/start — turn a GitHub issue/PR into a task.

    The frontend passes the row's own display fields (title/body_excerpt/html_url) so
    the task copy is composed without a second GitHub round-trip; the server never
    trusts them for identity — `number` + `kind` are the item's identity and the
    idempotency key. `assignee_agent_id` is optional (bare Start = unassigned).
    """

    kind: Literal["issue", "pull"]
    number: int = Field(..., ge=1, description="the issue/PR number")
    title: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    body_excerpt: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    html_url: Optional[str] = Field(default=None, max_length=512)
    assignee_agent_id: Optional[str] = Field(
        default=None, description="UUID of a live AI agent to assign; omit for unassigned"
    )
    # Trust-off convention (self-host / break-glass): the permissive body actor, mirrored
    # from task creation. Under proxy trust the header IS the creator and this is ignored.
    created_by_agent_id: Optional[str] = None
