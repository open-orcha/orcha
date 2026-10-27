"""Evidence stays exact across checkpoints, terminal paths, cleanup and rollback."""

from pathlib import Path
from datetime import timedelta
import json
from uuid import uuid4

import pytest
import pytest_asyncio
from fastapi import HTTPException

from portal_backend import worker_run_support
from portal_backend.database import db_cursor
from portal_backend import workflow_evidence_service as evidence
from portal_backend import sql
from portal_backend.workflow_service import result_digest
from portal_backend.workflow_worker_stops import confirm_stopped, release_lost, stop_execution
from portal_backend.workflow_worker_launch import continue_turn, require_runner


@pytest_asyncio.fixture
async def attempt(make_agent, make_task, db, monkeypatch, tmp_path):
    monkeypatch.setenv("ORCHA_ATTACHMENTS_DIR", str(tmp_path / "attachments"))
    # attachments_dir is a function, so confine tests even when a host config exists.
    monkeypatch.setattr(evidence.store, "attachments_dir", lambda: tmp_path / "attachments")
    owner = await make_agent("Evidence owner", kind="human")
    worker = await make_agent("Evidence worker", kind="ai")
    task = await make_task("Evidence result", "Review the exact saved changes",
                           assignee_alias="Evidence worker")
    tid, aid = task["id"], worker["agent_id"]
    cid = db.execute("SELECT container_id FROM tasks WHERE id=%s", (tid,))[0]["container_id"]
    wid, eid, rid = (str(uuid4()) for _ in range(3))
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO container_task_graph_guard(container_id) VALUES (%s)", (cid,))
        cur.execute("""INSERT INTO workflows(id,container_id,owner_human_id,created_by_human_id,
                       title,goal,launch_enabled) VALUES (%s,%s,%s,%s,'Evidence workflow','Exact evidence',true)""",
                    (wid, cid, owner["agent_id"], owner["agent_id"]))
        cur.execute("UPDATE tasks SET workflow_id=%s,status='in_progress',preparation_state='prepared' WHERE id=%s",
                    (wid, tid))
        cur.execute("""INSERT INTO worker_runs(run_id,agent_id,task_id,wake_kind,status,output,diff)
                       VALUES (%s,%s,%s,'ephemeral','running','saved output','+change')""", (rid, aid, tid))
        cur.execute("INSERT INTO worker_run_tasks(run_id,task_id) VALUES (%s,%s) ON CONFLICT DO NOTHING", (rid, tid))
        cur.execute("""INSERT INTO workflow_executions
                       (id,workflow_id,task_id,generation,work_revision,claimant_id,run_id,source_kind,exclusive,state)
                       VALUES (%s,%s,%s,1,1,%s,%s,'worker',true,'running')""", (eid, wid, tid, aid, rid))
    return {"task": tid, "worker": aid, "owner": owner["agent_id"], "workflow": wid,
            "execution": eid, "run": rid}


def submit(attempt, *, sequence=1, result="Finished against the requirements", source_revision="source-commit"):
    with db_cursor() as (_, cur):
        return evidence.capture_workflow_submission(
            cur, attempt["run"], generation=1, work_revision=1, source_sequence=sequence,
            result=result, source_revision=source_revision, captured_by=attempt["worker"],
        )


def finish(attempt, *, cause="finish", updates=None):
    with db_cursor() as (_, cur):
        evidence.terminalize_workflow_run_with_evidence(
            cur, attempt["run"], "exited", cause=cause, updates=updates,
        )
        cur.execute("SELECT current_evidence_set_id FROM workflow_executions WHERE id=%s", (attempt["execution"],))
        return evidence.evidence_reference(cur, cur.fetchone()["current_evidence_set_id"])


def validate(attempt, ref):
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (attempt["task"],))
        return evidence.validate_workflow_evidence(cur, cur.fetchone(), ref)


@pytest.mark.asyncio
async def test_pending_result_is_not_accepted_and_terminal_snapshot_is_exact(attempt, db):
    pending = submit(attempt)
    assert pending["state"] == "pending"
    with pytest.raises(HTTPException) as error:
        validate(attempt, pending)
    assert error.value.detail["code"] == "evidence_not_saved"
    saved = finish(attempt, updates={"diff": "final changes", "output": "final output"})
    assert saved["evidence_set_id"] == pending["evidence_set_id"]
    assert saved["state"] == "saved"
    assert {item["kind"] for item in saved["items"]} == {"result_summary", "file_changes", "log_excerpt"}
    assert all(item["captured_by"] == attempt["worker"] for item in saved["items"])
    assert all(item["captured_by_alias"] == "Evidence worker" for item in saved["items"])
    assert all(item["captured_by_kind"] == "ai" for item in saved["items"])
    assert validate(attempt, saved)["items"] == saved["items"]
    run = db.execute("SELECT ended_at FROM worker_runs WHERE run_id=%s", (attempt["run"],))[0]
    turn = db.execute("SELECT * FROM workflow_executions WHERE id=%s", (attempt["execution"],))[0]
    assert run["ended_at"] and turn["generation_revoked_at"]
    assert turn["state"] == "running" and turn["worker_stopped_at"] is None


@pytest.mark.asyncio
async def test_checkpoint_retry_and_final_snapshot_never_rebind_old_set(attempt, db):
    first = submit(attempt)
    assert submit(attempt)["evidence_set_id"] == first["evidence_set_id"]
    second = submit(attempt, sequence=2, result="A corrected result")
    final = finish(attempt)
    assert final["evidence_set_id"] == second["evidence_set_id"] != first["evidence_set_id"]
    with db_cursor() as (_, cur):
        old = evidence.evidence_reference(cur, first["evidence_set_id"])
    assert old["state"] == "superseded" and len(old["items"]) == 1
    assert old["items"] == first["items"]
    with pytest.raises(HTTPException) as error:
        validate(attempt, old)
    assert error.value.detail["code"] == "evidence_version_stale"
    assert len(db.execute("SELECT * FROM workflow_evidence_sets")) == 2
    assert finish(attempt, cause="orphan_lease", updates={"diff": "late replacement"}) == final


@pytest.mark.asyncio
async def test_same_receipt_changed_result_is_refused(attempt):
    submit(attempt)
    with pytest.raises(HTTPException) as error:
        submit(attempt, result="Changed result")
    assert error.value.detail["code"] == "evidence_receipt_conflict"


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["hash", "version", "item", "missing", "corrupt", "work_revision"])
async def test_acceptance_revalidates_exact_references_and_bytes(attempt, db, change):
    submit(attempt)
    saved = finish(attempt)
    target = saved["items"][0]
    if change == "hash":
        target["sha256"] = "0" * 64
    elif change == "version":
        target["deliverable_version"] += 1
    elif change == "item":
        target["item_id"] = str(uuid4())
    elif change == "work_revision":
        db.execute("UPDATE tasks SET work_revision=2 WHERE id=%s", (attempt["task"],))
    else:
        version = db.execute("SELECT stored_name FROM task_deliverable_versions WHERE deliverable_id=%s AND version=%s",
                             (target["deliverable_id"], target["deliverable_version"]))[0]
        path = evidence.store.resolve_version_file(attempt["task"], target["deliverable_id"], version["stored_name"])
        if change == "missing":
            path.unlink()
        else:
            path.write_text("corrupted")
    with pytest.raises(HTTPException) as error:
        validate(attempt, saved)
    assert error.value.detail["code"] == ("evidence_missing" if change in {"missing", "corrupt"}
                                          else "evidence_version_stale")


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["no_diff", "file_error", "cap"])
async def test_capture_failure_is_recorded_before_run_can_be_pruned(attempt, db, monkeypatch, failure):
    submit(attempt)
    if failure == "no_diff":
        db.execute("UPDATE worker_runs SET diff=NULL WHERE run_id=%s", (attempt["run"],))
    elif failure == "cap":
        monkeypatch.setattr(evidence.store, "MAX_DELIVERABLES_PER_TASK", 1)
    else:
        def fail(*args, **kwargs):
            raise evidence.EvidenceStorageError("evidence_publish_failed")
        monkeypatch.setattr(evidence, "publish_evidence", fail)
    saved = finish(attempt)
    assert saved["state"] == "missing" and saved["missing_reason"]
    assert db.execute("SELECT ended_at FROM worker_runs WHERE run_id=%s", (attempt["run"],))[0]["ended_at"]
    with pytest.raises(HTTPException):
        validate(attempt, saved)


@pytest.mark.asyncio
async def test_transaction_failure_rolls_back_ended_at_and_evidence_freeze(attempt, db, monkeypatch):
    initial = submit(attempt)
    def fail_prune(*args):
        raise RuntimeError("database interruption")
    with monkeypatch.context() as patch:
        patch.setattr(evidence, "prune_old_run_detail", fail_prune)
        with pytest.raises(RuntimeError, match="database interruption"):
            finish(attempt)
    assert db.execute("SELECT ended_at FROM worker_runs WHERE run_id=%s", (attempt["run"],))[0]["ended_at"] is None
    state = db.execute("SELECT state FROM workflow_evidence_sets WHERE id=%s", (initial["evidence_set_id"],))[0]
    assert state["state"] == "pending"
    saved = finish(attempt)
    assert saved["state"] == "saved" and len(saved["items"]) == 3
    assert len(db.execute("SELECT * FROM workflow_terminal_receipts")) == 1


@pytest.mark.asyncio
async def test_saved_result_survives_other_tasks_aging_out_diagnostics(attempt, db, monkeypatch):
    submit(attempt)
    saved = finish(attempt)
    monkeypatch.setattr(worker_run_support, "RUN_DETAIL_KEEP_PER_AGENT", 1)
    for _ in range(2):
        db.execute("INSERT INTO worker_runs(run_id,agent_id,wake_kind,status,ended_at) "
                   "VALUES (%s,%s,'ephemeral','exited',now())", (str(uuid4()), attempt["worker"]))
    with db_cursor() as (_, cur):
        worker_run_support.prune_old_run_detail(cur, attempt["worker"])
    row = db.execute("SELECT * FROM worker_runs WHERE run_id=%s", (attempt["run"],))[0]
    assert row["diff"] is None and row["details_pruned_at"]
    assert worker_run_support.run_row(row)["details_state"] == "pruned"
    assert validate(attempt, saved)["items"] == saved["items"]
    assert db.execute("SELECT state FROM workflow_executions WHERE id=%s", (attempt["execution"],))[0]["state"] == "running"


@pytest.mark.asyncio
@pytest.mark.parametrize("cause", ["finish", "lease_release", "orphan_lease", "stranded_run",
                                  "confirmed_stop", "lost_worker_release", "abort_launch"])
async def test_every_terminal_cause_freezes_an_attempt_without_acceptance(attempt, db, cause):
    saved = finish(attempt, cause=cause)
    assert saved["purpose"] == "attempt_record" and saved["state"] == "saved"
    assert all(item["source"] == ("released_attempt" if cause == "lost_worker_release" else "worker")
               for item in saved["items"])
    with pytest.raises(HTTPException):
        validate(attempt, saved)
    assert db.execute("SELECT state FROM workflow_executions WHERE id=%s", (attempt["execution"],))[0]["state"] == "running"


@pytest.mark.asyncio
async def test_cancelled_attempt_retains_result_and_label_without_reviving_task(attempt, db):
    submit(attempt)
    db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (attempt["task"],))
    saved = finish(attempt, cause="workflow_cancel")
    terminal = [item for item in saved["items"] if item["snapshot_phase"] == "terminal"]
    assert all(item["source"] == "cancelled_attempt" for item in terminal)
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (attempt["task"],))[0]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_version_limit_rolls_to_a_new_shard(attempt, db, monkeypatch):
    monkeypatch.setattr(evidence.store, "MAX_VERSIONS_PER_DELIVERABLE", 1)
    first = submit(attempt)
    second = submit(attempt, sequence=2, result="Second snapshot")
    assert first["items"][0]["deliverable_id"] != second["items"][0]["deliverable_id"]
    assert first["items"][0]["deliverable_version"] == second["items"][0]["deliverable_version"] == 1
    assert [row["path"] for row in db.execute("SELECT path FROM task_deliverables ORDER BY path")] == [
        "workflow-evidence/result-summary-submission-001.txt",
        "workflow-evidence/result-summary-submission-002.txt",
    ]


@pytest.mark.asyncio
async def test_oversize_diff_is_explicitly_incomplete_and_names_exact_source(attempt, monkeypatch):
    submit(attempt)
    monkeypatch.setattr(evidence.store, "max_deliverable_bytes", lambda: 512)
    saved = finish(attempt, updates={"diff": "+line\n" * 400})
    item = next(item for item in saved["items"] if item["kind"] == "file_changes")
    assert not item["complete"] and "Incomplete" in item["note"]
    assert saved["source_revision"] == "source-commit" and saved["state"] == "saved"


@pytest.mark.asyncio
async def test_owner_replacement_keeps_missing_set_and_does_not_accept_or_clear_holds(attempt, db):
    submit(attempt)
    original = finish(attempt, updates={"diff": None})
    assert original["state"] == "missing"
    db.execute("UPDATE tasks SET human_hold_by=%s,awaiting_owner_decision='changes_requested' WHERE id=%s",
               (attempt["owner"], attempt["task"]))
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (attempt["task"],))
        task = cur.fetchone()
        cur.execute("SELECT * FROM workflow_executions WHERE id=%s", (attempt["execution"],))
        execution = cur.fetchone()
        replacement = evidence.capture_owner_evidence(
            cur, task, {"narrative": "Reviewed replacement evidence"}, execution,
            captured_by=attempt["owner"],
        )
        old = evidence.evidence_reference(cur, original["evidence_set_id"])
    assert replacement["state"] == "saved" and replacement["evidence_set_id"] != original["evidence_set_id"]
    assert old["items"] == original["items"] and old["state"] == "superseded"
    assert db.execute("SELECT count(*) AS n FROM workflow_task_acceptances")[0]["n"] == 0
    task = db.execute("SELECT status,human_hold_by,awaiting_owner_decision FROM tasks WHERE id=%s", (attempt["task"],))[0]
    assert task["status"] == "in_progress" and str(task["human_hold_by"]) == attempt["owner"]
    assert task["awaiting_owner_decision"] == "changes_requested"


@pytest.mark.asyncio
async def test_evidence_read_contract_pages_exact_versions_and_rejects_wrong_task(attempt, client):
    first = submit(attempt)
    second = submit(attempt, sequence=2, result="Current result")
    finish(attempt)
    url = f"/api/workflows/{attempt['workflow']}/tasks/{attempt['task']}/evidence"
    response = await client.get(url + "?limit=1")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["current_evidence_set_id"] == second["evidence_set_id"]
    assert len(data["sets"]) == 1 and data["next_before_revision"] == 2
    older = await client.get(url + "?before_revision=2")
    assert older.json()["sets"][0]["evidence_set_id"] == first["evidence_set_id"]
    missing = await client.get(f"/api/workflows/{attempt['workflow']}/tasks/{uuid4()}/evidence")
    assert missing.status_code == 404


def test_terminal_writers_have_one_shared_evidence_boundary():
    root = Path(__file__).parents[1] / "orcha-cli/orcha_cli/templates/portal/portal_backend"
    paths = ["worker_run_finish_routes.py", "wake_acknowledgement_routes.py",
             "orphan_lease_routes.py", "stranded_runs.py"]
    for name in paths:
        source = (root / name).read_text()
        assert "terminalize_worker_run(" in source
        assert "ended_at=" not in source and "ended_at =" not in source


@pytest.mark.asyncio
# Silence-based reapers never end a run a live turn owns (see
# test_a_live_workflow_turn_is_never_reaped_as_stranded_while_its_worker_works).
@pytest.mark.parametrize("path", ["finish", "lease_release"])
async def test_real_terminal_routes_save_evidence_before_diagnostics_age_out(attempt, client, db, path):
    submitted = submit(attempt)
    if path == "finish":
        response = await client.post(f"/api/runs/{attempt['run']}/finish",
                                     json={"status": "exited", "output": "final", "diff": "+final"})
    else:
        response = await client.post(f"/api/agents/{attempt['worker']}/wake-ack",
                                     json={"release_lease": True, "lane": "work", "kind": "ephemeral"})
    assert response.status_code == 200, response.text
    with db_cursor() as (_, cur):
        saved = evidence.evidence_reference(cur, submitted["evidence_set_id"])
    assert saved["state"] == "saved"
    receipt = db.execute("SELECT cause FROM workflow_terminal_receipts WHERE run_id=%s", (attempt["run"],))
    assert receipt == [{"cause": path}]
    turn = db.execute("SELECT state,worker_stopped_at FROM workflow_executions WHERE id=%s", (attempt["execution"],))[0]
    assert turn == {"state": "running", "worker_stopped_at": None}
    # Exercise the real per-agent retention window on unrelated work, while this
    # task still holds its review/shutdown turn.
    for _ in range(worker_run_support.RUN_DETAIL_KEEP_PER_AGENT + 1):
        newer = str(uuid4())
        with db_cursor() as (_, cur):
            cur.execute("INSERT INTO worker_runs(run_id,agent_id,wake_kind,status) "
                        "VALUES (%s,%s,'ephemeral','running')", (newer, attempt["worker"]))
            evidence.terminalize_workflow_run_with_evidence(cur, newer, "exited", cause="finish")
    original = db.execute("SELECT details_pruned_at,diff FROM worker_runs WHERE run_id=%s", (attempt["run"],))[0]
    assert original["details_pruned_at"] and original["diff"] is None
    assert validate(attempt, saved)["items"] == saved["items"]
    assert db.execute("SELECT state,worker_stopped_at FROM workflow_executions WHERE id=%s",
                      (attempt["execution"],))[0] == turn


@pytest.mark.asyncio
@pytest.mark.parametrize("lost", [False, True])
async def test_real_stop_adapter_keeps_saved_evidence_and_truthful_liveness(attempt, db, lost):
    submitted = submit(attempt)
    now = sql.utcnow()
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM workflow_executions WHERE id=%s", (attempt["execution"],))
        stop_execution(cur, cur.fetchone(), origin="task_stop", actor_id=attempt["owner"],
                       reason="Stop this attempt", operation_key="stop", now=now)
        cur.execute("SELECT * FROM workflow_executions WHERE id=%s", (attempt["execution"],))
        execution = cur.fetchone()
        if lost:
            release_lost(cur, execution, actor_id=attempt["owner"], reason="Unreachable worker",
                         terminalize=evidence.terminalize_workflow_run_with_evidence,
                         now=now + timedelta(minutes=30))
        else:
            confirm_stopped(cur, execution, run_id=attempt["run"], generation=1,
                            terminalize=evidence.terminalize_workflow_run_with_evidence, now=now)
        saved = evidence.evidence_reference(cur, submitted["evidence_set_id"])
    assert saved["state"] == "saved"
    execution = db.execute("SELECT * FROM workflow_executions WHERE id=%s", (attempt["execution"],))[0]
    assert execution["state"] == ("released_lost" if lost else "released")
    assert bool(execution["worker_stopped_at"]) is not lost
    task = db.execute("SELECT status,awaiting_owner_decision FROM tasks WHERE id=%s", (attempt["task"],))[0]
    assert task == {"status": "not_ready", "awaiting_owner_decision": "stopped_by_owner"}
    assert db.execute("SELECT count(*) AS n FROM workflow_task_acceptances")[0]["n"] == 0
    assert all(i["storage_state"] == "readable" for i in saved["items"])


@pytest.mark.asyncio
async def test_real_continuation_preserves_old_set_and_never_rebinds_its_run(attempt, db):
    submitted = submit(attempt)
    now = sql.utcnow()
    with db_cursor() as (_, cur):
        runner = require_runner(cur, attempt["worker"])
        cur.execute("SELECT * FROM workflow_executions WHERE id=%s", (attempt["execution"],))
        confirm_stopped(cur, cur.fetchone(), run_id=attempt["run"], generation=1,
                        terminalize=evidence.terminalize_workflow_run_with_evidence, now=now)
        before = evidence.evidence_reference(cur, submitted["evidence_set_id"])
        cur.execute("SELECT * FROM workflow_executions WHERE id=%s", (attempt["execution"],))
        continued = continue_turn(cur, cur.fetchone(), runner, operation_key="continue",
                                  payload={"previous_run_id": attempt["run"]}, now=now)
        after = evidence.evidence_reference(cur, submitted["evidence_set_id"])
    assert continued["generation"] == 2 and continued["run_id"] != attempt["run"]
    assert before == after
    assert after["run_id"] == attempt["run"] and after["generation"] == 1
    with pytest.raises(HTTPException) as rejected:
        validate(attempt, after)
    assert rejected.value.detail["code"] == "evidence_version_stale"
    assert db.execute("SELECT count(*) AS n FROM workflow_executions")[0]["n"] == 1


@pytest.mark.asyncio
async def test_import_captures_exact_reviewed_result_and_refuses_changed_digest(attempt, db):
    result = {"summary": "Previously completed work", "url": "https://example.org/review"}
    db.execute("UPDATE tasks SET status='completed',result=%s WHERE id=%s",
               (sql.json_param(result), attempt["task"]))
    db.execute("UPDATE workflow_executions SET source_kind='import_review',run_id=NULL WHERE id=%s",
               (attempt["execution"],))
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (attempt["task"],))
        task = cur.fetchone()
        cur.execute("SELECT * FROM workflow_executions WHERE id=%s", (attempt["execution"],))
        execution = cur.fetchone()
        with pytest.raises(HTTPException) as rejected:
            evidence.capture_import_evidence(cur, task, {"narrative": "Reviewed"}, execution,
                captured_by=attempt["owner"], reviewed_result_digest="0" * 64)
        assert rejected.value.detail["code"] == "import_result_changed"
        reference = evidence.capture_import_evidence(cur, task, {"narrative": "Reviewed"}, execution,
            captured_by=attempt["owner"], reviewed_result_digest=result_digest(task["result"]))
        evidence.validate_workflow_evidence(cur, task, reference)
    assert reference["state"] == "saved" and reference["run_id"] is None
    item = reference["items"][0]
    assert (item["kind"], item["source"]) == ("import_result", "import")
    version = db.execute("SELECT stored_name FROM task_deliverable_versions WHERE deliverable_id=%s AND version=%s",
                         (item["deliverable_id"], item["deliverable_version"]))[0]
    saved = evidence.store.resolve_version_file(attempt["task"], item["deliverable_id"], version["stored_name"])
    assert json.loads(saved.read_text())["reviewed_result"] == task["result"]
    assert db.execute("SELECT count(*) AS n FROM workflow_evidence_sets")[0]["n"] == 1
    assert db.execute("SELECT count(*) AS n FROM workflow_task_acceptances")[0]["n"] == 0
