"""GH #35 — endpoint wiring for completion recalibration.

Drives the REAL completion transitions against the app (/done, /verify approve, /cancel) and reads
the owner's LATEST stored digest back through GET /api/agents/{aid}/digest. Proves the headline DoD:
after a task closes, the owner's digest no longer carries that task's stale open threads while its
durable learnings survive — and a completion that touches nothing writes no churn row.

Kept as its own all-async module (module-level asyncio pytestmark) so the sync pure-transform tests
in test_gh35_digest_recalibrate.py don't interleave with the async DB-reset fixture ordering.
"""
import pytest

pytestmark = pytest.mark.asyncio


async def _post_digest(client, aid, *, open_threads, decisions=None, learnings=None, focus=""):
    """Post an agent's own digest snapshot (append-only latest row)."""
    body = {"current_focus": focus, "decisions": decisions or [],
            "learnings": learnings or [], "open_threads": open_threads}
    r = await client.post(f"/api/agents/{aid}/digest", json=body)
    assert r.status_code == 201, r.text


async def _latest_digest(client, aid):
    g = await client.get(f"/api/agents/{aid}/digest")
    assert g.status_code == 200, g.text
    return g.json()["digest"]


async def test_done_recalibrates_owner_digest_needs_verification(
        client, make_agent, make_task, work_headers):
    """Headline DoD: after /done (needs_verification), the owner's latest digest no longer carries
    the finished task's stale open thread, its durable learning survives, and a still-pending
    verification thread is kept."""
    worker = await make_agent("Worker")
    task = await make_task("ship the recalibration", "it is shipped", assignee_alias="Worker")
    tid = task["id"]
    await _post_digest(
        client, worker["agent_id"],
        focus=f"finishing task {tid[:8]}",
        open_threads=[
            {"text": f"still need to wire the hook for task {tid[:8]}"},   # stale → pruned
            {"text": f"await human verification on {tid[:8]}"},            # pending → kept
            {"text": "unrelated: review Andrew's Android PR"},            # unrelated → kept
        ],
        learnings=[{"text": "digest_curate ships via _PORTAL_SHARED_MODULES"}],
        decisions=[{"text": f"for {tid[:8]}: base the PR on the integration branch"}])

    r = await client.post(f"/api/tasks/{tid}/done",
                          json={"agent_id": worker["agent_id"], "result": "done"},
                          headers=await work_headers(worker["agent_id"]))
    assert r.status_code == 200 and r.json()["status"] == "needs_verification", r.text

    d = await _latest_digest(client, worker["agent_id"])
    threads = [e["text"] for e in d["open_threads"]]
    assert not any("still need to wire the hook" in t for t in threads)     # stale pruned
    assert any("await human verification" in t for t in threads)            # pending kept
    assert any("review Andrew" in t for t in threads)                       # unrelated kept
    # durable learning survives; task-scoped decision pruned; focus reset off the closed task.
    assert d["learnings"] == [{"text": "digest_curate ships via _PORTAL_SHARED_MODULES"}]
    assert d["decisions"] == []
    assert f"still need to wire the hook for task {tid[:8]}" not in (d["current_focus"] or "")


async def test_verify_approve_drops_the_verification_thread_too(
        client, make_agent, make_task, work_headers):
    """Once a human verifies (completed), even the pending-verification thread is resolved and
    pruned, while learnings still survive."""
    human = await make_agent("Operator", kind="human")
    worker = await make_agent("Worker")
    task = await make_task("ship it", "shipped", assignee_alias="Worker")
    tid = task["id"]
    r = await client.post(f"/api/tasks/{tid}/done",
                          json={"agent_id": worker["agent_id"], "result": "done"},
                          headers=await work_headers(worker["agent_id"]))
    assert r.status_code == 200, r.text
    # Post the post-/done digest that still holds a verify thread + a durable learning.
    await _post_digest(
        client, worker["agent_id"],
        open_threads=[{"text": f"await human verification on {tid[:8]}"}],
        learnings=[{"text": "never self-certify — stop at needs_verification"}])

    v = await client.post(f"/api/tasks/{tid}/verify",
                          json={"approve": True, "actor_agent_id": human["agent_id"]})
    assert v.status_code == 200 and v.json()["status"] == "completed", v.text

    d = await _latest_digest(client, worker["agent_id"])
    assert d["open_threads"] == []                                          # verify thread pruned
    assert d["learnings"] == [{"text": "never self-certify — stop at needs_verification"}]


async def test_cancel_recalibrates_owner_digest(client, make_agent, make_task):
    """Cancelling a task closes its work for good — the owner's stale threads are pruned."""
    worker = await make_agent("Worker")
    human = await make_agent("Operator", kind="human")
    task = await make_task("abandon me", "n/a", assignee_alias="Worker")
    tid = task["id"]
    await _post_digest(
        client, worker["agent_id"],
        open_threads=[{"text": f"half-built work for task {tid[:8]}"},
                      {"text": "keep: unrelated design spec"}])

    c = await client.post(f"/api/tasks/{tid}/cancel",
                          json={"actor_agent_id": human["agent_id"], "reason": "deprioritised"})
    assert c.status_code == 200 and c.json()["status"] == "cancelled", c.text

    d = await _latest_digest(client, worker["agent_id"])
    threads = [e["text"] for e in d["open_threads"]]
    assert threads == ["keep: unrelated design spec"]


async def test_no_churn_row_when_digest_unrelated_to_task(
        client, make_agent, make_task, work_headers, db):
    """A completion whose digest references nothing about the task must NOT write a new snapshot
    (no monotonic-growth churn). Row count is unchanged across /done."""
    worker = await make_agent("Worker")
    task = await make_task("ship it", "shipped", assignee_alias="Worker")
    tid = task["id"]
    await _post_digest(client, worker["agent_id"],
                       open_threads=[{"text": "totally unrelated open thread"}])

    before = db.execute("SELECT count(*) AS n FROM agent_memory_digests WHERE agent_id=%s",
                        (worker["agent_id"],))[0]["n"]
    r = await client.post(f"/api/tasks/{tid}/done",
                          json={"agent_id": worker["agent_id"], "result": "done"},
                          headers=await work_headers(worker["agent_id"]))
    assert r.status_code == 200, r.text
    after = db.execute("SELECT count(*) AS n FROM agent_memory_digests WHERE agent_id=%s",
                       (worker["agent_id"],))[0]["n"]
    assert after == before  # nothing referenced the task → no recalibration row written
