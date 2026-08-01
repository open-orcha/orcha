/* ============================================================================
   Mobile pairing portal wiring.

   PART A  fallback shell (app.js standalone): Pair phone control + modal entry.
   PART B  branded QR card + the expiry chip overflow fix, driven through the
           REAL modules/app-pairing.js: the server-styled code sits in a
           tokens-only card (orca mark + wordmark + scan caption + URL line),
           and the sentence-length expiry chip wraps inside its border.

   Dependency-free: loads the real sources in a small DOM harness.

   Run: node tests/portal/pairing_modal.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");
const APP_JS = path.join(STATIC, "app.js");
const SETTINGS_HTML = path.join(STATIC, "settings.html");
const SETTINGS_JS = path.join(STATIC, "settings.js");
const SRC = fs.readFileSync(APP_JS, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

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

/* ---------------- PART A — fallback shell (app.js standalone) ------------ */
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

function fallbackTests() {
  console.log("PART A — fallback shell (app.js standalone)\n");

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
}

/* ---------------- real-module harness ------------------------------------ */
function moduleSandbox(opts) {
  opts = opts || {};
  const reg = {};
  const fetches = [];
  const payload = Object.assign({
    v: 1, kind: "orcha-pair", baseUrl: "http://192.168.1.24:8001",
    containerId: "c1", containerName: "openorcha",
    humanAgentId: "h1", humanAgentAlias: "Kedar",
    token: "t", shortCode: "ABCD-1234", expiresAt: "2099-01-01T00:00:00Z",
    qrSvg: '<svg data-qr="1"></svg>',
  }, opts.payload || {});
  const document = {
    documentElement: { setAttribute() {}, getAttribute: () => null },
    body: makeNode("body"),
    addEventListener() {},
    createElement() {
      const el = makeNode("");
      Object.defineProperty(el, "id", {
        get() { return el._id || ""; },
        set(v) { el._id = v; reg[v] = el; },
      });
      return el;
    },
    // lazily materialize ids so the module's nested renders (pairBody,
    // pairCountText) land on inspectable nodes
    getElementById: (id) => reg[id] || (reg[id] = makeNode(id)),
  };
  const sandbox = {
    window: {}, document, console, encodeURIComponent, Date,
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    fetch: (url) => {
      fetches.push(String(url));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`
    var D = { container: { id: "c1", name: "openorcha" } };
    var __humans = ${JSON.stringify(opts.humans || [{ id: "h1", alias: "Kedar", kind: "human" }])};
    function humans() { return __humans; }
    function actingHuman() { return __humans[0] || null; }
    function aliasFor() { return null; }
    function esc(s) { return s == null ? "" : String(s); }
    function icon() { return "<svg></svg>"; }
    function orcaSVG() { return "<svg data-orca></svg>"; }
    function toast() {}
  `, sandbox);
  vm.runInContext(read("modules", "app-pairing.js"), sandbox, { filename: "app-pairing.js" });
  return { sandbox, reg, fetches };
}

/* ---------------- PART B — branded card + expiry chip overflow fix ------- */
async function brandAndOverflowTests() {
  console.log("\nPART B — branded QR card + expiry chip (overflow fix)\n");
  const s = moduleSandbox();
  vm.runInContext("openPairingModal()", s.sandbox);
  await flush(); await flush();
  const body = s.reg.pairBody._html;

  assert(/class="pair-card"/.test(body), "the QR sits inside the branded card");
  assert(/pair-wordmark">Orcha</.test(body) && /data-orca/.test(body),
    "…with the orca mark + Orcha wordmark");
  assert(/pair-scanline">Scan with the Orcha app</.test(body),
    "…and the scan caption inside the card");
  assert(/data-qr="1"/.test(body), "the server-styled QR SVG is embedded as-is");
  assert(/pair-url mono">http:\/\/192\.168\.1\.24:8001</.test(body),
    "the URL line is kept beneath the code");
  assert(/Kedar \(human\)/.test(body), "the 'Pairing as' line keeps the roster alias text");

  assert(/class="pill s-warn pair-expiry" id="pairCountdown"/.test(body),
    "the expiry chip carries the pair-expiry wrap class");
  assert(/<span id="pairCountText">/.test(body),
    "the countdown ticks into a span (the glyph survives re-ticks)");
  assert(/regenerates automatically/.test(s.reg.pairCountText.textContent),
    "the countdown text renders into the chip");

  const overlays = read("styles", "overlays.css");
  const expiry = (overlays.match(/\.pair-expiry \{[^}]*\}/) || [""])[0];
  assert(/white-space: normal/.test(expiry) && /max-width: 100%/.test(expiry),
    "overlays.css lets the sentence-length chip WRAP inside its border (.pill is nowrap)");
  assert(/\.pair-card \{/.test(overlays) && /\.pair-wordmark \{/.test(overlays)
    && /\.pair-scanline \{/.test(overlays), "the branded card is styled with tokens");

  // conversation.css loads AFTER overlays.css, so any pairing rules that the
  // #191 file-split left duplicated there would WIN. While that severed
  // fragment exists it must stay in lockstep with the card layout; once the
  // split repair removes it, the narrow-viewport rule lives in overlays.css.
  const conv = read("styles", "conversation.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const convMedia = (conv.match(/@media[^{]*\{[\s\S]*?\n\}/) || [""])[0];
  if (/\.pair-/.test(convMedia)) {
    assert(/\.pair-card \{ width: min\(296px/.test(convMedia),
      "conversation.css's severed pairing media fragment is in lockstep with the card");
    assert(!/\.pair-qr \{/.test(convMedia),
      "…and carries no stale .pair-qr sizing that would fight the card on mobile");
  }
  assert(/\.pair-card \{ width: min\(296px/.test(overlays + "\n" + conv),
    "the narrow-viewport card rule exists in the loaded sheets");
}

async function run() {
  console.log("pairing_modal.test.js\n");
  fallbackTests();
  await brandAndOverflowTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
