"""Push pipeline (mig 041) — device registry, needs-you outbox hook, box lane.

Contract under test (portal_backend/push_routes.py + push_outbox.py):

  * /api/push/devices — IDENTITY-level like /api/prefs: a trusted login mapped
    as a live human in ANY project registers/lists/revokes its own APNs tokens.
    Untrusted / headerless / unmapped callers: 403. Upsert by token RE-OWNS the
    row to the current login. DELETE: own, or an owner of a project the holder
    is a member of.
  * The outbox hook fires AFTER COMMIT, best-effort, on exactly the three
    needs-you birth transitions — task→needs_verification, the OPENING
    agent-authored plan message, request opened targeting a human — and on
    nothing else. No registered devices → no rows (dormant). A broken hook
    never breaks the main transaction.
  * Box lane (/api/push/outbox/claim, /mark, /api/push/devices/
    revoke-unregistered): headerless/loopback callers only (a trusted browser
    identity is 403). Claim resolves recipient devices AT SEND TIME and prunes
    rows older than 48h.
"""
import pytest


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    """This suite exercises Team-plan features (members/device identity) under the
    plan-gating addendum (docs/orcha-cloud-local-run.md) — same idiom as
    tests/test_access_model.py. Solo-tier 402 behavior is covered by
    tests/test_plan_gating.py, so nothing here masks the gate itself."""
    monkeypatch.setenv("ORCHA_PLAN", "team")


pytestmark = pytest.mark.asyncio

OCTO = {"X-Auth-Request-User": "octocat"}      # bound owner of the arena
HUBOT = {"X-Auth-Request-User": "hubot"}       # invited member
MALLORY = {"X-Auth-Request-User": "mallory"}   # verified stranger — mapped nowhere

TOKEN_A = "a" * 64
TOKEN_B = "b" * 64
TOKEN_C = "c" * 64


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    ident = r.json()["identity"]
    assert ident and ident["member_role"] == "owner"
    return ident


async def _invite(client, cid, login, role="member"):
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": login, "role": role},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


async def _register(client, token, headers, platform=None):
    body = {"apns_token": token}
    if platform is not None:
        body["platform"] = platform
    return await client.post("/api/push/devices", json=body, headers=headers)


def _outbox(db):
    return db.execute(
        "SELECT container_id::text AS cid, kind, ref_id::text AS ref, title, body,"
        " delivered_at, failed FROM push_outbox ORDER BY created_at, id"
    )


# ---------- device registry: register / list / revoke ----------

async def test_register_upserts_and_reowns_by_token(
    client, container, make_agent, trust_proxy, db
):
    """Same physical phone, new signed-in member: the row follows the phone."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "hubot")

    r = await _register(client, TOKEN_A, OCTO)
    assert r.status_code == 201, r.text
    device = r.json()["device"]
    assert device["github_login"] == "octocat" and device["platform"] == "ios"

    # Uppercase hex + re-register → same row (lowercased), refreshed, same id
    r = await _register(client, TOKEN_A.upper(), OCTO)
    assert r.status_code == 201 and r.json()["device"]["id"] == device["id"]
    assert db.execute("SELECT count(*) AS n FROM push_devices")[0]["n"] == 1

    # hubot signs into the handed-down phone: row RE-OWNED, not duplicated
    r = await _register(client, TOKEN_A, HUBOT)
    assert r.status_code == 201 and r.json()["device"]["github_login"] == "hubot"
    rows = db.execute("SELECT github_login FROM push_devices")
    assert [row["github_login"] for row in rows] == ["hubot"]
    # ...and octocat no longer lists it
    assert (await client.get("/api/push/devices", headers=OCTO)).json() == {
        "devices": []
    }


async def test_register_revives_a_revoked_token(
    client, container, make_agent, trust_proxy, db
):
    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)
    r = await client.request(
        "DELETE", "/api/push/devices", json={"apns_token": TOKEN_A}, headers=OCTO
    )
    assert r.status_code == 200 and r.json()["revoked"] is True
    await _register(client, TOKEN_A, OCTO)
    row = db.execute("SELECT revoked_at FROM push_devices")[0]
    assert row["revoked_at"] is None


async def test_register_auth_gates_403(
    client, container, make_agent, trust_proxy, no_trust_proxy
):
    """Untrusted header, headerless trusted lane, and unmapped stranger: 403."""
    await make_agent("root", "operator", kind="human")
    r = await _register(client, TOKEN_A, OCTO)  # trust off: header is noise
    assert r.status_code == 403


async def test_register_unmapped_and_headerless_403(
    client, container, make_agent, trust_proxy
):
    await _bind_owner(client, container, make_agent)
    assert (await _register(client, TOKEN_A, MALLORY)).status_code == 403
    assert (await _register(client, TOKEN_A, {})).status_code == 403
    assert (await client.get("/api/push/devices", headers=MALLORY)).status_code == 403


async def test_register_validates_token_and_platform(
    client, container, make_agent, trust_proxy
):
    await _bind_owner(client, container, make_agent)
    assert (await _register(client, "not hex!", OCTO)).status_code == 422
    assert (await _register(client, "abc", OCTO)).status_code == 422  # too short
    assert (
        await _register(client, TOKEN_A, OCTO, platform="android")
    ).status_code == 422


async def test_list_is_own_devices_only(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "hubot")
    await _register(client, TOKEN_A, OCTO)
    await _register(client, TOKEN_B, HUBOT)
    mine = (await client.get("/api/push/devices", headers=OCTO)).json()["devices"]
    assert [d["apns_token"] for d in mine] == [TOKEN_A]


async def test_revoke_own_or_owner_gate(client, container, make_agent, trust_proxy):
    """A member revokes their own; an owner revokes a member's; a mere member
    cannot revoke someone else's; unknown token is 404."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "hubot")
    await _register(client, TOKEN_A, HUBOT)

    r = await client.request(
        "DELETE", "/api/push/devices", json={"apns_token": TOKEN_B}, headers=OCTO
    )
    assert r.status_code == 404

    # hubot (member) cannot revoke octocat's device
    await _register(client, TOKEN_B, OCTO)
    r = await client.request(
        "DELETE", "/api/push/devices", json={"apns_token": TOKEN_B}, headers=HUBOT
    )
    assert r.status_code == 403

    # octocat (owner of hubot's project) revokes hubot's device
    r = await client.request(
        "DELETE", "/api/push/devices", json={"apns_token": TOKEN_A}, headers=OCTO
    )
    assert r.status_code == 200 and r.json()["revoked"] is True
    # idempotent re-revoke
    r = await client.request(
        "DELETE", "/api/push/devices", json={"apns_token": TOKEN_A}, headers=HUBOT
    )
    assert r.status_code == 200 and r.json()["revoked"] is False


# ---------- the outbox hook: the three needs-you births ----------

async def test_done_enqueues_task_verify(
    client, container, make_agent, make_task, work_headers, trust_proxy, db
):
    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)
    dev = await make_agent("dev", "eng")
    t = await make_task("ship the widget", "done when shipped", assignee_alias="dev")
    r = await client.post(
        f"/api/tasks/{t['task_id']}/done",
        json={"agent_id": dev["agent_id"], "result": "x"},
        headers=await work_headers(dev["agent_id"]),
    )
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"
    rows = _outbox(db)
    assert len(rows) == 1
    assert rows[0]["kind"] == "task_verify" and rows[0]["ref"] == t["task_id"]
    assert rows[0]["title"] == "Verify task — test-arena"
    assert rows[0]["body"] == "ship the widget"
    assert rows[0]["delivered_at"] is None and rows[0]["failed"] is None


async def test_full_autonomy_done_enqueues_nothing(
    client, container, make_agent, make_task, work_headers, trust_proxy, db
):
    """`full` auto-completes — no human gate, so no needs-you push."""
    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)
    human = db.execute("SELECT id FROM agents WHERE kind='human'")[0]["id"]
    r = await client.post(
        f"/api/containers/{container['id']}/autonomy",
        json={"level": "full", "actor_agent_id": str(human)},
    )
    assert r.status_code == 200, r.text
    dev = await make_agent("dev", "eng")
    t = await make_task("auto", "done", assignee_alias="dev")
    r = await client.post(
        f"/api/tasks/{t['task_id']}/done",
        json={"agent_id": dev["agent_id"], "result": "x"},
        headers=await work_headers(dev["agent_id"]),
    )
    assert r.status_code == 200 and r.json()["status"] == "completed"
    assert _outbox(db) == []


async def test_opening_plan_message_enqueues_once(
    client, container, make_agent, make_task, trust_proxy, db
):
    """The FIRST agent-authored post on an in-progress task is the plan gate;
    later posts and human posts never re-fire."""
    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)
    dev = await make_agent("dev", "eng")
    t = await make_task("build widget", "done when shipped", assignee_alias="dev")

    # a HUMAN post first — not a plan, no push
    human = db.execute(
        "SELECT id::text AS id FROM agents WHERE kind='human'"
    )[0]["id"]
    r = await client.post(
        f"/api/tasks/{t['task_id']}/messages",
        json={"author_agent_id": human, "body": "any progress?"},
    )
    assert r.status_code == 201
    assert _outbox(db) == []

    # the agent's OPENING plan → exactly one plan_approval row
    r = await client.post(
        f"/api/tasks/{t['task_id']}/messages",
        json={"author_agent_id": dev["agent_id"], "body": "Plan: 1. do it"},
    )
    assert r.status_code == 201
    rows = _outbox(db)
    assert len(rows) == 1
    assert rows[0]["kind"] == "plan_approval" and rows[0]["ref"] == t["task_id"]
    assert rows[0]["title"] == "Plan approval — test-arena"
    assert rows[0]["body"] == "build widget"

    # a second agent post is a progress note, not a plan — no new row
    r = await client.post(
        f"/api/tasks/{t['task_id']}/messages",
        json={"author_agent_id": dev["agent_id"], "body": "halfway there"},
    )
    assert r.status_code == 201
    assert len(_outbox(db)) == 1


async def test_request_to_human_enqueues_agent_target_does_not(
    client, container, make_agent, make_request, trust_proxy, db
):
    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)
    asker = await make_agent("asker", "eng")
    helper = await make_agent("helper", "eng")

    # agent→agent: not a needs-you item
    await make_request(asker["agent_id"], "peer question", target_alias="helper")
    assert _outbox(db) == []

    # no target → escalate-to-human at birth → push
    req = await make_request(asker["agent_id"], "Should I use approach A or B?")
    rows = _outbox(db)
    assert len(rows) == 1
    assert rows[0]["kind"] == "request" and rows[0]["ref"] == req["request_id"]
    assert rows[0]["title"] == "Request for you — test-arena"
    assert rows[0]["body"] == "Should I use approach A or B?"


async def test_no_registered_devices_means_no_outbox_rows(
    client, container, make_agent, make_task, make_request, work_headers,
    trust_proxy, db,
):
    """The dormant default: nobody registered a phone → the hook writes nothing."""
    await _bind_owner(client, container, make_agent)
    dev = await make_agent("dev", "eng")
    t = await make_task("quiet", "done", assignee_alias="dev")
    await client.post(
        f"/api/tasks/{t['task_id']}/messages",
        json={"author_agent_id": dev["agent_id"], "body": "Plan: x"},
    )
    await client.post(
        f"/api/tasks/{t['task_id']}/done",
        json={"agent_id": dev["agent_id"], "result": "x"},
        headers=await work_headers(dev["agent_id"]),
    )
    await make_request(dev["agent_id"], "ping human")
    assert _outbox(db) == []


async def test_broken_hook_never_breaks_the_main_write(
    client, container, make_agent, make_task, work_headers, trust_proxy, db,
    monkeypatch,
):
    """After-commit best-effort teeth: the hook's own DB access exploding must
    leave /done fully committed and answering 200."""
    from portal_backend import push_outbox as push_outbox_module

    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)

    def _boom():
        raise RuntimeError("push infrastructure down")

    monkeypatch.setattr(push_outbox_module, "db_cursor", _boom)
    dev = await make_agent("dev", "eng")
    t = await make_task("resilient", "done", assignee_alias="dev")
    r = await client.post(
        f"/api/tasks/{t['task_id']}/done",
        json={"agent_id": dev["agent_id"], "result": "x"},
        headers=await work_headers(dev["agent_id"]),
    )
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"
    status = db.execute(
        "SELECT status FROM tasks WHERE id=%s", (t["task_id"],)
    )[0]["status"]
    assert status == "needs_verification"
    assert _outbox(db) == []  # nothing enqueued — and nothing broken


# ---------- the box lane: claim / mark / revoke-unregistered ----------

async def test_claim_resolves_devices_at_send_time_with_payload(
    client, container, make_agent, make_task, work_headers, trust_proxy, db
):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "hubot")
    await _register(client, TOKEN_A, OCTO)
    await _register(client, TOKEN_B, HUBOT)
    dev = await make_agent("dev", "eng")
    t = await make_task("claimable", "done", assignee_alias="dev")
    await client.post(
        f"/api/tasks/{t['task_id']}/done",
        json={"agent_id": dev["agent_id"], "result": "x"},
        headers=await work_headers(dev["agent_id"]),
    )

    r = await client.post("/api/push/outbox/claim", json={"limit": 10})
    assert r.status_code == 200, r.text
    events = r.json()["events"]
    assert len(events) == 1
    event = events[0]
    assert event["kind"] == "task_verify"
    assert event["payload"] == {"cid": cid, "kind": "task", "id": t["task_id"]}
    assert sorted(event["devices"]) == [TOKEN_A, TOKEN_B]

    # claim does NOT consume — the row stays pending until /mark
    r = await client.post("/api/push/outbox/claim", json={"limit": 10})
    assert len(r.json()["events"]) == 1

    # mark delivered → gone from the next claim
    r = await client.post(
        "/api/push/outbox/mark", json={"delivered": [event["id"]], "failed": {}}
    )
    assert r.status_code == 200 and r.json()["delivered"] == 1
    assert (await client.post("/api/push/outbox/claim", json={"limit": 10})).json()[
        "events"
    ] == []


async def test_claim_request_payload_kind_is_request(
    client, container, make_agent, make_request, trust_proxy
):
    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)
    asker = await make_agent("asker", "eng")
    req = await make_request(asker["agent_id"], "need you")
    r = await client.post("/api/push/outbox/claim", json={"limit": 10})
    event = r.json()["events"][0]
    assert event["payload"]["kind"] == "request"
    assert event["payload"]["id"] == req["request_id"]


async def test_claim_fails_rows_whose_audience_vanished(
    client, container, make_agent, make_request, trust_proxy, db
):
    """Devices revoked between enqueue and claim: the row is failed in place so
    it stops re-claiming forever."""
    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)
    asker = await make_agent("asker", "eng")
    await make_request(asker["agent_id"], "need you")
    await client.request(
        "DELETE", "/api/push/devices", json={"apns_token": TOKEN_A}, headers=OCTO
    )
    r = await client.post("/api/push/outbox/claim", json={"limit": 10})
    assert r.json()["events"] == []
    assert _outbox(db)[0]["failed"] == "no live devices at claim"


async def test_claim_prunes_rows_older_than_48h(
    client, container, make_agent, make_request, trust_proxy, db
):
    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)
    asker = await make_agent("asker", "eng")
    await make_request(asker["agent_id"], "stale")
    db.execute("UPDATE push_outbox SET created_at = now() - interval '49 hours'")
    r = await client.post("/api/push/outbox/claim", json={"limit": 10})
    assert r.json()["events"] == []
    assert _outbox(db) == []  # pruned, not failed


async def test_mark_failed_and_revoke_unregistered(
    client, container, make_agent, make_request, trust_proxy, db
):
    await _bind_owner(client, container, make_agent)
    await _register(client, TOKEN_A, OCTO)
    asker = await make_agent("asker", "eng")
    await make_request(asker["agent_id"], "doomed")
    event = (await client.post("/api/push/outbox/claim", json={"limit": 10})).json()[
        "events"
    ][0]

    r = await client.post(
        "/api/push/outbox/mark",
        json={"delivered": [], "failed": {event["id"]: "all device tokens unregistered"}},
    )
    assert r.status_code == 200 and r.json()["failed"] == 1
    assert _outbox(db)[0]["failed"] == "all device tokens unregistered"

    r = await client.post(
        "/api/push/devices/revoke-unregistered", json={"apns_tokens": [TOKEN_A]}
    )
    assert r.status_code == 200 and r.json()["revoked"] == 1
    assert (await client.get("/api/push/devices", headers=OCTO)).json() == {
        "devices": []
    }
    # idempotent
    r = await client.post(
        "/api/push/devices/revoke-unregistered", json={"apns_tokens": [TOKEN_A]}
    )
    assert r.json()["revoked"] == 0


async def test_box_lane_refuses_browser_identities(
    client, container, make_agent, trust_proxy
):
    """A signed-in member must not drive the box-internal outbox lane."""
    await _bind_owner(client, container, make_agent)
    for path, body in (
        ("/api/push/outbox/claim", {"limit": 10}),
        ("/api/push/outbox/mark", {"delivered": [], "failed": {}}),
        ("/api/push/devices/revoke-unregistered", {"apns_tokens": [TOKEN_A]}),
    ):
        r = await client.post(path, json=body, headers=OCTO)
        assert r.status_code == 403, f"{path}: {r.status_code}"
