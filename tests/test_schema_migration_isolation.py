"""Regression for migration-ledger isolation across the shared test database."""

from conftest import schema_migrations_hidden
from portal_backend import database, sql


def _rows(statement):
    with database.db_cursor() as (_conn, cur):
        cur.execute(statement)
        return cur.fetchall()


def _schema_signature():
    if database.BACKEND == "postgres":
        return _rows(
            "SELECT column_name, data_type, is_nullable, column_default "
            "FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='schema_migrations' "
            "ORDER BY ordinal_position"
        )
    return _rows("PRAGMA table_info(schema_migrations)")


def test_hiding_migration_ledger_restores_exact_rows():
    before = _rows("SELECT version, applied_at FROM schema_migrations ORDER BY version")
    schema_before = _schema_signature()
    assert before

    with schema_migrations_hidden():
        present = _rows(
            f"SELECT {sql.table_exists('schema_migrations')} AS present"
        )[0]["present"]
        assert not present

    assert _rows(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version"
    ) == before
    assert _schema_signature() == schema_before
