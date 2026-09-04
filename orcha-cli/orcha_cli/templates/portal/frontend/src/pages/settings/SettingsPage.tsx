/**
 * Settings page — React port of static/settings.html + static/settings.js.
 *
 * Two cards over the UNCHANGED FastAPI backend:
 *  - Anthropic API key (#294): GET/PUT/DELETE /api/containers/{cid}/settings/llm-key
 *    and POST .../llm-key/test. PRECEDENCE = env > db > none; env keys are
 *    read-only here. Every mutation is HUMAN-GATED (PR #315): the body carries
 *    actor_agent_id (the acting human) and the page refuses to fire without one.
 *  - Per-use-case universal-model selection (SPEC-SETTINGS §2):
 *    GET .../settings/models + GET .../settings/providers, explicit Save via one
 *    PUT .../settings/models writing only the overridden rows.
 *
 * Same class names / DOM structure as the vanilla page so the shared styles.css
 * (plus the settings-specific style block carried over VERBATIM from
 * settings.html's <head>) renders it identically. Key/model state lives in
 * component state fetched independently of the 3s snapshot poll — exactly like
 * the vanilla page — so the cards never flicker and drafts are never clobbered.
 */
import { useCallback, useEffect, useState } from "react";
import { getJSON, sendJSON } from "../../api/client";
import { Icon, Modal, useToast } from "../../components/ui";
import { Shell } from "../../shell/Shell";
import { extensions } from "../../extensions";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";

/* ---- settings-specific CSS, carried over verbatim from settings.html ------ */
const SETTINGS_CSS = `
  /* settings-specific layout — reuses styles.css tokens, no new color literals */
  .set-wrap { max-width: 760px; }
  .set-intro { margin: 2px 2px 20px; }
  .set-intro h1 { font-size: 20px; font-weight: 740; letter-spacing: -.02em; }
  .set-intro p { color: var(--muted); font-size: 13px; margin-top: 5px; line-height: 1.55; max-width: 64ch; }

  .set-card .card-b { padding: 18px 20px; }
  .set-card .lead { color: var(--muted); font-size: 12.5px; line-height: 1.55; margin: -2px 0 16px; }

  /* Tab strip (vanilla settings-tabs port) — reuses the topbar's .aut/.seg pill
     idiom from styles.css so dark/light and skins hold with no new tokens. */
  .set-tabs { margin: 0 0 18px; }
  .set-tabs .seg.on { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-line); }

  /* status banner (ok / warn / err / muted) — built from the same soft tokens
     used by .attn-card / callouts so it stays theme-correct. */
  .sc-banner { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; border-radius: 12px;
    border: 1px solid var(--border); background: var(--surface-2); margin-bottom: 16px; }
  .sc-banner .bt { display: flex; align-items: center; gap: 9px; font-size: 13px; line-height: 1.45; }
  .sc-banner .bt svg { width: 17px; height: 17px; flex: none; }
  .sc-banner.ok   { background: var(--ok-soft);   border-color: var(--ok-line); }
  .sc-banner.ok .bt svg   { color: var(--ok); }
  .sc-banner.warn { background: var(--warn-soft); border-color: var(--warn-line); }
  .sc-banner.warn .bt svg { color: var(--warn); }
  .sc-banner.err  { background: var(--danger-soft); border-color: var(--danger-line); }
  .sc-banner.err .bt svg  { color: var(--danger); }
  .sc-banner.muted .bt { color: var(--muted); }
  .sc-banner .masked { margin-left: auto; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px;
    color: var(--text-2); background: var(--surface-3); border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px; }

  .sc-row { display: flex; gap: 8px; align-items: stretch; }
  .sc-inp { flex: 1; min-width: 0; background: var(--surface-2); border: 1px solid var(--border-2); border-radius: 10px;
    color: var(--text); font: 13px "JetBrains Mono", ui-monospace, monospace; padding: 10px 12px; outline: none; }
  .sc-inp::placeholder { color: var(--faint); font-family: Inter, system-ui, sans-serif; }
  .sc-inp:focus { border-color: var(--accent-line); box-shadow: var(--ring); }
  .sc-row .iconbtn { flex: none; }

  .sc-hint { font-size: 11.5px; color: var(--faint); min-height: 16px; margin: 7px 2px 0; line-height: 1.4; }
  .sc-hint code { font-size: 11px; }
  .sc-acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }

  .sc-result { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding: 10px 12px; border-radius: 10px;
    font-size: 12.5px; line-height: 1.4; border: 1px solid var(--border); }
  .sc-result svg { width: 16px; height: 16px; flex: none; }
  .sc-result.ok  { background: var(--ok-soft);     border-color: var(--ok-line); }
  .sc-result.ok svg  { color: var(--ok); }
  .sc-result.err { background: var(--danger-soft); border-color: var(--danger-line); }
  .sc-result.err svg { color: var(--danger); }

  /* per-use-case model rows (SPEC-SETTINGS §2) — token-reuse only, no color literals. */
  .uc-list { display: flex; flex-direction: column; gap: 12px; }
  .uc-row { border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); padding: 14px 16px; }
  .uc-title { font-size: 13.5px; font-weight: 640; letter-spacing: -.01em; }
  .uc-purpose { color: var(--muted); font-size: 12px; line-height: 1.5; margin-top: 3px; }
  .uc-controls { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-top: 13px; }
  .uc-sel { display: flex; flex-direction: column; gap: 4px; }
  .uc-sel > span { font-size: 11px; color: var(--faint); }
  .uc-sel select { background: var(--surface-3); border: 1px solid var(--border-2); border-radius: 9px;
    color: var(--text); font: 13px Inter, system-ui, sans-serif; padding: 8px 10px; outline: none; min-width: 150px; }
  .uc-sel select:focus { border-color: var(--accent-line); box-shadow: var(--ring); }
  .uc-sel select:disabled { opacity: .55; cursor: not-allowed; }
  .uc-default { color: var(--faint); font-size: 11.5px; margin-left: auto; align-self: flex-end; padding-bottom: 9px; }
  .uc-foot { display: flex; align-items: center; gap: 8px; margin-top: 11px; }
  .uc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .uc-dot.on { background: var(--ok); }
  .uc-dot.off { background: var(--faint); }
  .uc-state-txt { font-size: 12px; color: var(--text-2); }
  .uc-reset { margin-left: auto; }
  .uc-note { font-size: 11.5px; color: var(--faint); margin-top: 9px; line-height: 1.45; }

  .set-savebar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
  .set-savebar .saved { color: var(--muted); font-size: 12.5px; display: flex; align-items: center; gap: 7px; }
  .set-savebar .saved svg { width: 15px; height: 15px; color: var(--ok); }
  .set-err { color: var(--danger); font-size: 12.5px; }

  /* per-provider key cards (multi-provider, follow-on to #294 Item 1) — one
     .pk-card per additional AVAILABLE catalog provider, stacked like the
     Anthropic card above; reuses the same .sc-* banner/row/result tokens. */
  .pk-list { display: flex; flex-direction: column; gap: 16px; }
  .pk-card + .pk-card { padding-top: 16px; border-top: 1px solid var(--border); }

  /* mobile pairing card — the vanilla pair-modal's .pair-grid/.pair-qr/.pair-meta
     markup, inlined into a settings card instead of an overlay (both consume the
     shared styles.css .pair-* rules, so no new tokens here). */
  .pair-card-body .pair-qr { margin: 0 auto; }

  /* appearance / design picker — browser-local, applies instantly */
  .skin-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 640px) { .skin-grid { grid-template-columns: 1fr; } }
  .skin-tile { text-align: left; cursor: pointer; font: inherit; color: var(--text);
    border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2);
    padding: 14px 15px; transition: border-color .15s ease; }
  .skin-tile:hover { border-color: var(--accent-line); }
  .skin-tile.on { border-color: var(--accent); box-shadow: var(--ring); }
  .skin-tile .sw { display: flex; gap: 5px; margin-bottom: 11px; }
  .skin-tile .sw i { width: 20px; height: 20px; border: 1px solid rgba(0,0,0,.25); display: block; }
  .skin-tile[data-skin="classic"] .sw i { border-radius: 6px; }
  .skin-tile[data-skin="swiss"] .sw i { border-radius: 0 !important; }
  .skin-tile .nm { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 660; }
  .skin-tile .nm svg { width: 15px; height: 15px; color: var(--accent); margin-left: auto; flex: none; }
  .skin-tile .ds { color: var(--muted); font-size: 12px; line-height: 1.5; margin-top: 4px; }
`;

/* ====================================================================== *
 *  PURE view-model helpers (ports of window.OrchaSettings, DOM-free)     *
 * ====================================================================== */

export interface KeyStatusResp {
  configured?: boolean;
  masked?: string | null;
  source?: string | null;
}
export interface KeyVM {
  mode: "db" | "env" | "none";
  configured: boolean;
  masked: string | null;
  editable: boolean;
  canClear: boolean;
}

// Normalize the {configured, masked, source} GET into a render view-model.
//  - source "db"  -> configured here, editable, clearable, testable
//  - source "env" -> configured via environment, READ-ONLY here, still testable
//  - null/none    -> unset; warn banner; editable, not clearable
export function keyState(dataIn: KeyStatusResp | null | undefined): KeyVM {
  const data = dataIn || {};
  const src = data.source === "db" || data.source === "env" ? data.source : null;
  const configured = src != null || data.configured === true;
  const mode = src === "db" ? "db" : src === "env" ? "env" : "none";
  return {
    mode,
    configured,
    masked: data.masked || null,
    editable: mode !== "env", // env keys are managed outside the portal
    canClear: mode === "db", // only a DB-stored key can be removed here
  };
}

// Soft Anthropic-key shape hint (NOT a hard gate — TEST is the real validation).
export function looksLikeKey(s: unknown): boolean {
  return typeof s === "string" && /^sk-ant-\S+/.test(s.trim());
}

// Optimistic mask for the moment right after a successful PUT, before the GET
// refresh confirms the server's own masked form. Mirrors "sk-...1234".
export function maskOptimistic(sIn: string | null | undefined): string | null {
  const s = (sIn || "").trim();
  if (s.length < 4) return null;
  return "sk-..." + s.slice(-4);
}

export interface CatalogModel {
  id: string;
  name: string;
}
export interface Provider {
  id: string;
  name: string;
  available: boolean;
  models?: CatalogModel[];
}
export interface UseCase {
  key: string;
  label: string;
  purpose: string;
  provider?: string | null;
  model?: string | null;
  default_provider: string;
  default_model: string;
  is_set?: boolean;
}
export interface Sel {
  provider: string;
  model: string;
}

// The selectable models for a provider in the catalog: [] for an unavailable/unknown
// provider (the row then falls back to its shipped default, read-only — §4).
export function modelsForProvider(catalog: Provider[] | null | undefined, providerId: string): CatalogModel[] {
  const p = (catalog || []).find((x) => x.id === providerId);
  return p && p.available ? p.models || [] : [];
}

// The CURRENT selection for a row: the stored override when set, else the shipped default.
export function currentSel(uc: UseCase): Sel {
  return uc.is_set && uc.provider && uc.model
    ? { provider: uc.provider, model: uc.model }
    : { provider: uc.default_provider, model: uc.default_model };
}

// A row is OVERRIDDEN (● dot) when its staged selection differs from the shipped default.
export function isOverride(sel: Sel | null | undefined, uc: UseCase): boolean {
  return !!sel && (sel.provider !== uc.default_provider || sel.model !== uc.default_model);
}

// Dirty = the staged selection differs from what's PERSISTED (override if set, else default).
export function rowDirty(sel: Sel | null | undefined, uc: UseCase): boolean {
  const persisted = currentSel(uc);
  return !!sel && (sel.provider !== persisted.provider || sel.model !== persisted.model);
}

// Build the PUT body: only overridden rows are sent (default-valued rows omitted ⇒ reset).
export function buildOverrides(
  staged: Record<string, Sel | undefined>,
  ucs: UseCase[] | null | undefined,
): { key: string; provider: string; model: string }[] {
  const out: { key: string; provider: string; model: string }[] = [];
  (ucs || []).forEach((uc) => {
    const sel = staged[uc.key] || currentSel(uc);
    if (isOverride(sel, uc)) out.push({ key: uc.key, provider: sel.provider, model: sel.model });
  });
  return out;
}

/* ---- shared bits ---------------------------------------------------------- */
function statusOf(e: unknown): number | undefined {
  return e && typeof e === "object" ? (e as { status?: number }).status : undefined;
}

/* ====================================================================== *
 *  Settings tabs (port of static/modules/settings-tabs.js)               *
 * ====================================================================== */

// The URL-hash persistence contract, verbatim from the vanilla module:
//  - deep link #tab=<name> selects the tab on load and on hashchange;
//  - an unknown (or absent) #tab falls back to the FIRST tab;
//  - loading never writes the hash — only a user click does (replaceState).
const TAB_HASH_RE = /(?:^#|[#&])tab=([\w-]+)/;

export function tabFromHash(hash: string | null | undefined, names: string[]): string {
  const m = TAB_HASH_RE.exec(hash || "");
  const want = m && names.indexOf(m[1]) !== -1 ? m[1] : null;
  return want || names[0];
}

/** The General tab's key on the tab strip (the open key + models cards). */
export const GENERAL_TAB = "general";

/* ====================================================================== *
 *  Anthropic API-key card (#294)                                          *
 * ====================================================================== */
interface TestResult {
  ok: boolean;
  detail?: string | null;
}

export function KeyCard({ cid }: { cid: string | null }) {
  const { snap } = useSnapshot();
  const toast = useToast();
  const [vm, setVm] = useState<KeyVM | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [draft, setDraft] = useState(""); // local — the 3s poll never clobbers it
  const [reveal, setReveal] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const keyUrl = useCallback(
    (suffix = "") => "/api/containers/" + encodeURIComponent(cid || "") + "/settings/llm-key" + suffix,
    [cid],
  );

  const loadKey = useCallback(async () => {
    if (!cid) return;
    setLoadErr(false);
    try {
      setVm(keyState(await getJSON<KeyStatusResp>(keyUrl())));
    } catch {
      setVm(null);
      setLoadErr(true);
    }
  }, [cid, keyUrl]);

  useEffect(() => {
    void loadKey();
  }, [loadKey]);

  // PR #315 human gate — mirror the vanilla requireHuman() wording exactly.
  const who = actingHuman(snap);
  const requireHuman = (verb: string): boolean => {
    if (who) return true;
    toast("Pick an acting human to " + verb + " the key", "warn");
    return false;
  };

  const doSave = async () => {
    const v = draft.trim();
    if (!v || busy) return;
    if (!requireHuman("save")) return;
    setBusy(true);
    try {
      const body = await sendJSON<{ masked?: string }>("PUT", keyUrl(), {
        api_key: v,
        actor_agent_id: who && who.id,
      });
      setBusy(false);
      toast("API key saved.", "ok");
      setTestResult(null);
      // Optimistic, then reconcile from the masked GET (server is the source of truth).
      setVm(keyState({ source: "db", configured: true, masked: (body && body.masked) || maskOptimistic(v) }));
      setDraft(""); // flip out of warn into the configured DB-key state (drop the draft)
      setReveal(false);
      void loadKey();
    } catch (e) {
      setBusy(false);
      // keep the typed value — a transient failure never loses it
      toast("Couldn't save the key (" + statusOf(e) + "). Your input is preserved.", "danger");
    }
  };

  const doTest = async () => {
    if (busy) return;
    const v = draft.trim();
    if (!requireHuman("test")) return;
    setBusy(true);
    setTestResult(null);
    try {
      // Send the pasted key if present, else test the stored key (omit api_key).
      // actor_agent_id is always required by the backend (server-side Anthropic ping).
      const body = await sendJSON<{ ok?: boolean; detail?: string }>(
        "POST",
        keyUrl("/test"),
        v ? { api_key: v, actor_agent_id: who && who.id } : { actor_agent_id: who && who.id },
      );
      setTestResult({ ok: !!(body && body.ok), detail: body ? body.detail : undefined });
    } catch (e) {
      setTestResult({ ok: false, detail: "Test failed (" + statusOf(e) + ")." });
    }
    setBusy(false); // the verdict shows AND the typed key stays so it can be Saved
  };

  const doClear = () => {
    if (busy) return;
    if (!requireHuman("remove")) return;
    setConfirmClear(true);
  };

  const doClearConfirmed = async () => {
    setBusy(true);
    try {
      const body = await sendJSON<KeyStatusResp>("DELETE", keyUrl(), { actor_agent_id: who && who.id });
      setBusy(false);
      setConfirmClear(false);
      toast("API key removed.", "ok");
      setTestResult(null);
      setVm(keyState(body || { source: null, configured: false })); // return to the unset (warn) state
      setDraft("");
      setReveal(false);
      void loadKey();
    } catch (e) {
      setBusy(false);
      setConfirmClear(false);
      toast("Couldn't remove the key (" + statusOf(e) + ").", "danger");
    }
  };

  if (loadErr) {
    return (
      <div className="sc-banner err">
        <div className="bt">
          <Icon name="x" cls="" />
          <span>Couldn&#39;t load the API-key status.</span>
        </div>
        <button className="btn sm ghost" id="keyRetry" onClick={() => void loadKey()}>
          Retry
        </button>
      </div>
    );
  }
  if (!vm) {
    return (
      <div className="sc-banner muted">
        <div className="bt">
          <Icon name="clock" cls="" />
          <span>Checking key status…</span>
        </div>
      </div>
    );
  }

  const hasField = draft.trim().length > 0;
  const saveDisabled = busy || !hasField;
  // Save needs a pasted value; Test works on the pasted value OR (when none is
  // typed) the stored key — so an operator can verify an existing key in place.
  const testDisabled = vm.editable ? busy || (!hasField && !vm.configured) : busy;
  const hint =
    hasField && !looksLikeKey(draft)
      ? 'Heads up: Anthropic keys usually start with "sk-ant-". Test to confirm.'
      : "";

  const banner =
    vm.mode === "db" ? (
      <div className="sc-banner ok">
        <div className="bt">
          <Icon name="check" cls="" />
          <span>
            <b>Anthropic API key configured</b> — stored encrypted on this workspace.
          </span>
        </div>
        <code className="masked">{vm.masked || "sk-…"}</code>
      </div>
    ) : vm.mode === "env" ? (
      <div className="sc-banner ok">
        <div className="bt">
          <Icon name="shield" cls="" />
          <span>
            <b>
              Using <code>ORCHA_LLM_API_KEY</code> from the environment
            </b>{" "}
            — it takes precedence over any stored key; read-only here.
          </span>
        </div>
        <code className="masked">{vm.masked || "sk-…"}</code>
      </div>
    ) : (
      <div className="sc-banner warn">
        <div className="bt">
          <Icon name="bell" cls="" />
          <span>
            <b>No Anthropic API key configured.</b> Universal-model features (guided onboarding, wake
            triage) are off until you add one.
          </span>
        </div>
      </div>
    );

  // env keys are managed outside the portal — no input/Save/Clear, only Test + a note.
  const editor = vm.editable ? (
    <>
      <div className="sc-row">
        <input
          id="keyInput"
          className="sc-inp"
          type={reveal ? "text" : "password"}
          spellCheck={false}
          autoComplete="off"
          placeholder={vm.mode === "db" ? "Paste a new key to replace…" : "sk-ant-…"}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setTestResult(null);
          }}
        />
        <button
          className="iconbtn"
          id="keyReveal"
          type="button"
          title="Show / hide"
          onClick={() => setReveal((r) => !r)}
        >
          <Icon name="search" cls="" />
        </button>
      </div>
      <div className="sc-hint" id="keyHint">
        {hint}
      </div>
      <div className="sc-acts">
        <button className="btn sm" id="keySave" disabled={saveDisabled} onClick={() => void doSave()}>
          <Icon name="check" cls="" />
          {vm.mode === "db" ? "Replace key" : "Save key"}
        </button>
        <button className="btn sm ghost" id="keyTest" disabled={testDisabled} onClick={() => void doTest()}>
          <Icon name="spark" cls="" />
          Test
        </button>
        {vm.canClear && (
          <button className="btn sm danger" id="keyClear" onClick={doClear}>
            <Icon name="x" cls="" />
            Remove
          </button>
        )}
      </div>
    </>
  ) : (
    <>
      <div className="sc-acts">
        <button className="btn sm ghost" id="keyTest" disabled={busy} onClick={() => void doTest()}>
          <Icon name="spark" cls="" />
          Test stored key
        </button>
      </div>
      <div className="sc-hint">
        To change an environment key, update <code>ORCHA_LLM_API_KEY</code> and relaunch with{" "}
        <code>orcha up</code>.
      </div>
    </>
  );

  return (
    <>
      {banner}
      {editor}
      {testResult && (
        <div className={"sc-result " + (testResult.ok ? "ok" : "err")}>
          <Icon name={testResult.ok ? "check" : "x"} cls="" />
          <span>
            {testResult.ok ? "Key is valid — Anthropic accepted it." : testResult.detail || "Key was rejected."}
          </span>
        </div>
      )}
      {confirmClear && (
        <Modal
          title="Remove API key"
          danger
          primary="Remove key"
          desc="Deletes the stored key from this workspace. If ORCHA_LLM_API_KEY is set in the environment, the client falls back to it; otherwise universal-model features turn off."
          onPrimary={() => void doClearConfirmed()}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </>
  );
}

/* ====================================================================== *
 *  Per-provider API keys (multi-provider, follow-on to #294 Item 1)      *
 *  One card per AVAILABLE non-Anthropic catalog provider (e.g. xAI/Grok),*
 *  mirroring the Anthropic card above but wired to the provider-scoped    *
 *  routes so a use-case set to xAI has somewhere to put an xAI key:       *
 *    GET    .../settings/provider-keys                  -> {keys:[...]}  *
 *    PUT    .../settings/provider-keys/{provider} {api_key}              *
 *    DELETE .../settings/provider-keys/{provider}                        *
 *    POST   .../settings/provider-keys/{provider}/test {api_key?}        *
 *  Anthropic keeps its own dedicated card above (KeyCard / llm-key route) *
 *  even though the GET here also lists it — filtered out, same as the     *
 *  vanilla settings-provider-keys.js, so it never renders twice.          *
 * ====================================================================== */
export interface ProviderKeyEntry {
  provider: string;
  name: string;
  configured?: boolean;
  source?: string | null;
  masked?: string | null;
  set_at?: string | null;
}
export interface ProviderKeyVM extends KeyVM {
  provider: string;
  name: string;
}
interface ProviderKeyCardVM extends ProviderKeyVM {
  onSaved: () => void;
}

// Non-Anthropic provider-key rows for the additional-provider card list —
// Anthropic is excluded here (it keeps its own dedicated card above).
export function otherProviderKeys(keysIn: ProviderKeyEntry[] | null | undefined): ProviderKeyVM[] {
  return (keysIn || [])
    .filter((k) => k.provider !== "anthropic")
    .map((k) => ({ ...keyState(k), provider: k.provider, name: k.name }));
}

function PkCard({
  k,
  cid,
}: {
  k: ProviderKeyCardVM;
  cid: string | null;
}) {
  const { snap } = useSnapshot();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const who = actingHuman(snap);
  const requireHuman = (verb: string): boolean => {
    if (who) return true;
    toast("Pick an acting human to " + verb + " the key", "warn");
    return false;
  };

  const pkUrl = (suffix = "") =>
    "/api/containers/" + encodeURIComponent(cid || "") + "/settings/provider-keys/" +
    encodeURIComponent(k.provider) + suffix;

  const doSave = async () => {
    const v = draft.trim();
    if (!v || busy) return;
    if (!requireHuman("save")) return;
    setBusy(true);
    try {
      await sendJSON("PUT", pkUrl(), { api_key: v, actor_agent_id: who && who.id });
      setBusy(false);
      toast("API key saved.", "ok");
      setTestResult(null);
      setDraft("");
      setReveal(false);
      k.onSaved();
    } catch (e) {
      setBusy(false);
      toast("Couldn't save the key (" + statusOf(e) + "). Your input is preserved.", "danger");
    }
  };

  const doTest = async () => {
    if (busy) return;
    const v = draft.trim();
    if (!requireHuman("test")) return;
    setBusy(true);
    setTestResult(null);
    try {
      const body = await sendJSON<{ ok?: boolean; detail?: string }>(
        "POST",
        pkUrl("/test"),
        v ? { api_key: v, actor_agent_id: who && who.id } : { actor_agent_id: who && who.id },
      );
      setTestResult({ ok: !!(body && body.ok), detail: body ? body.detail : undefined });
    } catch (e) {
      setTestResult({ ok: false, detail: "Test failed (" + statusOf(e) + ")." });
    }
    setBusy(false);
  };

  const doClear = () => {
    if (busy) return;
    if (!requireHuman("remove")) return;
    setConfirmClear(true);
  };

  const doClearConfirmed = async () => {
    setBusy(true);
    try {
      await sendJSON("DELETE", pkUrl(), { actor_agent_id: who && who.id });
      setBusy(false);
      setConfirmClear(false);
      toast("API key removed.", "ok");
      setTestResult(null);
      setDraft("");
      setReveal(false);
      k.onSaved();
    } catch (e) {
      setBusy(false);
      setConfirmClear(false);
      toast("Couldn't remove the key (" + statusOf(e) + ").", "danger");
    }
  };

  const hasField = draft.trim().length > 0;
  const saveDisabled = busy || !hasField;
  const testDisabled = k.editable ? busy || (!hasField && !k.configured) : busy;

  const banner =
    k.mode === "db" ? (
      <div className="sc-banner ok">
        <div className="bt">
          <Icon name="check" cls="" />
          <span>
            <b>{k.name} API key configured</b> — stored encrypted on this workspace.
          </span>
        </div>
        <code className="masked">{k.masked || "sk-…"}</code>
      </div>
    ) : k.mode === "env" ? (
      <div className="sc-banner ok">
        <div className="bt">
          <Icon name="shield" cls="" />
          <span>
            <b>
              Using <code>ORCHA_LLM_API_KEY</code> from the environment
            </b>{" "}
            — it takes precedence; read-only here.
          </span>
        </div>
        <code className="masked">{k.masked || "sk-…"}</code>
      </div>
    ) : (
      <div className="sc-banner warn">
        <div className="bt">
          <Icon name="bell" cls="" />
          <span>
            <b>No {k.name} API key configured.</b> Use-cases set to {k.name} are off until you add one.
          </span>
        </div>
      </div>
    );

  const editor = k.editable ? (
    <>
      <div className="sc-row">
        <input
          className="sc-inp"
          type={reveal ? "text" : "password"}
          spellCheck={false}
          autoComplete="off"
          placeholder={k.mode === "db" ? "Paste a new key to replace…" : "Paste " + k.name + " API key…"}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setTestResult(null);
          }}
        />
        <button className="iconbtn" type="button" title="Show / hide" onClick={() => setReveal((r) => !r)}>
          <Icon name="search" cls="" />
        </button>
      </div>
      <div className="sc-acts">
        <button className="btn sm" disabled={saveDisabled} onClick={() => void doSave()}>
          <Icon name="check" cls="" />
          {k.mode === "db" ? "Replace key" : "Save key"}
        </button>
        <button className="btn sm ghost" disabled={testDisabled} onClick={() => void doTest()}>
          <Icon name="spark" cls="" />
          Test
        </button>
        {k.canClear && (
          <button className="btn sm danger" onClick={doClear}>
            <Icon name="x" cls="" />
            Remove
          </button>
        )}
      </div>
    </>
  ) : (
    <>
      <div className="sc-acts">
        <button className="btn sm ghost" disabled={busy} onClick={() => void doTest()}>
          <Icon name="spark" cls="" />
          Test stored key
        </button>
      </div>
      <div className="sc-hint">
        To change an environment key, update <code>ORCHA_LLM_API_KEY</code> and relaunch with{" "}
        <code>orcha up</code>.
      </div>
    </>
  );

  return (
    <div className="pk-card" data-provider={k.provider}>
      {banner}
      {editor}
      {testResult && (
        <div className={"sc-result " + (testResult.ok ? "ok" : "err")}>
          <Icon name={testResult.ok ? "check" : "x"} cls="" />
          <span>
            {testResult.ok ? "Key is valid — " + k.name + " accepted it." : testResult.detail || "Key was rejected."}
          </span>
        </div>
      )}
      {confirmClear && (
        <Modal
          title="Remove API key"
          danger
          primary="Remove key"
          desc="Deletes the stored key for this provider from this workspace. If ORCHA_LLM_API_KEY is set in the environment, the client falls back to it."
          onPrimary={() => void doClearConfirmed()}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}

export function ProviderKeysCard({ cid }: { cid: string | null }) {
  const [keys, setKeys] = useState<ProviderKeyEntry[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);

  const loadKeys = useCallback(async () => {
    if (!cid) return;
    setLoadErr(false);
    try {
      const body = await getJSON<{ keys?: ProviderKeyEntry[] }>(
        "/api/containers/" + encodeURIComponent(cid) + "/settings/provider-keys",
      );
      if (body && Array.isArray(body.keys)) setKeys(body.keys);
      else {
        setKeys(null);
        setLoadErr(true);
      }
    } catch {
      setKeys(null);
      setLoadErr(true);
    }
  }, [cid]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  if (loadErr) {
    return (
      <div className="sc-banner err">
        <div className="bt">
          <Icon name="x" cls="" />
          <span>Couldn&#39;t load provider keys.</span>
        </div>
        <button className="btn sm ghost" onClick={() => void loadKeys()}>
          Retry
        </button>
      </div>
    );
  }
  if (!keys) {
    return (
      <div className="sc-banner muted">
        <div className="bt">
          <Icon name="clock" cls="" />
          <span>Checking provider keys…</span>
        </div>
      </div>
    );
  }

  const vms = otherProviderKeys(keys).map((k) => ({ ...k, onSaved: () => void loadKeys() }));
  if (!vms.length) return <div className="sc-hint">No additional providers are available yet.</div>;

  return (
    <div className="pk-list">
      {vms.map((k) => (
        <PkCard key={k.provider} k={k} cid={cid} />
      ))}
    </div>
  );
}

/* ====================================================================== *
 *  Per-use-case universal-model selection (SPEC-SETTINGS §2)             *
 * ====================================================================== */

function UcRow({
  uc,
  sel,
  catalog,
  onProvider,
  onModel,
  onReset,
}: {
  uc: UseCase;
  sel: Sel;
  catalog: Provider[];
  onProvider: (key: string, provider: string) => void;
  onModel: (key: string, model: string) => void;
  onReset: (key: string) => void;
}) {
  const overridden = isOverride(sel, uc);
  const provAvail = catalog.some((p) => p.id === sel.provider && p.available);
  const defModels = modelsForProvider(catalog, sel.provider);
  const retired = !!sel.model && provAvail && !defModels.some((m) => m.id === sel.model);

  // Model <option>s: if the stored model isn't in the catalog (retired provider/model),
  // inject it so the choice is never silently lost (§4) and flag it on the row.
  const opts = defModels.slice();
  if (sel.model && !opts.some((m) => m.id === sel.model)) {
    opts.unshift({ id: sel.model, name: sel.model + " (unavailable)" });
  }

  return (
    <div className="uc-row" data-key={uc.key}>
      <div className="uc-title">{uc.label}</div>
      <div className="uc-purpose">{uc.purpose}</div>
      <div className="uc-controls">
        <label className="uc-sel">
          <span>Provider</span>
          {/* every catalog provider, stubbed ones disabled ("coming soon") — honest, never a dead option (§2.1) */}
          <select
            className="uc-prov"
            data-key={uc.key}
            value={sel.provider}
            onChange={(e) => onProvider(uc.key, e.target.value)}
          >
            {catalog.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.name + (p.available ? "" : " (coming soon)")}
              </option>
            ))}
          </select>
        </label>
        <label className="uc-sel">
          <span>Model</span>
          <select
            className="uc-model"
            data-key={uc.key}
            disabled={!defModels.length && !retired}
            value={sel.model || ""}
            onChange={(e) => onModel(uc.key, e.target.value)}
          >
            {opts.length ? (
              opts.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))
            ) : (
              <option value={sel.model || ""}>{sel.model || "—"}</option>
            )}
          </select>
        </label>
        <span className="uc-default">default: {uc.default_model}</span>
      </div>
      <div className="uc-foot">
        <span className={"uc-dot " + (overridden ? "on" : "off")} />
        <span className="uc-state-txt">{overridden ? "set to " + sel.model : "using shipped default"}</span>
        <button className="btn sm ghost uc-reset" data-key={uc.key} disabled={!overridden} onClick={() => onReset(uc.key)}>
          <Icon name="x" cls="" />
          Reset to default
        </button>
      </div>
      {retired && (
        <div className="uc-note">
          This stored model is no longer in the catalog — it&#39;ll fall back to the default until you pick a
          current one.
        </div>
      )}
    </div>
  );
}

export function ModelsCard({ cid }: { cid: string | null }) {
  const { snap } = useSnapshot();
  const toast = useToast();
  const [models, setModels] = useState<UseCase[] | null>(null);
  const [catalog, setCatalog] = useState<Provider[] | null>(null);
  const [mdlErr, setMdlErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState(false);
  const [staged, setStaged] = useState<Record<string, Sel | undefined>>({});

  const loadModels = useCallback(async () => {
    if (!cid) return;
    setMdlErr(false);
    try {
      const [m, p] = await Promise.all([
        getJSON<{ use_cases?: UseCase[] }>("/api/containers/" + encodeURIComponent(cid) + "/settings/models"),
        getJSON<{ providers?: Provider[] }>("/api/containers/" + encodeURIComponent(cid) + "/settings/providers"),
      ]);
      if (m && Array.isArray(m.use_cases) && p) {
        const ucs = m.use_cases;
        setModels(ucs);
        setCatalog(p.providers || []);
        // reset staging to the persisted selection
        const st: Record<string, Sel> = {};
        ucs.forEach((uc) => {
          st[uc.key] = currentSel(uc);
        });
        setStaged(st);
      } else {
        setModels(null);
        setCatalog(null);
        setMdlErr(true);
      }
    } catch {
      setModels(null);
      setCatalog(null);
      setMdlErr(true);
    }
  }, [cid]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const who = actingHuman(snap);

  const onProvider = (key: string, provider: string) => {
    const uc = (models || []).find((u) => u.key === key);
    if (!uc) return;
    // re-scope the model: keep it if still valid, else the provider's first model (or the
    // default when this provider is the default's provider), else blank.
    const ms = modelsForProvider(catalog, provider);
    const cur = staged[key] || currentSel(uc);
    let model = cur.model;
    if (!ms.some((m) => m.id === model)) {
      model = provider === uc.default_provider ? uc.default_model : ms[0] ? ms[0].id : "";
    }
    setStaged((s) => ({ ...s, [key]: { provider, model } }));
    setSaveErr(false);
  };

  const onModel = (key: string, model: string) => {
    const uc = (models || []).find((u) => u.key === key);
    if (!uc) return;
    const cur = staged[key] || currentSel(uc);
    setStaged((s) => ({ ...s, [key]: { provider: cur.provider, model } }));
    setSaveErr(false);
  };

  const onReset = (key: string) => {
    const uc = (models || []).find((u) => u.key === key);
    if (!uc) return;
    setStaged((s) => ({ ...s, [key]: { provider: uc.default_provider, model: uc.default_model } }));
    setSaveErr(false);
  };

  const onDiscard = () => {
    const st: Record<string, Sel> = {};
    (models || []).forEach((uc) => {
      st[uc.key] = currentSel(uc);
    });
    setStaged(st);
    setSaveErr(false);
  };

  const dirty = (models || []).some((uc) => rowDirty(staged[uc.key], uc));

  const doSaveModels = async () => {
    if (busy || !dirty) return;
    if (!who) {
      // vanilla requireHuman("change models") — wording preserved verbatim
      toast("Pick an acting human to change models the key", "warn");
      return;
    }
    setBusy(true);
    setSaveErr(false);
    const overrides = buildOverrides(staged, models);
    try {
      const body = await sendJSON<{ use_cases?: UseCase[] }>(
        "PUT",
        "/api/containers/" + encodeURIComponent(cid || "") + "/settings/models",
        { actor_agent_id: who && who.id, use_cases: overrides },
      );
      setBusy(false);
      if (body && Array.isArray(body.use_cases)) {
        toast("Model settings saved.", "ok");
        setModels(body.use_cases);
        const st: Record<string, Sel> = {};
        body.use_cases.forEach((uc) => {
          st[uc.key] = currentSel(uc);
        }); // reconcile to server truth
        setStaged(st);
      } else {
        setSaveErr(true);
        toast("Couldn't save model settings (200). Your edits are kept.", "danger");
      }
    } catch (e) {
      setBusy(false);
      setSaveErr(true);
      // preserve staged edits — a transient failure never loses them
      toast("Couldn't save model settings (" + statusOf(e) + "). Your edits are kept.", "danger");
    }
  };

  if (mdlErr) {
    return (
      <div className="sc-banner err">
        <div className="bt">
          <Icon name="x" cls="" />
          <span>Couldn&#39;t load the model settings.</span>
        </div>
        <button className="btn sm ghost" id="mdlRetry" onClick={() => void loadModels()}>
          Retry
        </button>
      </div>
    );
  }
  if (!models || !catalog) {
    return (
      <div className="sc-banner muted">
        <div className="bt">
          <Icon name="clock" cls="" />
          <span>Loading models…</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="uc-list">
        {models.map((uc) => (
          <UcRow
            key={uc.key}
            uc={uc}
            sel={staged[uc.key] || currentSel(uc)}
            catalog={catalog}
            onProvider={onProvider}
            onModel={onModel}
            onReset={onReset}
          />
        ))}
      </div>
      <div className="set-savebar">
        <button className="btn sm" id="mdlSave" disabled={!(dirty && !busy)} onClick={() => void doSaveModels()}>
          <Icon name="check" cls="" />
          Save changes
        </button>
        {dirty && (
          <button className="btn sm ghost" id="mdlDiscard" disabled={busy} onClick={onDiscard}>
            Discard
          </button>
        )}
        {saveErr ? (
          <span className="set-err">Couldn&#39;t save — retry (your edits are kept).</span>
        ) : !dirty ? (
          <span className="saved">
            <Icon name="check" cls="" />
            all saved
          </span>
        ) : null}
      </div>
    </>
  );
}

/* ====================================================================== *
 *  Mobile pairing card (A1 pairing payload/UI contract)                  *
 *  On load, fetches GET .../pairing?human_agent_id=... and renders the    *
 *  returned SVG QR + short code inline (no modal — this IS the card).     *
 *  409 (no human / unreachable LAN) renders as an honest message, never a *
 *  crash; the vanilla .pair-* grid/qr/meta classes (shared styles.css)    *
 *  are reused so it matches the topbar pairing modal's look.              *
 * ====================================================================== */
export interface PairingWarning {
  reachable?: false;
  reason?: string;
  title?: string;
  message?: string;
  remedy?: string;
}
export interface PairingPayload {
  baseUrl?: string;
  humanAgentId?: string;
  humanAgentAlias?: string;
  shortCode?: string;
  qrSvg?: string;
  expiresAt?: string;
  reachable?: true;
}

export function PairingCard({ cid }: { cid: string | null }) {
  const { snap } = useSnapshot();
  const [data, setData] = useState<PairingPayload | null>(null);
  const [warn, setWarn] = useState<PairingWarning | null>(null);
  const [loading, setLoading] = useState(true);

  const who = actingHuman(snap);
  const humanId = who ? who.id : null;

  const load = useCallback(async () => {
    if (!cid) return;
    setLoading(true);
    setWarn(null);
    let url = "/api/containers/" + encodeURIComponent(cid) + "/pairing";
    if (humanId) url += "?human_agent_id=" + encodeURIComponent(String(humanId));
    try {
      const r = await fetch(url);
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {
        /* non-JSON error body */
      }
      if (!r.ok) {
        const detail = (body as { detail?: PairingWarning | string } | null)?.detail;
        setData(null);
        setWarn(
          typeof detail === "string"
            ? { message: detail }
            : detail || { message: "Pairing failed (" + r.status + ")." },
        );
        setLoading(false);
        return;
      }
      setData(body as PairingPayload);
      setLoading(false);
    } catch (e) {
      setData(null);
      setWarn({ message: "Could not reach the local pairing endpoint: " + (e as Error).message });
      setLoading(false);
    }
  }, [cid, humanId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="pair-loading">
        <Icon name="clock" cls="" />
        <span>Preparing pairing code…</span>
      </div>
    );
  }

  if (warn) {
    return (
      <div className="pair-warning">
        <div className="pair-warn-title">
          <Icon name="bell" cls="" />
          <span>{warn.title || "Phones can't reach this Orcha yet"}</span>
        </div>
        <p>{warn.message || "The server could not produce a phone-reachable network address."}</p>
        {warn.remedy && <div className="pair-remedy">{warn.remedy}</div>}
        <p className="pair-foot">
          Both devices must be on the same Wi-Fi. Some VPNs and corporate networks block phone-to-laptop
          traffic.
        </p>
      </div>
    );
  }

  if (!data) return null;

  const human = data.humanAgentAlias || "selected human";
  return (
    <div className="pair-card-body pair-grid">
      <div className="pair-qr-wrap">
        <div className="pair-qr" aria-label="Orcha phone pairing QR code" dangerouslySetInnerHTML={{ __html: data.qrSvg || "" }} />
        <div className="pair-url mono">{data.baseUrl || ""}</div>
      </div>
      <div className="pair-meta">
        <div>
          <div className="pair-label">Pairing as</div>
          <div className="pair-value">{human} (human)</div>
        </div>
        <div>
          <div className="pair-label">Manual code</div>
          <div className="pair-code mono">{data.shortCode || ""}</div>
        </div>
        <div className="pair-foot">
          Your phone talks directly to this computer on your network. Nothing goes through the cloud.
        </div>
      </div>
    </div>
  );
}

/* ====================================================================== *
 *  Appearance: portal design (skin) picker                               *
 *  Browser-local (localStorage "orcha:skin"), no API — mirrors the theme *
 *  toggle's contract. "classic" = the shipped teal look (no attribute);   *
 *  "swiss" = the sharp indigo direction, applied as data-skin on <html>.  *
 *  index.html's pre-paint <head> script reads the same key, so the pick   *
 *  sticks across the whole portal with no flash.                          *
 * ====================================================================== */
export interface Skin {
  id: "classic" | "swiss";
  name: string;
  desc: string;
  sw: string[];
}
export const SKINS: Skin[] = [
  {
    id: "classic",
    name: "Classic",
    desc: "Teal accent, rounded corners, soft shadows — the original Orcha look.",
    sw: ["#111620", "#1fc7cd", "#f2a83c", "#e8edf6"],
  },
  {
    id: "swiss",
    name: "Swiss",
    desc: "Electric indigo, sharp corners, mono status chips — dense engineering grid.",
    sw: ["#151517", "#5a72ff", "#ff7a52", "#f2f2ee"],
  },
];

export function currentSkin(): string {
  try {
    const s = localStorage.getItem("orcha:skin");
    return SKINS.some((k) => k.id === s) ? (s as string) : "classic";
  } catch {
    return "classic";
  }
}

export function applySkin(id: string): void {
  const d = document.documentElement;
  if (id === "classic") d.removeAttribute("data-skin");
  else d.setAttribute("data-skin", id);
  try {
    localStorage.setItem("orcha:skin", id);
  } catch {
    /* private mode */
  }
}

export function AppearanceCard() {
  const toast = useToast();
  const [skin, setSkin] = useState(() => currentSkin());

  const pick = (id: string) => {
    if (id === skin) return;
    applySkin(id);
    setSkin(id);
    toast("Design · " + (SKINS.find((k) => k.id === id) || {}).name, "ok");
  };

  return (
    <div className="skin-grid" id="skinGrid">
      {SKINS.map((k) => {
        const on = k.id === skin;
        return (
          <button
            key={k.id}
            type="button"
            className={"skin-tile" + (on ? " on" : "")}
            data-skin={k.id}
            onClick={() => pick(k.id)}
          >
            <div className="sw">
              {k.sw.map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
            </div>
            <div className="nm">
              {k.name}
              {on && <Icon name="check" cls="" />}
            </div>
            <div className="ds">{k.desc}</div>
          </button>
        );
      })}
    </div>
  );
}

/* ====================================================================== *
 *  The page                                                               *
 * ====================================================================== */
export function SettingsPage() {
  const { snap, cid } = useSnapshot();

  // Tabs appear ONLY when a downstream registered settings sections; open
  // Orcha (no sections) keeps today's untabbed layout with zero visual change.
  const sections = extensions.settingsSections ?? [];
  const tabbed = sections.length > 0;
  const names = [GENERAL_TAB, ...sections.map((s) => s.key)];
  const namesKey = names.join("\u0000");

  const [tab, setTab] = useState(() => tabFromHash(window.location.hash, names));

  // Vanilla contract: #tab=<name> re-selects on hashchange (back/forward,
  // manual edit) without writing the hash back.
  useEffect(() => {
    if (!tabbed) return;
    const list = namesKey.split("\u0000");
    const onHash = () => setTab(tabFromHash(window.location.hash, list));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [tabbed, namesKey]);

  // Clicking a pill selects it and rewrites the hash via replaceState (no
  // history spam) — the vanilla module's exact idiom, fallback included.
  const select = (name: string) => {
    setTab(name);
    try {
      history.replaceState(null, "", "#tab=" + name);
    } catch {
      window.location.hash = "tab=" + name;
    }
  };

  const active = tabbed && names.indexOf(tab) !== -1 ? tab : GENERAL_TAB;
  const activeSection = sections.find((s) => s.key === active);

  return (
    <Shell page="settings" title="Settings" ctx={snap?.container?.name}>
      <style>{SETTINGS_CSS}</style>
      <div className="set-wrap" {...(tabbed ? { "data-tab": active } : {})}>
        <div className="set-intro">
          <h1>Settings</h1>
          <p>
            Workspace-level configuration. The Anthropic API key below powers Orcha&#39;s universal LLM
            client (#290) — the direct-API calls behind guided onboarding and wake triage — separate from
            each agent&#39;s own embodiment model.
          </p>
        </div>

        {tabbed && (
          /* Vanilla tab strip verbatim (settings.html #setTabs): the topbar
             .aut/.seg pill idiom, so cloud's settings.css + the open styles.css
             style it with no new tokens. First tab is always General. */
          <nav className="aut set-tabs" id="setTabs" role="tablist" aria-label="Settings sections">
            {[{ key: GENERAL_TAB, title: "General" }, ...sections].map((t) => {
              const on = t.key === active;
              return (
                <span
                  key={t.key}
                  className={"seg" + (on ? " on" : "")}
                  role="tab"
                  tabIndex={0}
                  aria-selected={on}
                  data-tab={t.key}
                  onClick={() => select(t.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      select(t.key);
                    }
                  }}
                >
                  {t.title}
                </span>
              );
            })}
          </nav>
        )}

        {active === GENERAL_TAB && (
          <>
        {(extensions.settingsGeneral?.key ?? true) && (
        <div className="card set-card" data-settab={GENERAL_TAB}>
          <div className="card-h">
            <h2>Anthropic API key</h2>
          </div>
          <div className="card-b">
            <div className="lead">
              Stored encrypted on this workspace and used for the universal client. The{" "}
              <code>ORCHA_LLM_API_KEY</code> environment variable takes precedence — a key set here is used
              only when no env key is present.
            </div>
            <div id="keyCard">
              <KeyCard cid={cid} />
            </div>
          </div>
        </div>
        )}

        {(extensions.settingsGeneral?.key ?? true) && (
        <div className="card set-card" data-settab={GENERAL_TAB}>
          <div className="card-h">
            <h2>Provider API keys</h2>
          </div>
          <div className="card-b">
            <div className="lead">
              Stored encrypted on this workspace and used when a use-case below is set to that provider.
              As above, <code>ORCHA_LLM_API_KEY</code> takes precedence when present.
            </div>
            <div id="providerKeys">
              <ProviderKeysCard cid={cid} />
            </div>
          </div>
        </div>
        )}

        {(extensions.settingsGeneral?.models ?? true) && (
        <div className="card set-card" data-settab={GENERAL_TAB}>
          <div className="card-h">
            <h2>Universal model selection</h2>
          </div>
          <div className="card-b">
            <div className="lead">
              Pick which model powers each non-agent task. These are direct-API calls (the universal
              client, #290), separate from each agent&#39;s own embodiment model. A use-case left on its
              shipped default uses the model Orcha ships with.
            </div>
            <div id="modelRows">
              <ModelsCard cid={cid} />
            </div>
          </div>
        </div>
        )}

        {(extensions.settingsGeneral?.key ?? true) && (
        <div className="card set-card" data-settab={GENERAL_TAB}>
          <div className="card-h">
            <h2>Phone pairing</h2>
          </div>
          <div className="card-b">
            <div className="lead">
              Pair the Orcha mobile app with this workspace on your local Wi-Fi network.
            </div>
            <div id="pairingCard">
              <PairingCard cid={cid} />
            </div>
          </div>
        </div>
        )}

        {(extensions.settingsGeneral?.key ?? true) && (
        <div className="card set-card" data-settab={GENERAL_TAB}>
          <div className="card-h">
            <h2>Appearance</h2>
          </div>
          <div className="card-b">
            <div className="lead">
              How the portal looks in this browser — applies instantly, per device. Dark / light stays
              on the theme toggle in the top bar; this picks the design language.
            </div>
            <AppearanceCard />
          </div>
        </div>
        )}
          </>
        )}

        {activeSection && <activeSection.element />}
      </div>
    </Shell>
  );
}
