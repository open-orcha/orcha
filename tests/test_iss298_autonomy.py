"""#298: the autonomy SLIDER — the ONE engine-enforced gate (task completion) keyed off
containers.autonomy_level (mig 021), plus the exposure + human-gated write path.

The slider:
  plan (default) | pr  -> /done stops at needs_verification (a human verifies)
  full                 -> /done AUTO-COMPLETES via the shared _complete_and_unblock path

Everything below the completion gate (gh pr create / pr merge) is loosely-hardened agent
behavior recorded in docs/orcha-project-preferences.md — NOT engine-checked, so not tested here.
"""
import uuid

import main


async def _set_autonomy(client, cid, level, actor_id):
    return await client.post(f"/api/containers/{cid}/autonomy",
                             json={"level": level, "actor_agent_id": actor_id})


# ---------------------------------------------------------------- default + plan/pr gate

async def test_default_level_is_plan(client, container, db):
    """A fresh container defaults to the most-cautious level — zero behaviour change."""
    rows = db.execute("SELECT autonomy_level FROM containers WHERE id=%s", (container["id"],))
    assert rows[0]["autonomy_level"] == "plan"


async def test_plan_done_stops_at_needs_verification(client, make_agent, make_task):
    """plan (default): /done -> needs_verification (the human is still in the loop)."""
    dev = await make_agent("dev", "eng")
    t = await make_task("work", "done", assignee_alias="dev")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": dev["agent_id"], "result": "x"})
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"


async def test_pr_done_stops_at_needs_verification(client, container, make_agent, make_task):
    """pr: build-to-PR still keeps the human verify gate — only `full` auto-completes."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    assert (await _set_autonomy(client, container["id"], "pr", human["agent_id"])).status_code == 200
    t = await make_task("work", "done", assignee_alias="dev")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": dev["agent_id"], "result": "x"})
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"


# ---------------------------------------------------------------- full gate (the hard auto-complete)

async def test_full_done_auto_completes(client, container, make_agent, make_task, db):
    """full: /done AUTO-COMPLETES (no needs_verification, no human verify)."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    await _set_autonomy(client, container["id"], "full", human["agent_id"])
    t = await make_task("work", "done", assignee_alias="dev")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": dev["agent_id"], "result": "x"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "completed" and body["auto_completed"] is True
    rows = db.execute("SELECT status, completed_at FROM tasks WHERE id=%s", (t["task_id"],))
    assert rows[0]["status"] == "completed" and rows[0]["completed_at"] is not None


async def test_full_done_unblocks_downstream(client, container, make_agent, make_task, db):
    """full auto-completion runs the SAME downstream-unblock as a human /verify approve."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    await _set_autonomy(client, container["id"], "full", human["agent_id"])
    blocker = await make_task("blocker", "done", assignee_alias="dev")
    downstream = await make_task("downstream", "done", depends_on=[blocker["task_id"]])
    assert downstream["status"] == "pending"
    r = await client.post(f"/api/tasks/{blocker['task_id']}/done",
                          json={"agent_id": dev["agent_id"], "result": "x"})
    assert downstream["task_id"] in r.json().get("unblocked", [])
    rows = db.execute("SELECT status FROM tasks WHERE id=%s", (downstream["task_id"],))
    assert rows[0]["status"] == "ready"


async def test_full_done_audits_auto_completed(client, container, make_agent, make_task, db):
    """The audit row records the resolved level + auto_completed so a post-hoc reviewer can SEE
    the engine auto-completed (vs a human verifying)."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    await _set_autonomy(client, container["id"], "full", human["agent_id"])
    t = await make_task("work", "done", assignee_alias="dev")
    await client.post(f"/api/tasks/{t['task_id']}/done",
                      json={"agent_id": dev["agent_id"], "result": "x"})
    rows = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='status_changed' ORDER BY id",
        (t["task_id"],))
    last = rows[-1]["detail"]
    assert last["to"] == "completed" and last["autonomy_level"] == "full"
    assert last["auto_completed"] is True


async def test_full_done_emits_no_verification(client, container, make_agent, make_task, db):
    """Tooth (Gate, PR #317): full-autonomy /done AUTO-COMPLETES but is NOT a verification.
    The `verified` audit row and the `task_verified` assignee wake belong ONLY to the human
    /verify path — an engine auto-completion has no human verifier. If the full branch ever
    forges them (e.g. someone copies the verify-approve event block into /done), a downstream
    consumer would mistake an un-reviewed auto-completion for a human-approved one.
    BITES: inject log_event(...,'verified',...) or _publish_event(...,'task_verified',...) into
    the full /done branch and one of these assertions goes RED."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    await _set_autonomy(client, container["id"], "full", human["agent_id"])
    t = await make_task("work", "done", assignee_alias="dev")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": dev["agent_id"], "result": "x"})
    assert r.status_code == 200 and r.json()["status"] == "completed", r.text
    evs = db.execute(
        "SELECT event_type, detail FROM events WHERE entity_id=%s ORDER BY id", (t["task_id"],))
    # Sanity: we ARE on the full auto-complete path (anchors the negative assertions below).
    assert any(e["event_type"] == "status_changed" and e["detail"].get("auto_completed") is True
               for e in evs), "expected the full-autonomy auto_completed audit row"
    # (a) NO human-verification audit row was forged.
    assert not any(e["event_type"] == "verified" for e in evs), \
        "full-autonomy /done emitted a 'verified' event — that belongs ONLY to human /verify"
    # (b) the assignee got NO task_verified wake (only a real human /verify sends that).
    assert not db.execute(
        "SELECT 1 FROM agent_events WHERE event_key=%s AND event_name='task_verified'",
        (dev["agent_id"],)), \
        "full-autonomy /done sent the assignee a 'task_verified' wake — a verify-only event"


# ---------------------------------------------------------------- enum CHECK / route validation

async def test_route_rejects_bad_level(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    r = await _set_autonomy(client, container["id"], "yolo", human["agent_id"])
    assert r.status_code == 400, r.text


async def test_db_check_rejects_bad_level(db, container):
    """Belt-and-suspenders: the column CHECK refuses an out-of-enum value even via raw SQL."""
    import psycopg
    try:
        db.execute("UPDATE containers SET autonomy_level='nope' WHERE id=%s", (container["id"],))
        assert False, "DB CHECK should have rejected 'nope'"
    except psycopg.errors.CheckViolation:
        pass


# ---------------------------------------------------------------- human-gate on the write path

async def test_autonomy_write_is_human_gated(client, container, make_agent, db):
    """Moving the slider can switch OFF the verify gate — so it's a kind='human' action only."""
    ai = await make_agent("bot", "eng")
    r = await _set_autonomy(client, container["id"], "full", ai["agent_id"])
    assert r.status_code == 403, r.text
    # and the level did NOT move
    rows = db.execute("SELECT autonomy_level FROM containers WHERE id=%s", (container["id"],))
    assert rows[0]["autonomy_level"] == "plan"


async def test_autonomy_write_by_human_persists(client, container, make_agent, db):
    human = await make_agent("op", "operator", kind="human")
    r = await _set_autonomy(client, container["id"], "full", human["agent_id"])
    assert r.status_code == 200 and r.json()["autonomy_level"] == "full"
    rows = db.execute("SELECT autonomy_level FROM containers WHERE id=%s", (container["id"],))
    assert rows[0]["autonomy_level"] == "full"


# ---------------------------------------------------------------- exposure (engine surfaces level)

async def test_get_container_exposes_level(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    await _set_autonomy(client, container["id"], "pr", human["agent_id"])
    r = await client.get(f"/api/containers/{container['id']}")
    assert r.status_code == 200
    assert r.json()["container"]["autonomy_level"] == "pr"


async def test_next_payload_carries_level(client, container, make_agent, make_task):
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    await _set_autonomy(client, container["id"], "full", human["agent_id"])
    t = await make_task("loose", "done")    # unassigned -> ready
    ar = await client.post(f"/api/tasks/{t['id']}/assign",
                           json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert ar.status_code == 200 and ar.json()["status"] == "ready", ar.text
    r = await client.post(f"/api/agents/{dev['agent_id']}/next")
    assert r.status_code == 200, r.text
    assert r.json()["autonomy_level"] == "full"


# ---------------------------------------------------------------- shared-helper DRIFT tooth

async def test_shared_helper_drift_tooth(client, container, make_agent, make_task, db, monkeypatch):
    """Both /verify-approve AND full-/done MUST route completion through the single shared
    _complete_and_unblock. If either re-inlines its own completion (drift), this bites: we
    replace the helper with a no-op and assert NEITHER path reaches 'completed' in the DB.
    Revert either route back to inline SQL and that path stays 'completed' here -> test fails."""
    monkeypatch.setattr(main, "_complete_and_unblock", lambda cur, container_id, tid: [])

    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")

    # Path 1: human /verify approve — with the helper stubbed, the task must NOT complete.
    t1 = await make_task("via-verify", "done", assignee_alias="dev")
    await client.post(f"/api/tasks/{t1['task_id']}/done",
                      json={"agent_id": dev["agent_id"], "result": "x"})
    await client.post(f"/api/tasks/{t1['task_id']}/verify",
                      json={"approve": True, "actor_agent_id": human["agent_id"]})
    r1 = db.execute("SELECT status FROM tasks WHERE id=%s", (t1["task_id"],))
    assert r1[0]["status"] != "completed", "verify-approve bypassed the shared helper (drift)"

    # Path 2: full-autonomy /done — likewise must NOT complete with the helper stubbed.
    await _set_autonomy(client, container["id"], "full", human["agent_id"])
    t2 = await make_task("via-done", "done", assignee_alias="dev")
    await client.post(f"/api/tasks/{t2['task_id']}/done",
                      json={"agent_id": dev["agent_id"], "result": "x"})
    r2 = db.execute("SELECT status FROM tasks WHERE id=%s", (t2["task_id"],))
    assert r2[0]["status"] != "completed", "full-/done bypassed the shared helper (drift)"
