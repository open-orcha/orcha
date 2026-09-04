"""Working-tree changes + file history + editing — Orcha Cloud local run,
agentic-era IDE features (docs/orcha-cloud-local-run.md addendum, Part B + Code
Space editing Phase 1+2, Part C): "what have agents changed that isn't committed
yet", "how did this file get here", and now "let a human edit the working tree
from the portal and commit/push it". All of it is LOCAL-BINDING ONLY — a GitHub-
bound container has no working tree to read or write (the portal never clones a
GitHub repo to disk) and no meaningful uncommitted-changes concept, so every route
here degrades honestly to `{available:false, reason:"github_source"}` rather than
error, exactly like `github_hub_routes._local_source_unavailable`'s mirror-image
degrade for the hub surface.

Endpoints, all gated exactly like the browse routes — membership via
`github_repo_browse_routes._load_binding` (itself 400s a bad UUID and 403s a
trusted non-member of a MAPPED container). The write/commit/push routes below use
the SAME gate as the reads: these are human UI actions riding proxy trust, exactly
like a thread reply is — there is no separate "write" grant in this portal for
local-binding Code Space editing, matching the design doc's call that this is
IDE-in-the-browser for the project's own maintainer, not a multi-tenant write API.

  GET  .../code/worktree/changes          — dirty-tree summary: every changed file
                                             (tracked + untracked) with per-file +/-
                                             counts and a repo-wide summary.
  GET  .../code/worktree/diff?path=       — one file's unified diff text.
  GET  .../code/file/history?path=&ref=&n= — commits that touched one file (`--follow`).
  GET  .../code/worktree/file?path=       — one file's CURRENT WORKTREE content, for
                                             the editor (distinct from browse_file's
                                             ref-pinned committed-content read).
  PUT  .../code/worktree/file             — write a file's content into the working
                                             tree, with optimistic-concurrency drift
                                             detection via a content hash.
  POST .../code/worktree/commit           — `git add -A -- <paths>` + `git commit`.
  POST .../code/worktree/push             — `git push origin HEAD`.
  GET  .../code/worktree/branch           — current branch / head sha / ahead-behind
                                             / remote, for the editor's status strip.

All build on `portal_backend.local_git`'s working-tree helpers (status_porcelain/
diff_numstat/diff_unified/log_follow/worktree_file_hash/write_worktree_file/
stage_and_commit/push_current_branch/branch_info) — this module owns ONLY the
route/membership/shape layer, no git subprocess calls of its own; every git
failure mode already degrades to None/[]/False/dict inside `local_git`, so the
route layer's job is purely: gate membership, branch on local-vs-github, shape the
response, cap sizes, and turn a `local_git` None/False into an honest payload —
NEVER a 5xx for an ordinary git-level failure (a malformed request body or an
unsafe path is the one case that legitimately gets a 400, matching the existing
`path is required` 400s in this module).
"""

import threading
import time

from fastapi import HTTPException, Query, Request

from portal_backend import local_git
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.github_repo_browse_routes import LOCAL_REPO, _load_binding, is_vendored_path
from portal_backend.identity_routes import trusted_actor
from portal_backend.schemas.code_space import WorktreeCommitCreate, WorktreeFileWrite

# Unified diff text is capped the same spirit as browse/file's FILE_CONTENT_CAP_BYTES —
# an oversized diff is truncated with a marker, never silently dropped or left to blow
# up a response. ~200KB per the design doc.
WORKTREE_DIFF_MAX_BYTES = local_git.WORKTREE_DIFF_MAX_BYTES

# File-history default page size when the caller omits `n`.
DEFAULT_HISTORY_N = 20
# A hard ceiling on `n` regardless of what the caller asks for — mirrors every other
# bounded-list route in this portal (NAMES_SEARCH_MAX_RESULTS, GREP_MAX_RESULTS, …).
MAX_HISTORY_N = 200

# The editor READ cap — same 500_000-byte spirit as browse_file's own content cap
# (a huge file is truncated with a marker, never silently dropped or left to blow
# up the response / the browser's editor widget).
WORKTREE_FILE_READ_MAX_BYTES = 500_000

# The editor WRITE cap — 2MB is generous for a hand-edited source file while still
# bounding the worst case (a pasted-in binary blob, a runaway generated file) to
# something the portal's request body limits and `write_worktree_file`'s atomic-
# write tempfile can absorb without special-casing. Enforced as an honest
# {ok:false, reason:"too_large"} payload, never a 413/422 — matching this module's
# "the write degrades, it doesn't fail the request" contract.
WORKTREE_FILE_WRITE_MAX_BYTES = 2_000_000


def _github_source_unavailable() -> dict:
    """The container is bound to a real GitHub repo — working-tree/history surfaces
    have nothing to show there (the portal never checks out a GitHub repo to disk).
    Distinct `reason` ("github_source") from the hub's own "local_source" degrade
    (github_hub_routes._local_source_unavailable) since this is the EXACT MIRROR
    IMAGE: that one fires when local has no GitHub equivalent, this one fires when
    GitHub has no local-filesystem equivalent."""
    return {
        "available": False, "reason": "github_source",
        "detail": "working-tree changes and file history need a local repository — "
                   "this project is bound to a GitHub repo",
    }


def _require_local_binding(cur, cid: str, request: Request):
    """Shared preamble for every route below: validate + gate membership via the SAME
    `_load_binding` the browse routes use, then classify the bound repo into one of
    three shapes the caller handles: (True, None) — bound to local, proceed; (False,
    not_connected_payload) — no repo bound at all; (False, github_source_payload) —
    bound to a real GitHub repo. Returns (is_local: bool, degrade_payload: dict|None)
    so callers write `ok, degrade = _require_local_binding(...); if not ok: return
    degrade`, matching the browse routes' own `if not repo: return _not_connected()`
    idiom."""
    repo = _load_binding(cur, cid, request)
    if not repo:
        return False, {
            "available": False, "reason": "repo_not_connected",
            "detail": "no GitHub repo is connected to this project",
        }
    if repo != LOCAL_REPO:
        return False, _github_source_unavailable()
    return True, None




# ---- short-TTL read cache -----------------------------------------------------
# Working-tree reads run real git against a bind mount — on Docker-for-Mac a
# `status` + per-file untracked numstat over a large repo takes SECONDS (it can
# even hit local_git's own 20s subprocess timeout), and the Code Space page plus
# the Changes tab's poll hit these routes on every mount/tab switch. A short TTL
# absorbs that fan-in; any successful WRITE through this module (PUT file,
# commit) invalidates the cid's entries so the next read is honest. Push doesn't
# change the working tree but DOES change ahead/behind — it invalidates too.
_WORKTREE_CACHE: dict = {}
_CHANGES_TTL_SECONDS = 12.0
_BRANCH_TTL_SECONDS = 30.0


# Past the fresh TTL a cached payload is still served IMMEDIATELY (stale-while-
# revalidate) while a single-flight background thread recomputes it — the Changes
# tab's poll never waits on a multi-second bind-mount git scan again. Stale
# payloads older than this are considered dead and recomputed inline.
_STALE_MAX_SECONDS = 600.0
_REFRESH_IN_FLIGHT: set = set()
_REFRESH_LOCK = threading.Lock()


def _require_write_actor(cur, cid: str, request: Request) -> None:
    """Access model (mig 039) for this module's WRITE routes (PUT file / commit /
    push). `_require_local_binding` reuses the READ gate the GETs share, and that gate
    admits the viewer role by design (viewing is the one thing the role is for) — so a
    write must additionally bind the proxy identity through the same seam every other
    human write uses (`trusted_actor`), which refuses a viewer and a trusted
    non-member with a 403. Trust off / no header ⇒ no-op: the self-host convention
    is unchanged."""
    trusted_actor(cur, request, cid, None)


def _cache_get(kind: str, cid: str, ttl: float, refresh=None):
    hit = _WORKTREE_CACHE.get((kind, cid))
    if not hit:
        return None
    ts, payload = hit
    age = time.monotonic() - ts
    if age <= ttl:
        return payload
    if age > _STALE_MAX_SECONDS or refresh is None:
        return None
    _spawn_refresh(kind, cid, refresh)
    return payload


def _spawn_refresh(kind: str, cid: str, refresh) -> None:
    """Single-flight: at most one background recompute per (kind, cid)."""
    key = (kind, cid)
    with _REFRESH_LOCK:
        if key in _REFRESH_IN_FLIGHT:
            return
        _REFRESH_IN_FLIGHT.add(key)

    def _run():
        try:
            payload = refresh()
            if payload is not None:
                _cache_put(kind, cid, payload)
        except Exception:
            pass
        finally:
            with _REFRESH_LOCK:
                _REFRESH_IN_FLIGHT.discard(key)

    threading.Thread(target=_run, daemon=True, name=f"worktree-{kind}-refresh").start()


def _cache_put(kind: str, cid: str, payload: dict) -> dict:
    _WORKTREE_CACHE[(kind, cid)] = (time.monotonic(), payload)
    return payload


def _cache_invalidate(cid: str) -> None:
    for key in [k for k in _WORKTREE_CACHE if k[1] == cid]:
        _WORKTREE_CACHE.pop(key, None)


@app.get("/api/containers/{cid}/code/worktree/changes")
def get_worktree_changes(cid: str, request: Request):
    """The dirty working tree, summarized: every file that differs from HEAD (tracked
    modifications/adds/deletes/renames) PLUS every untracked file, each with its own
    +/- line counts, plus a repo-wide `summary`.

    Returns {available, dirty, files:[{path, status:"M"|"A"|"D"|"R"|"??",
    additions?, deletions?}], summary:{files, additions, deletions}}. `dirty` is
    `bool(files)` — a clean tree returns `available:true, dirty:false, files:[]`,
    the frontend's cue for "Working tree clean — everything is committed." `additions`/
    `deletions` are omitted (None) for a binary file, mirroring `local_git.diff_numstat`'s
    own binary handling (git's numstat prints "-" for a binary file's counts — never
    fabricated). Local-binding only; a GitHub-bound or unbound container gets the
    honest {available:false,...} degrade instead of a 404/500.
    """
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        return degrade
    cached = _cache_get("changes", cid, _CHANGES_TTL_SECONDS, refresh=_compute_changes)
    if cached is not None:
        return cached
    # Total cache miss: NEVER compute inline — a cold scan on a big repo over a
    # Docker-for-Mac bind mount is 5-20s, and this route sits directly under the
    # Changes tab. Kick the single-flight background scan and answer immediately
    # with scanning:true; the tab fast-polls until the real payload lands.
    _spawn_refresh("changes", cid, _compute_changes)
    return {
        "available": True, "scanning": True, "dirty": False, "files": [],
        "summary": {"files": 0, "additions": 0, "deletions": 0},
    }


def _compute_changes() -> dict:
    """The actual scan — also the body the stale-while-revalidate refresher runs."""
    status_entries = local_git.status_porcelain()
    if status_entries is None:
        return {
            "available": False, "reason": "git_error",
            "detail": "could not read working-tree status from the local repository",
        }
    numstat_entries = local_git.diff_numstat() or []
    counts_by_path = {e["path"]: e for e in numstat_entries}
    files = []
    total_additions = 0
    total_deletions = 0
    for entry in status_entries:
        path = entry["path"]
        # Orcha's own runtime files are not the agents' work: the stack dir
        # (.orcha/ — portal copies, pycache the running portal itself writes)
        # and vendored/generated dirs would make every project read as
        # permanently dirty. Same segment filter the symbol indexer uses.
        if path.startswith(".orcha/") or is_vendored_path(path):
            continue
        counts = counts_by_path.get(path, {})
        additions = counts.get("additions")
        deletions = counts.get("deletions")
        if additions is not None:
            total_additions += additions
        if deletions is not None:
            total_deletions += deletions
        row = {"path": path, "status": entry["status"], "additions": additions, "deletions": deletions}
        if entry["status"] == "R" and entry.get("orig_path"):
            row["orig_path"] = entry["orig_path"]
        files.append(row)
    return {
        "available": True,
        "dirty": bool(files),
        "files": files,
        "summary": {"files": len(files), "additions": total_additions, "deletions": total_deletions},
    }


@app.get("/api/containers/{cid}/code/worktree/diff")
def get_worktree_diff(cid: str, request: Request, path: str = Query(...)):
    """One file's unified diff against HEAD (or, for an untracked file, the
    synthesized whole-file-add form against `/dev/null` — see
    `local_git.diff_unified`'s docstring). Returns {path, diff, binary}. A binary
    file's diff is never decoded/rendered as text — `binary:true` with `diff` set to
    git's own short "Binary files a/... and b/... differ" summary line (or the
    `--no-index` equivalent for an untracked binary), matching how a `git diff` a
    human runs at a terminal already reads for a binary change, rather than inventing
    a separate placeholder string. Capped at WORKTREE_DIFF_MAX_BYTES with a truncation
    marker appended — never silently dropped. Local-binding only.
    """
    clean_path = (path or "").strip("/")
    if not clean_path:
        raise HTTPException(400, "path is required")
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        return degrade
    diff_text = local_git.diff_unified(clean_path)
    if diff_text is None:
        return {
            "available": False, "reason": "not_found",
            "detail": f"path {clean_path!r} could not be diffed in the local repository",
        }
    binary = "Binary files " in diff_text and "\n+" not in diff_text and "\n-" not in diff_text
    truncated = False
    if len(diff_text.encode("utf-8", errors="ignore")) > WORKTREE_DIFF_MAX_BYTES:
        # Truncate on a UTF-8-safe boundary: encode, slice, decode-with-ignore drops
        # any trailing partial multibyte sequence rather than raising.
        diff_text = diff_text.encode("utf-8", errors="ignore")[:WORKTREE_DIFF_MAX_BYTES].decode(
            "utf-8", errors="ignore")
        diff_text += "\n\n… diff truncated (exceeds the display cap) …\n"
        truncated = True
    return {"available": True, "path": clean_path, "diff": diff_text, "binary": binary, "truncated": truncated}


@app.get("/api/containers/{cid}/code/file/history")
def get_file_history(
    cid: str, request: Request,
    path: str = Query(...), ref: str = Query(default=""), n: int = Query(default=DEFAULT_HISTORY_N),
):
    """The commits that touched `path` (`git log --follow`, newest first), local-
    binding only — GitHub-bound containers get the same honest
    {available:false, reason:"github_source"} degrade every route in this module
    uses; there is no cheap GitHub equivalent (the commits-for-a-path API exists but
    is a whole separate integration this module deliberately does not add — see the
    design doc's "GitHub-only surfaces degrade honestly" principle).

    Returns {available, commits:[{sha, short, summary, author, committed_at}]}. `n`
    is clamped to [1, MAX_HISTORY_N] (a caller-supplied 0/negative/huge value never
    reaches git). `ref` defaults to HEAD like every other ref param in this portal.
    """
    clean_path = (path or "").strip("/")
    if not clean_path:
        raise HTTPException(400, "path is required")
    n_clamped = max(1, min(n, MAX_HISTORY_N))
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        return degrade
    commits = local_git.log_follow(clean_path, ref or None, n_clamped)
    if commits is None:
        return {
            "available": False, "reason": "not_found",
            "detail": f"could not resolve ref {ref!r} or path {clean_path!r} in the local repository",
        }
    return {"available": True, "path": clean_path, "commits": commits}


# ============================ editing: read / write / commit / push ===================

@app.get("/api/containers/{cid}/code/worktree/file")
def get_worktree_file(cid: str, request: Request, path: str = Query(...)):
    """The editor's read: one file's CURRENT WORKING-TREE bytes (whatever is on
    disk right now, tracked or not, committed or not) — distinct from
    `github_repo_browse_routes.browse_file`, which is pinned to a ref/commit sha
    and can never see an uncommitted edit. Local-binding only.

    Returns {available, path, content, binary, truncated, content_hash, exists}.
    `content` is the file's bytes decoded as UTF-8 with `errors="ignore"` (a lossy
    but never-raising decode, matching every other text-surface in this portal);
    `binary` is a best-effort NUL-byte sniff on the RAW bytes (before any
    truncation), so a binary file is flagged even if the truncation cap would have
    hidden the tell-tale NUL. `content_hash` is the sha256 hexdigest of the FULL,
    UNCAPPED raw bytes (via `local_git.worktree_file_hash`) — the caller's `base_hash`
    on a subsequent PUT must match this exact value, so hashing the truncated/decoded
    text here would make a large file impossible to safely round-trip. `truncated`
    caps display at WORKTREE_FILE_READ_MAX_BYTES, same spirit as browse_file's own
    cap and this module's own WORKTREE_DIFF_MAX_BYTES.

    A MISSING file is not an error — `exists:false, content:"", content_hash:null`
    is the honest "nothing here yet" shape a caller uses to decide whether a
    subsequent PUT is a create (base_hash=null) or an edit."""
    clean_path = (path or "").strip("/")
    if not clean_path:
        raise HTTPException(400, "path is required")
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        return degrade
    if not local_git._safe_rel_path(clean_path):
        raise HTTPException(400, f"path {clean_path!r} is not a safe repository-relative path")
    raw = local_git._read_worktree_file(clean_path)
    if raw is None:
        return {
            "available": True, "path": clean_path, "content": "", "binary": False,
            "truncated": False, "content_hash": None, "exists": False,
        }
    content_hash = local_git.worktree_file_hash(clean_path)
    binary = local_git._is_probably_binary(raw)
    truncated = len(raw) > WORKTREE_FILE_READ_MAX_BYTES
    display_bytes = raw[:WORKTREE_FILE_READ_MAX_BYTES] if truncated else raw
    content = display_bytes.decode("utf-8", errors="ignore")
    return {
        "available": True, "path": clean_path, "content": content, "binary": binary,
        "truncated": truncated, "content_hash": content_hash, "exists": True,
    }


@app.put("/api/containers/{cid}/code/worktree/file")
def put_worktree_file(cid: str, body: WorktreeFileWrite, request: Request):
    """The editor's write: create or overwrite one file in the working tree, with
    optimistic-concurrency drift detection so an in-portal edit never silently
    clobbers a change an agent made to the SAME file in the meantime.

    Rules (checked in this order):
      1. `path` must be a safe repository-relative path (400 — a malformed/unsafe
         path is the one case this route treats as a genuine bad REQUEST, not a
         degrade, matching this module's existing `path is required` 400 usage).
      2. `content`, UTF-8 encoded, must be <= WORKTREE_FILE_WRITE_MAX_BYTES, or the
         write is refused as {ok:false, reason:"too_large"} — never a 413; this
         portal's write routes degrade with a 200 + reason, they don't fail the
         HTTP request itself.
      3. `base_hash: null` means "I'm creating a new file" — if the file already
         exists, the write is refused as {ok:false, reason:"exists", current_hash}
         (current_hash lets the caller reload and retry as an edit instead).
      4. Otherwise `base_hash` must equal the file's CURRENT `worktree_file_hash()`
         (re-read fresh at write time, never a cached value) — a mismatch refuses
         the write as {ok:false, reason:"drift", current_hash}, the caller's cue to
         reload the latest content and re-apply its edit on top.
      5. On success, `write_worktree_file` performs the atomic write, and the
         response carries the NEW content_hash so the caller's next PUT has a
         fresh base_hash with no extra round trip.

    Local-binding only, gated by the SAME membership check as every GET in this
    module — this is a human UI action riding proxy trust (see module docstring)."""
    clean_path = (body.path or "").strip("/")
    if not clean_path or not local_git._safe_rel_path(clean_path) or local_git._is_git_internal_path(clean_path):
        raise HTTPException(400, f"path {body.path!r} is not a safe repository-relative path")
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
        _require_write_actor(cur, cid, request)
    if not is_local:
        return degrade
    encoded = body.content.encode("utf-8", errors="ignore")
    if len(encoded) > WORKTREE_FILE_WRITE_MAX_BYTES:
        return {"available": True, "ok": False, "reason": "too_large"}
    current_hash = local_git.worktree_file_hash(clean_path)
    if body.base_hash is None:
        if current_hash is not None:
            return {"available": True, "ok": False, "reason": "exists", "current_hash": current_hash}
    elif body.base_hash != current_hash:
        return {"available": True, "ok": False, "reason": "drift", "current_hash": current_hash}
    if not local_git.write_worktree_file(clean_path, encoded):
        return {"available": True, "ok": False, "reason": "write_failed"}
    new_hash = local_git.worktree_file_hash(clean_path)
    _cache_invalidate(cid)
    return {"available": True, "ok": True, "content_hash": new_hash}


@app.post("/api/containers/{cid}/code/worktree/commit")
def post_worktree_commit(cid: str, body: WorktreeCommitCreate, request: Request):
    """`git add -A -- <paths>` + `git commit -m <message>` over the local working
    tree. `paths` (non-empty) and `message` (non-blank) are validated as a 400 bad
    request (a caller that sends neither has a client bug, not a degrade-worthy
    git-level failure); each path is additionally checked with the same
    `_safe_rel_path` safety gate every write in this module uses — a single unsafe
    path 400s the WHOLE request rather than silently skipping it.

    `author_name`/`author_email`, when BOTH given, become a one-off `-c
    user.name=/user.email=` override on the commit (see
    `local_git.stage_and_commit`'s docstring) — the identity a human editing
    through the portal wants attributed, even on a box with no git identity
    configured. Returns {ok:true, sha, short} on success, or
    {ok:false, reason:"nothing_committed"} when there was nothing staged to commit
    (the honest, distinct-from-error case: the caller asked to commit paths that
    turned out to have no changes). Local-binding only, same membership gate as
    every GET in this module."""
    clean_paths = []
    for p in body.paths:
        clean = (p or "").strip("/")
        if not clean or not local_git._safe_rel_path(clean) or local_git._is_git_internal_path(clean):
            raise HTTPException(400, f"path {p!r} is not a safe repository-relative path")
        clean_paths.append(clean)
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(400, "message must not be blank")
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
        _require_write_actor(cur, cid, request)
    if not is_local:
        return degrade
    result = local_git.stage_and_commit(
        clean_paths, message, author_name=body.author_name, author_email=body.author_email)
    if result is None:
        return {"available": True, "ok": False, "reason": "nothing_committed"}
    _cache_invalidate(cid)
    # A commit moves HEAD — drop the browse module's 5s resolved-ref micro-cache
    # so the very next browse shows the new tree, not a stale sha's.
    from portal_backend.github_repo_browse_routes import _LOCAL_REF_CACHE
    _LOCAL_REF_CACHE.clear()
    return {"available": True, "ok": True, "sha": result["sha"], "short": result["short"]}


@app.post("/api/containers/{cid}/code/worktree/push")
def post_worktree_push(cid: str, request: Request):
    """`git push origin HEAD` — pushes the current branch to its upstream on
    `origin`. A thin passthrough over `local_git.push_current_branch()`: that
    function already never raises, always returning {"ok","detail"}, so this route
    adds only the membership gate + local-vs-github dispatch every other route in
    this module has. Local-binding only."""
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
        _require_write_actor(cur, cid, request)
    if not is_local:
        return degrade
    result = local_git.push_current_branch()
    _cache_invalidate(cid)
    return {"available": True, "ok": result["ok"], "detail": result["detail"]}


@app.get("/api/containers/{cid}/code/worktree/branch")
def get_worktree_branch(cid: str, request: Request):
    """The editor's status-strip summary: current branch, head sha, ahead/behind
    counts against the upstream, and the `origin` remote URL — a thin passthrough
    over `local_git.branch_info()`. Returns
    {available, branch, sha, ahead, behind, remote} on success; `ahead`/`behind`
    are `null` (not 0) when there is no upstream configured (see
    `local_git.branch_info`'s own docstring for why 0 would be a false claim).
    {available:false, reason:"not_found"} on the rare case the repo itself has no
    commits yet (an empty repo has no branch/head to report). Local-binding only."""
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        return degrade
    cached = _cache_get("branch", cid, _BRANCH_TTL_SECONDS, refresh=_compute_branch)
    if cached is not None:
        return cached
    payload = _compute_branch()
    if payload.get("available"):
        return _cache_put("branch", cid, payload)
    return payload


def _compute_branch() -> dict:
    info = local_git.branch_info()
    if info is None:
        return {
            "available": False, "reason": "not_found",
            "detail": "the local repository has no commits yet",
        }
    return {
        "available": True, "branch": info["branch"], "sha": info["sha"],
        "ahead": info["ahead"], "behind": info["behind"], "remote": info["remote"],
    }


@app.get("/api/containers/{cid}/code/worktree/available")
def get_worktree_available(cid: str, request: Request):
    """The CHEAP yes/no the Code Space page needs on mount: "is this a local-binding
    container with a usable working tree?" — binding lookup + `local_git.available()`
    (env dir + git binary present), NO git subprocess against the tree. The page's
    edit/History gating used to probe /worktree/changes for this, which runs a full
    `git status` + per-file untracked numstat — seconds on a large repo over a
    Docker-for-Mac bind mount, serialized on every mount/tab switch. Same membership
    gate + github_source degrade as every other route in this module."""
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        return degrade
    ok = local_git.available()
    if ok and _cache_get("changes", cid, _CHANGES_TTL_SECONDS, refresh=None) is None:
        _spawn_refresh("changes", cid, _compute_changes)
    return {"available": ok}


def prewarm_worktree(cids) -> None:
    """Startup/periodic warm hook (called from code_space_routes' background
    warmer thread, NEVER a request path): kicks the single-flight changes scan
    for every local-bound cid so the Changes tab's first open is served from
    cache instead of showing the scanning state."""
    for cid in cids:
        if _cache_get("changes", cid, _CHANGES_TTL_SECONDS, refresh=None) is None:
            _spawn_refresh("changes", cid, _compute_changes)
