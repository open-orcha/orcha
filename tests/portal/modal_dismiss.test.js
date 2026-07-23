/* ============================================================================
   #31 — modal must NOT dismiss while selecting text. A click-drag that STARTS
   inside the modal and releases on the backdrop fires a click whose target is
   the overlay; the old handler (`if (e.target === ov) closeModal()`) treated
   that as an outside-click and dismissed mid-selection. The fix tracks the
   pointer-down target and only dismisses when the gesture BOTH began and ended
   on the overlay itself.

   Dependency-free: stubs a minimal DOM that CAPTURES addEventListener handlers,
   loads the REAL portal app.js in a vm sandbox, opens a modal via the actual
   wired path, then replays pointerdown→click gesture pairs against the overlay.
   No npm.

   Run:  node tests/portal/modal_dismiss.test.js
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

// ---- tiny fake DOM that captures event listeners ---------------------------
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", textContent: "", disabled: false, title: "",
    dataset: {}, onclick: null, _handlers: {},
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
    },
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: (ev, fn) => { (n._handlers[ev] = n._handlers[ev] || []).push(fn); },
    appendChild: () => {}, focus: () => {},
    contains: (other) => other === n,
    querySelector: () => null, querySelectorAll: () => [],
    fire: (ev, target) => (n._handlers[ev] || []).forEach((fn) => fn({ target, key: undefined })),
  };
  return n;
}

function makeSandbox() {
  const reg = {};
  ["__mc", "__mp"].forEach((id) => { reg[id] = makeNode(id); });
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
  const window = { matchMedia: () => ({ matches: false }) };
  const sandbox = {
    window, document, console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, reg };
}

function run() {
  console.log("modal_dismiss.test.js — #31 outside-click vs text-selection drag\n");

  // --- Case 1: drag that STARTS inside the modal, releases on backdrop -------
  {
    console.log("Case 1: select-drag starting inside the modal must NOT dismiss it");
    const s = makeSandbox();
    s.Orcha.modal({ title: "Pick text", body: "<p>selectable body</p>" });
    const ov = s.reg.__ov;
    assert(ov.classList.contains("show"), "modal is open");
    const insideNode = makeNode("inside");          // a node within the modal body
    ov.fire("pointerdown", insideNode);             // gesture begins INSIDE the modal
    ov.fire("click", ov);                            // mouseup/click lands on the backdrop
    assert(ov.classList.contains("show"), "modal STAYS open — selection drag is not a dismiss");
  }

  // --- Case 2: a genuine backdrop click still dismisses ----------------------
  {
    console.log("\nCase 2: a true backdrop click (down + up on overlay) dismisses");
    const s = makeSandbox();
    s.Orcha.modal({ title: "Confirm" });
    const ov = s.reg.__ov;
    assert(ov.classList.contains("show"), "modal is open");
    ov.fire("pointerdown", ov);                     // gesture begins ON the backdrop
    ov.fire("click", ov);                            // and ends on the backdrop
    assert(!ov.classList.contains("show"), "modal dismissed on a real outside-click");
  }

  // --- Case 3: click that originates on backdrop but ends inside -------------
  {
    console.log("\nCase 3: down on backdrop, up inside the modal must NOT dismiss");
    const s = makeSandbox();
    s.Orcha.modal({ title: "Reverse" });
    const ov = s.reg.__ov;
    const insideNode = makeNode("inside");
    ov.fire("pointerdown", ov);                     // begins on backdrop
    ov.fire("click", insideNode);                   // but the click target is inside the modal
    assert(ov.classList.contains("show"), "modal stays open — click target is not the overlay");
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

run();
