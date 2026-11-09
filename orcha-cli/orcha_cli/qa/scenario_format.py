"""Scenario markdown v3: parse, render and lint (from `scenarios/parser.py`, `lint.py` and
`docs/scenario-format.md`).

A scenario is a user's goal and the outcomes that prove it was met: a name, a one-sentence
description, and acceptance criteria. Never steps. The tester works out the taps; the criteria
say what must be true on screen and in the data afterwards.

```
# Fleet                                   <- file title (optional)
Environment: test                         <- file header lines, before the first ##

## Record a trip on our own truck         <- one scenario per ## heading
Category: Income
Persona: Owner
Description: An owner records a hauled trip and sees it counted in the month's income.
Needs: reset
Tags: walked, ios
1. The Income page offers an "Add trip" action
   Check: Button "Add trip"
2. After saving a trip of {{rate}}, a "Trip added" confirmation appears
   Check: text "Trip added" appears within 10s
   Saved: record "Trip" -> rate is "{{rate}}"

## Examples
| rate |
| ---  |
| 4321 |

## Data
plate = pattern KD[A-Z] [0-9]{3}[A-Z]
```

`Check:` and `Saved:` lines under a criterion belong to it; before the first criterion they are
scenario-level. `Saved:` read-backs are stored among the checks as `saved ...`. Also kept:
`Seed:`, `Cleanup:`, `Stub:`/`Request:`, `Event:`, `Fresh:`, `Start:`, `Permissions:`, `Conditions:`,
`Scenario-Id:`, `Session:`, `Account:`. `Tags:` is an Orcha extension (the row's `tags`).

Rows: `to_row` / `from_row` map a scenario to the `qa_scenarios` fields (`name`, `category`,
`persona`, `description`, `criteria`, `checks` = `[{"criterion_index": 0 | null, "line": "..."}]`,
`data`, `needs`, `tags`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from . import checks as checks_mod

_STEP = re.compile(r"^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$")
_EXPECT = re.compile(r"^\s*expect:\s*(.*\S)\s*$", re.IGNORECASE)
_CHECK = re.compile(r"^\s*check:\s*(.*\S)\s*$", re.IGNORECASE)
_SAVED = re.compile(r"^\s*saved:\s*(.*\S)\s*$", re.IGNORECASE)
_SAVED_CHECK = re.compile(r"^saved:?\s+", re.IGNORECASE)
_HEADING = re.compile(r"^\s*##\s+(.*\S)\s*$")
_TITLE = re.compile(r"^\s*#\s+(.*\S)\s*$")
_HEADER = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$")
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_ .\-]*?)\s*\}\}")

DATA_SECTION = "data"
EXAMPLES_SECTION = "examples"
CONTEXT_SECTIONS = frozenset({"memory", "known paths", "agent", "seeded", "starting state"})
_META = {"category": "category", "persona": "persona", "scenario-id": "scenario_id", "description": "description",
         "session": "session", "account": "account"}

MIN_CRITERIA = 2  # what the portal stores (qa_scenarios.criteria: 2-12)
MAX_CRITERIA_STORED = 12
MAX_CRITERIA = 8  # the style rule: more usually means two journeys
ONE_WORKFLOW_MAX = 5


@dataclass
class Scenario:
    name: str
    criteria: list[str] = field(default_factory=list)
    category: Optional[str] = None
    persona: Optional[str] = None
    description: Optional[str] = None
    scenario_id: Optional[str] = None
    session: Optional[str] = None
    account: Optional[str] = None
    checks: dict[int, list[str]] = field(default_factory=dict)  # 0-based criterion -> Check lines
    scenario_checks: list[str] = field(default_factory=list)
    saved: dict[int, list[str]] = field(default_factory=dict)  # 0-based criterion -> Saved bodies
    scenario_saved: list[str] = field(default_factory=list)
    needs: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    seeds: list[str] = field(default_factory=list)
    cleanup: list[str] = field(default_factory=list)
    stubs: list[str] = field(default_factory=list)
    events: list[str] = field(default_factory=list)
    fresh: Optional[str] = None
    start: Optional[str] = None
    permissions: Optional[str] = None
    examples: Optional[dict[str, Any]] = None  # {"columns": [...], "rows": [[...]]}
    conditions: dict[str, str] = field(default_factory=dict)  # `Conditions:`, the run conditions (`conditions.py`)
    expect: Optional[str] = None  # legacy v1 `Expect:`


@dataclass
class ScenarioFile:
    title: Optional[str] = None
    meta: dict[str, str] = field(default_factory=dict)  # lower-cased header keys
    data: dict[str, str] = field(default_factory=dict)
    scenarios: list[Scenario] = field(default_factory=list)


def one_line(text: Any) -> str:
    """A value folded onto the one `Key: value` line it is written on: its lines joined by a
    space, blank ones dropped, so a description's `1. ...` lines never parse as criteria."""
    return " ".join(part.strip() for part in str(text or "").splitlines() if part.strip())


def _split_list(value: str) -> list[str]:
    """`a, b, "c, d"` -> ["a", "b", "\"c, d\""] (quotes keep a comma inside an item)."""
    out, buf, quoted = [], "", False
    for ch in value or "":
        if ch == '"':
            quoted = not quoted
        if ch == "," and not quoted:
            if buf.strip():
                out.append(buf.strip())
            buf = ""
            continue
        buf += ch
    if buf.strip():
        out.append(buf.strip())
    return out


def _add_unique(items: list[str], more: list[str]) -> list[str]:
    seen = {i.casefold() for i in items}
    for m in more:
        if m.casefold() not in seen:
            items.append(m)
            seen.add(m.casefold())
    return items


def parse_table(lines: list[str]) -> Optional[dict[str, Any]]:
    """A markdown pipe table -> {"columns", "rows"} (None when there is no header row)."""
    rows = []
    for line in lines:
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c) and any(cells):
            continue
        rows.append(cells)
    if not rows:
        return None
    columns, body = rows[0], rows[1:]
    return {"columns": columns, "rows": [(r + [""] * len(columns))[: len(columns)] for r in body]}


def parse_scenarios(text: str) -> list[Scenario]:
    """Every `##` scenario with at least one criterion, in file order."""
    scenarios: list[Scenario] = []
    current: Optional[Scenario] = None
    examples_of: Optional[Scenario] = None
    table: list[str] = []

    def close_table() -> None:
        nonlocal examples_of, table
        if examples_of is not None:
            examples_of.examples = parse_table(table)
        examples_of, table = None, []

    for line in (text or "").splitlines():
        if m := _HEADING.match(line):
            close_table()
            heading = m.group(1).strip().lower()
            if heading == EXAMPLES_SECTION:
                examples_of = current or (scenarios[-1] if scenarios else None)
                current = None
                continue
            if heading == DATA_SECTION or heading in CONTEXT_SECTIONS:
                current = None
                continue
            current = Scenario(name=m.group(1).strip())
            scenarios.append(current)
        elif examples_of is not None:
            table.append(line)
        elif current is None:
            continue
        elif (m := _CHECK.match(line)) or (m := _SAVED.match(line)):
            body = m.group(1)
            if _SAVED.match(line) or _SAVED_CHECK.match(body):
                body = _SAVED_CHECK.sub("", body, count=1).strip() if _CHECK.match(line) else body
                if current.criteria:
                    current.saved.setdefault(len(current.criteria) - 1, []).append(body)
                else:
                    current.scenario_saved.append(body)
                continue
            if current.criteria:
                current.checks.setdefault(len(current.criteria) - 1, []).append(body)
            else:
                current.scenario_checks.append(body)
        elif m := _EXPECT.match(line):
            current.expect = m.group(1)
        elif m := _STEP.match(line):
            current.criteria.append(m.group(1))
        elif m := _HEADER.match(line):
            key, value = m.group(1).lower(), m.group(2)
            if key == "event":
                current.events.append(value)
            elif key == "seed" and value:
                current.seeds.append(value)
            elif key == "stub" and value:
                current.stubs.append(value)
            elif key == "request" and value:
                current.stubs.append(f"request {value}")
            elif key == "cleanup" and value:
                current.cleanup.append(value)
            elif key in ("fresh", "start", "permissions"):
                setattr(current, key, value.strip().lower() or None)
            elif key == "conditions":
                current.conditions.update(parse_conditions(value))
            elif key == "needs":
                _add_unique(current.needs, _split_list(value))
            elif key == "tags":
                _add_unique(current.tags, _split_list(value))
            elif key in _META:
                setattr(current, _META[key], value)
    close_table()
    for s in scenarios:  # a v1 scenario's `Expect:` is its one criterion
        if s.expect and not s.criteria:
            s.criteria.append(s.expect)
    return [s for s in scenarios if s.criteria]


def parse_file(text: str) -> ScenarioFile:
    sf = ScenarioFile(scenarios=parse_scenarios(text))
    in_data = False
    seen_heading = False
    for line in (text or "").splitlines():
        if m := _HEADING.match(line):
            seen_heading = True
            in_data = m.group(1).strip().lower() == DATA_SECTION
            continue
        if not seen_heading:
            if (m := _TITLE.match(line)) and sf.title is None:
                sf.title = m.group(1)
            elif m := _HEADER.match(line):
                sf.meta[m.group(1).lower()] = m.group(2)
        elif in_data and "=" in line:
            key, _, value = line.partition("=")
            if key.strip():
                sf.data[key.strip()] = value.strip()
    return sf


# ---------- render ----------


#: The order a `Conditions:` line lists its keys in.
CONDITION_KEYS = ("os", "locale", "text_size", "appearance", "timezone", "network", "account", "setup")


def _conditions_of(value: Any) -> dict[str, str]:
    from .conditions import normalize

    return normalize(value)


def parse_conditions(text: Any) -> dict[str, str]:
    """`os=Android 13; locale=sw-KE; text_size=large` -> the conditions it names. Unknown keys and
    values that are not allowed are dropped (`conditions.normalize`)."""
    pairs = {}
    for part in str(text or "").split(";"):
        key, sep, value = part.partition("=")
        key = key.strip().lower().replace(" ", "_").replace("-", "_")
        if sep and key:
            pairs[key] = value.strip()
    return _conditions_of(pairs)


def format_conditions(conditions: Any) -> str:
    """The one `Conditions:` line: `key=value` pairs separated by `; `, a value's own `;` as `,`."""
    clean = _conditions_of(conditions)
    return "; ".join(f"{k}={one_line(clean[k]).replace(';', ',')}" for k in CONDITION_KEYS if k in clean)


def render_scenario(s: Scenario) -> str:
    lines = [f"## {one_line(s.name)}"]
    if s.scenario_id:
        lines.append(f"Scenario-Id: {s.scenario_id}")
    for key, value in (("Category", s.category), ("Persona", s.persona), ("Description", s.description),
                       ("Session", s.session), ("Account", s.account)):
        if value:
            lines.append(f"{key}: {one_line(value)}")
    if s.needs:
        lines.append("Needs: " + ", ".join(s.needs))
    if s.tags:
        lines.append("Tags: " + ", ".join(s.tags))
    for key, value in (("Fresh", s.fresh), ("Start", s.start), ("Permissions", s.permissions)):
        if value:
            lines.append(f"{key}: {value}")
    if s.conditions:
        lines.append(f"Conditions: {format_conditions(s.conditions)}")
    lines += [f"Seed: {x}" for x in s.seeds]
    lines += [f"Cleanup: {x}" for x in s.cleanup]
    for x in s.stubs:
        lines.append(f"Request: {x[len('request '):]}" if x.lower().startswith("request ") else f"Stub: {x}")
    lines += [f"Event: {x}" for x in s.events]
    lines += [f"Check: {x}" for x in s.scenario_checks]
    lines += [f"Saved: {x}" for x in s.scenario_saved]
    for i, c in enumerate(s.criteria):
        lines.append(f"{i + 1}. {one_line(c)}")
        lines += [f"   Check: {x}" for x in s.checks.get(i, [])]
        lines += [f"   Saved: {x}" for x in s.saved.get(i, [])]
    if s.examples and s.examples.get("columns"):
        cols = [str(c) for c in s.examples["columns"]]
        lines += ["", "## Examples", "| " + " | ".join(cols) + " |", "| " + " | ".join("---" for _ in cols) + " |"]
        for row in s.examples.get("rows") or []:
            lines.append("| " + " | ".join(str(c) for c in row) + " |")
    return "\n".join(lines) + "\n"


def render_file(scenarios: list[Scenario], *, data: Optional[dict[str, Any]] = None, title: Optional[str] = None,
                meta: Optional[dict[str, str]] = None) -> str:
    parts: list[str] = []
    head = ([f"# {title}"] if title else []) + [f"{k.title()}: {v}" for k, v in (meta or {}).items()]
    if head:
        parts.append("\n".join(head) + "\n")
    parts += [render_scenario(s) for s in scenarios]
    if data:
        parts.append("## Data\n" + "\n".join(f"{k} = {v}" for k, v in data.items()) + "\n")
    return "\n".join(parts)


# ---------- rows (qa_scenarios) ----------


def checks_json(s: Scenario) -> list[dict[str, Any]]:
    """The row's `checks` (a JSON list, at most 50): one `{"criterion_index": i, "line": ...}` per
    criterion check, `criterion_index` null for a scenario-level one; read-backs as `saved ...`."""
    out: list[dict[str, Any]] = []
    for line in list(s.scenario_checks) + [checks_mod.SAVED_PREFIX + x for x in s.scenario_saved]:
        out.append({"criterion_index": None, "line": line})
    for i in range(len(s.criteria)):
        for line in list(s.checks.get(i, [])) + [checks_mod.SAVED_PREFIX + x for x in s.saved.get(i, [])]:
            out.append({"criterion_index": i, "line": line})
    return out


def checks_by_index(lines: dict[int, list[str]], scenario: Optional[list[str]] = None) -> list[dict[str, Any]]:
    """`{0: [...], 1: [...]}` (and scenario-level lines) as the row's `checks` list."""
    return checks_json(Scenario(name="", criteria=[""] * (max(lines, default=-1) + 1), checks=dict(lines),
                                scenario_checks=list(scenario or [])))


def to_row(s: Scenario, data: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    row: dict[str, Any] = {
        "name": s.name, "category": s.category, "persona": s.persona, "description": s.description,
        "criteria": list(s.criteria), "checks": checks_json(s), "needs": list(s.needs), "tags": list(s.tags),
    }
    if data:
        row["data"] = dict(data)
    if s.seeds:
        row["seed"] = list(s.seeds)
    if s.cleanup:
        row["cleanup"] = list(s.cleanup)
    if s.events:
        row["events"] = list(s.events)
    if s.examples:
        row["examples"] = dict(s.examples)
    if s.session:
        row["session"] = s.session
    if s.fresh is not None:
        row["fresh"] = _fresh_bool(s.fresh)
    if s.permissions:
        row["permissions"] = "ask" if s.permissions.strip().lower() == "ask" else None
    if s.conditions:
        row["conditions"] = dict(s.conditions)
    return {k: v for k, v in row.items() if v is not None}


def _fresh_bool(value: str) -> Optional[bool]:
    word = value.strip().lower()
    return False if word in ("no", "false", "0", "off", "keep") else True if word else None


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        import json

        try:
            value = json.loads(value)
        except ValueError:
            return [value] if value.strip() else []
    return [str(x) for x in value] if isinstance(value, (list, tuple)) else []


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        import json

        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return dict(value) if isinstance(value, dict) else {}


def _check_items(value: Any) -> list[tuple[Optional[int], str]]:
    """(criterion index or None, line) from a row's `checks`: the list form
    (`[{"criterion_index", "line"}]`), or the older `{"scenario": [...], "criteria": {"0": [...]}}`."""
    if isinstance(value, str):
        import json

        try:
            value = json.loads(value)
        except ValueError:
            return []
    out: list[tuple[Optional[int], str]] = []
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict) and str(item.get("line") or "").strip():
                idx = item.get("criterion_index")
                try:
                    out.append((int(idx) if idx is not None else None, str(item["line"])))
                except (TypeError, ValueError):
                    continue
            elif isinstance(item, str) and item.strip():
                out.append((None, item))
        return out
    if isinstance(value, dict):
        out += [(None, line) for line in _as_list(value.get("scenario"))]
        for key, lines in _as_dict(value.get("criteria")).items():
            try:
                i = int(key)
            except (TypeError, ValueError):
                continue
            out += [(i, line) for line in _as_list(lines)]
    return out


def from_row(row: dict[str, Any]) -> Scenario:
    s = Scenario(
        name=str(row.get("name") or ""), criteria=_as_list(row.get("criteria")),
        category=row.get("category") or None, persona=row.get("persona") or None,
        description=row.get("description") or None, scenario_id=str(row["id"]) if row.get("id") else None,
        needs=_as_list(row.get("needs")), tags=_as_list(row.get("tags")), seeds=_as_list(row.get("seed")),
        cleanup=_as_list(row.get("cleanup")), events=_as_list(row.get("events")), session=row.get("session") or None,
        permissions=row.get("permissions") or None, examples=_as_dict(row.get("examples")) or None,
        fresh=None if row.get("fresh") is None else ("yes" if row.get("fresh") else "no"),
        conditions=parse_conditions(row.get("conditions")) if isinstance(row.get("conditions"), str) and "=" in str(row.get("conditions"))
        else _conditions_of(row.get("conditions")),
    )
    for index, line in _check_items(row.get("checks")):
        if checks_mod.is_saved(line):
            body = _SAVED_CHECK.sub("", line, count=1).strip()
            (s.saved.setdefault(index, []) if index is not None else s.scenario_saved).append(body)
        elif index is not None:
            s.checks.setdefault(index, []).append(line)
        else:
            s.scenario_checks.append(line)
    return s


# ---------- lint ----------

SEVERITY_COST = {"error": 25, "warning": 10, "info": 2}
_CLICK = re.compile(
    r"^\s*(?:then\s+|and\s+|first\s+|next\s+)?(?:tap|click|press|type|enter|swipe|scroll|long[- ]press|double[- ]tap|"
    r"select|choose|fill(?:\s+in)?|go\s+to|navigate\s+to|open|launch|wait|hit|drag|toggle|uncheck)\b",
    re.IGNORECASE,
)
_SELECTOR = re.compile(
    r"data-test(?:id)?|testID|test[_-]?id\b|accessibilityIdentifier|accessibility id|xpath|"
    r"(?<![\w/])//[a-z]+|(?<!\w)css=|\bid=\S|\[data-[\w-]+|(?<![\w&])#[a-z][\w-]{2,}\b|"
    r"\b[a-z][a-z0-9]*\.[a-z][a-z0-9]*[A-Z]\w*\b",
)
_SLEEP = re.compile(
    r"\b(?:sleep|pause)\s*\d|\bwait(?:ing)?\s+(?:for\s+)?\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds?|ms|milliseconds?|minutes?)\b",
    re.IGNORECASE,
)
_QUOTED = re.compile(r"\"([^\"]{2,})\"|“([^”]{2,})”")
_INPUT_BEFORE = re.compile(r"\b(?:for|typing|type|types|entering|enter|enters|searching|search|with|named|called)\s*$", re.IGNORECASE)
_WORD = re.compile(r"[a-z0-9]+")
_RUN_TAG = re.compile(r"\{\{\s*tag4?\s*\}\}|\bQA-")
_JUNK = re.compile(
    r"^(?:test(?:ing)?|asdf+|qwerty|foo|bar|baz|lorem(?:\s+ipsum.*)?|dummy|sample|xxx+|abc|aaa+|user|name|value|placeholder)[\s_-]*\d*$"
    r"|^[A-Z][a-z]+\d{3,}$",
    re.IGNORECASE,
)
_BIND = re.compile(r"\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$")
_OPTION_LIST = re.compile(r'["“][^"“”\n]{1,30}["”](?:\s*(?:,|/|,?\s*(?:and|or))\s*["“][^"“”\n]{1,30}["”]){3,}')
_ONE_OF = re.compile(r"^one\s+of\s+(.+)$", re.IGNORECASE)
_PATTERN_GEN = re.compile(r"^pattern\s+(.+)$", re.IGNORECASE)


@dataclass(frozen=True)
class Finding:
    rule: str
    severity: str  # error | warning | info
    message: str
    criterion: Optional[int] = None  # 0-based, None for the scenario

    def as_dict(self) -> dict[str, Any]:
        return {"rule": self.rule, "severity": self.severity, "message": self.message, "criterion": self.criterion}

    def line(self) -> str:
        where = f"criterion {self.criterion + 1}" if self.criterion is not None else "scenario"
        return f"{self.severity} {self.rule} ({where}): {self.message}"


def _norm(text: str) -> str:
    text = re.sub(r"\s*\[(warning|checked)\]\s*$", "", text or "", flags=re.IGNORECASE)
    return " ".join(_WORD.findall(text.lower()))


def _quotes_ui_text(text: str) -> bool:
    for m in _QUOTED.finditer(text):
        if not _INPUT_BEFORE.search(text[: m.start()]):
            return True
    return False


def check_generator(value: str) -> Optional[str]:
    """Why a `one of` / `pattern` Data value cannot draw a value (None when fine or plain)."""
    v = str(value or "").strip()
    if m := _ONE_OF.match(v):
        options = [o.strip() for o in m.group(1).split("|")]
        return None if all(options) and len(options) >= 2 else "`one of` needs two or more options separated by |"
    if m := _PATTERN_GEN.match(v):
        spec = m.group(1).strip()
        depth = 0
        for ch in spec:
            depth += ch == "["
            depth -= ch == "]"
            if depth < 0:
                return "pattern: a ] with no ["
        if depth:
            return "pattern: a [ with no ]"
    return None


def _known(name: str, names: set[str]) -> bool:
    low = name.lower()
    return low in names or low.startswith("qa.") or ("." in low and low.split(".", 1)[0] in names)


def lint_scenario(s: Scenario, data: Optional[dict[str, str]] = None) -> list[Finding]:
    """Style findings for one scenario (docs/scenario-format.md §4). Pure; never blocks anything."""
    out: list[Finding] = []
    criteria = list(s.criteria)
    if not criteria:
        out.append(Finding("criteria-count", "error", "No criteria: state 2 to 8 outcomes the user can observe."))
    elif len(criteria) < MIN_CRITERIA:
        out.append(Finding("criteria-count", "error", f"One criterion: Orcha stores 2 to {MAX_CRITERIA_STORED}; state the outcome it leads to as well."))
    elif len(criteria) > MAX_CRITERIA:
        out.append(Finding("criteria-count", "warning", f"{len(criteria)} criteria: more than {MAX_CRITERIA} usually means two journeys; split it."))
    elif len(criteria) > ONE_WORKFLOW_MAX:
        out.append(Finding("too-many-steps", "warning",
                           f"{len(criteria)} criteria: one workflow's outcomes rarely need more than {ONE_WORKFLOW_MAX}; "
                           "a side behaviour is its own small scenario."))
    if not (s.description or "").strip():
        out.append(Finding("no-description", "warning", "No description: say the user's goal in one sentence."))
    seen: dict[str, int] = {}
    for i, text in enumerate(criteria):
        if _CLICK.match(text):
            out.append(Finding("click-script", "warning", "Reads like a click script; state what the user sees or can do instead.", i))
        if m := _SELECTOR.search(text):
            out.append(Finding("selector", "warning", f"Selector or test id {m.group(0)!r} in a criterion; use the words on screen (ids go in Check: lines).", i))
        if m := _SLEEP.search(text):
            out.append(Finding("sleep", "warning", f"Fixed wait {m.group(0)!r}; a check polls instead (Check: ... within 10s).", i))
        if _OPTION_LIST.search(text):
            out.append(Finding("inventory", "warning", "Lists every option of a control; a scenario checks the outcome of choosing one.", i))
        key = _norm(text)
        if key and key in seen:
            out.append(Finding("duplicate-criterion", "warning", f"Says the same as criterion {seen[key] + 1}.", i))
        elif key:
            seen[key] = i
        lines = list(s.checks.get(i) or [])
        if _quotes_ui_text(text) and not lines:
            out.append(Finding("quoted-text-unchecked", "warning", "Quotes UI text but has no Check: line to hold it.", i))
        for a, b in checks_mod.contradictions(lines):
            out.append(Finding("contradictory-checks", "error", f"Check: {a} and Check: {b} can never both hold; keep the one the criterion means.", i))
        for line in lines:
            parsed = checks_mod.parse_check(line)
            if parsed.problems:
                out.append(Finding("bad-check", "error", f"Check: {line}: {'; '.join(parsed.problems)}.", i))
            elif checks_mod.transient_check(parsed, text):
                out.append(Finding("transient-check", "warning",
                                   f"Check: {line} is on a transient state, gone by the time the criterion is reported; write it with appears.", i))
    for line in s.scenario_checks:
        parsed = checks_mod.parse_check(line)
        if parsed.problems:
            out.append(Finding("bad-check", "error", f"Check: {line}: {'; '.join(parsed.problems)}."))
    if s.description and _SLEEP.search(s.description):
        out.append(Finding("sleep", "warning", "Fixed wait in the description; a check polls instead."))

    for key, value in (data or {}).items():
        if why := check_generator(value):
            out.append(Finding("bad-generator", "error", f"Data {key!r}: {why}."))
    texts: list[tuple[Optional[int], str]] = [(None, s.description or "")]
    texts += list(enumerate(criteria))
    texts += [(i, x) for i, xs in s.checks.items() for x in xs]
    texts += [(None, x) for x in [*s.scenario_checks, *s.seeds, *s.cleanup]]
    texts += [(None, str(v)) for v in (data or {}).values()]
    for idx, text in texts:
        if m := _RUN_TAG.search(text):
            out.append(Finding("run-tag-shown", "warning",
                               f"{m.group(0)!r} puts the run tag in test data: use a realistic value for the app's domain and locale.", idx))
            break
    cells = [str(c) for row in ((s.examples or {}).get("rows") or []) for c in row]
    for value in [*(str(v) for v in (data or {}).values() if not (_ONE_OF.match(str(v).strip()) or _PATTERN_GEN.match(str(v).strip()))), *cells]:
        if value.strip() and _JUNK.match(value.strip()):
            out.append(Finding("placeholder-value", "warning",
                               f"{value.strip()!r} is not a value a real user would enter; use realistic data for the app's domain."))
            break

    names = {k.lower() for k in (data or {})} | {"tag", "tag4"}
    names |= {str(c).strip().lower() for c in ((s.examples or {}).get("columns") or [])}
    names |= {m.group(1).lower() for line in s.seeds if (m := _BIND.search(line))}
    reported: set[str] = set()
    fields = list(texts) + [(i, x) for i, xs in s.saved.items() for x in xs]
    for idx, text in fields:
        for m in _PLACEHOLDER.finditer(text):
            name = m.group(1)
            if not _known(name, names) and name.lower() not in reported:
                reported.add(name.lower())
                out.append(Finding("unresolved-placeholder", "warning",
                                   f"{{{{{name}}}}} has no value: add it to Data, an Examples column, or a seed's 'as {name.split('.')[0]}'.", idx))
    return out


def score(findings: list[Finding]) -> int:
    """0-100 (100: nothing to say)."""
    return max(0, 100 - sum(SEVERITY_COST.get(f.severity, 0) for f in findings))


def lint_text(findings: list[Finding]) -> str:
    if not findings:
        return "lint: clean (100)"
    return f"lint: score {score(findings)}\n" + "\n".join(f"- {f.line()}" for f in findings)
