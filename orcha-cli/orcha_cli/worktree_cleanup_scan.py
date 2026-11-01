"""Project-wide worktree discovery and private, content-verified snapshots.

Unlike automatic GC this includes detached and externally located registrations. A
name never establishes ownership. Unknown leftovers are displayed but retained.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import subprocess
import time

from . import worktree_gc as gc


class CleanupError(RuntimeError):
    pass


def checked_git(base, *args):
    code, output = gc.git(list(args), str(base))
    if code:
        raise CleanupError("Git could not verify the checkout")
    return output.strip()


def common_dir(base):
    return Path(checked_git(base, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()


def identity(path):
    path = Path(path)
    if path.is_symlink() or path.absolute() != path.resolve():
        raise CleanupError("A symlink in the checkout path prevents safe cleanup")
    s = path.stat()
    if not stat.S_ISDIR(s.st_mode):
        raise CleanupError("The checkout directory is missing")
    return [s.st_dev, s.st_ino]


def registrations(base):
    # -z avoids Git's quoted path format, including whitespace and newlines.
    code, raw = gc.git(["worktree", "list", "--porcelain", "-z"], str(base))
    if code:
        raise CleanupError("Git could not list this project's worktrees")
    rows, row = [], {}
    for field in raw.split("\0"):
        if not field:
            if row:
                rows.append(row)
                row = {}
            continue
        key, _, value = field.partition(" ")
        if key == "worktree":
            row = {"path": os.path.realpath(value), "registered": True, "branch": None, "locked": False,
                   **({"blocked": "The registered checkout path is a symlink"} if Path(value).is_symlink() else {})}
        elif key == "HEAD":
            row["head"] = value
        elif key == "branch":
            row["branch"] = value.removeprefix("refs/heads/")
        elif key == "locked":
            row["locked"] = True
    return rows


def discover(base, known=None, *, only_path=None):
    common = common_dir(base)
    rows = registrations(base)
    if not rows:
        raise CleanupError("The main checkout could not be identified")
    main = Path(rows[0]["path"]).resolve()
    seen = {str(Path(r["path"]).resolve()) for r in rows}
    result = [r for r in rows if Path(r["path"]).resolve() not in (main, Path(base).resolve())]
    root = main / gc.WORKTREES_DIR
    if root.is_dir() and not root.is_symlink():
        for path in sorted(root.iterdir()):
            if path.is_dir() and str(path.resolve()) not in seen:
                result.append({"path": str(path), "registered": False, "branch": None,
                               "head": None, "locked": False})
    if only_path is not None:
        result = [r for r in result if r["path"] == only_path]
    for row in result:
        path = Path(row["path"])
        row["name"] = path.name
        row["task_ref"] = (gc.describe_branch(row.get("branch")).get("task_ref")
                           or gc.describe_branch("orcha/" + path.name).get("task_ref"))
        try:
            row["identity"] = identity(path)
            if row["registered"]:
                if common_dir(path) != common:
                    raise CleanupError("The checkout belongs to another repository")
                # Snapshot index as well as files: staged and unstaged versions can differ.
                admin = Path(checked_git(path, "rev-parse", "--absolute-git-dir"))
                if admin.parent != common / "worktrees":
                    raise CleanupError("Linked checkout ownership could not be verified")
                row["admin"] = str(admin)
            else:
                previous = (known or {}).get(str(path))
                if not previous or previous.get("identity") != row["identity"]:
                    raise CleanupError("Leftover ownership is unknown; retain for inspection")
                if (path / ".git").is_dir():
                    raise CleanupError("The leftover contains a separate repository")
                if (path / ".git").is_file():
                    pointer = gc.admin_dir(path)
                    if not pointer or Path(pointer).parent != common / "worktrees":
                        raise CleanupError("The leftover's Git pointer belongs elsewhere")
                row["head"] = previous.get("head")
                row["branch"] = previous.get("branch")
        except (OSError, CleanupError) as exc:
            row["blocked"] = str(exc) if isinstance(exc, CleanupError) else "The folder cannot be inspected"
    return result


def digest_file(path, deadline=None):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            if deadline is not None and time.monotonic() > deadline:
                raise CleanupError("Inspection timed out; the folder was retained")
            digest.update(chunk)
    return digest.hexdigest()


def generated(path, rel, registered):
    """Only recognized, ignored dependency/cache roots may be discarded.

    Arbitrary build/dist folders are saved: names alone do not prove their contents
    are reproducible. Private configuration is never a scaffolding exemption here.
    """
    if not registered or path.is_symlink():
        return False
    name = path.name
    recognized = (name in ("__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache")
                  or (name == "node_modules" and any((path / marker).is_file() for marker in
                      (".package-lock.json", ".modules.yaml", ".yarn-integrity")))
                  or (name in (".venv", ".venv-test", "venv") and (path / "pyvenv.cfg").is_file()))
    base = str(path.parents[len(Path(rel).parts) - 1])
    if not recognized or gc.git(["check-ignore", "-q", "--", rel], base)[0] != 0:
        return False
    code, tracked = gc.git(["ls-files", "--", rel + "/"], base)
    return code == 0 and not tracked


def snapshot(row, *, deadline=None):
    """Hash every retained file without following links; reject nested repositories.

    Generated roots get identity/mtime stamps. Preservation copies only hashed files,
    plus symbolic-link values and Git's index (including staged-only contents).
    """
    root = Path(row["path"])
    files, caches, generated_roots = {}, {}, []
    deadline = deadline or time.monotonic() + 300
    def check_time():
        if time.monotonic() > deadline:
            raise CleanupError("Inspection timed out; the folder was retained")
    def cache_tree(directory):
        # Inspect boundaries and private configuration even in generated dependencies.
        # Metadata detects additions/replacements without hashing large dependency trees.
        check_time()
        for p in sorted(directory.iterdir()):
            check_time()
            rel = p.relative_to(root).as_posix()
            if p.name == ".git":
                raise CleanupError("A nested repository must be handled separately")
            st = p.lstat()
            caches[rel] = [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]
            if p.is_symlink():
                files[rel] = {"kind": "symlink", "target": os.readlink(p)}
            elif p.is_dir():
                cache_tree(p)
            elif not stat.S_ISREG(st.st_mode):
                raise CleanupError("A socket or special file prevents safe cleanup")
            elif (p.name.startswith(".env") or p.suffix.lower() in
                  (".pem", ".key", ".p12", ".pfx", ".keystore", ".mobileprovision")
                  or p.name in (".npmrc", ".pypirc", "credentials", "credentials.json")):
                files[rel] = {"kind": "file", "sha256": digest_file(p, deadline), "size": st.st_size,
                              "mode": stat.S_IMODE(st.st_mode)}
    def walk(directory):
        check_time()
        for p in sorted(directory.iterdir()):
            check_time()
            rel = p.relative_to(root).as_posix()
            if rel == ".git":
                continue
            if p.name == ".git":
                raise CleanupError("A nested repository must be handled separately")
            s = p.lstat()
            if stat.S_ISLNK(s.st_mode):
                files[rel] = {"kind": "symlink", "target": os.readlink(p)}
            elif stat.S_ISDIR(s.st_mode):
                if generated(p, rel, row["registered"]):
                    caches[rel] = [s.st_dev, s.st_ino, s.st_mtime_ns]
                    generated_roots.append(rel)
                    cache_tree(p)
                else:
                    walk(p)
            elif stat.S_ISREG(s.st_mode):
                checksum = digest_file(p, deadline)
                after = p.lstat()
                if (s.st_ino, s.st_size, s.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                    raise CleanupError("Files changed during inspection; preview again")
                files[rel] = {"kind": "file", "sha256": checksum, "size": s.st_size,
                              "mode": stat.S_IMODE(s.st_mode)}
            else:
                raise CleanupError("A socket or special file prevents safe cleanup")
    walk(root)
    index = None
    if row.get("admin"):
        p = Path(row["admin"]) / "index"
        if p.is_file():
            index = digest_file(p)
    return {"files": files, "caches": caches, "generated_roots": generated_roots, "index": index}


def bounded_size(path):
    try:
        p = subprocess.run(["du", "-sk", str(path)], capture_output=True, text=True, timeout=30)
        if p.returncode == 0:
            return int(p.stdout.split()[0]) * 1024
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None
