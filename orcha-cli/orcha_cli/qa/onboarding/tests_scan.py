"""The team's own UI tests, read from the repository (a slim port of `test_import/extract.py`
`scan`, `exploration/exploration_study.py`'s walk and `frameworks.classify`). Nothing is run or
converted: a test here is a name, a place and its body, enough to count it, say which framework it
is in and tie it to the screens it talks about.

`has_screens` answers what the original conversion answers, without converting: whether a test drives
something a person sees. A Playwright API test, an empty one, a screenshot-only test or a unit test
stays out of the count, so "We found" says 104 UI tests where a repository has 110 test files' worth
of Playwright.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from orcha_cli.qa.onboarding import ignored

#: The frameworks the sheet lists (the UI contract's), in the order it lists them.
UI_FRAMEWORKS = ("xcuitest", "espresso", "maestro", "detox", "playwright", "cypress", "gherkin")
SKIP_DIRS = frozenset({
    "node_modules", "bower_components", "build", "dist", "out", "Pods", "DerivedData", "coverage",
    "vendor", "target", "venv", ".venv", "__pycache__", "__snapshots__", "qa-runs", "tmp", "temp",
    "Carthage", "xcuserdata", "obj", "bin", "intermediates", "generated", "storybook-static",
    "site-packages", "prototypes",
})
ALLOWED_HIDDEN = frozenset({".maestro"})
MAX_FILES = 25_000
MAX_TEST_READS = 800
MAX_READ_BYTES = 192 * 1024
MAX_BODY = 40_000

JS_TEST = re.compile(r"\.(test|spec|e2e|cy)\.(m|c)?[jt]sx?$")
PY_TEST = re.compile(r"^(test_.*|.*_test)\.py$")
SWIFT_TEST = re.compile(r"(Tests?|Spec|UITests?)\.swift$")
JVM_EXT = (".kt", ".java")
YAML_EXT = (".yaml", ".yml")
MAESTRO_STEP = re.compile(r"^\s*-\s*(launchApp|tapOn|inputText|assertVisible|runFlow|scrollUntilVisible)\b", re.M)
_UI_TEST_DIR = re.compile(r"(?:^|/)[^/]*UITests?/", re.IGNORECASE)
_SWIFT_TEST_FUNC = re.compile(r"\bfunc\s+test\w*\s*\(\s*\)")
_SWIFT_TEST = re.compile(r"(?:@Test\s*(?:\(\s*\"(?P<display>[^\"]*)\"[^)]*\))?\s*(?:@\w+\s*)*)?func\s+(?P<name>\w+)\s*\(\s*\)\s*(?:async\s*)?(?:throws\s*)?(?:->\s*\w+\s*)?\{")
_JVM_TEST = re.compile(r"@Test\b[^\n]*\n(?:\s*@\w+(?:\([^)]*\))?\s*\n)*\s*(?:public\s+|internal\s+|override\s+)*(?:fun|void)\s+(?P<name>`[^`]+`|\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?(?:=\s*\w+\s*)?\{")
_JS_CALL = re.compile(r"(?<![\w.$])(?P<fn>x?it|x?test|fit|specify|scenario|x?describe|context|suite|beforeEach|beforeAll|before)(?P<mods>(?:\.(?:only|skip|fixme|concurrent|serial|failing|todo|each|describe|parallel|beforeEach|beforeAll|step))*)\s*(?=[(`])")
_TITLE = re.compile(r"""\(\s*(?P<q>['"`])(?P<t>(?:\\.|(?!(?P=q)).)*)(?P=q)""", re.S)
_EACH_END = re.compile(r"\)\s*(?=\()|`\s*(?=\()")
_GHERKIN_SCENARIO = re.compile(r"^\s*(?:Scenario Outline|Scenario Template|Scenario|Example)\s*:\s*(.*)$", re.M)
_RUN_FLOW = re.compile(r"runFlow\s*:\s*(?:\{[^}]*file\s*:\s*)?['\"]?(?P<file>[\w./-]+\.ya?ml)")

#: What a body does on a screen, per framework family.
_UI_WEB = re.compile(r"\b(?:page|\w*[pP]age)\s*\.\s*(?!request\b)\w+|\bgetBy\w+\(|\blocator\(|\bexpect\(\s*\w*[pP]age\b|\b\w+(?:Page|Screen|PO)\.\w+\(")
_UI_CYPRESS = re.compile(r"\bcy\.(?!request\b|task\b|intercept\b|wait\b|log\b|fixture\b|exec\b|readFile\b|writeFile\b)\w+\(")
_UI_DETOX = re.compile(r"\belement\(|\bwaitFor\(|\bdevice\.\w+\(|\bby\.\w+\(")
_UI_ESPRESSO = re.compile(r"\bonView\(|\bonData\(|\bcomposeTestRule\b|\bcomposeRule\b|\bonNode\w*\(|\bonAllNodes\w*\(|\bUiDevice\b|\brule\.on\w+\(")
_UI_XCUI = re.compile(r"\bapp\.(?:buttons|staticTexts|textFields|secureTextFields|tables|cells|navigationBars|tabBars|alerts|sheets|switches|images|otherElements|collectionViews|scrollViews|launch|terminate|activate|swipe\w*|tap)\b|\bXCUIApplication\(|\.waitForExistence\(|\.tap\(\)|\.typeText\(|\.exists\b|\b[A-Z]\w*(?:Screen|Page|Robot)\s*\(\s*app\b|\b(?:let\s+)?app\s*=\s*\w")
_API_ONLY = re.compile(r"\b(?:request|apiContext)\.(?:get|post|put|patch|delete)\(|\bcy\.request\(")
_CAPTURE = re.compile(r"\bcaptureScreenshot\(|\btakeScreenshot\(\s*(?:named|name)?|XCUIScreen\.main\.screenshot\(|XCTAttachment\(\s*screenshot|\bsnapshot\(\s*\"|Screengrab\.screenshot\(|^\s*-\s*takeScreenshot", re.M)
_OUTCOME = re.compile(r"\bexpect\(|\bshould\(|\bXCTAssert\w*\(|\bassert\w*\(|^\s*-\s*assert", re.M)


@dataclass
class SourceTest:
    path: str
    name: str
    line: int
    framework: str
    body: str
    describe: Optional[str] = None


@dataclass
class Inventory:
    tests: list[SourceTest] = field(default_factory=list)
    files_seen: int = 0
    truncated: bool = False
    errors: list[str] = field(default_factory=list)


def _skip_dir(d: str) -> bool:
    """Folders never walked: hidden ones (but `.maestro`), `SKIP_DIRS`, Xcode bundles and build
    output under any name (`DerivedDataDevice/`, `App.xcarchive`, `Index.noindex`)."""
    return (
        (d.startswith(".") and d not in ALLOWED_HIDDEN) or d in SKIP_DIRS or d.startswith("DerivedData")
        or d.endswith((".xcassets", ".xcodeproj", ".xcworkspace", ".lproj", ".app", ".xcarchive", ".noindex", ".dSYM"))
    )


def _walk(root: Path, *, max_files: int = MAX_FILES, deadline: Optional[float] = None) -> tuple[list[str], bool]:
    files: list[str] = []
    skip = ignored.matcher(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not _skip_dir(d) and not skip(os.path.join(dirpath, d)))
        rel_dir = os.path.relpath(dirpath, root)
        prefix = "" if rel_dir == "." else rel_dir.replace(os.sep, "/") + "/"
        for name in sorted(filenames):
            if name.startswith("._"):
                continue  # macOS AppleDouble metadata beside a copied file, never the app's
            files.append(prefix + name)
            if len(files) >= max_files:
                return files, True
        if deadline is not None and time.monotonic() > deadline:
            return files, True
    return files, False


def _read(root: Path, rel: str) -> Optional[str]:
    try:
        path = root / rel
        if path.stat().st_size > MAX_READ_BYTES:
            return None
        return path.read_text(errors="replace")
    except OSError:
        return None


def humanize(name: str) -> str:
    """`test_rejects_short_password` / `testRejectsShortPassword` -> "rejects short password"."""
    name = name.strip("`")
    name = re.sub(r"^test_?", "", name)
    name = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", name).replace("_", " ")
    return " ".join(name.split()).lower()


def _test_candidate(rel: str) -> Optional[str]:
    """The framework family a file may hold tests of, from its name and folders alone."""
    name = rel.rsplit("/", 1)[-1]
    parts = rel.lower().split("/")
    if JS_TEST.search(name):
        return "js"
    if PY_TEST.match(name):
        return "pytest"
    if name.endswith(".swift") and (SWIFT_TEST.search(name) or any(p.endswith(("tests", "uitests")) for p in parts[:-1])):
        return "swift"
    if name.endswith(JVM_EXT) and any(p in ("test", "androidtest", "tests") for p in parts[:-1]):
        return "jvm"
    if name.endswith(YAML_EXT) and (".maestro" in parts or "maestro" in parts or "flows" in parts):
        return "maestro"
    return None


def _js_framework(rel: str, text: str) -> str:
    if ".cy." in rel or "/cypress/" in f"/{rel}":
        return "cypress"
    if "@playwright/test" in text:
        return "playwright"
    if "from 'detox'" in text or 'from "detox"' in text or ".e2e." in rel and "device." in text:
        return "detox"
    if "vitest" in text:
        return "vitest"
    return "jest"


def framework_of(rel: str, text: str) -> Optional[str]:
    """The framework a file's tests are written in, or None for a file that holds none."""
    if rel.endswith(".feature"):
        return "gherkin"
    family = _test_candidate(rel)
    if family is None and rel.endswith((".kt", ".java", ".swift")) and "test" in rel.lower():
        family = "jvm" if rel.endswith((".kt", ".java")) else "swift"
    if family == "js":
        return _js_framework(rel, text)
    if family == "swift":
        if "XCTestCase" not in text and "@Test" not in text:
            if _UI_TEST_DIR.search(rel) and _SWIFT_TEST_FUNC.search(text):
                return "xcuitest"  # subclasses the team's own base class; its folder says it
            return None
        if "XCUIApplication" in text:
            return "xcuitest"
        return "swift-testing" if "@Test" in text and "XCTestCase" not in text else "xctest"
    if family == "jvm":
        if "@Test" not in text:
            return None
        return "espresso" if "espresso" in text.lower() or "compose.ui.test" in text else "junit"
    if family == "maestro":
        return "maestro" if MAESTRO_STEP.search(text) else None
    return None


def match_close(text: str, open_idx: int) -> int:
    """The index of the bracket closing the one at `open_idx`, skipping strings, template
    literals and comments. -1 when it never closes."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack = [pairs[text[open_idx]]]
    i = open_idx + 1
    n = len(text)
    while i < n:
        c = text[i]
        if c in "'\"":
            i += 1
            while i < n and text[i] != c and text[i] != "\n":
                i += 2 if text[i] == "\\" else 1
            i += 1
            continue
        if c == "`":
            i += 1
            depth = 0
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text.startswith("${", i):
                    depth += 1
                    i += 2
                    continue
                if text[i] == "}" and depth:
                    depth -= 1
                elif text[i] == "`" and not depth:
                    break
                i += 1
            i += 1
            continue
        if text.startswith("//", i):
            nl = text.find("\n", i)
            i = n if nl < 0 else nl
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if c in pairs:
            stack.append(pairs[c])
        elif c in ")]}":
            if not stack or c != stack[-1]:
                return -1
            stack.pop()
            if not stack:
                return i
        i += 1
    return -1


def _line(text: str, idx: int) -> int:
    return text.count("\n", 0, idx) + 1


def js_tests(path: str, text: str, framework: str) -> list[SourceTest]:
    blocks: list[tuple[str, int, int, str, int, int]] = []  # kind, start, end, title, line, body_start
    for m in _JS_CALL.finditer(text):
        fn, mods = m.group("fn"), m.group("mods") or ""
        if fn in ("beforeEach", "beforeAll", "before") or "beforeEach" in mods or "beforeAll" in mods or ".step" in mods:
            continue
        pos = m.end()
        if ".each" in mods:  # `test.each([...])('title', ...)` or test.each`table`('title', ...)
            e = _EACH_END.search(text, pos)
            if e is None:
                continue
            pos = e.end()
        t = _TITLE.match(text, pos)
        if not t:
            continue
        close = match_close(text, pos)
        if close < 0:
            continue
        kind = "describe" if (fn in ("describe", "xdescribe", "context", "suite") or ".describe" in mods) else "test"
        blocks.append((kind, m.start(), close, t.group("t").strip(), _line(text, m.start()), t.end()))
    describes = [b for b in blocks if b[0] == "describe"]
    out = []
    for kind, start, end, title, line, body_start in blocks:
        if kind != "test":
            continue
        enclosing = sorted((d for d in describes if d[1] < start < d[2]), key=lambda d: d[1])
        name = " > ".join([d[3] for d in enclosing] + [title])
        out.append(SourceTest(path, name, line, framework, text[body_start:end][:MAX_BODY],
                              describe=enclosing[0][3] if enclosing else None))
    return out


def swift_tests(path: str, text: str, framework: str) -> list[SourceTest]:
    out = []
    for m in _SWIFT_TEST.finditer(text):
        name = m.group("name")
        if not (name.startswith("test") or m.group(0).lstrip().startswith("@Test")):
            continue
        close = match_close(text, m.end() - 1)
        if close < 0:
            continue
        out.append(SourceTest(path, m.group("display") or humanize(name), _line(text, m.start()), framework,
                              text[m.end():close][:MAX_BODY]))
    return out


def jvm_tests(path: str, text: str, framework: str) -> list[SourceTest]:
    out = []
    for m in _JVM_TEST.finditer(text):
        close = match_close(text, m.end() - 1)
        if close >= 0:
            out.append(SourceTest(path, humanize(m.group("name")), _line(text, m.start()), framework,
                                  text[m.end():close][:MAX_BODY]))
    return out


def maestro_test(path: str, text: str) -> list[SourceTest]:
    header, sep, flow = text.partition("\n---")
    if not sep:
        header, flow = "", text
    named = re.search(r"^\s*name\s*:\s*(.+)$", header, re.M)
    title = named.group(1).strip().strip("'\"") if named else humanize(Path(path).stem.replace("-", "_"))
    body = flow.lstrip("\n")
    return [SourceTest(path, title, text[: len(text) - len(body)].count("\n") + 1, "maestro", body)]


def gherkin_tests(path: str, text: str) -> list[SourceTest]:
    marks = list(_GHERKIN_SCENARIO.finditer(text))
    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        out.append(SourceTest(path, m.group(1).strip() or f"Scenario at line {_line(text, m.start())}",
                              _line(text, m.start()), "gherkin", text[m.end():end][:MAX_BODY]))
    return out


def tests_in_file(path: str, text: str, framework: str) -> list[SourceTest]:
    if framework == "gherkin":
        return gherkin_tests(path, text)
    if framework == "maestro":
        return maestro_test(path, text)
    if framework in ("playwright", "cypress", "jest", "vitest", "detox"):
        return js_tests(path, text, framework)
    if framework in ("xcuitest", "xctest", "swift-testing"):
        return swift_tests(path, text, framework)
    if framework in ("espresso", "junit"):
        return jvm_tests(path, text, framework)
    return []


def _resolve_runflow(test_path: str, file: str) -> str:
    base = test_path.rsplit("/", 1)[0] if "/" in test_path else ""
    parts = (base.split("/") if base else []) + file.split("/")
    out: list[str] = []
    for p in parts:
        if p == "..":
            if out:
                out.pop()
        elif p and p != ".":
            out.append(p)
    return "/".join(out)


def scan(repo_dir, subdir: Optional[str] = None, *, max_files: int = MAX_FILES, deadline: Optional[float] = None) -> Inventory:
    """Every source test under the repo (or its `subdir`), with paths relative to the repo. An
    unreadable file is skipped; with `max_files` / `deadline` (`time.monotonic()`) the scan stops
    early and says `truncated`."""
    repo = Path(repo_dir).expanduser()
    sub = str(subdir or "").strip().strip("/")
    root = repo / sub if sub and (repo / sub).is_dir() else repo
    base = "" if root == repo else root.relative_to(repo).as_posix() + "/"
    files, truncated = _walk(root, max_files=max_files, deadline=deadline)
    tests: list[SourceTest] = []
    errors: list[str] = []
    flows: dict[str, str] = {}
    reads = 0
    seen = len(files)
    for i, rel in enumerate(files):
        name = rel.rsplit("/", 1)[-1]
        if not (name.endswith(".feature") or _test_candidate(rel) is not None
                or (name.endswith((".kt", ".java", ".swift")) and "test" in rel.lower())):
            continue
        if reads >= MAX_TEST_READS * 2 or (deadline is not None and time.monotonic() > deadline):
            truncated, seen = True, i
            break
        text = _read(root, rel)
        reads += 1
        if not text:
            continue
        path = base + rel
        try:
            fw = framework_of(rel, text)
            if fw is None:
                continue
            if fw == "maestro":
                flows[path] = text
            tests += tests_in_file(path, text, fw)
        except (RecursionError, ValueError, IndexError) as e:  # an odd file never stops the scan
            errors.append(f"{path}: could not be read ({type(e).__name__})")
    # A flow another flow runs is a shared helper, not a test of its own.
    used = {_resolve_runflow(p, m.group("file")) for p, text in flows.items() for m in _RUN_FLOW.finditer(text)}
    if used:
        tests = [t for t in tests if not (t.framework == "maestro" and t.path in used)]
    return Inventory(tests, seen, truncated, errors)


def has_screens(test: SourceTest) -> bool:
    """Whether a test checks what a person sees (`frameworks.classify`, by pattern)."""
    body = test.body
    if test.framework == "gherkin":
        return True
    if not body.strip():
        return False
    if test.framework == "maestro":
        ui = bool(MAESTRO_STEP.search(body))
    elif test.framework == "playwright":
        ui = bool(_UI_WEB.search(body))
    elif test.framework == "cypress":
        ui = bool(_UI_CYPRESS.search(body))
    elif test.framework == "detox":
        ui = bool(_UI_DETOX.search(body))
    elif test.framework == "espresso":
        ui = bool(_UI_ESPRESSO.search(body))
    elif test.framework == "xcuitest":
        ui = bool(_UI_XCUI.search(body))
    else:
        return False
    if not ui:
        return False
    return not (_CAPTURE.search(body) and not _OUTCOME.search(body))
