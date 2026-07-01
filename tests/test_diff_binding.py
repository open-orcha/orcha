"""Approval–diff binding: /orcha-verify approval is bound to the exact diff reviewed.

GET /api/tasks/{tid}/diff returns the task's captured worker-run diffs plus a
canonical digest; approving a task that HAS a captured diff requires sending that
digest back, and the decision row records it. The approval stops meaning "a human
typed approve" and starts meaning "this human saw exactly this diff".
"""
import pytest


async def _needs_verification_task(client, make_agent, db):
    """Agent + claimed initial task, driven to needs_verification via /done."""
    a = await make_agent("Sam", initial_task={
        "title": "implement thing", "definition_of_done": "thing works", "priority": 50})
    tid = a["initial_task"]["task_id"]
    r = await client.post(f"/api/tasks/{tid}/done",
                          json={"agent_id": a["agent_id"], "result": "done"})
    assert r.status_code == 200, r.text
    return a, tid


def _insert_run(db, agent_id, task_id, diff, started_at_offset="0 seconds"):
    return db.execute(
        """INSERT INTO worker_runs (agent_id, task_id, status, diff, started_at)
           VALUES (%s, %s, 'exited', %s, now() + %s::interval) RETURNING run_id""",
        (agent_id, task_id, diff, started_at_offset))[0]["run_id"]


# ---------- GET /api/tasks/{tid}/diff ----------

async def test_diff_endpoint_returns_runs_and_stable_digest(client, container, make_agent, db):
    a, tid = await _needs_verification_task(client, make_agent, db)
    _insert_run(db, a["agent_id"], tid, "diff --git a/x b/x\n+one")
    _insert_run(db, a["agent_id"], tid, "diff --git a/y b/y\n+two", "5 seconds")
    r = await client.get(f"/api/tasks/{tid}/diff")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["task_id"] == tid
    assert d["diff_digest"].startswith("sha256:")
    assert [run["diff"] for run in d["runs"]] == [
        "diff --git a/x b/x\n+one", "diff --git a/y b/y\n+two"]  # oldest first
    r2 = await client.get(f"/api/tasks/{tid}/diff")
    assert r2.json()["diff_digest"] == d["diff_digest"]  # deterministic


async def test_diff_endpoint_task_without_diff(client, container, make_agent, db):
    _, tid = await _needs_verification_task(client, make_agent, db)
    r = await client.get(f"/api/tasks/{tid}/diff")
    assert r.status_code == 200
    assert r.json() == {"task_id": tid, "diff_digest": None, "runs": []}


async def test_diff_endpoint_ignores_empty_diffs(client, container, make_agent, db):
    a, tid = await _needs_verification_task(client, make_agent, db)
    _insert_run(db, a["agent_id"], tid, "   ")  # whitespace-only capture: not reviewable
    r = await client.get(f"/api/tasks/{tid}/diff")
    assert r.json()["diff_digest"] is None


# ---------- verify approval binding ----------

async def test_approve_requires_digest_when_diff_exists(client, container, make_agent, db):
    a, tid = await _needs_verification_task(client, make_agent, db)
    h = await make_agent("Hussein", kind="human")
    _insert_run(db, a["agent_id"], tid, "+ real change")
    r = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": True, "actor_agent_id": h["agent_id"]})
    assert r.status_code == 400
    assert "diff_digest" in r.json()["detail"]


async def test_approve_with_stale_digest_409s(client, container, make_agent, db):
    a, tid = await _needs_verification_task(client, make_agent, db)
    h = await make_agent("Hussein", kind="human")
    _insert_run(db, a["agent_id"], tid, "+ v1")
    stale = (await client.get(f"/api/tasks/{tid}/diff")).json()["diff_digest"]
    _insert_run(db, a["agent_id"], tid, "+ v2 landed after review", "5 seconds")
    r = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": True, "actor_agent_id": h["agent_id"],
                                "diff_digest": stale})
    assert r.status_code == 409
    assert "stale" in r.json()["detail"].lower()
    # task must remain unverified
    row = db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]
    assert row["status"] == "needs_verification"


async def test_approve_with_matching_digest_completes(client, container, make_agent, db):
    a, tid = await _needs_verification_task(client, make_agent, db)
    h = await make_agent("Hussein", kind="human")
    _insert_run(db, a["agent_id"], tid, "+ the change")
    digest = (await client.get(f"/api/tasks/{tid}/diff")).json()["diff_digest"]
    r = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": True, "actor_agent_id": h["agent_id"],
                                "diff_digest": digest, "feedback": "LGTM"})
    assert r.status_code == 200 and r.json()["status"] == "completed"


async def test_approve_no_diff_task_needs_no_digest(client, container, make_agent, db):
    _, tid = await _needs_verification_task(client, make_agent, db)
    h = await make_agent("Hussein", kind="human")
    r = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": True, "actor_agent_id": h["agent_id"]})
    assert r.status_code == 200 and r.json()["status"] == "completed"


async def test_approve_digest_on_no_diff_task_409s(client, container, make_agent, db):
    """A digest for a task with no captured diff means the reviewer looked at the
    wrong thing — refuse rather than silently ignore."""
    _, tid = await _needs_verification_task(client, make_agent, db)
    h = await make_agent("Hussein", kind="human")
    r = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": True, "actor_agent_id": h["agent_id"],
                                "diff_digest": "sha256:deadbeef"})
    assert r.status_code == 409


async def test_reject_is_lenient_about_digest(client, container, make_agent, db):
    """Rejecting is conservative — it must never be blocked by diff staleness."""
    a, tid = await _needs_verification_task(client, make_agent, db)
    h = await make_agent("Hussein", kind="human")
    _insert_run(db, a["agent_id"], tid, "+ v1")
    r = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": False, "actor_agent_id": h["agent_id"],
                                "feedback": "not good enough"})
    assert r.status_code == 200 and r.json()["status"] == "in_progress"


# ---------- the decision row records the binding ----------

async def test_approve_writes_decision_row_with_digest(client, container, make_agent, db):
    a, tid = await _needs_verification_task(client, make_agent, db)
    h = await make_agent("Hussein", kind="human")
    _insert_run(db, a["agent_id"], tid, "+ the change")
    digest = (await client.get(f"/api/tasks/{tid}/diff")).json()["diff_digest"]
    await client.post(f"/api/tasks/{tid}/verify",
                      json={"approve": True, "actor_agent_id": h["agent_id"],
                            "diff_digest": digest, "feedback": "ship it"})
    rows = db.execute(
        "SELECT * FROM decisions WHERE subject_type='task_verify' AND subject_id=%s", (tid,))
    assert len(rows) == 1
    assert rows[0]["decision"] == "approve"
    assert rows[0]["diff_digest"] == digest
    assert str(rows[0]["actor_agent_id"]) == h["agent_id"]
    assert rows[0]["reason"] == "ship it"


async def test_verify_gate_ui_ships_diff_binding(client):
    """The tasks page must ship the gate diff panel + digest echo (string-presence
    model, like test_b1_run_feed's HTML assertions). Teeth: these identifiers exist
    only with the approval–diff-binding feature."""
    html = (await client.get("/tasks")).text
    assert "gateDiffPanel(" in html
    assert "maybeLoadGateDiff(" in html
    assert "diff_digest" in html          # Accept echoes the binding digest
    data_js = (await client.get("/assets/data.js")).text
    assert "function diffOf(" in data_js and "/diff" in data_js


async def test_reject_with_feedback_writes_decision_row(client, container, make_agent, db):
    a, tid = await _needs_verification_task(client, make_agent, db)
    h = await make_agent("Hussein", kind="human")
    await client.post(f"/api/tasks/{tid}/verify",
                      json={"approve": False, "actor_agent_id": h["agent_id"],
                            "feedback": "missing tests"})
    rows = db.execute(
        "SELECT * FROM decisions WHERE subject_type='task_verify' AND subject_id=%s", (tid,))
    assert len(rows) == 1
    assert rows[0]["decision"] == "reject" and rows[0]["reason"] == "missing tests"
