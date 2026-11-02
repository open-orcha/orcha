"""Bring an agent's changes into the main checkout — and the reverse — on request (GH #288).

Every agent works in its own worktree under ``.orcha-worktrees``. Nothing moves between
checkouts on a worker's start path any more; a human asks for it, explicitly, and sees a
dry run first. Every git operation here runs on the HOST (the notifier daemon or the
``orcha worktrees`` CLI); the portal only records the request and the result.

Two directions, both per task worktree:

``bring_in``   agent worktree → main checkout. The agent's delta = its commits since the
               branch forked from the base ref PLUS its uncommitted tracked and untracked
               files (never git-ignored files, never Embodent's scaffolding). Two result
               forms, the human chooses per bring-in:
                 * ``apply``  the delta lands in main's WORKING TREE, uncommitted and unstaged
                              (default: nothing is ever committed in main without the human);
                 * ``merge``  the agent's uncommitted work is WIP-committed on its branch and
                              the branch is merged with ``--no-ff`` into main's current branch.
``update``     main checkout → agent worktree ("update from main"): main's HEAD is merged into
               the agent's branch and main's uncommitted changes are applied on top, so the
               agent's branch does not drift.

How a delta moves (both directions, ``apply`` form): the two checkouts are snapshotted as
throw-away commits (HEAD + everything uncommitted, scaffolding and ignored files left out)
and merged — the fork point is the merge base — in a TEMPORARY worktree. A clean merge yields
a result tree; the diff from the receiving checkout's snapshot to that result is what the
human sees in the dry run and what the real run applies to the receiving working tree as
plain uncommitted changes. Conflicts are reported and nothing is applied. Because it is a
merge, a repeat bring-in only adds what main does not have yet, and main having moved ahead
since the agent branched is just the ordinary three-way case.

Rules shared by both:
  * Dry run first, always: ``plan_*`` changes nothing and reports files, conflicts, the base
    commit check, the receiving checkout's dirty files (and so whether a stash is offered)
    and which branch main is on. The real run refuses anything the plan would have refused.
  * The receiving checkout's own uncommitted changes are never committed: when the human asks
    for it they go into a NAMED stash (``orcha-bring-in/<worktree>/<stamp>`` or the human's own
    message), are restored by SHA afterwards and dropped only when the restore was clean (a
    restore that would conflict is rehearsed and skipped: the entry stays for the human).
    Never bare ``git stash`` / ``pop`` on the shared stack. ``merge`` form needs the stash
    when main is dirty (git merge wants a clean tree); ``apply`` form can also merge on top of
    the dirty files — the three-way merge then carries the human's edits too.
  * If main is checked out on a branch other than the agent's base, the human must confirm
    (``allow_other_branch``) or the run is refused.
  * Each bring-in is recorded under ``<git-common-dir>/orcha/bring-in/<worktree name>.json``
    (when, which files, which main commit) so the UI can say "last brought in …".
  * The agent's worktree is left untouched by ``apply``; ``merge`` adds a WIP commit to its
    branch (that is what makes the merge possible); ``update`` is the explicit exception.
  * Whether the agent is running is decided by the caller (portal / daemon busy set); the
    functions here only need ``busy`` to refuse politely.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
from typing import Optional

from . import worktree_gc as gc

RECORD_DIR = ("orcha", "bring-in")
STASH_PREFIX = "orcha-bring-in"
MODES = ("apply", "merge")
GIT_TIMEOUT = 120.0
_IDENTITY = ("-c", "user.name=Orcha", "-c", "user.email=orcha@localhost")

# The same scaffolding git never carries between checkouts (notifier_worktree_cleanup).
SCAFFOLD_PATHSPECS = (
    ":(glob).claude/orcha.json",
    ":(glob).claude/orcha-tabs/**",
    ":(glob).claude/settings.json",
    ":(glob).claude/settings.local.json",
    ":(glob).claude/commands/orcha-*.md",
    ":(glob).claude/.orcha-*",
    ":(glob).agents/skills/orcha-*",
    ":(glob).agents/skills/orcha-*/**",
    ":(glob).codex/hooks.json",
    ":(glob).orcha/**",
    ":(glob)docs/orcha-project-preferences.md",
)
# The same patterns as EXCLUDE pathspecs (for `stash push`).
SCAFFOLD_EXCLUDES = tuple(":(exclude,glob)" + p[len(":(glob)"):] for p in SCAFFOLD_PATHSPECS)


class BringInError(Exception):
    """A refusal or failure with a human-readable reason (never a traceback for the UI)."""


# ------------------------------------------------------------------ git plumbing

def _git(args, cwd, *, env: Optional[dict] = None, timeout: float = GIT_TIMEOUT) -> tuple[int, str]:
    """Run git (optional locks off for inspection) — never raises."""
    full_env = {**os.environ, **(env or {})}
    try:
        p = subprocess.run(
            ["git", "--no-optional-locks", *args], cwd=cwd, capture_output=True, text=True,
            encoding="utf-8", errors="surrogateescape", timeout=timeout, check=False, env=full_env,
        )
        return p.returncode, p.stdout if p.returncode == 0 else (p.stdout + p.stderr)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return 1, str(exc)


def _must(args, cwd, *, env=None, what: str = "") -> str:
    code, out = _git(args, cwd, env=env)
    if code != 0:
        raise BringInError(f"{what or ('git ' + ' '.join(args[:2]))} failed: {out.strip()[:500]}")
    return out


def _common_dir(base_cwd) -> pathlib.Path:
    out = _must(["rev-parse", "--git-common-dir"], base_cwd, what="locating the repository")
    path = pathlib.Path(out.strip())
    return path if path.is_absolute() else (pathlib.Path(base_cwd) / path).resolve()


def _head(cwd) -> str:
    return _must(["rev-parse", "--verify", "HEAD"], cwd, what="reading HEAD").strip()


def _current_branch(cwd) -> Optional[str]:
    code, out = _git(["symbolic-ref", "--short", "-q", "HEAD"], cwd)
    return out.strip() if code == 0 and out.strip() else None


def _base_branch_name(base_cwd) -> str:
    """The branch agents fork from: origin/HEAD's target, else main, else master."""
    for ref in gc.base_refs(base_cwd):
        if ref.startswith("refs/remotes/origin/"):
            return ref[len("refs/remotes/origin/"):]
        if ref.startswith("refs/heads/"):
            return ref[len("refs/heads/"):]
    return "main"


def _is_worktree_path(relpath: str) -> bool:
    p = relpath[2:] if relpath.startswith("./") else relpath
    return p == gc.WORKTREES_DIR or p.startswith(gc.WORKTREES_DIR + "/")


def _dirty_files(cwd) -> list[str]:
    """Uncommitted tracked + untracked (not ignored) paths, scaffolding excluded."""
    st = gc._status(cwd)
    if st is None:
        raise BringInError(f"{cwd} is not a git checkout")
    modified, untracked = st
    return sorted(p for p in dict.fromkeys(modified + untracked)
                  if not gc.is_scaffolding(p) and not _is_worktree_path(p))


def _snapshot_tree(cwd) -> str:
    """A tree id of the checkout's CURRENT content (HEAD + uncommitted tracked + untracked,
    ignored files and scaffolding left out), written with a private index so the real one
    is never touched."""
    fd, index = tempfile.mkstemp(prefix="orcha-bringin-index-")
    os.close(fd)
    os.unlink(index)  # git wants to create it
    env = {"GIT_INDEX_FILE": index}
    try:
        _must(["read-tree", "HEAD"], cwd, env=env, what="reading the index")
        _must(["add", "-A", "--", "."], cwd, env=env, what="staging the snapshot")
        _git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", gc.WORKTREES_DIR,
              *SCAFFOLD_PATHSPECS], cwd, env=env)
        return _must(["write-tree"], cwd, env=env, what="writing the snapshot").strip()
    finally:
        try:
            os.unlink(index)
        except OSError:
            pass


def _commit_tree(cwd, tree: str, parent: str, message: str) -> str:
    env = {
        "GIT_AUTHOR_NAME": "Orcha", "GIT_AUTHOR_EMAIL": "orcha@localhost",
        "GIT_COMMITTER_NAME": "Orcha", "GIT_COMMITTER_EMAIL": "orcha@localhost",
    }
    code, out = _git(["commit-tree", tree, "-p", parent, "-m", message], cwd, env=env)
    if code != 0:
        raise BringInError(f"could not write a snapshot commit: {out.strip()[:300]}")
    return out.strip()


def _snapshot_commit(cwd, label: str, parent: Optional[str] = None) -> tuple[str, str]:
    """(commit, tree) of the checkout's current content, parented on ``parent`` (its HEAD)."""
    tree = _snapshot_tree(cwd)
    return _commit_tree(cwd, tree, parent or _head(cwd), f"orcha bring-in snapshot: {label}"), tree


def _changed_files(cwd, from_tree: str, to_tree: str) -> list[dict]:
    out = _must(["diff-tree", "-r", "--name-status", "-z", from_tree, to_tree], cwd,
                what="listing changed files")
    parts = out.split("\0")
    files, i = [], 0
    while i < len(parts) - 1:
        status, path = parts[i], parts[i + 1]
        i += 2
        if not status:
            continue
        if status[0] in "RC" and i < len(parts):
            files.append({"status": status[0], "path": parts[i], "from": path})
            i += 1
        else:
            files.append({"status": status[0], "path": path})
    return files


def _patch(cwd, from_tree: str, to_tree: str) -> str:
    code, out = _git(["diff-tree", "-p", "--binary", "--full-index", "-r", from_tree, to_tree], cwd)
    if code != 0:
        raise BringInError(f"could not build the patch: {out.strip()[:300]}")
    return out


def _conflicted(cwd) -> list[str]:
    code, out = _git(["diff", "--name-only", "--diff-filter=U", "-z"], cwd)
    return sorted(p for p in out.split("\0") if p) if code == 0 else []


class _TempWorktree:
    """A detached throw-away worktree at ``commit`` — rehearsals never touch a real checkout."""

    def __init__(self, base_cwd, commit: str):
        self.base_cwd, self.commit, self.path = base_cwd, commit, None

    def __enter__(self):
        self.path = tempfile.mkdtemp(prefix="orcha-bringin-")
        code, out = _git(["worktree", "add", "--detach", "--no-checkout", self.path, self.commit],
                         self.base_cwd)
        if code != 0:
            shutil.rmtree(self.path, ignore_errors=True)
            raise BringInError(f"could not create a rehearsal worktree: {out.strip()[:300]}")
        _must(["checkout", "-q", "--detach", self.commit], self.path, what="rehearsal checkout")
        return self.path

    def __exit__(self, *exc):
        if self.path:
            _git(["worktree", "remove", "--force", "--force", self.path], self.base_cwd)
            shutil.rmtree(self.path, ignore_errors=True)
            _git(["worktree", "prune"], self.base_cwd)
        return False


def _merge_in_temp(base_cwd, ours: str, theirs: str) -> tuple[Optional[str], list[str], Optional[str]]:
    """Merge ``theirs`` onto ``ours`` in a rehearsal worktree → (result tree, conflicts, error)."""
    with _TempWorktree(base_cwd, ours) as tmp:
        code, out = _git([*_IDENTITY, "merge", "--no-ff", "--no-commit", theirs], tmp)
        if code != 0:
            conflicts = _conflicted(tmp)
            _git(["merge", "--abort"], tmp)
            if conflicts:
                return None, conflicts, None
            return None, [], "the changes don't merge: " + out.strip()[:300]
        tree = _must(["write-tree"], tmp, what="writing the merge result").strip()
        _git(["merge", "--abort"], tmp)
    return tree, [], None


def _apply_to_working_tree(cwd, patch: str) -> tuple[bool, str]:
    """Plain ``git apply``: the working tree changes, the index does not (so everything the
    human sees afterwards is unstaged). The patch was built against this exact tree."""
    if not patch.strip():
        return True, ""
    with tempfile.NamedTemporaryFile("w", suffix=".patch", prefix="orcha-bringin-",
                                     delete=False, encoding="utf-8", errors="surrogateescape") as fh:
        fh.write(patch)
        name = fh.name
    try:
        code, out = _git(["apply", "--whitespace=nowarn", name], cwd)
    finally:
        try:
            os.unlink(name)
        except OSError:
            pass
    return code == 0, out


# ------------------------------------------------------------------ records

def record_path(base_cwd, worktree) -> pathlib.Path:
    name = os.path.basename(gc._real(worktree).rstrip("/"))
    return _common_dir(base_cwd).joinpath(*RECORD_DIR) / f"{name}.json"


def read_record(base_cwd, worktree) -> Optional[dict]:
    try:
        data = json.loads(record_path(base_cwd, worktree).read_text())
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def write_record(base_cwd, worktree, data: dict) -> None:
    path = record_path(base_cwd, worktree)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True))


def _sync_ref(name: str) -> str:
    return f"refs/orcha/bring-in/{name}"


def sync_point(base_cwd, info: dict) -> str:
    """The commit both sides last agreed on: the agent snapshot of the previous bring-in /
    update (kept alive under refs/orcha/bring-in/<name>), else the branch's fork point. It is
    the merge base of every rehearsal, so a repeat bring-in only carries what changed since —
    main's uncommitted copy of an earlier bring-in never reads as an add/add conflict (Q10)."""
    code, out = _git(["rev-parse", "--verify", "-q", _sync_ref(info["name"]) + "^{commit}"], base_cwd)
    return out.strip() if code == 0 and out.strip() else info["fork_point"]


def _mark_sync_point(base_cwd, info: dict, tree: str) -> str:
    commit = _commit_tree(base_cwd, tree, sync_point(base_cwd, info),
                          f"orcha bring-in sync point: {info['branch']}")
    _git(["update-ref", _sync_ref(info["name"]), commit], base_cwd)
    return commit


# ------------------------------------------------------------------ shared inspection

def _ensure_worktrees_excluded(base_cwd) -> None:
    """`.orcha-worktrees/` must be git-excluded in the main checkout, or a stash / snapshot
    would see the nested checkouts as content (the notifier does the same on provisioning)."""
    try:
        exclude = _common_dir(base_cwd) / "info" / "exclude"
        line = gc.WORKTREES_DIR + "/"
        existing = exclude.read_text().splitlines() if exclude.exists() else []
        if line not in existing and gc.WORKTREES_DIR not in existing:
            exclude.parent.mkdir(parents=True, exist_ok=True)
            exclude.write_text("\n".join(existing + [line]) + "\n")
    except (OSError, BringInError):
        pass


def _inspect(base_cwd, worktree, busy=()) -> dict:
    """Facts both directions need (raises BringInError when the request can't make sense)."""
    base_cwd, worktree = gc._real(base_cwd), gc._real(worktree)
    if not os.path.isdir(worktree):
        raise BringInError("that worktree is no longer there")
    if not gc.is_managed_path(base_cwd, worktree):
        raise BringInError("only a worktree under .orcha-worktrees can be brought in")
    if gc.path_in_use(worktree, busy):
        raise BringInError("the agent is running in that worktree — wait for its run to finish")
    _ensure_worktrees_excluded(base_cwd)
    branch = _current_branch(worktree)
    if not branch:
        raise BringInError("the agent worktree is not on a branch (detached HEAD)")
    base_branch = _base_branch_name(base_cwd)
    main_branch = _current_branch(base_cwd)
    main_head = _head(base_cwd)
    branch_head = _head(worktree)
    code, out = _git(["merge-base", main_head, branch_head], base_cwd)
    if code != 0:
        raise BringInError("the agent branch and the main checkout share no history")
    fork = out.strip()
    return {
        "base_cwd": base_cwd, "worktree": worktree, "name": os.path.basename(worktree),
        "branch": branch, "branch_head": branch_head, "base_branch": base_branch,
        "main_branch": main_branch, "main_head": main_head, "fork_point": fork,
        "main_ahead": main_head != fork,
        "other_branch": (main_branch is not None and main_branch != base_branch),
        "main_dirty": _dirty_files(base_cwd),
        "agent_dirty": _dirty_files(worktree),
    }


def _stash_name(info: dict, message: Optional[str]) -> str:
    msg = (message or "").strip()
    return msg or f"{STASH_PREFIX}/{info['name']}/{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"


def _stash(cwd, name: str) -> str:
    """Stash everything uncommitted (untracked too) under ``name``; returns the stash SHA."""
    _must(["stash", "push", "--include-untracked", "-m", name, "--", ".", *SCAFFOLD_EXCLUDES],
          cwd, what="stashing")
    return _must(["rev-parse", "--verify", "refs/stash"], cwd, what="reading the stash").strip()


def _restore_stash(cwd, sha: str) -> str:
    """'restored' (entry dropped) when the stash applies cleanly on top of what was just
    brought in; otherwise 'kept': the checkout is left exactly as the bring-in left it and
    the named stash entry stays for the human to apply by hand (#288 §3)."""
    rehearsal, _ = _snapshot_commit(cwd, "pre-restore")
    with _TempWorktree(cwd, rehearsal) as tmp:
        code, _ = _git(["stash", "apply", sha], tmp)
        _git(["reset", "-q", "--hard"], tmp)
    if code != 0:
        return "kept"
    code, _ = _git(["stash", "apply", sha], cwd)
    if code != 0:  # the rehearsal said clean; be conservative anyway
        _git(["reset", "-q", "--merge"], cwd)
        return "kept"
    _git(["reset", "-q"], cwd)  # the human's files stay unstaged, like the rest
    code, out = _git(["stash", "list", "--format=%gd %H"], cwd)
    for line in out.splitlines() if code == 0 else []:
        ref, _, h = line.partition(" ")
        if h == sha:
            _git(["stash", "drop", "-q", ref], cwd)
            break
    return "restored"


def _refusal(plan: dict) -> Optional[str]:
    if plan.get("error"):
        return plan["error"]
    if plan.get("conflicts"):
        return "conflicts in " + ", ".join(plan["conflicts"][:5]) + (
            f" and {len(plan['conflicts']) - 5} more" if len(plan["conflicts"]) > 5 else "")
    return None


# ------------------------------------------------------------------ bring in: plan

def plan_bring_in(base_cwd, worktree, *, mode: str = "apply", busy=()) -> dict:
    """Dry run. Never changes either checkout."""
    if mode not in MODES:
        raise BringInError(f"unknown mode {mode!r}")
    info = _inspect(base_cwd, worktree, busy)
    base = info["base_cwd"]
    record = read_record(base, worktree)
    since = sync_point(base, info)
    main_commit, main_tree = _snapshot_commit(base, "main", since)
    agent_commit, agent_tree = _snapshot_commit(info["worktree"], info["branch"], since)
    plan = {
        "direction": "bring_in", "mode": mode, "worktree": info["worktree"], "name": info["name"],
        "branch": info["branch"], "base_branch": info["base_branch"],
        "main_branch": info["main_branch"], "main_head": info["main_head"],
        "fork_point": info["fork_point"], "main_ahead": info["main_ahead"],
        "other_branch": info["other_branch"], "main_dirty": info["main_dirty"],
        "needs_stash": bool(info["main_dirty"]), "agent_dirty": info["agent_dirty"],
        "last_applied_at": (record or {}).get("applied_at"), "incremental": bool(record),
        "main_snapshot": main_tree, "agent_snapshot": agent_tree, "agent_commit": agent_commit,
        "files": [], "file_count": 0, "conflicts": [], "error": None, "nothing_to_do": False,
    }
    result_tree, conflicts, error = _merge_in_temp(base, main_commit, agent_commit)
    if result_tree is None:
        plan["conflicts"], plan["error"] = conflicts, error
        return plan
    files = _changed_files(base, main_tree, result_tree)
    plan.update({"files": files, "file_count": len(files), "result_tree": result_tree,
                 "nothing_to_do": not files})
    if files and mode == "apply":
        patch = _patch(base, main_tree, result_tree)
        plan["patch_sha256"] = hashlib.sha256(patch.encode("utf-8", "surrogateescape")).hexdigest()
    return plan


# ------------------------------------------------------------------ bring in: do it

def bring_in(base_cwd, worktree, *, mode: str = "apply", stash: bool = False,
             stash_message: Optional[str] = None, allow_other_branch: bool = False,
             busy=()) -> dict:
    """Apply (or merge) the agent's delta into main. Refuses whatever the plan refuses."""
    plan = plan_bring_in(base_cwd, worktree, mode=mode, busy=busy)
    if plan["other_branch"] and not allow_other_branch:
        raise BringInError(
            f"main is checked out on '{plan['main_branch']}', not '{plan['base_branch']}' — "
            "confirm applying there, or switch branches first")
    if mode == "merge" and plan["needs_stash"] and not stash:
        raise BringInError(
            f"main has {len(plan['main_dirty'])} uncommitted file(s) — a merge needs them stashed "
            "first (confirm the stash)")
    info = _inspect(base_cwd, worktree, busy)
    base = info["base_cwd"]
    result = {**plan, "outcome": "failed", "stash": None, "stash_restore": None, "wip_commit": None,
              "merge_commit": None}
    stash_sha = None
    if plan["needs_stash"] and stash:
        # the stash goes first: a conflict the dry run saw may be WITH the files being set aside
        result["stash"] = _stash_name(info, stash_message)
        stash_sha = _stash(base, result["stash"])
        result["stash_sha"] = stash_sha
        plan = plan_bring_in(base_cwd, worktree, mode=mode, busy=busy)
        result.update({k: plan[k] for k in ("files", "file_count", "conflicts", "error",
                                            "nothing_to_do", "main_snapshot", "agent_snapshot")})
    refusal = _refusal(plan)
    if refusal or plan["nothing_to_do"]:
        if stash_sha:
            result["stash_restore"] = _restore_stash(base, stash_sha)
        if refusal:
            raise BringInError(refusal)
        return {**result, "outcome": "nothing-to-do"}
    try:
        if mode == "apply":
            patch = _patch(base, plan["main_snapshot"], plan["result_tree"])
            ok, out = _apply_to_working_tree(base, patch)
            if not ok:
                raise BringInError("the changes did not apply cleanly to main: " + out.strip()[:300])
        else:
            if info["agent_dirty"]:
                _must(["add", "-A", "--", "."], info["worktree"], what="staging the agent's work")
                _git(["reset", "-q", "--", *SCAFFOLD_PATHSPECS], info["worktree"])
                _must([*_IDENTITY, "commit", "-q", "-m", f"WIP: {info['branch']} (orcha bring-in)"],
                      info["worktree"], what="committing the agent's work")
                result["wip_commit"] = _head(info["worktree"])
            code, out = _git([*_IDENTITY, "merge", "--no-ff", "--no-edit", info["branch"]], base)
            if code != 0:
                conflicts = _conflicted(base)
                _git(["merge", "--abort"], base)
                raise BringInError("the merge did not complete: "
                                   + (", ".join(conflicts[:5]) or out.strip()[:300]))
            result["merge_commit"] = _head(base)
        result["outcome"] = "done"
    finally:
        if stash_sha:
            result["stash_restore"] = _restore_stash(base, stash_sha)
    _mark_sync_point(base, info, plan["agent_snapshot"])
    write_record(base, worktree, {
        "branch": info["branch"], "mode": mode, "main_head": _head(base),
        "applied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "agent_snapshot": plan["agent_snapshot"], "patch_sha256": plan.get("patch_sha256"),
        "files": [f["path"] for f in plan["files"]][:500],
    })
    return result


# ------------------------------------------------------------------ update from main

def plan_update(base_cwd, worktree, *, busy=()) -> dict:
    """Dry run of main → agent worktree. Never changes either checkout."""
    info = _inspect(base_cwd, worktree, busy)
    base = info["base_cwd"]
    since = sync_point(base, info)
    main_commit, main_tree = _snapshot_commit(base, "main", since)
    agent_commit, agent_tree = _snapshot_commit(info["worktree"], info["branch"], since)
    code, out = _git(["rev-list", "--count", f"{info['branch_head']}..{info['main_head']}"], base)
    commits_behind = int(out.strip()) if code == 0 and out.strip().isdigit() else 0
    plan = {
        "direction": "update", "worktree": info["worktree"], "name": info["name"],
        "branch": info["branch"], "base_branch": info["base_branch"],
        "main_branch": info["main_branch"], "main_head": info["main_head"],
        "commits_behind": commits_behind, "main_dirty": info["main_dirty"],
        "agent_dirty": info["agent_dirty"], "needs_stash": bool(info["agent_dirty"]),
        "main_snapshot": main_tree, "agent_snapshot": agent_tree, "main_commit": main_commit,
        "files": [], "file_count": 0, "conflicts": [], "error": None, "nothing_to_do": False,
    }
    result_tree, conflicts, error = _merge_in_temp(base, agent_commit, main_commit)
    if result_tree is None:
        plan["conflicts"], plan["error"] = conflicts, error
        return plan
    files = _changed_files(base, agent_tree, result_tree)
    plan.update({"files": files, "file_count": len(files), "result_tree": result_tree,
                 "nothing_to_do": not files and not commits_behind})
    return plan


def update_from_main(base_cwd, worktree, *, stash: bool = False,
                     stash_message: Optional[str] = None, busy=()) -> dict:
    """Merge main's HEAD into the agent branch and apply main's uncommitted changes on top."""
    plan = plan_update(base_cwd, worktree, busy=busy)
    refusal = _refusal(plan)
    if refusal:
        raise BringInError(refusal)
    if plan["nothing_to_do"]:
        return {**plan, "outcome": "nothing-to-do"}
    if plan["needs_stash"] and not stash:
        raise BringInError(
            f"the agent worktree has {len(plan['agent_dirty'])} uncommitted file(s) — "
            "confirm stashing them first")
    info = _inspect(base_cwd, worktree, busy)
    base, wt = info["base_cwd"], info["worktree"]
    result = {**plan, "outcome": "failed", "stash": None, "stash_restore": None, "merge_commit": None}
    stash_sha = None
    if plan["needs_stash"]:
        result["stash"] = _stash_name(info, stash_message)
        stash_sha = _stash(wt, result["stash"])
        result["stash_sha"] = stash_sha
    try:
        if plan["commits_behind"]:
            code, out = _git([*_IDENTITY, "merge", "--no-edit", info["main_head"]], wt)
            if code != 0:
                conflicts = _conflicted(wt)
                _git(["merge", "--abort"], wt)
                raise BringInError("the merge did not complete: "
                                   + (", ".join(conflicts[:5]) or out.strip()[:300]))
            result["merge_commit"] = _head(wt)
        # what main has beyond its own HEAD (uncommitted work): rehearse onto the updated branch
        agent_commit, agent_tree = _snapshot_commit(wt, info["branch"], sync_point(base, info))
        result_tree, conflicts, error = _merge_in_temp(base, agent_commit, plan["main_commit"])
        if result_tree is None:
            raise BringInError(_refusal({"conflicts": conflicts, "error": error}) or "merge failed")
        files = _changed_files(base, agent_tree, result_tree)
        result.update({"files": files, "file_count": len(files)})
        ok, out = _apply_to_working_tree(wt, _patch(base, agent_tree, result_tree))
        if not ok:
            raise BringInError("main's uncommitted changes did not apply cleanly: " + out.strip()[:300])
        result["outcome"] = "done"
    finally:
        if stash_sha:
            result["stash_restore"] = _restore_stash(wt, stash_sha)
    # both sides now hold main's content: that is the next merge base (the agent's own
    # additions are NOT in main, so the agent snapshot would make main look like it deleted them)
    _mark_sync_point(base, info, plan["main_snapshot"])
    write_record(base, worktree, {
        "branch": info["branch"], "mode": "update", "main_head": info["main_head"],
        "applied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": [f["path"] for f in result["files"]][:500],
    })
    return result
