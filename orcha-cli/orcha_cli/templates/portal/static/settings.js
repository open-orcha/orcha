/* ============================================================================
   Orcha — #294 [SETTINGS] Settings page · Anthropic API-key surface (served at
   /settings). The KEY card only: paste / save / test / clear the container's
   Anthropic key for the universal LLM client (#290). The model-selection rows
   (SPEC-SETTINGS §2) are a co-dependent follow-up blocked on the #290 catalog —
   this task is the key surface SPEC-SETTINGS §4 defers to "#290 key setup".

   Item-1 decisions (Helm-ratified contract): the key is DB-encrypted server-side and
   global-per-container. PRECEDENCE = env-override > DB > none (matches the merged +
   Gate-verified backend read path): when ORCHA_LLM_API_KEY is set in the environment it
   WINS and the GET reports source="env" (the stored DB key is shadowed); otherwise a
   stored DB key is used (source="db"); with neither, source=null. Editable ANYTIME here
   (NOT first-run-only — that's the onboarding wizard).

   Why every mutation is server-side (a browser can't, safely): SAVE must encrypt
   at rest server-side, and TEST must ping Anthropic server-side (a browser can't —
   CORS + key exposure). So the page binds to Helm's ratified routes:
     GET    /api/containers/{cid}/settings/llm-key       -> {configured, masked, source}
     PUT    /api/containers/{cid}/settings/llm-key {api_key} -> {configured, masked}
     DELETE /api/containers/{cid}/settings/llm-key       -> remove (falls back to env)
     POST   /api/containers/{cid}/settings/llm-key/test {api_key?} -> {ok, detail}
   The masked GET (never plaintext) drives the configured-state render.

   Dependency-free, same pure client-side pattern as onboarding.js: resolve the cid
   once on boot, drive the live shell off the 3s snapshot (mountShell), and fetch the
   key status independently so the card never flickers on the poll. Pure view-model
   helpers are exported on window.OrchaSettings for node/vm tests.
   ========================================================================== */
(function () {
  const O = window.Orcha;
  const icon = O.icon, esc = O.esc;

  /* ---- PURE view-model helpers (DOM-free, exported for tests) ----------- *
   * keyState() maps the GET response to the card's render decisions so the
   * three states (none / db / env) and their affordances are unit-testable. */

  // Normalize the {configured, masked, source} GET into a render view-model.
  //  - source "db"  -> configured here, editable, clearable, testable
  //  - source "env" -> configured via environment, READ-ONLY here (can't edit env
  //                    from the browser), still testable
  //  - null/none    -> unset; show the warn banner; editable, not clearable
  function keyState(data) {
    data = data || {};
    const src = data.source === "db" || data.source === "env" ? data.source : null;
    const configured = src != null || data.configured === true;
    const mode = src === "db" ? "db" : src === "env" ? "env" : "none";
    return {
      mode,
      configured,
      masked: data.masked || null,
      editable: mode !== "env",          // env keys are managed outside the portal
      canClear: mode === "db",           // only a DB-stored key can be removed here
    };
  }

  // Soft Anthropic-key shape hint (NOT a hard gate — TEST is the real validation,
  // server-side). Anthropic keys are "sk-ant-…"; we only nudge, never block, so a
  // future key format still saves and the server stays the source of truth.
  function looksLikeKey(s) {
    return typeof s === "string" && /^sk-ant-\S+/.test(s.trim());
  }

  // Optimistic mask for the moment right after a successful PUT, before the GET
  // refresh confirms the server's own masked form. Mirrors "sk-...1234".
  function maskOptimistic(s) {
    s = (s || "").trim();
    if (s.length < 4) return null;
    return "sk-..." + s.slice(-4);
  }

  /* ---- resolved-once container id -------------------------------------- */
  let CID = null;

  /* ---- live key status (independent of the 3s snapshot cadence) -------- */
  let KEY = null;          // last GET view-model, or null until loaded
  let loadErr = false;     // GET failed → show inline retry
  let busy = false;        // a mutation (save/test/clear) is in flight
  let testResult = null;   // {ok, detail} from the last TEST, or null

  const $ = (id) => document.getElementById(id);

  async function api(method, path, body) {
    const init = { method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(path, init);
    let j = null;
    try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, body: j };
  }

  function keyUrl(suffix) {
    return "/api/containers/" + encodeURIComponent(CID) + "/settings/llm-key" + (suffix || "");
  }

  async function loadKey() {
    if (!CID) return;
    loadErr = false;
    const res = await api("GET", keyUrl());
    if (res.ok) { KEY = keyState(res.body); }
    else { KEY = null; loadErr = true; }
    renderKey();
  }

  /* ---- the key card --------------------------------------------------- */
  function fieldValue() {
    const el = $("keyInput");
    return el ? (el.value || "").trim() : "";
  }

  // force=true bypasses app.js patch()'s background input/selection guards — used by
  // the explicit user-triggered renders (see renderKeyForce) so a typed-key Save/Test
  // actually repaints instead of being deferred because #keyInput holds a draft.
  function renderKey(force) {
    const host = $("keyCard");
    if (!host) return;

    if (loadErr) {
      O.patch(host, `<div class="sc-banner err">
        <div class="bt">${icon("x", "")}<span>Couldn't load the API-key status.</span></div>
        <button class="btn sm ghost" id="keyRetry">Retry</button>
      </div>`, force);
      const rb = $("keyRetry"); if (rb) rb.addEventListener("click", loadKey);
      return;
    }
    if (!KEY) {
      O.patch(host, `<div class="sc-banner muted"><div class="bt">${icon("clock", "")}<span>Checking key status…</span></div></div>`, force);
      return;
    }

    const banner =
      KEY.mode === "db"
        ? `<div class="sc-banner ok"><div class="bt">${icon("check", "")}<span><b>Anthropic API key configured</b> — stored encrypted on this workspace.</span></div>
             <code class="masked">${esc(KEY.masked || "sk-…")}</code></div>`
        : KEY.mode === "env"
        ? `<div class="sc-banner ok"><div class="bt">${icon("shield", "")}<span><b>Using <code>ORCHA_LLM_API_KEY</code> from the environment</b> — it takes precedence over any stored key; read-only here.</span></div>
             <code class="masked">${esc(KEY.masked || "sk-…")}</code></div>`
        : `<div class="sc-banner warn"><div class="bt">${icon("bell", "")}<span><b>No Anthropic API key configured.</b> Universal-model features (guided onboarding, wake triage) are off until you add one.</span></div></div>`;

    // env keys are managed outside the portal — no input/Save/Clear, only Test + a note.
    const editor = KEY.editable
      ? `<div class="sc-row">
           <input id="keyInput" class="sc-inp" type="password" spellcheck="false" autocomplete="off"
                  placeholder="${KEY.mode === "db" ? "Paste a new key to replace…" : "sk-ant-…"}">
           <button class="iconbtn" id="keyReveal" type="button" title="Show / hide">${icon("search", "")}</button>
         </div>
         <div class="sc-hint" id="keyHint"></div>
         <div class="sc-acts">
           <button class="btn sm" id="keySave" disabled>${icon("check", "")}${KEY.mode === "db" ? "Replace key" : "Save key"}</button>
           <button class="btn sm ghost" id="keyTest" disabled>${icon("spark", "")}Test</button>
           ${KEY.canClear ? `<button class="btn sm danger" id="keyClear">${icon("x", "")}Remove</button>` : ""}
         </div>`
      : `<div class="sc-acts">
           <button class="btn sm ghost" id="keyTest">${icon("spark", "")}Test stored key</button>
         </div>
         <div class="sc-hint">To change an environment key, update <code>ORCHA_LLM_API_KEY</code> and relaunch with <code>orcha up</code>.</div>`;

    const result = testResult
      ? `<div class="sc-result ${testResult.ok ? "ok" : "err"}">${icon(testResult.ok ? "check" : "x", "")}<span>${esc(testResult.ok ? "Key is valid — Anthropic accepted it." : (testResult.detail || "Key was rejected."))}</span></div>`
      : "";

    O.patch(host, banner + editor + result, force);
    wireKey();
  }

  // An explicit, user-triggered render (Save/Test/Clear and their busy/result phases).
  // It MUST apply even though #keyInput may hold a typed draft — app.js's background
  // input-guard would otherwise defer it (Gate: typed Save PUT-succeeds but the card
  // stays in the warn/edit state; typed Test hides its result). We force the patch,
  // which replaces the input node, then (when keepDraft) restore the draft via the new
  // input's .value PROPERTY — innerHTML carries no value, so a typed key would be lost
  // (e.g. after Test, the operator can still Save the key they just verified).
  function renderKeyForce(keepDraft) {
    const draft = keepDraft ? fieldValue() : "";
    renderKey(true);
    if (draft) {
      const el = $("keyInput");
      if (el) { el.value = draft; syncControls(); }
    }
  }

  // Recompute the Save/Test enabled state + the soft hint from the current field.
  // Module-scoped (not a wireKey closure) so renderKeyForce can re-run it after
  // restoring a draft onto a freshly-rendered input node.
  function syncControls() {
    const v = fieldValue();
    const hasField = v.length > 0;
    const save = $("keySave");
    const test = $("keyTest");
    const hint = $("keyHint");
    // Save needs a pasted value; Test works on the pasted value OR (when none is
    // typed) the stored key — so an operator can verify an existing key in place.
    if (save) save.disabled = busy || !hasField;
    if (test) test.disabled = busy || (KEY && KEY.editable && !hasField && !KEY.configured);
    if (hint) hint.textContent = hasField && !looksLikeKey(v)
      ? "Heads up: Anthropic keys usually start with \"sk-ant-\". Test to confirm."
      : "";
  }

  // The merged Item-1 backend (PR #315) HUMAN-GATES every key mutation: PUT/DELETE
  // and POST .../test require actor_agent_id (a kind=human UUID) in the body and
  // 503/403 without it. Mirror app.js's autonomy switch (app.js:586/614/620/1017):
  // resolve the acting human, and refuse to fire if none is picked.
  function actingHuman() { return O.actingHuman ? O.actingHuman() : null; }
  function requireHuman(verb) {
    if (actingHuman()) return true;
    O.toast("Pick an acting human to " + verb + " the key", "warn");
    return false;
  }

  function wireKey() {
    const input = $("keyInput");
    const test = $("keyTest");
    const clear = $("keyClear");
    const reveal = $("keyReveal");
    const save = $("keySave");

    if (input) {
      input.addEventListener("input", () => { testResult = null; syncControls(); });
      syncControls();
    } else {
      // env mode: no input — Test always enabled (tests the stored env key).
      if (test) test.disabled = busy;
    }
    if (reveal && input) reveal.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
    });
    if (save) save.addEventListener("click", doSave);
    if (test) test.addEventListener("click", doTest);
    if (clear) clear.addEventListener("click", doClear);
  }

  async function doSave() {
    const v = fieldValue();
    if (!v || busy) return;
    if (!requireHuman("save")) return;
    const who = actingHuman();
    busy = true; renderKeyForce(true);
    const res = await api("PUT", keyUrl(), { api_key: v, actor_agent_id: who && who.id });
    busy = false;
    if (res.ok) {
      O.toast("API key saved.", "ok");
      testResult = null;
      // Optimistic, then reconcile from the masked GET (server is the source of truth).
      KEY = keyState({ source: "db", configured: true, masked: (res.body && res.body.masked) || maskOptimistic(v) });
      renderKeyForce(false);   // flip out of warn into the configured DB-key state (drop the draft)
      loadKey();
    } else {
      O.toast("Couldn't save the key (" + res.status + "). Your input is preserved.", "danger");
      renderKeyForce(true);   // keep the typed value — a transient failure never loses it
    }
  }

  async function doTest() {
    if (busy) return;
    const v = fieldValue();
    if (!requireHuman("test")) return;
    const who = actingHuman();
    busy = true; testResult = null; renderKeyForce(true);
    // Send the pasted key if present, else test the stored key (omit api_key).
    // actor_agent_id is always required by the backend (server-side Anthropic ping).
    const res = await api("POST", keyUrl("/test"),
      v ? { api_key: v, actor_agent_id: who && who.id } : { actor_agent_id: who && who.id });
    busy = false;
    if (res.ok && res.body) testResult = { ok: !!res.body.ok, detail: res.body.detail };
    else testResult = { ok: false, detail: "Test failed (" + res.status + ")." };
    renderKeyForce(true);   // show the verdict AND keep the typed key so it can be Saved
  }

  function doClear() {
    if (busy) return;
    if (!requireHuman("remove")) return;
    O.modal({
      title: "Remove API key", danger: true, primary: "Remove key",
      desc: "Deletes the stored key from this workspace. If ORCHA_LLM_API_KEY is set in the environment, the client falls back to it; otherwise universal-model features turn off.",
      onPrimary: async () => {
        const who = actingHuman();
        busy = true; renderKeyForce(true);
        const res = await api("DELETE", keyUrl(), { actor_agent_id: who && who.id });
        busy = false;
        O.closeModal();
        if (res.ok) {
          O.toast("API key removed.", "ok");
          testResult = null;
          KEY = keyState(res.body || { source: null, configured: false });
          renderKeyForce(false);   // return to the unset (warn) state
          loadKey();
        } else {
          O.toast("Couldn't remove the key (" + res.status + ").", "danger");
          renderKeyForce(true);
        }
      },
    });
  }

  /* ====================================================================== *
   *  Per-use-case universal-model selection (SPEC-SETTINGS §2)             *
   *  Renders one row per REGISTERED use-case from GET .../settings/models, *
   *  fed by the GET .../settings/providers catalog (#290 axis, NOT         *
   *  /api/models). Explicit Save: stage locally, one PUT writes the full   *
   *  override set; choosing a row's shipped default = unset that row.       *
   * ====================================================================== */

  /* ---- PURE view-model helpers (DOM-free, exported for node tests) ------ */

  // The selectable models for a provider in the catalog: [] for an unavailable/unknown provider
  // (the row then falls back to its shipped default, read-only — never an empty dropdown, §4).
  function modelsForProvider(catalog, providerId) {
    const p = (catalog || []).find((x) => x.id === providerId);
    return p && p.available ? (p.models || []) : [];
  }

  // The CURRENT selection for a row: the stored override when set, else the shipped default.
  // The dropdowns always show a concrete provider+model — "unset" is represented by the
  // selection equalling the default, so picking the default value resets the row on save.
  function currentSel(uc) {
    return uc.is_set && uc.provider && uc.model
      ? { provider: uc.provider, model: uc.model }
      : { provider: uc.default_provider, model: uc.default_model };
  }

  // A row is OVERRIDDEN (● dot) when its staged selection differs from the shipped default;
  // equal to the default ⇒ ○ "using shipped default" (and it'll be unset on save).
  function isOverride(sel, uc) {
    return !!sel && (sel.provider !== uc.default_provider || sel.model !== uc.default_model);
  }

  // Dirty = the staged selection differs from what's PERSISTED (override if set, else default).
  function rowDirty(sel, uc) {
    const persisted = currentSel(uc);
    return !!sel && (sel.provider !== persisted.provider || sel.model !== persisted.model);
  }

  // Build the PUT body: only overridden rows are sent (default-valued rows are omitted ⇒ reset).
  function buildOverrides(staged, ucs) {
    const out = [];
    (ucs || []).forEach((uc) => {
      const sel = staged[uc.key] || currentSel(uc);
      if (isOverride(sel, uc)) out.push({ key: uc.key, provider: sel.provider, model: sel.model });
    });
    return out;
  }

  /* ---- live model-settings state -------------------------------------- */
  let MODELS = null;       // GET /settings/models -> [{key,label,purpose,provider,model,default_*,is_set}]
  let CATALOG = null;      // GET /settings/providers -> [{id,name,available,models:[{id,name}]}]
  let mdlErr = false;      // a GET failed -> inline retry
  let mdlBusy = false;     // a PUT is in flight
  let saveErr = false;     // last PUT failed -> savebar error (edits preserved)
  const staged = {};       // key -> {provider, model} currently selected in the dropdowns

  function anyDirty() {
    if (!MODELS) return false;
    return MODELS.some((uc) => rowDirty(staged[uc.key], uc));
  }

  async function loadModels() {
    if (!CID) return;
    mdlErr = false;
    const [m, p] = await Promise.all([
      api("GET", "/api/containers/" + encodeURIComponent(CID) + "/settings/models"),
      api("GET", "/api/containers/" + encodeURIComponent(CID) + "/settings/providers"),
    ]);
    if (m.ok && m.body && Array.isArray(m.body.use_cases) && p.ok && p.body) {
      MODELS = m.body.use_cases;
      CATALOG = p.body.providers || [];
      // reset staging to the persisted selection
      Object.keys(staged).forEach((k) => delete staged[k]);
      MODELS.forEach((uc) => { staged[uc.key] = currentSel(uc); });
    } else {
      MODELS = null; CATALOG = null; mdlErr = true;
    }
    renderModels();
  }

  // Provider <option>s: every catalog provider, stubbed ones disabled ("coming soon") — honest,
  // never a dead option (§2.1). The currently-selected provider is always present + selected.
  function providerOptions(selProvider) {
    return (CATALOG || []).map((p) => {
      const label = p.name + (p.available ? "" : " (coming soon)");
      const dis = p.available ? "" : " disabled";
      const sel = p.id === selProvider ? " selected" : "";
      return `<option value="${esc(p.id)}"${dis}${sel}>${esc(label)}</option>`;
    }).join("");
  }

  // Model <option>s for the selected provider. If the stored model isn't in the catalog (retired
  // provider/model), inject it so the choice is never silently lost (§4) and flag it on the row.
  function modelOptions(sel) {
    const models = modelsForProvider(CATALOG, sel.provider).slice();
    if (sel.model && !models.some((m) => m.id === sel.model)) {
      models.unshift({ id: sel.model, name: sel.model + " (unavailable)" });
    }
    if (!models.length) return `<option value="${esc(sel.model || "")}" selected>${esc(sel.model || "—")}</option>`;
    return models.map((m) =>
      `<option value="${esc(m.id)}"${m.id === sel.model ? " selected" : ""}>${esc(m.name)}</option>`).join("");
  }

  function rowHtml(uc) {
    const sel = staged[uc.key] || currentSel(uc);
    const overridden = isOverride(sel, uc);
    const provAvail = (CATALOG || []).some((p) => p.id === sel.provider && p.available);
    const defModels = modelsForProvider(CATALOG, sel.provider);
    const retired = !!sel.model && provAvail && !defModels.some((m) => m.id === sel.model);
    return `<div class="uc-row" data-key="${esc(uc.key)}">
      <div class="uc-title">${esc(uc.label)}</div>
      <div class="uc-purpose">${esc(uc.purpose)}</div>
      <div class="uc-controls">
        <label class="uc-sel"><span>Provider</span>
          <select class="uc-prov" data-key="${esc(uc.key)}">${providerOptions(sel.provider)}</select></label>
        <label class="uc-sel"><span>Model</span>
          <select class="uc-model" data-key="${esc(uc.key)}"${defModels.length || retired ? "" : " disabled"}>${modelOptions(sel)}</select></label>
        <span class="uc-default">default: ${esc(uc.default_model)}</span>
      </div>
      <div class="uc-foot">
        <span class="uc-dot ${overridden ? "on" : "off"}"></span>
        <span class="uc-state-txt">${overridden ? "set to " + esc(sel.model) : "using shipped default"}</span>
        <button class="btn sm ghost uc-reset" data-key="${esc(uc.key)}"${overridden ? "" : " disabled"}>${icon("x", "")}Reset to default</button>
      </div>
      ${retired ? `<div class="uc-note">This stored model is no longer in the catalog — it'll fall back to the default until you pick a current one.</div>` : ""}
    </div>`;
  }

  function renderModels(force) {
    const host = $("modelRows");
    if (!host) return;
    if (mdlErr) {
      O.patch(host, `<div class="sc-banner err">
        <div class="bt">${icon("x", "")}<span>Couldn't load the model settings.</span></div>
        <button class="btn sm ghost" id="mdlRetry">Retry</button></div>`, force);
      const rb = $("mdlRetry"); if (rb) rb.addEventListener("click", loadModels);
      return;
    }
    if (!MODELS || !CATALOG) {
      O.patch(host, `<div class="sc-banner muted"><div class="bt">${icon("clock", "")}<span>Loading models…</span></div></div>`, force);
      return;
    }
    const rows = MODELS.map(rowHtml).join("");
    const dirty = anyDirty();
    const savebar = `<div class="set-savebar">
      <button class="btn sm" id="mdlSave"${dirty && !mdlBusy ? "" : " disabled"}>${icon("check", "")}Save changes</button>
      ${dirty ? `<button class="btn sm ghost" id="mdlDiscard"${mdlBusy ? " disabled" : ""}>Discard</button>` : ""}
      ${saveErr ? `<span class="set-err">Couldn't save — retry (your edits are kept).</span>`
                : (!dirty ? `<span class="saved">${icon("check", "")}all saved</span>` : "")}</div>`;
    O.patch(host, `<div class="uc-list">${rows}</div>${savebar}`, force);
    wireModels();
  }

  // explicit user-triggered render (Save/Discard/select changes) — bypass the input guard.
  function renderModelsForce() { renderModels(true); }

  function wireModels() {
    document.querySelectorAll(".uc-prov").forEach((s) => s.addEventListener("change", onProviderChange));
    document.querySelectorAll(".uc-model").forEach((s) => s.addEventListener("change", onModelChange));
    document.querySelectorAll(".uc-reset").forEach((b) => b.addEventListener("click", onReset));
    const save = $("mdlSave"); if (save) save.addEventListener("click", doSaveModels);
    const disc = $("mdlDiscard"); if (disc) disc.addEventListener("click", () => {
      MODELS.forEach((uc) => { staged[uc.key] = currentSel(uc); });
      saveErr = false; renderModelsForce();
    });
  }

  function ucByKey(key) { return (MODELS || []).find((u) => u.key === key); }

  function onProviderChange(e) {
    const key = e.target.getAttribute("data-key");
    const uc = ucByKey(key); if (!uc) return;
    const provider = e.target.value;
    // re-scope the model: keep it if still valid, else the provider's first model (or the default
    // when this provider is the default's provider), else blank.
    const models = modelsForProvider(CATALOG, provider);
    const cur = staged[key] || currentSel(uc);
    let model = cur.model;
    if (!models.some((m) => m.id === model)) {
      model = provider === uc.default_provider ? uc.default_model : (models[0] ? models[0].id : "");
    }
    staged[key] = { provider, model };
    saveErr = false; renderModelsForce();
  }

  function onModelChange(e) {
    const key = e.target.getAttribute("data-key");
    const uc = ucByKey(key); if (!uc) return;
    const cur = staged[key] || currentSel(uc);
    staged[key] = { provider: cur.provider, model: e.target.value };
    saveErr = false; renderModelsForce();
  }

  function onReset(e) {
    const key = e.target.getAttribute("data-key");
    const uc = ucByKey(key); if (!uc) return;
    staged[key] = { provider: uc.default_provider, model: uc.default_model };
    saveErr = false; renderModelsForce();
  }

  async function doSaveModels() {
    if (mdlBusy || !anyDirty()) return;
    if (!requireHuman("change models")) return;
    const who = actingHuman();
    mdlBusy = true; saveErr = false; renderModelsForce();
    const overrides = buildOverrides(staged, MODELS);
    const res = await api("PUT", "/api/containers/" + encodeURIComponent(CID) + "/settings/models",
      { actor_agent_id: who && who.id, use_cases: overrides });
    mdlBusy = false;
    if (res.ok && res.body && Array.isArray(res.body.use_cases)) {
      O.toast("Model settings saved.", "ok");
      MODELS = res.body.use_cases;
      Object.keys(staged).forEach((k) => delete staged[k]);
      MODELS.forEach((uc) => { staged[uc.key] = currentSel(uc); });   // reconcile to server truth
      renderModelsForce();
    } else {
      saveErr = true;
      O.toast("Couldn't save model settings (" + res.status + "). Your edits are kept.", "danger");
      renderModelsForce();   // preserve staged edits — a transient failure never loses them
    }
  }

  /* ---- boot: live shell off the snapshot; key status fetched once ------ */
  let booted = false;
  function render() {
    if (!window.ORCHA || !window.ORCHA.container) return;
    O.mountShell("settings", { title: "Settings", ctx: window.ORCHA.container.name });
  }
  window.OrchaData.start(() => {
    render();
    if (!booted) { booted = true; renderKey(); renderModels(); }   // paint loading cards once the shell exists
  }, 3000);

  (async function init() {
    try { CID = await window.OrchaData.resolveCid(); } catch (e) {}
    loadKey();
    loadModels();
  })();

  // expose the pure view-model helpers for node tests
  window.OrchaSettings = {
    keyState, looksLikeKey, maskOptimistic,
    modelsForProvider, currentSel, isOverride, rowDirty, buildOverrides,
  };
})();
