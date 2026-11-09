"""Data depth: how many distinct input partitions a flow tries (#413, "Data depth").

A scenario's data is its Examples table (`orcha.scenarios.examples`, one run per row) and its seeds. Each
row is sorted into the partition its values fall in, the way a tester names them:

- `empty`     a value left blank (a required field the person skips);
- `invalid`   a value the app should refuse: an email without an @, letters in an amount, a
              date that does not exist, a negative quantity, markup or a quote where text goes;
- `boundary`  a value on an edge: zero or one, a very large number, one character, a very long
              text;
- `locale`    a value from somewhere else: letters outside ASCII, a comma decimal, a currency
              other than the dollar, an international phone number;
- `partition` an ordinary valid value.

Two rows are the same partition when every column falls in the same class (two ordinary
names are one partition; an ordinary name and a long one are two). A scenario with seeds adds one
`seeded` partition. A scenario with no table and no seeds tries one partition, its own data.

No model is called; the rules are words and shapes, so the count is the same on every read.
"""

from __future__ import annotations

import json
import re
from typing import Any

TECHNIQUES = ("partition", "boundary", "invalid", "empty", "locale")
#: Most important first: a row with an empty cell is an empty row whatever else it holds.
PRIORITY = ("empty", "invalid", "boundary", "locale", "partition")
TECHNIQUE_LABEL = {
    "partition": "Ordinary values", "boundary": "Boundaries", "invalid": "Invalid input", "empty": "Empty fields",
    "locale": "Other locales", "seeded": "Seeded records",
}
LONG_TEXT = 100
BIG_NUMBER = 1_000_000

_NUMERIC_COL = re.compile(r"(amount|price|qty|quantity|count|age|number|total|size|weight|cost|fee|rate|percent|score|limit|days|nights|guests|people|seats)", re.I)
_EMAIL_COL = re.compile(r"e-?mail", re.I)
_DATE_COL = re.compile(r"(date|day|dob|birth|check.?in|check.?out|start|end|due)", re.I)
_PHONE_COL = re.compile(r"(phone|mobile|tel)", re.I)
_SECRET_REF = re.compile(r"^secret:sec_[0-9a-f]{8,64}$")
_NUMBER = re.compile(r"^[-+]?\d+(?:[.,]\d+)?$")
_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_MARKUP = re.compile(r"(<\s*script|<[a-z]+[^>]*>|'\s*or\s+1\s*=\s*1|;\s*drop\s+table)", re.I)
_CURRENCY = re.compile(r"[€£¥₹₦₩₺₽]|R\$|E£|\b(KES|KSh|TZS|TSh|UGX|USh|EUR|GBP|NGN|INR|ZAR|BRL|JPY|AED|RWF|ETB|EGP|Br)\b")
_COMMA_DECIMAL = re.compile(r"\d,\d{2}(?!\d)")


def _loads(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def _is_date(text: str) -> bool | None:
    m = _DATE.match(text)
    if not m:
        return None
    y, mo, d = (int(x) for x in m.groups())
    if not 1 <= mo <= 12 or d < 1:
        return False
    days = [31, 29 if (y % 4 == 0 and y % 100 != 0) or y % 400 == 0 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
    return d <= days


def cell_class(column: str, value: Any) -> str:
    """The class one cell falls in: empty, invalid, boundary, locale or partition. A sealed secret
    (`secret:sec_…`) is an ordinary value: its text is never read."""
    text = "" if value is None else str(value)
    if _SECRET_REF.match(text.strip()):
        return "partition"
    t = text.strip()
    if not t:
        return "empty"
    if _MARKUP.search(t):
        return "invalid"
    if _EMAIL_COL.search(column) and ("@" not in t or " " in t or t.startswith("@") or t.endswith("@")):
        return "invalid"
    date = _is_date(t)
    if date is False:
        return "invalid"
    numeric = bool(_NUMERIC_COL.search(column))
    if numeric and (not re.search(r"\d", t) or re.search(r"[A-Za-z]", _CURRENCY.sub("", t).replace("$", ""))):
        return "invalid"
    if _NUMBER.match(t):
        n = float(t.replace(",", "."))
        if n < 0 and numeric:
            return "invalid"
        if numeric and (n in (0, 1) or abs(n) >= BIG_NUMBER):
            return "boundary"
    if len(t) >= LONG_TEXT or (len(t) == 1 and not t.isdigit()):
        return "boundary"
    if any(ord(c) > 127 for c in t if c.isalpha()) or _CURRENCY.search(t) or _COMMA_DECIMAL.search(t):
        return "locale"
    if _PHONE_COL.search(column) and t.startswith("+") and not t.startswith("+1"):
        return "locale"
    return "partition"


def row_technique(values: dict[str, Any]) -> str:
    """The partition a row tests, by its most telling cell (`PRIORITY`)."""
    classes = {cell_class(k, v) for k, v in values.items()}
    for tech in PRIORITY:
        if tech in classes:
            return tech
    return "partition"


def row_key(values: dict[str, Any]) -> tuple[tuple[str, str], ...]:
    """The partition a row is in: every column's class, so two ordinary rows are one."""
    return tuple(sorted((str(k), cell_class(str(k), v)) for k, v in values.items()))


def table_rows(scenario: dict[str, Any]) -> list[dict[str, str]]:
    """The Examples table's rows as `{column: value}`."""
    table = _loads(scenario.get("examples"))
    if not isinstance(table, dict):
        return []
    cols = [str(c) for c in table.get("columns") or []]
    out = []
    for row in table.get("rows") or []:
        if isinstance(row, list):
            out.append({c: "" if i >= len(row) or row[i] is None else str(row[i]) for i, c in enumerate(cols)})
    return out


def has_seeds(scenario: dict[str, Any]) -> bool:
    seed = _loads(scenario.get("seed"))
    return bool(seed) and isinstance(seed, (list, dict))


def _sealed(column: str, *values: Any) -> bool:
    from portal_backend.qa_examples import is_secret_column

    return is_secret_column(column) or any(_SECRET_REF.match(str(v or "")) for v in values)


def _same_row(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Whether table row `a` is the applied suggestion `b`, by every column but the secret ones: a
    sealed cell is never read, and saving the table seals a password the suggestion held plain."""
    open_ = {k: v for k, v in b.items() if not _sealed(str(k), v, a.get(k))}
    return bool(open_) and all(str(a.get(k, "")) == str(v) for k, v in open_.items())


def depth(scenario: dict[str, Any], orcha_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """`{partitions, kinds, rows, orcha_rows, orcha_partitions}` of one scenario.

    `orcha_rows`: the rows Orcha suggested and a person applied (`data_variations`); only
    those still in the table count (a person may have removed one since)."""
    rows = table_rows(scenario)
    keys = {row_key(r) for r in rows}
    kinds = {row_technique(r) for r in rows}
    if has_seeds(scenario):
        keys.add((("seed", "seeded"),))
        kinds.add("seeded")
    partitions = len(keys) if keys else 1
    if not rows and not has_seeds(scenario):
        kinds = {"partition"}
    mine = [r for r in rows if any(_same_row(r, v) for v in orcha_rows or [])]
    theirs = {row_key(r) for r in rows if r not in mine} | ({(("seed", "seeded"),)} if has_seeds(scenario) else set())
    added = len({row_key(r) for r in mine} - theirs)
    return {
        "partitions": partitions,
        "kinds": sorted(kinds, key=lambda k: (PRIORITY + ("seeded",)).index(k)),
        "rows": len(rows),
        "orcha_rows": len(mine),
        "orcha_partitions": added,
    }
