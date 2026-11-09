"""Examples tables on a scenario (`scenarios.examples`, migration 079; issue #191).

A scenario can carry a data table: the same journey with different inputs and expectations.

    {"columns": ["plate", "expect"],
     "rows": [["KBX 421T", "saved"], ["kbx 421t", "saved as KBX 421T"], ["", "a plate is required"]]}

A run fans the scenario out into one child request per row (`worker/fanout.py`), each its own
session and verdict; `{{column}}` in the description, criteria, checks, seeds, cleanup lines,
stubs and data values is filled from that row (`apply_row`), the same placeholder syntax as
`## Data` keys and `{{tag}}`. A row value wins over a `## Data` key of the same name; `tag` and
`tag4` stay reserved for the run tag and cannot be columns. The checks stay the same
deterministic lines, only their values change per row. In a scenario file the table is a
`## Examples` section right after the scenario, a pipe table whose header row names the columns
(`render_markdown` / `parse_markdown`); Gherkin `Scenario Outline` + `Examples:` import writes
the same shape.

Tables converted from existing tests can be wide and long, so the rules are lenient where a
person would be: empty cells are allowed (an empty value is a value), a row shorter than the
header is padded and a longer one is an error, and a column the scenario never mentions is not
an error but is reported (`unused_columns`) so the editor can say so quietly.

`{{name}}` that is not a column is left for the run's variables, which the worker resolves
from Data, Setup output and seeded records (`as truck` on a seed gives `{{truck.id}}`). Stub
templates (`${request.body.x}`) are a different syntax and are never touched.

A cell may be a generator, in the `## Data` syntax (`one of Zawadi | Amani | Imani`, `pattern
KD[A-Z] [0-9]{3}[A-Z]`; issue #478). The worker draws it once per run, before the run, seeded by
the run tag and the column like a Data generator (`draw_generators`; the same tag draws the same
value), and fills that one value everywhere: the criteria, the description, every `Check:` and
`Saved:` line, the Data the agent reads and the row's label (`baby = Imani`). Only a cell that is
a generator as a whole is drawn: `<b>one of Zawadi | Amani</b>` is literal text (the row tests how
the app shows markup) and runs exactly as written, never half-drawn.

Secret columns (a password, PIN, one-time code, token or key): a column is secret when the table
says so (`"secret": ["PASSWORD"]`, the editor's per-column toggle) or, when the table does not say,
by its name (`is_secret_column`) or by what its values look like (`looks_secret`). Their values are
sealed (`seal`): each goes to the encrypted secrets table (`orcha.providers.secrets`, kind
`example_secret`) and the cell holds `secret:sec_<id>` instead. Everything that shows a row
(`row_label`, `display_values`, `render_markdown`, the run's `Example:` line) shows `••••` for
them, and a run never fills `{{PASSWORD}}` with the value: it fills the `<secret:example.password>`
marker, the worker reveals the value only into the run's 0600 secrets file
(`orcha.scenarios.example_secrets.run_secrets_for`), and the agent types it with `type_secret`.
"""

from __future__ import annotations

import json
import re
from typing import Any

MAX_COLUMNS = 20
MAX_ROWS = 100
MAX_CELL = 500
COLUMN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_ .\-]{0,63}$")
PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_ .\-]*?)\s*\}\}")
RESERVED = frozenset({"tag", "tag4"})
LABEL_MAX = 80
#: How a secret cell is shown anywhere a row is named or listed.
MASK = "••••"
_TOKEN_LIKE = re.compile(r"^(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA|eyJ)[-_A-Za-z0-9.]{12,}$|^[A-Za-z0-9+/_-]{32,}={0,2}$")
#: A sealed cell: a reference into the encrypted secrets table, never the value.
SECRET_REF_RE = re.compile(r"^secret:sec_[0-9a-f]{8,64}$")
#: The `secrets` table kind of a sealed examples cell.
SECRET_KIND = "example_secret"
#: Run secret names of a row's secret columns (`<secret:example.password>`).
RUN_SECRET_PREFIX = "example."


class ExamplesError(ValueError):
    pass


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def validate(value: Any) -> dict[str, Any] | None:
    """The cleaned table, None for no table (None, {}, or no rows and no columns), or
    ExamplesError. Cells become strings; a short row is padded with empty cells. A `secret` list
    (the columns marked secret) is kept, limited to the table's columns, in column order."""
    if value is None:
        return None
    if isinstance(value, str):
        if not value.strip():
            return None
        try:
            value = json.loads(value)
        except ValueError as e:
            raise ExamplesError(f"examples are not valid JSON: {e}") from e
    if not isinstance(value, dict):
        raise ExamplesError("examples must be an object with columns and rows")
    columns = value.get("columns") or []
    rows = value.get("rows") or []
    if not columns and not rows:
        return None
    if not isinstance(columns, list) or not all(isinstance(c, str) for c in columns):
        raise ExamplesError("columns must be a list of names")
    columns = [c.strip() for c in columns]
    if not columns:
        raise ExamplesError("a table with rows needs at least one column")
    if len(columns) > MAX_COLUMNS:
        raise ExamplesError(f"at most {MAX_COLUMNS} columns")
    seen: set[str] = set()
    for c in columns:
        if not COLUMN_RE.fullmatch(c):
            raise ExamplesError(f"column {c!r}: start with a letter or _, then letters, digits, spaces, '.', '_' or '-'")
        if c.lower() in RESERVED:
            raise ExamplesError(f"column {c!r} is reserved for the run tag ({{{{{c.lower()}}}}})")
        if c.lower() in seen:
            raise ExamplesError(f"column {c!r} appears twice")
        seen.add(c.lower())
    if not isinstance(rows, list):
        raise ExamplesError("rows must be a list")
    if len(rows) > MAX_ROWS:
        raise ExamplesError(f"at most {MAX_ROWS} rows (this table has {len(rows)})")
    out_rows: list[list[str]] = []
    for i, row in enumerate(rows, 1):
        if isinstance(row, dict):
            row = [row.get(c) for c in columns]
        if not isinstance(row, list):
            raise ExamplesError(f"row {i} must be a list of cells")
        if len(row) > len(columns):
            raise ExamplesError(f"row {i} has {len(row)} cells for {len(columns)} columns")
        cells = [_cell(v) for v in row] + [""] * (len(columns) - len(row))
        for v in cells:
            if len(v) > MAX_CELL:
                raise ExamplesError(f"row {i}: a cell is at most {MAX_CELL} characters")
            if "\n" in v or "\r" in v:
                raise ExamplesError(f"row {i}: a cell is one line")
        out_rows.append(cells)
    out: dict[str, Any] = {"columns": columns, "rows": out_rows}
    marked = value.get("secret")
    if marked is not None:
        if not isinstance(marked, list) or not all(isinstance(c, str) for c in marked):
            raise ExamplesError("secret must be a list of column names")
        wanted = {c.strip().lower() for c in marked}
        out["secret"] = [c for c in columns if c.lower() in wanted]
    return out


# ---------- secret columns ----------

#: A name token that alone makes a column secret.
_SECRET_TOKENS = frozenset({
    "password", "passwd", "passphrase", "passcode", "pwd", "pin", "otp", "totp", "hotp",
    "token", "secret", "apikey", "mfa", "2fa", "cvv", "cvc", "cvv2", "iban", "ssn", "credential", "credentials",
})
#: `code` / `key` are secret alone (`CODE`) or with one of these (`sms_code`, `api_key`), not in
#: `country_code` or `sort_key`.
_CODE_WITH = frozenset({"otp", "mfa", "2fa", "verification", "verify", "auth", "authentication", "security", "sms", "login",
                        "signin", "access", "confirmation", "confirm", "magic", "recovery", "backup", "reset", "one", "time", "onetime"})
_KEY_WITH = frozenset({"api", "secret", "private", "access", "auth", "license", "licence", "ssh", "signing", "encryption",
                       "client", "master", "app", "service", "account", "recovery", "setup", "totp"})
_SUBSTRINGS = ("password", "passwd", "passphrase", "passcode", "apikey", "secret", "token")
#: `pass` / `pw` alone (`PASS`) or with one of these (`user_pass`, `admin pw`), not in `pass_rate`.
_PASS_WITH = frozenset({"user", "username", "login", "admin", "account", "db", "wifi", "sign", "signin", "my", "new", "old", "current"})


def _tokens(name: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name)
    return [t for t in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if t]


def is_secret_column(name: str) -> bool:
    """Whether a column's name says it holds a secret: `PASSWORD`, `pwd`, `pin`, `otp`, `sms code`,
    `apiKey`, `client_secret`, `access token`, any case. `country_code`, `sort_key`, `email` do not."""
    if not isinstance(name, str) or not name.strip():
        return False
    tokens = _tokens(name)
    if not tokens:
        return False
    if any(t in _SECRET_TOKENS for t in tokens):
        return True
    joined = "".join(tokens)
    if any(sub in joined for sub in _SUBSTRINGS):
        return True
    if any(t in ("pass", "pw") for t in tokens) and (len(tokens) == 1 or any(t in _PASS_WITH for t in tokens)):
        return True
    if "code" in tokens and (tokens == ["code"] or any(t in _CODE_WITH for t in tokens)):
        return True
    if "key" in tokens and (tokens == ["key"] or any(t in _KEY_WITH for t in tokens)):
        return True
    return False


def is_secret_ref(value: Any) -> bool:
    """A sealed cell (`secret:sec_<id>`)."""
    return isinstance(value, str) and bool(SECRET_REF_RE.fullmatch(value))


def looks_secret(value: Any) -> bool:
    """A value that reads like a key or token whatever its column is called: a known prefix, or a
    long unbroken run of letters and digits."""
    text = str(value or "").strip()
    return bool(_TOKEN_LIKE.match(text))

def secret_columns(table: dict[str, Any] | None) -> list[str]:
    """The table's secret columns, in column order: the `secret` list when the table has one (the
    editor's toggles), else the columns whose name or values say so; a column holding a sealed
    cell is always secret."""
    if not table:
        return []
    columns = [str(c) for c in table.get("columns") or []]
    rows = [r for r in table.get("rows") or [] if isinstance(r, list)]
    marked = table.get("secret")
    out: list[str] = []
    for i, col in enumerate(columns):
        cells = [r[i] if i < len(r) else "" for r in rows]
        if any(is_secret_ref(v) for v in cells):
            out.append(col)
        elif isinstance(marked, list):
            if col.lower() in {str(m).lower() for m in marked}:
                out.append(col)
        elif is_secret_column(col) or any(looks_secret(v) for v in cells):
            out.append(col)
    return out


def has_plain_secrets(table: dict[str, Any] | None) -> bool:
    """Whether a secret column holds a value that is not sealed yet."""
    if not table:
        return False
    secret = {c.lower() for c in secret_columns(table)}
    for i, col in enumerate(table.get("columns") or []):
        if str(col).lower() not in secret:
            continue
        for row in table.get("rows") or []:
            v = row[i] if isinstance(row, list) and i < len(row) else ""
            if v not in ("", None) and not is_secret_ref(v):
                return True
    return False


def plain_secret_values(table: dict[str, Any] | None) -> list[str]:
    """The not-yet-sealed values of the table's secret columns (for a scrub). Never logged."""
    if not table:
        return []
    secret = {c.lower() for c in secret_columns(table)}
    out: list[str] = []
    for i, col in enumerate(table.get("columns") or []):
        if str(col).lower() not in secret:
            continue
        for row in table.get("rows") or []:
            v = row[i] if isinstance(row, list) and i < len(row) else ""
            if isinstance(v, str) and v and not is_secret_ref(v) and v not in out:
                out.append(v)
    return out


def seal(value: Any, store: Any = None) -> dict[str, Any] | None:
    """The table, validated, with every value of a secret column moved into the encrypted secrets
    table and the cell holding `secret:sec_<id>`; `secret` lists those columns. Sealed and empty
    cells stay as they are; the same value twice is stored once. Never logs a value."""
    table = validate(value)
    if not table:
        return table
    secret = secret_columns(table)
    if secret or "secret" in table:
        table["secret"] = secret
    if not has_plain_secrets(table):
        return table
    if store is None:
        raise ValueError("seal needs a store")
    lower = {c.lower() for c in secret}
    sealed: dict[str, str] = {}
    for i, col in enumerate(table["columns"]):
        if col.lower() not in lower:
            continue
        for row in table["rows"]:
            v = row[i]
            if v == "" or is_secret_ref(v):
                continue
            if v not in sealed:
                secret_id, _hint = store.store(SECRET_KIND, v)
                sealed[v] = f"secret:{secret_id}"
            row[i] = sealed[v]
    return table


def run_secret_name(column: str) -> str:
    """The run secret a secret column's value is typed from: `example.password` for `PASSWORD`."""
    return RUN_SECRET_PREFIX + (re.sub(r"[^A-Za-z0-9_.\-]+", "_", column.strip()).strip("_").lower() or "value")


def display_values(values: dict[str, Any] | None, secret: list[str] | set[str] | None = None) -> dict[str, str]:
    """A row's `{column: value}` as it may be shown: `••••` for a sealed cell, a column marked or
    named secret, or a value shaped like a key. The one masking rule every label and list uses."""
    marked = {str(c).lower() for c in secret or []}
    out: dict[str, str] = {}
    for k, v in (values or {}).items():
        text = _cell(v)
        if text != "" and (is_secret_ref(text) or str(k).lower() in marked or is_secret_column(str(k)) or looks_secret(text)):
            text = MASK
        out[str(k)] = text
    return out


def examples_of(scenario: dict[str, Any]) -> dict[str, Any] | None:
    """A scenario row's table, cleaned; None when it has none or it is unreadable (a broken
    table never stops a run: the scenario then runs once, as written)."""
    try:
        return validate(scenario.get("examples"))
    except ExamplesError:
        return None


def has_rows(scenario: dict[str, Any]) -> bool:
    table = examples_of(scenario)
    return bool(table and table["rows"])


def row_values(table: dict[str, Any], index: int) -> dict[str, str]:
    """`{column: value}` for row `index` (0-based); IndexError when there is no such row."""
    row = table["rows"][index]
    return dict(zip(table["columns"], row))


def masked_table(value: Any) -> Any:
    """The table as it may be shown (Ask's context and cards, a scenario's description): every
    cell of a secret column as `••••`, empty cells kept. Anything that is not a readable table
    is returned unchanged."""
    try:
        table = validate(value)
    except ExamplesError:
        return value
    if not table:
        return value
    lower = {c.lower() for c in secret_columns(table)}
    table["rows"] = [[MASK if (table["columns"][i].lower() in lower and v != "") else v for i, v in enumerate(r)] for r in table["rows"]]
    return table


def stored_values(table: dict[str, Any], index: int) -> dict[str, str]:
    """Row `index`'s values as a run request keeps them (`run_requests.example_values`): a sealed
    cell as its `secret:sec_<id>` reference, a secret column's value that is not sealed yet as
    `••••`, never the value."""
    values = row_values(table, index)
    lower = {c.lower() for c in secret_columns(table)}
    return {k: (MASK if k.lower() in lower and v != "" and not is_secret_ref(v) else v) for k, v in values.items()}


def row_label(values: dict[str, str], limit: int = LABEL_MAX, secret: list[str] | set[str] | None = None) -> str:
    """`plate = KBX 421T, expect = saved`: how a row is named in results (empty cells shown as
    `(empty)`, secret ones as `••••`, `display_values`), cut at `limit` characters."""
    shown = display_values(values, secret)
    text = ", ".join(f"{k} = {v if v != '' else '(empty)'}" for k, v in shown.items())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _lookup(values: dict[str, str]) -> dict[str, str]:
    """Columns are matched without regard to case, as Gherkin authors write `<Plate>`/`<plate>`."""
    return {k.lower(): v for k, v in values.items()}


def fill(text: str, values: dict[str, str]) -> str:
    """`{{column}}` replaced from `values`; any other `{{name}}` is left for the run's
    variables."""
    if not text or "{{" not in text:
        return text
    lookup = _lookup(values)

    def sub(m: re.Match[str]) -> str:
        name = m.group(1)
        return lookup[name.lower()] if name.lower() in lookup else m.group(0)

    return PLACEHOLDER.sub(sub, text)


def _fill_list(value: Any, values: dict[str, str]) -> Any:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return value
    if not isinstance(value, list):
        return value
    return [fill(v, values) if isinstance(v, str) else v for v in value]


def _fill_checks(value: Any, values: dict[str, str]) -> Any:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return value
    if not isinstance(value, dict):
        return value
    out = dict(value)
    out["scenario"] = [fill(x, values) for x in value.get("scenario") or [] if isinstance(x, str)]
    out["criteria"] = {
        str(k): [fill(x, values) for x in lines or [] if isinstance(x, str)]
        for k, lines in (value.get("criteria") or {}).items()
    }
    return out


#: Generator syntax inside a longer cell (`<b>one of A | B</b>`, `<i>pattern KD[A-Z]</i>`).
_GENERATOR_WORDS = re.compile(r"\bone\s+of\s+[^|]+\|\s*[^|\s]|\bpattern\s+\S*[\[\\{]", re.IGNORECASE)


def literal_lookalikes(cells: dict[str, str]) -> list[str]:
    """The columns whose cell has generator syntax in it but is not a generator as a whole
    (`parser.draws`): `<b>one of Zawadi | Amani</b>` tests how the app shows markup, so the run
    types it exactly as written, and the agent is told so rather than drawing from it."""
    from portal_backend.qa_growth_variations import draws

    return [k for k, v in cells.items() if not is_secret_ref(v) and _GENERATOR_WORDS.search(str(v or "")) and not draws(v)]


def draw_generators(cells: dict[str, str], tag: str | None, secret: list[str] | set[str] | None = None) -> tuple[dict[str, str], dict[str, str]]:
    """`(cells, drawn)`: every cell that is, as a whole, a generator (`one of A | B ...`,
    `pattern ...`, `orcha.scenarios.parser.draws`) replaced by this run's value, and `drawn` =
    `{column: value}` for those. Seeded by the run tag and the column, as a `## Data` generator
    is (`parser.generate_value`), so one tag always draws the same value. No tag (not a run)
    draws nothing. A secret column is never drawn: its value goes to the run's secrets file as
    written. Any other cell is literal text, kept as written."""
    if not tag:
        return dict(cells), {}
    from portal_backend.qa_growth_variations import draws, generate_value

    lower = {str(c).lower() for c in secret or []}
    out: dict[str, str] = {}
    drawn: dict[str, str] = {}
    for k, v in cells.items():
        if k.lower() not in lower and not is_secret_ref(v) and draws(v):
            out[k] = drawn[k] = generate_value(k, v, tag)
        else:
            out[k] = v
    return out, drawn


def apply_row(scenario: dict[str, Any], index: int, tag: str | None = None) -> dict[str, Any]:
    """A copy of `scenario` with row `index` filled in everywhere a value can appear, and
    `example = {"row", "total", "values", "label"}` set for the renderer. IndexError when the
    table has no such row; the scenario unchanged when it has no table.

    `tag`: the run's tag. A generator cell is drawn for it first (`draw_generators`), so the
    criteria, checks, Data and label all carry the one value this run uses, and
    `example["drawn"]` names it (`{"baby": "Imani"}`). Without a tag the cells stay as written."""
    table = examples_of(scenario)
    if not table:
        return scenario
    secret = secret_columns(table)
    cells, drawn = draw_generators(row_values(table, index), tag, secret)
    lower = {c.lower() for c in secret}
    # A secret column fills its `<secret:NAME>` marker, never the value: the agent types it with
    # `type_secret`, and the worker puts the value only in the run's secrets file.
    values = {k: (f"<secret:{run_secret_name(k)}>" if k.lower() in lower and v != "" else v) for k, v in cells.items()}
    sealed = {run_secret_name(k): v for k, v in cells.items() if k.lower() in lower and v != ""}
    out = dict(scenario)
    if out.get("description"):
        out["description"] = fill(str(out["description"]), values)
    out["criteria"] = _fill_list(out.get("criteria") or [], values)
    out["checks"] = _fill_checks(out.get("checks"), values)
    for key in ("seed", "cleanup", "events", "stubs"):
        if out.get(key):
            out[key] = _fill_list(out[key], values)
    data = out.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    # The row's values are also variables, winning over `## Data` keys of the same name.
    out["data"] = {
        **({k: fill(v, values) if isinstance(v, str) else v for k, v in data.items()} if isinstance(data, dict) else {}),
        **{k: v for k, v in values.items() if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", k)},
    }
    out["example"] = {
        "row": index, "total": len(table["rows"]), "values": display_values(cells, secret),
        "label": row_label(cells, secret=secret),
    }
    if drawn:
        out["example"]["drawn"] = drawn
    literal = [k for k in literal_lookalikes(cells) if k.lower() not in lower]
    if literal:
        out["example"]["literal"] = literal
    if sealed:
        # `{run secret name: secret:sec_<id>}` (or a not-yet-sealed value): only the worker reads it.
        out["example"]["secrets"] = sealed
    return out


def referenced_names(scenario: dict[str, Any]) -> set[str]:
    """Every `{{name}}` the scenario mentions (lower-cased), in any field a row fills."""
    texts: list[str] = [str(scenario.get("description") or "")]
    for key in ("criteria", "seed", "cleanup", "events", "stubs"):
        value = scenario.get(key)
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                value = [value]
        texts.extend(str(v) for v in value or [])
    checks = scenario.get("checks")
    if isinstance(checks, str):
        try:
            checks = json.loads(checks)
        except ValueError:
            checks = None
    if isinstance(checks, dict):
        texts.extend(str(v) for v in checks.get("scenario") or [])
        for lines in (checks.get("criteria") or {}).values():
            texts.extend(str(v) for v in lines or [])
    data = scenario.get("data")
    if isinstance(data, dict):
        texts.extend(str(v) for v in data.values())
    return {m.group(1).lower() for t in texts for m in PLACEHOLDER.finditer(t)}


def unused_columns(scenario: dict[str, Any], table: dict[str, Any] | None = None) -> list[str]:
    """Columns no `{{column}}` in the scenario refers to: kept (a converted test may carry a
    column for documentation), but worth a quiet note in the editor."""
    table = table if table is not None else examples_of(scenario)
    if not table:
        return []
    used = referenced_names(scenario)
    return [c for c in table["columns"] if c.lower() not in used]


def selected_rows(table: dict[str, Any] | None, wanted: list[int] | None) -> list[int]:
    """The row indexes a run covers: `wanted` (a Retry failed rows list) filtered to rows that
    exist, or every row."""
    if not table:
        return []
    n = len(table["rows"])
    if wanted is None:
        return list(range(n))
    return sorted({i for i in wanted if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < n})


# ---------- markdown (scenario files, export, Gherkin import) ----------


def _escape(cell: str) -> str:
    return cell.replace("\\", "\\\\").replace("|", "\\|")


def render_markdown(table: dict[str, Any] | None) -> list[str]:
    """`## Examples` and a pipe table, as lines; [] for no table. A secret column's cells are
    written as their `secret:sec_<id>` reference (a value not sealed yet as `••••`), never a value."""
    if not table or not table.get("columns"):
        return []
    cols = table["columns"]
    lower = {c.lower() for c in secret_columns(table)}
    lines = ["## Examples", "| " + " | ".join(_escape(c) for c in cols) + " |", "|" + "|".join(" --- " for _ in cols) + "|"]
    for row in table.get("rows") or []:
        cells = []
        for i, v in enumerate(row):
            text = _cell(v)
            if i < len(cols) and cols[i].lower() in lower and text and not is_secret_ref(text):
                text = MASK
            cells.append(_escape(text))
        lines.append("| " + " | ".join(cells) + " |")
    return lines


_SEPARATOR = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")


def split_row(line: str) -> list[str]:
    """The cells of one pipe-table line (`\\|` is a literal bar)."""
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|") and not text.endswith("\\|"):
        text = text[:-1]
    cells: list[str] = []
    cur: list[str] = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == "\\" and i + 1 < len(text) and text[i + 1] in "|\\":
            cur.append(text[i + 1])
            i += 2
            continue
        if c == "|":
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(c)
        i += 1
    cells.append("".join(cur).strip())
    return cells


def parse_markdown(lines: list[str]) -> dict[str, Any] | None:
    """A pipe table (the lines after `## Examples`) as `{columns, rows}`, or None when there is
    no header row. The `---` separator line is optional. Not validated: call `validate`."""
    table_lines = [ln for ln in lines if ln.strip().startswith("|")]
    if not table_lines:
        return None
    header = split_row(table_lines[0])
    rows = [split_row(ln) for ln in table_lines[1:] if not _SEPARATOR.match(ln)]
    return {"columns": header, "rows": rows}
