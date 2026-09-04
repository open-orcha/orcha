"""Local-repo code source (Orcha Cloud local run — Addendum 2): a thin, safe wrapper
over `git -C $ORCHA_LOCAL_REPO_DIR` that lets the browse/Code Space surfaces read the
project's OWN working tree with zero GitHub setup — the sentinel repo binding "local"
(see `docs/orcha-cloud-local-run.md` "Addendum 2").

The compose template mounts the project root read-only at ORCHA_LOCAL_REPO_DIR
(`../ -> /app/workspace:ro`) and the portal image carries the `git` binary. Most
functions here operate on COMMITTED state only (HEAD/branches/tags) — `git status`/
`git diff`/`--no-index` are read-only operations too, so the working-tree helpers below
(status_porcelain/diff_numstat/diff_unified) work fine against the same read-only
mount despite reading UNCOMMITTED state; nothing in this module ever writes to the
repo.

Contract mirrored from github_repo_browse_routes.py so callers can branch on
`repo == "local"` at a handful of chokepoints and otherwise reuse the exact same
downstream shapes (tree entries, snapshot dict, symbol indexer, etc.):
  - tree(ref)          -> [{"path","type":"blob"|"tree","sha","size"}, ...] (GitHub's
                           own git/trees?recursive=1 shape, so `_fetch_full_tree`-style
                           callers need no reshaping)
  - file_bytes(ref,path)-> raw bytes | None (binary-safe; caller does its own
                           NUL-byte binary sniff, exactly like the GitHub path)
  - resolve_ref(ref)    -> full 40-char commit sha | None
  - branches()          -> [{"name","is_head":bool}, ...]
  - grep(ref,q)         -> [{"path","line","text"}, ...] (bounded)
  - archive_bytes(ref)  -> raw `git archive --format=tar` bytes | None (feeds the SAME
                           in-memory tar extraction `_extract_source_files` already
                           does for a GitHub tarball — plain tar here, no gzip, so
                           callers open it with mode="r")
  - log1(ref)           -> {"sha","committed_at"} | None
  - origin_repo()       -> "owner/name" | None (GitHub-only `origin` remote parse — the
                           local-binding-with-GitHub-hub fall-through seam, see
                           github_hub_routes' LOCAL_REPO dispatch)

Working-tree helpers (portal_backend/code_workingtree_routes.py — "what have agents
changed that isn't committed yet"), all local-only, no GitHub equivalent:
  - status_porcelain()  -> [{"path","status":"M"|"A"|"D"|"R"|"??","orig_path"}, ...] | None
  - diff_numstat()      -> [{"path","additions","deletions"}, ...] | None (tracked +
                           untracked, whole tree)
  - diff_unified(path)  -> unified diff text (str) | None (whole tree when path=None;
                           untracked files get a synthesized whole-file-add diff)
  - log_follow(path,ref,n) -> [{"sha","short","summary","author","committed_at"}, ...] | None

SAFETY: every subprocess call is `subprocess.run([...], timeout=..., shell=False)` —
argv lists only, never a shell string, so there is no shell-injection surface even
though `q`/`ref`/`path` are caller-controlled. Path arguments (`path` in file_bytes,
and any repo-relative path this module ever trusts) are validated by `_safe_rel_path`
BEFORE being handed to git — reject absolute paths and any path containing a `..`
segment, mirroring the rigor `github_repo_browse_routes._safe_tar_members` applies to
tar member names. `ref`/`q` are passed as separate argv elements (never interpolated
into a shell string), so a hostile ref like `--upload-pack=...` still can't be
mistaken for a git option BECAUSE every call that accepts a caller ref places it after
a literal `--` separator wherever git syntax allows one, and otherwise validates it
looks like a plausible ref/sha first.

Every function degrades to None/[]/False on ANY failure (git not installed, dir
missing, bad ref, git binary error, timeout) — logged, never raised as a 500. This
module never talks to a database or FastAPI; it is a pure subprocess wrapper so it's
trivially testable against a real temp git repo (see tests/test_local_git_source.py).

Write path (Code Space editing Phase 1+2 — docs/orcha-cloud-local-run.md addendum,
Part C): the ONLY functions in this module that ever mutate the working tree or the
repo's history. Everything above this point is read-only, including against
uncommitted state; these functions are the deliberate exception, gated one layer up
by code_workingtree_routes' membership check (human UI actions riding proxy trust,
same as every write elsewhere in this portal):
  - worktree_file_hash(path)      -> sha256 hexdigest of a worktree file's raw bytes,
                                      or None (unreadable/missing) — the drift-check
                                      primitive the PUT route compares base_hash against.
  - write_worktree_file(path,b)   -> bool; atomic (tempfile + os.replace) write of raw
                                      bytes to a worktree path, creating parent dirs as
                                      needed. False on any failure, including an unsafe
                                      path or a `.git/...` path.
  - stage_and_commit(paths,msg,…) -> {"sha","short"} | None; `git add -A -- <paths>` +
                                      `git commit`, optionally with a one-off `-c
                                      user.name=/user.email=` override so the commit
                                      succeeds (and is attributed) even on a box with no
                                      git identity configured.
  - push_current_branch()         -> {"ok","detail"}; `git push origin HEAD`. Never
                                      raises; `detail` carries stderr's tail on failure.
  - branch_info()                 -> {"branch","sha","ahead","behind","remote"} | None;
                                      current branch/head/upstream tracking summary.
"""

import hashlib
import logging
import os
import re
import subprocess
import tempfile

logger = logging.getLogger("portal_backend.local_git")

# Every subprocess call is bounded — a huge repo / hung git process must never hang a
# request indefinitely. Generous enough for `git archive` on a large-ish repo, short
# enough that a genuinely hung git process fails a request quickly rather than exhausting
# the portal's worker threads.
GIT_TIMEOUT_SECONDS = 20

# grep/search result caps — mirrors github_repo_browse_routes.NAMES_SEARCH_MAX_RESULTS /
# CONTENTS_SEARCH_MAX_RESULTS in spirit: bounded so a broad query never blows up the
# response or makes `git grep` walk forever on a huge repo.
GREP_MAX_RESULTS = 200

_FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
# A conservative allow-list for a caller-supplied ref/branch/tag/short-sha BEFORE it is
# ever passed to git: word characters, dots, dashes, slashes (branch namespaces like
# "feat/x"), carets/tildes (relative refs like "HEAD~1"). Deliberately does not include
# leading '-' (a git *option* look-alike) — checked separately below.
_SAFE_REF_RE = re.compile(r"^[\w][\w./~^-]*$")


def _env_dir() -> str:
    return (os.environ.get("ORCHA_LOCAL_REPO_DIR") or "").strip()


def available() -> bool:
    """Whether the local-repo source can be used at all: the env var is set, the
    directory exists, it contains a `.git` (a real repo, not just any mounted dir),
    and the `git` binary itself is reachable. Cheap enough to call on every request
    that might need it (no caching — a missing/misconfigured mount should be visible
    immediately, not sticky-cached as unavailable)."""
    path = _env_dir()
    if not path:
        return False
    if not os.path.isdir(path):
        return False
    if not os.path.exists(os.path.join(path, ".git")):
        return False
    return _git_binary_present()


def _git_binary_present() -> bool:
    try:
        result = subprocess.run(
            ["git", "--version"],
            capture_output=True,
            timeout=GIT_TIMEOUT_SECONDS,
            shell=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _safe_ref(ref) -> bool:
    """A caller-supplied ref/branch/tag/short-or-full-sha is safe to pass to git: a
    non-empty string matching the conservative allow-list above, and NOT starting with
    '-' (which git would otherwise parse as an option rather than a revision — the same
    class of bug `git <subcommand> -- <path>` separators guard against elsewhere in this
    module)."""
    if not isinstance(ref, str) or not ref:
        return False
    if ref.startswith("-"):
        return False
    return bool(_SAFE_REF_RE.match(ref))


def _safe_rel_path(path) -> bool:
    """A repo-relative path is safe to pass to git: non-empty, not absolute, and no
    `..` path segment anywhere — mirrors the traversal check
    `github_repo_browse_routes._safe_tar_members` applies to tar member names (see its
    docstring for the full rationale). Rejects a leading '-' too, for the same
    option-look-alike reason `_safe_ref` does."""
    if not isinstance(path, str) or not path:
        return False
    if path.startswith("-"):
        return False
    normalized = path.replace("\\", "/")
    if normalized.startswith("/"):
        return False
    parts = normalized.split("/")
    if any(p == ".." for p in parts):
        return False
    return True


def _contained_path(repo_dir: str, rel_path: str) -> "str | None":
    """`os.path.join(repo_dir, rel_path)` — or None when the RESOLVED target (symlinks
    followed, `os.path.realpath`) lands outside the repo. `_safe_rel_path` only inspects
    the lexical path; a symlinked directory inside the working tree that points outside
    it (agent-created or committed) would otherwise let the worktree file read/write
    escape the mount. Both sides are realpath'd so a bind mount that is itself a symlink
    (Docker-for-Mac) compares equal to its resolved form."""
    root = os.path.realpath(repo_dir)
    full = os.path.join(repo_dir, rel_path)
    real = os.path.realpath(full)
    if real != root and not real.startswith(root + os.sep):
        return None
    return full


def _run(args: list, *, binary: bool = False):
    """Run `git -C <ORCHA_LOCAL_REPO_DIR> <args>`, returning stdout (bytes if
    binary=True, else text) on success or None on ANY failure (non-zero exit, git
    missing, timeout, dir missing). Never raises to the caller; every failure is
    logged at debug level (expected/routine — a bad ref or missing path is a normal
    occurrence, not a portal error) so the None just means 'not found / unavailable'.
    The ONE subprocess leaf in this module — every public function below funnels
    through this."""
    repo_dir = _env_dir()
    if not repo_dir:
        return None
    full_args = ["git", "-C", repo_dir] + args
    try:
        result = subprocess.run(
            full_args,
            capture_output=True,
            timeout=GIT_TIMEOUT_SECONDS,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("local_git: %s failed to run: %s", full_args, exc)
        return None
    if result.returncode != 0:
        logger.debug(
            "local_git: %s exited %s: %s",
            full_args, result.returncode,
            (result.stderr or b"").decode("utf-8", errors="ignore")[:500],
        )
        return None
    return result.stdout if binary else result.stdout.decode("utf-8", errors="ignore")


def resolve_ref(ref=None) -> "str | None":
    """Turn a ref (branch/tag/short-or-full-sha, or None/'' -> HEAD) into the full
    40-char commit sha it currently points at. None on a bad ref, an empty repo (no
    commits yet), or any git failure."""
    if not available():
        return None
    target = ref if ref else "HEAD"
    if target != "HEAD" and not _safe_ref(target):
        return None
    out = _run(["rev-parse", "--verify", "--quiet", f"{target}^{{commit}}"])
    if out is None:
        return None
    sha = out.strip()
    return sha if _FULL_SHA_RE.match(sha) else None


def branches() -> list:
    """Every local branch as {"name", "is_head": bool}, HEAD-marked via a separate
    symbolic-ref read (rather than parsing for-each-ref's own HEAD decoration, which
    varies by git version) so the marker is unambiguous. Empty list on any failure or
    an empty repo (no commits/branches yet — a normal state right after `git init`,
    not an error)."""
    if not available():
        return []
    out = _run(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    if out is None:
        return []
    names = [line.strip() for line in out.splitlines() if line.strip()]
    head_out = _run(["symbolic-ref", "--quiet", "--short", "HEAD"])
    head_name = head_out.strip() if head_out else None
    return [{"name": n, "is_head": n == head_name} for n in names]


def tree(ref=None) -> "list | None":
    """The FULL recursive tree at `ref` (default HEAD), in the same shape GitHub's
    `git/trees?recursive=1` returns: [{"path","type":"blob"|"tree","sha","size"}].
    `size` is included only for blobs (mirrors GitHub, which omits it for trees).
    None when the ref can't be resolved or git fails (never [] for that case — an
    empty list is reserved for a genuinely empty tree, e.g. an empty commit)."""
    sha = resolve_ref(ref)
    if sha is None:
        return None
    # ls-tree -r -t: recursive, include tree (directory) entries too — GitHub's
    # recursive tree response includes both blobs and trees, and code_space_routes'
    # blob-sha comparison indexes by (path -> sha) across both kinds.
    out = _run(["ls-tree", "-r", "-t", "-l", sha])
    if out is None:
        return None
    entries = []
    for line in out.splitlines():
        # Format: "<mode> <type> <sha> <size|'-'>\t<path>"
        if "\t" not in line:
            continue
        meta, path = line.split("\t", 1)
        fields = meta.split()
        if len(fields) < 4:
            continue
        _mode, obj_type, obj_sha, size_field = fields[0], fields[1], fields[2], fields[3]
        entry_type = "blob" if obj_type == "blob" else "tree"
        entry = {"path": path, "type": entry_type, "sha": obj_sha}
        if entry_type == "blob" and size_field.isdigit():
            entry["size"] = int(size_field)
        entries.append(entry)
    return entries


def blob_sha(ref, path) -> "str | None":
    """The blob sha for one path at `ref` — a small convenience over `tree()` for
    callers (like code_space's blob_match check) that only need one path's sha rather
    than the whole tree. None when the path/ref doesn't resolve to a blob."""
    entries = tree(ref)
    if entries is None:
        return None
    for entry in entries:
        if entry["path"] == path and entry["type"] == "blob":
            return entry["sha"]
    return None


def file_bytes(ref, path) -> "bytes | None":
    """One file's raw content at `ref` via `git show <sha>:<path>` — binary-safe (no
    text decode here; callers do their own NUL-byte binary sniff exactly like the
    GitHub contents-API path does). None when: the path fails `_safe_rel_path`, the
    ref doesn't resolve, the path doesn't exist at that ref, or git fails."""
    if not _safe_rel_path(path):
        return None
    sha = resolve_ref(ref)
    if sha is None:
        return None
    out = _run(["show", f"{sha}:{path}"], binary=True)
    return out


def grep(ref, q) -> "list | None":
    """Content search: `git grep -n --max-count` for `q` at `ref`, returned as
    [{"path","line","text"}], capped at GREP_MAX_RESULTS. None when the ref doesn't
    resolve, the query is empty, or git fails; [] is a genuine no-match result.
    `-F` (fixed-string, not regex) so an arbitrary user query can't be misread as a
    regex metacharacter soup or, worse, a git-grep option — combined with the `--`
    separator below, `q` can never be interpreted as anything but literal search text."""
    if not q:
        return None
    sha = resolve_ref(ref)
    if sha is None:
        return None
    out = _run(["grep", "-n", "-I", "-F", "-e", q, sha, "--"])
    # git grep exits 1 (not an error here) when there are simply no matches; `_run`
    # already treats any non-zero exit as None, so a genuine "no matches" result and a
    # real git failure are indistinguishable from `_run` alone. Re-run cheaply is
    # wasteful; instead treat None from `_run` here as "no matches or failure" and
    # return [] — honest enough: grep's failure modes on a resolved sha are rare
    # (corrupt object), and a caller already got None upstream if the ref itself was
    # bad. This keeps the common "no matches" case from masquerading as an error state.
    if out is None:
        return []
    results = []
    for line in out.splitlines():
        # Format: "<sha>:<path>:<line_no>:<text>" (git grep's default separator is ':').
        parts = line.split(":", 3)
        if len(parts) < 4:
            continue
        _commit, path, line_no, text = parts
        if not line_no.isdigit():
            continue
        results.append({"path": path, "line": int(line_no), "text": text})
        if len(results) >= GREP_MAX_RESULTS:
            break
    return results


def archive_bytes(ref=None) -> "bytes | None":
    """`git archive --format=tar` at `ref` (default HEAD) — the local equivalent of
    the GitHub tarball snapshot fetch (`_download_tarball_bytes`), feeding the SAME
    in-memory `_extract_source_files` extraction path. Plain `tar` (no gzip — a local
    filesystem read has no download-size pressure the way a GitHub codeload fetch
    does, so skipping compression keeps this call cheap); callers opening it with
    `tarfile.open(fileobj=..., mode="r")` handle both compressed and uncompressed
    equally well, so this is a drop-in byte source. Unlike GitHub's tarball, a local
    `git archive` has NO synthetic top-level `{owner}-{repo}-{sha}/` directory — paths
    are already repo-relative, so a caller reusing `_safe_tar_members`'s stripping
    logic must special-case that (see the route dispatch helper, not this module).
    None when the ref doesn't resolve or archive fails."""
    sha = resolve_ref(ref)
    if sha is None:
        return None
    return _run(["archive", "--format=tar", sha], binary=True)


def log1(ref=None) -> "dict | None":
    """The single most recent commit at `ref` (default HEAD): {"sha","committed_at"}
    (committed_at as an ISO-8601 string, strict — %cI). None when the ref doesn't
    resolve or the repo has no commits yet."""
    sha = resolve_ref(ref)
    if sha is None:
        return None
    out = _run(["log", "-1", "--format=%H%x1f%cI", sha])
    if out is None:
        return None
    line = out.strip()
    if "\x1f" not in line:
        return None
    commit_sha, committed_at = line.split("\x1f", 1)
    return {"sha": commit_sha, "committed_at": committed_at}


def status_porcelain() -> "list | None":
    """The working tree's dirty-state summary via `git status --porcelain=v1 -z`
    (porcelain v1 — a stable machine-readable format across git versions; `-z` NUL-
    terminates records and leaves paths UNQUOTED even when they contain spaces/unicode,
    avoiding porcelain v1's default C-style quoting of "unusual" paths). Returns a list
    of {"path", "status", "orig_path"} — `status` is ONE of "M" (modified — staged
    and/or unstaged, collapsed to one letter since the working-tree-changes view treats
    both the same way GitHub's own PR file list does), "A" (added/staged-new), "D"
    (deleted), "R" (renamed — `orig_path` is the pre-rename name, else None), or "??"
    (untracked). A path with conflicting index/worktree states (rare outside a mid-
    merge repo) collapses to whichever single letter `_classify_status_code` picks —
    see its own docstring for the precedence. None on any git failure (repo dir
    missing, not a repo); an empty list is a genuinely CLEAN working tree, not a
    failure — the route layer's `dirty` flag distinguishes the two by checking `is not
    None` before checking truthiness."""
    if not available():
        return None
    # TWO-PHASE scan (Docker-for-Mac bind-mount reality): a plain `status` walks
    # every directory in the tree hunting untracked files — 15-100s on a large
    # monorepo over gRPC-FUSE, past GIT_TIMEOUT_SECONDS. `--untracked-files=no`
    # walks only the INDEX (~1s), and untracked files come from a separate
    # `ls-files --others --exclude-standard` whose failure/timeout degrades to
    # "tracked changes only" instead of killing the whole scan.
    out = _run(["status", "--porcelain=v1", "-z", "--untracked-files=no"], binary=True)
    if out is None:
        return None
    # Split on NUL; a rename record is TWO consecutive fields (new name, then old
    # name) rather than one "old -> new" string the way the non -z format renders it.
    fields = out.decode("utf-8", errors="ignore").split("\x00")
    entries = []
    i = 0
    while i < len(fields):
        record = fields[i]
        i += 1
        if not record:
            continue
        if len(record) < 4:
            continue
        code = record[:2]
        path = record[3:]
        status = _classify_status_code(code)
        orig_path = None
        if status == "R":
            # The next NUL-delimited field is the rename's ORIGINAL path.
            if i < len(fields):
                orig_path = fields[i]
                i += 1
        entries.append({"path": path, "status": status, "orig_path": orig_path})
    others = _run(["ls-files", "--others", "--exclude-standard", "-z"], binary=True)
    if others is not None:
        for raw_path in others.decode("utf-8", errors="ignore").split("\x00"):
            if raw_path:
                entries.append({"path": raw_path, "status": "??", "orig_path": None})
    return entries


def _classify_status_code(code: str) -> str:
    """Collapse `git status --porcelain`'s two-character XY code (index-state,
    worktree-state) into ONE status letter for the working-tree-changes view — the UI
    wants "what changed", not git's full index-vs-worktree matrix. Precedence: `??`
    (untracked) and `R`/`R.`/`.R` (rename, either side) are checked first since they're
    unambiguous single concepts; otherwise ANY 'A' in either position wins (a newly
    added file, whether staged, or added-then-further-modified-in-worktree, still
    reads as "A" — GitHub's own PR file list makes the same call for a file that's new
    to the diff regardless of intermediate edits); then ANY 'D' wins (deleted, staged
    or not); everything else (a plain 'M', or any other combination git emits) falls
    through to 'M' as the honest default for "this tracked file differs from HEAD"."""
    if code == "??":
        return "??"
    if "R" in code:
        return "R"
    if "A" in code:
        return "A"
    if "D" in code:
        return "D"
    return "M"


def diff_numstat() -> "list | None":
    """Per-file added/deleted line counts across the WHOLE working tree (tracked
    changes only — staged + unstaged combined against HEAD) via
    `git diff HEAD --numstat -z`, PLUS untracked files (numstat has no concept of a
    file git isn't tracking yet, so each untracked path from `status_porcelain` is
    reported here too, with additions = its current line count and deletions = 0 — an
    untracked file's "diff" is conceptually a whole-file add against `/dev/null`,
    mirroring `diff_unified`'s own untracked-file handling below). Returns a list of
    {"path", "additions", "deletions"}; `additions`/`deletions` are None for a binary
    file (numstat prints "-" for both — never fabricate a byte-derived line count for a
    file git itself says has none). None on any git failure or when the repo is
    unavailable; `[]` is a genuinely clean tree (no tracked changes AND no untracked
    files)."""
    if not available():
        return None
    tracked = _diff_numstat_tracked()
    if tracked is None:
        return None
    untracked = _untracked_numstat()
    return tracked + untracked


def _diff_numstat_tracked() -> "list | None":
    out = _run(["diff", "HEAD", "--numstat", "-z"], binary=True)
    if out is None:
        # `git diff HEAD` fails on a genuinely empty repo (no commits yet, so HEAD
        # itself doesn't resolve) — every other "no tracked changes" case (a clean
        # tree, an existing HEAD with zero diffs) succeeds with empty stdout, so this
        # narrow failure mode degrades to "no tracked changes" rather than propagating
        # None (an empty repo has no tracked changes to report, by definition — the
        # caller's overall None-vs-[] contract is about REPO availability, already
        # checked one level up in `diff_numstat`/`status_porcelain`).
        return []
    text = out.decode("utf-8", errors="ignore")
    fields = [f for f in text.split("\x00") if f]
    entries = []
    for field in fields:
        # Format: "<added>\t<deleted>\t<path>" (a rename appears as delete+add of two
        # separate paths under plain --numstat, no -M — acceptable here since the
        # per-file counts, not rename detection, are the point of this call; rename
        # IDENTITY is already covered by status_porcelain's own -M-equipped status
        # parse).
        parts = field.split("\t", 2)
        if len(parts) != 3:
            continue
        added_field, deleted_field, path = parts
        additions = int(added_field) if added_field.isdigit() else None
        deletions = int(deleted_field) if deleted_field.isdigit() else None
        entries.append({"path": path, "additions": additions, "deletions": deletions})
    return entries


def _untracked_numstat() -> list:
    """Untracked files as numstat-shaped {"path","additions","deletions":0} entries —
    `additions` is the file's current line count (best-effort: `wc -l`-equivalent via a
    newline count on the raw bytes; a binary untracked file gets `additions: None`,
    matching numstat's own "-" convention for binaries, via the same `_is_probably_binary`
    NUL-byte sniff `diff_unified` uses for its own untracked-file whole-file-add form)."""
    entries = status_porcelain() or []
    untracked_paths = [
        e["path"] for e in entries
        if e["status"] == "??"
        # Orcha's own runtime dirs and dependency trees are never "the agents'
        # work" — and each line-count below is a full file read over the bind
        # mount, so skipping them here is a real cost cut, not just cosmetics.
        and not e["path"].startswith(".orcha/")
        and "node_modules/" not in e["path"]
    ]
    # NO per-file reads: each line count was a full file read over the bind mount
    # (Docker-for-Mac: ~10-50ms EACH, seconds in aggregate for hundreds of
    # untracked files) for a purely cosmetic number. An untracked row's counts are
    # additions=None/deletions=0 — the UI renders that as a plain "new file" row,
    # the same shape it already uses for binaries.
    return [{"path": path, "additions": None, "deletions": 0} for path in untracked_paths]


def _is_probably_binary(raw: bytes) -> bool:
    return b"\x00" in raw


def _read_worktree_file(rel_path: str) -> "bytes | None":
    """Raw bytes of a file in the WORKING TREE (not a git object — a git object only
    exists for committed/staged content, but an untracked file has neither) — the read-
    only bind mount (`ORCHA_LOCAL_REPO_DIR`) makes a plain filesystem read safe (no
    write path exists through this helper). `_safe_rel_path` gates traversal exactly
    like every other path this module trusts; the read itself is a plain `open()`, not
    a subprocess (there is no git plumbing command for "show me an untracked file's
    bytes" — `git show :path` only resolves INDEX/committed content). None on a bad
    path, missing dir, missing file, or any OSError (permission, race with a concurrent
    delete, etc.) — the same 'unavailable, not an error' contract every other read in
    this module keeps."""
    if not _safe_rel_path(rel_path):
        return None
    repo_dir = _env_dir()
    if not repo_dir:
        return None
    full_path = _contained_path(repo_dir, rel_path)
    if full_path is None:
        return None
    try:
        with open(full_path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def diff_unified(path=None) -> "str | None":
    """Unified diff text for the working tree — either the WHOLE tree (`path=None`,
    tracked changes only — untracked files have no meaningful "whole tree" unified
    diff form since git has nothing to diff them against as a group) or ONE file
    (`path` given), via `git diff HEAD -- <path>`. For a path that `status_porcelain`
    reports as untracked (`??`), synthesizes the "whole-file-add" diff form via
    `git diff --no-index -- /dev/null <path>` — the standard trick for showing an
    untracked file as an add-diff (git has no commit to diff an untracked file
    against, so `--no-index` against `/dev/null` produces the same shape a real
    "file added" diff would have). Returns None when: the repo is unavailable, `path`
    fails `_safe_rel_path`, or git fails outright. An EMPTY STRING is a legitimate "no
    diff" result (path given but unchanged) — distinct from None; callers check
    `is None` for failure, not falsiness."""
    if not available():
        return None
    if path is not None and not _safe_rel_path(path):
        return None
    if path is not None:
        status = _status_for_path(path)
        if status == "??":
            return _untracked_diff(path)
        args = ["diff", "HEAD", "--", path]
    else:
        args = ["diff", "HEAD"]
    out = _run(args)
    if out is None:
        # `git diff HEAD` fails on a repo with no commits yet (HEAD doesn't resolve) —
        # the honest answer there is "nothing to diff against", not a failure; treat it
        # as an empty diff rather than propagating None, mirroring
        # `_diff_numstat_tracked`'s identical empty-repo handling.
        return ""
    return out


def _status_for_path(path: str) -> "str | None":
    entries = status_porcelain() or []
    for entry in entries:
        if entry["path"] == path:
            return entry["status"]
    return None


# Diffs are capped the same way file reads are — an oversized diff is truncated with
# a marker rather than silently dropped or left to blow up a response.
WORKTREE_DIFF_MAX_BYTES = 200_000


def _untracked_diff(path: str) -> "str | None":
    """The add-diff form for an untracked file: `git diff --no-index -- /dev/null
    <path>` run FROM the repo dir (`_run` already prefixes `-C <repo_dir>`), so
    `<path>` resolves relative to the working tree exactly like every other path this
    module accepts. `--no-index` makes git compare two arbitrary paths without either
    needing to be a tracked blob — the standard idiom for "diff a file that isn't in
    git yet". `git diff --no-index` exits 1 (not 0) whenever the compared paths
    differ (i.e. on EVERY real result, since /dev/null vs a real file always differs)
    — `_run` would normally treat that nonzero exit as failure and return None, so
    this call bypasses `_run` and shells out directly to read stdout regardless of
    exit code, exactly like `local_git.grep`'s own git-grep-exit-1-is-not-an-error
    handling one layer up."""
    repo_dir = _env_dir()
    if not repo_dir:
        return None
    try:
        result = subprocess.run(
            ["git", "-C", repo_dir, "diff", "--no-index", "--", "/dev/null", path],
            capture_output=True,
            timeout=GIT_TIMEOUT_SECONDS,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("local_git: untracked diff for %s failed: %s", path, exc)
        return None
    # exit 0 only when the file happens to be byte-identical to /dev/null (i.e. truly
    # empty) — still a valid, if boring, diff; exit 1 is the normal "they differ" case;
    # anything else (2+) is a real git error.
    if result.returncode not in (0, 1):
        logger.debug(
            "local_git: untracked diff for %s exited %s: %s",
            path, result.returncode, (result.stderr or b"")[:500],
        )
        return None
    return result.stdout.decode("utf-8", errors="ignore")


def log_follow(path, ref=None, n: int = 20) -> "list | None":
    """File history: up to `n` most recent commits that touched `path`, newest first,
    via `git log --follow --format=... -n <n> <ref> -- <path>` (`--follow` tracks the
    file across renames, matching GitHub's own file-history view). Each entry:
    {"sha","short","summary","author","committed_at"} (committed_at ISO-8601 via
    %cI). None when: `path` fails `_safe_rel_path`, `ref` doesn't resolve, or git
    fails. An empty list is a genuine 'no history found for this path at this ref'
    (e.g. a path that only exists in the working tree, never committed) — not a
    failure."""
    if not _safe_rel_path(path):
        return None
    sha = resolve_ref(ref)
    if sha is None:
        return None
    # Field separator \x1f (unit separator) keeps a summary containing a literal tab
    # or pipe from corrupting the parse; \x1e (record separator) delimits commits so a
    # multi-line-safe split works even though summary (%s) itself never contains a
    # newline.
    out = _run([
        "log", "--follow", f"-n{n}",
        f"--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1e",
        sha, "--", path,
    ])
    if out is None:
        return []
    entries = []
    for record in out.split("\x1e"):
        record = record.strip("\n")
        if not record:
            continue
        parts = record.split("\x1f")
        if len(parts) != 5:
            continue
        full_sha, short_sha, summary, author, committed_at = parts
        entries.append({
            "sha": full_sha, "short": short_sha, "summary": summary,
            "author": author, "committed_at": committed_at,
        })
    return entries


_ORIGIN_HTTPS_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<name>[^/]+?)(?:\.git)?/?$"
)
_ORIGIN_SSH_RE = re.compile(
    r"^git@github\.com:(?P<owner>[^/]+)/(?P<name>[^/]+?)(?:\.git)?/?$"
)


def origin_repo() -> "str | None":
    """The local repo's `origin` remote, parsed into "owner/name" — the seam that lets
    a LOCAL-bound container (browse/Code Space served from the working tree) also serve
    the GitHub hub (issues/PRs/checks) when that working tree happens to be a clone
    FROM GitHub (see github_hub_routes' LOCAL_REPO fall-through). GitHub-only, by
    design: any other host, or a shape this doesn't recognize, returns None rather than
    guess — an honest "not a GitHub-backed clone" rather than a wrong owner/name.

    Supports exactly the two URL forms git itself would ever have written for a GitHub
    remote: `https://github.com/owner/name(.git)` and `git@github.com:owner/name(.git)`
    (a trailing slash is tolerated on the https form since some remotes carry one).
    Anything else — a GitLab/Bitbucket/self-hosted URL, an `ssh://` form, a bare local
    path, git://, or a URL git itself would reject — returns None; this module never
    tries to be a general-purpose git-URL parser, only a GitHub-recognizer.

    None (never raises) when: the local source is unavailable (`available()` is
    False), the repo has no `origin` remote configured, or `git remote get-url origin`
    itself fails for any reason. Uses the SAME `_run` subprocess leaf (argv-list,
    bounded timeout, no shell) every other function in this module does."""
    if not available():
        return None
    out = _run(["remote", "get-url", "origin"])
    if out is None:
        return None
    url = out.strip()
    if not url:
        return None
    match = _ORIGIN_HTTPS_RE.match(url) or _ORIGIN_SSH_RE.match(url)
    if not match:
        return None
    owner, name = match.group("owner"), match.group("name")
    if not owner or not name:
        return None
    return f"{owner}/{name}"


def worktree_file_hash(rel_path: str) -> "str | None":
    """sha256 hexdigest of a worktree file's raw bytes, via `_read_worktree_file` —
    the SAME "plain filesystem read, not a git object" leaf every other worktree
    reader uses, so this hashes exactly what a subsequent read would return. None
    when the path fails `_safe_rel_path`, the file doesn't exist, or any OSError
    (mirrors `_read_worktree_file`'s own None contract). Used as the optimistic-
    concurrency primitive for the editor's PUT route: a caller's `base_hash` is
    compared against a FRESH call to this function immediately before writing, never
    a cached value, so a concurrent agent edit is always detected."""
    raw = _read_worktree_file(rel_path)
    if raw is None:
        return None
    return hashlib.sha256(raw).hexdigest()


def _is_git_internal_path(rel_path: str) -> bool:
    """True when the path's first segment is `.git` — writing there would let a
    caller corrupt the repo's own object store/index/hooks rather than a tracked
    file. Checked in ADDITION to `_safe_rel_path` (which only rejects traversal, not
    an in-repo `.git/...` target) by every write in this module."""
    normalized = rel_path.replace("\\", "/")
    first_segment = normalized.split("/", 1)[0]
    return first_segment == ".git"


def write_worktree_file(rel_path: str, content: bytes) -> bool:
    """Write `content` (raw bytes) to `rel_path` inside the working tree, ATOMICALLY:
    the bytes land in a tempfile created in the SAME directory as the target (so
    `os.replace` is a same-filesystem rename, never a cross-device copy) and are then
    renamed onto the final path — a reader (or a concurrent git command) never
    observes a partially-written file. Parent directories are created as needed
    (`os.makedirs(..., exist_ok=True)`) so a PUT can create a brand-new file in a
    brand-new subdirectory in one call.

    False on ANY failure, never raises: an unsafe path (`_safe_rel_path`), a path
    whose first segment is `.git` (`_is_git_internal_path` — this module's write path
    touches TRACKED FILES ONLY, never git's own internal state), a missing/unset
    `ORCHA_LOCAL_REPO_DIR`, or any OSError (permission, disk full, a race). On
    failure the tempfile is best-effort cleaned up; a failure to clean it up is
    logged, not raised (a stray tempfile is a cheap leak, not a correctness bug)."""
    if not _safe_rel_path(rel_path):
        return False
    if _is_git_internal_path(rel_path):
        return False
    repo_dir = _env_dir()
    if not repo_dir:
        return False
    full_path = _contained_path(repo_dir, rel_path)
    if full_path is None:
        return False
    parent_dir = os.path.dirname(full_path)
    try:
        if parent_dir:
            os.makedirs(parent_dir, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=parent_dir or repo_dir, prefix=".orcha-write-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(content)
            os.replace(tmp_path, full_path)
        except OSError:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except OSError as exc:
        logger.debug("local_git: write_worktree_file(%s) failed: %s", rel_path, exc)
        return False
    return True


def stage_and_commit(
    paths: list, message: str, author_name: "str | None" = None, author_email: "str | None" = None,
) -> "dict | None":
    """`git add -A -- <paths>` then `git commit -m <message>`, returning
    {"sha","short"} (full + 7-char sha, via `rev-parse HEAD` after a successful
    commit) on success, or None on ANY failure — including the honest "nothing
    changed" case (git commit exits non-zero when there is nothing staged, which
    `_run` already maps to None, so callers can't tell "nothing to commit" from a
    genuine git error; the route layer re-checks `status_porcelain()` beforehand
    to give a distinct `reason:"nothing_committed"` in that specific case rather
    than a bare failure).

    When BOTH `author_name` and `author_email` are given, they're passed as
    `-c user.name=<name> -c user.email=<email>` BEFORE the `commit` subcommand
    (config-style overrides, not `--author=`) so the SAME identity also becomes the
    COMMITTER — this makes a commit succeed (and be attributed correctly) even on a
    box with no git identity configured at all, which `--author` alone would not
    fix (git still needs a committer identity to make the commit in the first
    place). When either is missing, falls through to whatever identity the repo/
    environment already has configured (unchanged behavior, no override).

    `paths` must be a non-empty list of repo-relative paths; each is checked with
    `_safe_rel_path` — a single unsafe path fails the WHOLE call (None), rather than
    silently skipping just that one path."""
    if not isinstance(paths, list) or not paths:
        return None
    if not all(_safe_rel_path(p) for p in paths):
        return None
    if not isinstance(message, str) or not message.strip():
        return None
    add_out = _run(["add", "-A", "--"] + paths)
    if add_out is None:
        return None
    commit_args = []
    if author_name and author_email:
        commit_args += [
            "-c", f"user.name={author_name}",
            "-c", f"user.email={author_email}",
        ]
    commit_args += ["commit", "-m", message]
    commit_out = _run(commit_args)
    if commit_out is None:
        return None
    sha_out = _run(["rev-parse", "HEAD"])
    if sha_out is None:
        return None
    sha = sha_out.strip()
    if not _FULL_SHA_RE.match(sha):
        return None
    return {"sha": sha, "short": sha[:7]}


# `git push` talks to a remote — generous enough for a real (if slow) network round
# trip, bounded so a hung/unreachable remote never hangs a request indefinitely.
PUSH_TIMEOUT_SECONDS = 30

# How much of a failed push's stderr to surface to the caller — enough for the
# actionable line (e.g. "! [rejected] ... (non-fast-forward)"), not a full traceback.
PUSH_DETAIL_MAX_CHARS = 500


def push_current_branch() -> dict:
    """`git push origin HEAD` — pushes whatever branch is currently checked out to
    its same-named branch on `origin`, bounded by `PUSH_TIMEOUT_SECONDS` (longer than
    `GIT_TIMEOUT_SECONDS` since this is the one operation in this module that
    genuinely talks to a network, not just the local filesystem). Returns
    {"ok": bool, "detail": str} — `detail` is "" on success, or the trimmed TAIL of
    stderr (the actionable line is almost always the last one — a rejected push,
    an auth failure, a missing remote) on failure, capped at
    PUSH_DETAIL_MAX_CHARS. Never raises: a missing repo dir, no `origin` remote, no
    upstream configured, auth failure, non-fast-forward rejection, or a timeout all
    surface as `{"ok": False, "detail": "..."}`, never an exception."""
    repo_dir = _env_dir()
    if not repo_dir:
        return {"ok": False, "detail": "local repository is not configured"}
    # HTTPS GitHub remotes have no credential helper inside the portal container —
    # ride the same gh-CLI token the compose env already exports for the GitHub
    # features (ORCHA_GITHUB_PAT), injected as an insteadOf rewrite so ssh remotes
    # and file:// test remotes are untouched. The token must NEVER surface in the
    # returned detail: stderr is sanitized below before it leaves this function.
    pat = (os.environ.get("ORCHA_GITHUB_PAT") or "").strip()
    cred_args = []
    if pat:
        cred_args = ["-c", f"url.https://x-access-token:{pat}@github.com/.insteadOf=https://github.com/"]
    try:
        result = subprocess.run(
            ["git", "-C", repo_dir, *cred_args, "push", "origin", "HEAD"],
            capture_output=True,
            timeout=PUSH_TIMEOUT_SECONDS,
            shell=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "detail": "git push timed out"}
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("local_git: push_current_branch failed to run: %s", exc)
        return {"ok": False, "detail": "git push could not be started"}
    if result.returncode == 0:
        return {"ok": True, "detail": ""}
    stderr_text = (result.stderr or b"").decode("utf-8", errors="ignore").strip()
    if pat:
        # The injected token must never leave this function, even inside a git
        # error line that echoes the rewritten URL.
        stderr_text = stderr_text.replace(pat, "***")
    detail = stderr_text[-PUSH_DETAIL_MAX_CHARS:] if stderr_text else f"git push exited {result.returncode}"
    logger.debug("local_git: push_current_branch exited %s: %s", result.returncode, detail)
    return {"ok": False, "detail": detail}


def branch_info() -> "dict | None":
    """A summary of where the current branch stands: {"branch", "sha", "ahead",
    "behind", "remote"}. `branch` is the current branch's short name, or the literal
    "HEAD" for a detached checkout (`symbolic-ref` fails there, so this falls back
    to that sentinel rather than returning None for an otherwise-healthy repo).
    `sha` is the short (7-char) HEAD commit sha. `ahead`/`behind` are the commit
    counts local HEAD leads/trails its upstream by, via
    `git rev-list --left-right --count @{u}...HEAD` (left=behind, right=ahead) —
    BOTH None (not 0) when there is no upstream configured, since "0 ahead, 0
    behind" would falsely claim the branch IS tracking something. `remote` is the
    `origin` URL (any host, not just GitHub — unlike `origin_repo()`, this is a
    raw pass-through for display, not a GitHub-specific parse), or None when no
    `origin` remote exists. None (the whole function) only when the repository is
    unavailable or has no commits yet (HEAD doesn't resolve) — every other partial
    failure (no upstream, no origin) degrades field-by-field instead."""
    if not available():
        return None
    sha_out = _run(["rev-parse", "--short", "HEAD"])
    if sha_out is None:
        return None
    sha = sha_out.strip()
    branch_out = _run(["symbolic-ref", "--quiet", "--short", "HEAD"])
    branch = branch_out.strip() if branch_out else "HEAD"
    ahead, behind = _ahead_behind()
    remote_out = _run(["remote", "get-url", "origin"])
    remote = remote_out.strip() if remote_out else None
    return {"branch": branch, "sha": sha, "ahead": ahead, "behind": behind, "remote": remote}


def _ahead_behind() -> "tuple[int | None, int | None]":
    """(ahead, behind) counts against the configured upstream, via
    `git rev-list --left-right --count @{u}...HEAD` (left-hand side of `...` is
    upstream, so its count is BEHIND; right-hand side is HEAD, so its count is
    AHEAD). (None, None) when there is no upstream configured or the command
    otherwise fails — deliberately NOT (0, 0), which would misreport an untracked
    branch as fully in sync."""
    out = _run(["rev-list", "--left-right", "--count", "@{u}...HEAD"])
    if out is None:
        return None, None
    fields = out.strip().split()
    if len(fields) != 2 or not all(f.isdigit() for f in fields):
        return None, None
    behind, ahead = int(fields[0]), int(fields[1])
    return ahead, behind


def workspace_name() -> "str | None":
    """The local entry's display `name` in the repos list. Inside the container the
    mount lands at a fixed path (/app/workspace), whose basename says nothing about
    the project — so the stack passes the real project name via ORCHA_LOCAL_REPO_NAME
    (compose template) and the mount basename is only the fallback."""
    explicit = (os.environ.get("ORCHA_LOCAL_REPO_NAME") or "").strip()
    if explicit:
        return explicit
    path = _env_dir()
    if not path:
        return None
    return os.path.basename(os.path.normpath(path)) or None
