/* ============================================================================
   #367 — home-screen human-gate cards must respect the engine autonomy LEVEL.

   attnItems() is the SINGLE authority that feeds the home dashboard action queue,
   the "Needs you" widget, AND the notification-center NEEDS-YOU rows. This test
   loads the REAL portal app.js in a vm sandbox and drives attnItems() across the
   three autonomy levels, asserting the #367 contract:

     • plan  (Plan-only)   → Plan card shown; Verify card shown.
     • pr    (Build-to-PR) → NO Plan card; Verify card shown.
     • full  (Full)        → NO Plan card; NO Verify card.
     • escalations are an explicit agent→human blocker — never suppressed by level.

   Regression guard for the two #367 bugs: Full no longer surfaces an approval
   card, and a completed-PR handoff (in_progress + agent note at pr/full) can never
   be mislabeled as a "Proposed plan" card.

   Dependency-free: minimal DOM + fetch stub, no npm install.
   Run:  node tests/portal/autonomy_cards.test.js
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

// ---- minimal fake DOM ------------------------------------------------------
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", dataset: {},
    get className() { return n._class; }, set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; }, set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
    setAttribute: () => {}, getAttribute: () => null, addEventListener: () => {},
    insertAdjacentElement: () => {}, appendChild: () => {}, focus: () => {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  return n;
}

function makeSandbox() {
  const reg = {};
  const document = {
    documentElement: { setAttribute: () => {}, getAttribute: () => null },
    body: makeNode("body"),
    addEventListener: () => {},
    createElement: () => makeNode(""),
    getElementById: (id) => (id in reg ? reg[id] : null),
    querySelectorAll: () => [],
  };
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; },
  };
  const window = { matchMedia: () => ({ matches: false }) };
  const sandbox = {
    window, document, localStorage, console,
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, ORCHA: sandbox.window.ORCHA, reg };
}

const human = { id: "h1", alias: "Kedar", kind: "human" };

// A task whose agent has posted an opening note and which carries no plan decision.
// Under the OLD rule this rendered a plan card at ANY level; under #367 it is a plan
// card ONLY at level 'plan'. At pr/full this represents a completed-PR handoff that
// must NOT be mislabeled as a plan.
function pendingTask() {
  return { id: "tp", title: "wire the slider", status: "in_progress", assignee: "Glass",
    plan_message: { body: "PR #360 is open and ready for merge", author_alias: "Glass", at: "2026-06-16T10:00:00Z" },
    plan_decision: null, started_at: "2026-06-16T09:00:00Z" };
}
function verifyTask() {
  return { id: "tv", title: "#367 cards", status: "needs_verification", assignee: "Glass",
    started_at: "2026-06-16T08:00:00Z" };
}
function escalationReq() {
  return { id: "re", type: "info", status: "open", target_id: null, from: "Lens",
    payload: "need a human decision", created_at: "2026-06-16T07:00:00Z" };
}

function snapshotAt(level) {
  const c = { id: "c1", wakes_enabled: true };
  if (level) c.autonomy_level = level;
  return { container: c, agents: [human], tasks: [pendingTask(), verifyTask()], requests: [escalationReq()] };
}

async function run() {
  console.log("autonomy_cards.test.js — #367\n");

  // --- Case 1: plan-only → plan card + verify card ---------------------------
  {
    console.log("Case 1: autonomy_level='plan' → Plan card AND Verify card");
    const s = makeSandbox();
    s.Orcha.applySnapshot(snapshotAt("plan"));
    const a = s.Orcha.attnItems();
    assert(a.plans.length === 1 && a.plans[0].id === "tp", "plan card shown at Plan-only");
    assert(a.verifs.length === 1 && a.verifs[0].id === "tv", "verify card shown at Plan-only");
    assert(a.escs.length === 1, "escalation shown at Plan-only");
    assert(a.count === 3, "count = 3 (plan + verify + escalation)");
  }

  // --- Case 2: build-to-PR → NO plan card, verify card stays -----------------
  {
    console.log("\nCase 2: autonomy_level='pr' → NO plan card; Verify card shown");
    const s = makeSandbox();
    s.Orcha.applySnapshot(snapshotAt("pr"));
    const a = s.Orcha.attnItems();
    assert(a.plans.length === 0, "BUG #2 GUARD: completed-PR handoff is NOT a plan card at pr");
    assert(a.verifs.length === 1 && a.verifs[0].id === "tv", "verify card shown at Build-to-PR");
    assert(a.escs.length === 1, "escalation still shown at pr");
    assert(a.count === 2, "count = 2 (verify + escalation)");
  }

  // --- Case 3: full → NO plan card, NO verify card ---------------------------
  {
    console.log("\nCase 3: autonomy_level='full' → NO plan card, NO verify card");
    const s = makeSandbox();
    s.Orcha.applySnapshot(snapshotAt("full"));
    const a = s.Orcha.attnItems();
    assert(a.plans.length === 0, "BUG #1 GUARD: Full suppresses the plan card");
    assert(a.verifs.length === 0, "Full suppresses the verify card (defensive even if a task reaches needs_verification)");
    assert(a.escs.length === 1, "escalation NEVER suppressed — a blocked agent at Full still needs a human");
    assert(a.count === 1, "count = 1 (escalation only)");
  }

  // --- Case 4: missing autonomy_level degrades to the migration default 'plan' -
  {
    console.log("\nCase 4: snapshot omits autonomy_level → degrades to 'plan' (cards shown)");
    const s = makeSandbox();
    s.Orcha.applySnapshot(snapshotAt(null));
    const a = s.Orcha.attnItems();
    assert(a.plans.length === 1, "pre-#298 snapshot (no level) defaults to Plan-only → plan card shown");
    assert(a.verifs.length === 1, "verify card shown under default 'plan'");
    assert(a.count === 3, "count = 3 under the safe default");
  }

  console.log(failures ? `\n✗ ${failures} assertion(s) failed` : "\n✓ all assertions passed");
  if (failures) process.exit(1);
}

run();
