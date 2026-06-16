"""#337 — file attachments on agent CONVERSATIONS (parity with #330 task-thread attachments).

The conversation-attachment BACKEND + agent-feed landed with #338 (upload/serve routes,
``conversation_turns.attachments``, ``render_attachment_feed`` — covered by
``test_iss338_attachment_feed``). #337 closes the loop on the FRONTEND by porting the task-thread
composer (#301/#330, ``tasks.html``) into the conversation panel: a paperclip / drag-drop / paste
composer that stages + uploads to the conversation-scoped store, rides the stored ids on the turn
POST, and renders attachments in the read view (image thumbnails w/ lightbox, file download chips).

Frontend-only — the routes already exist. These static guards pin the wiring; the node behavioral
case drives the REAL upload→send path against a stubbed DOM + fetch so the conv-scoped upload URL,
the get-or-create-first ordering, and the attachment ref on the turn POST are all exercised, not
just grepped.
"""
import pathlib
import shutil
import subprocess
import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


# ---------- static guards: composer affordance ----------

def test_conversation_composer_has_attachment_affordance():
    js = (STATIC / "conversation.js").read_text()
    # paperclip button + hidden file input + staging tray in the rendered skeleton
    assert 'id="convAttach"' in js and 'id="convAttachInput"' in js, "no attach button / file input in the composer"
    assert 'id="convTray"' in js, "no staging tray in the composer skeleton"
    assert 'type="file"' in js and 'accept=".png' in js, "file input missing the type-allowlist accept"
    # wired on every mount (paperclip click / drag-drop / paste)
    assert "function wireAttach" in js and "wireAttach()" in js, "attach controls not wired on mount"
    assert '"dragenter"' in js and '"dragover"' in js and '"drop"' in js, "no drag-drop wiring"
    assert '"paste"' in js, "no paste-to-attach wiring"


# ---------- static guards: upload is conversation-scoped + get-or-create first ----------

def test_conversation_upload_is_conversation_scoped():
    js = (STATIC / "conversation.js").read_text()
    assert 'fetch("/api/conversations/"' in js and "/attachments" in js, \
        "upload not posted to the conversation-scoped attachments route"
    assert "function ensureConv" in js, "no get-or-create helper before a conv-scoped upload"
    assert "FormData" in js and 'fd.append("file"' in js, "upload doesn't send the file as multipart"
    # client-side extension allowlist mirrors the backend allowlist
    assert "ACCEPT_EXT" in js and '"png"' in js and '"pdf"' in js, "no client-side extension allowlist"


# ---------- static guards: the turn POST carries refs + attachment-only is allowed ----------

def test_turn_post_carries_attachments_and_allows_attachment_only():
    js = (STATIC / "conversation.js").read_text()
    assert "attachments: atts.length ? atts : undefined" in js, "turn POST doesn't carry staged attachment refs"
    assert "done.map((s) => ({ id: s.ref.id, name: s.ref.name }))" in js, \
        "doesn't send minimal {id,name} refs (server re-validates size/type from disk)"
    # attachment-only turns (no text) are allowed; a truly-empty send is still blocked
    assert "if (!v && !done.length) return;" in js, "doesn't allow attachment-only turns / doesn't block truly-empty"
    assert 'O().toast("Wait for uploads to finish"' in js, "doesn't block send while an upload is still in flight"
    # the original turn contract is preserved (test_s1 pins this exact substring too)
    assert 'role: "human", author_agent_id: h.id, content: v' in js, "broke the human-turn POST contract"


# ---------- static guards: read view renders attachments + lightbox ----------

def test_read_view_renders_attachments_with_lightbox():
    js = (STATIC / "conversation.js").read_text()
    assert "function attRow" in js, "no read-view attachment renderer"
    assert "t.attachments" in js and "msg-atts" in js, "bubble() doesn't render the turn's attachments"
    assert "att-img" in js and "data-lightbox" in js, "image attachments not rendered as lightbox thumbnails"
    assert "att-file" in js, "non-image attachments not rendered as download chips"
    # lightbox handler is bound ONCE at module load (not per-mount → can't accumulate)
    assert "att-lightbox" in js, "no lightbox overlay"


# ---------- static guards: agents.html styles the surface without breaking the §3b lock ----------

def test_agents_css_styles_the_attachment_surface():
    css = (STATIC / "agents.html").read_text()
    for sel in (".conv-attach", ".conv-tray", ".att-chip", ".msg-atts", ".att-img",
                ".att-file", ".att-lightbox", ".conv.dragover"):
        assert sel in css, f"agents.html missing attachment style {sel}"
    # MUST NOT break the §3b lock-dim adjacency (conv-lock must still immediately precede composer)
    assert ".conv-lock:not([hidden]) + .conv-composer" in css, "lock-dim adjacency rule lost"


# ---------- behavioral: drive the real upload→send path with a stubbed DOM + fetch ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_upload_then_send_drives_the_conversation_attachment_path(tmp_path):
    conv_js = (STATIC / "conversation.js").read_text()
    harness = r"""
function recEl(id) {
  const h = {};
  const el = { id: id || "", _html: "", className: "", style: {}, hidden: false, value: "",
    disabled: false, files: null, scrollHeight: 0, scrollTop: 0, clientHeight: 0, dataset: {},
    set innerHTML(v){ this._html = v == null ? "" : String(v); }, get innerHTML(){ return this._html; },
    addEventListener(ev, fn){ (h[ev] = h[ev] || []).push(fn); },
    fire(ev, arg){ (h[ev] || []).forEach((fn) => fn(arg || { preventDefault(){}, target: el })); },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    focus(){}, scrollIntoView(){}, click(){ this.fire("click"); },
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    getAttribute(k){ return el["_a_" + k] || null; }, setAttribute(k, v){ el["_a_" + k] = v; },
    appendChild(){}, removeChild(){} };
  return el;
}
const els = {};
["convInput","convSend","convList","convPresence","convSlash","convAttach","convAttachInput",
 "convTray","convPair","convMax","convLock","convPairWrap","convTermSlot"].forEach((id) => els[id] = recEl(id));
const host = recEl("host");
host.querySelector = (sel) => (sel === ".conv" ? recEl("conv") : null);
global.document = { getElementById: (id) => els[id] || null, createElement: () => recEl(),
  addEventListener(){}, removeEventListener(){}, documentElement: { setAttribute(){} }, body: { appendChild(){} } };
global.window = {};
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => { if (fn) fn(); return 0; };
global.FormData = function () { this._p = []; this.append = (k, v, n) => this._p.push([k, n]); };
const CALLS = [];
global.fetch = (url, init) => {
  const method = (init && init.method) || "GET";
  CALLS.push({ url: String(url), method, body: init && init.body });
  const u = String(url);
  if (u.indexOf("/conversation?limit=") >= 0)                  // load(): no existing conversation yet
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ conversation: null, turns: [] }) });
  if (/\/api\/agents\/[^/]+\/conversations$/.test(u))          // ensureConv get-or-create
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ conversation: { id: "c1" } }) });
  if (/\/attachments$/.test(u))                                // conv-scoped upload
    return Promise.resolve({ ok: true, json: () => Promise.resolve(
      { id: "abc_shot.png", name: "shot.png", size: 1234, kind: "image", url: "/api/conversations/c1/attachments/abc_shot.png" }) });
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ turns: [] }) });  // turns POST / poll
};
window.Orcha = { esc: (s) => String(s == null ? "" : s), linkify: (s) => s, mdText: (s) => s,
  icon: () => "<svg></svg>", avatar: (n) => "<av>" + n + "</av>", relTime: () => "now", toast: () => {},
  actingHuman: () => ({ id: "h" }), leaseOf: () => null,
  agentById: (id) => id === "h" ? { id: "h", alias: "kedar", kind: "human" }
                                 : { id: "a1", alias: "Frame", kind: "ai", status: "idle" } };
__CONVJS__
const flush = () => new Promise((r) => setTimeout(r, 0));
async function drain() { for (let i = 0; i < 12; i++) await flush(); }
async function main() {
  window.OrchaConvo.mount(host, "a1");
  await drain();
  // 1) pick a file → the input's change handler stages + uploads it
  els.convAttachInput.files = [{ name: "shot.png", size: 1234 }];
  els.convAttachInput.fire("change");
  await drain();
  const up = CALLS.find((c) => /\/api\/conversations\/c1\/attachments$/.test(c.url) && c.method === "POST");
  console.log("UPLOAD_URL", up ? up.url : "NONE");
  const ensure = CALLS.find((c) => /\/api\/agents\/a1\/conversations$/.test(c.url) && c.method === "POST");
  console.log("ENSURE", ensure ? "yes" : "no");
  // 2) type + send → the turn POST carries the uploaded ref
  els.convInput.value = "look at this";
  els.convSend.fire("click");
  await drain();
  const turn = CALLS.find((c) => /\/api\/conversations\/c1\/turns$/.test(c.url) && c.method === "POST");
  console.log("TURN_BODY", turn ? turn.body : "NONE");
}
main().then(() => console.log("DONE")).catch((e) => { console.error("ERR", (e && e.stack) || e); process.exit(2); });
"""
    script = harness.replace("__CONVJS__", conv_js)
    p = tmp_path / "harness.js"
    p.write_text(script)
    out = subprocess.run(["node", str(p)], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, f"node harness errored:\n{out.stderr}\n{out.stdout}"
    assert "DONE" in out.stdout, f"harness didn't finish:\n{out.stdout}"
    # the upload hits the CONVERSATION-scoped route, after get-or-creating the conversation
    assert "UPLOAD_URL /api/conversations/c1/attachments" in out.stdout, out.stdout
    assert "ENSURE yes" in out.stdout, f"upload didn't get-or-create the conversation first:\n{out.stdout}"
    # the turn POST body carries the uploaded attachment ref ({id,name})
    assert '"attachments"' in out.stdout and "abc_shot.png" in out.stdout, \
        f"turn POST didn't carry the attachment ref:\n{out.stdout}"


# ---------- behavioral: stale-upload/remount race must NOT leak across agents (Gate P1) ----------

@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_upload_then_switch_agent_does_not_leak_attachment(tmp_path):
    """P1 regression: start an upload for agent A before any conversation exists, switch to agent B
    before A's get-or-create resolves, then send from B. The stale ensureConv/upload completions for
    A must NOT overwrite the global convId or stage A's attachment into B's tray — B's turn must go
    to B's own conversation and carry no attachment. Pre-fix this leaked: the turn POSTed to A's
    conversation with A's attachment. Drives the real DOM+fetch path; A's create is held open until
    after the remount so the race is deterministic, not timing-dependent."""
    conv_js = (STATIC / "conversation.js").read_text()
    harness = r"""
function recEl(id) {
  const h = {};
  const el = { id: id || "", _html: "", className: "", style: {}, hidden: false, value: "",
    disabled: false, files: null, scrollHeight: 0, scrollTop: 0, clientHeight: 0, dataset: {},
    set innerHTML(v){ this._html = v == null ? "" : String(v); }, get innerHTML(){ return this._html; },
    addEventListener(ev, fn){ (h[ev] = h[ev] || []).push(fn); },
    fire(ev, arg){ (h[ev] || []).forEach((fn) => fn(arg || { preventDefault(){}, target: el })); },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    focus(){}, scrollIntoView(){}, click(){ this.fire("click"); },
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    getAttribute(k){ return el["_a_" + k] || null; }, setAttribute(k, v){ el["_a_" + k] = v; },
    appendChild(){}, removeChild(){} };
  return el;
}
const els = {};
["convInput","convSend","convList","convPresence","convSlash","convAttach","convAttachInput",
 "convTray","convPair","convMax","convLock","convPairWrap","convTermSlot"].forEach((id) => els[id] = recEl(id));
const host = recEl("host");
host.querySelector = (sel) => (sel === ".conv" ? recEl("conv") : null);
global.document = { getElementById: (id) => els[id] || null, createElement: () => recEl(),
  addEventListener(){}, removeEventListener(){}, documentElement: { setAttribute(){} }, body: { appendChild(){} } };
global.window = {};
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => { if (fn) fn(); return 0; };
global.FormData = function () { this._p = []; this.append = (k, v, n) => this._p.push([k, n]); };
const CALLS = [];
// hold agent A's get-or-create open until we release it (AFTER switching to B)
let releaseA; const aPending = new Promise((res) => { releaseA = res; });
global.fetch = (url, init) => {
  const method = (init && init.method) || "GET";
  CALLS.push({ url: String(url), method, body: init && init.body });
  const u = String(url);
  if (u.indexOf("/conversation?limit=") >= 0)                  // load(): no existing conversation yet
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ conversation: null, turns: [] }) });
  if (/\/api\/agents\/a1\/conversations$/.test(u))            // A's get-or-create — HELD OPEN (the race)
    return aPending.then(() => ({ ok: true, json: () => Promise.resolve({ conversation: { id: "cA" } }) }));
  if (/\/api\/agents\/a2\/conversations$/.test(u))            // B's get-or-create — resolves normally
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ conversation: { id: "cB" } }) });
  if (/\/attachments$/.test(u))                                // conv-scoped upload
    return Promise.resolve({ ok: true, json: () => Promise.resolve(
      { id: "abc_shot.png", name: "shot.png", size: 1234, kind: "image", url: "/api/conversations/cA/attachments/abc_shot.png" }) });
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ turns: [] }) });  // turns POST / poll
};
window.Orcha = { esc: (s) => String(s == null ? "" : s), linkify: (s) => s, mdText: (s) => s,
  icon: () => "<svg></svg>", avatar: (n) => "<av>" + n + "</av>", relTime: () => "now", toast: () => {},
  actingHuman: () => ({ id: "h" }), leaseOf: () => null,
  agentById: (id) => id === "h" ? { id: "h", alias: "kedar", kind: "human" }
                                 : { id: id, alias: id === "a2" ? "Page" : "Frame", kind: "ai", status: "idle" } };
__CONVJS__
const flush = () => new Promise((r) => setTimeout(r, 0));
async function drain() { for (let i = 0; i < 12; i++) await flush(); }
async function main() {
  // mount agent A, then pick a file → uploadConvFiles fires A's get-or-create (which HANGS)
  window.OrchaConvo.mount(host, "a1");
  await drain();
  els.convAttachInput.files = [{ name: "shot.png", size: 1234 }];
  els.convAttachInput.fire("change");
  await drain();
  // switch to agent B BEFORE A's get-or-create resolves
  window.OrchaConvo.mount(host, "a2");
  await drain();
  // now A's stale conversation-create + upload resolve — must be dropped, not applied to B
  releaseA();
  await drain();
  // send from B
  els.convInput.value = "message to B";
  els.convSend.fire("click");
  await drain();
  const turn = CALLS.filter((c) => /\/turns$/.test(c.url) && c.method === "POST").pop();
  console.log("TURN_URL", turn ? turn.url : "NONE");
  console.log("TURN_BODY", turn ? turn.body : "NONE");
}
main().then(() => console.log("DONE")).catch((e) => { console.error("ERR", (e && e.stack) || e); process.exit(2); });
"""
    script = harness.replace("__CONVJS__", conv_js)
    p = tmp_path / "harness_race.js"
    p.write_text(script)
    out = subprocess.run(["node", str(p)], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, f"node harness errored:\n{out.stderr}\n{out.stdout}"
    assert "DONE" in out.stdout, f"harness didn't finish:\n{out.stdout}"
    # B's turn goes to B's OWN conversation — the stale A create never overwrote the global convId
    assert "TURN_URL /api/conversations/cB/turns" in out.stdout, \
        f"stale agent-A conversation leaked onto agent B's send:\n{out.stdout}"
    assert "/api/conversations/cA/turns" not in out.stdout, \
        f"a turn was sent to agent A's conversation after switching to B:\n{out.stdout}"
    # A's attachment never staged into B's tray, so it can't ride B's turn
    assert "abc_shot.png" not in out.stdout, \
        f"agent A's stale attachment leaked into agent B's turn:\n{out.stdout}"
