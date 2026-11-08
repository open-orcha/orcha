"""The app map's code source (adapted from `app_map/code.py`): what a repo declares about
its screens, how a user moves between them, the backend calls the app makes or serves and the data
it keeps, read deterministically, without a model, a network call or a build.

`extract(root)` runs `features`' walk and screen scanners, keeping every screen this time (so a
screen's `feature_key` is the key of the feature it lands in), keeps of the SwiftUI views only
those a person navigates to (`code_swift`: the root, a tab, a presented or pushed view; one that
composes a screen folds into it), adds the Compose destinations declared with a route constant
(`composable(Screen.Home.route)`, which the feature scan does not read) and the composables a
bottom sheet shows, then runs the readers:

- `code_nav`: navigation edges (SwiftUI links, sheets and destinations, UIKit pushes, Next and
  Expo routers, `<Link href>`, React Navigation, React Router, Compose `navController.navigate`,
  Android intents, Flutter's navigator, GoRouter, GetX and auto_route calls and tabs,
  `code_dart`), each from the screen whose code makes the call;
- `code_api`: client calls (`fetch`, axios-style clients, `URLSession`, typed Swift endpoints,
  Retrofit, Ktor client, OkHttp, Supabase) and JS server routes (Next route handlers,
  `pages/api`, Express / Fastify / Hono / Koa, NestJS), and the `prisma.<model>` reads and writes
  behind each server route;
- `code_models`: data models (SwiftData `@Model`, Core Data, Room `@Entity`, Prisma `model`,
  Firestore collections, and the columns SQL migrations give a Supabase table) and the reads
  and writes screens make on an on-device store;
- `code_texts`: each native screen's static UI texts, so a live capture with no route meets it;
- `code_links`: the deep links, universal links and shortcuts that open a screen.

Keys: a routed screen (Next, Expo Router, React Router) is its route pattern with ids collapsed
(`/listings/*`), a native one its name without the screen-kind suffix (`ListingDetailView` ->
`listing-detail`), and so is a Flutter one (its named route is kept as `route`); an endpoint is
`METHOD pattern`; an entity its singular, lower-case name. Every fact keeps the repo-relative
file and line it was read from.

A file belongs to a screen when it is the screen's own file, when a screen renders it (a
component, view model or repository it names, up to three hops, unless more than `MAX_SHARED`
screens do), or when it sits beside exactly one screen. The app's shell (`App`, `_layout`,
`ContentView`) and chrome (`Header`, `Footer`, `Sidebar`, ...) belong to none: their links lead
from every screen, which the live map records better. A routed link resolves among the routes of
its own package, so a web app's `/reports` never lands on the mobile app's.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Iterable, Iterator

from orcha_cli.qa.codemap import features as fm
from orcha_cli.qa.codemap.surface import endpoint_pattern, is_id_segment

#: Which screens the code map counts (2: a SwiftUI view only when a person navigates to it).
SCREEN_RULE = 2

#: Most source files read, and the largest one read; a bigger file is generated or vendored.
MAX_SOURCE_READS = 12_000
MAX_SOURCE_BYTES = 512 * 1024
#: A component rendered by more screens than this is app chrome: its links belong to no one
#: screen. Data code (a repository, a store) may serve more screens than a component does.
MAX_SHARED = 6
MAX_SHARED_DATA = 12
#: Hops from a screen's file through the components, view models and stores it names.
MAX_HOPS = 3

JS_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
SOURCE_EXT = (*JS_EXT, ".swift", ".kt", ".java", ".prisma", ".dart")
#: Generated Dart (json_serializable, freezed, auto_route, flutter_gen, mocks): never one screen's code.
DART_GENERATED = (".g.dart", ".freezed.dart", ".gr.dart", ".gen.dart", ".mocks.dart", ".config.dart", ".chopper.dart")
#: Folders read by `feature_map` but never by the code readers: served assets and test sources.
SKIP_PARTS = frozenset({"public", "static", "assets", "androidTest", "testFixtures", "Preview Content", "mocks", "__fixtures__", "scripts", "maestro", "integration_test", "test_driver"})
#: Platforms whose screens are routes (the key is the route pattern).
ROUTERS = frozenset({"next", "pages", "expo", "react-router"})
#: Frameworks whose screens are a web app's.
WEB_FRAMEWORKS = frozenset({"next", "pages", "react-router"})
#: Suffixes that name a native screen's kind, not the screen (`ListingDetailView` -> `listing-detail`).
SCREEN_SUFFIXES = ("view-controller", "controller", "screen", "view", "page", "activity", "fragment", "route", "destination", "bottom-sheet", "sheet")
#: Files that hold the app's shell, never one screen's code.
ROOT_FILES = re.compile(r"^(?:ContentView|RootView|MainView|App|app|_app|_document|_layout|layout|template|MainActivity)\.\w+$|App\.swift$")
#: Components that are the app's chrome on every screen (a header's links lead from anywhere).
CHROME_FILES = re.compile(r"^(?:Site|App|Main|Global|Top|Bottom|Side)?(?:Header|Footer|Nav|Navbar|NavBar|Navigation|Sidebar|SideBar|SideNav|TopBar|BottomBar|TabBar|Menu|Drawer|Layout|Shell)\.\w+$", re.IGNORECASE)

HOLE = "\x00"  # an interpolated expression inside a path, until it becomes `*`


# ---------- what the readers find ----------


@dataclass(frozen=True)
class CodeScreen:
    key: str
    name: str
    route: str | None
    platform: str
    path: str
    line: int
    feature_key: str
    #: What the code calls it: the type (`ListingsView`), the route or the React Navigation name.
    entry: str | None = None


@dataclass(frozen=True)
class CodeNav:
    from_key: str
    to_key: str
    label: str
    path: str
    line: int


@dataclass(frozen=True)
class CodeEndpoint:
    method: str  # upper case, "*" when the code does not say
    pattern: str
    side: str  # client | server
    path: str
    line: int
    handler: str | None


@dataclass(frozen=True)
class CodeEntity:
    key: str
    name: str
    store: str  # swiftdata | coredata | room | prisma | api (a Supabase table or Firestore collection)
    fields: tuple[str, ...]
    path: str
    line: int


@dataclass(frozen=True)
class CodeAccess:
    source: str  # an endpoint key ("GET /rest/v1/listings") or a screen key
    entity_key: str
    mode: str  # reads | writes
    path: str
    line: int


@dataclass(frozen=True)
class CodeFacts:
    screens: tuple[CodeScreen, ...]
    navigation: tuple[CodeNav, ...]
    endpoints: tuple[CodeEndpoint, ...]
    entities: tuple[CodeEntity, ...]
    access: tuple[CodeAccess, ...]
    #: Each native screen's static UI texts (`code_texts`), for meeting live captures.
    texts: tuple[Any, ...] = ()
    #: (screen key, file) for each file that is a screen's code (`Repo.screen_files`).
    files: tuple[tuple[str, str], ...] = ()
    #: The deep links, universal links and shortcuts the app declares (`code_links.CodeLink`).
    links: tuple[Any, ...] = ()
    #: (screen key, endpoint, file, line) for each call made in exactly one screen's code (its own
    #: file, or a view model or repository only that screen renders). Orcha's addition: the original's
    #: code source draws no `calls` edge. A shared API client serves many screens and says none.
    calls: tuple[tuple[str, CodeEndpoint, str, int], ...] = ()
    #: The screens in `screens` that are a twin (`Repo.twins`): the other phone's declaration of a
    #: key the first one holds, so its node's texts are the first one's.
    twins: tuple[CodeScreen, ...] = ()
    #: (folder, kind) of every `package.json` and `pubspec.yaml` in the repo (`_package_kind`, or
    #: `flutter` for a Flutter pubspec), so a JS or Dart fact lands on the platforms its app runs on.
    packages: tuple[tuple[str, str], ...] = ()


# ---------- keys ----------

_PARAM_SEGMENT = re.compile(r"^(?:\[\[?(?:\.\.\.)?[^\]]*\]\]?|:\w+\??|\{[^}]*\}|<[^>]*>|\*+)$")
_JS_INTERP = re.compile(r"\$\{[^}]*\}")
_SWIFT_INTERP = re.compile(r"\\\((?:[^()]|\([^()]*\))*\)")


def collapse_route(path: str) -> str:
    """A route or URL as a pattern: host and query dropped, and every parameter or id segment as
    `*` (`[id]`, `:id`, `{id}`, `${id}`, `\\(id)`, `812`, a uuid), the rule `api_surface` uses
    for traffic. Route groups `(x)` and slots `@x` are dropped. `https://x.test/api/listings/9?a=1`
    and `/api/listings/[id]` are both `/api/listings/*`."""
    raw = _SWIFT_INTERP.sub(HOLE, _JS_INTERP.sub(HOLE, (path or "").strip()))
    if "://" in raw:
        raw = raw.split("://", 1)[1]
        raw = raw[raw.find("/"):] if "/" in raw else "/"
    raw = raw.split("?", 1)[0].split("#", 1)[0]
    parts = [p for p in raw.split("/") if p and not (p.startswith("(") and p.endswith(")")) and not p.startswith("@")]
    segments = []
    for i, seg in enumerate(parts):
        head = seg.split(HOLE, 1)[0]
        if i == len(parts) - 1 and seg == head + HOLE and head[-1:].isalnum():
            segments.append(head)  # `/insights${query}`: the expression is a query suffix
        else:
            segments.append("*" if HOLE in seg or _PARAM_SEGMENT.match(seg) or is_id_segment(seg) else seg)
    return endpoint_pattern("/" + "/".join(segments))


def endpoint_key(method: str, pattern: str) -> str:
    """`GET /api/listings/*`: an endpoint node's key."""
    return f"{(method or '*').strip().upper() or '*'} {collapse_route(pattern)}"


def screen_key(name: str) -> str:
    """A native screen's key: its name in kebab case without the screen-kind suffix
    (`ListingDetailView` -> `listing-detail`, `SettingsScreen` -> `settings`)."""
    key = fm._kebab(name)
    for suffix in SCREEN_SUFFIXES:
        if key.endswith("-" + suffix):
            return key[: -(len(suffix) + 1)]
    return key


def _singular(word: str) -> str:
    if word.endswith(("ss", "us", "is")) or len(word) < 4:
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith(("sses", "xes", "ches", "shes", "zzes")):
        return word[:-2]
    return word[:-1] if word.endswith("s") else word


def entity_key(name: str) -> str:
    """A data model's key: singular, lower case, words joined by `_` (`Listing`, `listings`,
    `listing_table` and `ListingEntity` are all `listing`; `ListingPhoto` is `listing_photo`)."""
    key = fm._kebab(name).replace("-", "_")
    for suffix in ("_table", "_entity", "_model", "_record", "_dto", "_row"):
        if key.endswith(suffix) and len(key) > len(suffix):
            key = key[: -len(suffix)]
            break
    words = key.split("_")
    words[-1] = _singular(words[-1])
    return "_".join(words)


def route_name(route: str) -> str:
    """A routed screen's display name: `/` -> "Home", `/listings/*` -> "Listings detail",
    `/settings/profile` -> "Settings profile"."""
    segs = [s for s in route.strip("/").split("/") if s]
    words = [s for s in segs if s != "*"]
    if not words:
        return "Home" if not segs else "Detail"
    name = fm.feature_name(fm._kebab(" ".join(words)))
    return name + " detail" if segs[-1] == "*" and not name.endswith(("detail", "details")) else name


# ---------- reading source ----------


def line_at(text: str, offset: int) -> int:
    return fm._line(text, offset)


def close_of(text: str, i: int, limit: int = 20_000) -> int:
    """The index of the bracket that closes the one at `text[i]`, skipping strings and comments;
    the end of the window when it never closes."""
    pairs = {"(": ")", "{": "}", "[": "]"}
    stack = [pairs[text[i]]]
    j = i + 1
    end = min(len(text), i + limit)
    while j < end:
        c = text[j]
        if c in "\"'`":
            if text.startswith('"""', j):
                k = text.find('"""', j + 3)
                j = (k + 3) if k >= 0 else end
                continue
            k = j + 1
            while k < end and text[k] != c and (c == "`" or text[k] != "\n"):
                k += 2 if text[k] == "\\" else 1
            if k < end and text[k] == c:
                j = k + 1
            else:
                j += 1  # an apostrophe in prose, not a string
            continue
        if c == "/" and j + 1 < end and text[j + 1] in "/*":
            k = text.find("\n" if text[j + 1] == "/" else "*/", j + 2)
            j = end if k < 0 else k + (1 if text[j + 1] == "/" else 2)
            continue
        if c in pairs:
            stack.append(pairs[c])
        elif stack and c == stack[-1]:
            stack.pop()
            if not stack:
                return j
        j += 1
    return end - 1


def split_args(args: str) -> list[str]:
    """The top-level, comma-separated parts of an argument list or a SQL column list."""
    out, depth, cur = [], 0, []
    quote = ""
    for c in args:
        if quote:
            cur.append(c)
            if c == quote:
                quote = ""
            continue
        if c in "\"'`":
            quote = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            out.append("".join(cur).strip())
            cur = []
            continue
        cur.append(c)
    if "".join(cur).strip():
        out.append("".join(cur).strip())
    return out



_LITERAL = {
    "js": re.compile(r"""\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)"""),
    "swift": re.compile(r'\s*"((?:[^"\\\n]|\\.)*)"'),
    "kotlin": re.compile(r'\s*"((?:[^"\\\n$]|\\.|\$\{[^}]*\}|\$\w*)*)"'),
}
_INTERP = {"js": _JS_INTERP, "swift": _SWIFT_INTERP, "kotlin": re.compile(r"\$\{[^}]*\}|\$[A-Za-z_]\w*")}
_EXPR = re.compile(r"\s*[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\([^()]*\)|\[[^\[\]]*\]|!)*")
_PLUS = re.compile(r"\s*\+")


def lang_of(rel: str) -> str | None:
    if rel.endswith(JS_EXT):
        return "js"
    if rel.endswith(".swift"):
        return "swift"
    if rel.endswith((".kt", ".java")):
        return "kotlin"
    if rel.endswith(".dart"):
        return "dart"
    return None


def string_arg(text: str, pos: int, lang: str, consts: dict[str, str] | None = None) -> str | None:
    """The path a string expression at `pos` spells: literals joined by `+`, interpolations and
    other expressions as holes, a constant (`apiEndpoints.LISTINGS`, `Routes.HOME`) as its value
    when `consts` knows it. A leading expression is a base URL or locale and is dropped
    (`${API_URL}/listings/${id}` -> `/listings/\\0`). None when nothing in it is literal."""
    return string_expr(text, pos, lang, consts)[0]


def string_expr(text: str, pos: int, lang: str, consts: dict[str, str] | None = None) -> tuple[str | None, int]:
    """`string_arg`, and where the expression ends in `text`."""

    def const(expr: str) -> str | None:
        names = re.findall(r"[A-Za-z_$][\w$]*", re.sub(r"\([^()]*\)", "", expr))
        return next((consts[n] for n in reversed(names) if consts and n in consts), None)

    pieces: list[str] = []
    i = end = pos
    for _ in range(8):
        m = _LITERAL[lang].match(text, i)
        if m:
            idx = m.lastindex or 1
            lit = m.group(idx) or ""
            if lang != "js" or idx == 3:
                lit = _INTERP[lang].sub(lambda e: const(e.group(0)) or HOLE, lit)
                if "${" in lit:
                    lit = lit[: lit.index("${")]  # a nested template (`${q ? `?q=${q}` : ""}`): a query
            pieces.append(lit)
        else:
            m = _EXPR.match(text, i)
            if not m:
                break
            value = const(m.group(0))
            pieces.append(value if value is not None else HOLE)
        i = end = m.end()
        plus = _PLUS.match(text, i)
        if not plus:
            break
        i = plus.end()
    joined = "".join(pieces)
    if not joined.replace(HOLE, "").strip():
        return None, end
    based = joined.startswith(HOLE)
    joined = joined.lstrip(HOLE)
    if based and not joined.startswith(("/", "http:", "https:")):
        joined = "/" + joined
    return joined, end


class Source(fm._Reader):
    """The repo's source files, each read once and kept, within `MAX_SOURCE_READS` /
    `MAX_SOURCE_BYTES`. `feature_map`'s scanners share it, so no file is read twice."""

    def __init__(self, root: Path):
        super().__init__(root)
        self._texts: dict[str, str | None] = {}

    def text(self, rel: str) -> str | None:
        if rel in self._texts:
            return self._texts[rel]
        out = None
        if self.reads < MAX_SOURCE_READS:
            try:
                if (self.root / rel).stat().st_size <= MAX_SOURCE_BYTES:
                    self.reads += 1
                    out = (self.root / rel).read_text(errors="replace")
            except OSError:
                out = None
        self._texts[rel] = out
        return out


def _is_source(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1]
    if fm.TEST_FILE.search(name) or name.endswith((".min.js", ".bundle.js", *DART_GENERATED, "_test.dart")):
        return False
    parts = rel.split("/")[:-1]
    if any(p in SKIP_PARTS or p.endswith(("Tests", "UITests")) for p in parts):
        return False
    return name.endswith(SOURCE_EXT) or (name == "contents" and any(p.endswith(".xcdatamodel") for p in parts))


# ---------- the repo and its screens ----------

_DECL = {
    "js": re.compile(r"\b(?:function|class)\s+([A-Z]\w*)|\b(?:const|let|var)\s+([A-Z]\w*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\(|function\b|React\.|memo\b|forwardRef\b|styled\b|observer\b)"),
    "swift": re.compile(r"\b(?:struct|class|actor|enum|protocol)\s+([A-Z]\w*)"),
    "kotlin": re.compile(r"\b(?:fun|class|object|interface)\s+([A-Z]\w*)"),
    # Public names only: a Dart `_Private` class is its own file's, whatever another file calls one.
    "dart": re.compile(r"\b(?:class|mixin|enum|extension)\s+([A-Z]\w*)"),
}
#: The interface a class implements: code that names `EventRepository` reaches `EventRepositoryImpl`.
_SUPERTYPE = {
    "swift": re.compile(r"\b(?:class|struct|actor)\s+\w+\s*:\s*([A-Z]\w*)"),
    "kotlin": re.compile(r"\bclass\s+\w+(?:\s*<[^>]*>)?(?:\s*(?:@\w+\s*)*(?:constructor)?\s*\([^{]*?\))?\s*:\s*([A-Z]\w*)"),
    "dart": re.compile(r"\bclass\s+\w+(?:\s*<[^{]*?>)?\s+(?:extends\s+\w+(?:<[^{]*?>)?\s+)?(?:with\s+[\w\s,<>]+?\s+)?implements\s+([A-Z]\w*)"),
}
_REF = {
    "js": re.compile(r"<([A-Z]\w*)|\b([A-Z]\w*)\s*\("),
    "swift": re.compile(r"\b([A-Z]\w*)\s*[({]|[:<]\s*\[?([A-Z]\w*)"),
    "kotlin": re.compile(r"\b([A-Z]\w*)\s*[({]|[:<]\s*([A-Z]\w*)"),
    "dart": re.compile(r"\b([A-Z]\w*)(?:\s*<[^<>()]*>)?\s*(?:\.\s*\w+\s*)?\(|\b([A-Z]\w*)\s*\.\s*(?:of|read|watch|instance|to)\b"),
}
_COMPOSE_CALL = re.compile(r"\b([A-Z]\w*)\s*\(")


class Repo:
    """What the readers share: the files, their text, the screens by key and which screen(s) a
    file belongs to."""

    def __init__(self, root: Path, files: list[str], source: Source):
        self.root = root
        self.files = files
        self.source = source
        self.screens: dict[str, CodeScreen] = {}
        self._own: dict[str, list[str]] = {}  # file -> keys of the screens it is
        self._reach: dict[str, list[str]] = {}  # file -> keys of the screens that render it
        self._inline: dict[str, list[tuple[int, str]]] = {}  # file -> (line, key) of screens declared in it (Compose, Flutter)
        self._by_dir: dict[str, list[str]] = {}
        self._routes: list[tuple[list[str], str, str]] = []  # (segments, key, package folder)
        self._names: dict[str, str] = {}  # a native screen's type or screen name -> its key
        self._packages: dict[str, str] = {}  # folder -> its package folder
        self._package_dirs: set[str] | None = None
        self._sources: list[str] | None = None
        self._declared: dict[str, list[str]] | None = None
        self.consts: dict[str, dict[str, str]] = {}  # per language: {constant name: string}
        self.cache: dict[str, Any] = {}  # what one reader computes once for the repo
        #: The same screen declared on the other phone under the same key (`AddEntryBottomSheet`
        #: on iOS and Android): no node of its own, its place joins the node's evidence.
        self.twins: list[CodeScreen] = []
        #: Files that are the app's shell (a SwiftUI tab bar, `code_swift`): no one screen's code.
        self.shells: set[str] = set()

    def text(self, rel: str) -> str | None:
        return self.source.text(rel)

    def sources(self, lang: str | None = None) -> Iterator[tuple[str, str]]:
        """(file, text) of every source file, or those in `lang` (js | swift | kotlin)."""
        if self._sources is None:
            self._sources = [rel for rel in self.files if _is_source(rel)]
        for rel in self._sources:
            if lang and lang_of(rel) != lang:
                continue
            text = self.text(rel)
            if text:
                yield rel, text

    # ----- screens -----

    def add_screens(self, screens: list[fm.Screen]) -> None:
        keys = fm.feature_keys(screens)
        owned: dict[str, list[str]] = {}
        for s, feature in zip(screens, keys):
            cs = self._code_screen(s, feature)
            if cs is None:
                continue
            # The first declaration of a key is the node; a second one (the web app's `/expenses`
            # beside the mobile app's) still owns its file and resolves its package's links.
            self._keep(cs)
            # A Flutter screen's named route is the app's own, never a URL another package's links reach.
            if cs.route is not None and cs.platform != "flutter":
                self._routes.append(([p for p in cs.route.strip("/").split("/") if p], cs.key, self.package_of(cs.path)))
            if cs.route is None or cs.platform == "flutter":
                self._names.setdefault(s.entry or "", cs.key)
            for own in self._own_files(s, cs):
                owned.setdefault(own, []).append(cs.key)
            if s.platform in ("compose", "flutter") and s.file:
                # Several widget classes to a Dart file: the call belongs to the one declared above it.
                self._inline.setdefault(s.file, []).append((s.line, cs.key))
        self._own = owned
        for rel, keys_here in owned.items():
            self._by_dir.setdefault(rel.rsplit("/", 1)[0] if "/" in rel else "", []).extend(keys_here)
        self._reach = self._rendered_by(owned)

    def _keep(self, cs: CodeScreen) -> bool:
        """Add a screen unless its key is taken; one the other phone already declared under the
        key is kept as its twin. Whether it became a node."""
        have = self.screens.get(cs.key)
        if have is None:
            self.screens[cs.key] = cs
            return True
        if _surface(have.platform) != _surface(cs.platform):
            self.twins.append(cs)
        return False

    def add_presented(self, screens: list[fm.Screen], sheets: list[fm.Screen] = ()) -> list[str]:
        """Views presented as screens that are not their file's primary type (`code_swift`): screens
        and link targets, owning no file, so the links and calls in that file stay with the screen
        that owns it. Each takes the feature of the screen whose file declares it. `sheets`
        (`code_nav.compose_sheet_screens`, declared at the call that opens them) also own the
        file of the composable they show. Returns the keys added."""
        added: list[str] = []
        # A view named as its file (`QuickNotesSheet.swift`, a `RootView.swift` that is a tab) is
        # that file's screen and owns it; it goes first, so the views beside it take its feature.
        own = [s for s in screens if s.file and s.file.rsplit("/", 1)[-1].split(".")[0] == s.entry and s.file not in self._own]
        for group in (own, [s for s in [*screens, *sheets] if s not in own]):
            owned = False
            for s in group:
                owners = self.screens_of(s.file or "")
                feature = self.screens[owners[0]].feature_key if owners and s not in own else fm.feature_keys([s])[0]
                cs = self._code_screen(s, feature)
                if cs is None:
                    continue
                if self._keep(cs):
                    added.append(cs.key)
                self._names.setdefault(s.entry or "", cs.key)
                files = [s.file] if s in own else [f for f in self.declared().get(s.entry or "", []) if f.endswith(".kt")] if s in sheets else []
                if len(files) == 1 and files[0] != (None if s in own else s.file) and files[0] not in self._own:
                    self._own[files[0]] = [cs.key]
                    self._by_dir.setdefault(files[0].rsplit("/", 1)[0] if "/" in files[0] else "", []).append(cs.key)
                    owned = True
            if owned:
                self._reach = self._rendered_by(self._own)
        return added

    def _code_screen(self, s: fm.Screen, feature: str) -> CodeScreen | None:
        if not s.entry:
            return None
        routed = s.platform in ROUTERS or (s.platform == "compose" and not s.entry[:1].isupper())
        if routed:
            route = collapse_route(s.entry)
            key, name = route, route_name(route)
        elif s.platform == "flutter":
            route, key = getattr(s, "route", None), screen_key(s.entry)
            name = fm.feature_name(key)
        else:
            route, key = None, screen_key(s.entry)
            name = fm.feature_name(key)
        if not key:
            return None
        path, line = s.file or s.path or "", s.line
        if s.platform == "android" and s.path and s.path.endswith((".kt", ".java")):
            # The activity's class is better evidence than its manifest line.
            text = self.text(s.path) or ""
            m = re.search(r"\bclass\s+" + re.escape(s.entry) + r"\b", text)
            path, line = s.path, line_at(text, m.start()) if m else 1
        return CodeScreen(key, name, route, s.platform, path, line, feature, s.entry)

    def _own_files(self, s: fm.Screen, cs: CodeScreen) -> list[str]:
        if (s.platform in ROUTERS and s.platform != "react-router") or s.platform in ("swiftui", "uikit", "flutter"):
            return [s.file] if s.file else []
        if s.platform in ("react-navigation", "android", "react-router"):
            # A React Router route's own code is the component it renders, not the router file.
            return [s.path] if s.path and s.path.endswith((*JS_EXT, ".kt", ".java")) else []
        if s.platform == "compose" and s.file:
            # `composable("listings") { ListingsScreen(...) }`: the screen is the function it calls.
            text = self.text(s.file) or ""
            start = _offset_of_line(text, s.line)
            paren = text.find("(", start)
            close = close_of(text, paren) if paren >= 0 else -1
            brace = text.find("{", close) if close >= 0 else -1
            if brace < 0 or text[close + 1: brace].strip():
                return []
            body = text[brace + 1: close_of(text, brace)]
            for m in _COMPOSE_CALL.finditer(body):
                files = self.declared().get(m.group(1), [])
                if len(files) == 1 and files[0] != s.file:
                    return files
        return []

    def declared(self) -> dict[str, list[str]]:
        """{type or component name: files that declare it}, from every source file."""
        if self._declared is None:
            out: dict[str, set[str]] = {}
            for rel, text in self.sources():
                lang = lang_of(rel)
                if lang is None:
                    continue
                names = set()
                for m in _DECL[lang].finditer(text):
                    names.add(m.group(m.lastindex or 1))
                if lang in _SUPERTYPE:
                    names.update(_SUPERTYPE[lang].findall(text))
                if lang == "js":
                    stem = rel.rsplit("/", 1)[-1].split(".")[0]
                    if stem == "index" and "/" in rel:
                        stem = rel.rsplit("/", 2)[-2]
                    if stem[:1].isupper():
                        names.add(stem)
                for name in names:
                    out.setdefault(name, set()).add(rel)
            self._declared = {k: sorted(v) for k, v in out.items()}
        return self._declared

    def _rendered_by(self, owned: dict[str, list[str]]) -> dict[str, list[str]]:
        declared = {k: v for k, v in self.declared().items() if len(v) <= 3}
        refs: dict[str, set[str]] = {}

        def refs_of(rel: str) -> set[str]:
            if rel not in refs:
                text, lang = self.text(rel) or "", lang_of(rel)
                refs[rel] = {m.group(m.lastindex or 1) for m in _REF[lang].finditer(text)} if lang else set()
            return refs[rel]

        by_key: dict[str, list[str]] = {}
        for rel, keys in owned.items():
            for k in keys:
                by_key.setdefault(k, []).append(rel)
        reach: dict[str, set[str]] = {}
        for key, own in by_key.items():
            seen, frontier = set(own), list(own)
            for _ in range(MAX_HOPS):
                nxt = []
                for rel in frontier:
                    lang = lang_of(rel)
                    for name in refs_of(rel):
                        for other in declared.get(name, ()):
                            # Same language only: an iOS view never renders the Android one.
                            if other in seen or other in owned or lang_of(other) != lang:
                                continue
                            seen.add(other)
                            nxt.append(other)
                            reach.setdefault(other, set()).add(key)
                frontier = nxt
        return {rel: sorted(keys) for rel, keys in reach.items()}

    def screens_of(self, rel: str, line: int | None = None, limit: int = MAX_SHARED) -> tuple[str, ...]:
        """The screen(s) whose code `rel` is: the Flutter screen whose class (or the helper it
        uses) holds `line` (`code_dart.owners`), the screen declared just above `line` in a Compose
        nav graph, the file's own screen, the screens that render it (at most `limit` of them:
        more is shared code), else the one screen beside it (up to two folders up). Empty when
        the file is the app's shell or belongs to no one."""
        if line is not None and rel.endswith(".dart"):
            from orcha_cli.qa.codemap import code_dart

            found = code_dart.owners(self, rel, line)
            if found is not None:
                return found
        if line is not None and rel in self._inline:
            above = [(ln, k) for ln, k in self._inline[rel] if ln <= line]
            if above:
                return (max(above)[1],)
        if rel in self._own:
            return tuple(self._own[rel])
        if rel in self.shells:
            return ()
        name = rel.rsplit("/", 1)[-1]
        if CHROME_FILES.match(name) and limit <= MAX_SHARED:
            return ()
        if rel in self._reach:
            return tuple(self._reach[rel]) if len(self._reach[rel]) <= limit else ()
        if ROOT_FILES.search(name) or rel in self._inline:
            return ()
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        for _ in range(3):
            here = self._by_dir.get(folder)
            if here:
                return (here[0],) if len(set(here)) == 1 else ()
            if not folder:
                break
            folder = folder.rsplit("/", 1)[0] if "/" in folder else ""
        return ()

    def screen_files(self) -> list[tuple[str, str]]:
        """(screen key, file) for every source file `screens_of` gives a screen: its own file,
        the components, view models and stores it renders, and a file beside it. What a change
        to that file reaches (PR impact, `app_map/impact.py`)."""
        if self._sources is None:
            self._sources = [rel for rel in self.files if _is_source(rel)]
        return [(key, rel) for rel in self._sources for key in self.screens_of(rel)]

    def package_of(self, rel: str) -> str:
        """The folder of the nearest `package.json` above `rel` ("" for the repo root), so a web
        app's links resolve to its own routes, not the mobile app's beside it."""
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        if self._package_dirs is None:
            self._package_dirs = {r.rsplit("/", 1)[0] if "/" in r else "" for r in self.files if r.rsplit("/", 1)[-1] == "package.json"}
        if folder not in self._packages:
            here = folder
            while here and here not in self._package_dirs:
                here = here.rsplit("/", 1)[0] if "/" in here else ""
            self._packages[folder] = here
        return self._packages[folder]

    def route_key(self, path: str, from_rel: str | None = None) -> str | None:
        """The declared routed screen a path lands on, among the routes of `from_rel`'s package
        when it has any: the exact pattern, else the most specific route whose `*` segments
        match (`/listings/new` lands on `/listings/new` before `/listings/*`)."""
        pattern = collapse_route(path)
        segs = [p for p in pattern.strip("/").split("/") if p]
        routes = self._routes
        if from_rel is not None:
            package = self.package_of(from_rel)
            routes = [r for r in self._routes if r[2] == package] or self._routes
        best: tuple[int, str] | None = None
        for route_segs, key, _ in routes:
            if len(route_segs) != len(segs) or not all(a == b or a == "*" for a, b in zip(route_segs, segs)):
                continue
            score = sum(a != "*" for a in route_segs)
            if best is None or score > best[0]:
                best = (score, key)
        return best[1] if best else None

    def name_key(self, name: str) -> str | None:
        """The declared native screen a type or screen name is, by its exact name
        (`ListingDetailView(...)`, `navigate("ListingDetail")`, `SettingsActivity::class`)."""
        return self._names.get(name)


def _phone(platform: str) -> str | None:
    """The phone a native framework's screen is on."""
    return "ios" if platform in ("swiftui", "uikit") else "android" if platform in ("android", "compose") else None


def _surface(platform: str) -> str:
    """Where a framework's screens run: one phone, the web, or several (Expo, React Navigation,
    Flutter). Two declarations of one key on different surfaces are twins, so each platform's
    payload still has its own (a web `/listings` beside an Expo `/listings`)."""
    return _phone(platform) or ("web" if platform in WEB_FRAMEWORKS else "cross")


def _offset_of_line(text: str, line: int) -> int:
    offset = 0
    for _ in range(line - 1):
        nxt = text.find("\n", offset)
        if nxt < 0:
            break
        offset = nxt + 1
    return offset


# `extract` keeps one fact per file (the original kept one per repo): the payload is per phone, so the
# iOS call and the Android call to one endpoint both survive until `payload` filters by file.
def _dedupe(items: Iterable, key) -> list:
    seen: set = set()
    out = []
    for item in items:
        k = key(item)
        if k in seen:
            continue
        seen.add(k)
        out.append(item)
    return out


_WEB_DEPS = re.compile(r'"(?:next|react-dom|react-router|react-router-dom|vite|@remix-run/[\w-]+|vue|nuxt|svelte|@sveltejs/kit|@angular/core|gatsby|astro)"\s*:')
_SERVER_DEPS = re.compile(r'"(?:express|fastify|hono|koa|@koa/router|@nestjs/core|@nestjs/common|restify)"\s*:')


def _package_kind(text: str) -> str:
    """What a `package.json` is: `react-native` (it names react-native or expo; `react-native-web`
    when it also runs on the web), `web` (a web app's framework), `server` (a Node server) or
    `other` (a workspace root, a library, a script)."""
    if re.search(r'"(?:react-native|expo)"\s*:', text):
        return "react-native-web" if re.search(r'"react-native-web"\s*:', text) else "react-native"
    if _WEB_DEPS.search(text):
        return "web"
    if _SERVER_DEPS.search(text):
        return "server"
    return "other"


def _packages(files: list[str], source: Source) -> set[tuple[str, str]]:
    out = set()
    for rel in files:
        name = rel.rsplit("/", 1)[-1]
        if name not in ("package.json", "pubspec.yaml") or any(part in SKIP_PARTS for part in rel.split("/")[:-1]):
            continue  # a vendored library under `public/` or `assets/` is no app
        text = source.text(rel) or ""
        if name == "package.json":
            kind = _package_kind(text)
        else:
            kind = "flutter" if re.search(r"^\s+sdk:\s*flutter\b", text, re.MULTILINE) else "other"
        out.add((rel.rsplit("/", 1)[0] if "/" in rel else "", kind))
    return out


def extract(root: Path) -> CodeFacts:
    """Everything the code at `root` says about the app (see the module docstring). Never raises
    for an odd repo: an unreadable file is skipped and a repo with nothing recognisable gives
    empty facts."""
    from orcha_cli.qa.codemap import code_api, code_links, code_models, code_nav, code_swift, code_texts

    root = Path(root).expanduser()
    source = Source(root)
    found = fm.scan_screens(root, reader=source)
    repo = Repo(root, found.files, source)
    # A SwiftUI view is a screen only when a person navigates to it (`code_swift`), as an
    # Android screen is a destination of its nav graph: a view that composes one folds into it.
    swift = code_swift.navigable(repo)
    screens = found.screens if swift is None else [s for s in found.screens if s.platform != "swiftui" or swift.keep(s.entry or "")]
    repo.shells = swift.shell_files if swift is not None else set()
    repo.add_screens(screens + code_nav.compose_constant_screens(repo))
    if swift is None:
        extra = code_texts.presented_swift_screens(repo)
    else:
        extra = swift.screens((s.entry or "" for s in screens if s.platform == "swiftui"), found.files)
    presented = repo.add_presented(extra, code_nav.compose_sheet_screens(repo))

    navigation = code_nav.read(repo)
    if swift is not None:
        # A tab bar is no screen: each of its tabs leads to the others.
        for rel, line, tabs in swift.tabs:
            keys = [k for k in (repo.name_key(t) for t in tabs) if k]
            navigation += [CodeNav(a, b, f"{repo.screens[b].name} tab", rel, line) for a in keys for b in keys if a != b]
    endpoints, api_entities, api_access = code_api.read(repo)
    entities, model_access = code_models.read(repo)

    entities = code_models.with_table_columns(repo, _dedupe(entities + api_entities, key=lambda e: (e.key, e.path)))
    # Ways in: links whose code names no screen meet one of the same platform by their words.
    links = code_links.extract(root, files=found.files, text=source.text)
    by_platform: dict[str, dict[str, str]] = {}
    for sc in repo.screens.values():
        plat = "ios" if sc.platform in ("swiftui", "uikit") else "android" if sc.platform in ("android", "compose") else None
        if plat:
            by_platform.setdefault(plat, {})[sc.key] = sc.name
    native_phones = set(by_platform)
    for sc in repo.screens.values():
        if sc.platform == "flutter":  # a Flutter screen is both phones', less one written natively
            for plat in ("ios", "android"):
                if plat not in native_phones:
                    by_platform.setdefault(plat, {})[sc.key] = sc.name
    # A cross-platform app (Flutter, React Native) may declare its native screens on one platform
    # only: its other platform's links meet those.
    native = {k: v for named in by_platform.values() for k, v in named.items()}
    links = [
        link if link.screen_key else replace(link, screen_key=code_links.screen_for(link, by_platform.get(link.platform) or native))
        for link in links
    ]
    access = _dedupe(api_access + model_access, key=lambda a: (a.source, a.entity_key, a.mode, a.path))
    calls = []
    for e in endpoints:
        if e.side != "client":
            continue
        owners = repo.screens_of(e.path, e.line)
        if len(owners) == 1:
            calls.append((owners[0], e, e.path, e.line))
    # What a person navigates to: no other screen draws its words. Every SwiftUI screen is one
    # when `code_swift` judged them.
    targets = {n.to_key for n in navigation} | set(presented)
    if swift is not None:
        targets |= {k for k, sc in repo.screens.items() if sc.platform == "swiftui"}
    texts = code_texts.screen_texts(repo, targets)
    return CodeFacts(
        screens=tuple(sorted([*repo.screens.values(), *repo.twins], key=lambda s: (s.path, s.line, s.key))),
        navigation=tuple(sorted(_dedupe(navigation, key=lambda n: (n.from_key, n.to_key, n.label, n.path)), key=lambda n: (n.path, n.line, n.to_key))),
        endpoints=tuple(sorted(_dedupe(endpoints, key=lambda e: (e.side, e.method, e.pattern, e.path)), key=lambda e: (e.pattern, e.method, e.side, e.path))),
        entities=tuple(sorted(entities, key=lambda e: e.key)),
        access=tuple(sorted(access, key=lambda a: (a.source, a.entity_key, a.mode))),
        files=tuple(sorted(set(repo.screen_files()))),
        links=tuple(links),
        texts=tuple(sorted(texts, key=lambda t: t.key)),
        twins=tuple(repo.twins),
        packages=tuple(sorted(_packages(found.files, source))),
        calls=tuple(sorted(_dedupe(calls, key=lambda c: (c[0], c[1].method, c[1].pattern, c[2])), key=lambda c: (c[2], c[3], c[0]))),
    )
