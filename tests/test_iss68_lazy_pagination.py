"""ISS-68 (#167) — backend lazy-load primitives.

The 3s container snapshot re-ships every task's full message thread (~277KB) + all request
bodies (~478KB). This adds the paginated, priority-ordered READ endpoints the portal needs to
lazily fetch the top-N rows and "load more" on demand, plus a cursor on the task thread — WITHOUT
changing the snapshot (PR-1 is purely additive; the frontend flips to these + the snapshot trim
lands in PR-2). Covered here:

  GET /api/containers/{cid}/tasks?limit=&offset=&agent=        priority order + trimmed rows
  GET /api/containers/{cid}/requests?limit=&offset=&agent=&direction=   status order
  GET /api/tasks/{tid}/messages?limit=&before=                 thread cursor (newest-first page)
"""
import pytest

pytestmark = pytest.mark.asyncio


async def _post_msg(client, tid, body, author_id=None):
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": author_id, "body": body})
    assert r.status_code == 201, r.text
    return r.json()


# ---------- tasks list ----------

async def test_tasks_priority_order_waiting_then_in_progress_then_priority(
        client, container, make_task, db):
    cid = container["id"]
    # three tasks; force distinct statuses + priorities directly so the ORDER BY is deterministic
    a = await make_task("verify-me", "dod", priority=200)      # waiting (needs_verification)
    b = await make_task("working", "dod", priority=200)        # in_progress
    c_hi = await make_task("ready-hi", "dod", priority=1)      # ready, high priority
    c_lo = await make_task("ready-lo", "dod", priority=300)    # ready, low priority
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (a["id"],))
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (b["id"],))

    r = await client.get(f"/api/containers/{cid}/tasks", params={"limit": 10})
    assert r.status_code == 200, r.text
    d = r.json()
    titles = [t["title"] for t in d["tasks"]]
    # waiting first, then in_progress, then the rest by priority (lower number first)
    assert titles[:2] == ["verify-me", "working"], titles
    assert titles.index("ready-hi") < titles.index("ready-lo"), titles
    assert d["total"] == 5  # 4 here + the container root task
    assert d["has_more"] is False


async def test_tasks_pagination_limit_offset(client, container, make_task):
    cid = container["id"]
    for i in range(5):
        await make_task(f"t{i}", "dod", priority=100 + i)
    r1 = (await client.get(f"/api/containers/{cid}/tasks", params={"limit": 2, "offset": 0})).json()
    assert len(r1["tasks"]) == 2 and r1["has_more"] is True
    r2 = (await client.get(f"/api/containers/{cid}/tasks", params={"limit": 2, "offset": 2})).json()
    # no overlap between the two pages
    ids1 = {t["id"] for t in r1["tasks"]}
    ids2 = {t["id"] for t in r2["tasks"]}
    assert ids1.isdisjoint(ids2)


async def test_tasks_row_trims_thread_to_summary_and_plan_message(
        client, container, make_agent, make_task, db):
    cid = container["id"]
    ag = await make_agent("Builder")
    t = await make_task("with-thread", "dod", assignee_alias="Builder")   # assigned → may post
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (t["id"],))
    await _post_msg(client, t["id"], "first human note")                       # human (null author)
    await _post_msg(client, t["id"], "PLAN: do X then Y", author_id=ag["agent_id"])  # agent plan
    row = next(x for x in (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
               if x["id"] == t["id"])
    # the heavy full thread is GONE; a compact summary replaces it
    assert "messages" not in row, "row still ships the full message thread"
    assert row["message_summary"]["count"] == 2
    assert row["message_summary"]["last"]["body"].startswith("PLAN: do X")
    # the latest agent-authored note is surfaced so the approval card renders the plan thread-free
    assert row["plan_message"]["body"] == "PLAN: do X then Y"
    assert row["plan_message"]["author_alias"] == "Builder"


async def test_tasks_agent_filter(client, container, make_agent, make_task):
    cid = container["id"]
    mine = await make_agent("Mine")
    await make_task("assigned", "dod", assignee_alias="Mine")
    await make_task("unassigned", "dod")
    d = (await client.get(f"/api/containers/{cid}/tasks",
                          params={"agent": mine["agent_id"]})).json()
    titles = [t["title"] for t in d["tasks"]]
    assert "assigned" in titles and "unassigned" not in titles, titles


# ---------- requests list ----------

async def test_requests_status_order_and_pagination(
        client, container, make_agent, make_request, db):
    cid = container["id"]
    a = await make_agent("Asker")
    b = await make_agent("Answerer")
    r_open = await make_request(a["agent_id"], "open one", target_alias="Answerer")
    r_ans = await make_request(a["agent_id"], "answered one", target_alias="Answerer")
    r_closed = await make_request(a["agent_id"], "closed one", target_alias="Answerer")
    db.execute("UPDATE requests SET status='answered' WHERE id=%s", (r_ans["id"],))
    db.execute("UPDATE requests SET status='closed' WHERE id=%s", (r_closed["id"],))
    d = (await client.get(f"/api/containers/{cid}/requests", params={"limit": 10})).json()
    statuses = [r["status"] for r in d["requests"]]
    assert statuses == ["open", "answered", "closed"], statuses
    assert d["total"] == 3
    # pagination
    p1 = (await client.get(f"/api/containers/{cid}/requests", params={"limit": 1})).json()
    assert len(p1["requests"]) == 1 and p1["has_more"] is True
    assert p1["requests"][0]["status"] == "open"


async def test_requests_agent_direction_filter(
        client, container, make_agent, make_request):
    cid = container["id"]
    a = await make_agent("Out")
    b = await make_agent("In")
    await make_request(a["agent_id"], "a asks b", target_alias="In")
    await make_request(b["agent_id"], "b asks a", target_alias="Out")
    out = (await client.get(f"/api/containers/{cid}/requests",
                            params={"agent": a["agent_id"], "direction": "out"})).json()
    assert [r["payload"] for r in out["requests"]] == ["a asks b"]
    inc = (await client.get(f"/api/containers/{cid}/requests",
                            params={"agent": a["agent_id"], "direction": "in"})).json()
    assert [r["payload"] for r in inc["requests"]] == ["b asks a"]


async def test_requests_bad_direction_rejected(client, container):
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/requests", params={"direction": "sideways"})
    assert r.status_code == 400


# ---------- requests ?status filter (census correctness) ----------

async def test_requests_status_filter_scopes_to_one_lifecycle_state(
        client, container, make_agent, make_request, db):
    """Regression: ?status was IGNORED — a caller asking for open requests silently got
    closed/answered rows in the window. The filter must scope the list AND the total."""
    cid = container["id"]
    a = await make_agent("Asker")
    await make_agent("Answerer")
    r_open = await make_request(a["agent_id"], "open one", target_alias="Answerer")
    r_ans = await make_request(a["agent_id"], "answered one", target_alias="Answerer")
    r_closed = await make_request(a["agent_id"], "closed one", target_alias="Answerer")
    db.execute("UPDATE requests SET status='answered' WHERE id=%s", (r_ans["id"],))
    db.execute("UPDATE requests SET status='closed' WHERE id=%s", (r_closed["id"],))

    op = (await client.get(f"/api/containers/{cid}/requests",
                           params={"status": "open"})).json()
    assert [r["status"] for r in op["requests"]] == ["open"]
    assert op["total"] == 1 and op["has_more"] is False

    cl = (await client.get(f"/api/containers/{cid}/requests",
                           params={"status": "closed"})).json()
    assert [r["status"] for r in cl["requests"]] == ["closed"]
    assert cl["total"] == 1

    # filter composes with agent/direction scoping
    scoped = (await client.get(f"/api/containers/{cid}/requests",
                               params={"agent": a["agent_id"], "direction": "out",
                                       "status": "answered"})).json()
    assert [r["payload"] for r in scoped["requests"]] == ["answered one"]
    assert scoped["total"] == 1


async def test_requests_bad_status_rejected(client, container):
    cid = container["id"]
    r = await client.get(f"/api/containers/{cid}/requests", params={"status": "sideways"})
    assert r.status_code == 400


async def test_requests_order_is_deterministic_across_repeat_calls(
        client, container, make_agent, make_request, db):
    """Rows tied on (status, priority, created_at) must order the SAME on every call —
    the `id` tiebreaker makes pagination windows stable instead of flickering."""
    cid = container["id"]
    a = await make_agent("Asker")
    await make_agent("Answerer")
    # five open requests, all same priority; force an identical created_at so ONLY the
    # id tiebreaker decides order — without it Postgres may permute them per call.
    for i in range(5):
        await make_request(a["agent_id"], f"tied {i}", target_alias="Answerer")
    db.execute("UPDATE requests SET priority=50, created_at=now() WHERE container_id=%s", (cid,))

    full = await _get_ids(client, cid, {"limit": 50})
    again = await _get_ids(client, cid, {"limit": 50})
    assert full == again, "repeat full-list calls returned different order"
    # paginated windows must tile the full order with no gaps/overlaps
    page1 = await _get_ids(client, cid, {"limit": 2, "offset": 0})
    page2 = await _get_ids(client, cid, {"limit": 2, "offset": 2})
    page3 = await _get_ids(client, cid, {"limit": 2, "offset": 4})
    assert page1 + page2 + page3 == full, "pages did not tile the deterministic full order"


async def _get_ids(client, cid, params):
    d = (await client.get(f"/api/containers/{cid}/requests", params=params)).json()
    return [r["id"] for r in d["requests"]]


async def test_snapshot_request_order_is_id_stable_on_full_tie(
        client, container, make_agent, make_request, db):
    """The SNAPSHOT path (get_container, surfaced via /api/snapshot/{cid}) carries its own
    request ORDER BY, separate from the paginated endpoint above. Rows tied on
    (status, priority, created_at) must resolve by `id` so the dashboard request list renders
    in the same order on every reload. Request ids are random UUIDs, so without the `id`
    tiebreaker the heap/insertion order would NOT match id-sorted order — this assertion bites
    when the snapshot tiebreaker is removed (mutation: drop `, id` from the snapshot ORDER BY)."""
    cid = container["id"]
    a = await make_agent("Asker")
    await make_agent("Answerer")
    for i in range(8):
        await make_request(a["agent_id"], f"tied {i}", target_alias="Answerer")
    # collapse every distinguishing sort key EXCEPT id, so only the id tiebreaker decides order
    db.execute("UPDATE requests SET status='open', priority=50, created_at=now() "
               "WHERE container_id=%s", (cid,))

    snap = (await client.get(f"/api/snapshot/{cid}")).json()
    ids = [r["id"] for r in snap["requests"]]
    assert len(ids) == 8, "snapshot did not return all tied requests"
    assert ids == sorted(ids), "snapshot requests not ordered by id on a full tie"


# ---------- task-thread cursor ----------

async def test_messages_no_params_returns_full_thread_ascending(
        client, container, make_task):
    t = await make_task("thready", "dod")
    for i in range(4):
        await _post_msg(client, t["id"], f"m{i}")
    d = (await client.get(f"/api/tasks/{t['id']}/messages")).json()
    assert [m["body"] for m in d["messages"]] == ["m0", "m1", "m2", "m3"]
    assert "has_more" not in d   # unpaginated shape unchanged


def _earlier(p):
    """next-page params from a page's keyset cursor."""
    return {"limit": 2, "before": p["next_before"], "before_id": p["next_before_id"]}


async def test_messages_cursor_pages_newest_first_then_earlier(
        client, container, make_task):
    t = await make_task("thready", "dod")
    for i in range(5):
        await _post_msg(client, t["id"], f"m{i}")
    # newest page first: m3, m4 (ASC within the page), more earlier
    p1 = (await client.get(f"/api/tasks/{t['id']}/messages", params={"limit": 2})).json()
    assert [m["body"] for m in p1["messages"]] == ["m3", "m4"]
    assert p1["has_more"] is True and p1["next_before"] and p1["next_before_id"]
    # load earlier with the keyset cursor
    p2 = (await client.get(f"/api/tasks/{t['id']}/messages", params=_earlier(p1))).json()
    assert [m["body"] for m in p2["messages"]] == ["m1", "m2"]
    assert p2["has_more"] is True
    p3 = (await client.get(f"/api/tasks/{t['id']}/messages", params=_earlier(p2))).json()
    assert [m["body"] for m in p3["messages"]] == ["m0"]
    assert p3["has_more"] is False and p3["next_before"] is None


async def test_messages_cursor_stable_under_identical_timestamps(
        client, container, make_task, db):
    """P2 (kedar #180): five messages sharing one created_at must page WITHOUT dropping rows.
    A bare `created_at < before` cursor reported has_more on page 1 then returned nothing on the
    follow-up; the (created_at, id) keyset pages them all exactly."""
    t = await make_task("tied", "dod")
    for i in range(5):
        await _post_msg(client, t["id"], f"m{i}")
    # collapse every message onto one identical timestamp
    db.execute("UPDATE task_messages SET created_at = '2026-06-09T00:00:00+00:00' WHERE task_id=%s",
               (t["id"],))
    seen, params, guard = [], {"limit": 2}, 0
    while True:
        guard += 1
        assert guard < 10, "cursor failed to terminate"
        p = (await client.get(f"/api/tasks/{t['id']}/messages", params=params)).json()
        seen.extend(m["body"] for m in p["messages"])
        if not p["has_more"]:
            break
        params = _earlier(p)
    # all five recovered, none dropped, none duplicated
    assert sorted(seen) == ["m0", "m1", "m2", "m3", "m4"], seen
    assert len(seen) == len(set(seen)), f"duplicate rows across pages: {seen}"


# ---------- ISS-331: time/priority sort + direction on the two list endpoints ----------

async def test_tasks_sort_time_orders_within_bucket(client, container, make_task, db):
    cid = container["id"]
    a = await make_task("old", "dod", priority=50)
    b = await make_task("mid", "dod", priority=50)
    c = await make_task("new", "dod", priority=50)
    db.execute("UPDATE tasks SET created_at='2026-01-01' WHERE id=%s", (a["id"],))
    db.execute("UPDATE tasks SET created_at='2026-02-01' WHERE id=%s", (b["id"],))
    db.execute("UPDATE tasks SET created_at='2026-03-01' WHERE id=%s", (c["id"],))
    mine = ("old", "mid", "new")
    desc = (await client.get(f"/api/containers/{cid}/tasks",
                             params={"sort": "time", "dir": "desc", "limit": 50})).json()
    assert [t["title"] for t in desc["tasks"] if t["title"] in mine] == ["new", "mid", "old"]
    asc = (await client.get(f"/api/containers/{cid}/tasks",
                            params={"sort": "time", "dir": "asc", "limit": 50})).json()
    assert [t["title"] for t in asc["tasks"] if t["title"] in mine] == ["old", "mid", "new"]


async def test_tasks_sort_priority_direction(client, container, make_task, db):
    cid = container["id"]
    await make_task("p10", "dod", priority=10)
    await make_task("p50", "dod", priority=50)
    await make_task("p90", "dod", priority=90)
    # collapse created_at so priority alone decides
    db.execute("UPDATE tasks SET created_at='2026-01-01' WHERE container_id=%s", (cid,))
    asc = (await client.get(f"/api/containers/{cid}/tasks",
                            params={"sort": "priority", "dir": "asc", "limit": 50})).json()
    assert [t["title"] for t in asc["tasks"] if t["title"].startswith("p")] == ["p10", "p50", "p90"]
    desc = (await client.get(f"/api/containers/{cid}/tasks",
                             params={"sort": "priority", "dir": "desc", "limit": 50})).json()
    assert [t["title"] for t in desc["tasks"] if t["title"].startswith("p")] == ["p90", "p50", "p10"]


async def test_tasks_sort_keeps_status_bucket_outer(client, container, make_task, db):
    """Mutation tooth: even under sort=time desc, needs_verification floats above the rest — the
    status bucket is the OUTER key. Bites if _sort_clause drops the bucket (pure time would invert)."""
    cid = container["id"]
    old_nv = await make_task("old-nv", "dod", priority=50)       # OLD but needs_verification
    new_ready = await make_task("new-ready", "dod", priority=50)  # NEW but in the 'rest' bucket
    db.execute("UPDATE tasks SET status='needs_verification', created_at='2026-01-01' WHERE id=%s", (old_nv["id"],))
    db.execute("UPDATE tasks SET created_at='2026-03-01' WHERE id=%s", (new_ready["id"],))
    d = (await client.get(f"/api/containers/{cid}/tasks",
                          params={"sort": "time", "dir": "desc", "limit": 50})).json()
    titles = [t["title"] for t in d["tasks"]]
    assert titles.index("old-nv") < titles.index("new-ready"), titles


async def test_tasks_default_order_unchanged_without_sort(client, container, make_task, db):
    """Mutation tooth: omitting sort => pre-ISS-331 default (bucket, priority, created_at). A
    mutation that makes the None case time-sort instead would flip hi(P1, older) below lo(P300, newer)."""
    cid = container["id"]
    hi = await make_task("hi", "dod", priority=1)
    lo = await make_task("lo", "dod", priority=300)
    db.execute("UPDATE tasks SET created_at='2026-01-01' WHERE id=%s", (hi["id"],))   # hi OLDER
    db.execute("UPDATE tasks SET created_at='2026-03-01' WHERE id=%s", (lo["id"],))   # lo NEWER
    d = (await client.get(f"/api/containers/{cid}/tasks", params={"limit": 50})).json()
    titles = [t["title"] for t in d["tasks"]]
    assert titles.index("hi") < titles.index("lo"), titles   # priority-first, not time-first


async def test_tasks_sort_time_tie_breaks_on_id_deterministically(client, container, make_task, db):
    cid = container["id"]
    for i in range(5):
        await make_task(f"t{i}", "dod", priority=50)
    db.execute("UPDATE tasks SET created_at='2026-01-01', priority=50 WHERE container_id=%s", (cid,))
    p = {"sort": "time", "dir": "desc", "limit": 50}
    ids1 = [t["id"] for t in (await client.get(f"/api/containers/{cid}/tasks", params=p)).json()["tasks"]]
    ids2 = [t["id"] for t in (await client.get(f"/api/containers/{cid}/tasks", params=p)).json()["tasks"]]
    assert ids1 == ids2 and len(ids1) == len(set(ids1)), ids1


async def test_requests_sort_time_and_priority(client, container, make_agent, make_request, db):
    cid = container["id"]
    a = await make_agent("Asker")
    await make_agent("Answerer")
    r1 = await make_request(a["agent_id"], "first", target_alias="Answerer")
    r2 = await make_request(a["agent_id"], "second", target_alias="Answerer")
    r3 = await make_request(a["agent_id"], "third", target_alias="Answerer")
    db.execute("UPDATE requests SET created_at='2026-01-01' WHERE id=%s", (r1["id"],))
    db.execute("UPDATE requests SET created_at='2026-02-01' WHERE id=%s", (r2["id"],))
    db.execute("UPDATE requests SET created_at='2026-03-01' WHERE id=%s", (r3["id"],))
    desc = (await client.get(f"/api/containers/{cid}/requests",
                             params={"sort": "time", "dir": "desc"})).json()
    assert [r["payload"] for r in desc["requests"]] == ["third", "second", "first"]
    asc = (await client.get(f"/api/containers/{cid}/requests",
                            params={"sort": "time", "dir": "asc"})).json()
    assert [r["payload"] for r in asc["requests"]] == ["first", "second", "third"]
    # priority mode (all same created_at irrelevant — priority leads): r3<r2<r1 by priority number
    db.execute("UPDATE requests SET priority=10 WHERE id=%s", (r3["id"],))
    db.execute("UPDATE requests SET priority=20 WHERE id=%s", (r2["id"],))
    db.execute("UPDATE requests SET priority=30 WHERE id=%s", (r1["id"],))
    pa = (await client.get(f"/api/containers/{cid}/requests",
                           params={"sort": "priority", "dir": "asc"})).json()
    assert [r["payload"] for r in pa["requests"]] == ["third", "second", "first"]


async def test_sort_and_dir_validation_rejected(client, container):
    cid = container["id"]
    for ep in ("tasks", "requests"):
        assert (await client.get(f"/api/containers/{cid}/{ep}",
                                 params={"sort": "bogus"})).status_code == 400
        assert (await client.get(f"/api/containers/{cid}/{ep}",
                                 params={"dir": "sideways"})).status_code == 400
    # valid combinations are accepted (and compose with the existing filters)
    assert (await client.get(f"/api/containers/{cid}/tasks",
                             params={"sort": "time", "dir": "asc"})).status_code == 200
    assert (await client.get(f"/api/containers/{cid}/requests",
                             params={"sort": "priority", "dir": "desc", "status": "open"})).status_code == 200
