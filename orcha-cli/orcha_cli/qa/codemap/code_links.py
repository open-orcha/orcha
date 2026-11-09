"""Ways into a native app that its code declares (issue #323, the planned crawl's "ways in"):
deep links, universal links, Android app links and launcher shortcuts, read deterministically,
without a model, a network call or a build.

- **iOS**: the URL schemes of each app's `Info.plist` (`CFBundleURLTypes`; sign-in callback
  schemes such as Google's reversed client id only hand the URL to an SDK and are left out), the
  `applinks:` hosts of its entitlements (`com.apple.developer.associated-domains`), and what its
  URL handlers accept: `.onOpenURL`, `onContinueUserActivity(NSUserActivityTypeBrowsingWeb)`,
  `.handlesExternalEvents`, `application(_:open:)` / `scene(_:openURLContexts:)` and the router
  functions and `init?(url:)` parsers they call (Nyumbani: `.onOpenURL` -> `PushRouter.
  handleUniversalLink` -> `DeepLink(url:)`, which looks for `"property-details"`). The path words
  a handler matches (`url.host == "settings"`, `case "settings"`, `firstIndex(of: "x")`,
  `hasPrefix("/x")`, `contains("x")`) become link templates on each declared scheme and host,
  with the screen the branch opens when it names one (`SettingsView()`). A link the app's own code
  builds (`widgetURL`, a share link: `"https://host/en/property-details/\\(slug)"`) on a declared
  host is the best template there is and wins over a generated one.
- **Android**: each `AndroidManifest.xml` activity's `VIEW` intent filters, as `scheme://host/
  path` templates (`pathPrefix` takes an `{id}` tail, `pathPattern` wildcards are `{id}`);
  `android:autoVerify` https filters are app links. Compose `navDeepLink { uriPattern = ... }`
  inside `composable(route)` names its screen exactly. Static launcher shortcuts
  (`res/xml/shortcuts.xml`) are `intent` ways in: an action, a component and string extras.

Templates use `{name}` for parameters. `fill` puts values in (a locale parameter defaults to
`en`); `match_screen` finds the screen a link's path words name when the code does not say.
Nothing here raises for an odd repo: an unreadable or malformed file is skipped.
"""

from __future__ import annotations

import plistlib
import re
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Any

from orcha_cli.qa.codemap import features as fm
from orcha_cli.qa.codemap.code import close_of, collapse_route, line_at, screen_key

ANDROID_NS = "{http://schemas.android.com/apk/res/android}"
#: Schemes that hand the URL to a sign-in or payment SDK, never to a screen.
OAUTH_SCHEME = re.compile(r"^(?:com\.googleusercontent\.apps\..+|fb\d+.*|msauth\..+|msal[0-9a-f-]+|db-\w+|twitterkit-.+|pdk\d+|vk\d+|tiktok\w+|line3rdp\..+|com\.okta\..+|auth0\..*|appauth.*)$", re.IGNORECASE)
#: Folders never read besides `feature_map`'s own skips (test bundles, result bundles).
SKIP_PARTS = re.compile(r"(?:^|/)(?:[^/]*\.xcresult|test_output|\.build|node_modules|DerivedData|Pods|build)(?:/|$)")
#: Calls a URL handler body makes that are worth following, and how deep.
MAX_HOPS = 3
MAX_BODIES = 40
#: Path words a handler compares the URL against.
_MARKER_PATTERNS = (
    re.compile(r"firstIndex\s*\(\s*of\s*:\s*\"([^\"\\\n]+)\""),
    re.compile(r"\.(?:contains|hasPrefix|hasSuffix|starts\s*\(\s*with)\s*\(\s*\"([^\"\\\n]+)\""),
    re.compile(r"==\s*\"([^\"\\\n]+)\""),
    re.compile(r"\"([^\"\\\n]+)\"\s*=="),
    re.compile(r"\bcase\s+((?:\"[^\"\\\n]+\"\s*,?\s*)+):"),
)
_WORDISH = re.compile(r"^/?[A-Za-z][A-Za-z0-9_\-]*(?:/[A-Za-z0-9_\-]+)*/?$")
_NOT_MARKERS = frozenset({"http", "https", "www", "true", "false", "nil", "null", "url", "id", "en", "sw"})
#: A Swift URL handler: (pattern, kind of URL it receives).
_HANDLERS = (
    re.compile(r"\.onOpenURL\s*(?:\(\s*perform\s*:\s*)?\{"),
    re.compile(r"\.onContinueUserActivity\s*\(\s*NSUserActivityTypeBrowsingWeb[^{]*\{"),
    re.compile(r"\.handlesExternalEvents\s*\("),
    re.compile(r"func\s+application\s*\(\s*_[^)]*\bopen\s+url\s*:[^{]*\{"),
    re.compile(r"func\s+application\s*\(\s*_[^)]*\bcontinue\s+userActivity\s*:[^{]*\{"),
    re.compile(r"func\s+scene\s*\(\s*_[^)]*\b(?:openURLContexts|continue\s+userActivity)\b[^{]*\{"),
)
_FUNC = re.compile(r"\bfunc\s+([a-zA-Z_]\w*)\s*(?:<[^>]*>)?\s*\(")
_TYPE = re.compile(r"\b(?:enum|struct|class|actor|extension)\s+([A-Z]\w*)")
_URL_INIT = re.compile(r"\binit\s*\??\s*\(\s*(?:url|_\s+url|from\s+url)\s*:")
_CALL = re.compile(r"\b([a-zA-Z_]\w*)\s*\(")
_TYPE_URL_CALL = re.compile(r"\b([A-Z]\w*)\s*\(\s*(?:url|from)\s*:")
_VIEW = re.compile(r"\b([A-Z]\w*(?:View|Screen|Destination|Page|ViewController|Sheet))\s*[({]")
#: A URL the code spells, with Swift interpolations (`\(slug)`) and `{x}` placeholders.
_URL_LITERAL = re.compile(r"\b([a-zA-Z][a-zA-Z0-9+.\-]*)://([^\s\"'`<>)\]]*)")
_SWIFT_INTERP = re.compile(r"\\\(((?:[^()]|\([^()]*\))*)\)")
_PARAM = re.compile(r"\{([A-Za-z_]\w*)\}")
_LOCALE_PARAMS = frozenset({"lang", "language", "locale", "lng", "lc"})
_LOCALE = re.compile(r"^[a-z]{2}(?:[-_][A-Za-z]{2,4})?$")
#: Compose.
_COMPOSABLE = re.compile(r"\bcomposable\s*(<\s*([A-Z]\w*)\s*>)?\s*\(")
_URI_PATTERN = re.compile(r"\buriPattern\s*=\s*\"((?:[^\"\\\n]|\\.)*)\"")
_BASE_PATH = re.compile(r"\bnavDeepLink\s*<\s*[A-Z]\w*\s*>\s*\(\s*(?:basePath\s*=\s*)?\"((?:[^\"\\\n]|\\.)*)\"")
_KT_CONST = re.compile(r"\b(?:const\s+)?val\s+(\w+)\s*(?::\s*String)?\s*=\s*\"([^\"$]*)\"")
_KT_OBJECT_ROUTE = re.compile(r"\bobject\s+(\w+)\s*:\s*\w+\s*\(\s*(?:route\s*=\s*)?\"([^\"]*)\"")
_KT_TEMPLATE = re.compile(r"\$\{(\w+)\}|\$(\w+)")
_ROUTE_ARG = re.compile(r"^\s*(?:route\s*=\s*)?(?:\"([^\"]*)\"|((?:[A-Z]\w*\.)*[A-Za-z_]\w*(?:\.\w+)*))")
_GRADLE_ID = re.compile(r"\b(namespace|applicationId)\s*(?:=\s*)?[\"']([\w.]+)[\"']")


@dataclass(frozen=True)
class CodeLink:
    """One way into the app its code declares."""

    platform: str  # ios | android
    kind: str  # scheme | universal | app_link | intent
    uri: str | None  # a template, `{name}` for parameters; None for an intent with no data
    screen_key: str | None  # the screen it opens, when the code says (or a match found it)
    path: str  # repo-relative file it was read from
    line: int
    action: str | None = None  # intent action (shortcuts)
    component: str | None = None  # `package/fully.qualified.Activity`
    extras: tuple[tuple[str, str], ...] = ()
    label: str | None = None  # a shortcut's label, a handler's path word

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"uri": self.uri, "kind": self.kind}
        if self.action:
            out["action"] = self.action
        if self.component:
            out["component"] = self.component
        if self.extras:
            out["extras"] = dict(self.extras)
        if self.label:
            out["label"] = self.label
        return out


# ---------- templates ----------


def params(uri: str | None) -> list[str]:
    return _PARAM.findall(uri or "")


def is_concrete(uri: str | None) -> bool:
    """Whether a link needs no more values (no `{param}` left)."""
    return bool(uri) and not _PARAM.search(uri or "")


def fill(uri: str | None, values: dict[str, Any] | None = None, *, locale: str = "en") -> str | None:
    """The link with its `{param}`s filled from `values` (a locale parameter defaults to
    `locale`), or None when one cannot be filled."""
    if not uri:
        return None
    values = values or {}
    missing = False

    def one(m: re.Match[str]) -> str:
        nonlocal missing
        name = m.group(1)
        v = values.get(name)
        if v is None and name.lower() in _LOCALE_PARAMS:
            v = values.get("locale") or values.get("lang") or locale
        if v is None or str(v) == "":
            missing = True
            return m.group(0)
        return str(v)

    out = _PARAM.sub(one, uri)
    return None if missing else out


def _path_words(uri: str) -> list[list[str]]:
    """The literal path segments of a link, as word lists: hosts that are domains, parameters
    and locale segments left out (a custom scheme's host is a path word: `myapp://settings`)."""
    rest = uri.split("://", 1)[1] if "://" in uri else uri
    rest = rest.split("?", 1)[0].split("#", 1)[0]
    host, _, path = rest.partition("/")
    segs = ([host] if host and "." not in host and not host.startswith("{") else []) + [s for s in path.split("/") if s]
    out = []
    for s in segs:
        if s.startswith("{") or _PARAM.search(s) or _LOCALE.match(s) or s == "*":
            continue
        words = [_stem(w) for w in re.findall(r"[A-Za-z][a-z0-9]*|[A-Z]+(?![a-z])", s.replace("_", "-")) if w]
        words = [w for w in words if w]
        if words:
            out.append(words)
    return out


def _stem(word: str) -> str:
    word = word.lower()
    for suffix in ("ies", "es", "s"):
        if word.endswith(suffix) and len(word) > len(suffix) + 2 and not word.endswith(("ss", "us", "is")):
            return word[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return word


def _key_words(text: str) -> set[str]:
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", str(text or ""))
    return {_stem(w) for w in re.split(r"[^A-Za-z0-9]+", text) if len(w) > 1}


def match_screen(uri: str | None, screens: dict[str, str] | Iterable[str]) -> str | None:
    """The screen a link's path words name (`/{lang}/property-details/{slug}` ->
    `property-detail`, or `/property-details/*` among routed keys), or None. `screens` maps a
    key to its label or code name (or is just the keys). The last literal segment counts most;
    a link with a parameter after it prefers a detail screen."""
    if not uri:
        return None
    names = dict(screens) if isinstance(screens, dict) else {k: "" for k in screens}
    segments = _path_words(uri)
    if not segments or not names:
        return None
    detail_param = bool(re.search(r"/\{[^}]+\}/?$", uri.split("?", 1)[0]))
    best: tuple[float, int, str] | None = None
    for tail in range(len(segments), 0, -1):
        want = {w for seg in segments[tail - 1:tail] for w in seg}
        want_all = {w for seg in segments[:tail] for w in seg}
        for key, name in names.items():
            for words in (_key_words(key), _key_words(name)):
                words = {w for w in words if w not in ("view", "screen", "page", "destination")}
                if not words:
                    continue
                inter = len(want & words)
                if not inter:
                    continue
                score = inter / len(want | words)
                if want <= words or words <= want:
                    score += 0.5
                score += 0.1 * len(want_all & words) / max(1, len(want_all))
                if detail_param:
                    # A record's link (`/orders/{id}`) opens its detail, not the list.
                    score += 0.5 if ("detail" in words or key.endswith("/*")) else -0.25
                cand = (score, -len(key), key)
                if best is None or cand > best:
                    best = cand
        if best is not None and best[0] >= 0.75:
            return best[2]
    return best[2] if best is not None and best[0] >= 0.5 else None


# ---------- reading the repo ----------


class _Files:
    def __init__(self, root: Path, files: list[str] | None, text: Callable[[str], str | None] | None):
        self.root = root
        self.files = [f for f in (files if files is not None else fm._walk(root)[0]) if not SKIP_PARTS.search(f) and "/.claude/" not in f]
        self._text = text
        self._cache: dict[str, str | None] = {}

    def text(self, rel: str) -> str | None:
        if self._text is not None:
            t = self._text(rel)
            if t is not None:
                return t
        if rel in self._cache:
            return self._cache[rel]
        try:
            p = self.root / rel
            out = p.read_text(errors="replace") if p.stat().st_size <= 1024 * 1024 else None
        except OSError:
            out = None
        self._cache[rel] = out
        return out

    def bytes(self, rel: str) -> bytes | None:
        try:
            return (self.root / rel).read_bytes()
        except OSError:
            return None


def _test_source(rel: str) -> bool:
    """A test's source (its links are fixtures, not the app's): a test file name, or a folder
    of tests (`AppTests/`, `src/test/`, `androidTest/`)."""
    name = rel.rsplit("/", 1)[-1]
    parts = rel.split("/")[:-1]
    return bool(fm.TEST_FILE.search(name)) or name.endswith(("Tests.swift", "Test.swift", "Test.kt", "Tests.kt")) or any(
        p.endswith(("Tests", "UITests")) or p in ("test", "androidTest", "testFixtures", "Preview Content") for p in parts)


def _plist(files: _Files, rel: str) -> dict[str, Any] | None:
    raw = files.bytes(rel)
    if not raw:
        return None
    try:
        data = plistlib.loads(raw)
    except Exception:  # noqa: BLE001 - a templated or broken plist
        return None
    return data if isinstance(data, dict) else None


def _common(a: str, b: str) -> int:
    pa, pb = PurePosixPath(a).parts[:-1], PurePosixPath(b).parts[:-1]
    n = 0
    for x, y in zip(pa, pb):
        if x != y:
            break
        n += 1
    return n


@dataclass
class _IosApp:
    """One app's declared ways in: schemes from its Info.plist, hosts from its entitlements."""

    plist: str | None
    schemes: list[tuple[str, int]]
    hosts: list[tuple[str, str, int]]  # (host, entitlements file, line)

    @property
    def anchor(self) -> str:
        return self.plist or (self.hosts[0][1] if self.hosts else "")


def _ios_apps(files: _Files) -> list[_IosApp]:
    plists = [f for f in files.files if f.rsplit("/", 1)[-1] == "Info.plist"]
    ents = [f for f in files.files if f.endswith(".entitlements")]
    apps: list[_IosApp] = []
    for rel in plists:
        data = _plist(files, rel)
        if data is None:
            continue
        text = files.text(rel) or ""
        schemes: list[tuple[str, int]] = []
        for entry in data.get("CFBundleURLTypes") or []:
            for s in (entry.get("CFBundleURLSchemes") or []) if isinstance(entry, dict) else []:
                s = str(s).strip()
                if not s or "$(" in s or OAUTH_SCHEME.match(s):
                    continue
                idx = text.find(f"<string>{s}</string>")
                schemes.append((s, line_at(text, idx) if idx >= 0 else 1))
        apps.append(_IosApp(rel, schemes, []))
    for rel in ents:
        data = _plist(files, rel)
        if data is None:
            continue
        text = files.text(rel) or ""
        hosts = []
        for d in data.get("com.apple.developer.associated-domains") or []:
            d = str(d)
            if not d.startswith("applinks:"):
                continue
            host = d[len("applinks:"):].split("?", 1)[0].strip()
            if host and "$(" not in host:
                idx = text.find(d)
                hosts.append((host, rel, line_at(text, idx) if idx >= 0 else 1))
        if not hosts:
            continue
        # The entitlements belong to the app whose Info.plist is nearest (same target folder).
        home = max(apps, key=lambda a: _common(a.plist or "", rel), default=None)
        if home is not None and home.plist and _common(home.plist, rel) >= max(1, len(PurePosixPath(rel).parts) - 3):
            home.hosts += hosts
        else:
            apps.append(_IosApp(None, [], hosts))
    return [a for a in apps if a.schemes or a.hosts]


def _body(text: str, brace: int) -> str:
    return text[brace + 1: close_of(text, brace)] if 0 <= brace < len(text) and text[brace] in "{(" else ""


class _SwiftIndex:
    """Funcs and `init?(url:)` parsers of one app's Swift files, to follow a handler's calls."""

    def __init__(self, files: _Files, swift: list[str]):
        self.files = files
        self.funcs: dict[str, list[tuple[str, int]]] = {}
        self.url_inits: dict[str, list[tuple[str, int]]] = {}
        for rel in swift:
            text = files.text(rel) or ""
            if "func " in text:
                for m in _FUNC.finditer(text):
                    self.funcs.setdefault(m.group(1), []).append((rel, m.start()))
            if "init" in text and "url" in text:
                for m in _URL_INIT.finditer(text):
                    owner = None
                    for t in _TYPE.finditer(text, 0, m.start()):
                        owner = t.group(1)
                    if owner:
                        self.url_inits.setdefault(owner, []).append((rel, m.start()))

    def body_at(self, rel: str, pos: int) -> str:
        text = self.files.text(rel) or ""
        brace = text.find("{", pos)
        return _body(text, brace) if brace >= 0 else ""


#: Words that say a comparison is about the URL (its host, path or segments), not other data.
_URL_WORDS = re.compile(r"url|host|path|segment|component|link|route|scheme|query", re.IGNORECASE)


def _subject(body: str, at: int) -> str:
    """What the comparison at `at` compares: for a `case`, the subject of its `switch`; else its
    own line."""
    start = body.rfind("\n", 0, at) + 1
    end = body.find("\n", at)
    line = body[start: end if end >= 0 else len(body)]
    if body.startswith("case", at) or re.match(r"\s*case\b", line):
        sw = body.rfind("switch", 0, at)
        if sw < 0:
            return ""
        brace = body.find("{", sw)
        return body[sw: brace if brace >= 0 else sw + 80]
    return line


def _about_url(body: str, at: int) -> bool:
    """Whether the comparison at `at` looks at the URL (its subject names the URL's parts)."""
    return bool(_URL_WORDS.search(_subject(body, at)))


def _markers(body: str) -> list[tuple[str, int]]:
    """(path word, offset) a handler body compares the URL against."""
    out: list[tuple[str, int]] = []
    for regex in _MARKER_PATTERNS:
        for m in regex.finditer(body):
            if not _about_url(body, m.start()):
                continue
            raw = m.group(1)
            values = re.findall(r"\"([^\"\\\n]+)\"", raw) if raw.lstrip().startswith("\"") else [raw]
            for v in values:
                v = v.strip()
                word = v.strip("/")
                if (not word or "." in word or ":" in word or len(word) < 2 or not _WORDISH.match(v)
                        or word.lower() in _NOT_MARKERS or word.isupper()):
                    continue
                out.append((word, m.start()))
    seen: set[str] = set()
    return [(w, i) for w, i in sorted(out, key=lambda x: x[1]) if not (w in seen or seen.add(w))]


def _branch_screen(body: str, at: int) -> str | None:
    """The screen a branch opens: the first View-like type named after the marker, before the
    next `case` or the end of its block."""
    nxt = re.search(r"\bcase\b|\bdefault\s*:|\breturn\b", body[at + 1:])
    window = body[at: at + 1 + (nxt.start() if nxt else 400)]
    m = _VIEW.search(window)
    return screen_key(m.group(1)) if m else None


def _host_compared(body: str, at: int) -> bool:
    """Whether the path word is the URL's host (`myapp://settings`), not a path segment."""
    subject = _subject(body, at)
    return bool(re.search(r"\bhost\b", subject)) and not re.search(r"\bpath", subject)


def _flatten(text: str) -> str:
    """Swift interpolations as `{name}` (`\\(listing.slug)` -> `{slug}`); lines stay where they were."""
    return _SWIFT_INTERP.sub(lambda i: "{" + (re.findall(r"\w+", i.group(1)) or ["value"])[-1] + "}", text)


def _swift_url_templates(text: str) -> list[tuple[str, str, int]]:
    """(scheme, rest, offset) of every URL the Swift text spells, interpolations as `{name}`."""
    out = []
    flat = _flatten(text)
    for m in _URL_LITERAL.finditer(flat):
        rest = m.group(2).split("?", 1)[0].split("#", 1)[0].rstrip(".,;")
        out.append((m.group(1).lower(), rest, m.start()))
    return out


def _ios_links(files: _Files, screens: dict[str, str] | None) -> list[CodeLink]:
    apps = _ios_apps(files)
    if not apps:
        return []
    swift = [f for f in files.files if f.endswith(".swift") and not _test_source(f)]
    by_app: dict[int, list[str]] = {i: [] for i in range(len(apps))}
    for rel in swift:
        best = max(range(len(apps)), key=lambda i: _common(apps[i].anchor, rel))
        # One app in the repo owns every Swift file (its widgets and extensions build its links).
        if len(apps) == 1 or _common(apps[best].anchor, rel) >= 1:
            by_app[best].append(rel)
    links: list[CodeLink] = []
    for i, app in enumerate(apps):
        links += _app_links(files, app, by_app[i], screens)
    return links


def _app_links(files: _Files, app: _IosApp, swift: list[str], screens: dict[str, str] | None) -> list[CodeLink]:
    index = _SwiftIndex(files, swift)
    # The handlers and the functions they reach.
    markers: dict[str, tuple[str, int, str | None, bool, bool]] = {}  # word -> (file, line, screen, host?, param after)
    queue: list[tuple[str, str, int, int]] = []  # (file, body, body offset, depth)
    for rel in swift:
        text = files.text(rel) or ""
        if "URL" not in text and "url" not in text and "handlesExternalEvents" not in text:
            continue
        for regex in _HANDLERS:
            for m in regex.finditer(text):
                brace = m.end() - 1
                if text[brace] not in "{(":
                    continue
                queue.append((rel, _body(text, brace), brace + 1, 0))
    done: set[tuple[str, int]] = set()
    bodies = 0
    while queue and bodies < MAX_BODIES:
        rel, body, offset, depth = queue.pop(0)
        bodies += 1
        text = files.text(rel) or ""
        for word, at in _markers(body):
            if word in markers:
                continue
            after = body[at: at + 160]
            markers[word] = (rel, line_at(text, offset + at), _branch_screen(body, at), _host_compared(body, at), bool(re.search(r"\+\s*1\b", after)))
        if depth >= MAX_HOPS:
            continue
        for m in _TYPE_URL_CALL.finditer(body):
            for frel, pos in index.url_inits.get(m.group(1), []):
                if (frel, pos) not in done:
                    done.add((frel, pos))
                    t = files.text(frel) or ""
                    brace = t.find("{", pos)
                    queue.append((frel, _body(t, brace), brace + 1, depth + 1))
        for m in _CALL.finditer(body):
            name = m.group(1)
            if name[0].isupper() or name in ("if", "guard", "switch", "for", "while", "return", "print", "Task"):
                continue
            for frel, pos in index.funcs.get(name, [])[:3]:
                if (frel, pos) not in done:
                    done.add((frel, pos))
                    t = files.text(frel) or ""
                    brace = t.find("{", pos)
                    queue.append((frel, _body(t, brace), brace + 1, depth + 1))
    schemes = {s.lower() for s, _ in app.schemes}
    hosts = {h.lower() for h, _, _ in app.hosts}
    out: list[CodeLink] = []
    covered: set[str] = set()

    def screen_for(uri: str, named: str | None) -> str | None:
        if named and (screens is None or named in screens):
            return named
        return match_screen(uri, screens) if screens else None

    # Links the app's own code spells, on its own schemes and hosts.
    spelled: list[tuple[str, str, str, int, bool]] = []
    for rel in swift:
        text = files.text(rel) or ""
        if "://" not in text:
            continue
        flat = _flatten(text)  # the offsets `_swift_url_templates` gives are into this
        for scheme, rest, at in _swift_url_templates(text):
            host = rest.split("/", 1)[0].lower()
            own = (scheme in ("https", "http") and host in hosts) or scheme in schemes
            if own and "/" in rest.strip("/"):
                line_start = flat.rfind("\n", 0, at) + 1
                comment = "//" in flat[line_start:at] or flat.rfind("/*", 0, at) > flat.rfind("*/", 0, at)
                spelled.append((scheme, rest, rel, line_at(flat, at), comment))
    # Code before comments, then the most concrete (a locale spelled out beats `{lang}`).
    spelled.sort(key=lambda x: (x[4], len(params(x[1])), x[2], x[3]))
    taken: set[tuple[str, str, tuple[str, ...]]] = set()
    for scheme, rest, rel, line, _comment in spelled:
        uri = f"{scheme}://{rest}"
        words = {w for seg in _path_words(uri) for w in seg}
        hit = [w for w in markers if {_stem(x) for x in re.split(r"[-_/]", w) if x} <= words]
        if markers and not hit:
            continue  # the handlers do not accept it: a plain web link
        host_key = (scheme, rest.split("/", 1)[0].lower(), tuple(hit))
        if uri in {link.uri for link in out} or (hit and host_key in taken):
            continue
        taken.add(host_key)
        kind = "universal" if scheme in ("https", "http") else "scheme"
        named = markers[hit[0]][2] if hit else None
        out.append(CodeLink("ios", kind, uri, screen_for(uri, named), rel, line, label=hit[0] if hit else None))
        covered.update(hit)
    # Generated from the handlers' path words, on every declared scheme and host.
    for word, (rel, line, named, on_host, param) in markers.items():
        if word in covered:
            continue
        tail = "/{id}" if param else ""
        for scheme, _ in app.schemes:
            uri = f"{scheme}://{word}{tail}" if on_host else f"{scheme}:///{word}{tail}"
            out.append(CodeLink("ios", "scheme", uri, screen_for(uri, named), rel, line, label=word))
        for host, _, _ in app.hosts:
            uri = f"https://{host}/{word}{tail}"
            out.append(CodeLink("ios", "universal", uri, screen_for(uri, named), rel, line, label=word))
    # A declared scheme or host with nothing known behind it still opens the app.
    used = {link.uri.split("://", 1)[0].lower() for link in out if link.uri and link.kind == "scheme"}
    used_hosts = {link.uri.split("://", 1)[1].split("/", 1)[0].lower() for link in out if link.uri and link.kind == "universal"}
    for scheme, line in app.schemes:
        if scheme.lower() not in used:
            out.append(CodeLink("ios", "scheme", f"{scheme}://", None, app.plist or "", line))
    for host, rel, line in app.hosts:
        if host.lower() not in used_hosts:
            out.append(CodeLink("ios", "universal", f"https://{host}/", None, rel, line))
    return out


# ---------- Android ----------


def _android_ids(files: _Files, manifest: str, root: ET.Element) -> tuple[str | None, str | None]:
    """(namespace, applicationId) of a manifest's module: the manifest's `package`, else the
    module's Gradle file."""
    namespace = root.get("package")
    app_id = None
    parts = PurePosixPath(manifest).parts
    if "src" in parts:
        module = "/".join(parts[: parts.index("src")])
        for name in ("build.gradle.kts", "build.gradle"):
            text = files.text(f"{module}/{name}" if module else name)
            if not text:
                continue
            for m in _GRADLE_ID.finditer(text):
                if m.group(1) == "namespace":
                    namespace = namespace or m.group(2)
                else:
                    app_id = app_id or m.group(2)
            break
    return namespace, app_id or namespace


def _component(package: str | None, app_id: str | None, name: str | None) -> str | None:
    if not name or "$" in name:
        return None
    fq = (package or "") + name if name.startswith(".") else (name if "." in name else f"{package}.{name}" if package else name)
    owner = app_id or package
    return f"{owner}/{fq}" if owner else None


def _a(el: ET.Element, attr: str) -> str | None:
    v = el.get(ANDROID_NS + attr)
    return v.strip() if v and v.strip() else None


def _pattern_path(data: ET.Element) -> list[str]:
    out = []
    if _a(data, "path"):
        out.append(_a(data, "path") or "")
    if _a(data, "pathPrefix"):
        out.append((_a(data, "pathPrefix") or "").rstrip("/") + "/{id}")
    for attr in ("pathPattern", "pathAdvancedPattern"):
        v = _a(data, attr)
        if v:
            out.append(re.sub(r"(?:\\?\.\*|\.\+|\[[^\]]*\][*+])+", "{id}", v).replace("\\", ""))
    return out


def _manifest_links(files: _Files, rel: str, screens: dict[str, str] | None) -> list[CodeLink]:
    raw = files.text(rel)
    if not raw:
        return []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return []
    package, app_id = _android_ids(files, rel, root)
    app = root.find("application")
    if app is None:
        return []
    activities = app.findall("activity") + app.findall("activity-alias")
    out: list[CodeLink] = []
    for act in activities:
        name = _a(act, "name") or _a(act, "targetActivity")
        component = _component(package, app_id, name)
        launcher = any(_a(c, "name") == "android.intent.category.LAUNCHER" for f in act.findall("intent-filter") for c in f.findall("category"))
        own_key = screen_key(name.rsplit(".", 1)[-1]) if name and not launcher and len(activities) > 1 else None
        for flt in act.findall("intent-filter"):
            actions = {_a(x, "name") for x in flt.findall("action")}
            if "android.intent.action.VIEW" not in actions:
                continue
            datas = flt.findall("data")
            schemes = [s for s in (_a(d, "scheme") for d in datas) if s]
            hosts = [h for h in (_a(d, "host") for d in datas) if h]
            paths = [p for d in datas for p in _pattern_path(d)]
            verified = (_a(flt, "autoVerify") or "").lower() == "true"
            for scheme in dict.fromkeys(schemes):
                if "${" in scheme or OAUTH_SCHEME.match(scheme):
                    continue
                for host in dict.fromkeys(hosts or [""]):
                    if "${" in host:
                        continue
                    for path in dict.fromkeys(paths or [""]):
                        uri = f"{scheme}://{host}{path if not path or path.startswith('/') else '/' + path}"
                        kind = "app_link" if scheme in ("http", "https") and verified else ("scheme" if scheme not in ("http", "https") else "universal")
                        key = own_key or (match_screen(uri, screens) if screens and path else None)
                        needle = (path.split("{", 1)[0].rstrip("/") if path else "") or host or scheme
                        idx = raw.find(f'"{needle}') if needle else -1
                        out.append(CodeLink("android", kind, uri, key, rel, line_at(raw, idx) if idx >= 0 else 1, component=component))
    return out


def _strings(files: _Files, res_dir: str) -> dict[str, str]:
    text = files.text(f"{res_dir}/values/strings.xml") or ""
    return {m.group(1): m.group(2) for m in re.finditer(r"<string\s+name=\"(\w+)\"[^>]*>([^<]*)</string>", text)}


def _shortcut_links(files: _Files, rel: str) -> list[CodeLink]:
    raw = files.text(rel)
    if not raw:
        return []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return []
    res_dir = rel.rsplit("/xml/", 1)[0] if "/xml/" in rel else ""
    strings = _strings(files, res_dir) if res_dir else {}

    def text_of(value: str | None) -> str | None:
        if value and value.startswith("@string/"):
            return strings.get(value[len("@string/"):]) or None
        return value

    out = []
    for sc in root.findall("shortcut"):
        label = text_of(_a(sc, "shortcutShortLabel") or _a(sc, "shortcutLongLabel"))
        for intent in sc.findall("intent"):
            action = _a(intent, "action")
            if not action:
                continue
            pkg, cls = _a(intent, "targetPackage"), _a(intent, "targetClass")
            component = f"{pkg}/{cls}" if pkg and cls else None
            extras = tuple((k, v) for k, v in ((_a(e, "name"), _a(e, "value")) for e in intent.findall("extra")) if k and v is not None)
            data = _a(intent, "data")
            idx = raw.find(_a(sc, "shortcutId") or action)
            out.append(CodeLink("android", "intent", data, None, rel, line_at(raw, idx) if idx >= 0 else 1,
                                action=action, component=component, extras=extras, label=label))
    return out


def _kotlin_consts(files: _Files, kotlin: list[str]) -> dict[str, str]:
    seen: dict[str, set[str]] = {}
    for rel in kotlin:
        text = files.text(rel) or ""
        for regex in (_KT_OBJECT_ROUTE, _KT_CONST):
            for m in regex.finditer(text):
                seen.setdefault(m.group(1), set()).add(m.group(2))
    return {k: next(iter(v)) for k, v in seen.items() if len(v) == 1}


def _kt_string(raw: str, consts: dict[str, str]) -> str | None:
    """A Kotlin string with `$NAME` / `${NAME}` constants in, or None when one is unknown."""
    ok = True

    def one(m: re.Match[str]) -> str:
        nonlocal ok
        name = m.group(1) or m.group(2)
        if name in consts:
            return consts[name]
        ok = False
        return ""

    out = _KT_TEMPLATE.sub(one, raw)
    return out if ok else None


def _route_key(route: str) -> str:
    return collapse_route(route.split("?")[0])


def _compose_links(files: _Files, kotlin: list[str]) -> list[CodeLink]:
    consts: dict[str, str] | None = None
    out = []
    for rel in kotlin:
        text = files.text(rel) or ""
        if "navDeepLink" not in text or "composable" not in text:
            continue
        if consts is None:
            consts = _kotlin_consts(files, kotlin)
        for m in _COMPOSABLE.finditer(text):
            paren = m.end() - 1
            close = close_of(text, paren)
            args = text[paren + 1: close]
            # The trailing content lambda is outside the parens; deep links are inside.
            if "navDeepLink" not in args:
                continue
            if m.group(2):
                key = screen_key(m.group(2))
            else:
                ra = _ROUTE_ARG.match(args)
                route = None
                if ra and ra.group(1) is not None:
                    route = _kt_string(ra.group(1), consts)
                elif ra and ra.group(2):
                    names = [n for n in ra.group(2).split(".") if n not in ("route", "name", "path", "value")]
                    route = next((consts[n] for n in reversed(names) if n in consts), None)
                if not route:
                    continue
                key = _route_key(route)
            for regex in (_URI_PATTERN, _BASE_PATH):
                for d in regex.finditer(args):
                    uri = _kt_string(d.group(1), consts)
                    if not uri or "://" not in uri:
                        continue
                    scheme = uri.split("://", 1)[0].lower()
                    kind = "scheme" if scheme not in ("http", "https") else "app_link"
                    out.append(CodeLink("android", kind, uri, key, rel, line_at(text, paren + 1 + d.start())))
    return out


_NAVIGATE = re.compile(r"\bnavigate\s*\(")
_ROUTE_MEMBERS = frozenset({"route", "createRoute", "name", "path", "invoke", "routeName", "value"})


def _camel_flat(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _intent_screen(files: _Files, kotlin: list[str], consts: dict[str, str], link: CodeLink) -> str | None:
    """The Compose destination a shortcut's intent opens: the `navigate(...)` call whose
    argument carries the intent's extra (`navigate(Screen.LogEntry.createRoute(shortcutEventType))`
    for the `event_type` extra), resolved through the route constants."""
    wanted = {_camel_flat(k) for k, _ in link.extras if k} | {"shortcut"}
    for rel in kotlin:
        text = files.text(rel) or ""
        if "navigate" not in text:
            continue
        for m in _NAVIGATE.finditer(text):
            args = text[m.end(): close_of(text, m.end() - 1)]
            flat = _camel_flat(args)
            if not any(w and w in flat for w in wanted):
                continue
            chain = re.sub(r"\([^()]*\)", "", args)
            names = [n for n in re.findall(r"[A-Za-z_]\w*", chain) if n not in _ROUTE_MEMBERS]
            route = next((consts[n] for n in reversed(names) if n in consts), None)
            if route:
                return _route_key(route)
    return None


def _android_links(files: _Files, screens: dict[str, str] | None) -> list[CodeLink]:
    out: list[CodeLink] = []
    for rel in files.files:
        name = rel.rsplit("/", 1)[-1]
        if name == "AndroidManifest.xml":
            out += _manifest_links(files, rel, screens)
        elif name.endswith(".xml") and "/res/xml/" in f"/{rel}" and "shortcut" in name.lower():
            out += _shortcut_links(files, rel)
    kotlin = [f for f in files.files if f.endswith(".kt") and not _test_source(f)]
    out += _compose_links(files, kotlin)
    if any(link.kind == "intent" and not link.screen_key for link in out):
        consts = _kotlin_consts(files, kotlin)
        out = [replace(link, screen_key=_intent_screen(files, kotlin, consts, link)) if link.kind == "intent" and not link.screen_key else link for link in out]
    if screens:
        out = [link if link.screen_key else replace(link, screen_key=screen_for(link, screens)) for link in out]
    return out


def screen_for(link: CodeLink, screens: dict[str, str] | Iterable[str]) -> str | None:
    """The screen a link opens: the one its code names, else the one its path words name, else
    (a shortcut) the one its label and extras name ("Log Feeding", event_type=feeding ->
    `feeding-log`)."""
    if link.screen_key:
        return link.screen_key
    if link.uri:
        hit = match_screen(link.uri, screens)
        if hit:
            return hit
    if link.kind == "intent" and (link.label or link.extras):
        words = " ".join([link.label or "", *(v for _, v in link.extras)])
        return match_screen("app:///" + "-".join(re.findall(r"[A-Za-z]+", words)), screens)
    return None


# ---------- everything ----------


def extract(
    root: Path | str,
    *,
    files: list[str] | None = None,
    text: Callable[[str], str | None] | None = None,
    screens: dict[str, str] | None = None,
) -> list[CodeLink]:
    """Every way in the code at `root` declares (see the module docstring), deduplicated, in
    file order. `files` / `text` share a caller's walk and reads (`code.extract`); `screens`
    (`{key: label or code name}`) lets links without a named screen meet one by their words."""
    root = Path(root).expanduser()
    if not root.is_dir():
        return []
    walked = _Files(root, files, text)
    links: list[CodeLink] = []
    for reader in (_ios_links, _android_links):
        try:
            links += reader(walked, screens)
        except Exception:  # noqa: BLE001, S112 - an odd repo gives fewer links, never an error
            continue
    seen: set[tuple[Any, ...]] = set()
    out = []
    for link in links:
        ident = (link.platform, link.kind, link.uri, link.action, link.component, link.extras)
        if ident in seen:
            continue
        seen.add(ident)
        out.append(link)
    return out


def by_screen(links: Iterable[CodeLink]) -> dict[str, list[CodeLink]]:
    """The links that name a screen, by its key."""
    out: dict[str, list[CodeLink]] = {}
    for link in links:
        if link.screen_key:
            out.setdefault(link.screen_key, []).append(link)
    return out
