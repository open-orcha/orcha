"""Agent config history + rollback (migration 055_agent_config_revisions).

Covers: a revision on every mutating config route (PATCH profile / autonomy_override,
POST model, POST reasoning-effort, PATCH auto-wake) with field-level before/after + actor;
no-op and failed writes record nothing; lazy 'initial' backfill; filters + paging;
restore semantics (new 'restore' revisions through the same routes, history untouched);
authority (human actor, grants, viewer read-only); secret exclusion; row immutability.
"""
import psycopg
import pytest

from conftest import TEST_URL

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}

SECRET = "sk-ant-api03-AAAAbbbbCCCCddddEEEEffff0123456789"


async def _history(client, aid, headers=None, **params):
    r = await client.get(f"/api/agents/{aid}/config-revisions", params=params, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _rev(client, aid, n, headers=None):
    r = await client.get(f"/api/agents/{aid}/config-revisions/{n}", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _changes(rev):
    return {c["field"]: (c["before"], c["after"]) for c in rev["changes"]}


@pytest.fixture
async def boss_and_bot(make_agent):
    human = await make_agent("Boss", "human", kind="human")
    bot = await make_agent("Bot", "eng", prompt="p1")
    return human["agent_id"], bot["agent_id"]


# ---------------------------------------------------------------- capture per route

async def test_backfill_initial_on_first_read_is_idempotent(client, boss_and_bot, db):
    _, aid = boss_and_bot
    h = await _history(client, aid)
    assert h["total"] == 1 and h["latest_revision_no"] == 1
    r1 = h["revisions"][0]
    assert r1["kind"] == "initial" and r1["changes"] == [] and r1["actor"] is None
    full = await _rev(client, aid, 1)
    assert full["snapshot"]["system_prompt"] == "p1" and full["snapshot"]["role"] == "eng"
    assert full["snapshot"]["provider"] == "claude"
    h2 = await _history(client, aid)
    assert h2["total"] == 1  # no duplicate initial


async def test_profile_patch_records_field_diff_and_actor(client, boss_and_bot):
    human, aid = boss_and_bot
    r = await client.patch(f"/api/agents/{aid}", json={
        "actor_agent_id": human, "role": "architect", "system_prompt": "p2"})
    assert r.status_code == 200, r.text
    h = await _history(client, aid)
    assert [x["revision_no"] for x in h["revisions"]] == [2, 1]
    change, initial = h["revisions"]
    # initial captured from the PRE-change state, not the post-change one
    assert initial["kind"] == "initial"
    assert (await _rev(client, aid, 1))["snapshot"]["system_prompt"] == "p1"
    assert change["kind"] == "change" and change["source"] == "profile"
    assert _changes(change) == {"role": ("eng", "architect"), "system_prompt": ("p1", "p2")}
    assert change["actor"] == {"agent_id": human, "alias": "Boss", "kind": "human"}


async def test_noop_and_failed_writes_record_nothing(client, boss_and_bot, make_agent):
    human, aid = boss_and_bot
    await make_agent("Taken", "eng")
    r = await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "role": "eng"})
    assert r.status_code == 200
    r = await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "alias": "Taken"})
    assert r.status_code == 409
    h = await _history(client, aid)
    assert h["total"] == 1 and h["revisions"][0]["kind"] == "initial"


async def test_alias_rename_and_autonomy_override_set_and_clear(client, boss_and_bot):
    human, aid = boss_and_bot
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "alias": "Bot2"})
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "autonomy_override": "full"})
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "autonomy_override": None})
    revs = (await _history(client, aid))["revisions"]
    assert _changes(revs[0]) == {"autonomy_override": ("full", None)}
    assert _changes(revs[1]) == {"autonomy_override": (None, "full")}
    assert _changes(revs[2]) == {"alias": ("Bot", "Bot2")}


async def test_model_change_records_model_effort_and_derived_provider(client, boss_and_bot):
    _, aid = boss_and_bot
    r = await client.post(f"/api/agents/{aid}/reasoning-effort", json={"reasoning_effort": "high"})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/agents/{aid}/model", json={"model": "claude-haiku-4-5-20251001"})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/agents/{aid}/model", json={"model": "gpt-5.6-sol"})
    assert r.status_code == 200, r.text
    revs = (await _history(client, aid))["revisions"]
    effort, haiku = revs[2], revs[1]
    assert effort["source"] == "reasoning_effort"
    assert _changes(effort)["reasoning_effort"][1] == "high"
    # self-host model/effort swaps carry no actor: recorded as unattributed, never guessed
    assert effort["actor"] is None
    # haiku supports no effort → the route clears it; the revision says so
    assert _changes(haiku) == {
        "model": ("claude-opus-5-5", "claude-haiku-4-5-20251001"),  # #260: new agents default to Opus 5.5
        "reasoning_effort": ("high", None),
    }
    gpt = revs[0]
    c = {x["field"]: x for x in gpt["changes"]}
    assert c["model"]["after"] == "gpt-5.6-sol"
    assert c["provider"] == {"field": "provider", "before": "claude", "after": "codex", "derived": True}


async def test_auto_wake_recorded(client, boss_and_bot):
    human, aid = boss_and_bot
    r = await client.patch(f"/api/agents/{aid}/auto-wake", json={"actor_agent_id": human, "interval_secs": 600})
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/agents/{aid}/auto-wake", json={"actor_agent_id": human})
    assert r.status_code == 200, r.text
    revs = (await _history(client, aid))["revisions"]
    assert revs[1]["source"] == "auto_wake"
    assert _changes(revs[1]) == {"auto_wake_interval_secs": (None, 600)}
    assert _changes(revs[0]) == {"auto_wake_interval_secs": (600, None)}
    assert revs[0]["actor"]["alias"] == "Boss"


# ---------------------------------------------------------------- filters / paging / errors

async def test_filters_and_paging(client, boss_and_bot):
    human, aid = boss_and_bot
    for i in range(3):
        await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "role": f"r{i}"})
    await client.post(f"/api/agents/{aid}/model", json={"model": "claude-sonnet-5"})
    assert (await _history(client, aid, field="model"))["total"] == 1
    assert (await _history(client, aid, field="role"))["total"] == 3
    assert (await _history(client, aid, actor_kind="none"))["total"] == 2  # initial + model
    assert (await _history(client, aid, actor_kind="human"))["total"] == 3
    assert (await _history(client, aid, kind="initial"))["total"] == 1
    p1 = await _history(client, aid, limit=2)
    assert [r["revision_no"] for r in p1["revisions"]] == [5, 4] and p1["next_before"] == 4
    p2 = await _history(client, aid, limit=2, before=p1["next_before"])
    assert [r["revision_no"] for r in p2["revisions"]] == [3, 2]
    p3 = await _history(client, aid, limit=2, before=p2["next_before"])
    assert [r["revision_no"] for r in p3["revisions"]] == [1] and p3["next_before"] is None


async def test_bad_inputs(client, boss_and_bot):
    _, aid = boss_and_bot
    assert (await client.get(f"/api/agents/{aid}/config-revisions?field=grants")).status_code == 400
    assert (await client.get(f"/api/agents/{aid}/config-revisions?kind=nope")).status_code == 400
    assert (await client.get("/api/agents/not-a-uuid/config-revisions")).status_code == 400
    assert (await client.get(f"/api/agents/{aid}/config-revisions/99")).status_code == 404
    r = await client.post(f"/api/agents/{aid}/config-revisions/99/restore", json={"actor_agent_id": boss_and_bot[0]})
    assert r.status_code == 404


# ---------------------------------------------------------------- restore

async def test_restore_reapplies_and_appends_without_rewriting(client, boss_and_bot, db):
    human, aid = boss_and_bot
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "system_prompt": "p2"})
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "system_prompt": "p3"})
    before_rows = db.execute("SELECT * FROM agent_config_revisions WHERE agent_id=%s ORDER BY revision_no", (aid,))
    preview = await _rev(client, aid, 2)
    assert preview["restore_preview"] == [
        {"field": "system_prompt", "current": "p3", "target": "p2", "grant": "manage_agents"}]
    r = await client.post(f"/api/agents/{aid}/config-revisions/2/restore",
                          json={"actor_agent_id": human, "reason": "p3 regressed"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["applied"] == ["system_prompt"] and out["restored_from"] == 2
    [new] = out["revisions"]
    assert new["revision_no"] == 4 and new["kind"] == "restore" and new["restored_from"] == 2
    assert new["reason"] == "p3 regressed" and new["actor"]["alias"] == "Boss"
    assert _changes(new) == {"system_prompt": ("p3", "p2")}
    persona = (await client.get(f"/api/agents/{aid}/persona")).json()
    assert persona["system_prompt"] == "p2"
    after_rows = db.execute("SELECT * FROM agent_config_revisions WHERE agent_id=%s ORDER BY revision_no", (aid,))
    assert after_rows[:3] == before_rows  # history untouched
    # the route's own audit event fired too (same path as a human edit)
    ev = db.execute("SELECT * FROM events WHERE entity_id=%s AND event_type='agent_updated'", (aid,))
    assert len(ev) == 3


async def test_restore_multi_field_through_all_routes(client, boss_and_bot):
    human, aid = boss_and_bot
    # revision #2 is the target: effort=high on opus, wake 600, override pr
    await client.post(f"/api/agents/{aid}/reasoning-effort", json={"reasoning_effort": "high"})
    await client.patch(f"/api/agents/{aid}/auto-wake", json={"actor_agent_id": human, "interval_secs": 600})
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "autonomy_override": "pr"})
    target_no = (await _history(client, aid))["latest_revision_no"]
    target = (await _rev(client, aid, target_no))["snapshot"]
    # drift everything
    await client.post(f"/api/agents/{aid}/model", json={"model": "claude-haiku-4-5-20251001"})  # clears effort
    await client.patch(f"/api/agents/{aid}/auto-wake", json={"actor_agent_id": human})
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "autonomy_override": None,
                                                   "role": "drifted", "system_prompt": "drift"})
    r = await client.post(f"/api/agents/{aid}/config-revisions/{target_no}/restore", json={"actor_agent_id": human})
    assert r.status_code == 200, r.text
    out = r.json()
    assert set(out["applied"]) == {"role", "system_prompt", "autonomy_override", "model",
                                   "reasoning_effort", "auto_wake_interval_secs"}
    assert all(x["kind"] == "restore" and x["restored_from"] == target_no for x in out["revisions"])
    assert {x["source"] for x in out["revisions"]} == {"profile", "model", "reasoning_effort", "auto_wake"}
    # model/effort routes resolve no actor in self-host: the restore's human is credited
    assert all(x["actor"] and x["actor"]["alias"] == "Boss" for x in out["revisions"])
    latest = (await _history(client, aid))["latest_revision_no"]
    now = (await _rev(client, aid, latest))["snapshot"]
    assert now == target
    # restoring again is a no-op (nothing differs) — no new revision
    r = await client.post(f"/api/agents/{aid}/config-revisions/{target_no}/restore", json={"actor_agent_id": human})
    assert r.status_code == 200 and r.json()["applied"] == []
    assert (await _history(client, aid))["latest_revision_no"] == latest


async def test_restore_requires_human_actor(client, boss_and_bot):
    human, aid = boss_and_bot
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "role": "x"})
    r = await client.post(f"/api/agents/{aid}/config-revisions/1/restore", json={"actor_agent_id": aid})
    assert r.status_code == 403, r.text
    r = await client.post(f"/api/agents/{aid}/config-revisions/1/restore", json={})
    assert r.status_code == 400, r.text
    assert (await _history(client, aid))["latest_revision_no"] == 2


# ---------------------------------------------------------------- secrets / immutability

async def test_secrets_are_redacted_and_never_restored(client, boss_and_bot, db):
    human, aid = boss_and_bot
    r = await client.patch(f"/api/agents/{aid}", json={
        "actor_agent_id": human, "system_prompt": f"use key {SECRET} carefully"})
    assert r.status_code == 200
    await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": human, "system_prompt": "clean"})
    raw = db.execute("SELECT snapshot::text AS s, changes::text AS c FROM agent_config_revisions WHERE agent_id=%s", (aid,))
    assert raw and all(SECRET not in row["s"] and SECRET not in row["c"] for row in raw)
    rev2 = await _rev(client, aid, 2)
    assert rev2["redacted_fields"] == ["system_prompt"]
    assert rev2["snapshot"]["system_prompt"] == "use key [redacted secret] carefully"
    # only whitelisted config keys are ever stored — no keys/tokens/grants columns
    assert set(rev2["snapshot"]) == {"alias", "role", "system_prompt", "model", "reasoning_effort",
                                     "auto_wake_interval_secs", "autonomy_override", "provider"}
    assert rev2["restore_blocked"] and rev2["restore_blocked"][0]["field"] == "system_prompt"
    r = await client.post(f"/api/agents/{aid}/config-revisions/2/restore", json={"actor_agent_id": human})
    assert r.status_code == 409 and "secret" in r.text
    assert (await client.get(f"/api/agents/{aid}/persona")).json()["system_prompt"] == "clean"


async def test_revisions_are_immutable(client, boss_and_bot):
    _, aid = boss_and_bot
    await _history(client, aid)
    with psycopg.connect(TEST_URL) as conn:
        with pytest.raises(psycopg.errors.RaiseException):
            conn.execute("UPDATE agent_config_revisions SET reason='x' WHERE agent_id=%s", (aid,))


# ---------------------------------------------------------------- trusted-proxy authority

@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _invite(client, cid, login, role="member"):
    r = await client.post(f"/api/containers/{cid}/members",
                          json={"github_login": login, "role": role}, headers=OCTO)
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


async def test_authority_matrix_under_proxy(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).status_code == 200
    hubot = await _invite(client, cid, "hubot")
    await _invite(client, cid, "vera", role="viewer")
    bot = (await client.post(f"/api/containers/{cid}/agents", headers=OCTO,
                             json={"alias": "Bot", "role": "eng", "kind": "ai", "prompt": "p1"})).json()
    aid = bot["agent_id"]
    r = await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": "ignored", "system_prompt": "p2"},
                           headers=OCTO)
    assert r.status_code == 200, r.text
    # viewers + members READ history; a stranger can't
    assert (await _history(client, aid, headers=VERA))["total"] == 2
    assert (await _history(client, aid, headers=HUBOT))["total"] == 2
    assert (await client.get(f"/api/agents/{aid}/config-revisions", headers=MALLORY)).status_code == 403
    url = f"/api/agents/{aid}/config-revisions/1/restore"
    # viewer + grant-less member are refused; nothing is applied
    assert (await client.post(url, json={}, headers=VERA)).status_code == 403
    r = await client.post(url, json={}, headers=HUBOT)
    assert r.status_code == 403 and "manage_agents" in r.text
    assert (await _history(client, aid, headers=OCTO))["latest_revision_no"] == 2
    # a manage_agents grant unlocks it; the proxy identity is the credited actor
    r = await client.patch(f"/api/containers/{cid}/members/{hubot}", json={"grants": ["manage_agents"]},
                           headers=OCTO)
    assert r.status_code == 200, r.text
    r = await client.post(url, json={"reason": "rollback"}, headers=HUBOT)
    assert r.status_code == 200, r.text
    [rev] = r.json()["revisions"]
    assert rev["actor"]["agent_id"] == hubot and rev["restored_from"] == 1
    # an autonomy restore needs manage_autonomy too (checked up front, whole restore refused)
    r = await client.patch(f"/api/agents/{aid}", json={"actor_agent_id": "x", "autonomy_override": "full"},
                           headers=OCTO)
    assert r.status_code == 200
    r = await client.post(url, json={}, headers=HUBOT)
    assert r.status_code == 403 and "manage_autonomy" in r.text
