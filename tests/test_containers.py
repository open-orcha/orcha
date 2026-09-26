"""Container lifecycle state machine (Orcha#22)."""
import pytest


async def test_create_returns_ids(client):
    r = await client.post("/api/containers", json={"name": "proj"})
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["container_id"] and d["root_task_id"]


async def test_second_container_rejected_409(client, container):
    # Orcha#28: stack:db:container is 1:1:1 *by default* — the `orcha init` contract.
    # (Mig 037 multi-project: the portal opts out with additional=true, below.)
    r = await client.post("/api/containers", json={"name": "second"})
    assert r.status_code == 409, r.text


# ---------- multi-project create (mig 037: POST /api/containers, additional=true) ----------

async def test_additional_container_created_with_seeded_owner(client, container):
    """The portal's New-project flow: additional=true creates a SECOND container and
    seeds its founding human (kind='human', role='operator', member_role='owner') —
    without the trusted proxy header the seeded alias falls back to 'operator'."""
    r = await client.post(
        "/api/containers",
        json={"name": "proj-two", "description": "second project", "additional": True},
    )
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["container_id"] and d["root_task_id"] and d["name"] == "proj-two"
    assert d["human_agent_id"]

    snap = (await client.get(f"/api/containers/{d['container_id']}")).json()
    humans = [a for a in snap["agents"] if a["kind"] == "human"]
    assert len(humans) == 1 and humans[0]["alias"] == "operator"
    assert humans[0]["member_role"] == "owner" and humans[0]["github_login"] is None


async def test_additional_container_seeds_trusted_github_user_as_owner(
    client, container, monkeypatch
):
    """With the trusted proxy identity (ORCHA_TRUST_PROXY_USER=1 + X-Auth-Request-User),
    the CREATING GitHub user IS the new project's human: alias + github_login preset to
    the login, owner role — so /api/me resolves them immediately (switcher works)."""
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    r = await client.post(
        "/api/containers",
        json={"name": "proj-two", "additional": True},
        headers={"X-Auth-Request-User": "octocat"},
    )
    assert r.status_code == 201, r.text
    cid = r.json()["container_id"]

    me = (await client.get(
        f"/api/me?cid={cid}", headers={"X-Auth-Request-User": "octocat"}
    )).json()["identity"]
    assert me is not None, "creator must resolve in the new project without a bind pass"
    assert me["agent_id"] == r.json()["human_agent_id"]
    assert me["alias"] == "octocat" and me["github_login"] == "octocat"
    assert me["member_role"] == "owner"


async def test_additional_container_untrusted_header_ignored(
    client, container, monkeypatch
):
    # Trust env unset → the header is inert; the seed falls back to 'operator'.
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    r = await client.post(
        "/api/containers",
        json={"name": "proj-two", "additional": True},
        headers={"X-Auth-Request-User": "octocat"},
    )
    assert r.status_code == 201, r.text
    snap = (await client.get(f"/api/containers/{r.json()['container_id']}")).json()
    humans = [a for a in snap["agents"] if a["kind"] == "human"]
    assert humans[0]["alias"] == "operator" and humans[0]["github_login"] is None


async def test_duplicate_project_name_rejected_409(client, container):
    # containers_name_uq (mig 037): names unique per stack, case-insensitively —
    # the switcher menu and the reset confirm-phrase stay unambiguous.
    r = await client.post(
        "/api/containers", json={"name": container["name"].upper(), "additional": True}
    )
    assert r.status_code == 409, r.text
    assert "already exists" in r.json()["detail"]


async def test_list_containers_founding_first_with_switcher_fields(client, container):
    """GET /api/containers: founding project first (created_at ASC — CLI consumers
    take [0]), each row carrying the switcher fields (agents count, last_wake_scan_at)."""
    r = await client.post(
        "/api/containers", json={"name": "proj-two", "additional": True}
    )
    assert r.status_code == 201, r.text
    lst = (await client.get("/api/containers")).json()["containers"]
    assert [c["name"] for c in lst] == [container["name"], "proj-two"]
    assert lst[0]["agents"] == 0 and lst[1]["agents"] == 1  # the seeded owner
    assert all("last_wake_scan_at" in c for c in lst)
    assert all(c["last_wake_scan_at"] is None for c in lst)  # no notifier polled yet


async def test_wake_scan_stamps_notifier_binding(client, container):
    """GET .../wake-scan (the daemon's per-tick poll) stamps last_wake_scan_at — the
    portal's signal for WHICH project a host-side notifier serves. A container the
    daemon never polls keeps NULL (⇒ portal-only, no wakes)."""
    two = (await client.post(
        "/api/containers", json={"name": "proj-two", "additional": True}
    )).json()
    r = await client.get(f"/api/containers/{container['id']}/wake-scan")
    assert r.status_code == 200, r.text

    lst = (await client.get("/api/containers")).json()["containers"]
    by_name = {c["name"]: c for c in lst}
    assert by_name[container["name"]]["last_wake_scan_at"] is not None
    assert by_name["proj-two"]["last_wake_scan_at"] is None

    # the snapshot exposes it too (the dashboard's wakes-notice check reads the poll)
    snap = (await client.get(f"/api/containers/{two['container_id']}")).json()
    assert snap["container"]["last_wake_scan_at"] is None


async def test_status_flip_active_paused_active(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    for target in ("paused", "active"):
        r = await client.post(
            f"/api/containers/{container['id']}/status",
            json={"status": target, "actor_agent_id": human["agent_id"]},
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == target


async def test_invalid_status_rejected_400(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    r = await client.post(
        f"/api/containers/{container['id']}/status",
        json={"status": "banana", "actor_agent_id": human["agent_id"]},
    )
    assert r.status_code == 400, r.text


async def test_status_flip_is_human_only(client, container, make_agent):
    ai = await make_agent("bot", "worker")  # kind='ai'
    r = await client.post(
        f"/api/containers/{container['id']}/status",
        json={"status": "paused", "actor_agent_id": ai["agent_id"]},
    )
    assert r.status_code == 403, r.text  # Orcha#30: only humans flip container status


async def test_unknown_container_404(client):
    import uuid
    r = await client.get(f"/api/containers/{uuid.uuid4()}")
    assert r.status_code == 404, r.text


async def test_root_task_verification_completes_container(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    # verifying the root task (a sentinel) completes the whole container
    r = await client.post(
        f"/api/tasks/{container['root_task_id']}/verify",
        json={"approve": True, "actor_agent_id": human["agent_id"]},
    )
    assert r.status_code == 200, r.text
    snap = await client.get(f"/api/containers/{container['id']}")
    assert snap.json()["container"]["status"] == "completed"


@pytest.mark.xfail(reason="Orcha#24: paused container does not yet block mutating endpoints")
async def test_paused_blocks_mutations(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    await client.post(
        f"/api/containers/{container['id']}/status",
        json={"status": "paused", "actor_agent_id": human["agent_id"]},
    )
    r = await client.post(
        f"/api/containers/{container['id']}/tasks",
        json={"title": "t", "definition_of_done": "d", "depends_on": []},
    )
    assert r.status_code == 409, "a paused container should reject new tasks"
