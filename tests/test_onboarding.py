"""FT-SURFACE (O1+O2+O3) — first-run onboarding wizard (/onboarding) on the D0/D1 foundation.

The /onboarding page serves the wizard shell + onboarding.js (a guided state machine:
welcome → fork → create-agent | create-tasks → agent-created). Unlike the localStorage
mockup it was lifted from, it WIRES TO THE REAL API:
  O1 — register the operator (human) via POST .../agents kind='human'.
  O2 — create an agent via POST .../agents kind='ai' + prompt (+ optional initial_task),
       models from GET /api/models.
  O3 — a versioned CONCIERGE_TEMPLATE seeds the first agent's system prompt (editable).
  O4 — HELD: the assign/wake step is a "coming soon" stub (no assign endpoint wired).

The live visual is verified in the portal; the automatable surface is the page wiring +
the endpoints round-trip + static guards on the JS contract.
"""
import json
import pathlib
import shutil
import subprocess
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- the page serves + boots on the foundation ----------

async def test_onboarding_serves_and_boots(client):
    r = await client.get("/onboarding")
    assert r.status_code == 200, r.text
    html = r.text
    for asset in ("/assets/styles.css", "/assets/app.js", "/assets/data.js", "/assets/onboarding.js"):
        assert asset in html, f"onboarding doesn't load {asset}"
    # the shell mount points exist
    for el in ('id="sidebar"', 'id="topbar"', 'id="content"'):
        assert el in html, f"onboarding missing shell element {el}"
    # the wizard JS itself is served from /assets
    a = await client.get("/assets/onboarding.js")
    assert a.status_code == 200, "onboarding.js not served from /assets"


# ---------- static guards on the wizard contract ----------

def test_onboarding_registers_human_and_creates_agent():
    js = (STATIC / "onboarding.js").read_text()
    # O1: register the operator as a HUMAN via the agents endpoint
    assert "/agents" in js, "doesn't POST to the agents endpoint"
    assert 'kind: "human"' in js, "operator not registered with kind:human"
    assert 'role: "Operator"' in js, "operator role not set"
    # O2: create an AI agent WITH a prompt
    assert 'kind: "ai"' in js, "agent not created with kind:ai"
    assert "prompt" in js, "agent create doesn't send a system prompt"
    # resolve the container once + use it for both POSTs
    assert "OrchaData.resolveCid()" in js, "container id not resolved via resolveCid()"


def test_onboarding_reads_models_and_supports_initial_task():
    js = (STATIC / "onboarding.js").read_text()
    # O2: models come from GET /api/models (display name, send id), default applied
    assert "/api/models" in js, "doesn't read the canonical model list"
    assert "d.default" in js, "doesn't honor the models default"
    assert "m.id" in js, "model picker doesn't carry the curated id"
    # O2: an OPTIONAL initial_task with the right shape {title, definition_of_done}
    assert "initial_task" in js, "no optional initial_task support"
    assert "definition_of_done" in js, "initial_task missing definition_of_done"
    # review P2: the 'add tasks first' path persists EVERY queued task (POST /tasks), not just [0]
    assert "/tasks" in js and "for (const t of S.tasks)" in js, "tasks-first branch doesn't persist every queued task"
    assert "S.tasks[0]" not in js, "tasks-first branch still drops the queue (only carries the first task)"


def test_onboarding_has_concierge_template_for_first_agent():
    js = (STATIC / "onboarding.js").read_text()
    # O3: a versioned concierge template constant, editable in the textarea
    assert "CONCIERGE_TEMPLATE" in js, "no concierge template constant"
    # the seed mentions its key behaviors: suggest (not create) agents, requests, no self-cert
    assert "/orcha-suggest-agent" in js, "concierge template doesn't point at /orcha-suggest-agent"
    assert "self-certify" in js or "needs_verification" in js, "concierge template omits the human-authoritative rule"
    # "first agent" is detected from the snapshot (zero AI agents), not a local flag
    assert "aiAgents().length === 0" in js, "first-agent detection isn't snapshot-derived"


def test_onboarding_o4_is_a_held_stub_no_assign_wired():
    js = (STATIC / "onboarding.js").read_text()
    # O4 held: a coming-soon stub note, NOT a wired assign/wake step
    assert "coming soon" in js.lower(), "no held coming-soon stub for the assign step"
    assert "B5 assign endpoint" in js, "the held stub doesn't name the missing B5 assign endpoint"
    # no invented assign/wake endpoint CALLS (prose like "the assign/wake step" is fine —
    # what's forbidden is actually fetching one of these paths)
    for bad in ('"/assign', "'/assign", '/api/wakes', "/wakes", "/wake-scan"):
        assert bad not in js, f"O4 must stay held — wired a forbidden endpoint: {bad}"
    # and there must be NO fetch to a per-agent /wake* mutation
    assert "/wake\"" not in js and "/wake'" not in js, "must not wire a wake endpoint while O4 is held"


def test_onboarding_deeplinks_use_served_routes():
    js = (STATIC / "onboarding.js").read_text()
    # deep-link to an agent on the served route, never the *.html filename
    assert "/agents?agent=" in js, "agent deep-link not on the served /agents route"
    for bad in ('agents.html', 'home.html"', 'tasks.html'):
        assert bad not in js, f"onboarding links to a *.html route: {bad}"


# ---------- the page route is registered the same way as the others ----------

def test_onboarding_route_registered_in_main():
    main = (REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "main.py").read_text()
    assert '@app.get("/onboarding"' in main, "no served /onboarding route"
    assert '_serve("onboarding.html")' in main, "onboarding route doesn't serve the static shell"


# ---------- home empty-state CTA → /onboarding ----------

def test_home_empty_state_cta_links_to_onboarding():
    html = (STATIC / "home.html").read_text()
    # CTA surfaces only when there are no AI agents, and links to the wizard
    assert 'href="/onboarding"' in html, "home empty-state CTA doesn't link to /onboarding"
    assert 'a.kind !== "human"' in html, "CTA condition isn't 'no AI agents'"


# ---------- pure step-machine logic (node) ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_step_machine_transitions_are_pure():
    """The wizard exposes pure, DOM-free step-machine helpers (window.OrchaOnboarding):
    railKeyFor maps a step to its rail group, and resumeStep decides where the flow
    resumes given whether an operator already exists (skip welcome → fork; never
    double-register)."""
    js = (STATIC / "onboarding.js").read_text()
    harness = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { getElementById: () => null, addEventListener(){}, documentElement:{setAttribute(){}},
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}} };
global.fetch = () => Promise.reject("no fetch in test");
global.setInterval = () => 0;
global.window = {
  Orcha: { icon:()=>"", esc:(s)=>String(s==null?"":s), avatar:()=>"", trunc:(s)=>s, pill:()=>"", kindBadge:()=>"",
    orcaSVG:()=>"", toast(){}, mountShell(){}, agents:()=>[], tasks:()=>[], setActingHuman(){} },
  OrchaData: { resolveCid: () => Promise.reject("x"), start: () => {} },
};
__ONBJS__
const M = window.OrchaOnboarding;
const out = {
  railWelcome: M.railKeyFor("welcome"),
  railFork: M.railKeyFor("fork"),
  railCreateAgent: M.railKeyFor("create-agent"),
  railCreated: M.railKeyFor("agent-created"),
  // resume: welcome + operator-exists -> jump to fork (no double-register)
  resumeSkipsWelcome: M.resumeStep("welcome", true),
  // resume: deep step but NO operator -> back to welcome
  resumeNoOperator: M.resumeStep("create-agent", false),
  // resume: normal continuation
  resumeNormal: M.resumeStep("fork", true),
  templateMentionsSuggest: M.CONCIERGE_TEMPLATE.indexOf("/orcha-suggest-agent") >= 0,
  // GHOST RECONCILE (#140): persisted "agent-created" for an agent the live snapshot
  // no longer has -> drop the dead alias + fall back to fork (the onboarding ghost).
  ghostReset: M.reconcileGhost({ step: "agent-created", lastAgentAlias: "Requester" }, []),
  // an agent that STILL exists is left untouched (happy path, no false reset).
  ghostKept: M.reconcileGhost({ step: "agent-created", lastAgentAlias: "Requester" }, ["Requester"]),
  // no persisted agent at all -> nothing to reconcile.
  ghostNoop: M.reconcileGhost({ step: "fork", lastAgentAlias: null }, []),
};
console.log(JSON.stringify(out));
"""
    out = subprocess.run(["node", "-e", harness.replace("__ONBJS__", js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["railWelcome"] == "welcome", res
    assert res["railFork"] == "fork", res
    assert res["railCreateAgent"] == "build", res
    assert res["railCreated"] == "build", res
    assert res["resumeSkipsWelcome"] == "fork", res        # operator exists -> never re-welcome
    assert res["resumeNoOperator"] == "welcome", res        # no operator -> back to welcome
    assert res["resumeNormal"] == "fork", res
    assert res["templateMentionsSuggest"] is True, res
    # #140 onboarding-ghost: a reset (agent gone from live snapshot) clears the stale
    # success screen instead of re-rendering a vanished agent on soft refresh.
    assert res["ghostReset"]["lastAgentAlias"] is None, res
    assert res["ghostReset"]["step"] == "fork", res
    assert res["ghostKept"]["lastAgentAlias"] == "Requester", res   # live agent untouched
    assert res["ghostKept"]["step"] == "agent-created", res
    assert res["ghostNoop"]["step"] == "fork", res                   # nothing to do


# ---------- real round-trip against the endpoints the page uses ----------

async def test_onboarding_can_register_human_and_create_agent(client, container):
    cid = container["id"]
    # O1: register the operator (human)
    h = await client.post(f"/api/containers/{cid}/agents",
                          json={"alias": "Dario", "role": "Operator", "kind": "human"})
    assert h.status_code in (200, 201), h.text
    assert h.json()["agent_id"]

    # models endpoint the picker reads
    m = await client.get("/api/models")
    assert m.status_code == 200, m.text
    models = m.json()
    assert models["models"] and "default" in models
    model_id = models["default"]

    # O2: create an AI agent with a prompt + chosen model + an optional initial_task
    a = await client.post(f"/api/containers/{cid}/agents", json={
        "alias": "Atlas", "role": "Concierge", "kind": "ai",
        "prompt": "You are the concierge agent. Suggest agents via /orcha-suggest-agent; never self-certify.",
        "model": model_id,
        "initial_task": {"title": "Plan the workspace",
                         "definition_of_done": "A task breakdown the operator approved."},
    })
    assert a.status_code in (200, 201), a.text
    assert a.json()["agent_id"]

    # both exist in the snapshot, with the right kinds
    snap = await client.get(f"/api/containers/{cid}")
    assert snap.status_code == 200, snap.text
    agents = snap.json()["agents"]
    by_alias = {x["alias"]: x for x in agents}
    assert by_alias["Dario"]["kind"] == "human"
    assert by_alias["Atlas"]["kind"] == "ai"
    assert by_alias["Atlas"]["model"] == model_id
    # the initial_task surfaced as a task
    titles = [t["title"] for t in snap.json()["tasks"]]
    assert "Plan the workspace" in titles, titles


# ---------- O-series bug fixes (PR #121 follow-up) ----------

def test_onboarding_does_not_rebuild_on_every_tick():
    """Bug: the wizard jumped on the 3s repaint because OrchaData.start re-rendered the whole
    form every tick (innerHTML rebuild + scrollTo). Fix: boot ONCE, no per-tick re-render —
    the snapshot stays fresh; user navigation drives renders."""
    js = (STATIC / "onboarding.js").read_text()
    import re as _re
    start = _re.search(r"OrchaData\.start\(\(\) => \{.*?\}, 3000\)", js, _re.S).group(0)
    assert "booted = true; boot();" in start, "doesn't boot once"
    assert "else { render(); }" not in start and "else render()" not in start, \
        "still re-renders the whole wizard every 3s tick (the jump bug)"


def test_add_another_agent_affordance_and_deeplink():
    """Bug: no way to add a SECOND agent once the empty-state CTA was gone. Fix: a persistent
    '+ New agent' affordance on the dashboard + agents page → /onboarding?new=1, and onboarding
    jumps straight to the create-agent step when ?new=1 (operator already exists)."""
    home = (STATIC / "home.html").read_text()
    agents = (STATIC / "agents.html").read_text()
    js = (STATIC / "onboarding.js").read_text()
    assert "/onboarding?new=1" in home, "home has no persistent '+ New agent' entry point"
    assert "/onboarding?new=1" in agents, "agents page has no '+ New agent' entry point"
    assert 'q.get("new") === "1"' in js, "onboarding doesn't honor the ?new=1 deep-link"
    assert 'S.step = "create-agent"' in js, "?new=1 doesn't jump to the create-agent step"


def test_onboarding_refreshes_snapshot_after_writes():
    """review P2: since the per-tick rebuild was removed, a write must explicitly refresh the
    snapshot before rendering the next snapshot-derived step — else a just-created human /
    agent / task won't appear until the user navigates away/back."""
    js = (STATIC / "onboarding.js").read_text()
    assert "async function refreshAnd(step)" in js and "window.OrchaData.refresh()" in js, "no refresh-then-render helper"
    assert 'await refreshAnd("create-agent")' in js, "tasks-first doesn't refresh before the create-agent picker"
    assert 'await refreshAnd("fork")' in js and 'await refreshAnd("agent-created")' in js, "register/create don't refresh before next step"


def test_onboarding_no_jump_on_any_screen():
    """Finding 3: scroll-to-top belongs to an explicit step change (go), not render() — so a
    refresh/re-render of the CURRENT step (any path) never jumps; and the models-load path
    updates the picker in place instead of a full form rebuild."""
    js = (STATIC / "onboarding.js").read_text()
    assert "render(); window.scrollTo({ top: 0 }); }" in js, "scrollTo not scoped to go() (step change)"
    assert js.count("window.scrollTo") == 1, "scrollTo still fires outside an explicit step change"
    assert "mc.innerHTML = modelCards(" in js, "models-load still does a full re-render (jump)"


def test_onboarding_reconciles_ghost_against_live_snapshot():
    """#140 frontend half (onboarding-ghost): the SPA must NOT re-render a stale
    'agent-created' success screen after a workspace reset. boot() reconciles the
    persisted local flow against the live server snapshot, and the success screen
    bails to fork if the celebrated agent is gone from server truth."""
    js = (STATIC / "onboarding.js").read_text()
    # the pure reconciler exists + is exported for tests
    assert "function reconcileGhost(" in js, "no ghost reconciler"
    assert "reconcileGhost," in js, "reconcileGhost not exported on window.OrchaOnboarding"
    # boot() reconciles against the LIVE snapshot before resuming the step
    assert "reconcileGhost(S, snapAgents().map(" in js, "boot() doesn't reconcile against the live snapshot"
    # defensive render-time guard: no live agent -> don't render the dead success card
    assert "if (!a) { S.lastAgentAlias = null; save(); go(\"fork\"); return; }" in js, \
        "agent-created screen still renders a vanished agent"


def test_initial_task_picker_selects_by_id_not_index():
    """Finding 4: the existing-task picker selects by task ID (correct after a refresh/reorder),
    not a positional index into a stale snapshot."""
    js = (STATIC / "onboarding.js").read_text()
    assert "draft._pickId" in js and "data-pickid" in js, "picker doesn't select by task id"
    assert 'data-pick="${i}"' not in js and "rts[draft._pick]" not in js, "picker still uses a fragile positional index"
    assert "const rtsLive = readyTasks()" in js, "pick list isn't recomputed live"
