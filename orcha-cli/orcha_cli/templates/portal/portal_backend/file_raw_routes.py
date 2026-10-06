"""Raw file bytes for the portal's previews — images, PDF, video/audio, fonts.

Three read-only routes, each gated EXACTLY like the text route it sits beside:

  GET /api/containers/{cid}/github/browse/raw?ref=&path=      — the code viewer's file
      at a ref (local repo or GitHub). Same gate as /github/browse/file.
  GET /api/containers/{cid}/code/worktree/raw?path=&side=      — the Code tab's working
      tree (`side=working`, default) or HEAD (`side=head`): the two sides of an
      uncommitted change. Same gate as /code/worktree/diff.
  GET /api/agents/{aid}/runs/{rid}/changes/raw?path=&side=     — one side (`old` |
      `new`) of a file a run changed. Same gate as /changes/diff. A running run reads
      its own checkout (base commit vs working tree); a finished run rebuilds the file
      from its CAPTURED diff — the literal / delta hunks of a `GIT binary patch`, or the
      blob id in the section's `index <old>..<new>` header looked up in the run's own
      repository (never any other repo).

Paths must be repository-relative (no absolute paths, no `..`, no leading `-`), and a
working-tree read must stay inside the checkout after symlink resolution — 400
otherwise. Headers (file_preview.raw_response): a by-extension, magic-confirmed
Content-Type (text is always text/plain), `nosniff`, a sandbox CSP, `inline` only for
inert media (SVG is an attachment), and single-range support for `<video>` seeking.
Missing sides are 404, files over the preview cap 413.
"""

from __future__ import annotations

import base64
import os
import re
import urllib.parse

from fastapi import HTTPException, Query, Request

from portal_backend import file_preview, local_git
from portal_backend import run_changes_routes as rc
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.github_hub_routes import _gh_get, _load_binding, _resolve_repo_token
from portal_backend.github_repo_browse_routes import LOCAL_REPO, _resolve_ref

_OID_RE = re.compile(r"^[0-9a-f]{4,64}$")


def _clean_rel_path(path: str) -> str:
    clean = (path or "").strip()
    if not clean or "\x00" in clean or not local_git._safe_rel_path(clean):
        raise HTTPException(400, "path must be a repository-relative path (no absolute paths, no '..')")
    return clean.strip("/")


def _read_file_capped(full: str) -> bytes:
    try:
        if not os.path.isfile(full):
            raise HTTPException(404, "file not found")
        if os.path.getsize(full) > file_preview.RAW_MAX_BYTES:
            raise HTTPException(413, "file is larger than the preview cap")
        with open(full, "rb") as fh:
            return fh.read()
    except OSError:
        raise HTTPException(404, "file not readable")


# ---------------------------------------------------------------- code viewer (a ref)

def _github_bytes(repo: str, token: str, ref: str, path: str) -> bytes:
    query = urllib.parse.urlencode({"ref": ref})
    raw = _gh_get(f"/repos/{repo}/contents/{urllib.parse.quote(path)}?{query}", token)
    if isinstance(raw, list) or (raw or {}).get("type") not in (None, "file"):
        raise HTTPException(400, f"path {path!r} is not a file")
    if raw.get("encoding") == "base64" and raw.get("content"):
        return base64.b64decode(raw["content"])
    size = raw.get("size") or 0
    if size > file_preview.RAW_MAX_BYTES:
        raise HTTPException(413, "file is larger than the preview cap")
    sha = raw.get("sha")
    if not sha or not _OID_RE.match(sha):
        raise HTTPException(404, "file content unavailable")
    blob = _gh_get(f"/repos/{repo}/git/blobs/{sha}", token)  # the >1 MB path
    if blob.get("encoding") != "base64":
        raise HTTPException(404, "file content unavailable")
    return base64.b64decode(blob.get("content") or "")


@app.get("/api/containers/{cid}/github/browse/raw")
def browse_file_raw(
    cid: str, request: Request, ref: str = Query(default=""), path: str = Query(...),
    download: bool = Query(default=False),
):
    """The raw bytes of one file at `ref` in the project's bound repo (local or GitHub)
    — the code viewer's image / PDF / media / font preview and its Download link.
    Same access as GET /github/browse/file. 404 when the path doesn't exist at the ref,
    413 over the preview cap (50 MB)."""
    clean = _clean_rel_path(path)
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        raise HTTPException(404, "no repository is connected to this project")
    try:
        if repo == LOCAL_REPO:
            sha = _resolve_ref(repo, None, cid, ref)
            data = local_git._run(["cat-file", "blob", f"{sha}:{clean}"], binary=True)
            if data is None:
                raise HTTPException(404, f"{clean!r} not found at {sha[:7]}")
        else:
            token = _resolve_repo_token(repo, cid)
            if not token:
                raise HTTPException(404, "no GitHub token is available for this repository")
            data = _github_bytes(repo, token, _resolve_ref(repo, token, cid, ref), clean)
    except RuntimeError as exc:
        code = 404 if "github_status:404" in str(exc) else 502
        raise HTTPException(code, "the file could not be read from the repository")
    return file_preview.raw_response(request, data, clean, download=download)


# ---------------------------------------------------------------- Code tab working tree

@app.get("/api/containers/{cid}/code/worktree/raw")
def worktree_file_raw(
    cid: str, request: Request, path: str = Query(...),
    side: str = Query(default="working", pattern="^(working|head)$"),
    download: bool = Query(default=False),
):
    """One side of an uncommitted change in the project's local checkout: the file on
    disk now (`side=working`) or at HEAD (`side=head`). Local-binding only (404 for a
    GitHub-bound project). Same access as GET /code/worktree/diff."""
    clean = _clean_rel_path(path)
    from portal_backend.code_workingtree_routes import _require_local_binding

    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        raise HTTPException(404, (degrade or {}).get("detail") or "no local repository")
    if side == "head":
        data = local_git._run(["cat-file", "blob", f"HEAD:{clean}"], binary=True)
        if data is None:
            raise HTTPException(404, f"{clean!r} does not exist at HEAD")
    else:
        repo_dir = local_git._env_dir()
        full = local_git._contained_path(repo_dir, clean) if repo_dir else None
        if full is None:
            raise HTTPException(400, "path escapes the repository")
        data = _read_file_capped(full)
    return file_preview.raw_response(request, data, clean, download=download, cache="no-store")


# ---------------------------------------------------------------- a run's changes

def _run_object_store(run: dict):
    """`fetch(oid) -> bytes|None` over the run's OWN repository: its checkout (a linked
    worktree shares the base repo's objects), else its base checkout."""
    checkouts = []
    try:
        co, _root = rc._open_checkout(run)
        checkouts.append(co)
    except rc.Unavailable:
        pass
    base = run.get("base_cwd")
    if base and run.get("worktree"):
        try:
            local = rc._to_local(base, base)
            checkouts.append(rc.Checkout(local, rc._git_dir_for(local, base)))
        except rc.Unavailable:
            pass

    def fetch(oid: str):
        if not oid or not _OID_RE.match(oid):
            return None
        for co in checkouts:
            out = co.run(["cat-file", "blob", oid])
            if out is not None:
                return out
        return None

    return fetch


@app.get("/api/agents/{aid}/runs/{rid}/changes/raw")
def run_change_raw(
    aid: str, rid: str, request: Request, path: str = Query(...),
    side: str = Query(default="new", pattern="^(old|new)$"),
    download: bool = Query(default=False),
):
    """One side of a file the run changed: `old` (before the run) or `new` (after).
    `path` must be one of the run's changed files (the new path of a rename; `old`
    then reads the original path). Same access as GET /changes/diff. 404 when that
    side doesn't exist (the old side of an added file, the new side of a deleted one)
    or can't be rebuilt from what was recorded."""
    clean = _clean_rel_path(path)
    run = rc._load_run(aid, rid, request)
    payload = rc._payload(run)
    if not payload.get("available"):
        raise HTTPException(404, payload.get("detail") or "this run's changes are unavailable")
    match = next((f for f in payload["files"] if f["path"] == clean), None)
    if match is None:
        raise HTTPException(404, f"{clean!r} is not among this run's changed files")
    status = match.get("status")
    if side == "old" and status in ("A", "??"):
        raise HTTPException(404, "the file did not exist before the run")
    if side == "new" and status == "D":
        raise HTTPException(404, "the run deleted this file")
    src_path = (match.get("orig_path") or clean) if side == "old" else clean

    if payload["source"] == "captured":
        sec = next((s for s in rc._split_patch(run.get("diff") or "") if s["path"] == clean), None)
        if sec is None:
            raise HTTPException(404, "the recorded diff has no section for this file")
        data = file_preview.blob_from_section(sec["text"], side, _run_object_store(run))
        if data is None:
            raise HTTPException(404, "this version of the file wasn't recorded with the run's diff")
        return file_preview.raw_response(request, data, src_path, download=download,
                                         cache="private, max-age=3600")
    try:
        co, _root = rc._open_checkout(run)
    except rc.Unavailable as exc:
        raise HTTPException(404, exc.detail)
    if side == "old":
        base_sha = (payload.get("base") or {}).get("sha") or "HEAD"
        data = co.run(["cat-file", "blob", f"{base_sha}:{src_path}"])
        if data is None:
            raise HTTPException(404, f"{src_path!r} does not exist at the run's base")
    else:
        full = local_git._contained_path(co.work_tree, clean)
        if full is None:
            raise HTTPException(400, "path escapes the run's checkout")
        data = _read_file_capped(full)
    return file_preview.raw_response(request, data, src_path, download=download, cache="no-store")
