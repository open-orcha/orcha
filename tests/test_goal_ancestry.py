"""Goal ancestry — every task can say WHY it exists: project objective -> parent(s) -> task.

Covers:
- GET /api/tasks/{tid}/goal-chain: node order, truthful objective (null text when none is set,
  never the project name dressed up as an objective), explicit parent links, parents DERIVED
  from an accepted task request's originating_task_id, explicit-over-derived precedence, the
  root task (objective only), depth truncation, viewer read access.
- PUT /api/tasks/{tid}/parent: set / clear / no-op, audit event, and every refusal (root,
  self, cross-project, cycle, invalid ids, viewer, non-participating agent, retired actor).
- The wake context: GET /api/agents/{aid}/protocol carries goal_chain; the notifier renders it
  as ONE "Why this task exists" line inside the "Your task" section; it never breaks a wake.

Migration 062_goal_ancestry.sql (applied by conftest) adds tasks.parent_task_id.
"""

import pytest


def _kinds(chain):
    return [n["kind"] for n in chain]


def _titles(chain):
    return [n["title"] for n in chain]


async def _human(make_agent, alias="hu"):
    return await make_agent(alias, "operator", kind="human")


async def _chain(client, tid):
    r = await client.get(f"/api/tasks/{tid}/goal-chain")
    assert r.status_code == 200, r.text
    return r.json()


async def _set_parent(client, tid, parent, actor, **kw):
    return await client.put(f"/api/tasks/{tid}/parent",
                            json={"parent_task_id": parent, "actor_agent_id": actor}, **kw)


# ============================ GET goal-chain ============================


async def test_plain_task_chain_is_objective_then_task(client, container, make_task, db):
    db.execute("UPDATE containers SET description=%s WHERE id=%s",
               ("Ship a calm Linear-grade portal", container["id"]))
    t = await make_task("Build the breadcrumb", "renders")
    body = await _chain(client, t["id"])
    chain = body["goal_chain"]
    assert _kinds(chain) == ["objective", "task"]
    obj = chain[0]
    assert obj["text"] == "Ship a calm Linear-grade portal"
    assert obj["source"] == "project_description"
    assert obj["title"] == "test-arena"
    assert obj["id"] == container["root_task_id"]
    assert chain[1] == {"kind": "task", "id": t["id"], "title": "Build the breadcrumb",
                        "status": "ready", "text": None, "source": None,
                        "container_id": None, "via": None, "request_id": None}
    assert body["truncated"] is False and body["cycle"] is False


async def test_objective_text_is_null_when_none_set(client, container, make_task):
    """Truthful: the init path defaults the root description to the project NAME — that is not
    an objective, so the node carries text=null (the UI says "No objective set")."""
    t = await make_task("T", "d")
    obj = (await _chain(client, t["id"]))["goal_chain"][0]
    assert obj["kind"] == "objective"
    assert obj["text"] is None and obj["source"] is None
    assert obj["title"] == "test-arena"


async def test_objective_falls_back_to_a_real_root_description(client, container, make_task, db):
    db.execute("UPDATE tasks SET description=%s WHERE id=%s",
               ("Reach 1k weekly users", container["root_task_id"]))
    t = await make_task("T", "d")
    obj = (await _chain(client, t["id"]))["goal_chain"][0]
    assert obj["text"] == "Reach 1k weekly users" and obj["source"] == "root_task"


async def test_root_task_chain_is_objective_only(client, container):
    body = await _chain(client, container["root_task_id"])
    assert _kinds(body["goal_chain"]) == ["objective"]


async def test_explicit_parents_render_top_down(client, container, make_agent, make_task, db):
    h = await _human(make_agent)
    epic = await make_task("Epic: onboarding", "d")
    story = await make_task("Story: invite flow", "d")
    leaf = await make_task("Leaf: email template", "d")
    assert (await _set_parent(client, story["id"], epic["id"], h["agent_id"])).status_code == 200
    r = await _set_parent(client, leaf["id"], story["id"], h["agent_id"])
    assert r.status_code == 200, r.text
    assert r.json()["parent_task_id"] == story["id"]
    chain = r.json()["goal_chain"]
    assert _kinds(chain) == ["objective", "parent", "parent", "task"]
    assert _titles(chain)[1:] == ["Epic: onboarding", "Story: invite flow", "Leaf: email template"]
    assert all(n["via"] == "parent_link" for n in chain if n["kind"] == "parent")
    assert chain[1]["status"] == "ready"
    # the same chain on the read endpoint
    assert (await _chain(client, leaf["id"]))["goal_chain"] == chain
    # audited
    ev = db.execute("SELECT event_type, detail FROM events WHERE entity_id=%s "
                    "AND event_type='parent_set'", (leaf["id"],))
    assert len(ev) == 1 and ev[0]["detail"]["after"] == story["id"]
    assert ev[0]["detail"]["before"] is None


async def test_parent_derived_from_accepted_task_request(
        client, container, make_agent, make_task, make_request, work_headers):
    """A task spawned by accepting a task request raised FROM task P has P as its parent —
    stored fact (requests.originating_task_id + spawned_task_id), not a guess."""
    lead = await make_agent("Lead", "lead")
    eng = await make_agent("Eng", "eng")
    parent = await make_task("Parent: payments v2", "d", assignee_alias="Lead")
    req = await make_request(lead["agent_id"], "please build the webhook", target_alias="Eng",
                             type="task", originating_task_id=parent["id"],
                             task={"title": "Child: webhook", "definition_of_done": "d",
                                   "priority": 100})
    eng_id = eng["agent_id"]
    acc = await client.post(f"/api/requests/{req['id']}/accept-task",
                            json={"responder_agent_id": eng_id, "note": "on it"},
                            headers=await work_headers(eng_id))
    assert acc.status_code == 200, acc.text
    child = acc.json()["spawned_task_id"]
    chain = (await _chain(client, child))["goal_chain"]
    assert _kinds(chain) == ["objective", "parent", "task"]
    p = chain[1]
    assert p["id"] == parent["id"] and p["via"] == "task_request"
    assert p["request_id"] == req["id"]
    assert p["title"] == "Parent: payments v2" and p["status"] == "in_progress"


async def test_explicit_parent_wins_over_derived(
        client, container, make_agent, make_task, make_request, work_headers, db):
    h = await _human(make_agent)
    lead = await make_agent("Lead", "lead")
    eng = await make_agent("Eng", "eng")
    parent = await make_task("derived parent", "d", assignee_alias="Lead")
    other = await make_task("explicit parent", "d")
    req = await make_request(lead["agent_id"], "x", target_alias="Eng", type="task",
                             originating_task_id=parent["id"],
                             task={"title": "child", "definition_of_done": "d", "priority": 100})
    acc = await client.post(f"/api/requests/{req['id']}/accept-task",
                            json={"responder_agent_id": eng["agent_id"]},
                            headers=await work_headers(eng["agent_id"]))
    child = acc.json()["spawned_task_id"]
    r = await _set_parent(client, child, other["id"], h["agent_id"])
    assert r.status_code == 200, r.text
    parents = [n for n in r.json()["goal_chain"] if n["kind"] == "parent"]
    assert [(n["title"], n["via"]) for n in parents] == [("explicit parent", "parent_link")]
    # clearing the explicit link falls back to the stored derived parent (still truthful)
    r = await _set_parent(client, child, None, h["agent_id"])
    parents = [n for n in r.json()["goal_chain"] if n["kind"] == "parent"]
    assert [(n["title"], n["via"]) for n in parents] == [("derived parent", "task_request")]
    assert db.execute("SELECT 1 FROM events WHERE entity_id=%s AND event_type='parent_cleared'",
                      (child,))


async def test_depth_is_capped_and_marked_truncated(client, container, make_task, db):
    from portal_backend import goal_ancestry
    ids = [(await make_task(f"t{i}", "d"))["id"] for i in range(goal_ancestry.MAX_DEPTH + 3)]
    for child, parent in zip(ids[1:], ids[:-1]):
        db.execute("UPDATE tasks SET parent_task_id=%s WHERE id=%s", (parent, child))
    body = await _chain(client, ids[-1])
    parents = [n for n in body["goal_chain"] if n["kind"] == "parent"]
    assert len(parents) == goal_ancestry.MAX_DEPTH
    assert body["truncated"] is True
    # nearest parent is last before the task
    assert body["goal_chain"][-2]["id"] == ids[-2]


async def test_preexisting_cycle_stops_the_walk(client, container, make_task, db):
    """Defence in depth: rows edited outside the API can't hang or lie — the walk stops."""
    a = await make_task("A", "d")
    b = await make_task("B", "d")
    db.execute("UPDATE tasks SET parent_task_id=%s WHERE id=%s", (b["id"], a["id"]))
    db.execute("UPDATE tasks SET parent_task_id=%s WHERE id=%s", (a["id"], b["id"]))
    body = await _chain(client, a["id"])
    assert body["cycle"] is True
    assert _titles(body["goal_chain"]) == ["test-arena", "B", "A"]


async def test_goal_chain_404_and_400(client, container):
    assert (await client.get("/api/tasks/not-a-uuid/goal-chain")).status_code == 400
    r = await client.get("/api/tasks/00000000-0000-0000-0000-000000000000/goal-chain")
    assert r.status_code == 404


# ============================ PUT parent — refusals ============================


async def test_parent_refusals(client, container, make_agent, make_task):
    h = await _human(make_agent)
    a = await make_task("A", "d")
    b = await make_task("B", "d")
    c = await make_task("C", "d")
    aid = h["agent_id"]
    # root is the objective, never a parent; and the root itself has no parent
    r = await _set_parent(client, a["id"], container["root_task_id"], aid)
    assert r.status_code == 400 and "objective" in r.text
    r = await _set_parent(client, container["root_task_id"], a["id"], aid)
    assert r.status_code == 400
    # self
    assert (await _set_parent(client, a["id"], a["id"], aid)).status_code == 409
    # cycle: A <- B <- C, then A under C would loop
    assert (await _set_parent(client, b["id"], a["id"], aid)).status_code == 200
    assert (await _set_parent(client, c["id"], b["id"], aid)).status_code == 200
    r = await _set_parent(client, a["id"], c["id"], aid)
    assert r.status_code == 409 and "cycle" in r.text
    # bad ids
    assert (await _set_parent(client, a["id"], "nope", aid)).status_code == 400
    assert (await _set_parent(client, "nope", a["id"], aid)).status_code == 400
    r = await _set_parent(client, a["id"], "00000000-0000-0000-0000-000000000000", aid)
    assert r.status_code == 404
    # no actor at all
    assert (await _set_parent(client, a["id"], None, None)).status_code == 400
    # unknown field is refused (extra=forbid)
    r = await client.put(f"/api/tasks/{a['id']}/parent",
                         json={"parent_task_id": None, "actor_agent_id": aid, "x": 1})
    assert r.status_code == 422


async def test_cross_project_parent_refused(client, container, make_agent, make_task):
    h = await _human(make_agent)
    r = await client.post("/api/containers", json={"name": "other-proj", "additional": True})
    assert r.status_code == 201, r.text
    other_cid = r.json()["container_id"]
    foreign = await make_task("foreign", "d", container_id=other_cid)
    mine = await make_task("mine", "d")
    r = await _set_parent(client, mine["id"], foreign["id"], h["agent_id"])
    assert r.status_code == 400 and "not in this project" in r.text


async def test_agent_may_link_only_tasks_it_participates_in(
        client, container, make_agent, make_task):
    eng = await make_agent("Eng", "eng")
    await make_agent("Other", "eng")
    epic = await make_task("Epic", "d")
    mine = await make_task("mine", "d", assignee_alias="Eng")
    theirs = await make_task("theirs", "d", assignee_alias="Other")
    r = await _set_parent(client, mine["id"], epic["id"], eng["agent_id"])
    assert r.status_code == 200, r.text
    r = await _set_parent(client, theirs["id"], epic["id"], eng["agent_id"])
    assert r.status_code == 403


async def test_retired_or_foreign_actor_refused(client, container, make_agent, make_task, db):
    eng = await make_agent("Eng", "eng")
    t = await make_task("mine", "d", assignee_alias="Eng")
    p = await make_task("p", "d")
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (eng["agent_id"],))
    assert (await _set_parent(client, t["id"], p["id"], eng["agent_id"])).status_code == 403
    r = await _set_parent(client, t["id"], p["id"], "00000000-0000-0000-0000-000000000000")
    assert r.status_code == 403


async def test_viewer_reads_chain_but_cannot_set_parent(
        client, container, make_agent, make_task, db, monkeypatch):
    owner = await _human(make_agent, "own")
    viewer = await _human(make_agent, "vee")
    db.execute("UPDATE agents SET github_login='own-gh', member_role='owner' WHERE id=%s",
               (owner["agent_id"],))
    db.execute("UPDATE agents SET github_login='vee-gh', member_role='viewer' WHERE id=%s",
               (viewer["agent_id"],))
    a = await make_task("A", "d")
    b = await make_task("B", "d")
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    hv = {"X-Auth-Request-User": "vee-gh"}
    r = await client.get(f"/api/tasks/{a['id']}/goal-chain", headers=hv)
    assert r.status_code == 200
    r = await _set_parent(client, a["id"], b["id"], None, headers=hv)
    assert r.status_code == 403
    # the owner's proxy identity IS the actor (body actor ignored)
    r = await _set_parent(client, a["id"], b["id"], viewer["agent_id"],
                          headers={"X-Auth-Request-User": "own-gh"})
    assert r.status_code == 200, r.text
    # a trusted non-member can't even read
    r = await client.get(f"/api/tasks/{a['id']}/goal-chain",
                         headers={"X-Auth-Request-User": "stranger"})
    assert r.status_code == 403


async def test_setting_same_parent_is_a_quiet_noop(client, container, make_agent, make_task, db):
    h = await _human(make_agent)
    a = await make_task("A", "d")
    b = await make_task("B", "d")
    await _set_parent(client, a["id"], b["id"], h["agent_id"])
    r = await _set_parent(client, a["id"], b["id"], h["agent_id"])
    assert r.status_code == 200
    ev = db.execute("SELECT 1 FROM events WHERE entity_id=%s AND event_type='parent_set'",
                    (a["id"],))
    assert len(ev) == 1


async def test_parent_change_publishes_container_event(
        client, container, make_agent, make_task, db):
    h = await _human(make_agent)
    a = await make_task("A", "d")
    b = await make_task("B", "d")
    await _set_parent(client, a["id"], b["id"], h["agent_id"])
    rows = db.event_rows(f"c:{container['id']}")
    ev = [r for r in rows if r["event_name"] == "task_parent_changed"]
    assert len(ev) == 1 and ev[0]["payload"]["parent_task_id"] == b["id"]


async def test_openapi_documents_the_goal_chain_contract(client):
    spec = (await client.get("/openapi.json")).json()
    assert "/api/tasks/{tid}/goal-chain" in spec["paths"]
    assert "put" in spec["paths"]["/api/tasks/{tid}/parent"]
    assert "goal_chain" in spec["components"]["schemas"]["GoalChainResponse"]["properties"]


# ============================ wake context ============================


async def test_protocol_carries_goal_chain(client, container, make_agent, make_task, db):
    db.execute("UPDATE containers SET description=%s WHERE id=%s",
               ("Grow retention", container["id"]))
    h = await _human(make_agent)
    eng = await make_agent("Eng", "eng")
    epic = await make_task("Epic: retention", "d")
    t = await make_task("Add streaks", "streaks shown", assignee_alias="Eng",
                        description="daily streak counter")
    await _set_parent(client, t["id"], epic["id"], h["agent_id"])
    r = await client.get(f"/api/agents/{eng['agent_id']}/protocol")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["task_id"] == t["id"]
    assert _titles(body["goal_chain"]) == ["test-arena", "Epic: retention", "Add streaks"]

    import orcha_cli.notifier as notifier
    out = notifier.format_persona({"system_prompt": "You are Eng."}, None, body)
    assert "Your task" in out
    why = [ln for ln in out.splitlines() if ln.startswith("- Why this task exists")]
    assert len(why) == 1
    line = why[0]
    assert 'Project objective "Grow retention" (test-arena)' in line
    assert f'Parent task "Epic: retention" [ready] (id {epic["id"]})' in line
    assert line.endswith('This task "Add streaks"')
    assert line.index("Grow retention") < line.index("Epic: retention") < line.index("Add streaks")


async def test_protocol_omits_uninformative_chain(client, container, make_agent, make_task):
    """No objective text and no parent -> nothing to say; the field is absent (not faked)."""
    eng = await make_agent("Eng", "eng")
    await make_task("solo", "d", assignee_alias="Eng", description="x")
    body = (await client.get(f"/api/agents/{eng['agent_id']}/protocol")).json()
    assert body["task_id"] and "goal_chain" not in body


async def test_goal_chain_failure_never_breaks_the_protocol(
        client, container, make_agent, make_task, monkeypatch):
    from portal_backend import goal_ancestry

    def boom(cur, tid):
        cur.execute("SELECT no_such_column FROM tasks")  # poisons the tx like a real SQL error

    monkeypatch.setattr(goal_ancestry, "goal_chain", boom)
    eng = await make_agent("Eng", "eng")
    t = await make_task("solo", "d", assignee_alias="Eng", description="x")
    r = await client.get(f"/api/agents/{eng['agent_id']}/protocol")
    assert r.status_code == 200, r.text
    assert r.json()["task_id"] == t["id"] and "goal_chain" not in r.json()


# ============================ notifier render (pure) ============================


def test_render_goal_chain_pure_cases():
    from orcha_cli.notifier_protocol import _render_goal_chain, _render_task_body
    assert _render_goal_chain(None) is None
    assert _render_goal_chain([]) is None
    # project with no objective + the task only -> nothing informative
    assert _render_goal_chain([{"kind": "objective", "title": "P", "text": None},
                               {"kind": "task", "title": "T"}]) is None
    # no objective text but a parent -> says so truthfully
    out = _render_goal_chain([{"kind": "objective", "title": "P", "text": None},
                              {"kind": "parent", "id": "p1", "title": "Epic", "status": "ready"},
                              {"kind": "task", "title": "T"}])
    assert 'Project "P" (no objective set) → Parent task "Epic" [ready] (id p1) → This task "T"' \
        in out
    # long objective is clipped, newlines collapsed
    long = "word " * 200
    out = _render_goal_chain([{"kind": "objective", "title": "P", "text": long},
                              {"kind": "task", "title": "T"}])
    assert "…" in out and "\n" not in out and len(out) < 600
    # rides inside the task body; a title-only task with a chain still renders (chain adds info)
    body = _render_task_body({"task_id": "t", "title": "T", "goal_chain": [
        {"kind": "objective", "title": "P", "text": "Win"}, {"kind": "task", "title": "T"}]})
    assert body is not None and 'Project objective "Win" (P) → This task "T"' in body
    # malformed nodes are ignored, never crash the wake
    assert _render_goal_chain(["junk", {"kind": "task", "title": "T"}]) is None
