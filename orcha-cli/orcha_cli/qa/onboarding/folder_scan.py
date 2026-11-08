"""Find the projects inside a folder.

Adapted from `cloud/folder_scan.py`. Answers "which apps live in here?" for a folder that
need not be a repository itself — a folder of checkouts, a monorepo, or one app.

The walk goes at most `max_depth` levels below the chosen folder. A directory that is a git
checkout, or that is itself an app (an Xcode project, a Gradle app, a Flutter / Expo / web
`package.json`, a Python web app, an iOS Swift package), is a *project*: it is recorded and not
descended further, and not descended further. Inside a project the app folders come from `repolib.app_dirs`.
Two stacks `app_dirs` does not know (Python web frameworks, Swift packages with an iOS app
target) are added on top, from a shallow look inside the project.

Symlinked directories are never followed (neither by this walk nor by `app_dirs`), and every
directory visited is checked to still resolve inside the chosen folder, so a link cannot take
the scan somewhere the user did not pick.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import asdict
from pathlib import Path
from typing import Any

from orcha_cli.qa.onboarding.repolib import (
    MOBILE_DEPS,
    SKIP_DIRS as REPOLIB_SKIP_DIRS,
    WEB_DEPS,
    AppDir,
    _deps,
    _remote,
    app_dirs,
)
from orcha_cli.qa.onboarding import ignored

#: Never descended into: dependency caches, build output, VCS internals, virtualenvs.
SKIP_DIRS = REPOLIB_SKIP_DIRS | {".dart_tool", "Carthage", ".build", "venv", "env", ".gradle", "coverage", "out"}
#: Directory suffixes that are bundles on macOS, never folders holding projects.
BUNDLE_SUFFIXES = (".xcodeproj", ".xcworkspace", ".xcassets", ".framework", ".app", ".bundle", ".photoslibrary")

MAX_DEPTH = 3
MAX_PROJECTS = 300
#: Directories inspected before the walk gives up and reports `truncated` — a guard against a
#: chosen folder like `/` or `~` with a huge fan-out.
MAX_DIRS = 20_000
GIT_TIMEOUT_S = 5

# Python web framework -> (stack label, conventional dev URL).
_PY_WEB: tuple[tuple[str, str, str], ...] = (
    ("django", "Django", "http://localhost:8000"),
    ("fastapi", "FastAPI", "http://localhost:8000"),
    ("flask", "Flask", "http://localhost:5000"),
    ("starlette", "Starlette", "http://localhost:8000"),
    ("streamlit", "Streamlit", "http://localhost:8501"),
)
_PY_MANIFESTS = ("pyproject.toml", "requirements.txt", "Pipfile", "setup.py")
_IOS_PLATFORM_RE = re.compile(r"\.iOS\s*\(")
_SWIFT_APP_RE = re.compile(r"\.iOSApplication\s*\(|\.executableTarget\s*\(")


def _python_web(dir_: Path) -> AppDir | None:
    """A Django/FastAPI/Flask/... app rooted at `dir_`, by its dependency manifest (or Django's
    `manage.py`)."""
    text = ""
    for name in _PY_MANIFESTS:
        try:
            text += (dir_ / name).read_text(errors="ignore").lower() + "\n"
        except OSError:
            continue
    if (dir_ / "manage.py").is_file():
        text += "django\n"
    if not text:
        return None
    for dep, label, url in _PY_WEB:
        if re.search(rf"(?:^|[\s\"'\[,]){dep}(?:$|[\s\"'<>=~!\],;\[])", text, re.MULTILINE):
            return AppDir(path="", kinds=["web"], name=dir_.name, stack=label, build_hint=url)
    return None


def _swift_package_app(dir_: Path) -> AppDir | None:
    """A Swift package that declares an iOS platform and an app/executable target."""
    try:
        text = (dir_ / "Package.swift").read_text(errors="ignore")
    except OSError:
        return None
    if _IOS_PLATFORM_RE.search(text) and _SWIFT_APP_RE.search(text):
        return AppDir(path="", kinds=["ios"], name=dir_.name, stack="Swift Package")
    return None


def _is_app_dir(dir_: Path, names: set[str]) -> bool:
    """Whether `dir_` itself holds an app — the markers `app_dirs` and the two extras above
    look for, checked without walking any further."""
    if "package.json" in names:
        deps = _deps(dir_ / "package.json")
        if any(d in deps for d in MOBILE_DEPS) or any(d in deps for d in WEB_DEPS):
            return True
    if any(n.endswith((".xcodeproj", ".xcworkspace")) for n in names):
        return True
    if ("build.gradle" in names or "build.gradle.kts" in names) and (dir_ / "app").is_dir():
        return True
    if "pubspec.yaml" in names:
        try:
            if "flutter" in (dir_ / "pubspec.yaml").read_text(errors="ignore"):
                return True
        except OSError:
            pass
    if "Package.swift" in names and _swift_package_app(dir_):
        return True
    if names & {*_PY_MANIFESTS, "manage.py"} and _python_web(dir_):
        return True
    return False


def _inside(path: Path, root_real: Path) -> bool:
    try:
        Path(os.path.realpath(path)).relative_to(root_real)
    except ValueError:
        return False
    return True


def _children(dir_: Path, root_real: Path) -> list[Path]:
    """Sub-directories worth descending into: no symlinks, no skip-list names, no hidden
    folders, no macOS bundles, nothing that resolves outside the chosen folder."""
    try:
        entries = list(os.scandir(dir_))
    except OSError:
        return []
    out: list[Path] = []
    skip = ignored.matcher(root_real)
    for e in entries:
        try:
            if e.is_symlink() or not e.is_dir(follow_symlinks=False):
                continue
        except OSError:
            continue
        if e.name in SKIP_DIRS or e.name.startswith(".") or e.name.endswith(BUNDLE_SUFFIXES):
            continue
        p = Path(e.path)
        if _inside(p, root_real) and not skip(p):
            out.append(p)
    out.sort(key=lambda p: p.name.lower())
    return out


def _extra_apps(project: Path, known: set[str], root_real: Path, max_depth: int = 2) -> list[AppDir]:
    """Python web apps and iOS Swift packages inside `project` that `app_dirs` did not report
    (it has no rule for either), up to `max_depth` levels down."""
    out: list[AppDir] = []
    stack: list[tuple[Path, int]] = [(project, 0)]
    while stack:
        cur, depth = stack.pop()
        rel = cur.relative_to(project).as_posix()
        rel = "" if rel == "." else rel
        if rel not in known:
            hit = _swift_package_app(cur) or _python_web(cur)
            if hit is not None:
                hit.path = rel
                out.append(hit)
                continue
        if depth < max_depth:
            stack.extend((c, depth + 1) for c in _children(cur, root_real))
    return out


def _git(repo: Path) -> dict[str, Any] | None:
    """Origin remote, current branch (None when detached) and last commit date (ISO 8601) of
    the checkout at `repo`, or None when it is not one."""
    if not (repo / ".git").exists():
        return None
    info: dict[str, Any] = {"remote": _remote(repo), "branch": None, "last_commit": None}
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), "log", "-1", "--format=%cI%n%D"],
            capture_output=True, text=True, timeout=GIT_TIMEOUT_S, env=env,
        )
        if proc.returncode == 0:
            lines = proc.stdout.splitlines()
            info["last_commit"] = (lines[0].strip() or None) if lines else None
            refs = lines[1] if len(lines) > 1 else ""
            m = re.search(r"HEAD -> ([^,]+)", refs)
            info["branch"] = m.group(1).strip() if m else None
        if info["branch"] is None:
            head = subprocess.run(
                ["git", "-C", str(repo), "symbolic-ref", "--short", "-q", "HEAD"],
                capture_output=True, text=True, timeout=GIT_TIMEOUT_S, env=env,
            )
            if head.returncode == 0:
                info["branch"] = head.stdout.strip() or None
        if info["remote"] is None and (repo / ".git").is_file():
            # A linked worktree: `.git` is a pointer file, the config lives in the main checkout.
            rem = subprocess.run(
                ["git", "-C", str(repo), "config", "--get", "remote.origin.url"],
                capture_output=True, text=True, timeout=GIT_TIMEOUT_S, env=env,
            )
            if rem.returncode == 0:
                info["remote"] = rem.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        pass
    return info


def _platforms(apps: list[AppDir]) -> list[str]:
    """ios/android/web/desktop, in that order, from the app folders' kinds — a cross-platform
    `mobile` app (Flutter, Expo, React Native) counts for both phones."""
    found: set[str] = set()
    for a in apps:
        for k in a.kinds:
            if k == "mobile":
                found.update(("ios", "android"))
            elif k in ("ios", "android", "web", "desktop"):
                found.add(k)
    return [p for p in ("ios", "android", "web", "desktop") if p in found]


def _uniq(values: list[str | None]) -> list[str]:
    out: list[str] = []
    for v in values:
        if v and v not in out:
            out.append(v)
    return out


def describe_project(path: Path, root: Path, root_real: Path) -> dict[str, Any]:
    """One project record: its app folders plus what the picker shows about it."""
    apps = app_dirs(path, follow_symlinks=False)
    apps += _extra_apps(path, {a.path for a in apps}, root_real)
    apps.sort(key=lambda a: (a.path.count("/") if a.path else -1, a.path))
    rel = path.relative_to(root).as_posix()
    return {
        "name": path.name,
        "path": str(path),
        "rel_path": "" if rel == "." else rel,
        "platforms": _platforms(apps),
        "stacks": _uniq([a.stack for a in apps]),
        "bundle_ids": _uniq([a.bundle_id for a in apps]),
        "packages": _uniq([a.package for a in apps]),
        "urls": _uniq([a.build_hint for a in apps if (a.build_hint or "").startswith("http")]),
        "git": _git(path),
        "apps": [asdict(a) for a in apps],
    }


def scan_folder(
    path: str | Path,
    max_depth: int = MAX_DEPTH,
    max_projects: int = MAX_PROJECTS,
    max_dirs: int = MAX_DIRS,
) -> dict[str, Any]:
    """Every project in the folder at `path` (absolute, a directory), shallowest and then
    alphabetical first. `root_is_project` is true when the folder itself is the one project
    (a checkout or an app), so the picker can select it without showing a list."""
    root = Path(path).expanduser()
    if not root.is_absolute():
        raise ValueError("The folder path must be absolute.")
    if not root.is_dir():
        raise ValueError(f"Not a folder on this Mac: {root}")
    root_real = Path(os.path.realpath(root))

    def is_project(d: Path) -> bool:
        try:
            names = {e.name for e in os.scandir(d)}
        except OSError:
            return False
        return ".git" in names or _is_app_dir(d, names)

    if is_project(root):
        return {
            "root": str(root),
            "root_is_project": True,
            "projects": [describe_project(root, root, root_real)],
            "truncated": False,
        }

    found: list[tuple[int, Path]] = []
    truncated = False
    visited = 0
    # Breadth-first so a limit hit drops the deepest projects, never the shallow ones.
    queue: list[tuple[Path, int]] = [(c, 1) for c in _children(root, root_real)]
    i = 0
    while i < len(queue):
        cur, depth = queue[i]
        i += 1
        visited += 1
        if visited > max_dirs or len(found) >= max_projects:
            truncated = True
            break
        if is_project(cur):
            found.append((depth, cur))
            continue
        if depth < max_depth:
            queue.extend((c, depth + 1) for c in _children(cur, root_real))

    found.sort(key=lambda t: (t[0], t[1].relative_to(root).as_posix().lower()))
    return {
        "root": str(root),
        "root_is_project": False,
        "projects": [describe_project(p, root, root_real) for _, p in found],
        "truncated": truncated,
    }
