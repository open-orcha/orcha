/* Settings page module: API-key view-model helpers and key loading. */
const O = window.Orcha;
const SetIcon = O.icon, SetEsc = O.esc;

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
