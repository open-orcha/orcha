/* ============================================================================
   GH #207 (mig 034) — the "Enforce for all agents" lock chip beside the 3-level
   autonomy slider (#autTop). containers.autonomy_enforced:
     • unlit (default) — per-agent autonomy overrides APPLY;
     • lit "🔒 Enforced" — every override is IGNORED, the container level governs
       every agent. Clicking confirms → POST /autonomy with autonomy_enforced ONLY
       (F1: NO level — a lock flip must never re-assert a possibly-stale cached
       level, which could silently WIDEN the container).

   ROUND-1 FIX (F2): this suite now loads the LIVE topbar module the running portal
   actually executes — modules/app-state.js (defines the shared `D`) + then
   modules/app-autonomy.js (the enforce chip, setEnforce, onLevelClick). The prior
   revision loaded static/app.js, whose whole body sits behind `if (typeof D ===
   "undefined")` and is DEAD in the real portal (every page loads app-state.js first,
   which declares `const D`). So the earlier suite tested a copy no user runs, and F1
   lived precisely in the untested half. The externals app-autonomy.js reads from
   sibling modules (esc / actingHuman / modal / closeModal / toast / paintNotifications)
   are stubbed on the sandbox; the DOM + fetch are faked like autonomy_switch.test.js.

   Teeth pinned here (each BITES a specific mutation):
     • F1 — the enforce POST carries autonomy_enforced and NO level key (widen-proof).
     • F3 — an OVERRIDING roster surfaces a count on the chip + names it in the
             level-change modal.
     • the LEVEL count contract (exactly 3 data-level segs; the chip is not a 4th level).

   Run:  node tests/portal/autonomy_enforce.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MOD_DIR = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "modules"
);
const STATE_SRC = fs.readFileSync(path.join(MOD_DIR, "app-state.js"), "utf8");
const AUT_SRC = fs.readFileSync(path.join(MOD_DIR, "app-autonomy.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

// ---- tiny fake DOM (autonomy_switch harness + data-enforce awareness) ------
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
    _parseSegs: () => {
      if (n._segHtml !== n._html) {
        const segs = [];
        const re = /<span class="([^"]*)"\s+data-(notif|level|enforce)="([^"]*)"/g;
        let m;
        while ((m = re.exec(n._html))) {
          const seg = makeNode("");
          seg._class = m[1];
          seg.dataset = {}; seg.dataset[m[2]] = m[3];
          segs.push(seg);
        }
        n._segs = segs; n._segHtml = n._html;
      }
      return n._segs;
    },
    querySelector: (sel) => {
      if (!/seg/.test(sel)) return null;
      const segs = n._parseSegs();
      return segs.length ? segs[0] : null;
    },
    querySelectorAll: (sel) => {
      if (!/seg/.test(sel)) return [];
      return n._parseSegs();
    },
  };
  return n;
}

function makeSandbox(opts) {
  opts = opts || {};
  const reg = {};
  ["notifTop", "autTop", "topbar", "pausebar", "resumeBtn"].forEach((id) => { reg[id] = makeNode(id); });

  const document = {
    documentElement: { setAttribute: () => {}, getAttribute: () => null },
    body: makeNode("body"),
    addEventListener: () => {},
    createElement: () => makeNode(""),
    getElementById: (id) => (id in reg ? reg[id] : null),
    querySelectorAll: () => [],
  };
  const fetchCalls = [];

  // The simulated persisted container row (server truth), seeded from each applySnapshot so a
  // partial-update POST echoes the REAL current values for the columns it did not touch.
  const srv = { autonomy_level: "plan", autonomy_enforced: false };

  // The last confirm modal cfg the code opened — the harness "clicks" primary by calling onPrimary.
  const modalState = { last: null };

  const sandbox = {
    document, console,
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    requestAnimationFrame: (fn) => fn(),
    // --- externals app-autonomy.js reads from sibling modules (stubbed) ---
    esc: (s) => (s == null ? "" : String(s)),
    actingHuman: () => (sandbox.__acting || null),
    modal: (cfg) => { modalState.last = cfg; },
    closeModal: () => {},
    toast: () => {},
    paintNotifications: () => {},
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, body });
      if (opts.failFetch) return Promise.reject(new Error("network"));
      // Faithful partial-update echo: the server persists ONLY the supplied fields and RETURNS the
      // real current row for both columns (so a level-only write returns the unchanged enforced
      // flag, and an enforce-only write returns the unchanged level — never a client-cached value).
      if (/\/autonomy$/.test(url)) {
        if (body.level !== undefined) srv.autonomy_level = body.level;
        if (body.autonomy_enforced !== undefined) srv.autonomy_enforced = body.autonomy_enforced;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(
          { container_id: "c1", autonomy_level: srv.autonomy_level, autonomy_enforced: srv.autonomy_enforced }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ container_id: "c1", wakes_enabled: body.enabled }) });
    },
  };
  sandbox.window.ORCHA = { container: null, agents: [], tasks: [], requests: [] };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Load order MUST mirror the real page: app-state.js (declares `const D`) then app-autonomy.js.
  vm.runInContext(STATE_SRC, sandbox, { filename: "app-state.js" });
  vm.runInContext(AUT_SRC, sandbox, { filename: "app-autonomy.js" });
  return { sandbox, reg, fetchCalls, modalState, srv,
           applySnapshot: (fresh, acting) => {
             sandbox.__acting = acting || null;
             // Seed the simulated server row from the snapshot's container (the source of truth a
             // real poll reflects), so a subsequent partial POST echoes the untouched column faithfully.
             if (fresh && fresh.container) {
               srv.autonomy_level = fresh.container.autonomy_level != null ? fresh.container.autonomy_level : "plan";
               srv.autonomy_enforced = !!fresh.container.autonomy_enforced;
             }
             sandbox.applySnapshot(fresh);
           },
           ORCHA: sandbox.window.ORCHA };
}

const tick = () => new Promise((r) => setImmediate(r));
const enforceSeg = (s) => s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.enforce);
const levelSegs = (s) => s.reg.autTop.querySelectorAll(".seg").filter((x) => x.dataset.level);
const human = { id: "h1", alias: "Op", kind: "human" };
const confirm = (s) => { if (s.modalState.last && s.modalState.last.onPrimary) s.modalState.last.onPrimary(); };

async function run() {
  console.log("autonomy_enforce.test.js — GH #207 enforce chip on the LIVE module (modules/app-autonomy.js)\n");

  // --- Case 1: default render — chip present, unlit; 3 levels untouched ------
  {
    console.log("Case 1: default snapshot → enforce chip rendered UNLIT beside exactly 3 level segs");
    const s = makeSandbox();
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [human] }, human);
    const chip = enforceSeg(s);
    assert(!!chip, "the enforce chip renders in the LIVE autonomy host");
    assert(/\block\b/.test(chip._class), "chip carries the .lock class (not .lvl)");
    assert(!/\bon\b/.test(chip._class), "chip is unlit by default (mig-034 default: not enforced)");
    assert(levelSegs(s).length === 3, "still exactly 3 data-level segs (the chip is NOT a 4th level)");
  }

  // --- Case 2: enforced snapshot → chip lit with the lock glyph --------------
  {
    console.log("\nCase 2: autonomy_enforced=true in the snapshot → chip lit '🔒 Enforced'");
    const s = makeSandbox();
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "pr", autonomy_enforced: true }, agents: [human] }, human);
    const chip = enforceSeg(s);
    assert(/\bon\b/.test(chip._class), "chip lit while enforced");
    assert(/🔒/.test(s.reg.autTop.innerHTML), "lock glyph shown while enforced");
  }

  // --- Case 3 (F1 TOOTH): click Enforce → POST enforced:true and NO level ----
  {
    console.log("\nCase 3 (F1): click Enforce (off) → POST carries autonomy_enforced:true and OMITS level (widen-proof)");
    const s = makeSandbox();
    // Stale cache in the PERMISSIVE direction: this browser cached 'full', but ANOTHER operator has
    // since narrowed the real container to 'plan' (the server truth). A lock flip must NOT re-assert
    // the cached 'full' — that would silently WIDEN the container, the exact F1 defect.
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "full" }, agents: [human] }, human);
    s.srv.autonomy_level = "plan";   // the REAL container row moved under this tab
    enforceSeg(s).onclick();
    assert(s.fetchCalls.length === 0, "no POST before confirm");
    confirm(s);
    assert(s.ORCHA.container.autonomy_enforced === true, "optimistic: switch flips on immediately");
    assert(s.fetchCalls.length === 1, "exactly one POST fired");
    assert(/\/api\/containers\/c1\/autonomy$/.test(s.fetchCalls[0].url), "POST hits the /autonomy route");
    assert(s.fetchCalls[0].body.autonomy_enforced === true, "body.autonomy_enforced === true");
    assert(!("level" in s.fetchCalls[0].body), "F1: body OMITS level (a lock flip never re-asserts a cached level → cannot widen)");
    assert(s.fetchCalls[0].body.actor_agent_id === "h1", "body carries the acting human id");
    await tick();
    assert(s.ORCHA.container.autonomy_enforced === true, "reconciled from response (still enforced)");
    assert(s.ORCHA.container.autonomy_level === "plan", "F1: the container stays at the SERVER's 'plan' — the flip did NOT widen it back to the stale cached 'full'");
  }

  // --- Case 4: click (on) → confirm → POST {enforced:false}, no level --------
  {
    console.log("\nCase 4: click Enforced (on) → POST {autonomy_enforced:false} (no level) re-honors overrides");
    const s = makeSandbox();
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan", autonomy_enforced: true }, agents: [human] }, human);
    enforceSeg(s).onclick();
    confirm(s);
    await tick();
    assert(s.fetchCalls.length === 1 && s.fetchCalls[0].body.autonomy_enforced === false, "POST {autonomy_enforced:false} fired");
    assert(!("level" in s.fetchCalls[0].body), "F1: OFF flip also omits level");
    assert(s.ORCHA.container.autonomy_enforced === false, "switch reconciled off");
  }

  // --- Case 5: failed POST reverts the optimistic flip -----------------------
  {
    console.log("\nCase 5: enforce POST failure reverts the optimistic flip");
    const s = makeSandbox({ failFetch: true });
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [human] }, human);
    enforceSeg(s).onclick();
    confirm(s);
    assert(s.ORCHA.container.autonomy_enforced === true, "optimistic flip applied");
    await tick();
    assert(s.ORCHA.container.autonomy_enforced === false, "reverted after the POST failed");
  }

  // --- Case 6: no acting human → click is a no-op ----------------------------
  {
    console.log("\nCase 6: no acting human → clicking the chip POSTs nothing, opens nothing");
    const s = makeSandbox();
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [] }, null);
    enforceSeg(s).onclick();
    assert(s.fetchCalls.length === 0, "no POST without an acting human");
    assert(!s.modalState.last, "no confirm modal without an acting human");
  }

  // --- Case 7: poll reconcile — an external flip repaints the chip -----------
  {
    console.log("\nCase 7: a later snapshot (poll) repaints the enforce chip");
    const s = makeSandbox();
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [human] }, human);
    assert(!/\bon\b/.test(enforceSeg(s)._class), "starts unlit");
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan", autonomy_enforced: true }, agents: [human] }, human);
    assert(/\bon\b/.test(enforceSeg(s)._class), "poll flip → chip lit");
  }

  // --- Case 8: enforce is orthogonal to the level click path ------------------
  {
    console.log("\nCase 8: setting a LEVEL never flips the enforce switch (orthogonal fields)");
    const s = makeSandbox();
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan", autonomy_enforced: true }, agents: [human] }, human);
    const pr = levelSegs(s).find((x) => x.dataset.level === "pr");
    pr.onclick();
    confirm(s);
    await tick();
    assert(s.ORCHA.container.autonomy_level === "pr", "level moved to 'pr'");
    assert(s.fetchCalls.length === 1 && s.fetchCalls[0].body.autonomy_enforced === undefined, "level POST omits autonomy_enforced (partial update)");
    assert(s.ORCHA.container.autonomy_enforced === true, "enforce switch untouched by a level change");
  }

  // --- Case 9 (F3 TOOTH): overriding agents surface a count on the chip ------
  {
    console.log("\nCase 9 (F3): agents with a per-agent override surface a count on the Enforce chip");
    const s = makeSandbox();
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" },
                      agents: [human,
                               { id: "a1", alias: "ovr1", kind: "ai", autonomy_override: "full" },
                               { id: "a2", alias: "ovr2", kind: "ai", autonomy_override: "pr" },
                               { id: "a3", alias: "plain", kind: "ai", autonomy_override: null }] }, human);
    const chip = enforceSeg(s);
    assert(/2 overriding/.test(s.reg.autTop.innerHTML), "chip labels the count of overriding agents ('Enforce · 2 overriding')");
    assert(/\bhas-ovr\b/.test(chip._class), "chip carries the has-ovr marker class when overrides exist");
    // and when enforced, the count is suppressed (overrides are moot)
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan", autonomy_enforced: true },
                      agents: [human, { id: "a1", alias: "ovr1", kind: "ai", autonomy_override: "full" }] }, human);
    assert(!/overriding/.test(s.reg.autTop.innerHTML), "no count while enforced (overrides ignored)");
  }

  // --- Case 10 (F3 TOOTH): the level-change modal NAMES the overriding agents -
  {
    console.log("\nCase 10 (F3): narrowing the slider names the agents that will IGNORE the new level");
    const s = makeSandbox();
    s.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "full" },
                      agents: [human, { id: "a1", alias: "risky", kind: "ai", autonomy_override: "full" }] }, human);
    const planSeg = levelSegs(s).find((x) => x.dataset.level === "plan");
    planSeg.onclick();
    assert(s.modalState.last && /risky/.test(s.modalState.last.desc), "the confirm modal names the overriding agent by alias");
    assert(/ignore/i.test(s.modalState.last.desc), "the modal warns the override will IGNORE the new level");
  }

  console.log("\n" + (failures === 0 ? "ALL PASSED ✅" : failures + " FAILED ❌"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
