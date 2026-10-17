"""Live changes — "what is this agent's run changing on disk RIGHT NOW".

While an agent works, the portal could stream its log but never show its CODE moving:
the Code tab's working-tree routes (code_workingtree_routes) only read the project's
main checkout, and a worker usually edits its own isolated worktree under
`<base_cwd>/.orcha-worktrees/<name>`. These two read-only routes compute a run's changes
in the run's OWN checkout:

  GET /api/agents/{aid}/runs/{rid}/changes            — changed-file list + counts
  GET /api/agents/{aid}/runs/{rid}/changes/diff?path= — one file's unified diff

Authorization is exactly the runs list's (`worker_run_read_routes.list_agent_runs`):
valid UUIDs, the agent exists, `require_member_read` on the agent's project (trusted
non-members 403; viewers read — reading is what the role is for; trust off unchanged),
and the run must belong to that agent (404 otherwise).

What gets compared (truthful — never a fabricated diff):
  * RUNNING run with a worktree — the worktree's working tree (tracked + untracked)
    against the point it branched from: `merge-base HEAD origin/main` (every notifier
    worktree is created from origin/main — notifier_worktree_base / _stable). Commits
    the agent made on its branch are therefore included, exactly like the reap-time
    captured diff (notifier_worktree_cleanup.capture_diff, which diffs vs origin/main).
    No origin/main → compare against HEAD and say so (`base.kind == "head"`).
  * RUNNING run with no worktree (conversation/resident runs with worktrees disabled)
    — the project's main checkout against HEAD. That checkout is SHARED (a human or
    another agent may have edits there too), so `shared_checkout: true` says so.
  * FINISHED run — the diff the notifier CAPTURED at reap (`worker_runs.diff`), parsed
    per file. Never recomputed: the worktree may since have moved or been removed.
    A finished run with no captured diff is `available:false, reason:"not_captured"`.

Reachability: the portal usually runs in Docker with the project root mounted at
ORCHA_LOCAL_REPO_DIR (compose: `..:/app/workspace`). A run records HOST paths, so a
host path under the run's `base_cwd` is translated to the same relative path under
the mount. A linked worktree's `.git` FILE names its gitdir by absolute HOST path
(`gitdir: /Users/…/.git/worktrees/<name>`), which does not exist in the container —
that is translated the same way and handed to git via `--git-dir/--work-tree`. Any
path that cannot be reached degrades to `{available:false, reason, detail}` — never 500.

Git runs with GIT_OPTIONAL_LOCKS=0 (never takes the agent's index.lock while it works),
argv lists only (no shell), bounded timeouts. Results are cached ~1 s per run with a
per-run single-flight lock so a 1.5 s poll from several viewers costs one scan; every
payload carries a `version` (also sent as a weak ETag) — `?since=<version>` or
`If-None-Match` short-circuits an unchanged poll to a tiny body / 304.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone

from fastapi import HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response

from portal_backend import local_git
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.identity_routes import require_member_read

GIT_TIMEOUT_SECONDS = 10
# same display cap as the Code tab's working-tree diff
DIFF_MAX_BYTES = local_git.WORKTREE_DIFF_MAX_BYTES
# a runaway generated tree must not blow up the poll payload
MAX_FILES = 500
# untracked files get a real line count only while that stays cheap
UNTRACKED_COUNT_MAX_FILES = 200
UNTRACKED_COUNT_MAX_BYTES = 512_000
LIVE_TTL_SECONDS = 1.0
CAPTURED_TTL_SECONDS = 60.0
WORKTREES_DIR = ".orcha-worktrees"

# Orcha's own runtime overlay inside a worktree is not the agent's work — the same
# pathspec excludes the notifier's captured diff uses (notifier_worktree_cleanup.
# DIFF_EXCLUDES; duplicated because the portal image does not ship the notifier).
PATHSPEC = (
    ".",
    ":(exclude).claude/orcha.json",
    ":(exclude).claude/orcha-tabs",
    ":(exclude).claude/settings.json",
    ":(exclude).claude/commands/orcha-*.md",
    ":(exclude).agents/skills/orcha-*",
    # the notifier/bridge runtime state (.orcha-wakes, .orcha-notifier.*, …) that a
    # base checkout often leaves untracked
    ":(exclude).claude/.orcha-*",
    ":(exclude).orcha",
    ":(exclude)" + WORKTREES_DIR,
)


# ---------------------------------------------------------------- checkout access

class Unavailable(Exception):
    def __init__(self, reason: str, detail: str):
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


def _norm(p: str) -> str:
    return os.path.normpath(p) if p else p


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def _mount_dir() -> str:
    return (os.environ.get("ORCHA_LOCAL_REPO_DIR") or "").strip()


def _mount_is_base(base_cwd: str, mount: str) -> bool:
    """Whether the mounted project root IS the run's host `base_cwd`. Proven by an
    explicit ORCHA_HOST_PROJECT_DIR when the stack sets one; otherwise disproven only
    by evidence — the mount's registered linked worktrees name their host checkout
    path, so if there are some and none sits under base_cwd, this run belongs to a
    different repository and must not be shown the mounted tree's changes."""
    host = (os.environ.get("ORCHA_HOST_PROJECT_DIR") or "").strip()
    if host:
        return _norm(host) == base_cwd
    wt_admin = os.path.join(mount, ".git", "worktrees")
    try:
        names = os.listdir(wt_admin)
    except OSError:
        return True
    seen = False
    for name in names:
        try:
            with open(os.path.join(wt_admin, name, "gitdir"), encoding="utf-8") as fh:
                target = fh.read().strip()
        except OSError:
            continue
        seen = True
        if _under(_norm(target), base_cwd):
            return True
    return not seen


def _to_local(host_path: str, base_cwd: str | None) -> str:
    """A run's HOST path → a path this process can open. Identity when the path
    exists here (portal on the host, tests); else translated under the project mount
    when it lies under the run's base_cwd."""
    host_path = _norm(host_path)
    if os.path.isdir(host_path):
        return host_path
    mount = _mount_dir()
    base = _norm(base_cwd or "")
    if not mount or not base:
        raise Unavailable(
            "not_reachable",
            "the run's checkout isn't reachable from the portal (no project mount)",
        )
    if not _under(host_path, base):
        raise Unavailable(
            "not_reachable",
            "the run's checkout lies outside the project the portal can read",
        )
    if not _mount_is_base(base, mount):
        raise Unavailable(
            "not_reachable",
            "the run worked in a different repository than the one mounted into the portal",
        )
    rel = os.path.relpath(host_path, base)
    local = _norm(os.path.join(mount, rel)) if rel != "." else _norm(mount)
    if not _under(local, _norm(mount)):
        raise Unavailable("not_reachable", "the run's checkout path is not inside the project")
    if not os.path.isdir(local):
        raise Unavailable(
            "not_reachable",
            "the run's checkout no longer exists (worktree removed?)",
        )
    return local


def _git_dir_for(work_tree: str, base_cwd: str | None) -> str:
    """The git dir for a checkout — `<wt>/.git` for a main checkout, or the target of
    a linked worktree's `.git` FILE, translated host → mount when needed."""
    dot = os.path.join(work_tree, ".git")
    if os.path.isdir(dot):
        return dot
    try:
        with open(dot, encoding="utf-8") as fh:
            line = fh.read().strip()
    except OSError:
        raise Unavailable("not_a_repo", "the run's checkout is not a git repository")
    if not line.startswith("gitdir:"):
        raise Unavailable("not_a_repo", "the run's checkout has an unreadable .git file")
    target = line[len("gitdir:"):].strip()
    if not os.path.isabs(target):
        target = os.path.join(work_tree, target)
    target = _norm(target)
    if os.path.isdir(target):
        return target
    mount = _mount_dir()
    base = _norm(base_cwd or "")
    if mount and base and _under(target, base):
        rel = os.path.relpath(target, base)
        mapped = _norm(os.path.join(mount, rel))
        if _under(mapped, _norm(mount)) and os.path.isdir(mapped):
            return mapped
    raise Unavailable(
        "not_reachable",
        "the worktree's git metadata isn't reachable from the portal",
    )


class Checkout:
    """`git` bound to one checkout (explicit git dir + work tree)."""

    def __init__(self, work_tree: str, git_dir: str):
        self.work_tree = work_tree
        self.git_dir = git_dir

    def _argv(self, args: list) -> list:
        return [
            "git", "-c", "safe.directory=*", "-c", "core.quotepath=off",
            "--git-dir=" + self.git_dir, "--work-tree=" + self.work_tree,
        ] + args

    def run(self, args: list, *, ok=(0,)) -> bytes | None:
        env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
        try:
            res = subprocess.run(
                self._argv(args), cwd=self.work_tree, capture_output=True,
                timeout=GIT_TIMEOUT_SECONDS, shell=False, env=env,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if res.returncode not in ok:
            return None
        return res.stdout

    def text(self, args: list) -> str | None:
        out = self.run(args)
        return None if out is None else out.decode("utf-8", errors="replace").strip()


def _open_checkout(run: dict) -> tuple[Checkout, str]:
    worktree = run.get("worktree")
    base_cwd = run.get("base_cwd")
    host = worktree or base_cwd
    if not host:
        raise Unavailable("no_checkout", "this run recorded no checkout to read")
    local = _to_local(host, base_cwd)
    git_dir = _git_dir_for(local, base_cwd)
    co = Checkout(local, git_dir)
    if co.text(["rev-parse", "--git-dir"]) is None:
        raise Unavailable("not_a_repo", "git could not open the run's checkout")
    return co, ("worktree" if worktree else "base")


def _base_of(co: Checkout, root: str) -> dict:
    """What the run's changes are measured against."""
    head = co.text(["rev-parse", "--verify", "-q", "HEAD"])
    if root == "worktree":
        mb = co.text(["merge-base", "HEAD", "origin/main"])
        if mb:
            return {"kind": "merge_base", "ref": "origin/main", "sha": mb}
    return {"kind": "head", "ref": "HEAD", "sha": head}


# ---------------------------------------------------------------- live scan

def _parse_name_status(raw: bytes) -> dict:
    """`diff --name-status -z -M` → {path: (status, orig_path)}."""
    fields = raw.decode("utf-8", errors="replace").split("\x00")
    out = {}
    i = 0
    while i < len(fields):
        code = fields[i]
        i += 1
        if not code:
            continue
        letter = code[0]
        if letter in ("R", "C"):
            if i + 1 >= len(fields):
                break
            orig, new = fields[i], fields[i + 1]
            i += 2
            out[new] = ("R" if letter == "R" else "A", orig if letter == "R" else None)
        else:
            if i >= len(fields):
                break
            path = fields[i]
            i += 1
            status = {"A": "A", "D": "D"}.get(letter, "M")
            out[path] = (status, None)
    return out


def _parse_numstat(raw: bytes) -> dict:
    """`diff --numstat -z -M` → {path: (additions|None, deletions|None)} (None = binary)."""
    fields = raw.decode("utf-8", errors="replace").split("\x00")
    out = {}
    i = 0
    while i < len(fields):
        rec = fields[i]
        i += 1
        if not rec:
            continue
        parts = rec.split("\t", 2)
        if len(parts) != 3:
            continue
        a, d, path = parts
        if path == "":
            # rename: the old and new names follow as separate NUL fields
            if i + 1 >= len(fields):
                break
            path = fields[i + 1]
            i += 2
        out[path] = (int(a) if a.isdigit() else None, int(d) if d.isdigit() else None)
    return out


def _untracked_counts(co: Checkout, path: str, budget: list) -> tuple:
    """(additions|None, binary) for an untracked file — its line count, while cheap."""
    if budget[0] <= 0:
        return None, False
    full = local_git._contained_path(co.work_tree, path)
    if full is None or os.path.islink(full):
        return None, False
    try:
        if os.path.getsize(full) > UNTRACKED_COUNT_MAX_BYTES:
            return None, False
        with open(full, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None, False
    budget[0] -= 1
    if local_git._is_probably_binary(raw):
        return None, True
    if not raw:
        return 0, False
    return raw.count(b"\n") + (0 if raw.endswith(b"\n") else 1), False


def _live_files(co: Checkout, base_sha: str | None) -> tuple[list, bool]:
    files = []
    if base_sha:
        ns = co.run(["diff", "--name-status", "-z", "-M", base_sha, "--", *PATHSPEC])
        nm = co.run(["diff", "--numstat", "-z", "-M", base_sha, "--", *PATHSPEC])
        if ns is None or nm is None:
            raise Unavailable("git_error", "git could not diff the run's checkout")
        statuses = _parse_name_status(ns)
        counts = _parse_numstat(nm)
        for path, (status, orig) in statuses.items():
            a, d = counts.get(path, (None, None))
            row = {"path": path, "status": status, "additions": a, "deletions": d}
            if orig:
                row["orig_path"] = orig
            if a is None and d is None and path in counts:
                row["binary"] = True
            files.append(row)
    others = co.run(["ls-files", "--others", "--exclude-standard", "-z", "--", *PATHSPEC])
    if others is None:
        raise Unavailable("git_error", "git could not list the run's new files")
    budget = [UNTRACKED_COUNT_MAX_FILES]
    for path in others.decode("utf-8", errors="replace").split("\x00"):
        if not path or _under(path, WORKTREES_DIR) or path.startswith(".orcha/"):
            continue
        adds, binary = _untracked_counts(co, path, budget)
        row = {"path": path, "status": "??", "additions": adds, "deletions": 0 if adds is not None else None}
        if binary:
            row["binary"] = True
        files.append(row)
    files.sort(key=lambda f: f["path"])
    truncated = len(files) > MAX_FILES
    return files[:MAX_FILES], truncated


# ---------------------------------------------------------------- captured diff

_HUNK_RE = re.compile(r"^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@")


def _plain_path(raw: str) -> str | None:
    """A `--- ` / `+++ ` header path from a plain unified diff (no `diff --git`):
    drop a trailing tab-separated timestamp and a leading a/ or b/; /dev/null → None."""
    p = raw.split("\t", 1)[0].strip()
    if p == "/dev/null" or not p:
        return None
    if p.startswith(("a/", "b/")):
        p = p[2:]
    return p


def _split_patch(diff: str) -> list:
    """A captured unified patch → [{path, status, orig_path, additions, deletions,
    binary, text}] — one entry per `diff --git` section, in patch order.

    L2: a plain unified diff (no `diff --git` headers — `diff -u`, some agents' own
    capture) starts a section at a `--- ` line immediately followed by `+++ `, as long
    as we are not inside a hunk body (hunk line counts are tracked from `@@` headers)."""
    sections: list = []
    cur = None
    lines_in = diff.split("\n")
    old_left = new_left = 0  # remaining lines of the current plain-section hunk
    for i, line in enumerate(lines_in):
        if line.startswith("diff --git "):
            cur = {"lines": [line], "plain": False}
            sections.append(cur)
            old_left = new_left = 0
            continue
        in_body = old_left > 0 or new_left > 0
        if (
            not in_body
            and (cur is None or cur["plain"])
            and line.startswith("--- ")
            and i + 1 < len(lines_in)
            and lines_in[i + 1].startswith("+++ ")
        ):
            cur = {"lines": [line], "plain": True}
            sections.append(cur)
            continue
        if cur is None:
            continue
        cur["lines"].append(line)
        if cur["plain"]:
            m = _HUNK_RE.match(line)
            if m and not in_body:
                old_left = int(m.group(1)) if m.group(1) is not None else 1
                new_left = int(m.group(2)) if m.group(2) is not None else 1
            elif in_body:
                if line.startswith("\\"):
                    pass  # "\ No newline at end of file"
                elif line.startswith("-"):
                    old_left -= 1
                elif line.startswith("+"):
                    new_left -= 1
                else:
                    old_left -= 1
                    new_left -= 1
    out = []
    for sec in sections:
        lines = sec["lines"]
        a_path = b_path = None
        status, orig, binary = "M", None, False
        body = lines[1:]
        if sec["plain"]:
            # L2: header-less section — paths come from the ---/+++ pair.
            a_path = _plain_path(lines[0][4:])
            b_path = _plain_path(body[0][4:]) if body else None
            if a_path is None and b_path is not None:
                status = "A"
            elif b_path is None and a_path is not None:
                status = "D"
            elif a_path and b_path and a_path != b_path:
                status, orig = "R", a_path
            body = body[1:]
        else:
            head = lines[0][len("diff --git "):]
            if head.startswith("a/") and " b/" in head:
                a_path, b_path = head[2:].split(" b/", 1)
        adds = dels = 0
        in_hunk = False
        for ln in body:
            if not in_hunk:
                if ln.startswith("new file mode"):
                    status = "A"
                elif ln.startswith("deleted file mode"):
                    status = "D"
                elif ln.startswith("rename from "):
                    orig = ln[len("rename from "):]
                    status = "R"
                elif ln.startswith("rename to "):
                    b_path = ln[len("rename to "):]
                elif ln.startswith("+++ "):
                    tgt = ln[4:]
                    if tgt.startswith("b/"):
                        b_path = tgt[2:]
                elif ln.startswith("--- "):
                    src = ln[4:]
                    if src.startswith("a/") and not a_path:
                        a_path = src[2:]
                elif ln.startswith("Binary files ") or ln.startswith("GIT binary patch"):
                    binary = True
                elif ln.startswith("@@"):
                    in_hunk = True
                continue
            if ln.startswith("GIT binary patch"):
                binary = True
            # inside hunks every +/- line is content (a section's own ---/+++ headers
            # precede its first @@), even one that reads like "--- x".
            elif ln.startswith("+"):
                adds += 1
            elif ln.startswith("-"):
                dels += 1
        path = b_path if status != "D" else (a_path or b_path)
        path = path or a_path or ""
        if not path:
            continue
        row = {
            "path": path, "status": status,
            "additions": None if binary else adds, "deletions": None if binary else dels,
            "text": "\n".join(lines).rstrip("\n") + "\n",
        }
        if orig:
            row["orig_path"] = orig
        if binary:
            row["binary"] = True
        out.append(row)
    return out


# ---------------------------------------------------------------- payloads + cache

_CACHE: dict = {}
_LOCKS: dict = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(rid: str) -> threading.Lock:
    with _LOCKS_GUARD:
        lk = _LOCKS.get(rid)
        if lk is None:
            lk = _LOCKS[rid] = threading.Lock()
        return lk


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _version(payload: dict) -> str:
    material = {k: payload.get(k) for k in (
        "available", "reason", "running", "source", "root", "branch", "base", "files", "truncated")}
    return hashlib.sha1(json.dumps(material, sort_keys=True, default=str).encode()).hexdigest()[:16]


def _summary(files: list) -> dict:
    return {
        "files": len(files),
        "additions": sum(f["additions"] or 0 for f in files),
        "deletions": sum(f["deletions"] or 0 for f in files),
    }


def _unavailable(run: dict, exc: Unavailable) -> dict:
    return {
        "available": False, "reason": exc.reason, "detail": exc.detail,
        "running": run["status"] == "running", "run_status": run["status"],
        "root": "worktree" if run.get("worktree") else ("base" if run.get("base_cwd") else None),
        "branch": run.get("branch"), "files": [], "summary": _summary([]),
    }


def _compute(run: dict) -> dict:
    running = run["status"] == "running"
    root = "worktree" if run.get("worktree") else "base"
    if not running:
        diff = run.get("diff")
        if diff is None:
            raise Unavailable("not_captured", "this run finished without a recorded diff")
        truncated = "[diff truncated]" in diff
        sections = _split_patch(diff)
        if not sections and diff.replace("[diff truncated]", "").strip():
            # L2: a non-empty diff we could not split must not read "no file changes".
            raise Unavailable("unparsed", "the recorded diff could not be read")
        files = [{k: v for k, v in s.items() if k != "text"} for s in sections]
        return {
            "available": True, "running": False, "run_status": run["status"],
            "source": "captured", "root": root, "branch": run.get("branch"),
            "base": {"kind": "captured", "ref": "origin/main", "sha": None},
            "shared_checkout": False, "files": files, "summary": _summary(files),
            "truncated": truncated,
        }
    co, root = _open_checkout(run)
    base = _base_of(co, root)
    files, truncated = _live_files(co, base.get("sha"))
    return {
        "available": True, "running": True, "run_status": run["status"],
        "source": "live", "root": root, "branch": run.get("branch") or co.text(
            ["rev-parse", "--abbrev-ref", "HEAD"]),
        "base": base, "shared_checkout": root == "base",
        "files": files, "summary": _summary(files), "truncated": truncated,
    }


def _payload(run: dict) -> dict:
    rid = str(run["run_id"])
    running = run["status"] == "running"
    ttl = LIVE_TTL_SECONDS if running else CAPTURED_TTL_SECONDS
    key = (rid, run["status"])
    hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] <= ttl:
        return hit[1]
    with _lock_for(rid):
        hit = _CACHE.get(key)
        if hit and time.monotonic() - hit[0] <= ttl:
            return hit[1]
        try:
            payload = _compute(run)
        except Unavailable as exc:
            payload = _unavailable(run, exc)
        except Exception:  # never a 500 for a git-level surprise
            payload = _unavailable(run, Unavailable("git_error", "the run's changes could not be read"))
        payload["version"] = _version(payload)
        payload["as_of"] = _now_iso()
        # drop other status entries for this run (a live entry is dead once it ends)
        for k in [k for k in _CACHE if k[0] == rid and k != key]:
            _CACHE.pop(k, None)
        _CACHE[key] = (time.monotonic(), payload)
        return payload


def _load_run(aid: str, rid: str, request: Request) -> dict:
    if not valid_uuid(aid) or not valid_uuid(rid):
        raise HTTPException(400, "agent_id / run_id must be valid UUIDs")
    with db_cursor() as (_, cur):
        agent = require_agent(cur, aid)
        require_member_read(cur, request, str(agent["container_id"]))
        cur.execute(
            """SELECT run_id, status, worktree, branch, base_cwd, diff, ended_at
               FROM worker_runs WHERE run_id=%s AND agent_id=%s""",
            (rid, aid),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"worker run {rid} not found for this agent")
    return dict(row)


# ---------------------------------------------------------------- routes

@app.get("/api/agents/{aid}/runs/{rid}/changes")
def get_run_changes(aid: str, rid: str, request: Request, since: str | None = Query(default=None)):
    """The run's changed files. Returns {available, reason?, detail?, running,
    run_status, source:"live"|"captured", root:"worktree"|"base", branch,
    base:{kind:"merge_base"|"head"|"captured", ref, sha}, shared_checkout,
    files:[{path, status:"M"|"A"|"D"|"R"|"??", additions, deletions, orig_path?,
    binary?}], summary:{files, additions, deletions}, truncated, version, as_of}.
    `?since=<version>` (or If-None-Match) with an unchanged version answers
    {unchanged:true, version, running, as_of} (resp. 304)."""
    run = _load_run(aid, rid, request)
    payload = _payload(run)
    version = payload["version"]
    etag = f'W/"{version}"'
    inm = request.headers.get("if-none-match") or ""
    if inm and (inm.strip() == etag or inm.strip().strip('"') == version):
        return Response(status_code=304, headers={"ETag": etag})
    if since and since == version:
        return JSONResponse(
            {"unchanged": True, "version": version, "running": payload["running"],
             "as_of": payload["as_of"]},
            headers={"ETag": etag},
        )
    return JSONResponse(payload, headers={"ETag": etag})


def _cap(text: str) -> tuple[str, bool]:
    raw = text.encode("utf-8", errors="ignore")
    if len(raw) <= DIFF_MAX_BYTES:
        return text, False
    return raw[:DIFF_MAX_BYTES].decode("utf-8", errors="ignore") + "\n\n… diff truncated (exceeds the display cap) …\n", True


@app.get("/api/agents/{aid}/runs/{rid}/changes/diff")
def get_run_change_diff(aid: str, rid: str, request: Request, path: str = Query(...)):
    """One changed file's unified diff within the run's checkout. The path must be a
    repository-relative path (no absolute paths, no `..`, no leading `-`) that stays
    inside the checkout after symlink resolution (400 otherwise), and must be one of
    the run's changed files. Returns {available, path, diff, binary, truncated,
    source}."""
    clean = (path or "").strip()
    if not clean or not local_git._safe_rel_path(clean) or "\x00" in clean:
        raise HTTPException(400, "path must be a repository-relative path inside the run's checkout")
    clean = clean.strip("/")
    run = _load_run(aid, rid, request)
    payload = _payload(run)
    if not payload.get("available"):
        return {k: payload.get(k) for k in ("available", "reason", "detail")}
    match = next((f for f in payload["files"] if f["path"] == clean), None)
    if match is None:
        return {"available": False, "reason": "not_changed",
                "detail": f"{clean!r} is not among this run's changed files"}
    if payload["source"] == "captured":
        sec = next((s for s in _split_patch(run.get("diff") or "") if s["path"] == clean), None)
        text = sec["text"] if sec else ""
        text, truncated = _cap(text)
        return {"available": True, "path": clean, "diff": text, "binary": bool(match.get("binary")),
                "truncated": truncated or bool(payload.get("truncated")), "source": "captured"}
    try:
        co, _root = _open_checkout(run)
    except Unavailable as exc:
        return {"available": False, "reason": exc.reason, "detail": exc.detail}
    if local_git._contained_path(co.work_tree, clean) is None:
        raise HTTPException(400, "path escapes the run's checkout")
    if match["status"] == "??":
        out = co.run(["diff", "--no-index", "--", "/dev/null", clean], ok=(0, 1))
    else:
        base_sha = (payload.get("base") or {}).get("sha")
        paths = [clean] + ([match["orig_path"]] if match.get("orig_path") else [])
        out = co.run(["diff", "-M", base_sha, "--", *paths]) if base_sha else None
    if out is None:
        return {"available": False, "reason": "git_error", "detail": f"could not diff {clean!r}"}
    text = out.decode("utf-8", errors="replace")
    binary = bool(match.get("binary")) or ("Binary files " in text and "\n@@" not in text)
    text, truncated = _cap(text)
    return {"available": True, "path": clean, "diff": text, "binary": binary,
            "truncated": truncated, "source": "live"}
