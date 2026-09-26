"""GitHub-bound Code Space editing (Phase 4): propose -> branch + PR. The GitHub-bound
mirror image of code_workingtree_routes.py's local-binding editor — same human-in-the
-portal editing story, but a GitHub-bound container has no working tree to write into,
so "save" here means "open a PR", never a push straight to the default branch.

Endpoints, gated exactly like the browse/hub routes — membership via
`github_repo_browse_routes._load_binding` (400s a bad UUID, 403s a trusted non-member
of a MAPPED container):

  GET  .../code/github/editable  — cheap yes/no: is this container GitHub-bound AND
                                    does a write-capable token resolve? The frontend's
                                    pencil-icon gate (mirrors code_workingtree_routes'
                                    GET .../worktree/available).
  POST .../code/github/propose   — one atomic commit of 1..50 files on a NEW branch,
                                    opened as a PR. Never a push to the default branch.

LOCAL-binding containers degrade honestly to {available:false, reason:"local_source"}
here — the EXACT MIRROR IMAGE of code_workingtree_routes' own "github_source" degrade:
that module has nothing to show for a GitHub-bound container; this module has nothing
to show for a local-binding one (a local project edits its working tree directly via
.../worktree/file, not through a branch+PR flow). An unbound container gets the
existing repo_not_connected shape every other route in this portal uses.

Git Data API sequence (POST /propose's happy path) — the low-level, four-call
primitive GitHub exposes for "one commit, not via a working tree": blobs -> tree ->
commit -> ref, then one more call to open the PR:
  1. Resolve `base_ref` (or the repo's default branch) to a commit sha via the SAME
     `_resolve_ref` browse uses, then fetch that commit's tree sha
     (`GET /repos/{repo}/git/commits/{sha}`).
  2. Path-conflict check (BEFORE any write call): fetch the full recursive tree at
     that base sha (`github_repo_browse_routes._fetch_full_tree`, the same cached
     helper browse/search use) and compare each file's CURRENT blob sha there against
     the caller's optional `base_hash` — the SAME no-silent-overwrite invariant
     `code_workingtree_routes.put_worktree_file` enforces locally, translated to
     GitHub's blob-sha concurrency token instead of local_git's sha256 hash. A
     mismatch (edited-since-load) refuses as `reason:"drift"`; a new-file collision
     (`base_hash` null but the path already exists at base) refuses as
     `reason:"exists"`. Both list every offending path, and NEITHER makes a single
     write call to GitHub — the whole propose is refused as one unit, exactly like
     the local editor never partially applies an edit.
  3. `POST /repos/{repo}/git/blobs` once per file (content base64-encoded).
  4. `POST /repos/{repo}/git/trees` with `base_tree` = the base commit's tree sha and
     one `{path, mode:"100644", type:"blob", sha}` entry per new blob.
  5. `POST /repos/{repo}/git/commits` with `parents=[base_sha]` and the new tree sha.
     Author identity is left to the token's own GitHub identity (the App installation
     or the configured PAT) — this module does not attempt an author override the way
     the local editor's `author_name`/`author_email` commit override does, since the
     Git Data API's `author`/`committer` fields would need a verified email to avoid
     GitHub silently attributing the commit to "no reply" rather than a real account,
     and there is no such verified-email plumbing here.
  6. `POST /repos/{repo}/git/refs` creating `refs/heads/{branch}` at the new commit —
     the ONE call that actually publishes anything; every call before this one only
     creates loose objects nothing points at yet, so a failure at any earlier step
     leaves the repo's real refs untouched.
  7. `POST /repos/{repo}/pulls` opening the PR: `head` = the new branch (never a sha),
     `base` = `base_ref` when it's a real branch NAME, or the repo's default branch
     when `base_ref` resolved through a sha/tag/pr-ref (a PR's base must be a branch
     GitHub can compare against, never a bare commit).

Every GitHub failure anywhere in that sequence maps to ONE clean shape —
{available:true, ok:false, reason:"github_error", detail:<status+short message>} —
never a 5xx, mirroring every other route in this portal's "the write degrades, it
doesn't fail the request" contract. Malformed INPUT (blank message, zero files — the
schema already rejects this one but the message-strip check still runs defensively,
an unsafe path) is the one case that legitimately 400s, matching
code_workingtree_routes' own "a malformed request body is a genuine bad request, a
git-level failure is a degrade" split. Nothing here mutates the repo's default branch
or any existing ref — a NEW branch is always created, a PR is always opened on it,
and a failure partway through the Git Data sequence leaves no dangling ref (only loose
objects GitHub garbage-collects on its own schedule, the same residue any abandoned
Git Data API sequence leaves).

Network calls: reads reuse the EXACT SAME leaf + helpers every other browse-adjacent
module shares — `github_repo_browse_routes._gh_get`, plus its `_resolve_ref` (base
resolution), `_resolve_default_branch` (PR-base fallback), and `_fetch_full_tree` (the
conflict check's base-tree read, same cached recursive-tree helper browse/search use).
Since those helpers' OWN bodies call `github_repo_browse_routes._gh_get` (not a copy
imported into this module's namespace), a test that wants to fake a base-resolution or
tree-fetch call monkeypatches `github_repo_browse_routes._gh_get` — exactly the same
seam `tests/test_repo_browser_api.py` already patches for those same helpers. This
module ALSO makes one direct read of its own (`GET git/commits/{base_sha}`, to read
the base commit's tree sha) through the SAME imported `_gh_get` name, so a test's one
fake covers both the shared-helper calls and this module's own.

Writes go through one small new `_gh_post` leaf defined HERE for the five write calls
(blobs/trees/commits/refs/pulls) — kept in THIS module (not imported from
github_hub_routes or task_start_core) so a test that stubs it never needs to know any
other module exists, the same "own leaf, own import" reasoning
github_repo_browse_routes' module docstring gives for why IT has its own `_gh_get`
rather than sharing github_hub_routes'. Tests monkeypatch `_gh_get` (on
github_repo_browse_routes) and `_gh_post` (on this module) — NEVER real network.
"""

import base64
import json
import re
import time
import urllib.error
import urllib.request

from fastapi import HTTPException, Request

from portal_backend import github_repo_browse_routes as browse
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.github_hub_routes import _resolve_repo_token
from portal_backend.github_repo_browse_routes import (
    GITHUB_API,
    GITHUB_TIMEOUT_SECONDS,
    LOCAL_REPO,
    _load_binding,
)
from portal_backend.identity_routes import require_member_read, trusted_actor
from portal_backend.schemas.code_space import GithubProposeCreate

# Per-file content cap (UTF-8-encoded bytes) — a 400, not a degrade (see module
# docstring): an oversized file here means the caller's editor is misbehaving, not
# that a legitimate edit collided with something. Matches the schema constant.
FILE_MAX_BYTES = 500_000
MAX_FILES = 50

# PR title cap — GitHub itself doesn't hard-limit title length, but a very long first
# line makes for an unreadable PR list row; 72 chars mirrors the conventional commit
# -subject-line convention this codebase's own commit messages already follow.
TITLE_MAX_CHARS = 72

# Branch-name sanitization: only [\w-] survives from the login (Unicode word chars +
# hyphen; `\w` under Python's default re.UNICODE also matches non-ASCII letters, which
# is fine for a git ref component). Anything else (spaces, @, /, etc.) is dropped
# rather than replaced with a filler character, so "octo cat!" -> "octocat", not
# "octo-cat-".
_LOGIN_SANITIZE_RE = re.compile(r"[^\w-]+")

# A bare full/short commit sha (hex only, 7-40 chars) — used to tell "the caller
# passed a real branch/tag name" apart from "the caller passed a raw sha" for the PR
# base-name fallback (step 7). Deliberately conservative (hex-only) so a branch named
# e.g. "abc" or "deadcode" is never misread as a sha; git shas are lower-hex by
# convention and this only needs to catch the common "I copied a commit sha in" case,
# not exhaustively validate every possible git ref.
_SHA_LIKE_RE = re.compile(r"^[0-9a-f]{7,40}$")


def _looks_like_sha(ref: str) -> bool:
    return bool(_SHA_LIKE_RE.match(ref or ""))


def _not_connected() -> dict:
    return {"available": False, "reason": "repo_not_connected",
            "detail": "no GitHub repo is connected to this project"}


def _local_source_unavailable() -> dict:
    """The EXACT MIRROR IMAGE of code_workingtree_routes._github_source_unavailable —
    see this module's docstring. Distinct `reason` ("local_source") from the hub's own
    identically-named degrade (github_hub_routes._local_source_unavailable) but the
    SAME reason string as that one uses for issues/PRs, since both mean "this surface
    needs a real GitHub binding and this container doesn't have one" — deliberately
    reusing the vocabulary the frontend already has a treatment for, rather than
    minting yet another reason string for the same underlying concept."""
    return {
        "available": False, "reason": "local_source",
        "detail": "this project edits its working tree directly — use the editor's "
                   "save/commit flow",
    }


def _load_editable_binding(cur, cid: str, request: Request):
    """Shared preamble: validate + gate membership via `_load_binding` (the SAME one
    browse/hub routes use), then classify into (repo: str|None, degrade: dict|None) —
    callers write `repo, degrade = _load_editable_binding(...); if degrade: return
    degrade`. `repo` is the bound GitHub `owner/name` on success; degrade is None only
    in that case."""
    repo = _load_binding(cur, cid, request)
    if not repo:
        return None, _not_connected()
    if repo == LOCAL_REPO:
        return None, _local_source_unavailable()
    return repo, None


def _gh_post(path: str, token: str, payload: dict):
    """POST a GitHub REST path with a JSON body; return parsed JSON. stdlib urllib,
    the SAME contract every other GitHub leaf in this portal uses: raises
    RuntimeError("github_status:<code>") / RuntimeError("github_unreachable:...") on
    any failure, never returns a partial/error body as if it were success. This is
    the ONE write leaf every propose call in this module goes through — tests
    monkeypatch this function (and `_gh_get`), never urllib directly."""
    url = f"{GITHUB_API}{path}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "orcha-portal",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=GITHUB_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            pass
        raise RuntimeError(f"github_status:{exc.code}:{detail}") from exc
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        raise RuntimeError(f"github_unreachable:{exc}") from exc


def _github_error_payload(exc: RuntimeError) -> dict:
    """Map ANY _gh_get/_gh_post RuntimeError raised during a propose to the module's
    ONE error shape — {ok:false, reason:"github_error", detail}. Deliberately not the
    finer-grained rate_limited/not_found split github_hub_routes' `_error_payload`
    makes: a propose is a multi-step write sequence, and by the time any one step
    fails there's no single "the repo" or "the item" a 403-vs-404 distinction would
    usefully describe to the caller — one honest "GitHub returned X" detail is enough
    for the human to see in the UI and retry. `detail` is capped to keep a verbose
    GitHub error body from ballooning the response."""
    msg = str(exc)
    if msg.startswith("github_status:"):
        rest = msg[len("github_status:"):]
        code, _, body = rest.partition(":")
        detail = f"GitHub returned {code}"
        if body.strip():
            detail += f": {body.strip()[:300]}"
        return {"available": True, "ok": False, "reason": "github_error", "detail": detail}
    return {"available": True, "ok": False, "reason": "github_error",
            "detail": "could not reach GitHub"}


def _safe_propose_path(path: str) -> bool:
    """A repo-relative path is safe to write via the Git Data API: non-empty, not
    absolute, no `..` segment, and never inside `.git/` — the SAME rules
    local_git._safe_rel_path + _is_git_internal_path enforce for the local editor's
    write path, applied here even though the Git Data API itself has no filesystem to
    escape (a `.git/`-prefixed tree entry would still corrupt the repo's own metadata
    path from GitHub's point of view, and a `../`-laden path is never a legitimate
    tree entry either way)."""
    if not isinstance(path, str) or not path:
        return False
    if path.startswith("-"):
        return False
    normalized = path.replace("\\", "/")
    if normalized.startswith("/"):
        return False
    parts = normalized.split("/")
    if any(p == ".." or p == "" for p in parts):
        return False
    if parts[0] == ".git":
        return False
    return True


def _sanitize_login(login) -> str:
    """Branch-name-safe form of a github_login: lowercase, [\\w-] only, falling back
    to "member" when the login is missing OR sanitizes down to nothing (e.g. a login
    that was ENTIRELY punctuation — pathological, but the branch name must never end
    up with an empty identity segment)."""
    if not login:
        return "member"
    cleaned = _LOGIN_SANITIZE_RE.sub("", login.strip().lower())
    return cleaned or "member"


def _branch_name(login) -> str:
    """codespace/{login-or-"member"}-{YYYYMMDD-HHMMSS}, UTC."""
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    return f"codespace/{_sanitize_login(login)}-{stamp}"


def _pr_title_and_body(message: str, login) -> "tuple[str, str]":
    """Split the propose `message` into a PR title (first line, capped to
    TITLE_MAX_CHARS) and body (the rest, with a provenance footer appended). A
    single-line message has an empty remainder body — the footer alone still tells a
    reviewer this PR came from Orcha's Code Space, not a bare empty PR description."""
    lines = message.splitlines()
    first_line = (lines[0] if lines else "").strip()
    title = first_line[:TITLE_MAX_CHARS]
    rest = "\n".join(lines[1:]).strip()
    footer = f"Proposed from Orcha Code Space by {login or 'a project member'}."
    body = f"{rest}\n\n{footer}" if rest else footer
    return title, body


@app.get("/api/containers/{cid}/code/github/editable")
def get_github_editable(cid: str, request: Request):
    """The frontend's pencil-icon gate: {available: bool} — true iff this container is
    GitHub-bound AND a token resolves for its repo (`github_hub_routes._resolve_repo_token`
    — the SAME resolution the hub/browse routes use to decide whether they can talk to
    GitHub at all). There is no cheap GitHub capability probe for "can this specific
    token actually PUSH" short of attempting a write, so `available` here means "a
    token is wired", not "a write is guaranteed to succeed" — a real propose can still
    fail with `reason:"github_error"` if the token turns out to be read-only (a rare
    misconfiguration, not the common case this gate exists to short-circuit).

    Local-binding containers degrade to {available:false, reason:"local_source"} (see
    module docstring); unbound containers get the standard repo_not_connected shape."""
    with db_cursor() as (_, cur):
        repo, degrade = _load_editable_binding(cur, cid, request)
    if degrade:
        return degrade
    token = _resolve_repo_token(repo, cid)
    return {"available": bool(token)}


def _check_conflicts(entries: list, files) -> dict:
    """Compare each proposed file's CURRENT blob sha in the base tree (`entries`, the
    recursive tree GitHub returned for the base commit) against its `base_hash`.
    Returns {"drift": [paths...], "exists": [paths...]} — either list may be empty;
    both empty means no conflicts.

    `base_hash` semantics (matches what the draft editor can actually supply):
      * set → it must equal the base tree's blob sha for that path, else "drift"
        (edited since the editor loaded it) — INCLUDING when the path no longer
        exists at base (current None != any non-null claim).
      * null + path NOT present at base → a new file, no conflict.
      * null + path present at base → NO CLAIM: accepted as-is. The editor sends
        null whenever it has no blob sha for the loaded content (older cached
        payloads, "Reload base" fallback) — refusing those as "exists" made every
        ordinary edit un-proposable. "exists" is therefore currently unreachable
        and reserved for a future explicit new-file flow that asserts creation."""
    sha_by_path = {e.get("path"): e.get("sha") for e in entries if e.get("type") == "blob"}
    drift = []
    exists = []
    for f in files:
        current_sha = sha_by_path.get(f.path)
        if f.base_hash is not None and f.base_hash != current_sha:
            drift.append(f.path)
    return {"drift": drift, "exists": exists}


@app.post("/api/containers/{cid}/code/github/propose")
def post_github_propose(cid: str, body: GithubProposeCreate, request: Request):
    """One atomic commit of `body.files` on a NEW branch, opened as a PR against
    `body.base_ref` (or the repo's default branch). See the module docstring for the
    full Git Data API sequence and every response shape's rationale. Never pushes to
    the default branch; never overwrites a file that drifted since the editor loaded
    it or collides with an existing file on a declared-new write.

    Validation (checked BEFORE any GitHub call — a 400, matching
    code_workingtree_routes' "a malformed request body is a genuine bad request"
    split): `message` must be non-blank after stripping; every `files[].path` must be
    `_safe_propose_path`-safe; every `files[].content`, UTF-8-encoded, must be
    <= FILE_MAX_BYTES (the schema already bounds file COUNT to
    [1, GITHUB_PROPOSE_MAX_FILES]).

    Returns on success: {available:true, ok:true, pr_number, pr_url, branch,
    commit_sha}. Returns {available:true, ok:false, reason:"drift"|"exists",
    paths:[...]} when the base-sha conflict check (step 2 in the module docstring)
    finds a stale/colliding file — NO Git Data write call is made in that case.
    Returns {available:true, ok:false, reason:"github_error", detail} for any GitHub
    failure at any step of the sequence — by construction, once step 6 (POST refs)
    has succeeded the branch is real and a step-7 (POST pulls) failure still reports
    github_error, but the branch itself is left in place rather than an attempted
    (and itself fallible) rollback; a human can open the PR by hand from that branch.
    """
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(400, "message must not be blank")
    if not body.files:
        raise HTTPException(400, "files must not be empty")
    if len(body.files) > MAX_FILES:
        raise HTTPException(400, f"at most {MAX_FILES} files per propose")
    for f in body.files:
        if not _safe_propose_path(f.path):
            raise HTTPException(400, f"path {f.path!r} is not a safe repository-relative path")
        if len(f.content.encode("utf-8", errors="ignore")) > FILE_MAX_BYTES:
            raise HTTPException(400, f"path {f.path!r} exceeds the {FILE_MAX_BYTES}-byte file cap")

    with db_cursor() as (_, cur):
        repo, degrade = _load_editable_binding(cur, cid, request)
        if not degrade:
            # The acting human's github_login, via the SAME identity seam every other
            # route in this portal leans on (require_member_read — trusted-proxy
            # login resolved to a live container member; None under trust-off or an
            # unmapped container). Used only for the branch-name suffix and the PR's
            # provenance footer — never for authorization (membership was already
            # checked by _load_editable_binding above, via the same _load_binding).
            member = require_member_read(cur, request, cid)
            # Access model (mig 039): the read gate above admits the viewer role by
            # design; opening a branch + commit + PR with the project's token is a
            # WRITE, so bind through the same seam every other human write uses —
            # a viewer (or trusted non-member) is refused here with a 403 before any
            # GitHub call. Trust off / no header ⇒ no-op.
            trusted_actor(cur, request, cid, None)
    if degrade:
        return degrade
    login = member.get("github_login") if member else None

    token = _resolve_repo_token(repo, cid)
    if not token:
        return _not_connected()

    # Step 1: resolve base ref -> base commit sha -> base tree sha. `_resolve_ref` and
    # `_gh_get` are called through the `browse` module object (never imported by name)
    # so a test's `monkeypatch.setattr(browse, "_gh_get", ...)` — the SAME seam
    # test_repo_browser_api.py already uses for these exact helpers — covers every
    # read this route makes, including this one.
    try:
        base_sha = browse._resolve_ref(repo, token, cid, body.base_ref or "")
        base_commit = browse._gh_get(f"/repos/{repo}/git/commits/{base_sha}", token)
    except RuntimeError as exc:
        return _github_error_payload(exc)
    base_tree_sha = (base_commit.get("tree") or {}).get("sha")
    if not base_tree_sha:
        return {"available": True, "ok": False, "reason": "github_error",
                "detail": "could not resolve the base commit's tree"}

    # Step 2: path-conflict check against the base tree, BEFORE any write call.
    try:
        entries, _truncated = browse._fetch_full_tree(repo, base_sha, token, cid)
    except RuntimeError as exc:
        return _github_error_payload(exc)
    conflicts = _check_conflicts(entries, body.files)
    if conflicts["drift"]:
        return {"available": True, "ok": False, "reason": "drift", "paths": conflicts["drift"]}
    if conflicts["exists"]:
        return {"available": True, "ok": False, "reason": "exists", "paths": conflicts["exists"]}

    # Steps 3-6: blobs -> tree -> commit -> ref.
    try:
        blob_shas = {}
        for f in body.files:
            encoded = base64.b64encode(f.content.encode("utf-8")).decode("ascii")
            blob = _gh_post(f"/repos/{repo}/git/blobs", token,
                             {"content": encoded, "encoding": "base64"})
            blob_shas[f.path] = blob.get("sha")

        tree_entries = [
            {"path": f.path, "mode": "100644", "type": "blob", "sha": blob_shas[f.path]}
            for f in body.files
        ]
        new_tree = _gh_post(f"/repos/{repo}/git/trees", token,
                             {"base_tree": base_tree_sha, "tree": tree_entries})
        new_tree_sha = new_tree.get("sha")

        title, pr_body = _pr_title_and_body(message, login)
        new_commit = _gh_post(f"/repos/{repo}/git/commits", token, {
            "message": message,
            "tree": new_tree_sha,
            "parents": [base_sha],
        })
        commit_sha = new_commit.get("sha")

        branch = _branch_name(login)
        _gh_post(f"/repos/{repo}/git/refs", token, {
            "ref": f"refs/heads/{branch}",
            "sha": commit_sha,
        })
    except RuntimeError as exc:
        return _github_error_payload(exc)

    # Step 7: open the PR. The PR base must be a real branch NAME, never a sha — when
    # `body.base_ref` was omitted, was a "pr/<number>" convenience ref (which
    # _resolve_ref turns into a commit SHA, never a branch name), or itself LOOKS like
    # a raw commit sha (a caller passing a bare sha as base_ref has no branch name to
    # give GitHub either), fall back to the repo's default branch name for the PR's
    # base. A caller-supplied plain branch name or tag is used AS GIVEN — `_resolve_ref`
    # passes it straight through unchanged, so `body.base_ref` already IS the right
    # value to hand GitHub's `base` field in that common case.
    pr_base = body.base_ref or None
    if not pr_base or pr_base.startswith("pr/") or _looks_like_sha(pr_base):
        try:
            pr_base = browse._resolve_default_branch(repo, token, cid)
        except RuntimeError as exc:
            return _github_error_payload(exc)
    try:
        pull = _gh_post(f"/repos/{repo}/pulls", token, {
            "title": title or f"Code Space changes ({branch})",
            "head": branch,
            "base": pr_base,
            "body": pr_body,
        })
    except RuntimeError as exc:
        return _github_error_payload(exc)

    return {
        "available": True, "ok": True,
        "pr_number": pull.get("number"),
        "pr_url": pull.get("html_url"),
        "branch": branch,
        "commit_sha": commit_sha,
    }
