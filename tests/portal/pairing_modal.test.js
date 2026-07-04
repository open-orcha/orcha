/* ============================================================================
   Mobile pairing portal wiring.

   Dependency-free: loads the real app.js in a small DOM harness and verifies the
   shared shell exposes the Pair phone control and modal entry point.

   Run: node tests/portal/pairing_modal.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "app.js"
);
const SETTINGS_HTML = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "settings.html"
);
const SETTINGS_JS = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "settings.js"
);
const SRC = fs.readFileSync(APP_JS, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", _listeners: {}, _children: {},
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    textContent: "",
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
      toggle: (c, on) => { const s = n.classList._set(); if (on) s.add(c); else s.delete(c); n._class = [...s].join(" "); },
    },
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: (ev, fn) => { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    appendChild: () => {}, insertAdjacentElement: () => {}, focus: () => {}, blur: () => {},
    contains: () => false, querySelector: (sel) => n._children[sel] || null, querySelectorAll: () => [],
  };
  return n;
}

function makeSandbox() {
  const reg = {};
  ["sidebar", "topbar", "autTop", "attnPill", "themeBtn"].forEach((id) => { reg[id] = makeNode(id); });
  reg.attnPill._children[".n"] = makeNode("");

  const document = {
    documentElement: { setAttribute() {}, getAttribute() { return null; } },
    body: makeNode("body"),
    activeElement: null,
    addEventListener() {},
    createElement() {
      const el = makeNode("");
      Object.defineProperty(el, "id", {
        get() { return el._id || ""; },
        set(v) { el._id = v; reg[v] = el; },
      });
      return el;
    },
    getElementById(id) { return reg[id] || null; },
    querySelectorAll() { return []; },
  };
  const sandbox = {
    window: { matchMedia: () => ({ matches: false }) },
    document,
    localStorage: { getItem: () => null, setItem() {} },
    console,
    requestAnimationFrame: (fn) => fn(),
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({
      v: 1, kind: "orcha-pair", baseUrl: "http://192.168.1.24:8001",
      containerId: "c1", containerName: "openorcha", humanAgentId: "h1", humanAgentAlias: "Kedar",
      token: "t", shortCode: "ABCD-1234", expiresAt: "2099-01-01T00:00:00Z", qrSvg: "<svg></svg>",
    }) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, reg };
}

function run() {
  console.log("pairing_modal.test.js\n");

  const s = makeSandbox();
  s.Orcha.applySnapshot({
    container: { id: "c1", name: "openorcha", wakes_enabled: true },
    agents: [{ id: "h1", alias: "Kedar", kind: "human" }],
    tasks: [], requests: [],
  });
  s.Orcha.mountShell("home", { title: "Dashboard" });

  assert(/id="pairPhoneBtn"/.test(s.reg.topbar.innerHTML), "topbar includes the Pair phone button");
  assert(/Pair phone/.test(s.reg.topbar.innerHTML), "button text is visible");
  assert(typeof s.Orcha.openPairingModal === "function", "openPairingModal is exported for Settings");

  s.Orcha.openPairingModal();
  assert(s.reg.__ov && s.reg.__ov.classList.contains("show"), "pairing modal opens on the shared overlay");
  assert(/Pair your phone/.test(s.reg.__ov.innerHTML), "modal title is rendered");
  assert(/same Wi-Fi network/.test(s.reg.__ov.innerHTML), "modal includes the Wi-Fi scan copy");
  assert(/Preparing pairing code/.test(s.reg.__ov.innerHTML), "modal starts in a loading state before the QR payload arrives");

  const settingsHtml = fs.readFileSync(SETTINGS_HTML, "utf8");
  const settingsJs = fs.readFileSync(SETTINGS_JS, "utf8");
  assert(/id="pairingCard"/.test(settingsHtml), "Settings page has a phone pairing card host");
  assert(/settingsPairPhone/.test(settingsJs) && /openPairingModal/.test(settingsJs), "Settings card opens the same pairing modal");

  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
