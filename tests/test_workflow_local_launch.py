"""A local human starts a Workflow and each eligible assigned task launches by itself.

Real routes and the production hooks (no stand-ins): the local-human lane starts the
Workflow, and the scheduler reserves, activates, stops and continues the task with NO
launcher token or credential header. Every gate that must still refuse an invalid
launch is asserted through the same reserve route.
"""

import io
import json
import urllib.error
from uuid import uuid4

import pytest

from orcha_cli import notifier_workflow as nw
from portal_backend import workflow_service as ws
from portal_backend.database import db_cursor


def uid():
    return str(uuid4())


@pytest.fixture(autouse=True)
def local_lane(monkeypatch):
    monkeypatch.setattr(ws, "WORKFLOWS_INTEGRATED", True)
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    monkeypatch.delenv("ORCHA_BIND", raising=False)
    monkeypatch.setattr(nw, "_REFUSALS", {})
    monkeypatch.setattr(nw, "_NOTICE_TS", {})


class Project:
    """A local project with one human owner and two AI teammates."""

    def __init__(self, client):
        self.client = client
        self.cid, self.owner, self.ann, self.bob = uid(), uid(), uid(), uid()
        with db_cursor() as (_, cur):
            cur.execute("INSERT INTO containers(id,name) VALUES (%s,'Local launch')", (self.cid,))
            for aid, alias, kind, role in [
                (self.owner, "Owner", "human", "owner"),
                (self.ann, "Ann", "ai", "member"),
                (self.bob, "Bob", "ai", "member"),
            ]:
                cur.execute(
                    "INSERT INTO agents(id,container_id,alias,role,kind,member_role,github_login)"
                    " VALUES (%s,%s,%s,'test',%s,%s,%s)",
                    (aid, self.cid, alias, kind, role, alias.lower() if kind == "human" else None),
                )
        self.headers = {"X-Orcha-Local-Actor": self.owner}

    async def call(self, method, path, body=None, expect=200):
        response = await self.client.request(method, path, json=body, headers=self.headers)
        assert response.status_code == expect, (path, response.status_code, response.text)
        return response.json()

    async def detail(self, wid):
        return await self.call("GET", f"/api/workflows/{wid}")

    def mutation(self, detail, **extra):
        return {"expected_revision": detail["revision"], "idempotency_key": uid(), "reason": "test", **extra}

    async def start(self, mode, specs):
        """specs: (key, assignee, [prerequisite keys]); prepare every task, then Start."""
        draft = {
            "title": "Local", "goal": "Ship it", "execution_mode": mode, "idempotency_key": uid(),
            "tasks": [
                {"client_key": key, "title": f"Task {key}", "description": "d",
                 "definition_of_done": "done", "assignee_id": assignee, "depends_on": deps,
                 "priority": 10 * (index + 1)}  # serial turn order is priority, then age
                for index, (key, assignee, deps) in enumerate(specs)
            ],
        }
        wid = (await self.call("POST", f"/api/containers/{self.cid}/workflows", draft, 201))["id"]
        detail = await self.detail(wid)
        self.tasks = {t["title"].removeprefix("Task "): t["id"] for t in detail["tasks"]}
        for tid in self.tasks.values():
            detail = await self.detail(wid)
            task = next(t for t in detail["tasks"] if t["id"] == tid)
            await self.call("POST", f"/api/tasks/{tid}/prepare",
                            self.mutation(detail, expected_work_revision=task["work_revision"]))
        detail = await self.detail(wid)
        await self.call("POST", f"/api/workflows/{wid}/start", self.mutation(
            detail, task_ids=list(self.tasks.values()), holds=["start"],
            task_revisions={t["id"]: t["work_revision"] for t in detail["tasks"]}))
        self.wid = wid
        return wid

    async def reserve(self, aid, key, expect=201, operation_key=None):
        detail = await self.detail(self.wid)
        tid = self.tasks[key]
        task = next(t for t in detail["tasks"] if t["id"] == tid)
        response = await self.client.post(
            f"/api/agents/{aid}/runs/reserve",
            json={"task_id": tid, "expected_workflow_revision": detail["revision"],
                  "expected_work_revision": task["work_revision"], "operation_key": operation_key or uid()})
        assert response.status_code == expect, (key, response.status_code, response.text)
        return response.json()

    async def activate(self, aid, launch):
        response = await self.client.post(
            f"/api/agents/{aid}/runs/{launch['run_id']}/activate",
            json={"permit": launch["permit"], "process_key": "p" * 32, "pid": 4242})
        assert response.status_code == 200, response.text
        return response.json()


def blockers(body):
    return {b["code"] for b in body["detail"]["blockers"]}


@pytest.mark.asyncio
async def test_prepared_local_workflow_starts_and_the_assigned_task_reserves(client):
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    detail = await project.detail(project.wid)
    assert detail["launch_enabled"] is True
    assert [t["status"] for t in detail["tasks"]] == ["ready"]
    reserved = await project.reserve(project.ann, "a")
    assert reserved["task_id"] == project.tasks["a"] and reserved["permit"]


@pytest.mark.asyncio
async def test_unprepared_task_and_non_owner_cannot_start(client):
    project = Project(client)
    draft = {"title": "Local", "goal": "Ship it", "idempotency_key": uid(), "tasks": [
        {"client_key": "a", "title": "Task a", "assignee_id": project.ann}]}
    wid = (await project.call("POST", f"/api/containers/{project.cid}/workflows", draft, 201))["id"]
    detail = await project.detail(wid)
    refused = await project.client.post(f"/api/workflows/{wid}/start", json=project.mutation(detail),
                                        headers=project.headers)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "prepared_selection_required"
    other = uid()
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO agents(id,container_id,alias,role,kind,member_role) VALUES (%s,%s,'Other','t','human','member')",
                    (other, project.cid))
    refused = await project.client.post(f"/api/workflows/{wid}/start", json=project.mutation(detail),
                                        headers={"X-Orcha-Local-Actor": other})
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "workflow_owner_required"


@pytest.mark.asyncio
async def test_serial_runs_one_task_at_a_time_and_waits_for_prerequisites(client):
    project = Project(client)
    await project.start("serial", [("a", project.ann, []), ("b", project.bob, ["a"]), ("c", project.bob, [])])
    assert "prerequisites" in blockers(await project.reserve(project.bob, "b", expect=409))
    await project.reserve(project.ann, "a")
    # Task a holds the only serial turn, so the independent task c must wait too.
    assert blockers(await project.reserve(project.bob, "c", expect=409)) & {"workflow_turn", "reservation_live"}


@pytest.mark.asyncio
async def test_parallel_launches_independent_tasks_of_different_agents_together(client):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, []), ("b", project.bob, [])])
    await project.reserve(project.ann, "a")
    await project.reserve(project.bob, "b")


@pytest.mark.asyncio
@pytest.mark.parametrize("gate,code", [
    ("hold", "human_hold"), ("paused", "workflow_not_active"), ("cancelled", "workflow_not_active"),
    ("completed", "task_not_waiting"), ("inactive_project", "project_not_active"),
    ("limit", "limit_reached"),
])
async def test_gates_that_must_still_refuse_a_launch(client, gate, code):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, [])])
    tid = project.tasks["a"]
    detail = await project.detail(project.wid)
    task = detail["tasks"][0]
    if gate == "hold":
        await project.call("POST", f"/api/tasks/{tid}/hold",
                           project.mutation(detail, expected_work_revision=task["work_revision"]))
    elif gate == "paused":
        await project.call("POST", f"/api/workflows/{project.wid}/pause", project.mutation(detail))
    elif gate == "cancelled":
        await project.call("POST", f"/api/workflows/{project.wid}/cancel", project.mutation(detail))
    with db_cursor() as (_, cur):
        if gate == "completed":
            cur.execute("UPDATE tasks SET status='completed' WHERE id=%s", (tid,))
        elif gate == "inactive_project":
            cur.execute("UPDATE containers SET status='paused' WHERE id=%s", (project.cid,))
        elif gate == "limit":
            cur.execute("UPDATE workflows SET limit_reached=true WHERE id=%s", (project.wid,))
    refused = await project.reserve(project.ann, "a", expect=409)
    assert refused["detail"]["code"] == "not_eligible" and code in blockers(refused)


@pytest.mark.asyncio
async def test_a_retired_agent_or_a_person_cannot_launch(client):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, [])])
    refused = await project.reserve(project.owner, "a", expect=403)
    assert refused["detail"]["code"] == "runner_agent_invalid"
    with db_cursor() as (_, cur):
        cur.execute("UPDATE agents SET terminated_at=%s WHERE id=%s", (ws.sql.utcnow(), project.ann))
    refused = await project.reserve(project.ann, "a", expect=403)
    assert refused["detail"]["code"] == "runner_agent_invalid"


@pytest.mark.asyncio
async def test_reserve_ignores_any_runner_header_and_is_scoped_to_the_agents_own_project(client):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, [])])
    other_cid, other_ai = uid(), uid()
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO containers(id,name) VALUES (%s,'Elsewhere')", (other_cid,))
        cur.execute("INSERT INTO agents(id,container_id,alias,role,kind) VALUES (%s,%s,'Eve','t','ai')", (other_ai, other_cid))
    detail = await project.detail(project.wid)
    body = {"task_id": project.tasks["a"], "expected_workflow_revision": detail["revision"],
            "expected_work_revision": detail["tasks"][0]["work_revision"], "operation_key": uid()}
    # An AI teammate of another project cannot launch this project's task, header or not.
    foreign = await client.post(f"/api/agents/{other_ai}/runs/reserve", json=body,
                                headers={"X-Orcha-Runner-Token": "anything"})
    assert foreign.status_code == 409 and foreign.json()["detail"]["code"] == "workflow_task_required"
    # The assignee needs no header; a bogus one is simply ignored.
    ok = await client.post(f"/api/agents/{project.ann}/runs/reserve", json=body,
                           headers={"X-Orcha-Runner-Token": "ignored"})
    assert ok.status_code == 201, ok.text


@pytest.mark.asyncio
async def test_a_person_revoking_the_launcher_blocks_that_agent_until_cleared(client):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, []), ("b", project.bob, [])])
    await project.reserve(project.ann, "a")
    with db_cursor() as (_, cur):
        cur.execute("UPDATE workflow_runner_credentials SET revoked_at=%s WHERE agent_id=%s", (ws.sql.utcnow(), project.ann))
    refused = await project.reserve(project.ann, "a", expect=403)
    assert refused["detail"]["code"] == "runner_revoked"
    await project.reserve(project.bob, "b")  # other agents are unaffected


@pytest.mark.asyncio
async def test_token_less_dispatch_replay_activate_stop_confirm_end_to_end(client):
    project = Project(client)
    await project.start("serial", [("a", project.ann, []), ("b", project.ann, ["a"])])
    detail = await project.detail(project.wid)
    body = {"task_id": project.tasks["a"], "expected_workflow_revision": detail["revision"],
            "expected_work_revision": detail["tasks"][0]["work_revision"], "operation_key": uid()}
    url = f"/api/agents/{project.ann}/runs/reserve"
    launch = (await client.post(url, json=body)).json()
    assert (await client.post(url, json=body)).json() == launch  # lost-response replay
    await project.activate(project.ann, launch)
    detail = await project.detail(project.wid)
    task = next(t for t in detail["tasks"] if t["id"] == project.tasks["a"])
    await project.call("POST", f"/api/tasks/{task['id']}/stop",
                       project.mutation(detail, expected_work_revision=task["work_revision"]))
    # A stopped turn can never be continued by another worker.
    stopped = await client.post(f"/api/agents/{project.ann}/runs/{launch['run_id']}/continue-reserve",
                                json={"operation_key": uid()})
    assert stopped.status_code == 409 and stopped.json()["detail"]["code"] == "continuation_not_allowed"
    confirmed = await client.post(f"/api/agents/{project.ann}/runs/{launch['run_id']}/confirm-stopped",
                                  json={"generation": launch["generation"]})
    assert confirmed.status_code == 200, confirmed.text


@pytest.mark.asyncio
async def test_token_less_continue_after_a_confirmed_exit_and_wrong_agent_is_refused(client):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    base = f"/api/agents/{project.ann}/runs/{launch['run_id']}"
    # Another teammate cannot release or continue Ann's worker.
    for suffix, body in (("/abort-launch", None), ("/confirm-stopped", {"generation": 1}),
                         ("/continue-reserve", {"operation_key": uid()})):
        bob = await client.post(base.replace(project.ann, project.bob) + suffix, json=body)
        assert bob.status_code == 403 and bob.json()["detail"]["code"] == "wrong_runner", suffix
    # No exit observed yet -> no second worker.
    early = await client.post(base + "/continue-reserve", json={"operation_key": uid()})
    assert early.status_code == 409 and early.json()["detail"]["code"] == "continuation_not_allowed"
    with db_cursor() as (_, cur):
        cur.execute("UPDATE workflows SET status='paused' WHERE id=%s", (project.wid,))
    assert (await client.post(base + "/confirm-stopped", json={"generation": 1})).status_code == 200
    again = await client.post(base + "/continue-reserve", json={"operation_key": uid()})
    assert again.status_code == 201, again.text
    assert again.json()["generation"] == 2 and again.json()["run_id"] != launch["run_id"]


# --- Refusals are visible ---------------------------------------------------------------

def refusal_error(code, message, status=403):
    def reject(url, body, headers):
        raise urllib.error.HTTPError(url, status, "no", {}, io.BytesIO(
            json.dumps({"detail": {"code": code, "message": message}}).encode()))
    return reject


def test_launch_sends_no_credential_header(monkeypatch):
    seen = []
    monkeypatch.setattr(nw, "runner_post", lambda url, body, headers: (
        seen.append(headers) or {"task_id": body["task_id"], "permit": "p", "run_id": "r"}))
    launch = nw.reserve_candidate("http://x", {"agent_id": uid(), "context_task_id": "t1"})
    assert launch["run_id"] == "r" and seen == [{}]


def test_a_refused_launch_tells_the_task_thread_once_with_the_reason_and_fix(monkeypatch):
    aid = uid()
    monkeypatch.setattr(nw, "runner_post", refusal_error(
        "runner_agent_invalid", "Only an active AI teammate can start Workflow work."))
    candidate = {"agent_id": aid, "alias": "Ann", "context_task_id": "task-1"}
    posts = []
    assert nw.reserve_candidate("http://x", candidate) is None
    assert nw.announce_refusal("http://x", candidate, lambda url, body: posts.append((url, body)), quiet=True)
    (url, body), = posts
    assert url == "http://x/api/tasks/task-1/messages" and body["author_agent_id"] == aid
    assert "could not start this task automatically" in body["body"]
    assert "Only an active AI teammate can start Workflow work" in body["body"]
    assert "Assign the task to an active AI agent" in body["body"]
    nw.reserve_candidate("http://x", candidate)  # still refused a moment later
    assert not nw.announce_refusal("http://x", candidate, lambda url, body: posts.append(1), quiet=True)
    assert len(posts) == 1


def test_abort_and_confirm_exit_also_send_no_credential(monkeypatch):
    seen = []
    monkeypatch.setattr(nw, "runner_post", lambda url, body, headers: seen.append(headers) or {"state": "aborted"})
    assert nw.abort_reserved({"agent_id": "a", "api_base": "http://x", "run_id": "r"})

    class Done:
        def poll(self):
            return 0
    assert nw.confirm_exit("http://x", "a", {"workflow": True, "proc": Done(), "run_id": "r", "workflow_generation": 1})
    assert seen == [{}, {}]
