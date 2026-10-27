"""A local human starts a Workflow and each eligible assigned task launches by itself.

Real routes and the production hooks (no stand-ins): the local-human lane starts the
Workflow, the notifier registers its own launcher credential on a native project, and
the runner reserves the task. Every gate that must still refuse an invalid launch is
asserted through the same reserve route.
"""

import json
import pathlib
import sqlite3
import urllib.error
from uuid import uuid4

import pytest

from orcha_cli import notifier_workflow as nw
from orcha_cli import workflow_runner_provision as provision
from portal_backend import workflow_service as ws
from portal_backend.database import db_cursor
from portal_backend.workflow_worker_launch import digest

SQLITE_ONLY = pytest.mark.skipif(
    __import__("os").environ.get("ORCHA_TEST_BACKEND", "sqlite") != "sqlite",
    reason="local provisioning writes the native SQLite file",
)


def uid():
    return str(uuid4())


@pytest.fixture(autouse=True)
def local_lane(monkeypatch):
    monkeypatch.setattr(ws, "WORKFLOWS_INTEGRATED", True)
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    monkeypatch.delenv("ORCHA_BIND", raising=False)
    monkeypatch.delenv("ORCHA_WORKFLOW_RUNNER_CREDENTIALS", raising=False)
    monkeypatch.setattr(nw, "_PROVISIONED", {})
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

    def register(self, aid, secret="launcher-secret-for-tests"):
        with db_cursor() as (_, cur):
            cur.execute(
                "INSERT INTO workflow_runner_credentials(id,container_id,agent_id,runner_instance,token_sha256)"
                " VALUES (%s,%s,%s,'test',%s)", (uid(), self.cid, aid, digest(secret)))
        return secret

    async def reserve(self, aid, key, secret, expect=201):
        detail = await self.detail(self.wid)
        tid = self.tasks[key]
        task = next(t for t in detail["tasks"] if t["id"] == tid)
        response = await self.client.post(
            f"/api/agents/{aid}/runs/reserve",
            json={"task_id": tid, "expected_workflow_revision": detail["revision"],
                  "expected_work_revision": task["work_revision"], "operation_key": uid()},
            headers={"X-Orcha-Runner-Token": secret})
        assert response.status_code == expect, (key, response.status_code, response.text)
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
    secret = project.register(project.ann)
    reserved = await project.reserve(project.ann, "a", secret)
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
    ann, bob = project.register(project.ann), project.register(project.bob, "bob-launcher-secret")
    assert "prerequisites" in blockers(await project.reserve(project.bob, "b", bob, 409))
    await project.reserve(project.ann, "a", ann)
    # Task a holds the only serial turn, so the independent task c must wait too.
    assert blockers(await project.reserve(project.bob, "c", bob, 409)) & {"workflow_turn", "reservation_live"}


@pytest.mark.asyncio
async def test_parallel_launches_independent_tasks_of_different_agents_together(client):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, []), ("b", project.bob, [])])
    ann, bob = project.register(project.ann), project.register(project.bob, "bob-launcher-secret")
    await project.reserve(project.ann, "a", ann)
    await project.reserve(project.bob, "b", bob)


@pytest.mark.asyncio
@pytest.mark.parametrize("gate,code", [
    ("hold", "human_hold"), ("paused", "workflow_not_active"), ("cancelled", "workflow_not_active"),
    ("completed", "task_not_waiting"), ("inactive_project", "project_not_active"),
    ("limit", "limit_reached"),
])
async def test_gates_that_must_still_refuse_a_launch(client, gate, code):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, [])])
    secret = project.register(project.ann)
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
    refused = await project.reserve(project.ann, "a", secret, 409)
    assert refused["detail"]["code"] == "not_eligible" and code in blockers(refused)


@pytest.mark.asyncio
async def test_a_retired_agent_cannot_launch(client):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, [])])
    secret = project.register(project.ann)
    with db_cursor() as (_, cur):
        cur.execute("UPDATE agents SET terminated_at=%s WHERE id=%s", (ws.sql.utcnow(), project.ann))
    refused = await project.reserve(project.ann, "a", secret, 403)
    assert refused["detail"]["code"] == "runner_credential_invalid"


@pytest.mark.asyncio
async def test_reserve_still_needs_a_valid_credential_for_that_agent(client):
    project = Project(client)
    await project.start("parallel", [("a", project.ann, [])])
    body = {"task_id": project.tasks["a"], "expected_workflow_revision": 1, "expected_work_revision": 1, "operation_key": uid()}
    missing = await client.post(f"/api/agents/{project.ann}/runs/reserve", json=body)
    assert missing.status_code == 403 and missing.json()["detail"]["code"] == "runner_credential_required"
    wrong_agent = project.register(project.bob, "bobs-secret")
    stolen = await client.post(f"/api/agents/{project.ann}/runs/reserve", json=body,
                               headers={"X-Orcha-Runner-Token": wrong_agent})
    assert stolen.status_code == 403 and stolen.json()["detail"]["code"] == "runner_credential_invalid"


# --- Local provisioning (native SQLite projects) ---------------------------------------

def native_project(tmp_path, api_base="http://127.0.0.1:8123"):
    db = pathlib.Path(__import__("os").environ["ORCHA_DB_PATH"])
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(
        {"runtime": "native", "api_base_url": api_base, "db_path": str(db)}))
    return tmp_path, api_base


def credential_rows(agent_id):
    with db_cursor() as (_, cur):
        cur.execute("SELECT token_sha256, revoked_at, runner_instance FROM workflow_runner_credentials WHERE agent_id=%s",
                    (agent_id,))
        return cur.fetchall()


@SQLITE_ONLY
@pytest.mark.asyncio
async def test_notifier_registers_its_own_launcher_credential_and_the_task_reserves(client, tmp_path):
    root, api_base = native_project(tmp_path)
    project = Project(client)
    await project.start("serial", [("a", project.ann, [])])
    assert credential_rows(project.ann) == []
    candidate = {"agent_id": project.ann, "headless_cwd": str(root)}
    secret = provision.ensure_secret(candidate["headless_cwd"], api_base, project.ann)
    assert [r["token_sha256"] for r in credential_rows(project.ann)] == [provision.digest(secret)]
    cache = root / ".orcha" / provision.CACHE_NAME
    assert (cache.stat().st_mode & 0o777) == 0o600 and json.loads(cache.read_text()) == {project.ann: secret}
    assert provision.ensure_secret(str(root), api_base, project.ann) == secret  # idempotent
    assert len(credential_rows(project.ann)) == 1
    await project.reserve(project.ann, "a", secret)


@SQLITE_ONLY
def test_reserve_candidate_provisions_when_no_credential_is_configured(tmp_path, monkeypatch):
    root, api_base = native_project(tmp_path)
    aid = uid()
    seen = {}
    monkeypatch.setattr(provision, "ensure_secret", lambda cwd, base, agent: seen.setdefault("secret", "s" * 43))
    monkeypatch.setattr(nw, "runner_post", lambda url, body, headers: (
        seen.update(headers=headers) or {"task_id": body["task_id"], "permit": "p", "run_id": "r"}))
    launch = nw.reserve_candidate(api_base, {"agent_id": aid, "headless_cwd": str(root), "context_task_id": "t1"})
    assert launch["run_id"] == "r" and seen["headers"] == {"X-Orcha-Runner-Token": "s" * 43}
    assert nw.runner_secret(aid) == "s" * 43  # abort/confirm reuse it


@SQLITE_ONLY
@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["docker_or_hosted", "other_project", "human_agent", "retired_agent"])
async def test_provisioning_refuses_when_it_is_not_a_live_ai_agent_on_this_project(client, tmp_path, case):
    root, api_base = native_project(tmp_path)
    project = Project(client)
    target = {"docker_or_hosted": project.ann, "other_project": project.ann,
              "human_agent": project.owner, "retired_agent": project.bob}[case]
    start = str(root)
    if case == "docker_or_hosted":
        (root / ".claude" / "orcha.json").write_text(json.dumps({"runtime": "docker", "api_base_url": api_base}))
    elif case == "other_project":
        api_base = "http://127.0.0.1:9999"
    elif case == "retired_agent":
        with db_cursor() as (_, cur):
            cur.execute("UPDATE agents SET terminated_at=%s WHERE id=%s", (ws.sql.utcnow(), project.bob))
    with pytest.raises(provision.Unavailable) as refused:
        provision.ensure_secret(start, api_base, target)
    assert refused.value.reason and refused.value.fix
    assert credential_rows(target) == []


@SQLITE_ONLY
@pytest.mark.asyncio
async def test_a_revoked_launcher_credential_is_not_replaced_and_a_lost_row_is_re_registered(client, tmp_path):
    root, api_base = native_project(tmp_path)
    project = Project(client)
    secret = provision.ensure_secret(str(root), api_base, project.ann)
    with db_cursor() as (_, cur):
        cur.execute("UPDATE workflow_runner_credentials SET revoked_at=%s WHERE agent_id=%s",
                    (ws.sql.utcnow(), project.ann))
    with pytest.raises(provision.Unavailable, match="revoked"):
        provision.ensure_secret(str(root), api_base, project.ann)
    assert len(credential_rows(project.ann)) == 1
    with db_cursor() as (_, cur):
        cur.execute("DELETE FROM workflow_runner_credentials WHERE agent_id=%s", (project.ann,))
    again = provision.ensure_secret(str(root), api_base, project.ann)
    assert again != secret and len(credential_rows(project.ann)) == 1


# --- Refusals are visible ---------------------------------------------------------------

def test_a_refused_launch_tells_the_task_thread_once_with_the_fix(monkeypatch):
    aid = uid()
    candidate = {"agent_id": aid, "alias": "Ann", "context_task_id": "task-1", "headless_cwd": "/nonexistent"}
    posts = []
    assert nw.reserve_candidate("http://127.0.0.1:8123", candidate) is None
    assert nw.announce_refusal("http://x", candidate, lambda url, body: posts.append((url, body)), quiet=True)
    (url, body), = posts
    assert url == "http://x/api/tasks/task-1/messages" and body["author_agent_id"] == aid
    assert "could not start this task automatically" in body["body"] and "ORCHA_WORKFLOW_RUNNER_CREDENTIALS" in body["body"]
    nw.reserve_candidate("http://127.0.0.1:8123", candidate)  # still broken a moment later
    assert not nw.announce_refusal("http://x", candidate, lambda url, body: posts.append(1), quiet=True)
    assert len(posts) == 1


def test_a_rejected_configured_credential_is_reported_not_swallowed(monkeypatch):
    aid = uid()
    monkeypatch.setenv("ORCHA_WORKFLOW_RUNNER_CREDENTIALS", json.dumps({aid: "stale"}))

    def reject(url, body, headers):
        raise urllib.error.HTTPError(url, 403, "no", {}, __import__("io").BytesIO(
            b'{"detail": {"code": "runner_credential_invalid"}}'))

    monkeypatch.setattr(nw, "runner_post", reject)
    candidate = {"agent_id": aid, "alias": "Ann", "context_task_id": "t"}
    assert nw.reserve_candidate("http://x", candidate) is None
    posts = []
    assert nw.announce_refusal("http://x", candidate, lambda url, body: posts.append(body), quiet=True)
    assert "does not accept the launcher credential" in posts[0]["body"]
