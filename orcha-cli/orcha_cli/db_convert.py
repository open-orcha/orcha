"""Copy a Postgres Orcha database into a new SQLite file (GH #258 plan Part 6 M1, PR 8).

Used by ``orcha migrate-runtime`` (in-process) and by ``tools/db/pg_to_sqlite.py`` (a thin
command-line wrapper). The SQLite schema is never written here: the new file gets the
portal's own migrations (``templates/migrations/sqlite``) through
``portal_backend.database.run_migrations`` in a child process, so the converter and the
portal agree on the schema by construction. Then every table is copied in foreign-key
order, values go through :func:`map_value`, and the result is verified (row counts, a
random sample compared field by field, ``PRAGMA foreign_key_check`` and
``PRAGMA integrity_check``). Any mismatch deletes the output and raises.

The output path is never overwritten: an existing file is refused, or with ``force`` moved
aside to ``<name>.bak-<UTC ts>`` first.
"""
from __future__ import annotations

import datetime as _dt
import decimal
import json
import os
import pathlib
import random
import sqlite3
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

BATCH_ROWS = 1000
UTC = _dt.timezone.utc
SKIP_TABLES = frozenset({"schema_migrations"})
# Unique indexes on lower(column) in the baseline. SQLite's lower() folds ASCII only, so a
# non-ASCII value here still converts (Postgres uniqueness implies SQLite uniqueness) but a
# case-insensitive lookup on it will not match its other-case spelling. Reported, not fixed.
LOWER_INDEXED = (("agents", "github_login"), ("containers", "name"), ("project_dod_presets", "name"))

Progress = Callable[[dict], None]


class ConvertError(RuntimeError):
    """The conversion could not be completed; the output file has been removed."""


@dataclass
class TableReport:
    table: str
    rows: int
    seconds: float


@dataclass
class Report:
    out: str
    tables: list = field(default_factory=list)
    sampled: int = 0
    non_ascii_lower: dict = field(default_factory=dict)
    backup_of_existing: Optional[str] = None

    @property
    def total_rows(self) -> int:
        return sum(t.rows for t in self.tables)

    def as_dict(self) -> dict:
        return {
            "out": self.out,
            "tables": [{"table": t.table, "rows": t.rows, "seconds": round(t.seconds, 3)}
                       for t in self.tables],
            "table_count": len(self.tables),
            "total_rows": self.total_rows,
            "sampled_rows": self.sampled,
            "non_ascii_lower": self.non_ascii_lower,
            "backup_of_existing": self.backup_of_existing,
        }

    def render(self) -> str:
        width = max([len(t.table) for t in self.tables] + [5])
        lines = [f"{'table'.ljust(width)}  {'rows':>9}  seconds"]
        for t in self.tables:
            lines.append(f"{t.table.ljust(width)}  {t.rows:>9}  {t.seconds:7.3f}")
        lines.append(f"{len(self.tables)} tables, {self.total_rows} rows, "
                     f"{self.sampled} sampled rows compared, integrity ok")
        for key, n in sorted(self.non_ascii_lower.items()):
            lines.append(f"note: {n} non-ASCII value(s) in {key}: SQLite lower() folds ASCII "
                         "only, so case-insensitive lookups on them match the exact case only")
        return "\n".join(lines)


# ---------------------------------------------------------------- value mapping (plan M1 step 3)

def ts_text(value: _dt.datetime) -> str:
    """Canonical stored timestamp text (portal ``sql.ts``); a naive value is taken as UTC."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def map_value(value, pg_type: str):
    """One Postgres value (as psycopg returns it) -> the value the SQLite file stores.

    ``jsonb`` columns are selected as ``::text`` so JSON ``null`` (the text ``'null'``) and
    SQL NULL (``None``) stay distinct; that text is stored as is.
    """
    if value is None:
        return None
    if pg_type == "jsonb":
        if isinstance(value, str):
            return value
        return json.dumps(value, separators=(",", ":"))
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, uuid.UUID):
        return str(value).lower()
    if isinstance(value, _dt.datetime):
        return ts_text(value)
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"))
    return value


def comparable(value, pg_type: str):
    """Normalise a value from either side for the sample comparison: datetimes as UTC
    instants, JSON as parsed objects, booleans and UUIDs as their stored forms."""
    if value is None:
        return None
    if pg_type == "jsonb":
        if isinstance(value, (bytes, bytearray)):
            value = value.decode()
        return json.loads(value) if isinstance(value, str) else value
    if pg_type.startswith("timestamp"):
        if isinstance(value, str):
            value = _dt.datetime.fromisoformat(value)
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if pg_type == "boolean":
        return bool(value)
    if pg_type in ("numeric", "real", "double precision"):
        return float(value)
    if isinstance(value, uuid.UUID):
        return str(value).lower()
    return value


# ---------------------------------------------------------------- schema on the SQLite side

def portal_dir() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent / "templates" / "portal"


def sqlite_migrations_dir() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent / "templates" / "migrations" / "sqlite"


def apply_sqlite_schema(path: pathlib.Path, *, run=subprocess.run) -> None:
    """Create ``path`` with the portal's SQLite migrations, applied by the portal's own
    runner (``portal_backend.database`` binds its engine at import, hence the child)."""
    env = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    env.update({
        "ORCHA_DB_PATH": str(path),
        "MIGRATIONS_DIR": str(sqlite_migrations_dir()),
        "PYTHONPATH": os.pathsep.join(filter(None, [str(portal_dir()), env.get("PYTHONPATH")])),
    })
    code = "from portal_backend import database; database.run_migrations()"
    proc = run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ConvertError(f"could not create the SQLite schema: {proc.stderr.strip()[-500:]}")


def _sqlite_connect(path: pathlib.Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


# ---------------------------------------------------------------- reading Postgres

def _pg_tables(pg) -> list[str]:
    rows = pg.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    ).fetchall()
    return [r[0] for r in rows if r[0] not in SKIP_TABLES]


def _pg_columns(pg, table: str) -> list[tuple[str, str]]:
    rows = pg.execute(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = %s ORDER BY ordinal_position",
        (table,),
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def _pg_fk_edges(pg) -> list[tuple[str, str]]:
    rows = pg.execute(
        "SELECT c.conrelid::regclass::text, c.confrelid::regclass::text FROM pg_constraint c "
        "WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace"
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def fk_order(tables: list[str], edges: list[tuple[str, str]]) -> list[str]:
    """Tables ordered so every referenced table comes before its referrers (Kahn's
    algorithm, ties broken by name so the order is stable). Self-references are ignored."""
    parents = {t: set() for t in tables}
    for child, parent in edges:
        if child in parents and parent in parents and child != parent:
            parents[child].add(parent)
    ordered, done = [], set()
    while len(ordered) < len(tables):
        ready = sorted(t for t in tables if t not in done and parents[t] <= done)
        if not ready:
            raise ConvertError(f"foreign-key cycle among: {sorted(set(tables) - done)}")
        ordered.extend(ready)
        done.update(ready)
    return ordered


def _select_list(cols: list[tuple[str, str]]) -> str:
    return ", ".join(f'"{c}"::text' if t == "jsonb" else f'"{c}"' for c, t in cols)


# ---------------------------------------------------------------- the conversion

def _emit(progress: Optional[Progress], **event) -> None:
    if progress is not None:
        progress(event)


def _check_schema(pg, lite: sqlite3.Connection, tables: list[str]) -> None:
    if pg.execute("SELECT to_regclass('public.schema_migrations')").fetchone()[0] is None:
        raise ConvertError("the Postgres database has no schema_migrations table, so it is "
                           "not an Orcha database (or no portal has ever started on it)")
    lite_tables = {r[0] for r in lite.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")}
    lite_tables -= SKIP_TABLES
    if set(tables) != lite_tables:
        raise ConvertError(
            "the Postgres and SQLite schemas list different tables "
            f"(only in Postgres: {sorted(set(tables) - lite_tables)}; "
            f"only in SQLite: {sorted(lite_tables - set(tables))}). "
            "Run `orcha update` so the Postgres database has every migration, then retry."
        )
    pg_versions = {r[0] for r in pg.execute("SELECT version FROM schema_migrations")}
    lite_versions = {r[0] for r in lite.execute("SELECT version FROM schema_migrations")}
    if not pg_versions <= lite_versions:
        raise ConvertError(
            "the Postgres database has migrations this CLI's SQLite schema does not include: "
            f"{sorted(pg_versions - lite_versions)}. Update the orcha CLI, then retry."
        )
    missing = sorted(v for v in lite_versions - pg_versions if not v.startswith("001_baseline"))
    if missing:
        raise ConvertError(
            f"the Postgres database is missing migrations {missing[:5]}"
            f"{' ...' if len(missing) > 5 else ''}. Run `orcha update` first, then retry."
        )
    for table in tables:
        lite_cols = {r[1] for r in lite.execute(f'PRAGMA table_info("{table}")')}
        pg_cols = {c for c, _ in _pg_columns(pg, table)}
        if pg_cols != lite_cols:
            raise ConvertError(
                f"table {table}: columns differ (only in Postgres: {sorted(pg_cols - lite_cols)}; "
                f"only in SQLite: {sorted(lite_cols - pg_cols)})"
            )


def _copy_table(pg, lite: sqlite3.Connection, table: str, cols, batch: int) -> int:
    names = [c for c, _ in cols]
    types = [t for _, t in cols]
    insert = (f'INSERT INTO "{table}" ({", ".join(f"{chr(34)}{n}{chr(34)}" for n in names)}) '
              f'VALUES ({", ".join("?" * len(names))})')
    copied = 0
    lite.execute("BEGIN IMMEDIATE")
    try:
        with pg.cursor(name=f"orcha_convert_{table}") as cur:
            cur.itersize = batch
            cur.execute(f'SELECT {_select_list(cols)} FROM "{table}"')
            while True:
                rows = cur.fetchmany(batch)
                if not rows:
                    break
                lite.executemany(insert, [
                    tuple(map_value(v, t) for v, t in zip(row, types)) for row in rows
                ])
                copied += len(rows)
        lite.execute("COMMIT")
    except BaseException:
        if lite.in_transaction:
            lite.execute("ROLLBACK")
        raise
    return copied


def _stamp_migrations(pg, lite: sqlite3.Connection) -> None:
    """Keep the Postgres ``applied_at`` history for every version the baseline folds in."""
    rows = pg.execute("SELECT version, applied_at FROM schema_migrations").fetchall()
    lite.execute("BEGIN IMMEDIATE")
    lite.executemany(
        "UPDATE schema_migrations SET applied_at = ? WHERE version = ?",
        [(ts_text(applied) if applied else None, version) for version, applied in rows
         if applied is not None],
    )
    lite.execute("COMMIT")


def _check_sequences(lite: sqlite3.Connection) -> None:
    seqs = dict(lite.execute("SELECT name, seq FROM sqlite_sequence").fetchall())
    for (name,) in lite.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%'"
    ).fetchall():
        top = lite.execute(f'SELECT max(id) FROM "{name}"').fetchone()[0]
        if top is not None and seqs.get(name, 0) < top:
            raise ConvertError(f"sqlite_sequence for {name} is {seqs.get(name)} < max(id) {top}")


def _verify(pg, lite: sqlite3.Connection, plan: list, sample: int, rng: random.Random) -> int:
    compared = 0
    for table, cols, copied in plan:
        pg_count = pg.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        lite_count = lite.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        if not pg_count == lite_count == copied:
            raise ConvertError(f"{table}: Postgres has {pg_count} rows, SQLite {lite_count}")
        if not sample or not lite_count:
            continue
        names = [c for c, _ in cols]
        types = [t for _, t in cols]
        pk = [r[1] for r in sorted(lite.execute(f'PRAGMA table_info("{table}")'),
                                   key=lambda r: r[5]) if r[5]]
        key_idx = [names.index(c) for c in pk] or [
            i for i, t in enumerate(types) if t != "jsonb"]
        where = " AND ".join(f'"{names[i]}" IS NOT DISTINCT FROM %s' for i in key_idx)
        rowids = [r[0] for r in lite.execute(f'SELECT rowid FROM "{table}"')]
        for rowid in rng.sample(rowids, min(sample, len(rowids))):
            got = lite.execute(
                f'SELECT {", ".join(f"{chr(34)}{n}{chr(34)}" for n in names)} FROM "{table}" '
                "WHERE rowid = ?", (rowid,)).fetchone()
            src = pg.execute(
                f'SELECT {_select_list(cols)} FROM "{table}" WHERE {where} LIMIT 1',
                [_pg_param(got[i], types[i]) for i in key_idx],
            ).fetchone()
            if src is None:
                raise ConvertError(f"{table}: sampled row {rowid} has no Postgres match")
            for n, t, a, b in zip(names, types, src, got):
                if comparable(a, t) != comparable(b, t):
                    raise ConvertError(f"{table}.{n}: Postgres {a!r} != SQLite {b!r}")
            compared += 1
    return compared


def _pg_param(value, pg_type: str):
    """A stored SQLite value turned back into a Postgres comparison parameter."""
    if value is None:
        return None
    if pg_type.startswith("timestamp"):
        return _dt.datetime.fromisoformat(value)
    if pg_type == "boolean":
        return bool(value)
    if pg_type == "numeric":
        return decimal.Decimal(repr(value))
    return value


def _non_ascii_lower(lite: sqlite3.Connection) -> dict:
    found = {}
    for table, col in LOWER_INDEXED:
        n = 0
        for (value,) in lite.execute(f'SELECT "{col}" FROM "{table}" WHERE "{col}" IS NOT NULL'):
            if isinstance(value, str) and not value.isascii():
                n += 1
        if n:
            found[f"{table}.{col}"] = n
    return found


def convert(pg_url: str, out, *, verify_sample: int = 50, force: bool = False,
            progress: Optional[Progress] = None, batch: int = BATCH_ROWS,
            connect=None, apply_schema=apply_sqlite_schema, seed: Optional[int] = None) -> Report:
    """Copy the Postgres database at ``pg_url`` into a new SQLite file ``out``."""
    out = pathlib.Path(out)
    report = Report(out=str(out))
    if out.exists() or out.with_name(out.name + "-wal").exists():
        if not force:
            raise ConvertError(f"{out} already exists; refusing to overwrite it")
        stamp = _dt.datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        moved = out.with_name(f"{out.name}.bak-{stamp}")
        os.replace(out, moved)
        for suffix in ("-wal", "-shm"):
            side = out.with_name(out.name + suffix)
            if side.exists():
                os.replace(side, moved.with_name(moved.name + suffix))
        report.backup_of_existing = str(moved)
    if connect is None:
        import psycopg
        connect = psycopg.connect
    out.parent.mkdir(parents=True, exist_ok=True)
    lite = None
    try:
        _emit(progress, stage="schema")
        apply_schema(out)
        lite = _sqlite_connect(out)
        with connect(pg_url) as pg:
            import psycopg
            # one read-only snapshot for the copy and the verify (set before the first query)
            pg.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
            pg.read_only = True
            pg.execute("SET TIME ZONE 'UTC'")
            tables = _pg_tables(pg)
            _check_schema(pg, lite, tables)
            ordered = fk_order(tables, _pg_fk_edges(pg))
            triggers = lite.execute(
                "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").fetchall()
            lite.execute("PRAGMA foreign_keys=OFF")
            for name, _ in triggers:  # the run->task sync trigger would pre-insert copied rows
                lite.execute(f'DROP TRIGGER "{name}"')
            plan = []
            for i, table in enumerate(ordered, 1):
                cols = _pg_columns(pg, table)
                started = time.monotonic()
                _emit(progress, stage="copy", table=table, index=i, total=len(ordered))
                copied = _copy_table(pg, lite, table, cols, batch)
                report.tables.append(TableReport(table, copied, time.monotonic() - started))
                plan.append((table, cols, copied))
            for _, ddl in triggers:
                lite.execute(ddl)
            _stamp_migrations(pg, lite)
            _emit(progress, stage="verify")
            bad_fks = lite.execute("PRAGMA foreign_key_check").fetchall()
            if bad_fks:
                raise ConvertError(f"foreign-key check failed: {bad_fks[:5]}")
            _check_sequences(lite)
            report.sampled = _verify(pg, lite, plan, verify_sample, random.Random(seed))
            pg.rollback()
        integrity = lite.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ConvertError(f"integrity_check: {integrity}")
        report.non_ascii_lower = _non_ascii_lower(lite)
        lite.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        lite.close()
        lite = None
        _emit(progress, stage="done", tables=len(report.tables), rows=report.total_rows)
        return report
    except BaseException as exc:
        if lite is not None:
            lite.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                out.with_name(out.name + suffix).unlink()
            except FileNotFoundError:
                pass
        if isinstance(exc, ConvertError):
            raise
        if isinstance(exc, Exception):
            raise ConvertError(f"{type(exc).__name__}: {exc}") from exc
        raise


# ---------------------------------------------------------------- command line

def main(argv=None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="pg_to_sqlite.py",
        description="Copy a Postgres Orcha database into a new SQLite file (never overwrites).",
    )
    parser.add_argument("--pg", required=True, help="postgresql:// URL of the source database")
    parser.add_argument("--out", required=True, help="the SQLite file to create")
    parser.add_argument("--verify-sample", type=int, default=50,
                        help="random rows per table compared field by field (default 50)")
    parser.add_argument("--force", action="store_true",
                        help="move an existing --out aside to <name>.bak-<UTC ts> first")
    parser.add_argument("--json", action="store_true",
                        help="one JSON object per line: progress events, then the report")
    args = parser.parse_args(argv)

    def progress(event: dict) -> None:
        if args.json:
            print(json.dumps({"event": "progress", **event}), flush=True)

    try:
        report = convert(args.pg, args.out, verify_sample=args.verify_sample,
                         force=args.force, progress=progress)
    except ConvertError as exc:
        if args.json:
            print(json.dumps({"event": "error", "error": str(exc)}), flush=True)
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"event": "report", **report.as_dict()}), flush=True)
    else:
        print(report.render())
    return 0


if __name__ == "__main__":
    sys.exit(main())
