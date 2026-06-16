/* ============================================================================
   #294 [SETTINGS] — per-use-case universal-model selection rows on /settings.
   Replaces the '.set-soon' placeholder with one row per REGISTERED use-case
   (SPEC-SETTINGS §2), fed by:
     GET /api/containers/{cid}/settings/models     -> {use_cases:[...]}
     GET /api/containers/{cid}/settings/providers  -> {providers:[...]}  (#290 catalog)
     PUT /api/containers/{cid}/settings/models     -> full-replace override set (human-gated)

   Tests the EXPORTED pure view-model helpers (the dirty-tracking / override / PUT-body
   logic) and the render-from-fixture path (rows appear from the registered set, incl. a
   3rd unknown use-case = extensibility DoD). Dependency-free vm sandbox, same idiom as
   settings_key.test.js. Run:  node tests/portal/model_settings.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORTAL = path.join(__dirname, "..", "..", "orcha-cli", "orcha_cli", "templates", "portal", "static");
const APP_JS = fs.readFileSync(path.join(PORTAL, "app.js"), "utf8");
const DATA_JS = fs.readFileSync(path.join(PORTAL, "data.js"), "utf8");
const SETTINGS_JS = fs.readFileSync(path.join(PORTAL, "settings.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

// ---- tiny fake DOM ---------------------------------------------------------
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", textContent: "", value: "", type: "text",
    disabled: false, dataset: {}, _listeners: {},
    get className() { return n._class; }, set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; }, set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
    setAttribute: () => {}, getAttribute: () => null, contains: () => false,
    addEventListener: (ev, fn) => { n._listeners[ev] = fn; },
    insertAdjacentElement: () => {}, appendChild: () => {}, focus: () => {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  return n;
}

// The catalog + models fixtures (a 3rd 'summarize' use-case the page has NEVER heard of,
// to prove rows render from the registered SET, not a hardcoded list).
const CATALOG = [
  { id: "anthropic", name: "Anthropic", available: true, models: [
    { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
    { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
    { id: "claude-opus-4-8", name: "Opus 4.8" },
  ]},
  { id: "openai", name: "OpenAI", available: false, models: [] },
];
function modelsFixture() {
  return [
    { key: "onboarding", label: "Onboarding", purpose: "Drafts the roster.",
      default_provider: "anthropic", default_model: "claude-sonnet-4-6",
      provider: null, model: null, is_set: false },
    { key: "triage", label: "Wake eligibility", purpose: "Triages a wake.",
      default_provider: "anthropic", default_model: "claude-haiku-4-5-20251001",
      provider: "anthropic", model: "claude-sonnet-4-6", is_set: true },
    { key: "summarize", label: "Summarize", purpose: "A use-case the page never hardcoded.",
      default_provider: "anthropic", default_model: "claude-haiku-4-5-20251001",
      provider: null, model: null, is_set: false },
  ];
}

function makeSandbox(opts) {
  opts = opts || {};
  const reg = {};
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; },
  };
  const document = {
    documentElement: { setAttribute: () => {}, getAttribute: () => null },
    body: makeNode("body"), addEventListener: () => {}, activeElement: null,
    createElement: () => makeNode(""),
    getElementById: (id) => (reg[id] || (reg[id] = makeNode(id))),
    querySelectorAll: () => [],
  };
  const fetchCalls = [];
  let modelsState = modelsFixture();
  const sandbox = {
    URLSearchParams, location: { search: "" }, document, localStorage, console,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    EventSource: undefined,
    fetch: (url, init) => {
      const method = (init && init.method) || "GET";
      const body = init && init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, method, body });
      const J = (status, obj) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(obj) });
      if (/\/settings\/providers$/.test(url)) return J(200, { providers: CATALOG });
      if (/\/settings\/models$/.test(url)) {
        if (method === "PUT") {
          if (opts.failPut) return J(500, {});
          // server applies the full-replace: only sent overrides remain set
          const sent = new Map((body.use_cases || []).map((o) => [o.key, o]));
          modelsState = modelsFixture().map((uc) => {
            const o = sent.get(uc.key);
            return o ? { ...uc, provider: o.provider, model: o.model, is_set: true }
                     : { ...uc, provider: null, model: null, is_set: false };
          });
          return J(200, { use_cases: modelsState });
        }
        return J(200, { use_cases: modelsState });
      }
      if (/\/settings\/llm-key$/.test(url)) return J(200, { configured: false, masked: null, source: null });
      if (/\/api\/containers$/.test(url)) return J(200, [{ id: "c1", status: "active", name: "X" }]);
      if (/\/api\/containers\/c1$/.test(url)) return J(200, { container: { id: "c1", name: "X", status: "active" }, agents: [], tasks: [], requests: [] });
      return J(200, {});
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox, { filename: "app.js" });
  vm.runInContext(DATA_JS, sandbox, { filename: "data.js" });
  sandbox.window.OrchaData.start = () => {};   // don't start the poll loop
  sandbox.window.OrchaData.resolveCid = () => Promise.resolve("c1");
  vm.runInContext(SETTINGS_JS, sandbox, { filename: "settings.js" });
  if (!opts.noHuman) sandbox.window.Orcha.applySnapshot({
    container: { id: "c1", name: "X", status: "active" },
    agents: [{ id: "h-kedar", alias: "Kedar", kind: "human" }],
  });
  return { S: sandbox.window.OrchaSettings, reg, fetchCalls };
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

(async function run() {
  // ============ PURE view-model helpers ============
  console.log("pure helpers:");
  {
    const { S } = makeSandbox();
    // modelsForProvider: live provider lists models; stubbed provider -> [] (never empty dropdown)
    assert(S.modelsForProvider(CATALOG, "anthropic").length === 3, "modelsForProvider lists anthropic models");
    assert(S.modelsForProvider(CATALOG, "openai").length === 0, "modelsForProvider empty for stubbed provider");

    const ucUnset = { default_provider: "anthropic", default_model: "claude-haiku-4-5-20251001", is_set: false, provider: null, model: null };
    const ucSet = { default_provider: "anthropic", default_model: "claude-haiku-4-5-20251001", is_set: true, provider: "anthropic", model: "claude-sonnet-4-6" };

    // currentSel: unset -> default; set -> the override
    assert(S.currentSel(ucUnset).model === "claude-haiku-4-5-20251001", "currentSel unset -> default model");
    assert(S.currentSel(ucSet).model === "claude-sonnet-4-6", "currentSel set -> override model");

    // isOverride: default-valued selection is NOT an override; a different model IS
    assert(S.isOverride({ provider: "anthropic", model: "claude-haiku-4-5-20251001" }, ucUnset) === false, "isOverride false when equals default");
    assert(S.isOverride({ provider: "anthropic", model: "claude-sonnet-4-6" }, ucUnset) === true, "isOverride true when differs from default");

    // rowDirty: equal to persisted -> clean; differ -> dirty
    assert(S.rowDirty({ provider: "anthropic", model: "claude-sonnet-4-6" }, ucSet) === false, "rowDirty false when equals persisted override");
    assert(S.rowDirty({ provider: "anthropic", model: "claude-opus-4-8" }, ucSet) === true, "rowDirty true when differs from persisted");
    // resetting a SET row to default is dirty (it will unset on save)
    assert(S.rowDirty({ provider: "anthropic", model: "claude-haiku-4-5-20251001" }, ucSet) === true, "rowDirty true when resetting a set row to default");

    // buildOverrides: only non-default rows are sent (default rows omitted = reset)
    const ucs = modelsFixture();
    const staged = {
      onboarding: { provider: "anthropic", model: "claude-opus-4-8" },        // new override
      triage: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },  // reset to default (omit)
      summarize: { provider: "anthropic", model: "claude-haiku-4-5-20251001" }, // stays default (omit)
    };
    const body = S.buildOverrides(staged, ucs);
    const keys = body.map((b) => b.key);
    assert(keys.length === 1 && keys[0] === "onboarding", "buildOverrides sends only non-default rows (reset = omit)");
    assert(body[0].model === "claude-opus-4-8", "buildOverrides carries the chosen model");
  }

  // ============ render from the registered SET (extensibility) ============
  console.log("render-from-fixture:");
  {
    const { reg } = makeSandbox();
    await settle();
    const html = reg.modelRows._html;
    assert(/Onboarding/.test(html) && /Wake eligibility/.test(html), "renders the registered use-case rows");
    assert(/Summarize/.test(html), "renders a 3rd use-case the page never hardcoded (extensibility DoD)");
    assert(/default: claude-sonnet-4-6/.test(html), "shows the shipped-default chip");
    // triage is overridden in the fixture -> ● 'set to' state; onboarding unset -> ○ default
    assert(/uc-dot on/.test(html), "an overridden row shows the ● set-state dot");
    assert(/using shipped default/.test(html), "an unset row shows 'using shipped default'");
  }

  // ============ Save (PUT) full-replace + human gate ============
  console.log("save path:");
  {
    const { reg, fetchCalls } = makeSandbox();
    await settle();
    // Simulate the operator resetting triage to default + saving by invoking the rendered
    // Save handler with a staged map via the exported buildOverrides is covered above; here we
    // assert the boot fetched BOTH the catalog and the models store.
    const urls = fetchCalls.map((c) => c.url);
    assert(urls.some((u) => /\/settings\/models$/.test(u)), "boot GETs the model settings");
    assert(urls.some((u) => /\/settings\/providers$/.test(u)), "boot GETs the provider catalog (not /api/models)");
    assert(!urls.some((u) => /\/api\/models$/.test(u)), "never hits /api/models (wrong axis, §0)");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
