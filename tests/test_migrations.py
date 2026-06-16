"""R1 — incremental migration runner tests.

Exercises main.run_migrations against the conftest test DB (which already has the 001
schema loaded): 001 is recorded as a baseline WITHOUT re-running, a later migration is
applied once then skipped (idempotent), and a failing migration halts without recording.
"""
import pathlib
import sys

import psycopg
import pytest

# main is importable via conftest's sys.path setup (PORTAL_DIR).
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent
                       / "orcha-cli" / "orcha_cli" / "templates" / "portal"))
import main  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parent.parent
INIT_SQL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations" / "001_init.sql"

_PROBE_TABLES = ("schema_migrations", "r1_probe", "r1_after")


def _sql(q):
    with psycopg.connect(main.DB, autocommit=True) as c:
        cur = c.execute(q)
        try:
            return cur.fetchall()
        except psycopg.ProgrammingError:
            return []


@pytest.fixture(autouse=True)
def _clean_runner_tables():
    for t in _PROBE_TABLES:
        _sql(f"DROP TABLE IF EXISTS {t}")
    yield
    for t in _PROBE_TABLES:
        _sql(f"DROP TABLE IF EXISTS {t}")


def test_baseline_records_001_without_rerun_then_applies_next(tmp_path):
    # test DB already has the 001 schema (conftest) -> containers exists -> baseline path
    (tmp_path / "001_init.sql").write_text(INIT_SQL.read_text())
    (tmp_path / "002_probe.sql").write_text("CREATE TABLE r1_probe (id INT PRIMARY KEY);")
    applied = main.run_migrations(tmp_path)
    assert any(a == "baseline:001_init.sql" for a in applied)   # recorded, NOT re-run
    assert "002_probe.sql" in applied
    versions = {r[0] for r in _sql("SELECT version FROM schema_migrations")}
    assert {"001_init.sql", "002_probe.sql"} <= versions
    assert _sql("SELECT to_regclass('public.r1_probe')")[0][0] is not None
    # idempotent: a second run applies nothing
    assert main.run_migrations(tmp_path) == []


def test_failing_migration_halts_and_records_nothing(tmp_path):
    (tmp_path / "001_init.sql").write_text(INIT_SQL.read_text())
    (tmp_path / "002_bad.sql").write_text("CREATE TABLE bad (;")     # invalid SQL
    (tmp_path / "003_after.sql").write_text("CREATE TABLE r1_after (id INT);")
    with pytest.raises(RuntimeError):
        main.run_migrations(tmp_path)
    versions = {r[0] for r in _sql("SELECT version FROM schema_migrations")}
    assert "002_bad.sql" not in versions       # failed migration not recorded
    assert "003_after.sql" not in versions      # halted: later migration never ran
    assert _sql("SELECT to_regclass('public.r1_after')")[0][0] is None


def test_empty_migrations_dir_just_creates_ledger(tmp_path):
    applied = main.run_migrations(tmp_path)
    assert applied == []
    assert _sql("SELECT to_regclass('public.schema_migrations')")[0][0] is not None


def test_compose_initdb_only_baseline_portal_owns_rest():
    """P1 regression: initdb must mount ONLY 001 (else a fresh volume double-applies 002+,
    since both initdb and the portal runner would run it). The portal mounts the full dir."""
    compose = (REPO / "orcha-cli" / "orcha_cli" / "templates" / "docker-compose.yml.j2").read_text()
    # db initdb gets only the 001 baseline file, NOT the whole migrations dir
    assert "./migrations/001_init.sql:/docker-entrypoint-initdb.d/001_init.sql" in compose
    assert "./migrations:/docker-entrypoint-initdb.d" not in compose
    # portal still gets the whole dir (the runner owns 002+) + MIGRATIONS_DIR
    assert "./migrations:/app/migrations" in compose
    assert "MIGRATIONS_DIR: /app/migrations" in compose


def _boom(*a, **k):
    raise RuntimeError("simulated migration failure")


def test_startup_hook_hard_fails_by_default(monkeypatch):
    """Review (Tim): a failed migration must abort portal startup, not serve a stale schema."""
    monkeypatch.setattr(main, "run_migrations", _boom)
    monkeypatch.delenv("ORCHA_MIGRATE_ON_FAILURE", raising=False)
    with pytest.raises(RuntimeError):
        main._startup_migrate()


def test_startup_hook_continue_env_serves_anyway(monkeypatch):
    """Opt-in resilience: ORCHA_MIGRATE_ON_FAILURE=continue logs + serves current schema."""
    monkeypatch.setattr(main, "run_migrations", _boom)
    monkeypatch.setenv("ORCHA_MIGRATE_ON_FAILURE", "continue")
    main._startup_migrate()   # must NOT raise
