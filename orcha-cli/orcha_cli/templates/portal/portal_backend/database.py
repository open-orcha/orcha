"""Own database connections and the idempotent SQL migration runner."""

import os
import pathlib
from contextlib import contextmanager
from typing import Optional

import psycopg
from psycopg.rows import dict_row

DB = os.environ["DATABASE_URL"]
MIGRATIONS_DIR = pathlib.Path(os.environ.get("MIGRATIONS_DIR", "/app/migrations"))
_MIGRATION_LOCK_KEY = 4242421

# Seam C (open-orcha#213): an optional, namespaced "extra" migrations directory for
# downstream distributions (e.g. orcha-cloud). Applied AFTER all core migrations, tracked
# in its own ledger table so it can never collide with or perturb the core one. Zero effect
# when unset — read once at import time, same as MIGRATIONS_DIR above.
EXTRA_MIGRATIONS_DIR_ENV = "ORCHA_EXTRA_MIGRATIONS"
_extra_dir_env = os.environ.get(EXTRA_MIGRATIONS_DIR_ENV)
EXTRA_MIGRATIONS_DIR = pathlib.Path(_extra_dir_env) if _extra_dir_env else None


@contextmanager
def db_cursor():
    """Yield a transactional dictionary-row cursor."""
    with psycopg.connect(DB, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            yield conn, cur


def _apply_pending(conn, files, *, table: str, baseline_exempt: bool) -> list[str]:
    """Apply `files` not yet recorded in `table`, in lexical order, one commit per file.

    Mirrors the core runner's semantics exactly: the ledger table is created if
    missing, already-recorded filenames are skipped (idempotent), a failing migration
    rolls back and halts (nothing after it runs), and each success is committed
    immediately so a later failure can't undo earlier progress. `baseline_exempt`
    reproduces the core-only 001_init.sql special case (see `run_migrations`); the
    extra ledger never sets it, since there is no pre-existing schema to reconcile
    against for a downstream-owned namespace.
    """
    conn.execute(
        f"CREATE TABLE IF NOT EXISTS {table} "
        "(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    )
    conn.commit()
    done = {row[0] for row in conn.execute(f"SELECT version FROM {table}").fetchall()}
    core_exists = (
        conn.execute("SELECT to_regclass('public.containers')").fetchone()[0]
        is not None
    )
    applied: list[str] = []
    for migration in files:
        version = migration.name
        if version in done:
            continue
        baseline = baseline_exempt and version == "001_init.sql" and core_exists
        try:
            if not baseline:
                conn.execute(migration.read_text())
            conn.execute(
                f"INSERT INTO {table}(version) VALUES (%s) ON CONFLICT DO NOTHING",
                (version,),
            )
            conn.commit()
        except Exception as exc:
            conn.rollback()
            raise RuntimeError(
                f"migration {version} failed (halting): {exc}"
            ) from exc
        applied.append(("baseline:" if baseline else "") + version)
    return applied


def run_migrations(
    migrations_dir: Optional[pathlib.Path] = None,
    extra_migrations_dir: Optional[pathlib.Path] = None,
) -> list[str]:
    """Apply pending core migrations, then pending extra (Seam C) migrations.

    Core migrations apply first, in lexical filename order, tracked in
    `schema_migrations` — unchanged from before Seam C. If `ORCHA_EXTRA_MIGRATIONS`
    (or the `extra_migrations_dir` override) names a readable directory, its `*.sql`
    files are applied AFTER all core migrations, in lexical order, tracked in their
    own `extra_schema_migrations` ledger table. When unset (default) or unreadable,
    this is a no-op — no extra table is created and core behavior is unchanged, same
    "missing dir -> no files" philosophy the core runner already uses for
    `MIGRATIONS_DIR`.
    """
    mdir = migrations_dir or MIGRATIONS_DIR
    files = sorted(mdir.glob("*.sql")) if mdir.is_dir() else []
    edir = extra_migrations_dir if extra_migrations_dir is not None else EXTRA_MIGRATIONS_DIR
    extra_dir_readable = edir is not None and edir.is_dir()
    extra_files = sorted(edir.glob("*.sql")) if extra_dir_readable else []

    with psycopg.connect(DB) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (_MIGRATION_LOCK_KEY,))
        try:
            applied = _apply_pending(
                conn, files, table="schema_migrations", baseline_exempt=True
            )
            # The extra ledger is created only when ORCHA_EXTRA_MIGRATIONS names a
            # readable dir — pinned per Seam C: zero effect (no extra table at all)
            # when the env is unset, mirroring "today's behavior" exactly for the
            # unset case. Once the dir is readable, behave like core: the ledger
            # table is created even if that pass applies zero files.
            if extra_dir_readable:
                applied += _apply_pending(
                    conn,
                    extra_files,
                    table="extra_schema_migrations",
                    baseline_exempt=False,
                )
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (_MIGRATION_LOCK_KEY,))
            conn.commit()
    return applied
