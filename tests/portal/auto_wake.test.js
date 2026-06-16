/* ============================================================================
   #300 — per-agent clock-driven AUTO-WAKE control (agent Controls card).
   A human-gated segmented control (Off / 5m / 15m / 1h + a dynamic chip for any
   API-set custom cadence) wired to PATCH /api/agents/{aid}/auto-wake with
   {actor_agent_id, interval_secs} (int>=60 or null). Optimistic, reverts on failure.

   Dependency-free: stubs a minimal DOM + fetch, loads the REAL portal app.js +
   data.js in a vm sandbox, then runs the REAL agents.html inline script and drives
   the actual wired path (render → seg render → onAwakeClick → PATCH → optimistic +
   revert). Also asserts data.js's mapSnapshot whitelists the new field. No npm.

   Run:  node tests/portal/auto_wake.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORTAL = path.join(__dirname, "..", "..", "orcha-cli", "orcha_cli", "templates", "portal", "static");
const APP_JS = fs.readFileSync(path.join(PORTAL, "app.js"), "utf8");
const DATA_JS = fs.readFileSync(path.join(PORTAL, "data.js"), "utf8");
const AGENTS_HTML = fs.readFileSync(path.join(PORTAL, "agents.html"), "utf8");

// Extract the page's main inline IIFE (the LAST <script>(function(){…})();</script>).
const SCRIPTS = AGENTS_HTML.match(/<script>\s*\(function \(\)\s*\{[\s\S]*?\}\)\(\);\s*<\/script>/g) || [];
const AGENTS_JS = SCRIPTS[SCRIPTS.length - 1].replace(/^<script>/, "").replace(/<\/script>$/, "");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

// ---- tiny fake DOM ---------------------------------------------------------
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", textContent: "", disabled: false, title: "",
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, dataset: {}, _listeners: {},
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
      toggle: (c, force) => { const has = n.classList._set().has(c);
        const on = force === undefined ? !has : !!force;
        on ? n.classList.add(c) : n.classList.remove(c); return on; },
    },
    setAttribute: () => {}, getAttribute: () => null, contains: () => false,
    addEventListener: (ev, fn) => { n._listeners[ev] = fn; },
    insertAdjacentElement: () => {}, appendChild: () => {}, focus: () => {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  return n;
}

function makeSandbox(opts) {
  opts = opts || {};
  const reg = {};
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
    activeElement: null,
    createElement: () => {
      const el = makeNode("");
      Object.defineProperty(el, "id", { get() { return el._id || ""; }, set(v) { el._id = v; reg[v] = el; } });
      return el;
    },
    // auto-create any element the page asks for, cached by id (so a node persists across paints).
    getElementById: (id) => (reg[id] || (reg[id] = makeNode(id))),
    querySelectorAll: () => [],
  };
  const fetchCalls = [];
  const sandbox = {
    // data.js + agents.html read `new URLSearchParams(location.search)` at load (agents.html
    // unguarded), so both URLSearchParams and a minimal location must be sandbox globals.
    URLSearchParams, location: { search: "" }, document, localStorage, console,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    EventSource: undefined,
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, method: (init && init.method) || "GET", body });
      if (opts.failAwake && /\/auto-wake$/.test(url)) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ runs: [], digest: null }) });
    },
  };
  // In a browser `window` IS the global, so `window.Orcha = …` defines a bare global `Orcha`
  // and `OrchaTerm`/`OrchaConvo` resolve unprefixed. Mirror that: window === the sandbox global.
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox, { filename: "app.js" });
  vm.runInContext(DATA_JS, sandbox, { filename: "data.js" });
  // Capture the page render fn WITHOUT starting the real poll/EventSource loop.
  const cap = { render: null };
  sandbox.window.OrchaData.start = (render) => { cap.render = render; };
  sandbox.window.OrchaConvo = { mount: () => {}, teardown: () => {} };
  sandbox.window.OrchaTerm = { liveAgentIds: () => [] };
  vm.runInContext(AGENTS_JS, sandbox, { filename: "agents.html" });
  return { Orcha: sandbox.window.Orcha, OrchaData: sandbox.window.OrchaData, reg, fetchCalls, cap,
    ORCHA: () => sandbox.window.ORCHA };
}

const tick = () => new Promise((r) => setImmediate(r));
const human = { id: "h1", alias: "Kedar", kind: "human" };
function aiAgent(extra) {
  return Object.assign({ id: "ag1", alias: "Glass", kind: "ai", role: "frontend",
    status: "idle", wake_enabled: true, auto_wake_interval_secs: null, model: "claude-opus-4-8" }, extra || {});
}
// drive the REAL onAwakeClick with a synthesized event for the given interval.
function clickAwake(s, aid, secs) {
  const segObj = { dataset: { agent: aid } };
  const btn = { dataset: { awake: secs == null ? "null" : String(secs) }, disabled: false,
    closest: (sel) => sel === "#awakeSeg" ? segObj : null };
  const ev = { target: { closest: (sel) => sel === "[data-awake]" ? btn : null } };
  s.reg.awakeSeg._listeners.click(ev);
}
// the data-awake value of the button currently carrying class "on" (null = "Off" chip).
function activeAwake(html) {
  const re = /class="([^"]*)"\s+data-awake="([^"]*)"/g; let m;
  while ((m = re.exec(html))) { if (/\bon\b/.test(m[1])) return m[2]; }
  return undefined;
}
function renderWith(s, snap) { s.Orcha.applySnapshot(snap); s.cap.render(); }

async function run() {
  console.log("auto_wake.test.js — #300 per-agent auto-wake control\n");

  // --- Case 1: data.js mapSnapshot whitelists auto_wake_interval_secs --------
  {
    console.log("Case 1: data.js mapSnapshot carries auto_wake_interval_secs through the adapter");
    const s = makeSandbox();
    const mapped = s.OrchaData.mapSnapshot({ agents: [{ id: "ag1", alias: "Glass", kind: "ai", auto_wake_interval_secs: 900 }], tasks: [], requests: [] });
    assert(mapped.agents[0].auto_wake_interval_secs === 900, "set value (900) survives mapSnapshot");
    const off = s.OrchaData.mapSnapshot({ agents: [{ id: "ag1", alias: "Glass", kind: "ai" }], tasks: [], requests: [] });
    assert(off.agents[0].auto_wake_interval_secs === null, "absent → null (Off), never undefined");
  }

  // --- Case 2: control renders with the right presets + active state ---------
  {
    console.log("\nCase 2: Off-by-default renders all presets, 'Off' lit, all >= 60s floor");
    const s = makeSandbox();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent()], tasks: [], requests: [] });
    const html = s.reg.detailMain.innerHTML;
    assert(/id="awakeSeg"/.test(html), "Auto-wake segmented control rendered on the AI agent");
    assert(/data-awake="null"[^>]*>Off</.test(html) || />Off</.test(html), "an 'Off' option exists");
    ["300", "900", "3600"].forEach((v) => assert(new RegExp('data-awake="' + v + '"').test(html), "preset " + v + "s present"));
    assert(activeAwake(html) === "null", "with no cadence set, the 'Off' chip is active");
    // every numeric preset honors the backend's 60s floor
    const nums = (html.match(/data-awake="(\d+)"/g) || []).map((x) => parseInt(x.replace(/\D/g, ""), 10));
    assert(nums.every((n) => n >= 60), "no preset below the 60s DB/Pydantic floor");
  }

  // --- Case 3: a set cadence lights its preset -------------------------------
  {
    console.log("\nCase 3: auto_wake_interval_secs=900 lights the 15m preset");
    const s = makeSandbox();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent({ auto_wake_interval_secs: 900 })], tasks: [], requests: [] });
    assert(activeAwake(s.reg.detailMain.innerHTML) === "900", "15m (900s) is the lit preset");
  }

  // --- Case 4: an API-set non-preset value surfaces as an honest chip --------
  {
    console.log("\nCase 4: a non-preset cadence (600s/10m) renders a dynamic active chip");
    const s = makeSandbox();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent({ auto_wake_interval_secs: 600 })], tasks: [], requests: [] });
    const html = s.reg.detailMain.innerHTML;
    assert(/data-awake="600"[^>]*>10m</.test(html), "custom 10m chip added so the live state isn't hidden");
    assert(activeAwake(html) === "600", "the custom chip is the lit one");
  }

  // --- Case 5: gated read-only when no acting human --------------------------
  {
    console.log("\nCase 5: no acting human → buttons disabled AND click is a no-op (no PATCH)");
    const s = makeSandbox();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [aiAgent()], tasks: [], requests: [] });
    assert(/data-awake="300"[^>]*disabled/.test(s.reg.detailMain.innerHTML), "presets render disabled without a human");
    clickAwake(s, "ag1", 300);   // defense-in-depth: the handler itself re-checks actingHuman
    assert(s.fetchCalls.filter((c) => /\/auto-wake$/.test(c.url)).length === 0, "no PATCH fired without an acting human");
  }

  // --- Case 6: happy path — PATCH with correct route/body + optimistic flip ---
  {
    console.log("\nCase 6: click 15m → PATCH /auto-wake {actor_agent_id, interval_secs:900}, optimistic");
    const s = makeSandbox();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent()], tasks: [], requests: [] });
    clickAwake(s, "ag1", 900);
    const aw = s.fetchCalls.filter((c) => /\/auto-wake$/.test(c.url));
    assert(aw.length === 1, "exactly one PATCH fired");
    assert(/\/api\/agents\/ag1\/auto-wake$/.test(aw[0].url) && aw[0].method === "PATCH", "PATCH hits the agent's auto-wake route");
    assert(aw[0].body.actor_agent_id === "h1", "body carries the acting human id (HUMAN-AUTHORITY)");
    assert(aw[0].body.interval_secs === 900, "body.interval_secs === 900");
    assert(activeAwake(s.reg.detailMain.innerHTML) === "900", "optimistic: 15m lit immediately");
    await tick();
    assert(activeAwake(s.reg.detailMain.innerHTML) === "900", "stays 15m after the PATCH resolves");
  }

  // --- Case 7: disabling sends interval_secs: null ---------------------------
  {
    console.log("\nCase 7: from a set cadence, click Off → PATCH interval_secs: null");
    const s = makeSandbox();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent({ auto_wake_interval_secs: 3600 })], tasks: [], requests: [] });
    clickAwake(s, "ag1", null);
    const aw = s.fetchCalls.filter((c) => /\/auto-wake$/.test(c.url));
    assert(aw.length === 1 && aw[0].body.interval_secs === null, "PATCH body.interval_secs === null (disable)");
    assert(activeAwake(s.reg.detailMain.innerHTML) === "null", "optimistic: 'Off' lit");
  }

  // --- Case 8: re-clicking the active cadence is a no-op ---------------------
  {
    console.log("\nCase 8: clicking the already-active cadence fires no PATCH");
    const s = makeSandbox();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent({ auto_wake_interval_secs: 900 })], tasks: [], requests: [] });
    clickAwake(s, "ag1", 900);
    assert(s.fetchCalls.filter((c) => /\/auto-wake$/.test(c.url)).length === 0, "no-op: no redundant PATCH for the current value");
  }

  // --- Case 9: failed PATCH reverts the optimistic flip ----------------------
  {
    console.log("\nCase 9: PATCH failure reverts to the prior cadence");
    const s = makeSandbox({ failAwake: true });
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent({ auto_wake_interval_secs: 300 })], tasks: [], requests: [] });
    clickAwake(s, "ag1", 3600);
    assert(activeAwake(s.reg.detailMain.innerHTML) === "3600", "optimistic flip to 1h applied");
    await tick();
    assert(activeAwake(s.reg.detailMain.innerHTML) === "300", "reverted to 5m (300s) after the PATCH failed");
  }

  // --- Case 10: human agents get no auto-wake control ------------------------
  {
    console.log("\nCase 10: a HUMAN agent shows no auto-wake control (humans aren't woken)");
    const s = makeSandbox();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human], tasks: [], requests: [] });
    assert(!/id="awakeSeg"/.test(s.reg.detailMain.innerHTML), "no Auto-wake control on the human authority");
  }

  console.log("\n" + (failures === 0 ? "ALL PASSED ✅" : failures + " FAILED ❌"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
