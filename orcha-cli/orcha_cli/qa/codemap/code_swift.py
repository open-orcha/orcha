"""Which SwiftUI views are screens (issue #467): what a person navigates to, never a view that only
composes one. Android's reader counts the destinations of its nav graph and its activities
(`feature_map._scan_android`), so iOS counts the same kind of thing and the two read alike.

A view is a screen when it is

- **the app's root**: what `WindowGroup` (`Window`, `DocumentGroup`) shows, past the shells that
  only choose between views or wrap one (`RootView` choosing onboarding or the tabs, `AppView`
  wrapping the library and its covers);
- **a tab**: the content of a `Tab { ... }` or the view a `.tabItem` is on, inside a tab bar
  (`TabView`), or a case of a `switch` on the selected tab beside it (a tab bar of its own), past
  the shells it wraps (`TodayTabView` -> `TodayDashboardView`);
- **presented**: the content of `.sheet`, `.fullScreenCover`, `.popover`,
  `.navigationDestination`, a `NavigationLink`'s destination or a `UIHostingController(rootView:)`;
  each case of a destination's `switch` is one.

A view that holds a tab bar is no screen itself (its tabs are). Everything else composes a screen
and folds into it: `DashboardHeaderView` inside `TodayDashboardView`, a step an onboarding
coordinator switches in place (as Android's `when (step)` inside one destination), a row, a card.
A loading placeholder at the root (`LoadingView`) is no screen, nor a presented building block
(`...Row`, `...Card`, `...Button`, ...).

When the app's root is found, only code it reaches counts: a view nothing reachable instantiates
(a file left from an old design) presents nothing. Previews, tests and `#if DEBUG` code are never
read. `navigable` answers None when there is no SwiftUI to judge, so the caller keeps every view
the screen scan found.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

from orcha_cli.qa.codemap import features as fm
from orcha_cli.qa.codemap.code import Repo, close_of
from orcha_cli.qa.codemap.code_texts import scanned

#: Containers a presented view is wrapped in without being laid out beside anything.
PASS_THROUGH = frozenset({"NavigationStack", "NavigationView", "Group", "AnyView", "ScrollViewReader"})
#: Views that show nothing of the app's own (a branch of a shell that is only waiting).
NOTHING = frozenset({"ProgressView", "EmptyView", "Color", "Spacer", "Rectangle"})
#: A presented view whose name says it is a building block, not a screen.
NOT_A_SCREEN = re.compile(r"(?:Row|Cell|Card|Button|Toast|Banner|Badge|Chip|Icon|Label|Field|Modifier|Style|Preview)$")
#: A root branch that only waits for the app to load.
PLACEHOLDER = re.compile(r"(?:Loading|Loader|Spinner|Progress|Launch)(?:View|Screen)?$")
#: A view named as the app's root: on the root chain, the views it chooses between are the screens.
ROOT_SHELL = re.compile(r"^(?:App|Root|Content|Main)(?:Flow|Shell|Root)?(?:View|Screen)$")
#: A view that only wraps the content it is given (`ZoomNamespaceHost { NavigationStack { ... } }`).
WRAPPER = re.compile(r"(?:Wrapper|Shell|Container|Host)$")
#: How deep a content is followed through shells, members and branches.
MAX_DEPTH = 8

_TYPE = re.compile(
    r"^[ \t]*(?:(?:@\w+(?:\([^)\n]*\))?|public|private|fileprivate|internal|open|final|indirect|nonisolated)\s+)*"
    r"(struct|class|enum|extension|actor|protocol)\s+([A-Za-z_][\w.]*)([^{;\n]*(?:\n[^{;\n]*){0,3}?)\{",
    re.MULTILINE,
)
_CALL = re.compile(r"\b([A-Z]\w*)\s*(?:\(|\{|\.init\b)")
_MEMBER = re.compile(r"\b(?:var|func)\s+(\w+)\b[^{=;]*?(?:some\s+(?:SwiftUI\.)?View|AnyView)\s*\{")
_BODY = re.compile(r"\bvar\s+body\s*:\s*some\s+(?:SwiftUI\.)?View\s*\{")
_PRESENTER = re.compile(r"\.(sheet|fullScreenCover|popover|navigationDestination)\s*(?=[({])|\b(NavigationLink)\s*(?=[({])|\b(UIHostingController)\b(?:\s*<[^>]*>)?\s*\(")
_SCENE = re.compile(r"\b(?:WindowGroup|Window|DocumentGroup)\s*(?=[({])")
_TAB_VIEW = re.compile(r"\bTabView\s*(?=[({])")
_TAB = re.compile(r"(?:(?<![.\w])|(?<=SwiftUI\.))Tab\s*\(")
_TAB_ITEM = re.compile(r"\.tabItem\s*\{")
_TAB_SWITCH = re.compile(r"\bswitch\s+(?:self\.)?[\w.]*?[tT]ab\s*\{")
_PREVIEW = re.compile(r"#Preview\b")
_PARAMS = re.compile(r"^\s*(?:\[[^\]\n]*\]\s*)?(?:\([^()\n]*\)|[\w ,]+?)[ \t]+in\b")
_DIRECTIVE = re.compile(r"^[ \t]*#(?:if|elseif|else|endif)\b[^\n]*\n?", re.MULTILINE)
_DECLARED_AT = re.compile(r"\b(?:struct|class|enum|extension|actor|protocol)\s+$")
_KEYWORD = frozenset({"if", "switch", "return", "else", "case", "default", "let", "var", "guard", "for", "while", "try", "await", "self", "Self", "some", "in"})


@dataclass
class Navigable:
    """The views that are screens, and where each is declared (file, line)."""

    names: set[str]
    declared: dict[str, tuple[str, int]]
    #: Views that hold a tab bar: no screen of their own.
    tab_bars: set[str] = field(default_factory=set)
    #: The files that declare a tab bar (and its extensions): the app's shell, no one screen's code.
    shell_files: set[str] = field(default_factory=set)
    #: Each tab bar's tabs, in order: (the bar's file, its line, the tabs' views).
    tabs: list[tuple[str, int, list[str]]] = field(default_factory=list)
    #: Whether the app's root was found (a `WindowGroup`, a hosting controller). Without it a view
    #: nothing instantiates may be a root the code does not show, so it is kept (`keep`).
    rooted: bool = True
    #: The views some code instantiates.
    instantiated: set[str] = field(default_factory=set)

    def keep(self, view: str) -> bool:
        """Whether a view the screen scan found is a screen: navigated to, or, with no root to
        start from, nothing instantiates it (it may be a root the code does not show)."""
        return view in self.names or (not self.rooted and view not in self.instantiated and view not in self.tab_bars)

    def screens(self, have: Iterable[str], files: list[str] | None = None) -> list[fm.Screen]:
        """The screens not among `have` (the views the screen scan already found), as scan
        screens grouped by their feature folder as the scan groups its own (`Today/QuickNotesSheet`
        is Today's), so the code map adds them the way it adds a presented view."""
        known = set(have)
        apps = fm._app_dirs(files or [rel for rel, _ in self.declared.values()])
        out = []
        for name in sorted(self.names - known):
            rel, line = self.declared[name]
            group, _ = fm._swift_group(rel, name, apps)
            out.append(fm.Screen(group, "overview", name, rel, "swiftui", rel, line))
        return out


@dataclass
class _Type:
    kind: str  # view | modifier | app | preview | extension | global
    name: str
    rel: str
    start: int  # its `{`
    end: int  # its `}`
    decl: int  # where its declaration's line starts


@dataclass
class _Site:
    kind: str  # root | tab | present
    owner: str  # a view's name, or "" for code every reachable view may run
    rel: str
    content: str


def _strip_debug(text: str) -> str:
    """`text` with each `#if DEBUG` branch blanked (newlines kept); its `#else` stays."""
    out: list[str] = []
    stack: list[list[bool]] = []  # [is a DEBUG condition, in its DEBUG branch]
    for line in text.split("\n"):
        word = line.strip()
        blank = any(debug and inside for debug, inside in stack)
        if word.startswith("#if"):
            debug = bool(re.match(r"#if\s+DEBUG\b", word))
            stack.append([debug, debug])
            blank = blank or debug
        elif word.startswith(("#elseif", "#else")) and stack:
            stack[-1][1] = False
            blank = any(debug and inside for debug, inside in stack[:-1])
        elif word.startswith("#endif") and stack:
            stack.pop()
            blank = any(debug and inside for debug, inside in stack)
        out.append("" if blank else line)
    return "\n".join(out)


def _strip_previews(text: str) -> str:
    """`text` with each `#Preview { ... }` blanked."""
    chars = list(text)
    for m in _PREVIEW.finditer(text):
        i = m.end()
        while i < len(text) and text[i] in " \t":
            i += 1
        if i < len(text) and text[i] == "(":
            i = close_of(text, i, len(text)) + 1
        brace = text.find("{", i)
        if brace < 0 or text[i:brace].strip():
            continue
        end = close_of(text, brace, len(text))
        for k in range(m.start(), min(end + 1, len(chars))):
            if chars[k] != "\n":
                chars[k] = " "
    return "".join(chars)


def _skip_ws(s: str, i: int) -> int:
    while i < len(s) and s[i] in " \t\r\n":
        i += 1
    return i


def _skip_expr(s: str, i: int) -> int:
    """The end of the expression starting at `i`: a name, its arguments, its trailing closures
    (`label: { ... }` too) and the modifiers chained after it."""
    m = re.compile(r"[A-Za-z_$][\w.$]*").match(s, i)
    if not m:
        return i
    i = m.end()
    while True:
        j = _skip_ws(s, i)
        if j < len(s) and s[j] in "({" and "\n" not in s[i:j]:
            i = close_of(s, j, len(s)) + 1
            continue
        lm = re.compile(r"(\w+)\s*:\s*\{").match(s, j)
        if lm and lm.group(1) not in _KEYWORD:
            i = close_of(s, lm.end() - 1, len(s)) + 1
            continue
        mm = re.compile(r"\.\s*[A-Za-z_]\w*").match(s, j)
        if mm:
            i = mm.end()
            continue
        return i


def _closure_after(s: str, i: int) -> str | None:
    """The text inside the trailing closure that starts at or after `i` (only spaces between)."""
    j = _skip_ws(s, i)
    if j < len(s) and s[j] == "{":
        return s[j + 1: close_of(s, j, len(s))]
    return None


def _branches(s: str) -> list[str] | None:
    """The branches of the `if` chain or `switch` that `s` starts with, else None."""
    s = s.lstrip()
    if re.match(r"if\b", s):
        out = []
        i = 0
        while True:
            depth, j = 0, i + 2
            while j < len(s):
                c = s[j]
                if c in "([":
                    depth += 1
                elif c in ")]":
                    depth -= 1
                elif c == "{" and depth <= 0:
                    break
                j += 1
            if j >= len(s):
                return out or None
            close = close_of(s, j, len(s))
            out.append(s[j + 1: close])
            k = _skip_ws(s, close + 1)
            if not s.startswith("else", k):
                return out
            k = _skip_ws(s, k + 4)
            if s.startswith("if", k) and not re.match(r"\w", s[k + 2: k + 3]):
                i = k
                continue
            if k < len(s) and s[k] == "{":
                out.append(s[k + 1: close_of(s, k, len(s))])
            return out
    m = re.match(r"switch\b[^{]*\{", s)
    if m:
        block = s[m.end(): close_of(s, m.end() - 1, len(s))]
        return _cases(block)
    return None


def _cases(block: str) -> list[str]:
    """The statements of each `case` (and `default`) of a switch block."""
    starts: list[int] = []
    depth = 0
    i = 0
    while i < len(block):
        c = block[i]
        if c in "({[":
            depth += 1
        elif c in ")}]":
            depth -= 1
        elif depth == 0 and (block.startswith("case", i) or block.startswith("default", i)) and (i == 0 or not (block[i - 1].isalnum() or block[i - 1] in "_.")):
            # The label ends at its first `:` outside brackets.
            j, d = i, 0
            while j < len(block):
                if block[j] in "([":
                    d += 1
                elif block[j] in ")]":
                    d -= 1
                elif block[j] == ":" and d == 0:
                    break
                j += 1
            starts.append(j + 1)
            i = j
        i += 1
    out = []
    for n, start in enumerate(starts):
        end = len(block) if n + 1 == len(starts) else block.rfind("\n", 0, starts[n + 1])
        out.append(block[start: max(start, end)])
    return out


class _Reader:
    def __init__(self, repo: Repo):
        self.types: list[_Type] = []
        self.texts: dict[str, str] = {}
        self.views: dict[str, _Type] = {}
        self.modifiers: set[str] = set()
        self.apps: list[_Type] = []
        self.members: dict[str, list[tuple[str, str]]] = {}  # name -> [(owner, body)]
        for rel, raw in repo.sources("swift"):
            if "Tests/" in rel or rel.endswith("Tests.swift"):
                continue
            text = _strip_previews(_strip_debug(scanned(repo, rel, raw, "swift")[0]))
            self.texts[rel] = text
            for m in _TYPE.finditer(text):
                brace = m.end() - 1
                end = close_of(text, brace, len(text))
                rest = re.sub(r"\bwhere\b.*", "", m.group(3) or "", flags=re.DOTALL)
                tokens = set(re.findall(r"[A-Za-z_]\w*", re.sub(r"<[^<>]*>", "", rest)))
                kind, name = m.group(1), m.group(2).split(".")[-1]
                at = (brace, end, m.start())
                if "PreviewProvider" in tokens:
                    t = _Type("preview", name, rel, *at)
                elif kind == "struct" and "View" in tokens:
                    t = _Type("view", name, rel, *at)
                    self.views.setdefault(name, t)
                elif kind == "struct" and "ViewModifier" in tokens:
                    t = _Type("modifier", name, rel, *at)
                    self.modifiers.add(name)
                elif kind == "struct" and "App" in tokens:
                    t = _Type("app", name, rel, *at)
                    self.apps.append(t)
                elif kind == "extension":
                    t = _Type("extension", name, rel, *at)
                else:
                    t = _Type("global", name, rel, *at)
                self.types.append(t)
        # Extensions of a declared view are that view's code; of `View` or anything else, global.
        for t in self.types:
            if t.kind == "extension":
                t.kind = "view" if t.name in self.views else "global"
        self.by_file: dict[str, list[_Type]] = {}
        for t in self.types:
            self.by_file.setdefault(t.rel, []).append(t)
        for rel, text in self.texts.items():
            for m in _MEMBER.finditer(text):
                if m.group(1) == "body":
                    continue
                brace = m.end() - 1
                self.members.setdefault(m.group(1), []).append((self.owner(rel, m.start()), text[brace + 1: close_of(text, brace, len(text))]))
        self._shells: dict[str, list[str] | None] = {}

    # ----- where code is -----

    def owner(self, rel: str, offset: int) -> str:
        """The view whose code holds `offset` ("" for code no one view owns, "-" for a preview)."""
        best: _Type | None = None
        for t in self.by_file.get(rel, ()):
            if t.start <= offset <= t.end and (best is None or t.end - t.start < best.end - best.start):
                best = t
        if best is None:
            return ""
        if best.kind == "preview":
            return "-"
        return best.name if best.kind in ("view", "modifier") else ""

    def body_of(self, name: str) -> str | None:
        t = self.views.get(name)
        if t is None:
            return None
        text = self.texts[t.rel]
        m = _BODY.search(text, t.start, t.end)
        if not m:
            return None
        return text[m.end(): close_of(text, m.end() - 1, len(text))]

    def code_of(self, name: str) -> list[str]:
        """A view's own code: its declaration and its extensions."""
        return [self.texts[t.rel][t.start: t.end + 1] for t in self.types if t.name == name and t.kind == "view"]

    # ----- what a content shows -----

    def resolve(self, content: str, owner: str = "", depth: int = 0, root: int = 0) -> list[str]:
        """The declared views a presented, tab or root content is: past the containers and the
        views that only wrap another, through each branch of the content, and through the
        view-building members it calls (`stepView(for:)`, `detail`). On the app's root chain
        also past the shells that only choose between views: the scene's own view (`root` 2) and,
        after it, one named as the app's root (`root` 1). Empty when the content is laid out
        inline."""
        if depth > MAX_DEPTH:
            return []
        s = _PARAMS.sub("", _DIRECTIVE.sub("", content), count=1).strip()
        s = re.sub(r"^(?:return|try|await)\b\s*", "", s)
        if s.startswith("{"):
            s = s[1: close_of(s, 0, len(s))].strip()
        branches = _branches(s)
        if branches is not None:
            return _union(self.resolve(b, owner, depth + 1, root) for b in branches)
        m = re.match(r"([A-Za-z_$][\w.$]*)", s)
        if not m:
            return []
        parts = [p for p in m.group(1).split(".") if p]
        if parts[0] == "SwiftUI" and len(parts) > 1:
            parts = parts[1:]
        head = parts[0]
        after = s[m.end():]
        if head in self.views:
            return self._view(head, after, owner, depth, root)
        if head in PASS_THROUGH:
            inner = self._inner(after)
            return self.resolve(inner, owner, depth + 1, root) if inner is not None else []
        if head[:1].islower() or head[:1] == "$":
            # A member that builds the view: `stepView(for: step)`, `detail`, `route.destination`.
            return self._member(parts[-1], owner, depth, root)
        return []

    def _inner(self, after: str) -> str | None:
        """The content a container wraps: its trailing closure, else its argument."""
        j = _skip_ws(after, 0)
        if j < len(after) and after[j] == "(":
            close = close_of(after, j, len(after))
            closure = _closure_after(after, close + 1)
            if closure is not None:
                return closure
            return after[j + 1: close]
        return _closure_after(after, j)

    def _view(self, name: str, after: str, owner: str, depth: int, root: int) -> list[str]:
        if WRAPPER.search(name):
            # `ZoomNamespaceHost { NavigationStack { AdminPropertiesView() } }`: what it wraps.
            j = _skip_ws(after, 0)
            if after.startswith("(", j):
                j = close_of(after, j, len(after)) + 1
            inner = _closure_after(after, j)
            got = self.resolve(inner, owner, depth + 1, root) if inner is not None else []
            if got:
                return got
        shell = self.shell(name)
        # A shell that chooses between views is followed only on the root chain, and only the
        # scene's own view or one named as the app's root (`RootView`, `AppFlowView`): elsewhere
        # a choice is a flow switching its steps in place, which is one screen.
        if shell and len(shell) == 1:
            return self.resolve(f"{shell[0]}()", name, depth + 1, root)
        if shell and (root == 2 or (root and ROOT_SHELL.match(name))):
            return _union(self.resolve(f"{v}()", name, depth + 1, 1) for v in shell)
        return [] if WRAPPER.search(name) else [name]

    def _member(self, member: str, owner: str, depth: int, root: int) -> list[str]:
        found = self.members.get(member) or []
        mine = [body for who, body in found if who == owner] or ([body for _, body in found] if len(found) <= 2 else [])
        return _union(self.resolve(body, owner, depth + 1, root) for body in mine)

    def shell(self, name: str) -> list[str] | None:
        """The views a shell's body only chooses between or wraps (`RootView`: onboarding or the
        tabs; `TodayTabView`: the dashboard), or None when the view lays something out itself."""
        if name in self._shells:
            return self._shells[name]
        self._shells[name] = None  # a view that holds itself is no shell
        body = self.body_of(name)
        got = self._strict(body, 0) if body is not None else None
        self._shells[name] = got if got and name not in got else None
        return self._shells[name]

    def _strict(self, s: str, depth: int) -> list[str] | None:
        """The views `s` only wraps or chooses between, [] when it shows nothing of the app's own
        (a `ProgressView` while it loads), None when it lays anything out."""
        if depth > MAX_DEPTH:
            return None
        s = _DIRECTIVE.sub("", s).strip()
        # Local bindings ahead of the view (`@Bindable var auth = container.auth`).
        while True:
            lead = re.match(r"(?:@\w+\s+)?(?:let|var)\s+\w+[^\n]*\n", s)
            if not lead:
                break
            s = s[lead.end():].lstrip()
        s = re.sub(r"^return\b\s*", "", s)
        branches = _branches(s)
        if branches is not None:
            out: list[str] = []
            for b in branches:
                got = self._strict(b, depth + 1)
                if got is None:
                    return None
                out += [v for v in got if v not in out]
            return out or None
        m = re.match(r"(?:SwiftUI\.)?([A-Za-z_]\w*)", s)
        if not m or s[_skip_expr(s, 0):].strip():
            return None  # nothing, or more than one view side by side
        name = m.group(1)
        if name in NOTHING:
            return []
        if name in PASS_THROUGH:
            inner = self._inner(s[m.end():])
            return self._strict(inner, depth + 1) if inner is not None else None
        if name in self.views:
            if WRAPPER.search(name):
                j = _skip_ws(s, m.end())
                if s.startswith("(", j):
                    j = close_of(s, j, len(s)) + 1
                inner = _closure_after(s, j)
                if inner is not None:
                    return self._strict(inner, depth + 1)
            return [name]
        return None

    # ----- tab bars -----

    def tab_bars(self) -> set[str]:
        """Views whose code holds a tab bar: a `TabView` with `Tab`s or `.tabItem`s (a paging
        `TabView` is no tab bar)."""
        out = set()
        for name in self.views:
            for code in self.code_of(name):
                for m in _TAB_VIEW.finditer(code):
                    inner = self._inner(code[m.end():])
                    if inner and (_TAB.search(inner) or _TAB_ITEM.search(inner)):
                        out.add(name)
        return out

    def tab_sites(self, name: str) -> list[_Site]:
        """The tabs of a tab bar view: each `Tab`'s content, each view a `.tabItem` is on, each
        case of a `switch` on the selected tab."""
        t = self.views[name]
        out: list[_Site] = []
        for code in self.code_of(name):
            for m in _TAB.finditer(code):
                close = close_of(code, m.end() - 1, len(code))
                content = _closure_after(code, close + 1)
                if content is not None:
                    out.append(_Site("tab", name, t.rel, content))
            for m in _TAB_ITEM.finditer(code):
                start = _statement_start(code, m.start())
                out.append(_Site("tab", name, t.rel, code[start: m.start()]))
            for m in _TAB_SWITCH.finditer(code):
                block = code[m.end(): close_of(code, m.end() - 1, len(code))]
                out += [_Site("tab", name, t.rel, case) for case in _cases(block)]
        return out

    # ----- the sites -----

    def sites(self) -> list[_Site]:
        out: list[_Site] = []
        for rel, text in self.texts.items():
            for m in _SCENE.finditer(text):
                i = m.end()
                if text.startswith("(", i):
                    i = close_of(text, i, len(text)) + 1
                content = _closure_after(text, i)
                if content is not None:
                    out.append(_Site("root", self.owner(rel, m.start()), rel, content))
            for m in _PRESENTER.finditer(text):
                owner = self.owner(rel, m.start())
                if owner == "-":
                    continue
                content = _presented(text, m)
                if content:
                    out.append(_Site("present", owner, rel, content))
        return out

    def edges(self) -> dict[str, set[str]]:
        """{owner: the views and view modifiers its code instantiates}; "" for global code."""
        out: dict[str, set[str]] = {}
        known = set(self.views) | self.modifiers
        for rel, text in self.texts.items():
            for m in _CALL.finditer(text):
                if m.group(1) in known and not _DECLARED_AT.search(text[max(0, m.start() - 24): m.start()]):
                    owner = self.owner(rel, m.start())
                    if owner != "-":
                        out.setdefault(owner, set()).add(m.group(1))
        return out


def _union(lists: Iterable[list[str]]) -> list[str]:
    out: list[str] = []
    for got in lists:
        out += [v for v in got if v not in out]
    return out


def _statement_start(code: str, at: int) -> int:
    """Where the statement holding `at` begins: the first line at the same bracket depth that
    is not a chained modifier."""
    depth_at = 0
    depths = []
    d = 0
    for c in code[:at]:
        depths.append(d)
        if c in "({[":
            d += 1
        elif c in ")}]":
            d -= 1
    depth_at = d
    i = at
    while i > 0:
        nl = code.rfind("\n", 0, i)
        if nl < 0:
            return 0
        if depths[nl] == depth_at and nl + 1 < at:
            rest = code[nl + 1: at].lstrip()
            if rest and not rest.startswith("."):
                return nl + 1
        if depths[nl] < depth_at:
            return nl + 1
        i = nl
    return 0


def _presented(text: str, m: re.Match[str]) -> str:
    """What one presenter shows: a sheet's content closure (or `content:` argument), a link's
    destination, a hosting controller's root view."""
    i = m.end()
    if m.group(3):  # UIHostingController(rootView: ...)
        close = close_of(text, i - 1, len(text))
        args = text[i: close]
        return args.split("rootView:", 1)[1] if "rootView:" in args else ""
    link = bool(m.group(2))
    args = ""
    if text.startswith("(", i):
        close = close_of(text, i, len(text))
        args = text[i + 1: close]
        i = close + 1
    for label in ("destination:", "content:"):
        if label in args:
            given = args.split(label, 1)[1].strip()
            return given[1: close_of(given, 0, len(given))] if given.startswith("{") else given
    if link and "value:" in args:
        return ""  # its destination is a `.navigationDestination`
    return _closure_after(text, i) or ""


def navigable(repo: Repo) -> Navigable | None:
    """The SwiftUI views that are screens in `repo` (see the module docstring), or None when its
    Swift code has nothing to judge them by (no root, no tab bar, nothing presented)."""
    r = _Reader(repo)
    if not r.views:
        return None
    sites = r.sites()
    bars = r.tab_bars()
    for name in bars:
        sites += r.tab_sites(name)
    if not sites:
        return None
    roots = [s for s in sites if s.kind == "root"]
    edges = r.edges()
    # Only what the app reaches counts, when its root is known: global code (extensions of
    # `View`, the app, enums and classes) runs, and so does every view it instantiates.
    reach: set[str] | None = None
    if roots:
        reach = {""}
        todo = [""]
        while todo:
            for nxt in edges.get(todo.pop(), ()):
                if nxt not in reach:
                    reach.add(nxt)
                    todo.append(nxt)
    names: set[str] = set()
    tabs: dict[str, list[str]] = {}
    for site in sites:
        if reach is not None and site.owner not in reach:
            continue
        for name in r.resolve(site.content, site.owner, root=2 if site.kind == "root" else 0):
            if name in bars:
                continue
            if site.kind == "tab" and name not in tabs.setdefault(site.owner, []):
                tabs[site.owner].append(name)
            if site.kind == "present" and NOT_A_SCREEN.search(name):
                continue
            if site.kind == "root" and PLACEHOLDER.search(name):
                continue
            names.add(name)
    if not names and roots:
        return None
    declared = {name: (t.rel, fm._line(r.texts[t.rel], t.decl)) for name, t in r.views.items()}
    shells = {t.rel for t in r.types if t.kind == "view" and t.name in bars}
    bar_tabs = [(*declared[bar], found) for bar, found in tabs.items() if len(found) > 1]
    made = {v for owner, got in edges.items() if owner != "-" for v in got if v != owner}
    return Navigable(names, declared, bars, shells, bar_tabs, rooted=bool(roots), instantiated=made)
