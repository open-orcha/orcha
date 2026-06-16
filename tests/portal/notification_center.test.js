/* ============================================================================
   SPEC-3 — notification center (topbar "Needs you" dropdown). The pill EXPANDS
   into a typed feed instead of jumping to /#needs. Two zones:
     NEEDS YOU — actionable, client-computed from attnItems() (snapshot-fresh).
     EARLIER   — informational, the acting human's #247 registry feed
                 (GET /api/agents/{aid}/notifications?zone=earlier), with
                 "Mark all read" (POST .../notifications/read) + keyset paging.

   Dependency-free: stubs a minimal DOM + fetch, loads the REAL portal app.js in
   a vm sandbox, and drives the actual wired path (mountShell → pill click →
   ncOpen → fetch → render; applySnapshot → paintNotifications). No npm install.

   Run:  node tests/portal/notification_center.test.js
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

// ---- tiny fake DOM ---------------------------------------------------------
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
      toggle: (c, on) => { const s = n.classList._set(); if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (on) s.add(c); else s.delete(c); n._class = [...s].join(" "); },
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
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
// fire the LAST-registered handler for an event (each render re-attaches a fresh one).
function fire(node, ev) {
  const hs = node && node._listeners && node._listeners[ev];
  if (hs && hs.length) hs[hs.length - 1]({ preventDefault() {}, stopPropagation() {} });
}

function makeSandbox(opts) {
  opts = opts || {};
  const reg = {};
  ["sidebar", "topbar", "autTop", "pausebar", "resumeBtn", "attnPill", "ncMark", "ncMore", "themeBtn"]
    .forEach((id) => { reg[id] = makeNode(id); });
  // the badge count lives inside the pill as a `.n` child the code reconciles directly.
  reg.attnPill._children[".n"] = makeNode("");

  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const documentElement = { setAttribute: () => {}, getAttribute: () => null };
  const document = {
    documentElement, body: makeNode("body"),
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
  const window = { matchMedia: () => ({ matches: false }) };
  const sandbox = {
    window, document, localStorage, console,
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, body, method: (init && init.method) || "GET" });
      if (opts.failFetch) return Promise.reject(new Error("network"));
      if (/\/notifications\/read$/.test(url)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ agent_id: "h1", read_through_ts: 1718000050 }) });
      }
      if (/\/notifications\?/.test(url)) {
        const page = /before_ts=/.test(url) ? (opts.page2 || PAGE2) : (opts.page1 || PAGE1);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(page) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, reg, fetchCalls, store };
}

const tick = () => new Promise((r) => setImmediate(r));
const human = { id: "h1", alias: "Kedar", kind: "human" };

// EARLIER feed pages. Page 1 carries a known type, a graceful-degrade UNKNOWN type, and a
// keyset cursor (next_before_ts/id) → "Load earlier" appears. Page 2 is the tail (cursor null).
const PAGE1 = {
  notifications: [
    { event_name: "task_verified", type: "task_verified", zone: "earlier", priority: 10,
      actor_ref: "a1", actor_alias: "Anvil", actor_kind: "ai",
      deeplink: { kind: "task", id: "t9" }, preview: "#254 seed", ts: 1718000000, read: false },
    { event_name: "brand_new_kind", type: "brand_new_kind", zone: "earlier", priority: 90,
      actor_ref: null, actor_alias: null, actor_kind: null,
      deeplink: null, preview: "from the future", ts: 1717990000, read: true },
  ],
  read_through_ts: 1717990000, next_before_ts: 1717990000, next_before_id: 5,
};
const PAGE2 = {
  notifications: [
    { event_name: "request_answered", type: "request_answered", zone: "earlier", priority: 50,
      actor_ref: "a2", actor_alias: "Forge", actor_kind: "ai",
      deeplink: { kind: "request", id: "r4" }, preview: "run_id at SessionEnd", ts: 1717980000, read: true },
  ],
  read_through_ts: 1717990000, next_before_ts: null, next_before_id: null,
};

function baseSnapshot() {
  return {
    container: { id: "c1", wakes_enabled: true },
    agents: [human],
    tasks: [
      { id: "tp", title: "redesign portal", status: "in_progress", assignee: "Glass",
        plan_message: { body: "here is the plan", at: "2026-06-16T10:00:00Z" }, plan_decision: null,
        started_at: "2026-06-16T09:00:00Z" },
      { id: "tv", title: "#254 seed", status: "needs_verification", assignee: "Anvil",
        started_at: "2026-06-16T08:00:00Z" },
    ],
    requests: [
      { id: "re", type: "info", status: "open", target_id: null, from: "Lens",
        payload: "need a decision on the cite anchors", created_at: "2026-06-16T07:00:00Z" },
    ],
  };
}

async function run() {
  console.log("notification_center.test.js — SPEC-3\n");

  // --- Case 1: pill click toggles the panel + renders NEEDS YOU from attnItems ---
  {
    console.log("Case 1: click pill → panel opens, NEEDS YOU zone built from attnItems()");
    const s = makeSandbox();
    s.Orcha.applySnapshot(baseSnapshot());
    s.Orcha.mountShell("home", { title: "Dashboard" });
    assert(!s.reg.ncFloat || !s.reg.ncFloat.classList.contains("show"), "panel starts closed");
    fire(s.reg.attnPill, "click");
    const float = s.reg.ncFloat;
    assert(!!float && float.classList.contains("show"), "pill click opens the floating panel");
    const html = float.innerHTML;
    assert(/Needs you <span class="ct">\(3\)/.test(html), "NEEDS YOU count = 3 (1 plan + 1 verify + 1 escalation)");
    assert(/Plan approval · redesign portal/.test(html), "pending-plan row rendered");
    assert(/Verify task · #254 seed/.test(html), "needs_verification row rendered");
    assert(/Escalation · need a decision/.test(html), "escalation row rendered");
    assert(/\/tasks\?task=tp/.test(html) && /\/requests\?req=re/.test(html), "NEEDS YOU rows deep-link to task/request");
    // toggle closed
    fire(s.reg.attnPill, "click");
    assert(!float.classList.contains("show"), "second pill click closes the panel");
  }

  // --- Case 2: badge = NEEDS YOU count, reconciled on every snapshot ----------
  {
    console.log("\nCase 2: badge reflects NEEDS-YOU count and refreshes on poll");
    const s = makeSandbox();
    s.Orcha.applySnapshot(baseSnapshot());
    s.Orcha.mountShell("home", { title: "Dashboard" });
    assert(s.reg.attnPill._children[".n"].textContent === "3", "badge shows 3 after mount");
    const snap = baseSnapshot();
    snap.requests = [];   // escalation cleared → count drops to 2
    s.Orcha.applySnapshot(snap);
    assert(s.reg.attnPill._children[".n"].textContent === "2", "poll reconcile drops the badge to 2");
  }

  // --- Case 3: EARLIER feed fetched from the registry + graceful degrade ------
  {
    console.log("\nCase 3: open → GET ?zone=earlier, known type + unknown type degrade");
    const s = makeSandbox();
    s.Orcha.applySnapshot(baseSnapshot());
    s.Orcha.mountShell("home", { title: "Dashboard" });
    fire(s.reg.attnPill, "click");
    await tick();
    const feed = s.fetchCalls.find((c) => /\/notifications\?/.test(c.url));
    assert(!!feed, "a feed GET fired on open");
    assert(/\/api\/agents\/h1\/notifications\?zone=earlier&limit=20/.test(feed.url), "feed hits the acting human's earlier-zone feed");
    const html = s.reg.ncFloat.innerHTML;
    assert(/Task verified · #254 seed/.test(html), "known type renders its label + preview");
    assert(/Brand new kind · from the future/.test(html), "unknown type degrades to a humanised label (no crash)");
    assert(/\/tasks\?task=t9/.test(html), "EARLIER row deep-links via its registry deeplink");
    assert(/class="nrow unread"/.test(html), "the unread row carries the unread accent");
    assert(/Load earlier/.test(html), "keyset cursor present → 'Load earlier' shown");
  }

  // --- Case 4: Mark all read → POST .../notifications/read, rows flip read ----
  {
    console.log("\nCase 4: Mark all read POSTs the read cursor + clears unread accents");
    const s = makeSandbox();
    s.Orcha.applySnapshot(baseSnapshot());
    s.Orcha.mountShell("home", { title: "Dashboard" });
    fire(s.reg.attnPill, "click");
    await tick();
    assert(/class="nrow unread"/.test(s.reg.ncFloat.innerHTML), "an unread row exists pre-mark");
    fire(s.reg.ncMark, "click");
    const read = s.fetchCalls.find((c) => /\/notifications\/read$/.test(c.url));
    assert(!!read && read.method === "POST", "POST fired to the read-cursor route");
    assert(!/class="nrow unread"/.test(s.reg.ncFloat.innerHTML), "optimistic: no unread accents remain after mark-all-read");
  }

  // --- Case 5: Load earlier paginates with the keyset cursor -----------------
  {
    console.log("\nCase 5: Load earlier passes before_ts + before_id and appends the next page");
    const s = makeSandbox();
    s.Orcha.applySnapshot(baseSnapshot());
    s.Orcha.mountShell("home", { title: "Dashboard" });
    fire(s.reg.attnPill, "click");
    await tick();
    fire(s.reg.ncMore, "click");
    await tick();
    const page2 = s.fetchCalls.filter((c) => /\/notifications\?/.test(c.url))[1];
    assert(!!page2 && /before_ts=1717990000/.test(page2.url) && /before_id=5/.test(page2.url), "second page uses the (ts,id) keyset cursor from page 1");
    const html = s.reg.ncFloat.innerHTML;
    assert(/Task verified · #254 seed/.test(html) && /Request answered · run_id/.test(html), "page 2 is appended below page 1");
    assert(!/Load earlier/.test(html), "tail page (null cursor) hides 'Load earlier'");
  }

  // --- Case 6: no acting human → EARLIER prompts to pick one, no feed fetch ---
  {
    console.log("\nCase 6: no acting human → EARLIER shows a hint and never fetches the feed");
    const s = makeSandbox();
    const snap = baseSnapshot(); snap.agents = [];   // no human
    s.Orcha.applySnapshot(snap);
    s.Orcha.mountShell("home", { title: "Dashboard" });
    fire(s.reg.attnPill, "click");
    await tick();
    assert(s.fetchCalls.every((c) => !/\/notifications/.test(c.url)), "no feed fetch without an acting human");
    assert(/Pick an acting human/.test(s.reg.ncFloat.innerHTML), "EARLIER zone shows the pick-a-human hint");
  }

  console.log("\n" + (failures === 0 ? "ALL PASSED ✅" : failures + " FAILED ❌"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
