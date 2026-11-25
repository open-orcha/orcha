"""Retiring Fable 5.1 removes choices, safely persists replacements, and keeps history."""

import uuid

import pytest

from portal_backend.model_policy import DEFAULT_MODEL

RETIRED = "claude-fable-5-1"


async def saved_agent(make_agent, db):
    aid = (await make_agent("FormerFable", "engineer"))["agent_id"]
    db.execute("UPDATE agents SET model=%s, reasoning_effort='max' WHERE id=%s", (RETIRED, aid))
    return aid


def saved_model(db, aid):
    return db.execute("SELECT model FROM agents WHERE id=%s", (aid,))[0]["model"]


async def scan(client, container):
    response = await client.get(f"/api/containers/{container['id']}/wake-scan")
    assert response.status_code == 200, response.text
    return response.json()


async def test_retired_model_is_not_offered_or_newly_assignable(client, container, make_agent):
    models = (await client.get("/api/models")).json()["models"]
    ids = {m["id"] for m in models}
    assert RETIRED not in ids
    assert {"claude-fable-5-2", "claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5"} <= ids
    aid = (await make_agent("Supported", "engineer"))["agent_id"]
    response = await client.post(f"/api/agents/{aid}/model", json={"model": RETIRED})
    assert response.status_code == 400, response.text
    assert "not a known model" in response.text
    response = await client.post(f"/api/containers/{container['id']}/agents", json={
        "alias": "Retired", "role": "engineer", "kind": "ai", "model": RETIRED,
    })
    assert response.status_code == 400, response.text
    providers = (await client.get(f"/api/containers/{container['id']}/settings/providers")).json()
    assert all(RETIRED != m["id"] for p in providers["providers"] for m in p["models"])


async def test_idle_agent_migrates_once_and_history_is_untouched(client, container, make_agent, db):
    aid = await saved_agent(make_agent, db)
    old_output = '{"model":"claude-fable-5-1","usage":{"input_tokens":120}}'
    history = db.execute(
        "INSERT INTO worker_runs(agent_id,wake_kind,status,output,input_tokens,total_cost_usd) "
        "VALUES (%s,'ephemeral','exited',%s,120,0.25) RETURNING *", (aid, old_output),
    )[0]
    for _ in range(3):
        result = await scan(client, container)
        candidate = next(c for c in result["candidates"] if c["agent_id"] == aid)
        assert candidate["model"] == DEFAULT_MODEL
        assert candidate["reasoning_effort"] == "max"
        assert saved_model(db, aid) == DEFAULT_MODEL
        assert (await client.get(f"/api/agents/{aid}/persona")).json()["model"] == DEFAULT_MODEL
    events = db.execute("SELECT detail FROM events WHERE entity_id=%s AND event_type='model_changed'", (aid,))
    assert len(events) == 1
    assert events[0]["detail"]["previous_model"] == RETIRED
    assert events[0]["detail"]["model"] == DEFAULT_MODEL
    revisions = db.execute("SELECT snapshot FROM agent_config_revisions WHERE agent_id=%s ORDER BY revision_no", (aid,))
    assert [r["snapshot"]["model"] for r in revisions] == [RETIRED, DEFAULT_MODEL]
    assert all(r["snapshot"]["provider"] == "claude" for r in revisions)
    assert db.execute("SELECT * FROM worker_runs WHERE run_id=%s", (history["run_id"],))[0] == history


@pytest.mark.parametrize("lane,status", [("work", "running"), ("conversation", "running"), ("work", "reserved")])
async def test_busy_agent_defers_persisted_change_until_safe(client, container, make_agent, db, lane, status):
    aid = await saved_agent(make_agent, db)
    run = db.execute(
        "INSERT INTO worker_runs(agent_id,wake_kind,status,lane) VALUES (%s,'ephemeral',%s,%s) RETURNING *",
        (aid, status, lane),
    )[0]
    human = (await make_agent("Operator", kind="human"))["agent_id"]
    sid = str(uuid.uuid4())
    conv = db.execute(
        "INSERT INTO conversations(container_id,agent_id,started_by,session_id,session_pinned_at) "
        "VALUES (%s,%s,%s,%s,now()) RETURNING id", (container["id"], aid, human, sid),
    )[0]["id"]
    await scan(client, container)
    await client.get(f"/api/agents/{aid}/persona")
    assert saved_model(db, aid) == RETIRED
    assert db.execute("SELECT * FROM worker_runs WHERE run_id=%s", (run["run_id"],))[0] == run
    assert str(db.execute("SELECT session_id FROM conversations WHERE id=%s", (conv,))[0]["session_id"]) == sid
    active = (await client.get(f"/api/containers/{container['id']}/active-conversations")).json()
    candidate = next(c for c in active["conversations"] if c["conversation_id"] == str(conv))
    assert candidate["model"] == DEFAULT_MODEL
    assert candidate["cold_required"] is True  # a subsequent launch must never resume the retired pin
    db.execute("UPDATE worker_runs SET status='exited',ended_at=now() WHERE run_id=%s", (run["run_id"],))
    await scan(client, container)
    assert saved_model(db, aid) == DEFAULT_MODEL
    assert db.execute("SELECT session_id FROM conversations WHERE id=%s", (conv,))[0]["session_id"] is None


@pytest.mark.parametrize("column", ["wake_lease_until", "conv_lease_until"])
async def test_unregistered_launch_lease_defers_migration(client, container, make_agent, db, column):
    from portal_backend import sql

    aid = await saved_agent(make_agent, db)
    db.execute(f"INSERT INTO agent_wake_state(agent_id,{column}) VALUES (%s,%s)", (aid, sql.from_now(600)))
    await scan(client, container)
    assert saved_model(db, aid) == RETIRED
    db.execute(f"UPDATE agent_wake_state SET {column}=NULL WHERE agent_id=%s", (aid,))
    await scan(client, container)
    assert saved_model(db, aid) == DEFAULT_MODEL


async def test_persona_launch_boundary_migrates_without_a_wake_scan(client, make_agent, db):
    aid = await saved_agent(make_agent, db)
    response = await client.get(f"/api/agents/{aid}/persona")
    assert response.status_code == 200, response.text
    assert response.json()["model"] == DEFAULT_MODEL
    assert saved_model(db, aid) == DEFAULT_MODEL


async def test_claim_migrates_and_returns_fresh_cold_launch_state(client, make_agent, db):
    aid = await saved_agent(make_agent, db)
    response = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 600, "kind": "ephemeral"})
    assert response.status_code == 200, response.text
    claim = response.json()
    assert claim["claimed"] is True
    assert claim["model"] == DEFAULT_MODEL
    assert claim["reasoning_effort"] == "max"
    assert claim["cold_required"] is True
    assert saved_model(db, aid) == DEFAULT_MODEL
    again = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 600, "kind": "ephemeral"})
    assert again.json()["claimed"] is False
    assert len(db.execute("SELECT 1 FROM events WHERE entity_id=%s AND event_type='model_changed'", (aid,))) == 1


@pytest.mark.parametrize('lane', ['work', 'conversation'])
async def test_claim_cleanup_never_releases_a_later_claim_or_registered_worker(client, make_agent, lane):
    aid = (await make_agent("Admission ownership"))["agent_id"]
    first = str(uuid.uuid4())
    second = str(uuid.uuid4())
    async def claim(identity):
        return (await client.post(f"/api/agents/{aid}/wake-claim", json={"lane": lane, "claim_id": identity})).json()
    async def release(identity):
        return (await client.post(f"/api/agents/{aid}/wake-ack", json={
            "lane": lane, "claim_id": identity, "release_lease": True, "kind": "failed_launch",
        })).json()
    assert (await claim(first))['claim_id'] == first
    assert (await release(second))['released'] is False
    await release(first)
    assert (await claim(second))['claimed']
    assert (await release(first))['released'] is False
    response = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "lane": lane})
    assert response.status_code == 201
    assert (await release(second))['released'] is False


@pytest.mark.parametrize("conversation_busy", [False, True])
async def test_checkpoint_reentry_persists_once_without_changing_an_active_conversation(
    client, make_agent, container, db, conversation_busy,
):
    from portal_backend import sql

    aid = await saved_agent(make_agent, db)
    # The old installation admitted this worker before the retirement shipped.
    db.execute("INSERT INTO agent_wake_state(agent_id,wake_lease_until) VALUES (%s,%s)",
               (aid, sql.from_now(600)))
    response = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "lane": "work"})
    assert response.status_code == 201, response.text
    old_run = response.json()["run_id"]
    human = (await make_agent("Person", kind="human"))["agent_id"]
    pin = str(uuid.uuid4())
    conv = db.execute(
        "INSERT INTO conversations(container_id,agent_id,started_by,session_id,session_pinned_at) "
        "VALUES (%s,%s,%s,%s,now()) RETURNING id", (container['id'], aid, human, pin),
    )[0]['id']
    if conversation_busy:
        db.execute("UPDATE agent_wake_state SET conv_lease_until=%s WHERE agent_id=%s",
                   (sql.from_now(600), aid))
    assert (await client.post(f"/api/runs/{old_run}/finish", json={"status": "exited", "exit_code": 0})).status_code == 200
    # Merely refreshing persona while retaining the old lease must not migrate.
    await client.get(f"/api/agents/{aid}/persona")
    assert saved_model(db, aid) == RETIRED
    released = await client.post(f"/api/agents/{aid}/wake-ack", json={
        "kind": "model_retired_checkpoint", "run_id": old_run, "lane": "work", "release_lease": True,
    })
    assert released.status_code == 200, released.text
    admitted = await client.post(f"/api/agents/{aid}/wake-claim", json={"kind": "ephemeral", "lane": "work"})
    assert admitted.json()["claimed"] is True
    assert admitted.json()["model"] == DEFAULT_MODEL
    assert admitted.json()["cold_required"] is True
    assert saved_model(db, aid) == (RETIRED if conversation_busy else DEFAULT_MODEL)
    saved_pin = db.execute("SELECT session_id FROM conversations WHERE id=%s", (conv,))[0]['session_id']
    assert (str(saved_pin) if saved_pin else None) == (pin if conversation_busy else None)
    # Once both lanes release, retries converge without duplicate records.
    db.execute("UPDATE agent_wake_state SET wake_lease_until=NULL,conv_lease_until=NULL WHERE agent_id=%s", (aid,))
    for _ in range(2):
        await scan(client, container)
    assert saved_model(db, aid) == DEFAULT_MODEL
    assert len(db.execute("SELECT 1 FROM events WHERE entity_id=%s AND event_type='model_changed'", (aid,))) == 1


async def test_restore_of_retired_model_is_rejected_before_profile_changes(client, container, make_agent, db):
    aid = await saved_agent(make_agent, db)
    await scan(client, container)  # records the historical configuration as revision 1
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    db.execute("UPDATE agents SET role='new role' WHERE id=%s", (aid,))
    before = db.execute("SELECT * FROM agents WHERE id=%s", (aid,))[0]
    preview = (await client.get(f"/api/agents/{aid}/config-revisions/1")).json()
    assert any(b["field"] == "model" for b in preview["restore_blocked"])
    response = await client.post(f"/api/agents/{aid}/config-revisions/1/restore", json={"actor_agent_id": human})
    assert response.status_code == 409, response.text
    assert "retired" in response.text
    assert db.execute("SELECT * FROM agents WHERE id=%s", (aid,))[0] == before


def test_onboarding_cannot_propose_the_retired_model():
    from portal_backend.onboarding_prompt import _propose_roster_tool_schema
    from portal_backend.onboarding_normalization import _normalize_roster_payload

    schema = _propose_roster_tool_schema()["input_schema"]
    choices = schema["properties"]["agents"]["items"]["properties"]["model_hint"]["enum"]
    assert RETIRED not in choices
    assert "claude-fable-5-2" in choices
    roster = _normalize_roster_payload({
        "agents": [{"name": "Old", "role": "eng", "charter": "Work", "model_hint": RETIRED}],
        "tasks": [{"title": "Work", "definition_of_done": "Ready for review", "assignee": "Old"}],
    })
    assert roster["agents"][0]["model_hint"] is None


def test_admission_replaces_stale_model_and_session_before_launch():
    from orcha_cli.launch_model import admitted_candidate

    old = {"model": RETIRED, "model_runtime": "claude", "session_id": "old-pin", "reasoning_effort": "max"}
    new = admitted_candidate(old, {"model": DEFAULT_MODEL, "model_runtime": "claude", "reasoning_effort": "max"})
    assert new["model"] == DEFAULT_MODEL and new["session_id"] is None and new["cold_required"]
    assert old["model"] == RETIRED and old["session_id"] == "old-pin"
    # A scan may already have resolved the model while still carrying an old pin.
    resolved = {**old, "model": DEFAULT_MODEL}
    assert admitted_candidate(resolved, {"model": DEFAULT_MODEL, "cold_required": True})["session_id"] is None


async def test_other_supported_agent_models_are_not_migrated(client, container, make_agent, db):
    models = (await client.get("/api/models")).json()["models"]
    agents = []
    for i, model in enumerate(models):
        aid = (await make_agent(f"Model{i}", "engineer"))["agent_id"]
        db.execute("UPDATE agents SET model=%s WHERE id=%s", (model["id"], aid))
        agents.append((aid, model["id"]))
    await scan(client, container)
    assert [(aid, saved_model(db, aid)) for aid, _ in agents] == agents


async def test_human_live_claim_does_not_acquire_an_ai_model(client, make_agent):
    aid = (await make_agent("HumanTerminal", kind="human"))["agent_id"]
    response = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_kind": "live", "kind": "live"})
    assert response.status_code == 200, response.text
    assert response.json()["claimed"]
    assert not response.json().get("model")


async def test_competing_lane_claims_record_one_migration(client, make_agent, db):
    import asyncio

    aid = await saved_agent(make_agent, db)
    claims = await asyncio.gather(*(
        client.post(f"/api/agents/{aid}/wake-claim", json={"lane": lane})
        for lane in ("work", "conversation")
    ))
    assert all(r.status_code == 200 and r.json()["claimed"] for r in claims)
    assert all(r.json()["model"] == DEFAULT_MODEL for r in claims)
    assert saved_model(db, aid) == DEFAULT_MODEL
    assert len(db.execute("SELECT 1 FROM events WHERE entity_id=%s AND event_type='model_changed'", (aid,))) == 1


async def test_migration_and_history_rollback_together_then_retry(client, make_agent, db, monkeypatch):
    from portal_backend import model_retirement

    aid = await saved_agent(make_agent, db)
    def fail_history(*args, **kwargs):
        raise RuntimeError("simulated history failure")
    with monkeypatch.context() as patch:
        patch.setattr(model_retirement, "record_config_change", fail_history)
        with pytest.raises(RuntimeError, match="simulated history failure"):
            await client.post(f"/api/agents/{aid}/wake-claim", json={})
    assert saved_model(db, aid) == RETIRED
    assert db.execute("SELECT 1 FROM agent_config_revisions WHERE agent_id=%s", (aid,)) == []
    assert db.execute("SELECT 1 FROM events WHERE entity_id=%s AND event_type='model_changed'", (aid,)) == []
    retry = await client.post(f"/api/agents/{aid}/wake-claim", json={})
    assert retry.json()["claimed"] and retry.json()["model"] == DEFAULT_MODEL
    assert saved_model(db, aid) == DEFAULT_MODEL
