/* Settings compatibility controller: preserves the historical standalone entrypoint while the
   browser route uses the focused settings modules loaded before this file. */
(function () {
  if (window.OrchaSettings) return;
  const O = window.Orcha;
  const $ = (id) => document.getElementById(id);
  let cid = null;
  let key = null;
  let keyBusy = false;
  let keyResult = null;
  let models = null;
  let catalog = null;
  const staged = {};

  function keyState(data) {
    data = data || {};
    const source = data.source === "db" || data.source === "env" ? data.source : null;
    const mode = source || "none";
    return {
      mode,
      configured: source != null || data.configured === true,
      masked: data.masked || null,
      editable: mode !== "env",
      canClear: mode === "db",
    };
  }
  function looksLikeKey(value) {
    return typeof value === "string" && /^sk-ant-\S+/.test(value.trim());
  }
  function maskOptimistic(value) {
    value = (value || "").trim();
    return value.length < 4 ? null : "sk-..." + value.slice(-4);
  }
  function modelsForProvider(list, provider) {
    const found = (list || []).find((item) => item.id === provider);
    return found && found.available ? (found.models || []) : [];
  }
  function currentSel(useCase) {
    return useCase.is_set && useCase.provider && useCase.model
      ? { provider: useCase.provider, model: useCase.model }
      : { provider: useCase.default_provider, model: useCase.default_model };
  }
  function isOverride(selection, useCase) {
    return !!selection &&
      (selection.provider !== useCase.default_provider || selection.model !== useCase.default_model);
  }
  function rowDirty(selection, useCase) {
    const saved = currentSel(useCase);
    return !!selection && (selection.provider !== saved.provider || selection.model !== saved.model);
  }
  function buildOverrides(selections, useCases) {
    return (useCases || []).reduce((rows, useCase) => {
      const selection = selections[useCase.key] || currentSel(useCase);
      if (isOverride(selection, useCase)) {
        rows.push({ key: useCase.key, provider: selection.provider, model: selection.model });
      }
      return rows;
    }, []);
  }
  window.OrchaSettings = {
    keyState, looksLikeKey, maskOptimistic,
    modelsForProvider, currentSel, isOverride, rowDirty, buildOverrides,
  };

  async function api(method, url, body) {
    const options = { method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) options.body = JSON.stringify(body);
    try {
      const response = await fetch(url, options);
      let value = null;
      try { value = await response.json(); } catch (error) {}
      return { ok: response.ok, status: response.status, body: value };
    } catch (error) {
      return { ok: false, status: 0, body: null };
    }
  }
  function human(verb) {
    const actor = O.actingHuman();
    if (!actor) O.toast("Pick an acting human to " + verb + " the key", "warn");
    return actor;
  }
  function keyUrl(suffix) {
    return "/api/containers/" + encodeURIComponent(cid) + "/settings/llm-key" + (suffix || "");
  }
  function fieldValue() {
    const input = $("keyInput");
    return input ? (input.value || "").trim() : "";
  }
  function syncKeyControls() {
    const value = fieldValue();
    const save = $("keySave"), test = $("keyTest"), hint = $("keyHint");
    if (save) save.disabled = keyBusy || !value;
    if (test) test.disabled = keyBusy || (key && key.editable && !value && !key.configured);
    if (hint) hint.textContent = value && !looksLikeKey(value)
      ? 'Heads up: Anthropic keys usually start with "sk-ant-".' : "";
  }
  function renderKey(force, draft) {
    const host = $("keyCard");
    if (!host || !key) return;
    const banner = key.mode === "db"
      ? `<div class="sc-banner ok">Anthropic API key configured <code>${O.esc(key.masked || "sk-…")}</code></div>`
      : key.mode === "env"
        ? `<div class="sc-banner ok">Using <code>ORCHA_LLM_API_KEY</code>; it takes precedence over any stored key.</div>`
        : '<div class="sc-banner warn">No Anthropic API key configured.</div>';
    const editor = key.editable
      ? `<input id="keyInput" type="password"><button id="keyReveal">Show</button>
         <div id="keyHint"></div><button id="keySave">${key.mode === "db" ? "Replace key" : "Save key"}</button>
         <button id="keyTest">Test</button>${key.canClear ? '<button id="keyClear">Remove</button>' : ""}`
      : '<button id="keyTest">Test stored key</button>';
    const result = keyResult
      ? `<div class="sc-result ${keyResult.ok ? "ok" : "err"}">${O.esc(keyResult.ok ? "Key is valid." : (keyResult.detail || "Key was rejected."))}</div>`
      : "";
    O.patch(host, banner + editor + result, force);
    const input = $("keyInput"), reveal = $("keyReveal"), save = $("keySave");
    const test = $("keyTest"), clear = $("keyClear");
    if (input && draft) input.value = draft;
    if (input) input.addEventListener("input", () => { keyResult = null; syncKeyControls(); });
    if (reveal && input) reveal.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
    });
    if (save) save.addEventListener("click", saveKey);
    if (test) test.addEventListener("click", testKey);
    if (clear) clear.addEventListener("click", clearKey);
    syncKeyControls();
  }
  async function loadKey() {
    if (!cid) return;
    const result = await api("GET", keyUrl());
    key = keyState(result.ok ? result.body : {});
    renderKey();
  }
  async function saveKey() {
    const value = fieldValue(), actor = human("save");
    if (!value || !actor || keyBusy) return;
    keyBusy = true;
    renderKey(true, value);
    const result = await api("PUT", keyUrl(), { api_key: value, actor_agent_id: actor.id });
    keyBusy = false;
    if (!result.ok) {
      O.toast("Couldn't save the key (" + result.status + "). Your input is preserved.", "danger");
      renderKey(true, value);
      return;
    }
    keyResult = null;
    key = keyState(result.body || { source: "db", configured: true, masked: maskOptimistic(value) });
    renderKey(true);
    loadKey();
  }
  async function testKey() {
    const value = fieldValue(), actor = human("test");
    if (!actor || keyBusy) return;
    keyBusy = true;
    renderKey(true, value);
    const body = value ? { api_key: value, actor_agent_id: actor.id } : { actor_agent_id: actor.id };
    const result = await api("POST", keyUrl("/test"), body);
    keyBusy = false;
    keyResult = result.ok && result.body
      ? { ok: !!result.body.ok, detail: result.body.detail }
      : { ok: false, detail: "Test failed (" + result.status + ")." };
    renderKey(true, value);
  }
  function clearKey() {
    const actor = human("remove");
    if (!actor || keyBusy) return;
    O.modal({
      title: "Remove API key",
      primary: "Remove key",
      onPrimary: async () => {
        keyBusy = true;
        const result = await api("DELETE", keyUrl(), { actor_agent_id: actor.id });
        keyBusy = false;
        O.closeModal();
        if (result.ok) {
          keyResult = null;
          key = keyState(result.body || {});
          renderKey(true);
          loadKey();
        }
      },
    });
  }

  function renderModels() {
    const host = $("modelRows");
    if (!host || !models || !catalog) return;
    const rows = models.map((useCase) => {
      const selection = staged[useCase.key] || currentSel(useCase);
      const state = isOverride(selection, useCase) ? "set to " + selection.model : "using shipped default";
      return `<div class="uc-row"><div>${O.esc(useCase.label)}</div><div>${O.esc(useCase.purpose)}</div>
        <span>default: ${O.esc(useCase.default_model)}</span><span class="uc-dot ${isOverride(selection, useCase) ? "on" : "off"}"></span>${O.esc(state)}</div>`;
    }).join("");
    O.patch(host, rows, true);
  }
  async function loadModels() {
    if (!cid) return;
    const [modelResult, providerResult] = await Promise.all([
      api("GET", "/api/containers/" + encodeURIComponent(cid) + "/settings/models"),
      api("GET", "/api/containers/" + encodeURIComponent(cid) + "/settings/providers"),
    ]);
    models = modelResult.ok && modelResult.body && Array.isArray(modelResult.body.use_cases)
      ? modelResult.body.use_cases : [];
    catalog = providerResult.ok && providerResult.body && Array.isArray(providerResult.body.providers)
      ? providerResult.body.providers : [];
    models.forEach((useCase) => { staged[useCase.key] = currentSel(useCase); });
    renderModels();
  }
  function renderPairingCard() {
    const host = $("pairingCard");
    if (!host) return;
    O.patch(host, '<button id="settingsPairPhone" type="button">Pair phone</button>', true);
    const button = $("settingsPairPhone");
    if (button) button.addEventListener("click", () => O.openPairingModal());
  }
  window.OrchaData.start(() => {
    if (window.ORCHA && window.ORCHA.container) {
      O.mountShell("settings", { title: "Settings", ctx: window.ORCHA.container.name });
      renderPairingCard();
    }
  });
  (async function init() {
    try { cid = await window.OrchaData.resolveCid(); } catch (error) { return; }
    loadKey();
    loadModels();
  })();
})();
