/* ============================================================================
   Web-chat send UX (fix/web-chat-send-ux) — the field bug: ONE user send painted
   TWO identical "you · just now" bubbles with the agent stuck on "thinking…".

   Two dup vectors, both pinned here against the REAL conversation bundle:
     #1 send() had no in-flight guard and only cleared the composer after the
        POST resolved — a second Enter / "did it go through?" click while the
        portal was slow re-POSTed the same text (two REAL turns server-side).
     #2 the 3s interval poll and the manual post-send poll() could overlap on
        the SAME after_seq cursor; both responses concat'd the same fresh turns
        (one turn painted twice client-side).

   PART A  dup-guard — a second click + Enter during flight is a no-op (1 POST);
           the Send button is down with a spinner; the composer clears
           optimistically and a pending "sending…" bubble paints.
   PART B  reconcile + overlap dedupe — the POSTed turn lands once (by id);
           an overlapped same-cursor poll replaying the turn cannot dup it,
           and a second poll() while one is in flight is skipped.
   PART C  failure → Retry — POST failure restores the composer, paints an
           inline danger note with Retry, never auto-reposts; Retry re-submits
           exactly once through the same guarded path.
   PART D  response-lost reconcile — the POST failed client-side but the turn
           DID land: the poll's identical author+content match (pending window)
           clears the failed bubble + restored text instead of inviting a dup.

   Cold-start honesty rides along in PART A: the first-ever reply says
   "starting the agent's session…" instead of bare thinking dots.

   Dependency-free (mirrors the other tests/portal suites): the real portal
   modules in a vm sandbox over a tiny fake DOM.

   Run: node tests/portal/conversation_send.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");
const CONV_FILES = [
  ["modules", "conversation-state.js"],
  ["modules", "conversation-terminal-open.js"],
  ["modules", "conversation-terminal-state.js"],
  ["modules", "conversation-render.js"],
  ["modules", "conversation-composer.js"],
  ["modules", "conversation-lifecycle.js"],
  ["conversation.js"],
];

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}
const flush = () => new Promise((r) => setImmediate(r));
async function drain() { for (let i = 0; i < 15; i++) await flush(); }
const count = (hay, needle) => String(hay).split(needle).length - 1;

/* ---- tiny fake DOM ----------------------------------------------------- */
function mkEl(id) {
  const handlers = {};
  const el = {
    id: id || "", _html: "", className: "", style: {}, hidden: false, value: "",
    disabled: false, files: null, scrollHeight: 0, scrollTop: 0, clientHeight: 0, dataset: {},
    set innerHTML(v) { el._html = v == null ? "" : String(v); },
    get innerHTML() { return el._html; },
    addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    removeEventListener() {},
    fire(ev, arg) { (handlers[ev] || []).slice().forEach((fn) => fn(arg || { preventDefault() {}, target: el })); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    focus() {}, scrollIntoView() {}, click() { el.fire("click"); },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    getAttribute(k) { return el["_a_" + k] || null; }, setAttribute(k, v) { el["_a_" + k] = v; },
    appendChild() {}, removeChild() {},
  };
  return el;
}

/* ---- controllable network ---------------------------------------------- */
// net.postMode: "ok" (resolve with net.turnFor), "reject" (network error), "hold"
const net = {
  postMode: "ok", posts: [], heldPosts: [],
  turnGets: 0, holdPoll: false, heldPolls: [], pollTurns: [],
  nextSeq: 1,
  turnFor(body) {
    const b = JSON.parse(body);
    return { id: "srv-" + net.nextSeq, seq: net.nextSeq++, role: b.role,
             author_agent_id: b.author_agent_id, content: b.content,
             attachments: b.attachments || [], created_at: "2026-07-31T00:00:00Z", run_id: null, meta: {} };
  },
};
function fakeFetch(url, init) {
  const u = String(url);
  const method = (init && init.method) || "GET";
  if (u.indexOf("/conversation?limit=") >= 0) {
    const aid = u.match(/\/api\/agents\/([^/]+)\//)[1];
    return Promise.resolve({ ok: true, json: () => Promise.resolve(
      { conversation: { id: "c-" + aid }, turns: [] }) });
  }
  if (/\/api\/agents\/[^/]+\/conversations$/.test(u) && method === "POST") {
    const aid = u.match(/\/api\/agents\/([^/]+)\//)[1];
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ conversation: { id: "c-" + aid } }) });
  }
  if (/\/turns$/.test(u) && method === "POST") {
    net.posts.push({ url: u, body: init.body });
    if (net.postMode === "reject") return Promise.reject(new Error("network down"));
    if (net.postMode === "hold") return new Promise((res, rej) => net.heldPosts.push({
      // release(): settle as success (default, matches every pre-existing caller). releaseFail():
      // settle as a rejected network error — for a repro that holds a POST then fails IT
      // specifically, independent of whatever net.postMode is by the time it's released.
      release: () => res({ ok: true, json: () => Promise.resolve({ turn: net.turnFor(init.body) }) }),
      releaseFail: () => rej(new Error("network down")),
    }));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ turn: net.turnFor(init.body) }) });
  }
  if (u.indexOf("/turns?after_seq=") >= 0) {
    net.turnGets++;
    if (net.holdPoll) {
      return new Promise((res) => net.heldPolls.push(
        (turns) => res({ ok: true, json: () => Promise.resolve({ turns: turns || [] }) })));
    }
    const t = net.pollTurns; net.pollTurns = [];
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ turns: t }) });
  }
  // refreshPresence GET /api/conversations/{cid} — presence contract not live
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ presence: null }) });
}

/* ---- sandbox ------------------------------------------------------------ */
const els = {};
["convInput", "convSend", "convList", "convPresence", "convSlash", "convAttach",
 "convAttachInput", "convTray", "convPair", "convMax", "convLock", "convPairWrap",
 "convTermSlot"].forEach((id) => { els[id] = mkEl(id); });
const state = { retryBtn: null, retryBtns: {} };
// renderList wires EVERY Retry via list.querySelectorAll("[data-retrysend]") — one button per
// failed bubble (blocker #1 can paint more than one at once). Parse each data-retrysend="<at>"
// out of the rendered HTML and hand back a fake button keyed by its `at`, so a test can fire
// the click for a SPECIFIC failed bubble instead of only ever "the first one".
els.convList.querySelectorAll = (sel) => {
  if (sel !== "[data-retrysend]") return [];
  const html = els.convList._html;
  const re = /data-retrysend="(-?\d+)"/g;
  const found = [];
  let m;
  while ((m = re.exec(html))) {
    const at = m[1];
    const btn = mkEl("retry-" + at);
    btn.getAttribute = (k) => (k === "data-retrysend" ? at : null);
    state.retryBtns[at] = btn;
    found.push(btn);
  }
  state.retryBtn = found[0] || null;   // back-compat alias: "the most recent single Retry"
  return found;
};
const orchaStub = {
  esc: (s) => String(s == null ? "" : s), linkify: (s) => String(s == null ? "" : s),
  mdText: (s) => String(s == null ? "" : s), icon: (n) => "<svg data-ic=\"" + n + "\"></svg>",
  avatar: (n) => "<av>" + n + "</av>", relTime: () => "just now", toast: () => {},
  actingHuman: () => ({ id: "h" }), leaseOf: () => "idle",
  startRunStream: () => (() => {}),
  agentById: (id) => id === "h" ? { id: "h", alias: "maker", kind: "human" }
                                : { id, alias: "Frame", kind: "ai", status: "idle" },
};
function makeSandbox() {
  const documentObj = {
    getElementById: (id) => els[id] || null,
    createElement: () => mkEl(),
    addEventListener() {}, removeEventListener() {},
    documentElement: { setAttribute() {} }, body: { appendChild() {} },
  };
  const sandbox = {
    window: { Orcha: orchaStub }, document: documentObj, console,
    fetch: fakeFetch,
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn) => { if (fn) fn(); return 0; }, clearTimeout() {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  CONV_FILES.forEach((p) => vm.runInContext(read(...p), sandbox, { filename: p.join("/") }));
  return sandbox;
}
const sb = makeSandbox();
const run = (code) => vm.runInContext(code, sb);
const mountHost = mkEl("host");
mountHost.querySelector = () => null;

/* ---------------- PART A — dup-guard + optimistic pending ---------------- */
async function partA() {
  console.log("\nPART A — dup-guard: one user action, ONE turn\n");
  run('window.OrchaConvo.mount(__host, "a1")');
  await drain();
  net.postMode = "hold"; net.posts = [];
  els.convInput.value = "hello agent";
  els.convSend.fire("click");
  await flush();
  // second click + Enter (and a held-key repeat would be more of the same) during flight
  els.convSend.fire("click");
  els.convInput.fire("keydown", { key: "Enter", shiftKey: false, preventDefault() {}, target: els.convInput });
  els.convInput.fire("keydown", { key: "Enter", shiftKey: false, preventDefault() {}, target: els.convInput });
  await drain();
  assert(net.posts.length === 1, "a second submit during flight is a NO-OP (exactly one POST /turns)");
  // even NEW text + Enter during flight is ignored (the optimistic clear alone wouldn't stop
  // this one — it needs the `sending` guard; the typed text stays put, nothing is lost)
  els.convInput.value = "typed during flight";
  els.convInput.fire("keydown", { key: "Enter", shiftKey: false, preventDefault() {}, target: els.convInput });
  await drain();
  assert(net.posts.length === 1, "Enter with new text during flight is ignored (in-flight guard, not just the cleared input)");
  assert(els.convInput.value === "typed during flight", "…and the typed text is untouched");
  els.convInput.value = "";
  assert(run("sending") === true, "the in-flight guard is up");
  assert(els.convSend.disabled === true, "the Send button is disabled while the POST is in flight");
  assert(els.convSend._html.indexOf("spin") >= 0, "…and shows a spinner");
  assert(els.convInput.value === "", "the composer cleared optimistically");
  assert(els.convList._html.indexOf("sending…") >= 0 && count(els.convList._html, "hello agent") === 1,
    "a single pending bubble paints with the 'sending…' state");
  assert(els.convList._html.indexOf("conv-thinking") < 0, "no reply indicator while the send is unsettled");
  // the POST settles → reconcile by returned turn id
  net.heldPosts.splice(0).forEach((h) => h.release());
  await drain();
  assert(net.posts.length === 1, "settling did not re-POST");
  assert(run("sending") === false && els.convSend.disabled === false, "the guard + button release on success");
  assert(run("turns.length") === 1 && run("pendingLocal") === null,
    "the optimistic bubble reconciled into the ONE durable turn (by returned id)");
  assert(count(els.convList._html, "hello agent") === 1, "the message renders exactly once");
  assert(els.convList._html.indexOf("conv-thinking") >= 0, "the awaiting-reply indicator is up after success");
  assert(els.convList._html.indexOf("starting the agent’s session") >= 0
      && els.convList._html.indexOf("starting…") >= 0,
    "cold start (no agent turn yet) says 'starting the agent's session…', not bare thinking dots");
}

/* ---------------- PART B — poll overlap cannot duplicate ------------------ */
async function partB() {
  console.log("\nPART B — overlapped same-cursor polls cannot dup a turn\n");
  const gets = net.turnGets;
  net.holdPoll = true;
  run("poll()");
  run("poll()");   // the 3s tick firing while the first fetch is still in flight
  await flush();
  assert(net.turnGets === gets + 1, "a second poll() while one is in flight is skipped (no same-cursor stacking)");
  // a stale response replaying the ALREADY-LANDED turn (same id/seq) must be dropped
  const dup = { id: "srv-1", seq: 1, role: "human", author_agent_id: "h",
                content: "hello agent", attachments: [], created_at: "2026-07-31T00:00:00Z", run_id: null, meta: {} };
  net.heldPolls.splice(0).forEach((release) => release([dup]));
  net.holdPoll = false;
  await drain();
  assert(run("turns.length") === 1, "the replayed turn was deduped by id/seq (turns still 1)");
  assert(count(els.convList._html, "hello agent") === 1, "…and the bubble still paints exactly once");
  // a genuinely NEW turn still lands through the same filter
  net.pollTurns = [{ id: "srv-agent-1", seq: 2, role: "agent", author_agent_id: "a1",
                     content: "hi there", attachments: [], created_at: "2026-07-31T00:00:01Z", run_id: null, meta: {} }];
  run("poll()");
  await drain();
  assert(run("turns.length") === 2 && count(els.convList._html, "hi there") === 1,
    "a genuinely new (agent) turn still appends once");
  assert(els.convList._html.indexOf("conv-thinking") < 0, "the reply landed → indicator cleared");
}

/* ---------------- PART C — failure → restore + Retry ---------------------- */
async function partC() {
  console.log("\nPART C — POST failure: composer restored, inline Retry, no auto-dup\n");
  run('window.OrchaConvo.mount(__host, "a2")');
  await drain();
  net.postMode = "reject"; net.posts = [];
  els.convInput.value = "retry me";
  els.convSend.fire("click");
  await drain();
  assert(net.posts.length === 1, "the failed send POSTed once (and did NOT auto-retry)");
  assert(run("sending") === false && els.convSend.disabled === false, "the guard releases on failure");
  assert(els.convInput.value === "retry me", "the composer text was RESTORED — nothing silently lost");
  assert(els.convList._html.indexOf("conv-sendfail") >= 0 && els.convList._html.indexOf("data-retrysend") >= 0,
    "an inline danger note with Retry paints on the failed bubble");
  assert(els.convList._html.indexOf("not sent") >= 0, "the failed bubble is labeled 'not sent'");
  // Retry re-submits exactly the failed content through the same guarded path
  net.postMode = "ok";
  state.retryBtn.fire("click");
  await drain();
  assert(net.posts.length === 2, "Retry re-POSTed exactly once");
  assert(els.convInput.value === "", "Retry took the restored text back out of the composer");
  assert(run("pendingLocal") === null && count(els.convList._html, "retry me") === 1,
    "the retried turn reconciled into ONE bubble");
  assert(els.convList._html.indexOf("conv-sendfail") < 0, "the failure note cleared");
}

/* ---------------- PART D — POST response lost, poll reconciles ------------ */
async function partD() {
  console.log("\nPART D — POST landed but its response was lost: the poll reconciles, no dup\n");
  run('window.OrchaConvo.mount(__host, "a3")');
  await drain();
  net.postMode = "reject"; net.posts = [];
  els.convInput.value = "ghost turn";
  els.convSend.fire("click");
  await drain();
  assert(els.convList._html.indexOf("conv-sendfail") >= 0 && els.convInput.value === "ghost turn",
    "the send looks failed client-side (note + restored composer)");
  // …but the server DID persist it — the poll returns the identical author+content turn
  net.pollTurns = [{ id: "durable-1", seq: 1, role: "human", author_agent_id: "h",
                     content: "ghost turn", attachments: [], created_at: "2026-07-31T00:00:02Z", run_id: null, meta: {} }];
  run("poll()");
  await drain();
  assert(run("pendingLocal") === null, "identical author+content within the pending window reconciled the failed bubble");
  assert(count(els.convList._html, "ghost turn") === 1 && els.convList._html.indexOf("conv-sendfail") < 0,
    "ONE durable bubble remains — no failure note");
  assert(els.convInput.value === "", "the failure-restored composer text was taken back (a habit-Retry can't dup it)");
  assert(net.posts.length === 1, "no extra POST was ever issued");
}

/* ---------------- PART E — round-2 blocker #1: a failed send survives the NEXT send -------
   Repro from review round 1: send "IMPORTANT first message" while slow, type something new
   during flight, let the first POST fail (composer non-empty so nothing is restored into it),
   then send the new text. Before the fix, submitTurn() unconditionally overwrote pendingLocal
   at send-time — the failed bubble + its Retry vanished with no toast and no trace. */
async function partE() {
  console.log("\nPART E — round-2 blocker #1: a later send() must not destroy an earlier FAILED bubble\n");
  run('window.OrchaConvo.mount(__host, "a4")');
  await drain();
  net.postMode = "hold"; net.posts = [];
  els.convInput.value = "IMPORTANT first message";
  els.convSend.fire("click");
  await flush();
  // type something new WHILE the first send is still in flight (composer stays non-empty
  // through the failure below, so failSend's own restore path does NOT fire)
  els.convInput.value = "second message";
  // the first POST fails (releaseFail settles the ALREADY-HELD promise as rejected — flipping
  // net.postMode here would do nothing, the promise executor already ran)
  net.heldPosts.splice(0).forEach((h) => h.releaseFail());
  await drain();
  assert(els.convList._html.indexOf("conv-sendfail") >= 0 && count(els.convList._html, "IMPORTANT first message") === 1,
    "the first message shows failed + Retry (composer held new text, so nothing auto-restored into it)");
  assert(els.convInput.value === "second message", "the composer still holds the new text, untouched by the failure");
  // now send the second message through the normal guarded path
  net.postMode = "ok"; net.posts = [];
  els.convSend.fire("click");
  await drain();
  assert(net.posts.length === 1, "the second send POSTed exactly once");
  assert(count(els.convList._html, "IMPORTANT first message") === 1,
    "the FAILED first message is still in the DOM — not silently destroyed by the second send");
  assert(els.convList._html.indexOf("conv-sendfail") >= 0, "…and its Retry/failure note is still showing");
  assert(count(els.convList._html, "second message") === 1, "the second message also renders (as the durable turn once settled)");
  assert(run("failedSends.length") === 1 && run("failedSends[0].content") === "IMPORTANT first message",
    "the failed send was stashed (not dropped) so it survives the next send()");
  // Retry on the STASHED failed message must still work and target the right content
  net.posts = [];
  // state.retryBtns was populated by renderList()'s OWN querySelectorAll call (inside the
  // production code) — the listener is wired to THESE objects, so read from that cache
  // rather than re-invoking querySelectorAll (which would hand back listener-less doubles).
  const stashedAt = run("failedSends[0].at");
  const btn = state.retryBtns[String(stashedAt)];
  assert(!!btn, "a Retry button exists for the stashed failed bubble, keyed by its own `at`");
  btn.fire("click");
  await drain();
  assert(net.posts.length === 1, "retrying the stashed failed message POSTs exactly once");
  assert(JSON.parse(net.posts[0].body).content === "IMPORTANT first message",
    "…and it re-sends the STASHED message's own content, not the other one's");
  assert(run("failedSends.length") === 0, "the stashed failed send is cleared once retried");
}

/* ---------------- PART F — round-2 blocker #2: reconcile must not age-bound a live "sending" --
   Repro from review round 1: a send takes > PENDING_MATCH_MS (20s) to settle. The 3s poll picks
   up the durable copy well before that, but the age check used to block reconcilePending from
   matching it — the bubble stayed "sending…", the durable copy appended too (double paint), and
   when the hung POST finally rejected the second bubble flipped to "not sent" with a Retry that
   would re-POST a genuine duplicate. Fix: no age bound while status === "sending". */
async function partF() {
  console.log("\nPART F — round-2 blocker #2: an in-flight (>20s) send must reconcile, not double-paint\n");
  run('window.OrchaConvo.mount(__host, "a5")');
  await drain();
  net.postMode = "hold"; net.posts = [];
  els.convInput.value = "slow send";
  els.convSend.fire("click");
  await flush();
  assert(run("pendingLocal.status") === "sending", "the send is staged and still in flight");
  // age the pending bubble past the 20s reconcile window WITHOUT it failing yet
  run("pendingLocal.at = Date.now() - 25000");
  // the 3s poll fetches the durable copy the server already persisted
  net.pollTurns = [{ id: "srv-slow-1", seq: 1, role: "human", author_agent_id: "h",
                     content: "slow send", attachments: [], created_at: "2026-07-31T00:00:03Z", run_id: null, meta: {} }];
  run("poll()");
  await drain();
  assert(run("pendingLocal") === null, "past 20s, a still-SENDING pendingLocal still reconciles (no age bound while in flight)");
  assert(run("turns.length") === 1 && count(els.convList._html, "slow send") === 1,
    "the durable copy renders exactly once — no double bubble");
  assert(els.convList._html.indexOf("conv-sendfail") < 0, "no failure note — the send hadn't failed, it just reconciled");
  // when the hung POST finally rejects, failSend must see pendingLocal already cleared and no-op
  // (this is the existing guard at failSend's top; assert it still holds post-fix)
  net.heldPosts.splice(0).forEach((h) => h.releaseFail());
  await drain();
  assert(run("pendingLocal") === null && run("failedSends.length") === 0,
    "the late rejection is a no-op — no phantom Retry appears next to the already-landed message");
  assert(count(els.convList._html, "slow send") === 1, "still exactly one bubble for the message");
  assert(net.posts.length === 1, "the late rejection did not trigger any extra POST");
}

/* ---------------- PART G — minor #3: Send must not re-enable itself on a locked conversation --
   Repro: a terminal pairs mid-send (paired+termConnected -> applyLock() would disable Send).
   setSendBusy(false) alone re-enables the button unconditionally; settleSend/failSend must call
   applyLock() right after so a terminal-locked conversation doesn't get a live Send button
   until the next presence repaint (up to ~3s later, per the review). */
async function partG() {
  console.log("\nPART G — minor #3: settling a send must re-apply the terminal lock immediately\n");
  run('window.OrchaConvo.mount(__host, "a6")');
  await drain();
  net.postMode = "hold"; net.posts = [];
  els.convInput.value = "locks mid-flight";
  els.convSend.fire("click");
  await flush();
  // a terminal pairs WHILE the send is in flight
  run("paired = true; termConnected = true;");
  net.heldPosts.splice(0).forEach((h) => h.release());
  await drain();
  assert(els.convSend.disabled === true,
    "Send stays disabled on settle — applyLock() ran right after setSendBusy(false) and saw the live terminal lock");
  // same check on the failure path
  run("paired = false; termConnected = false;");
  run('window.OrchaConvo.mount(__host, "a7")');
  await drain();
  net.postMode = "hold"; net.posts = [];
  els.convInput.value = "fails mid-flight";
  els.convSend.fire("click");
  await flush();
  run("paired = true; termConnected = true;");
  net.heldPosts.splice(0).forEach((h) => h.releaseFail());
  await drain();
  assert(els.convSend.disabled === true,
    "Send also stays disabled when the in-flight send FAILS while a terminal is paired");
}

(async () => {
  sb.__host = mountHost;
  await partA();
  await partB();
  await partC();
  await partD();
  await partE();
  await partF();
  await partG();
  console.log("");
  if (failures) { console.error(failures + " FAILURE(S)"); process.exit(1); }
  console.log("ALL PASS");
})().catch((e) => { console.error("HARNESS ERROR", (e && e.stack) || e); process.exit(2); });
