"""FT-SURFACE (D6) — live run feed (SSE) wiring + ISS-52 (action queue live-update).

D6's live run feed rides the SHARED engine — in the React port that is
frontend/src/hooks/useRunStream.ts (per-run EventSource, the classify taxonomy from
lib/classify.ts, seq replay guard, teardown on unmount) mounted by the tasks page
(TasksPage RunCard) and the agents page (runlog.tsx).

D6 live-push: the snapshot provider (frontend/src/state/SnapshotProvider.tsx) ALSO
subscribes to the container event stream (GET /api/containers/{cid}/events) so
escalations / decisions / suggestions surface sub-second instead of waiting up to the
3s poll. The 3s poll stays as the fallback and covers changes the stream doesn't emit
— e.g. a brand-new plan turn, which still appears within one poll (ISS-52: the action
queue surfaces a fresh un-approved plan straight from the message-bearing snapshot —
covered in frontend/src/state/snapshot.test.ts).
"""
import pathlib
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
FRONTEND = PORTAL / "frontend" / "src"


# ---------- D6 live run feed is wired via the shared engine ----------

def test_live_run_feed_uses_the_shared_sse_engine():
    # the per-run SSE client + the classifier live ONCE (hooks/useRunStream + lib/classify)
    rs = (FRONTEND / "hooks" / "useRunStream.ts").read_text()
    assert "new EventSource(" in rs and '"/stream"' in rs, "no shared per-run SSE client"
    cl = (FRONTEND / "lib" / "classify.ts").read_text()
    assert "export function classifyLine" in cl, "shared classifier missing"
    # both detail pages render runs through the shared pieces
    tasks = (FRONTEND / "pages" / "tasks" / "TasksPage.tsx").read_text()
    assert "useRunStream" in tasks, "tasks page doesn't mount the shared run engine"
    runlog = (FRONTEND / "pages" / "agents" / "runlog.tsx").read_text()
    assert "classifyLine" in runlog, "agents run feed doesn't use the shared classifier"


# ---------- D6 live-push: container event stream → instant refresh ----------

def test_snapshot_provider_subscribes_to_the_container_event_stream():
    js = (FRONTEND / "state" / "SnapshotProvider.tsx").read_text()
    # opens the container event stream SEEDED at a cursor (never since_ts=0 → no history replay)
    assert '"/events?since_ts=" + cursor' in js, \
        "stream not seeded with a since_ts cursor (would replay the full history — review P1)"
    assert "cursor == null" in js and "Date.now() / 1000" in js, "doesn't seed the cursor at 'now' on first connect"
    assert "if (ts != null) cursor = ts" in js, "doesn't advance the cursor per event (reconnect would replay)"
    assert "es?.close()" in js and "setTimeout(connect, 3000)" in js, "doesn't manage reconnect from the cursor"
    # an event triggers a refresh; bursts coalesce; the 3s poll remains the fallback
    assert "void refresh()" in js, "an event doesn't refresh the snapshot"
    assert "pending" in js, "no coalescing of an event burst"
    assert "setInterval(" in js and "pollMs" in js, "the 3s poll fallback was removed"


async def test_container_event_stream_endpoint_exists(client, make_agent):
    """The SSE endpoint the live-push client targets exists (escalations/suggestions stream)."""
    agent = await make_agent("Worker", kind="ai")
    cid = agent["container_id"]
    # bad uuid → 400 (documented error contract; we don't hold the stream open in the test)
    r = await client.get("/api/containers/not-a-uuid/events")
    assert r.status_code == 400, r.text
    assert cid  # the agent's container exists for the real stream


# ---------- ISS-52: the action queue surfaces a fresh un-approved plan ----------
# Moved to the frontend Vitest suite: frontend/src/state/snapshot.test.ts
# ("ISS-52: a freshly posted plan surfaces straight from the message-bearing
# snapshot") — attnItems().plans over a mapSnapshot'd post-plan snapshot.
