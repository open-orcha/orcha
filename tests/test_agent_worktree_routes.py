"""Agent-worktree clean-up — the portal side (mig 067, portal_backend/agent_worktree_routes.py).

Settings default ON (7-day grace) for every project, are human-only (owner / manage_autonomy,
like the other execution controls) and validated; requests are checked against the host's
inventory (an unmerged worktree needs its branch name typed; in-use ones are refused); the
notifier lane claims requests, reports results / inventory / removal events, and reads task
context for worktree paths; viewers, plain members and strangers are kept out; everything is
in /openapi.json.
"""
import pytest

from test_evidence_verdikt import HUBOT, MALLORY, OCTO, VERA, _members
from conftest import ts_ago

BASE = "/Users/dev/acme"
WT = f"{BASE}/.orcha-worktrees"


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")


def _items():
    return [
        {"path": f"{WT}/Atlas-1", "name": "Atlas-1", "branch": "orcha/wk-Atlas-1", "state": "clean",
         "size_bytes": 1000, "kind": "wake", "agent": "Atlas"},
        {"path": f"{WT}/Probe-1", "name": "Probe-1", "branch": "orcha/wk-Probe-1", "state": "has-output",
         "size_bytes": 5000, "output": ["notes.md"], "output_count": 1},
        {"path": f"{WT}/Ferry-1", "name": "Ferry-1", "branch": "orcha/wk-Ferry-1", "state": "unmerged",
         "size_bytes": 300, "unmerged_commits": 2},
        {"path": f"{WT}/live-Atlas", "name": "live-Atlas", "branch": "orcha/live-Atlas", "state": "in-use",
         "size_bytes": 50},
    ]


async def _report(client, cid, items=None, headers=None):
    r = await client.post(f"/api/containers/{cid}/agent-worktrees/inventory",
                          json={"host": "mac", "base_cwd": BASE, "items": items or _items()},
                          headers=headers or {})
    return r


async def test_settings_default_on_and_inventory_round_trip(client, container, db):
    cid = container["id"]
    row = db.execute("SELECT worktree_auto_cleanup, worktree_grace_days FROM containers WHERE id=%s", (cid,))[0]
    assert row["worktree_auto_cleanup"] is True and row["worktree_grace_days"] == 7
    got = (await client.get(f"/api/containers/{cid}/agent-worktrees")).json()
    assert got["settings"] == {"auto_cleanup": True, "grace_days": 7}
    assert got["inventory"] is None and got["actions"] == []

    assert (await _report(client, cid)).status_code == 200
    inv = (await client.get(f"/api/containers/{cid}/agent-worktrees")).json()["inventory"]
    assert inv["host"] == "mac" and len(inv["items"]) == 4
    assert inv["counts"] == {"clean": 1, "has-output": 1, "unmerged": 1, "in-use": 1, "not-quorate": 0}
    assert inv["reclaimable_bytes"] == 6000 and inv["total_bytes"] == 6350


async def test_settings_update_is_validated_logged_and_human_only(client, container, make_agent, db):
    cid = container["id"]
    human = await make_agent("operator", kind="human")
    ai = await make_agent("builder")
    url = f"/api/containers/{cid}/agent-worktrees/settings"
    r = await client.put(url, json={"auto_cleanup": False, "actor_agent_id": human["agent_id"]})
    assert r.status_code == 200 and r.json() == {"auto_cleanup": False, "grace_days": 7}
    r = await client.put(url, json={"grace_days": 14, "actor_agent_id": human["agent_id"]})
    assert r.json() == {"auto_cleanup": False, "grace_days": 14}  # omitted field kept
    assert (await client.put(url, json={"grace_days": 91, "actor_agent_id": human["agent_id"]})).status_code == 422
    assert (await client.put(url, json={"grace_days": 3, "actor_agent_id": ai["agent_id"]})).status_code == 403
    ev = db.execute("SELECT detail FROM events WHERE container_id=%s AND event_type='agent_worktree_settings_changed' "
                    "ORDER BY id", (cid,))
    assert [e["detail"]["after"] for e in ev] == [{"auto_cleanup": False, "grace_days": 7},
                                                   {"auto_cleanup": False, "grace_days": 14}]


async def test_settings_and_actions_need_owner_or_manage_autonomy(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _members(client, cid, make_agent)
    await _report(client, cid)
    url = f"/api/containers/{cid}/agent-worktrees/settings"
    for who in (HUBOT, VERA, MALLORY):
        assert (await client.put(url, json={"auto_cleanup": False}, headers=who)).status_code == 403
        assert (await client.post(f"/api/containers/{cid}/agent-worktrees/actions",
                                  json={"action": "refresh"}, headers=who)).status_code == 403
    assert (await client.put(url, json={"auto_cleanup": False}, headers=OCTO)).status_code == 200
    # reading is open to every member (the viewer included), not to strangers
    assert (await client.get(f"/api/containers/{cid}/agent-worktrees", headers=VERA)).status_code == 200
    assert (await client.get(f"/api/containers/{cid}/agent-worktrees", headers=MALLORY)).status_code == 403


async def test_actions_are_checked_against_the_inventory(client, container, make_agent, db):
    cid = container["id"]
    hid = (await make_agent("operator", kind="human"))["agent_id"]
    url = f"/api/containers/{cid}/agent-worktrees/actions"
    await _report(client, cid)

    async def act(**body):
        return await client.post(url, json={"actor_agent_id": hid, **body})

    assert (await act(action="remove", path=f"{WT}/nope")).status_code == 404
    assert (await act(action="remove", path=f"{WT}/live-Atlas")).status_code == 409
    r = await act(action="remove", path=f"{WT}/Ferry-1")
    assert r.status_code == 400 and "orcha/wk-Ferry-1" in r.json()["detail"]
    assert (await act(action="remove", path=f"{WT}/Ferry-1", confirm_branch="wrong")).status_code == 400
    r = await act(action="remove", path=f"{WT}/Ferry-1", confirm_branch="orcha/wk-Ferry-1", keep_branch=True)
    assert r.status_code == 201 and r.json()["confirm_unmerged"] is True and r.json()["keep_branch"] is True
    assert (await act(action="save_output", path=f"{WT}/Atlas-1")).status_code == 409
    assert (await act(action="save_output", path=f"{WT}/Probe-1")).status_code == 201
    r = await act(action="remove", path=f"{WT}/Atlas-1")
    assert r.status_code == 201 and r.json()["status"] == "requested"
    assert (await act(action="remove", path=f"{WT}/Atlas-1")).status_code == 409  # already waiting
    assert (await act(action="clean_up", unmerged_paths=[f"{WT}/Atlas-1"])).status_code == 400
    r = await act(action="clean_up", unmerged_paths=[f"{WT}/Ferry-1"])
    assert r.status_code == 201 and r.json()["unmerged_paths"] == [f"{WT}/Ferry-1"]
    n = db.execute("SELECT count(*) AS n FROM events WHERE container_id=%s AND "
                   "event_type='agent_worktree_action_requested'", (cid,))[0]["n"]
    assert n == 4


async def test_notifier_lane_claim_result_context_and_events(client, container, make_agent, make_task, db):
    cid = container["id"]
    hid = (await make_agent("operator", kind="human"))["agent_id"]
    ai = await make_agent("Atlas")
    task = await make_task("ship it", "done")
    await _report(client, cid)
    created = (await client.post(f"/api/containers/{cid}/agent-worktrees/actions",
                                 json={"action": "remove", "path": f"{WT}/Atlas-1",
                                       "actor_agent_id": hid})).json()

    # a running run in a worktree → busy; peek claims nothing
    db.execute("INSERT INTO worker_runs (agent_id, task_id, status, worktree, branch, base_cwd) "
               "VALUES (%s,%s,'running',%s,'orcha/wk-Probe-1',%s)",
               (ai["agent_id"], task["id"], f"{WT}/Probe-1", BASE))
    peek = (await client.post(f"/api/containers/{cid}/agent-worktrees/claim", json={"peek": True})).json()
    assert peek["actions"] == [] and peek["busy_worktrees"] == [f"{WT}/Probe-1"]
    claim = (await client.post(f"/api/containers/{cid}/agent-worktrees/claim",
                               json={"claimed_by": "mac:1"})).json()
    assert claim["settings"] == {"auto_cleanup": True, "grace_days": 7}
    assert [a["id"] for a in claim["actions"]] == [created["id"]]
    assert claim["actions"][0]["status"] == "claimed"
    again = (await client.post(f"/api/containers/{cid}/agent-worktrees/claim", json={})).json()
    assert again["actions"] == []

    done = await client.post(f"/api/agent-worktrees/actions/{created['id']}/result",
                             json={"status": "done", "result": {"freed_bytes": 1000}})
    assert done.status_code == 200 and done.json()["status"] == "done"
    polled = (await client.get(f"/api/containers/{cid}/agent-worktrees/actions/{created['id']}")).json()
    assert polled["result"] == {"freed_bytes": 1000} and polled["finished_at"]

    # context: from the run recorded in the worktree, or by the task prefix in a branch name
    db.execute("UPDATE tasks SET status='completed', completed_at=now() WHERE id=%s", (task["id"],))
    ctx = (await client.post(f"/api/containers/{cid}/agent-worktrees/context", json={
        "paths": [f"{WT}/Probe-1", f"{WT}/task-Atlas-x"],
        "task_refs": {f"{WT}/task-Atlas-x": task["id"][:12]}})).json()["items"]
    p = ctx[f"{WT}/Probe-1"]
    assert p["task_id"] == task["id"] and p["task_status"] == "completed" and p["running"] is True
    assert p["task_ended_at"] and p["agent"] == "Atlas"
    assert ctx[f"{WT}/task-Atlas-x"]["task_id"] == task["id"]

    r = await client.post(f"/api/containers/{cid}/agent-worktrees/events", json={
        "kind": "removed", "trigger": "sweep", "path": f"{WT}/Atlas-1", "branch": "orcha/wk-Atlas-1",
        "state": "clean", "reason": "clean wake worktree", "freed_bytes": 1000, "branch_deleted": True})
    assert r.status_code == 201
    ev = db.execute("SELECT detail FROM events WHERE container_id=%s AND event_type='agent_worktree_removed'", (cid,))
    assert ev[0]["detail"]["path"] == f"{WT}/Atlas-1" and ev[0]["detail"]["freed_bytes"] == 1000


async def test_stale_claims_fail_instead_of_hanging(client, container, make_agent, db):
    cid = container["id"]
    hid = (await make_agent("operator", kind="human"))["agent_id"]
    await _report(client, cid)
    a = (await client.post(f"/api/containers/{cid}/agent-worktrees/actions",
                           json={"action": "refresh", "actor_agent_id": hid})).json()
    await client.post(f"/api/containers/{cid}/agent-worktrees/claim", json={})
    db.execute(f"UPDATE agent_worktree_actions SET claimed_at = {ts_ago(3600)} WHERE id=%s", (a["id"],))
    await client.post(f"/api/containers/{cid}/agent-worktrees/claim", json={"peek": True})
    row = (await client.get(f"/api/containers/{cid}/agent-worktrees/actions/{a['id']}")).json()
    assert row["status"] == "failed" and "notifier stopped" in row["error"]


async def test_notifier_lane_is_closed_to_viewers_members_and_strangers(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _members(client, cid, make_agent)
    for who in (HUBOT, VERA, MALLORY):
        assert (await client.post(f"/api/containers/{cid}/agent-worktrees/claim", json={}, headers=who)).status_code == 403
        assert (await _report(client, cid, headers=who)).status_code == 403
        assert (await client.post(f"/api/containers/{cid}/agent-worktrees/context", json={"paths": []},
                                  headers=who)).status_code == 403
        assert (await client.post(f"/api/containers/{cid}/agent-worktrees/events",
                                  json={"kind": "removed", "trigger": "sweep"}, headers=who)).status_code == 403
    # the header-less daemon lane passes
    assert (await client.post(f"/api/containers/{cid}/agent-worktrees/claim", json={})).status_code == 200


async def test_openapi_documents_the_agent_worktree_routes(client):
    spec = (await client.get("/openapi.json")).json()
    paths = spec["paths"]
    for p, method in (("/api/containers/{cid}/agent-worktrees", "get"),
                      ("/api/containers/{cid}/agent-worktrees/settings", "put"),
                      ("/api/containers/{cid}/agent-worktrees/actions", "post"),
                      ("/api/containers/{cid}/agent-worktrees/actions/{aid}", "get"),
                      ("/api/containers/{cid}/agent-worktrees/claim", "post"),
                      ("/api/agent-worktrees/actions/{aid}/result", "post"),
                      ("/api/containers/{cid}/agent-worktrees/inventory", "post"),
                      ("/api/containers/{cid}/agent-worktrees/context", "post"),
                      ("/api/containers/{cid}/agent-worktrees/events", "post")):
        assert method in paths.get(p, {}), p
    schemas = spec["components"]["schemas"]
    assert {"auto_cleanup", "grace_days"} <= set(schemas["WorktreeSettings"]["properties"])
    assert "confirm_branch" in schemas["WorktreeActionCreate"]["properties"]
