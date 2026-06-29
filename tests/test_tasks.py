"""Task state machine (Orcha#22): create, claim, done-auth, verify, dependencies."""
import uuid


async def test_create_assigned_is_in_progress(make_task, make_agent):
    await make_agent("dev", "eng")
    t = await make_task("build", "ship it", assignee_alias="dev")
    assert t["status"] == "in_progress"


async def test_create_unassigned_is_ready(make_task):
    t = await make_task("loose", "done")
    assert t["status"] == "ready"


async def test_next_does_not_claim_unassigned_ready_task(client, make_agent, make_task):
    """Assignment is the only task trigger: ready-but-unassigned tasks are not a free pool."""
    a = await make_agent("claimer", "eng")
    await make_task("loose", "done")
    r = await client.post(f"/api/agents/{a['agent_id']}/next")
    assert r.status_code == 200, r.text
    assert r.json()["task"] is None


async def test_create_with_deps_is_pending(make_task):
    blocker = await make_task("first", "done")
    t = await make_task("second", "done", depends_on=[blocker["task_id"]])
    assert t["status"] == "pending"


async def test_next_claims_ready_excludes_root(client, container, make_agent, make_task):
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("claimer", "eng")
    t = await make_task("ready-one", "done")
    ar = await client.post(f"/api/tasks/{t['task_id']}/assign",
                           json={"actor_agent_id": human["agent_id"], "agent_id": a["agent_id"]})
    assert ar.status_code == 200 and ar.json()["status"] == "ready", ar.text
    r = await client.post(f"/api/agents/{a['agent_id']}/next")
    assert r.status_code == 200, r.text
    claimed = r.json()["task"]
    assert claimed is not None
    assert claimed["id"] == t["task_id"]        # got the ready task
    assert claimed["id"] != container["root_task_id"]  # never the root sentinel


async def test_next_claim_payload_carries_full_task_body(client, make_agent, make_task):
    """GH #33: the claim payload must surface the FULL task body — title AND description AND
    definition_of_done — so the woken worker acts on the complete spec, not just the title."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("claimer", "eng")
    t = await make_task("loop the thing", "all 5 iterations logged",
                        description="Run the loop 5 times; each pass must append a line.")
    ar = await client.post(f"/api/tasks/{t['task_id']}/assign",
                           json={"actor_agent_id": human["agent_id"], "agent_id": a["agent_id"]})
    assert ar.status_code == 200, ar.text
    claimed = (await client.post(f"/api/agents/{a['agent_id']}/next")).json()["task"]
    assert claimed["title"] == "loop the thing"
    assert claimed["description"] == "Run the loop 5 times; each pass must append a line."
    assert claimed["definition_of_done"] == "all 5 iterations logged"


async def test_task_thread_read_carries_task_body_header(client, make_agent, make_task):
    """GH #33: reading a task thread also returns a `task` header (title + description +
    definition_of_done), so a worker woken by a task-thread message and told to "read the thread"
    sees the FULL task body — not just the message preview and the title."""
    a = await make_agent("dev", "eng")
    t = await make_task("loop the thing", "all 5 iterations logged", assignee_alias="dev",
                        description="Run the loop 5 times; each pass appends a line.")
    await client.post(f"/api/tasks/{t['id']}/messages",
                      json={"author_id": a["agent_id"], "body": "starting now"})
    r = await client.get(f"/api/tasks/{t['id']}/messages")
    assert r.status_code == 200, r.text
    hdr = r.json()["task"]
    assert hdr["title"] == "loop the thing"
    assert hdr["description"] == "Run the loop 5 times; each pass appends a line."
    assert hdr["definition_of_done"] == "all 5 iterations logged"
    # the same header rides on the paginated (limit>0) read too
    rp = await client.get(f"/api/tasks/{t['id']}/messages", params={"limit": 5})
    assert rp.json()["task"]["definition_of_done"] == "all 5 iterations logged"


async def test_next_no_ready_returns_none(client, make_agent):
    a = await make_agent("idle-claimer", "eng")
    r = await client.post(f"/api/agents/{a['agent_id']}/next")
    assert r.status_code == 200, r.text
    assert r.json()["task"] is None


async def test_done_only_by_assignee(client, make_agent, make_task):
    owner = await make_agent("owner", "eng")
    intruder = await make_agent("intruder", "eng")
    t = await make_task("mine", "done", assignee_alias="owner")
    bad = await client.post(f"/api/tasks/{t['task_id']}/done",
                            json={"agent_id": intruder["agent_id"], "result": "sneaky"})
    assert bad.status_code == 403, bad.text
    ok = await client.post(f"/api/tasks/{t['task_id']}/done",
                           json={"agent_id": owner["agent_id"], "result": "real"})
    assert ok.status_code == 200 and ok.json()["status"] == "needs_verification"


async def test_verify_approve_unlocks_downstream(client, make_agent, make_task):
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    blocker = await make_task("blocker", "done", assignee_alias="dev")
    downstream = await make_task("downstream", "done", depends_on=[blocker["task_id"]])
    assert downstream["status"] == "pending"
    await client.post(f"/api/tasks/{blocker['task_id']}/done",
                      json={"agent_id": dev["agent_id"], "result": "x"})
    v = await client.post(f"/api/tasks/{blocker['task_id']}/verify",
                          json={"approve": True, "actor_agent_id": human["agent_id"]})
    assert v.status_code == 200, v.text
    assert downstream["task_id"] in v.json().get("unblocked", [])


async def test_verify_reject_restores_assignee(client, container, make_agent, make_task):
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("redo", "done", assignee_alias="dev")
    await client.post(f"/api/tasks/{t['task_id']}/done",
                      json={"agent_id": dev["agent_id"], "result": "draft"})
    v = await client.post(f"/api/tasks/{t['task_id']}/verify",
                          json={"approve": False, "feedback": "redo it",
                                "actor_agent_id": human["agent_id"]})
    assert v.status_code == 200, v.text
    assert v.json()["status"] == "in_progress"
    # dev is back on the task
    snap = await client.get(f"/api/containers/{container['id']}")
    redo = [t2 for t2 in snap.json()["tasks"] if t2["id"] == t["task_id"]][0]
    assert "dev" in redo["assignees"]


async def test_blocked_task_cannot_be_done(client, make_agent, make_task):
    dev = await make_agent("dev", "eng")
    blocker = await make_task("b", "done")
    pending = await make_task("p", "done", depends_on=[blocker["task_id"]], assignee_alias="dev")
    r = await client.post(f"/api/tasks/{pending['task_id']}/done",
                          json={"agent_id": dev["agent_id"], "result": "nope"})
    assert r.status_code >= 400, "a pending/blocked task should not be completable"


async def test_verify_is_human_only(client, make_agent, make_task):
    dev = await make_agent("dev", "eng")
    t = await make_task("t", "done", assignee_alias="dev")
    await client.post(f"/api/tasks/{t['task_id']}/done",
                      json={"agent_id": dev["agent_id"], "result": "x"})
    r = await client.post(f"/api/tasks/{t['task_id']}/verify",
                          json={"approve": True, "actor_agent_id": dev["agent_id"]})
    assert r.status_code == 403, r.text


async def test_done_unknown_task_404(client, make_agent):
    dev = await make_agent("dev", "eng")
    r = await client.post(f"/api/tasks/{uuid.uuid4()}/done",
                          json={"agent_id": dev["agent_id"], "result": "x"})
    assert r.status_code == 404, r.text


# ---------- B5: assign an existing task to an agent (+ wake wiring) ----------

async def test_assign_ready_task_assigns_and_wakes(client, make_agent, make_task):
    """B5: a human assigns an unassigned (ready) task → agent_tasks row 'assigned', task stays
    'ready', and a targeted task_assigned event is published so the daemon wakes the assignee."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("loose", "ship it")                 # unassigned → ready
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "ready" and d["assignment_status"] == "assigned"
    assert d["agent_id"] == dev["agent_id"] and d["alias"] == "dev"
    assert d["woke"] is True and d["released_prior"] is None
    # the assignee receives a targeted task_assigned event (wake wiring)
    w = await client.get(f"/api/agents/{dev['agent_id']}/wait", params={"since_ts": 0, "timeout": 1})
    evt = w.json()
    assert evt["event"] == "task_assigned" and evt["task_id"] == t["task_id"]


async def test_assign_allows_ai_orchestrator(client, make_agent, make_task, db):
    """#327: direct assignment is no longer human-only — an AI orchestrator may dispatch an
    EXISTING task (mirrors create_task, which already lets any AI assign-at-create). The action
    is audited under the actor's real kind. TEETH: revert the assign gate to ('human',) and this
    200 → 403; revert the dynamic log_event actor_type to 'human' and the actor_type assert flips."""
    ai = await make_agent("bot", "eng")            # kind='ai' orchestrator
    dev = await make_agent("dev", "eng")
    t = await make_task("x", "done")               # unassigned → ready
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": ai["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready" and r.json()["woke"] is True
    # audited as an AI action, not human
    assert db.execute(
        "SELECT actor_type FROM events WHERE entity_id=%s AND event_type='assigned'",
        (t["task_id"],))[0]["actor_type"] == "ai"


async def test_assign_pending_task_is_not_woken(client, make_agent, make_task):
    """A task with unmet deps stays 'pending' and is NOT woken now (the dep-unblock path delivers
    a targeted task_ready when its deps clear — waking it now would just no-op)."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    blocker = await make_task("blocker", "done")
    pending = await make_task("later", "done", depends_on=[blocker["task_id"]])
    r = await client.post(f"/api/tasks/{pending['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "pending" and d["woke"] is False
    # no task_assigned delivered
    w = await client.get(f"/api/agents/{dev['agent_id']}/wait", params={"since_ts": 0, "timeout": 1})
    assert w.json()["event"] == "timeout"


async def test_assign_reassign_gate_and_release(client, make_agent, make_task, db):
    """A task already actively assigned to dev1 refuses a different assignee unless reassign=true,
    which releases dev1 first."""
    human = await make_agent("op", "operator", kind="human")
    dev1 = await make_agent("dev1", "eng")
    dev2 = await make_agent("dev2", "eng")
    t = await make_task("hot-potato", "done", assignee_alias="dev1")   # in_progress, dev1 working
    # without reassign → 409
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev2["agent_id"]})
    assert r.status_code == 409, r.text
    # with reassign=true → dev1 released, dev2 assigned, task back to ready
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev2["agent_id"],
                                "reassign": True})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["agent_id"] == dev2["agent_id"] and d["status"] == "ready"
    assert d["released_prior"] == [dev1["agent_id"]]
    # dev1's active assignment is gone; dev2 now holds it as 'assigned'
    assert not db.execute("SELECT 1 FROM agent_tasks WHERE agent_id=%s AND task_id=%s",
                          (dev1["agent_id"], t["task_id"]))
    rows = db.execute("SELECT assignment_status FROM agent_tasks WHERE agent_id=%s AND task_id=%s",
                      (dev2["agent_id"], t["task_id"]))
    assert rows and rows[0]["assignment_status"] == "assigned"


async def test_assign_same_agent_is_idempotent(client, make_agent, make_task):
    """Re-asserting the SAME active assignee is a no-op — it must not disturb in-progress work."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("mine", "done", assignee_alias="dev")          # in_progress, dev working
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["woke"] is False and d["released_prior"] is None
    assert d["status"] == "in_progress"          # untouched
    assert d["assignment_status"] == "working"


async def test_assign_root_task_rejected(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    r = await client.post(f"/api/tasks/{container['root_task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 409, r.text


async def test_assign_finished_task_rejected(client, make_agent, make_task):
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("wrap", "done", assignee_alias="dev")
    await client.post(f"/api/tasks/{t['task_id']}/done",
                      json={"agent_id": dev["agent_id"], "result": "x"})   # → needs_verification
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 409, r.text


async def test_assign_to_human_rejected(client, make_agent, make_task):
    human = await make_agent("op", "operator", kind="human")
    other_human = await make_agent("op2", "operator", kind="human")
    t = await make_task("x", "done")
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": other_human["agent_id"]})
    assert r.status_code == 409, r.text


async def test_assign_unknown_agent_404(client, make_agent, make_task):
    import uuid as _uuid
    human = await make_agent("op", "operator", kind="human")
    t = await make_task("x", "done")
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": str(_uuid.uuid4())})
    assert r.status_code == 404, r.text


async def test_next_prefers_assigned_task_over_higher_priority_pool(client, make_agent, make_task):
    """An assigned task is claimable even when a higher-priority unassigned task is also ready."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    competitor = await make_task("urgent-pool", "done", priority=1)        # higher priority, unassigned
    mine = await make_task("assigned-to-me", "done", priority=100)         # lower priority, will be assigned
    r = await client.post(f"/api/tasks/{mine['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 200 and r.json()["status"] == "ready", r.text
    nxt = await client.post(f"/api/agents/{dev['agent_id']}/next")
    assert nxt.status_code == 200, nxt.text
    assert nxt.json()["task"]["id"] == mine["task_id"], "must claim the ASSIGNED task, not the pool competitor"
    # the competitor is still ready for someone else
    assert competitor["status"] == "ready"


async def test_assign_cancelled_task_rejected(client, make_agent, make_task):
    """B5 review [P1]: a cancelled task is terminal — /assign must not resurrect it to ready/pending."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    t = await make_task("doomed", "done")
    c = await client.post(f"/api/tasks/{t['task_id']}/cancel",
                          json={"actor_agent_id": human["agent_id"], "reason": "obsolete"})
    assert c.status_code == 200, c.text
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert r.status_code == 409, r.text


async def test_next_excludes_tasks_assigned_to_another_agent(client, make_agent, make_task):
    """A task assigned to agent A is NOT in agent B's /next pool."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    t = await make_task("for-A-only", "done")                  # unassigned → ready
    r = await client.post(f"/api/tasks/{t['task_id']}/assign",
                          json={"actor_agent_id": human["agent_id"], "agent_id": a["agent_id"]})
    assert r.status_code == 200 and r.json()["status"] == "ready", r.text
    # B polls /next — must NOT get A's assigned task (it's the only ready task → None)
    nb = await client.post(f"/api/agents/{b['agent_id']}/next")
    assert nb.status_code == 200, nb.text
    assert nb.json()["task"] is None, "agent B must not be able to claim a task assigned to A"
    # A polls /next — gets its assigned task
    na = await client.post(f"/api/agents/{a['agent_id']}/next")
    assert na.status_code == 200 and na.json()["task"]["id"] == t["task_id"], na.text
