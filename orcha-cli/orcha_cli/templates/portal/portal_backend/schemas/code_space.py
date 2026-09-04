"""Request contracts for Orcha Code Space (Phase 1 thread endpoints + Phase 1+2
local-binding working-tree editing: write/commit/push + Phase 4 GitHub-bound
editing: propose -> branch + PR)."""

from typing import List, Optional

from pydantic import BaseModel, Field

from portal_backend.limits import MAX_NAME_LEN, MAX_PAYLOAD_LEN

# Phase 4 (code_github_edit_routes.py) file-count/size bounds — see that module's
# docstring for the full rationale; kept here (not re-derived in the route module)
# so the schema's own Field bounds are the single place these numbers live.
GITHUB_PROPOSE_MAX_FILES = 50
GITHUB_PROPOSE_FILE_MAX_BYTES = 500_000


class CodeThreadCreate(BaseModel):
    actor_agent_id: str
    ref: str = Field(default="", max_length=MAX_NAME_LEN)  # "" -> the repo's default branch
    path: str = Field(..., max_length=MAX_NAME_LEN)
    start_line: int = Field(..., ge=1)
    end_line: int = Field(..., ge=1)
    kind: str = Field(default="note", pattern="^(question|why|teach|note)$")
    body: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    tagged_agent_id: Optional[str] = None  # set -> a directed request wakes this agent


class CodeThreadMessageCreate(BaseModel):
    actor_agent_id: str
    body: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    resolve: bool = False  # human-only: flips the thread straight to 'resolved'


class WorktreeFileWrite(BaseModel):
    """PUT .../code/worktree/file body. `content` is intentionally an UNCONSTRAINED
    str (no Field max_length) — the 2MB cap is enforced in the route as an honest
    {ok:false, reason:"too_large"} payload, not a 422 validation error, matching
    this portal's "the write itself degrades, it doesn't fail the request" idiom.
    `base_hash` is the optimistic-concurrency token: null means "I'm creating a new
    file"; any other value must match the CURRENT worktree_file_hash() or the write
    is refused as drift."""

    path: str = Field(..., max_length=MAX_NAME_LEN)
    content: str
    base_hash: Optional[str] = None


class WorktreeCommitCreate(BaseModel):
    """POST .../code/worktree/commit body. `paths` are the repo-relative files to
    `git add -A -- <paths>` before committing — deliberately explicit (not "commit
    everything dirty") so an editor commit only ever touches the files the human
    actually reviewed. `author_name`/`author_email` are optional per-commit identity
    overrides (see local_git.stage_and_commit); when omitted, the repo/environment's
    own configured git identity is used unchanged."""

    paths: List[str] = Field(..., min_length=1)
    message: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    author_name: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    author_email: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)


class GithubProposeFile(BaseModel):
    """One file in a POST .../code/github/propose request. `content` is intentionally
    an UNCONSTRAINED str (no Field max_length) — the byte cap
    (GITHUB_PROPOSE_FILE_MAX_BYTES, ~500KB UTF-8-encoded) is enforced in the route as
    a 400, since an oversized file here is a genuine bad request, not a degrade
    (unlike the local editor's write cap, which degrades with a 200 — there's no
    "reload and retry" concurrency story for a propose that hasn't touched GitHub
    yet). `base_hash` is the blob sha the editor loaded THIS file's current content
    from (GitHub's own git blob sha, not local_git's sha256 worktree hash — the two
    editing modules use different concurrency tokens because they're checked against
    different sources of truth); null means "this is a new file" and a same-path
    collision at base_ref is refused as `reason:"exists"` rather than silently
    overwritten."""

    path: str = Field(..., max_length=MAX_NAME_LEN)
    content: str
    base_hash: Optional[str] = None


class GithubProposeCreate(BaseModel):
    """POST .../code/github/propose body: one atomic commit of `files` on a new
    branch, opened as a PR against `base_ref` (or the repo's default branch when
    omitted). `files` is bounded [1, GITHUB_PROPOSE_MAX_FILES] — an empty list has
    nothing to commit (a 400, not a no-op 200), and the upper bound keeps one propose
    click's Git Data API fan-out (one blob POST per file) bounded. `message`'s first
    line becomes the PR title (capped to 72 chars in the route); the rest becomes the
    PR body, with a provenance footer appended server-side."""

    base_ref: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    message: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    files: List[GithubProposeFile] = Field(..., min_length=1, max_length=GITHUB_PROPOSE_MAX_FILES)
