"""prompt_preview — the roster read payload carries a short (~160 char) preview of each
agent's system_prompt for the agent view; the FULL prompt stays on /persona (lazy-loaded
on expand) to avoid 8KB x N polling bloat. (Design call: Tim, option (c).)"""
import pytest


async def _agent(client, cid, alias):
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    return next(a for a in r.json()["agents"] if a["alias"] == alias)


@pytest.mark.asyncio
async def test_prompt_preview_truncates_long_prompt(client, container):
    long_prompt = "You are Verbose. " + ("blah " * 100)            # > 160 chars
    r = await client.post(f"/api/containers/{container['id']}/agents",
                          json={"alias": "Verbose", "role": "eng", "kind": "ai", "prompt": long_prompt})
    assert r.status_code in (200, 201), r.text
    a = await _agent(client, container["id"], "Verbose")
    assert a["prompt_preview"] == long_prompt[:160]                # first ~160 chars
    assert len(a["prompt_preview"]) == 160


@pytest.mark.asyncio
async def test_prompt_preview_returns_short_prompt_whole(client, container, make_agent):
    await make_agent("Terse", "eng", prompt="short prompt")
    a = await _agent(client, container["id"], "Terse")
    assert a["prompt_preview"] == "short prompt"                   # under 160 -> full text


@pytest.mark.asyncio
async def test_prompt_preview_null_for_human(client, container, make_agent):
    await make_agent("Person", "human", kind="human")             # humans carry no system_prompt
    a = await _agent(client, container["id"], "Person")
    assert a["prompt_preview"] is None
