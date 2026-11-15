"""Every Postgres migration has a SQLite twin, and the other way round (GH #377).

The test suite runs on SQLite only, so the old live-Postgres schema comparison
(test_schema_parity) is gone. This file-level check keeps its cheapest guarantee: a
Postgres migration cannot land without its SQLite version.

The pairing rule: ``sqlite/001_baseline.sql`` folds in Postgres ``001``..``071`` and stamps
each of their names into ``schema_migrations``. After that, every Postgres migration
``NNN_name.sql`` has a SQLite file ``MMM_name.sql`` with the same name after the number.
"""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations"
SQLITE = MIGRATIONS / "sqlite"
BASELINE = SQLITE / "001_baseline.sql"
LAST_IN_BASELINE = 71


def _suffix(name):
    return name.split("_", 1)[1]


def _postgres():
    return sorted(p.name for p in MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql"))


def _sqlite():
    return sorted(p.name for p in SQLITE.glob("[0-9][0-9][0-9]_*.sql") if p != BASELINE)


def test_baseline_stamps_every_folded_in_postgres_migration():
    stamped = set(re.findall(r"\('(\d{3}_[a-z0-9_]+\.sql)'\)", BASELINE.read_text()))
    folded = [n for n in _postgres() if int(n[:3]) <= LAST_IN_BASELINE]
    assert len(folded) == LAST_IN_BASELINE
    missing = [n for n in folded if n not in stamped]
    assert not missing, f"sqlite/001_baseline.sql does not stamp: {missing}"


def test_every_later_postgres_migration_has_a_sqlite_twin():
    twins = {_suffix(n) for n in _sqlite()}
    missing = [n for n in _postgres() if int(n[:3]) > LAST_IN_BASELINE and _suffix(n) not in twins]
    assert not missing, (
        f"Postgres migrations without a SQLite twin in {SQLITE.relative_to(REPO)}: {missing}")


def test_every_sqlite_migration_has_a_postgres_twin():
    later = {_suffix(n) for n in _postgres() if int(n[:3]) > LAST_IN_BASELINE}
    orphans = [n for n in _sqlite() if _suffix(n) not in later]
    assert not orphans, f"SQLite migrations without a Postgres twin: {orphans}"


def test_twins_apply_in_the_same_order():
    pg_order = [_suffix(n) for n in _postgres() if int(n[:3]) > LAST_IN_BASELINE]
    assert [_suffix(n) for n in _sqlite()] == pg_order
