"""Durable review evidence and the single worker terminalization boundary.

Callers own the transaction; nothing here commits or releases workflow capacity.
Graph -> workflow -> task -> execution -> run is the lock order. File publication
precedes metadata insertion. A database rollback leaves only unreferenced files,
never a prune-eligible run with an unfinished evidence snapshot.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from uuid import uuid4

from fastapi import HTTPException

from portal_backend import deliverables_storage as store, sql
from portal_backend.workflow_evidence_storage import (
    EvidenceStorageError, evidence_file_state, publish_evidence, stage_evidence,
)
from portal_backend.worker_run_support import prune_old_run_detail, revoke_tokens_for_runs

EXCERPT_BYTES = 64 * 1024
_TERMINAL = frozenset({"exited", "killed", "rate_limited", "failed", "orphaned"})
_RUN_UPDATES = frozenset({
    "exit_code", "output", "diff", "kill_reason", "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens", "total_cost_usd",
})


def _conflict(code: str) -> None:
    raise HTTPException(409, {"code": code, "message": code.replace("_", " ")})


def _digest(value) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _lock_context(cur, run_id):
    """Resolve without locks, then reacquire current facts in the global order."""
    cur.execute("SELECT * FROM worker_runs WHERE run_id=%s", (run_id,))
    initial = cur.fetchone()
    if not initial:
        raise HTTPException(404, "Worker run not found")
    task = execution = None
    if initial["task_id"]:
        cur.execute("SELECT * FROM tasks WHERE id=%s", (initial["task_id"],))
        task = cur.fetchone()
    if task and task.get("workflow_id"):
        cur.execute("SELECT container_id FROM container_task_graph_guard WHERE container_id=%s"
                    + sql.for_update(), (task["container_id"],))
        if not cur.fetchone():
            _conflict("workflow_graph_guard_missing")
        cur.execute("SELECT id FROM workflows WHERE id=%s" + sql.for_update(),
                    (task["workflow_id"],))
        cur.fetchone()
        cur.execute("SELECT * FROM tasks WHERE id=%s" + sql.for_update(), (task["id"],))
        task = cur.fetchone()
        cur.execute("SELECT * FROM workflow_executions WHERE task_id=%s AND run_id=%s "
                    "ORDER BY id" + sql.for_update(), (task["id"], run_id))
        matches = cur.fetchall()
        if len(matches) > 1:
            _conflict("ambiguous_workflow_run")
        execution = matches[0] if matches else None
    cur.execute("SELECT * FROM worker_runs WHERE run_id=%s" + sql.for_update(), (run_id,))
    run = cur.fetchone()
    if str(run["task_id"]) != str(initial["task_id"]):
        _conflict("run_task_changed")
    if task and task.get("workflow_id") and not execution and not run["ended_at"]:
        _conflict("workflow_execution_missing")
    return run, task, execution


def _save_item(cur, task, evidence_set, *, kind, source, phase, data, actor_id,
               complete=True, note=None):
    """Allocate bounded, numbered shards under the already-held task lock."""
    staged = stage_evidence(data)
    stem = f"workflow-evidence/{kind.replace('_', '-')}-{phase}"
    deliverable = None
    for shard in range(1, store.MAX_DELIVERABLES_PER_TASK + 1):
        path = f"{stem}-{shard:03}.txt"
        cur.execute("SELECT * FROM task_deliverables WHERE task_id=%s AND path=%s"
                    + sql.for_update(), (task["id"], path))
        candidate = cur.fetchone()
        if candidate and candidate["latest_version"] >= store.MAX_VERSIONS_PER_DELIVERABLE:
            continue
        deliverable = candidate
        break
    else:
        raise EvidenceStorageError("evidence_deliverable_limit")
    if deliverable:
        did, version = str(deliverable["id"]), deliverable["latest_version"] + 1
    else:
        cur.execute("SELECT count(*) AS n FROM task_deliverables WHERE task_id=%s", (task["id"],))
        if cur.fetchone()["n"] >= store.MAX_DELIVERABLES_PER_TASK:
            raise EvidenceStorageError("evidence_deliverable_limit")
        did, version = str(uuid4()), 1
    stored_name = publish_evidence(staged, task_id=str(task["id"]), deliverable_id=did,
                                   version=version, logical_path=path)
    if not deliverable:
        cur.execute("""INSERT INTO task_deliverables
                       (id,container_id,task_id,path,kind,latest_version)
                       VALUES (%s,%s,%s,%s,'text',%s)""",
                    (did, task["container_id"], task["id"], path, version))
    cur.execute("""INSERT INTO task_deliverable_versions
                   (id,deliverable_id,version,source,run_id,author_agent_id,stored_name,
                    size_bytes,sha256,content_type,note)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'text/plain; charset=utf-8',%s)""",
                (str(uuid4()), did, version,
                 "run_output" if evidence_set["run_id"] else "attached",
                 evidence_set["run_id"], actor_id, stored_name, staged.size_bytes,
                 staged.sha256, note))
    cur.execute("UPDATE task_deliverables SET latest_version=%s,updated_at=now() WHERE id=%s",
                (version, did))
    cur.execute("SELECT alias,kind FROM agents WHERE id=%s", (actor_id,))
    supplier = cur.fetchone()
    if not supplier:
        raise EvidenceStorageError("evidence_supplier_unavailable")
    cur.execute("""INSERT INTO workflow_evidence
                   (id,evidence_set_id,task_id,kind,source,snapshot_phase,deliverable_id,
                    deliverable_version,sha256,complete,note,captured_by,
                    captured_by_alias,captured_by_kind)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (str(uuid4()), evidence_set["id"], task["id"], kind, source, phase, did, version,
                 staged.sha256, complete, note, actor_id, supplier["alias"], supplier["kind"]))


def _new_set(cur, task, execution, *, run_id, sequence, purpose, capture,
             source_revision, required_kinds):
    cur.execute("""SELECT * FROM workflow_evidence_sets
                   WHERE workflow_execution_id=%s AND generation=%s AND source_sequence=%s""",
                (execution["id"], execution["generation"], sequence))
    previous_receipt = cur.fetchone()
    if previous_receipt:
        if previous_receipt["capture_sha256"] != _digest(capture):
            _conflict("evidence_receipt_conflict")
        return previous_receipt, False
    previous = execution.get("current_evidence_set_id")
    cur.execute("SELECT COALESCE(max(result_revision),0)+1 AS revision "
                "FROM workflow_evidence_sets WHERE task_id=%s", (task["id"],))
    revision = cur.fetchone()["revision"]
    sid = str(uuid4())
    cur.execute("""INSERT INTO workflow_evidence_sets
                   (id,workflow_execution_id,workflow_id,task_id,run_id,generation,
                    result_revision,work_revision,source_revision,source_sequence,
                    capture_sha256,supersedes_set_id,purpose,state,required_kinds)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending',%s)
                   RETURNING *""",
                (sid, execution["id"], task["workflow_id"], task["id"], run_id,
                 execution["generation"], revision, execution["work_revision"],
                 source_revision, sequence, _digest(capture), previous, purpose,
                 sql.json_param(required_kinds)))
    evidence_set = cur.fetchone()
    if previous:
        # Accepted historical sets stay intact. A pointer changing never rebinds them.
        cur.execute("""UPDATE workflow_evidence_sets SET state='superseded'
                       WHERE id=%s AND NOT EXISTS
                       (SELECT 1 FROM workflow_task_acceptances WHERE evidence_set_id=%s)""",
                    (previous, previous))
    cur.execute("UPDATE workflow_executions SET current_evidence_set_id=%s,evidence_state='pending' "
                "WHERE id=%s", (sid, execution["id"]))
    return evidence_set, True


def capture_workflow_submission(cur, run_id, *, generation, work_revision,
                                source_sequence, result, source_revision,
                                captured_by, requires_file_changes=True):
    """Capture a current authenticated worker's result; authority is checked upstream.

    The generation, sequence and content bind a retry to the same set. Terminal
    capture completes that set later. This never approves a plan or accepts work.
    """
    run, task, execution = _lock_context(cur, run_id)
    if (not execution or run["ended_at"] or execution.get("generation_revoked_at")
            or execution["generation"] != generation
            or execution["work_revision"] != work_revision
            or task["work_revision"] != work_revision
            or str(execution["claimant_id"]) != str(captured_by)
            or task["status"] not in {"in_progress", "needs_verification"}):
        _conflict("stale_generation")
    if type(source_sequence) is not int or source_sequence < 1 or not result.strip():
        _conflict("evidence_submission_required")
    cur.execute("SELECT COALESCE(max(source_sequence),0) AS sequence FROM workflow_evidence_sets "
                "WHERE workflow_execution_id=%s AND generation=%s",
                (execution["id"], generation))
    if source_sequence < cur.fetchone()["sequence"]:
        _conflict("evidence_version_stale")
    capture = {"result": result, "source_revision": source_revision,
               "requires_file_changes": requires_file_changes, "work_revision": work_revision}
    required = ["result_summary"] + (["file_changes"] if requires_file_changes else [])
    evidence_set, created = _new_set(
        cur, task, execution, run_id=run_id, sequence=source_sequence,
        purpose="acceptance", capture=capture, source_revision=source_revision,
        required_kinds=required,
    )
    if created:
        try:
            _save_item(cur, task, evidence_set, kind="result_summary", source="worker",
                       phase="submission", data=result.encode("utf-8"), actor_id=captured_by)
        except EvidenceStorageError as exc:
            cur.execute("UPDATE workflow_evidence_sets SET missing_reason=%s WHERE id=%s",
                        (str(exc), evidence_set["id"]))
    return evidence_reference(cur, evidence_set["id"])


def evidence_reference(cur, set_id):
    cur.execute("SELECT * FROM workflow_evidence_sets WHERE id=%s", (set_id,))
    evidence_set = cur.fetchone()
    if not evidence_set:
        _conflict("evidence_version_stale")
    cur.execute("""SELECT e.*,v.stored_name
                   FROM workflow_evidence e
                   JOIN task_deliverable_versions v ON v.deliverable_id=e.deliverable_id
                     AND v.version=e.deliverable_version
                   WHERE e.evidence_set_id=%s ORDER BY e.kind,e.snapshot_phase,e.id""", (set_id,))
    items = []
    for row in cur.fetchall():
        items.append({
            "item_id": str(row["id"]), "kind": row["kind"], "source": row["source"],
            "snapshot_phase": row["snapshot_phase"],
            "deliverable_id": str(row["deliverable_id"]),
            "deliverable_version": row["deliverable_version"], "sha256": row["sha256"],
            "complete": bool(row["complete"]), "note": row["note"],
            "captured_by": str(row["captured_by"]) if row["captured_by"] else None,
            "captured_by_alias": row["captured_by_alias"],
            "captured_by_kind": row["captured_by_kind"],
            "storage_state": evidence_file_state(
                task_id=str(evidence_set["task_id"]), deliverable_id=str(row["deliverable_id"]),
                stored_name=row["stored_name"], sha256=row["sha256"]),
        })
    return {"evidence_set_id": str(set_id), "task_id": str(evidence_set["task_id"]),
            "workflow_id": str(evidence_set["workflow_id"]),
            "workflow_execution_id": str(evidence_set["workflow_execution_id"]),
            "run_id": str(evidence_set["run_id"]) if evidence_set["run_id"] else None,
            "work_revision": evidence_set["work_revision"],
            "result_revision": evidence_set["result_revision"],
            "source_sequence": evidence_set["source_sequence"],
            "generation": evidence_set["generation"], "state": evidence_set["state"],
            "purpose": evidence_set["purpose"], "missing_reason": evidence_set["missing_reason"],
            "terminal_cause": evidence_set["terminal_cause"],
            "created_at": evidence_set["created_at"], "frozen_at": evidence_set["frozen_at"],
            "source_revision": evidence_set["source_revision"], "items": items}


def _capture_human_evidence(cur, task, basis, execution, *, captured_by, source):
    """Store an already validated human submission without changing its task."""
    cur.execute("SELECT COALESCE(max(source_sequence),0)+1 AS sequence FROM workflow_evidence_sets "
                "WHERE workflow_execution_id=%s AND generation=%s",
                (execution["id"], execution["generation"]))
    sequence = cur.fetchone()["sequence"]
    kinds = {
        "owner": "owner_result",
        "outside": "outside_result",
        "import": "import_result",
    }
    try:
        kind = kinds[source]
    except KeyError as exc:
        raise ValueError("Human evidence must identify its source") from exc
    evidence_set, _ = _new_set(
        cur, task, execution, run_id=None, sequence=sequence, purpose="acceptance",
        capture={"basis": basis, "captured_by": str(captured_by), "source": source},
        source_revision=None, required_kinds=[kind],
    )
    reason = None
    try:
        _save_item(cur, task, evidence_set, kind=kind, source=source, phase="submission",
                   data=json.dumps(basis, ensure_ascii=False, sort_keys=True).encode("utf-8"),
                   actor_id=captured_by)
    except EvidenceStorageError as exc:
        reason = str(exc)
    state = "missing" if reason else "saved"
    cur.execute("UPDATE workflow_evidence_sets SET state=%s,missing_reason=%s,frozen_at=now() WHERE id=%s",
                (state, reason, evidence_set["id"]))
    cur.execute("UPDATE workflow_executions SET evidence_state=%s WHERE id=%s "
                "AND current_evidence_set_id=%s", (state, execution["id"], evidence_set["id"]))
    return evidence_reference(cur, evidence_set["id"])


def capture_owner_evidence(cur, task, basis, execution, *, captured_by, source="owner"):
    """Save a human-supplied result in the caller's locked/authorized operation.

    The workflow service validates supporting references and distinguishes pending
    outside results from replacements. Neither this helper nor its result implies
    acceptance or releases a worker turn. The operation receipt handles retries.
    """
    if source not in {"owner", "outside"}:
        raise ValueError("Human evidence must identify its source")
    if (task["status"] in {"completed", "cancelled"} or task.get("withdrawn_at")
            or str(execution["task_id"]) != str(task["id"])
            or execution["work_revision"] != task["work_revision"]
            or not str(basis.get("narrative") or "").strip()):
        _conflict("evidence_version_stale")
    if execution.get("run_id"):
        cur.execute("SELECT ended_at FROM worker_runs WHERE run_id=%s", (execution["run_id"],))
        run = cur.fetchone()
        if not run or not run["ended_at"]:
            _conflict("worker_still_running")
    return _capture_human_evidence(cur, task, basis, execution,
                                   captured_by=captured_by, source=source)


def capture_import_evidence(cur, task, basis, execution, *, captured_by,
                            reviewed_result_digest):
    """Freeze the exact pre-workflow result the human reviewed during import.

    Import's locked service operation authenticates the human, validates the
    supporting references and records acceptance separately. A completed status
    alone never manufactures an evidence set or an approval.
    """
    from portal_backend.workflow_service import result_digest

    if (task["status"] != "completed" or task.get("result") is None
            or execution["source_kind"] != "import_review" or execution.get("run_id")
            or str(execution["task_id"]) != str(task["id"])
            or str(execution["workflow_id"]) != str(task["workflow_id"])
            or execution["work_revision"] != task["work_revision"]
            or not str(basis.get("narrative") or "").strip()):
        _conflict("evidence_version_stale")
    if result_digest(task["result"]) != reviewed_result_digest:
        _conflict("import_result_changed")
    snapshot = {"review": basis, "reviewed_result": task["result"],
                "reviewed_result_digest": reviewed_result_digest}
    return _capture_human_evidence(cur, task, snapshot, execution,
                                   captured_by=captured_by, source="import")


def validate_workflow_evidence(cur, task, reference):
    """Return exact evidence for acceptance, refusing stale or unreadable versions."""
    sid = reference.get("evidence_set_id")
    current = evidence_reference(cur, sid)
    cur.execute("""SELECT e.current_evidence_set_id FROM workflow_executions e
                   JOIN workflow_evidence_sets s ON s.workflow_execution_id=e.id
                   WHERE s.id=%s AND e.task_id=%s AND e.workflow_id=%s""",
                (sid, task["id"], task["workflow_id"]))
    execution = cur.fetchone()
    if (not execution or str(execution["current_evidence_set_id"]) != str(sid)
            or current["work_revision"] != task["work_revision"]
            or current["purpose"] != "acceptance"):
        _conflict("evidence_version_stale")
    if current["state"] != "saved":
        _conflict("evidence_not_saved")
    if not current["items"] or any(item["storage_state"] != "readable" for item in current["items"]):
        _conflict("evidence_missing")
    keys = ("item_id", "deliverable_id", "deliverable_version", "sha256")
    exact = [{key: item[key] for key in keys} for item in current["items"]]
    expected = [{key: item.get(key) for key in keys} for item in reference.get("items", [])]
    if sorted(exact, key=lambda i: i["item_id"]) != sorted(expected, key=lambda i: str(i["item_id"])):
        _conflict("evidence_version_stale")
    return current


def _diff_snapshot(diff, source_revision):
    data = diff.encode("utf-8")
    cap = store.max_deliverable_bytes()
    if len(data) <= cap:
        return data, True, None
    if not source_revision:
        raise EvidenceStorageError("oversize_diff_source_revision_required")
    added = sum(line.startswith("+") and not line.startswith("+++") for line in diff.splitlines())
    removed = sum(line.startswith("-") and not line.startswith("---") for line in diff.splitlines())
    note = "Incomplete file-change snapshot; inspect the recorded source revision for the full changes."
    header = (f"INCOMPLETE SNAPSHOT\nSource revision: {source_revision}\n"
              f"Diff summary: {added} added lines, {removed} removed lines.\n{note}\n\n").encode()
    if len(header) >= cap:
        raise EvidenceStorageError("evidence_file_too_large")
    bounded = data[:cap - len(header)].decode("utf-8", errors="ignore").encode("utf-8")
    return header + bounded, False, note


def _freeze_evidence(cur, run, task, execution, cause):
    sid = execution.get("current_evidence_set_id")
    cur.execute("SELECT * FROM workflow_evidence_sets WHERE id=%s" + sql.for_update(), (sid,))
    evidence_set = cur.fetchone()
    # A previous generation's set is never the target of this run's final snapshot.
    if evidence_set and (str(evidence_set["run_id"]) != str(run["run_id"])
                         or evidence_set["generation"] != execution["generation"]):
        evidence_set = None
    if not evidence_set:
        evidence_set, _ = _new_set(
            cur, task, execution, run_id=run["run_id"], sequence=1,
            purpose="attempt_record", capture={"cause": cause}, source_revision=None,
            required_kinds=["result_summary"],
        )
    if evidence_set["state"] != "pending":
        return evidence_set
    reason = evidence_set["missing_reason"]
    source = ("cancelled_attempt" if task["status"] == "cancelled" or "cancel" in cause
              else "released_attempt" if cause == "lost_worker_release" else "worker")
    try:
        if evidence_set["purpose"] == "attempt_record":
            _save_item(cur, task, evidence_set, kind="result_summary", source=source,
                       phase="terminal", data=f"Worker attempt ended: {cause}.\n".encode(),
                       actor_id=run["agent_id"])
        if run.get("diff") is not None:
            data, complete, note = _diff_snapshot(run["diff"], evidence_set["source_revision"])
            _save_item(cur, task, evidence_set, kind="file_changes", source=source,
                       phase="terminal", data=data, actor_id=run["agent_id"],
                       complete=complete, note=note)
        if run.get("output") is not None:
            excerpt = run["output"].encode("utf-8")[-EXCERPT_BYTES:]
            _save_item(cur, task, evidence_set, kind="log_excerpt", source=source,
                       phase="terminal", data=excerpt.decode("utf-8", errors="ignore").encode(),
                       actor_id=run["agent_id"], complete=False,
                       note="Final output excerpt; this is not the complete worker log.")
    except EvidenceStorageError as exc:
        reason = reason or str(exc)
    cur.execute("SELECT kind FROM workflow_evidence WHERE evidence_set_id=%s", (evidence_set["id"],))
    present = {row["kind"] for row in cur.fetchall()}
    required = evidence_set["required_kinds"]
    if isinstance(required, str):
        required = json.loads(required)
    if set(required) - present:
        reason = reason or "required_evidence_unavailable"
    ref = evidence_reference(cur, evidence_set["id"])
    if any(item["storage_state"] != "readable" for item in ref["items"]):
        reason = reason or "evidence_missing"
    state = "missing" if reason else "saved"
    cur.execute("""UPDATE workflow_evidence_sets SET state=%s,missing_reason=%s,
                   terminal_cause=%s,frozen_at=now() WHERE id=%s RETURNING *""",
                (state, reason, cause, evidence_set["id"]))
    evidence_set = cur.fetchone()
    cur.execute("UPDATE workflow_executions SET evidence_state=%s WHERE id=%s "
                "AND current_evidence_set_id=%s", (state, execution["id"], evidence_set["id"]))
    return evidence_set


@dataclass(frozen=True)
class RunTerminalization:
    """The before/after facts from the shared lock, owned by this transaction."""

    before: dict
    run: dict
    changed: bool
    workflow_linked: bool


def terminalize_workflow_run_with_evidence(cur, run_id, terminal_status, *, cause, updates=None):
    """Keep the row-returning contract used by workflow stop and release callers."""
    return terminalize_worker_run(
        cur, run_id, terminal_status, cause=cause, updates=updates,
    ).run


def terminalize_worker_run(cur, run_id, terminal_status, *, cause, updates=None,
                           expected_status=None):
    """Save or mark evidence missing BEFORE ended_at and pruning, atomically in SQL.

    A diagnostic timeout fences an old credential; it is never proof the process
    stopped. The caller alone decides whether confirmed shutdown releases capacity.
    Non-workflow runs retain their existing finish/update behavior. Cleanup callers
    supply expected_status="running"; a competing finish then makes them a no-op.
    Accounting and audit callers must use the returned locked facts, never a prior
    SELECT. A no-op neither revokes credentials nor prunes diagnostics.
    """
    if terminal_status not in _TERMINAL or not cause:
        raise ValueError("A known terminal status and cause are required")
    updates = dict(updates or {})
    if set(updates) - _RUN_UPDATES:
        raise ValueError("Unsupported worker terminal field")
    run, task, execution = _lock_context(cur, run_id)
    before = dict(run)
    workflow_linked = bool(task and task.get("workflow_id"))
    if expected_status is not None and run["status"] != expected_status:
        return RunTerminalization(before, run, False, workflow_linked)
    if workflow_linked and run["ended_at"]:
        # Exact evidence and its first terminal receipt cannot change on a late retry.
        return RunTerminalization(before, run, False, workflow_linked)
    if updates:
        columns = ",".join(f"{key}=%s" for key in updates)
        cur.execute(f"UPDATE worker_runs SET {columns} WHERE run_id=%s RETURNING *",
                    (*updates.values(), run_id))
        run = cur.fetchone()
    if execution:
        evidence_set = _freeze_evidence(cur, run, task, execution, cause)
        if evidence_set["state"] not in {"saved", "missing"}:
            _conflict("evidence_not_saved")
        cur.execute("UPDATE workflow_executions SET generation_revoked_at=COALESCE(generation_revoked_at,now()) "
                    "WHERE id=%s AND generation=%s", (execution["id"], execution["generation"]))
        cur.execute("""INSERT INTO workflow_terminal_receipts
                       (run_id,generation,cause,evidence_set_id,terminal_status)
                       VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (run_id, execution["generation"], cause, evidence_set["id"], terminal_status))
    cur.execute("UPDATE worker_runs SET status=%s,ended_at=now() WHERE run_id=%s RETURNING *",
                (terminal_status, run_id))
    result = cur.fetchone()
    revoke_tokens_for_runs(cur, [run_id])
    prune_old_run_detail(cur, run["agent_id"])
    return RunTerminalization(before, result, True, workflow_linked)
