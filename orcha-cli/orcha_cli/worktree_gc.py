"""Classify, preserve and safely remove the agent worktrees under ``.orcha-worktrees``.

This is the ONE implementation of agent-worktree housekeeping. The notifier daemon runs it
automatically (``notifier_worktree_gc``), ``orcha worktrees`` runs it from a terminal, and the
desktop app calls ``orcha worktrees … --json`` instead of re-implementing it.

States (``classify``):

* ``clean``        no commits beyond the base branch and no real changes — only Embodent's own
                   scaffolding (the runtime overlay, copied skills/commands, wake logs, the
                   ``.orcha`` stack folder a handoff carried in) or untracked files that are
                   byte-identical copies of the same file in the main checkout.
* ``has-output``   real untracked or modified files, no unmerged commits.
* ``unmerged``     the branch holds commits that are not on the base branch.
* ``in-use``       a live run / resident / terminal / preview is using it (or it is locked).
* ``not-quorate``  not an ``orcha/*`` branch, detached, or not a registered git worktree.

Safety rules every removal path goes through (``remove_worktree``):

* only paths that ``git worktree list`` reports, directly under ``<base>/.orcha-worktrees``,
  on an ``orcha/*`` branch — never ``rm -rf``, only ``git worktree remove``;
* ``in-use`` / ``not-quorate`` are refused; ``unmerged`` is refused unless a human explicitly
  confirmed it (and the branch is kept unless they also chose to drop it);
* real output is preserved first (attached to the task, or copied to
  ``<base>/.orcha/saved-output/<branch>/``); ``--force`` is passed only once everything that is
  left is scaffolding, preserved output, or ignored build/dependency directories;
* the branch goes with ``git branch -d`` (``-D`` only when its tip is provably contained in the
  base branch, or a human confirmed dropping unmerged commits).

Nothing here raises into a caller: failures come back as plain-language outcomes.
"""

from __future__ import annotations

import datetime as _dt
import fnmatch
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import time
from typing import Callable, Iterable, Optional

WORKTREES_DIR = ".orcha-worktrees"
SAVED_OUTPUT_DIR = pathlib.Path(".orcha") / "saved-output"
BRANCH_PREFIX = "orcha/"

STATE_CLEAN = "clean"
STATE_HAS_OUTPUT = "has-output"
STATE_UNMERGED = "unmerged"
STATE_IN_USE = "in-use"
STATE_NOT_QUORATE = "not-quorate"
STATES = (STATE_CLEAN, STATE_HAS_OUTPUT, STATE_UNMERGED, STATE_IN_USE, STATE_NOT_QUORATE)

# Files Embodent itself writes or copies into a worktree. Kept in step with
# notifier_worktree_base.overlay_runtime_config (orcha.json, settings.json, orcha-tabs,
# commands/orcha-*.md, .agents/skills/orcha-*) and with what `orcha init` places in a project
# (.orcha/ stack folder, .codex/hooks.json, docs/orcha-project-preferences.md, the
# .claude/.orcha-* runtime files) — a checkout handoff out of the main checkout carries those
# into a worktree too. Matched with fnmatch against the POSIX relative path.
SCAFFOLDING_PATTERNS = (
    ".claude/orcha.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/orcha-tabs/*",
    ".claude/commands/orcha-*.md",
    ".claude/.orcha-*",
    ".agents/skills/orcha-*",
    ".codex/hooks.json",
    ".orcha/*",
    "docs/orcha-project-preferences.md",
)
# ...except these: what an agent deliberately produced inside the .orcha folder.
OUTPUT_UNDER_SCAFFOLDING = (".orcha/outputs/*", ".orcha/saved-output/*")

# Deliverable caps mirror notifier_deliverables / the portal (the portal re-validates).
DELIVERABLE_EXTENSIONS = frozenset({
    "md", "markdown", "txt", "log", "yaml", "yml", "csv", "tsv", "json",
    "pdf", "png", "jpg", "jpeg", "gif", "webp",
})
DELIVERABLE_MAX_BYTES = 10 * 1024 * 1024
MAX_LISTED_PATHS = 200          # paths carried in an inventory row (the count is exact)
MAX_COMPARE_FILES = 5000        # more untracked files than this → not inspected file by file
GIT_TIMEOUT = 60.0

_TASK_BRANCH = re.compile(r"^orcha/task-(?P<agent>.+)-(?P<task>[0-9A-Fa-f]{8}-[0-9A-Fa-f]{1,3})$")
_WK_BRANCH = re.compile(r"^orcha/wk-(?P<agent>.+)-(?P<ms>\d{10,})$")
_RESIDENT_BRANCH = re.compile(r"^orcha/resident-(?P<conv>.+)$")
_LIVE_BRANCH = re.compile(r"^orcha/live-(?P<agent>.+)$")


# ------------------------------------------------------------------ git plumbing

def git(args, cwd, timeout: float = GIT_TIMEOUT) -> tuple[int, str]:
    """Run git without optional locks (so inspection never rewrites an index) — never raises."""
    try:
        p = subprocess.run(
            ["git", "--no-optional-locks", *args], cwd=cwd, capture_output=True, text=True,
            encoding="utf-8", errors="surrogateescape", timeout=timeout, check=False,
        )
        return p.returncode, p.stdout if p.returncode == 0 else (p.stdout + p.stderr)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return 1, str(exc)


def _real(path) -> str:
    try:
        return os.path.realpath(str(path))
    except OSError:
        return str(path)


def worktrees_root(base_cwd) -> str:
    return os.path.join(_real(base_cwd), WORKTREES_DIR)


def list_registered(base_cwd, *, run=git) -> Optional[list[dict]]:
    """Every linked worktree git knows about: [{path, head, branch, locked, prunable}].
    None when ``base_cwd`` is not a git checkout."""
    code, out = run(["worktree", "list", "--porcelain"], base_cwd)
    if code != 0:
        return None
    items, cur = [], {}
    for line in out.splitlines() + [""]:
        if not line.strip():
            if cur.get("path"):
                items.append(cur)
            cur = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            cur = {"path": value, "head": None, "branch": None, "locked": False, "prunable": False}
        elif key == "HEAD":
            cur["head"] = value
        elif key == "branch":
            cur["branch"] = value[len("refs/heads/"):] if value.startswith("refs/heads/") else value
        elif key == "locked":
            cur["locked"] = True
        elif key == "prunable":
            cur["prunable"] = True
    return items


def is_managed_path(base_cwd, path) -> bool:
    """True only for a DIRECT child of ``<base>/.orcha-worktrees`` (after resolving links)."""
    root = worktrees_root(base_cwd)
    rp = _real(path)
    return os.path.dirname(rp) == root and os.path.basename(rp) not in ("", ".", "..")


def managed_worktrees(base_cwd, *, run=git) -> Optional[list[dict]]:
    """Registered worktrees inside ``.orcha-worktrees`` plus unregistered folders there
    (reported as not-quorate, never touched). None when not a git checkout."""
    registered = list_registered(base_cwd, run=run)
    if registered is None:
        return None
    out, seen = [], set()
    for wt in registered:
        if is_managed_path(base_cwd, wt["path"]):
            wt = dict(wt, registered=True)
            out.append(wt)
            seen.add(_real(wt["path"]))
    root = worktrees_root(base_cwd)
    try:
        names = sorted(os.listdir(root))
    except OSError:
        names = []
    for name in names:
        full = os.path.join(root, name)
        if os.path.isdir(full) and not os.path.islink(full) and _real(full) not in seen:
            out.append({"path": full, "head": None, "branch": None, "locked": False,
                        "prunable": False, "registered": False})
    return out


def base_refs(base_cwd, *, run=git) -> list[str]:
    """The refs that count as "merged": the project's base branch, local and on origin.
    The base is origin/HEAD's target when set, else main (else master)."""
    candidates = []
    code, out = run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], base_cwd)
    if code == 0 and out.strip().startswith("refs/remotes/origin/"):
        candidates.append(out.strip()[len("refs/remotes/origin/"):])
    candidates += ["main", "master"]
    refs = []
    for name in candidates:
        for ref in (f"refs/remotes/origin/{name}", f"refs/heads/{name}"):
            if ref not in refs and run(["show-ref", "--verify", "--quiet", ref], base_cwd)[0] == 0:
                refs.append(ref)
        if refs:
            break
    return refs


def unmerged_commits(base_cwd, branch, refs, *, run=git) -> Optional[int]:
    """Commits on ``branch`` that no base ref contains (None = can't tell → treat as unmerged)."""
    if not branch:
        return None
    if not refs:
        return None
    code, out = run(["rev-list", "--count", f"refs/heads/{branch}", "--not", *refs], base_cwd)
    return int(out.strip()) if code == 0 and out.strip().isdigit() else None


def describe_branch(branch: Optional[str]) -> dict:
    """{kind, agent, task_ref, conversation_id} parsed from an orcha/* branch name."""
    info = {"kind": None, "agent": None, "task_ref": None, "conversation_id": None}
    if not branch:
        return info
    m = _TASK_BRANCH.match(branch)
    if m:
        return dict(info, kind="task", agent=m["agent"], task_ref=m["task"])
    m = _WK_BRANCH.match(branch)
    if m:
        return dict(info, kind="wake", agent=m["agent"])
    m = _RESIDENT_BRANCH.match(branch)
    if m:
        return dict(info, kind="resident", conversation_id=m["conv"])
    m = _LIVE_BRANCH.match(branch)
    if m:
        return dict(info, kind="live", agent=m["agent"])
    if branch.startswith(BRANCH_PREFIX):
        return dict(info, kind="other")
    return info


# ------------------------------------------------------------------ file classification

def is_scaffolding(relpath: str) -> bool:
    """Whether a worktree-relative POSIX path is Embodent's own scaffolding."""
    p = relpath[2:] if relpath.startswith("./") else relpath
    for pattern in OUTPUT_UNDER_SCAFFOLDING:
        if fnmatch.fnmatchcase(p, pattern):
            return False
    return any(fnmatch.fnmatchcase(p, pattern) for pattern in SCAFFOLDING_PATTERNS)


def _status(worktree, *, run=git) -> Optional[tuple[list[str], list[str]]]:
    """(tracked modified paths, untracked paths) — one ``git status`` call."""
    code, out = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktree)
    if code != 0:
        return None
    modified, untracked = [], []
    entries = out.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        xy, path = entry[:2], entry[3:]
        if xy == "??":
            untracked.append(path)
        elif xy == "!!":
            continue
        else:
            modified.append(path)
            if xy[0] in "RC":
                i += 1
    return modified, untracked


def _ignored_files(worktree, *, run=git) -> Optional[list[str]]:
    """Individually git-ignored files (an .env, a .tsbuildinfo). Wholly ignored directories
    (node_modules/, build/, .venv/) are dependency/build output and are skipped as a unit."""
    code, out = run(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory",
                     "--no-empty-directory", "-z"], worktree)
    if code != 0:
        return None
    return [p for p in out.split("\0") if p and not p.endswith("/")]


def _outputs_folder_files(worktree) -> list[str]:
    """Files under ``.orcha/outputs`` — the deliverables folder ignores itself (``*``), so git
    never lists it; walk it directly (no symlinks followed, its own .gitignore skipped)."""
    root = os.path.join(worktree, ".orcha", "outputs")
    if os.path.islink(root) or not os.path.isdir(root):
        return []
    found = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if full == os.path.join(root, ".gitignore"):
                continue
            found.append(os.path.relpath(full, worktree).replace(os.sep, "/"))
    return found


def _same_file(a: str, b: str) -> bool:
    try:
        if os.path.islink(a) or os.path.islink(b):
            return os.path.islink(a) and os.path.islink(b) and os.readlink(a) == os.readlink(b)
        sa, sb = os.stat(a), os.stat(b)
        if sa.st_size != sb.st_size:
            return False
        with open(a, "rb") as fa, open(b, "rb") as fb:
            while True:
                ca, cb = fa.read(1 << 20), fb.read(1 << 20)
                if ca != cb:
                    return False
                if not ca:
                    return True
    except OSError:
        return False


def _file_size(path: str) -> int:
    try:
        return os.lstat(path).st_size
    except OSError:
        return 0


def sha256_of(path: str) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def real_changes(base_cwd, worktree, *, run=git) -> Optional[dict]:
    """{modified, output, scaffolding, copies, ignored, uninspected} for one worktree, or None.

    ``output`` = untracked files that are neither scaffolding nor a byte-identical copy of the
    same file in the main checkout, plus everything in ``.orcha/outputs``. Git-ignored files
    elsewhere are what the project itself declared generated/local (build info, caches, .env
    copies) and are only counted (``ignored``), like wholly ignored folders such as
    node_modules/."""
    st = _status(worktree, run=run)
    ignored = _ignored_files(worktree, run=run)
    if st is None or ignored is None:
        return None
    modified, untracked = st
    result = {"modified": [], "output": [], "scaffolding": 0, "copies": 0,
              "ignored": 0, "uninspected": False}
    for path in modified:
        if is_scaffolding(path):
            result["scaffolding"] += 1
        else:
            result["modified"].append(path)
    real = []
    outputs = _outputs_folder_files(worktree)
    for path in list(dict.fromkeys(untracked + outputs)):
        if is_scaffolding(path):
            result["scaffolding"] += 1
        else:
            real.append(path)
    outputs_set = set(outputs)
    for path in ignored:
        if path in outputs_set:
            continue
        if is_scaffolding(path):
            result["scaffolding"] += 1
        else:
            result["ignored"] += 1
    if len(real) > MAX_COMPARE_FILES:
        # Too many to compare one by one: keep them all as output (fail safe).
        result["output"] = real
        result["uninspected"] = True
        return result
    base = _real(base_cwd)
    for path in real:
        if _same_file(os.path.join(worktree, path), os.path.join(base, path)):
            # A handoff copied this file in from the main checkout, where it still lives.
            result["copies"] += 1
        else:
            result["output"].append(path)
    return result


# ------------------------------------------------------------------ in-use / size / age

def process_cwds() -> set[str]:
    """Current working directories of every process this user can see (one lsof call).
    Claude/Codex sessions, terminals and preview servers all run with cwd = the worktree."""
    try:
        p = subprocess.run(["lsof", "-n", "-w", "-d", "cwd", "-F", "n"], capture_output=True,
                           text=True, timeout=20, check=False)
    except (OSError, subprocess.SubprocessError):
        return set()
    return {line[1:] for line in p.stdout.splitlines() if line.startswith("n/")}


def path_in_use(path: str, busy: Iterable[str]) -> bool:
    rp = _real(path)
    for b in busy:
        if not b:
            continue
        rb = _real(b)
        if rb == rp or rb.startswith(rp + os.sep):
            return True
    return False


def dir_size(path: str, *, timeout: float = 120.0) -> Optional[int]:
    """Bytes on disk (du -sk; a Python walk as fallback)."""
    try:
        p = subprocess.run(["du", "-sk", path], capture_output=True, text=True,
                           timeout=timeout, check=False)
        first = (p.stdout.split() or [""])[0]
        if first.isdigit():
            return int(first) * 1024
    except (OSError, subprocess.SubprocessError):
        pass
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(dirpath, name)).st_blocks * 512
            except OSError:
                pass
    return total


def admin_dir(worktree) -> Optional[str]:
    """The worktree's private git dir (``<repo>/.git/worktrees/<name>``)."""
    try:
        text = pathlib.Path(worktree, ".git").read_text().strip()
    except OSError:
        return None
    if not text.startswith("gitdir:"):
        return None
    d = text[len("gitdir:"):].strip()
    return d if os.path.isabs(d) else os.path.normpath(os.path.join(worktree, d))


def last_activity(worktree) -> Optional[float]:
    """Newest of: the worktree folder, its HEAD reflog and index (``--no-optional-locks``
    keeps our own inspection from refreshing them), and the files at its top level."""
    stamps = []
    for p in (worktree, os.path.join(worktree, ".git")):
        try:
            stamps.append(os.lstat(p).st_mtime)
        except OSError:
            pass
    adm = admin_dir(worktree)
    if adm:
        for name in ("logs/HEAD", "index", "HEAD"):
            try:
                stamps.append(os.stat(os.path.join(adm, name)).st_mtime)
            except OSError:
                pass
    try:
        with os.scandir(worktree) as it:
            for entry in it:
                try:
                    stamps.append(entry.stat(follow_symlinks=False).st_mtime)
                except OSError:
                    pass
    except OSError:
        pass
    return max(stamps) if stamps else None


def _iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).isoformat()


# ------------------------------------------------------------------ classification

def classify(base_cwd, wt: dict, *, busy: Iterable[str] = (), refs: Optional[list[str]] = None,
             measure: bool = True, run=git, now: Optional[float] = None,
             size_cache: Optional[dict] = None) -> dict:
    """One inventory row for a worktree entry from ``managed_worktrees``."""
    now = time.time() if now is None else now
    path = wt["path"]
    branch = wt.get("branch")
    info = describe_branch(branch)
    act = last_activity(path)
    row = {
        "path": path,
        "name": os.path.basename(path.rstrip(os.sep)),
        "branch": branch,
        "kind": info["kind"],
        "agent": info["agent"],
        "task_ref": info["task_ref"],
        "conversation_id": info["conversation_id"],
        "head": wt.get("head"),
        "state": STATE_CLEAN,
        "reason": "",
        "unmerged_commits": 0,
        "modified": [],
        "output": [],
        "modified_count": 0,
        "output_count": 0,
        "output_bytes": 0,
        "scaffolding_files": 0,
        "copied_files": 0,
        "ignored_files": 0,
        "size_bytes": None,
        "last_activity_at": _iso(act),
        "age_seconds": int(now - act) if act else None,
    }
    if measure:
        cache_key = (path, int(act or 0))
        if size_cache is not None and cache_key in size_cache:
            row["size_bytes"] = size_cache[cache_key]
        else:
            row["size_bytes"] = dir_size(path)
            if size_cache is not None:
                size_cache[cache_key] = row["size_bytes"]

    if not wt.get("registered", True):
        return dict(row, state=STATE_NOT_QUORATE, reason="not registered with git — left alone")
    if not branch:
        return dict(row, state=STATE_NOT_QUORATE, reason="detached HEAD — not an Orcha branch")
    if not branch.startswith(BRANCH_PREFIX):
        return dict(row, state=STATE_NOT_QUORATE, reason=f"branch {branch} is not an Orcha branch")
    if not os.path.isdir(path):
        return dict(row, state=STATE_NOT_QUORATE, reason="the folder is missing (run git worktree prune)")

    refs = base_refs(base_cwd, run=run) if refs is None else refs
    ahead = unmerged_commits(base_cwd, branch, refs, run=run)
    changes = real_changes(base_cwd, path, run=run)
    if changes is not None:
        row["modified"] = changes["modified"][:MAX_LISTED_PATHS]
        row["output"] = changes["output"][:MAX_LISTED_PATHS]
        row["modified_count"] = len(changes["modified"])
        row["output_count"] = len(changes["output"])
        row["output_bytes"] = sum(_file_size(os.path.join(path, p))
                                  for p in changes["output"] + changes["modified"])
        row["scaffolding_files"] = changes["scaffolding"]
        row["copied_files"] = changes["copies"]
        row["ignored_files"] = changes["ignored"]
    row["unmerged_commits"] = ahead if ahead is not None else None

    if wt.get("locked"):
        return dict(row, state=STATE_IN_USE, reason="locked with git worktree lock")
    if path_in_use(path, busy):
        return dict(row, state=STATE_IN_USE, reason="a run, session, terminal or preview is using it")
    if ahead is None:
        return dict(row, state=STATE_UNMERGED,
                    reason="couldn't compare with the base branch — kept to be safe")
    if ahead > 0:
        return dict(row, state=STATE_UNMERGED,
                    reason=f"{ahead} commit{'s' if ahead != 1 else ''} not on the base branch")
    if changes is None:
        return dict(row, state=STATE_HAS_OUTPUT, reason="couldn't read its status — kept to be safe")
    if changes["modified"] or changes["output"]:
        parts = []
        if changes["output"]:
            n = len(changes["output"])
            parts.append(f"{n} new file{'s' if n != 1 else ''}")
        if changes["modified"]:
            n = len(changes["modified"])
            parts.append(f"{n} changed file{'s' if n != 1 else ''}")
        return dict(row, state=STATE_HAS_OUTPUT, reason=" and ".join(parts))
    return dict(row, state=STATE_CLEAN, reason="only Embodent scaffolding — safe to remove")


def inventory(base_cwd, *, busy: Iterable[str] = (), measure: bool = True, run=git,
              include_process_cwds: bool = True, size_cache: Optional[dict] = None) -> Optional[list[dict]]:
    """Classify every worktree under ``.orcha-worktrees`` (None when not a git checkout)."""
    wts = managed_worktrees(base_cwd, run=run)
    if wts is None:
        return None
    busy = set(busy)
    if include_process_cwds and wts:
        busy |= {c for c in process_cwds() if c.startswith(worktrees_root(base_cwd))}
    refs = base_refs(base_cwd, run=run)
    now = time.time()
    return [classify(base_cwd, wt, busy=busy, refs=refs, measure=measure, run=run, now=now,
                     size_cache=size_cache) for wt in wts]


def reclaimable_bytes(rows: Iterable[dict]) -> int:
    return sum(r.get("size_bytes") or 0 for r in rows
               if r.get("state") in (STATE_CLEAN, STATE_HAS_OUTPUT))


# ------------------------------------------------------------------ preservation

def _preserved_marker(worktree) -> Optional[pathlib.Path]:
    adm = admin_dir(worktree)
    return pathlib.Path(adm) / "orcha-preserved.json" if adm else None


def read_preserved(worktree) -> dict:
    """{relpath: {sha256, where}} of output already attached / saved for this worktree."""
    marker = _preserved_marker(worktree)
    try:
        data = json.loads(marker.read_text()) if marker and marker.is_file() else {}
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_preserved(worktree, data: dict) -> None:
    marker = _preserved_marker(worktree)
    if not marker:
        return
    try:
        tmp = marker.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1, sort_keys=True))
        os.replace(tmp, marker)
    except OSError:
        pass


def deliverable_path(relpath: str) -> str:
    """The logical deliverable path for a worktree file (.orcha/outputs/x → x, like the
    run-end collector, so a re-upload is a dedupe instead of a second copy)."""
    prefix = ".orcha/outputs/"
    return relpath[len(prefix):] if relpath.startswith(prefix) else relpath


def deliverable_eligible(full: str, relpath: str) -> bool:
    name = os.path.basename(relpath)
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in DELIVERABLE_EXTENSIONS or os.path.islink(full):
        return False
    size = _file_size(full)
    return 0 < size <= DELIVERABLE_MAX_BYTES


def saved_output_dir(base_cwd, branch: str) -> pathlib.Path:
    slug = re.sub(r"[^A-Za-z0-9._-]", "-", (branch or "worktree").replace(BRANCH_PREFIX, "", 1))
    return pathlib.Path(_real(base_cwd)) / SAVED_OUTPUT_DIR / (slug.strip(".-") or "worktree")


def _copy_into(src: str, dest: pathlib.Path) -> bool:
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if os.path.islink(src):
            if dest.exists() or dest.is_symlink():
                dest.unlink()
            os.symlink(os.readlink(src), dest)
            return True
        shutil.copy2(src, dest, follow_symlinks=False)
        return _same_file(src, str(dest))
    except OSError:
        return False


def preserve_output(base_cwd, row: dict, *, task_id: Optional[str] = None,
                    run_id: Optional[str] = None,
                    upload: Optional[Callable[[str, str, str, Optional[str]], bool]] = None,
                    run=git) -> dict:
    """Make sure every real output / changed file of a worktree survives its removal.

    Each file is attached to ``task_id`` as a deliverable when it can be (type/size allowed,
    task still open — ``upload(task_id, logical_path, full_path, run_id) -> bool``); everything
    else is copied to ``<base>/.orcha/saved-output/<branch>/<path>``. Already-preserved files
    (same sha256) are not re-sent. Returns {attached, saved, failed, saved_to, preserved}."""
    worktree = row["path"]
    changes = real_changes(base_cwd, worktree, run=run)
    result = {"attached": [], "saved": [], "failed": [], "saved_to": None, "preserved": []}
    if changes is None:
        result["failed"].append({"path": "*", "reason": "couldn't read the worktree's status"})
        return result
    files = list(dict.fromkeys(changes["output"] + changes["modified"]))
    marker = read_preserved(worktree)
    dest_root = saved_output_dir(base_cwd, row.get("branch") or row.get("name") or "worktree")
    for rel in files:
        full = os.path.join(worktree, rel)
        if not os.path.lexists(full):
            # A tracked file the agent deleted: the deletion is the change. Record it in the
            # saved-output folder so the removal never silently drops it.
            note = dest_root / (rel + ".deleted")
            try:
                note.parent.mkdir(parents=True, exist_ok=True)
                note.write_text(f"{rel} was deleted in {row.get('branch')}\n")
                result["saved"].append(rel)
                result["preserved"].append(rel)
                result["saved_to"] = str(dest_root)
                marker[rel] = {"sha256": None, "where": str(note)}
            except OSError:
                result["failed"].append({"path": rel, "reason": "couldn't record the deletion"})
            continue
        sha = sha256_of(full) if not os.path.islink(full) else "link:" + os.readlink(full)
        prior = marker.get(rel)
        if prior and prior.get("sha256") == sha and sha is not None:
            where = prior.get("where") or ""
            if where.startswith("task:") or os.path.lexists(where):
                result["preserved"].append(rel)
                continue
        attached = False
        if task_id and upload and deliverable_eligible(full, rel):
            try:
                attached = bool(upload(task_id, deliverable_path(rel), full, run_id))
            except Exception:  # noqa: BLE001 - an upload error falls back to a local copy
                attached = False
        if attached:
            result["attached"].append(rel)
            result["preserved"].append(rel)
            marker[rel] = {"sha256": sha, "where": f"task:{task_id}"}
            continue
        dest = dest_root / rel
        if _copy_into(full, dest):
            result["saved"].append(rel)
            result["preserved"].append(rel)
            result["saved_to"] = str(dest_root)
            marker[rel] = {"sha256": sha, "where": str(dest)}
        else:
            result["failed"].append({"path": rel, "reason": "couldn't copy it"})
    if result["saved"]:
        try:
            gi = pathlib.Path(_real(base_cwd)) / SAVED_OUTPUT_DIR / ".gitignore"
            if not gi.exists():
                gi.parent.mkdir(parents=True, exist_ok=True)
                gi.write_text("*\n")
        except OSError:
            pass
    _write_preserved(worktree, marker)
    return result


# ------------------------------------------------------------------ removal

def _delete_branch(base_cwd, branch: str, refs: list[str], *, drop_unmerged: bool, run=git) -> tuple[bool, str]:
    if not branch or not branch.startswith(BRANCH_PREFIX):
        return False, "not an Orcha branch — kept"
    if run(["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], base_cwd)[0] != 0:
        return True, "already gone"
    code, out = run(["branch", "-d", branch], base_cwd)
    if code == 0:
        return True, "deleted"
    # `branch -d` judges "merged" against the main checkout's HEAD (or the upstream). When the
    # main checkout is on some other branch, fall back to -D only if the tip is provably on
    # the base branch.
    for ref in refs:
        if run(["merge-base", "--is-ancestor", f"refs/heads/{branch}", ref], base_cwd)[0] == 0:
            code, out = run(["branch", "-D", branch], base_cwd)
            return code == 0, "deleted" if code == 0 else out.strip()[:200]
    if drop_unmerged:
        code, out = run(["branch", "-D", branch], base_cwd)
        return code == 0, "deleted (unmerged commits dropped as confirmed)" if code == 0 else out.strip()[:200]
    return False, "kept — it has commits that aren't on the base branch"


def remove_worktree(base_cwd, path: str, *, busy: Iterable[str] = (),
                    allow_unmerged: bool = False, keep_branch: bool = False,
                    allow_output: bool = True, task_id: Optional[str] = None,
                    run_id: Optional[str] = None, upload=None, dry_run: bool = False,
                    include_process_cwds: bool = True, run=git) -> dict:
    """Safely remove ONE agent worktree. Returns {ok, outcome, path, branch, state, freed_bytes,
    branch_deleted, branch_note, preserved: {...}|None, reason}.

    ``allow_unmerged`` = a human explicitly confirmed removing a worktree whose branch has
    unmerged commits; the branch is then still kept unless ``keep_branch`` is False.
    ``allow_output`` = False refuses has-output (the automatic path before the grace period)."""
    out = {"ok": False, "outcome": "refused", "path": path, "branch": None, "state": None,
           "freed_bytes": 0, "branch_deleted": False, "branch_note": None, "preserved": None,
           "reason": ""}
    if not is_managed_path(base_cwd, path):
        return dict(out, reason="not inside this project's .orcha-worktrees folder")
    registered = [w for w in (managed_worktrees(base_cwd, run=run) or [])
                  if _real(w["path"]) == _real(path)]
    if not registered or not registered[0].get("registered"):
        return dict(out, reason="git doesn't list it as a worktree — not touched")
    wt = registered[0]
    busy = set(busy)
    if include_process_cwds:
        busy |= {c for c in process_cwds() if c.startswith(worktrees_root(base_cwd))}
    refs = base_refs(base_cwd, run=run)
    row = classify(base_cwd, wt, busy=busy, refs=refs, measure=True, run=run)
    out.update(branch=row["branch"], state=row["state"], freed_bytes=row["size_bytes"] or 0)
    if row["state"] == STATE_NOT_QUORATE:
        return dict(out, reason=row["reason"])
    if row["state"] == STATE_IN_USE:
        return dict(out, reason=row["reason"])
    if row["state"] == STATE_UNMERGED and not allow_unmerged:
        return dict(out, reason=row["reason"] + " — never removed automatically")
    needs_preserve = bool(row["output_count"] or row["modified_count"])
    if needs_preserve and not allow_output:
        return dict(out, reason="it has output that is still in its grace period")
    if dry_run:
        return dict(out, ok=True, outcome="would-remove", reason=row["reason"])
    if needs_preserve:
        kept = preserve_output(base_cwd, row, task_id=task_id, run_id=run_id, upload=upload, run=run)
        out["preserved"] = kept
        if kept["failed"]:
            return dict(out, reason="some output couldn't be saved, so the worktree was kept: "
                        + ", ".join(f["path"] for f in kept["failed"][:5]))
        # Re-check right before removing: anything real that is NOT preserved stops it.
        again = real_changes(base_cwd, path, run=run)
        if again is None:
            return dict(out, reason="couldn't re-read its status — kept")
        left = set(again["output"] + again["modified"]) - set(kept["preserved"])
        if left:
            return dict(out, reason=f"{len(left)} new file(s) appeared while saving — kept")
    if row["state"] != STATE_UNMERGED:
        # Fresh look at commits too: an agent could have committed since the classification.
        ahead = unmerged_commits(base_cwd, row["branch"], refs, run=run)
        if ahead is None or ahead > 0:
            return dict(out, state=STATE_UNMERGED, reason="it now has unmerged commits — kept")
    # Everything left is scaffolding, preserved output or ignored build/dependency folders,
    # which is the only case --force is used for.
    code, msg = run(["worktree", "remove", "--force", path], base_cwd, 300)
    if code != 0:
        return dict(out, outcome="failed", reason=f"git worktree remove failed: {msg.strip()[:300]}")
    run(["worktree", "prune"], base_cwd)
    out.update(ok=True, outcome="removed", reason=row["reason"])
    if keep_branch:
        out["branch_note"] = "kept as requested"
    else:
        deleted, note = _delete_branch(base_cwd, row["branch"], refs,
                                       drop_unmerged=allow_unmerged and not keep_branch, run=run)
        out.update(branch_deleted=deleted, branch_note=note)
    return out


# ------------------------------------------------------------------ host-side memory

def state_path(base_cwd) -> Optional[pathlib.Path]:
    """``<git common dir>/orcha/worktree-gc.json`` — first-seen times etc., never committed."""
    code, common = git(["rev-parse", "--git-common-dir"], base_cwd)
    if code != 0 or not common.strip():
        return None
    p = pathlib.Path(common.strip())
    if not p.is_absolute():
        p = pathlib.Path(base_cwd) / p
    return p.resolve() / "orcha" / "worktree-gc.json"


def load_state(base_cwd) -> dict:
    p = state_path(base_cwd)
    try:
        data = json.loads(p.read_text()) if p and p.is_file() else {}
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(base_cwd, data: dict) -> None:
    p = state_path(base_cwd)
    if not p:
        return
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1, sort_keys=True))
        os.replace(tmp, p)
    except OSError:
        pass


def first_seen(base_cwd, rows: Iterable[dict], *, now: Optional[float] = None) -> dict:
    """{path: epoch} when the housekeeper first saw each worktree. A worktree that already
    existed before the upgrade gets "now" — its grace period starts today, so nothing
    vanishes the moment someone upgrades. Forgotten paths are dropped."""
    now = time.time() if now is None else now
    data = load_state(base_cwd)
    seen = data.get("first_seen") if isinstance(data.get("first_seen"), dict) else {}
    paths = {r["path"] for r in rows}
    changed = False
    for p in paths:
        if p not in seen:
            seen[p] = now
            changed = True
    for p in list(seen):
        if p not in paths:
            del seen[p]
            changed = True
    if changed:
        data["first_seen"] = seen
        save_state(base_cwd, data)
    return seen


def human_bytes(n: Optional[int]) -> str:
    if n is None:
        return "?"
    size = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"
