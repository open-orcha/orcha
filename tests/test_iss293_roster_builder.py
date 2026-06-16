"""#293 — First-run roster-builder UX (frontend, Path G).

The onboarding wizard gains an AI lane: describe a goal → stream the model's thinking →
review/edit a proposed roster → commit it. It consumes the FROZEN SPEC-292 contract
(POST /api/onboarding/propose, SSE: thinking|clarify|roster|error|done) and — per the
SPEC-292 §4/§5 reuse mandate — commits through the EXISTING client POSTs
(POST .../agents, POST .../tasks): NO new commit route, zero route/OpenAPI/DB delta.

The #292 backend isn't deployed yet, so end-to-end verify waits on it. What's automatable
here is the client wiring: the pure SSE parser + proposal→form binding (node harness),
static guards on the lane contract (incl. the no-new-route reuse mandate + fail-open), and
the existing onboarding endpoints the commit reuses still round-trip.
"""
import json
import pathlib
import shutil
import subprocess
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- static guards on the Path G lane contract ----------

def test_path_g_lane_present_and_consumes_propose_contract():
    js = (STATIC / "onboarding.js").read_text()
    # the fork offers the AI lane, routing to the goal step
    assert 'data-go="propose-goal"' in js, "fork doesn't offer the Path G propose lane"
    # the three propose steps are wired into the render() dispatcher
    for step in ('"propose-goal": stepProposeGoal', '"propose-stream": stepProposeStream',
                 '"propose-roster": stepProposeRoster'):
        assert step in js, f"render() dispatcher missing {step}"
    # it streams from the FROZEN SPEC-292 route via POST (EventSource is GET-only → fetch+reader)
    assert '"/api/onboarding/propose"' in js, "doesn't consume the SPEC-292 propose route"
    assert "getReader()" in js, "SSE not read via a ReadableStream reader (POST+SSE needs fetch, not EventSource)"
    # the SSE event discriminators of §1.2 are all handled
    for ev in ('"thinking"', '"clarify"', '"roster"', '"error"', '"done"'):
        assert f"f.event === {ev}" in js, f"propose stream doesn't handle the {ev} event"


def test_reuse_mandate_no_new_commit_route():
    """SPEC-292 §5: commit REUSES the existing client POSTs — #293 adds NO commit route."""
    js = (STATIC / "onboarding.js").read_text()
    # the forbidden server-side commit endpoint must NOT appear
    assert "/api/onboarding/commit" not in js, "introduced a forbidden /commit route (violates §5 reuse mandate)"
    # commit still flows through the existing agent + task POSTs
    assert "/agents" in js and "/tasks" in js, "commit doesn't reuse the existing agents/tasks POSTs"
    # the walk seeds the EXISTING create-agent draft + hands tasks to the EXISTING queue loop
    assert "walkAgentToDraft(" in js and "S._agentDraft = walkAgentToDraft" in js, \
        "roster walk doesn't pre-seed the existing create-agent draft"
    assert "S._walk = rosterToWalk(" in js, "commit doesn't build the walk from the edited roster"


def test_propose_fails_open_to_manual_lane():
    """The #292 backend may be absent (404) — the stream must fail OPEN: an honest error
    turn that keeps the manual lanes usable, never a dead screen."""
    js = (STATIC / "onboarding.js").read_text()
    # an HTTP/transport failure surfaces an error turn (not an unhandled throw)
    assert "h.onError(" in js, "propose stream doesn't surface a recoverable error turn"
    assert "#292 backend" in js, "error copy doesn't name the missing backend dependency honestly"
    # the error card offers a manual fallback + retry
    assert 'data-go="fork"' in js, "error turn has no manual-setup fallback to the fork"
    assert 'id="peRetry"' in js, "error turn has no retry"


def test_demo_mode_is_dev_only_not_default():
    """?demo=1 synthesizes a roster client-side so the lane is demoable before #292 ships —
    but it must be GATED, never the default path."""
    js = (STATIC / "onboarding.js").read_text()
    assert 'q.get("demo") === "1"' in js, "no dev-only demo gate"
    assert "if (S._propose && S._propose.demo) return demoPropose(" in js, \
        "startPropose doesn't gate the demo stub behind the demo flag (would fake every run)"
    # boot() must reconcile the flag from the LIVE url every load (not a one-directional set),
    # else a single ?demo=1 visit sticks demo:true into localStorage and hijacks every later run.
    assert "reconcileDemoFlag(S, q.get(\"demo\") === \"1\")" in js, \
        "boot() doesn't reconcile the demo flag from the current URL (would let demo go sticky)"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_demo_mode_is_not_sticky_across_boots():
    """Gate #339 regression: load with ?demo=1, then boot without it. The demo flag must be
    CLEARED on the second boot so startPropose's `S._propose && S._propose.demo` gate is falsy
    again — i.e. the real /api/onboarding/propose path, never the synthetic stub. The unrelated
    propose state (goal/dialogue) survives the clear."""
    res = _run_node(r"""
const S = { _propose: { goal: "ship a thing", dialogue: [{ q: "scope?" }] } };
// 1) a dev visits /onboarding?demo=1 → flag set (and would persist to localStorage)
M.reconcileDemoFlag(S, true);
const afterDemo = S._propose.demo === true;
// 2) later they (or anyone) load plain /onboarding → flag must be cleared
M.reconcileDemoFlag(S, false);
console.log(JSON.stringify({
  afterDemo,
  // startPropose routes to demoPropose ONLY when this is truthy — must be falsy after the plain boot
  startProposeUsesDemo: !!(S._propose && S._propose.demo),
  goalKept: S._propose.goal,
  dialogueKept: Array.isArray(S._propose.dialogue) && S._propose.dialogue.length === 1,
}));
""")
    assert res["afterDemo"] is True, res                  # ?demo=1 still enables the stub for that session
    assert res["startProposeUsesDemo"] is False, res      # next plain boot → real propose path (not sticky)
    assert res["goalKept"] == "ship a thing", res         # unrelated propose state preserved
    assert res["dialogueKept"] is True, res


def test_propose_lane_does_not_self_certify_or_auto_commit():
    """Human-authoritative invariant: the model output is an editable proposal; the only
    writes are the operator's explicit create actions."""
    js = (STATIC / "onboarding.js").read_text()
    # the commit button is an explicit operator action, not an auto-fire on roster arrival
    assert 'id="rCommit"' in js, "no explicit operator commit control on the roster review"
    # onRoster routes to the EDITABLE review step, it does not POST anything itself
    assert 'go("propose-roster")' in js, "roster arrival doesn't route to the editable review"


def test_pure_helpers_exported_for_tests():
    js = (STATIC / "onboarding.js").read_text()
    for fn in ("parseSSE", "normalizeRoster", "rosterToWalk", "walkAgentToDraft"):
        assert f"{fn}," in js or f"{fn} }}" in js, f"{fn} not exported on window.OrchaOnboarding"


# ---------- pure logic (node harness) ----------

_HARNESS_PRELUDE = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { getElementById: () => null, addEventListener(){}, documentElement:{setAttribute(){}},
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}} };
global.fetch = () => Promise.reject("no fetch in test");
global.setInterval = () => 0; global.setTimeout = () => 0;
global.window = {
  Orcha: { icon:()=>"", esc:(s)=>String(s==null?"":s), avatar:()=>"", trunc:(s)=>s, pill:()=>"", kindBadge:()=>"",
    orcaSVG:()=>"", toast(){}, mountShell(){}, agents:()=>[], tasks:()=>[], setActingHuman(){} },
  OrchaData: { resolveCid: () => Promise.reject("x"), start: () => {} },
};
__ONBJS__
const M = window.OrchaOnboarding;
"""


def _run_node(body: str) -> dict:
    js = (STATIC / "onboarding.js").read_text()
    script = _HARNESS_PRELUDE.replace("__ONBJS__", js) + "\n" + body
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_parse_sse_incremental_heartbeat_and_malformed():
    """parseSSE: frames split on a blank line; ':' heartbeat comments ignored; a malformed
    frame is skipped (never kills the stream); a partial trailing frame is held in `rest`."""
    res = _run_node(r"""
// one heartbeat + one good frame + a malformed frame + a partial (no terminating blank line)
const buf = ": heartbeat 123\n\n" +
  'data: {"event":"thinking","delta":"hi"}\n\n' +
  "data: {not json}\n\n" +
  'data: {"event":"roster"';
const p1 = M.parseSSE(buf);
// feed the rest of the partial frame next
const p2 = M.parseSSE(p1.rest + ',"agents":[]}\n\n');
console.log(JSON.stringify({
  firstEvents: p1.frames.map(f => f.event),     // malformed dropped → only the thinking frame
  restHeld: p1.rest.indexOf('"event":"roster"') !== -1,
  secondEvents: p2.frames.map(f => f.event),
  secondRest: p2.rest,
}));
""")
    assert res["firstEvents"] == ["thinking"], res        # heartbeat ignored + malformed skipped
    assert res["restHeld"] is True, res                    # partial frame buffered, not lost
    assert res["secondEvents"] == ["roster"], res          # completes once the blank line arrives
    assert res["secondRest"] == "", res


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_normalize_roster_enforces_binding_constraints():
    """normalizeRoster (SPEC-292 §3): dangling assignee → unassigned; depends_on keeps only
    EARLIER titles; at most one kickoff per assignee; empties dropped; model_hint→model."""
    res = _run_node(r"""
const payload = {
  rationale: "why",
  agents: [
    { name: "Atlas", role: "Concierge", charter: "c1", model_hint: "m-x" },
    { name: "", role: "drop me", charter: "" },                 // empty name → dropped
    { name: "Forge", role: "Builder", charter: "c2", model_hint: null },
  ],
  tasks: [
    { title: "T1", definition_of_done: "d1", assignee: "Atlas", depends_on: ["T2"], is_kickoff: true },  // forward dep T2 dropped
    { title: "T2", definition_of_done: "d2", assignee: "Ghost", depends_on: ["T1"], is_kickoff: true },  // dangling assignee → null; dep T1 kept
    { title: "T3", definition_of_done: "d3", assignee: "Atlas", depends_on: [], is_kickoff: true },        // 2nd kickoff for Atlas → cleared
    { title: "", definition_of_done: "x" },                                                                  // empty title → dropped
  ],
};
const r = M.normalizeRoster(payload, "DEFAULT");
const atlas = r.agents.find(a => a.name === "Atlas");
const forge = r.agents.find(a => a.name === "Forge");
const t1 = r.tasks.find(t => t.title === "T1");
const t2 = r.tasks.find(t => t.title === "T2");
const t3 = r.tasks.find(t => t.title === "T3");
console.log(JSON.stringify({
  agentNames: r.agents.map(a => a.name),
  atlasModel: atlas.model, forgeModel: forge.model,
  t1deps: t1.depends_on, t1kick: t1.is_kickoff,
  t2assignee: t2.assignee, t2deps: t2.depends_on, t2kick: t2.is_kickoff,
  t3kick: t3.is_kickoff,
  taskTitles: r.tasks.map(t => t.title),
}));
""")
    assert res["agentNames"] == ["Atlas", "Forge"], res        # empty-name agent dropped
    assert res["atlasModel"] == "m-x", res                      # model_hint carried
    assert res["forgeModel"] == "DEFAULT", res                  # null hint → default
    assert res["t1deps"] == [], res                             # forward dep T2 dropped
    assert res["t1kick"] is True, res                           # first Atlas kickoff kept
    assert res["t2assignee"] is None, res                       # dangling assignee → unassigned
    assert res["t2deps"] == ["T1"], res                         # earlier dep kept
    assert res["t2kick"] is False, res                          # kickoff on now-unassigned cleared (no assignee key collision)
    assert res["t3kick"] is False, res                          # 2nd Atlas kickoff cleared
    assert res["taskTitles"] == ["T1", "T2", "T3"], res         # empty-title task dropped


def test_propose_retry_feeds_validation_error_back_to_model():
    """Retry after a server-side validation error must change the next propose prompt."""
    js = (STATIC / "onboarding.js").read_text()
    assert "function retryPropose(pr, err)" in js
    assert 'err.code === "invalid_goal"' in js
    assert "Previous roster proposal failed validation on the server" in js
    assert "retryPropose(S._propose, err)" in js


def test_propose_truncation_does_not_blind_retry_same_request():
    """A roster truncated by output-token limits needs a narrower goal, not the same POST again."""
    js = (STATIC / "onboarding.js").read_text()
    assert "roster_truncated" in js
    assert 'code !== "roster_truncated"' in js
    assert "if (retry) retry.addEventListener" in js


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_roster_to_walk_splits_kickoff_from_standalone():
    """rosterToWalk: each agent's kickoff → its initial_task; every non-kickoff task →
    a standalone queue entry committed through the existing POST loop."""
    res = _run_node(r"""
const roster = {
  rationale: "r",
  agents: [{ name: "Atlas", role: "C", charter: "c", model: "m" }, { name: "Forge", role: "B", charter: "c2", model: "m" }],
  tasks: [
    { title: "Plan",  definition_of_done: "dp", assignee: "Atlas", is_kickoff: true },
    { title: "Build", definition_of_done: "db", assignee: "Forge", is_kickoff: true },
    { title: "Audit", definition_of_done: "da", assignee: "Atlas", is_kickoff: false },   // non-kickoff → standalone
    { title: "Doc",   definition_of_done: "dd", assignee: null,    is_kickoff: false },   // unassigned → standalone
  ],
};
const w = M.walk = M.rosterToWalk(roster);
const d0 = M.walkAgentToDraft(w.agents[0], "DEF");
console.log(JSON.stringify({
  idx: w.idx,
  agentKickoffs: w.agents.map(a => a.kickoff ? a.kickoff.title : null),
  standalone: w.standalone.map(t => t.title),
  draftMode: d0._firstMode, draftDesc: d0._desc, draftTitle: d0._taskTitle, draftAlias: d0.alias, draftModel: d0.model,
}));
""")
    assert res["idx"] == 0, res
    assert res["agentKickoffs"] == ["Plan", "Build"], res       # kickoff matched per assignee
    assert sorted(res["standalone"]) == ["Audit", "Doc"], res   # both non-kickoffs queued standalone
    assert res["draftMode"] == "describe", res                  # kickoff → describe mode
    assert res["draftDesc"] == "dp", res
    assert res["draftTitle"] == "Plan", res                     # proposed title preserved (submitAgent honors it)
    assert res["draftAlias"] == "Atlas", res
    assert res["draftModel"] == "m", res


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_new_steps_in_build_rail_and_stream_resumes_to_goal():
    """The propose steps live under the 'build' rail group, and a reload during the live
    stream resumes to the goal step (the SSE can't survive a reload)."""
    res = _run_node(r"""
console.log(JSON.stringify({
  railGoal: M.railKeyFor("propose-goal"),
  railStream: M.railKeyFor("propose-stream"),
  railRoster: M.railKeyFor("propose-roster"),
  resumeStream: M.resumeStep("propose-stream", true),   // live stream can't resume → re-ask the goal
  resumeRoster: M.resumeStep("propose-roster", true),   // editable roster is persisted → stays put
}));
""")
    assert res["railGoal"] == "build" and res["railStream"] == "build" and res["railRoster"] == "build", res
    assert res["resumeStream"] == "propose-goal", res
    assert res["resumeRoster"] == "propose-roster", res


# ---------- the commit reuses the existing endpoints (real round-trip) ----------

async def test_commit_endpoints_roundtrip(client, container):
    """The walk commits through the EXISTING POSTs (no new route). Prove those endpoints —
    an agent with an initial_task + a standalone task — still round-trip end-to-end."""
    cid = container["id"]
    h = await client.post(f"/api/containers/{cid}/agents",
                          json={"alias": "Dario", "role": "Operator", "kind": "human"})
    assert h.status_code in (200, 201), h.text

    # agent + kickoff (initial_task) — the per-agent walk path
    a = await client.post(f"/api/containers/{cid}/agents", json={
        "alias": "Atlas", "role": "Concierge", "kind": "ai",
        "prompt": "You are the concierge. Never self-certify.",
        "initial_task": {"title": "Map the onboarding flow",
                         "definition_of_done": "A breakdown the operator approved."},
    })
    assert a.status_code in (200, 201), a.text
    # standalone task — the queued-tasks path
    t = await client.post(f"/api/containers/{cid}/tasks",
                          json={"title": "Ship the fix", "definition_of_done": "Top drop-off fixed + verified."})
    assert t.status_code in (200, 201), t.text

    snap = (await client.get(f"/api/containers/{cid}")).json()
    titles = [x["title"] for x in snap["tasks"]]
    assert "Map the onboarding flow" in titles, titles
    assert "Ship the fix" in titles, titles
