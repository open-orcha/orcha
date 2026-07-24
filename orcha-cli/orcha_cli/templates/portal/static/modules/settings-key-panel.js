/* Settings page module: API-key card rendering, mutations, and phone pairing entry. */
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
      <div class="bt">${SetIcon("x", "")}<span>Couldn't load the API-key status.</span></div>
      <button class="btn sm ghost" id="keyRetry">Retry</button>
    </div>`, force);
    const rb = $("keyRetry"); if (rb) rb.addEventListener("click", loadKey);
    return;
  }
  if (!KEY) {
    O.patch(host, `<div class="sc-banner muted"><div class="bt">${SetIcon("clock", "")}<span>Checking key status…</span></div></div>`, force);
    return;
  }

  const banner =
    KEY.mode === "db"
      ? `<div class="sc-banner ok"><div class="bt">${SetIcon("check", "")}<span><b>Anthropic API key configured</b> — stored encrypted on this workspace.</span></div>
           <code class="masked">${SetEsc(KEY.masked || "sk-…")}</code></div>`
      : KEY.mode === "env"
      ? `<div class="sc-banner ok"><div class="bt">${SetIcon("shield", "")}<span><b>Using <code>ORCHA_LLM_API_KEY</code> from the environment</b> — it takes precedence over any stored key; read-only here.</span></div>
           <code class="masked">${SetEsc(KEY.masked || "sk-…")}</code></div>`
      : `<div class="sc-banner warn"><div class="bt">${SetIcon("bell", "")}<span><b>No Anthropic API key configured.</b> Universal-model features (guided onboarding, wake triage) are off until you add one.</span></div></div>`;

  // env keys are managed outside the portal — no input/Save/Clear, only Test + a note.
  const editor = KEY.editable
    ? `<div class="sc-row">
         <input id="keyInput" class="sc-inp" type="password" spellcheck="false" autocomplete="off"
                placeholder="${KEY.mode === "db" ? "Paste a new key to replace…" : "sk-ant-…"}">
         <button class="iconbtn" id="keyReveal" type="button" title="Show / hide">${SetIcon("search", "")}</button>
       </div>
       <div class="sc-hint" id="keyHint"></div>
       <div class="sc-acts">
         <button class="btn sm" id="keySave" disabled>${SetIcon("check", "")}${KEY.mode === "db" ? "Replace key" : "Save key"}</button>
         <button class="btn sm ghost" id="keyTest" disabled>${SetIcon("spark", "")}Test</button>
         ${KEY.canClear ? `<button class="btn sm danger" id="keyClear">${SetIcon("x", "")}Remove</button>` : ""}
       </div>`
    : `<div class="sc-acts">
         <button class="btn sm ghost" id="keyTest">${SetIcon("spark", "")}Test stored key</button>
       </div>
       <div class="sc-hint">To change an environment key, update <code>ORCHA_LLM_API_KEY</code> and relaunch with <code>orcha up</code>.</div>`;

  const result = testResult
    ? `<div class="sc-result ${testResult.ok ? "ok" : "err"}">${SetIcon(testResult.ok ? "check" : "x", "")}<span>${SetEsc(testResult.ok ? "Key is valid — Anthropic accepted it." : (testResult.detail || "Key was rejected."))}</span></div>`
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

/* ---- phone pairing settings entry ----------------------------------- */
function renderPairingCard(force) {
  const host = $("pairingCard");
  if (!host) return;
  O.patch(host, `<div class="sc-banner muted">
    <div class="bt">${SetIcon("phone", "")}<span>Open the same pairing code that is available from the top bar.</span></div>
    <button class="btn sm" id="settingsPairPhone" type="button">${SetIcon("phone", "")}Pair phone</button>
  </div>
  <div class="sc-hint">Your phone talks directly to this computer on your network. Nothing goes through the cloud.</div>`, force);
  const btn = $("settingsPairPhone");
  if (btn) btn.addEventListener("click", () => O.openPairingModal && O.openPairingModal());
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
