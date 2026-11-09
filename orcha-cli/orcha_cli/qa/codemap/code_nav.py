"""Navigation edges from code (adapted from `app_map/code_nav.py`): which screen's code moves
the user to which screen, and the action's visible label when the code spells it.

- SwiftUI: `NavigationLink(destination: X())`, `NavigationLink { X() }`, the content of
  `.navigationDestination`, `.sheet`, `.fullScreenCover` and `.popover`, and the tabs of a
  `TabView` (`X().tabItem { ... }`, `Tab("Home", ...) { X() }`);
- UIKit: `pushViewController(...)` and `present(...)` of a controller, by class or by the
  variable holding one;
- Expo Router and React Native: `router.push/replace`, `<Link href>`, `redirect()`, `href:` in a menu
  config, react-router `navigate("/x")`, with `${id}` and `"/x/" + id` as `*`;
- React Navigation: `navigation.navigate("Name")`;
- Compose: `navController.navigate("route")`, a route constant (`Screen.Detail.route`,
  `Screen.Detail.createRoute(id)`) or a typed route (`navigate(ListingDetail(id))`);
- Android: `Intent(this, XActivity::class.java)`, `XActivity.class`;
- Flutter: `Navigator.pushNamed(context, Routes.x)`, `Navigator.push(..., MaterialPageRoute(
  builder: (_) => X()))`, GoRouter `context.go/push`, GetX `Get.to/toNamed`, auto_route
  `router.push(XRoute())` and a screen's tabs (`code_dart.nav`).

A call is attributed to the screen whose code holds it (`Repo.screens_of`); a call in no screen's
code, or to a target that is not a declared screen, is skipped, so every edge joins two nodes.

Also here: `compose_constant_screens`, the Compose destinations declared with a route constant
(`composable(Screen.Home.route)`, `dialog(...)` too), which `feature_map` only reads as string
literals, and `compose_sheet_screens`, the composable a `ModalBottomSheet` shows (#467).
"""

from __future__ import annotations

import re

from orcha_cli.qa.codemap import features as fm
from orcha_cli.qa.codemap import code_dart
from orcha_cli.qa.codemap.code import CodeNav, Repo, close_of, line_at, string_arg, string_expr

LABEL_WINDOW = 250

# ---------- labels ----------

_JSX_TEXT = re.compile(r"(?<![=\-])>([^<>{}]*)<")
_JSX_ATTR_LABEL = re.compile(r"\b(?:title|label|aria-label|accessibilityLabel)\s*=\s*[\"']([^\"']+)[\"']")
_OBJ_LABEL = re.compile(r"\b(?:label|title|name|text)\s*:\s*[\"'`]([^\"'`]+)[\"'`]")
_SWIFT_LABEL = re.compile(r"\b(?:Text|Label|Button)\s*\(\s*\"([^\"\\]+)\"")
_KOTLIN_LABEL = re.compile(r"\bText\s*\(\s*(?:text\s*=\s*)?\"([^\"$]+)\"")


def _clean(raw: str | None) -> str | None:
    text = " ".join((raw or "").split())
    if not text or len(text) > 40 or not re.search(r"[A-Za-z]", text) or re.search(r"[=;{}()<>|&]|://", text):
        return None
    return text


def _first(regex: re.Pattern[str], text: str) -> str | None:
    for m in regex.finditer(text):
        label = _clean(m.group(1))
        if label:
            return label
    return None


def _last(regex: re.Pattern[str], text: str) -> str | None:
    labels = [m.group(1) for m in regex.finditer(text)]
    for raw in reversed(labels):
        label = _clean(raw)
        if label:
            return label
    return None


# ---------- constants ----------

_KT_OBJECT_ROUTE = re.compile(r"\bobject\s+(\w+)\s*:\s*\w+\s*\(\s*(?:route\s*=\s*)?\"([^\"]*)\"")
_KT_VAL = re.compile(r"\b(?:const\s+)?val\s+(\w+)\s*(?::\s*String)?\s*=\s*\"([^\"$]*)\"")
_JS_CONST = re.compile(r"\b([A-Z][A-Z0-9_]{2,})\s*[:=]\s*[\"'`]([^\"'`$\n]*)[\"'`]")
#: Members of a route chain that name the route, not the destination (`Screen.Home.route`).
_ROUTE_MEMBERS = frozenset({"route", "createRoute", "name", "path", "invoke", "routeName", "value"})


def constants(repo: Repo, lang: str) -> dict[str, str]:
    """{name: string} for the simple string constants of one language (Kotlin route objects and
    `val`s, JS `UPPER_CASE` keys and consts); a name with two different values is dropped."""
    if lang in repo.consts:
        return repo.consts[lang]
    seen: dict[str, set[str]] = {}
    regexes = (_KT_OBJECT_ROUTE, _KT_VAL) if lang == "kotlin" else (_JS_CONST,)
    for _, text in repo.sources(lang):
        for regex in regexes:
            for m in regex.finditer(text):
                seen.setdefault(m.group(1), set()).add(m.group(2))
    out = {k: next(iter(v)) for k, v in seen.items() if len(v) == 1 and k not in _ROUTE_MEMBERS}
    repo.consts[lang] = out
    return out


def _resolve_chain(chain: str, consts: dict[str, str]) -> str | None:
    """`Screen.Detail.createRoute(id)` / `Routes.HOME` -> the constant's string, or None."""
    names = re.findall(r"[A-Za-z_]\w*", re.sub(r"\([^()]*\)", "", chain))
    for name in reversed(names):
        if name in _ROUTE_MEMBERS:
            continue
        if name in consts:
            return consts[name]
    return None


# ---------- Compose destinations declared by constant ----------

_COMPOSE_CONST = re.compile(r"\b(?:composable|dialog|bottomSheet)\s*\(\s*(?:route\s*=\s*)?((?:[A-Z]\w*\.)+\w+|[A-Z][A-Z0-9_]+)\b")


def compose_constant_screens(repo: Repo) -> list[fm.Screen]:
    consts = constants(repo, "kotlin")
    out: list[fm.Screen] = []
    for rel, text in repo.sources("kotlin"):
        if "composable" not in text:
            continue
        for m in _COMPOSE_CONST.finditer(text):
            route = _resolve_chain(m.group(1), consts)
            if not route:
                continue
            route = route.split("?")[0]
            segs = [s for s in route.split("/") if s]
            group = next((s for s in segs if not s.startswith("{")), "")
            kind = "detail" if any(s.startswith("{") for s in segs) else "overview"
            out.append(fm.Screen(group or "home", kind, route, rel, "compose", rel, line_at(text, m.start())))
    return out


# ---------- Compose bottom sheets ----------

_COMPOSE_SHEET = re.compile(r"\bModalBottomSheet\s*\(")
_KT_CALL = re.compile(r"\s*([A-Z]\w*)\s*\(")


def compose_sheet_screens(repo: Repo) -> list[fm.Screen]:
    """Compose's counterpart of a SwiftUI sheet (`code_swift`): the composable a
    `ModalBottomSheet` shows when its whole content is one the repo declares
    (`ModalBottomSheet(...) { AddEntryBottomSheet(...) }`). A sheet laid out inline
    (`{ Column { ... } }`) is part of the screen that opens it, as on iOS; an alert is no screen
    on either."""
    declared = repo.declared()
    out: list[fm.Screen] = []
    seen: set[str] = set()
    for rel, text in repo.sources("kotlin"):
        if "ModalBottomSheet" not in text:
            continue
        for m in _COMPOSE_SHEET.finditer(text):
            close = close_of(text, m.end() - 1)
            brace = re.match(r"\s*\{", text[close + 1:])
            if not brace:
                continue
            start = close + 1 + brace.end() - 1
            body = text[start + 1: close_of(text, start)]
            call = _KT_CALL.match(body)
            if not call or call.group(1) in seen or not any(f.endswith(".kt") for f in declared.get(call.group(1), ())):
                continue
            end = close_of(body, call.end() - 1) + 1
            lam = re.match(r"\s*\{", body[end:])
            if lam:
                end = close_of(body, end + lam.end() - 1) + 1
            if body[end:].strip():
                continue  # more than one thing in the sheet: laid out inline
            seen.add(call.group(1))
            out.append(fm.Screen(call.group(1), "overview", call.group(1), rel, "compose", rel, line_at(text, m.start())))
    return out


# ---------- JS / TS (Expo Router, React Navigation) ----------

_JS_CALL = re.compile(r"\b(router|Router|navigation|navigator|nav|history)\s*(?:\?\.|\.)\s*(push|replace|navigate)\s*\(\s*|(?<![.\w])(navigate|redirect|permanentRedirect)\s*\(\s*(?=[\"'`{])")
_JS_LINK = re.compile(r"<(Link|NavLink|Redirect|a)\b[^>]*?\b(?:href|to)\s*=\s*\{?\s*")
_JS_HREF = re.compile(r"\bhref\s*:\s*(?=[\"'`])")
_JS_OBJ_TARGET = re.compile(r"\b(pathname|name|screen)\s*:\s*")


def _js_target(repo: Repo, rel: str, text: str, pos: int, by_name: bool) -> tuple[str | None, int]:
    """(screen key, end of the argument) for the navigation argument at `pos`."""
    consts = constants(repo, "js")
    if text.startswith("{", pos):
        end = close_of(text, pos)
        m = _JS_OBJ_TARGET.search(text, pos, end)
        if not m:
            return None, end
        by_name = m.group(1) != "pathname"
        pos = m.end()
    path, end = string_expr(text, pos, "js", consts)
    if not path:
        return None, end
    if path.startswith("/") or path.startswith("http"):
        return repo.route_key(path, rel), end
    if by_name and "\x00" not in path:
        return repo.name_key(path), end
    return None, end


def _js(repo: Repo, rel: str, text: str) -> list[CodeNav]:
    out: list[CodeNav] = []

    def add(at: int, target: str | None, label: str | None) -> None:
        if not target:
            return
        line = line_at(text, at)
        for src in repo.screens_of(rel, line):
            if src != target:
                out.append(CodeNav(src, target, label or f"Open {repo.screens[target].name}", rel, line))

    for m in _JS_CALL.finditer(text):
        by_name = m.group(1) in ("navigation", "navigator", "nav")  # React Navigation names screens
        target, end = _js_target(repo, rel, text, m.end(), by_name)
        if not target:
            continue
        after = text[end: end + LABEL_WINDOW]
        stop = re.search(r"\b(?:router|navigation|navigate|onPress|onClick)\b", after)
        label = _first(_JSX_TEXT, after[: stop.start()] if stop else after) or _last(_JSX_ATTR_LABEL, text[max(0, m.start() - LABEL_WINDOW): m.start()])
        add(m.start(), target, label)
    for m in _JS_LINK.finditer(text):
        target, end = _js_target(repo, rel, text, m.end(), False)
        if not target:
            continue
        close = text.find("</" + m.group(1), end)
        inner = text[end: close if 0 <= close < end + 600 else end + 300]
        add(m.start(), target, _first(_JSX_TEXT, inner + "<") or _first(_JSX_ATTR_LABEL, text[m.start(): end + 200]))
    for m in _JS_HREF.finditer(text):
        target, _ = _js_target(repo, rel, text, m.end(), False)
        if target:
            near = text[max(0, m.start() - 150): m.end() + 150]
            add(m.start(), target, _first(_OBJ_LABEL, near))
    return out


# ---------- Swift (SwiftUI, UIKit) ----------

_NAV_LINK = re.compile(r"\bNavigationLink\s*(?=[({])")
_PRESENTED = re.compile(r"\.(navigationDestination|sheet|fullScreenCover|popover)\s*(?=[({])")
_TAB_ITEM = re.compile(r"\.tabItem\s*\{")
_TAB = re.compile(r"(?<![.\w])Tab\s*\(")
_SWIFT_CALL = re.compile(r"\b([A-Z]\w*)\s*[({]")  # `X(...)` or a trailing closure alone, `OnboardingView { ... }`
_UIKIT = re.compile(r"\b(pushViewController|present|show|setViewControllers)\s*\(\s*")
_SWIFT_VAR = re.compile(r"\b(?:let|var)\s+(\w+)\s*(?::\s*([A-Z]\w*))?\s*=\s*(?:[^\n]*?\bas[!?]\s*([A-Z]\w*)|([A-Z]\w*)\s*\()")


def _swift_screens_in(repo: Repo, text: str) -> list[str]:
    """Declared screens instantiated in `text`, in order."""
    out = []
    for m in _SWIFT_CALL.finditer(text):
        key = repo.name_key(m.group(1))
        if key and key not in out:
            out.append(key)
    return out


def _swift(repo: Repo, rel: str, text: str) -> list[CodeNav]:
    out: list[CodeNav] = []

    def add(at: int, targets: list[str], label: str | None, verb: str = "Open") -> None:
        line = line_at(text, at)
        for target in targets:
            for src in repo.screens_of(rel, line):
                if src != target:
                    out.append(CodeNav(src, target, label or f"{verb} {repo.screens[target].name}", rel, line))

    for m in _NAV_LINK.finditer(text):
        i = m.end()
        args = ""
        if text.startswith("(", i):
            close = close_of(text, i)
            args = text[i + 1: close]
            i = close + 1
        if "destination:" in args:
            targets = _swift_screens_in(repo, args.split("destination:", 1)[1])[:1]
        else:
            brace = re.match(r"\s*\{", text[i:])
            if not brace or "value:" in args:
                continue  # NavigationLink(value:): its destination is a `.navigationDestination`
            start = i + brace.end() - 1
            targets = _swift_screens_in(repo, text[start: close_of(text, start)])[:1]
        title = re.match(r"\s*\"([^\"\\]+)\"", args)
        label = _clean(title.group(1)) if title else _first(_SWIFT_LABEL, text[i: i + LABEL_WINDOW + 200])
        add(m.start(), targets, label)
    for m in _PRESENTED.finditer(text):
        i = m.end()
        body = ""
        if text.startswith("(", i):
            close = close_of(text, i)
            args = text[i + 1: close]
            if "destination:" in args or "content:" in args:
                body = args
            i = close + 1
        brace = re.match(r"\s*\{", text[i:])
        if brace:
            start = i + brace.end() - 1
            body += text[start: close_of(text, start)]
        add(m.start(), _swift_screens_in(repo, body), None)
    if "TabView" in text:
        for m in _TAB.finditer(text):
            # iOS 18 `Tab("Home", systemImage: ..., value: ...) { RootView() }`.
            close = close_of(text, m.end() - 1)
            brace = re.match(r"\s*\{", text[close + 1:])
            if not brace:
                continue
            start = close + 1 + brace.end() - 1
            title = re.match(r"\s*\"([^\"\\]+)\"", text[m.end():])
            tab = _clean(title.group(1)) if title else None
            add(m.start(), _swift_screens_in(repo, text[start: close_of(text, start)])[:1], f"{tab} tab" if tab else None, "Tab")
        for m in _TAB_ITEM.finditer(text):
            before = _swift_screens_in(repo, text[max(0, m.start() - 400): m.start()])
            if before:
                tab = _first(_SWIFT_LABEL, text[m.end(): close_of(text, m.end() - 1)])
                add(m.start(), before[-1:], f"{tab} tab" if tab else None, "Tab")
    if "UIViewController" in text or "pushViewController" in text or "present(" in text:
        variables: dict[str, str] = {}
        for v in _SWIFT_VAR.finditer(text):
            cls = v.group(3) or v.group(4) or v.group(2)
            if cls and repo.name_key(cls):
                variables[v.group(1)] = cls
        for m in _UIKIT.finditer(text):
            open_at = text.rfind("(", 0, m.end())
            args = text[open_at + 1: close_of(text, open_at)]
            targets = _swift_screens_in(repo, args)
            if not targets:
                for name in re.findall(r"\b([a-z_]\w*)\b", args):
                    if name in variables:
                        targets = [repo.name_key(variables[name]) or ""]
                        break
            add(m.start(), [t for t in targets[:1] if t], None)
    return out


# ---------- Kotlin / Java (Compose, Android) ----------

_KT_NAVIGATE = re.compile(r"\b(?:\w*[nN]avController|navigator|navHostController|findNavController\(\))\s*(?:\?\.|\.)\s*navigate\s*\(\s*")
_INTENT = re.compile(r"\bIntent\s*\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*([A-Z]\w*)(?:::class\.java|\.class)\s*\)|\bstartActivity<\s*([A-Z]\w*)\s*>")


def _kotlin(repo: Repo, rel: str, text: str) -> list[CodeNav]:
    out: list[CodeNav] = []
    consts = constants(repo, "kotlin")

    def add(at: int, target: str | None, end: int) -> None:
        if not target:
            return
        line = line_at(text, at)
        after = text[end: end + LABEL_WINDOW]
        label = _first(_KOTLIN_LABEL, after) or _last(_KOTLIN_LABEL, text[max(0, at - LABEL_WINDOW): at])
        for src in repo.screens_of(rel, line):
            if src != target:
                out.append(CodeNav(src, target, label or f"Open {repo.screens[target].name}", rel, line))

    for m in _KT_NAVIGATE.finditer(text):
        i = m.end()
        target = None
        if text.startswith('"', i):
            path = string_arg(text, i, "kotlin", consts)
            target = repo.route_key(path, rel) if path else None
        else:
            chain = re.match(r"[A-Za-z_][\w.]*(?:\([^()]*\))?(?:\.\w+)*", text[i:])
            if chain:
                route = _resolve_chain(chain.group(0), consts)
                if route:
                    target = repo.route_key(route.split("?")[0], rel)
                else:
                    head = re.match(r"([A-Z]\w*)\s*\(", chain.group(0))
                    target = repo.name_key(head.group(1)) if head else None
        add(m.start(), target, close_of(text, m.end() - 1) + 1)
    for m in _INTENT.finditer(text):
        add(m.start(), repo.name_key(m.group(1) or m.group(2)), m.end())
    return out


def read(repo: Repo) -> list[CodeNav]:
    """Every navigation edge the repo's code declares between two declared screens."""
    out: list[CodeNav] = []
    for rel, text in repo.sources():
        if rel.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")):
            if any(k in text for k in ("router", "navigat", "href", "redirect", "Link", "history")):
                out += _js(repo, rel, text)
        elif rel.endswith(".swift"):
            out += _swift(repo, rel, text)
        elif rel.endswith((".kt", ".java")):
            if "navigate" in text or "Intent" in text or "startActivity" in text:
                out += _kotlin(repo, rel, text)
        elif rel.endswith(".dart"):
            out += code_dart.nav(repo, rel, CodeNav)
    return out
