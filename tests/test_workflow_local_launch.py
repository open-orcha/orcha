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
