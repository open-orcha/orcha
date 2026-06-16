"""FT-SURFACE (D1) — live data adapter (snapshot -> window.ORCHA) + ISS-46 render.

D1 replaces the mock data.js with a loader that fetches the real FastAPI snapshot,
maps it to the component shape the design pages read (container, agents+byAlias,
tasks, requests), mutates window.ORCHA IN PLACE, and re-renders on the 3s cadence —
WITHOUT jumping scroll or clobbering a text selection (ISS-46, via Orcha.patch).
The adapter degrades gracefully (no dependency on Vault's D7): plan/runs/model fall
back to null/[] until those land. Pages are wired in D2-D5.
"""
import json
import pathlib
import re
import shutil
import subprocess
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- the adapter is served + the snapshot contract holds ----------

async def test_data_js_served_and_snapshot_contract(client, make_agent, make_task, make_request):
    # served via the /assets mount
    r = await client.get("/assets/data.js")
    assert r.status_code == 200, r.text
    assert "mapSnapshot" in r.text

    # the real snapshot the adapter reads exposes the keys it maps
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Worker", kind="ai")
    task = await make_task("do it", "done when X", assignee_alias="Worker")
    await make_request(worker["agent_id"], "advise?", target_alias="Boss")

    cid = worker["container_id"]
    snap = (await client.get(f"/api/containers/{cid}")).json()
    assert set(["container", "agents", "tasks", "requests"]).issubset(snap.keys())
    a0 = snap["agents"][0]
    assert {"id", "alias", "kind", "status"}.issubset(a0.keys())
    t0 = next(t for t in snap["tasks"] if t["id"] == task["id"])
    assert "assignees" in t0 and "status" in t0
    r0 = snap["requests"][0]
    assert {"id", "requester_id", "target_id", "status"}.issubset(r0.keys())


# ---------- static guards ----------

def test_adapter_and_render_primitive_present():
    data_js = (STATIC / "data.js").read_text()
    app_js = (STATIC / "app.js").read_text()
    for fn in ("mapSnapshot", "resolveCid", "function start", "refresh"):
        assert fn in data_js, f"data.js missing {fn}"
    # maps to the component shape + mutates in place (no D7 dependency: D7 fields fall back)
    assert "byAlias" in data_js and "Orcha.applySnapshot" in data_js, "adapter doesn't mutate window.ORCHA in place"
    # consumes D7's actual shapes: plan_decision, runs-summary-vs-array, resolved task_link
    assert "t.plan_decision" in data_js, "doesn't surface D7 plan_decision (ISS-41 suppress)"
    assert "Array.isArray(t.runs)" in data_js and "runs_summary" in data_js, "D7 runs-summary not distinguished from the run array"
    assert "r.task_link ||" in data_js, "doesn't prefer D7's resolved task_link object"
    assert 'r.target_id) || "human"' in data_js, "null request target not resolved to human"
    # ISS-46: the shared scroll/selection-preserving render primitive is exported
    assert "function patch" in app_js and "patch," in app_js, "Orcha.patch not exported"
    assert "selectionWithin" in app_js, "no active-selection guard"
    # D1 review (P2): mapped requests keep the raw ids the shell classifies by
    assert "requester_id: r.requester_id, target_id: r.target_id" in data_js, "mapped requests drop raw ids"
    # review P2: deeplinks/nav target the served FastAPI routes, not *.html (which 404)
    for bad in ('href="agents.html', 'href="tasks.html', 'href="requests.html', 'href="home.html',
                'href: "home.html"', 'href: "agents.html"', 'href: "tasks.html"', 'href: "requests.html"'):
        assert bad not in app_js, f"shell still links to a *.html route: {bad}"
    assert 'href="/agents?agent=' in app_js and 'href="/tasks?task=' in app_js and 'href="/requests?req=' in app_js, "deeplinks not on served routes"
    # ISS-49 (bundled): the run-feed timestamp uses BOTH shared friendly helpers, not raw ISO
    assert "esc(clockTime(started))" in app_js, "feed time not via clockTime"
    assert "esc(relTime(ended || started))" in app_js, "feed time missing friendly relative (relTime)"


async def test_portal_serves_routes_not_html_filenames(client):
    """Review P2: the shell deeplinks must hit the routes FastAPI actually serves.
    /agents|/tasks|/requests = 200; the *.html filenames the old links used = 404."""
    for path in ("/", "/agents", "/tasks", "/requests"):
        r = await client.get(path)
        assert r.status_code == 200, f"{path} → {r.status_code}"
    for bad in ("/agents.html", "/tasks.html", "/requests.html"):
        r = await client.get(bad)
        assert r.status_code == 404, f"{bad} → {r.status_code} (should 404)"


# ---------- D1 review P2: AI→AI request must not be counted as a human escalation ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_attn_count_classifies_mapped_requests_correctly():
    """The mapped snapshot must not make every open request look human-targeted. After
    OrchaData.applies a mapped snapshot, Orcha.attnItems() must classify correctly:
    AI→AI open = 0, →human (explicit or null target) open = 1."""
    app_js = (STATIC / "app.js").read_text()
    data_js = (STATIC / "data.js").read_text()
    harness = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}} };
global.window = {};
__APPJS__
__DATAJS__
const O = window.Orcha, DA = window.OrchaData;
const agents = [ {id:"h",alias:"kedar",kind:"human",status:"idle"},
                 {id:"a",alias:"A",kind:"ai",status:"working"},
                 {id:"b",alias:"B",kind:"ai",status:"working"} ];
function count(target_id) {
  O.applySnapshot(DA.mapSnapshot({ container:{id:"c",status:"active"}, agents, tasks:[],
    requests:[ {id:"r",type:"info",requester_id:"a",target_id,status:"open",priority:10} ] }));
  return O.attnItems().count;
}
console.log(JSON.stringify({ aiToAi: count("b"), toHuman: count("h"), nullTarget: count(null) }));
"""
    src = harness.replace("__APPJS__", app_js).replace("__DATAJS__", data_js)
    out = subprocess.run(["node", "-e", src], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["aiToAi"] == 0, res        # AI→AI is NOT a human escalation
    assert res["toHuman"] == 1, res       # explicit human target counts
    assert res["nullTarget"] == 1, res    # null target (picked human) counts


# ---------- mapping (node) ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_mapsnapshot_maps_real_shape_with_fallbacks():
    data_js = (STATIC / "data.js").read_text()
    harness = r"""
global.location = { search: "" }; global.fetch = () => {}; global.window = {};
__DATAJS__
const m = window.OrchaData.mapSnapshot({
  container: { id: "c1", name: "Orcha", status: "active" },
  agents: [ { id: "h1", alias: "kedar", kind: "human", status: "idle" },
            { id: "a1", alias: "Frame", kind: "ai", status: "working" } ],
  tasks: [
    { id: "t1", title: "X", status: "in_progress", priority: 50, assignees: ["Frame"], created_by_agent_id: "h1",
      messages: [ { message_id: "m1", author_id: "a1", author_alias: "Frame", is_human: false, body: "plan", created_at: "t" } ] },
    { id: "t2", title: "Y", status: "needs_verification", priority: 20, assignees: ["Frame"] },
  ],
  requests: [ { id: "r1", type: "info", requester_id: "a1", target_id: null, status: "open",
                priority: 30, payload: "q", parent_request_id: null, chain_depth: 0, spawned_task_id: "t1" } ],
});
console.log(JSON.stringify({
  byAlias: m.agents.length === 2 && m.byAlias.kedar.kind === "human",
  assignee: m.tasks[0].assignee === "Frame",
  modelNull: m.agents[0].model === null,                 // missing -> null (page shows —)
  planRunsFallback: m.tasks[0].plan_decision === null && Array.isArray(m.tasks[0].runs) && m.tasks[0].runs_summary === null,
  thread: m.tasks[0].thread[0].from === "Frame",
  reqFrom: m.requests[0].from === "Frame",
  reqNullTargetIsHuman: m.requests[0].to === "human",
  reqTaskLink: m.requests[0].task_link.task_id === "t1",   // pre-D7 minimal {task_id}
  reqChainParent: m.requests[0].in_service_of === null,
  currentTaskDerived: m.agents.find((a) => a.alias === "Frame").current_task.task_id === "t1",
}));
"""
    out = subprocess.run(["node", "-e", harness.replace("__DATAJS__", data_js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert all(res.values()), res


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_mapsnapshot_consumes_d7_enriched_shapes():
    """Once Vault's D7 (PR #74) lands, the snapshot ships richer SHAPES — agent
    current_task = {task_id,title}, task plan_decision object + runs SUMMARY {count,latest}
    (not an array), request task_link = {task_id,title,status}. The adapter must consume
    those, not mis-handle them (e.g. treat the runs summary as the per-run array)."""
    data_js = (STATIC / "data.js").read_text()
    harness = r"""
global.location = { search: "" }; global.fetch = () => {}; global.window = {};
__DATAJS__
const m = window.OrchaData.mapSnapshot({
  container: { id: "c1", status: "active" },
  agents: [ { id: "a1", alias: "Frame", kind: "ai", status: "working", model: "claude-opus-4-8",
              wake_enabled: true, last_active: "t", prompt_preview: "You are Frame, frontend engineer",
              current_task: { task_id: "t1", title: "X" } } ],
  tasks: [ { id: "t1", title: "X", status: "in_progress", priority: 50, assignees: ["Frame"],
             plan_decision: { decision: "approve", reason: "go", actor: "kedar", at: "t" },
             runs: { count: 3, latest: { status: "exited", exit_code: 0, started_at: "t", ended_at: "t" } } } ],
  requests: [ { id: "r1", type: "info", requester_id: "a1", target_id: null, status: "open", priority: 30,
                payload: "q", spawned_task_id: "t1",
                task_link: { task_id: "t1", title: "X", status: "in_progress" } } ],
});
console.log(JSON.stringify({
  currentTaskPassThrough: m.agents[0].current_task.task_id === "t1" && m.agents[0].current_task.title === "X",
  planDecision: m.tasks[0].plan_decision.decision === "approve" && m.tasks[0].plan_decision.reason === "go",
  runsSummaryNotArray: Array.isArray(m.tasks[0].runs) && m.tasks[0].runs.length === 0
                       && m.tasks[0].runs_summary.count === 3 && m.tasks[0].runs_summary.latest.status === "exited",
  taskLinkResolved: m.requests[0].task_link.title === "X" && m.requests[0].task_link.status === "in_progress",
  model: m.agents[0].model === "claude-opus-4-8" && m.agents[0].wake_enabled === true,
  promptPreview: m.agents[0].prompt_preview === "You are Frame, frontend engineer",  // #81, consumed by D3 persona
}));
"""
    out = subprocess.run(["node", "-e", harness.replace("__DATAJS__", data_js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert all(res.values()), res


# ---------- ISS-46: patch preserves scroll + defers on selection (node) ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_patch_preserves_scroll_skips_unchanged_and_defers_selection():
    app_js = (STATIC / "app.js").read_text()
    harness = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement: { setAttribute(){} }, addEventListener(){}, getElementById: () => null,
  createElement: () => ({ classList:{add(){},remove(){}}, addEventListener(){}, style:{}, appendChild(){} }), body:{ appendChild(){} } };
global.window = {};
__APPJS__
const O = window.Orcha;
function mkEl() {
  const kid = { id: "log1", scrollHeight: 500, clientHeight: 100, scrollTop: 80, getAttribute: () => null };
  let html = "";
  const el = {
    scrollHeight: 1000, clientHeight: 100, scrollTop: 40,
    get innerHTML(){ return html; },
    set innerHTML(v){ html = v; this.scrollTop = 0; kid.scrollTop = 0; },  // browser drops scroll on swap
    querySelectorAll(){ return [kid]; }, contains(n){ return n === el || n === kid; },
  };
  return { el, kid };
}
// 1) changed + no selection -> writes AND restores scroll (el + keyed child)
let a = mkEl();
window.getSelection = () => ({ rangeCount: 0, isCollapsed: true });
const wrote = O.patch(a.el, "<p>new</p>");
const r1 = { wrote, html: a.el.innerHTML, selfScroll: a.el.scrollTop, kidScroll: a.kid.scrollTop };
// 2) same html again -> no write (skip)
const wrote2 = O.patch(a.el, "<p>new</p>");
// 3) selection active inside -> defer, no write even though html differs
let b = mkEl();
window.getSelection = () => ({ rangeCount: 1, isCollapsed: false, anchorNode: { nodeType: 1 } });
// make contains() report the anchor is inside b.el
b.el.contains = () => true;
const wrote3 = O.patch(b.el, "<p>changed</p>");
console.log(JSON.stringify({
  wrote: r1.wrote === true, painted: r1.html === "<p>new</p>",
  scrollRestored: r1.selfScroll === 40 && r1.kidScroll === 80,
  skipUnchanged: wrote2 === false,
  deferredOnSelection: wrote3 === false && b.el.innerHTML === "",
}));
"""
    out = subprocess.run(["node", "-e", harness.replace("__APPJS__", app_js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["wrote"] and res["painted"], res
    assert res["scrollRestored"], res          # no scroll jump on a real change
    assert res["skipUnchanged"], res           # unchanged poll = no DOM write at all
    assert res["deferredOnSelection"], res     # active text selection is never clobbered


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_patch_defers_when_selection_dragged_into_panel():
    """P3: a selection that STARTS outside el and is dragged INTO it has its anchor
    outside but focus inside — patch must still defer (anchor-only check missed this)."""
    app_js = (STATIC / "app.js").read_text()
    harness = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}} };
global.window = {};
__APPJS__
const O = window.Orcha;
const inside = { nodeType: 1 }, outside = { nodeType: 1 };
const el = { scrollHeight: 1000, clientHeight: 100, scrollTop: 0,
  get innerHTML(){ return this._h || ""; }, set innerHTML(v){ this._h = v; },
  querySelectorAll(){ return []; }, contains(n){ return n === inside; } };
// anchor OUTSIDE, focus INSIDE (drag-into)
window.getSelection = () => ({ rangeCount: 1, isCollapsed: false, anchorNode: outside, focusNode: inside,
  getRangeAt: () => ({ intersectsNode: () => true }) });
const wrote = O.patch(el, "<p>changed</p>");
console.log(JSON.stringify({ deferred: wrote === false && (el._h === undefined) }));
"""
    out = subprocess.run(["node", "-e", harness.replace("__APPJS__", app_js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["deferred"], res
