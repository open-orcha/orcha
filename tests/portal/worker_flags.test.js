/* ============================================================================
   Launch-flags Controls row — read-only breakdown of HOW the daemon spawns the
   selected runtime's worker (per-runtime flags from GET /api/models.worker_flags).

   Dependency-free: stubs a minimal DOM + fetch (which returns a worker_flags
   fixture for /api/models), loads the REAL portal app.js + data.js in a vm
   sandbox, then runs the REAL agents.html inline script and asserts the row
   renders the right flags for the selected model's runtime, surfaces the
   reasoning-effort "not set" row, and stays hidden for humans. No npm.

   Run:  node tests/portal/worker_flags.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORTAL = path.join(__dirname, "..", "..", "orcha-cli", "orcha_cli", "templates", "portal", "static");
const APP_JS = fs.readFileSync(path.join(PORTAL, "app.js"), "utf8");
const DATA_JS = fs.readFileSync(path.join(PORTAL, "data.js"), "utf8");
const AGENTS_HTML = fs.readFileSync(path.join(PORTAL, "agents.html"), "utf8");

const SCRIPTS = AGENTS_HTML.match(/<script>\s*\(function \(\)\s*\{[\s\S]*?\}\)\(\);\s*<\/script>/g) || [];
const AGENTS_JS = SCRIPTS[SCRIPTS.length - 1].replace(/^<script>/, "").replace(/<\/script>$/, "");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

// Fixture shaped like the real main.WORKER_LAUNCH_FLAGS payload.
const MODELS_FIX = [
  { id: "claude-opus-4-8", name: "Opus 4.8", runtime: "claude" },
  { id: "gpt-5.5", name: "GPT-5.5", runtime: "codex" },
];
const WORKER_FLAGS_FIX = {
  claude: [
    { flag: "--model <id>", label: "Model", dynamic: true, detail: "Boots the worker on the selected model." },
    { flag: "--output-format stream-json", label: "Streaming JSON output", static: true, detail: "Tailable events." },
    { flag: "--dangerously-skip-permissions", label: "Permission prompts skipped", static: true, detail: "No TTY." },
    { flag: "(none — CLI default)", label: "Reasoning effort", set: false, detail: "Not set by Orcha — #241." },
  ],
  codex: [
    { flag: "exec", label: "Headless exec mode", static: true, detail: "Codex automation entrypoint." },
    { flag: "--dangerously-bypass-approvals-and-sandbox", label: "Approvals + sandbox bypassed", static: true, detail: "Non-interactive." },
    { flag: "(none — CLI default)", label: "Reasoning effort", set: false, detail: "Not set by Orcha — #241." },
  ],
};

function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", textContent: "", disabled: false, title: "",
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, dataset: {}, _listeners: {},
    get className() { return n._class; }, set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; }, set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
      toggle: (c, force) => { const has = n.classList._set().has(c);
        const on = force === undefined ? !has : !!force; on ? n.classList.add(c) : n.classList.remove(c); return on; },
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
    setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; },
  };
  const document = {
    documentElement: { setAttribute: () => {}, getAttribute: () => null },
    body: makeNode("body"), addEventListener: () => {}, activeElement: null,
    createElement: () => {
      const el = makeNode("");
      Object.defineProperty(el, "id", { get() { return el._id || ""; }, set(v) { el._id = v; reg[v] = el; } });
      return el;
    },
    getElementById: (id) => (reg[id] || (reg[id] = makeNode(id))),
    querySelectorAll: () => [],
  };
  const sandbox = {
    URLSearchParams, location: { search: "" }, document, localStorage, console,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    EventSource: undefined,
    fetch: (url) => {
      if (/\/api\/models$/.test(url)) {
        const body = { models: MODELS_FIX, default: "claude-opus-4-8" };
        if (!opts.noFlags) body.worker_flags = WORKER_FLAGS_FIX;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ runs: [], digest: null }) });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox, { filename: "app.js" });
  vm.runInContext(DATA_JS, sandbox, { filename: "data.js" });
  const cap = { render: null };
  sandbox.window.OrchaData.start = (render) => { cap.render = render; };
  sandbox.window.OrchaConvo = { mount: () => {}, teardown: () => {} };
  sandbox.window.OrchaTerm = { liveAgentIds: () => [] };
  vm.runInContext(AGENTS_JS, sandbox, { filename: "agents.html" });
  return { Orcha: sandbox.window.Orcha, OrchaData: sandbox.window.OrchaData, reg, cap };
}

const tick = () => new Promise((r) => setImmediate(r));
const human = { id: "h1", alias: "Kedar", kind: "human" };
function aiAgent(extra) {
  return Object.assign({ id: "ag1", alias: "Glass", kind: "ai", role: "frontend",
    status: "idle", wake_enabled: true, auto_wake_interval_secs: null, model: "claude-opus-4-8" }, extra || {});
}
function renderWith(s, snap) { s.Orcha.applySnapshot(snap); s.cap.render(); }

async function run() {
  console.log("worker_flags.test.js — launch-flags Controls row\n");

  // --- Case 1: Claude agent → claude flags, static + dynamic + not-set rows ----
  {
    console.log("Case 1: a Claude-model agent shows the Claude launch flags");
    const s = makeSandbox();
    await tick(); // let the /api/models fetch populate WORKER_FLAGS
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent()], tasks: [], requests: [] });
    const html = s.reg.detailMain.innerHTML;
    assert(/Launch flags/.test(html), "Launch flags row rendered");
    assert(/How the daemon runs this Claude worker/.test(html), "labelled with the Claude runtime");
    assert(/--output-format stream-json/.test(html), "a static Claude flag is shown verbatim");
    assert(/class="flagtag dyn"[^>]*>per-agent</.test(html), "the dynamic --model flag is tagged per-agent");
    assert(/class="flagrow unset"/.test(html) && /class="flagtag"[^>]*>not set</.test(html),
      "the reasoning-effort gap is shown as an explicit 'not set' row");
    assert(!/--dangerously-bypass-approvals-and-sandbox/.test(html), "no Codex-only flags leak into the Claude view");
  }

  // --- Case 2: a Codex-model agent shows the Codex flags ---------------------
  {
    console.log("\nCase 2: a Codex-model agent shows the Codex launch flags");
    const s = makeSandbox();
    await tick();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent({ model: "gpt-5.5" })], tasks: [], requests: [] });
    const html = s.reg.detailMain.innerHTML;
    assert(/How the daemon runs this Codex worker/.test(html), "labelled with the Codex runtime");
    assert(/--dangerously-bypass-approvals-and-sandbox/.test(html), "a static Codex flag is shown");
    assert(!/--output-format stream-json/.test(html), "no Claude-only flags leak into the Codex view");
  }

  // --- Case 3: humans get no Controls flags row -----------------------------
  {
    console.log("\nCase 3: a HUMAN agent shows no launch-flags row");
    const s = makeSandbox();
    await tick();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human], tasks: [], requests: [] });
    assert(!/Launch flags/.test(s.reg.detailMain.innerHTML), "no Launch flags row on the human authority");
  }

  // --- Case 4: pre-fetch (no worker_flags) shows a graceful placeholder ------
  {
    console.log("\nCase 4: when worker_flags isn't available the row degrades to 'Loading…'");
    const s = makeSandbox({ noFlags: true });
    await tick();
    renderWith(s, { container: { id: "c1", name: "X" }, agents: [human, aiAgent()], tasks: [], requests: [] });
    const html = s.reg.detailMain.innerHTML;
    assert(/Launch flags/.test(html), "the row still renders its header");
    assert(/Loading…/.test(html), "and shows a 'Loading…' placeholder rather than breaking");
  }

  console.log("\n" + (failures === 0 ? "ALL PASSED ✅" : failures + " FAILED ❌"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
