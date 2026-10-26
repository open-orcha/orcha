"""Populated upgrades keep legacy authority as history and retain exact evidence."""

import pathlib
import sqlite3
import uuid

import pytest

from conftest import BACKEND, TEST_URL


REPO = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations"
SQLITE_MIGRATIONS = MIGRATIONS / "sqlite"

CONTAINER = "11111111-1111-4111-8111-111111111111"
OWNER = "22222222-2222-4222-8222-222222222222"
WORKER = "33333333-3333-4333-8333-333333333333"
OPEN_TASK = "44444444-4444-4444-8444-444444444444"
DONE_TASK = "55555555-5555-4555-8555-555555555555"
WORKFLOW = "66666666-6666-4666-8666-666666666666"
EXECUTION = "77777777-7777-4777-8777-777777777777"
DELIVERABLE = "88888888-8888-4888-8888-888888888888"
VERSION = "99999999-9999-4999-8999-999999999999"
EVIDENCE_SET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
EVIDENCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
ACCEPTANCE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"


def _seed_legacy(execute):
    execute(f"""
        INSERT INTO containers(id,name,autonomy_level,autonomy_enforced)
        VALUES ('{CONTAINER}','upgrade fixture','full',true);
        INSERT INTO agents(id,container_id,alias,role,kind,member_role)
        VALUES ('{OWNER}','{CONTAINER}','Owner','owner','human','owner');
        INSERT INTO agents(id,container_id,alias,role,kind,autonomy_override)
        VALUES ('{WORKER}','{CONTAINER}','Worker','builder','ai','pr');
        INSERT INTO tasks(id,container_id,title,definition_of_done,status)
        VALUES ('{OPEN_TASK}','{CONTAINER}','unfinished','finish it','in_progress');
        INSERT INTO tasks(id,container_id,title,definition_of_done,status,result,completed_at)
        VALUES ('{DONE_TASK}','{CONTAINER}','accepted','keep it','completed',
                '{{"result":"kept"}}',CURRENT_TIMESTAMP);
    """)


def _seed_accepted_evidence(execute):
    execute(f"""
        INSERT INTO workflows
            (id,container_id,owner_human_id,created_by_human_id,title,goal)
        VALUES ('{WORKFLOW}','{CONTAINER}','{OWNER}','{OWNER}','upgrade','retain evidence');
        UPDATE tasks SET workflow_id='{WORKFLOW}' WHERE id='{DONE_TASK}';
        INSERT INTO workflow_executions
            (id,workflow_id,task_id,generation,work_revision,source_kind,exclusive,state)
        VALUES ('{EXECUTION}','{WORKFLOW}','{DONE_TASK}',1,1,
                'import_review',true,'awaiting_review');
        INSERT INTO task_deliverables
            (id,container_id,task_id,path,kind,latest_version)
        VALUES ('{DELIVERABLE}','{CONTAINER}','{DONE_TASK}','result.json','json',1);
        INSERT INTO task_deliverable_versions
            (id,deliverable_id,version,source,author_agent_id,stored_name,
             size_bytes,sha256,content_type)
        VALUES ('{VERSION}','{DELIVERABLE}',1,'attached','{OWNER}',
                'v1.json',16,'saved-sha','application/json');
        INSERT INTO workflow_evidence_sets
            (id,workflow_execution_id,workflow_id,task_id,generation,result_revision,
             work_revision,source_sequence,capture_sha256,purpose,state,required_kinds,frozen_at)
        VALUES ('{EVIDENCE_SET}','{EXECUTION}','{WORKFLOW}','{DONE_TASK}',1,1,1,1,
                'capture-sha','acceptance','saved','["owner_result"]',CURRENT_TIMESTAMP);
        INSERT INTO workflow_evidence
            (id,evidence_set_id,task_id,kind,source,snapshot_phase,deliverable_id,
             deliverable_version,sha256,captured_by)
        VALUES ('{EVIDENCE}','{EVIDENCE_SET}','{DONE_TASK}','owner_result','owner',
                'submission','{DELIVERABLE}',1,'saved-sha','{OWNER}');
        INSERT INTO workflow_task_acceptances
            (id,workflow_id,task_id,work_revision,actor_id,actor_kind,actor_alias,
             autonomy_at_acceptance,autonomy_revision,acceptance_source,
             evidence_set_id,evidence_items)
        VALUES ('{ACCEPTANCE}','{WORKFLOW}','{DONE_TASK}',1,'{OWNER}','human','Owner',
                'off',1,'human_review','{EVIDENCE_SET}','[]');
    """)


def _assert_upgrade(query):
    assert query(f"SELECT autonomy FROM tasks WHERE id='{OPEN_TASK}'")[0][0] == "off"
    assert query(f"SELECT status FROM tasks WHERE id='{OPEN_TASK}'")[0][0] == "in_progress"
    history = query(
        f"""SELECT agent_id,project_autonomy_level,project_autonomy_enforced,
                   agent_autonomy_override
              FROM legacy_autonomy_history WHERE container_id='{CONTAINER}'
             ORDER BY agent_id"""
    )
    assert len(history) == 2
    assert any(row[0] is None and row[1] == "full" and bool(row[2]) for row in history)
    assert any(str(row[0]) == WORKER and row[3] == "pr" for row in history)
    assert query(f"SELECT count(*) FROM workflow_task_acceptances WHERE id='{ACCEPTANCE}'")[0][0] == 1
    evidence = query(
        f"""SELECT kind,source,captured_by_alias,captured_by_kind
              FROM workflow_evidence WHERE id='{EVIDENCE}'"""
    )[0]
    assert tuple(evidence) == ("owner_result", "owner", "Owner", "human")


def test_populated_sqlite_upgrade_preserves_authority_history_and_evidence(tmp_path):
    con = sqlite3.connect(tmp_path / "upgrade.db")
    con.execute("PRAGMA foreign_keys=ON")
    try:
        con.executescript((SQLITE_MIGRATIONS / "001_baseline.sql").read_text())
        con.executescript((SQLITE_MIGRATIONS / "002_worktrees_always_on.sql").read_text())
        con.executescript((SQLITE_MIGRATIONS / "003_worktree_bring_in.sql").read_text())
        _seed_legacy(con.executescript)
        con.executescript((SQLITE_MIGRATIONS / "004_task_autonomy.sql").read_text())
        for name in ("005_workflows.sql", "006_workflow_evidence.sql",
                     "007_workflow_workers.sql"):
            con.executescript((SQLITE_MIGRATIONS / name).read_text())
        _seed_accepted_evidence(con.executescript)
        con.executescript((SQLITE_MIGRATIONS / "008_workflow_evidence_supplier.sql").read_text())
        con.executescript((SQLITE_MIGRATIONS / "009_workflow_import_evidence.sql").read_text())
        _assert_upgrade(lambda statement: con.execute(statement).fetchall())
    finally:
        con.close()


@pytest.mark.skipif(BACKEND != "postgres", reason="runs the populated PostgreSQL upgrade leg")
def test_populated_postgres_upgrade_preserves_authority_history_and_evidence():
    import psycopg
    from psycopg import sql

    schema = "upgrade_" + uuid.uuid4().hex
    with psycopg.connect(TEST_URL) as con:
        con.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        con.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(schema)))
        for path in sorted(MIGRATIONS.glob("0*.sql")):
            if int(path.name[:3]) > 73:
                break
            con.execute(path.read_text())
        _seed_legacy(lambda statement: con.execute(statement))
        con.execute((MIGRATIONS / "074_task_autonomy.sql").read_text())
        for name in ("075_workflows.sql", "076_workflow_evidence.sql",
                     "077_workflow_workers.sql"):
            con.execute((MIGRATIONS / name).read_text())
        _seed_accepted_evidence(lambda statement: con.execute(statement))
        con.execute((MIGRATIONS / "078_workflow_evidence_supplier.sql").read_text())
        con.execute((MIGRATIONS / "079_workflow_import_evidence.sql").read_text())
        _assert_upgrade(lambda statement: con.execute(statement).fetchall())
        con.rollback()
