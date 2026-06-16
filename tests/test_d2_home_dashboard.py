"""FT-SURFACE (D2) — redesigned home dashboard on the D0/D1 foundation.

home.html is rewritten to the design system: it loads the shared assets, mounts the
shell, and renders five sections from the LIVE snapshot on the 3s cadence (every
section repainted via Orcha.patch — scroll/selection safe): the container ctxbar, the
"Needs your attention" action queue HERO (plans to approve + tasks to verify +
escalations, with inline approve/reject), agents-at-a-glance, live activity, and a
tasks-by-status kanban. The visual is verified live; the automatable surface is the
wiring + the action-queue logic.
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


# ---------- the page serves + boots on the foundation ----------

async def test_home_serves_and_wires_the_foundation(client):
    r = await client.get("/")
    assert r.status_code == 200, r.text
    html = r.text
    for asset in ("/assets/styles.css", "/assets/app.js", "/assets/data.js"):
        assert asset in html, f"home doesn't load {asset}"
    assert 'mountShell("home"' in html, "home doesn't mount the shell"
    assert "OrchaData.start(render, 3000)" in html, "home doesn't boot the live adapter on the 3s cadence"
    # the five sections are present
    for el in ('id="ctxbar"', 'id="aqGrid"', 'id="agTbl"', 'id="actList"', 'id="kanban"'):
        assert el in html, f"home missing section {el}"


# ---------- static guards ----------

def test_home_uses_patch_and_served_route_deeplinks():
    html = (STATIC / "home.html").read_text()
    # every section repaints via the scroll/selection-safe primitive (ISS-46), not raw innerHTML
    assert "O.patch(" in html, "home doesn't render via Orcha.patch"
    # deeplinks target the served routes, never *.html (review P2 of D1)
    for bad in ('href="agents.html', 'href="tasks.html', 'href="requests.html', "'agents.html", "'tasks.html"):
        assert bad not in html, f"home links to a *.html route: {bad}"
    assert 'href="/agents"' in html and 'href="/tasks"' in html, "seeall links not on served routes"
    assert "location.href='/agents?agent=" in html and "location.href='/tasks?task=" in html, "row deeplinks not on served routes"
    # the action queue has INLINE approve/reject wired to the real endpoints (plan-first gate)
    assert 'data-kind="plan"' in html and 'data-kind="verify"' in html, "no inline plan/verify actions"
    assert "/api/decisions" in html and 'subject_type: "plan_approval"' in html, "plan approval not via the B0 decision contract"
    assert "/verify" in html, "task verify not wired"
    assert "O.actingHuman()" in html, "actions don't resolve the acting human"
    # review P1: the plan card shows the FULL plan body (scrollable), not a truncated summary.
    # ISS-44: rendered via linkify() (esc-first + clickable URLs), still the whole body.
    assert "O.linkify(planText(t))" in html, "plan card must show the full plan, not a truncated summary"
    assert "O.trunc(planText(t)" not in html, "plan body must not be truncated before approval"
    # review P2: one-shot — acted cards are suppressed immediately + not re-submittable
    assert "const d2Acted = new Set()" in html, "no one-shot per-task acted cache"
    assert "d2Acted.has(t.id)" in html, "acted cards aren't suppressed on render"
    assert "d2Acted.add(taskId)" in html, "a successful decision doesn't mark the card acted"
    # review P2 follow-up (:173): suppression must be pruned when the task leaves the
    # actionable set, so a reject→rework cycle that returns the same id isn't hidden forever
    assert "if (!actionable.has(id)) d2Acted.delete(id)" in html, \
        "d2Acted is never pruned — a reworked task stays hidden permanently this session"


# ---------- action-queue logic: plans to approve (node) ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_attn_queue_includes_pending_plans_only():
    """attnItems() must surface in-progress tasks whose agent posted a plan and that
    have NO plan_approval decision yet (the hero's 'plans to approve'), alongside
    needs_verification + escalations — and exclude already-decided or plan-less ones."""
    app_js = (STATIC / "app.js").read_text()
    harness = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}} };
global.window = {};
__APPJS__
const O = window.Orcha;
O.applySnapshot({
  container:{id:"c",status:"active"},
  agents:[{id:"h",alias:"kedar",kind:"human"},{id:"a1",alias:"Frame",kind:"ai"}],
  tasks:[
    // pending plan: in_progress + agent message + no plan_decision -> COUNTS
    { id:"t1", title:"X", status:"in_progress", assignees:["Frame"], plan_decision:null,
      thread:[{ id:"m", is_human:false, from:"Frame", body:"PLAN" }] },
    // decided plan: has a plan_decision -> EXCLUDED
    { id:"t2", title:"Y", status:"in_progress", assignees:["Frame"], plan_decision:{decision:"approve"},
      thread:[{ id:"m", is_human:false, from:"Frame", body:"PLAN" }] },
    // in_progress but no agent plan (only a human note) -> EXCLUDED
    { id:"t3", title:"Z", status:"in_progress", assignees:["Frame"], plan_decision:null,
      thread:[{ id:"m", is_human:true, from:"human", body:"hi" }] },
    // needs_verification -> verify
    { id:"t4", title:"W", status:"needs_verification", assignees:["Frame"] },
  ],
  requests:[ { id:"r", type:"info", requester_id:"a1", target_id:null, status:"open", from:"Frame", to:"human" } ],
});
const aq = O.attnItems();
console.log(JSON.stringify({
  plans: aq.plans.map(t=>t.id),
  verifs: aq.verifs.map(t=>t.id),
  escs: aq.escs.length,
  count: aq.count,
}));
"""
    out = subprocess.run(["node", "-e", harness.replace("__APPJS__", app_js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["plans"] == ["t1"], res          # only the pending, undecided, agent-authored plan
    assert res["verifs"] == ["t4"], res
    assert res["escs"] == 1, res
    assert res["count"] == 3, res                # 1 plan + 1 verify + 1 escalation
