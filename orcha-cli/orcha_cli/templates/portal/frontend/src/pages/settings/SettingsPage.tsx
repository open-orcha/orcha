/**
 * Settings — Orcha V2 sectioned settings (parity R-06, P-05…P-12, PI-07).
 *
 * Sections (arch §2.3; old `#tab=` keys keep resolving, aliases in
 * SETTINGS_ALIASES): General · Execution · Models & providers · Integrations ·
 * Members & access · Devices & pairing · Interface. Every pre-V2 setting is
 * still here, only regrouped:
 *  - Anthropic API key (#294): GET/PUT/DELETE /api/containers/{cid}/settings/llm-key
 *    and POST .../llm-key/test. PRECEDENCE = env > db > none; env keys are
 *    read-only here. Every mutation is HUMAN-GATED (PR #315): the body carries
 *    actor_agent_id (the acting human) and the page refuses to fire without one.
 *  - Provider keys: GET/PUT/DELETE …/settings/provider-keys[/{provider}] (+ /test).
 *  - Per-use-case universal-model selection (SPEC-SETTINGS §2):
 *    GET .../settings/models + GET .../settings/providers, explicit Save via one
 *    PUT .../settings/models writing only the overridden rows.
 *  - Worktree routing: POST …/worktrees (human-gated) — now under Execution.
 *  - Phone pairing: GET …/pairing — under Devices & pairing.
 *  - Downstream sections registered on extensions.settingsSections (cloud:
 *    provider keys, GitHub access, members, pairing, appearance) are slotted
 *    into their V2 group by key; unknown keys get their own section.
 * V2 is dark-only: the theme/skin pickers are gone (Interface section explains;
 * stored preferences are kept, never applied — see InterfaceSection.tsx).
 *
 * Key/model state lives in component state fetched independently of the 3s
 * snapshot poll, so the cards never flicker and drafts are never clobbered.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { getJSON, sendJSON } from "../../api/client";
import { Icon, Modal, useToast } from "../../components/ui";
import { Button, ButtonLink, Chip, Tooltip } from "../../components/primitives";
import { EnvKeyHint, SecretInput, SettingRow, SettingRows, SettingsGroup, StatusLine, TestResult, settingsErrText } from "./settingsUi";
import { useLocation } from "react-router-dom";
import { Shell, autonomyLabel, execChipState, snapshotErrorKind, wakesObserved } from "../../shell/Shell";
import { useChrome } from "../../shell/chrome";
import { extensions, type SettingsSection } from "../../extensions";
import { actingHuman, autLevel, useSnapshot } from "../../state/SnapshotProvider";
import { useGrantAuthority } from "./grantAuthority";
import { AgentWorktreesSection } from "./AgentWorktreesSection";
import { projectStatusMeta } from "../../cloud/projects/projectStatus";
import { useProjectIconAuthority } from "../../components/primitives/projectIconAuthority";
import * as prefs from "../../cloud/projects/prefs";
import { ProjectIcon, useProjectIcon } from "../../components/primitives/ProjectIcon";
import { ProjectIconPicker } from "../../components/primitives/EmojiPicker";
import { InterfaceSection } from "./InterfaceSection";
import { NotificationsSection } from "./notifications/NotificationsSection";
import { VoiceSection } from "./voice/VoiceSection";
import { AgentLimitRow } from "./AgentLimitRow";
import { ObjectiveRow } from "./ObjectiveRow";
import { ReviewRoutingRow } from "./ReviewRoutingRow";
import { PortabilitySection } from "./portability/PortabilitySection";
import { VerdiktSettingsSection } from "./integrations/VerdiktSettings";
import { ProjectModeSection } from "../onboarding/templates/ProjectModeSection";
import { DefaultBadge, KeyDetail, PROVIDER_DOCS, ProviderRow, RuntimesGroup } from "./providerRows";
import { DEVICE_NOT_A_MEMBER, DEVICE_SIGNIN_UNAVAILABLE, DeviceTokensSection } from "../../cloud/device/DeviceTokens";
import { fetchMe } from "../../cloud/identity";
import { pairingErrorView, type PairingErrorView } from "../../cloud/projects/PairingModal";
import "../../cloud/settings/settings-cards.css";
import "./settings-v2.css";

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

// A row whose stored model is RETIRED: its provider is still available but the
// model is no longer in that provider's catalog (UcRow flags it with a note).
export function isRetiredSel(sel: Sel, catalog: Provider[] | null | undefined): boolean {
  if (!catalog || !sel.model) return false;
  const provAvail = catalog.some((p) => p.id === sel.provider && p.available);
  return provAvail && !modelsForProvider(catalog, sel.provider).some((m) => m.id === sel.model);
}

// Build the PUT body: only overridden rows are sent (default-valued rows omitted ⇒ reset).
// SET-009: an UNTOUCHED row whose stored model is retired is omitted too — the
// server refuses a retired model, which would otherwise block every unrelated
// save; omitting resets it to the default, exactly what the row's note says.
export function buildOverrides(
  staged: Record<string, Sel | undefined>,
  ucs: UseCase[] | null | undefined,
  catalog?: Provider[] | null,
): { key: string; provider: string; model: string }[] {
  const out: { key: string; provider: string; model: string }[] = [];
  (ucs || []).forEach((uc) => {
    const sel = staged[uc.key] || currentSel(uc);
    if (!rowDirty(sel, uc) && isRetiredSel(sel, catalog)) return;
    if (isOverride(sel, uc)) out.push({ key: uc.key, provider: sel.provider, model: sel.model });
  });
  return out;
}

/* ---- shared bits ---------------------------------------------------------- */

/* ====================================================================== *
 *  Settings tabs (port of static/modules/settings-tabs.js)               *
 * ====================================================================== */

// The URL-hash persistence contract, verbatim from the vanilla module:
//  - deep link #tab=<name> selects the tab on load and on hashchange;
//  - an unknown (or absent) #tab falls back to the FIRST tab;
//  - loading never writes the hash — only a user click does (replaceState).
const TAB_HASH_RE = /(?:^#|[#&])tab=([\w-]+)/;

/**
 * V2 section aliases (arch §2.3): every pre-V2 `#tab=` key keeps selecting the
 * right content. Canonical keys are the pre-V2 ones where they existed
 * (provider-keys, github-access, members, pairing, general) so existing deep
 * links (desktop "Pair phone" → #tab=pairing) never change.
 */
export const SETTINGS_ALIASES: Record<string, string> = {
  models: "provider-keys",
  providers: "provider-keys",
  integrations: "github-access",
  github: "github-access",
  devices: "pairing",
  appearance: "interface",
  access: "members",
  notification: "notifications",
  alerts: "notifications",
  dictation: "voice",
  microphone: "voice",
};

/** Resolve a (possibly aliased) key against the available section keys; unknown → first. */
export function resolveSettingsKey(raw: string | null | undefined, names: string[]): string {
  if (!raw) return names[0];
  if (names.indexOf(raw) !== -1) return raw;
  const alias = SETTINGS_ALIASES[raw];
  return alias && names.indexOf(alias) !== -1 ? alias : names[0];
}

export function tabFromHash(hash: string | null | undefined, names: string[]): string {
  const m = TAB_HASH_RE.exec(hash || "");
  return resolveSettingsKey(m ? m[1] : null, names);
}

/** The General section key. */
export const GENERAL_TAB = "general";

/* ====================================================================== *
 *  Anthropic API-key card (#294)                                          *
 * ====================================================================== */
interface KeyTestResult {
  ok: boolean;
  detail?: string | null;
}

/** Row-mode options (Models & providers, image-33 style). Omitted = the plain card (cloud section). */
export interface KeyRowOpts {
  /** render as a collapsible provider row (logo · name · masked key · Default · docs · chevron) */
  asRow?: boolean;
  /** this provider is the shipped default for Orcha's helpers */
  isDefault?: boolean;
  /** bump to re-fetch (the group's Refresh) */
  reload?: number;
  /** reports the loaded key state up (the group's "N connected" count) */
  onState?: (vm: KeyVM | null) => void;
}

export function KeyCard({ cid, asRow = false, isDefault = false, reload = 0, onState }: { cid: string | null } & KeyRowOpts) {
  const toast = useToast();
  const [vm, setVm] = useState<KeyVM | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<KeyTestResult | null>(null);
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
  }, [loadKey, reload]);

  useEffect(() => {
    onState?.(vm);
  }, [vm, onState]);

  // PR #315 human gate + the manage_keys grant (e2e-permissions-15): without
  // it the card renders read-only (the section names the reason once).
  const auth = useGrantAuthority("manage_keys");
  const who = auth.human;
  const requireHuman = (verb: string): boolean => {
    if (who) return true;
    toast(auth.reason || "Pick an acting human to " + verb + " the key", "warn");
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
      toast("Couldn't save the key — " + settingsErrText(e) + ". Your input is preserved.", "danger");
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
      setTestResult({ ok: false, detail: "Test failed — " + settingsErrText(e) + "." });
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
      toast("Couldn't remove the key — " + settingsErrText(e) + ".", "danger");
    }
  };

  if (loadErr) {
    const line = (
      <StatusLine
        tone="err"
        action={<Button size="sm" variant="ghost" icon="refresh" id="keyRetry" onClick={() => void loadKey()}>Retry</Button>}
      >
        Couldn&#39;t load the API-key status.
      </StatusLine>
    );
    return asRow ? (
      <ProviderRow key="err" id="anthropic" brand="anthropic" name="Anthropic" defaultOpen
        detail={<span className="mp-detail-t">Couldn&#39;t load the key status</span>} detailTone="warn"
        docsHref={PROVIDER_DOCS.anthropic}>
        {line}
      </ProviderRow>
    ) : line;
  }
  if (!vm) {
    return asRow ? (
      <ProviderRow id="anthropic" brand="anthropic" name="Anthropic"
        detail={<span className="mp-detail-t">Checking key status…</span>} docsHref={PROVIDER_DOCS.anthropic} />
    ) : <StatusLine tone="muted">Checking key status…</StatusLine>;
  }

  const hint =
    draft.trim().length > 0 && !looksLikeKey(draft)
      ? 'Heads up: Anthropic keys usually start with "sk-ant-". Test to confirm.'
      : "";

  const body = (
    <>
      <KeyBody
        vm={vm}
        name="Anthropic"
        provider="anthropic"
        unsetCopy="Universal-model features (guided onboarding, wake triage) are off until you add one."
        envCopy="it takes precedence over any stored key; read-only here."
        draft={draft}
        onDraft={(v) => { setDraft(v); setTestResult(null); }}
        reveal={reveal}
        onReveal={() => setReveal((r) => !r)}
        busy={busy}
        hint={hint}
        ids={{ input: "keyInput", reveal: "keyReveal", save: "keySave", test: "keyTest", clear: "keyClear", hint: "keyHint" }}
        onSave={() => void doSave()}
        onTest={() => void doTest()}
        onClear={doClear}
        testResult={testResult}
        locked={!auth.can}
        inRow={asRow}
      />
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
  if (!asRow) return body;
  return (
    <ProviderRow
      key="ok"
      id="anthropic"
      brand="anthropic"
      name="Anthropic"
      detail={<KeyDetail mode={vm.mode} masked={vm.masked} />}
      detailTone={vm.mode === "none" ? "warn" : undefined}
      badge={isDefault ? <DefaultBadge tip="The shipped default provider for Embodent's helpers" /> : null}
      docsHref={PROVIDER_DOCS.anthropic}
    >
      {body}
    </ProviderRow>
  );
}

/**
 * The shared body of every API-key card (Anthropic, each other provider —
 * open and cloud builds): one flat status line (Remove lives on it as a quiet
 * danger action), the secret field with an eye toggle, then Save (primary only
 * once something is typed) and Test. Env-managed keys are read-only: Test +
 * a note on how to change them.
 */
export function KeyBody({
  vm, name, provider, unsetCopy, envCopy, draft, onDraft, reveal, onReveal, busy, hint, ids = {},
  onSave, onTest, onClear, testResult, locked = false, inRow = false,
}: {
  vm: Pick<KeyVM, "mode" | "masked" | "editable" | "canClear" | "configured">;
  name: string;
  provider: string;
  unsetCopy: ReactNode;
  envCopy?: ReactNode;
  draft: string;
  onDraft: (v: string) => void;
  reveal: boolean;
  onReveal: () => void;
  busy: boolean;
  hint?: string;
  ids?: { input?: string; reveal?: string; save?: string; test?: string; clear?: string; hint?: string };
  onSave: () => void;
  onTest: () => void;
  onClear: () => void;
  testResult: KeyTestResult | null;
  /** no manage_keys authority (or still resolving): status only, no controls */
  locked?: boolean;
  /** inside a provider row: the row's detail line already shows the masked key (D12: once) */
  inRow?: boolean;
}) {
  const hasField = draft.trim().length > 0;
  const status =
    vm.mode === "db" ? (
      <StatusLine
        tone="ok"
        masked={inRow ? null : vm.masked || "sk-…"}
        action={vm.canClear && !locked ? (
          <Button size="sm" variant="ghost" className="sc-remove" icon="trash" id={ids.clear} onClick={onClear} disabled={busy}
            aria-label={"Remove " + name + " API key"}>
            Remove
          </Button>
        ) : null}
      >
        {/* D12: the group title already names the provider — the line says only the state */}
        <b>Configured</b> · stored encrypted on this project<span className="v2-sr"> ({name} API key)</span>
      </StatusLine>
    ) : vm.mode === "env" ? (
      <StatusLine tone="env" masked={inRow ? null : vm.masked || "sk-…"}>
        <b>Using <code>ORCHA_LLM_API_KEY</code> from the environment</b> · {envCopy || "it takes precedence; read-only here."}
      </StatusLine>
    ) : (
      <StatusLine tone="warn">
        <b>Not configured.</b><span className="v2-sr"> (No {name} API key)</span> {unsetCopy}
      </StatusLine>
    );

  // Read-only for this viewer (viewer role, member without manage_keys,
  // non-member, offline): the configured/unset state still shows; every key
  // write AND test is owner-or-manage_keys server-side, so no control renders.
  if (locked) return status;
  if (!vm.editable) {
    return (
      <>
        {status}
        <div className="sc-acts">
          <Button size="sm" variant="secondary" icon="spark" id={ids.test} disabled={busy} onClick={onTest}>
            Test stored key
          </Button>
          <EnvKeyHint provider={provider} />
        </div>
        {testResult && (
          <TestResult ok={testResult.ok}>
            {testResult.ok ? "Key is valid — " + name + " accepted it." : testResult.detail || "Key was rejected."}
          </TestResult>
        )}
      </>
    );
  }
  return (
    <>
      {status}
      <SecretInput
        id={ids.input}
        revealId={ids.reveal}
        label={(vm.mode === "db" ? "Replace the " : "") + name + " API key"}
        placeholder={vm.mode === "db" ? "Paste a new key to replace…" : "Paste " + name + " API key…"}
        value={draft}
        onChange={onDraft}
        reveal={reveal}
        onToggleReveal={onReveal}
      />
      {hint ? <div className="sc-hint" id={ids.hint}>{hint}</div> : null}
      <div className="sc-acts">
        <Button
          size="sm"
          variant={hasField ? "primary" : "secondary"}
          icon="check"
          id={ids.save}
          disabled={busy || !hasField}
          onClick={onSave}
        >
          {vm.mode === "db" ? "Replace key" : "Save key"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="spark"
          id={ids.test}
          disabled={busy || (!hasField && !vm.configured)}
          onClick={onTest}
        >
          Test
        </Button>
      </div>
      {testResult && (
        <TestResult ok={testResult.ok}>
          {testResult.ok ? "Key is valid — " + name + " accepted it." : testResult.detail || "Key was rejected."}
        </TestResult>
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
  asRow = false,
  isDefault = false,
}: {
  k: ProviderKeyCardVM;
  cid: string | null;
  asRow?: boolean;
  isDefault?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<KeyTestResult | null>(null);
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const auth = useGrantAuthority("manage_keys");
  const who = auth.human;
  const requireHuman = (verb: string): boolean => {
    if (who) return true;
    toast(auth.reason || "Pick an acting human to " + verb + " the key", "warn");
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
      toast("Couldn't save the key — " + settingsErrText(e) + ". Your input is preserved.", "danger");
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
      setTestResult({ ok: false, detail: "Test failed — " + settingsErrText(e) + "." });
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
      toast("Couldn't remove the key — " + settingsErrText(e) + ".", "danger");
    }
  };

  const keyBody = (
      <KeyBody
        vm={k}
        name={k.name}
        provider={k.provider}
        unsetCopy="Use-cases on this provider stay off until you add one."
        draft={draft}
        onDraft={(v) => { setDraft(v); setTestResult(null); }}
        reveal={reveal}
        onReveal={() => setReveal((r) => !r)}
        busy={busy}
        onSave={() => void doSave()}
        onTest={() => void doTest()}
        onClear={doClear}
        testResult={testResult}
        locked={!auth.can}
        inRow={asRow}
      />
  );
  const confirm = confirmClear && (
        <Modal
          title={"Remove " + k.name + " API key"}
          danger
          primary="Remove key"
          desc="Deletes the stored key for this provider from this workspace. If ORCHA_LLM_API_KEY is set in the environment, the client falls back to it."
          onPrimary={() => void doClearConfirmed()}
          onClose={() => setConfirmClear(false)}
        />
  );
  if (asRow) {
    return (
      <ProviderRow
        id={k.provider}
        brand={k.provider}
        name={k.name}
        detail={<KeyDetail mode={k.mode} masked={k.masked} />}
        detailTone={k.mode === "none" ? "warn" : undefined}
        badge={isDefault ? <DefaultBadge tip="The shipped default provider for Embodent's helpers" /> : null}
        docsHref={PROVIDER_DOCS[k.provider] || null}
      >
        <div className="pk-card" data-provider={k.provider}>
          {keyBody}
          {confirm}
        </div>
      </ProviderRow>
    );
  }
  return (
    <div className="pk-card" data-provider={k.provider}>
      <h3 className="pk-name">{k.name}</h3>
      {keyBody}
      {confirm}
    </div>
  );
}

export function ProviderKeysCard({
  cid, asRows = false, reload = 0, onKeys, defaults,
}: {
  cid: string | null;
  /** render each provider as a collapsible row (Models & providers) */
  asRows?: boolean;
  /** bump to re-fetch (the group's Refresh) */
  reload?: number;
  /** reports the loaded non-Anthropic key states up (the group's count) */
  onKeys?: (keys: ProviderKeyVM[] | null) => void;
  /** providers that are the shipped default for Orcha's helpers */
  defaults?: Set<string>;
}) {
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
  }, [loadKeys, reload]);

  useEffect(() => {
    onKeys?.(keys ? otherProviderKeys(keys) : null);
  }, [keys, onKeys]);

  if (loadErr) {
    const line = (
      <StatusLine
        tone="err"
        action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void loadKeys()}>Retry</Button>}
      >
        Couldn&#39;t load provider keys.
      </StatusLine>
    );
    return asRows ? <div className="mp-pad">{line}</div> : line;
  }
  if (!keys) return asRows ? null : <StatusLine tone="muted">Checking provider keys…</StatusLine>;

  const vms = otherProviderKeys(keys).map((k) => ({ ...k, onSaved: () => void loadKeys() }));
  if (asRows) {
    return (
      <>
        {vms.map((k) => (
          <PkCard key={k.provider} k={k} cid={cid} asRow isDefault={!!defaults?.has(k.provider)} />
        ))}
      </>
    );
  }
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
  locked = false,
}: {
  uc: UseCase;
  sel: Sel;
  catalog: Provider[];
  onProvider: (key: string, provider: string) => void;
  onModel: (key: string, model: string) => void;
  onReset: (key: string) => void;
  /** no manage_keys authority: the selection is shown, not editable */
  locked?: boolean;
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
            disabled={locked}
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
            disabled={locked || (!defModels.length && !retired)}
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
      </div>
      <div className="uc-foot">
        <span className={"uc-dot " + (overridden ? "on" : "off")} aria-hidden="true" />
        <span className="uc-state-txt">
          {overridden ? (
            <>
              Custom: {modelName(catalog, sel.provider, sel.model)}
              <span className="uc-default"> · Default: {modelName(catalog, uc.default_provider, uc.default_model)}</span>
            </>
          ) : (
            <>Default: {modelName(catalog, uc.default_provider, uc.default_model)}</>
          )}
        </span>
        {overridden && !locked && (
          <Button
            size="sm" variant="ghost" className="uc-reset" data-key={uc.key}
            aria-label={"Reset " + uc.label + " to its default model"} title="Reset to default"
            onClick={() => onReset(uc.key)}
          >
            Reset
          </Button>
        )}
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

/** Human model name from the catalog ("Claude Opus 5.5"), falling back to the raw id. */
export function modelName(catalog: Provider[] | null | undefined, providerId: string, modelId: string | null | undefined): string {
  if (!modelId) return "—";
  const p = (catalog || []).find((x) => x.id === providerId);
  const m = p?.models?.find((x) => x.id === modelId);
  return m ? m.name : modelId;
}

export function ModelsCard({ cid }: { cid: string | null }) {
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

  // PUT settings/models is owner-or-manage_keys (model_setting_routes.py).
  const auth = useGrantAuthority("manage_keys");
  const who = auth.human;
  const locked = !auth.can;

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
      toast(auth.reason || "Pick an acting human to change model settings", "warn");
      return;
    }
    setBusy(true);
    setSaveErr(false);
    const overrides = buildOverrides(staged, models, catalog);
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
        toast("Couldn't save model settings — the server sent an unexpected answer. Your edits are kept.", "danger");
      }
    } catch (e) {
      setBusy(false);
      setSaveErr(true);
      // preserve staged edits — a transient failure never loses them
      toast("Couldn't save model settings — " + settingsErrText(e) + ". Your edits are kept.", "danger");
    }
  };

  if (mdlErr) {
    return (
      <StatusLine
        tone="err"
        action={<Button size="sm" variant="ghost" icon="refresh" id="mdlRetry" onClick={() => void loadModels()}>Retry</Button>}
      >
        Couldn&#39;t load the model settings.
      </StatusLine>
    );
  }
  if (!models || !catalog) return <StatusLine tone="muted">Loading models…</StatusLine>;

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
            locked={locked}
          />
        ))}
      </div>
      {locked ? null : <div className="set-savebar">
        <Button
          size="sm"
          variant={dirty ? "primary" : "secondary"}
          icon="check"
          id="mdlSave"
          disabled={!(dirty && !busy)}
          busy={busy}
          onClick={() => void doSaveModels()}
        >
          Save changes
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" id="mdlDiscard" disabled={busy} onClick={onDiscard}>
            Discard
          </Button>
        )}
        {saveErr ? (
          <span className="set-err">Couldn&#39;t save — retry (your edits are kept).</span>
        ) : !dirty ? (
          <span className="saved">
            <Icon name="check" cls="" />
            All saved
          </span>
        ) : null}
      </div>}
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
  const [warn, setWarn] = useState<PairingErrorView | null>(null);
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
        // DP-ERR-1: the reachability warning ONLY for the structured 409
        // {reachable:false}; any other failure gets fixed, friendly copy by
        // status (the shared PairingModal mapping), raw text behind Details.
        const detail = (body as { detail?: PairingWarning | string } | null)?.detail;
        setData(null);
        setWarn(pairingErrorView(r.status, detail));
        setLoading(false);
        return;
      }
      setData(body as PairingPayload);
      setLoading(false);
    } catch (e) {
      setData(null);
      setWarn(pairingErrorView(null, null, (e as Error).message));
      setLoading(false);
    }
  }, [cid, humanId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <StatusLine tone="muted">Preparing pairing code…</StatusLine>;

  if (warn) {
    return (
      <div className="pair-warning v2-pair" role="alert">
        <StatusLine tone="warn">
          <b>{warn.title}</b>
        </StatusLine>
        <p className="set-note">{warn.message}</p>
        {warn.remedy && <div className="pair-remedy">{warn.remedy}</div>}
        {warn.wifiHint && (
          <p className="set-note">
            Both devices must be on the same Wi-Fi. Some VPNs and corporate networks block phone-to-laptop
            traffic.
          </p>
        )}
        {warn.details ? (
          <details className="pair-details">
            <summary>Details</summary>
            <code>{warn.details}</code>
          </details>
        ) : null}
        {warn.retry ? (
          <div className="sc-acts">
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => void load()}>{warn.retryLabel ?? "Try again"}</Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (!data) return null;

  const human = data.humanAgentAlias || "selected human";
  return (
    <div className="pair-card-body pair-grid v2-pair">
      <div className="pair-qr-wrap">
        <div className="pair-qr" role="img" aria-label="Orcha phone pairing QR code" dangerouslySetInnerHTML={{ __html: data.qrSvg || "" }} />
        <div className="pair-url mono">{data.baseUrl || ""}</div>
      </div>
      <dl className="set-facts pair-meta">
        <dt>Pairing as</dt>
        <dd className="pair-value">{human} (human)</dd>
        <dt>Manual code</dt>
        <dd><span className="pair-code mono">{data.shortCode || ""}</span></dd>
      </dl>
      <p className="set-note pair-foot">
        Your phone talks directly to this computer on your network. Nothing goes through the cloud.
      </p>
    </div>
  );
}

/* ====================================================================== *
 *  Project execution routing                                              *
 * ====================================================================== */
export function WorktreeRoutingCard({ cid }: { cid: string | null }) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const persisted = !!snap?.container?.worktrees_disabled;
  const [disabled, setDisabled] = useState(persisted);
  const [confirmOff, setConfirmOff] = useState(false);
  // EX-12: POST …/worktrees is owner-or-manage_autonomy (container_control_routes.py);
  // without it the switch is disabled with the reason, and never POSTs.
  const auth = useGrantAuthority("manage_autonomy");
  const who = auth.human;
  const locked = !auth.can;

  useEffect(() => setDisabled(persisted), [persisted]);

  const toggle = async () => {
    if (!cid || busy || locked) return;
    if (!who) {
      toast(auth.reason || "Pick an acting human to change worktree routing", "warn");
      return;
    }
    const next = !disabled;
    setBusy(true);
    try {
      await sendJSON("POST", "/api/containers/" + encodeURIComponent(cid) + "/worktrees", {
        disabled: next,
        actor_agent_id: who.id,
      });
      setDisabled(next);
      await refresh();
      toast(
        next
          ? "Worktrees disabled — future agent runs use the main checkout."
          : "Worktrees enabled — future agent runs use normal isolation.",
        "ok",
      );
    } catch (e) {
      toast("Couldn't change worktree routing — " + settingsErrText(e) + ".", "danger");
    }
    setBusy(false);
  };

  const isolated = !disabled;
  const onSwitch = () => {
    if (!cid || busy || locked) return;
    // turning isolation OFF is the risky direction — confirm with the warning
    if (isolated) setConfirmOff(true);
    else void toggle();
  };

  return (
    <div className="wt-setting set-rowi">
      <div className="wt-setting-main">
        <div className="wt-setting-title set-rowi-l" id="wtTitle">Isolated worktrees</div>
        <div className="wt-setting-desc set-rowi-d" id="wtDesc">
          {isolated
            ? "Each task or agent runs in its own Git worktree, so concurrent agents never share a checkout."
            : "Off — every agent runs in this project’s main checkout. Concurrent agents may edit the same checkout and can overwrite or conflict with each other’s changes."}
        </div>
      </div>
      {(() => {
        const sw = (
          <button
            type="button"
            className={"set-switch" + (isolated ? " on" : "") + (locked ? " is-locked" : "")}
            role="switch"
            id="wtSwitch"
            aria-checked={isolated}
            aria-labelledby="wtTitle"
            aria-describedby="wtDesc"
            aria-busy={busy || undefined}
            aria-disabled={locked || undefined}
            disabled={busy}
            onClick={onSwitch}
          >
            <span className="set-switch-knob" />
          </button>
        );
        // aria-disabled (not disabled) keeps the switch focusable so the
        // reason tooltip is reachable by keyboard too
        return locked && auth.reason ? <Tooltip label={auth.reason} placement="left">{sw}</Tooltip> : sw;
      })()}
      {confirmOff && (
        <Modal
          title="Turn off isolated worktrees?"
          danger
          primary="Turn off"
          desc="Every agent will run in this project's main checkout instead of an isolated task or agent worktree. Concurrent agents may edit the same checkout and can overwrite or conflict with each other's changes. Existing worktrees are not removed."
          onPrimary={() => { setConfirmOff(false); void toggle(); }}
          onClose={() => setConfirmOff(false)}
        />
      )}
    </div>
  );
}

/* ====================================================================== *
 *  V2 sections                                                            *
 * ====================================================================== */

/**
 * What to say while a section has no project data (pure, tested; SG-12 /
 * EX-14): the snapshot failure named for what it is — an HTTP answer is not
 * an outage — with Retry only where retrying can help.
 */
export function projectLoadState(error: string | null | undefined): { text: string; tone: "muted" | "warn" | "err"; retry: boolean } {
  switch (snapshotErrorKind(error)) {
    case "forbidden": return { text: "You're not a member of this project.", tone: "warn", retry: false };
    case "not_found": return { text: "This project couldn't be found.", tone: "warn", retry: false };
    case "server": return { text: "Couldn't load this project.", tone: "err", retry: true };
    case "network": return { text: "Can't reach Embodent.", tone: "err", retry: true };
    default: return { text: "Loading project…", tone: "muted", retry: false };
  }
}

function ProjectLoadLine({ id }: { id?: string }) {
  const { error, refresh } = useSnapshot();
  const st = projectLoadState(error);
  return (
    <div className="set-pad" id={id}>
      <StatusLine
        tone={st.tone}
        action={st.retry ? <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refresh()}>Retry</Button> : null}
      >
        {st.text}
      </StatusLine>
    </div>
  );
}

/** General: what this project is (read-only facts) + the per-user default-project star. */
function GeneralSection() {
  const { snap, cid, multi } = useSnapshot();
  const c = snap?.container ?? null;
  const [prefsOn, setPrefsOn] = useState(prefs.active());
  const [defCid, setDefCid] = useState<string | null>(prefs.defaultCid());
  useEffect(() => {
    let alive = true;
    void prefs.sync().then(() => {
      if (!alive) return;
      setPrefsOn(prefs.active());
      setDefCid(prefs.defaultCid());
    });
    return () => { alive = false; };
  }, []);
  const isDefault = cid != null && defCid != null && String(defCid) === String(cid);
  const toggleDefault = () => {
    const next = isDefault ? null : cid;
    prefs.setDefaultCid(next);
    setDefCid(next);
  };
  return (
    <SettingsGroup settab={GENERAL_TAB} title="Details" flush>
      {c ? (
        <SettingRows>
          <SettingRow label="Name"><span className="set-val">{c.name || "—"}</span></SettingRow>
          <ProjectIconRow cid={c.id} name={c.name || "this project"} />
          <ObjectiveRow cid={c.id} objective={c.description} />
          {/* SG-06: a PROJECT lifecycle status (Active / Paused …), never the task glyph set */}
          <SettingRow label="Status">
            <Chip size="sm" dot={projectStatusMeta(c.status).tone} className="set-proj-status" data-status={c.status || "active"}>
              {projectStatusMeta(c.status).label}
            </Chip>
          </SettingRow>
          <SettingRow label="Project ID"><span className="set-val mono" title={c.id}>{c.id}</span></SettingRow>
          {prefsOn && multi && cid ? (
            <SettingRow label="Default project" desc="Your default opens first when you sign in. Saved to your account.">
              <Button size="sm" variant={isDefault ? "secondary" : "ghost"} aria-pressed={isDefault} onClick={toggleDefault} id="setDefaultProject">
                {isDefault ? "Default project ✓" : "Make this my default project"}
              </Button>
            </SettingRow>
          ) : null}
        </SettingRows>
      ) : (
        <ProjectLoadLine id="generalLoad" />
      )}
    </SettingsGroup>
  );
}

/**
 * D14 — the project icon (emoji, or an app glyph + palette colour; unset = the
 * neutral cube, never initials). Same store and picker as the sidebar ⋯ menu's
 * "Change icon…": the canonical per-project `containers.icon` column
 * (PUT /api/containers/{cid}/icon via cloud/projects/projectIcons.ts
 * saveProjectIconResult), shared by portal and desktop.
 */
export function ProjectIconRow({ cid, name }: { cid: string; name: string }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const icon = useProjectIcon(cid);
  const current = icon ? icon.value : "default";
  // SG-09: PUT /icon is owner-or-manage_autonomy — without it the button is
  // disabled (aria-disabled, still focusable) with the reason; never a picker
  // whose every pick is refused and snaps back.
  const auth = useProjectIconAuthority(cid);
  const denied = !auth.pending && !auth.canEdit ? auth.reason || "You can't change this project's icon" : null;
  const btn = (
    <button
      ref={ref}
      type="button"
      id="setProjectIcon"
      className={"v2-btn v2-btn-ghost v2-btn-sm set-icon-btn" + (denied ? " is-locked" : "")}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-disabled={denied ? true : undefined}
      aria-label={"Change icon for " + name + " (current: " + current + ")"}
      onClick={() => { if (!denied) setOpen((o) => !o); }}
    >
      <ProjectIcon cid={cid} size={18} />
      <span className="v2-btn-label">Change icon…</span>
    </button>
  );
  return (
    <SettingRow label="Icon" desc="Shown beside the project in the sidebar and project lists." id="setProjectIconL">
      <span className="set-icon">
        {denied ? <Tooltip label={denied} placement="left">{btn}</Tooltip> : btn}
      </span>
      <ProjectIconPicker cid={cid} name={name} anchor={ref} open={open} onClose={() => setOpen(false)} placement="bottom-end" />
    </SettingRow>
  );
}

/** Execution: worktree routing (P-05), the agent limit, + where the notifier / autonomy controls live. */
function ExecutionSection() {
  const { snap, cid } = useSnapshot();
  const chrome = useChrome();
  const c = snap?.container ?? null;
  const level = autLevel(snap);
  // EX-14: with no project data there is nothing to show or change — one
  // honest line (+ Retry where it can help), no switch bound to a dead POST.
  if (!c) {
    return (
      <SettingsGroup settab="execution" title="Notifier and autonomy" flush>
        <ProjectLoadLine id="execLoad" />
      </SettingsGroup>
    );
  }
  return (
    <>
      <SettingsGroup
        settab="execution" title="Notifier and autonomy" flush
        help="The notifier wakes agents; autonomy decides how far they may go before a human decides. They are independent: pausing wakes never changes autonomy, and never stops runs already in progress."
        action={chrome ? (
          <Tooltip label="Change them from the header's Execution controls, with their confirmations." placement="top">
            <Button size="sm" variant="secondary" id="setOpenExec" onClick={() => chrome.setExecOpen(true)}>Change…</Button>
          </Tooltip>
        ) : null}
      >
        {(
          <SettingRows id="execFacts">
            {/* The OBSERVED wake service, worded exactly like the header chip
                (execChipState — the shared notifierState() mapping), so the
                two can never disagree; the line under it names the config. */}
            <SettingRow label="Notifier" desc={wakesObserved(c)}>
              <span className="set-val" id="setNotifierState">{execChipState(c)}</span>
            </SettingRow>
            <SettingRow label="Autonomy">
              <span className="set-val">{autonomyLabel(level).label}</span>
            </SettingRow>
          </SettingRows>
        )}
      </SettingsGroup>
      <SettingsGroup
        settab="execution" title="Agent workspace" flush
      >
        <WorktreeRoutingCard cid={cid} />
        {/* mig 056: the agent limit (PUT …/limits, owner-or-manage_agents) */}
        <SettingRows id="execLimits">
          <AgentLimitRow cid={cid} />
        </SettingRows>
      </SettingsGroup>
      {/* mig 067: agent worktree clean-up (GET/PUT …/agent-worktrees, owner-or-manage_autonomy) */}
      <AgentWorktreesSection cid={cid} />
      {/* mig 057: finished work follows the org chart (PUT …/review-routing, owner-or-assign_reviewers) */}
      {c.review_route != null ? (
        <SettingsGroup
          settab="execution" title="Review" flush
          help="Who verifies an agent's finished work. An agent's “done” is never the verification — a person always verifies; an AI manager's review is a recommendation."
        >
          <SettingRows id="execReview">
            <ReviewRoutingRow cid={cid} />
          </SettingRows>
        </SettingsGroup>
      ) : null}
    </>
  );
}

/**
 * The ONE reason line for Models & providers when this viewer can't change
 * keys or models (viewer, member without manage_keys, non-member, offline):
 * the cards themselves go read-only silently, so the reason is said once
 * (D12), not per card.
 */
function KeysLockNote() {
  const auth = useGrantAuthority("manage_keys");
  if (auth.can || auth.pending || !auth.reason) return null;
  return (
    <div className="set-lock-note" id="keysLocked" data-settab="provider-keys">
      <StatusLine tone="muted" icon="shield">View-only — {auth.reason}</StatusLine>
    </div>
  );
}

/**
 * Providers (image-33 rows): Anthropic (llm-key route) then every other
 * AVAILABLE catalog provider (provider-keys routes), each a collapsible row
 * whose panel is the unchanged key body (field · Save/Replace · Test · Remove).
 * Catalog providers that are stubbed (available:false) are listed under
 * "Coming soon" without controls. "Default" marks the provider the shipped
 * use-case defaults run on (GET settings/models default_provider) — reported,
 * not settable (there is no settable default provider).
 */
/** What a distribution's own non-Anthropic key rows need from the group (cloud: ProviderKeysSection). */
export interface ProviderRowsSlot {
  /** bump to re-fetch (the group's Refresh) */
  reload: number;
  /** report the loaded key states up (the group's "N connected" count) */
  onKeys: (keys: ProviderKeyState[] | null) => void;
  /** providers that are the shipped default for Orcha's helpers */
  defaults: Set<string>;
}
export type ProviderKeyState = Pick<ProviderKeyVM, "provider" | "configured">;

export function ProvidersGroup({
  cid, renderOthers,
}: {
  cid: string | null;
  /** replaces the open ProviderKeysCard rows (same ProviderRow look, distribution-owned wiring) */
  renderOthers?: (slot: ProviderRowsSlot) => ReactNode;
}) {
  const [reload, setReload] = useState(0);
  const [anth, setAnth] = useState<KeyVM | null>(null);
  const [others, setOthers] = useState<ProviderKeyState[] | null>(null);
  const [defaults, setDefaults] = useState<Set<string>>(() => new Set());
  const [soon, setSoon] = useState<Provider[]>([]);

  useEffect(() => {
    if (!cid) return;
    let live = true;
    const base = "/api/containers/" + encodeURIComponent(cid) + "/settings/";
    getJSON<{ use_cases?: UseCase[] }>(base + "models")
      .then((m) => { if (live) setDefaults(new Set((m?.use_cases || []).map((u) => u.default_provider).filter(Boolean))); })
      .catch(() => { if (live) setDefaults(new Set()); });
    getJSON<{ providers?: Provider[] }>(base + "providers")
      .then((p) => { if (live) setSoon((p?.providers || []).filter((x) => x && !x.available)); })
      .catch(() => { if (live) setSoon([]); });
    return () => { live = false; };
  }, [cid, reload]);

  const onAnth = useCallback((vm: KeyVM | null) => setAnth(vm), []);
  const onOthers = useCallback((ks: ProviderKeyState[] | null) => setOthers(ks), []);
  const connected = (anth?.configured ? 1 : 0) + (others || []).filter((k) => k.configured).length;
  const known = anth != null && others != null;
  // a provider that already has a key row is never also listed as "coming soon"
  const soonShown = soon.filter((p) => p.id !== "anthropic" && !(others || []).some((k) => k.provider === p.id));

  return (
    <SettingsGroup
      settab="provider-keys" title="Providers" flush className="mp-group"
      lead="API keys for Embodent's own helpers."
      help="Keys are stored encrypted on this project. ORCHA_LLM_API_KEY in the environment takes precedence over any stored key."
      action={
        <>
          {known ? <Chip size="sm">{connected + " connected"}</Chip> : null}
          <Button size="sm" variant="ghost" icon="refresh" id="providersRefresh" onClick={() => setReload((r) => r + 1)}>
            Refresh
          </Button>
        </>
      }
    >
      <div className="mp-list" id="providerKeys">
        <div id="keyCard" className="mp-contents">
          <KeyCard cid={cid} asRow isDefault={defaults.has("anthropic")} reload={reload} onState={onAnth} />
        </div>
        {renderOthers
          ? renderOthers({ reload, onKeys: onOthers, defaults })
          : <ProviderKeysCard cid={cid} asRows reload={reload} onKeys={onOthers} defaults={defaults} />}
      </div>
      {soonShown.length ? (
        <>
          <div className="mp-subhead">
            <span>Coming soon</span>
            <Chip size="sm">{soonShown.length + (soonShown.length === 1 ? " provider" : " providers")}</Chip>
          </div>
          <div className="mp-list" id="providersSoon">
            {soonShown.map((p) => (
              <ProviderRow
                key={p.id}
                id={p.id}
                brand={p.id}
                name={p.name}
                dimmed
                detail={<span className="mp-detail-t">Not supported yet</span>}
                docsHref={PROVIDER_DOCS[p.id] || null}
              />
            ))}
          </div>
        </>
      ) : null}
    </SettingsGroup>
  );
}

function ModelsGroup({ cid }: { cid: string | null }) {
  return (
    <SettingsGroup
      settab="provider-keys" title="Universal model selection" flush
      lead="The model behind each of Embodent's own helpers."
      help="Embodent's direct-API helpers (the universal client) — separate from each agent's own model, which is set per agent."
    >
      <div id="modelRows"><ModelsCard cid={cid} /></div>
    </SettingsGroup>
  );
}

function OpenPairingGroup({ cid }: { cid: string | null }) {
  return (
    <SettingsGroup settab="pairing" title="Phone pairing" lead="Scan the code with the Orcha mobile app on the same Wi-Fi.">
      <div id="pairingCard"><PairingCard cid={cid} /></div>
    </SettingsGroup>
  );
}

/** The repo this project is bound to (snapshot container.github_repo), or "Not connected". */
export function RepoLinkGroup() {
  const { snap } = useSnapshot();
  const repo = (snap?.container as { github_repo?: string | null } | undefined)?.github_repo || null;
  const known = !!snap?.container;
  return (
    <SettingsGroup settab="github-access" title="Repository" flush>
      <SettingRows>
        <SettingRow
          label="Connected repository"
          desc={known ? (
            repo ? (
              <span className="set-repo" id="setRepo" title={repo}>
                <Icon name="git" cls="" />
                <span className="set-repo-t">{repo}</span>
              </span>
            ) : <span id="setRepo">Not connected</span>
          ) : null}
        >
          <ButtonLink size="sm" variant="secondary" href="/github" iconRight="arrow">
            {known && !repo ? "Connect on GitHub" : "Open GitHub"}
          </ButtonLink>
        </SettingRow>
      </SettingRows>
    </SettingsGroup>
  );
}

function DesktopSignInGroup() {
  return (
    <SettingsGroup settab="pairing" title="Desktop app" flush>
      <SettingRows>
        <SettingRow
          label="Sign-in"
          desc="Opens a one-time sign-in page for the app."
        >
          <ButtonLink size="sm" variant="secondary" href="/auth/device?client=desktop" iconRight="arrow">Sign in the desktop app…</ButtonLink>
        </SettingRow>
      </SettingRows>
    </SettingsGroup>
  );
}

/**
 * DEV-SELFHOST: device sign-in (the desktop app row + Signed-in devices) only
 * works behind GitHub sign-in — device_token_routes refuses without a verified
 * identity. On a self-hosted (trust-off) portal both are replaced by one muted
 * line instead of a button that 403s and an error card.
 */
function DeviceSignInGroups({ cid }: { cid: string | null }) {
  const [trusted, setTrusted] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    // an identity timeout has no verdict: show the groups (their own calls
    // then say whether device sign-in is available)
    fetchMe(cid || "").then((m) => { if (alive) setTrusted(!!m.trusted); }, () => { if (alive) setTrusted(true); });
    return () => { alive = false; };
  }, [cid]);
  // D9: signed in with GitHub but a member of no project — one plain line, and
  // no "Sign in the desktop app" offer that can't work for them.
  const [notMember, setNotMember] = useState(false);
  const onNotMember = useCallback(() => setNotMember(true), []);
  if (trusted == null) return null;
  if (trusted && notMember) {
    return (
      <SettingsGroup settab="pairing" title="Desktop app & signed-in devices">
        <p className="set-note" id="deviceNotMember">{DEVICE_NOT_A_MEMBER}</p>
      </SettingsGroup>
    );
  }
  if (!trusted) {
    return (
      <SettingsGroup settab="pairing" title="Desktop app & signed-in devices">
        <p className="set-note" id="deviceSignInOff">{DEVICE_SIGNIN_UNAVAILABLE}</p>
      </SettingsGroup>
    );
  }
  return (
    <>
      <DesktopSignInGroup />
      <DeviceTokensSection onNotMember={onNotMember} />
    </>
  );
}

/** One V2 settings section: canonical key, title, one-line purpose, content. */
export interface SettingsGroup { key: string; title: string; sub: string; render: () => ReactNode }

/** Section-list glyph + cluster (Linear settings: a short grouped list). */
const SECTION_META: Record<string, { icon: string; cluster: string }> = {
  general: { icon: "folder", cluster: "Project" },
  execution: { icon: "play", cluster: "Project" },
  "provider-keys": { icon: "spark", cluster: "Project" },
  "github-access": { icon: "git", cluster: "Project" },
  members: { icon: "agents", cluster: "Access" },
  pairing: { icon: "phone", cluster: "Access" },
  notifications: { icon: "bell", cluster: "Personal" },
  voice: { icon: "mic", cluster: "Personal" },
  interface: { icon: "sidebar", cluster: "Personal" },
};
export function sectionMeta(key: string): { icon: string; cluster: string } {
  return SECTION_META[key] || { icon: "more", cluster: "More" };
}
/** The section list split into its clusters, in first-seen order. */
export function clusterSections<T extends { key: string }>(groups: T[]): { cluster: string; items: T[] }[] {
  const out: { cluster: string; items: T[] }[] = [];
  groups.forEach((g) => {
    const c = sectionMeta(g.key).cluster;
    const hit = out.find((x) => x.cluster === c);
    if (hit) hit.items.push(g);
    else out.push({ cluster: c, items: [g] });
  });
  return out;
}

const KNOWN_EXT = new Set(["provider-keys", "github-access", "members", "pairing", "appearance"]);

/**
 * Build the V2 section list from the open cards + the registered extension
 * sections. Pure except for reading `extensions` — exported for tests.
 */
export function buildSettingsGroups(cid: string | null, ext = extensions): SettingsGroup[] {
  const sections: SettingsSection[] = ext.settingsSections ?? [];
  const byKey = (k: string) => sections.find((s) => s.key === k) || null;
  const keyOn = ext.settingsGeneral?.key ?? true;
  const modelsOn = ext.settingsGeneral?.models ?? true;
  const hasRoute = (p: string) => (ext.routes || []).some((r) => r.path === p);
  const el = (s: SettingsSection | null) => (s ? <s.element /> : null);
  const groups: SettingsGroup[] = [];

  groups.push({ key: GENERAL_TAB, title: "General", sub: "What this project is.", render: () => <><GeneralSection />{cid ? <ProjectModeSection cid={cid} /> : null}<PortabilitySection /></> });
  groups.push({ key: "execution", title: "Execution", sub: "How and where agents run.", render: () => <ExecutionSection /> });

  const pk = byKey("provider-keys");
  groups.push({
    key: "provider-keys", title: "Models & providers",
    sub: "Agent runtimes, provider API keys and the models behind Embodent's own helpers.",
    render: () => (
      <>
        {(keyOn || modelsOn) && <KeysLockNote />}
        {/* the open layout; a distribution that brings its own key section (cloud: keyOn false) keeps its arrangement */}
        {keyOn && <RuntimesGroup />}
        {keyOn && <ProvidersGroup cid={cid} />}
        {el(pk)}
        {modelsOn && <ModelsGroup cid={cid} />}
      </>
    ),
  });

  const gh = byKey("github-access");
  const hasGh = !!gh || hasRoute("/github");
  // Integrations: GitHub (when this distribution has it) + the Verdikt QA handoff (always)
  groups.push({
    key: "github-access", title: "Integrations",
    sub: hasGh ? "GitHub access, the connected repository and Verdikt QA." : "Verdikt QA for finished work.",
    render: () => <>{el(gh)}{hasRoute("/github") && <RepoLinkGroup />}{cid ? <VerdiktSettingsSection cid={cid} /> : null}</>,
  });

  const mem = byKey("members");
  if (mem) {
    groups.push({ key: "members", title: "Members & access", sub: "Who can see and act in this project.", render: () => el(mem) });
  }

  const pair = byKey("pairing");
  groups.push({
    key: "pairing", title: "Devices & pairing",
    sub: hasRoute("/auth/device")
      ? "Pair a phone, sign in the desktop app, and manage the devices signed in as you."
      : "Pair a phone with this project.",
    render: () => (
      <>
        {pair ? el(pair) : <OpenPairingGroup cid={cid} />}
        {hasRoute("/auth/device") && <DeviceSignInGroups cid={cid} />}
      </>
    ),
  });

  groups.push({
    key: "notifications", title: "Notifications",
    sub: "What reaches you, and where. Saved instantly, just for you.",
    render: () => <NotificationsSection cid={cid} />,
  });

  groups.push({
    key: "voice", title: "Voice",
    sub: "Dictate into any text field: engine, language, clean-up, shortcut and microphone.",
    render: () => <VoiceSection cid={cid} />,
  });

  const app = byKey("appearance");
  groups.push({ key: "interface", title: "Interface", sub: "Theme, sidebar and keyboard.", render: () => (app ? el(app) : <InterfaceSection />) });

  // any other downstream section keeps its own place, after the V2 groups
  sections.filter((s) => !KNOWN_EXT.has(s.key)).forEach((s) => {
    groups.push({ key: s.key, title: s.title, sub: "", render: () => el(s) });
  });
  return groups;
}

/* ====================================================================== *
 *  The page                                                               *
 * ====================================================================== */
/** Sections whose cards read project-scoped routes: for someone who isn't a
 *  member (the snapshot itself answered 403) each card would fail on its own
 *  with a Retry that can't help — say "not a member" once instead (S1). */
const MEMBER_ONLY_SECTIONS = new Set(["provider-keys", "github-access", "members"]);

export function SettingsPage() {
  const { snap, cid, error } = useSnapshot();
  const groups = useMemo(() => buildSettingsGroups(cid), [cid]);
  const names = groups.map((g) => g.key);
  const namesKey = names.join("\u0000");

  const [tab, setTab] = useState(() => tabFromHash(window.location.hash, names));
  const navRef = useRef<HTMLDivElement | null>(null);
  const pillsRef = useRef<HTMLElement | null>(null);

  // #tab=<name> (or an alias) re-selects on hashchange (back/forward, manual
  // edit, a deep link from the sidebar/palette) without writing the hash back.
  useEffect(() => {
    const list = namesKey.split("\u0000");
    const sync = () => setTab(tabFromHash(window.location.hash, list));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [namesKey]);
  // Router navigations (palette "Settings: X", desktop host "Pair phone")
  // use history.pushState, which never fires hashchange: follow the router
  // location too. Keyed on location.key so re-navigating to the hash the
  // router last saw still re-selects after select() rewrote it locally.
  const location = useLocation();
  useEffect(() => {
    setTab(tabFromHash(location.hash || window.location.hash, namesKey.split("\u0000")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, location.hash, namesKey]);

  // Selecting a section rewrites the hash via replaceState (no history spam);
  // loading never writes the hash.
  const select = (name: string) => {
    setTab(name);
    try {
      history.replaceState(history.state, "", "#tab=" + name);
    } catch {
      window.location.hash = "tab=" + name;
    }
  };

  const onNavKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = names.indexOf(active);
    let j = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") j = (i + 1) % names.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") j = (i - 1 + names.length) % names.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = names.length - 1;
    if (j < 0) return;
    e.preventDefault();
    select(names[j]);
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-tab="${names[j]}"]`)?.focus());
  };

  const active = names.indexOf(tab) !== -1 ? tab : GENERAL_TAB;
  const group = groups.find((g) => g.key === active) || groups[0];

  // keep the active mobile pill in view (never an off-screen selection)
  useEffect(() => {
    const el = pillsRef.current?.querySelector<HTMLElement>(`[data-pill="${active}"]`);
    if (el && typeof el.scrollIntoView === "function" && pillsRef.current && pillsRef.current.scrollWidth > pillsRef.current.clientWidth) {
      el.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [active]);

  return (
    <Shell page="settings" title="Settings" ctx={snap?.container?.name}>
      <div className="set-layout">
        {/* narrow widths: a horizontally scrolling pill row (like the project
            tabs), edge-faded, with the active pill kept in view */}
        <nav className="set-nav-pills" id="setSectionPills" aria-label="Settings section" ref={pillsRef}>
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              className={"set-pill" + (g.key === active ? " on" : "")}
              data-pill={g.key}
              aria-current={g.key === active ? "page" : undefined}
              onClick={() => select(g.key)}
            >
              {g.title}
            </button>
          ))}
        </nav>
        <div
          className="set-nav" id="setTabs" role="tablist" aria-label="Settings sections"
          aria-orientation="vertical" ref={navRef} onKeyDown={onNavKey}
        >
          {clusterSections(groups).map(({ cluster, items }) => (
            <div className="set-nav-group" key={cluster} role="presentation">
              <div className="set-nav-h" aria-hidden="true">{cluster}</div>
              {items.map((g) => {
            const on = g.key === active;
            return (
              <button
                key={g.key}
                type="button"
                className={"set-nav-item" + (on ? " on" : "")}
                role="tab"
                id={"settab-" + g.key}
                aria-selected={on}
                aria-controls="setPanel"
                tabIndex={on ? 0 : -1}
                data-tab={g.key}
                onClick={() => select(g.key)}
              >
                <Icon name={sectionMeta(g.key).icon} cls="set-nav-ico" />
                <span className="set-nav-t">{g.title}</span>
              </button>
            );
              })}
            </div>
          ))}
        </div>
        <div className="set-wrap" data-tab={active} role="tabpanel" id="setPanel" aria-labelledby={"settab-" + active}>
          <div className="set-head">
            <h1 className="set-title v2-t-display">{group.title}</h1>
            {group.sub ? <p className="set-sub">{group.sub}</p> : null}
          </div>
          {!snap?.container && snapshotErrorKind(error) === "forbidden" && MEMBER_ONLY_SECTIONS.has(group.key)
            ? <ProjectLoadLine id="setNotMember" />
            : !snap?.container && snapshotErrorKind(error) === "forbidden" && group.key === GENERAL_TAB
              /* NEW-G6w: a non-member's General is the one not-a-member line only — no
                 Work type / Template sections whose reads would 403 on their own. */
              ? <GeneralSection />
              : group.render()}
        </div>
      </div>
    </Shell>
  );
}
