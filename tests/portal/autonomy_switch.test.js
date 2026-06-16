/* ============================================================================
   SPEC-1 — global autonomy switch (topbar). TWO orthogonal backends in one slider:
   rung 0 is the LIVE binary kill-switch (containers.wakes_enabled) rendered
   Paused(red)/Running(green); rungs 1-3 are the engine autonomy LEVEL
   (#298 containers.autonomy_level, plan|pr|full) — the active level lights in its
   tone and clicking a different level confirms → POST /api/containers/{cid}/autonomy.

   Dependency-free: stubs a minimal DOM + fetch, loads the REAL portal app.js in a
   vm sandbox, and drives the actual wired path (applySnapshot → paintAutonomy →
   seg click → confirm modal → POST → optimistic + reconcile). No npm install.

   Run:  node tests/portal/autonomy_switch.test.js
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
    id: id || "", _class: "", _html: "", _segs: null, _segHtml: null,
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
      if (n._segHtml !== n._html) {   // cache so onclick assignments persist across paints
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

function makeSandbox(opts) {
  opts = opts || {};
  const reg = {};   // id -> node
  ["autTop", "topbar", "pausebar", "resumeBtn", "__mc", "__mp"].forEach((id) => { reg[id] = makeNode(id); });

  const captured = { modalHandlers: [] };
  // __mp.addEventListener captures the confirm handler so the test can "click" it.
  reg.__mp.addEventListener = (ev, fn) => { if (ev === "click") captured.modalHandlers.push(fn); };
  reg.__mc.addEventListener = () => {};

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
      // modal creates the overlay; register it under whatever id it is assigned.
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
      fetchCalls.push({ url, body });
      if (opts.failFetch) return Promise.reject(new Error("network"));
      // Route-aware echo: /autonomy returns the new level, /wakes returns the new binary.
      const res = /\/autonomy$/.test(url)
        ? { container_id: "c1", autonomy_level: body.level }
        : { container_id: "c1", wakes_enabled: body.enabled };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(res) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, ORCHA: sandbox.window.ORCHA, reg, fetchCalls, captured, store };
}

const tick = () => new Promise((r) => setImmediate(r));

async function run() {
  console.log("autonomy_switch.test.js — SPEC-1 Phase A\n");

  const human = { id: "h1", alias: "Kedar", kind: "human" };

  // --- Case 1: Running render ------------------------------------------------
  {
    console.log("Case 1: wakes_enabled=true → Running (neutral green); level rungs 1-3 live (default 'plan' lit)");
    const s = makeSandbox();
    // snapshot omits autonomy_level → degrades to the migration default 'plan' (rung 1)
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true }, agents: [human], tasks: [], requests: [] });
    const html = s.reg.autTop.innerHTML;
    const segs = s.reg.autTop.querySelectorAll(".seg");
    assert(segs.length === 4, "slider renders all 4 rungs");
    const r0 = segs.find((x) => x.dataset.rung === "0");
    assert(/\brun\b/.test(r0._class) && /\bon\b/.test(r0._class), "rung 0 lit as 'run on' (neutral)");
    assert(/Running/.test(html), "rung 0 label = 'Running'");
    assert(!/\bpaused\b/.test(r0._class), "rung 0 not red/paused while running");
    const lvls = segs.filter((x) => x.dataset.rung !== "0");
    assert(lvls.every((x) => /\blvl\b/.test(x._class) && !/\bsoon\b/.test(x._class)), "rungs 1-3 are live level segs (no 'soon')");
    const r1 = segs.find((x) => x.dataset.rung === "1");
    assert(/\bwarn\b/.test(r1._class) && /\bon\b/.test(r1._class), "default level 'plan' (rung 1) lit in warn tone");
    assert(segs.filter((x) => /[123]/.test(x.dataset.rung) && /\bon\b/.test(x._class)).length === 1, "exactly one level rung lit");
    assert(s.reg.topbar.classList.contains("paused") === false, "topbar has no paused border");
    assert(s.reg.pausebar.classList.contains("show") === false, "pausebar hidden");
  }

  // --- Case 2: Paused render -------------------------------------------------
  {
    console.log("\nCase 2: wakes_enabled=false → Paused (red) + topbar border + micro-banner");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: false }, agents: [human], tasks: [], requests: [] });
    const r0 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "0");
    assert(/\bpaused\b/.test(r0._class) && /\bon\b/.test(r0._class), "rung 0 lit as 'paused on' (red)");
    assert(/Paused/.test(s.reg.autTop.innerHTML), "rung 0 label = 'Paused'");
    assert(s.reg.topbar.classList.contains("paused"), "topbar grows the red paused border");
    assert(s.reg.pausebar.classList.contains("show"), "paused micro-banner is shown");
  }

  // --- Case 3: pause click → confirm → POST + optimistic + reconcile ---------
  {
    console.log("\nCase 3: click Running → confirm → POST {enabled:false}, optimistic + reconcile");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true }, agents: [human], tasks: [], requests: [] });
    const r0 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "0");
    r0.onclick();   // opens the confirm modal (no POST yet)
    assert(s.fetchCalls.length === 0, "no POST before confirm");
    assert(/Pause autonomy\?/.test(s.reg.__ov.innerHTML), "confirm modal asks 'Pause autonomy?'");
    s.captured.modalHandlers.forEach((fn) => fn());   // click the primary "Pause all wakes"
    assert(s.ORCHA.container.wakes_enabled === false, "optimistic: state flips to paused immediately");
    assert(s.fetchCalls.length === 1, "exactly one POST fired");
    assert(/\/api\/containers\/c1\/wakes$/.test(s.fetchCalls[0].url), "POST hits the wakes route for this cid");
    assert(s.fetchCalls[0].body.enabled === false, "body.enabled === false");
    assert(s.fetchCalls[0].body.actor_agent_id === "h1", "body carries the acting human id");
    await tick();
    assert(s.ORCHA.container.wakes_enabled === false, "reconciled from response (still paused)");
  }

  // --- Case 4: resume click POSTs enabled:true -------------------------------
  {
    console.log("\nCase 4: click Paused → confirm Resume → POST {enabled:true}");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: false }, agents: [human], tasks: [], requests: [] });
    const r0 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "0");
    r0.onclick();
    assert(/Resume autonomy\?/.test(s.reg.__ov.innerHTML), "confirm modal asks 'Resume autonomy?'");
    s.captured.modalHandlers.forEach((fn) => fn());
    await tick();
    assert(s.fetchCalls.length === 1 && s.fetchCalls[0].body.enabled === true, "POST {enabled:true} fired");
    assert(s.ORCHA.container.wakes_enabled === true, "state reconciled to running");
  }

  // --- Case 5: failed POST reverts the optimistic state ----------------------
  {
    console.log("\nCase 5: POST failure reverts to the prior state");
    const s = makeSandbox({ failFetch: true });
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true }, agents: [human], tasks: [], requests: [] });
    const r0 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "0");
    r0.onclick();
    s.captured.modalHandlers.forEach((fn) => fn());
    assert(s.ORCHA.container.wakes_enabled === false, "optimistic flip applied");
    await tick();
    assert(s.ORCHA.container.wakes_enabled === true, "reverted to running after the POST failed");
  }

  // --- Case 6: read-only gate when no acting human ---------------------------
  {
    console.log("\nCase 6: no acting human → slider locked, click is a no-op (no POST)");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true }, agents: [], tasks: [], requests: [] });
    assert(s.reg.autTop.classList.contains("locked"), "slider marked read-only (locked)");
    const r0 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "0");
    r0.onclick();
    assert(s.fetchCalls.length === 0, "no POST without an acting human");
    assert(!s.reg.__ov, "no confirm modal opened");
  }

  // --- Case 7: click a different level → confirm → POST {level}, optimistic + reconcile ---
  {
    console.log("\nCase 7: click Build to PR → confirm → POST {level:'pr'}, optimistic + reconcile");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [human], tasks: [], requests: [] });
    const r2 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "2");
    r2.onclick();   // opens the confirm modal (no POST yet)
    assert(s.fetchCalls.length === 0, "no POST before confirm");
    assert(/Set autonomy to Build to PR\?/.test(s.reg.__ov.innerHTML), "confirm modal asks to set the level");
    s.captured.modalHandlers.forEach((fn) => fn());   // click the primary "Set Build to PR"
    assert(s.ORCHA.container.autonomy_level === "pr", "optimistic: level flips to 'pr' immediately");
    assert(s.fetchCalls.length === 1, "exactly one POST fired");
    assert(/\/api\/containers\/c1\/autonomy$/.test(s.fetchCalls[0].url), "POST hits the autonomy route for this cid");
    assert(s.fetchCalls[0].body.level === "pr", "body.level === 'pr'");
    assert(s.fetchCalls[0].body.actor_agent_id === "h1", "body carries the acting human id");
    await tick();
    assert(s.ORCHA.container.autonomy_level === "pr", "reconciled from response (level 'pr')");
    const r2b = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "2");
    assert(/\binfo\b/.test(r2b._class) && /\bon\b/.test(r2b._class), "rung 2 now lit in info tone");
  }

  // --- Case 8: poll reconcile — external flip repaints without a click -------
  {
    console.log("\nCase 8: a later snapshot (poll) repaints the switch");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true }, agents: [human], tasks: [], requests: [] });
    assert(/Running/.test(s.reg.autTop.innerHTML), "starts Running");
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: false }, agents: [human], tasks: [], requests: [] });
    assert(/Paused/.test(s.reg.autTop.innerHTML) && s.reg.pausebar.classList.contains("show"), "poll flip → repaints to Paused");
  }

  // --- Case 9: minimal topbar (no insertAdjacentElement) must not crash mount ---
  {
    console.log("\nCase 9: ensurePausebar feature-detects — a stub topbar never crashes shell mount");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: false }, agents: [human], tasks: [], requests: [] });
    // mirror the D0 harness: a topbar with no insertAdjacentElement method
    delete s.reg.topbar.insertAdjacentElement;
    let threw = null;
    try { s.Orcha.mountShell("home", { title: "Dashboard" }); } catch (e) { threw = e; }
    assert(threw === null, "mountShell does not throw when topbar lacks insertAdjacentElement");
  }

  // --- Case 10: setWakes choke point gates the pausebar Resume too -------------
  {
    console.log("\nCase 10: pausebar Resume is gated on an acting human (setWakes choke point)");
    const s = makeSandbox();
    // paused, but NO acting human registered
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: false }, agents: [], tasks: [], requests: [] });
    const rb = s.reg.resumeBtn;
    assert(typeof rb.onclick === "function", "resume button is wired");
    rb.onclick();
    assert(s.fetchCalls.length === 0, "Resume banner fires no POST without an acting human");
  }

  // --- Case 11: Full is a danger-confirm and POSTs {level:'full'} -------------
  {
    console.log("\nCase 11: click Full → danger confirm → POST {level:'full'}, lit accent");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "pr" }, agents: [human], tasks: [], requests: [] });
    const r3 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "3");
    r3.onclick();
    assert(/Set autonomy to Full\?/.test(s.reg.__ov.innerHTML), "confirm modal asks to set Full");
    assert(/without further gates/.test(s.reg.__ov.innerHTML), "Full impact line warns gates are removed");
    s.captured.modalHandlers.forEach((fn) => fn());
    await tick();
    assert(s.fetchCalls.length === 1 && s.fetchCalls[0].body.level === "full", "POST {level:'full'} fired");
    assert(s.ORCHA.container.autonomy_level === "full", "level reconciled to 'full'");
    const r3b = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "3");
    assert(/\baccent\b/.test(r3b._class) && /\bon\b/.test(r3b._class), "rung 3 (Full) lit in accent tone");
  }

  // --- Case 12: clicking the already-active level is a no-op -------------------
  {
    console.log("\nCase 12: clicking the current level → no modal, no POST");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "pr" }, agents: [human], tasks: [], requests: [] });
    const r2 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "2");
    r2.onclick();   // rung 2 IS the current level ('pr')
    assert(!s.reg.__ov, "no confirm modal when clicking the active level");
    assert(s.fetchCalls.length === 0, "no POST when clicking the active level");
  }

  // --- Case 13: failed autonomy POST reverts the optimistic level --------------
  {
    console.log("\nCase 13: autonomy POST failure reverts to the prior level");
    const s = makeSandbox({ failFetch: true });
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [human], tasks: [], requests: [] });
    const r3 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "3");
    r3.onclick();
    s.captured.modalHandlers.forEach((fn) => fn());
    assert(s.ORCHA.container.autonomy_level === "full", "optimistic flip to 'full' applied");
    await tick();
    assert(s.ORCHA.container.autonomy_level === "plan", "reverted to 'plan' after the POST failed");
  }

  // --- Case 14: level is orthogonal to pause — renders lit while paused --------
  {
    console.log("\nCase 14: paused + level set → level rung still lit (orthogonal fields)");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: false, autonomy_level: "pr" }, agents: [human], tasks: [], requests: [] });
    const r0 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "0");
    assert(/\bpaused\b/.test(r0._class), "rung 0 paused");
    const r2 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "2");
    assert(/\binfo\b/.test(r2._class) && /\bon\b/.test(r2._class), "level 'pr' still lit while paused (orthogonal)");
  }

  // --- Case 15: no acting human → level click is a no-op (no POST) -------------
  {
    console.log("\nCase 15: no acting human → clicking a level POSTs nothing");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [], tasks: [], requests: [] });
    const r3 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "3");
    r3.onclick();
    assert(s.fetchCalls.length === 0, "no POST without an acting human");
    assert(!s.reg.__ov, "no confirm modal without an acting human");
  }

  // --- Case 16: a later snapshot (poll) repaints the level --------------------
  {
    console.log("\nCase 16: external level change in a later snapshot repaints the active rung");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [human], tasks: [], requests: [] });
    let r1 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "1");
    assert(/\bon\b/.test(r1._class), "starts with 'plan' (rung 1) lit");
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "full" }, agents: [human], tasks: [], requests: [] });
    r1 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "1");
    const r3 = s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.rung === "3");
    assert(!/\bon\b/.test(r1._class), "poll: 'plan' no longer lit");
    assert(/\baccent\b/.test(r3._class) && /\bon\b/.test(r3._class), "poll: 'full' (rung 3) now lit");
  }

  console.log("\n" + (failures === 0 ? "ALL PASSED ✅" : failures + " FAILED ❌"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
