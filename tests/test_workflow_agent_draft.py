"""GH #391: an agent can save a workflow DRAFT when a person asks; nothing else.

Route-level tests on the real isolated database: the work-session token may preview and
save a draft owned by a person, the history names the agent, and every other workflow
write still refuses the agent.
"""
import pytest

from portal_backend import workflow_routes
from portal_backend.database import db_cursor
from test_workflows import setup_workflow, uid  # noqa: F401  (fixture)


@pytest.fixture
def agent(setup_workflow, monkeypatch):
    """The fixture's Worker in a work session running a task that Other asked for."""
    cid, _, worker, other, hooks, _ = setup_workflow
    monkeypatch.setattr(workflow_routes, "HOOKS", hooks)
    token, task, run = uid(), uid(), uid()
    with db_cursor() as (_, cur):
        add_task(cur, cid, worker, task, other)
        cur.execute(
            "INSERT INTO worker_runs(run_id,agent_id,task_id) VALUES (%s,%s,%s)",
            (run, worker, task),
        )
        cur.execute(
            "INSERT INTO embodiment_tokens(run_token,agent_id,lane,kind,run_id) VALUES (%s,%s,'work','headless',%s)",
            (token, worker, run),
        )
    return {"X-Orcha-Run-Token": token}


def add_task(cur, cid, worker, task, requester):
    cur.execute(
        "INSERT INTO tasks(id,container_id,title,description,definition_of_done,status,created_by_agent_id,started_at) VALUES (%s,%s,'Draft it','','done','in_progress',%s,now())",
        (task, cid, requester),
    )
    cur.execute(
        "INSERT INTO agent_tasks(agent_id,task_id,assignment_status) VALUES (%s,%s,'working')",
        (worker, task),
    )


def draft_body(worker, **extra):
    return {
        "title": "Agent drafted",
        "goal": "A reviewed result",
        "tasks": [
            {"client_key": "a", "title": "First", "definition_of_done": "Done A", "assignee_id": worker},
            {"client_key": "b", "title": "Second", "definition_of_done": "Done B", "assignee_id": worker, "depends_on": ["a"]},
        ],
        "idempotency_key": uid(),
        **extra,
    }


def rows(query, params=()):
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(query, params)
        return cur.fetchall()


@pytest.mark.asyncio
async def test_agent_previews_and_saves_a_draft_owned_by_the_requester(client, setup_workflow, agent):
    cid, owner, worker, other, _, _ = setup_workflow
    body = draft_body(worker)
    url = f"/api/containers/{cid}/workflows"
    preview = await client.post(url + "/preview", json={k: v for k, v in body.items() if k != "idempotency_key"}, headers=agent)
    assert preview.status_code == 200, preview.text

    created = await client.post(url, json=body, headers=agent)
    assert created.status_code == 201, created.text
    w = created.json()
    assert w["owner_human_id"] == other  # the person who asked, never the agent or the project owner
    assert w["drafted_by_agent_id"] == worker and w["drafted_by_alias"] == "Worker"
    assert w["status"] == "active" and not w["launch_enabled"]
    assert [t["preparation_state"] for t in w["tasks"]] == ["draft", "draft"]
    assert all(t["start_hold"] and t["status"] == "not_ready" for t in w["tasks"])
    created_event = [a for a in w["activity"] if a["event"] == "workflow_created"][0]
    assert created_event["actor_alias"] == "Worker" and created_event["actor_kind"] == "ai"
    assert created_event["detail"]["drafted_by"] == "Worker"
    assert created_event["detail"]["drafted_for"] == "Other"
    assert created_event["detail"]["drafted_for_id"] == other

    saved = rows("SELECT owner_human_id,created_by_human_id,drafted_by_agent_id,launch_enabled FROM workflows WHERE id=%s", (w["id"],))[0]
    assert (str(saved["owner_human_id"]), str(saved["created_by_human_id"])) == (other, other)
    assert str(saved["drafted_by_agent_id"]) == worker
    assert rows("SELECT 1 FROM workflow_executions WHERE workflow_id=%s", (w["id"],)) == []
    assert all(r["autonomy"] != "on" for r in rows("SELECT autonomy FROM tasks WHERE workflow_id=%s", (w["id"],)))

    # Same agent + same key is the same workflow, not a second one.
    again = await client.post(url, json=body, headers=agent)
    assert again.status_code == 201 and again.json() == w
    assert len(rows("SELECT 1 FROM workflows WHERE container_id=%s", (cid,))) == 1

    # The person sees it as theirs; the agent can read it back.
    readback = await client.get(f"/api/workflows/{w['id']}", headers=agent)
    assert readback.status_code == 200 and readback.json()["drafted_by_alias"] == "Worker"
    as_person = await client.get(f"/api/workflows/{w['id']}", headers={"X-Orcha-Local-Actor": other})
    assert as_person.json()["owner_human_id"] == other


@pytest.mark.asyncio
async def test_agent_can_name_the_person_and_only_a_real_member_counts(client, setup_workflow, agent):
    cid, owner, worker, other, _, _ = setup_workflow
    url = f"/api/containers/{cid}/workflows"
    named = await client.post(url, json=draft_body(worker, for_human_id=owner.id), headers=agent)
    assert named.status_code == 201, named.text
    assert named.json()["owner_human_id"] == owner.id and named.json()["drafted_by_alias"] == "Worker"

    viewer, other_cid, outsider, gone = uid(), uid(), uid(), uid()
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO containers(id,name) VALUES (%s,'Other project')", (other_cid,))
        for aid, c, kind, role, terminated in [
            (viewer, cid, "human", "viewer", False),
            (outsider, other_cid, "human", "owner", False),
            (gone, cid, "human", "member", True),
        ]:
            cur.execute(
                "INSERT INTO agents(id,container_id,alias,role,kind,member_role,terminated_at) VALUES (%s,%s,%s,'test',%s,%s,%s)",
                (aid, c, f"M{aid[:4]}", kind, role, "2026-01-01" if terminated else None),
            )
    for bad in (worker, viewer, outsider, gone, uid(), "not-a-member-id"):
        r = await client.post(url, json=draft_body(worker, for_human_id=bad), headers=agent)
        assert r.status_code == 422, (bad, r.text)
        assert r.json()["detail"]["code"] == "draft_owner_required"
    assert len(rows("SELECT 1 FROM workflows WHERE container_id=%s", (cid,))) == 1


@pytest.mark.asyncio
async def test_without_a_named_or_requesting_person_the_agent_is_refused(client, setup_workflow, agent):
    cid, _, worker, _, _, _ = setup_workflow
    with db_cursor() as (_, cur):  # the agent's task now came from an agent, not a person
        cur.execute("UPDATE tasks SET created_by_agent_id=%s WHERE container_id=%s", (worker, cid))
    r = await client.post(f"/api/containers/{cid}/workflows", json=draft_body(worker), headers=agent)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "draft_owner_required"
    assert rows("SELECT 1 FROM workflows WHERE container_id=%s", (cid,)) == []


@pytest.mark.asyncio
async def test_default_owner_comes_from_the_sessions_own_task(client, setup_workflow, agent):
    """Review r1: a newer unrelated task must not decide who owns the draft."""
    cid, owner, worker, other, _, _ = setup_workflow
    url = f"/api/containers/{cid}/workflows"
    with db_cursor() as (_, cur):  # a newer task, asked for by someone else, also in progress
        add_task(cur, cid, worker, uid(), owner.id)
    r = await client.post(url, json=draft_body(worker), headers=agent)
    assert r.status_code == 201 and r.json()["owner_human_id"] == other, r.text

    # A session bound to no task may default only when exactly one task is in progress.
    resident = uid()
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO embodiment_tokens(run_token,agent_id,lane,kind) VALUES (%s,%s,'work','resident')",
            (resident, worker),
        )
    headers = {"X-Orcha-Run-Token": resident}
    ambiguous = await client.post(url, json=draft_body(worker), headers=headers)
    assert ambiguous.status_code == 422 and ambiguous.json()["detail"]["code"] == "draft_owner_required"
    with db_cursor() as (_, cur):
        cur.execute("UPDATE tasks SET status='needs_verification' WHERE created_by_agent_id=%s", (other,))
    single = await client.post(url, json=draft_body(worker), headers=headers)
    assert single.status_code == 201 and single.json()["owner_human_id"] == owner.id, single.text
    named = await client.post(url, json=draft_body(worker, for_human_id=other), headers=headers)
    assert named.status_code == 201 and named.json()["owner_human_id"] == other


@pytest.mark.asyncio
async def test_agent_cannot_pull_existing_tasks_into_a_draft(client, setup_workflow, agent):
    cid, _, worker, _, _, _ = setup_workflow
    existing = uid()
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO tasks(id,container_id,title,description,definition_of_done,status) VALUES (%s,%s,'Real work','','done','ready')", (existing, cid))
    r = await client.post(
        f"/api/containers/{cid}/workflows",
        json=draft_body(worker, existing_task_ids=[existing]),
        headers=agent,
    )
    assert r.status_code == 403 and r.json()["detail"]["code"] == "human_required"
    assert rows("SELECT 1 FROM workflows WHERE container_id=%s", (cid,)) == []
    assert rows("SELECT workflow_id FROM tasks WHERE id=%s", (existing,))[0]["workflow_id"] is None


@pytest.mark.asyncio
async def test_conversation_lane_and_unknown_tokens_cannot_draft(client, setup_workflow, agent):
    cid, _, worker, _, _, _ = setup_workflow
    chat = uid()
    with db_cursor() as (_, cur):
        cur.execute(
            "INSERT INTO embodiment_tokens(run_token,agent_id,lane,kind) VALUES (%s,%s,'conversation','headless')",
            (chat, worker),
        )
    for headers in ({"X-Orcha-Run-Token": chat}, {"X-Orcha-Run-Token": uid()}):
        for suffix in ("", "/preview"):
            body = draft_body(worker)
            if suffix:
                body.pop("idempotency_key")
            r = await client.post(f"/api/containers/{cid}/workflows{suffix}", json=body, headers=headers)
            assert r.status_code == 403, r.text
    assert rows("SELECT 1 FROM workflows WHERE container_id=%s", (cid,)) == []


@pytest.mark.asyncio
async def test_agent_still_cannot_do_any_other_workflow_write(client, setup_workflow, agent):
    cid, owner, worker, other, _, _ = setup_workflow
    created = await client.post(f"/api/containers/{cid}/workflows", json=draft_body(worker), headers=agent)
    w = created.json()
    wid, tid = w["id"], w["tasks"][0]["id"]
    rev = {"expected_revision": w["revision"], "idempotency_key": uid()}
    task_rev = {**rev, "expected_work_revision": w["tasks"][0]["work_revision"]}
    attempts = [
        ("POST", f"/api/workflows/{wid}/start", {**rev, "task_ids": [tid]}),
        ("POST", f"/api/workflows/{wid}/release", {**rev, "task_ids": [tid]}),
        ("POST", f"/api/workflows/{wid}/transfer-owner", {**rev, "new_owner_id": owner.id}),
        ("POST", f"/api/workflows/{wid}/pause", rev),
        ("POST", f"/api/workflows/{wid}/cancel", rev),
        ("POST", f"/api/workflows/{wid}/finish", rev),
        ("POST", f"/api/workflows/{wid}/hide", rev),
        ("POST", f"/api/workflows/{wid}/run_again", rev),
        ("PATCH", f"/api/workflows/{wid}", {**rev, "title": "Changed"}),
        ("POST", f"/api/tasks/{tid}/prepare", {**task_rev, "title": "Changed"}),
        ("POST", f"/api/tasks/{tid}/hold", task_rev),
    ]
    for method, path, payload in attempts:
        r = await client.request(method, path, json=payload, headers=agent)
        assert r.status_code == 403, (path, r.status_code, r.text)
        assert r.json()["detail"]["code"] == "human_required", (path, r.text)
    # Agents may add steps only after the owner starts the workflow.
    add = await client.post(
        f"/api/workflows/{wid}/tasks",
        json={**rev, "tasks": [{"client_key": "c", "title": "Extra", "definition_of_done": "x", "assignee_id": worker}]},
        headers=agent,
    )
    assert add.status_code == 409 and add.json()["detail"]["code"] == "workflow_not_started"
    after = (await client.get(f"/api/workflows/{wid}", headers=agent)).json()
    assert after["revision"] == w["revision"] and not after["launch_enabled"] and after["owner_human_id"] == other
    assert sorted(t["title"] for t in after["tasks"]) == ["First", "Second"]


@pytest.mark.asyncio
async def test_person_flows_unchanged_and_owner_field_is_agent_only(client, setup_workflow, agent, monkeypatch):
    cid, owner, worker, other, _, _ = setup_workflow
    url = f"/api/containers/{cid}/workflows"
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    mine = await client.post(url, json=draft_body(worker), headers={"X-Orcha-Local-Actor": owner.id})
    assert mine.status_code == 201, mine.text
    m = mine.json()
    assert m["owner_human_id"] == owner.id and m["drafted_by_agent_id"] is None and m["drafted_by_alias"] is None
    assert [a["actor_kind"] for a in m["activity"] if a["event"] == "workflow_created"] == ["human"]

    same = await client.post(url, json=draft_body(worker, for_human_id=owner.id), headers={"X-Orcha-Local-Actor": owner.id})
    assert same.status_code == 201, same.text
    elsewhere = await client.post(url, json=draft_body(worker, for_human_id=other), headers={"X-Orcha-Local-Actor": owner.id})
    assert elsewhere.status_code == 422 and elsewhere.json()["detail"]["code"] == "owner_not_allowed"

    # A person's token-less request in hosted proxy mode, and an agent's work session there.
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    hosted = await client.post(
        url,
        json=draft_body(worker),
        headers={"Host": "localhost", "Origin": "http://localhost", "X-Orcha-Local-Actor": owner.id, "X-Auth-Request-User": "owner"},
    )
    assert hosted.status_code == 201 and hosted.json()["owner_human_id"] == owner.id
    by_agent = await client.post(url, json=draft_body(worker), headers=agent)
    assert by_agent.status_code == 201 and by_agent.json()["owner_human_id"] == other
