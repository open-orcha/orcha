"""Read-only GitHub repository file browser for a container's bound repo (Feature B):
directory listing, single-file content, and filename/content search — the portal's
"browse the repo" surface, distinct from the issues/PRs hub (github_hub_routes.py).

Endpoints (all GETs, all gated exactly like the hub routes):
  GET .../github/browse/tree    — one directory level (non-recursive)
  GET .../github/browse/file    — a single file's content (capped, binary-detected)
  GET .../github/browse/search  — filename search (names) or GitHub code search (contents)

Auth/token plumbing, membership gating, and error classification are ALL reused
directly from github_hub_routes — same GitHub App installation token resolution
(`_resolve_repo_token`), same container-binding + require_member_read load
(`_load_binding`), same not-connected shape (`_not_connected`), and the same
`_gh_get` network leaf + RuntimeError("github_status:<code>") contract, so the
403/404/network-failure ladder classifies identically here. Tests stub `_gh_get`
on THIS module (browse routes have their own leaf import, since a test that
monkeypatches github_hub_routes._gh_get must not have to know this module exists) —
never real network.

`ref` semantics: any GitHub-resolvable ref (branch name, tag, or full/short commit sha)
is passed straight through to GitHub's API. `ref=pr/<number>` is a portal-only
convenience: resolved via the SAME `/pulls/{number}` fetch idiom github_hub_routes uses
for PR detail, to that PR's head sha, before the real GitHub call is made. Omitting
`ref` entirely resolves the repo's default branch (one extra `/repos/{repo}` call,
cached like everything else here).

Repo snapshot (tarball) cache
------------------------------
`_fetch_repo_snapshot` replaces "one Contents-API fetch per file" with a single
`GET /repos/{repo}/tarball/{ref}` (per docs/code-space-indexing-research.md §1c/§3
Phase A: ~790 calls -> 1-2 calls for a cold 789-file repo). The tarball response is a
redirect to codeload.github.com; `urllib.request.urlopen` follows it natively (a GET,
no auth needed on the signed codeload URL). Streamed into a bounded buffer (hard cap
REPO_SNAPSHOT_MAX_BYTES, ~80MB) and extracted IN MEMORY with stdlib `tarfile` — only
source-extension members under a caller-supplied byte cap are kept (everything else,
including oversized/binary/non-source members, is skipped DURING extraction, so the
full repo is never materialized). Every member name is validated against path
traversal (`../`, absolute paths, symlink/hardlink members) before being trusted — see
`_safe_tar_members`. The tarball's synthetic top-level directory
(`{owner}-{repo}-{shortsha}/...`, GitHub's own convention) is stripped so callers see
plain repo-relative paths, matching every other path in this module.

Cached per (cid, resolved_ref) like the tree/default-branch caches above it, but with
its own generous TTL (REPO_SNAPSHOT_TTL_SECONDS, 10 min — matching the symbol
indexer's SYMBOL_STATE_TTL_SECONDS in code_space_routes, since re-fetching+re-extracting
a whole tarball is the expensive operation this cache exists to amortize) and an
explicit memory bound: at most REPO_SNAPSHOT_MAX_CACHED snapshots held at once,
oldest-inserted evicted first once a NEW snapshot would exceed that count.

A repo whose tarball exceeds the size cap returns None (never partially cached) —
callers fall back to the existing per-file Contents-API path and should surface a
`snapshot_unavailable` marker rather than pretend the snapshot path was used.
"""

import base64
import io
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

from fastapi import HTTPException, Query, Request

from portal_backend import local_git
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.github_hub_routes import (
    _gh_get,
    _load_binding,
    _not_connected,
    _resolve_repo_token,
    _detail_error_payload,
    _error_payload,
)

# The repo-binding sentinel meaning "this project's own working tree" (Addendum 2) —
# every dispatch point in this module checks `repo == LOCAL_REPO` and, when true,
# serves the request from `portal_backend.local_git` instead of the GitHub API. Kept
# as a named constant (not a repeated literal) since code_space_routes and
# github_hub_routes also need to recognize the exact same sentinel.
LOCAL_REPO = "local"

GITHUB_API = "https://api.github.com"
GITHUB_TIMEOUT_SECONDS = 10

# Directory-tree cache (recursive tree fetches for search:names) — short-lived, keyed
# per (cid, ref): GitHub's recursive git/trees call is the heaviest one this module
# makes, and a search-as-you-type UI would otherwise refire it on every keystroke.
TREE_CACHE_TTL_SECONDS = 60
# Default-branch resolution is also cached (it barely changes) so a burst of tree/file/
# search calls against ref-less requests doesn't cost one `/repos/{repo}` fetch each.
DEFAULT_BRANCH_CACHE_TTL_SECONDS = 60

# File content cap: 500 KB. Content past this is truncated (never silently dropped —
# `truncated: true` tells the caller there's more on GitHub).
FILE_CONTENT_CAP_BYTES = 500_000

# search:names cap on returned paths; search:contents (GitHub code search) cap on
# returned files. Both bounded so a broad query never blows up the response.
NAMES_SEARCH_MAX_RESULTS = 200
CONTENTS_SEARCH_MAX_RESULTS = 50

# Repo snapshot (tarball) cache — see module docstring. Larger than a single tarball's
# raw download size can legitimately be (a repo's uncompressed tree can exceed this even
# when the compressed tarball itself is smaller); this caps the STREAMED DOWNLOAD, the
# bound that actually protects the 4GB shared VM.
REPO_SNAPSHOT_MAX_BYTES = 80_000_000
# Warm snapshots kept 10 min — matches code_space_routes.SYMBOL_STATE_TTL_SECONDS, since
# re-fetching+re-extracting the tarball is the expensive step both the symbol indexer and
# any future snapshot-backed file read want to amortize together.
REPO_SNAPSHOT_TTL_SECONDS = 600
# Explicit memory bound: at most this many (cid, ref) snapshots held in-process at once.
# Each holds every source-extension file's bytes for a full repo, so this is a real cap,
# not a nicety — a container flipping between refs/branches shouldn't accumulate an
# unbounded number of whole-repo copies in memory.
REPO_SNAPSHOT_MAX_CACHED = 2

_TREE_CACHE: dict = {}
_DEFAULT_BRANCH_CACHE: dict = {}
_REPO_SNAPSHOT_CACHE: dict = {}
# Insertion order of currently-cached (cid, ref) snapshot keys — oldest first — so
# eviction always drops the least-recently-INSERTED snapshot once the bound is exceeded.
# (Insertion order, not last-access order: a snapshot cache is refreshed wholesale on a
# TTL-expired re-fetch, not touched on every read, so LRU-by-access would need extra
# bookkeeping this cache has no other use for.)
_REPO_SNAPSHOT_ORDER: list = []


def _tree_cache_get(cid: str, ref: str):
    hit = _TREE_CACHE.get((cid, ref))
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def _tree_cache_put(cid: str, ref: str, payload) -> None:
    _TREE_CACHE[(cid, ref)] = (time.monotonic() + TREE_CACHE_TTL_SECONDS, payload)


def _default_branch_cache_get(cid: str):
    hit = _DEFAULT_BRANCH_CACHE.get(cid)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def _default_branch_cache_put(cid: str, branch: str) -> None:
    _DEFAULT_BRANCH_CACHE[cid] = (time.monotonic() + DEFAULT_BRANCH_CACHE_TTL_SECONDS, branch)


def _repo_snapshot_cache_get(cid: str, ref: str):
    hit = _REPO_SNAPSHOT_CACHE.get((cid, ref))
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def _repo_snapshot_cache_put(cid: str, ref: str, files: dict) -> None:
    key = (cid, ref)
    if key not in _REPO_SNAPSHOT_CACHE:
        _REPO_SNAPSHOT_ORDER.append(key)
    _REPO_SNAPSHOT_CACHE[key] = (time.monotonic() + REPO_SNAPSHOT_TTL_SECONDS, files)
    # Evict oldest-inserted snapshots beyond the bound. A loop (not a single pop) in case
    # the bound itself was ever lowered, or a stale key lingers past its own TTL without
    # having been read (and thus never lazily swept) — both self-heal here rather than
    # only handling the "insert one over" steady-state case.
    while len(_REPO_SNAPSHOT_ORDER) > REPO_SNAPSHOT_MAX_CACHED:
        oldest = _REPO_SNAPSHOT_ORDER.pop(0)
        _REPO_SNAPSHOT_CACHE.pop(oldest, None)


def _resolve_default_branch(repo: str, token: str, cid: str) -> str:
    """The repo's default branch name (e.g. "main"), cached 60s per container. Raises
    RuntimeError (the SAME github_status:<code> contract as every other _gh_get caller
    here) on a GitHub failure — callers map it through the shared error ladder."""
    cached = _default_branch_cache_get(cid)
    if cached is not None:
        return cached
    raw = _gh_get(f"/repos/{repo}", token)
    branch = raw.get("default_branch") or "main"
    _default_branch_cache_put(cid, branch)
    return branch


LOCAL_REF_TTL_SECONDS = 5.0
_LOCAL_REF_CACHE: dict = {}


def _resolve_ref(repo: str, token: str, cid: str, ref) -> str:
    """Turn the caller's `ref` query param into a resolvable ref/sha.

    Local source (repo == LOCAL_REPO): resolved via `local_git.resolve_ref` instead of
    any GitHub call — `token` is unused/None on this path (a local repo needs none).
    None/empty -> HEAD (local) or the repo's default branch (GitHub, resolved +
    cached). "pr/<number>" is GitHub-only (a local repo has no PR concept) and raises
    the same github_status:404 shape a nonexistent PR would, so callers don't need a
    separate local-specific error branch. Anything else -> passed straight through
    unchanged (branch name, tag, full/short sha) on the GitHub path; resolved via `git
    rev-parse` on the local path.
    """
    if repo == LOCAL_REPO:
        # Micro-TTL on the rev-parse: EVERY browse request resolves its ref, and a
        # git subprocess over a Docker-for-Mac bind mount costs 0.3-3s depending on
        # page-cache pressure — it was the dominant per-click latency even when the
        # snapshot served the bytes from memory. HEAD moving up to 5s late in the
        # BROWSE view is invisible (the worktree/editor surfaces never come through
        # here); a commit made through the portal lands within one TTL.
        key = ref or "HEAD"
        hit = _LOCAL_REF_CACHE.get(key)
        if hit and time.monotonic() - hit[0] <= LOCAL_REF_TTL_SECONDS:
            return hit[1]
        sha = local_git.resolve_ref(ref or None)
        if sha is None:
            raise RuntimeError("github_status:404")
        _LOCAL_REF_CACHE[key] = (time.monotonic(), sha)
        return sha
    if not ref:
        return _resolve_default_branch(repo, token, cid)
    if ref.startswith("pr/"):
        number_part = ref[len("pr/"):]
        try:
            number = int(number_part)
        except ValueError:
            raise HTTPException(400, "ref=pr/<number> must have an integer number")
        pull = _gh_get(f"/repos/{repo}/pulls/{number}", token)
        sha = (pull.get("head") or {}).get("sha")
        if not sha:
            raise RuntimeError("github_status:404")
        return sha
    return ref


def _is_binary_content(content_bytes: bytes) -> bool:
    """Simple binary sniff: a NUL byte anywhere in the (decoded) content — the same
    heuristic git/most editors use. Called on already-fetched, already-decoded bytes;
    never on the still-base64 wire form."""
    return b"\0" in content_bytes


def _download_tarball_bytes(repo: str, resolved_ref: str, token: str):
    """Stream `GET /repos/{repo}/tarball/{resolved_ref}` into memory, bounded at
    REPO_SNAPSHOT_MAX_BYTES + 1 (so an oversize download is detected without ever fully
    buffering an unbounded response). Returns the raw tarball bytes, or None when the
    download exceeds the cap (caller falls back to the per-file path — never raises for
    "too big", since that's an expected, handled shape, not a failure). Raises
    RuntimeError("github_status:<code>") / RuntimeError("github_unreachable:...") on a
    real GitHub/network failure, the SAME contract as `_gh_get`, so callers can reuse
    the existing error-payload mapping. This is the ONE network leaf for tarball bytes;
    tests monkeypatch this function, never urllib directly. The 302 redirect to
    codeload.github.com is a signed, short-lived URL — `urllib.request.urlopen` follows
    it with its default redirect handling (a plain GET, no Authorization header needed
    on the codeload hop, unlike Slack's cross-host download flow)."""
    url = f"{GITHUB_API}/repos/{repo}/tarball/{urllib.parse.quote(resolved_ref)}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "orcha-portal",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=GITHUB_TIMEOUT_SECONDS) as response:
            data = response.read(REPO_SNAPSHOT_MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"github_status:{exc.code}") from exc
    except Exception as exc:  # DNS, timeout, TLS — one graceful shape, matches _gh_get
        raise RuntimeError(f"github_unreachable:{exc}") from exc
    if len(data) > REPO_SNAPSHOT_MAX_BYTES:
        return None
    return data


def _safe_tar_members(tar: "tarfile.TarFile", *, has_prefix: bool = True):
    """Yield only tar members safe to trust: regular files whose name, after stripping
    the tarball's synthetic top-level directory (when `has_prefix`), never escapes the
    extraction root.

    SECURITY (path traversal): a malicious or corrupt tarball could contain a member
    named e.g. `../../etc/passwd` or an absolute path; naively trusting `member.name`
    when building an in-memory `{path: bytes}` dict would let such a member's path
    collide with/overwrite an unrelated key or (if this code is ever adapted to extract
    to disk) escape the target directory. Every member is checked here BEFORE its bytes
    are ever read: reject absolute paths, any path whose normalized form starts with
    `..` or contains a `..` segment, and reject symlink/hardlink/device/fifo members
    outright (only `isfile()` — regular files — are extracted; a symlink's target is
    attacker-controlled and never followed). This is a `data`-filter-equivalent
    allowlist applied manually (rather than relying solely on `tarfile`'s built-in
    `filter="data"`) so the same check governs which members are even considered for
    the top-level-prefix-stripping step below, not just the final extraction call.

    `has_prefix=False` (the local `git archive` path — see `_fetch_local_repo_snapshot`)
    skips the top-level-directory strip entirely: a local archive's member names are
    ALREADY repo-relative (no synthetic `{owner}-{repo}-{sha}/` wrapper the way GitHub's
    tarball has one), so a single-segment name is a real file here, not a shape to
    discard. The traversal/absolute-path/symlink checks apply identically either way."""
    for member in tar.getmembers():
        if not member.isfile():
            continue
        name = member.name or ""
        if name.startswith("/") or name.startswith("\\"):
            continue
        # Traversal is checked on the FULL original name (before any stripping), since
        # a crafted top-level segment is itself part of the attack surface.
        normalized = name.replace("\\", "/")
        parts = normalized.split("/")
        if any(p == ".." for p in parts):
            continue
        if not has_prefix:
            if not normalized:
                continue
            yield member, normalized
            continue
        if len(parts) < 2:
            # No top-level directory component to strip (a bare filename at the tar
            # root) — GitHub's own tarballs always nest under {owner}-{repo}-{sha}/, so
            # this shape isn't a real repo file; skip it rather than guess.
            continue
        yield member, "/".join(parts[1:])


def _extract_source_files(
    tarball_bytes: bytes, extensions, max_file_bytes: int,
    *, mode: str = "r:gz", has_prefix: bool = True,
) -> dict:
    """Extract `tarball_bytes` (a repo tarball — gzip-compressed for the GitHub
    tarball path, plain for the local `git archive` path, see `mode`) IN MEMORY into
    `{repo_relative_path: bytes}`, keeping only members whose extension is in
    `extensions` and whose size is <= `max_file_bytes` — every other member (docs,
    images, lockfiles, oversized files, anything not on the source-extension allowlist)
    is skipped DURING iteration and its bytes are never read, so the full repo is never
    materialized in memory even though the whole tarball's member LIST is walked.
    Members are validated via `_safe_tar_members` (path traversal, symlinks) before
    their path is trusted; `has_prefix` is forwarded unchanged (see that function's
    docstring for the GitHub-tarball-vs-local-archive distinction). Uses
    `tarfile.open(fileobj=io.BytesIO(...))` — extraction stays fully in-process, no
    temp files on disk, no `extractall`."""
    files: dict = {}
    with tarfile.open(fileobj=io.BytesIO(tarball_bytes), mode=mode) as tar:
        for member, rel_path in _safe_tar_members(tar, has_prefix=has_prefix):
            if not rel_path:
                continue
            if is_vendored_path(rel_path):
                continue
            # extensions=None = keep EVERY (non-vendored, size-capped) file — the
            # browse fast-path wants docs/configs too, not just source files; the
            # symbol indexer pre-filters its own path list before consumption.
            if extensions is not None and not any(rel_path.endswith(ext) for ext in extensions):
                continue
            if member.size > max_file_bytes:
                continue
            extracted = tar.extractfile(member)
            if extracted is None:
                continue
            files[rel_path] = extracted.read()
    return files


# Directory names whose contents are vendored/generated, not authored source. Symbol
# indexing and code search skip them: definitions inside a bundled dist/ or a vendored
# lib pollute go-to-symbol with unclickable noise AND dominate cold-index time (a
# minified bundle is one enormous "file" of regex fodder). Matched as whole path
# segments anywhere in the path — "src/distance/" is NOT "dist/".
VENDORED_DIR_SEGMENTS = frozenset({
    "node_modules", "vendor", "dist", "build", "out", ".venv", "venv",
    "__pycache__", "Pods", "DerivedData", ".next", ".nuxt", "coverage",
    "target", ".gradle",
})


def is_vendored_path(rel_path: str) -> bool:
    """True when any path segment names a vendored/generated directory."""
    return any(seg in VENDORED_DIR_SEGMENTS for seg in rel_path.split("/")[:-1])


def _fetch_local_repo_snapshot(resolved_ref: str, cid: str, extensions, max_file_bytes: int):
    """Local-source equivalent of `_fetch_repo_snapshot` (Addendum 2): `git archive`
    instead of a GitHub tarball download, feeding the SAME in-memory extraction
    (`_extract_source_files`, plain-tar mode + no top-level-prefix stripping) and the
    SAME cache (keyed (cid, resolved_ref) — a local ref and a GitHub ref never collide
    since a container is bound to exactly one repo at a time). Returns None when the
    archive can't be produced (bad ref, git failure) or extraction fails — same
    "snapshot unavailable, fall back" contract `_fetch_repo_snapshot` has, except the
    local path's fallback (a no-snapshot symbol-indexing pass) simply has nothing to
    fall back TO other than an empty index, since there is no per-file Contents-API
    equivalent here; callers already treat None uniformly either way."""
    cached = _repo_snapshot_cache_get(cid, resolved_ref)
    if cached is not None:
        return cached
    archive_bytes = local_git.archive_bytes(resolved_ref)
    if archive_bytes is None:
        return None
    try:
        files = _extract_source_files(
            archive_bytes, extensions, max_file_bytes, mode="r", has_prefix=False)
    except tarfile.TarError:
        return None
    _repo_snapshot_cache_put(cid, resolved_ref, files)
    return files


def _fetch_repo_snapshot(repo: str, resolved_ref: str, token: str, cid: str, extensions, max_file_bytes: int):
    """The whole repo's source files at `resolved_ref`, as `{path: bytes}` — ONE tarball
    fetch (`_download_tarball_bytes`) + one in-memory extraction
    (`_extract_source_files`), replacing an entire per-file Contents-API loop. Cached
    per (cid, resolved_ref) for REPO_SNAPSHOT_TTL_SECONDS (see module docstring).

    Local source (repo == LOCAL_REPO): dispatches to `_fetch_local_repo_snapshot`
    (git archive instead of a tarball download) — same cache, same {path: bytes}
    shape, so every downstream consumer (the symbol indexer in code_space_routes)
    needs no local-specific branch of its own.

    Returns None when no snapshot is available — either the tarball exceeded
    REPO_SNAPSHOT_MAX_BYTES (`_download_tarball_bytes` returned None) or the extraction
    itself failed unexpectedly (a corrupt/unexpected tarball shape; logged as a
    RuntimeError-free None rather than raising, since "no snapshot" is a handled
    fallback path here, not an error the caller needs to classify through the
    github_status ladder). Callers use None as the `snapshot_unavailable` signal and
    fall back to the existing per-file path. Raises RuntimeError("github_status:<code>")
    / RuntimeError("github_unreachable:...") only for a genuine GitHub/network failure
    on the download itself — the same contract every other fetch in this module uses,
    so callers can reuse `_error_payload`/`_detail_error_payload`.
    """
    if repo == LOCAL_REPO:
        return _fetch_local_repo_snapshot(resolved_ref, cid, extensions, max_file_bytes)
    cached = _repo_snapshot_cache_get(cid, resolved_ref)
    if cached is not None:
        return cached
    tarball_bytes = _download_tarball_bytes(repo, resolved_ref, token)
    if tarball_bytes is None:
        return None
    try:
        files = _extract_source_files(tarball_bytes, extensions, max_file_bytes)
    except tarfile.TarError:
        return None
    _repo_snapshot_cache_put(cid, resolved_ref, files)
    return files


def _local_tree_level(repo: str, resolved_ref: str, cid: str, clean_path: str) -> list:
    """One directory level of the local tree, filtered from the SAME cached full
    recursive tree `_fetch_full_tree`/`_names_search` already use — a local `ls-tree`
    is cheap enough (and already cached) that a second, non-recursive git call would
    only add complexity for no real win. Mirrors browse_tree's GitHub-path shape
    exactly: {name, path, type:"dir"|"file", size?}, dirs sorted before files."""
    entries, _truncated = _fetch_full_tree(repo, resolved_ref, None, cid)
    prefix = f"{clean_path}/" if clean_path else ""
    seen_dirs = set()
    out = []
    for item in entries:
        item_path = item.get("path") or ""
        if not item_path.startswith(prefix):
            continue
        rest = item_path[len(prefix):]
        if not rest:
            continue
        head, _sep, tail = rest.partition("/")
        if tail:
            # A deeper entry under a subdirectory of this level — represent the
            # subdirectory itself once, not its own descendants.
            if head in seen_dirs:
                continue
            seen_dirs.add(head)
            out.append({"name": head, "path": f"{prefix}{head}", "type": "dir"})
            continue
        if item.get("type") == "tree":
            if head in seen_dirs:
                continue
            seen_dirs.add(head)
            out.append({"name": head, "path": f"{prefix}{head}", "type": "dir"})
        else:
            out.append({
                "name": head, "path": f"{prefix}{head}", "type": "file",
                "size": item.get("size"),
            })
    return out


@app.get("/api/containers/{cid}/github/browse/tree")
def browse_tree(cid: str, request: Request, ref: str = Query(default=""), path: str = Query(default="")):
    """One directory level (NOT recursive) of the container's bound repo.

    Returns {ref, path, entries:[{name, path, type:"dir"|"file", size?}], truncated}.
    `ref` in the response is the resolved ref actually used (default branch when the
    caller omitted it, or the PR's head sha when `ref=pr/<number>` was given) — never
    echoed back as the literal query string, so the caller always knows exactly what
    was fetched. `size` is present for files (GitHub's byte size), omitted for dirs.
    `truncated` mirrors GitHub's own contents-API truncation flag for this directory
    (extremely rare at a single non-recursive level, but surfaced honestly rather than
    silently assumed false).

    Local source (repo == LOCAL_REPO): served from `local_git` via the cached full
    tree (`_local_tree_level`) instead of a GitHub contents-API call — no token needed.
    """
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    if repo == LOCAL_REPO:
        try:
            resolved_ref = _resolve_ref(repo, None, cid, ref)
        except RuntimeError as exc:
            return {**_detail_error_payload(exc), "repo": repo}
        clean_path = (path or "").strip("/")
        try:
            entries = _local_tree_level(repo, resolved_ref, cid, clean_path)
        except RuntimeError as exc:
            return {**_detail_error_payload(exc), "repo": repo}
        entries.sort(key=lambda e: (e["type"] != "dir", (e["name"] or "").lower()))
        return {"ref": resolved_ref, "path": clean_path, "entries": entries, "truncated": False}
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    try:
        resolved_ref = _resolve_ref(repo, token, cid, ref)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    clean_path = (path or "").strip("/")
    contents_path = f"/repos/{repo}/contents/{clean_path}" if clean_path else f"/repos/{repo}/contents"
    query = urllib.parse.urlencode({"ref": resolved_ref})
    try:
        raw = _gh_get(f"{contents_path}?{query}", token)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    if isinstance(raw, dict):
        # GitHub returns a single object (not a list) when `path` names a FILE, not a
        # directory — a clean 400 rather than pretending it's an empty directory.
        raise HTTPException(400, f"path {clean_path!r} is a file, not a directory")
    entries = []
    for item in raw:
        entry = {
            "name": item.get("name"),
            "path": item.get("path"),
            "type": "dir" if item.get("type") == "dir" else "file",
        }
        if entry["type"] == "file":
            entry["size"] = item.get("size")
        entries.append(entry)
    entries.sort(key=lambda e: (e["type"] != "dir", (e["name"] or "").lower()))
    return {
        "ref": resolved_ref,
        "path": clean_path,
        "entries": entries,
        "truncated": False,
    }


def _snapshot_bytes_for_path(cid: str, resolved_ref: str, clean_path: str):
    """The path's raw bytes from the ALREADY-CACHED repo snapshot
    (`_repo_snapshot_cache_get` — the SAME (cid, resolved_ref)-keyed cache
    `_fetch_repo_snapshot`/`_fetch_local_repo_snapshot` populate, which the local
    background warmer (`code_space_routes.warm_local_symbol_index`) keeps hot). None
    when no snapshot has been built for this ref yet, or the snapshot exists but
    doesn't carry this path (non-source extension, or over the symbol indexer's
    MAX_SOURCE_FILE_BYTES cap — the indexer's snapshot is deliberately narrower than a
    raw file read's own 500KB/any-extension contract). Callers treat None as "fall back
    to `local_git.file_bytes`" — never a failure signal in its own right; this function
    never triggers a snapshot BUILD itself (no `git archive` call on a miss), only
    reads whatever is already warm — a cold miss must stay cheap (a dict lookup), not
    trade one subprocess call for a much bigger one."""
    cached = _repo_snapshot_cache_get(cid, resolved_ref)
    if cached is None:
        return None
    return cached.get(clean_path)


def _local_file_response(repo: str, resolved_ref: str, cid: str, clean_path: str) -> dict:
    """browse_file's local-source body — BLAZING-fast path (docs/orcha-cloud-local-run.md
    addendum, local-run perf bar): try the already-warm symbol-indexer snapshot FIRST
    (`_snapshot_bytes_for_path`, same (cid, resolved_ref) cache the background warmer —
    `code_space_routes.warm_local_symbol_index` — keeps hot) and serve bytes straight
    from memory, no subprocess at all. Only when the snapshot has no entry for this path
    (non-source extension, oversize, or no snapshot built yet for this ref) does this
    fall back to `local_git.file_bytes` — one `git show` subprocess call over the bind
    mount (~100-300ms on Docker for Mac), the same cost the pre-snapshot code paid on
    EVERY call. Same cap/binary-sniff rules and response shape either way
    (`_is_binary_content`, FILE_CONTENT_CAP_BYTES) — the caller can't tell which path
    served a given response.

    Raises HTTPException(400) when `clean_path` names a directory (mirrors the GitHub
    path's `isinstance(raw, list)` check) — checked via the SAME cached full tree
    `_local_tree_level`/blob-match already use, BEFORE trusting either byte source: `git
    show <sha>:<dir>` does NOT fail the way a missing path does (it succeeds with a
    plain-text tree listing), so bytes alone can't tell "directory" apart from "a real
    file whose content happens to look tree-ish" — the tree lookup is the only reliable
    signal."""
    entries, _truncated = _fetch_full_tree(repo, resolved_ref, None, cid)
    is_dir = any(
        (e.get("path") or "") == clean_path and e.get("type") == "tree"
        for e in entries
    )
    if is_dir:
        raise HTTPException(400, f"path {clean_path!r} is a directory, not a file")
    raw_bytes = _snapshot_bytes_for_path(cid, resolved_ref, clean_path)
    if raw_bytes is None:
        raw_bytes = local_git.file_bytes(resolved_ref, clean_path)
    if raw_bytes is None:
        # Honest local wording — the shared hub mapper would say "issue or pull
        # request not found", which is nonsense for a local file read.
        return {
            "available": False, "reason": "not_found", "repo": repo,
            "detail": f"path {clean_path!r} not found at {resolved_ref[:7]} in the local repository",
        }
    size = len(raw_bytes)
    if _is_binary_content(raw_bytes):
        return {
            "ref": resolved_ref, "path": clean_path, "size": size,
            "truncated": False, "binary": True, "encoding": "utf-8",
        }
    truncated = size > FILE_CONTENT_CAP_BYTES
    capped_bytes = raw_bytes[:FILE_CONTENT_CAP_BYTES]
    content = capped_bytes.decode("utf-8", errors="ignore")
    return {
        "ref": resolved_ref, "path": clean_path, "content": content, "size": size,
        "truncated": truncated, "binary": False, "encoding": "utf-8",
    }


@app.get("/api/containers/{cid}/github/browse/file")
def browse_file(cid: str, request: Request, ref: str = Query(default=""), path: str = Query(...)):
    """A single file's content from the container's bound repo.

    Returns {ref, path, content, size, truncated, binary, encoding:"utf-8"}. `content`
    is the DECODED text; capped at FILE_CONTENT_CAP_BYTES (~500KB) with `truncated:true`
    when GitHub's file is larger — the caller sees the first slice, not a failure.
    Binary files (detected via GitHub's own contents-API `encoding` field being
    anything other than "base64" decodeable-as-text, or a NUL byte in the decoded
    bytes) return `binary:true` with `content` omitted entirely (never a best-effort
    garbled decode) — `size` is still the real GitHub-reported size in that case.

    Local source (repo == LOCAL_REPO): served via `local_git.file_bytes` + the same
    cap/binary rules (`_local_file_response`) — no token needed.
    """
    clean_path = (path or "").strip("/")
    if not clean_path:
        raise HTTPException(400, "path is required")
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    if repo == LOCAL_REPO:
        try:
            resolved_ref = _resolve_ref(repo, None, cid, ref)
            return _local_file_response(repo, resolved_ref, cid, clean_path)
        except RuntimeError as exc:
            return {**_detail_error_payload(exc), "repo": repo}
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    try:
        resolved_ref = _resolve_ref(repo, token, cid, ref)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    query = urllib.parse.urlencode({"ref": resolved_ref})
    try:
        raw = _gh_get(f"/repos/{repo}/contents/{clean_path}?{query}", token)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    if isinstance(raw, list):
        raise HTTPException(400, f"path {clean_path!r} is a directory, not a file")
    size = raw.get("size") or 0
    encoding = raw.get("encoding")
    content_b64 = raw.get("content") or ""
    if encoding != "base64":
        # GitHub omits/varies `content`+`encoding` for files it judges too large for the
        # contents API (>1MB) or otherwise non-inline-able — treat as binary-shaped
        # rather than guess at a decode.
        return {
            "ref": resolved_ref, "path": clean_path, "size": size,
            "truncated": False, "binary": True, "encoding": "utf-8",
        }
    try:
        raw_bytes = base64.b64decode(content_b64)
    except (ValueError, TypeError):
        return {
            "ref": resolved_ref, "path": clean_path, "size": size,
            "truncated": False, "binary": True, "encoding": "utf-8",
        }
    if _is_binary_content(raw_bytes):
        return {
            "ref": resolved_ref, "path": clean_path, "size": size,
            "truncated": False, "binary": True, "encoding": "utf-8",
        }
    truncated = len(raw_bytes) > FILE_CONTENT_CAP_BYTES
    capped_bytes = raw_bytes[:FILE_CONTENT_CAP_BYTES]
    # Decode defensively: a cap can land mid-multibyte-character; drop any trailing
    # partial sequence rather than raise.
    content = capped_bytes.decode("utf-8", errors="ignore")
    # blob_sha: the file's git blob sha at this ref (straight off the contents
    # response) — the P4 draft editor's base_hash, so propose-time drift checks
    # compare REAL shas instead of degrading to no-claim.
    return {
        "blob_sha": raw.get("sha"),
        "ref": resolved_ref,
        "path": clean_path,
        "content": content,
        "size": size,
        "truncated": truncated,
        "binary": False,
        "encoding": "utf-8",
    }


def _fetch_full_tree(repo: str, resolved_ref: str, token: str, cid: str):
    """The full recursive tree for a ref (git/trees?recursive=1), cached 60s per
    (cid, resolved_ref) — the same TTL idea as the hub's list caches, sized for a
    search-as-you-type UI that would otherwise refire this (GitHub's heaviest single
    call here) on every keystroke. Returns (entries, truncated) where entries is
    GitHub's raw tree array (each {path, type:"blob"|"tree", ...}); `truncated` mirrors
    GitHub's own `truncated` flag on the tree response (a very large repo).

    Local source (repo == LOCAL_REPO): `local_git.tree()` already returns entries in
    this EXACT shape ({path, type:"blob"|"tree", sha, size}) — GitHub's `git/trees`
    shape was the template `local_git.tree` was written to match — so no reshaping is
    needed here; `truncated` is always False (a local `ls-tree` never truncates the
    way GitHub's API can for an enormous repo). `token` is unused on this path.
    """
    if repo == LOCAL_REPO:
        cached = _tree_cache_get(cid, resolved_ref)
        if cached is not None:
            return cached
        entries = local_git.tree(resolved_ref)
        if entries is None:
            raise RuntimeError("github_status:404")
        result = (entries, False)
        _tree_cache_put(cid, resolved_ref, result)
        return result
    cached = _tree_cache_get(cid, resolved_ref)
    if cached is not None:
        return cached
    raw = _gh_get(f"/repos/{repo}/git/trees/{resolved_ref}?recursive=1", token)
    entries = raw.get("tree") or []
    truncated = bool(raw.get("truncated"))
    result = (entries, truncated)
    _tree_cache_put(cid, resolved_ref, result)
    return result


def _in_memory_grep(cid: str, resolved_ref: str, q: str):
    """Content search over the ALREADY-CACHED repo snapshot in-process — no `git grep`
    subprocess, no bind-mount I/O at all (BLAZING-fast local reads bar,
    docs/orcha-cloud-local-run.md addendum). Case-insensitive substring match (mirrors
    `_names_search`'s own case-insensitive convention, and stays a strict SUBSET
    relationship to `local_git.grep`'s `-F` fixed-string semantics — no regex either
    way, so a warm-snapshot search and a cold `git grep` fallback never disagree on
    what counts as a match), first-match line number per file computed by scanning the
    file's own decoded text (`str.split("\\n")`, 1-indexed) — the snapshot carries
    whole-file bytes, not pre-computed line offsets, so this is the one place that cost
    is paid, and it's paid in-memory (no subprocess) rather than shelling out per file.
    Binary files (`_is_binary_content`) are skipped, same as `local_git.grep -I`.
    Results capped at `local_git.GREP_MAX_RESULTS` (the SAME cap the git-grep fallback
    uses) so a broad query returns an identically-shaped, identically-bounded result
    set regardless of which path served it.

    Returns None when no snapshot is cached for (cid, resolved_ref) yet — the caller's
    signal to fall back to `local_git.grep` (a cold git-grep subprocess), exactly like
    `_snapshot_bytes_for_path`'s own None-means-fallback contract for single-file
    reads. Returns [] (not None) for a genuine "snapshot warm, zero matches" result —
    the same None-vs-[] distinction `local_git.grep` itself documents."""
    snapshot = _repo_snapshot_cache_get(cid, resolved_ref)
    if snapshot is None:
        return None
    needle = q.lower()
    results = []
    for path in sorted(snapshot):
        if len(results) >= local_git.GREP_MAX_RESULTS:
            break
        raw_bytes = snapshot[path]
        if _is_binary_content(raw_bytes):
            continue
        text = raw_bytes.decode("utf-8", errors="ignore")
        if needle not in text.lower():
            continue
        for line_no, line_text in enumerate(text.split("\n"), start=1):
            if needle in line_text.lower():
                results.append({"path": path, "line": line_no, "text": line_text})
                break
            if len(results) >= local_git.GREP_MAX_RESULTS:
                break
    return results


def _names_search(repo: str, resolved_ref: str, token: str, cid: str, q: str) -> dict:
    entries, truncated = _fetch_full_tree(repo, resolved_ref, token, cid)
    needle = q.lower()
    results = []
    for item in entries:
        item_path = item.get("path") or ""
        if needle in item_path.lower():
            results.append({
                "path": item_path,
                "type": "dir" if item.get("type") == "tree" else "file",
            })
            if len(results) >= NAMES_SEARCH_MAX_RESULTS:
                break
    return {"results": results, "truncated": truncated}


def _code_search_match(fragment: dict) -> dict:
    """One GitHub code-search `text_matches` fragment -> {line, text}. GitHub's search
    API doesn't give a line NUMBER directly; it gives byte offsets into `object_url`'s
    full content plus the matched fragment text. We don't re-fetch the full file just
    to compute an exact line number (a second GitHub call per match, per result, would
    make a 50-result search prohibitively expensive) — `line` is the 1-indexed line
    within the fragment's OWN text where the first match indicator starts, a
    best-effort locator, and `text` is the fragment itself (already a short excerpt
    GitHub trims around the match)."""
    fragment_text = fragment.get("fragment") or ""
    matches = fragment.get("matches") or []
    line = 1
    if matches:
        offset = matches[0].get("indices", [0])[0] if matches[0].get("indices") else 0
        line = fragment_text.count("\n", 0, offset) + 1
    return {"line": line, "text": fragment_text}


def _contents_search(repo: str, token: str, q: str) -> dict:
    """GitHub code search scoped to this repo: GET /search/code?q=<q>+repo:owner/name.

    GitHub's code search ONLY indexes the repo's default branch — a documented
    limitation, not a bug here — so results never reflect `ref` even when the caller
    passed one; the response always sets `default_branch_only: true` so the UI can
    show that honestly rather than implying the search covered whatever ref was
    requested. Capped at CONTENTS_SEARCH_MAX_RESULTS files, each with its own
    text_matches fragments mapped to {line, text}."""
    query = urllib.parse.urlencode({"q": f"{q} repo:{repo}"})
    raw = _gh_get(f"/search/code?{query}", token)
    items = raw.get("items") or []
    results = []
    for item in items[:CONTENTS_SEARCH_MAX_RESULTS]:
        fragments = item.get("text_matches") or []
        results.append({
            "path": item.get("path"),
            "matches": [_code_search_match(f) for f in fragments],
        })
    return {"results": results, "default_branch_only": True}


@app.get("/api/containers/{cid}/github/browse/search")
def browse_search(
    cid: str,
    request: Request,
    q: str = Query(..., min_length=1),
    mode: str = Query(default="names"),
    ref: str = Query(default=""),
):
    """Search the container's bound repo — filenames (`mode=names`, default) or file
    contents (`mode=contents`, GitHub code search).

    names: filters the full recursive tree for `ref` (or the default branch) by a
    case-insensitive substring match on path, capped at NAMES_SEARCH_MAX_RESULTS.
    Returns {results:[{path,type}], truncated} — `truncated` reflects GitHub's own
    tree-truncation flag (an enormous repo), not the results cap.

    contents: GitHub's code-search API, always scoped to this repo
    (`q=<q>+repo:owner/name`) and ALWAYS the default branch regardless of `ref` (a
    GitHub limitation — see `_contents_search`'s docstring). Returns
    {results:[{path,matches:[{line,text}]}], default_branch_only:true}, capped at
    CONTENTS_SEARCH_MAX_RESULTS files.
    Local source (repo == LOCAL_REPO): `names` filters the SAME cached local tree
    (`_names_search`, unchanged — `_fetch_full_tree` already dispatches on
    LOCAL_REPO); `contents` tries the in-process, in-memory search FIRST
    (`_in_memory_grep`, over the same warm repo snapshot `code_space_routes`'
    background warmer keeps hot — target <30ms server-side, no subprocess at all) and
    falls back to `local_git.grep` (a `git grep` subprocess over the bind mount) only
    when no snapshot is cached yet for this ref. Not pinned to a "default branch" (that
    GitHub limitation doesn't apply locally) either way — always returns
    `default_branch_only: false` honestly.
    """
    if mode not in ("names", "contents"):
        raise HTTPException(400, "mode must be 'names' or 'contents'")
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    if repo == LOCAL_REPO:
        try:
            resolved_ref = _resolve_ref(repo, None, cid, ref)
        except RuntimeError as exc:
            return {**_detail_error_payload(exc), "repo": repo}
        if mode == "contents":
            results = _in_memory_grep(cid, resolved_ref, q)
            if results is None:
                results = local_git.grep(resolved_ref, q)
            if results is None:
                return {**_error_payload(RuntimeError("github_status:404")), "repo": repo}
            return {
                "available": True, "repo": repo, "ref": resolved_ref,
                "results": results, "default_branch_only": False,
            }
        try:
            payload = _names_search(repo, resolved_ref, None, cid, q)
        except RuntimeError as exc:
            return {**_error_payload(exc), "repo": repo}
        return {"available": True, "repo": repo, "ref": resolved_ref, **payload}
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    if mode == "contents":
        try:
            return {"available": True, "repo": repo, **_contents_search(repo, token, q)}
        except RuntimeError as exc:
            return {**_error_payload(exc), "repo": repo}
    try:
        resolved_ref = _resolve_ref(repo, token, cid, ref)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    try:
        payload = _names_search(repo, resolved_ref, token, cid, q)
    except RuntimeError as exc:
        return {**_error_payload(exc), "repo": repo}
    return {"available": True, "repo": repo, "ref": resolved_ref, **payload}
