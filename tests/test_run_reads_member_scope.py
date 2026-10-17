"""Run-output reads are project-scoped under proxy trust (V2 integration, A.md "From E").

GET /api/agents/{aid}/runs, GET /api/tasks/{tid}/runs and the SSE
GET /api/agents/{aid}/runs/{rid}/stream used to call only require_agent/require_task, so on
a trusted-proxy (cloud) deployment a verified non-member who knew an agent/task UUID could
read another project's run output. They now run the same require_member_read gate the
conversation/snapshot reads use:

  * trusted member            -> 200 (unchanged)
  * trusted non-member        -> 403 "not a member of this project"
  * trust off / no header     -> unchanged (self-host, in-stack notifier/daemon callers)
"""
import pytest

OCTO = {"X-Auth-Request-User": "octocat"}      # bound owner of the project
MALLORY = {"X-Auth-Request-User": "mallory"}   # verified stranger


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _arena(client, container, make_agent, make_task, db):
    await make_agent("root", "operator", kind="human")
    ai = await make_agent("bot", "worker", kind="ai")
    t = await make_task("do it", "done")
    run = db.execute(
        """INSERT INTO worker_runs (agent_id, task_id, status, started_at)
           VALUES (%s, %s, 'exited', now()) RETURNING run_id""",
        (ai["agent_id"], t["id"]),
    )[0]["run_id"]
    db.execute(
        "INSERT INTO worker_run_tasks (run_id, task_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (run, t["id"]),
    )
    return ai["agent_id"], t["id"], str(run)


async def _bind_owner(client, container):
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    assert r.json()["identity"]["member_role"] == "owner"


async def test_trusted_non_member_cannot_read_runs(
    client, container, make_agent, make_task, db, trust_proxy
):
    aid, tid, _ = await _arena(client, container, make_agent, make_task, db)
    await _bind_owner(client, container)

    for url in (f"/api/agents/{aid}/runs", f"/api/tasks/{tid}/runs"):
        r = await client.get(url, headers=MALLORY)
        assert r.status_code == 403 and "not a member of this project" in r.text, (url, r.text)


async def test_trusted_non_member_cannot_open_run_stream(
    client, container, make_agent, make_task, db, trust_proxy
):
    aid, _, run = await _arena(client, container, make_agent, make_task, db)
    await _bind_owner(client, container)
    r = await client.get(f"/api/agents/{aid}/runs/{run}/stream", headers=MALLORY)
    assert r.status_code == 403 and "not a member of this project" in r.text


async def test_trusted_member_reads_runs(
    client, container, make_agent, make_task, db, trust_proxy
):
    aid, tid, run = await _arena(client, container, make_agent, make_task, db)
    await _bind_owner(client, container)
    r = await client.get(f"/api/agents/{aid}/runs", headers=OCTO)
    assert r.status_code == 200, r.text
    assert [x["run_id"] for x in r.json()["runs"]] == [run]
    r = await client.get(f"/api/tasks/{tid}/runs", headers=OCTO)
    assert r.status_code == 200, r.text
    assert [x["run_id"] for x in r.json()["runs"]] == [run]


async def test_trust_off_and_no_header_unchanged(
    client, container, make_agent, make_task, db, no_trust_proxy, monkeypatch
):
    aid, tid, run = await _arena(client, container, make_agent, make_task, db)
    # trust off: any header is inert
    r = await client.get(f"/api/agents/{aid}/runs", headers=MALLORY)
    assert r.status_code == 200, r.text
    # trust on, no header (in-stack caller / break-glass token): still readable
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    r = await client.get(f"/api/tasks/{tid}/runs")
    assert r.status_code == 200, r.text
    assert [x["run_id"] for x in r.json()["runs"]] == [run]
