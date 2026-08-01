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

_PROBE_TABLES = (
    "schema_migrations", "r1_probe", "r1_after",
    # Seam C (open-orcha#213) probe/ledger tables.
    "extra_schema_migrations", "c1_extra_probe", "c1_extra_after", "c1_core_probe",
)


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


# --- Seam C (open-orcha#213) — namespaced extra migrations -----------------------------
#
# ORCHA_EXTRA_MIGRATIONS names a directory of *.sql files applied AFTER all core
# migrations, tracked in their own `extra_schema_migrations` ledger (never touching
# `schema_migrations`). Pinned decisions exercised below:
#   - unset env => byte-for-byte today's behavior; no extra table is ever created.
#   - extra dir readable => its own ledger table is created (even for zero files),
#     mirroring core's "ledger always exists" behavior once its dir is readable.
#   - extra files apply strictly after every core file in the same run.
#   - the same NNN numeric prefix may exist in both core and extra (separate ledgers
#     keyed by filename => no collision possible).
#   - re-boot (second run_migrations call) is idempotent for both ledgers.
#   - an unreadable/missing extra dir is a silent no-op (matches core's MIGRATIONS_DIR
#     philosophy: `mdir.is_dir()` gates a plain empty-list, not an exception).


def test_unset_extra_env_is_byte_for_byte_todays_behavior(tmp_path):
    """Zero effect when ORCHA_EXTRA_MIGRATIONS is unset: no extra table, core untouched."""
    (tmp_path / "001_init.sql").write_text(INIT_SQL.read_text())
    (tmp_path / "002_probe.sql").write_text("CREATE TABLE r1_probe (id INT PRIMARY KEY);")
    applied = main.run_migrations(tmp_path)
    assert applied == ["baseline:001_init.sql", "002_probe.sql"]
    # No extra_migrations_dir arg and (by construction of the test env) no
    # ORCHA_EXTRA_MIGRATIONS in the environment => extra ledger never created.
    assert _sql("SELECT to_regclass('public.extra_schema_migrations')")[0][0] is None


def test_extra_migrations_apply_after_core_into_own_ledger(tmp_path):
    core_dir = tmp_path / "core"
    extra_dir = tmp_path / "extra"
    core_dir.mkdir()
    extra_dir.mkdir()
    (core_dir / "001_init.sql").write_text(INIT_SQL.read_text())
    (core_dir / "002_core.sql").write_text(
        "CREATE TABLE c1_core_probe (id INT PRIMARY KEY);"
    )
    (extra_dir / "001_extra.sql").write_text(
        "CREATE TABLE c1_extra_probe (id INT PRIMARY KEY);"
    )

    applied = main.run_migrations(core_dir, extra_dir)

    # Core, then extra, in that order; extra's own filenames recorded distinctly.
    assert applied == [
        "baseline:001_init.sql",
        "002_core.sql",
        "001_extra.sql",
    ]
    core_versions = {r[0] for r in _sql("SELECT version FROM schema_migrations")}
    extra_versions = {r[0] for r in _sql("SELECT version FROM extra_schema_migrations")}
    assert core_versions == {"001_init.sql", "002_core.sql"}
    assert extra_versions == {"001_extra.sql"}
    assert _sql("SELECT to_regclass('public.c1_core_probe')")[0][0] is not None
    assert _sql("SELECT to_regclass('public.c1_extra_probe')")[0][0] is not None


def test_same_numeric_prefix_coexists_in_core_and_extra(tmp_path):
    """Core and extra are separate namespaces keyed by filename in separate ledgers,
    so an identical NNN prefix in both dirs is not a collision."""
    core_dir = tmp_path / "core"
    extra_dir = tmp_path / "extra"
    core_dir.mkdir()
    extra_dir.mkdir()
    (core_dir / "001_init.sql").write_text(INIT_SQL.read_text())
    (core_dir / "002_shared_number.sql").write_text(
        "CREATE TABLE c1_core_probe (id INT PRIMARY KEY);"
    )
    (extra_dir / "002_shared_number.sql").write_text(
        "CREATE TABLE c1_extra_probe (id INT PRIMARY KEY);"
    )

    applied = main.run_migrations(core_dir, extra_dir)

    assert applied == ["baseline:001_init.sql", "002_shared_number.sql", "002_shared_number.sql"]
    assert {r[0] for r in _sql("SELECT version FROM schema_migrations")} >= {
        "001_init.sql", "002_shared_number.sql"
    }
    assert {r[0] for r in _sql("SELECT version FROM extra_schema_migrations")} == {
        "002_shared_number.sql"
    }
    assert _sql("SELECT to_regclass('public.c1_core_probe')")[0][0] is not None
    assert _sql("SELECT to_regclass('public.c1_extra_probe')")[0][0] is not None


def test_extra_migrations_reboot_is_idempotent(tmp_path):
    core_dir = tmp_path / "core"
    extra_dir = tmp_path / "extra"
    core_dir.mkdir()
    extra_dir.mkdir()
    (core_dir / "001_init.sql").write_text(INIT_SQL.read_text())
    (extra_dir / "001_extra.sql").write_text(
        "CREATE TABLE c1_extra_probe (id INT PRIMARY KEY);"
    )

    first = main.run_migrations(core_dir, extra_dir)
    assert first == ["baseline:001_init.sql", "001_extra.sql"]

    second = main.run_migrations(core_dir, extra_dir)
    assert second == []   # nothing reapplied on either ledger
    assert len(_sql("SELECT version FROM extra_schema_migrations")) == 1


def test_extra_ledger_created_even_with_zero_extra_files(tmp_path):
    """A readable-but-empty extra dir still gets its own ledger table (mirrors core's
    'ledger always exists once the dir is readable' behavior) — but applies nothing."""
    core_dir = tmp_path / "core"
    extra_dir = tmp_path / "extra"
    core_dir.mkdir()
    extra_dir.mkdir()
    (core_dir / "001_init.sql").write_text(INIT_SQL.read_text())

    applied = main.run_migrations(core_dir, extra_dir)

    assert applied == ["baseline:001_init.sql"]
    assert _sql("SELECT to_regclass('public.extra_schema_migrations')")[0][0] is not None
    assert _sql("SELECT version FROM extra_schema_migrations") == []


def test_missing_extra_dir_is_a_silent_noop(tmp_path):
    """An unreadable/nonexistent ORCHA_EXTRA_MIGRATIONS path is skipped, not an error —
    same philosophy as core's MIGRATIONS_DIR: `is_dir()` gates a plain empty list."""
    core_dir = tmp_path / "core"
    core_dir.mkdir()
    (core_dir / "001_init.sql").write_text(INIT_SQL.read_text())
    missing_extra_dir = tmp_path / "does-not-exist"

    applied = main.run_migrations(core_dir, missing_extra_dir)

    assert applied == ["baseline:001_init.sql"]
    assert _sql("SELECT to_regclass('public.extra_schema_migrations')")[0][0] is None


def test_orcha_extra_migrations_env_var_is_read_when_arg_omitted(tmp_path, monkeypatch):
    """The env var (not just the explicit arg) drives the extra dir, matching how
    MIGRATIONS_DIR/ORCHA_EXTRA_MIGRATIONS are read at import/module scope in database.py."""
    core_dir = tmp_path / "core"
    extra_dir = tmp_path / "extra"
    core_dir.mkdir()
    extra_dir.mkdir()
    (core_dir / "001_init.sql").write_text(INIT_SQL.read_text())
    (extra_dir / "001_extra.sql").write_text(
        "CREATE TABLE c1_extra_probe (id INT PRIMARY KEY);"
    )

    import portal_backend.database as database_module

    monkeypatch.setattr(database_module, "EXTRA_MIGRATIONS_DIR", extra_dir)
    applied = main.run_migrations(core_dir)

    assert applied == ["baseline:001_init.sql", "001_extra.sql"]
    assert _sql("SELECT to_regclass('public.c1_extra_probe')")[0][0] is not None
