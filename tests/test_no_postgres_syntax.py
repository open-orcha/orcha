"""Lint: no Postgres-only SQL construct is spelled inline in portal_backend (GH #258, plan S1).

Every construct that differs between Postgres and SQLite must go through
`portal_backend/sql.py` (the one file exempt from this lint). Sites not yet ported sit on an
allow-list, `tests/fixtures/no_postgres_syntax_allowlist.txt`, keyed `relpath:line:token`.
The list may only SHRINK: a hit that is not listed fails, and so does a listed entry that
no longer matches a hit (a ported or moved site must take its entry with it).

Scope follows the plan text: `portal_backend/**/*.py`, excluding `sql.py`. `main.py` (the
app factory next to portal_backend) holds no SQL and is out of scope.

Matching strategy (why not a plain grep):
- SQL tokens are matched only inside STRING LITERALS, found with `tokenize` (whole f-strings
  on every Python version, docstrings skipped via `ast`). SQL can only reach the database
  through a string, so this drops the false positives a raw grep hits in Python code, e.g.
  `any(...)` for `ANY(`, `time.strftime(` for `strftime(`, `datetime(...)` for `datetime(`,
  and prose in comments and docstrings ("no FOR UPDATE here"), which executes nothing.
- SQL tokens are case-insensitive regexes with flexible whitespace, because SQL is: a raw
  case-sensitive grep for `EXTRACT(EPOCH` misses `extract(epoch FROM ...)`. `::json` is
  word-bounded so a `::jsonb` hit is not double-counted, and `::int` does not match `::interval`.
- Driver tokens (`psycopg`, `Jsonb(`) are Python-level, so they match NAME tokens in code:
  imports, `psycopg.errors.UniqueViolation`, `Jsonb(x)`. Comments/docstrings don't count.
- One hit per (file, physical line, token); the line is where the match starts.
- `ANY(`/`ALL(` must follow a comparison operator (`= ANY(`, `<> ALL(`), so English in an
  OpenAPI description ("if any (...)") is not a hit. `ALL(` and `::uuid` are not in the plan's
  S1 list either: quorate-v2 added `x <> ALL(%s)` and `%s::uuid` sites (sql.not_in_list() /
  sql.uuid_param() are their ports).
- `RIGHT(` is not in the plan's S1 token list; it was added because
  container_metrics_routes.py uses `right(wr.output, %s)`, which SQLite does not have
  (sql.right() is its port).
"""

import ast
import io
import pathlib
import re
import tokenize

REPO = pathlib.Path(__file__).resolve().parent.parent
BACKEND = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "portal_backend"
ALLOWLIST = pathlib.Path(__file__).resolve().parent / "fixtures" / "no_postgres_syntax_allowlist.txt"
EXEMPT = {"sql.py"}

# token (as named in the plan and the allow-list) -> regex matched inside SQL string literals
SQL_TOKENS = {
    "interval '": r"\binterval\s*'",
    "make_interval": r"\bmake_interval\b",
    "EXTRACT(EPOCH": r"\bextract\s*\(\s*epoch\b",
    "::jsonb": r"::\s*jsonb\b",
    "::json": r"::\s*json\b",
    "::text": r"::\s*text\b",
    "::int": r"::\s*int(?:eger|[248])?\b",
    "::timestamptz": r"::\s*timestamptz\b",
    "::interval": r"::\s*interval\b",
    "::uuid": r"::\s*uuid\b",
    "ANY(": r"[=<>]\s*any\s*\(",
    "ALL(": r"[=<>]\s*all\s*\(",
    "@>": r"@>",
    "unnest(": r"\bunnest\s*\(",
    "LATERAL": r"\blateral\b",
    "DISTINCT ON": r"\bdistinct\s+on\b",
    "json_build_object": r"\bjsonb?_build_object\b",
    "json_agg": r"\bjsonb?_agg\b",
    "LEFT(": r"\bleft\s*\(",
    "RIGHT(": r"\bright\s*\(",
    "GREATEST(": r"\bgreatest\s*\(",
    "ILIKE": r"\bilike\b",
    "FOR UPDATE": r"\bfor\s+update\b",
    "SKIP LOCKED": r"\bskip\s+locked\b",
    "pg_advisory": r"\bpg_advisory",
    "to_regclass": r"\bto_regclass\b",
    "datetime(": r"\bdatetime\s*\(",
    "strftime(": r"\bstrftime\s*\(",
}
_SQL_RES = {tok: re.compile(rx, re.IGNORECASE) for tok, rx in SQL_TOKENS.items()}
CODE_TOKENS = ("psycopg", "Jsonb(")
_FSTRING_START = getattr(tokenize, "FSTRING_START", None)  # Python >= 3.12
_FSTRING_END = getattr(tokenize, "FSTRING_END", None)


def _docstring_starts(source: str) -> set:
    """(line, col) of every bare string-expression statement (docstrings and the like)."""
    return {
        (node.lineno, node.col_offset)
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    }


def _offsets(source: str) -> list:
    """Absolute character offset of the start of each (1-based) line."""
    starts, total = [0, 0], 0
    for line in source.splitlines(keepends=True):
        total += len(line)
        starts.append(total)
    return starts


def _scan_source(source: str) -> set:
    """{(line, token)} for every lint hit in one module's source text."""
    hits = set()
    docstrings = _docstring_starts(source)
    line_at = _offsets(source)
    toks = list(tokenize.generate_tokens(io.StringIO(source).readline))
    spans, depth, fstart = [], 0, None
    for i, tok in enumerate(toks):
        if tok.type == tokenize.NAME:
            if tok.string == "psycopg":
                hits.add((tok.start[0], "psycopg"))
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            if tok.string == "Jsonb" and nxt is not None and nxt.string == "(":
                hits.add((tok.start[0], "Jsonb("))
        elif tok.type == tokenize.STRING and depth == 0:
            if tok.start not in docstrings:
                spans.append((tok.start, tok.end))
        elif _FSTRING_START is not None and tok.type == _FSTRING_START:
            depth, fstart = depth + 1, fstart if depth else tok.start
        elif _FSTRING_END is not None and tok.type == _FSTRING_END:
            depth -= 1
            if depth == 0 and fstart not in docstrings:
                spans.append((fstart, tok.end))
    for (srow, scol), (erow, ecol) in spans:
        begin = line_at[srow] + scol
        text = source[begin:line_at[erow] + ecol]
        for token, rx in _SQL_RES.items():
            for m in rx.finditer(text):
                hits.add((srow + text.count("\n", 0, m.start()), token))
    return hits


def scan_backend() -> set:
    """{"relpath:line:token"} for every hit under portal_backend (sql.py exempt)."""
    found = set()
    for path in sorted(BACKEND.rglob("*.py")):
        rel = path.relative_to(BACKEND).as_posix()
        if rel in EXEMPT:
            continue
        for line, token in _scan_source(path.read_text(encoding="utf-8")):
            found.add(f"{rel}:{line}:{token}")
    return found


def load_allowlist() -> list:
    entries = []
    for raw in ALLOWLIST.read_text(encoding="utf-8").splitlines():
        if raw.strip() and not raw.lstrip().startswith("#"):
            entries.append(raw.rstrip("\n"))
    return entries


def _sort_key(entry: str):
    rel, line, token = entry.split(":", 2)
    return rel, int(line), token


def test_allowlist_is_well_formed():
    entries = load_allowlist()
    dupes = sorted({e for e in entries if entries.count(e) > 1})
    assert not dupes, f"duplicate allow-list entries: {dupes}"
    for entry in entries:
        rel, line, token = entry.split(":", 2)
        assert line.isdigit(), f"allow-list entry {entry!r}: line must be an integer"
        assert token in SQL_TOKENS or token in CODE_TOKENS, f"allow-list entry {entry!r}: unknown token"
        assert rel not in EXEMPT, f"allow-list entry {entry!r}: {rel} is exempt, never list it"


def test_no_new_postgres_only_syntax():
    unlisted = sorted(scan_backend() - set(load_allowlist()), key=_sort_key)
    lines = []
    for entry in unlisted:
        rel, line, token = entry.split(":", 2)
        lines.append(
            f"  {BACKEND.relative_to(REPO)}/{rel}:{line}  token {token!r} -> route it through "
            f"portal_backend/sql.py or, if porting later, add path:line `{entry}` to the "
            f"allow-list {ALLOWLIST.relative_to(REPO)}"
        )
    assert not unlisted, "Postgres-only SQL outside portal_backend/sql.py:\n" + "\n".join(lines)


def test_allowlist_only_shrinks():
    stale = sorted(set(load_allowlist()) - scan_backend(), key=_sort_key)
    assert not stale, "stale allow-list entries (site ported or moved): delete or re-point them in " + (
        f"{ALLOWLIST.relative_to(REPO)}:\n" + "\n".join(f"  {e}" for e in stale)
    )


def test_scanner_matches_sql_strings_only():
    """Teeth for the matching strategy itself (independent of the allow-list)."""
    src = (
        '"""Docstring: FOR UPDATE, ANY(x) and datetime( are prose here."""\n'
        "import psycopg\n"
        "# comment: now() - interval '1 day'\n"
        "ok = any([1]) and time.strftime('%Y') and datetime(2026, 1, 1)\n"
        "q = \"SELECT 1 FROM t WHERE ts > now() - interval '1 day'\"\n"
        "f = f\"\"\"SELECT {x}\n  FROM t WHERE id = any(%s) FOR   UPDATE\"\"\"\n"
        "c = 'x::jsonb'\n"
        "p = Jsonb(v)\n"
        "d = 'Created from this task, if any (none here)'\n"
        "n = 'WHERE e.name <> ALL(%s) AND id = %s::uuid'\n"
        "j = 'WHERE changes @> %s'\n"
    )
    assert _scan_source(src) == {
        (2, "psycopg"), (5, "interval '"), (7, "ANY("), (7, "FOR UPDATE"),
        (8, "::jsonb"), (9, "Jsonb("), (11, "ALL("), (11, "::uuid"),
        (12, "@>"),
    }
