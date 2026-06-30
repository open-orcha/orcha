/* ============================================================================
   GH #74 — the task-thread panel stayed stuck on "Loading thread…" forever for
   any task with a populated SPEC-4 protocol panel.

   Root cause: inputActiveWithin() — the guard that makes patch() defer a 3s
   background repaint so it can't wipe text a human is mid-typing — used a
   "value is non-empty" test. The protocol editor renders the task's SAVED
   protocol straight into <textarea>s, so a populated-but-untouched panel made
   the guard return true forever; every non-forced renderDetail() (the lazy
   thread load + the 3s poll) was deferred and the freshly-fetched thread never
   painted. The fix compares against defaultValue (the rendered value), so a
   field only counts as "active" once the human actually edits it.

   This test loads the REAL portal app.js in a vm sandbox (no npm install) and
   exercises the exported inputActiveWithin() + patch() directly.

   Run:  node tests/portal/thread_repaint_guard.test.js
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

// ---- minimal DOM tailored to inputActiveWithin() + patch() -----------------
function ctrl(tag, value, def, type) {
  return { tagName: tag, type: type || (tag === "TEXTAREA" ? "textarea" : "text"),
           value: value, defaultValue: def === undefined ? value : def };
}
// a fake pane element. `controls` is what querySelectorAll("input, textarea") returns.
function makePane(controls) {
  const el = {
    _html: "", __patchHtml: undefined,
    scrollHeight: 0, clientHeight: 0, scrollTop: 0,
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = v == null ? "" : String(v); },
    contains: (node) => controls.indexOf(node) >= 0,
    querySelectorAll: (sel) => {
      if (/input|textarea/.test(sel) && !/scrollkey/.test(sel)) return controls.slice();
      return [];   // [id],[data-scrollkey] scroll-capture pass → none
    },
  };
  return el;
}

function makeSandbox() {
  const documentObj = {
    activeElement: null,
    documentElement: { setAttribute() {}, getAttribute() { return null; } },
    body: { id: "body", className: "", addEventListener() {}, querySelectorAll: () => [] },
    addEventListener() {},
    createElement() { return { setAttribute() {}, addEventListener() {}, style: {} }; },
    getElementById() { return null; },
    querySelectorAll() { return []; },
  };
  // NB: window has no getSelection → selectionWithin() short-circuits to false,
  // isolating this test to the input/dirty guard.
  const window = { matchMedia: () => ({ matches: false }) };
  const sandbox = {
    window, document: documentObj, console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout() {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { O: sandbox.window.Orcha, document: documentObj };
}

function run() {
  console.log("thread_repaint_guard.test.js — GH #74\n");
  const { O, document } = makeSandbox();
  assert(typeof O.inputActiveWithin === "function", "Orcha.inputActiveWithin is exported");
  assert(typeof O.patch === "function", "Orcha.patch is exported");

  console.log("\ninputActiveWithin() — the dirty/focus guard:");

  // The actual GH#74 shape: protocol editor pre-filled, untouched, nothing focused.
  const protoPane = makePane([
    ctrl("TEXTAREA", "HomebrewAgent -> human", "HomebrewAgent -> human"),
    ctrl("TEXTAREA", "kedar", "kedar"),
    ctrl("TEXTAREA", "Autonomous up to the human", "Autonomous up to the human"),
    ctrl("INPUT", "", "", "text"),   // empty reply composer
  ]);
  document.activeElement = null;
  assert(O.inputActiveWithin(protoPane) === false,
    "pre-filled but UNTOUCHED protocol fields (value===defaultValue) do NOT block the repaint");

  // ISS-53 must still hold: a field the human edited away from its rendered value blocks.
  const dirtyField = ctrl("TEXTAREA", "I typed this reason", "");
  const dirtyPane = makePane([dirtyField]);
  document.activeElement = null;   // typed, then blurred
  assert(O.inputActiveWithin(dirtyPane) === true,
    "a DIRTY field (value!==defaultValue) blocks the repaint even when blurred (ISS-53 preserved)");

  // A focused field always blocks (mid-typing), even if not yet dirty.
  const focused = ctrl("INPUT", "x", "x", "text");
  const focusedPane = makePane([focused]);
  document.activeElement = focused;
  assert(O.inputActiveWithin(focusedPane) === true,
    "a FOCUSED field blocks the repaint even when value===defaultValue");

  // Empty, untouched, unfocused composer → no block.
  const emptyPane = makePane([ctrl("INPUT", "", "", "text")]);
  document.activeElement = null;
  assert(O.inputActiveWithin(emptyPane) === false,
    "an empty untouched composer does not block the repaint");

  console.log("\npatch() — end-to-end GH#74 scenario (non-forced repaint):");

  // With pre-filled-untouched protocol fields, a NON-forced patch must APPLY
  // (this is the thread-load / 3s-poll path that was frozen).
  {
    const pane = makePane([ctrl("TEXTAREA", "saved protocol", "saved protocol")]);
    document.activeElement = null;
    pane.innerHTML = '<div class="none">Loading thread…</div>';
    pane.__patchHtml = pane.innerHTML;
    const applied = O.patch(pane, '<div class="thread"><div class="msg">hi</div></div>', false);
    assert(applied === true, "non-forced patch APPLIES over a pre-filled-untouched protocol panel");
    assert(/class="msg"/.test(pane.innerHTML), "the thread markup actually reached the DOM (no longer stuck on Loading)");
  }

  // With a dirty field, a NON-forced patch must DEFER (anti-clobber intact).
  {
    const pane = makePane([ctrl("TEXTAREA", "half-typed reply", "")]);
    document.activeElement = null;
    pane.innerHTML = "OLD";
    pane.__patchHtml = "OLD";
    const applied = O.patch(pane, "NEW", false);
    assert(applied === false, "non-forced patch DEFERS while a dirty field holds unsaved text");
    assert(pane.innerHTML === "OLD", "the dirty field's surrounding DOM was not clobbered");
    // …but an explicit user navigation (force) still applies.
    const forced = O.patch(pane, "NEW", true);
    assert(forced === true && pane.innerHTML === "NEW", "a FORCED patch still applies past the dirty guard");
  }

  console.log("");
  if (failures) { console.error(failures + " assertion(s) FAILED"); process.exit(1); }
  console.log("all assertions passed");
}

run();
