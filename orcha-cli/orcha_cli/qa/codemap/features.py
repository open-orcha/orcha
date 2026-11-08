"""An app's features from its code: a deterministic, offline scan of a repo (ported from
`exploration/feature_map.py`).

This module reads the screens a repo declares and groups them into features with human names,
without a model, a network call or a build:

- Next.js app router (`app/**/page.tsx`) and pages router (`pages/**.tsx`, when the package is a
  Next app), grouped by the first meaningful route segment: route groups `(x)`, parallel slots
  `@x` and locale segments (`[locale]`, `[lang]`) are ignored, `api/` is skipped;
- Expo Router (an `app/` folder with a `_layout`), grouped the same way;
- React Router (`<Route path>` elements and `createBrowserRouter` / `useRoutes` route objects,
  nested paths joined; Orcha's addition, the original reads only its navigation calls);
- React Navigation (`<Stack.Screen name="...">`, `{name: '...', component: ...}`);
- Android (`AndroidManifest.xml` activities, Compose `composable("route")`);
- SwiftUI and UIKit (`struct XView: View`, `class XViewController: UIViewController`), grouped
  by their feature folder;
- Flutter (`code_dart`: the widget classes a route builds, named as a screen, or held as a
  screen's tabs), grouped by the folder inside `features/`, `screens/`, `ui/` and the like.

Names are normalised so the screens of one feature land together whatever the platform calls
them: `add-expense`, `expense/[id]`, `ExpenseDetailView` and `/expenses` are all "Expenses";
`login`, `register` and `forgot-password` are "Sign in".

The scan walks the whole repo (so the `apps/*` and `packages/*` of a monorepo are covered),
skipping dependency, build and hidden folders, with a cap on files walked and files read so a
huge repo still answers in well under two seconds.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


#: Folders never walked: dependencies, build output, tests, docs and examples, and every hidden
#: folder (`.git`, `.next`, `.claude`, worktrees, ...).
SKIP_DIRS = frozenset({
    "node_modules", "bower_components", "build", "dist", "out", "Pods", "DerivedData", "coverage",
    "vendor", "target", "venv", "__pycache__", "__tests__", "__mocks__", "__snapshots__", "qa-runs",
    "tmp", "temp", "e2e", "cypress", "playwright", "test", "tests", "spec", "examples", "example",
    "docs", "prototypes", "storybook", "stories", "fixtures", "generated", "intermediates",
    "Carthage", "xcuserdata", "obj", "bin",
})
#: Most files walked; the rest of a giant repo is not looked at (the result says `truncated`).
MAX_FILES = 25_000
#: Most source files opened for a regex scan (React Navigation, Compose, Swift); larger files skipped.
MAX_READS = 2_500
MAX_READ_BYTES = 256 * 1024
#: Most features kept, and most paths recorded per feature.
MAX_FEATURES = 80
MAX_PATHS = 12

JS_EXT = (".tsx", ".jsx", ".ts", ".js")
PAGE_FILE = re.compile(r"^page\.(tsx|jsx|ts|js|mdx|md)$")
LAYOUT_FILE = re.compile(r"^_layout\.(tsx|jsx|ts|js)$")
TEST_FILE = re.compile(r"\.(test|spec|stories|story|e2e)\.[jt]sx?$|\.d\.ts$")
LOCALE_SEGMENTS = frozenset({"[locale]", "[lang]", "[lng]", "[language]", "[languages]", "[country]", "[region]"})

#: Route words that all mean "getting into the app".
AUTH_WORDS = frozenset({
    "login", "log-in", "signin", "sign-in", "signup", "sign-up", "register", "registration",
    "forgot-password", "reset-password", "forgot", "reset", "verify-email", "check-email",
    "auth", "authentication", "logout", "log-out", "sign-out", "signout", "otp", "magic-link",
    "password", "verify", "confirm-email", "accept-invite", "invite",
})
LEGAL_WORDS = frozenset({
    "privacy", "privacy-policy", "terms", "terms-of-service", "terms-and-conditions", "tos",
    "legal", "cookies", "cookie-policy", "imprint", "eula",
})
HOME_WORDS = frozenset({"", "index", "home", "root", "main", "landing", "start"})
#: Verbs in front of a screen name ("add-expense", "EditTripScreen") that name an action on a feature.
VERB_PREFIXES = ("add", "new", "create", "edit", "update", "record", "view", "show", "delete")
#: Suffixes that name the screen kind, not the feature ("ExpenseListView", "trip-detail").
KIND_SUFFIXES = (
    "view-controller", "controller", "screen", "page", "view", "activity", "fragment", "list",
    "details", "detail", "edit", "new", "create", "form", "overview", "index", "route",
    "destination", "tab",
)
#: Folder names that hold screens without naming a feature (Swift grouping walks past them).
GENERIC_FOLDERS = frozenset({
    "views", "view", "screens", "screen", "scenes", "ui", "features", "feature", "modules",
    "sources", "source", "src", "app", "presentation", "pages", "components", "subviews",
    "controllers", "viewcontrollers", "swiftui", "uikit", "main", "core", "shared", "common",
})
#: Folders whose views are building blocks, never features.
COMPONENT_FOLDERS = frozenset({
    "components", "shared", "common", "utilities", "utils", "extensions", "modifiers", "styles",
    "preview content", "helpers", "design", "designsystem", "design-system", "widgets", "cells",
})
SKIP_ACTIVITIES = frozenset({"main", "launcher", "launch", "splash", "base", "dev-settings", "devsettings", ""})

#: Screens that are a state or a piece of chrome, never a feature someone tests: a boot or splash
#: screen, an error or failure state, a notice, a toast, the keyboard shortcuts sheet. A feature
#: key that is one of these, or ends in one ("port-notice", "keyboard-shortcuts"), is no feature.
NON_FEATURE_WORDS = frozenset({
    "boot", "booting", "splash", "launch", "loading", "loader", "spinner", "failed", "failure", "error", "errors",
    "crash", "crashed", "notice", "notices", "toast", "toasts", "banner", "placeholder", "debug", "shortcuts",
    "not-found", "unavailable", "maintenance",
})


def is_non_feature(key: str) -> bool:
    """A state or chrome screen rather than a feature (`NON_FEATURE_WORDS`)."""
    k = (key or "").strip().lower()
    return k in NON_FEATURE_WORDS or k.rsplit("-", 1)[-1] in NON_FEATURE_WORDS


def compact_key(key: str) -> str:
    """A key without its separators, so "GitHub" (`git-hub`) and "Github" (`github`) are one."""
    return re.sub(r"[^a-z0-9]", "", (key or "").lower())


NAME_OVERRIDES = {"sign-in": "Sign in", "legal": "Legal", "home": "Home"}
KIND_ORDER = ("list", "overview", "detail", "new", "edit", "import")

#: Ranks the platforms an entry is taken from when a feature is found in several.
PLATFORM_RANK = {"next": 0, "pages": 1, "react-router": 2, "expo": 3, "react-navigation": 4, "flutter": 5, "android": 6, "compose": 7, "swiftui": 8, "uikit": 9}


@dataclass
class Screen:
    """One route or screen the code declares, before grouping."""

    group: str  # the raw segment or screen name that names its feature
    kind: str  # list | overview | detail | new | edit | import | <sub-page name>
    entry: str | None  # a route ("/expenses/[id]") or a screen name
    path: str | None  # repo-relative file or folder
    platform: str
    file: str | None = None  # the repo-relative file that declares it (the app map's evidence)
    line: int = 1
    route: str | None = None  # a Flutter screen's named route (`/library/category`), when it has one


@dataclass
class Feature:
    """A feature as the scan found it (the `app_features` columns it fills)."""

    key: str
    name: str
    summary: str | None
    entry: str | None
    paths: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"key": self.key, "name": self.name, "summary": self.summary, "entry": self.entry, "paths": list(self.paths)}


@dataclass
class ScanResult:
    features: list[Feature]
    root: str  # the folder scanned
    frameworks: list[str]
    files_seen: int
    truncated: bool
    elapsed_s: float


# ---------- names ----------


def _kebab(text: str) -> str:
    """`ExpenseListView` / `expense_list` / `Expense list` -> `expense-list`."""
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", text.strip())
    text = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1-\2", text)
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return text


def feature_key(raw: str) -> str:
    """The feature a route segment or screen name belongs to, as a slug. Strips the screen kind
    and the action verb so the screens of one feature share a key (`AddExpenseScreen` ->
    `expense`); auth, legal and home words fold into `sign-in`, `legal` and `home`. Plural and
    singular are merged later (`_merge_plurals`), when the scan knows which forms exist."""
    key = _kebab(raw)
    if key in AUTH_WORDS:
        return "sign-in"
    if key in LEGAL_WORDS:
        return "legal"
    if key in HOME_WORDS:
        return "home"
    changed = True
    while changed:
        changed = False
        for suffix in KIND_SUFFIXES:
            if key.endswith("-" + suffix) and len(key) > len(suffix) + 1:
                key = key[: -(len(suffix) + 1)]
                changed = True
        for verb in VERB_PREFIXES:
            if key.startswith(verb + "-") and len(key) > len(verb) + 1:
                key = key[len(verb) + 1:]
                changed = True
    if key in AUTH_WORDS:
        return "sign-in"
    if key in LEGAL_WORDS:
        return "legal"
    if key in HOME_WORDS or key in KIND_SUFFIXES:
        return "home"
    return key


def feature_name(key: str) -> str:
    """`monthly-review` -> "Monthly review"; `sign-in` -> "Sign in"."""
    if key in NAME_OVERRIDES:
        return NAME_OVERRIDES[key]
    words = key.replace("-", " ").strip()
    return words[:1].upper() + words[1:] if words else key


def _singular_variants(key: str) -> list[str]:
    out = []
    if key.endswith("ies") and len(key) > 4:
        out.append(key[:-3] + "y")
    if key.endswith("es") and len(key) > 3:
        out.append(key[:-2])
    if key.endswith("s") and len(key) > 2:
        out.append(key[:-1])
    return out


def _merge_plurals(keys: Iterable[str]) -> dict[str, str]:
    """`{key: canonical}`: a singular form folds into its plural when both exist (`expense` and
    `expenses` -> `expenses`, `category` and `categories` -> `categories`)."""
    present = set(keys)
    mapping = {k: k for k in present}
    for k in sorted(present):
        for single in _singular_variants(k):
            if single in present and single != k:
                mapping[single] = k
    return mapping


def _summary(kinds: list[str]) -> str:
    """"3 screens: list, detail, new" from the kinds of a feature's screens."""
    n = len(kinds)
    unique = sorted(set(kinds), key=lambda k: (KIND_ORDER.index(k) if k in KIND_ORDER else len(KIND_ORDER), k))
    label = f"{n} screen{'s' if n != 1 else ''}"
    if n == 1 and unique in (["overview"], ["list"]):
        return label
    return f"{label}: {', '.join(unique[:6])}"


# ---------- walking ----------


def _walk(root: Path) -> tuple[list[str], bool]:
    """Every file under `root` (posix, relative to it), sorted, skipping `SKIP_DIRS` and hidden
    folders; at most `MAX_FILES` (then `truncated`)."""
    files: list[str] = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS and not d.endswith((".xcassets", ".xcodeproj", ".xcworkspace", ".lproj")))
        rel_dir = os.path.relpath(dirpath, root)
        prefix = "" if rel_dir == "." else rel_dir.replace(os.sep, "/") + "/"
        for name in sorted(filenames):
            files.append(prefix + name)
            if len(files) >= MAX_FILES:
                truncated = True
                return files, truncated
    return files, truncated


def _line(text: str, offset: int) -> int:
    """The 1-based line of `offset` in `text`."""
    return text.count("\n", 0, offset) + 1


class _Reader:
    """Reads source files for the regex scans, within `MAX_READS` / `MAX_READ_BYTES`."""

    def __init__(self, root: Path):
        self.root = root
        self.reads = 0

    def text(self, rel: str) -> str | None:
        if self.reads >= MAX_READS:
            return None
        path = self.root / rel
        try:
            if path.stat().st_size > MAX_READ_BYTES:
                return None
            self.reads += 1
            return path.read_text(errors="replace")
        except OSError:
            return None


# ---------- route-tree frameworks (Next.js, Expo Router, pages router) ----------


def _route_root(parts: list[str], name: str) -> int | None:
    """Index of the first path segment called `name` (the router folder), or None."""
    for i, part in enumerate(parts[:-1]):
        if part == name:
            return i
    return None


def _meaningful(segments: list[str]) -> list[str]:
    """Route segments without groups `(x)`, parallel slots `@x`, intercepts and locale params."""
    out = []
    for seg in segments:
        if not seg or (seg.startswith("(") and seg.endswith(")")) or seg.startswith("@"):
            continue
        if seg.lower() in LOCALE_SEGMENTS:
            continue
        out.append(seg)
    return out


def _is_dynamic(seg: str) -> bool:
    return seg.startswith("[") and seg.endswith("]")


def _route_screen(segments: list[str], platform: str, path_of: Any) -> Screen | None:
    """A route's `Screen`: grouped by its first non-dynamic segment (`/[org]/expenses/[id]` is
    Expenses), `home` when it has none; None for an API route. `path_of(i)` is the repo-relative
    path of the route folder ending at segment index `i` of `segments` (None: use the file)."""
    meaningful = _meaningful(segments)
    if meaningful and meaningful[0].lower() == "api":
        return None
    entry = "/" + "/".join(meaningful)
    group_idx = next((i for i, seg in enumerate(meaningful) if not _is_dynamic(seg)), None)
    if group_idx is None:
        return Screen("home", "detail" if meaningful else "overview", entry, path_of(None), platform)
    group = meaningful[group_idx]
    rest = meaningful[group_idx + 1:]
    raw = _kebab(group)
    if raw.startswith(("edit-", "update-")):
        kind = "edit"  # `edit-trip/[id]` edits a trip, whatever follows
    elif raw.startswith(("add-", "new-", "create-", "record-")):
        kind = "new"
    elif rest:
        if any(_kebab(s) in ("edit", "update") for s in rest):
            kind = "edit"
        elif any(_kebab(s) in ("new", "create", "add") for s in rest):
            kind = "new"
        elif _is_dynamic(rest[-1]):
            kind = "detail"
        else:
            kind = _kebab(rest[-1]).replace("-", " ") or "overview"
    elif raw.endswith("-import") or raw == "import":
        kind = "import"
    else:
        kind = "list" if feature_key(group).endswith("s") else "overview"
    # The folder of the group segment is the feature's code (colocated components included);
    # a top-level file route (`add-expense.tsx`) is just the file.
    seg_index = segments.index(group) if group in segments else None
    return Screen(group, kind, entry, path_of(seg_index), platform)


def _scan_route_trees(files: list[str], base: str, reader: _Reader, frameworks: set[str]) -> list[Screen]:
    screens: list[Screen] = []
    by_root: dict[str, list[list[str]]] = {}
    for rel in files:
        parts = rel.split("/")
        idx = _route_root(parts, "app")
        if idx is None:
            continue
        if any(p in ("__tests__",) or (p.startswith("_") and not LAYOUT_FILE.match(p)) for p in parts[idx + 1:]):
            continue
        by_root.setdefault("/".join(parts[: idx + 1]), []).append(parts[idx + 1:])

    for root, rels in sorted(by_root.items()):
        has_pages = any(PAGE_FILE.match(r[-1]) for r in rels)
        has_layout = any(len(r) >= 1 and LAYOUT_FILE.match(r[-1]) for r in rels)
        if has_pages:
            frameworks.add("next")
            for r in rels:
                if not PAGE_FILE.match(r[-1]):
                    continue
                segments = r[:-1]
                file_path = base + root + "/" + "/".join(r)

                def path_of(i: int | None, segments: list[str] = segments, file_path: str = file_path) -> str:
                    if i is None:
                        return file_path
                    return base + root + "/" + "/".join(segments[: i + 1])

                s = _route_screen(segments, "next", path_of)
                if s:
                    s.file = file_path
                    screens.append(s)
        elif has_layout:
            frameworks.add("expo")
            for r in rels:
                name = r[-1]
                if not name.endswith(JS_EXT) or TEST_FILE.search(name) or name.startswith(("_", "+")):
                    continue
                stem = name.rsplit(".", 1)[0]
                segments = r[:-1] + ([] if stem == "index" else [stem])
                file_path = base + root + "/" + "/".join(r)
                n_dirs = len(r) - 1

                def path_of(i: int | None, segments: list[str] = segments, file_path: str = file_path, n_dirs: int = n_dirs) -> str:
                    if i is None or i >= n_dirs:
                        return file_path
                    return base + root + "/" + "/".join(segments[: i + 1])

                s = _route_screen(segments, "expo", path_of)
                if s:
                    s.file = file_path
                    screens.append(s)
    screens.extend(_scan_pages_router(files, base, reader, frameworks))
    return screens


def _is_next_package(files_set: set[str], pkg_dir: str, reader: _Reader) -> bool:
    prefix = pkg_dir + "/" if pkg_dir else ""
    for cfg in ("next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"):
        if prefix + cfg in files_set:
            return True
    if prefix + "package.json" in files_set:
        text = reader.text(prefix + "package.json") or ""
        return '"next"' in text
    return False


def _scan_pages_router(files: list[str], base: str, reader: _Reader, frameworks: set[str]) -> list[Screen]:
    screens: list[Screen] = []
    files_set = set(files)
    checked: dict[str, bool] = {}
    for rel in files:
        parts = rel.split("/")
        idx = _route_root(parts, "pages")
        if idx is None or not parts[-1].endswith(JS_EXT) or TEST_FILE.search(parts[-1]):
            continue
        root_parts = parts[:idx]
        pkg = "/".join(root_parts[:-1] if root_parts and root_parts[-1] == "src" else root_parts)
        if pkg not in checked:
            checked[pkg] = _is_next_package(files_set, pkg, reader)
        if not checked[pkg]:
            continue
        route = parts[idx + 1:]
        stem = route[-1].rsplit(".", 1)[0]
        if stem.startswith("_") or stem in ("404", "500") or any(p.startswith("_") for p in route[:-1]):
            continue
        segments = route[:-1] + ([] if stem == "index" else [stem])
        file_path = base + rel
        n_dirs = len(route) - 1
        root = "/".join(parts[: idx + 1])

        def path_of(i: int | None, segments: list[str] = segments, file_path: str = file_path, n_dirs: int = n_dirs, root: str = root) -> str:
            if i is None or i >= n_dirs:
                return file_path
            return base + root + "/" + "/".join(segments[: i + 1])

        s = _route_screen(segments, "pages", path_of)
        if s:
            s.file = file_path
            frameworks.add("next")
            screens.append(s)
    return screens


# ---------- React Navigation ----------

NAV_FILE = re.compile(r"(navigat|router|routes|stack|tabs|drawer)", re.IGNORECASE)
RN_SCREEN_TAG = re.compile(r"<\s*[\w.]+\.Screen\b([^>]*?)/?>", re.DOTALL)
RN_NAME_ATTR = re.compile(r"\bname\s*=\s*\{?\s*[\"'`]([^\"'`]+)[\"'`]")
RN_COMPONENT_ATTR = re.compile(r"\bcomponent\s*=\s*\{\s*([A-Za-z_]\w*)")
RN_CONFIG = re.compile(r"\{\s*name\s*:\s*[\"'`]([^\"'`]+)[\"'`]\s*,\s*component\s*:\s*([A-Za-z_]\w*)")


def _scan_react_navigation(files: list[str], base: str, reader: _Reader, frameworks: set[str], stems: dict[str, str]) -> list[Screen]:
    screens: list[Screen] = []
    for rel in files:
        name = rel.rsplit("/", 1)[-1]
        if not name.endswith(JS_EXT) or TEST_FILE.search(name):
            continue
        parent = rel.rsplit("/", 2)[-2] if "/" in rel else ""
        if not (NAV_FILE.search(name) or NAV_FILE.search(parent) or name.split(".")[0] in ("App", "app")):
            continue
        if "/app/" in "/" + rel and LAYOUT_FILE.match(name):
            continue
        text = reader.text(rel)
        if not text or ("@react-navigation" not in text and ".Screen" not in text):
            continue
        found: list[tuple[str, str | None, int]] = []
        for m in RN_SCREEN_TAG.finditer(text):
            attrs = m.group(1)
            nm = RN_NAME_ATTR.search(attrs)
            if nm:
                comp = RN_COMPONENT_ATTR.search(attrs)
                found.append((nm.group(1), comp.group(1) if comp else None, m.start()))
        for m in RN_CONFIG.finditer(text):
            found.append((m.group(1), m.group(2), m.start()))
        if found:
            frameworks.add("react-navigation")
        for screen_name, component, at in found:
            path = stems.get(component) if component else None
            raw = _kebab(screen_name)
            kind = "detail" if raw.endswith(("-detail", "-details")) else "new" if raw.startswith(("add-", "new-", "create-")) else "edit" if raw.startswith("edit-") else "list" if raw.endswith("-list") else "overview"
            screens.append(Screen(screen_name, kind, screen_name, base + path if path else None, "react-navigation", base + rel, _line(text, at)))
    return screens


# ---------- React Router ----------

RR_IMPORT = re.compile(r"""["'](?:react-router-dom|react-router)["']""")
RR_MARKER = re.compile(r"\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes|createRoutesFromElements|RouteObject)\b|<Route\b")
RR_TAG = re.compile(r"<Route\b")
RR_TAG_CLOSE = re.compile(r"</Route\s*>")
RR_PATH_ATTR = re.compile(r"\bpath\s*=\s*\{?\s*[\"'`]([^\"'`]*)[\"'`]")
RR_INDEX_ATTR = re.compile(r"(?<![\w-])index(?:\s*=\s*\{\s*true\s*\})?(?=[\s/>])")
RR_OBJ_PATH = re.compile(r"\bpath\s*:\s*[\"'`]([^\"'`]*)[\"'`]")
RR_OBJ_INDEX = re.compile(r"\bindex\s*:\s*true\b")
RR_OBJ_ROUTE = re.compile(r"\b(?:element|Component|children|lazy|loader)\s*:")
RR_COMPONENT = re.compile(r"\belement\s*[=:]\s*\{?\s*<\s*([A-Z]\w*)|\b(?:Component|component)\s*[=:]\s*\{?\s*([A-Z]\w*)")


def _js_spans(text: str) -> list[tuple[int, int]]:
    """(open, close) of every `{ ... }` in a JS/TS file, strings and comments skipped."""
    spans: list[tuple[int, int]] = []
    stack: list[int] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] in "/*":
            k = text.find("\n" if text[i + 1] == "/" else "*/", i + 2)
            i = n if k < 0 else k + (1 if text[i + 1] == "/" else 2)
            continue
        if c in "\"'`":
            k = i + 1
            while k < n and text[k] != c and (c == "`" or text[k] != "\n"):
                k += 2 if text[k] == "\\" else 1
            i = k + 1
            continue
        if c == "{":
            stack.append(i)
        elif c == "}" and stack:
            spans.append((stack.pop(), i))
        i += 1
    return spans


def _rr_join(parent: str, child: str) -> str:
    if child.startswith("/"):
        return child
    return parent.rstrip("/") + "/" + child if child else parent


def _rr_tag_end(text: str, i: int) -> tuple[int, bool]:
    """Where the opening `<Route ...` tag that starts before `i` ends, and whether it closes itself
    (`/>`); a `>` inside an attribute's `{ ... }` (`element={<Home />}`) is no end."""
    depth, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in "\"'`" and depth == 0:
            k = text.find(c, i + 1)
            i = n if k < 0 else k + 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif depth <= 0 and c == ">":
            return i, text[i - 1] == "/"
        i += 1
    return n, True


def _react_router_routes(text: str) -> list[tuple[str, int, str | None]]:
    """(full path, offset, component) of each route a React Router file declares: `<Route path>`
    elements (nested ones join their parent's path) and route objects (`{ path, element }` in
    `createBrowserRouter([...])`, `useRoutes`, a `RouteObject[]`), index routes as their parent's."""
    out: list[tuple[str, int, str | None]] = []
    # JSX: the open `<Route>` elements, each with the span up to its `</Route>`.
    tags = []
    for m in RR_TAG.finditer(text):
        end, closed = _rr_tag_end(text, m.end())
        tags.append((m.start(), end, closed, text[m.end(): end]))
    spans: list[tuple[int, int]] = []
    opens = [t for t in tags if not t[2]]
    closes = [m.start() for m in RR_TAG_CLOSE.finditer(text)]
    events = sorted([(t[0], "open", t) for t in opens] + [(c, "close", None) for c in closes], key=lambda e: e[0])
    stack: list[int] = []
    for at, kind, _t in events:
        if kind == "open":
            stack.append(at)
        elif stack:
            spans.append((stack.pop(), at))
    paths: dict[int, str | None] = {}
    for start, _end, _closed, attrs in tags:
        p = RR_PATH_ATTR.search(attrs)
        paths[start] = p.group(1) if p else None
    for start, _end, _closed, attrs in tags:
        parents = sorted(s for s, e in spans if s < start < e)
        full = "/"
        for s in parents:
            if paths.get(s) is not None:
                full = _rr_join(full, paths[s] or "")
        own = paths[start]
        if own is None and not RR_INDEX_ATTR.search(attrs):
            continue  # a layout route: its children carry the paths
        full = _rr_join(full, own or "")
        comp = RR_COMPONENT.search(attrs)
        out.append((full, start, (comp.group(1) or comp.group(2)) if comp else None))
    # Route objects.
    if "path" in text and RR_OBJ_ROUTE.search(text):
        objs = _js_spans(text)
        route_of: dict[tuple[int, int], tuple[str | None, int, str | None]] = {}
        for o in objs:
            body = text[o[0]: o[1] + 1]
            inner = [x for x in objs if o[0] < x[0] and x[1] < o[1]]

            def own(regex: re.Pattern[str], body: str = body, o: tuple[int, int] = o, inner: list = inner) -> re.Match[str] | None:
                for m in regex.finditer(body):
                    if not any(x[0] <= o[0] + m.start() <= x[1] for x in inner):
                        return m
                return None

            if not own(RR_OBJ_ROUTE):
                continue
            p = own(RR_OBJ_PATH)
            idx = own(RR_OBJ_INDEX)
            comp = own(RR_COMPONENT)
            if p is None and idx is None:
                route_of[o] = (None, o[0], None)  # a layout route
                continue
            route_of[o] = (p.group(1) if p else "", o[0] + (p.start() if p else idx.start()), (comp.group(1) or comp.group(2)) if comp else None)
        for o, (path, at, comp) in route_of.items():
            if path is None:
                continue
            full = "/"
            for parent in sorted((x for x in route_of if x[0] < o[0] and o[1] < x[1]), key=lambda x: x[0]):
                if route_of[parent][0]:
                    full = _rr_join(full, route_of[parent][0])
            out.append((_rr_join(full, path), at, comp))
    return sorted(out, key=lambda r: r[1])


def _scan_react_router(files: list[str], base: str, reader: _Reader, frameworks: set[str], stems: dict[str, str]) -> list[Screen]:
    """React Router screens (`<Route path>` elements and route objects), keyed by their route."""
    screens: list[Screen] = []
    for rel in files:
        name = rel.rsplit("/", 1)[-1]
        if not name.endswith(JS_EXT) or TEST_FILE.search(name):
            continue
        text = reader.text(rel)
        if not text or not RR_IMPORT.search(text) or not RR_MARKER.search(text):
            continue
        for full, at, comp in _react_router_routes(text):
            segs = [s for s in full.split("/") if s]
            if segs and segs[-1] == "*" and len(segs) == 1:
                continue  # the not-found catch-all
            segments = ["[" + s[1:].rstrip("?") + "]" if s.startswith(":") else "[...]" if s == "*" else s for s in segs]
            path = stems.get(comp) if comp else None
            s = _route_screen(segments, "react-router", lambda i, path=path: base + path if path else None)
            if s:
                s.file, s.line = base + rel, _line(text, at)
                frameworks.add("react-router")
                screens.append(s)
    return screens


# ---------- Android ----------

MANIFEST_PACKAGE = re.compile(r"<manifest\b[^>]*?\bpackage\s*=\s*\"([^\"]+)\"", re.DOTALL)
ACTIVITY = re.compile(r"<activity\b[^>]*?android:name\s*=\s*\"([^\"]+)\"", re.DOTALL)
#: A destination of a Compose nav graph: a screen, a dialog or a bottom sheet the graph opens.
COMPOSE_ROUTE = re.compile(r"\b(?:composable|dialog|bottomSheet)\s*\(\s*(?:route\s*=\s*)?\"([^\"]+)\"")
COMPOSE_TYPED = re.compile(r"\b(?:composable|dialog|bottomSheet)\s*<\s*([A-Za-z_][\w.]*)\s*>")


def _scan_android(files: list[str], base: str, reader: _Reader, frameworks: set[str], stems: dict[str, str]) -> list[Screen]:
    screens: list[Screen] = []
    for rel in files:
        name = rel.rsplit("/", 1)[-1]
        if name == "AndroidManifest.xml":
            text = reader.text(rel) or ""
            pkg = MANIFEST_PACKAGE.search(text)
            for m in ACTIVITY.finditer(text):
                full = m.group(1)
                short = full.rsplit(".", 1)[-1]
                path = stems.get(short)
                # The app's own activities only: a library's (`com.yalantis.ucrop.UCropActivity`)
                # is named in full and has no source file here.
                own = full.startswith(".") or "." not in full or (pkg is not None and full.startswith(pkg.group(1) + ".")) or path is not None
                if not own:
                    continue
                stem = short[: -len("Activity")] if short.endswith("Activity") else short
                if _kebab(stem) in SKIP_ACTIVITIES:
                    continue
                frameworks.add("android")
                screens.append(Screen(stem, "overview", short, base + path if path else None, "android", base + rel, _line(text, m.start())))
        elif name.endswith(".kt"):
            text = reader.text(rel)
            if not text or "composable" not in text:
                continue
            for m in COMPOSE_ROUTE.finditer(text):
                route = m.group(1).split("?")[0]
                segs = [s for s in route.split("/") if s]
                group = next((s for s in segs if not s.startswith("{")), "")
                kind = "detail" if any(s.startswith("{") for s in segs) else "overview"
                frameworks.add("compose")
                screens.append(Screen(group or "home", kind, route, base + rel, "compose", base + rel, _line(text, m.start())))
            for m in COMPOSE_TYPED.finditer(text):
                cls = m.group(1).rsplit(".", 1)[-1]
                frameworks.add("compose")
                screens.append(Screen(cls, "overview", cls, base + rel, "compose", base + rel, _line(text, m.start())))
    return screens


# ---------- SwiftUI / UIKit ----------

SWIFTUI_VIEW = re.compile(r"\bstruct\s+([A-Z]\w*?(?:View|Screen))\s*:\s*(?:[\w.]+\s*,\s*)*View\b")
UIKIT_VC = re.compile(r"\bclass\s+([A-Z]\w*?ViewController)\s*:\s*UI\w*Controller\b")
APP_MARKERS = ("Info.plist", "AppDelegate.swift", "SceneDelegate.swift")


def _app_dirs(files: list[str]) -> set[str]:
    """Folders that are an app target (they hold Info.plist, AppDelegate or a `*App.swift`),
    which are never a feature."""
    out = set()
    for rel in files:
        name = rel.rsplit("/", 1)[-1]
        if name in APP_MARKERS or (name.endswith("App.swift") and name != "App.swift") or name == "App.swift":
            out.add(rel.rsplit("/", 1)[0] if "/" in rel else "")
    return out


def _swift_group(rel: str, view: str, app_dirs: set[str]) -> tuple[str, str | None]:
    """The feature folder of a Swift view and its path: the nearest enclosing folder that is not
    generic (`Views`, `Screens`, ...) nor an app target; the view's own name (and no folder)
    when there is none."""
    parts = rel.split("/")[:-1]
    for depth in range(len(parts), 0, -1):
        folder = parts[depth - 1]
        here = "/".join(parts[:depth])
        if here in app_dirs or depth == 1 and not app_dirs:
            break
        if folder.lower() in GENERIC_FOLDERS:
            continue
        if feature_key(folder) == "home" and _kebab(folder) not in HOME_WORDS:
            continue  # `Edit`, `List`, `Detail`: a screen kind, the feature is further up
        return folder, here
    return view, None


def _scan_swift(files: list[str], base: str, reader: _Reader, frameworks: set[str]) -> list[Screen]:
    screens: list[Screen] = []
    app_dirs = _app_dirs(files)
    for rel in files:
        if not rel.endswith(".swift") or "Tests" in rel or "Preview" in rel.rsplit("/", 1)[-1]:
            continue
        if any(p.lower() in COMPONENT_FOLDERS for p in rel.split("/")[:-1]):
            continue
        stem = rel.rsplit("/", 1)[-1][: -len(".swift")]
        text = reader.text(rel)
        if not text:
            continue
        for regex, platform in ((SWIFTUI_VIEW, "swiftui"), (UIKIT_VC, "uikit")):
            # The file's primary type only: the helper views beside it are building blocks.
            match = next((m for m in regex.finditer(text) if m.group(1) == stem), None)
            primary = match.group(1) if match else None
            if match is None or primary in ("ContentView", "RootView", "MainView"):
                continue
            frameworks.add(platform)
            group, folder = _swift_group(rel, primary, app_dirs)
            raw = _kebab(primary)
            kind = (
                "detail" if "-detail" in raw else "new" if raw.startswith(("add-", "new-", "create-")) else
                "edit" if raw.startswith("edit-") or "-edit" in raw else "list" if "-list" in raw else "overview"
            )
            path = base + (folder or rel)
            screens.append(Screen(group, kind, primary, path, platform, base + rel, _line(text, match.start())))
    return screens


# ---------- grouping ----------


def feature_keys(screens: list[Screen]) -> list[str]:
    """The feature key of each screen ("" when it has none), with plurals merged across the
    whole scan, so a screen's key is the `app_features` key of the feature it lands in."""
    keys = [feature_key(s.group) for s in screens]
    canonical = _merge_plurals(k for k in keys if k)
    return [canonical[k] if k else "" for k in keys]


def _group(screens: list[Screen]) -> list[Feature]:
    """The features the screens make. A state or chrome screen (`is_non_feature`: boot, a failure
    state, a notice) stays on the app map but is no feature, and keys that differ only in their
    separators are one feature."""
    groups: dict[str, list[Screen]] = {}
    by_compact: dict[str, str] = {}
    for k, s in zip(feature_keys(screens), screens):
        if k and not is_non_feature(k):
            k = by_compact.setdefault(compact_key(k), k)
            groups.setdefault(k, []).append(s)
    features = []
    for key, members in groups.items():
        entries = [s for s in members if s.entry]
        entry = None
        if entries:
            stem = key.rstrip("s").replace("-", "")

            def rank(s: Screen) -> tuple[Any, ...]:
                text = s.entry or ""
                # A route without parameters first, then the platform order, then one that
                # names the feature (ProfileView over FaqsView in Profile/), then its list.
                kind = {"list": 0, "overview": 1}.get(s.kind, 2)  # the list, not the add form
                return ("[" in text or "{" in text, PLATFORM_RANK.get(s.platform, 9), stem not in text.lower().replace("-", ""), kind, len(text), text)

            entry = min(entries, key=rank).entry
        paths = sorted({s.path for s in members if s.path})
        # A folder already covers the files inside it.
        paths = [p for p in paths if not any(p != q and p.startswith(q + "/") for q in paths)]
        features.append(Feature(key, feature_name(key), _summary([s.kind for s in members]), entry, paths[:MAX_PATHS]))
    features.sort(key=lambda f: (-len(f.paths), f.key))
    features = features[:MAX_FEATURES]
    features.sort(key=lambda f: (f.key != "home", f.name.lower(), f.key))
    return features


@dataclass
class ScreenScan:
    """Every screen a scan found, before grouping (the app map keeps each one)."""

    screens: list[Screen]
    root: Path  # the folder scanned
    base: str  # its path relative to the repo, "" or ending in "/"
    files: list[str]  # every file walked, relative to `root`
    frameworks: set[str]
    truncated: bool


def scan_screens(repo_dir: Path | str, subdir: str | None = None, reader: _Reader | None = None) -> ScreenScan:
    """The routes and screens `repo_dir` (or its `subdir`) declares, ungrouped. `reader` lets a
    caller share its own (cached, larger) reader with the scan."""
    repo = Path(repo_dir).expanduser()
    sub = str(subdir or "").strip().strip("/")
    root = repo / sub if sub and (repo / sub).is_dir() else repo
    base = "" if root == repo else str(PurePosixPath(*Path(os.path.relpath(root, repo)).parts)) + "/"
    files, truncated = _walk(root)
    reader = reader or _Reader(root)
    frameworks: set[str] = set()
    stems: dict[str, str] = {}
    for rel in files:
        name = rel.rsplit("/", 1)[-1]
        if name.endswith((*JS_EXT, ".kt", ".java")) and not TEST_FILE.search(name):
            stems.setdefault(name.rsplit(".", 1)[0], rel)
    screens = _scan_route_trees(files, base, reader, frameworks)
    screens += _scan_react_navigation(files, base, reader, frameworks, stems)
    screens += _scan_react_router(files, base, reader, frameworks, stems)
    screens += _scan_android(files, base, reader, frameworks, stems)
    screens += _scan_swift(files, base, reader, frameworks)
    from orcha_cli.qa.codemap import code_dart  # Flutter: a reader of its own, shared with the app map

    screens += code_dart.scan_screens(files, base, reader, frameworks)
    return ScreenScan(screens, root, base, files, frameworks, truncated)


def scan(repo_dir: Path | str, subdir: str | None = None) -> ScanResult:
    """Scan `repo_dir` (or its `subdir`) for features. Paths in the result are relative to
    `repo_dir`, so they match `git log` run there. Never raises for an odd repo: an unreadable
    folder is skipped and an app with no recognisable routes yields no features."""
    started = time.monotonic()
    found = scan_screens(repo_dir, subdir)
    return ScanResult(
        features=_group(found.screens),
        root=str(found.root),
        frameworks=sorted(found.frameworks, key=lambda f: PLATFORM_RANK.get(f, 9)),
        files_seen=len(found.files),
        truncated=found.truncated,
        elapsed_s=round(time.monotonic() - started, 3),
    )
