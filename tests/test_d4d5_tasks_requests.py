"""FT-SURFACE (D4 + D5 + ISS-53) — tasks.html & requests.html redesign + repaint-input guard.

D4 rewrites tasks.html and D5 rewrites requests.html onto the D0/D1 foundation (shell +
live snapshot @3s via Orcha.patch + the shared run engine). ISS-53 (same root as ISS-46)
extends Orcha.patch to defer the 3s repaint while a card INPUT is focused or holds unsaved
text, so a human can type a reject reason / an answer without it being wiped mid-keystroke.
The live click-throughs are verified in the portal; the automatable surface is the wiring,
the gate logic (plan_decision-gated, ISS-41), the request action gating, and the patch guard.
"""
import json
import pathlib
import shutil
import subprocess
import pytest

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- ISS-53: patch defers while a card input is focused or dirty ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_patch_defers_while_a_card_input_is_focused_or_dirty():
    """Orcha.patch must NOT repaint el while the user is mid-typing inside it — a focused
    input/textarea, OR a text input holding unsaved (non-empty) value. An empty, blurred
    input does not block the repaint."""
    app_js = (STATIC / "app.js").read_text()
    harness = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
function mkEl(opts) {
  const ta = { tagName: "TEXTAREA", type: "", value: opts.value || "", id: "", getAttribute: () => null };
  const el = {
    scrollHeight: 1000, clientHeight: 100, scrollTop: 0,
    get innerHTML(){ return this._h || ""; }, set innerHTML(v){ this._h = v; },
    querySelectorAll(sel){ return /input|textarea/i.test(sel) ? [ta] : []; }, contains(n){ return n === ta || n === el; },
  };
  return { el, ta };
}
global.document = { documentElement:{setAttribute(){}}, addEventListener(){}, getElementById:()=>null,
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}), body:{appendChild(){}},
  activeElement: null };
global.window = { getSelection: () => ({ rangeCount: 0, isCollapsed: true }) };
__APPJS__
const O = window.Orcha;
// 1) empty + blurred -> patch proceeds
let a = mkEl({ value: "" });
const wroteEmpty = O.patch(a.el, "<p>1</p>");
// 2) focused (activeElement inside el) -> defer
let b = mkEl({ value: "" });
global.document.activeElement = b.ta;
const wroteFocused = O.patch(b.el, "<p>2</p>");
global.document.activeElement = null;
// 3) dirty (non-empty value), not focused -> defer (don't lose typed text)
let c = mkEl({ value: "half-typed reason" });
const wroteDirty = O.patch(c.el, "<p>3</p>");
console.log(JSON.stringify({
  proceedsWhenEmpty: wroteEmpty === true && a.el.innerHTML === "<p>1</p>",
  defersWhenFocused: wroteFocused === false && b.el.innerHTML === "",
  defersWhenDirty: wroteDirty === false && c.el.innerHTML === "",
}));
"""
    out = subprocess.run(["node", "-e", harness.replace("__APPJS__", app_js)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["proceedsWhenEmpty"], res     # an empty blurred input never blocks a repaint
    assert res["defersWhenFocused"], res      # actively typing -> never clobbered
    assert res["defersWhenDirty"], res        # unsaved text -> never clobbered


# ---------- D4: tasks.html ----------

async def test_tasks_serves_and_wires_the_foundation(client):
    r = await client.get("/tasks")
    assert r.status_code == 200, r.text
    html = r.text
    for asset in ("/assets/styles.css", "/assets/app.js", "/assets/data.js"):
        assert asset in html, f"tasks doesn't load {asset}"
    assert 'mountShell("tasks"' in html and "OrchaData.start(render, 3000)" in html, "tasks doesn't boot on the foundation"
    for el in ('id="tlist"', 'id="detailMain"', 'id="runsWrap"'):
        assert el in html, f"tasks missing section {el}"


def test_tasks_static_guards():
    html = (STATIC / "tasks.html").read_text()
    assert "O.patch(" in html, "tasks doesn't render via Orcha.patch"
    # no *.html deeplinks; agent deeplinks via the shared helper on served routes
    for bad in ('href="agents.html', 'href="tasks.html', "'agents.html"):
        assert bad not in html, f"tasks links to a *.html route: {bad}"
    # the gate POSTs the real endpoints; plan-approval is gated on the durable plan_decision (ISS-41)
    assert "/api/decisions" in html and 'subject_type: "plan_approval"' in html, "plan approval not via the B0 contract"
    assert "/verify" in html and "/messages" in html, "verify / reply not wired"
    assert "/cancel" in html, "B7 close-task not wired"
    assert "!t.plan_decision" in html, "plan gate not gated on the durable plan_decision"
    # the reject-reason + reply inputs are the ISS-53-protected typing surfaces
    assert 'id="rt-' in html and 'id="reply"' in html, "no reject-reason / reply inputs"
    # runs via the shared engine, fetched per task
    assert "O.runCard(" in html and "O.activateRuns(" in html and "/api/tasks/" in html, "runs don't use the shared engine"


# ---------- D5: requests.html ----------

async def test_requests_serves_and_wires_the_foundation(client):
    r = await client.get("/requests")
    assert r.status_code == 200, r.text
    html = r.text
    for asset in ("/assets/styles.css", "/assets/app.js", "/assets/data.js"):
        assert asset in html, f"requests doesn't load {asset}"
    assert 'mountShell("requests"' in html and "OrchaData.start(render, 3000)" in html, "requests doesn't boot on the foundation"
    for el in ('id="rlist"', 'id="detailMain"'):
        assert el in html, f"requests missing section {el}"


def test_requests_static_guards():
    html = (STATIC / "requests.html").read_text()
    assert "O.patch(" in html, "requests doesn't render via Orcha.patch"
    for bad in ('href="agents.html', 'href="requests.html', "'requests.html"):
        assert bad not in html, f"requests links to a *.html route: {bad}"
    # the request chain is walkable
    assert "function chainView" in html and "in_service_of" in html, "no walkable request chain"
    # all four arbitration actions wire the REAL endpoints
    assert "/respond" in html and "/convert-to-task" in html and "/escalate" in html and "/close" in html, "request actions not fully wired"
    # actions are gated on the acting human's ROLE (respond=target, convert/escalate=requester)
    assert "isTarget" in html and "isRequester" in html, "actions not gated on the human's role (would 403)"
    # convert requires a definition of done (the endpoint mandates it)
    assert "definition_of_done: dod" in html, "convert-to-task doesn't send a definition of done"
    # the inline answer box is the ISS-53-protected typing surface; deeplinks on served routes
    assert 'id="ansIn"' in html, "no inline answer input (ISS-53 surface)"
    assert 'href="/agents?agent=' in html, "agent deeplinks not on the served route"


def test_review_p1_fixes():
    """PR #114 review (3x P1):
    A) human thread comments are ATTRIBUTED with the acting human's id (#271 — was: omit the id
       for the NULL=human path; that spoof hole is closed, the server now derives is_human from
       agents.kind and a human is a container member, so the attributed id passes the guard).
    B) every successful submit clears its input before re-render, so the ISS-53 dirty-input
       guard can't block the acknowledged repaint (stale controls / double-submit).
    C) every task status stays visible in the list (pending/failed have buckets + a catch-all)."""
    tasks = (STATIC / "tasks.html").read_text()
    reqs = (STATIC / "requests.html").read_text()
    # A (#271): the reply POST attributes the acting human and gates on one being selected.
    # Robust to extra fields on the body object (#301 added an optional `attachments`): the
    # guard is that the POST still carries body + the acting human's id, not the exact literal.
    assert '/messages",' in tasks and "body: v, author_agent_id: h.id" in tasks, \
        "human comment must be attributed with the acting human's id (#271)"
    assert "const h = actorOrWarn(); if (!h) return;" in tasks, \
        "reply must require an acting human before posting (#271)"
    # B: success paths clear (and blur) the submitted input before render
    assert 'ta.value = ""' in tasks, "gate reject doesn't clear the reason before re-render"
    assert 'cr.value = ""' in tasks, "task close doesn't clear its reason before re-render"
    assert 'inp.value = ""; inp.blur()' in tasks, "reply doesn't clear its input before re-render"
    assert 'ai.value = ""' in reqs, "answer doesn't clear #ansIn before re-render"
    # C: pending + failed have buckets, and a catch-all renders any other status
    assert 'k: "pending"' in tasks and 'k: "failed"' in tasks, "pending/failed tasks have no list bucket"
    assert "!grouped.has(t.id)" in tasks, "no catch-all — a task with an unexpected status would vanish"


def test_review_p2_fixes():
    """PR #114 re-review (2x P2 on requests.html):
    A) cancelling the inline answer editor must clear #ansIn first, or the ISS-53
       dirty-input guard blocks the repaint and the editor stays open forever.
    B) human-target detection must use the SHARED O.isToHuman (resolves any human by id),
       not a first-human shortcut that misses non-first humans in a multi-human container."""
    reqs = (STATIC / "requests.html").read_text()
    # A: cancel-answer clears+blurs the box before re-render
    cancel = reqs[reqs.index('act === "cancel-answer"'):reqs.index('act === "cancel-answer"') + 360]
    assert 'ai.value = ""' in cancel and "renderDetail()" in cancel, "cancel-answer doesn't clear #ansIn before repaint"
    # B: delegates to the shared detector; no first-human shortcut
    assert "return O.isToHuman(r)" in reqs, "doesn't use the shared human-target detector"
    assert "O.humans()[0]" not in reqs, "still uses the first-human shortcut (misses non-first humans)"
