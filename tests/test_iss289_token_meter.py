"""#289 (EFFICIENCY epic, measurement backbone) — per-wake token accounting + the
tokens-vs-quota meter (GET /api/containers/{cid}/token-usage) + the notifier log parser."""
import json

from orcha_cli import notifier


# --------------------------------------------------------------------------- #
# notifier._usage_from_log — parse the terminal stream-json `result` event
# --------------------------------------------------------------------------- #

def _write_log(tmp_path, *lines) -> str:
    p = tmp_path / "wake.jsonl"
    p.write_text("".join(json.dumps(o) + "\n" for o in lines))
    return str(p)


def test_usage_from_log_extracts_all_five(tmp_path):
    log = _write_log(
        tmp_path,
        {"type": "system", "subtype": "init"},
        {"type": "assistant", "message": {"content": []}},
        {"type": "result", "subtype": "success", "num_turns": 3,
         "total_cost_usd": 0.1234,
         "usage": {"input_tokens": 11, "output_tokens": 22,
                   "cache_read_input_tokens": 333, "cache_creation_input_tokens": 44}},
    )
    u = notifier._usage_from_log(log)
    assert u == {"input_tokens": 11, "output_tokens": 22,
                 "cache_read_input_tokens": 333, "cache_creation_input_tokens": 44,
                 "total_cost_usd": 0.1234}


def test_usage_from_log_missing_usage_degrades_to_none(tmp_path):
    # a result event with no usage object → every token key None (never a crash / KeyError)
    log = _write_log(tmp_path, {"type": "result", "subtype": "error_max_turns"})
    u = notifier._usage_from_log(log)
    assert u == {"input_tokens": None, "output_tokens": None,
                 "cache_read_input_tokens": None, "cache_creation_input_tokens": None,
                 "total_cost_usd": None}


def test_usage_from_log_reads_last_result(tmp_path):
    # a resident logs one result per turn; we take the LAST (cumulative for its final turn)
    log = _write_log(
        tmp_path,
        {"type": "result", "usage": {"input_tokens": 1, "output_tokens": 1,
                                     "cache_read_input_tokens": 1, "cache_creation_input_tokens": 1}},
        {"type": "result", "usage": {"input_tokens": 9, "output_tokens": 8,
                                     "cache_read_input_tokens": 7, "cache_creation_input_tokens": 6}},
    )
    u = notifier._usage_from_log(log)
    assert u["input_tokens"] == 9 and u["cache_read_input_tokens"] == 7


def test_usage_from_log_no_result_or_missing_file(tmp_path):
    # no terminal result line yet → empty dict (nothing to record)
    assert notifier._usage_from_log(_write_log(tmp_path, {"type": "assistant"})) == {}
    # no log path → empty dict
    assert notifier._usage_from_log(None) == {}
    # unreadable path → empty dict (degrades, never raises)
    assert notifier._usage_from_log(str(tmp_path / "nope.jsonl")) == {}


# --------------------------------------------------------------------------- #
# /finish persists the five token fields onto worker_runs
# --------------------------------------------------------------------------- #

async def test_finish_persists_token_usage(client, make_agent, db):
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "ephemeral"})).json()["run_id"]
    f = await client.post(f"/api/runs/{rid}/finish",
                          json={"status": "exited", "exit_code": 0,
                                "input_tokens": 100, "output_tokens": 200,
                                "cache_read_input_tokens": 5000,
                                "cache_creation_input_tokens": 50, "total_cost_usd": 0.0042})
    assert f.status_code == 200
    row = db.execute("SELECT * FROM worker_runs WHERE run_id=%s", (rid,))[0]
    assert row["input_tokens"] == 100 and row["output_tokens"] == 200
    assert row["cache_read_input_tokens"] == 5000 and row["cache_creation_input_tokens"] == 50
    assert float(row["total_cost_usd"]) == 0.0042

    # a clean finish that carries NO token fields leaves them NULL (pre-019 / usage-less wake)
    rid2 = (await client.post(f"/api/agents/{aid}/runs",
                              json={"wake_kind": "ephemeral"})).json()["run_id"]
    await client.post(f"/api/runs/{rid2}/finish", json={"status": "exited", "exit_code": 0})
    row2 = db.execute("SELECT * FROM worker_runs WHERE run_id=%s", (rid2,))[0]
    assert row2["input_tokens"] is None and row2["total_cost_usd"] is None


# --------------------------------------------------------------------------- #
# GET /api/containers/{cid}/token-usage — aggregation, windowing, quota, breakdown
# --------------------------------------------------------------------------- #

async def _finish_with(client, aid, **toks):
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "ephemeral"})).json()["run_id"]
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0, **toks})
    return rid


async def test_token_usage_aggregates_and_sums_all_four(client, make_agent, container):
    cid = container["id"]
    a = await make_agent("Burner", "eng")
    aid = a["agent_id"]
    await _finish_with(client, aid, input_tokens=10, output_tokens=20,
                       cache_read_input_tokens=1000, cache_creation_input_tokens=5,
                       total_cost_usd=0.01)
    await _finish_with(client, aid, input_tokens=1, output_tokens=2,
                       cache_read_input_tokens=3, cache_creation_input_tokens=4,
                       total_cost_usd=0.02)

    r = await client.get(f"/api/containers/{cid}/token-usage")
    assert r.status_code == 200, r.text
    body = r.json()
    allw = body["windows"]["all"]
    assert allw["input_tokens"] == 11 and allw["output_tokens"] == 22
    assert allw["cache_read_input_tokens"] == 1003 and allw["cache_creation_input_tokens"] == 9
    # total_tokens sums ALL FOUR kinds (cache reads count against quota) — the headline number
    assert allw["total_tokens"] == 11 + 22 + 1003 + 9
    assert allw["runs"] == 2
    assert abs(allw["total_cost_usd"] - 0.03) < 1e-9

    # per-agent breakdown + last_wake (the per-wake number) present
    assert body["per_agent"][0]["alias"] == "Burner"
    assert body["per_agent"][0]["total_tokens"] == allw["total_tokens"]
    assert body["last_wake"]["agent_alias"] == "Burner"
    assert body["last_wake"]["total_tokens"] == 1 + 2 + 3 + 4   # the most-recent wake only


async def test_token_usage_windowing(client, make_agent, container, db):
    """A wake older than 5h but inside 7d counts toward 7d/all, NOT 5h — the FILTER must bite."""
    cid = container["id"]
    aid = (await make_agent("W", "eng"))["agent_id"]
    old = await _finish_with(client, aid, input_tokens=1000, output_tokens=0,
                             cache_read_input_tokens=0, cache_creation_input_tokens=0)
    db.execute("UPDATE worker_runs SET ended_at = now() - interval '6 hours' WHERE run_id=%s", (old,))
    await _finish_with(client, aid, input_tokens=7, output_tokens=0,
                       cache_read_input_tokens=0, cache_creation_input_tokens=0)  # fresh

    w = (await client.get(f"/api/containers/{cid}/token-usage")).json()["windows"]
    assert w["5h"]["total_tokens"] == 7            # the 6h-old wake is excluded
    assert w["5h"]["runs"] == 1
    assert w["7d"]["total_tokens"] == 1007         # both inside the week
    assert w["all"]["total_tokens"] == 1007


async def test_token_usage_quota_pct(client, make_agent, container, monkeypatch):
    cid = container["id"]
    aid = (await make_agent("W", "eng"))["agent_id"]
    await _finish_with(client, aid, input_tokens=50, output_tokens=50,
                       cache_read_input_tokens=0, cache_creation_input_tokens=0)  # total 100

    # no env pinned → no invented number
    w = (await client.get(f"/api/containers/{cid}/token-usage")).json()["windows"]
    assert w["5h"]["quota_tokens"] is None and w["5h"]["pct_of_quota"] is None

    # operator pins the 5h ceiling → pct surfaces (100 / 1000 = 10%)
    monkeypatch.setenv("ORCHA_QUOTA_5H_TOKENS", "1000")
    w = (await client.get(f"/api/containers/{cid}/token-usage")).json()["windows"]
    assert w["5h"]["quota_tokens"] == 1000 and w["5h"]["pct_of_quota"] == 10.0
    assert w["7d"]["pct_of_quota"] is None         # weekly quota not pinned → still null

    # an invalid / non-positive value is ignored (never a divide-by-zero or crash)
    monkeypatch.setenv("ORCHA_QUOTA_5H_TOKENS", "0")
    w = (await client.get(f"/api/containers/{cid}/token-usage")).json()["windows"]
    assert w["5h"]["quota_tokens"] is None and w["5h"]["pct_of_quota"] is None


async def test_token_usage_empty_container(client, container):
    """No finished wakes → zeros everywhere, last_wake null, never a 500."""
    r = await client.get(f"/api/containers/{container['id']}/token-usage")
    assert r.status_code == 200
    body = r.json()
    assert body["windows"]["all"]["total_tokens"] == 0 and body["windows"]["all"]["runs"] == 0
    assert body["per_agent"] == [] and body["last_wake"] is None


async def test_token_usage_bad_uuid_and_missing(client):
    assert (await client.get("/api/containers/not-a-uuid/token-usage")).status_code == 400
    import uuid
    r = await client.get(f"/api/containers/{uuid.uuid4()}/token-usage")
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# REWORK (Gate 2nd-pass) teeth
# --------------------------------------------------------------------------- #

async def test_finish_run_wires_usage_from_log(client, make_agent, db, tmp_path, monkeypatch):
    """Integration WIRING tooth: notifier._finish_run must parse its log and attach the five usage
    fields to the /finish body. Drop `**_usage_from_log(log_path)` from _finish_run and the body
    loses them → the persisted worker_run stays NULL → this goes RED. The isolated parser +
    /finish-persistence tests both stay green when that wiring is cut, so neither catches it."""
    aid = (await make_agent("W", "eng"))["agent_id"]
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "ephemeral"})).json()["run_id"]
    log = _write_log(
        tmp_path,
        {"type": "result", "subtype": "success", "total_cost_usd": 0.5,
         "usage": {"input_tokens": 7, "output_tokens": 8,
                   "cache_read_input_tokens": 9, "cache_creation_input_tokens": 10}},
    )
    # _finish_run posts via _post_json (a real HTTP call); capture the body it built and replay it
    # through the in-process app so the row is persisted with exactly what _finish_run assembled.
    captured = {}
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body: captured.update(url=url, body=body))
    notifier._finish_run("", rid, "exited", 0, log)
    assert captured["url"] == f"/api/runs/{rid}/finish"
    await client.post(captured["url"], json=captured["body"])

    row = db.execute("SELECT * FROM worker_runs WHERE run_id=%s", (rid,))[0]
    assert row["input_tokens"] == 7 and row["output_tokens"] == 8
    assert row["cache_read_input_tokens"] == 9 and row["cache_creation_input_tokens"] == 10
    assert float(row["total_cost_usd"]) == 0.5


async def test_usage_less_ended_run_excluded(client, make_agent, container, db):
    """An ENDED wake with ALL-NULL usage is NOT a measured wake (pre-mig-019 / unparseable result):
    it must not inflate `runs`, must not surface as last_wake, and contributes 0 tokens. Bites the
    measured-predicate added to all three aggregations — drop it and runs becomes 2 / last_wake flips."""
    cid = container["id"]
    aid = (await make_agent("M", "eng"))["agent_id"]
    # one genuine measured wake
    await _finish_with(client, aid, input_tokens=5, output_tokens=5,
                       cache_read_input_tokens=0, cache_creation_input_tokens=0, total_cost_usd=0.01)
    # an ended-but-usage-less wake: clean finish carrying NO token fields → every usage col NULL
    rid_null = (await client.post(f"/api/agents/{aid}/runs",
                                  json={"wake_kind": "ephemeral"})).json()["run_id"]
    await client.post(f"/api/runs/{rid_null}/finish", json={"status": "exited", "exit_code": 0})
    # force it to be the MOST-RECENT ended row so an unfiltered last_wake query would surface it
    db.execute("UPDATE worker_runs SET ended_at = now() + interval '1 minute' WHERE run_id=%s",
               (rid_null,))

    body = (await client.get(f"/api/containers/{cid}/token-usage")).json()
    assert body["windows"]["all"]["runs"] == 1            # only the measured wake counts
    assert body["windows"]["all"]["total_tokens"] == 10
    assert body["windows"]["5h"]["runs"] == 1
    assert body["per_agent"][0]["runs"] == 1              # per-agent excludes the usage-less row
    assert body["per_agent"][0]["total_tokens"] == 10
    assert body["last_wake"]["run_id"] != rid_null        # never selects the usage-less wake
    assert body["last_wake"]["total_tokens"] == 10


def test_usage_from_log_malformed_final_line_fails_open(tmp_path):
    """A log whose LAST line is a half-written / malformed JSON object → {} (never a crash). Locks
    in the `except ValueError: return {}` fail-open Gate verified only with an ad-hoc probe."""
    p = tmp_path / "wake.jsonl"
    p.write_text(
        json.dumps({"type": "result",
                    "usage": {"input_tokens": 1, "output_tokens": 1,
                              "cache_read_input_tokens": 1, "cache_creation_input_tokens": 1}}) + "\n"
        + '{"type": "result", "usage": {"input_tokens": 99,'  # truncated final line, still being written
    )
    assert notifier._usage_from_log(str(p)) == {}
