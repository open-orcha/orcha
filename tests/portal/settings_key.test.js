/* ============================================================================
   #294 [SETTINGS] — Anthropic API-key surface on the new /settings page.
   The key card: paste / save / test / remove, wired to Helm's ratified contract
     GET    /api/containers/{cid}/settings/llm-key       -> {configured, masked, source}
     PUT    /api/containers/{cid}/settings/llm-key {api_key}
     DELETE /api/containers/{cid}/settings/llm-key
     POST   /api/containers/{cid}/settings/llm-key/test {api_key?}
   Three states: source=db (editable+clearable), source=env (read-only here),
   none (warn banner). Selection of the key is server-side (encrypt + Anthropic
   ping); a browser can't, safely (CORS + key exposure).

   Dependency-free: stubs a minimal DOM + fetch, loads the REAL portal app.js +
   data.js + settings.js in a vm sandbox, and drives the actual wired path
   (init→loadKey→renderKey→doSave/doTest/doClear). Also asserts app.js's nav has
   the 5th Settings entry + the sliders icon. No npm.

   Run:  node tests/portal/settings_key.test.js
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

// ---- tiny fake DOM (with input .value support) -----------------------------
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", textContent: "", value: "", type: "text",
    disabled: false, title: "", dataset: {}, _listeners: {},
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
      toggle: (c, force) => { const has = n.classList._set().has(c);
        const on = force === undefined ? !has : !!force;
        on ? n.classList.add(c) : n.classList.remove(c); return on; },
    },
    setAttribute: () => {}, getAttribute: () => null, contains: () => false,
    addEventListener: (ev, fn) => { n._listeners[ev] = fn; },
    insertAdjacentElement: () => {}, appendChild: () => {}, focus: () => {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  return n;
}

// opts.key = the GET key-status fixture; opts.failPut / opts.testOk control mutations.
function makeSandbox(opts) {
  opts = opts || {};
  const reg = {};
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const documentElement = { setAttribute: () => {}, getAttribute: () => null };
  const document = {
    documentElement, body: makeNode("body"),
    addEventListener: () => {}, activeElement: null,
    createElement: () => {
      const el = makeNode("");
      Object.defineProperty(el, "id", { get() { return el._id || ""; }, set(v) { el._id = v; reg[v] = el; } });
      return el;
    },
    getElementById: (id) => (reg[id] || (reg[id] = makeNode(id))),
    querySelectorAll: () => [],
  };
  const fetchCalls = [];
  // stateful key store so a GET after a PUT/DELETE reflects the mutation (as the
  // real backend would) — the optimistic-then-reconcile path needs server truth.
  let keyState = opts.key !== undefined ? opts.key : { configured: false, masked: null, source: null };
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
      if (/\/settings\/llm-key\/test$/.test(url)) return J(200, { ok: opts.testOk !== false, detail: opts.testOk === false ? "invalid key" : "ok" });
      if (/\/settings\/llm-key$/.test(url)) {
        if (method === "PUT") {
          if (opts.failPut) return J(500, {});
          keyState = { configured: true, masked: "sk-...wxyz", source: "db" };
          return J(200, keyState);
        }
        if (method === "DELETE") {
          keyState = { configured: false, masked: null, source: null };
          return J(200, keyState);
        }
        return J(200, keyState);      // GET reflects the latest mutation
      }
      if (/\/api\/containers$/.test(url)) return J(200, [{ id: "c1", status: "active", name: "X" }]);
      if (/\/api\/containers\/c1$/.test(url)) return J(200, { container: { id: "c1", name: "X", status: "active" }, agents: [], tasks: [], requests: [] });
      return J(200, {});
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox, { filename: "app.js" });
  vm.runInContext(DATA_JS, sandbox, { filename: "data.js" });
  // capture the page render fn WITHOUT starting the real poll/EventSource loop,
  // and resolve the cid synchronously so init() doesn't depend on the snapshot.
  const cap = { render: null };
  sandbox.window.OrchaData.start = (render) => { cap.render = render; };
  sandbox.window.OrchaData.resolveCid = () => Promise.resolve("c1");
  vm.runInContext(SETTINGS_JS, sandbox, { filename: "settings.js" });
  // PR #315: every key mutation is human-gated (actor_agent_id required). Seed an
  // acting human by default so the mutation paths fire; opts.noHuman exercises the gate.
  if (!opts.noHuman) sandbox.window.Orcha.applySnapshot({
    container: { id: "c1", name: "X", status: "active" },
    agents: [{ id: "h-kedar", alias: "Kedar", kind: "human" }],
  });
  return { Orcha: sandbox.window.Orcha, OrchaData: sandbox.window.OrchaData,
    OrchaSettings: sandbox.window.OrchaSettings, reg, fetchCalls, cap,
    apply: (s) => sandbox.window.Orcha.applySnapshot(s), ORCHA: () => sandbox.window.ORCHA };
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

// ---- faithful LIVE-DOM harness for the keyCard subtree ---------------------
// The stub above can't catch the Gate bug: its querySelectorAll() returns [] (so
// app.js's input-guard never fires) and getElementById() returns a STABLE node (so a
// typed value survives an innerHTML swap for free). This harness models the two real
// browser semantics that matter: (1) keyCard.querySelectorAll("input,textarea")
// returns the LIVE child inputs (so inputActiveWithin() actually sees a typed draft and
// defers a non-forced patch), and (2) setting keyCard.innerHTML REPLACES the child
// nodes — a fresh #keyInput starts empty, so a value only survives if the code restores
// it via the .value property. The known control ids settings.js renders:
const CONTROL_IDS = ["keyInput", "keySave", "keyTest", "keyClear", "keyReveal", "keyHint", "keyRetry"];
function makeLiveSandbox(opts) {
  opts = opts || {};
  const reg = {};            // general auto-create registry (shell ids etc.)
  let children = {};         // current keyCard child control nodes (rebuilt on innerHTML set)

  function mkInput(id) {
    const n = makeNode(id);
    n.tagName = "INPUT"; n.type = "password"; n.value = "";
    return n;
  }

  const keyCard = makeNode("keyCard");
  Object.defineProperty(keyCard, "innerHTML", {
    get() { return keyCard._html; },
    set(v) {
      keyCard._html = v == null ? "" : String(v);
      const found = new Set();
      let m; const re = /id="([^"]+)"/g;
      while ((m = re.exec(keyCard._html))) found.add(m[1]);
      const next = {};
      for (const id of CONTROL_IDS) {
        if (found.has(id)) next[id] = id === "keyInput" ? mkInput(id) : makeNode(id);
      }
      children = next;       // node replacement: old child nodes (and their values) are gone
    },
  });
  // a real subtree query: only the inputs currently rendered, with their live values
  keyCard.querySelectorAll = (sel) => {
    if (/input|textarea/i.test(sel)) {
      return Object.values(children).filter((n) => n.tagName === "INPUT" || n.tagName === "TEXTAREA");
    }
    return [];
  };
  keyCard.contains = (node) => Object.values(children).indexOf(node) !== -1;

  const documentElement = { setAttribute: () => {}, getAttribute: () => null };
  const document = {
    documentElement, body: makeNode("body"),
    addEventListener: () => {}, activeElement: null,
    createElement: () => {
      const el = makeNode("");
      Object.defineProperty(el, "id", { get() { return el._id || ""; }, set(v) { el._id = v; reg[v] = el; } });
      return el;
    },
    getElementById: (id) => {
      if (id === "keyCard") return keyCard;
      if (CONTROL_IDS.indexOf(id) !== -1) return children[id] || null;  // only if currently rendered
      return reg[id] || (reg[id] = makeNode(id));
    },
    querySelectorAll: () => [],
  };

  const fetchCalls = [];
  let keyState = opts.key !== undefined ? opts.key : { configured: false, masked: null, source: null };
  const sandbox = {
    URLSearchParams, location: { search: "" }, document, console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    EventSource: undefined,
    fetch: (url, init) => {
      const method = (init && init.method) || "GET";
      const body = init && init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, method, body });
      const J = (status, obj) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(obj) });
      if (/\/settings\/llm-key\/test$/.test(url)) return J(200, { ok: opts.testOk !== false, detail: opts.testOk === false ? "invalid key" : "ok" });
      if (/\/settings\/llm-key$/.test(url)) {
        if (method === "PUT") {
          if (opts.failPut) return J(500, {});
          keyState = { configured: true, masked: "sk-...wxyz", source: "db" };
          return J(200, keyState);
        }
        if (method === "DELETE") { keyState = { configured: false, masked: null, source: null }; return J(200, keyState); }
        return J(200, keyState);
      }
      if (/\/api\/containers$/.test(url)) return J(200, [{ id: "c1", status: "active", name: "X" }]);
      if (/\/api\/containers\/c1$/.test(url)) return J(200, { container: { id: "c1", name: "X", status: "active" }, agents: [], tasks: [], requests: [] });
      return J(200, {});
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox, { filename: "app.js" });
  vm.runInContext(DATA_JS, sandbox, { filename: "data.js" });
  sandbox.window.OrchaData.start = () => {};                       // don't start the real poll
  sandbox.window.OrchaData.resolveCid = () => Promise.resolve("c1");
  vm.runInContext(SETTINGS_JS, sandbox, { filename: "settings.js" });
  if (!opts.noHuman) sandbox.window.Orcha.applySnapshot({
    container: { id: "c1", name: "X", status: "active" },
    agents: [{ id: "h-kedar", alias: "Kedar", kind: "human" }],
  });
  return {
    Orcha: sandbox.window.Orcha, fetchCalls,
    keyCard, input: () => children.keyInput, ctrl: (id) => children[id],
    cardHtml: () => keyCard.innerHTML,
  };
}

async function run() {
  console.log("settings_key.test.js — #294 Anthropic API-key surface\n");

  // --- Case 1: pure keyState() view-model ------------------------------------
  {
    console.log("Case 1: keyState() maps GET → mode/editable/canClear");
    const s = makeSandbox();
    const KS = s.OrchaSettings.keyState;
    const db = KS({ configured: true, masked: "sk-...1234", source: "db" });
    assert(db.mode === "db" && db.editable && db.canClear, "source=db → editable + clearable");
    const env = KS({ configured: true, masked: "sk-...beef", source: "env" });
    assert(env.mode === "env" && !env.editable && !env.canClear, "source=env → read-only, not clearable");
    const none = KS({ configured: false, masked: null, source: null });
    assert(none.mode === "none" && none.editable && !none.canClear && !none.configured, "no key → unset, editable, not clearable");
    assert(KS({}).mode === "none", "missing/empty body degrades to 'none', never throws");
  }

  // --- Case 2: pure looksLikeKey() / maskOptimistic() ------------------------
  {
    console.log("\nCase 2: soft key-shape hint + optimistic mask");
    const s = makeSandbox();
    assert(s.OrchaSettings.looksLikeKey("sk-ant-abc123") === true, "sk-ant-… recognized");
    assert(s.OrchaSettings.looksLikeKey("nope") === false, "non-sk-ant rejected (soft hint only)");
    assert(s.OrchaSettings.maskOptimistic("sk-ant-secret7890") === "sk-...7890", "mask shows only the last 4");
    assert(s.OrchaSettings.maskOptimistic("xx") === null, "too-short → null (no fake mask)");
  }

  // --- Case 3: none-state render — warn banner, Save/Test disabled until typed
  {
    console.log("\nCase 3: no key configured → warn banner; Save/Test gated on input");
    const s = makeSandbox({ key: { configured: false, masked: null, source: null } });
    await settle();
    const html = s.reg.keyCard.innerHTML;
    assert(/sc-banner warn/.test(html), "warning banner shown when no key");
    assert(/id="keyInput"/.test(html), "paste field rendered (editable)");
    assert(!/id="keyClear"/.test(html), "no Remove button when nothing is stored");
    assert(s.reg.keySave.disabled === true, "Save disabled with an empty field");
    assert(s.reg.keyTest.disabled === true, "Test disabled with no field + no stored key");
    // type a key → both enable
    s.reg.keyInput.value = "sk-ant-newkey0001";
    s.reg.keyInput._listeners.input();
    assert(s.reg.keySave.disabled === false, "Save enables once a key is typed");
    assert(s.reg.keyTest.disabled === false, "Test enables once a key is typed");
  }

  // --- Case 4: db-state render — masked + Replace + Test + Remove -------------
  {
    console.log("\nCase 4: stored DB key → ok banner, masked, Replace + Remove");
    const s = makeSandbox({ key: { configured: true, masked: "sk-...1234", source: "db" } });
    await settle();
    const html = s.reg.keyCard.innerHTML;
    assert(/sc-banner ok/.test(html), "ok banner for a configured key");
    assert(/sk-\.\.\.1234/.test(html), "masked key (never plaintext) shown");
    assert(/id="keyClear"/.test(html), "Remove button present for a DB key");
    assert(/Replace key/.test(html), "Save button labeled 'Replace key' when one exists");
    // Test is enabled even with an empty field — it can verify the STORED key.
    assert(s.reg.keyTest.disabled === false, "Test enabled (verifies stored key) without typing");
  }

  // --- Case 5: env-state render — read-only, no input/Save/Clear --------------
  {
    console.log("\nCase 5: env key → read-only here; only 'Test stored key'");
    const s = makeSandbox({ key: { configured: true, masked: "sk-...beef", source: "env" } });
    await settle();
    const html = s.reg.keyCard.innerHTML;
    assert(/ORCHA_LLM_API_KEY/.test(html), "names the env var as the source");
    assert(/takes precedence/i.test(html), "env banner states env takes precedence over a stored key (ratified env-override > DB)");
    assert(!/id="keyInput"/.test(html), "no paste field for an env-managed key");
    assert(!/id="keySave"/.test(html) && !/id="keyClear"/.test(html), "no Save/Remove for an env key");
    assert(/id="keyTest"/.test(html), "Test stored key still offered");
  }

  // --- Case 6: SAVE → PUT {api_key}, optimistic, then GET refresh ------------
  {
    console.log("\nCase 6: Save issues PUT with {api_key} and refreshes");
    const s = makeSandbox({ key: { configured: false, masked: null, source: null } });
    await settle();
    s.reg.keyInput.value = "sk-ant-tosave9999";
    s.reg.keyInput._listeners.input();
    s.reg.keySave._listeners.click();
    await settle();
    const put = s.fetchCalls.find((c) => c.method === "PUT" && /\/settings\/llm-key$/.test(c.url));
    assert(!!put, "a PUT to .../settings/llm-key was sent");
    assert(put && put.body && put.body.api_key === "sk-ant-tosave9999", "PUT body carries {api_key} verbatim (Helm's contract)");
    assert(put && put.body && put.body.actor_agent_id === "h-kedar", "PUT body carries actor_agent_id (PR #315 human-gate)");
    assert(/sc-banner ok/.test(s.reg.keyCard.innerHTML), "card flips to configured after save");
    // a refreshing GET follows the save (reconcile from server truth)
    const getsAfterPut = s.fetchCalls.filter((c, i) => c.method === "GET" && /\/settings\/llm-key$/.test(c.url) && i > s.fetchCalls.indexOf(put));
    assert(getsAfterPut.length >= 1, "a GET refresh follows the PUT");
  }

  // --- Case 7: SAVE failure preserves the typed value ------------------------
  {
    console.log("\nCase 7: a failed PUT keeps the user's input (never silently lost)");
    const s = makeSandbox({ key: { configured: false, masked: null, source: null }, failPut: true });
    await settle();
    s.reg.keyInput.value = "sk-ant-willfail";
    s.reg.keyInput._listeners.input();
    s.reg.keySave._listeners.click();
    await settle();
    assert(/id="keyInput"/.test(s.reg.keyCard.innerHTML), "still in editable state after failure");
    assert(!/sc-banner ok/.test(s.reg.keyCard.innerHTML), "did NOT falsely show configured on a failed save");
  }

  // --- Case 8: TEST → POST .../test, result rendered -------------------------
  {
    console.log("\nCase 8: Test posts to .../test and shows the verdict");
    const s = makeSandbox({ key: { configured: false, masked: null, source: null } });
    await settle();
    s.reg.keyInput.value = "sk-ant-totest";
    s.reg.keyInput._listeners.input();
    s.reg.keyTest._listeners.click();
    await settle();
    const t = s.fetchCalls.find((c) => c.method === "POST" && /\/settings\/llm-key\/test$/.test(c.url));
    assert(!!t, "a POST to .../settings/llm-key/test was sent");
    assert(t && t.body && t.body.api_key === "sk-ant-totest", "Test sends the typed key");
    assert(t && t.body && t.body.actor_agent_id === "h-kedar", "Test body carries actor_agent_id (PR #315 human-gate)");
    assert(/sc-result ok/.test(s.reg.keyCard.innerHTML), "a success result is rendered");
  }

  // --- Case 9: TEST stored key (env) omits api_key ---------------------------
  {
    console.log("\nCase 9: Test on an env key omits api_key (verifies the stored key)");
    const s = makeSandbox({ key: { configured: true, masked: "sk-...beef", source: "env" } });
    await settle();
    s.reg.keyTest._listeners.click();
    await settle();
    const t = s.fetchCalls.find((c) => c.method === "POST" && /\/settings\/llm-key\/test$/.test(c.url));
    assert(t && (!t.body || t.body.api_key === undefined), "no api_key in the body → server tests the stored key");
    assert(t && t.body && t.body.actor_agent_id === "h-kedar", "stored-key Test still carries actor_agent_id (PR #315)");
  }

  // --- Case 10: REMOVE → modal → DELETE --------------------------------------
  {
    console.log("\nCase 10: Remove confirms then DELETEs the stored key");
    const s = makeSandbox({ key: { configured: true, masked: "sk-...1234", source: "db" } });
    await settle();
    s.reg.keyClear._listeners.click();              // opens the confirm modal
    assert(!!s.reg.__mp && !!s.reg.__mp._listeners.click, "a confirm modal opened");
    s.reg.__mp._listeners.click();                  // confirm
    await settle();
    const del = s.fetchCalls.find((c) => c.method === "DELETE" && /\/settings\/llm-key$/.test(c.url));
    assert(!!del, "DELETE .../settings/llm-key sent after confirm");
    assert(del && del.body && del.body.actor_agent_id === "h-kedar", "DELETE body carries actor_agent_id (PR #315 human-gate)");
    assert(/sc-banner warn/.test(s.reg.keyCard.innerHTML), "card returns to the unset (warn) state");
  }

  // --- Case 11: app.js nav has the 5th Settings entry + sliders icon ---------
  {
    console.log("\nCase 11: shell nav carries the Settings entry + sliders icon");
    const s = makeSandbox();
    s.apply({ container: { id: "c1", name: "X", status: "active" }, agents: [{ id: "h", alias: "Kedar", kind: "human" }], tasks: [], requests: [] });
    s.Orcha.mountShell("settings", { title: "Settings", ctx: "X" });
    const sb = s.reg.sidebar.innerHTML;
    assert(/href="\/settings"/.test(sb), "a /settings link is in the sidebar nav");
    assert(/href="\/settings"[^>]*class="active"/.test(sb), "the Settings link is active on the settings page");
    assert(s.Orcha.icon("sliders").indexOf("circle") !== -1, "the 'sliders' icon is registered (knobs present)");
  }

  // --- Case 12: REGRESSION (Gate) — typed SAVE flips warn → configured DB state
  // Exercises node replacement + a LIVE input via querySelectorAll, so app.js's
  // background input-guard actually sees the typed draft. Pre-fix this deferred the
  // render: PUT was sent but the card stayed in warn (stillWarn:true, showsOk:false).
  {
    console.log("\nCase 12: [regression] a typed Save flips the card out of warn into the configured DB-key state");
    const s = makeLiveSandbox({ key: { configured: false, masked: null, source: null } });
    await settle();
    assert(/sc-banner warn/.test(s.cardHtml()), "starts in the warn (no-key) state");
    s.input().value = "sk-ant-livesave123";
    s.input()._listeners.input();
    s.ctrl("keySave")._listeners.click();
    await settle();
    const put = s.fetchCalls.find((c) => c.method === "PUT" && /\/settings\/llm-key$/.test(c.url));
    assert(!!put && put.body.api_key === "sk-ant-livesave123", "PUT sent with the typed key");
    assert(/sc-banner ok/.test(s.cardHtml()), "card flipped to the configured (ok) banner — the forced render applied");
    assert(!/sc-banner warn/.test(s.cardHtml()), "card no longer shows the warn banner (Gate's stillWarn:true is fixed)");
  }

  // --- Case 13: REGRESSION (Gate) — typed TEST shows its result AND keeps the draft
  {
    console.log("\nCase 13: [regression] a typed Test renders the verdict and preserves the typed value");
    const s = makeLiveSandbox({ key: { configured: false, masked: null, source: null } });
    await settle();
    s.input().value = "sk-ant-livetest456";
    s.input()._listeners.input();
    s.ctrl("keyTest")._listeners.click();
    await settle();
    const t = s.fetchCalls.find((c) => c.method === "POST" && /\/settings\/llm-key\/test$/.test(c.url));
    assert(!!t && t.body.api_key === "sk-ant-livetest456", "Test POSTed the typed key");
    assert(/sc-result ok/.test(s.cardHtml()), "the test result is rendered (Gate's hidden-result is fixed)");
    assert(s.input() && s.input().value === "sk-ant-livetest456", "the typed key survived node replacement (restored via .value) so it can still be Saved");
  }

  // --- Case 14: REGRESSION (PR #315) — no acting human BLOCKS every mutation ---
  // The merged backend 503/403s a key mutation lacking actor_agent_id. With no human
  // registered, actingHuman() is null → Save/Test/Remove must refuse and fire NO fetch.
  {
    console.log("\nCase 14: [regression] with no acting human, Save/Test/Remove are blocked (no request fired)");
    let warned = 0;
    const s = makeSandbox({ key: { configured: true, masked: "sk-...1234", source: "db" }, noHuman: true });
    const origToast = s.Orcha.toast;
    s.Orcha.toast = (msg, kind) => { if (kind === "warn") warned++; return origToast && origToast(msg, kind); };
    await settle();
    assert(s.Orcha.actingHuman() === null, "precondition: no acting human resolvable");
    const before = s.fetchCalls.length;
    // SAVE: type a key, click Save → must NOT PUT
    s.reg.keyInput.value = "sk-ant-blocked0001";
    s.reg.keyInput._listeners.input();
    s.reg.keySave._listeners.click();
    await settle();
    assert(!s.fetchCalls.some((c) => c.method === "PUT"), "Save fired NO PUT without an acting human");
    // TEST: click Test → must NOT POST
    s.reg.keyTest._listeners.click();
    await settle();
    assert(!s.fetchCalls.some((c) => c.method === "POST" && /\/test$/.test(c.url)), "Test fired NO POST without an acting human");
    // REMOVE: click Remove → must NOT even open the modal / DELETE
    s.reg.keyClear._listeners.click();
    await settle();
    assert(!s.fetchCalls.some((c) => c.method === "DELETE"), "Remove fired NO DELETE without an acting human");
    assert(s.fetchCalls.length === before, "no new request of any kind was issued while blocked");
    assert(warned >= 1, "the operator was warned to pick an acting human");
  }

  // --- Case 15: REGRESSION (Gate) — STATIC settings.html lead reflects env-override > DB
  // The page's own static lead copy (not just the settings.js env banner) must match the
  // ratified precedence (merged #315/#316): env wins, a stored key is the fallback. It must
  // NOT claim the stored key overrides env (the original backwards copy).
  {
    console.log("\nCase 15: [regression] static settings.html lead states env takes precedence (stored is fallback)");
    const html = fs.readFileSync(path.join(PORTAL, "settings.html"), "utf8");
    const lead = (html.match(/<div class="lead">[\s\S]*?<\/div>/) || [""])[0];
    assert(/ORCHA_LLM_API_KEY/.test(lead), "lead names the env var");
    assert(/takes\s+precedence/i.test(lead), "lead states the env variable takes precedence");
    assert(/only when no env key is present|fallback/i.test(lead), "lead frames the stored key as the fallback (used only when no env key)");
    assert(!/key set here overrides the/i.test(lead) && !/A key set here overrides/i.test(lead),
      "lead does NOT claim a key set here overrides env (the backwards copy)");
  }

  console.log("\n" + (failures ? "✗ " + failures + " failing assertion(s)" : "✓ all settings_key assertions passed"));
  process.exit(failures ? 1 : 0);
}
run();
