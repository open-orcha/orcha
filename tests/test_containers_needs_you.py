"""GET /api/containers `needs_you` == the portal's "Needs you" attention rule.

The sidebar rows of OTHER projects, the switcher and the Projects table read the
server's `needs_you`; the open project's own sidebar row / nav / band read the portal's
selectAttention (frontend/src/state/attention.ts) over the snapshot. Linear review r3:
the two disagreed (8 on the project itself, 5 everywhere else) because the server left
out waiting plans and counted other reviewers' verifications. These tests pin:

  * the explicit per-kind numbers for a seeded project (plans gated on the author's
    EFFECTIVE autonomy, verifications gated on the container level, human-facing /
    escalated requests), and
  * PARITY: server needs_you == a line-for-line Python port of selectAttention run over
    the very snapshot (GET /api/containers/{cid}) the portal consumes, for several
    acting humans and autonomy settings.
"""

OCTO = {"X-Auth-Request-User": "octocat"}   # bound owner
HUBOT = {"X-Auth-Request-User": "hubot"}    # invited member
VERA = {"X-Auth-Request-User": "vera"}      # invited VIEWER


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    assert r.json()["identity"]["member_role"] == "owner"


async def _invite(client, cid, login, role="member"):
    r = await client.post(
        f"/api/containers/{cid}/members",
        json={"github_login": login, "role": role},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]

# ---------------------------------------------------------------------------
# A faithful port of frontend/src/state/attention.ts selectAttention (count only),
# with its helpers from state/SnapshotProvider.tsx and lib/reviewer.ts, operating on
# the RAW snapshot JSON exactly as api/client.ts maps it (assignee = assignees[0]).
# ---------------------------------------------------------------------------


def _by_alias(snap, alias):
    if not alias:
        return None
    return next((a for a in snap["agents"] if a["alias"] == alias), None)


def _by_id(snap, aid):
    if aid is None:
        return None
    return next((a for a in snap["agents"] if str(a["id"]) == str(aid)), None)


def _agent_autonomy(snap, a):
    lvl = snap["container"].get("autonomy_level") or "plan"
    if not a:
        return lvl
    if a.get("effective_autonomy"):
        return a["effective_autonomy"]
    if snap["container"].get("autonomy_enforced"):
        return lvl
    return a.get("autonomy_override") or lvl


def _plan_awaits_human(snap, t):
    pm = t.get("plan_message")
    if not (t["status"] == "in_progress" and not t.get("plan_decision") and pm):
        return False
    assignee = (t.get("assignees") or [None])[0]
    who = _by_alias(snap, pm.get("author_alias")) or _by_alias(snap, assignee)
    return _agent_autonomy(snap, who) == "plan"


def _review_for(t, h):
    r = t.get("reviewer")
    if r is None or h is None:
        return None
    rid = t.get("reviewer_agent_id") if t.get("reviewer_agent_id") is not None else r.get("agent_id")
    if rid is None:
        return None
    if str(h["id"]) == str(rid):
        return None
    if h.get("member_role") in ("owner", None):
        return None
    return r.get("github_login") or r.get("alias") or ""


def _is_to_human(snap, r):
    if not r["target_id"]:
        return True
    t = _by_id(snap, r["target_id"])
    return bool(t) and t["kind"] == "human"


def select_attention_count(snap, acting_id, read_only=False):
    if read_only:
        return 0
    level = snap["container"].get("autonomy_level") or "plan"
    acting = _by_id(snap, acting_id)
    n = 0
    for t in snap["tasks"]:
        kind = None
        if _plan_awaits_human(snap, t):
            kind = "plan"
        elif level != "full" and t["status"] == "needs_verification":
            kind = "verify"
        if not kind:
            continue
        if t.get("reviewer_agent_id") is not None or t.get("reviewer") is not None:
            other = (_review_for(t, acting) is not None) if acting else t.get("reviewer_agent_id") is not None
        else:
            other = False
        n += 0 if other else 1
    for r in snap["requests"]:
        if (r["status"] == "open" and _is_to_human(snap, r)) or r["status"] == "escalated":
            target = _by_id(snap, r["target_id"])
            other = bool(target) and target["kind"] == "human" and (
                acting_id is None or str(target["id"]) != str(acting_id)
            )
            n += 0 if other else 1
    return n


# ---------------------------------------------------------------------------
# seeding helpers (direct rows: the statuses/decisions under test, nothing else)
# ---------------------------------------------------------------------------


def _set_status(db, tid, status):
    db.execute("UPDATE tasks SET status=%s WHERE id=%s", (status, tid))


def _plan_msg(db, tid, author_id, body="1. do it"):
    db.execute(
        "INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,%s,%s)",
        (tid, author_id, body),
    )


def _decide_plan(db, cid, tid, actor_id):
    db.execute(
        """INSERT INTO decisions (container_id, subject_type, subject_id, decision, actor_agent_id)
           VALUES (%s,'plan_approval',%s,'approve',%s)""",
        (cid, str(tid), actor_id),
    )


def _request(db, cid, requester, target, status="open"):
    db.execute(
        """INSERT INTO requests (container_id, type, requester_id, target_id, status, payload)
           VALUES (%s,'info',%s,%s,%s,'q?')""",
        (cid, requester, target, status),
    )


def _row(listing, cid):
    return next(c for c in listing["containers"] if c["id"] == cid)


async def _snapshot(client, cid, headers=None):
    r = await client.get(f"/api/containers/{cid}", headers=headers or {})
    assert r.status_code == 200, r.text
    return r.json()


async def _seed(client, db, container, make_agent, make_task):
    """A project exercising every branch of the rule. Returns ids."""
    cid = container["id"]
    root = await make_agent("root", "operator", kind="human")
    other_h = await make_agent("zed", "operator", kind="human")
    dev = await make_agent("dev")            # inherits the container level (plan)
    fast = await make_agent("fast")          # per-agent override → pr
    db.execute("UPDATE agents SET autonomy_override='pr' WHERE id=%s", (fast["agent_id"],))

    ids = {"root": root["agent_id"], "zed": other_h["agent_id"],
           "dev": dev["agent_id"], "fast": fast["agent_id"]}

    # plans
    p1 = await make_task("plan by dev", "d", assignee_alias="dev")          # counts (plan)
    _set_status(db, p1["id"], "in_progress"); _plan_msg(db, p1["id"], ids["dev"])
    p2 = await make_task("plan by fast", "d", assignee_alias="fast")        # override pr → no
    _set_status(db, p2["id"], "in_progress"); _plan_msg(db, p2["id"], ids["fast"])
    p3 = await make_task("decided plan", "d", assignee_alias="dev")         # decided → no
    _set_status(db, p3["id"], "in_progress"); _plan_msg(db, p3["id"], ids["dev"])
    _decide_plan(db, cid, p3["id"], ids["root"])
    p4 = await make_task("no plan yet", "d", assignee_alias="dev")          # no message → no
    _set_status(db, p4["id"], "in_progress")
    p5 = await make_task("human-only note", "d", assignee_alias="dev")      # human msg → no
    _set_status(db, p5["id"], "in_progress"); _plan_msg(db, p5["id"], ids["root"])

    # verifications
    v1 = await make_task("verify me", "d", assignee_alias="dev")            # counts
    _set_status(db, v1["id"], "needs_verification")
    v2 = await make_task("zed reviews", "d", assignee_alias="dev")          # reviewer=zed
    _set_status(db, v2["id"], "needs_verification")
    db.execute("UPDATE tasks SET reviewer_agent_id=%s WHERE id=%s", (ids["zed"], v2["id"]))
    v3 = await make_task("root reviews", "d", assignee_alias="dev")         # reviewer=root
    _set_status(db, v3["id"], "needs_verification")
    db.execute("UPDATE tasks SET reviewer_agent_id=%s WHERE id=%s", (ids["root"], v3["id"]))

    # requests
    _request(db, cid, ids["dev"], None)                    # untargeted → counts
    _request(db, cid, ids["dev"], ids["root"])             # to root
    _request(db, cid, ids["dev"], ids["zed"])              # to zed
    _request(db, cid, ids["dev"], ids["fast"])             # agent-to-agent → never
    _request(db, cid, ids["fast"], ids["dev"], "escalated")  # escalated → counts
    _request(db, cid, ids["dev"], None, "answered")        # not open → never
    return ids


async def test_needs_you_matches_attention_rule_trust_off(
    client, db, container, make_agent, make_task, monkeypatch
):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    cid = container["id"]
    ids = await _seed(client, db, container, make_agent, make_task)
    # member_role is set on seeded humans? make it explicit: root owner, zed member
    db.execute("UPDATE agents SET member_role='owner' WHERE id=%s", (ids["root"],))
    db.execute("UPDATE agents SET member_role='member' WHERE id=%s", (ids["zed"],))

    # default acting human = the FIRST human (root, an owner): owners see every review
    row = _row((await client.get("/api/containers")).json(), cid)
    assert row["needs_you_breakdown"] == {"plan": 1, "verify": 3, "request": 3}
    assert row["needs_you"] == 7
    snap = await _snapshot(client, cid)
    assert row["needs_you"] == select_attention_count(snap, ids["root"])

    # acting as zed (a plain member): root's review is not zed's; zed's request is
    row = _row((await client.get(f"/api/containers?acting={cid}:{ids['zed']}")).json(), cid)
    assert row["needs_you_breakdown"] == {"plan": 1, "verify": 2, "request": 3}
    assert row["needs_you"] == select_attention_count(snap, ids["zed"])

    # a bogus / foreign pick falls back to the first human
    row = _row((await client.get(f"/api/containers?acting={cid}:{ids['dev']}")).json(), cid)
    assert row["needs_you"] == select_attention_count(snap, ids["root"])


async def test_needs_you_follows_effective_autonomy(
    client, db, container, make_agent, make_task, monkeypatch
):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    cid = container["id"]
    ids = await _seed(client, db, container, make_agent, make_task)

    # enforced container level wins over every override: fast's plan now waits too
    db.execute("UPDATE containers SET autonomy_enforced=true WHERE id=%s", (cid,))
    row = _row((await client.get("/api/containers")).json(), cid)
    assert row["needs_you_breakdown"]["plan"] == 2
    assert row["needs_you"] == select_attention_count(await _snapshot(client, cid), ids["root"])

    # level full (enforced): no plan gates, no verification gate — only requests
    db.execute("UPDATE containers SET autonomy_level='full' WHERE id=%s", (cid,))
    row = _row((await client.get("/api/containers")).json(), cid)
    assert row["needs_you_breakdown"] == {"plan": 0, "verify": 0, "request": 3}
    assert row["needs_you"] == select_attention_count(await _snapshot(client, cid), ids["root"])

    # not enforced + dev overridden to plan while the container is full: dev's plan waits
    db.execute("UPDATE containers SET autonomy_enforced=false WHERE id=%s", (cid,))
    db.execute("UPDATE agents SET autonomy_override='plan' WHERE id=%s", (ids["dev"],))
    row = _row((await client.get("/api/containers")).json(), cid)
    assert row["needs_you_breakdown"]["plan"] == 1
    assert row["needs_you"] == select_attention_count(await _snapshot(client, cid), ids["root"])


async def test_needs_you_plan_author_falls_back_to_assignee(
    client, db, container, make_agent, make_task, monkeypatch
):
    """A terminated plan author is not in the snapshot: the ASSIGNEE's autonomy decides."""
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    gone = await make_agent("gone")
    fast = await make_agent("fast")
    db.execute("UPDATE agents SET autonomy_override='pr' WHERE id=%s", (fast["agent_id"],))
    t = await make_task("handed over", "d", assignee_alias="fast")
    _set_status(db, t["id"], "in_progress")
    _plan_msg(db, t["id"], gone["agent_id"])
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (gone["agent_id"],))

    row = _row((await client.get("/api/containers")).json(), cid)
    assert row["needs_you_breakdown"]["plan"] == 0  # fast runs at pr
    db.execute("UPDATE agents SET autonomy_override=NULL WHERE id=%s", (fast["agent_id"],))
    row = _row((await client.get("/api/containers")).json(), cid)
    assert row["needs_you_breakdown"]["plan"] == 1
    snap = await _snapshot(client, cid)
    assert row["needs_you"] == select_attention_count(snap, snap["agents"][0]["id"])


async def test_needs_you_scoped_to_signed_in_user(
    client, db, container, make_agent, make_task, monkeypatch
):
    """Under proxy trust the signed-in login decides; a viewer can act on nothing."""
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    monkeypatch.setenv("ORCHA_PLAN", "team")
    cid = container["id"]
    await _bind_owner(client, container, make_agent)       # "root" → octocat (owner)
    hubot = await _invite(client, cid, "hubot")            # member
    await _invite(client, cid, "vera", role="viewer")
    octo = next(a for a in (await _snapshot(client, cid, OCTO))["agents"]
                if a.get("github_login") == "octocat")
    dev = await make_agent("dev")
    t_h = await make_task("hubot reviews", "d", assignee_alias="dev")
    _set_status(db, t_h["id"], "needs_verification")
    db.execute("UPDATE tasks SET reviewer_agent_id=%s WHERE id=%s", (hubot, t_h["id"]))
    t_o = await make_task("octo reviews", "d", assignee_alias="dev")
    _set_status(db, t_o["id"], "needs_verification")
    db.execute("UPDATE tasks SET reviewer_agent_id=%s WHERE id=%s", (octo["id"], t_o["id"]))
    _request(db, cid, dev["agent_id"], hubot)
    _request(db, cid, dev["agent_id"], octo["id"])

    snap = await _snapshot(client, cid, OCTO)
    # octocat is the owner: both reviews + their own request (not hubot's)
    row = _row((await client.get("/api/containers", headers=OCTO)).json(), cid)
    assert row["needs_you_breakdown"] == {"plan": 0, "verify": 2, "request": 1}
    assert row["needs_you"] == select_attention_count(snap, octo["id"])
    # hubot (plain member): only their own review + their own request
    row = _row((await client.get("/api/containers", headers=HUBOT)).json(), cid)
    assert row["needs_you_breakdown"] == {"plan": 0, "verify": 1, "request": 1}
    assert row["needs_you"] == select_attention_count(snap, hubot)
    # the viewer role decides nothing
    row = _row((await client.get("/api/containers", headers=VERA)).json(), cid)
    assert row["needs_you"] == 0 == select_attention_count(snap, None, read_only=True)
    # the client-supplied pick is IGNORED under trust (identity comes from the login)
    row = _row((await client.get(f"/api/containers?acting={cid}:{octo['id']}", headers=HUBOT)).json(), cid)
    assert row["needs_you_breakdown"] == {"plan": 0, "verify": 1, "request": 1}


async def test_needs_you_bootstrap_counts_for_founding_human(
    client, db, container, make_agent, make_task, monkeypatch
):
    """Unmapped bootstrap: /api/me binds the founding human, so the arrival acts as them."""
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    cid = container["id"]
    root = await make_agent("root", "operator", kind="human")
    dev = await make_agent("dev")
    _request(db, cid, dev["agent_id"], root["agent_id"])
    row = _row((await client.get("/api/containers", headers=OCTO)).json(), cid)
    assert row["needs_you"] == 1


async def test_list_row_shape_unchanged_besides_additions(client, container):
    row = (await client.get("/api/containers")).json()["containers"][0]
    assert "autonomy_level" not in row and "autonomy_enforced" not in row
    assert row["needs_you"] == 0
    assert row["needs_you_breakdown"] == {"plan": 0, "verify": 0, "request": 0}
