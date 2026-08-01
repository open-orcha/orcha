"""SEAM A (open-orcha#211) — the pluggable auth-provider seam.

Open-core Orcha ships NO server-side caller authentication: a route trusts the
acting-agent id handed to it in the request body and only checks that id's KIND
(the documented V2 spoof vector in test_iss271_actor_hardening.py). SEAM A adds a
lane a downstream distribution can plug into — `resolve_actor` (who is really
calling) and `authorize` (may they do this action) — WITHOUT forking the routes.

The invariant this file guards: with the BUILT-IN DEFAULTS the refactor is a
no-op — every existing route behaves bit-for-bit as before (the whole pre-existing
suite proves that at scale; the default-passthrough tests here pin the seam's own
contract). Overriding either hook must OBSERVABLY change behavior.

Mutation notes (each test states what breaks if the seam were mis-wired):

  * defaults_passthrough: if the inserted `resolve_actor`/`authorize` calls were
    NOT no-ops by default, these routes would 4xx / behave differently. They pass
    untouched → the default resolver returns the body id and the default
    authorizer permits.
  * override_resolver_changes_resolution: the toy header resolver returns an id
    DIFFERENT from the body's. We prove that id is the one `authorize` receives —
    i.e. the resolver's output actually flows to the authorize lane at the call
    site. Revert the seam insertion in the route and this test can no longer
    observe the header id → it goes red.
  * authorize_deny_surfaces_403: a downstream authorizer that raises
    HTTPException(403) makes the route return 403 even though the built-in
    require_kind check would have permitted it. Remove the `authorize(...)` call
    from the route and the deny never fires → the route returns 200/201 → red.
  * registration_idempotent_and_replaceable: register twice → latest wins;
    partial registration leaves the other hook untouched; reset restores defaults.
"""
import importlib

import pytest

pytestmark = pytest.mark.asyncio

# Import the seam module the same way the app does (portal_backend is on sys.path
# via conftest). Keep a handle so every test can register/reset on the SAME module
# object the routes imported their `resolve_actor`/`authorize` names from.
auth_provider = importlib.import_module("portal_backend.auth_provider")


@pytest.fixture(autouse=True)
def _reset_provider_between_tests():
    """The provider registry is process-global; restore defaults around every test
    so one test's override never leaks into another (or into the rest of the suite)."""
    auth_provider.reset_auth_provider()
    yield
    auth_provider.reset_auth_provider()


async def _human(make_agent):
    h = await make_agent("Boss", kind="human")
    return h["agent_id"]


# --------------------------------------------------------------------------
# 1. DEFAULTS PASSTHROUGH — the refactor is a no-op with the built-in providers
# --------------------------------------------------------------------------


async def test_default_resolve_returns_the_fallback_id():
    """The default resolver IS the pre-seam behavior: it returns the body-supplied
    fallback id unchanged (the route trusts what it was handed)."""
    got = auth_provider.resolve_actor(
        cur=None, request=None, container_id="c-1", fallback_actor_id="agent-42"
    )
    assert got == "agent-42"
    # None fallback (e.g. a human-authored create) passes through as None.
    assert (
        auth_provider.resolve_actor(
            cur=None, request=None, container_id="c-1", fallback_actor_id=None
        )
        is None
    )


async def test_default_authorize_permits_everything():
    """The default authorizer never denies — it returns None for any action, so the
    route's own require_kind check stays the sole gate."""
    assert (
        auth_provider.authorize(
            cur=None,
            request=None,
            actor_agent_id="agent-42",
            action="create_task",
            container_id="c-1",
        )
        is None
    )


async def test_create_task_unchanged_under_defaults(client, container, make_agent, db):
    """End-to-end: a refactored route (create_task) works exactly as before with the
    defaults in place — the inserted seam calls are no-ops. The task is created and the
    body-supplied creator is recorded (the route still uses the body id downstream)."""
    dev = await make_agent("Dev", kind="ai")
    r = await client.post(
        f"/api/containers/{container['id']}/tasks",
        json={
            "title": "seam-default",
            "definition_of_done": "done",
            "created_by_agent_id": dev["agent_id"],
            "depends_on": [],
        },
    )
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    rows = db.execute(
        "SELECT created_by_agent_id FROM tasks WHERE id=%s", (tid,)
    )
    assert rows and str(rows[0]["created_by_agent_id"]) == dev["agent_id"]


async def test_verify_task_still_human_gated_under_defaults(
    client, container, make_agent, make_task
):
    """The existing per-route human-authority check is UNMOVED by the seam: an AI actor
    still cannot verify (403 from require_kind, not from the default authorizer)."""
    ai = await make_agent("Sneaky", kind="ai")
    task = await make_task("t", "d")
    r = await client.post(
        f"/api/tasks/{task['id']}/verify",
        json={"actor_agent_id": ai["agent_id"], "approve": True},
    )
    assert r.status_code == 403, r.text


# --------------------------------------------------------------------------
# 2. OVERRIDE RESOLVER — a toy trusted-header resolver changes resolution
# --------------------------------------------------------------------------


async def test_override_resolver_changes_what_authorize_receives(
    client, container, make_agent
):
    """Register a toy resolver that derives the acting id from a trusted `X-Actor-Id`
    HEADER instead of the request body, plus an authorizer that records the id it is
    handed. The route's create_task call site must feed the RESOLVED id (the header's)
    into authorize — proving the resolver override is actually wired at the call site.

    Teeth: if the route did not call resolve_actor→authorize (seam reverted), the
    authorizer would never run and `seen` would stay empty → red.
    """
    seen = {}

    def header_resolver(cur, request, container_id, fallback_actor_id):
        # Trust a signed/proxied header in a real deployment; here just read it.
        hdr = request.headers.get("x-actor-id")
        return hdr or fallback_actor_id

    def recording_authorize(cur, request, actor_agent_id, action, container_id):
        seen["actor"] = actor_agent_id
        seen["action"] = action
        return None  # permit

    auth_provider.register_auth_provider(
        resolve_actor=header_resolver, authorize=recording_authorize
    )

    dev = await make_agent("Dev", kind="ai")
    body_id = dev["agent_id"]
    header_id = "trusted-header-actor"
    r = await client.post(
        f"/api/containers/{container['id']}/tasks",
        headers={"X-Actor-Id": header_id},
        json={
            "title": "seam-override",
            "definition_of_done": "done",
            "created_by_agent_id": body_id,
            "depends_on": [],
        },
    )
    assert r.status_code == 201, r.text
    # The resolver's HEADER id — NOT the body id — is what authorize saw.
    assert seen["actor"] == header_id
    assert seen["actor"] != body_id
    assert seen["action"] == "create_task"


async def test_override_resolver_alone_leaves_authorize_default(
    client, container, make_agent
):
    """Registering ONLY a resolver must not disturb the default (permit) authorizer —
    the route still succeeds, and resolution is redirected to the header."""
    def header_resolver(cur, request, container_id, fallback_actor_id):
        return request.headers.get("x-actor-id") or fallback_actor_id

    auth_provider.register_auth_provider(resolve_actor=header_resolver)

    dev = await make_agent("Dev", kind="ai")
    r = await client.post(
        f"/api/containers/{container['id']}/tasks",
        headers={"X-Actor-Id": "someone-else"},
        json={
            "title": "resolver-only",
            "definition_of_done": "done",
            "created_by_agent_id": dev["agent_id"],
            "depends_on": [],
        },
    )
    assert r.status_code == 201, r.text


# --------------------------------------------------------------------------
# 3. AUTHORIZE DENY — a downstream authorizer that raises 403 surfaces
# --------------------------------------------------------------------------


async def test_authorize_deny_surfaces_403(client, container, make_agent):
    """A downstream authorizer that denies `create_task` makes the route return 403 —
    even though the built-in checks would have permitted this create. This is the new
    lane the seam adds (closes the V2 spoof vector in a downstream distribution).

    Teeth: remove the `authorize(...)` call from create_task and this returns 201 → red.
    """
    from fastapi import HTTPException

    def deny_creates(cur, request, actor_agent_id, action, container_id):
        if action == "create_task":
            raise HTTPException(403, "downstream policy: creates are denied")
        return None

    auth_provider.register_auth_provider(authorize=deny_creates)

    dev = await make_agent("Dev", kind="ai")
    r = await client.post(
        f"/api/containers/{container['id']}/tasks",
        json={
            "title": "should-be-denied",
            "definition_of_done": "done",
            "created_by_agent_id": dev["agent_id"],
            "depends_on": [],
        },
    )
    assert r.status_code == 403, r.text
    assert "denied" in r.text


async def test_authorize_deny_targets_only_its_action(
    client, container, make_agent, make_task
):
    """The deny is action-scoped: an authorizer that only blocks `verify_task` leaves
    `create_task` permitted. Proves the per-call-site `action` string reaches authorize
    and can be discriminated on."""
    from fastapi import HTTPException

    def deny_verify(cur, request, actor_agent_id, action, container_id):
        if action == "verify_task":
            raise HTTPException(403, "no verifying today")
        return None

    auth_provider.register_auth_provider(authorize=deny_verify)

    dev = await make_agent("Dev", kind="ai")
    # create_task is NOT the denied action → still allowed
    r = await client.post(
        f"/api/containers/{container['id']}/tasks",
        json={
            "title": "still-ok",
            "definition_of_done": "done",
            "created_by_agent_id": dev["agent_id"],
            "depends_on": [],
        },
    )
    assert r.status_code == 201, r.text

    # verify_task IS denied — and it is denied by the authorizer, which runs regardless
    # of the actor's kind (a human actor would also be blocked).
    human = await make_agent("Boss", kind="human")
    task = await make_task("t", "d")
    v = await client.post(
        f"/api/tasks/{task['id']}/verify",
        json={"actor_agent_id": human["agent_id"], "approve": True},
    )
    assert v.status_code == 403, v.text
    assert "no verifying today" in v.text


# --------------------------------------------------------------------------
# 4. REGISTRATION — idempotent / replaceable / partial / resettable
# --------------------------------------------------------------------------


async def test_registration_latest_wins():
    """Registering a hook twice replaces it — the latest binding is the live one."""
    auth_provider.register_auth_provider(resolve_actor=lambda c, r, cid, f: "first")
    assert auth_provider.resolve_actor(None, None, "c", "body") == "first"
    auth_provider.register_auth_provider(resolve_actor=lambda c, r, cid, f: "second")
    assert auth_provider.resolve_actor(None, None, "c", "body") == "second"


async def test_partial_registration_leaves_other_hook_untouched():
    """Passing only `authorize` must NOT reset `resolve_actor` (and vice-versa) — each
    kwarg left None keeps that hook at its current binding."""
    from fastapi import HTTPException

    auth_provider.register_auth_provider(resolve_actor=lambda c, r, cid, f: "custom")
    # Now register ONLY an authorizer — the custom resolver must survive.
    def deny_all(c, r, a, action, cid):
        raise HTTPException(403, "nope")

    auth_provider.register_auth_provider(authorize=deny_all)
    assert auth_provider.resolve_actor(None, None, "c", "body") == "custom"
    with pytest.raises(HTTPException):
        auth_provider.authorize(None, None, "custom", "any", "c")


async def test_empty_registration_is_a_noop():
    """register_auth_provider() with no args changes nothing."""
    auth_provider.register_auth_provider(resolve_actor=lambda c, r, cid, f: "sticky")
    auth_provider.register_auth_provider()  # no-op
    assert auth_provider.resolve_actor(None, None, "c", "body") == "sticky"


async def test_reset_restores_builtin_defaults():
    """reset_auth_provider() puts both hooks back to today's behavior."""
    from fastapi import HTTPException

    auth_provider.register_auth_provider(
        resolve_actor=lambda c, r, cid, f: "override",
        authorize=lambda c, r, a, action, cid: (_ for _ in ()).throw(
            HTTPException(403, "denied")
        ),
    )
    auth_provider.reset_auth_provider()
    # default resolver → fallback id, default authorize → permit (None)
    assert auth_provider.resolve_actor(None, None, "c", "body-id") == "body-id"
    assert auth_provider.authorize(None, None, "body-id", "create_task", "c") is None
