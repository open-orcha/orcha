#!/usr/bin/env python3
"""Generate the SQLite baseline schema from a fully-migrated Postgres database (GH #258 plan
PR 7a, decision D10).

SQLite cannot replay the Postgres migrations (no ``ADD COLUMN IF NOT EXISTS``, no
``DROP CONSTRAINT``, no plpgsql), so the SQLite side starts from ONE squashed file,
``orcha-cli/orcha_cli/templates/migrations/sqlite/001_baseline.sql``. This script writes it by
reading the live catalog of a Postgres database that has every ``templates/migrations/*.sql``
applied (``information_schema`` + ``pg_constraint`` + ``pg_indexes``) and applying the plan's
type map (Part 4 §S3 "Baseline schema"). Anything it does not know how to translate makes it
fail loudly instead of guessing: a new column type, default, CHECK/index expression or
plpgsql trigger has to be taught here (and hand-reviewed) before the baseline can move.

The committed baseline is exactly this script's output; review the diff, then freeze it.

    # build a throwaway Postgres DB from the migrations and write the baseline
    python tools/db/gen_sqlite_baseline.py \\
        --admin-url postgresql://orcha:orcha@localhost:5437/postgres --scratch-db orcha_baseline_gen

    # or read an already-migrated database
    python tools/db/gen_sqlite_baseline.py --dsn postgresql://orcha:orcha@localhost:5437/orcha_test

    # exit 1 if the committed baseline differs from what the catalog generates
    python tools/db/gen_sqlite_baseline.py --dsn ... --check
"""
from __future__ import annotations

import argparse
import difflib
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
PG_MIGRATIONS = REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations"
BASELINE = PG_MIGRATIONS / "sqlite" / "001_baseline.sql"
BASELINE_VERSION = BASELINE.name

# v4-shaped UUID text (plan Appendix B): 8-4-4-4-12 lowercase hex, version nibble 4,
# variant nibble one of 8/9/a/b.
UUID_V4_DEFAULT = (
    "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || "
    "substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || "
    "substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))"
)
# ISO-8601 UTC with microseconds and +00:00 (D3) — the same text psycopg's datetimes serialise to.
NOW_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00')"

# Postgres data_type -> SQLite declared type. The declared name is what the sqlite3 converters
# key on (D3), so TIMESTAMPTZ / JSONB / UUID / BOOLEAN keep their Postgres spelling.
TYPE_MAP = {
    "uuid": "UUID",
    "timestamp with time zone": "TIMESTAMPTZ",
    "jsonb": "JSONB",
    "boolean": "BOOLEAN",
    "text": "TEXT",
    "smallint": "INTEGER",
    "integer": "INTEGER",
    "bigint": "INTEGER",
    "double precision": "REAL",
    "numeric": "REAL",
}

# plpgsql triggers have no mechanical translation; each one is hand-ported here. The keys are
# the Postgres trigger names the catalog must contain — any other trigger fails the run.
TRIGGERS = {
    # 031_worker_run_tasks.sql: AFTER INSERT OR UPDATE OF task_id -> sync_worker_run_task().
    "worker_run_task_sync": [
        "CREATE TRIGGER worker_run_task_sync_ins AFTER INSERT ON worker_runs "
        "WHEN NEW.task_id IS NOT NULL BEGIN INSERT OR IGNORE INTO worker_run_tasks "
        "(run_id, task_id) VALUES (NEW.run_id, NEW.task_id); END;",
        "CREATE TRIGGER worker_run_task_sync_upd AFTER UPDATE OF task_id ON worker_runs "
        "WHEN NEW.task_id IS NOT NULL BEGIN INSERT OR IGNORE INTO worker_run_tasks "
        "(run_id, task_id) VALUES (NEW.run_id, NEW.task_id); END;",
    ],
    # 055_agent_config_revisions.sql: BEFORE UPDATE -> RAISE EXCEPTION (append-only history).
    "agent_config_revisions_no_update": [
        "CREATE TRIGGER agent_config_revisions_no_update BEFORE UPDATE ON agent_config_revisions "
        "BEGIN SELECT RAISE(ABORT, 'agent_config_revisions rows are immutable "
        "(history is append-only)'); END;",
    ],
}

# Expressions with no SQLite spelling, translated by hand (key = pg_get_constraintdef text).
CHECK_OVERRIDES = {
    # project_skills.name ~ '^[a-z0-9][a-z0-9-]{0,62}$' — SQLite ships no REGEXP function.
    "CHECK ((name ~ '^[a-z0-9][a-z0-9-]{0,62}$'::text))":
        "CHECK (length(name) BETWEEN 1 AND 63 AND name GLOB '[a-z0-9]*' "
        "AND name NOT GLOB '*[^a-z0-9-]*')",
}

_CASTS = re.compile(r"::(?:text|jsonb|json|numeric|integer|bigint|smallint|boolean|uuid)\b")
_ANY_ARRAY = re.compile(r"(\w+) = ANY \(ARRAY\[([^\]]*)\]\)")
_UNPORTABLE = re.compile(r"::|\bANY\b|\bARRAY\b|\bILIKE\b|\bnow\(\)|~|\bbtrim\b|\binterval\b", re.I)


def translate_expr(expr: str, where: str) -> str:
    """A CHECK / index-predicate / index-key expression in Postgres catalog spelling -> SQLite."""
    out = _ANY_ARRAY.sub(lambda m: f"{m.group(1)} IN ({m.group(2)})", expr)
    out = _CASTS.sub("", out)
    out = re.sub(r"\bbtrim\(", "trim(", out)
    if _UNPORTABLE.search(out):
        raise SystemExit(f"untranslatable expression in {where}: {expr!r} -> {out!r}")
    return out


def translate_default(col: dict, where: str) -> str | None:
    d = col["column_default"]
    if d is None:
        return None
    if d == "gen_random_uuid()":
        return UUID_V4_DEFAULT
    if d == "now()":
        return NOW_DEFAULT
    if d in ("true", "false"):
        return "1" if d == "true" else "0"
    if re.fullmatch(r"-?\d+(\.\d+)?", d):
        return d
    m = re.fullmatch(r"('(?:[^']|'')*')::(?:text|jsonb)", d)
    if m:
        return m.group(1)
    raise SystemExit(f"untranslatable default in {where}: {d!r}")


def _fetch(conn, sql, params=()):
    cur = conn.execute(sql, params)
    names = [c.name for c in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def read_catalog(conn) -> dict:
    """Everything the baseline needs, from the live Postgres catalog (schema ``public``)."""
    tables = [r["table_name"] for r in _fetch(conn, """
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           AND table_name <> 'schema_migrations'
         ORDER BY table_name""")]
    columns = {t: [] for t in tables}
    for r in _fetch(conn, """
        SELECT table_name, column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
         ORDER BY table_name, ordinal_position"""):
        columns[r["table_name"]].append(r)
    constraints = {t: [] for t in tables}
    for r in _fetch(conn, """
        SELECT c.conrelid::regclass::text AS table_name, c.conname, c.contype::text AS contype,
               pg_get_constraintdef(c.oid) AS def, c.confrelid::regclass::text AS ref_table,
               ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
                       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
                      ORDER BY k.i)::text[] AS cols
          FROM pg_constraint c
         WHERE c.connamespace = 'public'::regnamespace AND c.contype IN ('p', 'u', 'f', 'c')
           AND c.conrelid::regclass::text <> 'schema_migrations'
         ORDER BY 1, 2"""):
        constraints[r["table_name"]].append(r)
    indexes = _fetch(conn, """
        SELECT i.tablename AS table_name, i.indexname, i.indexdef
          FROM pg_indexes i
         WHERE i.schemaname = 'public' AND i.tablename <> 'schema_migrations'
           AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                            WHERE k.conindid = (quote_ident(i.schemaname) || '.' ||
                                                quote_ident(i.indexname))::regclass)
         ORDER BY i.tablename, i.indexname""")
    triggers = sorted(r["tgname"] for r in _fetch(conn, """
        SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace"""))
    return {"tables": tables, "columns": columns, "constraints": constraints,
            "indexes": indexes, "triggers": triggers}


def fk_order(tables: list[str], constraints: dict) -> list[str]:
    """Referenced tables first (the order the converter in PR 8 copies in); ties and any
    cycle broken alphabetically so the output is stable."""
    deps = {t: {c["ref_table"] for c in constraints[t] if c["contype"] == "f"} - {t}
            for t in tables}
    ordered, done = [], set()
    while len(ordered) < len(tables):
        ready = [t for t in tables if t not in done and deps[t] <= done]
        pick = ready[0] if ready else min(t for t in tables if t not in done)
        ordered.append(pick)
        done.add(pick)
    return ordered


def render_table(table: str, columns: list[dict], constraints: list[dict]) -> str:
    pk = next((c for c in constraints if c["contype"] == "p"), None)
    single_pk = pk["cols"][0] if pk and len(pk["cols"]) == 1 else None
    lines = []
    for col in columns:
        where = f"{table}.{col['column_name']}"
        if col["data_type"] not in TYPE_MAP:
            raise SystemExit(f"unmapped column type {col['data_type']!r} at {where}")
        decl = TYPE_MAP[col["data_type"]]
        default = col["column_default"]
        if default and default.startswith("nextval("):
            # BIGSERIAL id: the rowid alias; AUTOINCREMENT keeps ids monotonic like a sequence.
            if col["column_name"] != single_pk or decl != "INTEGER":
                raise SystemExit(f"nextval() default outside a single-column PK at {where}")
            lines.append(f"    {col['column_name']} INTEGER PRIMARY KEY AUTOINCREMENT")
            continue
        parts = [col["column_name"], decl]
        if col["column_name"] == single_pk:
            parts.append("PRIMARY KEY")
        if col["is_nullable"] == "NO":
            parts.append("NOT NULL")
        sqlite_default = translate_default(col, where)
        if sqlite_default is not None:
            parts.append(f"DEFAULT {sqlite_default}")
        lines.append("    " + " ".join(parts))
    if pk and single_pk is None:
        lines.append(f"    PRIMARY KEY ({', '.join(pk['cols'])})")
    for kind in ("u", "c", "f"):
        for c in constraints:
            if c["contype"] != kind:
                continue
            where = f"{table} constraint {c['conname']}"
            if kind == "u":
                body = f"UNIQUE ({', '.join(c['cols'])})"
            elif kind == "c":
                body = CHECK_OVERRIDES.get(c["def"]) or translate_expr(c["def"], where)
            else:
                body = c["def"]
                if not re.fullmatch(r"FOREIGN KEY \([\w, ]+\) REFERENCES \w+\([\w, ]+\)"
                                    r"( ON DELETE (CASCADE|SET NULL))?", body):
                    raise SystemExit(f"unexpected foreign key shape in {where}: {body!r}")
            lines.append(f"    CONSTRAINT {c['conname']} {body}")
    return f"CREATE TABLE {table} (\n" + ",\n".join(lines) + "\n);"


def render_index(ix: dict) -> str:
    m = re.fullmatch(r"CREATE (UNIQUE )?INDEX (\w+) ON public\.(\w+) USING btree \((.*?)\)"
                     r"(?: WHERE \((.*)\))?", ix["indexdef"])
    if not m:
        raise SystemExit(f"unexpected index shape: {ix['indexdef']!r}")
    unique, name, table, keys, pred = m.groups()
    where = f"index {name}"
    out = f"CREATE {unique or ''}INDEX {name} ON {table} ({translate_expr(keys, where)})"
    if pred:
        out += f" WHERE {translate_expr(pred, where)}"
    return out + ";"


def render(catalog: dict, migration_names: list[str]) -> str:
    unknown = sorted(set(catalog["triggers"]) - set(TRIGGERS))
    missing = sorted(set(TRIGGERS) - set(catalog["triggers"]))
    if unknown or missing:
        raise SystemExit(f"trigger set changed: new={unknown} gone={missing}; hand-port them")
    tables = fk_order(catalog["tables"], catalog["constraints"])
    out = [
        "-- Orcha SQLite baseline schema (GH #258, plan D10). GENERATED by",
        "-- tools/db/gen_sqlite_baseline.py from a Postgres database with all",
        f"-- {len(migration_names)} templates/migrations/*.sql applied "
        f"({migration_names[0]} .. {migration_names[-1]}); hand-reviewed, then frozen.",
        "-- Do not edit by hand: change the generator and regenerate.",
        "--",
        f"-- {len(tables)} tables, {len(catalog['indexes'])} indexes, "
        f"{sum(len(v) for v in TRIGGERS.values())} triggers. Needs SQLite >= 3.38.",
        "-- Every statement ends with ';' at end of line (run_migrations splits on it).",
        "",
        "CREATE TABLE IF NOT EXISTS schema_migrations (",
        "    version TEXT PRIMARY KEY NOT NULL,",
        f"    applied_at TIMESTAMPTZ NOT NULL DEFAULT {NOW_DEFAULT}",
        ");",
        "",
    ]
    for t in tables:
        out += [render_table(t, catalog["columns"][t], catalog["constraints"][t]), ""]
    out += [render_index(ix) for ix in catalog["indexes"]] + [""]
    for pg_name in sorted(TRIGGERS):
        out += TRIGGERS[pg_name]
    out += [
        "",
        "-- The baseline's own row plus every Postgres migration it folds in, so a fresh",
        "-- SQLite DB and one converted from Postgres report the same history and tip.",
        "INSERT OR IGNORE INTO schema_migrations (version) VALUES",
        ",\n".join(f"    ('{n}')" for n in [BASELINE_VERSION] + migration_names) + ";",
    ]
    return "\n".join(out) + "\n"


def build_scratch(admin_url: str, db_name: str) -> str:
    import psycopg
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{db_name}"')
    dsn = admin_url.rsplit("/", 1)[0] + f"/{db_name}"
    with psycopg.connect(dsn) as conn:
        for f in sorted(PG_MIGRATIONS.glob("*.sql")):
            conn.execute(f.read_text())
        conn.commit()
    return dsn


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dsn", help="an already fully-migrated Postgres database")
    src.add_argument("--admin-url", help="build a scratch DB from the migrations via this URL")
    ap.add_argument("--scratch-db", default="orcha_sqlite_baseline_gen")
    ap.add_argument("--out", type=pathlib.Path, default=BASELINE)
    ap.add_argument("--check", action="store_true", help="diff against --out instead of writing")
    args = ap.parse_args(argv)

    import psycopg
    dsn = args.dsn or build_scratch(args.admin_url, args.scratch_db)
    with psycopg.connect(dsn) as conn:
        catalog = read_catalog(conn)
    text = render(catalog, sorted(f.name for f in PG_MIGRATIONS.glob("*.sql")))
    if args.check:
        current = args.out.read_text() if args.out.exists() else ""
        if current == text:
            print(f"{args.out} is up to date")
            return 0
        sys.stdout.writelines(difflib.unified_diff(
            current.splitlines(True), text.splitlines(True), str(args.out), "generated"))
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
