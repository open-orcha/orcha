"""Epic C / D3 + D4: per-agent memory digest + rehydrate brief.

Covers the digest table round-trip (POST -> GET latest, append-only history),
the rehydrate assembly (identity + tasks + inbox + outbox + digest), cross-agent
isolation, and the ownership boundary (rehydrate carries no CC file-memory).
"""
import pytest
from orcha_cli import __main__ as cli

pytestmark = pytest.mark.asyncio


async def _digest_body(focus="wiring the digest table",
                       decisions=None, learnings=None, open_threads=None):
    return {
        "current_focus": focus,
        "decisions": decisions if decisions is not None else [{"text": "store reasoning, not facts"}],
        "learnings": learnings if learnings is not None else [{"text": "templates/ is canonical, .orcha/ is deployed"}],
        "open_threads": open_threads if open_threads is not None else [{"text": "await Forge reachability contract"}],
    }


async def test_post_then_get_latest_digest(client, make_agent):
    a = await make_agent("Vault", "persistence")
    aid = a["agent_id"]

    r = await client.post(f"/api/agents/{aid}/digest", json=await _digest_body())
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["agent_id"] == aid
    assert body["snapshot_ts"] > 0

    g = await client.get(f"/api/agents/{aid}/digest")
    assert g.status_code == 200, g.text
    d = g.json()["digest"]
    assert d is not None
    assert d["current_focus"] == "wiring the digest table"
    assert d["decisions"] == [{"text": "store reasoning, not facts"}]
    assert d["learnings"][0]["text"].startswith("templates/")


async def test_digest_round_trips_audience_register(client, make_agent):
    """#325: the plain-language register (`audience`) persists and reads back on GET +
    rehydrate, so the conversational tone survives across wakes — not only the facts."""
    a = await make_agent("Vault", "persistence")
    aid = a["agent_id"]
    register = "Talking to Kedar — non-engineer founder. Wants brief plain answers; no bare UUIDs."

    body = await _digest_body()
    body["audience"] = register
    r = await client.post(f"/api/agents/{aid}/digest", json=body)
    assert r.status_code == 201, r.text

    g = await client.get(f"/api/agents/{aid}/digest")
    assert g.json()["digest"]["audience"] == register
    # and it rehydrates with the rest of the brief
    rd = await client.get(f"/api/agents/{aid}/rehydrate")
    assert rd.json()["digest"]["audience"] == register


async def test_digest_audience_defaults_null_when_omitted(client, make_agent):
    """#325: audience is optional/additive — a digest POSTed without it (any pre-#325
    caller) stores NULL and reads back as null, never an error."""
    a = await make_agent("Vault", "persistence")
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/digest", json=await _digest_body())
    assert r.status_code == 201, r.text
    g = await client.get(f"/api/agents/{aid}/digest")
    assert g.json()["digest"]["audience"] is None


async def test_get_digest_is_null_before_any_snapshot(client, make_agent):
    a = await make_agent("Vault", "persistence")
    g = await client.get(f"/api/agents/{a['agent_id']}/digest")
    assert g.status_code == 200
    assert g.json()["digest"] is None


async def test_append_only_returns_newest(client, make_agent):
    a = await make_agent("Vault", "persistence")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/digest", json=await _digest_body(focus="first"))
    r2 = await client.post(f"/api/agents/{aid}/digest", json=await _digest_body(focus="second"))
    assert r2.status_code == 201

    g = await client.get(f"/api/agents/{aid}/digest")
    assert g.json()["digest"]["current_focus"] == "second"

    # history is preserved: two rows for this agent
    # (use the db fixture for a row-level assertion the API doesn't expose)


async def test_history_is_preserved(client, make_agent, db):
    a = await make_agent("Vault", "persistence")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/digest", json=await _digest_body(focus="first"))
    await client.post(f"/api/agents/{aid}/digest", json=await _digest_body(focus="second"))
    rows = db.execute(
        "SELECT current_focus FROM agent_memory_digests WHERE agent_id=%s ORDER BY snapshot_ts",
        (aid,),
    )
    assert [r["current_focus"] for r in rows] == ["first", "second"]


async def test_post_digest_unknown_agent_404(client):
    import uuid
    r = await client.post(f"/api/agents/{uuid.uuid4()}/digest", json=await _digest_body())
    assert r.status_code == 404


async def test_post_digest_bad_uuid_400(client):
    r = await client.post("/api/agents/not-a-uuid/digest", json=await _digest_body())
    assert r.status_code == 400


async def test_digest_snapshotted_event_published(client, container, make_agent, db):
    """The snapshot still emits a digest_snapshotted event for dashboards — but ISS-58 makes it
    CONTAINER-scoped (event_key='c:<cid>', target_id NULL), NOT on the agent's own key (which
    self-woke the agent in a loop). agent_id rides in the payload for attribution."""
    a = await make_agent("Vault", "persistence")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/digest", json=await _digest_body())
    # container-scoped row exists...
    crows = db.execute(
        "SELECT payload FROM agent_events WHERE event_key=%s AND event_name='digest_snapshotted'",
        (f"c:{container['id']}",),
    )
    assert len(crows) >= 1
    assert crows[-1]["payload"].get("agent_id") == aid
    # ...and NOTHING landed on the agent's own key (the runaway source).
    arows = db.execute(
        "SELECT 1 FROM agent_events WHERE event_key=%s AND event_name='digest_snapshotted'",
        (aid,),
    )
    assert len(arows) == 0


async def test_rehydrate_assembles_full_brief(client, make_agent, make_task, make_request):
    vault = await make_agent(
        "Vault", "persistence",
        initial_task={"title": "Epic C", "definition_of_done": "ship the digest"},
    )
    aid = vault["agent_id"]
    asker = await make_agent("Forge", "infra")

    # an incoming request Vault must answer
    await make_request(asker["agent_id"], "what's the reachability contract?",
                       target_alias="Vault")
    # the reasoning gap
    await client.post(f"/api/agents/{aid}/digest",
                      json=await _digest_body(focus="reconciling with Dock"))

    r = await client.get(f"/api/agents/{aid}/rehydrate")
    assert r.status_code == 200, r.text
    brief = r.json()

    assert brief["identity"]["alias"] == "Vault"
    assert brief["identity"]["role"] == "persistence"
    # (ii) the agent re-attaches to its in-progress task
    assert any(t["title"] == "Epic C" for t in brief["tasks"])
    # (iii) the open incoming request is surfaced
    assert any(i["requester_alias"] == "Forge" for i in brief["inbox"])
    # (iv) the reasoning digest rehydrates
    assert brief["digest"]["current_focus"] == "reconciling with Dock"


async def test_rehydrate_brief_marks_digest_external_state_stale():
    brief = cli._fmt_rehydrate_brief({
        "identity": {
            "alias": "Vault",
            "role": "runtime",
            "id": "agent-1",
            "status": "idle",
            "turns_used": 1,
            "turn_budget": 5,
        },
        "digest": {
            "current_focus": "PR #353 is waiting on review",
            "decisions": [],
            "learnings": [],
            "open_threads": [{"text": "PR #353 still needs Lens review"}],
        },
    })

    assert "re-check external state" in brief
    assert "verify live before acting or deciding there is nothing to do" in brief
    assert "PR #353 still needs Lens review" in brief


async def test_rehydrate_is_per_agent_isolated(client, make_agent):
    vault = await make_agent("Vault", "persistence")
    dock = await make_agent("Dock", "platform")
    await client.post(f"/api/agents/{vault['agent_id']}/digest",
                      json=await _digest_body(focus="VAULT-ONLY focus"))

    # Dock has no digest of their own and must not see Vault's
    rd = await client.get(f"/api/agents/{dock['agent_id']}/rehydrate")
    assert rd.json()["digest"] is None
    rv = await client.get(f"/api/agents/{vault['agent_id']}/rehydrate")
    assert rv.json()["digest"]["current_focus"] == "VAULT-ONLY focus"


async def test_rehydrate_excludes_completed_tasks(client, make_agent, make_task, make_request):
    # boundary/relevance: rehydrate shows only live (non-terminal) tasks
    vault = await make_agent(
        "Vault", "persistence",
        initial_task={"title": "live one", "definition_of_done": "x"},
    )
    r = await client.get(f"/api/agents/{vault['agent_id']}/rehydrate")
    titles = [t["title"] for t in r.json()["tasks"]]
    assert "live one" in titles


# ---------- ISS-58: a digest snapshot must NOT self-wake the agent ----------

async def _scan_cand(client, cid, aid, min_idle=0):
    r = await client.get(f"/api/containers/{cid}/wake-scan", params={"min_idle": min_idle})
    assert r.status_code == 200, r.text
    return next((c for c in r.json()["candidates"] if c["agent_id"] == aid), None)


async def test_digest_snapshot_does_not_rewake(client, container, make_agent):
    """ISS-58 runaway hotfix: posting a digest snapshot must not create pending work on the
    agent's own key, so wake-scan does NOT wake it (which would snapshot again → ~60s loop)."""
    a = await make_agent("Atlas", "eng")
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/digest", json=await _digest_body())
    assert r.status_code == 201, r.text
    cand = await _scan_cand(client, container["id"], aid)
    assert cand["pending_events"] == 0, "digest_snapshotted must not count as pending work"
    assert cand["should_wake"] is False


async def test_digest_snapshotted_is_container_scoped_not_on_agent_key(client, make_agent):
    """The snapshot event is delivered container-scoped (for dashboards), NOT to the agent's own
    inbox — so a long-poll listener on the agent key sees nothing from its own snapshot."""
    a = await make_agent("Atlas2", "eng")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/digest", json=await _digest_body())
    w = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 1})
    assert w.json()["event"] == "timeout", "snapshot must not land on the agent's own event key"


async def test_non_waking_event_excluded_from_wake_count(client, container, make_agent, db):
    """Backstop: even if a digest_snapshotted somehow lands on an agent's key, wake-scan excludes
    _NON_WAKING_EVENTS from the should_wake count so it never wakes on a self-echo."""
    import time as _t
    a = await make_agent("Atlas3", "eng")
    aid = a["agent_id"]
    db.execute(
        """INSERT INTO agent_events (container_id, target_id, event_key, event_name, ts, payload)
           VALUES (%s, %s, %s, 'digest_snapshotted', %s, '{}'::jsonb)""",
        (container["id"], aid, aid, _t.time()),
    )
    cand = await _scan_cand(client, container["id"], aid)
    assert cand["pending_events"] == 0 and cand["should_wake"] is False
