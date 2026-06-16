"""A2 — worker_runs: persist + expose headless wake output (FT-ENGINE)."""
import uuid


async def test_worker_run_lifecycle_exited(client, make_agent):
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "wake_event": "request_created"})
    assert r.status_code == 201, r.text
    rid = r.json()["run_id"]
    assert r.json()["status"] == "running"

    # list shows it running
    lst = await client.get(f"/api/agents/{aid}/runs")
    assert lst.status_code == 200
    runs = lst.json()["runs"]
    assert len(runs) == 1 and runs[0]["run_id"] == rid and runs[0]["status"] == "running"
    assert runs[0]["ended_at"] is None

    # finish exited with stream-json output
    f = await client.post(f"/api/runs/{rid}/finish",
                          json={"status": "exited", "exit_code": 0,
                                "output": '{"type":"system"}\n{"type":"assistant"}'})
    assert f.status_code == 200 and f.json()["status"] == "exited"

    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["status"] == "exited" and run["exit_code"] == 0
    assert '"assistant"' in run["output"]          # the actual progress text is retrievable
    assert run["ended_at"] is not None


async def test_worker_run_killed_and_task_views(client, make_agent, make_task):
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    t = await make_task("T", "dod", assignee_alias="W")
    tid = t["id"]
    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "task_id": tid})
    rid = r.json()["run_id"]
    await client.post(f"/api/runs/{rid}/finish", json={"status": "killed", "exit_code": -9})

    # per-task endpoint shows the killed run
    pt = await client.get(f"/api/tasks/{tid}/runs")
    assert pt.status_code == 200
    assert pt.json()["runs"][0]["status"] == "killed" and pt.json()["runs"][0]["run_id"] == rid

    # agent endpoint with ?task_id filter
    flt = await client.get(f"/api/agents/{aid}/runs", params={"task_id": tid})
    assert len(flt.json()["runs"]) == 1 and flt.json()["runs"][0]["run_id"] == rid


async def test_finish_persists_and_surfaces_kill_reason(client, make_agent):
    """#270: the stall/hard-cap watchdog attaches a structured kill_reason on /finish; it persists
    and surfaces on the worker_runs API row. A clean exit leaves it NULL."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    # a killed run carries the diagnostic JSON
    rk = (await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})).json()["run_id"]
    reason = '{"cause": "stalled", "over_cap": false, "worker_is_live": false, "last_event_type": "assistant"}'
    f = await client.post(f"/api/runs/{rk}/finish",
                          json={"status": "killed", "exit_code": -9, "kill_reason": reason})
    assert f.status_code == 200
    # a clean exit carries no kill_reason
    re_ = (await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})).json()["run_id"]
    await client.post(f"/api/runs/{re_}/finish", json={"status": "exited", "exit_code": 0})

    rows = {r["run_id"]: r for r in (await client.get(f"/api/agents/{aid}/runs")).json()["runs"]}
    assert rows[rk]["kill_reason"] == reason          # killed row surfaces the structured reason
    assert rows[re_]["kill_reason"] is None           # clean exit → NULL


async def test_runs_newest_first(client, make_agent):
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    ids = []
    for _ in range(3):
        ids.append((await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})).json()["run_id"])
    got = [r["run_id"] for r in (await client.get(f"/api/agents/{aid}/runs")).json()["runs"]]
    assert got == list(reversed(ids))              # most-recent-first


async def test_worker_run_process_metadata_round_trips(client, make_agent):
    human = await make_agent("Human", "operator", kind="human")
    agent = await make_agent("W", "eng")
    aid = agent["agent_id"]
    conv = (await client.post(f"/api/agents/{aid}/conversations",
                              json={"actor_agent_id": human["agent_id"]})).json()["conversation"]

    r = await client.post(
        f"/api/agents/{aid}/runs",
        json={"wake_kind": "ephemeral", "wake_event": "conversation_turn",
              "pid": 12345, "runtime": "codex", "conversation_id": conv["id"],
              "conversation_ack_ts": 77.0,
              "log_path": "/tmp/codex.ndjson",
              "last_message_path": "/tmp/codex.ndjson.reply.txt",
              "worktree": "/tmp/wt", "branch": "orcha/W", "base_cwd": "/tmp/base"},
    )
    assert r.status_code == 201, r.text
    row = r.json()
    rid = row["run_id"]
    assert row["pid"] == 12345
    assert row["runtime"] == "codex"
    assert row["conversation_id"] == conv["id"]
    assert row["conversation_ack_ts"] == 77.0
    assert row["last_message_path"] == "/tmp/codex.ndjson.reply.txt"
    assert row["worktree"] == "/tmp/wt"
    assert row["branch"] == "orcha/W"
    assert row["base_cwd"] == "/tmp/base"

    listed = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert listed["run_id"] == rid
    assert listed["pid"] == 12345
    assert listed["runtime"] == "codex"
    assert listed["conversation_id"] == conv["id"]
    assert listed["conversation_ack_ts"] == 77.0


async def test_finish_unknown_run_404(client):
    r = await client.post(f"/api/runs/{uuid.uuid4()}/finish", json={"status": "exited"})
    assert r.status_code == 404, r.text


async def test_finish_bad_status_422(client, make_agent):
    a = await make_agent("W", "eng")
    rid = (await client.post(f"/api/agents/{a['agent_id']}/runs", json={"wake_kind": "ephemeral"})).json()["run_id"]
    r = await client.post(f"/api/runs/{rid}/finish", json={"status": "bogus"})
    assert r.status_code == 422, r.text


async def test_runs_unknown_agent_404(client):
    r = await client.get(f"/api/agents/{uuid.uuid4()}/runs")
    assert r.status_code == 404, r.text


async def test_start_run_unknown_task_404(client, make_agent):
    """A valid-but-unknown task_id must be a clean 404, not a 500 FK violation."""
    a = await make_agent("W", "eng")
    r = await client.post(f"/api/agents/{a['agent_id']}/runs",
                          json={"wake_kind": "ephemeral", "task_id": str(uuid.uuid4())})
    assert r.status_code == 404, r.text


async def test_worker_run_sse_streams_lines_then_closes(client, make_agent):
    """SSE: the stream tails the worker_run_lines table (ISS-39: one event per line the daemon
    POSTed) and closes with a terminal done event once the run is finished."""
    import json as J
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "ephemeral"})).json()["run_id"]
    # the daemon streams lines into the DB (no bind-mounted file involved)
    await client.post(f"/api/runs/{rid}/lines", json={"start_seq": 1, "lines": [
        '{"type":"system","subtype":"init"}', '{"type":"assistant","message":"hi"}']})
    # finish the run so the stream is finite (drains lines → done → closes)
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})

    r = await client.get(f"/api/agents/{aid}/runs/{rid}/stream")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    events = [J.loads(l[len("data:"):].strip()) for l in r.text.splitlines() if l.startswith("data:")]
    line_events = [e for e in events if "line" in e]
    assert any('"system"' in e["line"] for e in line_events)
    assert any("hi" in e["line"] for e in line_events)
    assert [e["seq"] for e in events] == sorted(e["seq"] for e in events)   # monotonic seq
    assert events[-1].get("done") is True and events[-1]["status"] == "exited"   # closes on finish


async def test_worker_run_lines_idempotent_and_404(client, make_agent):
    """ISS-39: POST /lines is idempotent on (run_id, seq) — a re-POSTed batch never duplicates —
    and an unknown run is a clean 404."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    rid = (await client.post(f"/api/agents/{aid}/runs",
                             json={"wake_kind": "ephemeral"})).json()["run_id"]
    body = {"start_seq": 1, "lines": ["a", "b", "c"]}
    r1 = await client.post(f"/api/runs/{rid}/lines", json=body)
    assert r1.status_code == 200 and r1.json()["accepted"] == 3 and r1.json()["max_seq"] == 3
    await client.post(f"/api/runs/{rid}/lines", json=body)          # retry the same batch
    # the stream must show exactly 3 line events (no dup from the retry)
    await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})
    import json as J
    r = await client.get(f"/api/agents/{aid}/runs/{rid}/stream")
    line_events = [J.loads(l[5:].strip()) for l in r.text.splitlines()
                   if l.startswith("data:") and '"line"' in l]
    assert [e["seq"] for e in line_events] == [1, 2, 3], line_events
    # unknown run → 404
    r404 = await client.post(f"/api/runs/{uuid.uuid4()}/lines", json=body)
    assert r404.status_code == 404, r404.text


async def test_worker_run_sse_unknown_run_404(client, make_agent):
    a = await make_agent("W", "eng")
    r = await client.get(f"/api/agents/{a['agent_id']}/runs/{uuid.uuid4()}/stream")
    assert r.status_code == 404, r.text
