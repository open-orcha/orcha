/* ============================================================================
   GH #89 — per-agent pending-notifications bell + veto panel.

   The roster bell renders from the snapshot's `total_pending` (wake truth). The
   panel is the human's per-notification VETO surface: per-row Acknowledge POSTs
   .../notifications/{event_id}/acknowledge {suppress_wake:true} and optimistically
   removes the row (rollback on failure); "Acknowledge all" needs a confirm step
   before POSTing .../notifications/read {suppress_wake:true, through_ts:<loaded max>,
   ack_event_ids:<loaded ids>};
   the snooze control renders ONLY for an agent with a clock auto-wake configured.

   Dependency-free vm-sandbox harness, same pattern as notification_center.test.js:
   stub DOM + fetch, load the REAL app.js, drive the wired path.

   Run:  node tests/portal/pending_ack.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "app.js"
);
const SRC = fs.readFileSync(APP_JS, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

// ---- tiny fake DOM (same shape as notification_center.test.js) -------------
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", _text: "", dataset: {},
    _listeners: {}, _children: {},
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    get textContent() { return n._text; },
    set textContent(v) { n._text = v == null ? "" : String(v); },
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
      toggle: (c, on) => { const s = n.classList._set(); if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (on) s.add(c); else s.delete(c); n._class = [...s].join(" "); },
    },
    setAttribute: () => {}, getAttribute: () => null, focus: () => {},
    appendChild: () => {}, insertAdjacentElement: () => {},
    addEventListener: (ev, fn) => { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    contains: () => false,
    querySelector: (sel) => n._children[sel] || null,
    querySelectorAll: () => [],
  };
  return n;
}
function fire(node, ev) {
  const hs = node && node._listeners && node._listeners[ev];
  if (hs && hs.length) hs[hs.length - 1]({ preventDefault() {}, stopPropagation() {} });
}

// Pending page: two rows — a stateful type (open request → hint) and a plain one.
const PENDING = {
  notifications: [
    { event_id: 11, event_name: "request_created", type: "request_created", zone: "needs_you",
      priority: 20, actor_ref: "a2", actor_alias: "Forge", actor_kind: "ai",
      deeplink: { kind: "request", id: "r7" }, preview: "please review the plan",
      ts: 1718000100, read: false },
    { event_id: 12, event_name: "request_closed", type: "request_closed", zone: "earlier",
      priority: 80, actor_ref: null, actor_alias: null, actor_kind: null,
      deeplink: null, preview: "loop closed", ts: 1718000000, read: false },
  ],
  total_pending: 2, read_through_ts: 0, next_before_ts: null, next_before_id: null,
};

function makeSandbox(opts) {
  opts = opts || {};
  const reg = {};
  // ids the panel renders into innerHTML and then re-binds by getElementById —
  // pre-register stubs so the wired listeners land somewhere the test can fire.
  ["pnAckAll", "pnAck-11", "pnAck-12",
   "pnSnooze1h", "pnSnooze4h", "pnSnoozeTomorrow", "pnSnoozeClear"]
    .forEach((id) => { reg[id] = makeNode(id); });

  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const document = {
    documentElement: { setAttribute: () => {}, getAttribute: () => null },
    body: makeNode("body"),
    addEventListener: () => {},
    createElement: () => {
      const el = makeNode("");
      Object.defineProperty(el, "id", {
        get() { return el._id || ""; },
        set(v) { el._id = v; reg[v] = el; },
      });
      return el;
    },
    getElementById: (id) => (id in reg ? reg[id] : null),
    querySelectorAll: () => [],
  };
  const fetchCalls = [];
  const sandbox = {
    window: { matchMedia: () => ({ matches: false }) },
    document, localStorage, console,
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, body, method: (init && init.method) || "GET" });
      if (/\/acknowledge$/.test(url)) {
        if (opts.failAck) return Promise.reject(new Error("network"));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ suppressed: true }) });
      }
      if (/\/notifications\/read$/.test(url)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ suppressed_count: 2 }) });
      }
      if (/\/wake\/snooze$/.test(url)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(
          { agent_id: "a1", snooze_until: body && ((body.snooze_seconds || body.until_ts) ? "2026-07-02T09:00:00Z" : null) }) });
      }
      if (/\/notifications\/pending\?/.test(url)) {
        // fresh clone per fetch — the app mutates rows in place (optimistic removal), and a
        // real response body is a fresh object every time; sharing the fixture would leak
        // one case's mutations into the next.
        const page = JSON.parse(JSON.stringify(opts.pending || PENDING));
        return Promise.resolve({ ok: true, json: () => Promise.resolve(page) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, reg, fetchCalls };
}

const tick = () => new Promise((r) => setImmediate(r));

function snapshotWith(agent) {
  return { container: { id: "c1" }, agents: [agent], tasks: [], requests: [] };
}
const AGENT = { id: "a1", alias: "Vox", kind: "ai", total_pending: 2, auto_wake_interval_secs: 300 };

async function run() {
  console.log("pending_ack.test.js — GH #89\n");

  // --- Case 1: bell chip renders from total_pending; silent when zero --------
  {
    console.log("Case 1: roster bell renders from total_pending");
    const s = makeSandbox();
    const withPending = s.Orcha.pendingBellHtml({ id: "a1", total_pending: 3 });
    assert(/class="pbell"/.test(withPending) && />3</.test(withPending), "3 pending → bell chip with the count");
    assert(/data-pending-agent="a1"/.test(withPending), "chip carries the agent id for the roster delegation");
    assert(s.Orcha.pendingBellHtml({ id: "a1", total_pending: 0 }) === "", "0 pending → no chip (zero-noise)");
    assert(s.Orcha.pendingBellHtml({ id: "a1" }) === "", "missing count → no chip");
    const capped = s.Orcha.pendingBellHtml({ id: "a1", total_pending: 250 });
    assert(/99\+/.test(capped), "count caps at 99+");
  }

  // --- Case 2: open → GET pending, rows render, stateful hint present --------
  {
    console.log("\nCase 2: openPendingPanel fetches the pending feed and renders the veto rows");
    const s = makeSandbox();
    s.Orcha.applySnapshot(snapshotWith({ ...AGENT }));
    s.Orcha.openPendingPanel("a1");
    await tick();
    const feed = s.fetchCalls.find((c) => /\/notifications\/pending\?/.test(c.url));
    assert(!!feed && /\/api\/agents\/a1\/notifications\/pending\?limit=/.test(feed.url), "GET .../notifications/pending fired on open");
    const html = s.reg.pnFloat.innerHTML;
    assert(s.reg.pnFloat.classList.contains("show"), "panel floats open");
    assert(/Pending notifications — Vox/.test(html), "panel is titled with the agent alias");
    assert(/\(2\)/.test(html), "header count = total_pending");
    assert(/please review the plan/.test(html) && /loop closed/.test(html), "both pending rows render");
    assert(/acknowledging only hides the notification/.test(html), "stateful (open-request) row carries the scope-boundary hint");
    assert(/pn-snooze/.test(html) && /Until 9am tomorrow/.test(html), "snooze block renders (agent has a clock auto-wake)");
  }

  // --- Case 3: per-row ack POSTs + optimistically removes; rollback on fail --
  {
    console.log("\nCase 3: per-row Acknowledge → POST + optimistic removal (rollback on failure)");
    const s = makeSandbox();
    s.Orcha.applySnapshot(snapshotWith({ ...AGENT }));
    s.Orcha.openPendingPanel("a1");
    await tick();
    fire(s.reg["pnAck-11"], "click");
    const ack = s.fetchCalls.find((c) => /\/acknowledge$/.test(c.url));
    assert(!!ack && ack.method === "POST" && /\/api\/agents\/a1\/notifications\/11\/acknowledge$/.test(ack.url),
           "POST .../notifications/11/acknowledge fired");
    assert(ack.body && ack.body.suppress_wake === true, "body carries suppress_wake:true (the veto)");
    assert(!/please review the plan/.test(s.reg.pnFloat.innerHTML), "row removed optimistically before the response");
    assert(/\(1\)/.test(s.reg.pnFloat.innerHTML), "header count drops with it");
    await tick();
    assert(!/please review the plan/.test(s.reg.pnFloat.innerHTML), "row stays gone on 2xx");

    // failure path: the row comes back
    const f = makeSandbox({ failAck: true });
    f.Orcha.applySnapshot(snapshotWith({ ...AGENT }));
    f.Orcha.openPendingPanel("a1");
    await tick();
    fire(f.reg["pnAck-11"], "click");
    assert(!/please review the plan/.test(f.reg.pnFloat.innerHTML), "optimistic removal happens first");
    await tick(); await tick();
    assert(/please review the plan/.test(f.reg.pnFloat.innerHTML), "failed POST rolls the row back");
    assert(/\(2\)/.test(f.reg.pnFloat.innerHTML), "count restored on rollback");
  }

  // --- Case 4: Acknowledge all requires the confirm step ---------------------
  {
    console.log("\nCase 4: Acknowledge all takes TWO clicks, then POSTs the bulk ack");
    const s = makeSandbox();
    s.Orcha.applySnapshot(snapshotWith({ ...AGENT }));
    s.Orcha.openPendingPanel("a1");
    await tick();
    fire(s.reg.pnAckAll, "click");
    assert(s.fetchCalls.every((c) => !/\/notifications\/read$/.test(c.url)), "first click does NOT POST");
    assert(/Really acknowledge all 2\?/.test(s.reg.pnFloat.innerHTML), "first click flips the label to a confirm");
    fire(s.reg.pnAckAll, "click");
    const bulk = s.fetchCalls.find((c) => /\/notifications\/read$/.test(c.url));
    assert(!!bulk && bulk.method === "POST" && bulk.body && bulk.body.suppress_wake === true,
           "second click POSTs notifications/read {suppress_wake:true}");
    assert(bulk.body.through_ts === 1718000100, "bulk ack is bounded to the loaded rows' max ts");
    assert(JSON.stringify(bulk.body.ack_event_ids) === JSON.stringify([11, 12]),
           "bulk ack suppression is bounded to the loaded row event ids");
    assert(/Nothing pending/.test(s.reg.pnFloat.innerHTML), "list clears to the empty state");
  }

  // --- Case 5: partial loads do not expose an unsafe bulk acknowledge --------
  {
    console.log("\nCase 5: partial pending list hides Acknowledge all");
    const s = makeSandbox({ pending: { ...PENDING, total_pending: 3, next_before_ts: 1717999999, next_before_id: 4 } });
    s.Orcha.applySnapshot(snapshotWith({ ...AGENT, total_pending: 3 }));
    s.Orcha.openPendingPanel("a1");
    await tick();
    assert(!/Acknowledge all/.test(s.reg.pnFloat.innerHTML), "no bulk ack when not all pending rows are loaded");
    assert(/Showing the newest 2 of 3/.test(s.reg.pnFloat.innerHTML), "partial-load notice explains why");
  }

  // --- Case 6: snooze only renders with a clock auto-wake; POSTs the choice --
  {
    console.log("\nCase 6: snooze control is clock-wake-gated and POSTs wake/snooze");
    const noClock = makeSandbox();
    noClock.Orcha.applySnapshot(snapshotWith({ ...AGENT, auto_wake_interval_secs: null }));
    noClock.Orcha.openPendingPanel("a1");
    await tick();
    assert(!/pn-snooze/.test(noClock.reg.pnFloat.innerHTML), "no auto_wake_interval_secs → no snooze block");

    const s = makeSandbox();
    s.Orcha.applySnapshot(snapshotWith({ ...AGENT }));
    s.Orcha.openPendingPanel("a1");
    await tick();
    fire(s.reg.pnSnooze1h, "click");
    const sn = s.fetchCalls.find((c) => /\/wake\/snooze$/.test(c.url));
    assert(!!sn && sn.method === "POST" && /\/api\/agents\/a1\/wake\/snooze$/.test(sn.url), "POST .../wake/snooze fired");
    assert(sn.body && sn.body.snooze_seconds === 3600, "1h button sends snooze_seconds:3600");
    await tick();
    assert(/Snoozed — auto-wake resumes/.test(s.reg.pnFloat.innerHTML), "active snooze renders the lift time + Clear");
    fire(s.reg.pnSnoozeClear, "click");
    const clear = s.fetchCalls.filter((c) => /\/wake\/snooze$/.test(c.url))[1];
    assert(!!clear && clear.body && clear.body.snooze_seconds === 0, "Clear sends snooze_seconds:0");
    await tick();
    assert(!/Snoozed —/.test(s.reg.pnFloat.innerHTML), "cleared snooze returns to the choice buttons");
  }

  console.log("\n" + (failures === 0 ? "ALL PASSED ✅" : failures + " FAILED ❌"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
