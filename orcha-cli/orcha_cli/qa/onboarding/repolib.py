"""The app folders of a repository (adapted from `cloud/repolib.py`): JS apps by their
package.json, Expo / React Native / Flutter, bare Xcode and Gradle projects, XcodeGen specs, Laravel,
with each app's bundle id, package, display name, stack and conventional dev URL. Reads files only:
no model, no device, no network, nothing run.

What counts as an app:
- A package or library is not an app (`_flutter_is_app`, `_js_library`, `_gradle_is_library`,
  `_xcode_is_library`).
- Sample, test and benchmark folders (`SAMPLE_DIRS` anywhere in the path) are still apps, but
  flagged `sample` and ranked after the real ones.
- Desktop apps (Electron, Tauri) are recognised so their Vite renderer is never taken for a web
  site; Orcha QA does not test them.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from orcha_cli.qa.onboarding import ignored

ELECTRON_DEPS = ("electron", "electron-vite", "electron-builder", "@electron-forge/cli", "electron-forge")
TAURI_CONFIGS = ("src-tauri/tauri.conf.json", "src-tauri/Tauri.toml")

SKIP_DIRS = {
    "node_modules", ".git", ".venv", "venv", "Library", "Applications", "Pods", "build",
    "dist", ".next", "DerivedData", ".cache", "__pycache__", ".Trash", "Music", "Movies",
    "Pictures", "Public", "target", "vendor",
}
PLATFORM_DIRS = {"ios", "android", "macos", "windows", "linux", "web"}
# Folders the deeper web-frontend search never enters: build output, caches and test fixtures
# hold package.json files that are not the app (on top of `SKIP_DIRS`).
DEEP_SKIP_DIRS = {"out", "coverage", ".turbo", "storybook-static", "site-packages", "__snapshots__", "fixtures"}
# A web frontend can sit deeper than the general scan goes: Orcha's portal UI is
# `orcha-cli/orcha_cli/templates/portal/frontend`, five levels down. Below `max_depth` only web
# apps are looked for, down to this depth, visiting at most `WEB_SEARCH_BUDGET` folders.
WEB_MAX_DEPTH = 6
WEB_SEARCH_BUDGET = 4000
MOBILE_DEPS = ("expo", "react-native")
# Electron apps (`ELECTRON_DEPS`) are checked before WEB_DEPS: they list `vite` too,
# but their renderer only runs inside Electron, never at a dev-server URL.
DESKTOP_DEPS = ELECTRON_DEPS
WEB_DEPS = ("next", "vite", "react-scripts", "@remix-run/dev", "astro", "nuxt", "@angular/core", "svelte", "@sveltejs/kit")
# Path segments that mark an app folder as a sample, test or benchmark rather than the product:
# ranked after the real apps and given no icon thumbnails.
SAMPLE_DIRS = {
    "dev", "example", "examples", "sample", "samples", "test", "tests", "testing", "__tests__",
    "integration_test", "integration_tests", "benchmark", "benchmarks", "fixture", "fixtures", "e2e",
}
# Web framework -> (stack label, conventional local dev URL). Checked in this order (a repo
# with both `next` and `vite` in its deps is unusual, but Next.js wins as the more specific
# signal); SvelteKit is checked before bare Svelte, since `@sveltejs/kit` repos also depend on
# `svelte` itself. The URL is what the Platforms step prefills the web target's locator with
# and is only ever a *convention*, never verified against the app's actual config.
_WEB_FRAMEWORKS: tuple[tuple[str, str, str], ...] = (
    ("next", "Next.js", "http://localhost:3000"),
    ("@sveltejs/kit", "SvelteKit", "http://localhost:5173"),
    ("nuxt", "Nuxt", "http://localhost:3000"),
    ("astro", "Astro", "http://localhost:4321"),
    ("vite", "Vite", "http://localhost:5173"),
    ("react-scripts", "Create React App", "http://localhost:3000"),
    ("@remix-run/dev", "Remix", "http://localhost:3000"),
    ("@angular/core", "Angular", "http://localhost:4200"),
    ("svelte", "Svelte", "http://localhost:5173"),
)

@dataclass
class AppDir:
    path: str  # relative to the repository root ("" = root)
    kinds: list[str]
    bundle_id: str | None = None  # iOS bundle identifier when it can be read from the project
    package: str | None = None  # Android application id / package
    name: str | None = None  # app display name (Expo `name`, package.json name)
    icons: list[Any] = field(default_factory=list)  # the original thumbnails; never filled here
    # Human-readable framework label for the Platforms step ("Flutter", "React Native (Expo)",
    # "Next.js", "Native iOS", ...), or None when the scan can only tell the bare `kinds`.
    stack: str | None = None
    # What running this app locally conventionally looks like: a web framework's dev URL/port
    # ("http://localhost:3000") or the `package.json` "dev" script's command, for the Platforms
    # step's build hint. None when the scan has no convention to suggest.
    build_hint: str | None = None
    # A desktop app (`kinds == ["desktop"]`): engine, dev/build/package commands, product name,
    # appId and the packaged `.app` path in the original. Always None here.
    desktop: dict[str, Any] | None = None
    # The package.json "dev" script, when there is one: between several web apps the one with a
    # dev script is the likelier site to test.
    dev_script: str | None = None
    # A sample, test or benchmark app (`SAMPLE_DIRS` in its path): listed after the real apps.
    sample: bool = False


def is_tauri(app_dir: Path) -> bool:
    return any((app_dir / c).is_file() for c in TAURI_CONFIGS)


def _deps(package_json: Path) -> set[str]:
    try:
        data = json.loads(package_json.read_text())
    except (OSError, ValueError):
        return set()
    out: set[str] = set()
    for key in ("dependencies", "devDependencies"):
        out.update((data.get(key) or {}).keys())
    return out


def _dev_script(package_json: Path) -> str | None:
    """The `"dev"` script command from `package.json`, if any — the build hint for a JS app
    when no more specific convention (a web framework's own default port) applies."""
    try:
        data = json.loads(package_json.read_text())
    except (OSError, ValueError):
        return None
    scripts = data.get("scripts")
    dev = scripts.get("dev") if isinstance(scripts, dict) else None
    return dev if isinstance(dev, str) and dev.strip() else None


_PORT_FLAG_RE = re.compile(r"(?:--port[= ]|-p\s+)(\d{2,5})\b")
_PORT_ENV_RE = re.compile(r"\bPORT=(\d{2,5})\b")
_VITE_SERVER_PORT_RE = re.compile(r"server\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})", re.DOTALL)
_PROXY_TARGET_RE = re.compile(r"""target\s*:\s*(?:[^"'`,}]*\|\|\s*)?["'`](https?://(?:localhost|127\.0\.0\.1):\d{2,5})["'`]""")
_OUT_DIR_RE = re.compile(r"""outDir\s*:\s*["'`](\.\./[^"'`]+)["'`]""")


def _vite_config(app_dir: Path) -> str:
    for name in ("vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"):
        try:
            return (app_dir / name).read_text(errors="ignore")
        except OSError:
            continue
    return ""


def web_url(app_dir: Path, default: str | None) -> str | None:
    """The URL a web app is visited at, when its own files say more than the framework's
    convention: a port in the dev script (`vite --port 4000`, `next dev -p 4000`,
    `PORT=4000 ...`), Vite's `server.port`, or, for a frontend whose build lands outside its
    folder and whose dev server proxies to a local backend (Orcha's portal: built into
    `../static/dist`, served by the FastAPI portal on :8000+), that backend's URL. `default`
    otherwise. Read with regexes, never run."""
    dev = _dev_script(app_dir / "package.json") or ""
    m = _PORT_FLAG_RE.search(dev) or _PORT_ENV_RE.search(dev)
    if m:
        return f"http://localhost:{m.group(1)}"
    config = _vite_config(app_dir)
    if config:
        m = _VITE_SERVER_PORT_RE.search(config)
        if m:
            return f"http://localhost:{m.group(1)}"
        target = _PROXY_TARGET_RE.search(config)
        if target and _OUT_DIR_RE.search(config):
            return target.group(1).replace("127.0.0.1", "localhost")
    return default


# A PHP backend whose own server is the app (Vite, when present, only serves its assets):
# Laravel's `php artisan serve` listens on :8000.
LARAVEL_URL = "http://localhost:8000"


def _is_laravel(app_dir: Path) -> bool:
    """A Laravel app: an `artisan` script next to a composer.json that requires
    laravel/framework. Such a repo usually also has a package.json with `vite`, but that dev
    server only serves CSS/JS on :5173 — the app itself is at `php artisan serve`'s :8000."""
    if not (app_dir / "artisan").is_file():
        return False
    composer = _read_json(app_dir / "composer.json")
    reqs = composer.get("require")
    return isinstance(reqs, dict) and "laravel/framework" in reqs


def _is_expo(app_dir: Path) -> bool:
    return (app_dir / "app.json").is_file() or (app_dir / "app.config.json").is_file() or (app_dir / "app.config.js").is_file() or (app_dir / "app.config.ts").is_file()


def _stack_and_hint(app_dir: Path, kinds: list[str], deps: set[str]) -> tuple[str | None, str | None]:
    """Human-readable framework label + build hint for the Platforms step, from whatever the
    scan already knows about this app dir (its `kinds` and, for a JS app, its `package.json`
    dependencies) — never a second filesystem walk, just a label on top of the existing
    detection."""
    if "desktop" in kinds:
        return ("Tauri" if is_tauri(app_dir) else "Electron"), None
    if "mobile" in kinds:
        if (app_dir / "pubspec.yaml").is_file():
            return "Flutter", "flutter run"
        if _is_expo(app_dir):
            return "React Native (Expo)", "npx expo start"
        return "React Native", _dev_script(app_dir / "package.json") or "npx react-native run-ios / run-android"
    if "web" in kinds:
        if _is_laravel(app_dir):
            return "Laravel", LARAVEL_URL
        deps = deps or _deps(app_dir / "package.json")
        for dep, label, url in _WEB_FRAMEWORKS:
            if dep in deps:
                return label, web_url(app_dir, url)
        return "Web", web_url(app_dir, None) or _dev_script(app_dir / "package.json")
    if "ios" in kinds and "android" not in kinds:
        # A directory whose own name/project mentions macOS/tvOS/watchOS instead of iOS (e.g.
        # Sukoon-macOS) is a native project too, just not for iOS - the same hint app_ids()
        # uses to prefer the iOS pbxproj over the macOS one in a multi-platform repo.
        if _OTHER_APPLE_PLATFORM_RE.search(app_dir.name) and not _IOS_HINT_RE.search(app_dir.name):
            return "Native (Apple platform)", None
        return "Native iOS", None
    if "android" in kinds and "ios" not in kinds:
        return "Native Android", None
    return None, None


# The value of a `PRODUCT_BUNDLE_IDENTIFIER` setting, quoted or not, in a pbxproj (`= x;`) or an
# XcodeGen spec (`: x`). The value must end there: `com.acme.$(SUFFIX)` is a build-time value,
# not an id, and a partial `com.acme.` match would be worse than none.
_BUNDLE_RE = re.compile(
    r"""PRODUCT_BUNDLE_IDENTIFIER\s*[=:]\s*["']?([A-Za-z0-9_.\-]+)["']?\s*(?:;|$)""", re.MULTILINE
)
_APP_ID_RE = re.compile(r"applicationId\s*[=(]?\s*[\"']([A-Za-z0-9_.]+)[\"']")
_PACKAGE_RE = re.compile(r"package\s*=\s*[\"']([A-Za-z0-9_.]+)[\"']")

# A bundle id ending in one of these is a test target, app extension, or watch companion, never
# the main app the user wants to run — e.g. a sukoon-like repo's iOS pbxproj lists
# com.nursoft.sukoon.ios, com.nursoft.sukoon.ios.MushafSwipeUITests and
# com.nursoft.sukoon.ios.widgets alongside each other; only the first is the app.
_EXCLUDED_BUNDLE_SUFFIXES = (
    "Tests",
    "UITests",
    ".widgets",
    ".watchkitapp",
    ".watchkitextension",
    ".extension",
)


def _is_excluded_bundle_id(bundle_id: str) -> bool:
    return any(bundle_id.endswith(suffix) for suffix in _EXCLUDED_BUNDLE_SUFFIXES)


def _is_test_bundle_id(bundle_id: str) -> bool:
    return bundle_id.endswith("Tests")


def _pick_bundle_id(ids: set[str]) -> str | None:
    """Best guess at the *app* target's id among every `PRODUCT_BUNDLE_IDENTIFIER` in one
    pbxproj: drop test/extension/widget/watch ids, then take the shortest of what remains (the
    app target's id is a prefix of its extensions' — com.x.app vs com.x.app.widget). Falls back
    to the shortest extension id if every id looked like an extension target, so a project that
    fails to declare a "plain" id still returns something — but never to a test bundle
    (`io.openorcha.OrchaTests`): a test bundle cannot be launched, so naming it as the app only
    sends the run to an app that does not exist."""
    candidates = {i for i in ids if not _is_excluded_bundle_id(i)} or {i for i in ids if not _is_test_bundle_id(i)}
    if not candidates:
        return None
    return min(candidates, key=lambda v: (len(v), v))


# A pbxproj under a directory whose name or own filename mentions iOS is preferred over one
# that mentions macOS/tvOS/watchOS when several native platforms share a repo (Sukoon-iOS vs
# Sukoon-macOS): match "ios" as a whole path segment/word so "Sukoon-iOS" and "ios-app" match
# but "macos" does not accidentally contain "ios".
_IOS_HINT_RE = re.compile(r"(?:^|[^a-z])ios(?:$|[^a-z])", re.IGNORECASE)
_OTHER_APPLE_PLATFORM_RE = re.compile(r"(?:^|[^a-z])(macos|tvos|watchos)(?:$|[^a-z])", re.IGNORECASE)


_YML_KEY_RE = re.compile(r"^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*?)\s*$")


def _yml_value(raw: str) -> str:
    """A scalar from one line of YAML: comment dropped, quotes stripped."""
    if raw[:1] in ("'", '"'):
        return raw[1:].split(raw[0], 1)[0]
    return raw.split(" #", 1)[0].strip()


def xcodegen_targets(text: str) -> list[dict[str, str | None]]:
    """The targets of an XcodeGen spec (`project.yml`): name, `type`, `platform` and bundle id
    (`PRODUCT_BUNDLE_IDENTIFIER` anywhere in the target, else `options.bundleIdPrefix` + name,
    which is what XcodeGen itself generates). A line-based reader rather than a YAML parser,
    which the worker does not ship: it only needs these few keys. Empty when `text` is not an
    XcodeGen spec."""
    prefix: str | None = None
    targets: list[dict[str, str | None]] = []
    section: str | None = None
    target_indent: int | None = None
    current: dict[str, str | None] | None = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith(("#", "-")):
            continue
        m = _YML_KEY_RE.match(line)
        if not m:
            continue
        indent, key, value = len(m.group(1)), m.group(2), _yml_value(m.group(3))
        if indent == 0:
            section, target_indent, current = key, None, None
            continue
        if section == "options" and key == "bundleIdPrefix" and value:
            prefix = value
        if section != "targets":
            continue
        if target_indent is None:
            target_indent = indent
        if indent == target_indent:
            current = {"name": key, "type": None, "platform": None, "bundle_id": None}
            targets.append(current)
            continue
        if current is None:
            continue
        if key == "type" and current["type"] is None:
            current["type"] = value
        elif key == "platform" and current["platform"] is None:
            current["platform"] = value
        elif key == "PRODUCT_BUNDLE_IDENTIFIER" and current["bundle_id"] is None and value and "$" not in value:
            current["bundle_id"] = value
    for t in targets:
        if t["bundle_id"] is None and prefix:
            t["bundle_id"] = f"{prefix}.{t['name']}"
    return targets


def _xcodegen_ios_apps(targets: list[dict[str, str | None]]) -> list[dict[str, str | None]]:
    return [
        t for t in targets
        if t["type"] == "application" and (t["platform"] is None or "ios" in (t["platform"] or "").lower())
    ]


def xcodegen_bundle_id(spec: Path) -> str | None:
    """The iOS application target's bundle id in an XcodeGen spec, or None. Only `application`
    targets count: the unit-test bundle (`io.openorcha.OrchaTests`, from the prefix) and the
    widget extension are never the app."""
    try:
        text = spec.read_text(errors="ignore")
    except OSError:
        return None
    ids = {str(t["bundle_id"]) for t in _xcodegen_ios_apps(xcodegen_targets(text)) if t["bundle_id"]}
    return _pick_bundle_id(ids)


def is_xcodegen_ios_spec(spec: Path) -> bool:
    """Whether `spec` is an XcodeGen project with an iOS application target."""
    try:
        if not spec.is_file():
            return False
        return bool(_xcodegen_ios_apps(xcodegen_targets(spec.read_text(errors="ignore"))))
    except OSError:
        return False


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def identifiers(app_dir: Path) -> dict[str, str | None]:
    """Best-effort app identifiers: Expo `app.json`/`app.config.json` (`expo.ios.bundleIdentifier`,
    `expo.android.package`, `expo.name`), native `PRODUCT_BUNDLE_IDENTIFIER` in a pbxproj,
    Android `applicationId` in build.gradle(.kts) or `package` in the manifest."""
    out: dict[str, str | None] = {"bundle_id": None, "package": None, "name": None}
    for cfg in ("app.json", "app.config.json"):
        data = _read_json(app_dir / cfg)
        expo = data.get("expo") if isinstance(data.get("expo"), dict) else data
        if isinstance(expo, dict) and expo:
            ios = expo.get("ios") if isinstance(expo.get("ios"), dict) else {}
            android = expo.get("android") if isinstance(expo.get("android"), dict) else {}
            out["bundle_id"] = out["bundle_id"] or ios.get("bundleIdentifier")
            out["package"] = out["package"] or android.get("package")
            out["name"] = out["name"] or expo.get("name")
    if out["name"] is None:
        out["name"] = _read_json(app_dir / "package.json").get("name")
    if out["bundle_id"] is None:
        for pbx in sorted(app_dir.glob("*.xcodeproj/project.pbxproj")) + sorted(app_dir.glob("ios/*.xcodeproj/project.pbxproj")):
            try:
                ids = [m for m in _BUNDLE_RE.findall(pbx.read_text(errors="ignore")) if "$(" not in m]
            except OSError:
                ids = []
            if ids:
                out["bundle_id"] = _pick_bundle_id(set(ids))
                break
    if out["bundle_id"] is None:
        # An XcodeGen project keeps its targets in project.yml and its .xcodeproj out of git.
        for spec in (app_dir / "project.yml", app_dir / "ios" / "project.yml"):
            out["bundle_id"] = xcodegen_bundle_id(spec)
            if out["bundle_id"]:
                break
    if out["package"] is None:
        candidates = [app_dir / "app" / "build.gradle", app_dir / "app" / "build.gradle.kts",
                      app_dir / "android" / "app" / "build.gradle", app_dir / "android" / "app" / "build.gradle.kts"]
        for g in candidates:
            try:
                m = _APP_ID_RE.search(g.read_text(errors="ignore"))
            except OSError:
                continue
            if m:
                out["package"] = m.group(1)
                break
        if out["package"] is None:
            for mf in (app_dir / "app" / "src" / "main" / "AndroidManifest.xml", app_dir / "android" / "app" / "src" / "main" / "AndroidManifest.xml"):
                try:
                    m = _PACKAGE_RE.search(mf.read_text(errors="ignore"))
                except OSError:
                    continue
                if m:
                    out["package"] = m.group(1)
                    break
    return out


_FLUTTER_PLUGIN_RE = re.compile(r"^\s+plugin:\s*$", re.MULTILINE)
_APP_ENTRY_MAINS = ("expo-router/entry", "node_modules/expo/AppEntry.js", "expo/AppEntry")
_WEB_APP_CONFIGS = (
    "next.config.js", "next.config.mjs", "next.config.ts", "nuxt.config.ts", "nuxt.config.js",
    "astro.config.mjs", "astro.config.ts", "angular.json", "index.html", "remix.config.js",
)
_GRADLE_LIBRARY_RE = re.compile(r"""com\.android\.library|android[.\-]library\b""")
_GRADLE_APP_RE = re.compile(r"""com\.android\.application|android[.\-]application\b""")
_PRODUCT_TYPE_RE = re.compile(r"productType\s*=\s*\"?(com\.apple\.product-type\.[A-Za-z0-9.\-]+)")


def _flutter_is_app(cur: Path, text: str) -> bool:
    """A Flutter pubspec is an app when it can run: it has a platform folder (`ios/`,
    `android/`, `web/`, ...) or a `lib/main.dart`. A pubspec with neither is a package
    (`flutter_test`, `flutter_tools`), and a plugin (`flutter: plugin:`) is a package even
    though it ships `ios/` and `android/` folders: its runnable app is its `example/`."""
    if _FLUTTER_PLUGIN_RE.search(text):
        return False
    if (cur / "lib" / "main.dart").is_file():
        return True
    return any((cur / d).is_dir() for d in PLATFORM_DIRS)


def _js_library(cur: Path, data: dict[str, Any]) -> bool:
    """A package.json that publishes a library rather than running an app: it is not
    `"private": true`, it names a library entry (`main`, `module`, `exports`, `types`), and
    nothing in the folder says app (an Expo/React Native app config, an Expo entry `main`, a
    web framework config, an `index.html`, or native `ios/`/`android/` app projects)."""
    if data.get("private") is True:
        return False
    if not any(k in data for k in ("main", "module", "exports", "types", "typings")):
        return False
    main = data.get("main")
    if isinstance(main, str) and main.startswith(_APP_ENTRY_MAINS):
        return False
    if _is_expo(cur) or any((cur / f).is_file() for f in _WEB_APP_CONFIGS):
        return False
    if (cur / "android" / "app").is_dir() or any((cur / "ios").glob("*.xcodeproj")):
        return False
    return True


def _gradle_is_library(module: Path) -> bool:
    """A Gradle module that applies the Android library plugin and not the application one."""
    for name in ("build.gradle", "build.gradle.kts"):
        try:
            text = (module / name).read_text(errors="ignore")
        except OSError:
            continue
        if _GRADLE_LIBRARY_RE.search(text) and not _GRADLE_APP_RE.search(text):
            return True
    return False


def _xcode_is_library(cur: Path, names: list[str]) -> bool:
    """Every Xcode project in the folder builds frameworks or libraries and none an application
    (`productType` in the pbxproj), or the folder is a pod (`*.podspec`) with no application
    project. A pbxproj that names no product type at all is given the benefit of the doubt."""
    types: set[str] = set()
    for n in names:
        if n.endswith(".xcodeproj"):
            try:
                types.update(_PRODUCT_TYPE_RE.findall((cur / n / "project.pbxproj").read_text(errors="ignore")))
            except OSError:
                continue
    has_app = any(t.startswith("com.apple.product-type.application") for t in types)
    if has_app:
        return False
    if types:
        return True
    return any(n.endswith(".podspec") for n in names)


def is_sample_path(rel: str) -> bool:
    """Whether an app folder (relative to the repository) sits under a sample, test or
    benchmark folder (`SAMPLE_DIRS`): `dev/benchmarks/complex_layout`, `examples/hello`."""
    return any(part.lower() in SAMPLE_DIRS for part in rel.split("/") if part)


def app_dirs(
    repo: Path,
    max_depth: int = 3,
    *,
    follow_symlinks: bool = True,
    web_max_depth: int = WEB_MAX_DEPTH,
    web_budget: int = WEB_SEARCH_BUDGET,
) -> list[AppDir]:
    """App folders inside a repository, real apps first and then samples (`is_sample_path`),
    shallowest first within each: JS apps by their package.json dependencies, plus bare native
    projects (`*.xcodeproj`, `build.gradle`) when no JS app wraps them. Packages and libraries
    are not apps (see the module docstring) and are descended into like any folder, so a
    library's `example/` app is still found. Below `max_depth`, down to `web_max_depth`, only web apps are looked for (a
    frontend nested in a package, like Orcha's portal), visiting at most `web_budget` folders.

    `follow_symlinks=False` never descends into a symlinked directory, so a scan of a chosen folder
    cannot wander outside it."""
    unread = ignored.matcher(repo)
    found: list[tuple[int, AppDir]] = []
    stack: list[tuple[Path, int]] = [(repo, 0)]
    deep_visits = 0
    deepest = max(max_depth, web_max_depth)
    while stack:
        cur, depth = stack.pop()
        deep = depth > max_depth
        if deep:
            deep_visits += 1
            if deep_visits > web_budget:
                continue
        kinds: list[str] = []
        deps: set[str] = set()
        pj = cur / "package.json"
        if pj.is_file():
            deps = _deps(pj)
            if any(d in deps for d in DESKTOP_DEPS):
                kinds.append("desktop")
            else:
                if any(d in deps for d in MOBILE_DEPS):
                    kinds.append("mobile")
                if any(d in deps for d in WEB_DEPS):
                    kinds.append("web")
                if kinds and _js_library(cur, _read_json(pj)):
                    kinds = []  # a component or SDK package that lists react-native or vite
        if is_tauri(cur):
            # A Tauri app's package.json lists Vite for its webview, which is not a web app.
            kinds = ["desktop"]
        if not kinds and _is_laravel(cur):
            kinds.append("web")  # a Laravel app with no (or a non-Vite) frontend toolchain
        pubspec = cur / "pubspec.yaml"
        if not kinds and pubspec.is_file():
            try:
                text = pubspec.read_text(errors="ignore")
                if "flutter" in text and _flutter_is_app(cur, text):
                    kinds.append("mobile")
            except OSError:
                pass
        names: list[str] = []
        if not kinds:
            try:
                names = [c.name for c in cur.iterdir()]
            except OSError:
                names = []
            has_own_xcodeproj = any(n.endswith(".xcodeproj") for n in names)
            has_workspace = any(n.endswith(".xcworkspace") for n in names)
            # An XcodeGen project (`project.yml`) commits no .xcodeproj at all.
            has_xcodegen = "project.yml" in names and is_xcodegen_ios_spec(cur / "project.yml")
            if (has_own_xcodeproj or has_workspace or has_xcodegen) and "Pods" not in names:
                if has_xcodegen or not _xcode_is_library(cur, names):
                    kinds.append("ios")
            if "build.gradle" in names or "build.gradle.kts" in names:
                if (cur / "app").is_dir() and not _gradle_is_library(cur / "app"):
                    kinds.append("android")
        # A directory whose only Xcode marker is an `.xcworkspace` and has no `.xcodeproj`
        # of its own (e.g. a multi-app workspace root: Sukoon.xcworkspace at the repo root,
        # with the real projects in sibling Sukoon-iOS/, Sukoon-macOS/ folders) is a workspace
        # *umbrella*, not an app with an identifier of its own — recording it as an AppDir
        # would surface "Detected: iOS" with no bundle id and, being treated as a leaf, would
        # stop the scan from ever reaching the real per-platform projects. Skip recording it
        # and keep descending so those sibling projects are found instead.
        is_workspace_umbrella = (
            kinds == ["ios"]
            and not any(n.endswith(".xcodeproj") for n in names)
            and any(n.endswith(".xcworkspace") for n in names)
        )
        if deep and kinds != ["web"]:
            # Below the general depth only a plain web app counts; anything else found there
            # (a native project, a desktop app) is not recorded, and does not stop the search.
            kinds = []
        if kinds and not is_workspace_umbrella:
            rel = cur.relative_to(repo).as_posix()
            sample = is_sample_path("" if rel == "." else rel)
            ids = identifiers(cur)
            stack_label, build_hint = _stack_and_hint(cur, kinds, deps)
            found.append(
                (
                    depth,
                    AppDir(
                        "" if rel == "." else rel,
                        kinds,
                        ids["bundle_id"],
                        ids["package"],
                        ids["name"],
                        [],
                        stack_label,
                        build_hint,
                        None,
                        _dev_script(pj) if pj.is_file() else None,
                        sample,
                    ),
                )
            )
        if depth >= deepest:
            continue
        if kinds and depth >= max_depth:
            # A web app found at the edge of the general scan is a leaf for the deeper search.
            continue
        # A cross-platform app (Expo/RN/Flutter) owns its generated platform folders: not
        # separate apps. Xcode bundles and native projects are leaves too. A workspace
        # umbrella is not a leaf: it has nothing of its own but wraps the real app folders.
        if kinds and set(kinds) & {"ios", "android"} and "mobile" not in kinds and not is_workspace_umbrella:
            continue
        # A desktop app is one app: its folders (bundled resources, renderer, copies of
        # templates) are never separate apps.
        if "desktop" in kinds:
            continue
        skip = SKIP_DIRS | (PLATFORM_DIRS if "mobile" in kinds else set()) | (DEEP_SKIP_DIRS if depth + 1 > max_depth else set())
        try:
            children = [
                c for c in cur.iterdir()
                if c.is_dir()
                and (follow_symlinks or not c.is_symlink())
                and c.name not in skip
                and not c.name.startswith(".")
                and not c.name.endswith((".xcodeproj", ".xcworkspace"))
                and not unread(c)
            ]
        except OSError:
            continue
        stack.extend((c, depth + 1) for c in children)
    found.sort(key=lambda t: (t[1].sample, t[0], t[1].path))
    return [a for _, a in found]


def _pbxprojs(repo: Path, max_depth: int) -> list[Path]:
    """Every `project.pbxproj` under `repo`, skipping the same noise `app_dirs` skips, up to
    `max_depth` directories deep. Order is not significant — `app_ids` re-sorts by preference."""
    out: list[Path] = []
    stack: list[tuple[Path, int]] = [(repo, 0)]
    unread = ignored.matcher(repo)
    while stack:
        cur, depth = stack.pop()
        try:
            children = list(cur.iterdir())
        except OSError:
            continue
        for c in children:
            if c.is_dir() and c.name.endswith(".xcodeproj"):
                pbx = c / "project.pbxproj"
                if pbx.is_file():
                    out.append(pbx)
        if depth >= max_depth:
            continue
        for c in children:
            if (
                c.is_dir()
                and c.name not in SKIP_DIRS
                and not c.name.startswith(".")
                and not c.name.endswith((".xcodeproj", ".xcworkspace"))
                and not unread(c)
            ):
                stack.append((c, depth + 1))
    return out


def _platform_score(pbx: Path) -> int:
    """0 when the pbxproj's own directory or filename mentions iOS, 2 when it mentions another
    Apple platform (macOS/tvOS/watchOS) instead, 1 when neither is mentioned — lower sorts
    first, so an ambiguous project is preferred over a project clearly for another platform,
    but a project clearly for iOS beats both."""
    haystack = f"{pbx.parent.parent.name}/{pbx.parent.name}"
    if _IOS_HINT_RE.search(haystack):
        return 0
    if _OTHER_APPLE_PLATFORM_RE.search(haystack):
        return 2
    return 1


def app_ids(repo: Path, subdirectory: str | None = None, max_depth: int = 3, *, follow_symlinks: bool = False) -> dict[str, Any]:
    """Best guess at this repository's iOS bundle id (and Android package / app name, via
    `identifiers`), across every app folder found — not just one. Handles a multi-app
    workspace where a bare `min(ids, key=len)` over every pbxproj in the repo would pick the
    wrong platform's id (a sukoon-like repo's `Sukoon-macOS/sukoon-mac.xcodeproj` declares the
    shorter `com.nursoft.sukoon`, while `Sukoon-iOS/sukoon-ios.xcodeproj` declares the longer
    `com.nursoft.sukoon.ios` — the *correct* one for "Detected: iOS"):

    1. When `subdirectory` is given, pbxprojs under it are tried first (a user-chosen monorepo
       app folder wins over anything else in the repo).
    2. Within each tier, a pbxproj whose own directory/filename mentions iOS is preferred over
       one that mentions macOS/tvOS/watchOS; a project that mentions neither ranks in between.
    3. Within a pbxproj, ids ending in `Tests`, `UITests`, `.widgets`, `.watchkitapp`,
       `.watchkitextension` or `.extension` are excluded before picking the shortest remaining
       id (`_pick_bundle_id`) — a widget/UI-test target is never the main app.

    Also returns the Android `package` and a `name`, from whichever app dir `app_dirs` ranks
    first after the same subdirectory preference, so the caller gets one coherent answer for
    "the app in this repo" rather than mixing ids from unrelated app folders.
    """
    repo = Path(repo)
    sub = (subdirectory or "").strip("/")
    scan_root = (repo / sub) if sub else repo

    pbxprojs = _pbxprojs(scan_root, max_depth) if scan_root.is_dir() else []
    if not pbxprojs and sub:
        # The chosen subdirectory doesn't exist, or has no Xcode project of its own — fall
        # back to the whole repository rather than reporting nothing.
        pbxprojs = _pbxprojs(repo, max_depth)

    def sort_key(pbx: Path) -> tuple[int, int, str]:
        try:
            rel = pbx.relative_to(repo).as_posix()
        except ValueError:
            rel = str(pbx)
        return (_platform_score(pbx), len(rel), rel)

    pbxprojs.sort(key=sort_key)

    bundle_id: str | None = None
    bundle_id_source: str | None = None
    bundle_id_candidates: list[str] = []
    for pbx in pbxprojs:
        try:
            ids = {m for m in _BUNDLE_RE.findall(pbx.read_text(errors="ignore")) if "$(" not in m}
        except OSError:
            continue
        picked = _pick_bundle_id(ids)
        if picked and picked not in bundle_id_candidates:
            bundle_id_candidates.append(picked)
        if picked and bundle_id is None:
            bundle_id = picked
            try:
                # The .xcodeproj *directory*, not the pbxproj file inside it — "From
                # Sukoon-iOS/sukoon-ios.xcodeproj" is what a developer recognizes; the
                # project.pbxproj filename inside every .xcodeproj adds nothing.
                bundle_id_source = pbx.parent.relative_to(repo).as_posix()
            except ValueError:
                bundle_id_source = str(pbx.parent)

    apps = app_dirs(repo, max_depth=max_depth, follow_symlinks=follow_symlinks)
    ranked_apps = sorted(
        apps,
        key=lambda a: (
            0 if sub and (a.path == sub or a.path.startswith(sub + "/")) else 1,
            0 if "ios" in a.kinds or "mobile" in a.kinds else 1,
            len(a.path),
        ),
    )
    package = next((a.package for a in ranked_apps if a.package), None)
    name = next((a.name for a in ranked_apps if a.name), None)
    if bundle_id is None:
        bundle_id = next((a.bundle_id for a in ranked_apps if a.bundle_id), None)

    return {
        "bundle_id": bundle_id,
        "bundle_id_source": bundle_id_source,
        "bundle_id_candidates": bundle_id_candidates,
        "package": package,
        "name": name,
    }


def _git_config_path(repo: Path) -> Path:
    """The config file of a checkout. A linked worktree or submodule has a `.git` *file*
    (`gitdir: ...`); its config lives in the common git dir that one points at."""
    dot_git = repo / ".git"
    if not dot_git.is_file():
        return dot_git / "config"
    try:
        line = dot_git.read_text(errors="ignore").strip()
    except OSError:
        return dot_git / "config"
    if not line.startswith("gitdir:"):
        return dot_git / "config"
    gitdir = Path(line[len("gitdir:"):].strip())
    if not gitdir.is_absolute():
        gitdir = repo / gitdir
    try:
        common = (gitdir / "commondir").read_text(errors="ignore").strip()
    except OSError:
        return gitdir / "config"
    common_dir = Path(common) if Path(common).is_absolute() else gitdir / common
    return common_dir / "config"


def _remote(repo: Path) -> str | None:
    try:
        text = _git_config_path(repo).read_text()
    except OSError:
        return None
    section = False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("["):
            section = s.startswith('[remote "origin"]')
        elif section and s.startswith("url"):
            _, _, value = s.partition("=")
            return value.strip() or None
    return None


def repo_name(path: Path, levels: int = 4) -> str | None:
    """The name of the repository `path` is in (read-only): its origin remote's name
    (`github.com/acme/shop` is "shop"), else the checkout's own folder name.
    Looks up from `path` at most `levels` folders for the checkout, so a typed app folder
    (`.../integ/web`) is named after its repository, not "web". None outside a checkout."""
    here = path.expanduser()
    for _ in range(levels + 1):
        if (here / ".git").exists():
            remote = _remote(here)
            if remote:
                tail = remote.strip().rstrip("/").replace(":", "/").split("/")[-1]
                tail = tail[:-4] if tail.endswith(".git") else tail
                if tail:
                    return tail
            return here.name or None
        if here.parent == here:
            return None
        here = here.parent
    return None


def inspect(path: str, subdirectory: str | None = None, max_depth: int = 3, *, follow_symlinks: bool = False) -> dict[str, Any] | None:
    """What `POST /api/repos/inspect` returns for a repository path the user just typed, whether
    or not any worker has already published it in its library: the repo-wide best guess
    (`app_ids`, kinds from the union of every app dir found) plus every individual app dir
    (`app_dirs`), so the Repository step can show "Detected: iOS (com.nursoft.sukoon.ios)" and
    the Platforms step can prefill, show "From Sukoon-iOS/sukoon-ios.xcodeproj"
    (`bundle_id_source`), and offer every candidate id (`bundle_id_candidates`) in a combobox
    when more than one pbxproj plausibly supplies the app's id. `None` when `path` is not a
    directory (a git URL, a typo, or a path that only exists on a different worker machine) -
    the caller falls back to whatever the worker library already knows."""
    repo = Path(path).expanduser()
    if not repo.is_dir():
        return None
    apps = app_dirs(repo, max_depth=max_depth, follow_symlinks=follow_symlinks)
    ids = app_ids(repo, subdirectory=subdirectory, max_depth=max_depth, follow_symlinks=follow_symlinks)
    kinds = sorted({k for a in apps for k in a.kinds})
    return {
        "kinds": kinds,
        "bundle_id": ids["bundle_id"],
        "bundle_id_source": ids["bundle_id_source"],
        "bundle_id_candidates": ids["bundle_id_candidates"],
        "package": ids["package"],
        "name": ids["name"],
        "repo_name": repo_name(repo),
        "apps": [asdict(a) for a in apps],
    }
