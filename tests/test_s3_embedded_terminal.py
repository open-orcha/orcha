"""S3 — embedded terminal panel + §3b locking UX (xterm.js over Forge's PTY ws bridge).

Frame's span (spec §3b): the xterm.js panel, the lease-aware open/guard UX, and the
both-ways lock. Built against Forge's contracts — PTY ws bridge (req b960aceb) and
lease-on-the-read-payload (req 959cfbcd). Backend (the ws route + the `live` lease field)
is Forge's; this surface degrades gracefully until it lands (lease absent → idle → terminal
openable + conversation unlocked).

Frontend-only: vendored xterm assets + terminal.js + wiring. No new portal route (the ws
endpoint is Forge's), so the Postman collection is unchanged.
"""
import pathlib
import re
import shutil
import subprocess
import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"

# shared node stubs for the OrchaTerm behavioral harnesses: a minimal DOM (createElement +
# appendChild/removeChild with parentNode + children), an xterm/FitAddon double, a capturing
# WebSocket, and the discovery fetch. `__TERMJS__` is replaced with terminal.js.
_TERM_HARNESS_PRELUDE = r"""
let sent = [], states = [], written = [];
let dataCb = null, resizeCb = null, wsRef = null, fetched = [];
function mkEl() {
  return { children: [], style: {}, parentNode: null,
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; } };
}
global.document = { createElement: () => mkEl() };
global.window = {
  addEventListener(){}, removeEventListener(){},
  Terminal: class { constructor(){ this.cols=80; this.rows=24; } open(p){ this.parent = p; } loadAddon(){}
    onData(cb){ dataCb = cb; } onResize(cb){ resizeCb = cb; } write(s){ written.push(s); } dispose(){} },
  FitAddon: { FitAddon: class { fit(){} } },
  Orcha: { actingHuman: () => ({ id: "h1" }), toast(){} },
};
global.location = { protocol: "https:", host: "portal.docker:8000" };
global.fetch = (u) => { fetched.push(u); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ws_url: "ws://127.0.0.1:8765" }) }); };
global.WebSocket = class { constructor(url){ this.url = url; this.readyState = 1; wsRef = this; }
  send(s){ sent.push(JSON.parse(s)); } close(){ this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); } };
__TERMJS__
"""


def test_xterm_is_vendored_not_cdn():
    vend = STATIC / "vendor"
    xj = (vend / "xterm.js").read_bytes()
    assert len(xj) > 100_000 and b"Terminal" in xj, "xterm.js missing / not the real library"
    assert (vend / "xterm.css").exists(), "xterm.css not vendored"
    fit = (vend / "addon-fit.js").read_bytes()
    assert b"FitAddon" in fit, "addon-fit not vendored"
    assert (vend / "README.md").exists(), "no provenance note for the vendored libs"
    # the page loads the vendored copies, never a runtime CDN
    agents = (STATIC / "agents.html").read_text()
    assert "/assets/vendor/xterm.js" in agents and "/assets/vendor/addon-fit.js" in agents and "/assets/terminal.js" in agents, \
        "agents.html doesn't load the vendored terminal assets"
    assert "/assets/vendor/xterm.css" in agents, "xterm.css not linked"
    assert "cdn.jsdelivr" not in agents and "unpkg" not in agents, "must not load xterm from a CDN at runtime"


def test_lease_helper_reads_the_embodiment_field_141_exposes():
    app = (STATIC / "app.js").read_text()
    assert "const leaseOf" in app and "leaseOf," in app, "leaseOf not defined/exported"
    assert '["idle", "ephemeral", "resident", "live"]' in app, "lease enum wrong"
    # #141 exposes the lease as `embodiment` on the agent read payload — must read THAT, or the
    # guard/lock never engage and the browser shows a busy agent as free (review P1).
    assert "agent.embodiment" in app, "doesn't read the `embodiment` field #141 exposes"
    assert 'return v && LEASES.indexOf(v) >= 0 ? v : "idle"' in app, "absent/unknown lease should default to idle"
    # and the data adapter must pass `embodiment` through (it whitelists agent fields)
    data = (STATIC / "data.js").read_text()
    assert "embodiment: a.embodiment" in data, "data adapter drops the embodiment field"


def test_terminal_module_speaks_the_pty_contract():
    js = (STATIC / "terminal.js").read_text()
    assert "window.OrchaTerm" in js, "no OrchaTerm module"
    # Contract v1 (b960aceb): the bridge is a HOST-side process, discovered via the portal's
    # GET /api/terminal/config -> {ws_url}; NOT the portal origin. Path/query:
    #   <ws_url>/terminal?agent_id=<aid>&actor_agent_id=<human>[&preempt=1]
    assert "function resolveBridgeBase" in js and '"/api/terminal/config"' in js, "doesn't discover the bridge ws_url"
    assert '"/terminal?agent_id=" + encodeURIComponent(aid)' in js, "agent_id not a query param"
    assert '"&actor_agent_id=" + encodeURIComponent(human.id)' in js, "actor_agent_id missing"
    assert '"&preempt=1"' in js, "no preempt flag"
    assert "location.host" not in js, "must NOT target the portal origin (the bridge is host-side)"
    assert '"ws://127.0.0.1:8765"' in js, "no documented fallback when discovery is absent"
    # JSON frames both ways
    assert 'type: "stdin"' in js and 'type: "resize"' in js, "no stdin/resize client frames"
    assert 'm.type === "stdout"' in js and 'm.type === "status"' in js and 'm.type === "error"' in js, "doesn't handle server frames"
    # close == snapshot-on-close (server side); we just close the socket
    assert "ws.close()" in js, "no close path (snapshot-on-close trigger)"


def test_s3_integration_visible_connect_states():
    # R1 integration: connect failures are VISIBLE (no silent flash-and-die). The panel stays
    # open with a clear message; the composer doesn't lock until a session truly connects.
    c = (STATIC / "conversation.js").read_text()
    assert "function termFail" in c, "no visible-failure handler"
    assert "termConnected" in c, "doesn't track whether a session actually connected"
    # bridge-down / busy / denied messages, and the 'connecting' state never auto-unpairs
    assert "Terminal bridge not reachable" in c, "no bridge-down message"
    assert "orcha terminal-bridge" in c, "doesn't tell the user how to start the bridge"
    # the bridge sends `lease_denied` for BOTH 4403 (not-human, no holder) and 4409 (busy, holder);
    # they must be DISTINGUISHED (Page diagnosis) — busy keys off `holder`, denial is the rest.
    assert 'code === 4409 || (state === "lease_denied" && holder)' in c, "busy not gated on a held lease (holder/4409)"
    assert 'code === 4403 || state === "lease_denied"' in c, "not-human denial (4403 / holderless lease_denied) not surfaced"
    assert "Couldn't pair as" in c and "acting human" in c, "denial message doesn't point at the human actor"
    assert 'state === "lease_denied" || code === 4409' not in c, "regressed: any lease_denied still lumped as busy"
    # the lock only engages once truly connected (a bridge-down panel must not freeze the composer)
    assert "(paired && termConnected)" in c, "lock not gated on a real connection"
    a = (STATIC / "agents.html").read_text()
    assert ".term-error" in a, "no failure-state styling"


def test_pair_in_terminal_lifted_into_the_conversation():
    # the §3b terminal is the reference "Pair in terminal" design, docked in the conversation
    # (conversation.js owns the shell; OrchaTerm is the engine). It is NOT the old #142 panel.
    c = (STATIC / "conversation.js").read_text()
    assert 'id="convPair"' in c and "Pair in terminal" in c, "no Pair-in-terminal control in the conversation header"
    assert "function togglePair" in c and "function openPair" in c and "function termShell" in c, "pair flow missing"
    # the lifted shell: traffic lights, the live pairtag, the close-&-save button, xterm in term-body
    assert 'class="lights"' in c and 'class="pairtag"' in c and 'id="termBody"' in c, "reference term shell not lifted"
    assert "Close &amp; save session" in c, "no close-&-save affordance"
    # §3b guard matrix driven by the lease: idle->open, busy->human preempt, live->blocked
    assert "O().leaseOf(a)" in c, "pair guard doesn't read the lease"
    # ISS-69(b): the preempt path has holder-specific copy (resident=hand-off warm conversation,
    # ephemeral=stop the task) rather than one generic "Preempt the running session?" title.
    assert 'lease === "ephemeral" || lease === "resident"' in c and ("Hand off the live conversation?" in c and "Preempt the running task?" in c), "no holder-specific busy preempt path"
    assert 'lease === "live"' in c, "doesn't block when a live lease is already held"
    # session opens through the shared OrchaTerm engine; close codes + snapshot overlay surfaced
    assert "OrchaTerm.open(" in c and "OrchaTerm.close(agentId)" in c, "not wired to the OrchaTerm engine"
    assert "4403" in c and "4409" in c, "ws close codes not handled"
    assert "term-saving" in c and "saving session" in c.lower(), "snapshot-on-close overlay missing"
    # the old #142 separate panel is gone
    a = (STATIC / "agents.html").read_text()
    assert 'id="termWrap"' not in a and "function mountTerm" not in a, "old #142 terminal panel not retired"
    # the reference CSS is present
    assert ".conv-wrap.paired" in a and ".term-h .pairtag" in a and ".term-saving" in a, "reference term CSS not lifted"


def test_iss69_contention_ux_names_holder_and_handles_yield():
    """ISS-69 — embodiment-contention UX. (a) DISPLAY: the busy message names the lease HOLDER in
    human terms (resident=in a live conversation, live=in a live terminal, ephemeral=running a
    task) + appends the wire `reason`; the roster shows the embodiment kind. (b)-FRONTEND: the
    resident preempt is framed as a warm-conversation HAND-OFF, and the bridge's `yielding` status
    frame (Forge's contract) renders 'handing off…'. Frontend-only → Postman unchanged."""
    c = (STATIC / "conversation.js").read_text()
    # (a) holder named in human terms, not the raw lease_kind
    assert "HOLDER_DOING" in c and '"in a live conversation"' in c and '"in a live terminal"' in c and '"running a task"' in c, \
        "busy copy doesn't name the holder in human terms"
    assert "info.reason" in c, "the bridge `reason` detail isn't surfaced on a busy lease"
    assert "is busy with another live session" not in c, "still leaks the old generic busy copy"
    # (b) resident = hand-off warm conversation; ephemeral = stop the task
    assert "Hand off the live conversation?" in c and "warm conversation" in c, "no resident hand-off framing"
    assert "Preempt the running task?" in c, "no ephemeral-task preempt framing"
    # (b) the bridge's yield status frame is handled (Forge contract: state==='yielding')
    assert 'state === "yielding"' in c and "handing off" in c.lower(), "the `yielding` handoff frame isn't handled"
    # (b) P1 (kedar #179): the full-panel `.term-saving` hand-off overlay MUST be cleared on
    # `connected`, else a successful yield→connected hand-off leaves the live terminal covered.
    assert "function hideSaving" in c, "no hideSaving() to clear the hand-off overlay"
    conn_branch = c[c.index('state === "connected"'):c.index('state === "connected"') + 200]
    assert "hideSaving()" in conn_branch, "the connected branch doesn't clear the saving/hand-off overlay"
    # the hand-off overlay has its own copy, not the close flow's "Closing — saving session"
    assert 'showSaving("handoff")' in c and "Handing off — saving session" in c, "hand-off overlay reuses the close copy"
    # (a) roster surfaces the embodiment kind from the read payload, colour-coded by kind
    a = (STATIC / "agents.html").read_text()
    assert "function embodBadge" in a and "O.leaseOf(a)" in a, "roster doesn't surface the embodiment lease"
    assert ".rrow .rlive.resident" in a and ".rrow .rlive.ephemeral" in a, "roster badge not colour-coded by embodiment kind"


def test_conversation_locks_while_agent_in_live_terminal():
    c = (STATIC / "conversation.js").read_text()
    assert "function applyLock" in c, "no conversation lock"
    # locked while a live lease is held — by another embodiment OR our own CONNECTED pair session
    assert 'O().leaseOf(a) === "live"' in c and "(paired && termConnected)" in c, "lock not driven by live lease / our connected pair"
    assert "inp.disabled" in c and "send.disabled" in c, "composer not disabled while locked"
    assert "conversation paused" in c, "no lock banner copy"
    # the lock CSS must gate on the VISIBLE banner — a sibling selector matches a [hidden]
    # .conv-lock too, so without :not([hidden]) every UNLOCKED composer would be dead (P1).
    a = (STATIC / "agents.html").read_text()
    assert ".conv-lock:not([hidden]) + .conv-composer" in a, "lock CSS not gated on the visible banner"
    assert ".conv-lock + .conv-composer" not in a.replace(".conv-lock:not([hidden]) + .conv-composer", ""), \
        "an ungated .conv-lock + .conv-composer rule would disable every composer"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_terminal_js_syntax_and_frame_protocol():
    js = (STATIC / "terminal.js").read_text()
    # syntax
    chk = subprocess.run(["node", "--check", "-"], input=js, capture_output=True, text=True)
    assert chk.returncode == 0, chk.stderr
    # behavioral: drive open() with stubbed xterm + WebSocket and assert the frame protocol
    harness = _TERM_HARNESS_PRELUDE + r"""
const T = window.OrchaTerm;
const flush = () => new Promise(r => setTimeout(r, 15));
(async () => {
  const hostA = mkEl();
  T.open(hostA, "a1", { preempt: true, onState: (s) => states.push(s) });
  await flush();   // discovery fetch -> connect
  // 1) discovered the bridge base, then built the v1 contract URL (host-side, query ids)
  if (fetched.indexOf("/api/terminal/config") < 0) throw new Error("did not discover the bridge");
  if (!wsRef) throw new Error("no socket after discovery");
  if (wsRef.url !== "ws://127.0.0.1:8765/terminal?agent_id=a1&actor_agent_id=h1&preempt=1") throw new Error("bad url: " + wsRef.url);
  // 2) server 'connected' status surfaces via onState
  wsRef.onmessage({ data: JSON.stringify({ type: "status", state: "connected" }) });
  // 3) stdout is written to the terminal
  wsRef.onmessage({ data: JSON.stringify({ type: "stdout", data: "hello" }) });
  if (written.indexOf("hello") < 0) throw new Error("stdout not written");
  // 4) a keystroke becomes a stdin frame; a resize becomes a resize frame
  dataCb("x");
  resizeCb({ cols: 120, rows: 40 });
  if (!sent.some(f => f.type === "stdin" && f.data === "x")) throw new Error("no stdin frame");
  if (!sent.some(f => f.type === "resize" && f.cols === 120 && f.rows === 40)) throw new Error("no resize frame");
  // 5) close(aid) triggers the socket close (server-side snapshot-on-close)
  T.close("a1");
  if (wsRef.readyState !== 3) throw new Error("close didn't close the socket");
  if (states.indexOf("connected") < 0) throw new Error("connected state not reported");
  console.log("OK");
})();
"""
    out = subprocess.run(["node", "-e", harness.replace("__TERMJS__", js)], capture_output=True, text=True)
    assert out.returncode == 0, (out.stdout + out.stderr)
    assert out.stdout.strip().splitlines()[-1] == "OK", out.stdout


# ---------- ISS-71: per-agent session registry survives navigate-away-and-back ----------

def test_iss71_wiring():
    c = (STATIC / "conversation.js").read_text()
    # nav-away DETACHES (keeps the socket open), only an explicit close ends it
    assert "OrchaTerm.detach(agentId)" in c, "nav-away must detach (keep alive), not close"
    assert "OrchaTerm.teardown()" not in c, "must not hard-teardown the terminal on nav"
    # returning to an agent with a live session re-docks it
    assert "OrchaTerm.hasSession(aid)" in c and "openPair(false)" in c, "doesn't reattach a surviving session on mount"
    t = (STATIC / "terminal.js").read_text()
    assert "function detach" in t and "function cleanup" in t and "function liveAgentIds" in t, "registry API missing"
    assert "const sessions = {}" in t, "no per-agent session registry"
    # Forge caveat: a backgrounded live session is surfaced in the roster
    a = (STATIC / "agents.html").read_text()
    assert "OrchaTerm.liveAgentIds()" in a and ".rrow .rlive" in a, "no roster indicator for a backgrounded live terminal"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_iss71_detach_keeps_socket_open_reattach_reuses_it():
    js = (STATIC / "terminal.js").read_text()
    harness = _TERM_HARNESS_PRELUDE + r"""
const T = window.OrchaTerm;
const flush = () => new Promise(r => setTimeout(r, 15));
const A = (n, c) => { if (!c) { console.error("FAIL: " + n); process.exit(1); } };
(async () => {
  const hostA = mkEl();
  T.open(hostA, "a1", { onState: () => {} });
  await flush();
  const wrap = hostA.children[0];
  const sock = wsRef;
  A("attached to hostA", hostA.children.length === 1);
  A("hasSession a1", T.hasSession("a1"));
  wsRef.onmessage({ data: JSON.stringify({ type: "status", state: "connected" }) });
  A("connected", T.isConnected("a1"));
  A("liveAgentIds has a1", T.liveAgentIds().indexOf("a1") >= 0);
  // NAV AWAY -> detach: the xterm leaves the DOM but the socket STAYS OPEN
  T.detach("a1");
  A("detached from DOM", hostA.children.length === 0);
  A("socket still open after detach", sock.readyState === 1);
  A("session survives detach", T.hasSession("a1"));
  // NAV BACK -> reattach: SAME xterm element re-docked, NO new socket
  const hostB = mkEl();
  let reattached = false;
  T.open(hostB, "a1", { onState: (s, i) => { if (i && i.reattached) reattached = true; } });
  A("same xterm element re-docked", hostB.children[0] === wrap);
  A("no new socket on reattach", wsRef === sock);
  A("reattach reported", reattached);
  // explicit close -> ends it
  T.close("a1");
  A("socket closed on explicit close", sock.readyState === 3);
  A("session gone", !T.hasSession("a1"));
  console.log("OK");
})();
"""
    out = subprocess.run(["node", "-e", harness.replace("__TERMJS__", js)], capture_output=True, text=True)
    assert out.returncode == 0, (out.stdout + out.stderr)
    assert out.stdout.strip().splitlines()[-1] == "OK", out.stdout


# ---------- ISS-67: bounded reconnect-backoff while the bridge is still booting ----------

def test_iss67_reconnect_wiring():
    """String teeth (no node): the backoff seam + progressive UX are actually wired."""
    t = (STATIC / "terminal.js").read_text()
    assert "MAX_CONNECT_ATTEMPTS" in t and "CONNECT_BACKOFF_MS" in t, "no bounded backoff config"
    assert "function retriable" in t and "1006" in t, "no transport-vs-policy close discrimination"
    # never retry a policy close — those codes carry their own UX downstream
    assert "scheduleRetry" in t and "s.attempt < MAX_CONNECT_ATTEMPTS" in t, "retry isn't bounded by attempt count"
    assert "bridgeStarting: true" in t, "retry doesn't report progress to the host"
    assert "performance.mark" in t and "performance.measure" in t, "ISS-67(A) instrumentation missing"
    # the consumer surfaces the progressive state instead of an instant 'not reachable'
    c = (STATIC / "conversation.js").read_text()
    assert "bridgeStarting" in c and "starting bridge" in c, "conversation.js doesn't show the bridge-starting UX"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_iss67_never_connected_close_retries_then_connects():
    js = (STATIC / "terminal.js").read_text()
    harness = _TERM_HARNESS_PRELUDE + r"""
const T = window.OrchaTerm;
const flush = () => new Promise(r => setTimeout(r, 15));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const A = (n, c) => { if (!c) { console.error("FAIL: " + n); process.exit(1); } };
let evts = [];
(async () => {
  // (1) BRIDGE STILL BOOTING: a fresh open whose first ws closes abnormally (1006), never connected.
  const hostA = mkEl();
  T.open(hostA, "a1", { onState: (s, i) => evts.push({ s: s, i: i || {} }) });
  await flush();                         // discovery -> first connect attempt
  const sock1 = wsRef;
  A("first socket created", !!sock1);
  sock1.onclose({ code: 1006 });         // abnormal close before ever reaching 'connected'
  // must NOT have hard-failed: no 'closed' emitted, and a progressive 'bridge starting' state shown
  A("no premature 'closed' on never-connected abnormal close", !evts.some(e => e.s === "closed"));
  A("reported bridge-starting progress", evts.some(e => e.s === "connecting" && e.i.bridgeStarting && e.i.attempt === 1));
  // (2) BACKOFF then RETRY: a NEW socket is created (first backoff is 300ms)
  await sleep(360);
  A("a retry socket was created", wsRef && wsRef !== sock1);
  // (3) the retry CONNECTS — surfaces 'connected', no 'closed' ever emitted
  wsRef.onmessage({ data: JSON.stringify({ type: "status", state: "connected" }) });
  A("connected after retry", T.isConnected("a1"));
  A("never hard-failed during the boot wait", !evts.some(e => e.s === "closed"));
  T.cleanup("a1");

  // (4) POLICY close (4409 busy) must NOT be retried — propagate immediately as 'closed'.
  evts = [];
  const hostB = mkEl();
  T.open(hostB, "b1", { onState: (s, i) => evts.push({ s: s, i: i || {} }) });
  await flush();
  const bsock = wsRef;
  bsock.onclose({ code: 4409 });
  A("policy close not retried — emits 'closed' at once", evts.some(e => e.s === "closed" && e.i.code === 4409));
  A("policy close kept the SAME socket (no retry)", wsRef === bsock);
  A("session torn down after policy close", !T.hasSession("b1"));
  console.log("OK");
})();
"""
    out = subprocess.run(["node", "-e", harness.replace("__TERMJS__", js)], capture_output=True, text=True)
    assert out.returncode == 0, (out.stdout + out.stderr)
    assert out.stdout.strip().splitlines()[-1] == "OK", out.stdout
