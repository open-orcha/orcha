"""Per-project identity under proxy trust (the kedar1607 bug).

A signed-in GitHub user who is NOT a member of the currently-viewed project must
NEVER act as (or be attributed to) that project's default human. The shared gate
(identity_routes.trusted_actor) binds the actor of every human-authoritative write
to the proxy-verified login IN THE TARGET CONTAINER:

  * trusted member  -> the header IS the actor; any client-supplied actor id is
                       OVERRIDDEN (audited), never trusted;
  * trusted non-member -> 403 ("not a member of this project"), never a fallback;
  * trust off / no header (break-glass team token) -> pre-collab behavior intact.

/api/me additionally (a) reports `trusted` so the UI can render the honest viewer
state, and (b) stamps presence for the login across EVERY container it is a member
of — an invitee who signs in anywhere stops reading `pending` everywhere.
"""
import uuid

import pytest

OCTO = {"X-Auth-Request-User": "octocat"}          # project A's bound owner
HUBOT = {"X-Auth-Request-User": "hubot"}           # invited member of project A
KEDAR = {"X-Auth-Request-User": "kedar1607"}       # member of project B ONLY
MALLORY = {"X-Auth-Request-User": "mallory"}       # a verified stranger


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    """This module exercises member invites (per-project identity setup) — a
    Team-plan feature under the plan-gating addendum
    (docs/orcha-cloud-local-run.md). Solo-tier 402 behavior is covered by
    tests/test_plan_gating.py; this suite stays on the team plan so its
    per-project-identity assertions are unaffected by the gate."""
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _bind_octocat_owner(client, container, make_agent):
    """Found project A: root human + octocat's arrival binds them as its owner."""
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    ident = r.json()["identity"]
    assert ident and ident["member_role"] == "owner"
    return ident


async def _invite_hubot(client, cid):
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "hubot", "role": "member"},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


async def _needs_verification_task(client, make_task, db):
    t = await make_task("ship it", "shipped")
    db.execute(
        "UPDATE tasks SET status='needs_verification' WHERE id=%s", (t["id"],)
    )
    return t


# ---------- verify ----------

async def test_verify_trusted_member_overrides_client_actor(
    client, container, make_agent, make_task, db, trust_proxy
):
    """The header IS the verifier: a client-smuggled actor id (the owner's) is
    overridden to the signed-in member — attribution can't be spoofed."""
    cid = container["id"]
    owner = await _bind_octocat_owner(client, container, make_agent)
    hubot_id = await _invite_hubot(client, cid)
    t = await _needs_verification_task(client, make_task, db)

    r = await client.post(
        f"/api/tasks/{t['id']}/verify",
        json={"approve": True, "actor_agent_id": owner["agent_id"]},
        headers=HUBOT,
    )
    assert r.status_code == 200, r.text
    ev = db.execute(
        "SELECT actor_id, detail FROM events "
        "WHERE entity_id=%s AND event_type='verified'", (t["id"],)
    )[0]
    # attribution followed the header (the approve path's actor_id is NULL by
    # convention; verifier_human_id carries the verifier): hubot, NOT the owner
    assert ev["detail"]["verifier_human_id"] == hubot_id
    # the mismatch was audited, not errored
    audit = db.execute(
        "SELECT detail FROM events WHERE event_type='actor_overridden_by_proxy_identity'"
    )
    assert audit and audit[0]["detail"]["claimed_actor_agent_id"] == owner["agent_id"]


async def test_verify_trusted_non_member_403(
    client, container, make_agent, make_task, db, trust_proxy
):
    cid = container["id"]
    owner = await _bind_octocat_owner(client, container, make_agent)
    t = await _needs_verification_task(client, make_task, db)
    r = await client.post(
        f"/api/tasks/{t['id']}/verify",
        json={"approve": True, "actor_agent_id": owner["agent_id"]},
        headers=MALLORY,
    )
    assert r.status_code == 403, r.text
    assert "not a member of this project" in r.text
    # nothing happened to the task
    row = db.execute("SELECT status FROM tasks WHERE id=%s", (t["id"],))[0]
    assert row["status"] == "needs_verification"


async def test_verify_trust_off_and_no_header_unchanged(
    client, container, make_agent, make_task, db, no_trust_proxy, monkeypatch
):
    """Self-host (trust off, header inert) AND the trust-on/no-header team-token
    lane both keep the permissive body-actor convention."""
    cid = container["id"]
    human = await make_agent("root", "operator", kind="human")
    t = await _needs_verification_task(client, make_task, db)
    # trust OFF: a random header is ignored; the body actor verifies
    r = await client.post(
        f"/api/tasks/{t['id']}/verify",
        json={"approve": False, "feedback": "redo", "actor_agent_id": human["agent_id"]},
        headers=MALLORY,
    )
    assert r.status_code == 200, r.text

    # trust ON, NO header (break-glass team token): body actor still works
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (t["id"],))
    r = await client.post(
        f"/api/tasks/{t['id']}/verify",
        json={"approve": True, "actor_agent_id": human["agent_id"]},
    )
    assert r.status_code == 200, r.text


# ---------- plan decision (POST /api/decisions) ----------

async def test_decision_trusted_member_overrides_and_non_member_403(
    client, container, make_agent, make_task, trust_proxy
):
    cid = container["id"]
    owner = await _bind_octocat_owner(client, container, make_agent)
    hubot_id = await _invite_hubot(client, cid)
    ai = await make_agent("bot", "worker", kind="ai")
    t = await make_task("plan me", "planned")

    r = await client.post(
        "/api/decisions",
        json={
            "subject_type": "plan_approval", "subject_id": t["id"],
            "decision": "approve", "actor_agent_id": owner["agent_id"],
            "target_agent_id": ai["agent_id"],
        },
        headers=HUBOT,
    )
    assert r.status_code == 201, r.text
    d = (await client.get(f"/api/decisions/{r.json()['decision_id']}")).json()
    assert d["actor_agent_id"] == hubot_id            # overridden to the header user

    r = await client.post(
        "/api/decisions",
        json={
            "subject_type": "plan_approval", "subject_id": t["id"],
            "decision": "approve", "actor_agent_id": owner["agent_id"],
            "target_agent_id": ai["agent_id"],
        },
        headers=KEDAR,
    )
    assert r.status_code == 403 and "not a member of this project" in r.text


# ---------- task create ----------

async def test_task_create_trusted_attribution_and_non_member_403(
    client, container, make_agent, db, trust_proxy
):
    cid = container["id"]
    owner = await _bind_octocat_owner(client, container, make_agent)
    hubot_id = await _invite_hubot(client, cid)

    # hubot creates a task while claiming the owner as creator -> attributed to hubot
    r = await client.post(
        f"/api/containers/{cid}/tasks",
        json={"title": "T", "definition_of_done": "D",
              "created_by_agent_id": owner["agent_id"]},
        headers=HUBOT,
    )
    assert r.status_code == 201, r.text
    row = db.execute(
        "SELECT created_by_agent_id FROM tasks WHERE id=%s", (r.json()["task_id"],)
    )[0]
    assert str(row["created_by_agent_id"]) == hubot_id

    # ...and with NO creator supplied the trusted member is still the creator
    r = await client.post(
        f"/api/containers/{cid}/tasks",
        json={"title": "T2", "definition_of_done": "D2"},
        headers=HUBOT,
    )
    assert r.status_code == 201, r.text
    row = db.execute(
        "SELECT created_by_agent_id FROM tasks WHERE id=%s", (r.json()["task_id"],)
    )[0]
    assert str(row["created_by_agent_id"]) == hubot_id

    r = await client.post(
        f"/api/containers/{cid}/tasks",
        json={"title": "T3", "definition_of_done": "D3"},
        headers=MALLORY,
    )
    assert r.status_code == 403 and "not a member of this project" in r.text


# ---------- cancel ----------

async def test_cancel_trusted_non_member_403_member_ok(
    client, container, make_agent, make_task, db, trust_proxy
):
    cid = container["id"]
    owner = await _bind_octocat_owner(client, container, make_agent)
    t = await make_task("kill me", "gone")
    r = await client.post(
        f"/api/tasks/{t['id']}/cancel",
        json={"actor_agent_id": owner["agent_id"], "reason": "nope"},
        headers=MALLORY,
    )
    assert r.status_code == 403 and "not a member of this project" in r.text
    # the member (via header, claimed actor overridden-to-self) cancels fine
    r = await client.post(
        f"/api/tasks/{t['id']}/cancel",
        json={"actor_agent_id": owner["agent_id"], "reason": "obsolete"},
        headers=OCTO,
    )
    assert r.status_code == 200, r.text


# ---------- request answer (respond) ----------

async def test_respond_trusted_override_and_non_member_403(
    client, container, make_agent, make_request, trust_proxy
):
    cid = container["id"]
    owner = await _bind_octocat_owner(client, container, make_agent)
    hubot_id = await _invite_hubot(client, cid)
    ai = await make_agent("bot", "worker", kind="ai")
    # target the OWNER explicitly (alias == login post-bind)
    req = await make_request(ai["agent_id"], "help?", target_alias="octocat")

    # a stranger can't answer at all — 403 before any target logic
    r = await client.post(
        f"/api/requests/{req['id']}/respond",
        json={"responder_agent_id": owner["agent_id"], "response": "hi"},
        headers=MALLORY,
    )
    assert r.status_code == 403 and "not a member of this project" in r.text

    # hubot (member, but NOT the target) is overridden to himself -> target gate 403
    r = await client.post(
        f"/api/requests/{req['id']}/respond",
        json={"responder_agent_id": owner["agent_id"], "response": "hi"},
        headers=HUBOT,
    )
    assert r.status_code == 403, r.text

    # the real target answers; a smuggled responder id (hubot's) is overridden
    r = await client.post(
        f"/api/requests/{req['id']}/respond",
        json={"responder_agent_id": hubot_id, "response": "the answer"},
        headers=OCTO,
    )
    assert r.status_code == 200, r.text
    got = (await client.get(f"/api/requests/{req['id']}")).json()
    assert got["status"] == "answered"


# ---------- member endpoint (invite) — cross-project ----------

async def test_member_of_another_project_cannot_act_here(
    client, container, make_agent, trust_proxy
):
    """THE field bug: kedar1607 (member of project B only) opens project A. He must
    be a pure viewer there — owner-gated AND human-gated writes both refuse him."""
    cid_a = container["id"]
    await _bind_octocat_owner(client, container, make_agent)

    # kedar founds project B through the portal (additional=true seeds him as owner)
    r = await client.post(
        "/api/containers",
        json={"name": "proj-b", "additional": True},
        headers=KEDAR,
    )
    assert r.status_code == 201, r.text
    cid_b = r.json()["container_id"]
    me_b = (await client.get(f"/api/me?cid={cid_b}", headers=KEDAR)).json()
    assert me_b["identity"] and me_b["identity"]["github_login"] == "kedar1607"

    # ...but in project A he is identity-null / trusted (the honest viewer state)
    me_a = (await client.get(f"/api/me?cid={cid_a}", headers=KEDAR)).json()
    assert me_a == {"identity": None, "trusted": True}

    # owner-gated write in A: refused
    r = await client.post(
        f"/api/containers/{cid_a}/members",
        json={"github_login": "friend", "role": "member"},
        headers=KEDAR,
    )
    assert r.status_code == 403, r.text
    # human-gated write in A: refused with the clear detail
    r = await client.post(
        f"/api/containers/{cid_a}/tasks",
        json={"title": "sneak", "definition_of_done": "x"},
        headers=KEDAR,
    )
    assert r.status_code == 403 and "not a member of this project" in r.text


# ---------- cross-project presence stamp ----------

async def test_signin_anywhere_clears_pending_everywhere(
    client, container, make_agent, db, trust_proxy
):
    """An invitee whose membership lives in project B signs in while the portal is
    on project A: /api/me?cid=A matches no identity there, but the login match
    stamps B's row — `pending` clears in EVERY project, not just the viewed one."""
    cid_a = container["id"]
    await _bind_octocat_owner(client, container, make_agent)

    # octocat founds project B and invites kedar there
    r = await client.post(
        "/api/containers", json={"name": "proj-b", "additional": True}, headers=OCTO
    )
    cid_b = r.json()["container_id"]
    r = await client.post(
        f"/api/containers/{cid_b}/members",
        json={"github_login": "kedar1607", "role": "member"},
        headers=OCTO,
    )
    assert r.status_code == 201 and r.json()["pending"] is True
    kedar_b = r.json()["agent_id"]

    # kedar's first sign-in lands on project A (the portal's boot default)
    me = (await client.get(f"/api/me?cid={cid_a}", headers=KEDAR)).json()
    assert me == {"identity": None, "trusted": True}

    # ...and his project-B membership stopped reading pending anyway
    members_b = (await client.get(f"/api/containers/{cid_b}/members")).json()["members"]
    kedar_row = [m for m in members_b if m["agent_id"] == kedar_b][0]
    assert kedar_row["pending"] is False
    stamp = db.execute(
        "SELECT last_heartbeat_at FROM agents WHERE id=%s", (kedar_b,)
    )[0]["last_heartbeat_at"]
    assert stamp is not None

    # stamped once: a re-poll never moves it (later activity is bump_agent's job)
    await client.get(f"/api/me?cid={cid_a}", headers=KEDAR)
    again = db.execute(
        "SELECT last_heartbeat_at FROM agents WHERE id=%s", (kedar_b,)
    )[0]["last_heartbeat_at"]
    assert again == stamp


# ---------- bootstrap exemption ----------

async def test_unmapped_container_bootstrap_passes_through(
    client, container, make_agent, make_task, db, trust_proxy
):
    """Before ANY human is mapped (fresh `orcha init` state) the gate must not
    lock the founding operator out — mirrors the binding rule's NOT-EXISTS guard."""
    human = await make_agent("root", "operator", kind="human")
    t = await _needs_verification_task(client, make_task, db)
    r = await client.post(
        f"/api/tasks/{t['id']}/verify",
        json={"approve": True, "actor_agent_id": human["agent_id"]},
        headers=OCTO,  # trusted arrival, but nobody is mapped yet
    )
    assert r.status_code == 200, r.text


# ---------- trust-off /api/me envelope ----------

async def test_me_envelope_reports_trust(client, container, make_agent, no_trust_proxy):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={cid}", headers=OCTO)
    assert r.json() == {"identity": None, "trusted": False}
