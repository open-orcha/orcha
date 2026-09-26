"""Metrics dashboard — GET /api/containers/{cid}/metrics aggregation math.

Covers the cost-extraction ladder (daemon-recorded mig-019 columns first, then a
defensive parse of the captured stream-json output TAIL; absent/garbled → 0 and
excluded from runs_with_cost), window filtering, per-agent totals + cost-desc
ordering, daily gap-fill, sandbox wall-clock attribution, and the task
completed/verified counters. Seeded through the real run lifecycle API
(POST /runs + /finish); timestamps are backdated through the db fixture because
the API always stamps now().
"""
import json
import uuid

from portal_backend.container_metrics_routes import parse_output_tail

CLAUDE_TAIL = (
    '{"type":"system","subtype":"init"}\n'
    '{"type":"assistant","message":{"content":[{"type":"text","text":"done; the result is in"}]}}\n'
    '{"type":"result","subtype":"success","num_turns":3,"total_cost_usd":0.25,'
    '"usage":{"input_tokens":100,"output_tokens":40,"cache_read_input_tokens":9000,'
    '"cache_creation_input_tokens":50}}'
)


# --------------------------------------------------------------------------- #
# parse_output_tail — the defensive tail parser
# --------------------------------------------------------------------------- #

def test_parse_tail_claude_result():
    parsed = parse_output_tail(CLAUDE_TAIL)
    assert parsed == {"cost": 0.25, "tokens_in": 100, "tokens_out": 40}


def test_parse_tail_survives_truncated_head_line():
    # SQL right() cuts mid-line: the OLDEST tail line is garbled, the terminal
    # result record is intact — the parser must still find it.
    truncated = CLAUDE_TAIL[10:]
    assert not truncated.startswith("{")         # mid-JSON garbage up front
    assert parse_output_tail(truncated)["cost"] == 0.25


def test_parse_tail_garbled_and_absent_degrade_to_none():
    assert parse_output_tail(None) is None
    assert parse_output_tail("") is None
    assert parse_output_tail("plain text, not stream-json") is None
    assert parse_output_tail('{"type":"assistant"}') is None          # no terminal record
    assert parse_output_tail('{"type":"result",') is None             # garbled result line
    # a result record with garbled/absent numbers → keys None, never a crash
    parsed = parse_output_tail('{"type":"result","total_cost_usd":"oops"}')
    assert parsed == {"cost": None, "tokens_in": None, "tokens_out": None}


def test_parse_tail_reads_last_result():
    two = (
        '{"type":"result","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1}}\n'
        '{"type":"result","total_cost_usd":0.09,"usage":{"input_tokens":9,"output_tokens":9}}'
    )
    assert parse_output_tail(two)["cost"] == 0.09


def test_parse_tail_codex_turn_end_has_tokens_no_cost():
    codex = (
        '{"type":"item.completed","item":{"type":"agent_message"}}\n'
        '{"type":"turn.completed","usage":{"input_tokens":70,"cached_input_tokens":10,"output_tokens":30}}'
    )
    assert parse_output_tail(codex) == {"cost": None, "tokens_in": 70, "tokens_out": 30}
    nested = '{"msg":{"type":"turn_complete","usage":{"input_tokens":5,"output_tokens":6}}}'
    assert parse_output_tail(nested) == {"cost": None, "tokens_in": 5, "tokens_out": 6}


# --------------------------------------------------------------------------- #
# endpoint helpers
# --------------------------------------------------------------------------- #

async def _run(client, aid, *, wake_kind="ephemeral", status="exited", exit_code=0,
               output=None, finish_extra=None):
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": wake_kind})
    assert r.status_code == 201, r.text
    rid = r.json()["run_id"]
    body = {"status": status, "exit_code": exit_code}
    if output is not None:
        body["output"] = output
    body.update(finish_extra or {})
    f = await client.post(f"/api/runs/{rid}/finish", json=body)
    assert f.status_code == 200, f.text
    return rid


async def _metrics(client, cid, days=7):
    r = await client.get(f"/api/containers/{cid}/metrics", params={"days": days})
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- #
# endpoint math
# --------------------------------------------------------------------------- #

async def test_metrics_costs_from_tails_and_columns_with_n_of_m(client, container, make_agent):
    """Costs come from parsed tails AND daemon-recorded columns; garbled/absent
    rows contribute 0 and stay out of runs_with_cost (the N of M caption)."""
    cid = container["id"]
    aid = (await make_agent("W", "eng"))["agent_id"]
    await _run(client, aid, output=CLAUDE_TAIL)                       # parsed: 0.25
    await _run(client, aid, output="garbage not json")                # no cost
    await _run(client, aid)                                           # absent output
    await _run(client, aid, finish_extra={                            # daemon-recorded: 0.75
        "input_tokens": 10, "output_tokens": 20, "total_cost_usd": 0.75})
    d = await _metrics(client, cid)
    t = d["totals"]
    assert t["runs"] == 4
    assert t["est_cost_usd"] == 1.0
    assert t["runs_with_cost"] == 2                                   # honest: 2 of 4 reported
    assert t["tokens_in"] == 110 and t["tokens_out"] == 60


async def test_metrics_recorded_columns_beat_tail_parse(client, container, make_agent, db):
    """When the daemon recorded usage (mig 019), those columns win over the tail."""
    cid = container["id"]
    aid = (await make_agent("W", "eng"))["agent_id"]
    rid = await _run(client, aid, output=CLAUDE_TAIL, finish_extra={
        "input_tokens": 1, "output_tokens": 2, "total_cost_usd": 0.5})
    d = await _metrics(client, cid)
    assert d["totals"]["est_cost_usd"] == 0.5                         # not 0.25 from the tail
    assert d["totals"]["tokens_in"] == 1 and d["totals"]["tokens_out"] == 2
    assert d["totals"]["runs_with_cost"] == 1
    assert rid  # lifecycle sanity


async def test_metrics_window_filters_out_old_runs(client, container, make_agent, db):
    cid = container["id"]
    aid = (await make_agent("W", "eng"))["agent_id"]
    inside = await _run(client, aid, output=CLAUDE_TAIL)
    outside = await _run(client, aid, output=CLAUDE_TAIL)
    db.execute(
        "UPDATE worker_runs SET started_at=now() - interval '9 days', "
        "ended_at=now() - interval '9 days' WHERE run_id=%s", (outside,))
    d = await _metrics(client, cid, days=7)
    assert d["totals"]["runs"] == 1 and d["totals"]["est_cost_usd"] == 0.25
    d30 = await _metrics(client, cid, days=30)
    assert d30["totals"]["runs"] == 2 and d30["totals"]["est_cost_usd"] == 0.5
    assert inside  # lifecycle sanity


async def test_metrics_per_agent_totals_sorted_by_cost_desc(client, container, make_agent, db):
    cid = container["id"]
    cheap = (await make_agent("Cheap", "eng"))["agent_id"]
    spendy = (await make_agent("Spendy", "eng"))["agent_id"]
    await _run(client, cheap, output=CLAUDE_TAIL)                                   # 0.25
    await _run(client, spendy, finish_extra={"total_cost_usd": 2.0})
    await _run(client, spendy, status="killed", exit_code=-9)                       # failed, no cost
    await _run(client, spendy, exit_code=3)                                         # exited non-zero → failed
    d = await _metrics(client, cid)
    aliases = [a["alias"] for a in d["per_agent"]]
    assert aliases == ["Spendy", "Cheap"]                                           # cost desc
    spendy_row = d["per_agent"][0]
    assert spendy_row["runs"] == 3
    assert spendy_row["ok_runs"] == 1 and spendy_row["failed_runs"] == 2
    assert spendy_row["est_cost_usd"] == 2.0
    assert spendy_row["last_active"] is not None
    assert d["per_agent"][1]["tokens_in"] == 100
    # model rides the roster row for the UI tag
    assert "model" in spendy_row and "agent_id" in spendy_row


async def test_metrics_daily_gap_fill_and_bucketing(client, container, make_agent, db):
    cid = container["id"]
    aid = (await make_agent("W", "eng"))["agent_id"]
    today_run = await _run(client, aid, output=CLAUDE_TAIL)
    old_run = await _run(client, aid, output=CLAUDE_TAIL)
    db.execute(
        "UPDATE worker_runs SET started_at=now() - interval '3 days', "
        "ended_at=now() - interval '3 days' WHERE run_id=%s", (old_run,))
    d = await _metrics(client, cid, days=7)
    days = d["daily"]
    assert len(days) == 7                                             # full window, gaps filled
    assert [x["date"] for x in days] == sorted(x["date"] for x in days)
    assert sum(x["runs"] for x in days) == 2
    assert days[-1]["runs"] == 1                                      # today's bucket
    zero_days = [x for x in days if x["runs"] == 0]
    assert len(zero_days) == 5
    assert all(x["est_cost_usd"] == 0 and x["sandbox_seconds"] == 0 for x in zero_days)
    assert today_run  # lifecycle sanity


async def test_metrics_sandbox_seconds_only_from_sandbox_rows(client, container, make_agent, db):
    cid = container["id"]
    aid = (await make_agent("W", "eng"))["agent_id"]
    sbx = await _run(client, aid, wake_kind="sandbox")
    eph = await _run(client, aid, wake_kind="ephemeral")
    db.execute(
        "UPDATE worker_runs SET started_at=ended_at - interval '90 seconds' "
        "WHERE run_id IN (%s, %s)", (sbx, eph))
    d = await _metrics(client, cid)
    assert d["totals"]["sandbox_seconds"] == 90.0                     # ephemeral time excluded
    assert d["per_agent"][0]["sandbox_seconds"] == 90.0


async def test_metrics_tasks_completed_and_verified_in_window(
        client, container, make_agent, make_task, db):
    cid = container["id"]
    human = (await make_agent("Boss", "owner", kind="human"))["agent_id"]
    await make_agent("W", "eng")
    t1 = (await make_task("T1", "dod", assignee_alias="W"))["id"]
    t2 = (await make_task("T2", "dod", assignee_alias="W"))["id"]
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id IN (%s,%s)", (t1, t2))
    for tid in (t1, t2):
        r = await client.post(f"/api/tasks/{tid}/verify",
                              json={"actor_agent_id": human, "approve": True})
        assert r.status_code == 200, r.text
    # push one completion + its audit event out of the window
    db.execute("UPDATE tasks SET completed_at=now() - interval '9 days' WHERE id=%s", (t2,))
    db.execute(
        "UPDATE events SET created_at=now() - interval '9 days' "
        "WHERE entity_type='task' AND entity_id=%s AND event_type='verified'", (t2,))
    d = await _metrics(client, cid, days=7)
    assert d["totals"]["tasks_completed"] == 1
    assert d["totals"]["tasks_verified"] == 1
    d30 = await _metrics(client, cid, days=30)
    assert d30["totals"]["tasks_completed"] == 2
    assert d30["totals"]["tasks_verified"] == 2


async def test_metrics_empty_container_and_guards(client, container):
    cid = container["id"]
    d = await _metrics(client, cid)
    assert d["totals"]["runs"] == 0 and d["totals"]["est_cost_usd"] == 0
    assert d["per_agent"] == []
    assert len(d["daily"]) == 7 and all(x["runs"] == 0 for x in d["daily"])
    assert (await client.get("/api/containers/not-a-uuid/metrics")).status_code == 400
    missing = uuid.uuid4()
    assert (await client.get(f"/api/containers/{missing}/metrics")).status_code == 404
    assert (await client.get(f"/api/containers/{cid}/metrics",
                             params={"days": 0})).status_code == 422
    assert (await client.get(f"/api/containers/{cid}/metrics",
                             params={"days": 91})).status_code == 422


async def test_metrics_output_tail_is_capped_in_sql(client, container, make_agent):
    """A multi-megabyte output row still yields its cost: the result record rides
    the last 4KB, which is exactly what the SQL right() hauls."""
    cid = container["id"]
    aid = (await make_agent("W", "eng"))["agent_id"]
    huge = "\n".join(
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text",
                    "text": "x" * 200}]}}) for _ in range(5000)
    ) + "\n" + CLAUDE_TAIL.splitlines()[-1]
    await _run(client, aid, output=huge)
    d = await _metrics(client, cid)
    assert d["totals"]["est_cost_usd"] == 0.25
    assert d["totals"]["runs_with_cost"] == 1
