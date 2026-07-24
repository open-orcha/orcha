/* Settings page module: provider catalog, use-case overrides, and save/reset controls. */
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
    return `<option value="${SetEsc(p.id)}"${dis}${sel}>${SetEsc(label)}</option>`;
  }).join("");
}

// Model <option>s for the selected provider. If the stored model isn't in the catalog (retired
// provider/model), inject it so the choice is never silently lost (§4) and flag it on the row.
function modelOptions(sel) {
  const models = modelsForProvider(CATALOG, sel.provider).slice();
  if (sel.model && !models.some((m) => m.id === sel.model)) {
    models.unshift({ id: sel.model, name: sel.model + " (unavailable)" });
  }
  if (!models.length) return `<option value="${SetEsc(sel.model || "")}" selected>${SetEsc(sel.model || "—")}</option>`;
  return models.map((m) =>
    `<option value="${SetEsc(m.id)}"${m.id === sel.model ? " selected" : ""}>${SetEsc(m.name)}</option>`).join("");
}

function rowHtml(uc) {
  const sel = staged[uc.key] || currentSel(uc);
  const overridden = isOverride(sel, uc);
  const provAvail = (CATALOG || []).some((p) => p.id === sel.provider && p.available);
  const defModels = modelsForProvider(CATALOG, sel.provider);
  const retired = !!sel.model && provAvail && !defModels.some((m) => m.id === sel.model);
  return `<div class="uc-row" data-key="${SetEsc(uc.key)}">
    <div class="uc-title">${SetEsc(uc.label)}</div>
    <div class="uc-purpose">${SetEsc(uc.purpose)}</div>
    <div class="uc-controls">
      <label class="uc-sel"><span>Provider</span>
        <select class="uc-prov" data-key="${SetEsc(uc.key)}">${providerOptions(sel.provider)}</select></label>
      <label class="uc-sel"><span>Model</span>
        <select class="uc-model" data-key="${SetEsc(uc.key)}"${defModels.length || retired ? "" : " disabled"}>${modelOptions(sel)}</select></label>
      <span class="uc-default">default: ${SetEsc(uc.default_model)}</span>
    </div>
    <div class="uc-foot">
      <span class="uc-dot ${overridden ? "on" : "off"}"></span>
      <span class="uc-state-txt">${overridden ? "set to " + SetEsc(sel.model) : "using shipped default"}</span>
      <button class="btn sm ghost uc-reset" data-key="${SetEsc(uc.key)}"${overridden ? "" : " disabled"}>${SetIcon("x", "")}Reset to default</button>
    </div>
    ${retired ? `<div class="uc-note">This stored model is no longer in the catalog — it'll fall back to the default until you pick a current one.</div>` : ""}
  </div>`;
}

function renderModels(force) {
  const host = $("modelRows");
  if (!host) return;
  if (mdlErr) {
    O.patch(host, `<div class="sc-banner err">
      <div class="bt">${SetIcon("x", "")}<span>Couldn't load the model settings.</span></div>
      <button class="btn sm ghost" id="mdlRetry">Retry</button></div>`, force);
    const rb = $("mdlRetry"); if (rb) rb.addEventListener("click", loadModels);
    return;
  }
  if (!MODELS || !CATALOG) {
    O.patch(host, `<div class="sc-banner muted"><div class="bt">${SetIcon("clock", "")}<span>Loading models…</span></div></div>`, force);
    return;
  }
  const rows = MODELS.map(rowHtml).join("");
  const dirty = anyDirty();
  const savebar = `<div class="set-savebar">
    <button class="btn sm" id="mdlSave"${dirty && !mdlBusy ? "" : " disabled"}>${SetIcon("check", "")}Save changes</button>
    ${dirty ? `<button class="btn sm ghost" id="mdlDiscard"${mdlBusy ? " disabled" : ""}>Discard</button>` : ""}
    ${saveErr ? `<span class="set-err">Couldn't save — retry (your edits are kept).</span>`
              : (!dirty ? `<span class="saved">${SetIcon("check", "")}all saved</span>` : "")}</div>`;
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
