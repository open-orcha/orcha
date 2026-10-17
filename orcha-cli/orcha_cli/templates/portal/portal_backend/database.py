"""Own database connections and the idempotent SQL migration runner.

GH #258 plan S3 (PR 7b): two engines behind one `db_cursor()`.
- SQLite (the default): `ORCHA_DB_PATH` names the database file; sqlite3 with the row/type
  adapters below, `%s` placeholders translated to `?`, one `BEGIN IMMEDIATE` per outermost
  scope (nested scopes join it, plan D7), migrations from `templates/migrations/sqlite`.
- Postgres (transition only, deleted in the cleanup PR, plan S9): selected when
  `ORCHA_DB_PATH` is unset and `DATABASE_URL` is set; behaves exactly as before.
"""

import contextvars
import datetime as _dt
import json
import os
import pathlib
import re
import sqlite3
import sys
import threading
import time
from contextlib import contextmanager
from functools import lru_cache
from typing import Optional

from portal_backend import sql

_TEMPLATES = pathlib.Path(__file__).resolve().parents[2]

if os.environ.get("ORCHA_DB_PATH"):
    BACKEND = "sqlite"
    DB = os.environ["ORCHA_DB_PATH"]
elif os.environ.get("DATABASE_URL"):
    BACKEND = "postgres"
    DB = os.environ["DATABASE_URL"]
else:
    raise KeyError("ORCHA_DB_PATH (SQLite database file) or DATABASE_URL (Postgres) must be set")
sql.DIALECT = BACKEND  # one engine per process: the dialect helpers follow the connection

# Compose sets MIGRATIONS_DIR to its bind mount; a host-process portal (`orcha portal`)
# falls back to the migrations shipped next to it in the package (templates/migrations,
# or templates/migrations/sqlite for the SQLite engine).
MIGRATIONS_DIR = pathlib.Path(
    os.environ.get("MIGRATIONS_DIR")
    or (_TEMPLATES / "migrations" / "sqlite" if BACKEND == "sqlite" else _TEMPLATES / "migrations")
)
_MIGRATION_LOCK_KEY = 4242421
SLOW_TX_SECS = float(os.environ.get("ORCHA_DB_SLOW_TX_SECS", "0.25"))
UTC = _dt.timezone.utc
# GH #258 S2b: result columns built by sql.json_object()/sql.json_array_agg(). Postgres returns
# json that psycopg decodes; SQLite returns TEXT, so the row adapter decodes these by name.
JSON_ALIASES = frozenset({
    "active_run", "assignees", "attachments", "close_decision", "current_task", "message_summary",
    "plan_decision", "plan_message", "previous_plan_decision", "reassigned", "reviewer", "running_run",
    "runs",
    "task_link", "waiting_on",
})

# Boolean EXPRESSION columns (COALESCE(r.wake_enabled, true), CASE ... END) lose the declared
# BOOLEAN type on SQLite and come back as 1/0; these aliases are turned back into bools.
BOOL_ALIASES = frozenset({
    "cold_required", "escalated", "is_human", "pending", "requester_retired", "runtime_served",
    "target_retired", "wake_enabled",
})


# ---------------------------------------------------------------- Postgres (transition only)

def _pg_connect(dict_rows: bool = False):
    """The one place the Postgres driver is touched (allow-listed until the switch goes)."""
    import psycopg.rows

    return psycopg.connect(DB, **({"row_factory": psycopg.rows.dict_row} if dict_rows else {}))


@contextmanager
def _pg_cursor():
    with _pg_connect(dict_rows=True) as conn:
        with conn.cursor() as cur:
            yield conn, cur


def _pg_run_migrations(mdir: pathlib.Path) -> list[str]:
    files = sorted(mdir.glob("*.sql")) if mdir.is_dir() else []
    applied: list[str] = []
    with _pg_connect() as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (_MIGRATION_LOCK_KEY,))
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
            )
            conn.commit()
            done = {
                row[0]
                for row in conn.execute(
                    "SELECT version FROM schema_migrations"
                ).fetchall()
            }
            core_exists = (
                conn.execute("SELECT to_regclass('public.containers')").fetchone()[0]
                is not None
            )
            for migration in files:
                version = migration.name
                if version in done:
                    continue
                baseline = version == "001_init.sql" and core_exists
                try:
                    if not baseline:
                        conn.execute(migration.read_text())
                    conn.execute(
                        "INSERT INTO schema_migrations(version) VALUES (%s) "
                        "ON CONFLICT DO NOTHING",
                        (version,),
                    )
                    conn.commit()
                except Exception as exc:
                    conn.rollback()
                    raise RuntimeError(
                        f"migration {version} failed (halting): {exc}"
                    ) from exc
                applied.append(("baseline:" if baseline else "") + version)
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (_MIGRATION_LOCK_KEY,))
            conn.commit()
    return applied


# ---------------------------------------------------------------- SQLite: type adapters (D3, D8, D9)

def _ts_text(value: _dt.datetime) -> str:
    if value.tzinfo is None:  # psycopg stored naive datetimes as UTC (the session time zone)
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def _json_value(raw: bytes):
    # JSONB has NUMERIC affinity: a scalar like 5 is stored as an INTEGER and handed back as b"5".
    return json.loads(raw.decode())


sqlite3.register_adapter(_dt.datetime, _ts_text)
sqlite3.register_adapter(bool, int)
sqlite3.register_converter("TIMESTAMPTZ", lambda b: _dt.datetime.fromisoformat(b.decode()))
sqlite3.register_converter("JSONB", _json_value)
sqlite3.register_converter("BOOLEAN", lambda b: b not in (b"0", b"false", b"FALSE", b""))
sqlite3.register_converter("UUID", lambda b: b.decode())
try:
    import uuid as _uuid
    import decimal as _decimal

    sqlite3.register_adapter(_uuid.UUID, str)
    sqlite3.register_adapter(_decimal.Decimal, float)
    sqlite3.register_adapter(dict, json.dumps)
    sqlite3.register_adapter(list, json.dumps)
except ImportError:  # pragma: no cover — stdlib
    pass

# A stored timestamp's canonical text (sql.ts()). Expression columns (max(created_at),
# COALESCE(a.ts, b.ts), a UNION) lose the declared type, so the row adapter turns text of
# exactly this shape back into a datetime, as psycopg would have returned it.
_CANONICAL_TS = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00")


def _now_text() -> str:
    return sql.ts(sql.utcnow())


def _dict_row(cur, row):
    d = {}
    for (name, *_), value in zip(cur.description, row):
        if isinstance(value, int) and name in BOOL_ALIASES:
            value = bool(value)
        elif isinstance(value, str):
            if name in JSON_ALIASES:
                value = json.loads(value)  # json_object()/json_group_array() come back as TEXT
            elif len(value) == 32 and _CANONICAL_TS.fullmatch(value):
                value = _dt.datetime.fromisoformat(value)
        d[name] = value
    return d


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(
        DB, detect_types=sqlite3.PARSE_DECLTYPES, isolation_level=None,  # autocommit; we BEGIN
        timeout=5.0, check_same_thread=False,
    )
    conn.row_factory = _dict_row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.create_function("now", 0, _now_text, deterministic=False)  # D4: now() keeps working
    # wall-clock per call, like now() here (Postgres now() is the transaction start; the
    # import path asks for clock_timestamp() so each row of one import gets its own time)
    conn.create_function("clock_timestamp", 0, _now_text, deterministic=False)
    return conn


# Idle connections, reused across scopes (opening one costs a file open + four PRAGMAs).
_idle: list = []
_idle_lock = threading.Lock()
_IDLE_MAX = 8


def _acquire() -> sqlite3.Connection:
    with _idle_lock:
        if _idle:
            return _idle.pop()
    return _connect()


def _release(raw: sqlite3.Connection) -> None:
    if raw.in_transaction:
        raw.execute("ROLLBACK")
    with _idle_lock:
        if len(_idle) < _IDLE_MAX:
            _idle.append(raw)
            return
    raw.close()


# ---------------------------------------------------------------- SQLite: placeholders (D5)

_PCT_S = re.compile(r"%s|%\((\w+)\)s|%%")


@lru_cache(maxsize=4096)
def _translate(text: str) -> str:
    """psycopg placeholders to sqlite3: %s -> ?, %(name)s -> :name, %% -> %."""
    return _PCT_S.sub(
        lambda m: "%" if m.group(0) == "%%" else (":" + m.group(1) if m.group(1) else "?"), text
    )


_WRITE = re.compile(r"^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b", re.IGNORECASE)


def _assert_readonly() -> bool:
    return os.environ.get("ORCHA_DB_ASSERT_READONLY") == "1"


class _Scope:
    """One outermost transaction; nested db_cursor() calls in the same context join it."""

    __slots__ = ("raw", "depth", "readonly", "ends", "cursors")

    def __init__(self, raw, readonly):
        self.raw, self.depth, self.readonly = raw, 0, readonly
        self.ends = 0  # explicit commit()/rollback() calls: each one drops every open savepoint
        # Closed when the scope ends: a half-read SELECT (fetchone() on many rows, or a
        # converter that raised mid-row) keeps its read snapshot open after COMMIT/ROLLBACK,
        # and a pooled connection with a stale snapshot can't BEGIN IMMEDIATE (SQLITE_BUSY,
        # no busy-wait) once another connection has written. A retained traceback keeps the
        # cursor alive, so garbage collection can't be relied on to reset it.
        self.cursors: list = []

    def begin(self) -> None:
        self.raw.execute("BEGIN" if self.readonly else "BEGIN IMMEDIATE")


# The active scope follows the asyncio task / thread context, so two coroutines interleaving
# on the event-loop thread never share a transaction, while a nested call joins its caller's.
_scope: contextvars.ContextVar = contextvars.ContextVar("orcha_db_scope", default=None)


class Cursor:
    """psycopg-shaped cursor over sqlite3: execute/executemany/fetch*/rowcount/description."""

    def __init__(self, scope: _Scope):
        self._scope = scope
        self._cur = scope.raw.cursor()
        scope.cursors.append(self._cur)

    def _ready(self, text: str) -> None:
        scope = self._scope
        if scope.readonly and _assert_readonly() and _WRITE.match(text):
            raise AssertionError(f"write inside a readonly db_cursor scope: {text.strip()[:80]}")
        if scope.depth > 0 and not scope.raw.in_transaction:
            scope.begin()  # psycopg opened an implicit transaction after a mid-scope commit()

    def execute(self, query, params=None):
        self._ready(query)
        if params is None:
            self._cur.execute(query)
        else:
            self._cur.execute(_translate(query), params)
        return self

    def executemany(self, query, seq):
        self._ready(query)
        self._cur.executemany(_translate(query), seq)
        return self

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    def fetchmany(self, size=None):
        return self._cur.fetchmany(size) if size is not None else self._cur.fetchmany()

    def __iter__(self):
        return iter(self._cur)

    @property
    def rowcount(self):
        return self._cur.rowcount

    @property
    def description(self):
        return self._cur.description

    @property
    def connection(self):
        return Conn(self._scope)

    def close(self):
        self._cur.close()


class Conn:
    """psycopg-shaped connection: commit()/rollback()/execute()/cursor()."""

    def __init__(self, scope: _Scope):
        self._scope = scope

    def commit(self):
        if self._scope.raw.in_transaction:
            self._scope.raw.execute("COMMIT")
            self._scope.ends += 1

    def rollback(self):
        if self._scope.raw.in_transaction:
            self._scope.raw.execute("ROLLBACK")
            self._scope.ends += 1

    def execute(self, query, params=None):
        return Cursor(self._scope).execute(query, params)

    def cursor(self):
        return Cursor(self._scope)


def _caller() -> str:
    """file:line of the code that opened the scope (first frame outside this module/contextlib)."""
    frame = sys._getframe(1)
    while frame is not None and frame.f_code.co_filename.endswith(("database.py", "contextlib.py")):
        frame = frame.f_back
    if frame is None:
        return "?"
    return f"{pathlib.Path(frame.f_code.co_filename).name}:{frame.f_lineno}"


def report_slow_transaction(held: float, readonly: bool, where: str) -> None:
    """Plan risk R2: a scope held past SLOW_TX_SECS blocks every other writer. tests/conftest.py
    wraps this to list them in the run summary."""
    print(f"[db] slow transaction {held * 1000:.0f} ms at {where}"
          f"{' (readonly)' if readonly else ''}", flush=True)


@contextmanager
def _sqlite_cursor(readonly: bool):
    scope = _scope.get()
    if scope is not None and scope.depth > 0:
        # Nested: join the outer transaction (a second writer would wait on our own lock),
        # inside a SAVEPOINT so an exception undoes only this scope's writes, as a separate
        # psycopg transaction did. An explicit commit()/rollback() in between ends it early.
        if scope.readonly and not readonly and _assert_readonly():
            raise AssertionError("a write db_cursor scope nested inside a readonly one")
        scope.depth += 1
        name, ends = f"orcha_sp{scope.depth}", scope.ends
        if not scope.raw.in_transaction:
            scope.begin()
        scope.raw.execute(f"SAVEPOINT {name}")
        try:
            yield Conn(scope), Cursor(scope)
        except BaseException:
            if scope.ends == ends and scope.raw.in_transaction:
                scope.raw.execute(f"ROLLBACK TO {name}")
                scope.raw.execute(f"RELEASE {name}")
            raise
        else:
            if scope.ends == ends and scope.raw.in_transaction:
                scope.raw.execute(f"RELEASE {name}")
        finally:
            scope.depth -= 1
        return
    scope = _Scope(_acquire(), readonly)
    previous = _scope.get()
    _scope.set(scope)
    t0 = time.monotonic()
    conn = Conn(scope)
    try:
        scope.begin()
        scope.depth = 1
        yield conn, Cursor(scope)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        scope.depth = 0
        _scope.set(previous)
        for raw_cur in scope.cursors:
            raw_cur.close()
        _release(scope.raw)
        held = time.monotonic() - t0
        if held > SLOW_TX_SECS:
            report_slow_transaction(held, readonly, _caller())


# Side effects queued by after_commit(): one list per outermost db_cursor scope.
_after: contextvars.ContextVar = contextvars.ContextVar("orcha_db_after_commit", default=None)


def after_commit(fn) -> None:
    """Run `fn()` once the outermost db_cursor scope has exited cleanly (committed, write lock
    released); dropped if the scope raises. Outside any scope it runs now. For slow,
    best-effort side effects (a GitHub comment) that must not hold the SQLite write lock
    (plan S3 note 4) or fire for a transaction that rolled back."""
    hooks = _after.get()
    if hooks is None:
        fn()
    else:
        hooks.append(fn)


@contextmanager
def db_cursor(*, readonly: bool = False):
    """Yield (conn, cur). SQLite: the outermost scope opens BEGIN IMMEDIATE (BEGIN when
    readonly) and commits on a clean exit, rolls back on an exception; inner scopes join it.
    Postgres: a fresh psycopg connection per scope, as before (`readonly` is ignored).
    The outermost scope runs its after_commit() hooks after it has fully exited."""
    outermost = _after.get() is None
    hooks: list = []
    token = _after.set(hooks) if outermost else None
    try:
        if BACKEND == "postgres":
            with _pg_cursor() as pair:
                yield pair
        else:
            with _sqlite_cursor(readonly) as pair:
                yield pair
    finally:
        if outermost:
            _after.reset(token)
    for fn in hooks:  # reached only on a clean exit
        try:
            fn()
        except Exception as exc:  # the transaction already committed; never fail the caller now
            print(f"[db] after_commit hook failed: {exc!r}", flush=True)


def ping() -> None:
    """Raise unless the database answers a trivial query."""
    if BACKEND == "postgres":
        with _pg_connect() as conn:
            conn.execute("SELECT 1")
        return
    raw = _acquire()
    try:
        raw.execute("SELECT 1").fetchone()
    finally:
        _release(raw)


# ---------------------------------------------------------------- SQLite: migrations

def split_statements(script: str) -> list[str]:
    """Split a migration file into statements: a statement ends with ';' at end of line
    (comments aside) and is complete per sqlite3.complete_statement (so a trigger's
    BEGIN ... END body stays whole)."""
    out, buf = [], []
    for line in script.splitlines():
        buf.append(line)
        if line.split("--", 1)[0].rstrip().endswith(";"):
            stmt = "\n".join(buf)
            if sqlite3.complete_statement(stmt):
                out.append(stmt)
                buf = []
    tail = "\n".join(buf).strip()
    if tail and any(ln.split("--", 1)[0].strip() for ln in buf):
        raise ValueError(f"migration has an unterminated statement: {tail[:80]!r}")
    return out


def _sqlite_run_migrations(mdir: pathlib.Path) -> list[str]:
    files = sorted(mdir.glob("*.sql")) if mdir.is_dir() else []
    applied: list[str] = []
    raw = _acquire()
    try:
        raw.execute("BEGIN IMMEDIATE")  # the migration mutex (replaces pg_advisory_lock)
        try:
            # Same DDL as the baseline's: its INSERT OR IGNORE stamps the folded-in Postgres
            # names without applied_at, and without this DEFAULT the NOT NULL makes SQLite
            # skip those rows silently (history = 001_baseline only, migration tip 1).
            raw.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY "
                f"NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT {sql.now_text_default()})"
            )
            done = {r["version"] for r in raw.execute("SELECT version FROM schema_migrations")}
            for migration in files:
                version = migration.name
                if version in done:
                    continue
                raw.execute("SAVEPOINT migration")
                try:
                    for stmt in split_statements(migration.read_text()):
                        raw.execute(stmt)
                    raw.execute(
                        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                        (version, sql.ts(sql.utcnow())),
                    )
                    raw.execute("RELEASE migration")
                except Exception as exc:
                    raw.execute("ROLLBACK TO migration")
                    raw.execute("RELEASE migration")
                    raw.execute("COMMIT")  # keep the files that did apply, as Postgres does
                    raise RuntimeError(f"migration {version} failed (halting): {exc}") from exc
                applied.append(version)
            raw.execute("COMMIT")
        finally:
            if raw.in_transaction:
                raw.execute("ROLLBACK")
    finally:
        _release(raw)
    return applied


def run_migrations(migrations_dir: Optional[pathlib.Path] = None) -> list[str]:
    """Apply pending migration files in lexical order."""
    mdir = pathlib.Path(migrations_dir or MIGRATIONS_DIR)
    if BACKEND == "postgres":
        return _pg_run_migrations(mdir)
    return _sqlite_run_migrations(mdir)
