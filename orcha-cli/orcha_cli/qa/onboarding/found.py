"""The "We found" sheet: what QA onboarding reads about a project folder before mapping it, without a
model, a device or the network (`read_folder`).

`read_folder` answers the UI's `FoundSheet` (`pages/qa/onboarding/contract.ts`):

- `repo`: `{path, name}`;
- `platforms`: `[{kind, app_id?, stack?, path?}]`, iOS, Android, web in that order, from the app
  folders `repolib` finds. `app_id` is the bundle id, the package, or for the web the URL it serves
  on (`environments` keeps it too; here it also fills the web target);
- `environments`: `[{name, base_url?}]`, the local dev URL and what the CI points its suite at;
- `tests`: `[{framework, count, path}]`, only tests that check a screen;
- `ci`: `[{provider, path}]`;
- `backends`, `backend_unknown` (`onboarding.backends`);
- `defaults`: `{device?, test_data?}`;
- `auth`: `{summary, methods, sure}`, the sign-in the code shows (`auth_scan`), left out when none;
- `sandboxes`: `{kind: {key: {ready, evidence}}}`, the sandboxed services (`sandbox_scan`).

And what the picker needs for a monorepo: `apps` (every app folder, real ones first) and
`bundle_id_candidates`.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

from orcha_cli.qa.onboarding import auth_scan, backends, ci as ci_mod, folder_scan, repolib, sandbox_scan, tests_scan

PLATFORM_ORDER = ("ios", "android", "web")
CI_PROVIDERS = {
    ".github/": "GitHub Actions", ".gitlab-ci.yml": "GitLab CI", ".circleci/": "CircleCI", "bitrise.yml": "Bitrise",
    "azure-pipelines.yml": "Azure Pipelines", "codemagic.yaml": "Codemagic", "Jenkinsfile": "Jenkins", ".buildkite/": "Buildkite",
}
CLEAN_START = {
    "ios": "Each test starts on a fresh install",
    "android": "Each test starts with the app's data cleared",
    "web": "Each test starts in a new browser session",
}
DEVICE_WORD = {"ios": "A simulator", "android": "An emulator", "web": "Chromium"}
#: Web apps that are a server-side backend: a repository's site is its frontend when it has one.
SERVER_STACKS = frozenset({"Laravel", "Django", "FastAPI", "Flask", "Starlette", "Streamlit"})
#: How long the test scan may read the repository.
SCAN_SECONDS = 15.0
#: How long the backend scan may read an app's code (a cold disk needs longer than a warm one).
BACKEND_SECONDS = 10.0
GIT_TIMEOUT_S = 5


def common_dir(paths: list[str]) -> str:
    """The folder every path is under (`ios/AppUITests`), or `.` when they share none."""
    dirs = [p.rsplit("/", 1)[0] if "/" in p else "" for p in paths]
    if not dirs:
        return "."
    try:
        common = os.path.commonpath(dirs) if all(dirs) else ""
    except ValueError:
        common = ""
    return common or "."


def tests_found(inv: tests_scan.Inventory) -> list[dict[str, Any]]:
    """`[{framework, count, path}]` for the UI frameworks the scan found, counting only the tests
    that check a screen."""
    by: dict[str, list[str]] = {}
    seen: set[tuple[str, str]] = set()
    for t in inv.tests:
        if t.framework not in tests_scan.UI_FRAMEWORKS or (t.path, t.name) in seen:
            continue
        seen.add((t.path, t.name))
        if tests_scan.has_screens(t):
            by.setdefault(t.framework, []).append(t.path)
    return [{"framework": fw, "count": len(by[fw]), "path": common_dir(by[fw])} for fw in tests_scan.UI_FRAMEWORKS if fw in by]


def ci_found(root: Path) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for p in ci_mod.ci_files(root):
        rel = p.relative_to(root).as_posix()
        provider = next((name for key, name in CI_PROVIDERS.items() if rel == key or rel.startswith(key)), "CI")
        out.append({"provider": provider, "path": rel})
    return out


def _tracked(root: Path, rel: str) -> bool:
    """Whether git tracks anything in the app folder. A leftover copy beside the real app
    (`web-back/` next to `apps/web/`) is not the app. True when git cannot say."""
    try:
        got = subprocess.run(["git", "-C", str(root), "ls-files", "--", rel or "."], capture_output=True, text=True,
                             timeout=GIT_TIMEOUT_S, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    except (OSError, subprocess.SubprocessError):
        return True
    return got.returncode != 0 or bool(got.stdout.strip())


def _app_dir_for(kind: str, apps: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The app folder of a platform: one that is that platform first, else a cross-platform
    mobile app (Expo, React Native, Flutter) for iOS and Android. Folders git tracks come before
    copies it does not; among several web apps a frontend comes before a server-side backend, and
    one with a dev script before one without."""
    real = [a for a in apps if not a.get("sample")] or apps
    real = [a for a in real if a.get("tracked", True)] or real
    if kind == "web":
        webs = [a for a in real if "web" in (a.get("kinds") or [])]
        sites = [a for a in webs if a.get("stack") not in SERVER_STACKS] or webs
        return next((a for a in sites if a.get("dev_script")), sites[0] if sites else None)
    exact = next((a for a in real if kind in (a.get("kinds") or [])), None)
    if exact is not None:
        return exact
    return next((a for a in real if "mobile" in (a.get("kinds") or [])), None)


def platforms(inspected: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    apps = list((inspected or {}).get("apps") or [])
    seen = {k for a in apps for k in a.get("kinds") or []}
    kinds = [k for k in PLATFORM_ORDER if k in seen or (k in ("ios", "android") and "mobile" in seen)]
    out: list[dict[str, Any]] = []
    for kind in kinds:
        a = _app_dir_for(kind, apps)
        entry: dict[str, Any] = {"kind": kind}
        app_id = None
        if kind == "ios":
            app_id = (a or {}).get("bundle_id") or (inspected or {}).get("bundle_id")
        elif kind == "android":
            app_id = (a or {}).get("package") or (inspected or {}).get("package")
        elif str((a or {}).get("build_hint") or "").startswith(("http://", "https://")):
            app_id = a["build_hint"]  # type: ignore[index]
        if app_id:
            entry["app_id"] = app_id
        stack = (a or {}).get("stack") or {"ios": "Native iOS", "android": "Native Android"}.get(kind) if a else None
        if stack:
            entry["stack"] = stack
        if a is not None:
            entry["path"] = a.get("path") or "."
            if a.get("name"):
                entry["name"] = a["name"]
        out.append(entry)
    return out


def environments(sheet: dict[str, Any], proposal: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    """Where the web app runs: its local dev URL, and the URL the CI runs its suite against."""
    out: list[dict[str, Any]] = []
    for p in sheet["platforms"]:
        if p["kind"] == "web" and p.get("app_id"):
            out.append({"name": "Local", "base_url": p["app_id"]})
    url = (proposal or {}).get("url")
    if isinstance(url, str) and url.startswith(("http://", "https://")) and "$" not in url and not any(e.get("base_url") == url for e in out):
        out.append({"name": "CI", "base_url": url})
    return out


def primary_platform(found: dict[str, Any], options: Optional[dict[str, Any]] = None) -> Optional[str]:
    """The platform onboarding maps and first runs on: the person's pick, else the first one."""
    kinds = [p["kind"] for p in found.get("platforms") or []]
    want = (options or {}).get("platform")
    if want in kinds:
        return str(want)
    return kinds[0] if kinds else None


def defaults(kind: Optional[str]) -> dict[str, str]:
    return {"device": DEVICE_WORD[kind], "test_data": CLEAN_START[kind]} if kind else {}


def _app_row(a: dict[str, Any]) -> dict[str, Any]:
    keep = ("path", "kinds", "bundle_id", "package", "name", "stack", "build_hint", "dev_script", "sample", "tracked")
    return {k: a.get(k) for k in keep}


def inspect(root: Path) -> Optional[dict[str, Any]]:
    """`repolib.inspect`, plus the two stacks it has no rule for (Python web apps, iOS Swift
    packages) from `folder_scan`. Symlinks are never followed out of the project."""
    inspected = repolib.inspect(str(root))
    if inspected is None:
        return None
    real = Path(os.path.realpath(root))
    if len(inspected["apps"]) > 1:
        for a in inspected["apps"]:
            a["tracked"] = _tracked(root, a["path"])
    known = {a["path"] for a in inspected["apps"]}
    extra = [repolib.asdict(a) for a in folder_scan._extra_apps(root, known, real)]
    if extra:
        inspected["apps"] = sorted(inspected["apps"] + extra, key=lambda a: (bool(a.get("sample")), a["path"].count("/") if a["path"] else -1, a["path"]))
    return inspected


def read_folder(repo: str | Path, *, seconds: float = SCAN_SECONDS) -> dict[str, Any]:
    """The whole sheet for the project folder at `repo`. Reads only; nothing is stored. Raises
    FileNotFoundError when there is no such folder; a part that cannot be read is left out."""
    root = Path(repo).expanduser()
    if not root.is_dir():
        raise FileNotFoundError(f"There is no folder at {repo}.")
    try:
        inspected = inspect(root)
    except Exception:  # noqa: BLE001 - the sheet shows what else it found
        inspected = None
    inv = tests_scan.scan(root, deadline=time.monotonic() + seconds)
    sheet: dict[str, Any] = {
        "repo": {"path": str(root), "name": (inspected or {}).get("repo_name") or root.name},
        "platforms": platforms(inspected),
        "tests": tests_found(inv),
        "ci": ci_found(root),
        "apps": [_app_row(a) for a in (inspected or {}).get("apps") or []],
    }
    if (inspected or {}).get("bundle_id_candidates"):
        sheet["bundle_id_candidates"] = inspected["bundle_id_candidates"]  # type: ignore[index]
    try:
        proposal = ci_mod.propose(root)
    except Exception:  # noqa: BLE001 - no proposal: the local URL alone
        proposal = None
    sheet["environments"] = environments(sheet, proposal)
    try:
        got = backends.detect(root, sheet["platforms"], seconds=BACKEND_SECONDS)
    except Exception:  # noqa: BLE001 - the sheet shows what else it found
        got = {"backends": [], "unknown": {}}
    if got["backends"]:
        sheet["backends"] = got["backends"]
    if got["unknown"]:
        sheet["backend_unknown"] = got["unknown"]
    sheet["defaults"] = defaults(primary_platform(sheet))
    try:
        auth = auth_scan.detect(root)
    except Exception:  # noqa: BLE001 - the sheet shows what else it found
        auth = None
    if auth and auth["methods"]:
        sheet["auth"] = {"summary": auth["summary"], "methods": auth["methods"], "sure": auth["sure"]}
    try:
        boxes = sandbox_scan.detect(root, sheet["platforms"])
    except Exception:  # noqa: BLE001 - the sheet shows what else it found
        boxes = {}
    if boxes:
        sheet["sandboxes"] = boxes
    return sheet


def _main() -> None:  # pragma: no cover - a manual check
    import json
    import sys

    print(json.dumps(read_folder(sys.argv[1]), indent=2))


if __name__ == "__main__":  # pragma: no cover
    _main()
