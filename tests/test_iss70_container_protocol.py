"""GH#70 — container-level `protocol`: a single free-form workspace-wide working agreement.

A container carries an optional free-text `protocol` (migration 030) that sets the default
behavioral context for every task/agent inside it. It is edited via the human-gated, audited
PATCH /api/containers/{cid}/settings/protocol, read via GET on the same resource, and — crucially —
served to a waking agent as the FALLBACK protocol when its task carries none. A task-level protocol
(SPEC-4) OVERRIDES it.

Each test is mutation-checked: it asserts the live behaviour AND the contract (human gate /
full-replace / precedence / fallback) that makes it pass — flip the prod line and the matching
assertion goes red.
"""
import pytest
import pytest_asyncio

from orcha_cli import notifier

# asyncio_mode=auto (pytest.ini) runs the async tests; the pure render tests below stay sync.


@pytest_asyncio.fixture
async def human(make_agent):
    h = await make_agent("kedar", "operator", kind="human")
    return h["agent_id"]


@pytest_asyncio.fixture
async def worker(make_agent):
    w = await make_agent("dev", "eng")
    return w["agent_id"]


def _url(cid):
    return f"/api/containers/{cid}/settings/protocol"


# ── 1. GET defaults to null (empty by default = no constraint) ────────────────
async def test_get_defaults_null(client, container):
    r = await client.get(_url(container["id"]))
    assert r.status_code == 200, r.text
    assert r.json() == {"container_id": container["id"], "protocol": None}


# ── 2. human-authority gate + audit (mirrors /autonomy and the task protocol) ──
async def test_patch_is_human_gated(client, container, worker, human):
    """The gate: a non-human actor is 403'd (TEETH: drop _require_kind(...,("human",)) in
    update_container_protocol and this 403 → 200). A missing/!uuid actor → 400."""
    r = await client.patch(_url(container["id"]),
                           json={"actor_agent_id": worker, "protocol": "always open a draft PR"})
    assert r.status_code == 403, r.text

    r = await client.patch(_url(container["id"]),
                           json={"actor_agent_id": "not-a-uuid", "protocol": "x"})
    assert r.status_code == 400, r.text

    r = await client.patch(_url(container["id"]),
                           json={"actor_agent_id": human, "protocol": "always open a draft PR"})
    assert r.status_code == 200, r.text
    assert r.json()["protocol"] == "always open a draft PR"


# ── 3. set then read back; full-replace (not a merge) ─────────────────────────
async def test_set_persists_and_replaces(client, container, human):
    await client.patch(_url(container["id"]),
                       json={"actor_agent_id": human, "protocol": "first rule"})
    r = await client.patch(_url(container["id"]),
                           json={"actor_agent_id": human, "protocol": "second rule"})
    assert r.json()["protocol"] == "second rule"   # replaced wholesale, not appended/merged
    r = await client.get(_url(container["id"]))
    assert r.json()["protocol"] == "second rule"


# ── 4. empty / whitespace clears the field back to no-protocol ────────────────
async def test_empty_clears(client, container, human):
    await client.patch(_url(container["id"]),
                       json={"actor_agent_id": human, "protocol": "some rule"})
    r = await client.patch(_url(container["id"]),
                           json={"actor_agent_id": human, "protocol": "   "})
    assert r.status_code == 200 and r.json()["protocol"] is None
    assert (await client.get(_url(container["id"]))).json()["protocol"] is None


# ── 5. length cap rejects an over-long body (413 body_too_long handler) ───────
async def test_length_cap(client, container, human):
    r = await client.patch(_url(container["id"]),
                           json={"actor_agent_id": human, "protocol": "x" * 8_001})
    assert r.status_code == 413, r.text   # max_length=8000 → the body_too_long handler
    assert r.json()["field"] == "protocol"


# ── 6. fallback: a taskless agent's protocol GET surfaces the container one ────
async def test_agent_protocol_falls_back_to_container(client, container, worker, human):
    """The fallback: with no active task protocol the agent receives the CONTAINER protocol as
    context (TEETH: drop the container lookup in get_agent_protocol and container_protocol is None)."""
    r = await client.get(f"/api/agents/{worker}/protocol")
    assert r.json()["protocol"] is None and r.json()["container_protocol"] is None  # nothing set yet

    await client.patch(_url(container["id"]),
                       json={"actor_agent_id": human, "protocol": "small focused changes only"})
    r = await client.get(f"/api/agents/{worker}/protocol")
    assert r.status_code == 200
    assert r.json()["protocol"] is None
    assert r.json()["container_protocol"] == "small focused changes only"


# ── 7. precedence: a task protocol OVERRIDES the container one ─────────────────
async def test_task_protocol_overrides_container(client, container, worker, human):
    """When the agent's in_progress task carries its own protocol, that wins and the container
    fallback is suppressed (TEETH: the response must NOT carry container_protocol here)."""
    await client.patch(_url(container["id"]),
                       json={"actor_agent_id": human, "protocol": "WORKSPACE default"})
    # assign + claim a task into in_progress, then give it a task-level protocol
    tr = await client.post(f"/api/containers/{container['id']}/tasks",
                           json={"title": "x", "definition_of_done": "d", "assignee_alias": "dev"})
    tid = tr.json()["task_id"]
    await client.post(f"/api/agents/{worker}/next")            # → in_progress
    await client.patch(f"/api/tasks/{tid}/protocol",
                       json={"actor_agent_id": human, "notes": "TASK rule"})

    r = await client.get(f"/api/agents/{worker}/protocol")
    assert r.json()["task_id"] == tid
    assert r.json()["protocol"]["notes"] == "TASK rule"
    assert r.json().get("container_protocol") is None          # container fallback suppressed


# ── 8. notifier renders the container fallback as the standing-protocol section ─
def test_render_container_protocol_fallback():
    """A null task protocol + a container_protocol renders the WORKSPACE standing-protocol block."""
    out = notifier.format_persona(
        {"system_prompt": "You are Helm."},
        {"digest": {"current_focus": "dispatch"}},
        {"protocol": None, "container_protocol": "ship small, open draft PRs"})
    assert "Standing protocol" in out
    assert "ship small, open draft PRs" in out


def test_task_protocol_wins_over_container_in_render():
    """When BOTH are present (defensive — the server suppresses container_protocol, but the renderer
    must too), the task protocol renders and the container text does not."""
    out = notifier.format_persona(
        {"system_prompt": "P"}, None,
        {"protocol": {"notes": "TASK rule"}, "container_protocol": "WORKSPACE default"})
    assert "TASK rule" in out
    assert "WORKSPACE default" not in out


def test_no_section_when_neither_set():
    out = notifier.format_persona({"system_prompt": "P"}, None,
                                  {"protocol": None, "container_protocol": None})
    assert "Standing protocol" not in out
