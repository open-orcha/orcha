"""FT-SURFACE (D6) — live run feed (SSE) wiring + ISS-52 (action queue live-update).

D6's marquee live run feed is already wired via the SHARED app.js engine (startRunStream
tails worker_run_lines per run_id, classifies the 9 types, sections survive the 3s patch,
EventSource torn down on view change) and mounted on the redesigned agents/tasks/conversation
pages — this file asserts that wiring + adds the live-push layer.

D6 live-push: OrchaData.start now ALSO subscribes to the container event stream
(GET /api/containers/{cid}/events) so escalations / decisions / suggestions surface
sub-second instead of waiting up to the 3s poll. The 3s poll stays as the fallback and
covers changes the stream doesn't emit — e.g. a brand-new plan turn, which still appears
within one poll (ISS-52: the redesigned action queue surfaces a fresh un-approved plan from
the message-bearing snapshot, unlike the old load()+rebuild home the bug was filed against).
"""
import json
import pathlib
import shutil
import subprocess
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- D6 live run feed is wired via the shared engine ----------

def test_live_run_feed_uses_the_shared_sse_engine():
    app = (STATIC / "app.js").read_text()
    # the per-run SSE client + the 9-type classifier + the run card live once in app.js
    assert "function startRunStream" in app and "/runs/\" + encodeURIComponent(runId) + \"/stream" in app, \
        "no shared per-run SSE client"
    assert "function classifyLine" in app and "function activateRuns" in app, "shared classify/activate missing"
    # redesigned pages render runs through it
    for page in ("agents.html", "tasks.html"):
        html = (STATIC / page).read_text()
        assert "O.runCard(" in html and "O.activateRuns(" in html, f"{page} doesn't mount the shared run engine"


# ---------- D6 live-push: container event stream → instant refresh ----------

def test_data_adapter_subscribes_to_the_container_event_stream():
    js = (STATIC / "data.js").read_text()
    assert "function startEventStream" in js and "start(render, ms)" in js, "no live-push subscription"
    # opens the container event stream SEEDED at a cursor (never since_ts=0 → no history replay)
    assert 'new EventSource("/api/containers/" + encodeURIComponent(_cid) + "/events?since_ts=" + _evCursor)' in js, \
        "stream not seeded with a since_ts cursor (would replay the full history — review P1)"
    assert "_evCursor == null" in js and "Date.now() / 1000" in js, "doesn't seed the cursor at 'now' on first connect"
    assert "if (ts != null) _evCursor = ts" in js, "doesn't advance the cursor per event (reconnect would replay)"
    assert "es.close()" in js and "setTimeout(connect, 3000)" in js, "doesn't manage reconnect from the cursor"
    # an event triggers a refresh+render; bursts coalesce; the 3s poll remains the fallback
    assert "refresh().then(() => { if (render) render(); })" in js, "an event doesn't refresh+render"
    assert "_pending" in js, "no coalescing of an event burst"
    assert "setInterval(tick, ms || 3000)" in js, "the 3s poll fallback was removed"


async def test_container_event_stream_endpoint_exists(client, make_agent):
    """The SSE endpoint the live-push client targets exists (escalations/suggestions stream)."""
    agent = await make_agent("Worker", kind="ai")
    cid = agent["container_id"]
    # bad uuid → 400 (documented error contract; we don't hold the stream open in the test)
    r = await client.get("/api/containers/not-a-uuid/events")
    assert r.status_code == 400, r.text


# ---------- ISS-52: the action queue surfaces a fresh un-approved plan (node) ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_action_queue_surfaces_a_freshly_posted_plan():
    """ISS-52: a just-posted plan (an in_progress task whose agent posted the first thread
    message, no plan_decision yet) must appear in Orcha.attnItems().plans straight from the
    snapshot — so the redesigned dashboard live-updates it within one 3s poll."""
    app_js = (STATIC / "app.js").read_text()
    data_js = (STATIC / "data.js").read_text()
    harness = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}} };
global.window = {}; global.location = { search: "" }; global.fetch = () => {};
__APPJS__
__DATAJS__
const O = window.Orcha, DA = window.OrchaData;
// a snapshot as it looks right AFTER an agent posts its plan on an in-progress task
O.applySnapshot(DA.mapSnapshot({
  container: { id: "c1", status: "active" },
  agents: [ { id: "h", alias: "kedar", kind: "human", status: "idle" },
            { id: "a1", alias: "Frame", kind: "ai", status: "working" } ],
  tasks: [ { id: "t1", title: "Do X", status: "in_progress", priority: 50, assignees: ["Frame"],
             plan_decision: null,
             messages: [ { message_id: "m1", author_id: "a1", author_alias: "Frame", is_human: false, body: "PLAN: ...", created_at: "t" } ] } ],
  requests: [],
}));
const aq = O.attnItems();
console.log(JSON.stringify({ plans: aq.plans.map(t => t.id), count: aq.count }));
"""
    out = subprocess.run(["node", "-e", harness.replace("__APPJS__", app_js).replace("__DATAJS__", data_js)],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["plans"] == ["t1"], res     # the fresh plan surfaces from the snapshot
    assert res["count"] == 1, res
