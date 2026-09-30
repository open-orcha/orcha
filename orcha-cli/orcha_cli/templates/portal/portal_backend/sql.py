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


def list_param(values) -> object:
    """The bound value for in_list(). SQLite gets a JSON array; UUIDs etc. become strings,
    while str/int/float stay as they are so an INTEGER column still matches."""
    if _pg():
        return list(values)
    return json.dumps([v if isinstance(v, (str, int, float)) else str(v) for v in values])


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


def for_update() -> str:
    """Row-lock suffix. SQLite has none: the S3 `BEGIN IMMEDIATE` write lock covers it."""
    return " FOR UPDATE" if _pg() else ""


def is_unique_violation(exc: BaseException) -> bool:
    """True when `exc` is a unique-constraint violation from either engine.

    Dialect-agnostic on purpose (an exception says which driver raised it). psycopg is looked
    up in sys.modules, never imported: if it was never imported, `exc` cannot be a psycopg error."""
    if isinstance(exc, sqlite3.IntegrityError):
        return "UNIQUE constraint failed" in str(exc)
    psycopg = sys.modules.get("psycopg")
    return psycopg is not None and isinstance(exc, psycopg.errors.UniqueViolation)
