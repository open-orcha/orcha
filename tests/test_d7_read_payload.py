"""D7 — enriched container read payload + ISS-41 read-path.

GET /api/containers/{cid} gains additive, backward-compatible fields so the redesign
renders without extra calls and the approval card suppresses durably:
- agent: model, wake_enabled, current_task, last_active
- task:  plan_decision (latest plan_approval decision → ISS-41 root fix) + runs summary
- request: task_link (the spawned task, resolved)
Plus per-agent `model` is stored at registration (default Opus 4.8; NULL for humans).
"""
import pytest


async def _get_container(client, cid):
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    return r.json()


def _agent(payload, alias):
    return next(a for a in payload["agents"] if a["alias"] == alias)


def _task(payload, tid):
    return next(t for t in payload["tasks"] if t["id"] == tid)


# ---------- per-agent: model ----------

@pytest.mark.asyncio
async def test_model_defaults_to_opus_for_ai(client, container, make_agent):
    await make_agent("Aiden", "eng")                      # no model → server default
    p = await _get_container(client, container["id"])
    assert _agent(p, "Aiden")["model"] == "claude-opus-4-8"


@pytest.mark.asyncio
async def test_model_honored_when_provided(client, container):
    r = await client.post(f"/api/containers/{container['id']}/agents",
                          json={"alias": "Sonny", "role": "eng", "kind": "ai",
                                "prompt": "p", "model": "claude-sonnet-5"})
    assert r.status_code in (200, 201), r.text
    p = await _get_container(client, container["id"])
    assert _agent(p, "Sonny")["model"] == "claude-sonnet-5"


@pytest.mark.asyncio
async def test_human_has_null_model(client, container, make_agent):
    await make_agent("Kedar", "human", kind="human")
    p = await _get_container(client, container["id"])
    assert _agent(p, "Kedar")["model"] is None


@pytest.mark.asyncio
async def test_unknown_model_rejected(client, container):
    r = await client.post(f"/api/containers/{container['id']}/agents",
                          json={"alias": "Bad", "role": "eng", "kind": "ai",
                                "prompt": "p", "model": "gpt-9-ultra"})
    assert r.status_code == 400, r.text
    assert "not a known model" in r.text


@pytest.mark.asyncio
async def test_list_models_endpoint(client):
    r = await client.get("/api/models")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["default"] == "claude-opus-4-8"
    ids = {m["id"] for m in body["models"]}
    assert "claude-opus-4-8" in ids and "claude-sonnet-5" in ids
    assert "gpt-5.5" in ids and "gpt-5.4-mini" in ids
    assert all("id" in m and "name" in m for m in body["models"])   # {id,name} shape
    assert all("runtime" in m for m in body["models"])


# ---------- per-agent: wake_enabled / current_task / last_active ----------

@pytest.mark.asyncio
async def test_wake_enabled_defaults_true_and_reflects_optout(client, container, make_agent, db):
    a = await make_agent("Worky", "eng")
    aid = a["agent_id"]
    p = await _get_container(client, container["id"])
    assert _agent(p, "Worky")["wake_enabled"] is True        # no reachability row → default true

    db.execute("INSERT INTO agent_reachability (agent_id, wake_enabled) VALUES (%s, false)", (aid,))
    p = await _get_container(client, container["id"])
    assert _agent(p, "Worky")["wake_enabled"] is False       # opt-out reflected


@pytest.mark.asyncio
async def test_current_task_reflects_working_assignment(client, container, make_agent, make_task, db):
    a = await make_agent("Tasky", "eng")
    aid = a["agent_id"]
    t = await make_task("do the thing", "done when done", assignee_alias="Tasky")
    tid = t["id"]
    # assignee starts as 'assigned'; mark it actively worked
    db.execute("UPDATE agent_tasks SET assignment_status='working' WHERE agent_id=%s AND task_id=%s",
               (aid, tid))
    p = await _get_container(client, container["id"])
    ct = _agent(p, "Tasky")["current_task"]
    assert ct is not None and ct["task_id"] == tid and ct["title"] == "do the thing"


@pytest.mark.asyncio
async def test_current_task_null_when_idle(client, container, make_agent):
    await make_agent("Idle", "eng")
    p = await _get_container(client, container["id"])
    assert _agent(p, "Idle")["current_task"] is None


# ---------- per-task: plan_decision (ISS-41) ----------

@pytest.mark.asyncio
async def test_plan_decision_latest_wins(client, container, make_agent, make_task, db):
    human = await make_agent("Boss", "human", kind="human")
    hid = human["agent_id"]
    t = await make_task("ship it", "dod")
    tid = t["id"]

    p = await _get_container(client, container["id"])
    assert _task(p, tid)["plan_decision"] is None            # no decision yet

    # an earlier reject, then a later approve → latest (approve) must win
    db.execute("""INSERT INTO decisions (container_id, subject_type, subject_id, decision, reason,
                      actor_agent_id, created_at)
                  VALUES (%s,'plan_approval',%s,'reject','needs work',%s, now() - interval '1 minute')""",
               (container["id"], tid, hid))
    db.execute("""INSERT INTO decisions (container_id, subject_type, subject_id, decision, reason,
                      actor_agent_id, created_at)
                  VALUES (%s,'plan_approval',%s,'approve','lgtm',%s, now())""",
               (container["id"], tid, hid))

    p = await _get_container(client, container["id"])
    pd = _task(p, tid)["plan_decision"]
    assert pd is not None
    assert pd["decision"] == "approve" and pd["reason"] == "lgtm" and pd["actor"] == "Boss"


@pytest.mark.asyncio
async def test_plan_decision_ignores_other_subject_types(client, container, make_agent, make_task, db):
    human = await make_agent("Boss2", "human", kind="human")
    t = await make_task("x", "dod")
    db.execute("""INSERT INTO decisions (container_id, subject_type, subject_id, decision, reason,
                      actor_agent_id) VALUES (%s,'task_verify',%s,'approve','ok',%s)""",
               (container["id"], t["id"], human["agent_id"]))
    p = await _get_container(client, container["id"])
    assert _task(p, t["id"])["plan_decision"] is None        # task_verify != plan_approval


# ---------- per-task: runs summary ----------

@pytest.mark.asyncio
async def test_runs_summary(client, container, make_agent, make_task, db):
    a = await make_agent("Runner", "eng")
    t = await make_task("y", "dod")
    aid, tid = a["agent_id"], t["id"]
    db.execute("""INSERT INTO worker_runs (agent_id, task_id, status, exit_code, started_at)
                  VALUES (%s,%s,'exited',0, now() - interval '2 minutes')""", (aid, tid))
    db.execute("""INSERT INTO worker_runs (agent_id, task_id, status, started_at)
                  VALUES (%s,%s,'running', now())""", (aid, tid))
    p = await _get_container(client, container["id"])
    runs = _task(p, tid)["runs"]
    assert runs["count"] == 2
    assert runs["latest"]["status"] == "running"             # newest by started_at


@pytest.mark.asyncio
async def test_runs_empty_when_none(client, container, make_task):
    t = await make_task("z", "dod")
    p = await _get_container(client, container["id"])
    runs = _task(p, t["id"])["runs"]
    assert runs["count"] == 0 and runs["latest"] is None


# ---------- per-request: task_link ----------

@pytest.mark.asyncio
async def test_request_task_link_resolves_spawned_task(client, container, make_agent, make_task, make_request, db):
    a = await make_agent("Req", "eng")
    t = await make_task("linked", "dod")
    req = await make_request(a["agent_id"], "please", target_alias="Req")
    db.execute("UPDATE requests SET spawned_task_id=%s WHERE id=%s", (t["id"], req["id"]))
    p = await _get_container(client, container["id"])
    r = next(x for x in p["requests"] if x["id"] == req["id"])
    assert r["task_link"] == {"task_id": t["id"], "title": "linked", "status": t.get("status", "ready")} \
           or (r["task_link"]["task_id"] == t["id"] and r["task_link"]["title"] == "linked")


@pytest.mark.asyncio
async def test_request_task_link_null_without_spawn(client, container, make_agent, make_request):
    a = await make_agent("Req2", "eng")
    req = await make_request(a["agent_id"], "no spawn", target_alias="Req2")
    p = await _get_container(client, container["id"])
    r = next(x for x in p["requests"] if x["id"] == req["id"])
    assert r["task_link"] is None


# ---------- backward compatibility ----------

@pytest.mark.asyncio
async def test_existing_keys_preserved(client, container, make_agent, make_task):
    await make_agent("Compat", "eng")
    await make_task("keep", "dod")
    p = await _get_container(client, container["id"])
    a = _agent(p, "Compat")
    for k in ("id", "alias", "role", "kind", "status", "waiting_on"):
        assert k in a
    t = p["tasks"][0]
    # ISS-68: the snapshot drops the full `messages` thread for a compact `message_summary`
    # (+ plan_message); the full thread is lazy via GET /api/tasks/{tid}/messages.
    for k in ("id", "title", "status", "assignees", "message_summary"):
        assert k in t
    assert "messages" not in t, "snapshot still ships the full per-task thread (ISS-68 trim)"


# ---------- §3b: per-agent embodiment (live lease state for the lock/guard UX) ----------

@pytest.mark.asyncio
async def test_embodiment_defaults_idle(client, container, make_agent):
    a = await make_agent("Solo")
    p = await _get_container(client, container["id"])
    assert _agent(p, "Solo")["embodiment"] == "idle"


@pytest.mark.asyncio
async def test_embodiment_reflects_live_lease(client, container, make_agent):
    """A held 'live' terminal lease surfaces as embodiment='live' so the portal can show the
    live-session indicator + lock the conversation panel / guard 'Open terminal'."""
    a = await make_agent("Paired")
    await client.post(f"/api/agents/{a['agent_id']}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "live"})
    p = await _get_container(client, container["id"])
    assert _agent(p, "Paired")["embodiment"] == "live"


@pytest.mark.asyncio
async def test_embodiment_reflects_ephemeral_and_resident(client, container, make_agent):
    eph = await make_agent("Eph")
    res = await make_agent("Res")
    await client.post(f"/api/agents/{eph['agent_id']}/wake-claim", json={"lease_ttl": 300})
    await client.post(f"/api/agents/{res['agent_id']}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    p = await _get_container(client, container["id"])
    assert _agent(p, "Eph")["embodiment"] == "ephemeral"
    assert _agent(p, "Res")["embodiment"] == "resident"
