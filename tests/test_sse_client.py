"""FT-SURFACE (task 199982a9) — SSE live-stream client (shared app.js engine).

The portal opens an EventSource per RUNNING worker run against Forge's PR #58 endpoint
GET /api/agents/{aid}/runs/{run_id}/stream and renders the streamed stream-json lines
live (sub-second), surviving the 3s panel rebuild. Since D3 (agents) + D4 (tasks) this
lives ONCE in the shared app.js engine (startRunStream + activateRuns), not inline per
page. The live render against a real running worker is verified in the portal; the
automatable surface is:
  * the endpoint the client targets exists with the documented error contract,
  * the shared client opens that endpoint, handles the {seq,line} / terminal {done}
    shapes, monotonically dedups reconnect replay, and reconnects on stream_timeout,
  * only RUNNING runs stream (finished ones paint from their stored output).
Repaint-survival of in-progress UI is the shared Orcha.patch guarantee (ISS-46/ISS-53,
covered by test_d1_data_adapter).
"""
import pathlib
import re
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- the endpoint the client depends on (Forge PR #58) ----------

async def test_stream_endpoint_error_contract(client, make_agent):
    agent = await make_agent("Worker", kind="ai")
    aid = agent["agent_id"]
    # bad uuids → 400
    r = await client.get(f"/api/agents/not-a-uuid/runs/not-a-uuid/stream")
    assert r.status_code == 400, r.text
    # valid agent, unknown run → 404 (run not found for this agent)
    r = await client.get(f"/api/agents/{aid}/runs/00000000-0000-0000-0000-000000000000/stream")
    assert r.status_code == 404, r.text


# ---------- the SHARED client (app.js startRunStream) ----------

def test_shared_client_wires_eventsource_to_the_stream():
    """startRunStream opens the documented stream endpoint and consumes both message
    shapes: a worker line {seq,line} and the terminal {done}."""
    app = (STATIC / "app.js").read_text()
    fn = re.search(r"function startRunStream\(logEl, agentId, runId\) \{.*?\n  \}", app, re.S).group(0)
    assert 'new EventSource("/api/agents/" + encodeURIComponent(agentId) + "/runs/" + encodeURIComponent(runId) + "/stream")' in fn, \
        "EventSource not wired to the stream endpoint"
    assert "d.done" in fn, "terminal {done} shape not handled"
    assert "d.seq" in fn and "d.line" in fn, "worker-line {seq,line} shape not handled"
    # classifies streamed lines through the shared classifier
    assert "classifyLine(d.line)" in fn, "streamed lines not classified via classifyLine"


def test_shared_client_dedups_replay_and_reconnects_on_timeout():
    """Monotonic seq guard drops reconnect replay; a stream_timeout reopens the stream
    while a real terminal status does not (no infinite loop)."""
    app = (STATIC / "app.js").read_text()
    fn = re.search(r"function startRunStream\(logEl, agentId, runId\) \{.*?\n  \}", app, re.S).group(0)
    assert "d.seq <= maxSeq" in fn and "return" in fn, "no monotonic dedup of reconnect replay"
    assert 'd.status === "stream_timeout"' in fn and "open()" in fn, "stream_timeout not reconnectable"


def test_only_running_runs_stream():
    """activateRuns streams only RUNNING runs (live), and paints finished ones from their
    stored output — so a finished run never holds an EventSource open."""
    app = (STATIC / "app.js").read_text()
    fn = re.search(r"function activateRuns\(runs\) \{.*?\n  \}", app, re.S).group(0)
    assert 'run.status === "running"' in fn and "startRunStream(" in fn, "running runs don't stream"
    assert "paintFinished(" in fn, "finished runs not painted from stored output"
