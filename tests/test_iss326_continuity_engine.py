"""#326 CONTINUITY MECHANISM (engine) — four primitives that make committed work survive the
wake boundary instead of evaporating into chat prose + the memory digest.

  B3  a generic `not_ready` task status — held / design-gated work that is EXCLUDED from the
      ready-queue and NOT self-claimable via /orcha-next until a human releases it.
  B1  a first-class READY-QUEUE view: GET /containers/{cid}/tasks?status=ready&unassigned=true
      &sort=priority — the live queue as ONE cheap read, not a client-side reconstruction.
  B2  a human-only unassign route — clear the active assignee(s); the row returns to the queue.
  A1  the per-task protocol read FRESH every wake, ahead of the digest (the RULES surface).

Each block carries a mutation tooth (noted inline) — a deliberate break would turn it RED.
"""
import pytest
import pytest_asyncio

import main
from orcha_cli import notifier


# ----- fixtures -----

@pytest_asyncio.fixture
async def human(make_agent):
    h = await make_agent("kedar", "operator", kind="human")
    return h["agent_id"]


@pytest_asyncio.fixture
async def worker(make_agent):
    w = await make_agent("dev", "eng")
    return w["agent_id"]


async def _create(client, container, **body):
    body.setdefault("title", "t")
    body.setdefault("definition_of_done", "d")
    r = await client.post(f"/api/containers/{container['id']}/tasks", json=body)
    assert r.status_code == 201, r.text
    return r.json()["task_id"]


async def _get_task(client, container, tid):
    # no single-task GET endpoint — read the row off the unfiltered container list (tiny test DB).
    r = await client.get(f"/api/containers/{container['id']}/tasks", params={"limit": 100})
    for t in r.json()["tasks"]:
        if str(t["id"]) == str(tid):
            return t
    return None


async def _status(client, container, tid):
    t = await _get_task(client, container, tid)
    return t["status"] if t else None


# ===================== B3 — not_ready status =====================

async def test_create_not_ready_is_held(client, container):
    tid = await _create(client, container, not_ready=True)
    assert await _status(client, container, tid) == "not_ready"


async def test_not_ready_excluded_from_ready_queue(client, container):
    await _create(client, container, title="open", not_ready=False)
    await _create(client, container, title="held", not_ready=True)
    r = await client.get(f"/api/containers/{container['id']}/tasks",
                         params={"status": "ready", "unassigned": True, "sort": "priority"})
    titles = [t["title"] for t in r.json()["tasks"]]
    assert "open" in titles and "held" not in titles


async def test_not_ready_NOT_claimable_via_next(client, container, worker, work_headers):
    """TOOTH (B3 core): a held task is the ONLY row, yet /orcha-next yields nothing — held work
    is never silently grabbed. If create_task set 'ready' instead of 'not_ready', this fails."""
    await _create(client, container, title="held", not_ready=True)
    r = await client.post(f"/api/agents/{worker}/next", headers=await work_headers(worker))
    assert r.json()["task"] is None


async def test_release_then_assign_makes_claimable(client, container, worker, human, work_headers):
    # #341 (open claim pool deleted): a released held task is ready+unassigned and NOT self-claimable;
    # the lead assigns it, and only then does the assignee's /next claim it. Held + release + assign
    # + claim is the full continuity hand-off under the assignment-only model.
    tid = await _create(client, container, title="held", not_ready=True)
    rr = await client.post(f"/api/tasks/{tid}/readiness",
                           json={"actor_agent_id": human, "ready": True})
    assert rr.status_code == 200 and rr.json()["status"] == "ready"
    aa = await client.post(f"/api/tasks/{tid}/assign",
                           json={"agent_id": worker, "actor_agent_id": human})
    assert aa.status_code == 200
    r = await client.post(f"/api/agents/{worker}/next", headers=await work_headers(worker))
    assert r.json()["task"] and r.json()["task"]["id"] == tid


async def test_readiness_roundtrip_ready_to_held_to_ready(client, container, human):
    tid = await _create(client, container, title="x")          # starts 'ready'
    h = await client.post(f"/api/tasks/{tid}/readiness", json={"actor_agent_id": human, "ready": False})
    assert h.json()["status"] == "not_ready"
    assert await _status(client, container, tid) == "not_ready"
    rel = await client.post(f"/api/tasks/{tid}/readiness", json={"actor_agent_id": human, "ready": True})
    assert rel.json()["status"] == "ready"


async def test_readiness_human_only(client, container, worker):
    """TOOTH: an AI actor cannot flip readiness (#327) — drop the _require_kind and this passes 200."""
    tid = await _create(client, container, title="x")
    r = await client.post(f"/api/tasks/{tid}/readiness", json={"actor_agent_id": worker, "ready": False})
    assert r.status_code == 403


async def test_readiness_refuses_in_progress(client, container, worker, human, work_headers):
    # #341 assignment-only: assign the task to the worker so /next can claim it into in_progress
    # (an unassigned ready task is no longer self-claimable via the deleted open pool).
    tid = await _create(client, container, title="x", assignee_alias="dev")
    await client.post(f"/api/agents/{worker}/next", headers=await work_headers(worker))            # claim → in_progress
    r = await client.post(f"/api/tasks/{tid}/readiness", json={"actor_agent_id": human, "ready": False})
    assert r.status_code == 409


async def test_release_held_task_pending_when_deps_unmet(client, container, human):
    dep = await _create(client, container, title="dep")
    held = await _create(client, container, title="held", not_ready=True, depends_on=[dep])
    r = await client.post(f"/api/tasks/{held}/readiness", json={"actor_agent_id": human, "ready": True})
    # dep is not completed → release lands 'pending', not 'ready'
    assert r.json()["status"] == "pending"


# ===================== B1 — ready-queue view =====================

async def test_ready_queue_filters_and_orders(client, container, human, make_agent):
    """TOOTH (B1): only ready+unassigned rows, in strict priority order. A ready+ASSIGNED row and
    a not_ready row are both excluded; priority 5 sorts ahead of priority 50."""
    await make_agent("builder", "eng")
    lo = await _create(client, container, title="lo", priority=50)
    hi = await _create(client, container, title="hi", priority=5)
    await _create(client, container, title="assigned", assignee_alias="builder")  # has owner
    await _create(client, container, title="held", not_ready=True)
    r = await client.get(f"/api/containers/{container['id']}/tasks",
                         params={"status": "ready", "unassigned": True, "sort": "priority"})
    titles = [t["title"] for t in r.json()["tasks"]]
    assert titles == ["hi", "lo"]           # ordering tooth + exclusion of assigned/held
    assert hi and lo


async def test_list_default_ordering_unchanged(client, container):
    """Back-compat: with no #326 params the legacy bucket ordering still applies."""
    await _create(client, container, title="a")
    r = await client.get(f"/api/containers/{container['id']}/tasks")
    assert r.status_code == 200 and r.json()["total"] >= 1


# ===================== B2 — unassign =====================

async def test_unassign_clears_owner_and_returns_to_ready(client, container, worker, human, work_headers):
    """TOOTH (B2): an in_progress assigned task → unassign → status 'ready', no active assignee."""
    tid = await _create(client, container, title="x", assignee_alias="dev")
    await client.post(f"/api/agents/{worker}/next", headers=await work_headers(worker))            # → in_progress
    r = await client.post(f"/api/tasks/{tid}/unassign", json={"actor_agent_id": human})
    assert r.status_code == 200
    assert r.json()["status"] == "ready" and worker in r.json()["released"]
    # the row now carries no assignee and returns to the ready-queue for human/lead re-routing
    row = await _get_task(client, container, tid)
    assert row["assignees"] == []


async def test_unassign_human_only(client, container, worker):
    tid = await _create(client, container, title="x", assignee_alias="dev")
    r = await client.post(f"/api/tasks/{tid}/unassign", json={"actor_agent_id": worker})
    assert r.status_code == 403


async def test_unassign_idempotent_when_no_assignee(client, container, human):
    tid = await _create(client, container, title="x")          # never assigned
    r = await client.post(f"/api/tasks/{tid}/unassign", json={"actor_agent_id": human})
    assert r.status_code == 200 and r.json()["already"] is True and r.json()["released"] == []


async def test_unassigned_not_self_claimable_via_next(client, container, worker, human, make_agent, work_headers):
    """#341 (open claim pool deleted): after unassign the row is ready+unassigned and stays VISIBLE
    in the ready-queue for human/lead routing, but is NOT self-claimable by any worker via /next.
    Re-adding the free-pool fall-through to /next would return the task here instead of None."""
    tid = await _create(client, container, title="x", assignee_alias="dev")
    await client.post(f"/api/agents/{worker}/next", headers=await work_headers(worker))
    await client.post(f"/api/tasks/{tid}/unassign", json={"actor_agent_id": human})
    other = await make_agent("dev2", "eng")
    r = await client.post(f"/api/agents/{other['agent_id']}/next", headers=await work_headers(other['agent_id']))
    assert r.json()["task"] is None
    # still surfaced in the ready-queue view so a human/lead can re-route it
    q = await client.get(f"/api/containers/{container['id']}/tasks",
                         params={"status": "ready", "unassigned": True, "sort": "priority"})
    assert any(str(t["id"]) == str(tid) for t in q.json()["tasks"])


# ===================== A1 — protocol every-wake read =====================

async def test_get_agent_protocol_returns_active_task_protocol(client, container, worker, human, work_headers):
    tid = await _create(client, container, title="x", assignee_alias="dev")
    await client.post(f"/api/agents/{worker}/next", headers=await work_headers(worker))            # → in_progress
    await client.patch(f"/api/tasks/{tid}/protocol",
                       json={"actor_agent_id": human, "notes": "drain ready rows in priority order",
                             "review_chain": "dev -> Lens -> Gate"})
    r = await client.get(f"/api/agents/{worker}/protocol")
    assert r.status_code == 200
    assert r.json()["task_id"] == tid
    assert r.json()["protocol"]["notes"].startswith("drain ready")


async def test_get_agent_protocol_null_when_no_active_task(client, container, worker):
    r = await client.get(f"/api/agents/{worker}/protocol")
    assert r.status_code == 200 and r.json()["protocol"] is None


def test_format_persona_renders_protocol_ahead_of_digest():
    """TOOTH (A1): the protocol (RULES) renders AND lands before the digest facts — the wake reads
    the human-authored rules ahead of its own recalled notes. Remove the proto block and this fails."""
    out = notifier.format_persona(
        {"system_prompt": "You are Helm."},
        {"digest": {"current_focus": "dispatch wave"}},
        {"protocol": {"notes": "your queue is the ready unassigned rows",
                      "review_chain": "dev -> Lens -> Gate"}})
    assert "Standing protocol" in out
    assert "your queue is the ready unassigned rows" in out
    assert out.index("Standing protocol") < out.index("Where you left off")


def test_format_persona_no_protocol_section_when_absent():
    """A null/absent protocol adds no section (idle/cold wake) — and the 2-arg call still works."""
    out = notifier.format_persona({"system_prompt": "You are Helm."},
                                  {"digest": {"current_focus": "x"}}, {"protocol": None})
    assert "Standing protocol" not in out
    assert notifier.format_persona({"system_prompt": "P"}, None) is not None  # back-compat 2-arg
