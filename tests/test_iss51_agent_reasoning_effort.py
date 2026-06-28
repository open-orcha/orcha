"""GH #51 — per-agent reasoning effort, wired through to the worker spawn.

POST /api/agents/{aid}/reasoning-effort {reasoning_effort} persists agents.reasoning_effort;
it flows through the container read payload and the wake-scan candidate, where the daemon
passes it to the worker — `claude --effort <level>` (or Codex `model_reasoning_effort`).
Validation is curated (low|medium|high|xhigh); humans carry no effort. An unknown/NULL value
resolves to the default rather than reaching the argv.
"""
import pathlib
import sys
import uuid

import pytest

import main

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import notifier  # noqa: E402


async def _effort_in_payload(client, cid, alias):
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    a = next(x for x in r.json()["agents"] if x["alias"] == alias)
    return a["reasoning_effort"]


# ---------- set / read / validate ----------

async def test_set_effort_persists_and_flows_through_read_payload(client, container, make_agent):
    a = await make_agent("Effo", "eng")
    aid = a["agent_id"]
    assert await _effort_in_payload(client, container["id"], "Effo") is None   # NULL = server default

    r = await client.post(f"/api/agents/{aid}/reasoning-effort", json={"reasoning_effort": "high"})
    assert r.status_code == 200, r.text
    assert r.json() == {"agent_id": aid, "reasoning_effort": "high"}
    assert await _effort_in_payload(client, container["id"], "Effo") == "high"


async def test_unknown_effort_rejected(client, container, make_agent):
    a = await make_agent("Picky", "eng")
    r = await client.post(f"/api/agents/{a['agent_id']}/reasoning-effort",
                          json={"reasoning_effort": "ludicrous"})
    assert r.status_code == 400, r.text
    assert "not valid" in r.text


async def test_unknown_agent_404(client):
    r = await client.post(f"/api/agents/{uuid.uuid4()}/reasoning-effort",
                          json={"reasoning_effort": "high"})
    assert r.status_code == 404, r.text


async def test_bad_uuid_400(client):
    r = await client.post("/api/agents/not-a-uuid/reasoning-effort",
                          json={"reasoning_effort": "high"})
    assert r.status_code == 400, r.text


async def test_human_rejected(client, container, make_agent):
    h = await make_agent("Human", "human", kind="human")
    r = await client.post(f"/api/agents/{h['agent_id']}/reasoning-effort",
                          json={"reasoning_effort": "high"})
    assert r.status_code == 400, r.text
    assert "humans carry no reasoning effort" in r.text


async def test_effort_changed_event_emitted(client, container, make_agent, db):
    a = await make_agent("Eventy", "eng")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/reasoning-effort", json={"reasoning_effort": "xhigh"})
    rows = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='reasoning_effort_changed'", (aid,))
    assert rows and rows[0]["detail"]["reasoning_effort"] == "xhigh"


async def test_list_efforts_endpoint(client):
    r = await client.get("/api/reasoning-efforts")
    assert r.status_code == 200, r.text
    body = r.json()
    ids = {e["id"] for e in body["efforts"]}
    assert ids == {"low", "medium", "high", "xhigh"}
    assert body["default"] == "medium"


# ---------- resolver fallback (the spawn seam) ----------

def test_resolve_reasoning_effort_falls_back(monkeypatch):
    assert main.resolve_reasoning_effort("high") == "high"
    assert main.resolve_reasoning_effort("xhigh") == "xhigh"
    assert main.resolve_reasoning_effort(None) == main.DEFAULT_REASONING_EFFORT
    assert main.resolve_reasoning_effort("bogus") == main.DEFAULT_REASONING_EFFORT


# ---------- wake-scan candidate carries the resolved effort ----------

async def test_wake_scan_candidate_carries_resolved_effort(client, container, make_agent):
    a = await make_agent("Scanny", "eng")
    aid = a["agent_id"]
    # default (NULL) → resolves to the server default on the candidate
    r = await client.get(f"/api/containers/{container['id']}/wake-scan")
    cand = next(c for c in r.json()["candidates"] if c["agent_id"] == aid)
    assert cand["reasoning_effort"] == main.DEFAULT_REASONING_EFFORT

    await client.post(f"/api/agents/{aid}/reasoning-effort", json={"reasoning_effort": "xhigh"})
    r = await client.get(f"/api/containers/{container['id']}/wake-scan")
    cand = next(c for c in r.json()["candidates"] if c["agent_id"] == aid)
    assert cand["reasoning_effort"] == "xhigh"


# ---------- spawn argv: the effort reaches the worker command ----------

def test_spawn_headless_claude_appends_effort_flag():
    _, repr_, _ = notifier.spawn_headless("/proj", "do it", None, True,
                                          alias="A", reasoning_effort="xhigh", runtime="claude")
    assert "--effort xhigh" in repr_


def test_spawn_headless_codex_maps_effort_to_config():
    # Codex has no 'xhigh' tier → folded to 'high'
    _, repr_, _ = notifier.spawn_headless("/proj", "do it", None, True,
                                          alias="A", reasoning_effort="xhigh", runtime="codex")
    assert "-c model_reasoning_effort=high" in repr_
    _, repr_lo, _ = notifier.spawn_headless("/proj", "do it", None, True,
                                            alias="A", reasoning_effort="low", runtime="codex")
    assert "-c model_reasoning_effort=low" in repr_lo


def test_spawn_headless_no_effort_no_flag():
    _, repr_, _ = notifier.spawn_headless("/proj", "do it", None, True, alias="A", runtime="claude")
    assert "--effort" not in repr_


def test_spawn_resident_appends_effort_flag():
    _, repr_, _ = notifier.spawn_resident("/proj", alias="A", reasoning_effort="high",
                                          runtime="claude", dry_run=True)
    assert "--effort high" in repr_
