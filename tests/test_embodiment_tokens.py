"""GH #91+#90 — embodiment tokens: the per-process WORK-lane capability gate.

A token is minted BEFORE a worker is spawned and injected into its env as ORCHA_RUN_TOKEN. The
WORK-lane-only task-lifecycle endpoints (/next, accept->working, /tasks/{id}/done, release) require
a valid, non-revoked, agent-matching, lane='work' token presented as the X-Orcha-Run-Token header.
A conversation-lane token (or a missing/unknown/revoked one) is refused 403 there — so a
conversation embodiment can DISPATCH a task but never silently OWN/complete it. Dispatch endpoints
(create task, create/answer/close request, post to a task thread) stay UNGATED.

The token is bound to its worker_run row at run-create, and the SERVER revokes it on every
run-terminal transition (finish / orphan / reap) so revocation survives daemon turnover.
"""
import pytest

pytestmark = pytest.mark.asyncio

HDR = "X-Orcha-Run-Token"


async def _mint(client, aid, lane, kind="headless"):
    r = await client.post(f"/api/agents/{aid}/embodiment-tokens",
                          json={"lane": lane, "kind": kind})
    assert r.status_code in (200, 201), r.text
    return r.json()["run_token"]


# ---------- mint + revoke ----------

async def test_mint_returns_token(client, make_agent):
    a = await make_agent("A")
    tok = await _mint(client, a["agent_id"], "work")
    assert isinstance(tok, str) and len(tok) > 20


async def test_revoke_is_idempotent(client, make_agent):
    a = await make_agent("A")
    tok = await _mint(client, a["agent_id"], "work")
    r1 = await client.post(f"/api/embodiment-tokens/{tok}/revoke")
    assert r1.status_code == 200 and r1.json()["revoked"] is True
    r2 = await client.post(f"/api/embodiment-tokens/{tok}/revoke")   # already revoked
    assert r2.status_code == 200 and r2.json()["revoked"] is False


# ---------- the /next gate (representative WORK-lane endpoint) ----------

async def test_next_allows_work_token(client, make_agent, make_task):
    a = await make_agent("A")
    aid = a["agent_id"]
    await make_task("do it", "done", assignee_alias="A")
    tok = await _mint(client, aid, "work")
    r = await client.post(f"/api/agents/{aid}/next", headers={HDR: tok})
    assert r.status_code == 200, r.text


async def test_next_refuses_conversation_token(client, make_agent, make_task):
    a = await make_agent("A")
    aid = a["agent_id"]
    await make_task("do it", "done", assignee_alias="A")
    tok = await _mint(client, aid, "conversation")
    r = await client.post(f"/api/agents/{aid}/next", headers={HDR: tok})
    assert r.status_code == 403, r.text


async def test_next_refuses_missing_token(client, make_agent, make_task):
    a = await make_agent("A")
    aid = a["agent_id"]
    await make_task("do it", "done", assignee_alias="A")
    r = await client.post(f"/api/agents/{aid}/next")   # no header
    assert r.status_code == 403, r.text


async def test_next_refuses_revoked_token(client, make_agent, make_task):
    a = await make_agent("A")
    aid = a["agent_id"]
    await make_task("do it", "done", assignee_alias="A")
    tok = await _mint(client, aid, "work")
    await client.post(f"/api/embodiment-tokens/{tok}/revoke")
    r = await client.post(f"/api/agents/{aid}/next", headers={HDR: tok})
    assert r.status_code == 403, r.text


async def test_next_refuses_other_agents_token(client, make_agent, make_task):
    a = await make_agent("A")
    b = await make_agent("B")
    await make_task("do it", "done", assignee_alias="A")
    tok_b = await _mint(client, b["agent_id"], "work")   # B's token, used on A's /next
    r = await client.post(f"/api/agents/{a['agent_id']}/next", headers={HDR: tok_b})
    assert r.status_code == 403, r.text


# ---------- dispatch endpoints stay OPEN to a conversation token ----------

async def test_conversation_token_can_dispatch_a_task(client, make_agent, container):
    """The whole point of #91/#90: a conversation lane MUST be able to create+assign a task."""
    a = await make_agent("A")
    aid = a["agent_id"]
    tok = await _mint(client, aid, "conversation")
    r = await client.post(
        f"/api/containers/{container['id']}/tasks",
        json={"title": "background work", "definition_of_done": "posted to thread",
              "assignee_alias": "A", "created_by_agent_id": aid},
        headers={HDR: tok})
    assert r.status_code == 201, r.text   # dispatch is ungated even under a conv token


# ---------- server revokes the token when the run terminalizes ----------

async def test_finish_run_revokes_bound_token(client, make_agent, db):
    a = await make_agent("A")
    aid = a["agent_id"]
    tok = await _mint(client, aid, "work")
    # bind the token to a run at run-create (what the daemon does with token_id)
    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "lane": "work",
                                "token_id": tok, "pid": 4321})
    assert r.status_code == 201, r.text
    run_id = r.json()["run_id"]
    # token still valid before finish
    rows = db.execute("SELECT revoked_at FROM embodiment_tokens WHERE run_token=%s", (tok,))
    assert rows and rows[0]["revoked_at"] is None
    # finishing the run revokes the token server-side
    fin = await client.post(f"/api/runs/{run_id}/finish", json={"status": "exited", "exit_code": 0})
    assert fin.status_code == 200, fin.text
    rows = db.execute("SELECT revoked_at FROM embodiment_tokens WHERE run_token=%s", (tok,))
    assert rows and rows[0]["revoked_at"] is not None
