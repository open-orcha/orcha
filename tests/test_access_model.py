"""Access model (mig 039) — the viewer role, granular grants, roster privacy, and
project-isolated reads.

Matrix under test (trusted proxy lane; trust off keeps every pre-039 convention):

  role      work writes   keys   members(list)  member CRUD    repo  autonomy  agents  reviewer
  owner        yes        yes    full           yes (all)      yes   yes       yes     yes
  member       yes        403*   OWN ROW ONLY*  403*           403*  403*      403*    403*
  viewer       403        403    own row*       403            403   403       403     403

  * unless the matching grant is held: manage_keys / manage_members / manage_repo /
    manage_autonomy / manage_agents / assign_reviewers. Grants are additive; owners
    hold all implicitly. A grant NEVER unlocks a write for a viewer (read-only role);
    the one read a grant unlocks for a viewer is the roster (manage_members).

Owner-only carve-outs even for manage_members holders: role changes to/from owner,
owner removal, and any grants change.

Reads (deliverable 2): GET /api/containers is filtered to the login's memberships
(+ still-unmapped bootstrap containers); cid-scoped reads 403 a trusted non-member.
"""
import pytest

OCTO = {"X-Auth-Request-User": "octocat"}      # bound owner of the arena
HUBOT = {"X-Auth-Request-User": "hubot"}       # invited member
VERA = {"X-Auth-Request-User": "vera"}         # invited VIEWER
MALLORY = {"X-Auth-Request-User": "mallory"}   # verified stranger
KEDAR = {"X-Auth-Request-User": "kedar1607"}   # member of project B only


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    """This module exercises member invites + the grants/roles matrix — a
    Team-plan feature under the plan-gating addendum
    (docs/orcha-cloud-local-run.md). Solo-tier 402 behavior is covered by
    tests/test_plan_gating.py; this suite stays on the team plan so its
    access-model assertions are unaffected by the gate."""
    monkeypatch.setenv("ORCHA_PLAN", "team")


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


async def _grant(client, cid, aid, grants):
    r = await client.patch(
        f"/api/containers/{cid}/members/{aid}",
        json={"grants": grants},
        headers=OCTO,
    )
    assert r.status_code == 200, r.text
    assert sorted(r.json()["grants"]) == sorted(grants)
    return r.json()


# ---------- grants matrix: keys ----------

async def test_keys_owner_or_manage_keys(
    client, container, make_agent, trust_proxy, monkeypatch
):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "0" * 64)
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")

    key_body = {"api_key": "sk-ant-test-1234", "actor_agent_id": hubot}
    # a plain member may NOT touch credentials
    r = await client.put(
        f"/api/containers/{cid}/settings/llm-key", json=key_body, headers=HUBOT
    )
    assert r.status_code == 403 and "manage_keys" in r.text
    # ...nor delete/test
    r = await client.request(
        "DELETE", f"/api/containers/{cid}/settings/llm-key",
        json={"actor_agent_id": hubot}, headers=HUBOT,
    )
    assert r.status_code == 403, r.text
    r = await client.post(
        f"/api/containers/{cid}/settings/llm-key/test",
        json={"actor_agent_id": hubot}, headers=HUBOT,
    )
    assert r.status_code == 403, r.text
    # model settings ride the same bundle
    r = await client.put(
        f"/api/containers/{cid}/settings/models",
        json={"use_cases": [], "actor_agent_id": hubot},
        headers=HUBOT,
    )
    assert r.status_code == 403, r.text

    # granted manage_keys -> the PUT lands
    await _grant(client, cid, hubot, ["manage_keys"])
    r = await client.put(
        f"/api/containers/{cid}/settings/llm-key", json=key_body, headers=HUBOT
    )
    assert r.status_code == 200, r.text
    assert r.json()["configured"] is True
    # the owner always could
    r = await client.put(
        f"/api/containers/{cid}/settings/llm-key", json=key_body, headers=OCTO
    )
    assert r.status_code == 200, r.text


# ---------- grants matrix: repo / autonomy / agents / reviewers ----------

async def test_repo_autonomy_agents_reviewer_grants(
    client, container, make_agent, make_task, trust_proxy
):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")
    ai = await make_agent("bot", "worker", kind="ai")
    t = await make_task("ship", "shipped")

    # repo bind
    r = await client.put(
        f"/api/containers/{cid}/github", json={"repo": "acme/site"}, headers=HUBOT
    )
    assert r.status_code == 403 and "manage_repo" in r.text
    # autonomy switches (wakes toggle + level + status + sweep)
    r = await client.post(
        f"/api/containers/{cid}/wakes",
        json={"enabled": False, "actor_agent_id": hubot}, headers=HUBOT,
    )
    assert r.status_code == 403 and "manage_autonomy" in r.text
    r = await client.post(
        f"/api/containers/{cid}/autonomy",
        json={"level": "full", "actor_agent_id": hubot}, headers=HUBOT,
    )
    assert r.status_code == 403, r.text
    r = await client.post(
        f"/api/containers/{cid}/status",
        json={"status": "paused", "actor_agent_id": hubot}, headers=HUBOT,
    )
    assert r.status_code == 403, r.text
    r = await client.post(
        f"/api/containers/{cid}/sweep?actor_agent_id={hubot}", headers=HUBOT
    )
    assert r.status_code == 403, r.text
    r = await client.patch(
        f"/api/agents/{ai['agent_id']}/auto-wake",
        json={"interval_secs": 3600, "actor_agent_id": hubot},
        headers=HUBOT,
    )
    assert r.status_code == 403, r.text
    # agent management
    r = await client.post(
        f"/api/containers/{cid}/agents",
        json={"alias": "b2", "role": "worker", "kind": "ai", "prompt": "x"},
        headers=HUBOT,
    )
    assert r.status_code == 403 and "manage_agents" in r.text
    r = await client.post(
        f"/api/agents/{ai['agent_id']}/retire",
        json={"actor_agent_id": hubot}, headers=HUBOT,
    )
    assert r.status_code == 403, r.text
    # reviewer assignment
    r = await client.put(
        f"/api/tasks/{t['id']}/reviewer",
        json={"reviewer_agent_id": None},
        headers=HUBOT,
    )
    assert r.status_code == 403 and "assign_reviewers" in r.text

    # grant the lot (owner PATCH) -> each unlocks
    await _grant(
        client, cid, hubot,
        ["manage_repo", "manage_autonomy", "manage_agents", "assign_reviewers"],
    )
    assert (await client.put(
        f"/api/containers/{cid}/github", json={"repo": "acme/site"}, headers=HUBOT
    )).status_code == 200
    assert (await client.post(
        f"/api/containers/{cid}/wakes",
        json={"enabled": False, "actor_agent_id": hubot}, headers=HUBOT,
    )).status_code == 200
    assert (await client.post(
        f"/api/containers/{cid}/autonomy",
        json={"level": "full", "actor_agent_id": hubot}, headers=HUBOT,
    )).status_code == 200
    assert (await client.post(
        f"/api/containers/{cid}/agents",
        json={"alias": "b2", "role": "worker", "kind": "ai", "prompt": "x"},
        headers=HUBOT,
    )).status_code == 201
    assert (await client.put(
        f"/api/tasks/{t['id']}/reviewer",
        json={"reviewer_agent_id": None},
        headers=HUBOT,
    )).status_code == 200
    # ...but the member still can't touch what wasn't granted (keys)
    assert (await client.post(
        f"/api/containers/{cid}/settings/llm-key/test",
        json={"actor_agent_id": hubot}, headers=HUBOT,
    )).status_code == 403


# ---------- work bundle: a plain member still WORKS ----------

async def test_plain_member_keeps_the_work_bundle(
    client, container, make_agent, trust_proxy
):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "hubot")
    # create a task (the canonical work write) — no grant needed
    r = await client.post(
        f"/api/containers/{cid}/tasks",
        json={"title": "T", "definition_of_done": "D"},
        headers=HUBOT,
    )
    assert r.status_code == 201, r.text


# ---------- roster privacy ----------

async def test_roster_privacy_shapes(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")

    # the owner sees the full roster
    r = await client.get(f"/api/containers/{cid}/members", headers=OCTO)
    assert r.status_code == 200
    body = r.json()
    assert body["restricted"] is False and len(body["members"]) == 2
    assert all("grants" in m for m in body["members"])

    # a plain member sees ONLY their own row + restricted:true
    r = await client.get(f"/api/containers/{cid}/members", headers=HUBOT)
    assert r.status_code == 200
    body = r.json()
    assert body["restricted"] is True
    assert [m["github_login"] for m in body["members"]] == ["hubot"]

    # manage_members unlocks the full roster
    await _grant(client, cid, hubot, ["manage_members"])
    r = await client.get(f"/api/containers/{cid}/members", headers=HUBOT)
    assert r.json()["restricted"] is False and len(r.json()["members"]) == 2

    # a trusted NON-member gets 403 (read isolation), trust-off/no-header full list
    r = await client.get(f"/api/containers/{cid}/members", headers=MALLORY)
    assert r.status_code == 403, r.text
    r = await client.get(f"/api/containers/{cid}/members")
    assert r.status_code == 200 and r.json()["restricted"] is False


# ---------- member CRUD via manage_members; owner-only carve-outs ----------

async def test_manage_members_below_owner_only(
    client, container, make_agent, trust_proxy
):
    cid = container["id"]
    owner = await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")
    await _grant(client, cid, hubot, ["manage_members"])

    # the grant holder can invite members and viewers...
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "friend", "role": "member"},
        headers=HUBOT,
    )
    assert r.status_code == 201, r.text
    friend = r.json()["agent_id"]
    # ...re-role below owner (member <-> viewer)...
    r = await client.patch(
        f"/api/containers/{cid}/members/{friend}",
        json={"role": "viewer"},
        headers=HUBOT,
    )
    assert r.status_code == 200 and r.json()["member_role"] == "viewer"
    # ...and remove a non-owner
    r = await client.request(
        "DELETE", f"/api/containers/{cid}/members/{friend}", headers=HUBOT
    )
    assert r.status_code == 200, r.text

    # owner-only carve-outs: invite-as-owner, promote-to-owner, touch an owner,
    # remove an owner, change grants
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "boss", "role": "owner"},
        headers=HUBOT,
    )
    assert r.status_code == 403 and "owner role" in r.text
    r = await client.patch(
        f"/api/containers/{cid}/members/{hubot}",
        json={"role": "owner"},
        headers=HUBOT,
    )
    assert r.status_code == 403, r.text
    r = await client.patch(
        f"/api/containers/{cid}/members/{owner['agent_id']}",
        json={"role": "member"},
        headers=HUBOT,
    )
    assert r.status_code == 403, r.text
    r = await client.request(
        "DELETE", f"/api/containers/{cid}/members/{owner['agent_id']}", headers=HUBOT
    )
    assert r.status_code == 403, r.text
    r = await client.patch(
        f"/api/containers/{cid}/members/{hubot}",
        json={"grants": ["manage_keys"]},
        headers=HUBOT,
    )
    assert r.status_code == 403 and "owner role" in r.text

    # a plain member (no grant) cannot list-manage at all
    plain = await _invite(client, cid, "plainer")
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": "nope"},
        headers={"X-Auth-Request-User": "plainer"},
    )
    assert r.status_code == 403 and "manage_members" in r.text

    # schema guards: unknown grant is a 422; an empty PATCH is a 400
    r = await client.patch(
        f"/api/containers/{cid}/members/{hubot}",
        json={"grants": ["manage_everything"]},
        headers=OCTO,
    )
    assert r.status_code == 422, r.text
    r = await client.patch(
        f"/api/containers/{cid}/members/{hubot}", json={}, headers=OCTO
    )
    assert r.status_code == 400, r.text


# ---------- the viewer role: every write 403s ----------

async def test_viewer_write_403s_including_chat(
    client, container, make_agent, make_task, db, trust_proxy
):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    vera = await _invite(client, cid, "vera", role="viewer")
    ai = await make_agent("bot", "worker", kind="ai")
    t = await make_task("ship", "shipped")
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (t["id"],))

    # the viewer READS the project fine (snapshot + tasks + own membership row)
    assert (await client.get(f"/api/containers/{cid}", headers=VERA)).status_code == 200
    assert (
        await client.get(f"/api/containers/{cid}/tasks", headers=VERA)
    ).status_code == 200
    r = await client.get(f"/api/containers/{cid}/members", headers=VERA)
    assert r.status_code == 200 and r.json()["restricted"] is True

    # ...but every write is refused: task create, verify, chat
    r = await client.post(
        f"/api/containers/{cid}/tasks",
        json={"title": "T", "definition_of_done": "D"},
        headers=VERA,
    )
    assert r.status_code == 403 and "read-only" in r.text
    r = await client.post(
        f"/api/tasks/{t['id']}/verify",
        json={"approve": True, "actor_agent_id": vera}, headers=VERA,
    )
    assert r.status_code == 403, r.text

    # chat: the owner opens a conversation; the viewer may neither open one nor turn
    r = await client.post(
        f"/api/agents/{ai['agent_id']}/conversations",
        json={"actor_agent_id": vera},
        headers=VERA,
    )
    assert r.status_code == 403, r.text
    r = await client.post(
        f"/api/agents/{ai['agent_id']}/conversations",
        json={"actor_agent_id": vera},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    conv = r.json()["conversation"]["id"]
    r = await client.post(
        f"/api/conversations/{conv}/turns",
        json={"role": "human", "author_agent_id": vera, "content": "hi"},
        headers=VERA,
    )
    assert r.status_code == 403 and "read-only" in r.text
    # the viewer can still READ the conversation
    r = await client.get(f"/api/conversations/{conv}/turns", headers=VERA)
    assert r.status_code == 200, r.text

    # a grant NEVER unlocks a write for a viewer (read-only is absolute)
    r = await client.patch(
        f"/api/containers/{cid}/members/{vera}",
        json={"grants": ["manage_keys"]},
        headers=OCTO,
    )
    assert r.status_code == 200, r.text
    r = await client.put(
        f"/api/containers/{cid}/settings/llm-key",
        json={"api_key": "sk-x", "actor_agent_id": vera},
        headers=VERA,
    )
    assert r.status_code == 403 and "read-only" in r.text
    # ...but the roster grant DOES unlock the roster READ for a viewer
    r = await client.patch(
        f"/api/containers/{cid}/members/{vera}",
        json={"grants": ["manage_members"]},
        headers=OCTO,
    )
    assert r.status_code == 200, r.text
    r = await client.get(f"/api/containers/{cid}/members", headers=VERA)
    assert r.status_code == 200 and r.json()["restricted"] is False

    # the viewer may still pair a phone (read-scoped access)
    r = await client.get(f"/api/containers/{cid}/pairing", headers=VERA)
    assert r.status_code in (200, 409), r.text  # 409 = no LAN address in CI, not 403


# ---------- containers list filtering + landing card fields ----------

async def test_containers_list_filtering_and_card_fields(
    client, container, make_agent, trust_proxy
):
    cid_a = container["id"]
    await _bind_owner(client, container, make_agent)
    # kedar founds project B through the portal
    r = await client.post(
        "/api/containers", json={"name": "proj-b", "additional": True}, headers=KEDAR
    )
    assert r.status_code == 201, r.text
    cid_b = r.json()["container_id"]

    # octocat sees only A; kedar only B; mallory (member of nothing) sees NOTHING
    ids = [c["id"] for c in (await client.get("/api/containers", headers=OCTO)).json()["containers"]]
    assert ids == [cid_a]
    ids = [c["id"] for c in (await client.get("/api/containers", headers=KEDAR)).json()["containers"]]
    assert ids == [cid_b]
    assert (await client.get("/api/containers", headers=MALLORY)).json()["containers"] == []
    # trust off / no header: the full stack (CLI + self-host unchanged)
    ids = [c["id"] for c in (await client.get("/api/containers")).json()["containers"]]
    assert ids == [cid_a, cid_b]

    # landing-card fields ride each row; roster privacy holds per container
    row_a = (await client.get("/api/containers", headers=OCTO)).json()["containers"][0]
    for field in ("agents", "tasks", "needs_you", "member_count", "members"):
        assert field in row_a, f"missing {field}"
    assert row_a["member_count"] == 1
    assert [m["github_login"] for m in row_a["members"]] == ["octocat"]

    # invite hubot to A: a plain member gets the COUNT, not the roster
    await _invite(client, cid_a, "hubot")
    row_a = (await client.get("/api/containers", headers=HUBOT)).json()["containers"][0]
    assert row_a["member_count"] == 2 and row_a["members"] is None


async def test_containers_list_bootstrap_exemption(client, container, trust_proxy):
    """A stack whose container is still UNMAPPED (fresh `orcha init`, no human bound)
    must show a trusted arrival the world — or the binding rule could never run."""
    r = await client.get("/api/containers", headers=OCTO)
    assert [c["id"] for c in r.json()["containers"]] == [container["id"]]


# ---------- read isolation: snapshot & friends ----------

async def test_non_member_reads_403(client, container, make_agent, make_task, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    t = await make_task("secret", "hidden")

    for path in (
        f"/api/containers/{cid}",
        f"/api/snapshot/{cid}",
        f"/api/containers/{cid}/tasks",
        f"/api/containers/{cid}/requests",
        f"/api/containers/{cid}/token-usage",
        f"/api/containers/{cid}/github",
        f"/api/containers/{cid}/settings/llm-key",
        f"/api/containers/{cid}/settings/provider-keys",
        f"/api/containers/{cid}/settings/models",
        f"/api/containers/{cid}/metrics",
        f"/api/tasks/{t['id']}/messages",
    ):
        r = await client.get(path, headers=MALLORY)
        assert r.status_code == 403, f"{path} -> {r.status_code}: {r.text}"
        # members read them fine; trust off unchanged
        assert (await client.get(path, headers=OCTO)).status_code == 200, path
        assert (await client.get(path)).status_code == 200, path


async def test_bootstrap_container_readable_until_mapped(
    client, container, make_agent, trust_proxy
):
    """The unmapped-bootstrap exemption: before any human is bound, trusted arrivals
    can read (the founder must see the stack to claim it)."""
    cid = container["id"]
    await make_agent("root", "operator", kind="human")  # human exists, still unmapped
    assert (await client.get(f"/api/containers/{cid}", headers=OCTO)).status_code == 200
    # bind octocat -> mapped; a different trusted stranger now reads 403
    await client.get(f"/api/me?cid={cid}", headers=OCTO)
    assert (await client.get(f"/api/containers/{cid}", headers=MALLORY)).status_code == 403
