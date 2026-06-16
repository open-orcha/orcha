"""B8.1 — make agents.model settable via API (builds on D7's agents.model column).

POST /api/agents/{aid}/model {model} persists the chosen model and it flows through
the D7 read payload (agent.model). Validation stays CURATED (kedar's ruling): a model
must be one of AVAILABLE_MODELS; humans carry no model.
"""
import uuid

import pytest

import main


async def _agent_model_in_payload(client, cid, alias):
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    a = next(x for x in r.json()["agents"] if x["alias"] == alias)
    return a["model"]


@pytest.mark.asyncio
async def test_set_model_persists_and_flows_through_read_payload(client, container, make_agent):
    a = await make_agent("Switch", "eng")            # defaults to opus
    aid = a["agent_id"]
    assert await _agent_model_in_payload(client, container["id"], "Switch") == "claude-opus-4-8"

    r = await client.post(f"/api/agents/{aid}/model", json={"model": "claude-sonnet-4-6"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agent_id"] == aid and body["model"] == "claude-sonnet-4-6"
    assert body["cold_reset_conversations"] == []   # no active conversation to cold-reset
    # D7 read payload reflects the update
    assert await _agent_model_in_payload(client, container["id"], "Switch") == "claude-sonnet-4-6"


@pytest.mark.asyncio
async def test_unknown_model_rejected(client, container, make_agent):
    a = await make_agent("Picky", "eng")
    r = await client.post(f"/api/agents/{a['agent_id']}/model", json={"model": "gpt-9-ultra"})
    assert r.status_code == 400, r.text
    assert "not a known model" in r.text


@pytest.mark.asyncio
async def test_unknown_agent_404(client):
    r = await client.post(f"/api/agents/{uuid.uuid4()}/model", json={"model": "claude-opus-4-8"})
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_bad_uuid_400(client):
    r = await client.post("/api/agents/not-a-uuid/model", json={"model": "claude-opus-4-8"})
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_human_rejected(client, container, make_agent):
    h = await make_agent("Human", "human", kind="human")
    r = await client.post(f"/api/agents/{h['agent_id']}/model", json={"model": "claude-opus-4-8"})
    assert r.status_code == 400, r.text
    assert "humans carry no model" in r.text


@pytest.mark.asyncio
async def test_model_changed_event_emitted(client, container, make_agent, db):
    a = await make_agent("Eventy", "eng")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/model", json={"model": "claude-haiku-4-5-20251001"})
    rows = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='model_changed'", (aid,))
    assert rows and rows[0]["detail"]["model"] == "claude-haiku-4-5-20251001"


# ---------- Fable 5 (limited-availability) + graceful fallback ----------

@pytest.mark.asyncio
async def test_fable5_listed_and_selectable(client, container, make_agent):
    """Fable 5 is in the curated list (offered through 2026-06-22) and settable per-agent."""
    r = await client.get("/api/models")
    models = r.json()["models"]
    ids = {m["id"] for m in models}
    assert "claude-fable-5" in ids
    assert "gpt-5.5" in ids and "gpt-5.3-codex-spark" in ids
    by_id = {m["id"]: m for m in models}
    assert by_id["claude-fable-5"]["runtime"] == "claude"
    assert by_id["gpt-5.5"]["runtime"] == "codex"
    a = await make_agent("Faby", "eng")
    r = await client.post(f"/api/agents/{a['agent_id']}/model", json={"model": "claude-fable-5"})
    assert r.status_code == 200, r.text
    assert await _agent_model_in_payload(client, container["id"], "Faby") == "claude-fable-5"


def test_resolve_model_falls_back_when_retired(monkeypatch):
    """A persisted choice no longer in the curated list resolves to the default — the spawn
    seam that gives ZERO breakage the moment Fable is removed from AVAILABLE_MODELS."""
    assert main.resolve_model("claude-fable-5") == "claude-fable-5"   # while listed
    assert main.resolve_model("claude-opus-4-8") == "claude-opus-4-8"
    assert main.resolve_model(None) == main.DEFAULT_MODEL
    assert main.resolve_model("some-old-id") == main.DEFAULT_MODEL
    # simulate Fable retired: drop it from the curated id set
    monkeypatch.setattr(main, "_MODEL_IDS", main._MODEL_IDS - {"claude-fable-5"})
    assert main.resolve_model("claude-fable-5") == main.DEFAULT_MODEL


def test_resolve_model_runtime_matches_curated_runtime(monkeypatch):
    assert main.resolve_model_runtime("claude-fable-5") == "claude"
    assert main.resolve_model_runtime("gpt-5.5") == "codex"
    assert main.resolve_model_runtime("some-old-id") == "claude"
    monkeypatch.setattr(main, "_MODEL_IDS", main._MODEL_IDS - {"gpt-5.5"})
    assert main.resolve_model_runtime("gpt-5.5") == "claude"


@pytest.mark.asyncio
async def test_wake_scan_candidate_carries_resolved_model(client, container, make_agent, monkeypatch):
    a = await make_agent("Scanny", "eng")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/model", json={"model": "claude-fable-5"})

    r = await client.get(f"/api/containers/{container['id']}/wake-scan")
    cand = next(c for c in r.json()["candidates"] if c["agent_id"] == aid)
    assert cand["model"] == "claude-fable-5"
    assert cand["model_runtime"] == "claude"
    await client.post(f"/api/agents/{aid}/model", json={"model": "gpt-5.5"})
    r = await client.get(f"/api/containers/{container['id']}/wake-scan")
    cand = next(c for c in r.json()["candidates"] if c["agent_id"] == aid)
    assert cand["model"] == "gpt-5.5"
    assert cand["model_runtime"] == "codex"
    # retired → candidate auto-falls-back to the default (never an invalid --model id)
    monkeypatch.setattr(main, "_MODEL_IDS", main._MODEL_IDS - {"gpt-5.5"})
    r = await client.get(f"/api/containers/{container['id']}/wake-scan")
    cand = next(c for c in r.json()["candidates"] if c["agent_id"] == aid)
    assert cand["model"] == main.DEFAULT_MODEL
    assert cand["model_runtime"] == "claude"


# ---------- GAP A (THIRD surface): /persona carries the resolved model --------

@pytest.mark.asyncio
async def test_persona_carries_resolved_model_for_live_terminal(client, container, make_agent, monkeypatch):
    """The live terminal path (orcha use → _exec_live_session) boots claude AS the agent off
    /persona; it now surfaces the model resolved server-side (the CLI can't import resolve_model),
    so a live terminal pins the per-agent selection like the ephemeral/resident surfaces."""
    a = await make_agent("Live", "eng")              # defaults to opus
    aid = a["agent_id"]
    r = await client.get(f"/api/agents/{aid}/persona")
    assert r.status_code == 200, r.text
    assert r.json()["model"] == "claude-opus-4-8"
    assert r.json()["model_runtime"] == "claude"

    await client.post(f"/api/agents/{aid}/model", json={"model": "claude-fable-5"})
    assert (await client.get(f"/api/agents/{aid}/persona")).json()["model"] == "claude-fable-5"
    await client.post(f"/api/agents/{aid}/model", json={"model": "gpt-5.5"})
    codex_persona = (await client.get(f"/api/agents/{aid}/persona")).json()
    assert codex_persona["model"] == "gpt-5.5"
    assert codex_persona["model_runtime"] == "codex"

    # retired → /persona auto-falls-back to the default (never an invalid --model id)
    monkeypatch.setattr(main, "_MODEL_IDS", main._MODEL_IDS - {"gpt-5.5"})
    assert (await client.get(f"/api/agents/{aid}/persona")).json()["model"] == main.DEFAULT_MODEL


@pytest.mark.asyncio
async def test_persona_model_none_for_human(client, container, make_agent):
    """A human has no model → /persona model is None → the live path adds no --model flag."""
    h = await make_agent("Operator0", "human", kind="human")
    r = await client.get(f"/api/agents/{h['agent_id']}/persona")
    assert r.status_code == 200, r.text
    assert r.json()["model"] is None
    assert r.json()["model_runtime"] is None


# ---------- GAP B: a model change forces the resident to cold-reboot ----------

@pytest.mark.asyncio
async def test_model_change_clears_pinned_session(client, container, make_agent, db):
    """A live resident's pinned session has the OLD model baked in; changing the model clears
    session_id so the next boot is COLD and adopts `--model <new>`."""
    human = await make_agent("Operator", "human", kind="human")
    a = await make_agent("Resi", "eng")
    aid = a["agent_id"]
    sid = str(uuid.uuid4())
    rows = db.execute(
        "INSERT INTO conversations (container_id, agent_id, started_by, session_id) "
        "VALUES (%s,%s,%s,%s) RETURNING id",
        (container["id"], aid, human["agent_id"], sid))
    conv_id = str(rows[0]["id"])

    r = await client.post(f"/api/agents/{aid}/model", json={"model": "claude-fable-5"})
    assert r.status_code == 200, r.text
    assert r.json()["cold_reset_conversations"] == [conv_id]
    after = db.execute("SELECT session_id FROM conversations WHERE id=%s", (conv_id,))
    assert after[0]["session_id"] is None        # pin cleared → next boot cold


@pytest.mark.asyncio
async def test_setting_same_model_does_not_reset_session(client, container, make_agent, db):
    """No actual change → no needless cold reboot (the pinned session survives)."""
    human = await make_agent("Op2", "human", kind="human")
    a = await make_agent("Resi2", "eng")            # defaults to opus
    aid = a["agent_id"]
    sid = str(uuid.uuid4())
    rows = db.execute(
        "INSERT INTO conversations (container_id, agent_id, started_by, session_id) "
        "VALUES (%s,%s,%s,%s) RETURNING id",
        (container["id"], aid, human["agent_id"], sid))
    conv_id = str(rows[0]["id"])

    r = await client.post(f"/api/agents/{aid}/model", json={"model": "claude-opus-4-8"})
    assert r.json()["cold_reset_conversations"] == []
    after = db.execute("SELECT session_id FROM conversations WHERE id=%s", (conv_id,))
    assert str(after[0]["session_id"]) == sid       # untouched
