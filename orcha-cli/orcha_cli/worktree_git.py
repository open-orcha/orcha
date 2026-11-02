"""Validated Git 2.23+ repository queries, using the process's first PATH Git.

Older Git prints unknown rev-parse options with a successful exit status. Never
interpret exit status alone as a path. Old worktree porcelain also leaves paths
unquoted and omits locks; its fallback reads validated administration pointers.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import stat

from . import worktree_gc as gc


class CleanupError(RuntimeError):
    """Safe, public explanation; never include command output or private paths."""


class NotGitProject(CleanupError):
    """Git positively reported that no repository was found."""


class CheckoutBusy(CleanupError):
    """A checkout reservation or lifecycle lock requires a later retry."""


def _value(raw):
    # Remove only Git's record terminator: whitespace may belong to the path.
    if not isinstance(raw, str) or not raw.endswith("\n"):
        raise CleanupError("Git returned incomplete repository information; check the Git installation")
    value = raw[:-1]
    if not value or "\0" in value or value.startswith("--"):
        raise CleanupError("Git returned invalid repository information; check the Git installation")
    return value


def _path(raw, base):
    value = _value(raw)
    path = Path(value)
    return (path if path.is_absolute() else Path(base) / path).resolve(strict=True)


def _pointer(path):
    return _value(path.read_bytes().decode("utf-8", "surrogateescape"))


def common_dir(base):
    """Resolve legacy output relative to Git's cwd, then verify both directory links."""
    code, out = gc.git(["rev-parse", "--git-common-dir"], str(base))
    if code:
        if code == 128 and out.strip() == "fatal: not a git repository (or any of the parent directories): .git":
            raise NotGitProject("This folder is not a Git project")
        raise CleanupError("Git could not verify this project; check Git access and the repository")
    try:
        common = _path(out, base)
        code, out = gc.git(["rev-parse", "--absolute-git-dir"], str(base))
        if code:
            raise CleanupError("Git could not verify the checkout directory")
        admin = _path(out, base)
        pointer = admin / "commondir"
        expected = (admin / _pointer(pointer)).resolve(strict=True) if pointer.exists() else admin
        if common != expected or not (common / "objects").is_dir() or not (common / "HEAD").is_file():
            raise CleanupError("Git repository directories do not agree; retain the checkouts for inspection")
        return common
    except (OSError, ValueError) as exc:
        raise CleanupError("Git returned an unavailable repository directory; check the repository") from exc


def _row(path, *, head=None, branch=None, locked=False):
    original = Path(path)
    if not original.is_absolute() or "\0" in path:
        raise CleanupError("Git returned an invalid worktree path; no folders can be removed")
    canonical = original.resolve()
    row = {"path": str(canonical), "registered": True, "head": head,
           "branch": branch, "locked": locked}
    if original != canonical:
        row["blocked"] = "The registered checkout path contains a symlink or is not canonical"
    return row


def _porcelain(raw):
    """Accept only complete NUL-separated records; malformed output never falls back."""
    if not raw or not raw.endswith("\0\0"):
        raise CleanupError("Git returned an incomplete worktree list; no folders can be removed")
    rows = []
    for record in raw[:-2].split("\0\0"):
        fields = record.split("\0")
        if not fields[0].startswith("worktree "):
            raise CleanupError("Git returned an invalid worktree list; no folders can be removed")
        values = {}
        for field in fields[1:]:
            key, sep, value = field.partition(" ")
            if key in values or key not in {"HEAD", "branch", "detached", "bare", "locked", "prunable"}:
                raise CleanupError("Git returned an ambiguous worktree list; no folders can be removed")
            values[key] = value if sep else None
        bare = "bare" in values
        if not bare and (not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", values.get("HEAD") or "")
                         or ("branch" in values) == ("detached" in values)):
            raise CleanupError("Git returned invalid worktree ownership; no folders can be removed")
        branch = values.get("branch")
        if branch is not None and not branch.startswith("refs/heads/"):
            raise CleanupError("Git returned an invalid worktree branch; no folders can be removed")
        rows.append(_row(fields[0][9:], head=values.get("HEAD"),
                         branch=branch[11:] if branch else None, locked="locked" in values))
    if len({r["path"] for r in rows}) != len(rows):
        raise CleanupError("Git returned duplicate worktree paths; no folders can be removed")
    return rows


def _legacy_main(common):
    """Find the main checkout without inspecting possibly damaged linked checkouts."""
    code, bare = gc.git(["rev-parse", "--is-bare-repository"], str(common))
    if code or bare not in ("true\n", "false\n"):
        raise CleanupError("Git could not identify the main checkout; no folders can be removed")
    if bare == "true\n":
        main = common
    elif common.name == ".git" and not common.is_symlink():
        main = common.parent
        if common_dir(main) != common:
            raise CleanupError("The main checkout belongs to another repository")
    else:
        raise CleanupError("This Git version cannot safely list this repository layout; use Git with worktree list -z support")
    return main


def project_root(base):
    """Resolve saved-plan storage even when a linked checkout cannot be inspected.

    Recovery must reach its durable receipts before inventory checks. Modern Git's
    list identifies the main checkout without opening linked checkout folders;
    the older-Git path verifies only the main/common-directory relationship.
    """
    common = common_dir(base)
    code, raw = gc.git(["worktree", "list", "--porcelain", "-z"], str(base))
    if code:
        if code != 129 or not re.search(r"unknown (?:switch|option) [`']z['`]", raw):
            raise CleanupError("Git could not identify this project's main checkout")
        return _legacy_main(common)
    main = Path(_porcelain(raw)[0]["path"])
    if common_dir(main) != common:
        raise CleanupError("The main checkout belongs to another repository")
    return main


def _legacy_registrations(base, common, *, only_path=None):
    """Avoid ambiguous pre-2.36 porcelain (raw newlines and no locked field).

    Git's commondir/gitdir/HEAD records preserve filename bytes. Only conventional
    main checkouts and bare repositories have an unambiguous main path here;
    unusual separate-Git-dir layouts are retained with an explanation.
    """
    main = _legacy_main(common)
    rows = [_row(str(main))]
    root = common / "worktrees"
    if not root.exists():
        return rows
    if root.is_symlink():
        raise CleanupError("Worktree administration contains a symlink; retain folders for inspection")
    for admin in sorted(root.iterdir()):
        if admin.is_symlink() or not admin.is_dir():
            raise CleanupError("Worktree administration is ambiguous; retain folders for inspection")
        if (admin / _pointer(admin / "commondir")).resolve(strict=True) != common:
            raise CleanupError("Worktree administration belongs to another repository")
        pointer = Path(_pointer(admin / "gitdir"))
        if not pointer.is_absolute() or pointer.name != ".git":
            raise CleanupError("Git returned an invalid checkout pointer; retain folders for inspection")
        # A single-checkout recheck still accounts for every registration (and
        # duplicate pointer), but queries commits/ownership only for its target.
        # This avoids starting O(n²) Git processes during a large old-Git cleanup.
        if only_path is not None and str(pointer.parent.resolve()) != only_path:
            rows.append(_row(str(pointer.parent), locked=os.path.lexists(admin / "locked")))
            continue
        code, head = gc.git(["--git-dir=" + str(admin), "rev-parse", "--verify", "HEAD"], str(base))
        if code or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\n", head):
            raise CleanupError("A checkout commit could not be verified; retain folders for inspection")
        ref = _pointer(admin / "HEAD")
        branch = ref[16:] if ref.startswith("ref: refs/heads/") else None
        if ref.startswith("ref:") and branch is None:
            raise CleanupError("A checkout branch could not be verified; retain folders for inspection")
        row = _row(str(pointer.parent), head=head[:-1], branch=branch,
                   locked=os.path.lexists(admin / "locked"))
        if pointer.parent.exists():
            code, actual = gc.git(["rev-parse", "--absolute-git-dir"], str(pointer.parent))
            if code or _path(actual, pointer.parent) != admin:
                raise CleanupError("Checkout registration does not match its folder; retain it for inspection")
        rows.append(row)
    if len({r["path"] for r in rows}) != len(rows):
        raise CleanupError("Worktree administration contains duplicate paths; retain folders for inspection")
    return rows


def registrations(base, *, only_path=None):
    common = common_dir(base)
    code, raw = gc.git(["worktree", "list", "--porcelain", "-z"], str(base))
    if not code:
        return _porcelain(raw)
    # Only an explicit unsupported-option result admits the old-Git fallback.
    if code != 129 or not re.search(r"unknown (?:switch|option) [`']z['`]", raw):
        raise CleanupError("Git could not list this project's worktrees")
    try:
        return _legacy_registrations(base, common, only_path=only_path)
    except (OSError, ValueError) as exc:
        raise CleanupError("Worktree administration could not be verified; retain folders for inspection") from exc


def add_locked(base, path, ref, reason, *, run, no_checkout=False):
    """Create an atomically locked checkout using flags present in Git 2.23.

    --reason on *add* was introduced later than --lock. Label only the exact
    regular lock Git just created; an unexpected/human lock is left untouched.
    Failure leaves the checkout locked for inspection rather than removing it.
    """
    args = ["worktree", "add", "--lock", "--detach"]
    if no_checkout:
        args.append("--no-checkout")
    code, out = run([*args, str(path), ref], str(base))
    if code:
        raise CleanupError("Git could not create the locked checkout; inspect it before retrying")
    common = common_dir(base)
    code, raw = gc.git(["rev-parse", "--absolute-git-dir"], str(path))
    admin = _path(raw, path) if not code else None
    if admin is None or admin.parent != common / "worktrees" or common_dir(path) != common:
        raise CleanupError("The new checkout's lock ownership could not be verified")
    fd = os.open(admin / "locked", os.O_RDWR | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or os.read(fd, 1024) != b"added with --lock\n":
            raise CleanupError("The new checkout has another lock; retain it for inspection")
        # Never unlink/replace the lock: Git must see it continuously, even on a crash.
        os.lseek(fd, 0, os.SEEK_SET)
        data = (reason + "\n").encode("utf-8")
        if os.write(fd, data) != len(data):
            raise CleanupError("The checkout lock could not be labeled; retain it for inspection")
        os.ftruncate(fd, len(data))
        os.fsync(fd)
    finally:
        os.close(fd)
