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


@contextmanager
def db_cursor():
    """Yield a transactional dictionary-row cursor."""
    with psycopg.connect(DB, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            yield conn, cur


def run_migrations(migrations_dir: Optional[pathlib.Path] = None) -> list[str]:
    """Apply pending migration files in lexical order."""
    mdir = migrations_dir or MIGRATIONS_DIR
    files = sorted(mdir.glob("*.sql")) if mdir.is_dir() else []
    applied: list[str] = []
    with psycopg.connect(DB) as conn:
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
