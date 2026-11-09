"""What each native screen says on screen, read from its code (docs/app-map.md, "Keys"): the
static UI strings that let a live capture with no route meet the screen that draws it.

A capture of a native app has no URL, only texts and anchors, and most of them are the app's own
words: SwiftUI `Text("Nothing tracked yet.")`, `Button("Add a routine")`, `.navigationTitle(
"Settings")`, an `accessibilityLabel`; Compose `Text("…")`, `stringResource(R.string.x)` resolved
through `res/values/strings.xml`, a `contentDescription`; an XML layout's `android:text`; a JSX
text node; Flutter's literals and localized strings (`code_dart`: `l10n.key` through the app's
English `.arb`, `'key'.tr()` through its `en.json`), an app bar's `title:`. A user's own data (a routine's name, a baby's name) never appears in code, so it
neither helps nor hurts the match.

Each declaration (a Swift type with its extensions, a Kotlin function or class, a JS file) is one
unit with the literals inside it. A screen's texts are its own unit's and those of the units it
renders, up to `code.MAX_HOPS` hops (a row, a card, an empty state, a view model's messages),
stopping at another screen's unit. A string that is a key in `Localizable.strings` /
`.xcstrings` is read as its English value. An interpolated string is a pattern with `*` for each
hole (`"Try \\(name)"` -> `Try *`) when enough of it is literal.

`presented_swift_screens` also finds the SwiftUI views that are presented as screens (a `.sheet`,
`.fullScreenCover`, `.navigationDestination` or `NavigationLink` destination) but are not their
file's primary type (`AddRoutineSheet` beside `RootView`), so a real sheet with its own words is
its own screen instead of part of the one that presents it.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field

from orcha_cli.qa.codemap import features as fm
from orcha_cli.qa.codemap import code_dart
from orcha_cli.qa.codemap.code import HOLE, MAX_HOPS, Repo, _offset_of_line, close_of, lang_of

#: Most texts kept per screen (its own unit's first), and the longest text kept.
MAX_TEXTS = 150
MAX_TEXT_LEN = 120
#: Letters a pattern (an interpolated string) needs outside its holes to say anything.
MIN_PATTERN_LETTERS = 4
#: A unit declared in more files than this is a common name, not one component.
MAX_DECLARED = 3

WILDCARD = "*"

# ---------- what is read ----------


@dataclass(frozen=True)
class ScreenTexts:
    """One screen's static texts: `title` (its navigation title or top app bar title), `texts`
    (patterns use `*` for a hole) and `alerts` (titles of its alerts and confirmation dialogs)."""

    key: str
    title: str | None
    texts: tuple[str, ...]
    alerts: tuple[str, ...] = ()
    own: int = 0  # how many of `texts` (the first ones) are in the screen's own code


@dataclass
class Unit:
    name: str
    rel: str
    lang: str
    texts: list[str] = field(default_factory=list)
    titles: list[str] = field(default_factory=list)
    alerts: list[str] = field(default_factory=list)
    refs: set[str] = field(default_factory=set)


# ---------- string literals ----------


def literals(text: str, lang: str) -> Iterator[tuple[int, int, str]]:
    """(start, end, value) of each string literal in `text`, comments skipped. An interpolation
    (`\\(x)`, `${x}`, `$x`) is `HOLE` in the value; escapes are read (`\\n` is a space)."""
    if lang == "dart":
        yield from code_dart.literals(text)
        return
    for kind, start, end, value in _scan(text, lang):
        if kind == "string":
            yield start, end, value


def code_only(text: str, lang: str) -> str:
    """`text` with its comments and string literals blanked (newlines kept), for reading names."""
    if lang == "dart":
        return code_dart.code_only(text)
    out = list(text)
    for _, start, end, _ in _scan(text, lang):
        for k in range(start, min(end, len(out))):
            if out[k] != "\n":
                out[k] = " "
    return "".join(out)


def scanned(repo: Repo, rel: str, text: str, lang: str) -> tuple[str, list[str]]:
    """`text` with its comments and strings blanked (`code_only`), and its string literals'
    values, read once per file for the readers that need both (`code_swift`, `code_traces`)."""
    key = f"scanned:{rel}"
    if key not in repo.cache:
        out = list(text)
        values: list[str] = []
        for kind, start, end, value in _scan(text, lang):
            for k in range(start, min(end, len(out))):
                if out[k] != "\n":
                    out[k] = " "
            if kind == "string" and value:
                values.append(value)
        repo.cache[key] = ("".join(out), values)
    return repo.cache[key]


def _scan(text: str, lang: str) -> Iterator[tuple[str, int, int, str]]:
    """("comment" | "string", start, end, value) of each comment and string literal."""
    n = len(text)
    i = 0
    quotes = {"js": "\"'`", "swift": '"', "kotlin": '"'}[lang]
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] in "/*":
            k = text.find("\n" if text[i + 1] == "/" else "*/", i + 2)
            end = n if k < 0 else k + (0 if text[i + 1] == "/" else 2)
            yield "comment", i, end, ""
            i = max(end, i + 2)
            continue
        if lang == "kotlin" and c == "'":
            k = text.find("'", i + 1 + (text[i + 1: i + 2] == "\\"))
            i = (k + 1) if 0 <= k - i <= 8 else i + 1  # a char literal
            continue
        if c not in quotes:
            i += 1
            continue
        if text.startswith('"""', i) and lang in ("swift", "kotlin"):
            k = text.find('"""', i + 3)
            end = n if k < 0 else k + 3
            body = text[i + 3: end - 3]
            yield "string", i, end, _interpolate(" ".join(body.split()), lang)
            i = end
            continue
        value, end = _read_string(text, i, lang)
        if end < 0:
            i += 1  # an apostrophe in prose or an unterminated string
            continue
        yield "string", i, end, value
        i = end


def _read_string(text: str, i: int, lang: str) -> tuple[str, int]:
    """The value of the string opening at `text[i]` and the index after it; -1 when it does not
    close on its line (template literals may span lines)."""
    q = text[i]
    n = len(text)
    out: list[str] = []
    j = i + 1
    while j < n:
        c = text[j]
        if c == q:
            return "".join(out), j + 1
        if c == "\n" and q != "`":
            return "", -1
        if c == "\\" and j + 1 < n:
            nxt = text[j + 1]
            if lang == "swift" and nxt == "(":
                j = _skip_balanced(text, j + 1, "(", ")", lang)
                out.append(HOLE)
                continue
            out.append({"n": " ", "t": " ", "r": "", "\\": "\\", '"': '"', "'": "'", "`": "`", "$": "$"}.get(nxt, ""))
            j += 2
            continue
        if c == "$" and (lang == "kotlin" or q == "`"):
            if j + 1 < n and text[j + 1] == "{":
                j = _skip_balanced(text, j + 1, "{", "}", lang)
                out.append(HOLE)
                continue
            if lang == "kotlin":
                m = re.match(r"[A-Za-z_]\w*", text[j + 1: j + 60])
                if m:
                    j += 1 + m.end()
                    out.append(HOLE)
                    continue
        out.append(c)
        j += 1
    return "", -1


def _skip_balanced(text: str, i: int, open_: str, close: str, lang: str) -> int:
    """The index after the bracket that closes `text[i]`, skipping strings inside."""
    depth = 0
    j = i
    n = len(text)
    while j < n:
        c = text[j]
        if c == open_:
            depth += 1
        elif c == close:
            depth -= 1
            if depth == 0:
                return j + 1
        elif c == '"' or (c == "'" and lang == "js"):
            _, end = _read_string(text, j, lang)
            if end > 0:
                j = end
                continue
        elif c == "\n":
            return j
        j += 1
    return n


def _interpolate(value: str, lang: str) -> str:
    if lang == "swift":
        return re.sub(r"\\\((?:[^()]|\([^()]*\))*\)", HOLE, value)
    if lang == "kotlin":
        return re.sub(r"\$\{[^}]*\}|\$[A-Za-z_]\w*", HOLE, value)
    return re.sub(r"\$\{[^}]*\}", HOLE, value)


#: What comes just before a literal that is never shown: a symbol or image name, a storage key, a
#: log line, an identifier, a route, a URL or a date format.
_NOT_SHOWN = re.compile(
    r"(?:\b(?:systemName|systemImage|systemSymbol|imageName|iconName|icon|image|named|forKey|key|Key|identifier|"
    r"accessibilityIdentifier|testTag|tag|route|AppStorage|SceneStorage|Logger|print|debugPrint|NSLog|os_log|"
    r"fatalError|precondition|preconditionFailure|assert|assertionFailure|Image|UIImage|painterResource|Color|"
    r"UIColor|Font|font|custom|URL|url|endpoint|path|dateFormat|format|forResource|withExtension|entityName|"
    r"predicate|NSPredicate|keyPath|subsystem|category|Notification\.Name|forCellReuseIdentifier|"
    r"withIdentifier|navigate|composable|require|import|from|log|warn|error|info|debug|trace|d|e|i|w|v)"
    r"\s*[:=(]\s*|\b(?:Log|Timber|logger|console|os)\s*\.\s*\w+\s*\([^()\n]*|"
    r"\b(?:print|debugPrint|NSLog|os_log|fatalError|println)\s*\([^()\n]*|\bimport\s+|"
    r"[\w)\]]\[\s*|#Preview\s*\(\s*|@\w+\s*\(\s*)$"
)
#: A literal that is a key or code, not words: `house.fill`, `lately.theme`, `snug-calendar`,
#: `selectedTab`, `MAX_COUNT`, a hex colour, a file name.
_KEYLIKE = re.compile(
    r"^(?:[a-z0-9]+(?:[._:/\-][a-z0-9]+)+|\w+(?:[._:/]\w+)+|\w*[a-z][A-Z]\w*(?:-\w+)*|[a-z]+[A-Z]\w*|[A-Z0-9]+_[A-Z0-9_]+|#?[0-9a-fA-F]{6,8}|[\w.\-]+\.(?:png|jpe?g|json|mp3|mp4|svg|ttf|otf|plist|xml|gif|webp|caf|wav))$"
)
_DATE_FORMAT = re.compile(r"^[yMdEHhmsaZzLGQwWk ,.:'/\-]+$")
_FORMAT = re.compile(r"%(?:\d+\$)?(?:l{0,2}[@dfsiuxXeEgGc]|\.\d+f)")
_LETTER = re.compile(r"[^\W\d_]")


def ui_text(raw: str) -> str | None:
    """`raw` as text a user would see, or None when it is a key, code or nothing: whitespace
    collapsed, a format placeholder as a hole, every hole as `*` (one per run of holes), and a
    pattern only when `MIN_PATTERN_LETTERS` of it are literal."""
    value = _FORMAT.sub(HOLE, raw)
    value = " ".join(value.split())
    if not value or len(value) > MAX_TEXT_LEN or "://" in value or value.startswith(("/", "@")):
        return None
    if re.search(r"[{}<>;=]|\\[a-z]", value) or not _LETTER.search(value):
        return None
    plain = value.replace(HOLE, "")
    if " " not in value and (len(value) < 2 or _KEYLIKE.match(value.replace(HOLE, "x")) or value.islower()):
        return None  # a key, a symbol name, an index letter, or a lone lower-case word
    if _DATE_FORMAT.match(value) and re.search(r"yy|MM|dd|HH|hh|mm|EEE|h:", value):
        return None
    if HOLE in value:
        if len(_LETTER.findall(plain)) < MIN_PATTERN_LETTERS:
            return None
        value = re.sub(HOLE + r"+(?:\s*" + HOLE + r")*", WILDCARD, value)
    return value


# ---------- string resources ----------

_ANDROID_STRING = re.compile(r"<string\s+name=\"([^\"]+)\"[^>]*>(.*?)</string>", re.DOTALL)
_APPLE_STRING = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;', re.MULTILINE)


def _android_value(raw: str) -> str:
    raw = re.sub(r"<[^>]+>", "", raw).replace("\\'", "'").replace('\\"', '"').replace("\\n", " ").replace("&amp;", "&")
    raw = raw.replace("&lt;", "<").replace("&gt;", ">").strip().strip('"')
    return _FORMAT.sub(HOLE, raw)


def string_resources(repo: Repo) -> dict[str, dict[str, str]]:
    """`{"android": {name: text}, "apple": {key: English text}}`: the default `res/values`
    strings, and `Localizable.strings` (`en` or `Base`) and `.xcstrings` catalogs."""
    if "string_resources" in repo.cache:
        return repo.cache["string_resources"]
    android: dict[str, str] = {}
    apple: dict[str, str] = {}
    dirs: set[str] = set()
    for rel in repo.files:
        name = rel.rsplit("/", 1)[-1]
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        dirs.add(folder)
        if folder.endswith("/res/values") and name.startswith("strings") and name.endswith(".xml"):
            for m in _ANDROID_STRING.finditer(repo.text(rel) or ""):
                android.setdefault(m.group(1), _android_value(m.group(2)))
        elif name.endswith(".xcstrings"):
            try:
                catalog = json.loads(repo.text(rel) or "{}")
            except ValueError:
                continue
            for key, entry in (catalog.get("strings") or {}).items():
                locs = (entry or {}).get("localizations") or {}
                unit = ((locs.get(catalog.get("sourceLanguage") or "en") or locs.get("en") or {}).get("stringUnit") or {})
                apple.setdefault(key, str(unit.get("value") or key))
    # `.lproj` folders are not walked: look beside every folder that has files.
    for folder in sorted(dirs):
        for lproj in ("en.lproj", "Base.lproj"):
            path = repo.root / folder / lproj / "Localizable.strings"
            try:
                if path.is_file() and path.stat().st_size <= 1024 * 1024:
                    for m in _APPLE_STRING.finditer(path.read_text(errors="replace")):
                        apple.setdefault(m.group(1), m.group(2).replace('\\"', '"').replace("\\n", " "))
            except OSError:
                continue
    out = {"android": android, "apple": apple, "flutter": code_dart.strings_of(repo)}
    repo.cache["string_resources"] = out
    return out


# ---------- units ----------

_SWIFT_TYPE = re.compile(
    r"^[ \t]*(?:@\w+(?:\([^)\n]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|final|indirect|nonisolated)\s+)*"
    r"(struct|class|enum|actor|extension)\s+([A-Z]\w*)(?:\.\w+)*[^{\n]*(?:\n[^{\n]*){0,3}\{",
    re.MULTILINE,
)
_KOTLIN_DECL = re.compile(
    r"^[ \t]*(?:@[\w.]+(?:\([^)\n]*\))?\s+)*(?:(?:public|private|internal|protected|open|abstract|data|sealed|inline|"
    r"override|suspend|enum|inner|final|static)\s+)*(fun|class|object|interface)\s+(?:<[^>]*>\s*)?(?:[A-Z]\w*\.)?([A-Za-z_]\w*)",
    re.MULTILINE,
)
_REF = {
    "swift": re.compile(r"\b([A-Z]\w*)\s*[({.]|[:<]\s*\[?([A-Z]\w*)"),
    "kotlin": re.compile(r"\b([A-Z]\w*)\s*[({]|[:<]\s*([A-Z]\w*)|::\s*([A-Z]\w*)"),
    "js": re.compile(r"<([A-Z]\w*)|\b([A-Z]\w*)\s*\("),
    "dart": re.compile(r"\b(_?[A-Z]\w*)(?:\s*<[^<>()]*>)?\s*(?:\.\s*[a-z]\w*\s*)?\("),
}
_SWIFT_TITLE = re.compile(r"\.navigation(?:Bar)?Title\s*\(\s*(?:Text\s*\(\s*)?(?:String\s*\(\s*localized:\s*)?(?=\")")
_SWIFT_ALERT = re.compile(r"\.(?:alert|confirmationDialog)\s*\(\s*(?:Text\s*\(\s*)?(?=\")|\bAlert\s*\(\s*title:\s*Text\s*\(\s*(?=\")")
_KOTLIN_BAR = re.compile(r"\b\w*(?:TopAppBar|AppBar|TopBar|Toolbar|NavBar|Header)\s*\(")
_KOTLIN_ALERT = re.compile(r"\b\w*AlertDialog\s*\(")
_KOTLIN_TITLE_ARG = re.compile(r"\btitle\s*=\s*")
_R_STRING = re.compile(r"\bR\.string\.(\w+)")
_JSX_TEXT = re.compile(r"(?<![=\-])>([^<>{}]*[^\W\d_][^<>{}]*)<")
_JS_TITLE = re.compile(r"\b(?:headerTitle|title)\s*:\s*([\"'`])((?:(?!\1).)+)\1")
_XML_TEXT = re.compile(r"\bandroid:(?:text|hint|contentDescription|title)\s*=\s*\"([^\"]+)\"|\bapp:title\s*=\s*\"([^\"]+)\"")
_LAYOUT_REF = re.compile(r"\bR\.layout\.(\w+)|\b([A-Z]\w*)Binding\b")


_DART_DECL = re.compile(
    r"^(?:@\w+(?:\([^)\n]*\))?\s+)*(?:(?:abstract|sealed|base|final|interface)\s+)*(?:class|mixin|enum|extension)\s+(_?[A-Z]\w*)?[^{;]*\{",
    re.MULTILINE,
)


def _dart_bodies(text: str) -> Iterator[tuple[str, int, int]]:
    """(name, start, end) of each top-level class, mixin, enum and extension of a Dart file."""
    code = code_dart.code_only(text)
    pos = 0
    while True:
        m = _DART_DECL.search(code, pos)
        if not m:
            return
        end = code_dart.close_of(code, m.end() - 1)
        yield m.group(1) or "", m.start(), end
        pos = end + 1


def _decl_bodies(text: str, lang: str) -> Iterator[tuple[str, int, int]]:
    """(name, start, end) of each top-level declaration's body in a Swift, Kotlin or Dart file."""
    if lang == "dart":
        yield from _dart_bodies(text)
        return
    regex = _SWIFT_TYPE if lang == "swift" else _KOTLIN_DECL
    pos = 0
    while True:
        m = regex.search(text, pos)
        if not m:
            return
        name = m.group(2)
        if lang == "swift":
            brace = m.end() - 1
        else:
            i = m.end()
            paren = re.match(r"\s*\(", text[i:])
            if paren:
                i = close_of(text, i + paren.end() - 1) + 1
            nxt = re.search(r"[{=\n]", text[i: i + 400])
            # A Kotlin declaration's body: its block (after a return type or supertypes), else none.
            k = text.find("{", i, i + 400)
            if k < 0 or (nxt and nxt.group(0) == "=" and text.find("=", i) < k):
                pos = m.end()
                continue
            between = text[i:k]
            if between.count("\n") > 3 or re.search(r"\b(?:fun|class|object|interface|val|var)\b|@", between):
                pos = m.end()
                continue
            brace = k
        end = close_of(text, brace, limit=400_000)
        yield name, m.start(), end
        pos = end + 1


def _swift_text(value: str, resources: dict[str, str]) -> str | None:
    if HOLE not in value and value in resources:
        value = resources[value]
    return ui_text(value)


def _literal_at(text: str, pos: int, lang: str) -> str | None:
    if pos < len(text) and text[pos] in "\"'`":
        value, end = _read_string(text, pos, lang)
        return value if end > 0 else None
    return None


def _dart_unit(unit: Unit, body: str, resources: dict[str, dict[str, str]]) -> Unit:
    strings = resources.get("flutter") or {}
    code = code_dart.code_only(body)
    texts: list[str] = []
    for start, end, value in sorted(code_dart.unit_strings(body, code, strings)):
        before = body[max(0, start - 60): start]
        if _NOT_SHOWN.search(before) or _DART_NOT_SHOWN.search(before):
            continue
        if re.match(r"\s*:", body[end: end + 3]) and not re.search(r"\?\s*$", before):
            continue  # a map key
        text = ui_text(value)
        if text:
            texts.append(text)
    for regex, out in ((code_dart._BAR, unit.titles), (code_dart._ALERT, unit.alerts)):
        for value in code_dart.titled(body, code, regex, strings):
            text = ui_text(value)
            if text and WILDCARD not in text:
                out.append(text)
    unit.texts = list(dict.fromkeys(texts))
    unit.refs = {g for m in _REF["dart"].finditer(code) for g in m.groups() if g and g != unit.name}
    return unit


#: Dart arguments that are never shown: a key, an asset, a font, a route or analytics name.
_DART_NOT_SHOWN = re.compile(
    r"(?:\b(?:Key|ValueKey|ObjectKey|PageStorageKey|GlobalObjectKey|fontFamily|package|heroTag|restorationId|name|"
    r"routeName|initialRoute|boxName|asset|assetName|svg|lottie|semanticsIdentifier|eventName|screenName|"
    r"getString|setString|getBool|setBool|getInt|setInt|get|put|delete|containsKey|openBox|parse|tryParse|https|http|"
    r"Uri|pattern|RegExp|DateFormat|Intl\.message|jsonDecode|fromJson|toJson|logEvent|setUserProperty|developer\.log)"
    r"\s*[:=(]\s*|\.\s*(?:asset|network|file|tr|translate)\s*\(\s*|\b(?:case|import|export|part)\s+)$"
)


def _unit(name: str, rel: str, lang: str, body: str, resources: dict[str, dict[str, str]]) -> Unit:
    unit = Unit(name, rel, lang)
    if lang == "dart":
        return _dart_unit(unit, body, resources)
    texts: list[str] = []
    android = resources["android"]
    apple = resources["apple"]
    for start, end, value in literals(body, lang):
        before = body[max(0, start - 60): start]
        if _NOT_SHOWN.search(before):
            continue
        if re.match(r"\s*:", body[end: end + 3]) and lang in ("js", "swift") and not re.search(r"\?\s*$", before):
            continue  # a dictionary or object key
        text = _swift_text(value, apple) if lang == "swift" else ui_text(value)
        if text:
            texts.append(text)
    if lang == "kotlin":
        for m in _R_STRING.finditer(body):
            if m.group(1) in android:
                text = ui_text(android[m.group(1)])
                if text:
                    texts.append(text)
        for m in _KOTLIN_BAR.finditer(body):
            title = _kotlin_title(body, m.end() - 1, android)
            if title:
                unit.titles.append(title)
        for m in _KOTLIN_ALERT.finditer(body):
            title = _kotlin_title(body, m.end() - 1, android)
            if title:
                unit.alerts.append(title)
    elif lang == "swift":
        for regex, out in ((_SWIFT_TITLE, unit.titles), (_SWIFT_ALERT, unit.alerts)):
            for m in regex.finditer(body):
                value = _literal_at(body, m.end(), "swift")
                text = _swift_text(value, apple) if value else None
                if text and WILDCARD not in text:
                    out.append(text)
    else:
        for m in _JSX_TEXT.finditer(body):
            text = ui_text(m.group(1))
            if text:
                texts.append(text)
        for m in _JS_TITLE.finditer(body):
            text = ui_text(m.group(2))
            if text and ("options" in body[max(0, m.start() - 200): m.start()] or "setOptions" in body[max(0, m.start() - 200): m.start()]):
                unit.titles.append(text)
    unit.texts = list(dict.fromkeys(texts))
    unit.refs = {g for m in _REF[lang].finditer(code_only(body, lang)) for g in m.groups() if g and g != name}
    return unit


def _kotlin_title(body: str, paren: int, android: dict[str, str]) -> str | None:
    """The literal (or string resource) given as `title =` in the call opening at `paren`."""
    args = body[paren: close_of(body, paren) + 1]
    m = _KOTLIN_TITLE_ARG.search(args)
    if not m:
        return None
    window = args[m.end(): m.end() + 200]
    for start, _, value in literals(window, "kotlin"):
        if not re.search(r"\b(?:testTag|contentDescription)\s*=\s*$", window[:start]):
            text = ui_text(value)
            return text if text and WILDCARD not in text else None
    res = _R_STRING.search(window)
    if res and res.group(1) in android:
        text = ui_text(android[res.group(1)])
        return text if text and WILDCARD not in text else None
    return None


class Units:
    """Every unit of the repo's source, by name (Swift types merge their extensions)."""

    def __init__(self, repo: Repo):
        self.repo = repo
        self.by_name: dict[str, list[Unit]] = {}
        self.by_file: dict[str, list[Unit]] = {}
        resources = string_resources(repo)
        for rel, text in repo.sources():
            lang = lang_of(rel)
            if lang is None:
                continue
            units: list[Unit] = []
            if lang == "js":
                # A JS file is one unit, known by every component it declares.
                unit = _unit(rel, rel, lang, text, resources)
                units.append(unit)
                for m in _JS_DECL.finditer(text):
                    self.by_name.setdefault(m.group(m.lastindex or 1), []).append(unit)
            else:
                for name, start, end in _decl_bodies(text, lang):
                    units.append(_unit(name, rel, lang, text[start: end + 1], resources))
            self.by_file[rel] = units
            for u in units:
                self.by_name.setdefault(u.name, []).append(u)
        self.layouts = {
            rel.rsplit("/", 1)[-1][:-4]: rel for rel in repo.files
            if "/res/layout" in rel and rel.endswith(".xml")
        }

    def named(self, name: str, lang: str, near: str | None = None) -> list[Unit]:
        found = [u for u in self.by_name.get(name, []) if u.lang == lang]
        if lang == "dart" and name.startswith("_"):
            return [u for u in found if u.rel == near]  # a private Dart class is its own file's
        return found if len({u.rel for u in found}) <= MAX_DECLARED else []

    def layout_texts(self, unit: Unit) -> list[str]:
        """An Android activity's or fragment's XML layout texts (`R.layout.x`, `XBinding`)."""
        text = self.repo.text(unit.rel) or ""
        android = string_resources(self.repo)["android"]
        out: list[str] = []
        for m in _LAYOUT_REF.finditer(text):
            name = m.group(1) or fm._kebab(m.group(2)).replace("-", "_")
            rel = self.layouts.get(name)
            for x in _XML_TEXT.finditer(self.repo.text(rel) or "" if rel else ""):
                raw = x.group(1) or x.group(2)
                value = android.get(raw[8:], "") if raw.startswith("@string/") else raw
                t = ui_text(value)
                if t:
                    out.append(t)
        return out


# ---------- screens ----------

_COMPOSE_CALL = re.compile(r"\b([A-Z]\w*)\s*\(")
_JS_DECL = re.compile(r"\b(?:function|class)\s+([A-Z]\w*)|\b(?:const|let|var)\s+([A-Z]\w*)\s*(?::[^=\n]+)?=")


def _primary_units(repo: Repo, units: Units, key: str) -> list[Unit]:
    """The units that are this screen's own code."""
    s = repo.screens[key]
    names = [n for n, k in repo._names.items() if k == key]
    if s.platform in ("swiftui", "uikit", "android"):
        lang = "swift" if s.platform != "android" else "kotlin"
        return [u for n in names for u in units.named(n, lang)]
    if s.platform == "flutter":
        # The widget and its state (`_HomeTabState extends State<HomeTab>`), both in its own file.
        return [u for n in names for name in (n, f"_{n}State", f"{n}State") for u in units.named(name, "dart", s.path) if u.rel == s.path]
    if s.platform == "compose":
        text = repo.text(s.path) or ""
        start = _offset_of_line(text, s.line)
        paren = text.find("(", start)
        if paren < 0:
            return []
        close = close_of(text, paren)
        brace = text.find("{", close)
        if brace < 0 or text[close + 1: brace].strip():
            return []
        body = text[brace + 1: close_of(text, brace)]
        out: list[Unit] = []
        for m in _COMPOSE_CALL.finditer(body):
            out += [u for u in units.named(m.group(1), "kotlin") if u not in out]
        return out
    if lang_of(s.path) == "js":
        return list(units.by_file.get(s.path, []))
    return []


def screen_texts(repo: Repo, targets: set[str] | None = None) -> list[ScreenTexts]:
    """The static texts of each native screen (and each Expo / React Navigation one), from its
    own units and the units they render (see the module docstring). A routed web screen is
    met by its route, so it has none.

    `targets` are the screens something navigates to (`code_nav`: a link, a sheet, a tab); a
    screen renders another's words only when that one is not a target, which is a component
    that happens to be named like a screen (`DashboardHeaderView` inside `TodayDashboardView`).
    Without `targets` no screen renders another's."""
    units = Units(repo)
    primaries = {k: _primary_units(repo, units, k) for k in repo.screens}
    owned = {id(u) for k, us in primaries.items() if targets is None or k in targets for u in us}
    out: list[ScreenTexts] = []
    for key, own in primaries.items():
        s = repo.screens[key]
        if not own or s.platform in ("next", "pages", "react-router"):
            continue
        texts: list[str] = []
        titles: list[str] = []
        alerts: list[str] = []
        seen = {id(u) for u in own}
        frontier = list(own)
        for u in own:
            titles += u.titles
            if s.platform == "android":
                texts += units.layout_texts(u)
        own_count = 0
        for hop in range(1 + MAX_HOPS):
            nxt: list[Unit] = []
            for u in frontier:
                texts += u.texts
                alerts += u.alerts
                if hop == MAX_HOPS:
                    continue
                for ref in sorted(u.refs):
                    for other in units.named(ref, u.lang, u.rel):
                        if id(other) in seen or id(other) in owned:
                            continue
                        seen.add(id(other))
                        nxt.append(other)
            if hop == 0:
                own_count = len(dict.fromkeys(texts))
            frontier = nxt
            if not frontier:
                break
        title = next(iter(titles), None)
        ordered = list(dict.fromkeys(texts))
        own_texts = set(ordered[:own_count]) | ({title} if title else set())
        texts = ([title] if title else []) + [t for t in ordered if t != title]
        kept = texts[:MAX_TEXTS]
        out.append(ScreenTexts(key, title, tuple(kept), tuple(dict.fromkeys(alerts))[:10], sum(1 for t in kept if t in own_texts)))
    return out


# ---------- presented SwiftUI views ----------

_PRESENTER = re.compile(r"\.(?:sheet|fullScreenCover|navigationDestination|popover)\s*(?=[({])|\bNavigationLink\s*(?=[({])")
_SWIFT_VIEW_DECL = re.compile(r"^[ \t]*(?:(?:public|private|fileprivate|internal|final)\s+)*struct\s+([A-Z]\w*)\s*:\s*(?:[\w.]+\s*,\s*)*View\b", re.MULTILINE)
#: A presented view whose name says it is a building block, not a screen.
_NOT_A_SCREEN = re.compile(r"(?:Row|Cell|Card|Button|Toast|Banner|Badge|Chip|Icon|Label|Field|Wrapper|Shell|Container|Host|Modifier|Style|Preview)$")
#: Containers a presented view is wrapped in without being laid out beside anything.
_PASS_THROUGH = frozenset({"NavigationStack", "NavigationView", "NavigationSplitView", "Group", "AnyView", "Binding", "Optional"})
_WRAPPER = re.compile(r"(?:Wrapper|Shell|Container|Host)$")


def presented_swift_screens(repo: Repo) -> list[fm.Screen]:
    """SwiftUI views presented as a sheet, a full-screen cover, a navigation destination or a
    link's destination that are not screens yet (a second view in a screen's file, or a file's
    view whose name has no screen suffix, such as `SortSheet`)."""
    declared: dict[str, tuple[str, int, int]] = {}  # name -> (file, line, offset)
    texts: dict[str, str] = {}
    for rel, text in repo.sources("swift"):
        text = code_only(text, "swift")
        texts[rel] = text
        for m in _SWIFT_VIEW_DECL.finditer(text):
            declared.setdefault(m.group(1), (rel, fm._line(text, m.start()), m.start()))

    def views_in(body: str) -> list[str]:
        """The view a presentation's content is: its first call past the stacks that only wrap
        it (`NavigationStack { EditView(...) }`); none when the content is laid out inline
        (`VStack { Avatar(); Text(...) }`)."""
        for c in re.finditer(r"\b([A-Z]\w*)\s*[({]", body):
            name = c.group(1)
            if name in _PASS_THROUGH:
                continue
            return [name] if name in declared else []
        return []

    presented: list[str] = []
    for rel, text in texts.items():
        for m in _PRESENTER.finditer(text):
            i = m.end()
            body = ""
            if text.startswith("(", i):
                close = close_of(text, i)
                body = text[i + 1: close]
                i = close + 1
            brace = re.match(r"\s*\{", text[i:])
            if brace:
                start = i + brace.end() - 1
                body += text[start: close_of(text, start)]
            for name in views_in(body)[:1]:
                if _WRAPPER.search(name):
                    # `AddRoutineFloatingShell { AddRoutineSheet(...) }`: the view inside the wrapper.
                    w_rel, _, at = declared[name]
                    w_text = texts[w_rel]
                    brace_at = w_text.find("{", at)
                    struct = w_text[brace_at: close_of(w_text, brace_at)] if brace_at >= 0 else ""
                    body = re.search(r"\bvar\s+body\s*:\s*some\s+View\s*\{", struct)
                    inner = views_in(struct[body.end() - 1: close_of(struct, body.end() - 1)]) if body else []
                    name = inner[0] if inner and inner[0] != name else name
                if name not in presented and not repo.name_key(name):
                    presented.append(name)
    out: list[fm.Screen] = []
    for name in presented:
        if _NOT_A_SCREEN.search(name):
            continue
        rel, line, _ = declared[name]
        out.append(fm.Screen(name, "overview", name, rel, "swiftui", rel, line))
    return out
