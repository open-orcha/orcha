""""Make recurring…" from a task: routines record the task they were copied from.

Covers the origin link (create → read/list, ?origin_task_id= filter for the task's
"Recurring" link), the task itself staying untouched, cross-project / unknown task
rejection, the same authority as routine creation (AI / plain member / viewer refused,
verified stranger can't read), and the /openapi.json contract.
"""
import pytest

import conftest  # noqa: F401  (test DB bootstrap)

OCTO = {"X-Auth-Request-User": "octocat"}
VERA = {"X-Auth-Request-User": "vera"}


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


@pytest.fixture
async def arena(client, container, make_agent, make_task, db):
    owner = await make_agent("kedar", "Founder", kind="human")
    db.execute("UPDATE agents SET member_role='owner' WHERE id=%s", (owner["agent_id"],))
    forge = await make_agent("forge", "Builder")
    task = await make_task("Triage new issues", "Every new issue has a label.",
                           description="Look at the inbox.", priority=50)
    return {"cid": container["id"], "owner": owner["agent_id"], "forge": forge["agent_id"], "task": task["id"]}


def body(actor, task_id, **kw):
    b = {
        "actor_agent_id": actor,
        "title": "Triage new issues",
        "description": "Look at the inbox.",
        "definition_of_done": "Every new issue has a label.",
        "priority": 50,
        "cron": "0 9 * * 1-5",
        "timezone": "Africa/Nairobi",
        "origin_task_id": task_id,
    }
    b.update(kw)
    return b


async def test_origin_link_is_recorded_listed_and_filterable(client, arena, db):
    before = db.execute("SELECT title, status, description, definition_of_done, priority FROM tasks WHERE id=%s", (arena["task"],))[0]
    r = await client.post(f"/api/containers/{arena['cid']}/routines",
                          json=body(arena["owner"], arena["task"], assignee_agent_id=arena["forge"]))
    assert r.status_code == 201, r.text
    rt = r.json()
    assert rt["origin_task_id"] == arena["task"]
    assert rt["origin_task_title"] == "Triage new issues"
    assert rt["priority"] == 50 and rt["assignee_alias"] == "forge"
    # a copy, not a conversion: the task is unchanged
    after = db.execute("SELECT title, status, description, definition_of_done, priority FROM tasks WHERE id=%s", (arena["task"],))[0]
    assert after == before
    # read + list carry it
    got = (await client.get(f"/api/routines/{rt['id']}")).json()
    assert got["origin_task_id"] == arena["task"]
    # an unrelated routine has no origin and is filtered out of the task's "Recurring" lookup
    other = await client.post(f"/api/containers/{arena['cid']}/routines", json=body(arena["owner"], None))
    assert other.status_code == 201 and other.json()["origin_task_id"] is None
    lst = (await client.get(f"/api/containers/{arena['cid']}/routines",
                            params={"origin_task_id": arena["task"]})).json()
    assert [x["id"] for x in lst["routines"]] == [rt["id"]]
    assert len((await client.get(f"/api/containers/{arena['cid']}/routines")).json()["routines"]) == 2
    # audit event names the origin
    ev = db.execute("SELECT detail FROM events WHERE entity_id=%s AND event_type='routine_created'", (rt["id"],))
    assert ev and ev[0]["detail"]["origin_task_id"] == arena["task"]
    # a deleted routine no longer shows as the task's recurring link
    assert (await client.delete(f"/api/routines/{rt['id']}", params={"actor_agent_id": arena["owner"]})).status_code == 200
    lst = (await client.get(f"/api/containers/{arena['cid']}/routines",
                            params={"origin_task_id": arena["task"]})).json()
    assert lst["routines"] == []


async def test_origin_task_must_belong_to_the_same_project(client, arena):
    r = await client.post("/api/containers", json={"name": "other-project", "additional": True})
    assert r.status_code == 201, r.text
    other_root = r.json()["root_task_id"]
    x = await client.post(f"/api/containers/{arena['cid']}/routines", json=body(arena["owner"], other_root))
    assert x.status_code == 404 and "this project" in x.text
    x = await client.post(f"/api/containers/{arena['cid']}/routines",
                          json=body(arena["owner"], "00000000-0000-4000-8000-000000000000"))
    assert x.status_code == 404
    x = await client.post(f"/api/containers/{arena['cid']}/routines", json=body(arena["owner"], "nope"))
    assert x.status_code == 400
    x = await client.get(f"/api/containers/{arena['cid']}/routines", params={"origin_task_id": "nope"})
    assert x.status_code == 400


async def test_make_recurring_needs_routine_authority_trust_off(client, arena, make_agent, db):
    cid, tid = arena["cid"], arena["task"]
    assert (await client.post(f"/api/containers/{cid}/routines", json=body(arena["forge"], tid))).status_code == 403
    m = await make_agent("hubot", "Dev", kind="human")
    x = await client.post(f"/api/containers/{cid}/routines", json=body(m["agent_id"], tid))
    assert x.status_code == 403 and "manage_agents" in x.text
    v = await make_agent("vera", "Viewer", kind="human")
    db.execute("""UPDATE agents SET member_role='viewer', grants='["manage_agents"]'::jsonb WHERE id=%s""", (v["agent_id"],))
    assert (await client.post(f"/api/containers/{cid}/routines", json=body(v["agent_id"], tid))).status_code == 403
    assert db.execute("SELECT count(*) AS n FROM routines WHERE origin_task_id=%s", (tid,))[0]["n"] == 0


async def test_make_recurring_trusted_lane_viewer_and_stranger(client, container, make_agent, make_task, monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).json()["identity"]["member_role"] == "owner"
    assert (await client.post(f"/api/containers/{cid}/members", json={"github_login": "vera", "role": "viewer"},
                              headers=OCTO)).status_code == 201
    t = await make_task("Weekly report", "Report posted.")
    x = await client.post(f"/api/containers/{cid}/routines", json=body(None, t["id"]), headers=VERA)
    assert x.status_code == 403
    x = await client.post(f"/api/containers/{cid}/routines", json=body(None, t["id"]), headers=OCTO)
    assert x.status_code == 201, x.text
    assert x.json()["origin_task_id"] == t["id"]
    # viewer can read the task's recurring link; a verified stranger cannot
    ok = await client.get(f"/api/containers/{cid}/routines", params={"origin_task_id": t["id"]}, headers=VERA)
    assert ok.status_code == 200 and len(ok.json()["routines"]) == 1
    no = await client.get(f"/api/containers/{cid}/routines", params={"origin_task_id": t["id"]},
                          headers={"X-Auth-Request-User": "mallory"})
    assert no.status_code == 403


async def test_openapi_documents_the_origin_link(client):
    spec = (await client.get("/openapi.json")).json()
    schemas = spec["components"]["schemas"]
    assert "origin_task_id" in schemas["RoutineCreate"]["properties"]
    assert {"origin_task_id", "origin_task_title"} <= set(schemas["RoutineRead"]["properties"])
    lst = spec["paths"]["/api/containers/{cid}/routines"]["get"]
    assert any(p["name"] == "origin_task_id" for p in lst["parameters"])
    create = spec["paths"]["/api/containers/{cid}/routines"]["post"]
    assert create["responses"]["201"]["content"]["application/json"]["schema"]["$ref"].endswith("/RoutineRead")
