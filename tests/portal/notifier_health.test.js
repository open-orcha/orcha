/* ============================================================================
   #103 — notifier health surface in the portal topbar. Covers the exact
   acceptance-criteria UI: the inline health chip on the autonomy switch, the
   "Running but no notifier polling" warning banner (shown ONLY when wakes are on
   AND the notifier is stale/offline), and the Restart-notifier POST with its
   self-heal vs manual-fallback branches.

   Dependency-free: stubs a minimal DOM + fetch, loads the REAL portal app.js in a
   vm sandbox, and drives the actual wired path (applySnapshot → paintAutonomy →
   paintNotifier → restart click → POST). No npm install.

   Run:  node tests/portal/notifier_health.test.js
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

function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", _segs: null, _segHtml: null, textContent: "",
    dataset: {}, onclick: null, onkeydown: null,
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      toggle: (c, on) => { const s = n.classList._set(); if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (on) s.add(c); else s.delete(c); n._class = [...s].join(" "); },
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
    },
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: () => {}, insertAdjacentElement: () => {}, appendChild: () => {}, focus: () => {},
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (!/seg/.test(sel)) return [];
      if (n._segHtml !== n._html) {
        const segs = [];
        const re = /<span class="([^"]*)"\s+data-rung="(\d+)"/g;
        let m;
        while ((m = re.exec(n._html))) {
          const seg = makeNode("");
          seg._class = m[1]; seg.dataset = { rung: m[2] };
          segs.push(seg);
        }
        n._segs = segs; n._segHtml = n._html;
      }
      return n._segs;
    },
  };
  return n;
}

function makeSandbox() {
  const reg = {};
  // Pre-register the topbar nodes AND the #103 notifbar trio (in the real app these are injected by
  // ensurePausebar via insertAdjacentElement, which the fake DOM no-ops — so seed them here).
  ["autTop", "topbar", "pausebar", "resumeBtn", "notifbar", "notifbarMsg", "notifRestartBtn", "__mc", "__mp"]
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
      Object.defineProperty(el, "id", { get() { return el._id || ""; }, set(v) { el._id = v; reg[v] = el; } });
      return el;
    },
    getElementById: (id) => (id in reg ? reg[id] : null),
    querySelectorAll: () => [],
  };
  const fetchCalls = [];
  const toasts = [];
  const sandbox = {
    window: { matchMedia: () => ({ matches: false }) },
    document, localStorage, console,
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, body });
      let res = { ok: true };
      if (/\/notifier\/restart-request$/.test(url)) {
        // self_heal keyed off a global the test sets before clicking
        res = { ok: true, self_heal: sandbox.__selfHeal, notifier_status: sandbox.__selfHeal ? "stale" : "offline",
                manual_command: "orcha notifier --restart" };
      } else if (/\/wakes$/.test(url)) {
        res = { container_id: "c1", wakes_enabled: body.enabled };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(res) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, reg, fetchCalls, store, sandbox };
}

const tick = () => new Promise((r) => setImmediate(r));
const human = { id: "h1", alias: "Kedar", kind: "human" };
const snap = (notifier, wakes) => ({
  container: { id: "c1", wakes_enabled: wakes !== false, notifier },
  agents: [human], tasks: [], requests: [],
});

async function run() {
  console.log("notifier_health.test.js — #103\n");

  // --- Case 1: chip tones per status ----------------------------------------
  {
    console.log("Case 1: the health chip renders in the right tone/label per status");
    for (const [status, tone, label] of [
      ["running", "ok", "notifier live"],
      ["stale", "warn", "notifier stale"],
      ["offline", "bad", "notifier offline"],
    ]) {
      const s = makeSandbox();
      s.Orcha.applySnapshot(snap({ status }, true));
      const html = s.reg.autTop.innerHTML;
      assert(new RegExp(`notif-chip ${tone}`).test(html) && html.includes(label),
        `${status} → chip '${tone}' labelled '${label}'`);
    }
  }

  // --- Case 2: pre-#103 snapshot omits notifier → no chip, no banner --------
  {
    console.log("\nCase 2: a pre-#103 snapshot (no notifier field) shows no chip and no banner");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true }, agents: [human], tasks: [], requests: [] });
    assert(!/notif-chip/.test(s.reg.autTop.innerHTML), "no chip rendered on an older backend");
    assert(!s.reg.notifbar.classList.contains("show"), "no warning banner on an older backend");
  }

  // --- Case 3: banner shows ONLY when Running + unhealthy --------------------
  {
    console.log("\nCase 3: the warning banner is gated on Running AND stale/offline");
    let s = makeSandbox();
    s.Orcha.applySnapshot(snap({ status: "running" }, true));
    assert(!s.reg.notifbar.classList.contains("show"), "running → banner hidden");

    s = makeSandbox();
    s.Orcha.applySnapshot(snap({ status: "offline" }, true));
    assert(s.reg.notifbar.classList.contains("show"), "Running + offline → banner shown");
    assert(/offline/.test(s.reg.notifbarMsg.textContent), "banner message names the offline state");

    s = makeSandbox();
    s.Orcha.applySnapshot(snap({ status: "offline" }, false));   // paused
    assert(!s.reg.notifbar.classList.contains("show"), "Paused → pausebar owns it, notifbar hidden");
  }

  // --- Case 4: restart click → self-heal → POST, no modal -------------------
  {
    console.log("\nCase 4: Restart notifier POSTs the request; self_heal path just toasts");
    const s = makeSandbox();
    s.sandbox.__selfHeal = true;
    s.Orcha.applySnapshot(snap({ status: "stale" }, true));
    s.reg.notifRestartBtn.onclick();
    await tick();
    const call = s.fetchCalls.find((c) => /\/notifier\/restart-request$/.test(c.url));
    assert(!!call, "POST /notifier/restart-request fired");
    assert(call && call.body.actor_agent_id === "h1", "carries the acting human as actor");
    assert(!s.reg.__ov || !s.reg.__ov.classList.contains("show"), "self-heal shows no manual-command modal");
  }

  // --- Case 5: restart click → offline → manual-command modal ----------------
  {
    console.log("\nCase 5: when the notifier is offline, the manual-command modal is shown");
    const s = makeSandbox();
    s.sandbox.__selfHeal = false;
    s.Orcha.applySnapshot(snap({ status: "offline" }, true));
    s.reg.notifRestartBtn.onclick();
    await tick();
    assert(s.fetchCalls.some((c) => /\/notifier\/restart-request$/.test(c.url)), "POST fired");
    const ov = s.reg.__ov;
    assert(ov && ov.classList.contains("show"), "manual-command modal opened");
    assert(ov && /orcha notifier --restart/.test(ov.innerHTML), "modal shows the exact host command");
  }

  console.log(failures === 0 ? "\nALL PASSED ✅" : `\n${failures} FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
