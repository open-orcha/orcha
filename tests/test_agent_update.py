"""Agent-update — PATCH /api/agents/{aid} edits role / system_prompt / alias.

Human-authority gated, partial update. Replaces editing personas via raw DB; unblocks
onboarding + re-profiles. Changes flow through /persona and the container read payload.
"""
import uuid

import pytest


async def _persona(client, aid):
    r = await client.get(f"/api/agents/{aid}/persona")
    assert r.status_code == 200, r.text
    return r.json()


async def _roster_agent(client, cid, alias):
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    return next((a for a in r.json()["agents"] if a["alias"] == alias), None)


@pytest.mark.asyncio
async def test_update_role_and_prompt_reflected(client, container, make_agent):
    human = await make_agent("Boss", "human", kind="human")
    a = await make_agent("Edit", "old role", prompt="old prompt")
    aid = a["agent_id"]
    r = await client.patch(f"/api/agents/{aid}",
                           json={"actor_agent_id": human["agent_id"],
                                 "role": "new role", "system_prompt": "a much better prompt"})
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "new role"
    p = await _persona(client, aid)
    assert p["role"] == "new role" and p["system_prompt"] == "a much better prompt"
    # read payload reflects role + prompt_preview
    ra = await _roster_agent(client, container["id"], "Edit")
    assert ra["role"] == "new role" and ra["prompt_preview"] == "a much better prompt"


@pytest.mark.asyncio
async def test_partial_update_leaves_other_fields(client, container, make_agent):
    human = await make_agent("Boss2", "human", kind="human")
    a = await make_agent("Partial", "keep role", prompt="keep prompt")
    aid = a["agent_id"]
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human["agent_id"], "role": "changed"})
    p = await _persona(client, aid)
    assert p["role"] == "changed" and p["system_prompt"] == "keep prompt"   # prompt untouched


@pytest.mark.asyncio
async def test_update_alias_and_rebind_note(client, container, make_agent):
    human = await make_agent("Boss3", "human", kind="human")
    a = await make_agent("OldName", "eng")
    aid = a["agent_id"]
    r = await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human["agent_id"], "alias": "NewName"})
    assert r.status_code == 200, r.text
    assert r.json()["alias"] == "NewName"
    assert "re-bind" in r.json()["alias_rebind_note"]
    assert await _roster_agent(client, container["id"], "NewName") is not None
    assert await _roster_agent(client, container["id"], "OldName") is None


@pytest.mark.asyncio
async def test_alias_collision_409(client, container, make_agent):
    human = await make_agent("Boss4", "human", kind="human")
    await make_agent("Taken", "eng")
    a = await make_agent("Mover", "eng")
    r = await client.patch(f"/api/agents/{a['agent_id']}",
                           json={"actor_agent_id": human["agent_id"], "alias": "Taken"})
    assert r.status_code == 409, r.text
    assert "already exists" in r.text


@pytest.mark.asyncio
async def test_non_human_actor_403(client, container, make_agent):
    bot = await make_agent("Bot", "eng")
    victim = await make_agent("Victim", "eng")
    r = await client.patch(f"/api/agents/{victim['agent_id']}",
                           json={"actor_agent_id": bot["agent_id"], "role": "x"})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_unknown_agent_404(client, container, make_agent):
    human = await make_agent("Boss5", "human", kind="human")
    r = await client.patch(f"/api/agents/{uuid.uuid4()}",
                           json={"actor_agent_id": human["agent_id"], "role": "x"})
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_editing_human_prompt_400(client, container, make_agent):
    human = await make_agent("Boss6", "human", kind="human")
    other_human = await make_agent("Hooman", "human", kind="human")
    r = await client.patch(f"/api/agents/{other_human['agent_id']}",
                           json={"actor_agent_id": human["agent_id"], "system_prompt": "nope"})
    assert r.status_code == 400, r.text
    assert "humans carry no system_prompt" in r.text


@pytest.mark.asyncio
async def test_blank_ai_prompt_rejected(client, container, make_agent):
    """[P1 review] a human must not be able to blank out an AI agent's system_prompt —
    mirrors register_agent's non-empty rule (else /persona is blank -> generic worker)."""
    human = await make_agent("Boss9", "human", kind="human")
    ai = await make_agent("Persona", "eng", prompt="real prompt")
    aid = ai["agent_id"]
    for blank in ("", "   ", "\n\t "):
        r = await client.patch(f"/api/agents/{aid}",
                               json={"actor_agent_id": human["agent_id"], "system_prompt": blank})
        assert r.status_code == 400, f"{blank!r}: {r.text}"
        assert "non-empty system_prompt" in r.text
    # the original prompt is untouched
    p = await _persona(client, aid)
    assert p["system_prompt"] == "real prompt"


@pytest.mark.asyncio
async def test_no_fields_400(client, container, make_agent):
    human = await make_agent("Boss7", "human", kind="human")
    a = await make_agent("Nada", "eng")
    r = await client.patch(f"/api/agents/{a['agent_id']}", json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_bad_uuid_400(client, container, make_agent):
    human = await make_agent("Boss8", "human", kind="human")
    r = await client.patch("/api/agents/not-a-uuid", json={"actor_agent_id": human["agent_id"], "role": "x"})
    assert r.status_code == 400, r.text
