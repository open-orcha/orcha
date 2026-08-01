/* ============================================================================
   Seamless navigation (MPA, no SPA rewrite) — the four layers that remove the
   blank flash + make sidebar/tab clicks read as instant:

     PART A  pre-paint snippet — every shell page's <head> sets an inline
             bg/fg on <html> BEFORE any stylesheet link, with hardcoded colors
             that must match --bg/--text in styles/tokens.css (classic) and
             the Swiss skin token block; identical snippet on all 6 pages.
     PART B  self-hosted fonts — fonts.googleapis.com/gstatic gone from every
             page; /assets/styles/fonts.css linked instead; every @font-face
             src resolves to a real woff2 file (magic-checked) in static/fonts.
     PART C  speculation rules — every page carries a JSON-valid prerender
             document rule (moderate eagerness) with the non-page exclusions
             (/api/*, /assets/*).
     PART D  view transitions — tokens.css opts into cross-document view
             transitions (fast root cross-fade, none under reduced motion).
     PART E  primed shell — app-shell.js restores the cached sidebar/topbar
             markup synchronously at load (before the first snapshot round
             trip) and mountShell persists its render for the next page.

   Dependency-free: Node built-ins only; PART E runs the REAL app-shell.js in
   a vm sandbox over a tiny fake DOM (mirrors the other tests/portal suites).

   Run: node tests/portal/seamless_nav.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");

const PAGES = [
  "home.html", "agents.html", "tasks.html", "requests.html",
  "settings.html", "onboarding.html",
];
const heads = {};
for (const p of PAGES) heads[p] = read(p).split("</head>")[0];

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* =====================================================================
   PART A — pre-paint: inline bg/fg before any CSS
   ===================================================================== */
console.log("PART A — pre-paint inline background before CSS");

const snippetOf = (head) => {
  // Round-2 fix (finding #2): stamp() was hoisted OUT of the outer try{} so it can be
  // re-invoked on prerenderingchange — match on that shape instead of the old
  // inline `(function(){try{var d=...` form.
  const m = head.match(/<script>\(function\(\)\{var d=document\.documentElement;function stamp\(\)[\s\S]*?<\/script>/);
  return m ? m[0] : null;
};
const refSnippet = snippetOf(heads["home.html"]);
assert(!!refSnippet, "home.html head carries the pre-paint snippet");

for (const p of PAGES) {
  const head = heads[p], snip = snippetOf(head);
  assert(snip === refSnippet, p + ": snippet present and byte-identical to home.html");
  if (!snip) continue;
  // line-anchored: the snippet's own explanatory comment mentions the literal
  // string <link rel="stylesheet">, so a plain indexOf would find the comment.
  const firstCss = head.search(/^<link rel="stylesheet"/m);
  assert(firstCss > -1 && head.indexOf(snip) < firstCss,
    p + ": snippet sits BEFORE the first stylesheet link (else it can't beat slow CSS to first paint)");
}

// the snippet's mechanics
assert(refSnippet.includes("d.style.backgroundColor="), "snippet sets an inline background-color on <html>");
assert(refSnippet.includes("d.style.color="), "snippet sets an inline color on <html>");
assert(refSnippet.includes("prefers-color-scheme: light"), "snippet resolves 'auto' via prefers-color-scheme (mirrors the CSS dark default)");
assert(/DOMContentLoaded/.test(refSnippet) && refSnippet.includes("d.style.backgroundColor=''"),
  "snippet clears the inline override once real CSS is live (DOMContentLoaded)");
assert(refSnippet.includes("data-theme") && refSnippet.includes("data-skin") && refSnippet.includes("data-sidebar"),
  "snippet still stamps data-theme / data-skin / data-sidebar (pre-existing contract)");

// hardcoded colors must match the token files (source of truth)
const tokensCss = read("styles", "tokens.css");
// the Swiss skin block lives in the shared skin sheets; parse it from wherever
// it currently sits (conversation.css today, responsive.css once the #191
// split-fragment repair moves it) so this suite doesn't pin a file layout.
const skinCss = read("styles", "responsive.css") + "\n" + read("styles", "conversation.css");
function tokenIn(block, name) {
  const m = block.match(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{3,8})"));
  return m ? m[1].toLowerCase() : null;
}
function blockOf(css, selRe) {
  const m = css.match(new RegExp(selRe + "[^{]*\\{([\\s\\S]*?)(?:\\n\\}|$)"));
  return m ? m[1] : "";
}
const expect = {
  classicDark: { bg: tokenIn(blockOf(tokensCss, ':root,\\n\\[data-theme="dark"\\]'), "bg"),
                 fg: tokenIn(blockOf(tokensCss, ':root,\\n\\[data-theme="dark"\\]'), "text") },
  classicLight: { bg: tokenIn(blockOf(tokensCss, '\\n\\[data-theme="light"\\]'), "bg"),
                  fg: tokenIn(blockOf(tokensCss, '\\n\\[data-theme="light"\\]'), "text") },
  swissDark: { bg: tokenIn(blockOf(skinCss, 'html\\[data-skin="swiss"\\],'), "bg"),
               fg: tokenIn(blockOf(skinCss, 'html\\[data-skin="swiss"\\],'), "text") },
  swissLight: { bg: tokenIn(blockOf(skinCss, 'html\\[data-skin="swiss"\\]\\[data-theme="light"\\]'), "bg"),
                fg: tokenIn(blockOf(skinCss, 'html\\[data-skin="swiss"\\]\\[data-theme="light"\\]'), "text") },
};
assert(expect.classicDark.bg && expect.classicLight.bg && expect.swissDark.bg && expect.swissLight.bg,
  "parsed all four --bg values out of the token sheets");
const lower = refSnippet.toLowerCase();
for (const [label, pair] of Object.entries(expect)) {
  assert(pair.bg && lower.includes("'" + pair.bg + "'"), `snippet hardcodes the ${label} --bg (${pair.bg})`);
  assert(pair.fg && lower.includes("'" + pair.fg + "'"), `snippet hardcodes the ${label} --text (${pair.fg})`);
}
// Round-2 fix (finding #5): the four checks above are presence-only — they pass even if
// light/dark are swapped on either branch (a mutation the reviewer ran by hand: swapping
// L?'a':'b' to L?'b':'a' on all six pages still passed every check above, while painting a
// black first frame for light-mode users and a white one for dark-mode users). Assert the
// TERNARY STRUCTURE itself: W?(L?swissLight:swissDark):(L?classicLight:classicDark), so each
// hex must sit on the correct branch, not merely appear somewhere in the snippet.
const bgTernary = `w?(l?'${expect.swissLight.bg}':'${expect.swissDark.bg}'):(l?'${expect.classicLight.bg}':'${expect.classicDark.bg}')`;
const fgTernary = `w?(l?'${expect.swissLight.fg}':'${expect.swissDark.fg}'):(l?'${expect.classicLight.fg}':'${expect.classicDark.fg}')`;
assert(lower.replace(/\s+/g, "").includes(bgTernary.replace(/\s+/g, "")),
  "snippet's background-color ternary maps skin x theme to the right --bg on EACH branch (not just present somewhere)");
assert(lower.replace(/\s+/g, "").includes(fgTernary.replace(/\s+/g, "")),
  "snippet's color ternary maps skin x theme to the right --text on EACH branch (not just present somewhere)");

/* =====================================================================
   PART B — self-hosted fonts
   ===================================================================== */
console.log("PART B — self-hosted fonts, Google origins gone");

for (const p of PAGES) {
  const html = read(p);
  assert(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html), p + ": no fonts.googleapis/gstatic reference");
  assert(html.includes('<link rel="stylesheet" href="/assets/styles/fonts.css">'), p + ": links /assets/styles/fonts.css");
  const head = heads[p];
  assert(head.indexOf("/assets/styles/fonts.css") < head.indexOf("/assets/styles/tokens.css"),
    p + ": fonts.css loads before tokens.css (tokens references the families)");
}

const fontsCss = read("styles", "fonts.css");
for (const fam of ["Inter", "JetBrains Mono", "Space Grotesk"]) {
  assert(fontsCss.includes(`font-family: "${fam}"`), `fonts.css declares @font-face for ${fam}`);
}
const faces = fontsCss.split("@font-face").slice(1);
assert(faces.length >= 6 && faces.every((f) => /font-display:\s*swap/.test(f)),
  "every @font-face uses font-display: swap (text stays visible while fonts stream)");
const srcs = [...fontsCss.matchAll(/url\("(\/assets\/fonts\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);
assert(srcs.length >= 6, "fonts.css references at least 6 woff2 files (latin + latin-ext x 3 families), found " + srcs.length);
for (const src of srcs) {
  const file = path.join(STATIC, src.replace("/assets/", ""));
  const ok = fs.existsSync(file) && fs.readFileSync(file).slice(0, 4).toString("latin1") === "wOF2";
  assert(ok, src + " exists in static/ and has the woff2 magic");
}

// Round-2 fix — public-release blocker: the vendored woff2 files declare an OFL 1.1
// obligation (each carries an OFL URL in its own name-table license field) that this
// MIT-licensed repo didn't ship. static/fonts/OFL.txt + README.md follow the exact
// convention static/vendor/README.md already established for the xterm.js bundle.
{
  const oflPath = path.join(STATIC, "fonts", "OFL.txt");
  const readmePath = path.join(STATIC, "fonts", "README.md");
  assert(fs.existsSync(oflPath), "static/fonts/OFL.txt exists");
  if (fs.existsSync(oflPath)) {
    const ofl = fs.readFileSync(oflPath, "utf8");
    assert(/SIL OPEN FONT LICENSE Version 1\.1/.test(ofl), "OFL.txt carries the SIL OFL 1.1 license text");
    for (const holder of ["Inter Project Authors", "JetBrains Mono Project Authors", "Space Grotesk Project Authors"]) {
      assert(ofl.includes(holder), `OFL.txt credits the ${holder}`);
    }
  }
  assert(fs.existsSync(readmePath), "static/fonts/README.md exists");
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, "utf8");
    for (const fam of ["Inter", "JetBrains Mono", "Space Grotesk"]) {
      assert(readme.includes(fam), `fonts/README.md's provenance table covers ${fam}`);
    }
    assert(/OFL/.test(readme), "fonts/README.md records the OFL-1.1 license, matching vendor/README.md's table shape");
  }
  const fontsCssHeader = fontsCss.slice(0, fontsCss.indexOf("*/"));
  assert(/OFL|Open Font License/.test(fontsCssHeader), "styles/fonts.css's header comment credits the license (not just the vendoring rationale)");
}

/* =====================================================================
   PART C — speculation rules (prerender)
   ===================================================================== */
console.log("PART C — speculation rules on every page");

for (const p of PAGES) {
  const head = heads[p];
  const m = head.match(/<script type="speculationrules">\s*([\s\S]*?)\s*<\/script>/);
  assert(!!m, p + ": carries a speculationrules script in <head>");
  if (!m) continue;
  let rules = null;
  try { rules = JSON.parse(m[1]); } catch (e) {}
  assert(!!rules, p + ": speculationrules payload is valid JSON");
  if (!rules) continue;
  const rule = (rules.prerender || [])[0] || {};
  assert(rule.eagerness === "moderate", p + ": prerender eagerness is 'moderate' (hover/pointer-down)");
  const and = (rule.where && rule.where.and) || [];
  assert(and.some((c) => c.href_matches === "/*"), p + ": document rule matches same-origin links incl. ?cid= queries");
  // /onboarding* added round-2 (finding #3): onboarding-boot.js's boot() is NOT read-only —
  // it can advance persisted wizard/demo-flag state in localStorage before the user ever
  // clicks a hovered "+ New agent" link. Excluding the whole page from prerender is the
  // primary fix (boot() also self-guards on document.prerendering as a second layer).
  for (const excl of ["/api/*", "/assets/*", "/onboarding*"]) {
    assert(and.some((c) => c.not && c.not.href_matches === excl), p + `: excludes ${excl} from prerender`);
  }
}

/* =====================================================================
   PART D — cross-document view transitions
   ===================================================================== */
console.log("PART D — view transitions in tokens.css");

assert(/@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/.test(tokensCss),
  "tokens.css opts into cross-document view transitions (navigation: auto)");
assert(/::view-transition-old\(root\),\s*\n?::view-transition-new\(root\)\s*\{\s*animation-duration:\s*120ms/.test(tokensCss),
  "root cross-fade is fast (120ms) — a nav aid, not an animation showcase");
assert(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*@view-transition\s*\{\s*navigation:\s*none;?\s*\}/.test(tokensCss),
  "prefers-reduced-motion gets navigation: none (instant swap)");
for (const p of PAGES) {
  assert(heads[p].includes("/assets/styles/tokens.css"), p + ": loads tokens.css (so the opt-in applies on both nav endpoints)");
}

/* =====================================================================
   PART E — primed shell (real app-shell.js in a vm sandbox)
   ===================================================================== */
console.log("PART E — primeShell restores cached chrome before data");

const APP_STATE_JS = read("modules", "app-state.js");
const APP_SHELL_JS = read("modules", "app-shell.js");
assert(/saveShellCache\(\);\s*\}/.test(APP_SHELL_JS.slice(APP_SHELL_JS.indexOf("function mountShell"))),
  "mountShell persists its render via saveShellCache()");

function makeNode(id) {
  const attrs = {}, classes = new Set();
  const n = {
    id: id || "", _html: "", _listeners: {}, style: {},
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    get firstChild() { return n._html ? {} : null; },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    addEventListener: (ev, fn) => { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    appendChild: () => {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      contains: (c) => classes.has(c),
    },
  };
  return n;
}
function makeSandbox({ store = {}, pathname = "/tasks", search = "?cid=proj1", ids = {} } = {}) {
  const byId = {};
  for (const [k, v] of Object.entries(ids)) byId[k] = v;
  const documentElement = makeNode("html");
  const document = {
    documentElement, body: makeNode("body"),
    getElementById: (id) => byId[id] || null,
    createElement: () => makeNode(""),
    addEventListener: () => {},
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const sandbox = {
    window: { matchMedia: () => ({ matches: false }) },
    document, localStorage, console, URLSearchParams,
    location: { pathname, search },
    setTimeout: () => 0, clearTimeout: () => {}, fetch: () => Promise.resolve({ ok: false }),
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = document;
  sandbox.window.localStorage = localStorage;
  vm.createContext(sandbox);
  vm.runInContext(APP_STATE_JS, sandbox);
  vm.runInContext(APP_SHELL_JS, sandbox);
  return { sandbox, store, byId };
}

// E1: cached chrome for this (cid, page) is restored synchronously at load
{
  const side = makeNode("sidebar"), top = makeNode("topbar"), sbT = makeNode("sbToggle");
  const cached = JSON.stringify({ side: "<nav>cached-side</nav>", top: "<div>cached-top</div>" });
  const { } = makeSandbox({
    store: { "orcha:shellHtml:proj1:tasks": cached },
    ids: { sidebar: side, topbar: top, sbToggle: sbT },
  });
  assert(side.innerHTML === "<nav>cached-side</nav>", "sidebar markup restored from the cache at script load");
  assert(top.innerHTML === "<div>cached-top</div>", "topbar markup restored from the cache at script load");
  assert((sbT._listeners.click || []).length === 1, "collapse toggle is wired pre-data (browser-local state only)");
}

// E2: no cache -> chrome untouched, no crash (first-ever visit behaves as before)
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  makeSandbox({ store: {}, ids: { sidebar: side, topbar: top } });
  assert(side.innerHTML === "" && top.innerHTML === "", "no cache: sidebar/topbar stay empty until the real mount");
}

// E3: an already-mounted shell is never clobbered by the primer
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  side.innerHTML = "<nav>live</nav>"; top.innerHTML = "<div>live</div>";
  makeSandbox({
    store: { "orcha:shellHtml:proj1:tasks": JSON.stringify({ side: "stale", top: "stale" }) },
    ids: { sidebar: side, topbar: top },
  });
  assert(side.innerHTML === "<nav>live</nav>", "primer never overwrites an already-rendered sidebar");
}

// E4: cache key is per (cid, page) — another container's cache never leaks in
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  makeSandbox({
    store: { "orcha:shellHtml:OTHER:tasks": JSON.stringify({ side: "wrong-cid", top: "wrong-cid" }) },
    ids: { sidebar: side, topbar: top },
  });
  assert(side.innerHTML === "", "a different container's cached chrome is not restored");
}

// E5: saveShellCache writes the current chrome under the derived key
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  const { sandbox, store } = makeSandbox({ store: {}, ids: { sidebar: side, topbar: top } });
  side.innerHTML = "<nav>fresh</nav>"; top.innerHTML = "<div>fresh</div>";
  vm.runInContext("saveShellCache()", sandbox);
  const saved = JSON.parse(store["orcha:shellHtml:proj1:tasks"] || "null");
  assert(!!saved && saved.side === "<nav>fresh</nav>" && saved.top === "<div>fresh</div>",
    "saveShellCache persists sidebar+topbar under orcha:shellHtml:<cid>:<page>");
}

// E6: bare "/" maps to the home cache key (pathname -> page normalisation)
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  makeSandbox({
    pathname: "/", search: "?cid=proj1",
    store: { "orcha:shellHtml:proj1:home": JSON.stringify({ side: "home-side", top: "home-top" }) },
    ids: { sidebar: side, topbar: top },
  });
  assert(side.innerHTML === "home-side", "'/' primes from the home cache entry");
}

// E7: round-2 fix (finding #4) — primeShell neutralises the data-bearing controls it
// can't back with a live handler. #notifTop/#autTop (which show the notifier kill-switch
// + autonomy level) are emptied outright rather than left showing their last PAINTED
// reading; the whole topbar is marked .priming + aria-busy so CSS makes the
// not-yet-wired regions (search, attn pill, pair-phone, notifier/autonomy) visibly inert
// instead of silently swallowing a click.
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  const notifTop = makeNode("notifTop"), autTop = makeNode("autTop");
  notifTop.innerHTML = "<button class=\"on\">Running</button>";   // stale painted state from the cache
  autTop.innerHTML = "<button class=\"on\">Plan-only</button>";
  const cachedTop = "<div class=\"ctl-wrap\"><div id=\"notifTop\"></div><div id=\"autTop\"></div></div>";
  makeSandbox({
    store: { "orcha:shellHtml:proj1:tasks": JSON.stringify({ side: "<nav>cached</nav>", top: cachedTop }) },
    ids: { sidebar: side, topbar: top, notifTop, autTop },
  });
  assert(top.classList.contains("priming"), "primed topbar carries .priming (CSS makes its data-bearing regions pointer-events:none)");
  assert(top.getAttribute("aria-busy") === "true", "…and aria-busy=true signals not-yet-live to assistive tech too");
  assert(notifTop.innerHTML === "", "#notifTop (the notifier kill-switch) is EMPTIED, not left showing its stale cached reading");
  assert(autTop.innerHTML === "", "#autTop (autonomy level) is EMPTIED too — autonomy is container-level but the cache is per (cid,page)");
}

// E8: mountShell's own render clears whatever primeShell marked not-yet-live (source-level
// check: mountShell's dependency graph — attnItems/agents/actingHuman/icon/orcaSVG/
// ensurePausebar/paintAutonomy/wireNotifPill from OTHER modules — is out of scope for this
// single-module sandbox, so this pins the two statements directly rather than driving a
// full mountShell() call).
{
  const start = APP_SHELL_JS.indexOf("function mountShell");
  const end = APP_SHELL_JS.indexOf("function shellCacheKey");   // next top-level fn after mountShell
  const mountShellBlock = APP_SHELL_JS.slice(start, end);
  assert(/topbar\.classList\.remove\(\s*["']priming["']\s*\)/.test(mountShellBlock),
    "mountShell clears .priming on its own real render");
  assert(/topbar\.removeAttribute\(\s*["']aria-busy["']\s*\)/.test(mountShellBlock),
    "mountShell clears aria-busy on its own real render");
}

/* =====================================================================
   PART F — round-2 review fixes: prerender must not run side effects early
   (async: F1 drives a real fetch()-returning promise chain through data.js's
   refresh(), so this whole part runs inside an async IIFE at the bottom of
   the file — everything above is synchronous, same as before.)
   ===================================================================== */
async function partF() {
console.log("PART F — prerendering must not open connections, mutate state, or freeze chrome");

// F1: data.js's OrchaData.start() must NOT poll/stream while document.prerendering is
// true (finding #1) — it must defer via the platform's own prerenderingchange event and
// run for real once activated. Drives the REAL data.js in a vm sandbox.
{
  const DATA_JS = read("data.js");
  const fetchCalls = [];
  const intervals = [];
  const listeners = {};
  const documentObj = {
    prerendering: true,
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  };
  const sandbox = {
    window: { Orcha: { applySnapshot: (s) => s, toast: () => {} }, ORCHA: null },
    document: documentObj,
    location: { search: "" },
    URLSearchParams,
    fetch: (url) => { fetchCalls.push(String(url)); return Promise.resolve({ ok: false, status: 500 }); },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout: () => 0,
    EventSource: undefined,   // keep this test focused on the poll/fetch side of finding #1
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(DATA_JS, sandbox, { filename: "data.js" });
  vm.runInContext("window.OrchaData.start(function(){}, 3000)", sandbox);
  assert(fetchCalls.length === 0, "start() while document.prerendering=true issues NO fetch (no premature snapshot poll)");
  assert(intervals.length === 0, "…and does not arm the 3s setInterval either");
  assert((listeners.prerenderingchange || []).length === 1,
    "…instead registers exactly one prerenderingchange listener to defer startup");
  // activation: the platform flips document.prerendering to false THEN fires
  // prerenderingchange (that ordering is the whole point of the event) — start()'s guard
  // re-reads document.prerendering on the re-entrant call, so the test must flip it too or
  // it would just re-arm another listener and hang deferred forever. refresh()'s fetch
  // chain is a real promise chain (resolveCid -> getJSON -> ...), so flush microtasks a
  // few times before asserting.
  documentObj.prerendering = false;
  listeners.prerenderingchange[0]();
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert(fetchCalls.length >= 1, "on prerenderingchange, start() runs for real and fetches the snapshot");
  assert(intervals.length === 1, "…and arms the 3s poll interval exactly once");
}

// F2: the pre-paint snippet's stamp() re-syncs data-theme/data-skin/data-sidebar on
// prerenderingchange (finding #2) — localStorage changed (another tab, or the SAME
// origin's visible document) between prerender-time parse and activation must not leave
// the activated page showing a stale theme/skin/sidebar with no re-sync until reload.
{
  const headHtml = heads["home.html"];
  const m = headHtml.match(/<script>\(function\(\)\{var d=document\.documentElement;function stamp[\s\S]*?<\/script>/);
  assert(!!m, "home.html carries the stamp()-based pre-paint snippet");
  const snippetSrc = m[0].replace(/^<script>/, "").replace(/<\/script>$/, "");
  const attrs = {};
  const listeners = {};
  const store = { "orcha:theme": "dark", "orcha:skin": null, "orcha:sidebar": "collapsed" };
  const documentEl = {
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
    style: {},
  };
  const sandbox = {
    document: {
      documentElement: documentEl,
      prerendering: true,
      addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
    },
    window: { matchMedia: () => ({ matches: false }) },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(snippetSrc, sandbox, { filename: "prepaint.js" });
  assert(attrs["data-theme"] === "dark" && attrs["data-sidebar"] === "collapsed" && !("data-skin" in attrs),
    "prerender-time stamp: data-theme=dark, data-sidebar=collapsed, no data-skin (matches localStorage at parse time)");
  assert((listeners.prerenderingchange || []).length === 1,
    "registers exactly one prerenderingchange listener (still prerendering)");
  // the user (or another tab sharing this origin's localStorage) changes theme/skin/sidebar
  // WHILE this document is still an invisible prerender
  store["orcha:theme"] = "light"; store["orcha:skin"] = "swiss"; store["orcha:sidebar"] = "expanded";
  listeners.prerenderingchange[0]();   // simulate activation
  assert(attrs["data-theme"] === "light", "on activation, data-theme re-syncs to the NEW value");
  assert(attrs["data-skin"] === "swiss", "…data-skin re-syncs too");
  assert(!("data-sidebar" in attrs), "…and data-sidebar is REMOVED (no longer collapsed) rather than left stale");
}

// F3: onboarding-boot.js's boot() must not persist wizard/demo-flag state while
// document.prerendering is true (finding #3 — the speculation-rules exclusion is the
// primary fix; this is the belt-and-suspenders client-side guard).
{
  const ONBOARDING_STATE_JS = read("modules", "onboarding-state.js");
  const ONBOARDING_BOOT_JS = read("modules", "onboarding-boot.js");
  const store = { "orcha:onboarding": JSON.stringify({ step: "fork", tasks: [], lastAgentAlias: null, _agentDraft: null }) };
  const orchaStub = { agents: () => [{ id: "h1", alias: "maker", kind: "human" }], tasks: () => [] };
  const sandbox = {
    window: { Orcha: orchaStub, OrchaData: { start: () => {}, resolveCid: () => Promise.resolve(null) } },
    document: { prerendering: true, getElementById: () => null, addEventListener: () => {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    location: { search: "?new=1" },
    URLSearchParams,
    fetch: () => Promise.resolve({ ok: false }),
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ONBOARDING_STATE_JS, sandbox, { filename: "onboarding-state.js" });
  // boot()/render() reference module-level helpers that live in onboarding-render.js /
  // onboarding-proposal-model.js in the real page; stub them — boot() itself (the
  // document.prerendering guard) is what's under test, not the rest of the wizard.
  vm.runInContext(
    "function render(){} function parseSSE(){} function normalizeRoster(){} " +
    "function rosterToWalk(){} function walkAgentToDraft(){}",
    sandbox
  );
  vm.runInContext(ONBOARDING_BOOT_JS, sandbox, { filename: "onboarding-boot.js" });
  vm.runInContext("boot()", sandbox);
  const after = JSON.parse(store["orcha:onboarding"]);
  assert(after.step === "fork", "boot() while document.prerendering=true does NOT advance the persisted step (?new=1 would otherwise jump it to create-agent)");
}
}

/* ---- summary --------------------------------------------------------- */
partF().then(() => {
  if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
  console.log("\nAll seamless-nav assertions passed.");
}).catch((e) => { console.error("HARNESS ERROR", (e && e.stack) || e); process.exit(2); });
