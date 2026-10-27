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
from portal_backend import sql
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

    async def add(self, key, assignee, deps=()):
        """A person adds one more task to the running Workflow; it joins as a draft."""
        detail = await self.detail(self.wid)
        await self.call("POST", f"/api/workflows/{self.wid}/tasks", self.mutation(detail, tasks=[
            {"client_key": key, "title": f"Task {key}", "description": "d", "definition_of_done": "done",
             "assignee_id": assignee, "depends_on": [self.tasks[d] for d in deps]}]))
        detail = await self.detail(self.wid)
        self.tasks[key] = next(t["id"] for t in detail["tasks"] if t["title"] == f"Task {key}")
        return self.tasks[key]

    async def prepare(self, key):
        detail = await self.detail(self.wid)
        tid = self.tasks[key]
        task = next(t for t in detail["tasks"] if t["id"] == tid)
        await self.call("POST", f"/api/tasks/{tid}/prepare",
                        self.mutation(detail, expected_work_revision=task["work_revision"]))
        return next(t for t in (await self.detail(self.wid))["tasks"] if t["id"] == tid)

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
    # The wake scan applies the same gate: the task is not offered to the agent either.
    scan = await client.get(f"/api/containers/{project.cid}/wake-scan", params={"cooldown": 0, "min_idle": 0})
    ann = [c for c in scan.json()["candidates"] if c["agent_id"] == project.ann]
    assert all(tid not in c["auto_start_task_ids"] for c in ann)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["serial", "parallel"])
async def test_a_task_added_to_a_running_workflow_launches_once_prepared_without_a_second_release(client, mode):
    """Kedar's case: a fourth task joins a Workflow that is already running."""
    project = Project(client)
    await project.start(mode, [("a", project.ann, [])])
    await project.add("n", project.bob)
    # Until its owner prepares it the new task is a draft and cannot launch.
    assert {"task_draft", "start_hold"} <= blockers(await project.reserve(project.bob, "n", expect=409))
    assert unacked(project.bob, project.tasks["n"], "task_ready") == 0
    prepared = await project.prepare("n")
    # Preparing is the go-ahead: no Release click is left on the new task.
    assert prepared["start_hold"] is False and "start_hold" not in {b["code"] for b in prepared["blockers"]}
    if mode == "parallel":
        # ...and its agent is woken for it, so the launcher picks it up without being asked.
        assert unacked(project.bob, project.tasks["n"], "task_ready") >= 1
    if mode == "serial":
        # One turn at a time, oldest first: the new task is only waiting behind task a.
        assert [b["code"] for b in prepared["blockers"]] == ["workflow_turn"]
        await project.reserve(project.ann, "a")
        assert blockers(await project.reserve(project.bob, "n", expect=409)) & {"workflow_turn", "reservation_live"}
    else:
        assert prepared["blockers"] == [] and prepared["can_start"] is True
        reserved = await project.reserve(project.bob, "n")
        assert reserved["task_id"] == project.tasks["n"] and reserved["permit"]
        await project.reserve(project.ann, "a")


@pytest.mark.asyncio
async def test_an_added_task_still_waits_for_its_prerequisite_and_a_hold(client):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, [])])
    await project.add("n", project.bob, deps=["a"])
    await project.add("h", project.bob)
    detail = await project.detail(project.wid)
    held = next(t for t in detail["tasks"] if t["id"] == project.tasks["h"])
    await project.call("POST", f"/api/tasks/{project.tasks['h']}/hold",
                       project.mutation(detail, expected_work_revision=held["work_revision"]))
    waiting, on_hold = await project.prepare("n"), await project.prepare("h")
    # The release is automatic, but the prerequisite and the person's hold are not waived.
    assert not waiting["start_hold"] and [b["code"] for b in waiting["blockers"]] == ["prerequisites"]
    assert not on_hold["start_hold"] and [b["code"] for b in on_hold["blockers"]] == ["human_hold"]
    assert "prerequisites" in blockers(await project.reserve(project.bob, "n", expect=409))
    assert "human_hold" in blockers(await project.reserve(project.bob, "h", expect=409))
    detail = await project.detail(project.wid)
    on_hold = next(t for t in detail["tasks"] if t["id"] == project.tasks["h"])
    await project.call("POST", f"/api/workflows/{project.wid}/release", project.mutation(
        detail, task_ids=[on_hold["id"]], holds=["human"], task_revisions={on_hold["id"]: on_hold["work_revision"]}))
    await project.reserve(project.bob, "h")


@pytest.mark.asyncio
@pytest.mark.parametrize("gate,code", [
    ("paused", "workflow_not_active"), ("cancelled", "workflow_not_active"), ("completed", "task_not_waiting"),
    ("inactive_project", "project_not_active"), ("limit", "limit_reached"),
])
async def test_an_added_task_is_still_refused_when_the_workflow_cannot_launch(client, gate, code):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, [])])
    await project.add("n", project.bob)
    await project.prepare("n")
    detail = await project.detail(project.wid)
    if gate in {"paused", "cancelled"}:
        action = {"paused": "pause", "cancelled": "cancel"}[gate]
        await project.call("POST", f"/api/workflows/{project.wid}/{action}", project.mutation(detail))
    with db_cursor() as (_, cur):
        if gate == "completed":
            cur.execute("UPDATE tasks SET status='completed' WHERE id=%s", (project.tasks["n"],))
        elif gate == "inactive_project":
            cur.execute("UPDATE containers SET status='paused' WHERE id=%s", (project.cid,))
        elif gate == "limit":
            cur.execute("UPDATE workflows SET limit_reached=true WHERE id=%s", (project.wid,))
    refused = await project.reserve(project.bob, "n", expect=409)
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


# --- Signed-in people stay behind the machine-lane check (PS-07 / PS-37) --------------------

@pytest.mark.asyncio
async def test_signed_in_people_cannot_launch_as_an_agent_but_the_local_notifier_and_managers_can(client, monkeypatch):
    project = Project(client)
    other_cid = uid()
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO containers(id,name) VALUES (%s,'Elsewhere')", (other_cid,))
        for cid, login, role, grants in [
            (project.cid, "vera", "viewer", "[]"), (project.cid, "mel", "member", "[]"),
            (project.cid, "gina", "member", '["manage_agents"]'), (other_cid, "maya", "owner", "[]"),
        ]:
            cur.execute(
                "INSERT INTO agents(id,container_id,alias,role,kind,member_role,github_login,grants)"
                " VALUES (%s,%s,%s,'test','human',%s,%s,%s)", (uid(), cid, login, role, login, grants))
    await project.start("parallel", [("a", project.ann, []), ("b", project.bob, [])])
    # The header-less local notifier launches exactly as before.
    reserved = await project.reserve(project.ann, "a")
    detail = await project.detail(project.wid)
    body = {"task_id": project.tasks["a"], "expected_workflow_revision": detail["revision"],
            "expected_work_revision": detail["tasks"][0]["work_revision"], "operation_key": uid()}
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    base = f"/api/agents/{project.ann}"
    run = f"{base}/runs/{reserved['run_id']}"
    activate = {"permit": reserved["permit"], "process_key": "p" * 32, "pid": 4242}
    routes = [
        (f"{base}/runs/reserve", body), (f"{run}/activate", activate), (f"{run}/abort-launch", None),
        (f"{run}/confirm-stopped", {"generation": reserved["generation"]}),
        (f"{run}/continue-reserve", {"operation_key": uid()}),
    ]
    refusals = {"vera": "viewer", "mel": "manage_agents", "maya": "not a member of this project"}
    for login, why in refusals.items():
        for url, payload in routes:
            refused = await client.post(url, json=payload, headers={"X-Auth-Request-User": login})
            assert refused.status_code == 403, (login, url, refused.text)
            assert why in refused.json()["detail"], (login, url, refused.text)
            assert "run_token" not in refused.text
    # The refusals changed nothing: the same permit still activates for people who may.
    for login in ("gina", "owner"):
        ok = await client.post(f"{run}/activate", json=activate, headers={"X-Auth-Request-User": login})
        assert ok.status_code == 200 and ok.json()["run_token"], (login, ok.text)
    assert (await client.post(f"{run}/activate", json=activate)).status_code == 200  # local notifier replay
    # A manager can reserve for another teammate; a viewer still cannot.
    detail = await project.detail(project.wid)
    b = next(t for t in detail["tasks"] if t["id"] == project.tasks["b"])
    body_b = {"task_id": b["id"], "expected_workflow_revision": detail["revision"],
              "expected_work_revision": b["work_revision"], "operation_key": uid()}
    url_b = f"/api/agents/{project.bob}/runs/reserve"
    assert (await client.post(url_b, json=body_b, headers={"X-Auth-Request-User": "vera"})).status_code == 403
    assert (await client.post(url_b, json=body_b, headers={"X-Auth-Request-User": "gina"})).status_code == 201


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
    assert url == "http://x/api/tasks/task-1/messages"
    assert "author_agent_id" not in body  # a system note, never the assignee's own post
    assert "could not start this task automatically" in body["body"]
    assert "Only an active AI teammate can start Workflow work" in body["body"]
    assert "Assign the task to an active AI agent" in body["body"]
    nw.reserve_candidate("http://x", candidate)  # still refused a moment later
    assert not nw.announce_refusal("http://x", candidate, lambda url, body: posts.append(1), quiet=True)
    assert len(posts) == 1


def test_the_wake_loop_acks_and_announces_a_refusal_once_per_interval(monkeypatch):
    """spawn() itself must call announce_refusal: the unit tests above call it directly."""
    from orcha_cli import notifier, notifier_wake_worker
    posts = []

    def record(url, body):
        posts.append((url, body))
        return {"claimed": True}
    monkeypatch.setattr(notifier, "_post_json", record)
    monkeypatch.setattr(nw, "runner_post", refusal_error(
        "runner_agent_invalid", "Only an active AI teammate can start Workflow work."))
    candidate = {"agent_id": uid(), "alias": "Ann", "context_task_id": "task-spawn", "workflow_id": "wf",
                 "workflow_revision": 1, "workflow_work_revision": 1}

    def wake():
        return notifier_wake_worker.spawn("http://x", candidate, prompt="work", event="ready", dry_run=False,
                                          quiet=True, lease_ttl=60, live_workers={}, services=notifier)

    assert wake() is None and wake() is None  # nothing launched, and nothing spawned
    acks = [b for u, b in posts if u.endswith("/wake-ack")]
    notes = [b for u, b in posts if u == "http://x/api/tasks/task-spawn/messages"]
    assert [a["kind"] for a in acks] == ["workflow_admission_refused"] * 2  # cooldown on every refusal
    assert len(notes) == 1 and "author_agent_id" not in notes[0]  # one visible note, 30 minutes apart
    assert "Only an active AI teammate can start Workflow work" in notes[0]["body"]


@pytest.mark.asyncio
async def test_the_refusal_note_never_becomes_the_tasks_plan(client):
    """Posted as the assignee, the note is its earliest message and so its plan; with no
    author the assignee's real plan is still the plan and task autonomy still approves it."""
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    tid = project.tasks["a"]
    candidate = {"agent_id": project.ann, "alias": "Ann", "context_task_id": tid}
    posts = []
    nw._REFUSALS[project.ann] = ("Only an active AI teammate can start Workflow work", "Assign the task to an active AI agent.")
    assert nw.announce_refusal("http://x", candidate, lambda url, body: posts.append(body), quiet=True)
    (note,) = posts
    assert (await client.post(f"/api/tasks/{tid}/messages", json=note)).status_code == 201
    with db_cursor() as (_, cur):
        cur.execute("UPDATE tasks SET status='in_progress', autonomy='on' WHERE id=%s", (tid,))
    plan = await client.post(f"/api/tasks/{tid}/messages",
                             json={"author_agent_id": project.ann, "body": "Plan: do the work."})
    assert plan.status_code == 201 and plan.json()["plan_auto_approved"] is True


def test_abort_and_confirm_exit_also_send_no_credential(monkeypatch):
    seen = []
    monkeypatch.setattr(nw, "runner_post", lambda url, body, headers: seen.append(headers) or {"state": "aborted"})
    assert nw.abort_reserved({"agent_id": "a", "api_base": "http://x", "run_id": "r"})

    class Done:
        def poll(self):
            return 0
    assert nw.confirm_exit("http://x", "a", {"workflow": True, "proc": Done(), "run_id": "r", "workflow_generation": 1})
    assert seen == [{}, {}]


# --- A new event continues a turn whose worker stopped to wait (task 521272c5) ----------
#
# The worker started the task, asked a question and exited; confirm-stopped keeps the turn.
# The answer (or a thread message) must wake the agent by CONTINUING that turn: a fresh
# reserve is always refused while the turn is live, so the agent never woke.

async def stopped_turn(project, client):
    await project.start("serial", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    stopped = await client.post(f"/api/agents/{project.ann}/runs/{launch['run_id']}/confirm-stopped",
                                json={"generation": launch["generation"]})
    assert stopped.status_code == 200 and stopped.json()["state"] == "running", stopped.text
    return launch


async def ann_candidate(project, client):
    scan = await client.get(f"/api/containers/{project.cid}/wake-scan", params={"cooldown": 0, "min_idle": 0})
    assert scan.status_code == 200, scan.text
    return next(c for c in scan.json()["candidates"] if c["agent_id"] == project.ann)


async def notifier_launch(client, candidate, monkeypatch):
    """Send exactly what the notifier sends for this candidate to the real route."""
    sent = []
    monkeypatch.setattr(nw, "runner_post", lambda url, body, headers: sent.append((url, body)))
    assert nw.reserve_candidate("http://orcha", candidate) is None
    (url, body), = sent
    return await client.post(url.removeprefix("http://orcha"), json=body)


@pytest.mark.asyncio
@pytest.mark.parametrize("event", ["request_answered", "task_message"])
async def test_an_answer_or_thread_message_continues_the_stopped_workflow_turn(client, monkeypatch, event):
    project = Project(client)
    launch = await stopped_turn(project, client)
    tid = project.tasks["a"]
    if event == "request_answered":
        asked = await client.post(f"/api/containers/{project.cid}/requests", json={
            "requester_agent_id": project.ann, "payload": "Which file should I ship?", "type": "info",
            "target_alias": "Owner", "originating_task_id": tid, "expires_minutes": 60})
        assert asked.status_code == 201, asked.text
        answered = await client.post(f"/api/requests/{asked.json()['request_id']}/respond", headers=project.headers,
                                     json={"responder_agent_id": project.owner, "response": "The arm64 one."})
        assert answered.status_code == 200, answered.text
    else:
        await project.call("POST", f"/api/tasks/{tid}/messages",
                           {"author_agent_id": project.owner, "body": "Please carry on."}, 201)
    candidate = await ann_candidate(project, client)
    assert candidate["should_wake"] and candidate["latest_event"] == event
    assert candidate["context_task_id"] == tid and candidate["workflow_id"] == project.wid
    assert candidate["workflow_continue_run_id"] == launch["run_id"]
    continued = await notifier_launch(client, candidate, monkeypatch)
    assert continued.status_code == 201, continued.text
    assert continued.json()["task_id"] == tid and continued.json()["generation"] == launch["generation"] + 1
    await project.activate(project.ann, continued.json())  # the continued worker can start


@pytest.mark.asyncio
async def test_a_ready_task_still_reserves_a_fresh_turn(client, monkeypatch):
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    candidate = await ann_candidate(project, client)
    assert candidate["auto_start_task_ids"] == [project.tasks["a"]]
    assert "workflow_continue_run_id" not in candidate
    reserved = await notifier_launch(client, candidate, monkeypatch)
    assert reserved.status_code == 201 and reserved.json()["generation"] == 1, reserved.text


def unacked(aid, tid, event_name):
    with db_cursor() as (_, cur):
        cur.execute("""SELECT count(*) AS n FROM agent_events e
                       WHERE e.event_key=%s AND e.event_name=%s AND e.payload->>'task_id'=%s
                         AND NOT EXISTS (SELECT 1 FROM agent_event_acks k WHERE k.agent_id=%s AND k.event_id=e.id)""",
                    (aid, event_name, tid, aid))
        return cur.fetchone()["n"]


@pytest.mark.asyncio
async def test_starting_the_turn_consumes_task_ready_so_the_agent_is_not_rewoken_without_a_task(client):
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    tid = project.tasks["a"]
    assert unacked(project.ann, tid, "task_ready") >= 1  # what used to re-wake Ann every minute
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    assert unacked(project.ann, tid, "task_ready") == 0
    assert unacked(project.ann, tid, "task_assigned") == 0
    await client.post(f"/api/agents/{project.ann}/runs/{launch['run_id']}/confirm-stopped",
                      json={"generation": launch["generation"]})
    candidate = await ann_candidate(project, client)
    assert not candidate["should_wake"] and candidate["pending_events"] == 0, candidate["reason"]


@pytest.mark.asyncio
@pytest.mark.parametrize("worker_exited,why", [
    (False, "A stop was requested for this task"),  # stop while the worker still runs
    (True, "The task's turn has already ended"),  # a stop after the exit releases the turn
])
async def test_a_refused_continuation_names_the_gate_that_refused_it(client, worker_exited, why):
    project = Project(client)
    if worker_exited:
        launch = await stopped_turn(project, client)
    else:
        await project.start("serial", [("a", project.ann, [])])
        launch = await project.reserve(project.ann, "a")
        await project.activate(project.ann, launch)
    detail = await project.detail(project.wid)
    task = detail["tasks"][0]
    await project.call("POST", f"/api/tasks/{task['id']}/stop",
                       project.mutation(detail, expected_work_revision=task["work_revision"]))
    refused = await client.post(f"/api/agents/{project.ann}/runs/{launch['run_id']}/continue-reserve",
                                json={"operation_key": uid()})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "continuation_not_allowed"
    assert why in refused.json()["detail"]["message"]


def test_a_not_eligible_refusal_shows_the_specific_blocker_not_the_generic_one(monkeypatch):
    def reject(url, body, headers):
        raise urllib.error.HTTPError(url, 409, "no", {}, io.BytesIO(json.dumps({"detail": {
            "code": "not_eligible", "message": "The task cannot take a turn yet.", "blockers": [
                {"code": "task_not_waiting", "message": "This task is not waiting to take a turn."},
                {"code": "reservation_live", "message": "The previous turn has not been released."}]}}).encode()))
    monkeypatch.setattr(nw, "runner_post", reject)
    candidate = {"agent_id": uid(), "alias": "Ann", "context_task_id": "task-1"}
    assert nw.reserve_candidate("http://x", candidate) is None
    posts = []
    assert nw.announce_refusal("http://x", candidate, lambda url, body: posts.append(body), quiet=True)
    assert "The task cannot take a turn yet: The previous turn has not been released" in posts[0]["body"]
    assert "not waiting" not in posts[0]["body"]


def test_a_refusal_reaches_the_notifier_log_in_quiet_mode_once_per_reason(monkeypatch):
    monkeypatch.setattr(nw, "_LOGGED", {})
    candidate = {"agent_id": uid(), "alias": "Ann", "context_task_id": "task-1"}
    lines = []

    def refuse(reason):
        nw._refuse(candidate["agent_id"], reason, "Fix it.")
        nw.announce_refusal("http://x", candidate, lambda url, body: None, quiet=True, log=lines.append)

    refuse("This task is on hold")
    refuse("This task is on hold")  # the next scan, 20 seconds later
    assert len(lines) == 1 and "Ann: Workflow task task-1 not launched: This task is on hold. Fix it." in lines[0]
    refuse("The workflow is not active")  # a new reason is news
    assert len(lines) == 2


def test_a_workflow_task_on_a_terminal_session_is_announced_not_silently_dropped(monkeypatch):
    """No lease was claimed, so nothing is acked or released (a resident may hold the lease)."""
    from types import SimpleNamespace
    from orcha_cli import notifier_wake_candidate
    monkeypatch.setattr(nw, "_LOGGED", {})
    posts, lines = [], []
    services = SimpleNamespace(
        build_wake_prompt=lambda c: "work", select_transport=lambda c: "tmux", derive_wake_event=lambda c: "task_message",
        _post_json=lambda url, body: posts.append((url, body)), _lifecycle_log=lines.append)
    candidate = {"agent_id": uid(), "alias": "Ann", "should_wake": True, "context_task_id": "task-1",
                 "workflow_id": "wf", "reason": "1 pending event"}
    context = {"agent_hold_until": {}, "hold_now": 0}
    for _ in range(2):
        assert notifier_wake_candidate.process_candidate(
            "http://x", candidate, context=context, dry_run=False, quiet=True, lease_ttl=60,
            live_workers={}, services=services) is None
    assert [url for url, _ in posts] == ["http://x/api/tasks/task-1/messages"]  # one note, no wake-ack
    assert "open terminal session" in posts[0][1]["body"]
    assert len(lines) == 1 and "open terminal session" in lines[0]


# --- A notifier restart must not strand a Workflow turn (task 4dab637d) -----------------
#
# Dana's worker started, the notifier restarted, so nobody tracked her process any more. It
# finished by itself; the orphan sweep later found the pid gone and marked the run Killed,
# but nothing told the Workflow turn its worker was gone. The turn stayed live, and the
# owner's plan rejection could only be refused ("The previous turn has not been released").

import asyncio

from orcha_cli import notifier, notifier_orphan_cleanup

DEAD = False


def bridge(client, monkeypatch, *, pid_alive):
    """Point the notifier's sweep and launcher at the real routes (sync code -> ASGI app)."""
    loop = asyncio.get_running_loop()

    def call(method, url, body=None):
        path = url.removeprefix("http://orcha")
        return asyncio.run_coroutine_threadsafe(client.request(method, path, json=body), loop).result(30)

    def get_json(url, **_):
        response = call("GET", url)
        return response.json() if response.status_code < 400 else None

    def post_json(url, body=None, **_):
        response = call("POST", url, body or {})
        return response.json() if response.status_code < 400 else None

    def runner_post(url, body, headers):
        response = call("POST", url, body)
        if response.status_code >= 400:
            raise urllib.error.HTTPError(url, response.status_code, "refused", {}, io.BytesIO(response.content))
        return response.json()

    monkeypatch.setattr(notifier, "_get_json", get_json)
    monkeypatch.setattr(notifier, "_post_json", post_json)
    monkeypatch.setattr(nw, "runner_post", runner_post)
    monkeypatch.setattr(notifier._sandbox, "managed_containers", lambda cid: [])
    monkeypatch.setattr(notifier, "_run_pid_alive", lambda pid: pid_alive)


async def sweep(project):
    return await asyncio.to_thread(
        notifier.reap_orphaned_runs, "http://orcha", project.cid, sandbox_enabled=False, quiet=True)


async def reject_plan(project, tid):
    return await project.call("POST", "/api/decisions", {
        "subject_type": "plan_approval", "subject_id": tid, "decision": "reject",
        "reason": "Please redo the plan", "actor_agent_id": project.owner, "target_agent_id": project.ann}, 201)


@pytest.mark.asyncio
async def test_a_plan_rejection_wakes_the_agent_after_the_orphan_sweep_ended_its_run(client, monkeypatch):
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    bridge(client, monkeypatch, pid_alive=False)  # the notifier restarted; the worker's pid is gone
    assert await sweep(project) == 1
    tid = project.tasks["a"]
    await reject_plan(project, tid)

    candidate = await ann_candidate(project, client)
    assert candidate["should_wake"] and candidate["latest_event"] == "decision_made"
    launched = await notifier_launch(client, candidate, monkeypatch)
    assert launched.status_code == 201, launched.text
    assert launched.json()["task_id"] == tid and launched.json()["generation"] == launch["generation"] + 1


@pytest.mark.asyncio
async def test_a_run_an_older_sweep_already_ended_is_healed_by_the_next_sweep(client, monkeypatch):
    # Dana's live case: the run is already stamped Killed but its turn never heard about it.
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    bridge(client, monkeypatch, pid_alive=False)
    refused = []
    real_confirm = notifier_orphan_cleanup._confirm_workflow_stop
    monkeypatch.setattr(notifier_orphan_cleanup, "_confirm_workflow_stop",
                        lambda api_base, row: refused.append(row["run_id"]) or False)
    assert await sweep(project) == 1  # an older daemon: finished the run, told the turn nothing
    tid = project.tasks["a"]
    await reject_plan(project, tid)
    stuck = await ann_candidate(project, client)
    assert refused == [launch["run_id"]] and "workflow_continue_run_id" not in stuck

    monkeypatch.setattr(notifier_orphan_cleanup, "_confirm_workflow_stop", real_confirm)
    assert await sweep(project) == 0  # nothing left to finish, but the stop is now confirmed
    candidate = await ann_candidate(project, client)
    assert candidate["workflow_continue_run_id"] == launch["run_id"]
    launched = await notifier_launch(client, candidate, monkeypatch)
    assert launched.status_code == 201, launched.text
    assert launched.json()["generation"] == launch["generation"] + 1


@pytest.mark.asyncio
async def test_a_worker_that_may_still_be_running_is_never_confirmed_or_relaunched(client, monkeypatch):
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    bridge(client, monkeypatch, pid_alive=True)  # the pid still answers: maybe still working
    assert await sweep(project) == 0
    await reject_plan(project, project.tasks["a"])
    candidate = await ann_candidate(project, client)
    # The decision waits for the live turn: no launch of the task, and it is not consumed.
    assert "workflow_continue_run_id" not in candidate and "workflow_id" not in candidate
    assert not candidate["should_wake"], candidate["reason"]
    with db_cursor() as (_, cur):
        cur.execute("SELECT id FROM agent_events WHERE event_key=%s AND event_name='decision_made'",
                    (project.ann,))
        decision = {r["id"] for r in cur.fetchall()}
    assert decision and not decision & set(candidate["handled_event_ids"])
    refused = await project.reserve(project.ann, "a", expect=409)
    assert "reservation_live" in json.dumps(refused)


from datetime import timedelta

from portal_backend.workflow_scheduling import _time


async def task_row(project, tid):
    return next(t for t in (await project.detail(project.wid))["tasks"] if t["id"] == tid)


@pytest.mark.asyncio
async def test_a_turn_nobody_can_confirm_shows_why_and_offers_release_after_the_quiet_period(client, monkeypatch):
    # No notifier can confirm the exit (here: an older daemon ended the run and told the turn
    # nothing, and no later sweep confirms it). The owner sees why, and one Release appears
    # after the usual 30 quiet minutes, never earlier.
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    bridge(client, monkeypatch, pid_alive=False)
    monkeypatch.setattr(notifier_orphan_cleanup, "_confirm_workflow_stop", lambda api_base, row: False)
    assert await sweep(project) == 1
    tid = project.tasks["a"]

    row = await task_row(project, tid)
    assert row["display_state"]["label"] == "Worker ended, stop not confirmed"
    assert row["display_state"]["release_available"] is False
    assert row["display_state"]["release_available_at"]
    detail = await project.detail(project.wid)
    early = await client.post(f"/api/tasks/{tid}/release-lost-worker", headers=project.headers,
                              json=project.mutation(detail, expected_work_revision=row["work_revision"]))
    assert early.status_code == 409 and "release_not_yet_available" in early.text

    with db_cursor() as (_, cur):  # 31 minutes pass with no word from the worker
        cur.execute("SELECT ended_at FROM worker_runs WHERE run_id=%s", (launch["run_id"],))
        ended = _time(cur.fetchone()["ended_at"])
        cur.execute("UPDATE worker_runs SET ended_at=%s WHERE run_id=%s",
                    (ended - timedelta(minutes=31), launch["run_id"]))
        cur.execute("UPDATE workflow_executions SET last_runner_contact_at=%s WHERE run_id=%s",
                    (ended - timedelta(minutes=31), launch["run_id"]))
    row = await task_row(project, tid)
    assert row["display_state"]["label"] == "Worker ended, stop not confirmed - release available"
    assert row["display_state"]["release_available"] is True
    detail = await project.detail(project.wid)
    await project.call("POST", f"/api/tasks/{tid}/release-lost-worker",
                       project.mutation(detail, expected_work_revision=row["work_revision"]))
    row = await task_row(project, tid)
    assert row["status"] == "not_ready" and row["awaiting_owner_decision"] == "worker_released"


@pytest.mark.asyncio
async def test_a_running_worker_is_never_offered_release(client):
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    row = await task_row(project, project.tasks["a"])
    assert row["display_state"]["label"] == "Running"
    assert row["display_state"]["release_available"] is False
    assert row["display_state"]["release_available_at"] is None


@pytest.mark.asyncio
async def test_a_turn_asked_to_stop_is_released_when_the_sweep_finds_its_worker_gone(client, monkeypatch):
    # Changes requested in review, or a stop, puts the turn in "stopping" and waits for the
    # worker to exit. If the notifier restarts first, the sweep's confirmation finishes it.
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    with db_cursor() as (_, cur):
        cur.execute("UPDATE workflow_executions SET state='stopping' WHERE run_id=%s", (launch["run_id"],))
    bridge(client, monkeypatch, pid_alive=False)
    assert await sweep(project) == 1
    with db_cursor() as (_, cur):
        cur.execute("SELECT state, worker_stopped_at FROM workflow_executions WHERE run_id=%s",
                    (launch["run_id"],))
        turn = cur.fetchone()
    assert turn["state"] == "released" and turn["worker_stopped_at"] is not None


@pytest.mark.asyncio
async def test_a_workflow_run_records_its_log_so_the_sweep_can_tell_a_normal_exit_from_a_crash(client, monkeypatch, tmp_path):
    # The worker shared its plan and exited normally while the notifier was restarting.
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    log = str(tmp_path / "ann.log")
    details = {"log_path": log, "worktree": None, "branch": None, "base_cwd": str(tmp_path), "runtime": "claude"}
    response = await client.post(f"/api/agents/{project.ann}/runs/{launch['run_id']}/activate",
                                 json={"permit": launch["permit"], "process_key": "p" * 32, "pid": 4242,
                                       "run_details": details})
    assert response.status_code == 200, response.text
    with db_cursor() as (_, cur):
        cur.execute("SELECT log_path, base_cwd, runtime FROM worker_runs WHERE run_id=%s", (launch["run_id"],))
        assert dict(cur.fetchone()) == {"log_path": log, "base_cwd": str(tmp_path), "runtime": "claude"}
    bridge(client, monkeypatch, pid_alive=False)
    monkeypatch.setattr(notifier, "_terminal_status", lambda path: "success" if path == log else None)
    assert await sweep(project) == 1
    with db_cursor() as (_, cur):
        cur.execute("SELECT status FROM worker_runs WHERE run_id=%s", (launch["run_id"],))
        assert cur.fetchone()["status"] == "exited"
    await reject_plan(project, project.tasks["a"])
    candidate = await ann_candidate(project, client)
    assert candidate["workflow_continue_run_id"] == launch["run_id"]


def test_the_bootstrap_forwards_run_details_to_activation():
    from orcha_cli import workflow_bootstrap

    sent = []
    config = {"run_id": "r", "agent_id": "a", "task_id": "t", "generation": 1, "permit": "x" * 32,
              "api_base": "http://orcha", "command": ["true"], "run_details": {"log_path": "/l"}}
    workflow_bootstrap.activate_and_exec(config, post=lambda url, body: sent.append(body) or None)
    assert sent[0]["run_details"] == {"log_path": "/l"}


@pytest.mark.asyncio
async def test_a_workflow_task_waiting_its_turn_does_not_swallow_the_agents_other_work(client, monkeypatch):
    """Code Reviewer case: a ready Workflow task that must wait (another task holds the
    serial turn) used to become the launch task, its reserve was refused, and the whole
    wake was dropped, so a review request addressed to the same agent never arrived."""
    project = Project(client)
    await project.start("serial", [("a", project.ann, []), ("c", project.bob, [])])
    await project.reserve(project.ann, "a")  # a holds the only serial turn
    asked = await client.post(f"/api/containers/{project.cid}/requests", json={
        "requester_agent_id": project.ann, "payload": "Please review my change.", "type": "task",
        "target_alias": "Bob", "expires_minutes": 60,
        "task": {"title": "Review", "definition_of_done": "reviewed", "priority": 10}})
    assert asked.status_code == 201, asked.text
    scan = await client.get(f"/api/containers/{project.cid}/wake-scan", params={"cooldown": 0, "min_idle": 0})
    bob = next(c for c in scan.json()["candidates"] if c["agent_id"] == project.bob)
    assert bob["should_wake"], bob["reason"]
    assert project.tasks["c"] not in bob["auto_start_task_ids"]  # it would be refused
    assert "workflow_id" not in bob  # so the wake is not a Workflow launch at all
    # The waiting task itself is still refused if anything does try to start it.
    assert blockers(await project.reserve(project.bob, "c", expect=409)) & {"workflow_turn", "reservation_live"}


async def test_a_message_on_a_workflow_task_waiting_its_turn_does_not_capture_the_wake(client, monkeypatch):
    """Live Code Reviewer case after the fix above: old "could not start" notes and nudges
    on its waiting Workflow task were directed messages, so the wake still bound to that
    task, the reserve was refused and every wake was dropped. The wake now binds to the
    agent's other work; the waiting task's rows stay pending for its own turn."""
    project = Project(client)
    await project.start("serial", [("a", project.ann, []), ("c", project.bob, [])])
    await project.reserve(project.ann, "a")  # a holds the only serial turn
    waiting = project.tasks["c"]
    await project.call("POST", f"/api/tasks/{waiting}/messages",
                       {"author_agent_id": project.owner, "body": "Any news on this one?"}, 201)
    asked = await client.post(f"/api/containers/{project.cid}/requests", json={
        "requester_agent_id": project.ann, "payload": "Please review my change.", "type": "task",
        "target_alias": "Bob", "expires_minutes": 60,
        "task": {"title": "Review", "definition_of_done": "reviewed", "priority": 10}})
    assert asked.status_code == 201, asked.text
    await project.call("POST", f"/api/tasks/{waiting}/messages",
                       {"author_agent_id": project.owner, "body": "Still waiting?"}, 201)
    scan = await client.get(f"/api/containers/{project.cid}/wake-scan", params={"cooldown": 0, "min_idle": 0})
    bob = next(c for c in scan.json()["candidates"] if c["agent_id"] == project.bob)
    assert bob["should_wake"], bob["reason"]
    assert "workflow_id" not in bob and bob["context_task_id"] != waiting
    assert bob["wake_task_id"] != waiting
    assert not any(waiting in m for m in bob["prompt_messages"])
    with db_cursor() as (_, cur):
        cur.execute("""SELECT e.id FROM agent_events e WHERE e.event_key=%s
                       AND e.event_name='task_message'""", (project.bob,))
        waiting_rows = {r["id"] for r in cur.fetchall()}
    assert waiting_rows
    assert not waiting_rows & set(bob["delivery_handled_event_ids"])
    assert not waiting_rows & set(bob["handled_event_ids"])
    assert blockers(await project.reserve(project.bob, "c", expect=409)) & {"workflow_turn", "reservation_live"}



async def _bob_candidate(client, project):
    scan = await client.get(f"/api/containers/{project.cid}/wake-scan", params={"cooldown": 0, "min_idle": 0})
    assert scan.status_code == 200, scan.text
    return next(c for c in scan.json()["candidates"] if c["agent_id"] == project.bob)


async def test_a_message_on_a_waiting_workflow_task_is_held_and_delivered_when_its_turn_comes(client):
    """Review of 16e5d3b9: an owner instruction on a Workflow task waiting for its turn was
    acknowledged and lost. It must neither wake the agent now nor be dropped: it is
    delivered with the task once the task can start."""
    project = Project(client)
    await project.start("serial", [("a", project.ann, []), ("b", project.bob, [])])
    launch = await project.reserve(project.ann, "a")
    waiting = project.tasks["b"]
    instruction = "Use the approved staging repository; do not publish to production."
    await project.call("POST", f"/api/tasks/{waiting}/messages",
                       {"author_agent_id": project.owner, "body": instruction}, 201)
    first = await _bob_candidate(client, project)
    assert not first["should_wake"], first["reason"]
    assert first["auto_start_task_ids"] == [] and first["context_task_id"] is None
    assert not any(instruction in m for m in first["prompt_messages"])
    await client.post(f"/api/agents/{project.bob}/events/ack-handled",
                      json={"event_ids": first["delivery_handled_event_ids"]})
    await client.post(f"/api/agents/{project.bob}/events/ack-handled",
                      json={"event_ids": first["handled_event_ids"]})
    assert not (await _bob_candidate(client, project))["should_wake"]
    # The predecessor finishes (isolated fixture), so b's turn comes.
    with db_cursor() as (_, cur):
        cur.execute("UPDATE workflow_executions SET state='released',worker_stopped_at=now(),released_at=now() "
                    "WHERE run_id=%s", (launch["run_id"],))
        cur.execute("UPDATE worker_runs SET status='exited',ended_at=now() WHERE run_id=%s", (launch["run_id"],))
        cur.execute("UPDATE tasks SET status='completed' WHERE id=%s", (project.tasks["a"],))
    second = await _bob_candidate(client, project)
    assert second["should_wake"] and waiting in second["auto_start_task_ids"]
    assert second["context_task_id"] == waiting
    assert any(instruction in m for m in second["prompt_messages"]), second["prompt_messages"]


@pytest.mark.parametrize("gate", ["prerequisite", "hold"])
async def test_a_message_on_a_blocked_workflow_task_does_not_capture_the_agents_other_work(client, gate):
    """Review of 16e5d3b9: only ready tasks were parked, so a message on a Workflow task
    still pending a prerequisite or held by a human still captured an unrelated wake and
    its refused reserve dropped it. Every Workflow task that cannot start is parked."""
    project = Project(client)
    await project.start("serial", [("a", project.ann, []),
                                   ("b", project.bob, ["a"] if gate == "prerequisite" else [])])
    await project.reserve(project.ann, "a")
    waiting = project.tasks["b"]
    if gate == "hold":
        detail = await project.detail(project.wid)
        row = next(t for t in detail["tasks"] if t["id"] == waiting)
        await project.call("POST", f"/api/tasks/{waiting}/hold",
                           project.mutation(detail, expected_work_revision=row["work_revision"]))
    await project.call("POST", f"/api/tasks/{waiting}/messages",
                       {"author_agent_id": project.owner, "body": "Keep this for when your turn starts."}, 201)
    asked = await client.post(f"/api/containers/{project.cid}/requests", json={
        "requester_agent_id": project.ann, "payload": "Please review my change.", "type": "task",
        "target_alias": "Bob", "expires_minutes": 60,
        "task": {"title": "Review", "definition_of_done": "reviewed", "priority": 10}})
    assert asked.status_code == 201, asked.text
    bob = await _bob_candidate(client, project)
    assert bob["should_wake"], bob["reason"]
    assert "workflow_id" not in bob and bob["context_task_id"] != waiting
    assert bob["wake_task_id"] != waiting
    # The gate itself is untouched: the blocked task is still refused.
    refused = await project.reserve(project.bob, "b", expect=409)
    assert refused["detail"]["code"] == "not_eligible", refused


async def test_a_held_backlog_does_not_fill_the_wake_batch_and_hide_later_work(client):
    """Review of abd6486d: held rows on a waiting Workflow task were filtered out only after
    the 24,000-character prompt budget and the 20-row manifest limit, so a long enough held
    backlog filled the batch, later actionable work was never collected, and every scan
    woke the agent with an empty prompt. Held rows are now skipped before both limits."""
    project = Project(client)
    await project.start("serial", [("a", project.ann, []), ("b", project.bob, [])])
    launch = await project.reserve(project.ann, "a")  # a holds the only serial turn
    waiting = project.tasks["b"]
    for n in range(110):
        await project.call("POST", f"/api/tasks/{waiting}/messages",
                           {"author_agent_id": project.owner, "body": f"Note {n} for later. " + "x" * 300}, 201)
    other = await client.post(f"/api/containers/{project.cid}/tasks", json={
        "title": "Other work", "definition_of_done": "done", "priority": 10, "assignee_alias": "Bob"})
    assert other.status_code == 201, other.text
    other_id = other.json().get("id") or other.json()["task_id"]
    with db_cursor() as (_, cur):
        cur.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (other_id,))
    instruction = "Please rename the release notes file before you push."
    await project.call("POST", f"/api/tasks/{other_id}/messages",
                       {"author_agent_id": project.owner, "body": instruction}, 201)

    first = await _bob_candidate(client, project)
    assert first["should_wake"], first["reason"]
    assert first["context_task_id"] == other_id
    assert any(instruction in m for m in first["prompt_messages"]), first["prompt_messages"]
    assert first["notifications"] and all(
        n.get("drain_task_id") != waiting for n in first["notifications"])
    with db_cursor() as (_, cur):
        cur.execute("""SELECT e.id, e.payload FROM agent_events e
                       WHERE e.event_key=%s AND e.event_name='task_message'""", (project.bob,))
        rows = cur.fetchall()
    held = {r["id"] for r in rows if str((r["payload"] or {}).get("task_id")) == waiting}
    actionable = {r["id"] for r in rows if str((r["payload"] or {}).get("task_id")) == other_id}
    assert len(held) == 110 and actionable
    handled = set(first["handled_event_ids"]) | set(first["delivery_handled_event_ids"])
    assert actionable <= handled and not held & handled
    await client.post(f"/api/agents/{project.bob}/events/ack-handled",
                      json={"event_ids": first["delivery_handled_event_ids"]})
    await client.post(f"/api/agents/{project.bob}/events/ack-handled",
                      json={"event_ids": first["handled_event_ids"]})
    # Nothing actionable is left, so no empty wake repeats while b waits.
    assert not (await _bob_candidate(client, project))["should_wake"]

    # b's turn comes: the held notes are still pending and are delivered to it.
    with db_cursor() as (_, cur):
        cur.execute("UPDATE workflow_executions SET state='released',worker_stopped_at=now(),released_at=now() "
                    "WHERE run_id=%s", (launch["run_id"],))
        cur.execute("UPDATE worker_runs SET status='exited',ended_at=now() WHERE run_id=%s", (launch["run_id"],))
        cur.execute("UPDATE tasks SET status='completed' WHERE id IN (%s,%s)", (project.tasks["a"], other_id))
    turn = await _bob_candidate(client, project)
    assert turn["should_wake"] and turn["context_task_id"] == waiting
    assert any("Note 0 for later." in m for m in turn["prompt_messages"]), turn["prompt_messages"][:2]


@pytest.mark.asyncio
@pytest.mark.parametrize("lease", ["none", "expired", "stale"])
async def test_a_live_workflow_turn_is_never_reaped_as_stranded_while_its_worker_works(client, monkeypatch, lease):
    # Dana's second case: the notifier restarted mid-turn, so nobody streamed her output or
    # held a lane lease. After 21 quiet minutes the server backstop marked her still-working
    # run Orphaned and revoked its credentials. A live turn's run belongs to the turn and the
    # host's pid sweep, which never ends a run whose process still answers.
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    launch = await project.reserve(project.ann, "a")
    await project.activate(project.ann, launch)
    with db_cursor() as (conn, cur):
        cur.execute("UPDATE worker_runs SET started_at=%s WHERE run_id=%s",
                    (sql.ago(2000), launch["run_id"]))
        if lease != "none":
            cur.execute("""INSERT INTO agent_wake_state
                           (agent_id,wake_lease_until,lease_kind,work_last_heartbeat_at,last_woken_at)
                           VALUES (%s,%s,'ephemeral',%s,%s)
                           ON CONFLICT (agent_id) DO UPDATE SET
                           wake_lease_until=EXCLUDED.wake_lease_until,
                           work_last_heartbeat_at=EXCLUDED.work_last_heartbeat_at,
                           last_woken_at=EXCLUDED.last_woken_at""",
                        (project.ann, sql.ago(60) if lease == "expired" else sql.from_now(300),
                         sql.ago(2000), sql.ago(2000)))
        conn.commit()
    reaped = await project.call("POST", f"/api/containers/{project.cid}/reap-orphan-leases")
    assert reaped["stranded"] == []
    with db_cursor() as (_, cur):
        cur.execute("SELECT status FROM worker_runs WHERE run_id=%s", (launch["run_id"],))
        assert cur.fetchone()["status"] == "running"
        cur.execute("SELECT revoked_at FROM embodiment_tokens WHERE run_id=%s", (launch["run_id"],))
        tokens = cur.fetchall()
        assert tokens and all(t["revoked_at"] is None for t in tokens)
        cur.execute("SELECT worker_stopped_at FROM workflow_executions WHERE run_id=%s", (launch["run_id"],))
        assert cur.fetchone()["worker_stopped_at"] is None
    refused = await project.reserve(project.ann, "a", expect=409)
    assert "reservation_live" in blockers(refused)
    candidate = await ann_candidate(project, client)
    assert candidate["embodiment_running"] and "reconcil" not in candidate["reason"], candidate["reason"]
    # Excluding silence-based cleanup must not strand the turn once the process dies.
    bridge(client, monkeypatch, pid_alive=False)
    assert await sweep(project) == 1
    await reject_plan(project, project.tasks["a"])
    continued = await notifier_launch(client, await ann_candidate(project, client), monkeypatch)
    assert continued.status_code == 201, continued.text
    await project.activate(project.ann, continued.json())
