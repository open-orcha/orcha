"""Manager review handoff (mig 057): finished work follows the org chart.

Contract under test:
  * /done → needs_verification routes the review through the FINISHER's reporting chain:
    the nearest human manager who can act (never a viewer / retired / other project)
    becomes tasks.reviewer_agent_id, stamped review_routing.routed_via='reports_to' and
    audited as `review_routed`.
  * An AI manager between the finisher and that human gets a PRE-review request (info,
    detail.kind='manager_review', carrying DoD / result / run evidence). Its APPROVE is a
    recommendation only (task stays needs_verification for the human); SEND BACK returns
    the task to the assignee like a human rejection, labelled as the manager's feedback.
  * Human authority: a human may verify while the pre-review is pending (superseded), may
    approve work the AI sent back (overridden); an explicitly human-set reviewer is kept.
  * No reporting line → unchanged behaviour. Setting variants: owner / anyone / pre-review
    off. The setting is human-only, owner-or-assign_reviewers.
"""
import pathlib

import pytest


@pytest.fixture(autouse=True)
def _trust_off(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


def _set(db, aid, mid):
    db.execute("UPDATE agents SET reports_to_agent_id=%s WHERE id=%s", (mid, aid))


def _role(db, aid, role):
    db.execute("UPDATE agents SET member_role=%s WHERE id=%s", (role, aid))


def _task(db, tid):
    return db.execute(
        "SELECT status, reviewer_agent_id, review_routing, manager_review FROM tasks WHERE id=%s",
        (tid,),
    )[0]


async def _done(client, work_headers, tid, aid, result="shipped it"):
    r = await client.post(f"/api/tasks/{tid}/done", json={"agent_id": aid, "result": result},
                          headers=await work_headers(aid))
    assert r.status_code == 200, r.text
    return r.json()


async def _team(make_agent, db, *, ai_manager=True):
    """probe (AI) → atlas (AI manager, optional) → hussein (human owner)."""
    hussein = (await make_agent("hussein", kind="human"))["agent_id"]
    _role(db, hussein, "owner")
    probe = (await make_agent("probe"))["agent_id"]
    atlas = None
    if ai_manager:
        atlas = (await make_agent("atlas", role="lead"))["agent_id"]
        _set(db, probe, atlas)
        _set(db, atlas, hussein)
    else:
        _set(db, probe, hussein)
    return hussein, probe, atlas


def _prereview_requests(db, tid):
    return db.execute(
        "SELECT id, status, target_id, requester_id, payload, detail, response FROM requests "
        "WHERE detail->>'kind'='manager_review' AND detail->>'task_id'=%s ORDER BY created_at",
        (tid,),
    )


# ---- migration --------------------------------------------------------------------------


async def test_migration_columns_and_defaults(db, container):
    cols = {r["column_name"]: r for r in db.execute(
        """SELECT table_name||'.'||column_name AS column_name, column_default, is_nullable
             FROM information_schema.columns
            WHERE (table_name='containers' AND column_name IN ('review_route','ai_manager_prereview'))
               OR (table_name='tasks' AND column_name IN ('review_routing','manager_review'))""")}
    assert set(cols) == {"containers.review_route", "containers.ai_manager_prereview",
                         "tasks.review_routing", "tasks.manager_review"}
    c = db.execute("SELECT review_route, ai_manager_prereview FROM containers WHERE id=%s",
                   (container["id"],))[0]
    assert c["review_route"] == "manager_chain" and c["ai_manager_prereview"] is True
    sql = (pathlib.Path(__file__).resolve().parents[1] / "orcha-cli" / "orcha_cli" / "templates"
           / "migrations" / "057_manager_review_handoff.sql").read_text()
    db.execute(sql)  # additive + idempotent


# ---- AI → human manager -----------------------------------------------------------------


async def test_ai_to_human_manager_becomes_reviewer(client, container, make_agent, make_task,
                                                    db, work_headers):
    hussein, probe, _ = await _team(make_agent, db, ai_manager=False)
    t = await make_task("work", "tests pass", assignee_alias="probe")
    out = await _done(client, work_headers, t["task_id"], probe)
    assert out["status"] == "needs_verification"
    assert out["review"]["review_routed_via"] == "reports_to"
    row = _task(db, t["task_id"])
    assert str(row["reviewer_agent_id"]) == hussein
    assert row["review_routing"]["routed_via"] == "reports_to"
    assert row["review_routing"]["reviewer_alias"] == "hussein"
    assert row["review_routing"]["assignee_alias"] == "probe"
    assert row["manager_review"] is None
    assert not _prereview_requests(db, t["task_id"])
    ev = db.execute("SELECT detail FROM events WHERE event_type='review_routed' AND entity_id=%s",
                    (t["task_id"],))
    assert ev and ev[0]["detail"]["review_routed_via"] == "reports_to"
    # the snapshot/task list carries the route for the portal
    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    st = next(x for x in snap["tasks"] if str(x["id"]) == t["task_id"])
    assert st["review_routing"]["routed_via"] == "reports_to"
    assert st["reviewer"]["alias"] == "hussein"


# ---- AI → AI manager → human ------------------------------------------------------------


async def test_ai_manager_prereview_approve_then_human_verifies(
    client, container, make_agent, make_task, db, work_headers
):
    hussein, probe, atlas = await _team(make_agent, db)
    t = await make_task("login page", "form validates email", assignee_alias="probe")
    out = await _done(client, work_headers, t["task_id"], probe, result="added validation")
    assert out["review"]["pre_review_by"] == "atlas"
    row = _task(db, t["task_id"])
    assert str(row["reviewer_agent_id"]) == hussein  # the human, not the AI manager
    assert row["review_routing"]["pre_review_by"] == "atlas"
    assert row["manager_review"]["status"] == "pending"
    assert row["manager_review"]["manager_alias"] == "atlas"
    reqs = _prereview_requests(db, t["task_id"])
    assert len(reqs) == 1
    rq = reqs[0]
    assert str(rq["target_id"]) == atlas and str(rq["requester_id"]) == probe
    assert rq["status"] == "open"
    assert "form validates email" in rq["payload"] and "added validation" in rq["payload"]
    assert "APPROVE" in rq["payload"] and "SEND BACK" in rq["payload"]
    assert rq["detail"]["definition_of_done"] == "form validates email"
    # the AI manager is woken like for any other request
    wake = db.execute(
        "SELECT payload FROM agent_events WHERE target_id=%s AND event_name='request_created'",
        (atlas,),
    )
    assert any(w["payload"].get("kind") == "manager_review" for w in wake)

    # Atlas answers through the ordinary respond path
    r = await client.post(f"/api/requests/{rq['id']}/respond",
                          json={"responder_agent_id": atlas,
                                "response": "APPROVE: validation covers the DoD"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "closed"
    row = _task(db, t["task_id"])
    assert row["status"] == "needs_verification"  # an AI approval never verifies
    assert row["manager_review"]["status"] == "approved"
    assert row["manager_review"]["recommendation"] == "approve"
    assert row["manager_review"]["reasons"] == "validation covers the DoD"
    assert _prereview_requests(db, t["task_id"])[0]["status"] == "closed"
    msgs = db.execute("SELECT body FROM task_messages WHERE task_id=%s", (t["task_id"],))
    assert any("atlas recommends approval" in m["body"] for m in msgs)
    # the finisher is NOT woken by the approval
    assert not db.execute(
        "SELECT 1 FROM agent_events WHERE target_id=%s AND event_name='request_answered'", (probe,))

    # the AI can never verify; the human does
    v = await client.post(f"/api/tasks/{t['task_id']}/verify",
                          json={"approve": True, "actor_agent_id": atlas})
    assert v.status_code == 403
    v = await client.post(f"/api/tasks/{t['task_id']}/verify",
                          json={"approve": True, "actor_agent_id": hussein})
    assert v.status_code == 200, v.text
    assert _task(db, t["task_id"])["status"] == "completed"


async def test_ai_manager_send_back_returns_work_and_human_can_override(
    client, container, make_agent, make_task, db, work_headers
):
    hussein, probe, atlas = await _team(make_agent, db)
    t = await make_task("api", "returns 404 for unknown ids", assignee_alias="probe")
    await _done(client, work_headers, t["task_id"], probe)
    # structured endpoint: only the manager asked may record it
    bad = await client.post(f"/api/tasks/{t['task_id']}/manager-review",
                            json={"agent_id": probe, "decision": "approve"})
    assert bad.status_code == 403
    r = await client.post(f"/api/tasks/{t['task_id']}/manager-review",
                          json={"agent_id": atlas, "decision": "send_back",
                                "reasons": "no test for the 404 path"})
    assert r.status_code == 200, r.text
    row = _task(db, t["task_id"])
    assert row["status"] == "in_progress"
    assert row["manager_review"]["status"] == "sent_back"
    at = db.execute("SELECT assignment_status FROM agent_tasks WHERE task_id=%s", (t["task_id"],))
    assert [a["assignment_status"] for a in at] == ["working"]
    ev = db.execute(
        "SELECT payload FROM agent_events WHERE target_id=%s AND event_name='task_verified'",
        (probe,),
    )
    assert ev and ev[-1]["payload"]["approved"] is False
    assert ev[-1]["payload"]["by_manager_alias"] == "atlas"
    assert "no test for the 404 path" in ev[-1]["payload"]["feedback"]
    msgs = db.execute("SELECT body FROM task_messages WHERE task_id=%s", (t["task_id"],))
    assert any(m["body"].startswith("[manager feedback] atlas") for m in msgs)
    assert _prereview_requests(db, t["task_id"])[0]["status"] == "closed"
    # a second verdict is a 409 (nothing pending)
    again = await client.post(f"/api/tasks/{t['task_id']}/manager-review",
                              json={"agent_id": atlas, "decision": "approve"})
    assert again.status_code == 409

    # human override: accept the work as delivered despite the send-back
    v = await client.post(f"/api/tasks/{t['task_id']}/verify",
                          json={"approve": True, "actor_agent_id": hussein})
    assert v.status_code == 200, v.text
    row = _task(db, t["task_id"])
    assert row["status"] == "completed" and row["manager_review"]["status"] == "overridden"
    assert db.execute("SELECT 1 FROM events WHERE event_type='manager_review_overridden' "
                      "AND entity_id=%s", (t["task_id"],))


async def test_send_back_via_respond_then_resubmit_reroutes(
    client, make_agent, make_task, db, work_headers
):
    hussein, probe, atlas = await _team(make_agent, db)
    t = await make_task("docs", "readme updated", assignee_alias="probe")
    await _done(client, work_headers, t["task_id"], probe)
    rq = _prereview_requests(db, t["task_id"])[0]
    r = await client.post(f"/api/requests/{rq['id']}/respond",
                          json={"responder_agent_id": atlas, "response": "SEND BACK: typo in step 2"})
    assert r.status_code == 200 and r.json()["task_status"] == "in_progress"
    # the assignee reworks and finishes again → a NEW pre-review round
    await _done(client, work_headers, t["task_id"], probe, result="fixed typo")
    reqs = _prereview_requests(db, t["task_id"])
    assert len(reqs) == 2 and reqs[1]["status"] == "open"
    row = _task(db, t["task_id"])
    assert row["manager_review"]["status"] == "pending"
    assert str(row["manager_review"]["request_id"]) == str(reqs[1]["id"])


async def test_unparseable_answer_is_a_comment_handed_to_human(
    client, make_agent, make_task, db, work_headers
):
    hussein, probe, atlas = await _team(make_agent, db)
    t = await make_task("x", "y", assignee_alias="probe")
    await _done(client, work_headers, t["task_id"], probe)
    rq = _prereview_requests(db, t["task_id"])[0]
    r = await client.post(f"/api/requests/{rq['id']}/respond",
                          json={"responder_agent_id": atlas, "response": "Looks mostly fine?"})
    assert r.status_code == 200
    row = _task(db, t["task_id"])
    assert row["status"] == "needs_verification"
    assert row["manager_review"]["status"] == "commented"
    assert row["manager_review"]["recommendation"] is None


async def test_human_verifies_while_prereview_pending_supersedes(
    client, make_agent, make_task, db, work_headers
):
    hussein, probe, atlas = await _team(make_agent, db)
    t = await make_task("x", "y", assignee_alias="probe")
    await _done(client, work_headers, t["task_id"], probe)
    v = await client.post(f"/api/tasks/{t['task_id']}/verify",
                          json={"approve": True, "actor_agent_id": hussein})
    assert v.status_code == 200, v.text
    row = _task(db, t["task_id"])
    assert row["status"] == "completed" and row["manager_review"]["status"] == "superseded"
    assert _prereview_requests(db, t["task_id"])[0]["status"] == "closed"
    # the manager's late answer no longer acts on the task
    rq = _prereview_requests(db, t["task_id"])[0]
    late = await client.post(f"/api/requests/{rq['id']}/respond",
                             json={"responder_agent_id": atlas, "response": "SEND BACK: no"})
    assert late.status_code == 409
    assert _task(db, t["task_id"])["status"] == "completed"


# ---- chain edge cases -------------------------------------------------------------------


async def test_viewer_manager_is_skipped(client, make_agent, make_task, db, work_headers):
    owner = (await make_agent("owner", kind="human"))["agent_id"]
    _role(db, owner, "owner")
    vera = (await make_agent("vera", kind="human"))["agent_id"]
    _role(db, vera, "viewer")
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, dev, vera)
    _set(db, vera, owner)
    t = await make_task("x", "y", assignee_alias="dev")
    await _done(client, work_headers, t["task_id"], dev)
    row = _task(db, t["task_id"])
    assert str(row["reviewer_agent_id"]) == owner
    assert row["review_routing"]["manager_depth"] == 2
    assert {"alias": "vera", "why": "viewer"} in row["review_routing"]["reports_to_skipped"]


async def test_chain_with_nobody_who_can_act_falls_back_to_anyone(
    client, make_agent, make_task, db, work_headers
):
    await make_agent("owner", kind="human")
    vera = (await make_agent("vera", kind="human"))["agent_id"]
    _role(db, vera, "viewer")
    dev = (await make_agent("dev"))["agent_id"]
    _set(db, dev, vera)
    t = await make_task("x", "y", assignee_alias="dev")
    await _done(client, work_headers, t["task_id"], dev)
    row = _task(db, t["task_id"])
    assert row["reviewer_agent_id"] is None
    assert row["review_routing"]["routed_via"] == "fallback"


async def test_no_chain_keeps_todays_behaviour(client, make_agent, make_task, db, work_headers):
    await make_agent("owner", kind="human")
    dev = (await make_agent("dev"))["agent_id"]
    t = await make_task("x", "y", assignee_alias="dev")
    out = await _done(client, work_headers, t["task_id"], dev)
    assert out["review"]["review_routed_via"] is None
    row = _task(db, t["task_id"])
    assert row["reviewer_agent_id"] is None and row["review_routing"] is None
    assert row["manager_review"] is None
    assert not db.execute("SELECT 1 FROM events WHERE event_type='review_routed' AND entity_id=%s",
                          (t["task_id"],))


async def test_explicit_human_set_reviewer_is_respected(
    client, make_agent, make_task, db, work_headers
):
    hussein, probe, atlas = await _team(make_agent, db, ai_manager=False)
    maya = (await make_agent("maya", kind="human"))["agent_id"]
    t = await make_task("x", "y", assignee_alias="probe")
    r = await client.put(f"/api/tasks/{t['task_id']}/reviewer",
                         json={"reviewer_agent_id": maya, "actor_agent_id": hussein})
    assert r.status_code == 200, r.text
    await _done(client, work_headers, t["task_id"], probe)
    row = _task(db, t["task_id"])
    assert str(row["reviewer_agent_id"]) == maya
    assert row["review_routing"]["routed_via"] == "manual"


async def test_explicit_anyone_is_respected(client, make_agent, make_task, db, work_headers):
    hussein, probe, _ = await _team(make_agent, db, ai_manager=False)
    t = await make_task("x", "y", assignee_alias="probe")
    r = await client.put(f"/api/tasks/{t['task_id']}/reviewer",
                         json={"reviewer_agent_id": None, "actor_agent_id": hussein})
    assert r.status_code == 200
    await _done(client, work_headers, t["task_id"], probe)
    assert _task(db, t["task_id"])["reviewer_agent_id"] is None


# ---- setting variants -------------------------------------------------------------------


async def _put_setting(client, cid, actor, **kw):
    return await client.put(f"/api/containers/{cid}/review-routing",
                            json={"actor_agent_id": actor, **kw})


async def test_setting_read_write_and_gating(client, container, make_agent, db):
    cid = container["id"]
    owner = (await make_agent("owner", kind="human"))["agent_id"]
    _role(db, owner, "owner")
    member = (await make_agent("mem", kind="human"))["agent_id"]
    viewer = (await make_agent("vee", kind="human"))["agent_id"]
    _role(db, viewer, "viewer")
    ai = (await make_agent("bot"))["agent_id"]
    g = (await client.get(f"/api/containers/{cid}/review-routing")).json()
    assert g["review_route"] == "manager_chain" and g["ai_manager_prereview"] is True
    assert (await _put_setting(client, cid, ai, review_route="anyone")).status_code == 403
    assert (await _put_setting(client, cid, owner, review_route="bogus")).status_code == 422
    r = await _put_setting(client, cid, owner, review_route="owner", ai_manager_prereview=False)
    assert r.status_code == 200, r.text
    assert r.json()["review_route"] == "owner" and r.json()["ai_manager_prereview"] is False
    ev = db.execute("SELECT actor_id, detail FROM events WHERE event_type='review_routing_changed'")
    assert ev and str(ev[-1]["actor_id"]) == owner
    assert ev[-1]["detail"]["previous"]["review_route"] == "manager_chain"
    # partial update keeps the other field
    r = await _put_setting(client, cid, owner, ai_manager_prereview=True)
    assert r.json()["review_route"] == "owner" and r.json()["ai_manager_prereview"] is True
    assert member and viewer  # trust-on gating is covered by enforce_grant's shared tests


async def test_setting_trusted_lane_gating(client, container, make_agent, db, monkeypatch):
    cid = container["id"]
    owner = (await make_agent("octo", kind="human"))["agent_id"]
    _role(db, owner, "owner")
    db.execute("UPDATE agents SET github_login='octocat' WHERE id=%s", (owner,))
    vera = (await make_agent("vera", kind="human"))["agent_id"]
    _role(db, vera, "viewer")
    db.execute("UPDATE agents SET github_login='vera' WHERE id=%s", (vera,))
    mem = (await make_agent("hubot", kind="human"))["agent_id"]
    db.execute("UPDATE agents SET github_login='hubot' WHERE id=%s", (mem,))
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    body = {"review_route": "anyone"}
    assert (await client.put(f"/api/containers/{cid}/review-routing", json=body,
                             headers={"X-Auth-Request-User": "vera"})).status_code == 403
    assert (await client.put(f"/api/containers/{cid}/review-routing", json=body,
                             headers={"X-Auth-Request-User": "hubot"})).status_code == 403
    db.execute("UPDATE agents SET grants='[\"assign_reviewers\"]'::jsonb WHERE id=%s", (mem,))
    assert (await client.put(f"/api/containers/{cid}/review-routing", json=body,
                             headers={"X-Auth-Request-User": "hubot"})).status_code == 200
    assert (await client.put(f"/api/containers/{cid}/review-routing", json=body,
                             headers={"X-Auth-Request-User": "octocat"})).status_code == 200
    # the viewer can still read it
    assert (await client.get(f"/api/containers/{cid}/review-routing",
                             headers={"X-Auth-Request-User": "vera"})).status_code == 200


async def test_setting_owner_routes_to_project_owner(
    client, container, make_agent, make_task, db, work_headers
):
    hussein, probe, atlas = await _team(make_agent, db)
    boss = (await make_agent("boss", kind="human"))["agent_id"]
    _set(db, atlas, boss)  # the chain's human is boss, but the setting says owner
    await _put_setting(client, container["id"], hussein, review_route="owner")
    t = await make_task("x", "y", assignee_alias="probe")
    await _done(client, work_headers, t["task_id"], probe)
    row = _task(db, t["task_id"])
    assert str(row["reviewer_agent_id"]) == hussein
    assert row["review_routing"]["routed_via"] == "owner"
    assert row["manager_review"] is None  # pre-review is a manager-chain feature
    assert not _prereview_requests(db, t["task_id"])


async def test_setting_anyone_assigns_nobody(client, container, make_agent, make_task, db,
                                             work_headers):
    hussein, probe, atlas = await _team(make_agent, db)
    await _put_setting(client, container["id"], hussein, review_route="anyone")
    t = await make_task("x", "y", assignee_alias="probe")
    await _done(client, work_headers, t["task_id"], probe)
    row = _task(db, t["task_id"])
    assert row["reviewer_agent_id"] is None and row["manager_review"] is None
    assert not _prereview_requests(db, t["task_id"])


async def test_prereview_off_routes_straight_to_human(
    client, container, make_agent, make_task, db, work_headers
):
    hussein, probe, atlas = await _team(make_agent, db)
    await _put_setting(client, container["id"], hussein, ai_manager_prereview=False)
    t = await make_task("x", "y", assignee_alias="probe")
    await _done(client, work_headers, t["task_id"], probe)
    row = _task(db, t["task_id"])
    assert str(row["reviewer_agent_id"]) == hussein  # AI manager skipped, human found above
    assert row["manager_review"] is None
    assert not _prereview_requests(db, t["task_id"])


async def test_full_autonomy_bypasses_routing(client, container, make_agent, make_task, db,
                                              work_headers):
    hussein, probe, atlas = await _team(make_agent, db)
    db.execute("UPDATE containers SET autonomy_level='full' WHERE id=%s", (container["id"],))
    t = await make_task("x", "y", assignee_alias="probe")
    out = await _done(client, work_headers, t["task_id"], probe)
    assert out["status"] == "completed"
    assert not _prereview_requests(db, t["task_id"])


async def test_expiry_sweep_never_escalates_a_prereview(
    client, container, make_agent, make_task, db, work_headers
):
    hussein, probe, atlas = await _team(make_agent, db)
    t = await make_task("x", "y", assignee_alias="probe")
    await _done(client, work_headers, t["task_id"], probe)
    rq = _prereview_requests(db, t["task_id"])[0]
    db.execute("UPDATE requests SET expires_at=now() - interval '1 minute' WHERE id=%s", (rq["id"],))
    s = await client.post(f"/api/containers/{container['id']}/sweep?actor_agent_id={hussein}")
    assert s.status_code == 200, s.text
    assert str(rq["id"]) not in s.json()["request_ids"]
    assert str(_prereview_requests(db, t["task_id"])[0]["target_id"]) == atlas


async def test_cancel_closes_pending_prereview(client, make_agent, make_task, db, work_headers):
    hussein, probe, atlas = await _team(make_agent, db)
    t = await make_task("x", "y", assignee_alias="probe")
    await _done(client, work_headers, t["task_id"], probe)
    c = await client.post(f"/api/tasks/{t['task_id']}/cancel",
                          json={"actor_agent_id": hussein, "reason": "no longer needed"})
    assert c.status_code == 200, c.text
    assert _prereview_requests(db, t["task_id"])[0]["status"] == "closed"
    assert _task(db, t["task_id"])["manager_review"]["status"] == "superseded"


async def test_review_routing_lists_pending_reviews_per_human(
    client, container, make_agent, make_task, db, work_headers
):
    hussein, probe, _ = await _team(make_agent, db, ai_manager=False)
    for i in range(2):
        t = await make_task(f"t{i}", "y", assignee_alias="probe")
        await _done(client, work_headers, t["task_id"], probe)
    g = (await client.get(f"/api/containers/{container['id']}/review-routing")).json()
    assert g["reporting_lines"] == 1
    assert g["reviewers"] == [{"agent_id": hussein, "alias": "hussein", "pending_reviews": 2}]
