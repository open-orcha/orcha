"""Which backend each platform's app talks to, read from the repository without running anything
or touching the network (adapted from `onboarding_map/backends.py`), so "We found" can say
where runs land before any of them start.

An app's backend is a URL it is built with, and which one depends on the build:

- **checkout**: what a build from this checkout uses (a dev server). Expo, Next.js, Vite and React Native read `.env.development.local`, `.env.local`,
  `.env.development` and `.env`, in that order, from the app folder;
- **release**: what a store or CI build uses (an APK or IPA someone adds): `.env.production`,
  `eas.json` (a profile's `env`, or the `eas env:create --name X --value URL` it documents) and
  the CI workflows that build the app;
- **any**: what every build uses: a URL in the code (`const API_BASE = "https://..."`, a
  `process.env.X ?? "https://..."` default), `app.json` / `app.config.*`, and the Firebase
  config files (`google-services.json`, `GoogleService-Info.plist`).

Only URL values of backend variables are read (`EXPO_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_API_URL`,
`API_BASE_URL`, ...): keys, tokens and DSNs are never read, and a URL loses any user, password or
query string before it leaves this module. Test files (`__tests__`, `*.test.*`, `jest.*`) are
skipped: their URLs are fixtures, not the app's. So is developer tooling (`scripts/`, `tools/`,
`bin/`): a script's `?? "http://127.0.0.1:54321"` default is where it runs, not the app (#468).

Each backend is marked `production` with the production guard's own heuristic
(`production.looks_like_production`): a hosted URL with no staging/dev/test/preview
marker in its host or variable is production; localhost, private addresses and `.local` hosts
never are. A platform whose backend cannot be told (it reads a variable whose value is set
outside the repository, by EAS or a CI secret) is listed in `unknown` with why.
"""

from __future__ import annotations

import json
import os
import plistlib
import re
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

from orcha_cli.qa.onboarding.app_code import not_app_code
from orcha_cli.qa.onboarding.production import host_of, is_local_host, looks_like_production
from orcha_cli.qa.onboarding import ignored

#: Variable names (after any client prefix) that hold the app's backend URL.
BACKEND_NAMES = (
    "SUPABASE_URL", "API_URL", "API_BASE", "API_BASE_URL", "BASE_API_URL", "BACKEND_URL", "SERVER_URL", "GRAPHQL_URL",
    "GRAPHQL_ENDPOINT", "API_ENDPOINT", "API_HOST", "HASURA_URL", "HASURA_GRAPHQL_URL", "POCKETBASE_URL", "APPWRITE_ENDPOINT",
    "CONVEX_URL", "FIREBASE_DATABASE_URL", "PARSE_SERVER_URL",
)
#: Client prefixes a bundler inlines: they say which kind of app a variable belongs to.
MOBILE_PREFIXES = ("EXPO_PUBLIC_", "REACT_NATIVE_", "RN_")
WEB_PREFIXES = ("NEXT_PUBLIC_", "VITE_", "REACT_APP_", "NUXT_PUBLIC_", "GATSBY_", "PUBLIC_")
MOBILE_KINDS = ("ios", "android")

#: The env files a build from the checkout reads, highest priority first.
CHECKOUT_ENV = (".env.development.local", ".env.local", ".env.development", ".env")
#: The env files a release build reads.
RELEASE_ENV = (".env.production.local", ".env.production")
#: CI files at the repository root (`.github/workflows/*` is listed separately).
CI_FILES = (".gitlab-ci.yml", "codemagic.yaml", "codemagic.yml", "bitrise.yml", "azure-pipelines.yml", ".circleci/config.yml")
CODE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".dart", ".swift", ".kt", ".java")
APP_CONFIGS = ("app.json", "app.config.js", "app.config.ts", "app.config.mjs", "app.config.cjs")
SKIP_DIRS = frozenset({
    "node_modules", ".git", "build", "dist", ".expo", ".next", "Pods", ".gradle", "DerivedData", "vendor", "coverage",
    ".turbo", "out", "web-build", ".dart_tool", "__tests__", "__mocks__", "e2e", "test", "tests", "mocks", "fixtures",
    "__fixtures__", "stories", ".storybook", "Carthage", "intermediates", "generated",
})
#: A file whose name says it is a test, a mock or a test setup: its URLs are fixtures.
TEST_FILE = re.compile(r"(\.test\.|\.spec\.|\.e2e\.|\.stories\.|^jest[.\-]|^setup-?tests|mock)", re.I)
MAX_CODE_FILES = 900
MAX_FILE_BYTES = 256 * 1024
CODE_SECONDS = 3.0

_NAME = re.compile(r"\b([A-Z][A-Z0-9_]*[A-Z0-9])\b")
_URL = re.compile(r"""https?://[^\s"'`,;()<>{}\[\]\\]+""")
#: A camelCase constant or option holding the backend, in code and app config.
_CODE_CONST = re.compile(
    r"""\b(supabaseUrl|supabaseURL|apiUrl|apiURL|apiBaseUrl|apiBaseURL|baseApiUrl|backendUrl|backendURL|serverUrl|serverURL|"""
    r"""graphqlUrl|graphqlEndpoint|apiEndpoint|apiBase|baseURL|baseUrl)\b["']?\s*[:=]\s*(?:URL\(\s*string:\s*)?["'`](https?://[^"'`\s]+)["'`]"""
)
#: `createClient("https://x.supabase.co", ...)`: Supabase with its URL written in.
_SUPABASE_CALL = re.compile(r"""createClient\s*\(\s*["'`](https?://[^"'`\s]+)["'`]""")
_HOST_OK = re.compile(r"^[a-z0-9.\-]+$|^\[[0-9a-f:]+\]$")
_COMMENT = ("#", "//", "*", "/*", "<!--")
#: What may sit between a variable and its URL for the URL to be its value: `=`, `: `, `": "`,
#: ` ?? "`, ` || '`, ` --value ` (`eas env:create --name X --value URL`), or only spaces.
_GLUE = re.compile(r"""[\s"'`]*(?:=|:|\?\?|\|\||--value)?[\s"'`=]*""")
#: Hosts an app calls that are never its own backend: a payment provider's API is not where a run's
#: data lands (nyumba-connect's Stripe `apiBase`).
THIRD_PARTY_HOSTS = ("api.stripe.com", "api.paypal.com", "api-m.paypal.com", "api.flutterwave.com", "api.paystack.co")
#: Folders where an app keeps its own code, read before the rest (generated native folders last).
CODE_FIRST = ("src", "app", "lib", "config", "constants", "services", "api", "utils", "shared")


def clean_url(raw: str) -> str | None:
    """`scheme://host[:port][/path]` of a URL found in a file: no user, password, query or
    fragment (they may carry a key). None for a placeholder (`http://<your-ip>:54321`)."""
    raw = raw.strip().rstrip(".")
    try:
        parts = urlsplit(raw)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not host or not _HOST_OK.match(host) or "${" in raw or "$(" in raw:
        return None
    netloc = f"[{host}]" if ":" in host else host
    if port:
        netloc += f":{port}"
    return urlunsplit((parts.scheme, netloc, parts.path.rstrip("/"), "", ""))


def is_backend_name(name: str) -> bool:
    core = strip_prefix(name)
    return any(core == n or core.endswith("_" + n) for n in BACKEND_NAMES)


def strip_prefix(name: str) -> str:
    for p in MOBILE_PREFIXES + WEB_PREFIXES:
        if name.startswith(p):
            return name[len(p):]
    return name


def family_of(name: str) -> str | None:
    """`mobile` or `web` for a variable a bundler inlines, None when it carries no prefix."""
    if name.startswith(MOBILE_PREFIXES):
        return "mobile"
    if name.startswith(WEB_PREFIXES):
        return "web"
    return None


def service_of(name: str, url: str) -> str:
    host = host_of(url)
    text = f"{name} {host}".lower()
    for word, label in (("supabase", "Supabase"), ("firebase", "Firebase"), ("hasura", "Hasura"), ("appwrite", "Appwrite"),
                        ("pocketbase", "PocketBase"), ("convex", "Convex"), ("graphql", "GraphQL API")):
        if word in text:
            return label
    return "API"


def _read(path: Path) -> str | None:
    try:
        if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def scan_text(text: str, *, comments: bool) -> tuple[list[tuple[str, str, int]], set[str]]:
    """`([(variable, url, line)], {variables read with no value})` for the backend variables in a
    file. `comments`: whether a commented line counts (a CI file documents its values in
    comments; an env file's commented line is an alternative not in use)."""
    found: list[tuple[str, str, int]] = []
    reads: set[str] = set()
    for i, line in enumerate(text.splitlines(), 1):
        if not comments and line.lstrip().startswith(_COMMENT):
            continue
        for m in _NAME.finditer(line):
            name = m.group(1)
            if not is_backend_name(name):
                continue
            window = line[m.end(): m.end() + 90]
            at = window.find("http")
            hit = _URL.match(window, at) if at >= 0 else None
            url = clean_url(hit.group(0)) if hit else None
            if url and _GLUE.fullmatch(window[:at]):
                found.append((name, url, i))
            else:
                reads.add(name)
    return found, reads


def scan_code(text: str) -> tuple[list[tuple[str, str, int]], set[str]]:
    """Backend URLs written in code or app config: an env default, a camelCase constant, a
    Supabase client made with its URL. Comment lines are skipped."""
    found, reads = scan_text(text, comments=False)
    for i, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(_COMMENT):
            continue
        for m in _CODE_CONST.finditer(line):
            url = clean_url(m.group(2))
            if url:
                found.append((m.group(1), url, i))
        for m in _SUPABASE_CALL.finditer(line):
            url = clean_url(m.group(1))
            if url:
                found.append(("createClient", url, i))
    return found, reads


def _code_files(app: Path, deadline: float) -> Iterable[Path]:
    """The app's code files, its own folders first (`src`, `app`, ...) and generated native
    folders last, capped by count and time. Developer tooling (`scripts/verify.ts` signing in
    against a local stack), docs and UI tests are not the app (`auth.detect.not_app_code`)."""
    try:
        entries = sorted(app.iterdir(), key=lambda p: (p.is_dir(), CODE_FIRST.index(p.name) if p.name in CODE_FIRST else len(CODE_FIRST), p.name))
    except OSError:
        return
    n = 0
    skip = ignored.matcher(app)
    for entry in entries:
        if entry.name in SKIP_DIRS or entry.name.startswith(".") or (entry.is_dir() and skip(entry)):
            continue
        walk: Iterable[tuple[str, list[str], list[str]]] = [(str(app), [], [entry.name])] if entry.is_file() else os.walk(entry)
        for dirpath, dirnames, filenames in walk:
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".") and not skip(os.path.join(dirpath, d)))
            for f in sorted(filenames):
                if not f.endswith(CODE_SUFFIXES) or TEST_FILE.search(f) or f in APP_CONFIGS:
                    continue
                if not_app_code(_rel(app, Path(dirpath) / f)):
                    continue
                n += 1
                if n > MAX_CODE_FILES or time.monotonic() > deadline:
                    return
                yield Path(dirpath) / f


def _rel(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def _mobile_side(path: Path, text: str) -> tuple[str, ...]:
    """The phones a CI file builds: from its name, else from what it runs."""
    name = path.name.lower()
    if "android" in name and "ios" not in name:
        return ("android",)
    if "ios" in name and "android" not in name:
        return ("ios",)
    low = text.lower()
    android = any(w in low for w in ("gradle", "assemblerelease", ".apk", "bundlerelease", "--platform android"))
    ios = any(w in low for w in ("xcodebuild", ".ipa", "testflight", "fastlane ios", "--platform ios"))
    if android and not ios:
        return ("android",)
    if ios and not android:
        return ("ios",)
    return MOBILE_KINDS


class _Candidates:
    """Every backend URL found for one platform, by build, in the order they win."""

    def __init__(self) -> None:
        self.by_build: dict[str, list[dict[str, Any]]] = {"checkout": [], "release": [], "any": []}
        self.reads: set[str] = set()

    def add(self, build: str, variable: str, url: str, source: str) -> None:
        self.by_build[build].append({"variable": variable, "url": url, "source": source})

    def pick(self, build: str) -> dict[str, Any] | None:
        """The winning URL for `build`: its own sources first, then what every build uses."""
        if self.by_build[build]:
            return {**self.by_build[build][0], "build": build}
        if self.by_build["any"]:
            return {**self.by_build["any"][0], "build": "any"}
        return None


def _accepts(name: str, family: str) -> bool:
    fam = family_of(name)
    return fam is None or fam == family


def detect(root: Path, platforms: list[dict[str, Any]], *, seconds: float = CODE_SECONDS) -> dict[str, Any]:
    """`{"backends": [...], "unknown": {kind: why}}` for the platforms `found.platforms` lists
    (each with its app folder `path`). Each backend: `platforms`, `service`, `url`, `source`
    (the file, relative to the repository), `variable`, `build` (checkout, release or any) and
    `production`. Never raises: an unreadable file is skipped."""
    deadline = time.monotonic() + seconds
    root = Path(root)
    cands: dict[str, _Candidates] = {}
    dirs: dict[str, list[str]] = {}
    for p in platforms:
        kind = p.get("kind")
        if kind in ("ios", "android", "web"):
            cands[kind] = _Candidates()
            dirs.setdefault(str(p.get("path") or "."), []).append(kind)
    if not cands:
        return {"backends": [], "unknown": {}}

    for rel_dir, kinds in dirs.items():
        app = (root / rel_dir).resolve() if rel_dir != "." else root
        if not app.is_dir():
            continue
        family = "web" if kinds == ["web"] else "mobile"

        def add(build: str, hits: list[tuple[str, str, int]], source: Path, *, family: str = family, only: tuple[str, ...] = tuple(kinds)) -> None:
            for name, url, _line in hits:
                if name.isupper() and not _accepts(name, family):
                    continue
                if host_of(url) in THIRD_PARTY_HOSTS:
                    continue
                for k in only:
                    if k in cands:
                        cands[k].add(build, name, url, _rel(root, source))

        def reads(names: set[str], *, family: str = family) -> None:
            for k in kinds:
                cands[k].reads.update(n for n in names if _accepts(n, family))

        for build, files in (("checkout", CHECKOUT_ENV), ("release", RELEASE_ENV)):
            for f in files:
                text = _read(app / f)
                if text is not None:
                    hits, _ = scan_text(text, comments=False)
                    add(build, hits, app / f)
        eas = app / "eas.json"
        text = _read(eas)
        if text is not None and family == "mobile":
            add("release", _eas_profiles(text), eas)
            hits, names = scan_text(text, comments=True)
            add("release", hits, eas)
            reads(names)
        for f in APP_CONFIGS:
            text = _read(app / f)
            if text is not None:
                hits, names = scan_code(text)
                add("any", hits, app / f)
                reads(names)
        for path in _code_files(app, deadline):
            text = _read(path)
            if text is None:
                continue
            hits, names = scan_code(text)
            add("any", hits, path)
            reads(names)
        for kind, hit in _firebase(app):
            if kind in kinds:
                add("any", [hit[:3]], hit[3], only=(kind,))

    for path in _ci_files(root):
        text = _read(path)
        if text is None:
            continue
        hits, names = scan_text(text, comments=True)
        hosted = [h for h in hits if not is_local_host(host_of(h[1]))]
        mobile = [h for h in hosted if family_of(h[0]) == "mobile"]
        web = [h for h in hosted if family_of(h[0]) == "web"]
        for name, url, _ in mobile:
            for k in _mobile_side(path, text):
                if k in cands:
                    cands[k].add("release", name, url, _rel(root, path))
        for name, url, _ in web:
            if "web" in cands:
                cands["web"].add("release", name, url, _rel(root, path))
        for n in names:
            fam = family_of(n)
            for k in (MOBILE_KINDS if fam == "mobile" else ("web",) if fam == "web" else ()):
                if k in cands:
                    cands[k].reads.add(n)

    out: list[dict[str, Any]] = []
    unknown: dict[str, str] = {}
    for kind in ("ios", "android", "web"):
        c = cands.get(kind)
        if c is None:
            continue
        checkout = c.pick("checkout")
        release = c.pick("release")
        if checkout and release and checkout["url"] == release["url"]:
            picked = [{**checkout, "build": "any"}]  # every build talks to it
        elif checkout and release:
            picked = [{**checkout, "build": "checkout"}, {**release, "build": "release"}]
        else:
            picked = [b for b in (checkout, release) if b]
        for b in picked:
            entry = {
                "platforms": [kind], "service": service_of(b["variable"], b["url"]), "url": b["url"], "source": b["source"],
                "variable": b["variable"], "build": b["build"], "production": looks_like_production(b["variable"], b["url"]),
            }
            same = next((e for e in out if {k: v for k, v in e.items() if k != "platforms"} == {k: v for k, v in entry.items() if k != "platforms"}), None)
            if same:
                same["platforms"].append(kind)
            else:
                out.append(entry)
        if not checkout and (kind in MOBILE_KINDS or c.reads):
            unknown[kind] = _why_unknown(c, release)
    return {"backends": out, "unknown": unknown}


def _why_unknown(c: _Candidates, release: dict[str, Any] | None) -> str:
    var = sorted(c.reads, key=lambda n: (not is_backend_name(n), n))[0] if c.reads else None
    if var and release:
        return f"Builds from this checkout read {var}, but no value for it is in the repository (no .env); release builds use {host_of(release['url'])}"
    if var:
        return f"It reads {var}, but no value for it is in the repository: it is set outside it (EAS, CI or the shell)"
    if release:
        return f"Only release builds name one ({host_of(release['url'])}); nothing says what a build from this checkout uses"
    return "No backend address in its code or config"


def _eas_profiles(text: str) -> list[tuple[str, str, int]]:
    """The URLs an `eas.json` build profile sets in its `env`, the production profile first."""
    try:
        data = json.loads(text)
    except ValueError:
        return []
    builds = data.get("build") if isinstance(data, dict) else None
    if not isinstance(builds, dict):
        return []
    hits: list[tuple[str, str, int]] = []
    for profile in sorted(builds, key=lambda p: (p != "production", p)):
        env = (builds.get(profile) or {}).get("env") if isinstance(builds.get(profile), dict) else None
        for name, value in (env or {}).items() if isinstance(env, dict) else ():
            url = clean_url(str(value)) if isinstance(value, str) and is_backend_name(str(name)) else None
            if url:
                hits.append((str(name), url, 0))
    return hits


def _firebase(app: Path) -> list[tuple[str, tuple[str, str, int, Path]]]:
    """`[(kind, (variable, url, 0, file))]` from the Firebase config files of an app folder."""
    out: list[tuple[str, tuple[str, str, int, Path]]] = []
    for rel in ("google-services.json", "android/app/google-services.json", "app/google-services.json"):
        path = app / rel
        text = _read(path)
        if text is None:
            continue
        try:
            info = (json.loads(text) or {}).get("project_info") or {}
        except (ValueError, AttributeError):
            continue
        url = clean_url(str(info.get("firebase_url") or "")) or (clean_url(f"https://{info['project_id']}.firebaseapp.com") if info.get("project_id") else None)
        if url:
            out.append(("android", ("FIREBASE_PROJECT", url, 0, path)))
        break
    for path in sorted(app.glob("GoogleService-Info.plist")) + sorted(app.glob("ios/*/GoogleService-Info.plist")):
        try:
            info = plistlib.loads(path.read_bytes())
        except Exception:  # noqa: BLE001 - a broken plist is skipped
            continue
        url = clean_url(str(info.get("DATABASE_URL") or "")) or (clean_url(f"https://{info['PROJECT_ID']}.firebaseapp.com") if info.get("PROJECT_ID") else None)
        if url:
            out.append(("ios", ("FIREBASE_PROJECT", url, 0, path)))
            break
    return out


def _ci_files(root: Path) -> list[Path]:
    wf = root / ".github" / "workflows"
    files = sorted([*wf.glob("*.yml"), *wf.glob("*.yaml")]) if wf.is_dir() else []
    return files + [root / f for f in CI_FILES if (root / f).is_file()]
