"""Flutter apps for the app map (docs/app-map.md, "How it is built", step 1): the screens a Dart
app declares, its routes, the moves between screens and the words each screen shows, read
deterministically, without a model, the Dart SDK or a build.

A Flutter screen is a widget class (one that extends `StatelessWidget`, `StatefulWidget`,
Riverpod's `ConsumerWidget`, a hook or GetX widget, or another widget class of the app) that is
in the `lib/` folder of a Flutter package (a `pubspec.yaml` naming the flutter SDK) and is:

- the widget a route builds: a `case Routes.x:` of an `onGenerateRoute` switch (or a switch
  expression's arm), an entry of `MaterialApp(routes: {...})`, a `GoRoute(path:, builder: /
  pageBuilder:)` (nested `routes:` join their paths), a GetX `GetPage(name:, page:)`, an
  auto_route `AutoRoute(page: XRoute.page, path:)` or a `@RoutePage()` class, or a `static
  Route route(...)` on the screen itself;
- the widget a `MaterialPageRoute` / `CupertinoPageRoute` / `PageTransition` / `MaterialPage`
  builds, or one `Get.to(() => X())` opens;
- named as a screen (`...Screen`, `...Page`, a `...View` in a view folder);
- or one of the tabs a screen holds (a list of two or more widgets in a screen's class, one of
  them a screen or each named like one: `const _tabs = [HomeTab(), LibraryTab(), ...]`).

A screen's key is its class name without the kind suffix (`LibraryCategoryScreen` ->
`library-category`), as for SwiftUI and Compose: a Flutter app's named routes (`/library/
category`) are not URLs a capture has, and a web app beside it may declare the same paths. The
route is kept on the screen (`route`). The framework is `flutter`, a screen on both phones
(`atlas.BOTH_PHONES`).

Navigation (`nav`): `Navigator.pushNamed(context, Routes.x)` and the other `...Named` calls on a
navigator, `Navigator.push(..., MaterialPageRoute(builder: (_) => X()))`, GoRouter's
`context.go/push('/path')` and `goNamed/pushNamed('name')`, GetX `Get.to(() => X())` /
`Get.toNamed('/x')`, auto_route `context.router.push(XRoute())`, and a screen's tabs. Each
from the screen whose code makes the call (`Repo.screens_of`), labelled by the text beside it
when the code spells it.

Texts (`code_texts` with `lang == "dart"`): string literals (adjacent literals joined, `$x` and
`${x}` as holes), and localized strings resolved to English: `S.of(context).key` / `l10n.key` /
`AppLocalizations.of(context)!.key` through the app's `*_en.arb`, and `'key'.tr()` /
`'key'.translate(context)` through an `en.json` in a `languages`, `translations`, `lang`,
`i18n` or `locales` folder. A screen's title is its app bar's `title:`; its alerts are the
`title:` of the `AlertDialog`s it shows.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from orcha_cli.qa.codemap import features as fm

HOLE = "\x00"

#: Generated and test-only Dart files, never read.
SKIP_SUFFIXES = (".g.dart", ".freezed.dart", ".gr.dart", ".gen.dart", ".mocks.dart", ".config.dart", ".chopper.dart")
#: Folders of a Flutter package that hold no app screens.
SKIP_FOLDERS = frozenset({"test", "integration_test", "test_driver", "example", "tool", "bin", "generated", "gen", "l10n"})
#: The widget classes Flutter and its common packages give.
WIDGET_BASES = frozenset({
    "StatelessWidget", "StatefulWidget", "ConsumerWidget", "ConsumerStatefulWidget", "HookWidget", "HookConsumerWidget",
    "StatefulHookWidget", "StatefulHookConsumerWidget", "GetView", "GetWidget", "GetResponsiveView", "GetResponsiveWidget",
    "StatelessObserverWidget", "ObserverWidget", "PlatformWidget", "BlocWidget", "ViewModelWidget", "StackedView",
})
#: The class a StatefulWidget's state extends (`_XState extends State<X>`).
STATE_BASES = frozenset({"State", "ConsumerState", "HookState", "StateMVC"})
#: Names that say a widget is a screen.
SCREEN_NAME = re.compile(r"[a-z0-9](?:Screen|Page)$")
VIEW_NAME = re.compile(r"[a-z0-9]View$")
TAB_NAME = re.compile(r"[a-z0-9]Tab$")
VIEW_FOLDERS = frozenset({"view", "views", "screen", "screens", "page", "pages", "presentation", "ui"})
#: Widgets that wrap the screen a route builds (`OpenSourceScope(child: X())`), never it.
WRAPPER = re.compile(
    r"(?:Scope|Provider|Providers|Wrapper|Builder|Listener|Consumer|Guard|Gate|Container|Host|Theme|Localizations|Overlay|"
    r"Directionality|MediaQuery|Padding|Center|SafeArea|Navigator|Route|PageRoute|Transition|Material|Scaffold|Shell|Observer|"
    r"Animated\w*|Hero|Banner|Dialog|Sheet|Loader|Loading|Spinner|Scaffold|Annotated\w*|Semantics|Focus|Form|Expanded|Sized\w*|"
    r"Responsive\w*|MaxWidth|Restart\w*|Splash\w*Wrapper|Bloc\w*|Repository\w*)$"
)
#: Route classes and page builders whose builder or child is a screen.
ROUTE_CTOR = re.compile(
    r"\b(?:MaterialPageRoute|CupertinoPageRoute|PageRouteBuilder|PageTransition|MaterialPage|CupertinoPage|"
    r"CustomTransitionPage|NoTransitionPage|MaterialWithModalsPageRoute|ModalBottomSheetRoute|"
    r"[A-Z]\w*(?:PageRoute|Route|Transition))\s*(?:<[^<>()]*>)?\s*\("
)
_CTOR = re.compile(r"\b(?:const\s+|new\s+)?(_?[A-Z]\w*)(?:\s*<[^<>()]*>)?\s*(?:\.\s*([a-z]\w*))?\s*\(")
_CLASS = re.compile(
    r"^[ \t]*(?:@\w+(?:\([^)\n]*\))?\s+)*(?:(?:abstract|sealed|base|final|interface|mixin)\s+)*class\s+(_?[A-Z]\w*)"
    r"(?:\s*<[^{]*?>)?(?:\s+extends\s+([A-Za-z_][\w.]*)(?:\s*<\s*([A-Za-z_]\w*)[^{]*?>)?)?[^{;]*\{",
    re.MULTILINE,
)
_DECL_ANY = re.compile(r"^[ \t]*(?:@\w+(?:\([^)\n]*\))?\s+)*(?:(?:abstract|sealed|base|final|interface)\s+)*(?:class|mixin|enum|extension)\s+(_?[A-Z]\w*)?[^{;]*\{", re.MULTILINE)
_CONST = re.compile(r"\b(?:static\s+)?(?:const|final)\s+(?:String\s+)?([A-Za-z_]\w*)\s*=\s*(r?)(['\"])((?:(?!\3)[^\\\n]|\\.)*)\3\s*;")
_ROUTE_PAGE = re.compile(r"@RoutePage\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*class\s+([A-Z]\w*)")
_STATIC_ROUTE = re.compile(r"\bstatic\s+(?:[\w<>?,\s]+\s+)?route\w*\s*\(")
_L10N = re.compile(
    r"\b(?:S\s*\.\s*of\s*\(\s*\w+\s*\)|S\s*\.\s*current|AppLocalizations\s*\.\s*of\s*\(\s*\w+\s*\)\s*!?|"
    r"context\s*\.\s*(?:l10n|loc|tr|strings|localizations)|l10n|loc|localizations|strings|lang|t)\s*\.\s*([a-z]\w*)\b"
)
_TR_CALL = re.compile(r"\s*\.\s*(?:tr|translate|i18n|tr\(\))\b")
LANG_FOLDERS = frozenset({"languages", "language", "translations", "translation", "lang", "langs", "i18n", "l10n", "locales", "locale", "strings"})
#: Folders a Flutter screen's feature is named after the one beside them (`features/library/...`).
CONTAINERS = frozenset({"features", "feature", "modules", "module", "screens", "screen", "pages", "page", "ui", "presentation", "src", "views", "lib"})
GENERIC = frozenset({
    "view", "views", "widget", "widgets", "screens", "screen", "pages", "page", "presentation", "ui", "lib", "src", "features",
    "feature", "modules", "components", "component", "tabs", "tab", "common", "shared", "core", "app",
})


# ---------- reading Dart source ----------


def scan(text: str) -> Iterator[tuple[str, int, int, str]]:
    """("comment" | "string", start, end, value) of each comment and string literal. A string's
    value has its escapes read and `HOLE` for each interpolation (`$x`, `${x}`); a raw string
    (`r'...'`) is taken as written."""
    n = len(text)
    i = 0
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] in "/*":
            if text[i + 1] == "/":
                k = text.find("\n", i + 2)
                end = n if k < 0 else k
            else:
                depth, k = 1, i + 2
                while k < n and depth:  # Dart block comments nest
                    if text.startswith("/*", k):
                        depth, k = depth + 1, k + 2
                    elif text.startswith("*/", k):
                        depth, k = depth - 1, k + 2
                    else:
                        k += 1
                end = k
            yield "comment", i, end, ""
            i = max(end, i + 2)
            continue
        if c in "'\"":
            raw = i > 0 and text[i - 1] == "r" and (i < 2 or not (text[i - 2].isalnum() or text[i - 2] == "_"))
            start = i - 1 if raw else i
            value, end = read_string(text, i, raw)
            if end < 0:
                i += 1
                continue
            yield "string", start, end, value
            i = end
            continue
        i += 1


def read_string(text: str, i: int, raw: bool = False) -> tuple[str, int]:
    """The value of the Dart string opening at `text[i]` and the index after it; -1 when a
    one-line string does not close on its line."""
    n = len(text)
    q = text[i]
    triple = text.startswith(q * 3, i)
    close = q * 3 if triple else q
    j = i + (3 if triple else 1)
    out: list[str] = []
    while j < n:
        if text.startswith(close, j):
            return "".join(out), j + len(close)
        c = text[j]
        if c == "\n" and not triple:
            return "", -1
        if c == "\\" and not raw and j + 1 < n:
            nxt = text[j + 1]
            out.append({"n": " ", "t": " ", "r": "", "\\": "\\", "'": "'", '"': '"', "$": "$"}.get(nxt, ""))
            j += 2
            continue
        if c == "$" and not raw and j + 1 < n:
            if text[j + 1] == "{":
                j = _skip_interp(text, j + 1)
                out.append(HOLE)
                continue
            m = re.match(r"[A-Za-z_]\w*", text[j + 1: j + 80])
            if m:
                j += 1 + m.end()
                out.append(HOLE)
                continue
        out.append(c)
        j += 1
    return "", -1


def _skip_interp(text: str, i: int) -> int:
    """The index after the `}` closing the `${` whose brace is at `i`, skipping strings in it."""
    depth = 0
    j = i
    n = len(text)
    while j < n:
        c = text[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return j + 1
        elif c in "'\"":
            _, end = read_string(text, j)
            if end > 0:
                j = end
                continue
        j += 1
    return n


def literals(text: str) -> Iterator[tuple[int, int, str]]:
    """(start, end, value) of each string literal, adjacent literals (`'a' 'b'`) joined."""
    pending: list[Any] | None = None
    for kind, start, end, value in scan(text):
        if kind != "string":
            continue
        if pending is not None and not text[pending[1]:start].strip():
            pending[1], pending[2] = end, pending[2] + value
            continue
        if pending is not None:
            yield pending[0], pending[1], pending[2]
        pending = [start, end, value]
    if pending is not None:
        yield pending[0], pending[1], pending[2]


def code_only(text: str) -> str:
    """`text` with comments and string literals blanked (same length, newlines kept), so a
    regex reads only code and the offsets still point into `text`. A string's quotes are kept
    so an argument stays an argument."""
    out = list(text)
    for kind, start, end, _ in scan(text):
        lo, hi = (start, end) if kind == "comment" else (start + 1, end - 1)
        for k in range(lo, min(hi, len(out))):
            if out[k] != "\n":
                out[k] = " "
    return "".join(out)


def string_at(text: str, pos: int) -> tuple[str | None, int]:
    """The string literal (adjacent ones joined) starting at `pos` after blanks, and its end."""
    m = re.compile(r"\s*(r?)(['\"])").match(text, pos)
    if not m:
        return None, pos
    value, end = read_string(text, m.end() - 1, bool(m.group(1)))
    if end < 0:
        return None, pos
    while True:
        nxt = re.compile(r"\s*(r?)(['\"])").match(text, end)
        if not nxt:
            break
        more, e2 = read_string(text, nxt.end() - 1, bool(nxt.group(1)))
        if e2 < 0:
            break
        value, end = value + more, e2
    return value, end


def close_of(code: str, i: int) -> int:
    """The index of the bracket closing the one at `code[i]` in code-only text (strings and
    comments already blanked); the end of the text when it never closes."""
    pairs = {"(": ")", "{": "}", "[": "]"}
    stack = [pairs[code[i]]]
    for j in range(i + 1, len(code)):
        c = code[j]
        if c in pairs:
            stack.append(pairs[c])
        elif c in ")}]":
            if stack and c == stack[-1]:
                stack.pop()
                if not stack:
                    return j
    return len(code) - 1


def top_args(code: str, open_at: int) -> list[tuple[int, int]]:
    """(start, end) of each top-level, comma-separated argument of the call or literal whose
    bracket is at `open_at`, in code-only text."""
    close = close_of(code, open_at)
    out: list[tuple[int, int]] = []
    depth, start = 0, open_at + 1
    for j in range(open_at + 1, close):
        c = code[j]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            out.append((start, j))
            start = j + 1
    if code[start:close].strip():
        out.append((start, close))
    return out


def named_arg(code: str, args: list[tuple[int, int]], name: str) -> tuple[int, int] | None:
    """(start, end) of the value of the named argument `name:` among `args`."""
    for a, b in args:
        m = re.compile(r"\s*" + re.escape(name) + r"\s*:\s*").match(code, a, b)
        if m:
            return m.end(), b
    return None


def line_at(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


# ---------- the package and its classes ----------


@dataclass
class DartClass:
    name: str
    rel: str
    line: int
    start: int  # offset of the declaration
    body: tuple[int, int]  # offsets of `{` and `}`
    extends: str | None
    state_of: str | None  # `_XState extends State<X>`: X


@dataclass
class Index:
    """What the readers share about a repo's Flutter code: its Dart files (`rel -> text` and
    code-only text), classes, widgets, string constants and routes."""

    files: list[str] = field(default_factory=list)
    texts: dict[str, str] = field(default_factory=dict)
    codes: dict[str, str] = field(default_factory=dict)
    classes: dict[str, list[DartClass]] = field(default_factory=dict)
    widgets: set[str] = field(default_factory=set)
    consts: dict[str, str] = field(default_factory=dict)  # `Routes.home` and `home` -> "/home" (when one value)
    routes: dict[str, str] = field(default_factory=dict)  # route path -> screen class
    route_names: dict[str, str] = field(default_factory=dict)  # GoRoute/GetPage name -> screen class
    route_classes: dict[str, str] = field(default_factory=dict)  # auto_route `XRoute` -> screen class
    targets: set[str] = field(default_factory=set)  # classes a route or a page route builds
    tabs: list[tuple[str, int, list[str]]] = field(default_factory=list)  # (file, offset, tab classes)
    screens: dict[str, DartClass] = field(default_factory=dict)  # class name -> its declaration
    route_of: dict[str, str] = field(default_factory=dict)  # screen class -> its first route path

    def cls(self, name: str) -> DartClass | None:
        found = self.classes.get(name) or []
        return found[0] if len(found) == 1 else None


def flutter_files(files: list[str], text: Callable[[str], str | None]) -> list[str]:
    """The Dart files in the `lib/` folder of each Flutter package among `files`."""
    pubspecs: dict[str, bool] = {}
    for rel in files:
        if rel.rsplit("/", 1)[-1] == "pubspec.yaml":
            body = text(rel) or ""
            pubspecs[rel.rsplit("/", 1)[0] if "/" in rel else ""] = bool(re.search(r"^\s*(?:sdk:\s*flutter|flutter:)", body, re.MULTILINE))
    if not any(pubspecs.values()):
        return []
    out = []
    for rel in files:
        if not rel.endswith(".dart") or rel.endswith(SKIP_SUFFIXES):
            continue
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        pkg = folder
        while pkg not in pubspecs and pkg:
            pkg = pkg.rsplit("/", 1)[0] if "/" in pkg else ""
        if not pubspecs.get(pkg):
            continue
        inner = rel[len(pkg) + 1:] if pkg else rel
        parts = inner.split("/")
        if parts[0] != "lib" or any(p in SKIP_FOLDERS for p in parts[1:-1]):
            continue
        out.append(rel)
    return out


def build_index(files: list[str], text: Callable[[str], str | None]) -> Index:
    idx = Index()
    for rel in flutter_files(files, text):
        body = text(rel)
        if not body:
            continue
        idx.files.append(rel)
        idx.texts[rel] = body
        idx.codes[rel] = code_only(body)
    if not idx.files:
        return idx
    supers: dict[str, str | None] = {}
    seen_consts: dict[str, set[str]] = {}
    for rel in idx.files:
        body, code = idx.texts[rel], idx.codes[rel]
        spans: list[tuple[int, int, str]] = []
        for m in _CLASS.finditer(code):
            brace = m.end() - 1
            end = close_of(code, brace)
            ext = (m.group(2) or "").rsplit(".", 1)[-1] or None
            state_of = m.group(3) if ext in STATE_BASES else None
            c = DartClass(m.group(1), rel, line_at(body, m.start(1)), m.start(), (brace, end), ext, state_of)
            idx.classes.setdefault(c.name, []).append(c)
            supers.setdefault(c.name, ext)
            spans.append((brace, end, c.name))
        for m in _CONST.finditer(body):
            if code[m.start(): m.start() + 5] != body[m.start(): m.start() + 5]:
                continue  # inside a comment or a string
            value = m.group(4) if m.group(2) else _unescape(m.group(4))
            owner = next((name for a, b, name in spans if a < m.start() < b), None)
            for key in ([f"{owner}.{m.group(1)}"] if owner else []) + [m.group(1)]:
                seen_consts.setdefault(key, set()).add(value)
    idx.consts = {k: next(iter(v)) for k, v in seen_consts.items() if len(v) == 1}
    # A widget: a class whose chain of superclasses reaches a Flutter widget.
    for name in supers:
        chain, cur = set(), name
        while cur and cur not in chain:
            chain.add(cur)
            if cur in WIDGET_BASES:
                idx.widgets.add(name)
                break
            cur = supers.get(cur)
    idx.widgets -= WIDGET_BASES
    _read_routes(idx)
    _pick_screens(idx)
    return idx


def _unescape(raw: str) -> str:
    return re.sub(r"\\(.)", lambda m: {"n": " ", "t": " "}.get(m.group(1), m.group(1)), raw)


def _is_widget(idx: Index, name: str) -> bool:
    return name in idx.widgets


def first_widget(idx: Index, code: str, a: int, b: int, prefer_screens: bool = True) -> str | None:
    """The screen a route builds between offsets `a` and `b` of `code`: the first widget of the
    app that is not a wrapper (`OpenSourceScope(child: X())` is X), a screen-named one first;
    `X.route(...)` is X."""
    plain: str | None = None
    for m in _CTOR.finditer(code, a, b):
        name, member = m.group(1), m.group(2)
        if member and member.startswith("route") and name in idx.classes:
            return name
        if not _is_widget(idx, name) or name.startswith("_"):
            continue
        if WRAPPER.search(name) and not SCREEN_NAME.search(name):
            continue
        if not prefer_screens or SCREEN_NAME.search(name) or VIEW_NAME.search(name) or TAB_NAME.search(name):
            return name
        plain = plain or name
    return plain


def resolve(idx: Index, text: str, code: str, a: int, b: int) -> str | None:
    """The string an expression spells: a literal (adjacent ones joined), else a constant
    (`Routes.home`, `kHome`) the index knows. None for anything else."""
    value, end = string_at(text, a)
    if value is not None and end <= b:
        return value
    m = re.compile(r"\s*([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_]\w*)*)").match(code, a, b)
    if not m:
        return None
    chain = re.sub(r"\s+", "", m.group(1)).split(".")
    for k in (".".join(chain[-2:]), chain[-1]):
        if k in idx.consts:
            return idx.consts[k]
    return None


def _join(parent: str, child: str) -> str:
    if child.startswith("/") or not parent:
        return child
    return parent.rstrip("/") + "/" + child


def _read_routes(idx: Index) -> None:
    for rel in idx.files:  # auto_route's pages first: a router names them by their route class
        for m in _ROUTE_PAGE.finditer(idx.codes[rel]):
            idx.targets.add(m.group(1))
            stem = re.sub(r"(?:Screen|Page|View)$", "", m.group(1))
            idx.route_classes.setdefault(stem + "Route", m.group(1))
    for rel in idx.files:
        text, code = idx.texts[rel], idx.codes[rel]
        if "switch" in code and ("RouteSettings" in code or "onGenerateRoute" in code or ".name" in code):
            _switch_routes(idx, text, code)
        for m in re.finditer(r"\broutes\s*:\s*(?:const\s+)?(?:<[^<>]*(?:<[^<>]*>)?[^<>]*>\s*)?\{", code):
            brace = m.end() - 1
            for a, b in top_args(code, brace):
                colon = _top_colon(code, a, b)
                if colon is None:
                    continue
                path = resolve(idx, text, code, a, colon)
                target = first_widget(idx, code, colon + 1, b)
                if path is not None and target:
                    idx.routes.setdefault(path, target)
                    idx.targets.add(target)
        if "GoRoute" in code:
            _go_routes(idx, text, code)
        for m in re.finditer(r"\bGetPage\s*(?:<[^<>()]*>)?\s*\(", code):
            args = top_args(code, m.end() - 1)
            name, page = named_arg(code, args, "name"), named_arg(code, args, "page")
            path = resolve(idx, text, code, *name) if name else None
            target = first_widget(idx, code, *page) if page else None
            if target:
                idx.targets.add(target)
                if path:
                    idx.routes.setdefault(path, target)
        if "AutoRoute" in code or "CustomRoute" in code:
            _auto_routes(idx, text, code)
        for m in ROUTE_CTOR.finditer(code):
            target = first_widget(idx, code, m.end(), close_of(code, m.end() - 1))
            if target:
                idx.targets.add(target)
        for m in re.finditer(r"\bGet\s*\.\s*(?:to|off|offAll|dialog|bottomSheet)\s*(?:<[^<>()]*>)?\s*\(", code):
            target = first_widget(idx, code, m.end(), close_of(code, m.end() - 1))
            if target and "dialog" not in m.group(0) and "bottomSheet" not in m.group(0):
                idx.targets.add(target)
        for c in (x for xs in idx.classes.values() for x in xs if x.rel == rel):
            # `static Route route(RouteSettings s) => ...`: the class is a screen.
            if _STATIC_ROUTE.search(code, c.body[0], c.body[1]) and c.name in idx.widgets:
                idx.targets.add(c.name)


def _top_colon(code: str, a: int, b: int) -> int | None:
    depth = 0
    for j in range(a, b):
        c = code[j]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == ":" and depth == 0:
            return j
    return None


def _switch_routes(idx: Index, text: str, code: str) -> None:
    for m in re.finditer(r"\bswitch\s*\(([^()]*(?:\([^()]*\))?[^()]*)\)\s*\{", code):
        subject = m.group(1)
        if not re.search(r"\bname\b|settings|route", subject, re.IGNORECASE):
            continue
        brace = m.end() - 1
        end = close_of(code, brace)
        cases = list(re.finditer(r"\bcase\b|\bdefault\b", code[brace:end]))
        if cases:
            pending: list[str] = []
            for k, c in enumerate(cases):
                start = brace + c.start()
                stop = brace + cases[k + 1].start() if k + 1 < len(cases) else end
                if c.group(0) == "default":
                    pending = []
                    continue
                colon = _top_colon(code, start + 4, stop)
                if colon is None:
                    continue
                path = resolve(idx, text, code, start + 4, colon)
                if path is not None:
                    pending.append(path)
                target = first_widget(idx, code, colon + 1, stop)
                if target:
                    for p in pending:
                        idx.routes.setdefault(p, target)
                    idx.targets.add(target)
                    pending = []
        else:  # a switch expression: `Routes.home => const HomeScreen(),`
            for a, b in top_args(code, brace):
                arrow = code.find("=>", a, b)
                if arrow < 0:
                    continue
                path = resolve(idx, text, code, a, arrow)
                target = first_widget(idx, code, arrow + 2, b)
                if target:
                    idx.targets.add(target)
                    if path is not None:
                        idx.routes.setdefault(path, target)


def _go_routes(idx: Index, text: str, code: str) -> None:
    calls = [(m.start(), m.end() - 1, close_of(code, m.end() - 1)) for m in re.finditer(r"\bGoRoute\s*\(", code)]
    paths: dict[int, str] = {}
    for start, open_at, close in calls:
        parent = max((c for c in calls if c[1] < open_at and c[2] > close), key=lambda c: c[1], default=None)
        args = top_args(code, open_at)
        p = named_arg(code, args, "path")
        own = resolve(idx, text, code, *p) if p else None
        full = _join(paths.get(parent[1], "") if parent else "", own or "")
        paths[open_at] = full
        body = named_arg(code, args, "builder") or named_arg(code, args, "pageBuilder")
        target = first_widget(idx, code, *body) if body else None
        if target:
            idx.targets.add(target)
            if own is not None:
                idx.routes.setdefault(full or "/", target)
            n = named_arg(code, args, "name")
            name = resolve(idx, text, code, *n) if n else None
            if name:
                idx.route_names.setdefault(name, target)


def _auto_routes(idx: Index, text: str, code: str) -> None:
    calls = [(m.end() - 1, close_of(code, m.end() - 1)) for m in re.finditer(r"\b(?:AutoRoute|CustomRoute|AdaptiveRoute|MaterialRoute|CupertinoRoute|RedirectRoute)\s*(?:<[^<>()]*>)?\s*\(", code)]
    paths: dict[int, str] = {}
    for open_at, close in calls:
        parent = max((c for c in calls if c[0] < open_at and c[1] > close), key=lambda c: c[0], default=None)
        args = top_args(code, open_at)
        p = named_arg(code, args, "path")
        own = resolve(idx, text, code, *p) if p else None
        full = _join(paths.get(parent[0], "") if parent else "", own or "")
        paths[open_at] = full
        page = named_arg(code, args, "page")
        m = re.compile(r"\s*([A-Z]\w*)\s*\.\s*page\b").match(code, *page) if page else None
        target = idx.route_classes.get(m.group(1)) if m else None
        if target and own is not None:
            idx.routes.setdefault(full or "/", target)


def _pick_screens(idx: Index) -> None:
    def candidate(c: DartClass) -> bool:
        if c.name.startswith("_") or c.name not in idx.widgets:
            return False
        if c.name in idx.targets or SCREEN_NAME.search(c.name):
            return True
        folder = c.rel.split("/")[-2] if "/" in c.rel else ""
        return bool(VIEW_NAME.search(c.name) and (folder in VIEW_FOLDERS or c.rel.endswith("_view.dart")))

    for name, decls in idx.classes.items():
        if len(decls) == 1 and candidate(decls[0]):
            idx.screens[name] = decls[0]
    # A screen's tabs: a list of two or more of the app's widgets in a screen's class, one of them
    # a screen or each named like one (`HomeTab`, `LibraryTab`).
    for rel in idx.files:
        code = idx.codes[rel]
        for m in re.finditer(r"(?:[=:]|\breturn|\bconst|>)\s*\[", code):
            open_at = m.end() - 1
            items = top_args(code, open_at)
            if len(items) < 2 or len(items) > 8:
                continue
            found = [first_widget(idx, code, a, b) for a, b in items]
            if any(f is None for f in found) or len(set(found)) != len(found):
                continue
            names = [str(f) for f in found]
            named = all(SCREEN_NAME.search(n) or TAB_NAME.search(n) or VIEW_NAME.search(n) for n in names)
            if not (named or any(n in idx.screens for n in names)) or not all(n in idx.widgets for n in names):
                continue
            if not any(c.body[0] < open_at < c.body[1] and c.name in idx.screens for c in _classes_in(idx, rel)):
                continue
            for n in names:
                c = idx.cls(n)
                if c is not None:
                    idx.screens.setdefault(n, c)
            idx.tabs.append((rel, open_at, names))
    for path, cls in idx.routes.items():
        idx.route_of.setdefault(cls, path)


def _classes_in(idx: Index, rel: str) -> list[DartClass]:
    return [c for cs in idx.classes.values() for c in cs if c.rel == rel]


def feature_group(rel: str, name: str) -> str:
    """The folder a Flutter screen's feature is named after: the one inside the last container
    folder (`lib/features/library/view/x.dart` -> `library`), else the nearest that is not
    generic, else the class's own name."""
    parts = rel.split("/")[:-1]
    if "lib" in parts:
        parts = parts[parts.index("lib") + 1:]
    last = max((i for i, p in enumerate(parts) if p.lower() in CONTAINERS and i + 1 < len(parts)), default=None)
    if last is not None and parts[last + 1].lower() not in GENERIC:
        return parts[last + 1]
    for p in reversed(parts):
        if p.lower() not in GENERIC:
            return p
    return name


def _kind(name: str) -> str:
    raw = fm._kebab(name)
    if "-detail" in raw:
        return "detail"
    if raw.startswith(("add-", "new-", "create-")):
        return "new"
    if raw.startswith("edit-") or "-edit" in raw:
        return "edit"
    if "-list" in raw:
        return "list"
    return "overview"


def screens(idx: Index, base: str = "") -> list[fm.Screen]:
    """The index's screens as `feature_map` screens (platform `flutter`), in file order."""
    out = []
    for name, c in sorted(idx.screens.items(), key=lambda kv: (kv[1].rel, kv[1].line)):
        out.append(fm.Screen(feature_group(c.rel, name), _kind(name), name, base + c.rel, "flutter", base + c.rel, c.line, route=idx.route_of.get(name)))
    return out


def scan_screens(files: list[str], base: str, reader: Any, frameworks: set[str]) -> list[fm.Screen]:
    """`feature_map`'s scanner for Flutter: the screens of every Flutter package in `files`."""
    idx = build_index(files, reader.text)
    try:
        reader.dart_index = idx  # the app map's readers reuse it (`index_of`)
    except AttributeError:
        pass
    found = screens(idx, base)
    if found:
        frameworks.add("flutter")
    return found


def index_of(repo: Any) -> Index:
    """The repo's Flutter index, built once (`code.Repo.cache`; the one `feature_map`'s scan
    built on the same reader when there is one)."""
    if "dart" not in repo.cache:
        made = getattr(getattr(repo, "source", None), "dart_index", None)
        repo.cache["dart"] = made if made is not None else build_index(repo.files, repo.text)
    return repo.cache["dart"]


# ---------- which screen a line of Dart belongs to ----------


def top_decls(idx: Index, rel: str) -> list[tuple[str, int, int]]:
    """(name, start, end) of each top-level declaration of a file with a body: classes, mixins,
    enums, extensions and functions (`void openFile(...) { ... }`)."""
    cache = idx.__dict__.setdefault("_decls", {})
    if rel in cache:
        return cache[rel]
    code = idx.codes.get(rel, "")
    out: list[tuple[str, int, int]] = []
    depth, head = 0, 0
    i = 0
    while i < len(code):
        c = code[i]
        if c == "{" and depth == 0:
            header = code[head:i]
            end = close_of(code, i)
            m = re.search(r"\b(?:class|mixin|enum|extension)\s+(_?[A-Za-z]\w*)", header) or re.search(r"\b(_?[A-Za-z]\w*)\s*(?:<[^<>]*>)?\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?:async\*?|sync\*)?\s*$", header)
            if m:
                out.append((m.group(1), head + (len(header) - len(header.lstrip())), end))
            i, head = end + 1, end + 1
            continue
        if c in "([":
            depth += 1
        elif c in ")]":
            depth = max(0, depth - 1)
        elif c == ";" and depth == 0:
            head = i + 1
        i += 1
    cache[rel] = out
    return out


def _state_owner(idx: Index, name: str) -> str | None:
    c = idx.cls(name)
    return c.state_of if c is not None and c.state_of in idx.screens else None


def owners(repo: Any, rel: str, line: int) -> tuple[str, ...] | None:
    """The screens a line of a Flutter file is the code of: the screen class (or its state) the
    line is in; else, for a helper (a row widget, a private section, a top-level function), the
    screens that use it: the declarations of the same file that name it, then (a public helper)
    the files that do, each followed up to `MAX_OWNER_HOPS`. None when the file is not Flutter
    code or the line is outside every declaration."""
    idx = index_of(repo)
    if rel not in idx.texts:
        return None
    text = idx.texts[rel]
    at = sum(len(x) + 1 for x in text.split("\n")[: max(0, line - 1)])
    return _owners_at(repo, idx, rel, at, 0, set())


MAX_OWNER_HOPS = 4


def _owners_at(repo: Any, idx: Index, rel: str, at: int, depth: int, seen: set[tuple[str, str]]) -> tuple[str, ...] | None:
    decl = next(((n, a, b) for n, a, b in top_decls(idx, rel) if a <= at <= b), None)
    if decl is None:
        return None
    name = decl[0]
    screen = name if name in idx.screens else _state_owner(idx, name)
    if screen:
        key = repo.name_key(screen)
        return (key,) if key else ()
    memo = idx.__dict__.setdefault("_owners", {})
    if (rel, name) in memo:
        return memo[(rel, name)]
    if depth >= MAX_OWNER_HOPS or (rel, name) in seen:
        return ()
    seen.add((rel, name))
    keys: list[str] = []
    uses = _uses(idx).get(name, [])
    for other, offset in uses:
        if other == rel and not (decl[1] <= offset <= decl[2]):
            keys += list(_owners_at(repo, idx, rel, offset, depth + 1, seen) or ())
    if not keys and not name.startswith("_"):
        for other, offset in uses:
            if other != rel:
                keys += list(_owners_at(repo, idx, other, offset, depth + 1, seen) or ())
    keys = list(dict.fromkeys(keys))
    out = tuple(keys) if len(keys) <= 6 else ()
    if depth == 0:
        memo[(rel, name)] = out  # complete only from the top: a cycle cut deeper left it partial
    return out


def _uses(idx: Index) -> dict[str, list[tuple[str, int]]]:
    """{top-level declaration name: (file, offset) of each place the code names it}, built once."""
    if "_uses" in idx.__dict__:
        return idx.__dict__["_uses"]
    names = {n for rel in idx.files for n, _, _ in top_decls(idx, rel)}
    out: dict[str, list[tuple[str, int]]] = {}
    word = re.compile(r"\b[A-Za-z_]\w*\b")
    for rel in idx.files:
        for m in word.finditer(idx.codes[rel]):
            if m.group(0) in names:
                out.setdefault(m.group(0), []).append((rel, m.start()))
    idx.__dict__["_uses"] = out
    return out


# ---------- localized strings ----------


def strings(files: list[str], text: Callable[[str], str | None]) -> dict[str, str]:
    """{key: English text} from the app's `*_en.arb` files (`flutter gen-l10n`, intl_utils) and
    the `en.json` of a translations folder (easy_localization, GetX, a custom `translate`).
    Placeholders (`{count}`) are holes."""
    out: dict[str, str] = {}
    for rel in files:
        name = rel.rsplit("/", 1)[-1]
        folder = rel.rsplit("/", 2)[-2].lower() if rel.count("/") >= 1 else ""
        english = (name.endswith(".arb") and re.search(r"(?:^|[_-])en(?:[_-]\w+)?\.arb$", name)) or (
            folder in LANG_FOLDERS and re.match(r"^en(?:[_-](?:US|GB))?\.json$", name))
        if not english:
            continue
        try:
            data = json.loads(text(rel) or "{}")
        except ValueError:
            continue
        for k, v in _flat(data).items():
            if not k.startswith("@") and isinstance(v, str):
                out.setdefault(k, _message(v))
    return out


def _message(value: str) -> str:
    """An ARB / ICU message as the text it shows: a plural or select reads as its `other`
    branch (`{count, plural, =1{1 resource} other{{count} resources}}` -> `* resources`, the
    hole a `HOLE`), and each `{placeholder}` (and a plural's `#`) is a hole."""
    m = re.match(r"^\s*\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,(.*)\}\s*$", value, re.S)
    if m:
        body = m.group(1)
        at = re.search(r"\bother\s*\{", body)
        if at:
            depth, j = 0, at.end() - 1
            for j in range(at.end() - 1, len(body)):
                depth += {"{": 1, "}": -1}.get(body[j], 0)
                if depth == 0:
                    break
            value = body[at.end(): j].replace("#", HOLE)
    return re.sub(r"\{[^{}]*\}", HOLE, value)


def _flat(data: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(data, dict):
        for k, v in data.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, dict):
                out.update(_flat(v, key))
            else:
                out[key] = v
    return out


def strings_of(repo: Any) -> dict[str, str]:
    if "dart_strings" not in repo.cache:
        repo.cache["dart_strings"] = strings(repo.files, repo.text)
    return repo.cache["dart_strings"]


def localized(text: str, code: str, strings_: dict[str, str]) -> Iterator[tuple[int, str]]:
    """(offset, English text) of each localized string in `text`: `l10n.key` and its kin, and a
    literal key passed through `.tr()` / `.translate(context)`."""
    if not strings_:
        return
    for m in _L10N.finditer(code):
        value = strings_.get(m.group(1))
        if value:
            yield m.start(), value
    for start, end, value in literals(text):
        if value in strings_ and _TR_CALL.match(text, end):
            yield start, strings_[value]


# ---------- navigation ----------

_NAMED_PUSH = re.compile(
    r"\.\s*(pushNamed|pushReplacementNamed|pushNamedAndRemoveUntil|popAndPushNamed|restorablePushNamed|"
    r"pushNamedIfNotCurrent|goNamed|pushReplacementNamed|replaceNamed|toNamed|offNamed|offAllNamed|offAndToNamed|"
    r"go|push|pushReplacement|replace)\s*(?:<[^<>()]*>)?\s*\("
)
_WIDGET_PUSH = re.compile(r"\.\s*(push|pushReplacement|pushAndRemoveUntil|to|off|offAll)\s*(?:<[^<>()]*>)?\s*\(")
_AUTO_PUSH = re.compile(r"\.\s*(?:push|replace|navigate|pushRoute|replaceRoute|navigateTo|popAndPush)\s*\(\s*(?:const\s+)?([A-Z]\w*Route)\s*\(")
_TAB_ITEM = re.compile(r"\b\w*(?:Tab|Destination|NavigationBarItem|NavItem|TabItem|BarItem|RailDestination)\w*\s*\(")


def _clean(raw: str | None) -> str | None:
    text = " ".join((raw or "").replace(HOLE, "").split())
    if not text or len(text) > 40 or not re.search(r"[A-Za-z]", text) or re.search(r"[=;{}()<>|&]|://", text):
        return None
    if " " not in text and (text[:1].islower() or re.search(r"[a-z][A-Z]|[._/]", text)):
        return None  # a key or an identifier, not words
    return text


def _enclosing_calls(code: str, pos: int, limit: int = 6) -> Iterator[tuple[str, int]]:
    """(name, open paren) of the widget constructors around `pos`, innermost first
    (`AppIconButton(tooltip: ..., onTap: () => Navigator...)`)."""
    depth, i, found = 0, pos - 1, 0
    lo = max(0, pos - 3000)
    while i >= lo and found < limit:
        c = code[i]
        if c in ")]}":
            depth += 1
        elif c in "([{":
            if depth:
                depth -= 1
            elif c == "(":
                m = re.search(r"\b([A-Z]\w*)(?:\.\w+)?\s*(?:<[^<>()]*>)?\s*$", code[max(0, i - 80): i])
                if m:
                    found += 1
                    yield m.group(1), i
        i -= 1


def _label_near(text: str, code: str, start: int, end: int, strings_: dict[str, str]) -> str | None:
    """The text on the control that makes a navigation call: a `label:`, `title:`, `tooltip:`,
    `text:` or `Text(...)` among the arguments of the nearest widget around the call (the button,
    the tile or the row it is in). None for a call in a method, which no control spells."""
    for _, open_at in _enclosing_calls(code, start):
        args = top_args(code, open_at)
        for name in ("label", "title", "tooltip", "text", "semanticLabel", "child"):
            arg = named_arg(code, args, name)
            if not arg:
                continue
            a, b = arg
            inner = re.compile(r"\s*(?:const\s+)?Text\s*\(").match(code, a, b)
            value, _ = string_at(text, inner.end() if inner else a)
            if value is None:
                hit = next(localized(text[a:b], code[a:b], strings_), None)
                value = hit[1] if hit else None
            label = _clean(value)
            if label:
                return label
    return None


def match_route(idx: Index, path: str) -> str | None:
    """The screen class a route path or GoRouter name opens: the exact route, else a declared
    pattern whose `:param` / `{param}` / interpolated segments fit."""
    if path in idx.routes:
        return idx.routes[path]
    if path in idx.route_names:
        return idx.route_names[path]
    segs = [s for s in path.split("?")[0].strip("/").split("/") if s]
    best: tuple[int, str] | None = None
    for route, cls in idx.routes.items():
        rs = [s for s in route.strip("/").split("/") if s]
        if len(rs) != len(segs):
            continue
        ok, score = True, 0
        for r, s in zip(rs, segs):
            wild = r.startswith((":", "{", "*")) or HOLE in s
            if r == s:
                score += 1
            elif not wild:
                ok = False
                break
        if ok and (best is None or score > best[0]):
            best = (score, cls)
    return best[1] if best else None


def nav(repo: Any, rel: str, make: Callable[[str, str, str, str, int], Any]) -> list[Any]:
    """The navigation edges `rel` makes, each built by `make(from_key, to_key, label, rel, line)`
    from every screen whose code holds the call (`repo.screens_of`)."""
    idx = index_of(repo)
    if rel not in idx.texts:
        return []
    text, code = idx.texts[rel], idx.codes[rel]
    strings_ = strings_of(repo)
    out: list[Any] = []

    def key_of(cls: str | None) -> str | None:
        return repo.name_key(cls) if cls else None

    def add(at: int, end: int, target: str | None, label: str | None = None, verb: str = "Open") -> None:
        if not target:
            return
        line = line_at(text, at)
        label = label or _label_near(text, code, at, end, strings_)
        for src in repo.screens_of(rel, line):
            if src != target:
                out.append(make(src, target, label or f"{verb} {repo.screens[target].name}", rel, line))

    for m in _NAMED_PUSH.finditer(code):
        open_at = m.end() - 1
        close = close_of(code, open_at)
        args = top_args(code, open_at)
        if not args:
            continue
        a, b = args[0]
        if re.fullmatch(r"\s*context\s*", code[a:b]) and len(args) > 1:
            a, b = args[1]  # `Navigator.pushNamed(context, Routes.x)`
        verb = m.group(1)
        if verb in ("push", "pushReplacement", "replace") and not re.match(r"\s*r?['\"]", text[a:b]):
            continue  # a widget push or a route object: below
        path = resolve(idx, text, code, a, b)
        if path is None:
            continue
        add(m.start(), close, key_of(match_route(idx, path)))
    for m in _WIDGET_PUSH.finditer(code):
        open_at = m.end() - 1
        close = close_of(code, open_at)
        args = code[open_at:close]
        if m.group(1) in ("to", "off", "offAll") and not re.search(r"\bGet\s*$", code[max(0, m.start() - 8): m.start()]):
            continue
        if m.group(1) not in ("to", "off", "offAll") and not ROUTE_CTOR.search(args):
            continue
        add(m.start(), close, key_of(first_widget(idx, code, open_at, close)))
    for m in _AUTO_PUSH.finditer(code):
        add(m.start(), m.end(), key_of(idx.route_classes.get(m.group(1))))
    for tab_rel, open_at, names in idx.tabs:
        if tab_rel != rel:
            continue
        labels = _tab_labels(text, code, strings_)
        for k, n in enumerate(names):
            label = f"{labels[k]} tab" if len(labels) == len(names) else None
            add(open_at, open_at, key_of(n), label, "Tab")
    return out


def _tab_labels(text: str, code: str, strings_: dict[str, str]) -> list[str]:
    """The `label:` of each tab item a file declares, in order (a literal or a localized key)."""
    out: list[str] = []
    for m in _TAB_ITEM.finditer(code):
        if m.group(0).lstrip().startswith(("TabBar(", "TabController")):
            continue
        args = top_args(code, m.end() - 1)
        lab = named_arg(code, args, "label") or named_arg(code, args, "text")
        if not lab:
            continue
        value, _ = string_at(text, lab[0])
        if value is None:
            hit = next(localized(text[lab[0]: lab[1]], code[lab[0]: lab[1]], strings_), None)
            value = hit[1] if hit else None
        label = _clean(value)
        if label:
            out.append(label)
    return out


# ---------- texts ----------

_BAR = re.compile(r"\b\w*(?:AppBar|TopBar|NavigationBar|NavBar|Toolbar|Header)\s*\(")
_ALERT = re.compile(r"\b\w*(?:AlertDialog|ConfirmDialog|Dialog)\s*\(")


def unit_strings(body: str, code: str, strings_: dict[str, str]) -> Iterator[tuple[int, int, str]]:
    """(start, end, value) of the literals and localized strings in one declaration's body."""
    for start, end, value in literals(body):
        if value in strings_ and _TR_CALL.match(body, end):
            yield start, end, strings_[value]
        else:
            yield start, end, value
    for m in _L10N.finditer(code):
        value = strings_.get(m.group(1))
        if value:
            yield m.start(), m.end(), value


def titled(body: str, code: str, regex: re.Pattern[str], strings_: dict[str, str]) -> list[str]:
    """The `title:` (or `middle:`) of each call `regex` finds: a literal, `Text('...')` or a
    localized string."""
    out: list[str] = []
    for m in regex.finditer(code):
        args = top_args(code, m.end() - 1)
        arg = named_arg(code, args, "title") or named_arg(code, args, "middle") or named_arg(code, args, "titleText")
        if not arg:
            continue
        a, b = arg
        inner = re.compile(r"\s*(?:const\s+)?Text\s*\(").match(code, a, b)
        value, end = string_at(body, inner.end() if inner else a)
        if value is not None and value in strings_ and _TR_CALL.match(body, end):
            value = strings_[value]  # `Text('listings.title'.tr())`
        if value is None:
            value = next((v for _, v in localized(body[a:b], code[a:b], strings_)), None)
        if value:
            out.append(value)
    return out
