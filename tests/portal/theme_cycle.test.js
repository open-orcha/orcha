/* ============================================================================
   Regression test for GH #239 — "Theme change button requires double-click".

   Dependency-free: stubs window/document/localStorage/matchMedia, loads the REAL
   portal app.js in a vm sandbox, and asserts that a SINGLE cycleTheme() click always
   flips the *visible* appearance — even on a dark-preference OS, where "auto" renders
   identically to "dark" and the old auto→dark→light cycle wasted the first click.

   Run:  node tests/portal/theme_cycle.test.js
   (No package.json / npm install needed — uses only Node built-ins.)
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

// The appearance a given stored theme actually RENDERS as, given the OS preference.
// Mirrors styles.css: default palette is dark; [data-theme="auto"] only flips to
// light under @media (prefers-color-scheme: light).
function appearanceOf(stored, osPrefersLight) {
  if (stored === "light") return "light";
  if (stored === "dark") return "dark";
  return osPrefersLight ? "light" : "dark"; // "auto" / unset
}

// Build a fresh sandbox with the given OS preference and (optional) seeded theme.
function makeSandbox(osPrefersLight, seededTheme) {
  const store = {};
  if (seededTheme != null) store["orcha:theme"] = seededTheme;
  const htmlAttrs = {};
  let toasts = [];

  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  // Minimal DOM node — enough for toast()/syncThemeLabel() to run headless.
  function fakeNode() {
    return {
      id: "", className: "", textContent: "",
      classList: { add: () => {}, remove: () => {} },
      setAttribute: () => {}, getAttribute: () => null,
      appendChild: () => {},
    };
  }
  const documentElement = {
    setAttribute: (k, v) => { htmlAttrs[k] = v; },
    getAttribute: (k) => (k in htmlAttrs ? htmlAttrs[k] : null),
  };
  const document = {
    documentElement,
    body: fakeNode(),
    addEventListener: () => {},
    createElement: () => fakeNode(),
    getElementById: () => null, // no themeBtn / themeLabel in this headless harness
  };
  const window = {
    matchMedia: (q) => ({
      matches: /light/.test(q) ? !!osPrefersLight : !osPrefersLight,
      media: q,
    }),
  };
  const sandbox = {
    window, document, localStorage, console,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 0, clearTimeout: () => {},
  };
  sandbox.globalThis = sandbox;
  // app.js references `window`, `document`, `localStorage` as bare globals; expose them.
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  const Orcha = sandbox.window.Orcha;
  // Patch toast so cycleTheme doesn't blow up reaching into DOM-less internals.
  // (toast() resolves an overlay node via getElementById -> null; capture instead.)
  return {
    Orcha,
    store,
    htmlAttrs,
    appliedTheme: () => documentElement.getAttribute("data-theme"),
    osPrefersLight,
  };
}

function run() {
  console.log("theme_cycle.test.js — GH #239 single-click regression\n");

  // --- Case 1: dark-preference OS, unset/auto (the reported repro) -----------
  {
    console.log("Case 1: dark OS, default 'auto' — first click must be VISIBLE");
    const s = makeSandbox(/*osPrefersLight*/ false, null);
    // load-time effect (app.js L889): data-theme set from currentTheme() = 'auto'
    const before = appearanceOf(s.appliedTheme() || "auto", s.osPrefersLight);
    assert(before === "dark", "auto on a dark OS renders 'dark' before any click");
    s.Orcha.cycleTheme();
    const stored1 = s.store["orcha:theme"];
    const after = appearanceOf(stored1, s.osPrefersLight);
    assert(stored1 === "light", "one click stores explicit 'light' (was 'auto')");
    assert(s.appliedTheme() === "light", "one click applies data-theme='light'");
    assert(after !== before, "ONE click changed the VISIBLE theme (no double-click)");
  }

  // --- Case 2: second click flips back (clean binary toggle) ------------------
  {
    console.log("\nCase 2: dark OS — second click flips back to dark");
    const s = makeSandbox(false, "light");
    const before = appearanceOf("light", s.osPrefersLight);
    s.Orcha.cycleTheme();
    const after = appearanceOf(s.store["orcha:theme"], s.osPrefersLight);
    assert(s.store["orcha:theme"] === "dark", "click from 'light' stores 'dark'");
    assert(after !== before, "click flipped the visible theme again");
  }

  // --- Case 3: light-preference OS, unset/auto -------------------------------
  {
    console.log("\nCase 3: light OS, default 'auto' — first click must be VISIBLE");
    const s = makeSandbox(/*osPrefersLight*/ true, null);
    const before = appearanceOf("auto", s.osPrefersLight);
    assert(before === "light", "auto on a light OS renders 'light' before any click");
    s.Orcha.cycleTheme();
    const after = appearanceOf(s.store["orcha:theme"], s.osPrefersLight);
    assert(s.store["orcha:theme"] === "dark", "one click stores 'dark' on a light OS");
    assert(after !== before, "ONE click changed the visible theme on a light OS");
  }

  // --- Case 4: persistence round-trips ---------------------------------------
  {
    console.log("\nCase 4: choice persists to localStorage");
    const s = makeSandbox(false, null);
    s.Orcha.cycleTheme();
    const picked = s.store["orcha:theme"];
    assert(picked === "light" || picked === "dark", "explicit theme persisted: " + picked);
    assert(s.Orcha.currentTheme() === picked, "currentTheme() reads back the persisted pick");
  }

  console.log("\n" + (failures === 0
    ? "ALL PASSED ✅"
    : failures + " FAILED ❌"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
