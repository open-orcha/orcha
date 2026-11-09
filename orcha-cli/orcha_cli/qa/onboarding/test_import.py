"""The team's own UI tests as draft QA scenarios: pure, like the original `test_import.store.
convert_sources`. No model, no agent, no device and no cost: each test the scan found (`tests_scan`,
the port of `extract.scan`) becomes one draft pointing at its source file, tagged `test:<path>`. The
code stays in the repository. A person approves each draft.

The criteria are what the test asserts, read by pattern: `expect(...).toHaveText("Paid")`, a Maestro
`assertVisible`, a Gherkin `Then`. A test whose assertions name nothing readable gets its own goal
as a criterion, so nothing a test checks is lost, only said more plainly.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional

from orcha_cli.qa.onboarding.tests_scan import SourceTest

MIN_CRITERIA = 2
MAX_CRITERIA = 12
MAX_NAME = 200
NO_ERROR = "No error message appears along the way"
#: Where each framework's tests run; a framework for both phones takes the project's first.
PLATFORM_OF = {"xcuitest": "ios", "espresso": "android", "playwright": "web", "cypress": "web"}
_ASSERT = re.compile(r"\bexpect\(|\.should\(|\bXCTAssert\w*\(|\bassert\w*\(|^\s*-\s*assert\w*|\.exists\b|\.toBeVisible\(|\bcy\.contains\(|\bmatches\(", re.I)
_NEGATED = re.compile(r"\.not\b|\bnot\.|NotVisible|doesNotExist|XCTAssertFalse|assertFalse|isNotDisplayed|\bnot\.exist|assertDoesNotExist", re.I)
_QUOTED = re.compile(r"""(?P<q>["'`])(?P<t>(?:\\.|(?!(?P=q)).){2,120})(?P=q)""")
_NOT_TEXT = re.compile(r"^(?:be\.|have\.|not\.|contain$|exist$|visible$|https?:|/|#|\.|\[|//)|[{}<>=]|^\w+[-_]\w+$")
_GHERKIN_STEP = re.compile(r"^\s*(Then|And|But)\s+(.+?)\s*$", re.M)
_GHERKIN_ANY = re.compile(r"^\s*(Given|When|Then|And|But)\s+", re.M)


def _sentence(text: str) -> str:
    text = " ".join(text.split()).strip(" .")
    return (text[:1].upper() + text[1:]) if text else ""


def _gherkin(body: str) -> list[str]:
    out, then = [], False
    for line in body.splitlines():
        step = _GHERKIN_ANY.match(line)
        if not step:
            continue
        word = step.group(1)
        then = word == "Then" or (then and word in ("And", "But"))
        if then:
            out.append(_sentence(line[step.end():]))
    return out


def _asserted(body: str) -> list[str]:
    """One outcome per assertion that names something a person can read."""
    out: list[str] = []
    for line in body.splitlines():
        if not _ASSERT.search(line):
            continue
        said = next((m.group("t") for m in _QUOTED.finditer(line) if not _NOT_TEXT.search(m.group("t"))), None)
        if said:
            out.append(f'"{" ".join(said.split())}" is {"not shown" if _NEGATED.search(line) else "shown"}')
    return out


def criteria_of(test: SourceTest, goal: str) -> list[str]:
    found = _gherkin(test.body) if test.framework == "gherkin" else _asserted(test.body)
    criteria = list(dict.fromkeys(c for c in found if c))[:MAX_CRITERIA]
    if not criteria:
        criteria = [_sentence(goal)]
    if len(criteria) < MIN_CRITERIA:
        criteria.append(NO_ERROR)
    return criteria


def _platform(test: SourceTest, picked: list[str]) -> Optional[str]:
    wanted = PLATFORM_OF.get(test.framework)
    if wanted:
        return wanted if wanted in picked else None
    return next((p for p in picked if p != "web"), picked[0] if picked else None) if test.framework in ("maestro", "detox") else (picked[0] if picked else None)


def convert_sources(tests: list[SourceTest], picked: list[str], screens_of: Optional[dict[tuple[str, str, str], list[str]]] = None) -> list[dict[str, Any]]:
    """One `{platform, fields, evidence}` per test, ready for the portal's propose. A test for a
    platform the project did not pick stays out. Two tests that read the same keep their file's
    name, so neither overwrites the other. `screens_of`: (platform, path, test name) -> screen keys."""
    out: list[dict[str, Any]] = []
    used: dict[tuple[str, str], str] = {}
    for t in tests:
        platform = _platform(t, picked)
        if platform is None:
            continue
        goal = " ".join(t.name.split())
        name = (f"{t.describe}: {goal}" if t.describe else goal)[:MAX_NAME]
        if used.get((platform, name), t.path) != t.path or (platform, name) in used:
            name = f"{name[:MAX_NAME - len(Path(t.path).name) - 3]} ({Path(t.path).name})"
        n, base = 2, name
        while (platform, name) in used:
            name, n = f"{base[:MAX_NAME - 4]} #{n}", n + 1
        used[(platform, name)] = t.path
        criteria = criteria_of(t, goal)
        ref = f"{t.path}:{t.line}"
        tags = ["migrated", t.framework, f"test:{t.path}"] + [f"screen:{k}" for k in (screens_of or {}).get((platform, t.path, t.name), [])]
        out.append({"platform": platform, "framework": t.framework, "path": t.path,
                    "fields": {"name": name, "criteria": criteria, "tags": tags, "source": "generated",
                               "description": f"From the {t.framework} test at {ref}: its code stays in your repository."},
                    "evidence": [{"criterion_index": i, "status": "code_only", "code_ref": ref} for i in range(len(criteria))]})
    return out
