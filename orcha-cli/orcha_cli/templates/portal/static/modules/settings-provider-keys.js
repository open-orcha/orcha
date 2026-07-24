/* Settings page module: per-provider save/test/clear controls and key cards. */
/* ====================================================================== *
 *  Per-provider API keys (multi-provider, follow-on to #294 Item 1)      *
 *  One card per AVAILABLE non-Anthropic catalog provider (e.g. xAI/Grok),*
 *  mirroring the Anthropic card above but wired to the provider-scoped    *
 *  routes so a use-case set to xAI has somewhere to put an xAI key:       *
 *    GET    .../settings/provider-keys                  -> [{provider,…}] *
 *    PUT    .../settings/provider-keys/{provider} {api_key}              *
 *    DELETE .../settings/provider-keys/{provider}                        *
 *    POST   .../settings/provider-keys/{provider}/test {api_key?}        *
 *  Anthropic keeps its own dedicated card above; this lists the rest.     *
 * ====================================================================== */
let PKEYS = null;        // [{provider,name,…keyState view-model}] or null until loaded
let pkErr = false;
const pkBusy = {};       // provider -> mutation in flight
const pkTest = {};       // provider -> {ok,detail} last test verdict

function pkUrl(provider, suffix) {
  return "/api/containers/" + encodeURIComponent(CID) +
         "/settings/provider-keys/" + encodeURIComponent(provider) + (suffix || "");
}

async function loadProviderKeys() {
  if (!CID) return;
  pkErr = false;
  const res = await api("GET", "/api/containers/" + encodeURIComponent(CID) + "/settings/provider-keys");
  if (res.ok && res.body && Array.isArray(res.body.keys)) {
    // Anthropic has its own dedicated card above; render every OTHER available provider here.
    PKEYS = res.body.keys.filter((k) => k.provider !== "anthropic").map((k) => {
      const vmodel = keyState(k); vmodel.provider = k.provider; vmodel.name = k.name; return vmodel;
    });
  } else { PKEYS = null; pkErr = true; }
  renderProviderKeys();
}

function pkField(provider) {
  const el = $("pk-input-" + provider);
  return el ? (el.value || "").trim() : "";
}

function pkCardHtml(k) {
  const p = k.provider, nm = SetEsc(k.name);
  const banner =
    k.mode === "db"
      ? `<div class="sc-banner ok"><div class="bt">${SetIcon("check", "")}<span><b>${nm} API key configured</b> — stored encrypted on this workspace.</span></div><code class="masked">${SetEsc(k.masked || "sk-…")}</code></div>`
      : k.mode === "env"
      ? `<div class="sc-banner ok"><div class="bt">${SetIcon("shield", "")}<span><b>Using <code>ORCHA_LLM_API_KEY</code> from the environment</b> — it takes precedence; read-only here.</span></div><code class="masked">${SetEsc(k.masked || "sk-…")}</code></div>`
      : `<div class="sc-banner warn"><div class="bt">${SetIcon("bell", "")}<span><b>No ${nm} API key configured.</b> Use-cases set to ${nm} are off until you add one.</span></div></div>`;
  const editor = k.editable
    ? `<div class="sc-row">
         <input id="pk-input-${SetEsc(p)}" class="sc-inp" type="password" spellcheck="false" autocomplete="off"
                placeholder="${k.mode === "db" ? "Paste a new key to replace…" : "Paste " + nm + " API key…"}">
         <button class="iconbtn" id="pk-reveal-${SetEsc(p)}" type="button" title="Show / hide">${SetIcon("search", "")}</button>
       </div>
       <div class="sc-acts">
         <button class="btn sm" id="pk-save-${SetEsc(p)}" disabled>${SetIcon("check", "")}${k.mode === "db" ? "Replace key" : "Save key"}</button>
         <button class="btn sm ghost" id="pk-test-${SetEsc(p)}" disabled>${SetIcon("spark", "")}Test</button>
         ${k.canClear ? `<button class="btn sm danger" id="pk-clear-${SetEsc(p)}">${SetIcon("x", "")}Remove</button>` : ""}
       </div>`
    : `<div class="sc-acts"><button class="btn sm ghost" id="pk-test-${SetEsc(p)}">${SetIcon("spark", "")}Test stored key</button></div>
       <div class="sc-hint">To change an environment key, update <code>ORCHA_LLM_API_KEY</code> and relaunch with <code>orcha up</code>.</div>`;
  const tr = pkTest[p];
  const result = tr
    ? `<div class="sc-result ${tr.ok ? "ok" : "err"}">${SetIcon(tr.ok ? "check" : "x", "")}<span>${SetEsc(tr.ok ? ("Key is valid — " + k.name + " accepted it.") : (tr.detail || "Key was rejected."))}</span></div>`
    : "";
  return `<div class="pk-card" data-provider="${SetEsc(p)}">${banner}${editor}${result}</div>`;
}

function renderProviderKeys(force) {
  const host = $("providerKeys");
  if (!host) return;
  if (pkErr) {
    O.patch(host, `<div class="sc-banner err"><div class="bt">${SetIcon("x", "")}<span>Couldn't load provider keys.</span></div><button class="btn sm ghost" id="pkRetry">Retry</button></div>`, force);
    const rb = $("pkRetry"); if (rb) rb.addEventListener("click", loadProviderKeys);
    return;
  }
  if (!PKEYS) {
    O.patch(host, `<div class="sc-banner muted"><div class="bt">${SetIcon("clock", "")}<span>Checking provider keys…</span></div></div>`, force);
    return;
  }
  if (!PKEYS.length) { O.patch(host, `<div class="sc-hint">No additional providers are available yet.</div>`, force); return; }
  O.patch(host, PKEYS.map(pkCardHtml).join(""), force);
  wireProviderKeys();
}

// explicit render after a user action; restores the typed draft onto the fresh input node.
function renderPKForce(provider, keepDraft) {
  const draft = keepDraft ? pkField(provider) : "";
  renderProviderKeys(true);
  if (draft) { const el = $("pk-input-" + provider); if (el) el.value = draft; }
  syncPK();
}

function syncPK() {
  (PKEYS || []).forEach((k) => {
    const p = k.provider, v = pkField(p), has = v.length > 0;
    const save = $("pk-save-" + p), test = $("pk-test-" + p);
    if (save) save.disabled = !!pkBusy[p] || !has;
    if (test) test.disabled = !!pkBusy[p] || (k.editable && !has && !k.configured);
  });
}

function wireProviderKeys() {
  (PKEYS || []).forEach((k) => {
    const p = k.provider;
    const input = $("pk-input-" + p), test = $("pk-test-" + p), clear = $("pk-clear-" + p),
          reveal = $("pk-reveal-" + p), save = $("pk-save-" + p);
    if (input) input.addEventListener("input", () => { pkTest[p] = null; syncPK(); });
    else if (test) test.disabled = !!pkBusy[p];
    if (reveal && input) reveal.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
    });
    if (save) save.addEventListener("click", () => doSavePK(p));
    if (test) test.addEventListener("click", () => doTestPK(p));
    if (clear) clear.addEventListener("click", () => doClearPK(p));
  });
  syncPK();
}

async function doSavePK(p) {
  const v = pkField(p);
  if (!v || pkBusy[p]) return;
  if (!requireHuman("save")) return;
  const who = actingHuman();
  pkBusy[p] = true; renderPKForce(p, true);
  const res = await api("PUT", pkUrl(p), { api_key: v, actor_agent_id: who && who.id });
  pkBusy[p] = false;
  if (res.ok) { O.toast("API key saved.", "ok"); pkTest[p] = null; loadProviderKeys(); }
  else { O.toast("Couldn't save the key (" + res.status + "). Your input is preserved.", "danger"); renderPKForce(p, true); }
}

async function doTestPK(p) {
  if (pkBusy[p]) return;
  const v = pkField(p);
  if (!requireHuman("test")) return;
  const who = actingHuman();
  pkBusy[p] = true; pkTest[p] = null; renderPKForce(p, true);
  const res = await api("POST", pkUrl(p, "/test"),
    v ? { api_key: v, actor_agent_id: who && who.id } : { actor_agent_id: who && who.id });
  pkBusy[p] = false;
  pkTest[p] = (res.ok && res.body) ? { ok: !!res.body.ok, detail: res.body.detail }
                                   : { ok: false, detail: "Test failed (" + res.status + ")." };
  renderPKForce(p, true);
}

function doClearPK(p) {
  if (pkBusy[p]) return;
  if (!requireHuman("remove")) return;
  O.modal({
    title: "Remove API key", danger: true, primary: "Remove key",
    desc: "Deletes the stored key for this provider from this workspace. If ORCHA_LLM_API_KEY is set in the environment, the client falls back to it.",
    onPrimary: async () => {
      const who = actingHuman();
      pkBusy[p] = true; renderPKForce(p, true);
      const res = await api("DELETE", pkUrl(p), { actor_agent_id: who && who.id });
      pkBusy[p] = false; O.closeModal();
      if (res.ok) { O.toast("API key removed.", "ok"); pkTest[p] = null; loadProviderKeys(); }
      else { O.toast("Couldn't remove the key (" + res.status + ").", "danger"); renderPKForce(p, true); }
    },
  });
}
