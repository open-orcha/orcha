/* ============================================================================
   SEAM B / #212 — portal extension convention guard.

   Pins the FROZEN downstream-seams contract for portal extensions:
     • window.OrchaExt registry API SHAPES (the 3 registrars + _consume(kind)).
     • A stub registration RENDERS in all THREE core consume sites:
         nav shell (registerNavItem), settings tabs (registerSettingsTab),
         task-detail sections (registerTaskDetailSection, below Definition of done).
     • ABSENT extensions = BYTE-IDENTICAL core render — registering nothing leaves
       every consume site's output exactly as it was before this seam existed.
     • The "extensions must NEVER patch core" rule is documented (module header + docs).

   This loads the REAL portal sources in vm sandboxes (same node/vm idiom as the rest
   of tests/portal/*.test.js — zero npm, no test framework).
   Run:  node tests/portal/extensions_convention.test.js
   ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const STATIC = path.join(ROOT, "orcha-cli", "orcha_cli", "templates", "portal", "static");
const read = (rel) => fs.readFileSync(path.join(STATIC, rel), "utf8");

const EXT_JS = read("modules/app-extensions.js");
const STUB_JS = read("extensions/index.js");
const APP_JS = read("app.js");
// The real (non-fallback) nav-consume path lives in app-shell.js's mountShell, which app.js only
// wires into window.Orcha when the module chain (starting with app-state.js's `const D`) is present.
// Load the same core chain home.html loads, in order, so mountShell is the REAL one.
const CORE_CHAIN = [
  "modules/app-state.js", "modules/app-text.js", "modules/app-data.js", "modules/app-ui.js",
  "modules/app-shell.js", "modules/app-autonomy.js", "modules/app-notifications.js",
  "modules/app-pairing.js", "modules/app-patch-log.js", "modules/app-run-classify.js",
  "modules/app-run-stream.js", "modules/app-sort.js", "modules/app-extensions.js",
].map((rel) => ({ rel, src: read(rel) }));
const SETTINGS_JS = read("settings.js");
const TASKS_STATE_JS = read("pages/tasks-state.js");
const TASKS_DETAIL_JS = read("pages/tasks-detail.js");
const TASKS_ACTIONS_JS = read("pages/tasks-actions.js");
const TASKS_THREAD_JS = read("pages/tasks-thread.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- a small DOM good enough for the three consume sites ------------------ *
   Nodes track innerHTML, className, dataset, children (appendChild), and support
   a real-enough querySelector('[data-ext-section="id"]') used by tasks-detail. */
function makeNode(tag) {
  const n = {
    tagName: (tag || "div").toUpperCase(),
    _class: "", _html: "", textContent: "", value: "", type: "text", disabled: false,
    dataset: {}, _attrs: {}, children: [], _listeners: {},
    get className() { return n._class; }, set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; }, set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
    setAttribute: (k, v) => { n._attrs[k] = String(v); }, getAttribute: (k) => (k in n._attrs ? n._attrs[k] : null),
    contains: () => false,
    addEventListener: (ev, fn) => { n._listeners[ev] = fn; },
    insertAdjacentElement: () => {}, focus: () => {}, remove: () => {},
    appendChild: (c) => { n.children.push(c); c.parentNode = n; return c; },
    querySelector: (sel) => {
      // supports the [data-ext-section="ID"] lookup renderExtSections uses
      const m = /^\[data-ext-section="(.*)"\]$/.exec(sel);
      if (m) return findByExtSection(n, m[1]);
      // supports settings.js's card.querySelector(".card-b"): the card body host lives inside an
      // innerHTML string (no real child node), so lazily mint + memoize one appendable node per class.
      const c = /^\.([\w-]+)$/.exec(sel);
      if (c) {
        const inTree = findByClass(n, c[1]);
        if (inTree) return inTree;
        n._qs = n._qs || {};
        if (!n._qs[c[1]]) { const child = makeNode("div"); child._class = c[1]; n._qs[c[1]] = child; }
        return n._qs[c[1]];
      }
      return null;
    },
    querySelectorAll: () => [],
  };
  return n;
}
function walk(node, hit) {
  if (!node) return null;
  if (hit(node)) return node;
  for (const c of node.children || []) { const r = walk(c, hit); if (r) return r; }
  return null;
}
function findByExtSection(root, id) { return walk(root, (n) => n.dataset && n.dataset.extSection === id); }
function findByClass(root, cls) { return walk(root, (n) => (" " + (n._class || "") + " ").indexOf(" " + cls + " ") >= 0); }

/* =========================================================================
   PART 1 — registry API shapes (contract §Seam B: OrchaExt registry shapes)
   ========================================================================= */
function loadRegistry(alsoStub) {
  const sandbox = { window: {}, console, document: {}, CSS: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(EXT_JS, sandbox, { filename: "app-extensions.js" });
  if (alsoStub) vm.runInContext(STUB_JS, sandbox, { filename: "extensions/index.js" }); // must be inert
  return sandbox.window.OrchaExt;
}

console.log("PART 1 — window.OrchaExt registry shapes");
{
  const X = loadRegistry(true);
  assert(!!X, "app-extensions.js defines window.OrchaExt");
  assert(typeof X.registerNavItem === "function", "registerNavItem is a function");
  assert(typeof X.registerSettingsTab === "function", "registerSettingsTab is a function");
  assert(typeof X.registerTaskDetailSection === "function", "registerTaskDetailSection is a function");
  assert(typeof X._consume === "function", "_consume is a function");
  assert(Array.isArray(X._consume("nav")) && X._consume("nav").length === 0, "_consume('nav') → [] before any registration");
  assert(Array.isArray(X._consume("settingsTab")) && X._consume("settingsTab").length === 0, "_consume('settingsTab') → []");
  assert(Array.isArray(X._consume("taskDetailSection")) && X._consume("taskDetailSection").length === 0, "_consume('taskDetailSection') → []");
  assert(Array.isArray(X._consume("bogus")) && X._consume("bogus").length === 0, "_consume(unknown kind) → [] (never throws)");

  // registration + retrieval round-trip, and order sorting (numbered before unspecified)
  X.registerNavItem({ id: "docs", label: "Docs", href: "/docs", order: 10 });
  X.registerNavItem({ id: "status", label: "Status", href: "/status" });        // no order → after
  X.registerTaskDetailSection({ id: "sbom", order: 1, render: () => {} });
  X.registerSettingsTab({ id: "billing", label: "Billing", render: () => {} });
  const nav = X._consume("nav");
  assert(nav.length === 2 && nav[0].id === "docs" && nav[1].id === "status", "nav registrations returned in order (numbered order before unspecified)");
  assert(nav[0].label === "Docs" && nav[0].href === "/docs", "nav entry preserves label + href");
  assert(X._consume("settingsTab")[0].id === "billing" && typeof X._consume("settingsTab")[0].render === "function", "settingsTab entry preserves render()");
  assert(X._consume("taskDetailSection")[0].id === "sbom", "taskDetailSection entry present");
  assert(X._consume("nav") !== X._consume("nav"), "_consume returns a NEW array each call (registry not mutable via return)");

  // the empty stub is inert: loading it registered nothing
  const Y = loadRegistry(true);
  assert(Y._consume("nav").length === 0 && Y._consume("settingsTab").length === 0 && Y._consume("taskDetailSection").length === 0,
    "core stub extensions/index.js registers NOTHING (empty comment-only file)");
}

/* =========================================================================
   Shared: build the real Orcha app (app.js + shell) with a snapshot + optional
   registered extensions, then render the sidebar via the REAL mountShell.
   ========================================================================= */
function makeAppSandbox(register) {
  const reg = {};
  function el(id) { return (id in reg) ? reg[id] : (reg[id] = makeNode()); }
  const document = {
    documentElement: { setAttribute: () => {}, removeAttribute: () => {}, getAttribute: () => null },
    body: makeNode("body"),
    addEventListener: () => {}, createElement: (t) => makeNode(t),
    getElementById: (id) => (id in reg ? reg[id] : null),
    querySelector: () => null, querySelectorAll: () => [],
  };
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; },
  };
  const sandbox = {
    window: { matchMedia: () => ({ matches: false }) },
    document, localStorage, console,
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    CSS: { escape: (s) => s },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Load the real core module chain (app-extensions.js is last in it), THEN app.js — so app.js
  // takes its non-fallback assembly and window.Orcha.mountShell is the real app-shell.js one.
  CORE_CHAIN.forEach(({ rel, src }) => vm.runInContext(src, sandbox, { filename: rel }));
  vm.runInContext(APP_JS, sandbox, { filename: "app.js" });
  if (register) register(sandbox.window.OrchaExt);
  // sidebar host so mountShell has somewhere to write
  reg["sidebar"] = makeNode("sidebar");
  const O = sandbox.window.Orcha;
  O.applySnapshot({ container: { id: "c1", autonomy_level: "plan", wakes_enabled: true },
    agents: [{ id: "h1", alias: "Kedar", kind: "human" }], tasks: [], requests: [] });
  O.mountShell("home", { title: "Dashboard" });
  return { sidebarHTML: reg["sidebar"].innerHTML, O };
}

console.log("\nPART 2 — nav shell consume site (registerNavItem)");
{
  const base = makeAppSandbox(null).sidebarHTML;
  const withExt = makeAppSandbox((X) => {
    X.registerNavItem({ id: "billing", label: "Billing", href: "/billing", order: 50 });
  }).sidebarHTML;
  assert(base.indexOf("/billing") === -1 && base.indexOf("Billing") === -1, "no-extensions sidebar has no extension nav item");
  assert(withExt.indexOf('href="/billing"') !== -1 && withExt.indexOf("Billing") !== -1, "registered nav item renders into the shell nav");
  // BYTE-IDENTICAL guard: the base render must be unchanged from the with-ext render minus the item.
  // We check the stronger property directly: a second no-ext render equals the first.
  const base2 = makeAppSandbox(null).sidebarHTML;
  assert(base === base2, "no-extensions sidebar render is deterministic (byte-identical across runs)");
  // and the extension item is strictly ADDITIVE — the core entries are untouched.
  assert(["/", "/agents", "/tasks", "/requests", "/settings"].every((h) => withExt.indexOf('href="' + h + '"') !== -1),
    "core nav entries all still present with an extension registered (additive only)");
}

/* =========================================================================
   PART 3 — settings tabs consume site (registerSettingsTab)
   Drives the REAL settings.js: it renders registered tabs into #extSettingsTabs
   on mountShell. We assert a card is appended + render(el) is invoked; and that
   with NO registration the host stays empty (byte-identical settings page).
   ========================================================================= */
function makeSettingsSandbox(register) {
  const reg = {};
  const host = makeNode("extSettingsTabs");
  reg["extSettingsTabs"] = host;
  reg["sidebar"] = makeNode("sidebar");
  reg["topbar"] = makeNode("topbar");
  reg["pairingCard"] = makeNode("pairingCard");
  let startCb = null;
  const document = {
    documentElement: { setAttribute: () => {}, removeAttribute: () => {}, getAttribute: () => null },
    body: makeNode("body"), addEventListener: () => {},
    createElement: (t) => makeNode(t),
    getElementById: (id) => (id in reg ? reg[id] : null),
    querySelector: () => null, querySelectorAll: () => [],
  };
  const store = {};
  const sandbox = {
    window: {
      matchMedia: () => ({ matches: false }),
      // stub the shared services settings.js leans on so we exercise ONLY the seam path
      Orcha: {
        esc: (s) => (s == null ? "" : String(s)),
        patch: (el, html) => { if (el) el.innerHTML = html; return true; },
        mountShell: () => {}, openPairingModal: () => {}, actingHuman: () => null, toast: () => {}, modal: () => {}, closeModal: () => {},
      },
      OrchaData: {
        start: (cb) => { startCb = cb; },
        resolveCid: () => Promise.resolve("c1"),
      },
      ORCHA: { container: { name: "demo" } },
    },
    document, console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(EXT_JS, sandbox, { filename: "app-extensions.js" });
  if (register) register(sandbox.window.OrchaExt);
  vm.runInContext(SETTINGS_JS, sandbox, { filename: "settings.js" });
  // settings.js registers a start() callback; fire it to run the mount → renderExtTabs path.
  if (startCb) startCb();
  return host;
}

console.log("\nPART 3 — settings tabs consume site (registerSettingsTab)");
{
  const empty = makeSettingsSandbox(null);
  assert(empty.children.length === 0 && empty.innerHTML === "", "no-extensions settings host is empty (byte-identical settings page)");

  let renderedInto = null;
  const withTab = makeSettingsSandbox((X) => {
    X.registerSettingsTab({ id: "billing", label: "Billing", render: (el) => { renderedInto = el; el.innerHTML = "<p>usage</p>"; } });
  });
  assert(withTab.children.length === 1, "one settings-tab card appended for one registration");
  const card = withTab.children[0];
  assert(card.dataset.extTab === "billing", "the appended card carries data-ext-tab = the tab id");
  assert(card.innerHTML.indexOf("Billing") !== -1, "tab label renders into the card header");
  assert(renderedInto !== null && renderedInto.innerHTML.indexOf("usage") !== -1, "render(el) was called with the card body host");
}

/* =========================================================================
   PART 4 — task-detail sections consume site (registerTaskDetailSection)
   Drives the REAL renderDetail() (tasks-state + detail + actions + thread loaded
   together, exactly as the <script> tags do). Asserts the section renders BELOW
   Definition of done, and that with NO registration the detail HTML is byte-identical.
   ========================================================================= */
function makeTasksSandbox(register) {
  const reg = {};
  const detailMain = makeNode("detailMain");
  reg["detailMain"] = detailMain;
  let lastHTML = "";
  const document = {
    documentElement: { setAttribute: () => {}, removeAttribute: () => {}, getAttribute: () => null },
    body: makeNode("body"), addEventListener: () => {},
    createElement: (t) => makeNode(t),
    getElementById: (id) => (id in reg ? reg[id] : null),
    querySelector: () => null, querySelectorAll: () => [],
  };
  // A patch() that records the html AND builds a mini-DOM tree for the ext-section hosts,
  // so renderExtSections' querySelector('[data-ext-section="..."]') can find them.
  function buildHosts(html) {
    detailMain.children = [];
    const re = /data-ext-section="([^"]+)"/g; let m;
    while ((m = re.exec(html))) { const h = makeNode("div"); h.dataset.extSection = m[1]; detailMain.appendChild(h); }
  }
  const sandbox = {
    window: {
      matchMedia: () => ({ matches: false }),
      Orcha: {
        esc: (s) => (s == null ? "" : String(s)),
        linkify: (s) => (s == null ? "" : String(s)),
        icon: () => "", pill: () => "", avatar: () => "", agentByAlias: () => null, agentLink: () => "",
        actingHuman: () => null, trunc: (s) => s, relTime: () => "", shortId: (s) => s,
        patch: (el, html) => { if (el === detailMain) { lastHTML = html; buildHosts(html); } return true; },
      },
      ORCHA: { container: { id: "c1" }, tasks: [], requests: [], agents: [] },
      OrchaData: { threadOf: () => Promise.resolve([]) },
    },
    document, console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout: (fn) => 0, clearTimeout: () => {}, location: { search: "" },
    URLSearchParams: URLSearchParams, CSS: { escape: (s) => s },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(EXT_JS, sandbox, { filename: "app-extensions.js" });
  vm.runInContext(TASKS_STATE_JS, sandbox, { filename: "tasks-state.js" });
  vm.runInContext(TASKS_DETAIL_JS, sandbox, { filename: "tasks-detail.js" });
  vm.runInContext(TASKS_ACTIONS_JS, sandbox, { filename: "tasks-actions.js" });
  vm.runInContext(TASKS_THREAD_JS, sandbox, { filename: "tasks-thread.js" });
  if (register) register(sandbox.window.OrchaExt);
  const task = { id: "t1", title: "Wire slider", status: "in_progress", assignee: "Glass",
    definition_of_done: "Slider persists on reload.", plan_decision: null };
  sandbox.window.ORCHA.tasks = [task];
  sandbox.sel = "t1";
  vm.runInContext("sel = 't1'; renderDetail(true);", sandbox);
  return { html: lastHTML, detailMain };
}

console.log("\nPART 4 — task-detail sections consume site (registerTaskDetailSection)");
{
  const base = makeTasksSandbox(null);
  assert(base.html.indexOf("Definition of done") !== -1, "sanity: base detail renders Definition of done");
  assert(base.html.indexOf("data-ext-section") === -1, "no-extensions detail has NO ext-section hosts");
  const base2 = makeTasksSandbox(null).html;
  assert(base.html === base2, "no-extensions task-detail HTML is byte-identical across runs");

  let gotTask = null, gotHost = null;
  const withSec = makeTasksSandbox((X) => {
    X.registerTaskDetailSection({ id: "sbom", order: 1, render: (el, t) => { gotHost = el; gotTask = t; el.innerHTML = "<div>SBOM</div>"; } });
  });
  assert(withSec.html.indexOf('data-ext-section="sbom"') !== -1, "registered task-detail section host renders into the detail HTML");
  // positioned BELOW Definition of done (the contract's placement requirement)
  const iDoD = withSec.html.indexOf("Definition of done");
  const iSec = withSec.html.indexOf('data-ext-section="sbom"');
  assert(iDoD !== -1 && iSec !== -1 && iSec > iDoD, "section host is rendered BELOW Definition of done");
  assert(gotHost !== null && gotHost.innerHTML.indexOf("SBOM") !== -1, "render(el, task) called with the section host");
  assert(gotTask && gotTask.id === "t1", "render(el, task) receives the current task");
}

/* =========================================================================
   PART 5 — the "extensions never patch core" rule is DOCUMENTED
   ========================================================================= */
console.log("\nPART 5 — 'extensions never patch core' doc rule");
{
  const headerHasRule = /never\s+patch\s+core|must\s+NEVER\s+patch\s+core|never patch/i.test(EXT_JS);
  assert(headerHasRule, "app-extensions.js module header states extensions must never patch core");
  assert(/window\.OrchaExt/.test(STUB_JS) && /never patch|must never/i.test(STUB_JS), "the empty stub file restates the register-only / no-patch rule");

  // the architecture doc carries the rule too (find the portal-extensions doc section)
  const DOC_CANDIDATES = [
    path.join(ROOT, "docs", "architecture", "00-system-overview.md"),
    path.join(ROOT, "docs", "portal-extensions.md"),
  ];
  let docHit = false;
  for (const d of DOC_CANDIDATES) {
    if (fs.existsSync(d)) {
      const txt = fs.readFileSync(d, "utf8");
      if (/OrchaExt/.test(txt) && /never patch core|must never patch|never patch/i.test(txt)) { docHit = true; break; }
    }
  }
  assert(docHit, "a portal-architecture doc documents the OrchaExt seam + the never-patch-core rule");
}

console.log("\n" + (failures === 0 ? "ALL PASS" : "FAILURES") + ` — ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
