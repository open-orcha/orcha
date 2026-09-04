"""Agent spend drilldown (GET .../metrics/agents/{aid}/spend) + rule-based
spend-reduction insights (GET .../metrics/insights).

Accounting doctrine under test, same as the #289 meter: total_tokens sums all
FOUR token kinds (input + output + cache-read + cache-creation) — that's the
quota signal; total_cost_usd is the dollar figure and is never folded in."""
import uuid

import pytest

pytestmark = pytest.mark.asyncio


async def _run_with(client, aid, *, task_id=None, ended_ago=None, db=None, **toks):
    """Start+finish a worker_run with given usage fields; optionally backdate ended_at."""
    body = {"wake_kind": "ephemeral"}
    if task_id is not None:
        body["task_id"] = task_id
    r = await client.post(f"/api/agents/{aid}/runs", json=body)
    assert r.status_code == 201, r.text
    rid = r.json()["run_id"]
    f = await client.post(f"/api/runs/{rid}/finish",
                          json={"status": "exited", "exit_code": 0, **toks})
    assert f.status_code == 200, f.text
    if ended_ago and db is not None:
        db.execute(
            f"UPDATE worker_runs SET ended_at = now() - interval '{ended_ago}' WHERE run_id=%s",
            (rid,),
        )
    return rid


# --------------------------------------------------------------------------- #
# GET /api/containers/{cid}/metrics/agents/{aid}/spend
# --------------------------------------------------------------------------- #

async def test_spend_agent_header(client, make_agent, container):
    cid = container["id"]
    a = await make_agent("Forge", "eng")
    aid = a["agent_id"]
    r = await client.get(f"/api/containers/{cid}/metrics/agents/{aid}/spend")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agent"]["id"] == aid
    assert body["agent"]["alias"] == "Forge"
    assert body["window"] == "all"
    assert body["totals"]["runs"] == 0
    assert body["tasks"] == []


async def test_spend_rollup_sums_all_four_and_reports_cost_separately(client, make_agent, container, make_task):
    cid = container["id"]
    aid = (await make_agent("Burner", "eng"))["agent_id"]
    task = await make_task("Ship feature", "it ships")
    tid = task["id"]

    await _run_with(client, aid, task_id=tid, input_tokens=10, output_tokens=20,
                    cache_read_input_tokens=1000, cache_creation_input_tokens=5,
                    total_cost_usd=0.01)
    await _run_with(client, aid, task_id=tid, input_tokens=1, output_tokens=2,
                    cache_read_input_tokens=3, cache_creation_input_tokens=4,
                    total_cost_usd=0.02)

    body = (await client.get(f"/api/containers/{cid}/metrics/agents/{aid}/spend")).json()
    t = body["totals"]
    assert t["input_tokens"] == 11 and t["output_tokens"] == 22
    assert t["cache_read_input_tokens"] == 1003 and t["cache_creation_input_tokens"] == 9
    assert t["total_tokens"] == 11 + 22 + 1003 + 9         # quota signal: all 4 kinds
    assert abs(t["total_cost_usd"] - 0.03) < 1e-9           # dollars separate, never folded in
    assert t["runs"] == 2

    assert len(body["tasks"]) == 1
    task_row = body["tasks"][0]
    assert task_row["task_id"] == tid
    assert task_row["title"] == "Ship feature"
    assert task_row["total_tokens"] == t["total_tokens"]
    assert task_row["runs"] == 2
    assert task_row["first_run_at"] is not None and task_row["last_run_at"] is not None


async def test_spend_null_task_becomes_synthetic_conversation_row(client, make_agent, container):
    cid = container["id"]
    aid = (await make_agent("Drainer", "eng"))["agent_id"]
    # no task_id + non-task wake_event so it stays NULL, not lazily attributed
    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "wake_event": "conversation_turn"})
    rid = r.json()["run_id"]
    await client.post(f"/api/runs/{rid}/finish",
                      json={"status": "exited", "exit_code": 0,
                            "input_tokens": 5, "output_tokens": 5,
                            "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                            "total_cost_usd": 0.001})

    body = (await client.get(f"/api/containers/{cid}/metrics/agents/{aid}/spend")).json()
    assert len(body["tasks"]) == 1
    row = body["tasks"][0]
    assert row["task_id"] is None
    assert row["title"] == "Conversation & drains"
    assert row["status"] is None
    assert row["total_tokens"] == 10


async def test_spend_null_usage_row_excluded(client, make_agent, container):
    """A clean finish with NO usage fields (all-NULL) is not 'measured' — mirrors the meter."""
    cid = container["id"]
    aid = (await make_agent("Quiet", "eng"))["agent_id"]
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    rid = r.json()["run_id"]
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})

    body = (await client.get(f"/api/containers/{cid}/metrics/agents/{aid}/spend")).json()
    assert body["totals"]["runs"] == 0
    assert body["tasks"] == []


async def test_spend_sorted_by_total_tokens_desc(client, make_agent, container, make_task):
    cid = container["id"]
    aid = (await make_agent("Sorter", "eng"))["agent_id"]
    t_small = await make_task("Small task", "dod")
    t_big = await make_task("Big task", "dod")

    await _run_with(client, aid, task_id=t_small["id"], input_tokens=10, output_tokens=10,
                    cache_read_input_tokens=0, cache_creation_input_tokens=0)
    await _run_with(client, aid, task_id=t_big["id"], input_tokens=1000, output_tokens=1000,
                    cache_read_input_tokens=0, cache_creation_input_tokens=0)

    body = (await client.get(f"/api/containers/{cid}/metrics/agents/{aid}/spend")).json()
    titles = [row["title"] for row in body["tasks"]]
    assert titles == ["Big task", "Small task"]


async def test_spend_window_filtering(client, make_agent, container, db):
    """A wake older than 5h but inside 7d counts toward 7d/all, not 5h."""
    cid = container["id"]
    aid = (await make_agent("Windowed", "eng"))["agent_id"]
    await _run_with(client, aid, input_tokens=1000, output_tokens=0,
                    cache_read_input_tokens=0, cache_creation_input_tokens=0,
                    ended_ago="6 hours", db=db)
    await _run_with(client, aid, input_tokens=7, output_tokens=0,
                    cache_read_input_tokens=0, cache_creation_input_tokens=0)

    w5h = (await client.get(f"/api/containers/{cid}/metrics/agents/{aid}/spend?window=5h")).json()
    assert w5h["totals"]["total_tokens"] == 7
    assert w5h["totals"]["runs"] == 1

    w7d = (await client.get(f"/api/containers/{cid}/metrics/agents/{aid}/spend?window=7d")).json()
    assert w7d["totals"]["total_tokens"] == 1007

    wall = (await client.get(f"/api/containers/{cid}/metrics/agents/{aid}/spend?window=all")).json()
    assert wall["totals"]["total_tokens"] == 1007


async def test_spend_membership_gate_matches_meter(client, make_agent, container, monkeypatch):
    """Trusted non-member on a MAPPED container → 403 (same guard as the meter)."""
    cid = container["id"]
    aid = (await make_agent("Gated", "eng"))["agent_id"]
    from portal_backend import identity_routes

    monkeypatch.setattr(identity_routes, "proxy_login", lambda request: "intruder")
    monkeypatch.setattr(identity_routes, "container_mapped", lambda cur, container_id: True)
    monkeypatch.setattr(identity_routes, "find_member_by_login", lambda cur, container_id, login: None)

    r = await client.get(f"/api/containers/{cid}/metrics/agents/{aid}/spend")
    assert r.status_code == 403


async def test_spend_bad_uuid_and_missing(client, make_agent, container):
    cid = container["id"]
    assert (await client.get(f"/api/containers/{cid}/metrics/agents/not-a-uuid/spend")).status_code == 400
    assert (await client.get(f"/api/containers/not-a-uuid/metrics/agents/{uuid.uuid4()}/spend")).status_code == 400
    r = await client.get(f"/api/containers/{cid}/metrics/agents/{uuid.uuid4()}/spend")
    assert r.status_code == 404
    r2 = await client.get(f"/api/containers/{uuid.uuid4()}/metrics/agents/{uuid.uuid4()}/spend")
    assert r2.status_code == 404


# --------------------------------------------------------------------------- #
# GET /api/containers/{cid}/metrics/insights
# --------------------------------------------------------------------------- #

async def test_insights_empty_container_no_insights(client, container):
    r = await client.get(f"/api/containers/{container['id']}/metrics/insights")
    assert r.status_code == 200
    assert r.json()["insights"] == []
    assert r.json()["window"] == "7d"


async def test_insights_silent_under_data_floor(client, make_agent, container):
    """Fewer than MIN_RUNS_FOR_RULE (5) runs — even with an extreme cold-context ratio — stays silent."""
    cid = container["id"]
    aid = (await make_agent("TooFew", "eng"))["agent_id"]
    for _ in range(3):
        await _run_with(client, aid, input_tokens=1000, output_tokens=100,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    assert body["insights"] == []


async def test_insight_cold_context_fires(client, make_agent, container):
    cid = container["id"]
    aid = (await make_agent("ColdOne", "eng"))["agent_id"]
    # cache_read tiny relative to input across >=5 runs: ratio << 0.3
    for _ in range(6):
        await _run_with(client, aid, input_tokens=1000, output_tokens=100,
                        cache_read_input_tokens=10, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert f"cold-context:{aid}" in ids
    hit = next(i for i in body["insights"] if i["id"] == f"cold-context:{aid}")
    assert hit["severity"] == "high"
    assert "rewarms context" in hit["title"]
    assert hit["evidence"]["cache_hit_ratio"] < 0.3


async def test_insight_cold_context_silent_when_cache_healthy(client, make_agent, container):
    cid = container["id"]
    aid = (await make_agent("WarmOne", "eng"))["agent_id"]
    for _ in range(6):
        await _run_with(client, aid, input_tokens=100, output_tokens=100,
                        cache_read_input_tokens=1000, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert f"cold-context:{aid}" not in ids


async def test_insight_wake_churn_fires(client, make_agent, container):
    cid = container["id"]
    aid = (await make_agent("Churner", "eng"))["agent_id"]
    # 4 of 6 runs (>40%) produce <500 output tokens
    for _ in range(4):
        await _run_with(client, aid, input_tokens=50, output_tokens=10,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0)
    for _ in range(2):
        await _run_with(client, aid, input_tokens=50, output_tokens=2000,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert f"wake-churn:{aid}" in ids
    hit = next(i for i in body["insights"] if i["id"] == f"wake-churn:{aid}")
    assert hit["severity"] == "medium"
    assert hit["evidence"]["tiny_runs"] == 4


async def test_insight_wake_churn_silent_under_threshold(client, make_agent, container):
    cid = container["id"]
    aid = (await make_agent("Steady", "eng"))["agent_id"]
    # only 1 of 6 tiny (< 40%)
    await _run_with(client, aid, input_tokens=50, output_tokens=10,
                    cache_read_input_tokens=0, cache_creation_input_tokens=0)
    for _ in range(5):
        await _run_with(client, aid, input_tokens=50, output_tokens=2000,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert f"wake-churn:{aid}" not in ids


async def test_insight_context_bloat_fires(client, make_agent, container, make_task):
    cid = container["id"]
    aid = (await make_agent("Bloater", "eng"))["agent_id"]
    task = await make_task("Overscoped task", "dod")
    tid = task["id"]
    # input > 8x output, total > 100k, across >=5 runs on the SAME task
    for _ in range(5):
        await _run_with(client, aid, task_id=tid, input_tokens=25000, output_tokens=100,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert f"context-bloat:{tid}" in ids
    hit = next(i for i in body["insights"] if i["id"] == f"context-bloat:{tid}")
    assert hit["evidence"]["task_title"] == "Overscoped task"


async def test_insight_context_bloat_silent_when_scoped_well(client, make_agent, container, make_task):
    cid = container["id"]
    aid = (await make_agent("WellScoped", "eng"))["agent_id"]
    task = await make_task("Tight task", "dod")
    tid = task["id"]
    for _ in range(5):
        await _run_with(client, aid, task_id=tid, input_tokens=1000, output_tokens=800,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert f"context-bloat:{tid}" not in ids


async def test_insight_heavy_model_small_talk_fires(client, make_agent, container, db):
    cid = container["id"]
    aid = (await make_agent("Chatty", "eng"))["agent_id"]
    db.execute("UPDATE agents SET model=%s WHERE id=%s", ("claude-opus-5", aid))
    for _ in range(6):
        await _run_with(client, aid, input_tokens=200, output_tokens=100,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert f"heavy-model-small-talk:{aid}" in ids
    hit = next(i for i in body["insights"] if i["id"] == f"heavy-model-small-talk:{aid}")
    assert hit["evidence"]["model"] == "claude-opus-5"


async def test_insight_heavy_model_silent_on_light_model(client, make_agent, container, db):
    cid = container["id"]
    aid = (await make_agent("SonnetUser", "eng"))["agent_id"]
    db.execute("UPDATE agents SET model=%s WHERE id=%s", ("claude-sonnet-5", aid))
    for _ in range(6):
        await _run_with(client, aid, input_tokens=200, output_tokens=100,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert f"heavy-model-small-talk:{aid}" not in ids


async def test_insight_heavy_model_silent_when_output_is_substantial(client, make_agent, container, db):
    cid = container["id"]
    aid = (await make_agent("BusyOpus", "eng"))["agent_id"]
    db.execute("UPDATE agents SET model=%s WHERE id=%s", ("claude-fable-5", aid))
    for _ in range(6):
        await _run_with(client, aid, input_tokens=2000, output_tokens=5000,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert f"heavy-model-small-talk:{aid}" not in ids


async def test_insight_concentration_fires_with_task_title(client, make_agent, container, make_task):
    cid = container["id"]
    aid = (await make_agent("BigSpender", "eng"))["agent_id"]
    expensive = await make_task("Expensive task", "dod")
    cheap = await make_task("Cheap task", "dod")
    await _run_with(client, aid, task_id=expensive["id"], input_tokens=10, output_tokens=10,
                    cache_read_input_tokens=0, cache_creation_input_tokens=0, total_cost_usd=10.0)
    await _run_with(client, aid, task_id=cheap["id"], input_tokens=10, output_tokens=10,
                    cache_read_input_tokens=0, cache_creation_input_tokens=0, total_cost_usd=1.0)

    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    hit = next(i for i in body["insights"] if i["id"] == f"concentration:{expensive['id']}")
    assert hit["severity"] == "info"
    assert "Expensive task" in hit["title"]
    assert hit["evidence"]["fraction"] > 0.4


async def test_insight_concentration_silent_when_spend_is_spread(client, make_agent, container, make_task):
    cid = container["id"]
    aid = (await make_agent("Spreader", "eng"))["agent_id"]
    tasks = [await make_task(f"Task {i}", "dod") for i in range(4)]
    for t in tasks:
        await _run_with(client, aid, task_id=t["id"], input_tokens=10, output_tokens=10,
                        cache_read_input_tokens=0, cache_creation_input_tokens=0, total_cost_usd=1.0)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    assert not any(i["id"].startswith("concentration:") for i in body["insights"])


async def test_insight_cache_write_churn_fires(client, make_agent, container):
    cid = container["id"]
    aid = (await make_agent("CacheBurner", "eng"))["agent_id"]
    # cache creation far exceeds cache reads across the window
    for _ in range(6):
        await _run_with(client, aid, input_tokens=100, output_tokens=100,
                        cache_read_input_tokens=10, cache_creation_input_tokens=5000)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert "cache-write-churn:window" in ids
    hit = next(i for i in body["insights"] if i["id"] == "cache-write-churn:window")
    assert hit["severity"] == "high"
    assert hit["evidence"]["read_to_creation_ratio"] < 1


async def test_insight_cache_write_churn_silent_when_reused(client, make_agent, container):
    cid = container["id"]
    aid = (await make_agent("CacheReuser", "eng"))["agent_id"]
    for _ in range(6):
        await _run_with(client, aid, input_tokens=100, output_tokens=100,
                        cache_read_input_tokens=5000, cache_creation_input_tokens=100)
    body = (await client.get(f"/api/containers/{cid}/metrics/insights?window=all")).json()
    ids = [i["id"] for i in body["insights"]]
    assert "cache-write-churn:window" not in ids


async def test_insights_bad_uuid(client):
    assert (await client.get("/api/containers/not-a-uuid/metrics/insights")).status_code == 400
    r = await client.get(f"/api/containers/{uuid.uuid4()}/metrics/insights")
    assert r.status_code == 404


async def test_insights_window_query_validation(client, container):
    """window only accepts 7d|all here (unlike spend's 5h|7d|all) — 5h is not a valid insights window."""
    r = await client.get(f"/api/containers/{container['id']}/metrics/insights?window=5h")
    assert r.status_code == 422
