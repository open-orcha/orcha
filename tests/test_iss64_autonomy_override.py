"""orcha-cloud #64 (upstream open-orcha/orcha#207) — PER-AGENT AUTONOMY OVERRIDES (mig 043)
over the #298 slider (mig 021).

Two additive columns + ONE shared rule (portal_backend/autonomy.py):

    effective = container.autonomy_level              if container.autonomy_enforced
              else (agent.autonomy_override or container.autonomy_level)

The ONE engine-enforced gate (task completion) now resolves the EFFECTIVE level for the
ACTING agent (the agent marking /done — the same identity the WORK-lane token verified, on
both lanes); every exposure surface (get_container / /next / wake-scan) carries the container
level+enforced flag AND the per-agent effective level as ADDITIVE fields — `autonomy_level`
keeps its container meaning everywhere, so nothing pre-043 shifts under an old consumer.

Cloud divergence under test here (beyond the upstream port): the PATCH autonomy_override lane
must ALSO pass the mig-039 access model — owner-or-`manage_autonomy` (the SAME grant the
container slider requires), while profile fields keep their owner-or-`manage_agents` gate;
viewers are refused across the board.

Safety floor (unchanged, and asserted here): an override can only take the SAME three enum
values the container slider already allows — it grants ONE agent what the container could
already grant EVERYONE; needs_verification stays the default; writes stay human-gated.
"""
import pytest

from portal_backend.autonomy import effective_autonomy

# ---- mig-039 trusted-proxy helpers (mirrors test_access_model's arena) ----
OCTO = {"X-Auth-Request-User": "octocat"}      # bound owner of the arena
HUBOT = {"X-Auth-Request-User": "hubot"}       # invited member
VERA = {"X-Auth-Request-User": "vera"}         # invited VIEWER


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


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
    return r.json()


async def _set_autonomy(client, cid, level, actor_id, *, enforced=None, headers=None):
    body = {"level": level, "actor_agent_id": actor_id}
    if enforced is not None:
        body["autonomy_enforced"] = enforced
    return await client.post(f"/api/containers/{cid}/autonomy", json=body,
                             headers=headers or {})


async def _set_override(client, aid, actor_id, value, *, headers=None):
    return await client.patch(
        f"/api/agents/{aid}",
        json={"actor_agent_id": actor_id, "autonomy_override": value},
        headers=headers or {},
    )


# ---------------------------------------------------------------- the ONE shared rule (unit matrix)

def test_effective_level_truth_matrix():
    """The full inherit/override/enforced matrix of the ONE shared rule. Every consumer
    (completion gate + all exposure surfaces) routes through effective_autonomy(), so this
    matrix IS the engine contract. MUTATION: flip the enforced branch to honor the override
    (or the override branch to ignore it) and a row here goes RED."""
    for container_level in ("plan", "pr", "full"):
        # NULL override -> inherit, enforced or not (enforce is a no-op without overrides).
        assert effective_autonomy(container_level, False, None) == container_level
        assert effective_autonomy(container_level, True, None) == container_level
        for override in ("plan", "pr", "full"):
            # not enforced -> the override GOVERNS (widening AND narrowing both work) …
            assert effective_autonomy(container_level, False, override) == override
            # … enforced -> the override is IGNORED; the container level governs everyone.
            assert effective_autonomy(container_level, True, override) == container_level


# ---------------------------------------------------------------- the hard gate honors the ACTING agent

async def test_override_full_auto_completes_while_sibling_parks(
    client, container, make_agent, make_task, db, work_headers
):
    """THE feature tooth: container at 'plan', agent A overridden to 'full', sibling B inherits.
    A's /done AUTO-COMPLETES (same _complete_and_unblock path as a human verify); B's /done still
    parks at needs_verification. The acting identity on this WORK-lane route is body.agent_id —
    exactly the agent the minted work token was verified for, so the override lookup can never
    key off a spoofed sibling. MUTATION: compute the gate off the container level (drop the
    per-agent resolve in task_done_routes) -> A's task parks too -> RED."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    b = await make_agent("sib", "eng")
    r = await _set_override(client, a["agent_id"], human["agent_id"], "full")
    assert r.status_code == 200, r.text

    ta = await make_task("a-work", "done", assignee_alias="ovr")
    ra = await client.post(f"/api/tasks/{ta['task_id']}/done",
                           json={"agent_id": a["agent_id"], "result": "x"},
                           headers=await work_headers(a["agent_id"]))
    assert ra.status_code == 200, ra.text
    assert ra.json()["status"] == "completed" and ra.json()["auto_completed"] is True
    rows = db.execute("SELECT status, completed_at FROM tasks WHERE id=%s", (ta["task_id"],))
    assert rows[0]["status"] == "completed" and rows[0]["completed_at"] is not None

    tb = await make_task("b-work", "done", assignee_alias="sib")
    rb = await client.post(f"/api/tasks/{tb['task_id']}/done",
                           json={"agent_id": b["agent_id"], "result": "x"},
                           headers=await work_headers(b["agent_id"]))
    assert rb.status_code == 200 and rb.json()["status"] == "needs_verification"


async def test_enforced_flips_override_back_to_container_level(
    client, container, make_agent, make_task, work_headers
):
    """The lock switch: same override='full' agent, but the container ENFORCES 'plan' -> the
    /done parks at needs_verification (override ignored). MUTATION: drop the enforced branch in
    effective_autonomy -> auto-complete -> RED."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    r = await _set_autonomy(client, container["id"], "plan", human["agent_id"], enforced=True)
    assert r.status_code == 200 and r.json()["autonomy_enforced"] is True

    t = await make_task("locked", "done", assignee_alias="ovr")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": a["agent_id"], "result": "x"},
                          headers=await work_headers(a["agent_id"]))
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"


async def test_override_narrows_a_full_container(
    client, container, make_agent, make_task, work_headers
):
    """The narrowing direction: container at 'full' but the acting agent is overridden to 'plan'
    -> its /done parks at needs_verification while the container would auto-complete. An override
    is a per-agent LEVEL, not a privilege escalator."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("careful", "eng")
    assert (await _set_autonomy(client, container["id"], "full", human["agent_id"])).status_code == 200
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "plan")).status_code == 200

    t = await make_task("narrow", "done", assignee_alias="careful")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": a["agent_id"], "result": "x"},
                          headers=await work_headers(a["agent_id"]))
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"


async def test_cleared_override_re_inherits(
    client, container, make_agent, make_task, work_headers
):
    """null CLEARS: after set-then-clear the agent inherits the container level again ('plan'
    parks). Distinguishes clear-to-null from omitted (the model_fields_set contract)."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("dev", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    r = await _set_override(client, a["agent_id"], human["agent_id"], None)
    assert r.status_code == 200 and r.json()["autonomy_override"] is None

    t = await make_task("cleared", "done", assignee_alias="dev")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": a["agent_id"], "result": "x"},
                          headers=await work_headers(a["agent_id"]))
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"


# ---------------------------------------------------------------- PATCH validation + write gates

async def test_patch_bad_override_value_is_422(client, container, make_agent, db):
    """A bad enum value is refused by the AgentUpdate schema Literal (422) BEFORE the route body
    runs — an unvalidated string must never reach the hard gate. And the DB did not move."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("dev", "eng")
    r = await _set_override(client, a["agent_id"], human["agent_id"], "yolo")
    assert r.status_code == 422, r.text
    rows = db.execute("SELECT autonomy_override FROM agents WHERE id=%s", (a["agent_id"],))
    assert rows[0]["autonomy_override"] is None


async def test_patch_override_on_human_target_rejected(client, container, make_agent, db):
    """Humans carry NO override (they never mark tasks done) — 400, mirroring the
    humans-carry-no-system_prompt guard. Clearing to null on a human is rejected too (one
    consistent contract)."""
    human = await make_agent("op", "operator", kind="human")
    human2 = await make_agent("op2", "operator", kind="human")
    r = await _set_override(client, human2["agent_id"], human["agent_id"], "full")
    assert r.status_code == 400, r.text
    r = await _set_override(client, human2["agent_id"], human["agent_id"], None)
    assert r.status_code == 400, r.text
    rows = db.execute("SELECT autonomy_override FROM agents WHERE id=%s", (human2["agent_id"],))
    assert rows[0]["autonomy_override"] is None


async def test_patch_override_is_human_gated(client, container, make_agent, db):
    """An AI actor cannot hand out autonomy — same human-authority gate as role/prompt edits
    (403 via require_kind, the trust-off lane). The level did NOT move."""
    ai = await make_agent("bot", "eng")
    target = await make_agent("dev", "eng")
    r = await _set_override(client, target["agent_id"], ai["agent_id"], "full")
    assert r.status_code == 403, r.text
    rows = db.execute("SELECT autonomy_override FROM agents WHERE id=%s", (target["agent_id"],))
    assert rows[0]["autonomy_override"] is None


async def test_patch_omitting_override_leaves_it_unchanged(client, container, make_agent, db):
    """OMITTING the field is 'unchanged' — a role-only PATCH never clears an override (the
    model_fields_set membership check, NOT `is not None`). MUTATION: test `is not None` in the
    route and a role edit silently wipes the override -> RED."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("dev", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "pr")).status_code == 200
    r = await client.patch(f"/api/agents/{a['agent_id']}",
                           json={"actor_agent_id": human["agent_id"], "role": "senior eng"})
    assert r.status_code == 200, r.text
    rows = db.execute("SELECT autonomy_override FROM agents WHERE id=%s", (a["agent_id"],))
    assert rows[0]["autonomy_override"] == "pr"


async def test_db_check_rejects_bad_override(db, container, client, make_agent):
    """Belt-and-suspenders: the mig-043 column CHECK refuses an out-of-enum value even via raw
    SQL (mirrors the mig-021 CHECK tooth)."""
    import psycopg
    a = await make_agent("dev", "eng")
    try:
        db.execute("UPDATE agents SET autonomy_override='nope' WHERE id=%s", (a["agent_id"],))
        assert False, "DB CHECK should have rejected 'nope'"
    except psycopg.errors.CheckViolation:
        pass


async def test_enforce_write_is_human_gated_and_optional(client, container, make_agent, db):
    """The enforce switch rides the SAME human-only /autonomy endpoint: an AI actor is 403 and
    nothing moves; a human flips it on and OFF; omitting the field leaves the switch unchanged
    (partial update)."""
    ai = await make_agent("bot", "eng")
    human = await make_agent("op", "operator", kind="human")
    r = await _set_autonomy(client, container["id"], "plan", ai["agent_id"], enforced=True)
    assert r.status_code == 403, r.text
    rows = db.execute("SELECT autonomy_enforced FROM containers WHERE id=%s", (container["id"],))
    assert rows[0]["autonomy_enforced"] is False          # mig-043 default: NOT enforced

    r = await _set_autonomy(client, container["id"], "pr", human["agent_id"], enforced=True)
    assert r.status_code == 200 and r.json()["autonomy_enforced"] is True
    # level-only write (enforced omitted) -> the switch stays where it was
    r = await _set_autonomy(client, container["id"], "plan", human["agent_id"])
    assert r.status_code == 200 and r.json()["autonomy_enforced"] is True
    r = await _set_autonomy(client, container["id"], "plan", human["agent_id"], enforced=False)
    assert r.status_code == 200 and r.json()["autonomy_enforced"] is False


# ---------------------------------------------------------------- mig-039 access model (cloud lane)

async def test_override_lane_requires_manage_autonomy_grant(
    client, container, make_agent, trust_proxy
):
    """THE cloud tooth: under the trusted proxy the override lane is owner-or-manage_autonomy —
    the SAME grant the container slider requires — while profile fields keep owner-or-
    manage_agents. Each field class needs ITS grant: manage_agents alone never unlocks the
    override; manage_autonomy alone never unlocks a role edit; a PATCH carrying both needs both.
    MUTATION: gate the override on manage_agents (or drop the added enforce_grant) -> the
    ungranted/mis-granted 403s below go GREEN->RED."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    hubot = await _invite(client, cid, "hubot")
    ai = await make_agent("bot", "worker", kind="ai")
    aid = ai["agent_id"]

    # no grants -> the override lane is refused, and NAMES the missing grant
    r = await _set_override(client, aid, hubot, "full", headers=HUBOT)
    assert r.status_code == 403 and "manage_autonomy" in r.text, r.text

    # manage_agents alone -> profile edits unlock, the override lane still refuses
    await _grant(client, cid, hubot, ["manage_agents"])
    r = await client.patch(f"/api/agents/{aid}",
                           json={"actor_agent_id": hubot, "role": "senior"}, headers=HUBOT)
    assert r.status_code == 200, r.text
    r = await _set_override(client, aid, hubot, "full", headers=HUBOT)
    assert r.status_code == 403 and "manage_autonomy" in r.text, r.text

    # manage_autonomy alone -> the override lane unlocks, profile edits refuse
    await _grant(client, cid, hubot, ["manage_autonomy"])
    r = await _set_override(client, aid, hubot, "full", headers=HUBOT)
    assert r.status_code == 200 and r.json()["autonomy_override"] == "full", r.text
    r = await client.patch(f"/api/agents/{aid}",
                           json={"actor_agent_id": hubot, "role": "staff"}, headers=HUBOT)
    assert r.status_code == 403 and "manage_agents" in r.text, r.text
    # …and a combined PATCH (role + override) needs BOTH -> still 403 on the missing one
    r = await client.patch(
        f"/api/agents/{aid}",
        json={"actor_agent_id": hubot, "role": "staff", "autonomy_override": "pr"},
        headers=HUBOT,
    )
    assert r.status_code == 403 and "manage_agents" in r.text, r.text

    # the owner always could (clears it — the trusted lane resolves the true actor, so the
    # claimed body actor is just a placeholder), and the enforce switch honors the same grant
    r = await _set_override(client, aid, hubot, None, headers=OCTO)
    assert r.status_code == 200 and r.json()["autonomy_override"] is None, r.text
    r = await _set_autonomy(client, cid, "plan", hubot, enforced=True, headers=HUBOT)
    assert r.status_code == 200 and r.json()["autonomy_enforced"] is True, r.text


async def test_override_lane_refuses_viewers(client, container, make_agent, trust_proxy):
    """mig 039: the viewer role is read-only across the board — a viewer PATCHing an override is
    403 even though viewers can SEE the badge + effective level in the snapshot."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "vera", role="viewer")
    ai = await make_agent("bot", "worker", kind="ai")
    r = await _set_override(client, ai["agent_id"], ai["agent_id"], "full", headers=VERA)
    assert r.status_code == 403, r.text


async def test_trusted_lane_binds_the_acting_human(client, container, make_agent, trust_proxy):
    """Acting-agent resolution, browser-header lane: under the trusted proxy the resolved
    member IS the actor — a mismatched client-supplied actor_agent_id is overridden, never
    trusted (the per-project identity rule). The write lands attributed to the verified
    member, not the claimed body actor."""
    cid = container["id"]
    ident = await _bind_owner(client, container, make_agent)
    ai = await make_agent("bot", "worker", kind="ai")
    # claim a bogus actor (the AI's own id) — the trusted lane overrides it with octocat's agent
    r = await _set_override(client, ai["agent_id"], ai["agent_id"], "pr", headers=OCTO)
    assert r.status_code == 200 and r.json()["autonomy_override"] == "pr", r.text


# ---------------------------------------------------------------- exposure (additive fields, all surfaces)

async def test_get_container_exposes_enforced_and_per_agent_effective(
    client, container, make_agent
):
    """get_container carries the container's autonomy_enforced AND, per agent, the raw
    autonomy_override + server-computed effective_autonomy (the roster badge + 'acts as' label
    read these). `autonomy_level` keeps its container meaning — additive only. MUTATION: drop
    the effective_autonomy annotation loop in container_snapshot_routes -> RED."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    r = await client.get(f"/api/containers/{container['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["container"]["autonomy_level"] == "plan"           # unchanged container meaning
    assert body["container"]["autonomy_enforced"] is False
    by_alias = {x["alias"]: x for x in body["agents"]}
    assert by_alias["ovr"]["autonomy_override"] == "full"
    assert by_alias["ovr"]["effective_autonomy"] == "full"         # override governs
    assert by_alias["op"]["autonomy_override"] is None
    assert by_alias["op"]["effective_autonomy"] == "plan"          # inherit

    # flip the lock: every effective level snaps to the container level; overrides still visible
    assert (await _set_autonomy(client, container["id"], "plan", human["agent_id"],
                                enforced=True)).status_code == 200
    body = (await client.get(f"/api/containers/{container['id']}")).json()
    assert body["container"]["autonomy_enforced"] is True
    by_alias = {x["alias"]: x for x in body["agents"]}
    assert by_alias["ovr"]["autonomy_override"] == "full"          # the parked override stays visible
    assert by_alias["ovr"]["effective_autonomy"] == "plan"         # …but no longer governs


async def test_next_payload_carries_enforced_and_effective(
    client, container, make_agent, make_task, work_headers
):
    """/next tells the claiming worker the level IT acts under: autonomy_level keeps the
    container meaning (pre-043 consumers unbroken) while autonomy_enforced + effective_autonomy
    ride beside it. The worker keys its advisory gh/git behavior off effective_autonomy."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    assert (await _set_override(client, dev["agent_id"], human["agent_id"], "full")).status_code == 200
    t = await make_task("loose", "done")    # unassigned -> ready
    ar = await client.post(f"/api/tasks/{t['id']}/assign",
                           json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert ar.status_code == 200, ar.text
    r = await client.post(f"/api/agents/{dev['agent_id']}/next",
                          headers=await work_headers(dev["agent_id"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["autonomy_level"] == "plan"        # the CONTAINER level, meaning unchanged
    assert body["autonomy_enforced"] is False
    assert body["effective_autonomy"] == "full"    # what THIS worker acts under


async def test_wake_scan_carries_enforced_and_per_candidate_effective(
    client, container, make_agent
):
    """wake-scan (the daemon's contract): scan-wide autonomy_level+autonomy_enforced, plus each
    candidate's autonomy_override + effective_autonomy — the notifier's per-candidate T2 gate
    (notifier_wake_candidate) keys off the candidate field. MUTATION: drop the builder's
    effective_autonomy -> the daemon falls back to the scan-wide level and a per-agent 'full'
    never cheap-acts -> RED here first."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    r = await client.get(f"/api/containers/{container['id']}/wake-scan",
                         params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["autonomy_level"] == "plan" and body["autonomy_enforced"] is False
    cand = next(c for c in body["candidates"] if c["agent_id"] == a["agent_id"])
    assert cand["autonomy_override"] == "full" and cand["effective_autonomy"] == "full"

    # enforced -> every candidate's effective level recomputes to the container level
    assert (await _set_autonomy(client, container["id"], "plan", human["agent_id"],
                                enforced=True)).status_code == 200
    body = (await client.get(f"/api/containers/{container['id']}/wake-scan",
                             params={"cooldown": 0, "min_idle": 0})).json()
    assert body["autonomy_enforced"] is True
    cand = next(c for c in body["candidates"] if c["agent_id"] == a["agent_id"])
    assert cand["effective_autonomy"] == "plan"


async def test_full_override_audit_records_resolved_level(
    client, container, make_agent, make_task, db, work_headers
):
    """The auto-complete audit row records the RESOLVED level + auto_completed (mirrors the #298
    audit tooth) so a post-hoc reviewer can see the engine auto-completed under an override while
    the container itself sat at 'plan'."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    t = await make_task("audited", "done", assignee_alias="ovr")
    await client.post(f"/api/tasks/{t['task_id']}/done",
                      json={"agent_id": a["agent_id"], "result": "x"},
                      headers=await work_headers(a["agent_id"]))
    rows = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='status_changed' ORDER BY id",
        (t["task_id"],))
    last = rows[-1]["detail"]
    assert last["to"] == "completed" and last["autonomy_level"] == "full"
    assert last["auto_completed"] is True
    rows = db.execute("SELECT autonomy_level FROM containers WHERE id=%s", (container["id"],))
    assert rows[0]["autonomy_level"] == "plan"     # the container never moved


# ---------------------------------------------------------------- portal source contracts (UI teeth)
#
# MIGRATED (portal React migration): the vanilla agents.html override seg (autOvrSeg /
# canEditAutOvr / ovrBadge) and the app-autonomy.js enforce chip (data-enforce) are retired
# with the static files. The React port's autonomy surface is the shell's AutonomySwitch
# (frontend/src/shell/Shell.tsx): the 3-level container slider POSTing the SAME /autonomy
# endpoint, human-gated. The per-agent override chips, the roster override/lock badge, and
# the enforce chip have NOT yet been ported to the React frontend — that UI is a tracked
# fast-follow of the React adoption. The #64 CONTRACT itself stays fully covered above at
# the API layer (PATCH gates, mig-039 grants, the exposure fields the future UI will render
# from: autonomy_override / effective_autonomy / autonomy_enforced on every surface).

import pathlib
import re


import pytest


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    """Autonomy-override writes ride member-mutation-adjacent gates — a Team-plan
    surface under the plan-gating addendum; this suite tests overrides, not the
    gate (tests/test_plan_gating.py owns that)."""
    monkeypatch.setenv("ORCHA_PLAN", "team")

_FRONTEND = (pathlib.Path(__file__).resolve().parent.parent / "orcha-cli" / "orcha_cli"
             / "templates" / "portal" / "frontend" / "src")


def test_shell_autonomy_switch_posts_levels_to_the_same_endpoint():
    """The React shell's AutonomySwitch is the surviving autonomy UI: the plan/pr/full rungs
    POST the SAME /api/containers/{cid}/autonomy endpoint the enforce switch and this suite's
    API teeth exercise (one endpoint, one contract), and the control is human-gated (an
    acting human must be picked before any write fires)."""
    src = (_FRONTEND / "shell" / "Shell.tsx").read_text()
    # The switch was split (Shell.autonomy-split): AutonomyLevels renders the
    # three rungs, AutonomyControls hosts them + the notifier — same endpoint,
    # same teeth, new names. The tripwire pins the split components.
    assert "function AutonomyLevels" in src and "function AutonomyControls" in src, \
        "the shell lost the autonomy switch (AutonomyLevels/AutonomyControls)"
    assert "/autonomy" in src and 'sendJSON("POST"' in src, \
        "the level slider no longer POSTs the /autonomy endpoint"
    for level in ('level: "plan"', 'level: "pr"', 'level: "full"'):
        assert level in src, f"the slider lost the {level} rung"
    assert "actor_agent_id" in src, "the autonomy write no longer names its acting human"
    assert "Pick an acting human to change autonomy" in src, \
        "the slider lost its human-gate affordance"


def test_react_override_control_ships_with_all_mig039_teeth():
    """The #64 override UI landed in the React frontend (AgentsPage) — the former
    tripwire now pins its four mandatory teeth so a refactor can't shed them:
    (1) mig-039 affordance gates, (2) explicit-null Inherit chip, (3) the
    effective_autonomy badge, (4) the enforced lock glyph. Behavior coverage:
    frontend AgentsPage.autonomy.test.tsx (8 tests)."""
    src = (_FRONTEND / "pages" / "agents" / "AgentsPage.tsx").read_text()
    # (1) gates: grant + viewer read-only + owner path
    assert "canEditAutOvr" in src and "manage_autonomy" in src, "affordance gates missing"
    assert '"viewer"' in src, "viewer read-only gate missing"
    # (2) Inherit sends an explicit null (clear-vs-omit contract)
    assert "autonomy_override" in src and "Inherit" in src, "Inherit chip missing"
    assert re.search(r"autonomy_override[\"']?\s*:\s*", src), "override not sent in the PATCH body"
    # (3) effective badge from the server-computed field
    assert "effective_autonomy" in src and "Effective:" in src, "effective badge missing"
    # (4) enforced lock glyph parks the chips
    assert "autonomy_enforced" in src, "enforce gate missing"
    # graceful absence on open backends
    assert "showAutOvr" in src, "absence gate missing"