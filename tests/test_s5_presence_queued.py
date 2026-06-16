"""FT-SURFACE (S5) — conversation presence: thinking-vs-queued + derive-from-durable-state.

Two folded asks land here (one [Frame] PR):
  • req b178e687 — busy/queued: when the agent holds another (task) lease the human's
    message is QUEUED, so the panel shows an honest "queued" notice + a busy pill, NOT
    fake "thinking…" dots.
  • req 1ccab87e — derive the pending-reply indicator from the DURABLE turns (last turn is
    a human turn with no agent reply) so it SURVIVES an agent-switch + reload, not just the
    optimistic in-memory `awaiting` flag.

Both render against Vault's committed presence contract (req 6de81ae3): the conversation
read payload (GET /api/agents/{aid}/conversation, GET /api/conversations/{id}) carries a
top-level `presence` (idle|waking|working|busy|replied|stopped) + opaque `presence_reason`.
The field isn't live yet — the panel degrades to deriving presence from agent.status until
it is, which this file also pins.
"""
import json
import pathlib
import shutil
import subprocess
import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- the wiring is present in the source ----------

def test_presence_contract_is_wired_into_the_panel():
    js = (STATIC / "conversation.js").read_text()
    # reads presence + presence_reason off the top level of the conversation read payload
    assert "d.presence" in js and "d.presence_reason" in js, "doesn't read the presence contract fields"
    # refreshes presence on the poll tick via GET /api/conversations/{id} (not the /turns delta)
    assert "function refreshPresence" in js and '"/api/conversations/" + encodeURIComponent(convId)' in js, \
        "presence isn't refreshed on poll"
    # the indicator is derived from durable turns, not only the optimistic flag
    assert "function awaitingReply" in js and 'last.role === "human"' in js, "indicator not derived from durable turns"
    assert "awaitingReply()" in js and "function indicatorBubble" in js, "renderList doesn't use the derived indicator"
    # busy -> honest queued notice, never fake thinking dots
    assert "function queuedBubble" in js and "presence_reason" in js, "no queued notice"
    assert "is busy with another task" in js, "no generic queued fallback line"
    # the busy pill + queued styles exist
    css = (STATIC / "agents.html").read_text()
    assert ".presence.p-busy" in css and ".conv-queued" in css, "busy pill / queued CSS missing"


# ---------- behavioral: drive the panel with stubbed DOM + fetch ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_presence_drives_queued_vs_thinking_vs_fallback():
    conv_js = (STATIC / "conversation.js").read_text()
    harness = r"""
function mkEl() {
  return { _html: "", className: "", style: {}, hidden: false, value: "",
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    set innerHTML(v){ this._html = v; }, get innerHTML(){ return this._html; },
    addEventListener(){}, querySelectorAll(){ return []; }, querySelector(){ return null; },
    focus(){}, scrollIntoView(){}, classList:{add(){},remove(){}}, dataset:{} };
}
const els = {};
["convInput","convSend","convList","convPresence","convSlash"].forEach((id) => els[id] = mkEl());
global.document = { getElementById:(id)=>els[id]||null, createElement:()=>mkEl(),
  addEventListener(){}, removeEventListener(){}, documentElement:{setAttribute(){}}, body:{appendChild(){}} };
global.window = {};
global.setInterval = () => 0;        // freeze the poll so we control the state
global.clearInterval = () => {};
global.__agentStatus = "idle";
global.__payload = {};
global.fetch = (url) => {
  if (String(url).indexOf("/conversation?limit=") >= 0)
    return Promise.resolve({ ok:true, json:()=>Promise.resolve(global.__payload) });
  return Promise.resolve({ ok:true, json:()=>Promise.resolve({ turns: [] }) });
};
window.Orcha = {
  esc:(s)=>String(s==null?"":s), linkify:(s)=>String(s==null?"":s), mdText:(s)=>String(s==null?"":s), icon:()=>"<svg></svg>", avatar:(n)=>"<av>"+n+"</av>",
  relTime:()=>"now", toast:()=>{}, actingHuman:()=>({id:"h"}),
  agentById:(id)=> id==="h" ? {id:"h",alias:"kedar",kind:"human",status:"idle"}
                            : {id:"a1",alias:"Frame",kind:"ai",status: global.__agentStatus},
};
__CONVJS__
const flush = () => new Promise((r)=>setTimeout(r, 15));

let _mountN = 0;
async function run(payload, agentStatus) {
  global.__payload = payload; global.__agentStatus = agentStatus || "idle";
  els.convList._html = ""; els.convPresence.className = "";
  // ISS-68: the panel now caches turns per-agent (no reload on tab-switch). Each case mounts a
  // DISTINCT agent id so it exercises a fresh load(), not the prior case's cache (the stub
  // returns the same Frame agent for any non-human id).
  window.OrchaConvo.mount(mkEl(), "a" + (++_mountN));
  await flush();
  const p = window.OrchaConvo.presenceOf();
  return { k: p.k, l: p.l, awaiting: window.OrchaConvo.awaitingReply(),
           list: els.convList._html, pill: els.convPresence.className };
}
(async () => {
  const humanLast = [{ seq:1, role:"human", content:"hi", author_agent_id:"h" }];
  const agentLast = humanLast.concat([{ seq:2, role:"agent", content:"hey", author_agent_id:"a1" }]);
  const out = {};
  // 1) busy + pending human turn -> queued notice (with reason) + busy pill, NOT thinking dots
  out.busy = await run({ conversation:{id:"cv1"}, turns: humanLast,
    presence:"busy", presence_reason:"busy with 'Fix reset flow' — queued" });
  // 2) working + pending -> thinking dots
  out.working = await run({ conversation:{id:"cv1"}, turns: humanLast, presence:"working" });
  // 3) field ABSENT -> derive from agent.status; agent replied last -> no pending indicator
  out.fallback = await run({ conversation:{id:"cv1"}, turns: agentLast }, "working");
  // 4) unknown future enum -> idle (forward-compat); pending human turn while idle -> queued
  out.unknown = await run({ conversation:{id:"cv1"}, turns: humanLast, presence:"frobnicate" });
  console.log(JSON.stringify(out));
})();
"""
    out = subprocess.run(["node", "-e", harness.replace("__CONVJS__", conv_js)],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    r = json.loads(out.stdout.strip().splitlines()[-1])

    # 1) busy → queued notice carrying the opaque reason, a busy pill, and NO thinking dots
    assert r["busy"]["k"] == "busy" and r["busy"]["l"] == "busy", r["busy"]
    assert r["busy"]["awaiting"] is True, r["busy"]
    assert "conv-queued" in r["busy"]["list"] and "Fix reset flow" in r["busy"]["list"], r["busy"]["list"]
    assert "conv-thinking" not in r["busy"]["list"], "busy must NOT show fake thinking dots"
    assert "p-busy" in r["busy"]["pill"], r["busy"]["pill"]

    # 2) working → animated thinking dots, not a queued notice
    assert r["working"]["k"] == "working", r["working"]
    assert "conv-thinking" in r["working"]["list"] and "conv-queued" not in r["working"]["list"], r["working"]["list"]

    # 3) field absent → presence derived from agent.status; agent replied last → indicator gone
    assert r["fallback"]["k"] == "working", "presence didn't fall back to agent.status"
    assert r["fallback"]["awaiting"] is False, "an agent reply must clear the pending indicator"
    assert "conv-thinking" not in r["fallback"]["list"] and "conv-queued" not in r["fallback"]["list"], r["fallback"]["list"]

    # 4) unknown enum value → idle (forward-compat); a pending turn while idle → honest queued, not dots
    assert r["unknown"]["k"] == "idle" and r["unknown"]["l"] == "idle", r["unknown"]
    assert "conv-queued" in r["unknown"]["list"] and "conv-thinking" not in r["unknown"]["list"], r["unknown"]["list"]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_stale_presence_response_does_not_paint_the_switched_to_agent():
    """Review P2 (PR #128): if a presence poll for agent A is in flight when the user selects
    agent B, A's late response must NOT overwrite B's panel (A's busy reason / p-busy pill)."""
    conv_js = (STATIC / "conversation.js").read_text()
    harness = r"""
function mkEl() {
  return { _html:"", className:"", style:{}, hidden:false, value:"",
    scrollHeight:0, scrollTop:0, clientHeight:0,
    set innerHTML(v){ this._html=v; }, get innerHTML(){ return this._html; },
    addEventListener(){}, querySelectorAll(){ return []; }, querySelector(){ return null; },
    focus(){}, scrollIntoView(){}, classList:{add(){},remove(){}}, dataset:{} };
}
const els = {};
["convInput","convSend","convList","convPresence","convSlash"].forEach((id)=>els[id]=mkEl());
global.document = { getElementById:(id)=>els[id]||null, createElement:()=>mkEl(),
  addEventListener(){}, removeEventListener(){}, documentElement:{setAttribute(){}}, body:{appendChild(){}} };
global.window = {};
global.__poll = null;
global.setInterval = (fn)=>{ global.__poll = fn; return 1; };   // capture the poll tick to drive it
global.clearInterval = ()=>{};
const loadPayload = {
  a1: { conversation:{id:"cvA"}, turns:[{seq:1,role:"human",content:"hi",author_agent_id:"h"}],
        presence:"busy", presence_reason:"A is busy — queued" },
  a2: { conversation:{id:"cvB"}, turns:[{seq:1,role:"human",content:"yo",author_agent_id:"h"}],
        presence:"working" },
};
global.__pendingPresence = [];     // resolvers for in-flight GET /api/conversations/{cid}
global.fetch = (url) => {
  url = String(url);
  const m = url.match(/\/api\/agents\/(\w+)\/conversation\?limit/);
  if (m) return Promise.resolve({ ok:true, json:()=>Promise.resolve(loadPayload[m[1]]) });
  if (url.indexOf("/turns") >= 0) return Promise.resolve({ ok:true, json:()=>Promise.resolve({ turns:[] }) });
  if (/\/api\/conversations\/cvA$/.test(url))   // refreshPresence for A — hold it open
    return new Promise((res)=>global.__pendingPresence.push(()=>res({ ok:true,
      json:()=>Promise.resolve({ presence:"busy", presence_reason:"A is busy — queued" }) })));
  return Promise.resolve({ ok:true, json:()=>Promise.resolve({ presence:"working" }) });  // cvB
};
window.Orcha = {
  esc:(s)=>String(s==null?"":s), linkify:(s)=>String(s==null?"":s), mdText:(s)=>String(s==null?"":s), icon:()=>"<svg></svg>", avatar:(n)=>"<av>"+n+"</av>",
  relTime:()=>"now", toast:()=>{}, actingHuman:()=>({id:"h"}),
  agentById:(id)=> id==="h" ? {id:"h",alias:"kedar",kind:"human",status:"idle"}
                            : {id, alias: id==="a1"?"Alpha":"Bravo", kind:"ai", status:"working"},
};
__CONVJS__
const flush = () => new Promise((r)=>setTimeout(r, 15));
(async () => {
  window.OrchaConvo.mount(mkEl(), "a1");
  await flush();                       // A loads -> busy
  global.__poll();                     // poll tick: refreshPresence(cvA) goes in-flight (held)
  await flush();
  window.OrchaConvo.mount(mkEl(), "a2");  // SWITCH to B before A's presence resolves
  await flush();                       // B loads -> working
  global.__pendingPresence.forEach((f)=>f());   // now A's stale presence resolves
  await flush();
  const p = window.OrchaConvo.presenceOf();
  console.log(JSON.stringify({ k:p.k, l:p.l, pill: els.convPresence.className, list: els.convList._html }));
})();
"""
    out = subprocess.run(["node", "-e", harness.replace("__CONVJS__", conv_js)],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    r = json.loads(out.stdout.strip().splitlines()[-1])
    # B's panel stays B — A's stale busy must be dropped by the mount-token guard
    assert r["k"] == "working" and r["l"] == "working", r
    assert "p-busy" not in r["pill"], "stale agent-A busy pill leaked onto agent B"
    assert "A is busy" not in r["list"] and "conv-queued" not in r["list"], "stale agent-A queued notice leaked onto B"
    assert "conv-thinking" in r["list"], "B should show its own working/thinking indicator"
