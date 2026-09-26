"""FT-SURFACE (task 199982a9) — SSE live-stream client (shared engine).

The portal opens an EventSource per RUNNING worker run against Forge's PR #58 endpoint
GET /api/agents/{aid}/runs/{run_id}/stream and renders the streamed stream-json lines
live (sub-second), surviving the 3s panel rebuild.

Phase 7: the vanilla static/app.js engine is retired; the shared client lives twice-
thinly over one contract in the React sources:
  - frontend/src/pages/agents/runlog.tsx      — startRunStream/paintFinished (the
    imperative engine behind the agents run feed + per-turn WorkLogDetails)
  - frontend/src/hooks/useRunStream.ts        — the hook flavor (tasks-page RunCard),
    finishedRows = paintFinished parity
The live render against a real running worker is verified in the portal; the
automatable surface is:
  * the endpoint the client targets exists with the documented error contract,
  * both clients open that endpoint, handle the {seq,line} / terminal {done} shapes,
    monotonically dedup reconnect replay, and reconnect on stream_timeout,
  * only RUNNING runs stream (finished ones paint from their stored output).
"""
import pathlib
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
FRONTEND = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend" / "src"
RUNLOG = FRONTEND / "pages" / "agents" / "runlog.tsx"
HOOK = FRONTEND / "hooks" / "useRunStream.ts"


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


# ---------- the SHARED client (runlog.tsx startRunStream + useRunStream) ----------

def test_shared_client_wires_eventsource_to_the_stream():
    """Both clients open the documented stream endpoint and consume both message
    shapes: a worker line {seq,line} and the terminal {done}."""
    for path, rid_var in ((RUNLOG, "runId"), (HOOK, "rid")):
        src = path.read_text()
        url = ('new EventSource("/api/agents/" + encodeURIComponent(agentId) + "/runs/" + '
               f'encodeURIComponent({rid_var}) + "/stream")')
        assert url in src, f"{path.name}: EventSource not wired to the stream endpoint"
        assert "d.done" in src, f"{path.name}: terminal {{done}} shape not handled"
        assert 'typeof d.seq === "number"' in src and 'typeof d.line === "string"' in src, \
            f"{path.name}: worker-line {{seq,line}} shape not handled"
        # classifies streamed lines through the shared classifier
        assert "classifyLine(d.line)" in src, f"{path.name}: streamed lines not classified via classifyLine"


def test_shared_client_dedups_replay_and_reconnects_on_timeout():
    """Monotonic seq guard drops reconnect replay; a stream_timeout reopens the stream
    while a real terminal status does not (no infinite loop)."""
    for path in (RUNLOG, HOOK):
        src = path.read_text()
        assert "d.seq <= maxSeq" in src and "return" in src, \
            f"{path.name}: no monotonic dedup of reconnect replay"
        assert 'd.status === "stream_timeout"' in src and "open()" in src, \
            f"{path.name}: stream_timeout not reconnectable"
        # the timeout-reopen respects a client-side stop (no zombie reconnect loop)
        assert "!stopped" in src, f"{path.name}: reconnect doesn't respect the stopped flag"


def test_only_running_runs_stream():
    """Only RUNNING runs stream (live); finished ones paint from their stored output —
    so a finished run never holds an EventSource open."""
    runlog = RUNLOG.read_text()
    assert 'if (run.status === "running" && streamAgent) return startRunStream(logEl, streamAgent, rid);' in runlog, \
        "runlog: running runs don't stream"
    assert "paintFinished(logEl, run)" in runlog, "runlog: finished runs not painted from stored output"
    hook = HOOK.read_text()
    assert 'run.status === "running"' in hook, "useRunStream: liveness not keyed on running"
    assert "if (!live) {" in hook and "finishedRows(r)" in hook, \
        "useRunStream: finished runs not painted from stored output"
