"""Dialect helpers: ONE spelling for every SQL construct that differs between Postgres and SQLite.

GH #258, no-Docker/no-Postgres plan Part 4 S1. NOTHING IMPORTS THIS MODULE YET: Phase B (plan
PRs 4-5, "S2") ports the Postgres-only sites through these helpers while the portal still runs
on Postgres, S3 swaps the engine, and the cleanup PR deletes the Postgres branches.
tests/test_no_postgres_syntax.py fails the build when a Postgres-only construct is spelled
inline anywhere else in portal_backend (the not-yet-ported sites sit on its allow-list).

Rules for this module:
- Pure string / parameter builders. No DB access, no import of `database` (which needs
  DATABASE_URL), and no import of psycopg at load time, so it imports on a SQLite-only host.
- Placeholders stay `%s`; the S3 SQLite adapter maps them to `?`.
- DIALECT is read at CALL time (via _pg()), so tests can `monkeypatch.setattr(sql, "DIALECT", ...)`.
- On SQLite, `now()` is a user-defined function returning ts(utcnow()) (plan decision D4).
- Never compare a stored column against SQLite `datetime()`/`strftime()` output: those emit
  `YYYY-MM-DD HH:MM:SS` (space, no fraction, no offset), which sorts before every canonical
  `...T...+00:00` value of the same day. Bind a Python datetime from ago()/from_now() instead.
"""

import datetime as _dt
import json
import os
import re
import sqlite3
import sys

DIALECT = os.environ.get("ORCHA_DB_DIALECT", "postgres")  # transition only; "sqlite" after S3
DIALECTS = ("postgres", "sqlite")
UTC = _dt.timezone.utc

_JSON_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _pg() -> bool:
    """True on Postgres, False on SQLite; an unknown DIALECT is a configuration bug."""
    if DIALECT not in DIALECTS:
        raise ValueError(f"ORCHA_DB_DIALECT must be one of {DIALECTS}, got {DIALECT!r}")
    return DIALECT == "postgres"


# --- time: compute in Python, bind as a parameter (D4) ---

def utcnow() -> _dt.datetime:
    """The current instant as an aware UTC datetime."""
    return _dt.datetime.now(UTC)


def ts(dt: _dt.datetime) -> str:
    """Canonical stored text: ISO-8601, UTC, microseconds, '+00:00' (sorts lexicographically)."""
    if dt.tzinfo is None:
        raise ValueError("ts() needs an aware datetime; a naive one has no defined instant")
    return dt.astimezone(UTC).isoformat(timespec="microseconds")


def ago(seconds: float) -> _dt.datetime:
    """`now() - interval '5 hours'` becomes `>= %s` bound to ago(5 * 3600)."""
    return utcnow() - _dt.timedelta(seconds=seconds)


def from_now(seconds: float) -> _dt.datetime:
    """`now() + make_interval(secs => %s)` becomes `%s` bound to from_now(secs)."""
    return utcnow() + _dt.timedelta(seconds=seconds)


def ts_param(placeholder: str = "%s") -> str:
    """A bound timestamp whose type Postgres cannot infer from context (`%s IS NULL OR ...`):
    `%s::timestamptz` on Postgres, the bare placeholder on SQLite. Never spell
    `CAST(%s AS timestamptz)` inline: on SQLite that is NUMERIC affinity and turns
    '2026-10-05T...' into the integer 2026."""
    return f"{placeholder}::timestamptz" if _pg() else placeholder


def uuid_param(placeholder: str = "%s") -> str:
    """A bound id whose type Postgres cannot infer (`%s IS NULL OR id <> %s`): `%s::uuid` on
    Postgres, the bare placeholder on SQLite (ids are TEXT there)."""
    return f"{placeholder}::uuid" if _pg() else placeholder


def ts_neg_infinity() -> str:
    """A timestamp that sorts before every stored one (`COALESCE(max(x), <this>)` sentinels).
    Postgres: '-infinity'::timestamptz. SQLite: the canonical text of 0001-01-01 UTC, which
    sorts before every canonical ts() value and still parses back as a datetime."""
    return "'-infinity'::timestamptz" if _pg() else "'0001-01-01T00:00:00.000000+00:00'"


def now_text_default() -> str:
    """A column DEFAULT giving the current instant as canonical text (sql.ts() shape). SQLite
    only: Postgres columns use DEFAULT now(). Same expression as the SQLite baseline's
    TIMESTAMPTZ defaults."""
    return "(strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00')"


def age_secs(col: str) -> str:
    """Seconds elapsed since the timestamp expression `col` (NULL when `col` is NULL)."""
    if _pg():
        return f"EXTRACT(EPOCH FROM (now() - ({col})))"
    return f"((julianday(now()) - julianday({col})) * 86400.0)"


def epoch(col: str) -> str:
    """Unix epoch seconds (float) of the timestamp expression `col`: EXTRACT(EPOCH FROM col).
    (active_conversation_routes.py compares a DOUBLE PRECISION epoch column against one.)"""
    if _pg():
        return f"EXTRACT(EPOCH FROM ({col}))"
    return f"((julianday({col}) - 2440587.5) * 86400.0)"


# --- set membership: `x = ANY(%s)` ---

def in_list(col: str) -> str:
    """Membership test on one bound list: f"WHERE {sql.in_list('id')}" + sql.list_param(ids)."""
    if _pg():
        return f"{col} = ANY(%s)"
    return f"{col} IN (SELECT value FROM json_each(%s))"


def not_in_list(col: str) -> str:
    """Negated membership on one bound list (`x <> ALL(%s)`); bind sql.list_param(values).
    Both engines agree on NULLs: a NULL `col` is excluded by a non-empty list, and an empty
    list matches every row, NULL included (vacuous truth)."""
    if _pg():
        return f"{col} <> ALL(%s)"
    return f"{col} NOT IN (SELECT value FROM json_each(%s))"


def list_param(values) -> object:
    """The bound value for in_list(). SQLite gets a JSON array; UUIDs etc. become strings,
    while str/int/float stay as they are so an INTEGER column still matches."""
    if _pg():
        return list(values)
    return json.dumps([v if isinstance(v, (str, int, float)) else str(v) for v in values])


def int_rows(alias: str = "value") -> str:
    """A derived table with one row per element of a bound int list, column `alias`:
    f"FROM {sql.int_rows('number')} v" + sql.list_param(numbers).
    Postgres `unnest(%s::int[])`, SQLite json_each(%s)."""
    if not _JSON_KEY.match(alias):
        raise ValueError(f"int_rows: alias must be a plain identifier, got {alias!r}")
    if _pg():
        return f"(SELECT unnest(%s::int[]) AS {alias})"
    return f"(SELECT value AS {alias} FROM json_each(%s))"


# --- JSON ---

def json_param(obj) -> str:
    """Bound value for a JSON column; replaces `%s::jsonb` and psycopg's Jsonb()."""
    return json.dumps(obj)


def json_cast(placeholder: str = "%s") -> str:
    """For the f-string sites that need the cast on Postgres: `%s::jsonb` -> json_cast()."""
    return f"{placeholder}::jsonb" if _pg() else placeholder


def json_object(*pairs: str) -> str:
    """json_build_object('k', v, ...) / json_object('k', v, ...). Pass keys pre-quoted.
    NOTE: SQLite returns JSON TEXT here (Postgres returns json that psycopg decodes)."""
    if len(pairs) % 2:
        raise ValueError("json_object() needs key/value pairs")
    fn = "json_build_object" if _pg() else "json_object"
    return f"{fn}({', '.join(pairs)})"


def json_nested(select: str) -> str:
    """A JSON value from a scalar subquery (pass the bare SELECT), nested inside
    json_object()/json_array_agg().

    SQLite drops the JSON subtype at a subquery boundary, so an inner json_object() lands in
    the outer one as a quoted string; json(...) re-marks it as JSON. Postgres keeps the type."""
    return f"({select})" if _pg() else f"json(({select}))"


def json_array_agg(expr: str, order_by: str | None = None) -> str:
    """json_agg(expr [ORDER BY ...]) / json_group_array(expr).

    SQLite before 3.44 has no ORDER BY inside an aggregate, so the portable spelling orders
    rows in a subquery and calls this without order_by. Passing order_by on SQLite raises
    rather than silently dropping the order."""
    if _pg():
        return f"json_agg({expr}{' ORDER BY ' + order_by if order_by else ''})"
    if order_by:
        raise ValueError("json_array_agg(order_by=...) is Postgres-only: order in a subquery")
    return f"json_group_array({expr})"


def json_bool(expr: str) -> str:
    """A boolean SQL expression as a JSON value inside json_object()/json_array_agg().

    SQLite has no boolean type, so a bare predicate lands in the JSON as 1/0; wrapping it in
    json('true')/json('false') makes it decode as a bool (plan Appendix B probe g). A NULL
    predicate stays JSON null on both engines."""
    if _pg():
        return f"({expr})"
    return f"CASE WHEN ({expr}) THEN json('true') WHEN NOT ({expr}) THEN json('false') END"


def json_bool_is_true(col: str, key: str, *, default: bool = True) -> str:
    """Predicate: the JSON boolean `col`.`key` is true; a missing key/NULL col counts as `default`.

    Postgres `->>` yields the text 'true'/'false'; SQLite json_extract() yields 1/0 for JSON
    booleans, so the comparison differs. (A JSON *string* "true" matches only on Postgres.)
    The one site: container_metrics_routes.py `COALESCE(detail->>'approved', 'true') = 'true'`
    -> sql.json_bool_is_true("detail", "approved")."""
    if not _JSON_KEY.match(key):
        raise ValueError(f"json_bool_is_true: key must be a plain identifier, got {key!r}")
    if _pg():
        return f"COALESCE({col}->>'{key}', '{'true' if default else 'false'}') = 'true'"
    return f"COALESCE(json_extract({col}, '$.{key}'), {1 if default else 0}) = 1"


def _json_keys(keys) -> list:
    keys = list(keys)
    if not keys:
        raise ValueError("need at least one JSON key")
    for k in keys:
        if not _JSON_KEY.match(k):
            raise ValueError(f"JSON key must be a plain identifier, got {k!r}")
    return keys


def json_remove_keys(col: str, keys) -> str:
    """The JSON object `col` without the top-level `keys` (constants, inlined):
    Postgres `(col - '{a,b}'::text[])`, SQLite `json_remove(col, '$.a', '$.b')`."""
    keys = _json_keys(keys)
    if _pg():
        return f"({col} - '{{{','.join(keys)}}}'::text[])"
    paths = ", ".join("'$." + k + "'" for k in keys)
    return f"json_remove({col}, {paths})"


def json_has_any_key(col: str, keys) -> str:
    """Predicate: the JSON object `col` has at least one of the top-level `keys` (a key whose
    value is JSON null counts, as with Postgres `?|`)."""
    keys = _json_keys(keys)
    if _pg():
        return f"({col} ?| '{{{','.join(keys)}}}'::text[])"
    return "(" + " OR ".join(f"json_type({col}, '$.{k}') IS NOT NULL" for k in keys) + ")"


def json_array_has(col: str, placeholder: str = "%s") -> str:
    """Predicate: the JSON array of strings `col` contains the bound string.
    Postgres `col ? %s::text`, SQLite an EXISTS over json_each(col)."""
    if _pg():
        return f"({col} ? {placeholder}::text)"
    return f"EXISTS (SELECT 1 FROM json_each({col}) WHERE json_each.value = {placeholder})"


def json_array_has_match(col: str, key: str, placeholder: str = "%s") -> str:
    """Predicate: the JSON array of objects `col` has an element whose `key` equals the bound
    string. Postgres `col @> '[{"key": value}]'` (containment), SQLite an EXISTS over json_each."""
    if not _JSON_KEY.match(key):
        raise ValueError(f"json_array_has_match: key must be a plain identifier, got {key!r}")
    if _pg():
        return f"({col} @> jsonb_build_array(jsonb_build_object('{key}', {placeholder}::text)))"
    return (f"EXISTS (SELECT 1 FROM json_each({col}) "
            f"WHERE json_extract(json_each.value, '$.{key}') = {placeholder})")


def json_merge(left_obj: str, right_obj: str) -> str:
    """Shallow merge of two JSON objects, right wins: Postgres `left || right`, SQLite
    json_patch(left, right). CAVEAT: json_patch is RFC 7396, so a JSON null in `right`
    DELETES that key (Postgres keeps it as null) and nested objects merge recursively;
    callers must not rely on either (clear the keys first, never send nulls)."""
    if _pg():
        return f"({left_obj} || {right_obj})"
    return f"json_patch({left_obj}, {right_obj})"


# --- strings / misc ---

def _count(n: int) -> int:
    if not isinstance(n, int) or isinstance(n, bool) or n < 0:
        raise ValueError(f"character count must be a non-negative int, got {n!r}")
    return n


def left(col: str, n: int) -> str:
    """The first n characters: LEFT(col, n) / substr(col, 1, n)."""
    n = _count(n)
    return f"LEFT({col}, {n})" if _pg() else f"substr({col}, 1, {n})"


def right(col: str, n: int) -> str:
    """The last n characters: right(col, n) / substr(col, -n). n=0 yields '' on both."""
    n = _count(n)
    if _pg():
        return f"right({col}, {n})"
    return f"substr({col}, -{n})" if n else f"substr({col}, 1, 0)"


def greatest(*exprs: str) -> str:
    """GREATEST(a, b, ...) / max(a, b, ...).

    CAVEAT: Postgres GREATEST ignores NULLs; SQLite's scalar max() returns NULL if ANY
    argument is NULL. Callers must COALESCE every nullable operand."""
    if len(exprs) < 2:
        raise ValueError("greatest() needs at least two expressions (1-arg max() is an aggregate)")
    fn = "GREATEST" if _pg() else "max"
    return f"{fn}({', '.join(exprs)})"


def ilike() -> str:
    """Case-insensitive LIKE operator. SQLite LIKE folds ASCII only."""
    return "ILIKE" if _pg() else "LIKE"


def for_update(*, of: str | None = None, skip_locked: bool = False) -> str:
    """Row-lock suffix: ` FOR UPDATE [OF t] [SKIP LOCKED]`. SQLite has none: the S3
    `BEGIN IMMEDIATE` write lock serialises writers, so nothing is ever locked to skip."""
    if of is not None and not _JSON_KEY.match(of):
        raise ValueError(f"for_update(of=...) must be a plain identifier, got {of!r}")
    if not _pg():
        return ""
    return " FOR UPDATE" + (f" OF {of}" if of else "") + (" SKIP LOCKED" if skip_locked else "")


def xact_lock(key_expr: str) -> str:
    """A transaction-scoped lock on the text key `key_expr` (bind its parameters as usual):
    `SELECT pg_advisory_xact_lock(hashtext(key))` on Postgres. On SQLite the scope's
    `BEGIN IMMEDIATE` already serialises every writer, so this only evaluates the key."""
    if _pg():
        return f"SELECT pg_advisory_xact_lock(hashtext({key_expr}))"
    return f"SELECT ({key_expr}) AS lock_key"


def table_exists(name: str) -> str:
    """Predicate: the table `name` exists (`to_regclass('public.x') IS NOT NULL` on Postgres)."""
    if not _JSON_KEY.match(name):
        raise ValueError(f"table_exists: name must be a plain identifier, got {name!r}")
    if _pg():
        return f"(to_regclass('public.{name}') IS NOT NULL)"
    return f"EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='{name}')"


def column_exists(table: str, column: str) -> str:
    """Predicate: `table` has a column `column` (information_schema on Postgres)."""
    if not (_JSON_KEY.match(table) and _JSON_KEY.match(column)):
        raise ValueError(f"column_exists: plain identifiers only, got {table!r}.{column!r}")
    if _pg():
        return ("EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = "
                f"current_schema() AND table_name = '{table}' AND column_name = '{column}')")
    return f"EXISTS (SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{column}')"


def is_unique_violation(exc: BaseException) -> bool:
    """True when `exc` is a unique-constraint violation from either engine.

    Dialect-agnostic on purpose (an exception says which driver raised it). psycopg is looked
    up in sys.modules, never imported: if it was never imported, `exc` cannot be a psycopg error."""
    if isinstance(exc, sqlite3.IntegrityError):
        return "UNIQUE constraint failed" in str(exc)
    psycopg = sys.modules.get("psycopg")
    return psycopg is not None and isinstance(exc, psycopg.errors.UniqueViolation)


def is_undefined_table(exc: BaseException) -> bool:
    """True when `exc` says a queried table does not exist, from either engine (same
    sys.modules rule as is_unique_violation)."""
    if isinstance(exc, sqlite3.OperationalError):
        return str(exc).startswith("no such table")
    psycopg = sys.modules.get("psycopg")
    return psycopg is not None and isinstance(exc, psycopg.errors.UndefinedTable)
