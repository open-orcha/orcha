/**
 * ORCHA CLOUD — per-provider API-key settings section. React port of the
 * vanilla modules/settings-provider-keys.js + the settings.html
 * "xAI / Grok API key" card (multi-provider follow-on to #294 Item 1).
 *
 * ONE home for every provider key (vanilla settings.html kept the Anthropic
 * card and the xAI/Grok card together under the Workspace tab): the section
 * renders the open Anthropic KeyCard as its FIRST card — the open General-tab
 * copy is hidden via extensions.settingsGeneral.key:false — then one card per
 * AVAILABLE non-Anthropic catalog provider (e.g. xAI/Grok), mirroring the
 * Anthropic card but wired to the provider-scoped routes so a use-case set to
 * xAI has somewhere to put an xAI key. Wire contract
 * (backend UNCHANGED — byte-exact with the vanilla module):
 *   GET    /api/containers/{cid}/settings/provider-keys        -> {keys:[…]}
 *   PUT    …/settings/provider-keys/{provider}   {api_key, actor_agent_id}
 *   DELETE …/settings/provider-keys/{provider}   {actor_agent_id}
 *   POST   …/settings/provider-keys/{provider}/test {api_key?, actor_agent_id}
 * Every mutation is HUMAN-GATED (PR #315): the body carries actor_agent_id
 * and the card refuses to fire without one — resolved through the shared
 * cloud identity layer (fetchMe + memActor), so the trusted proxy lane's
 * signed-in member is the ONLY possible actor.
 *
 * V2 look (image-33 rows): the section renders the SAME Models & providers
 * groups as the open layout — Agent runtimes, then the Providers group
 * (Anthropic KeyCard row, "N connected", Refresh, Default badge, docs link,
 * Coming soon) — and plugs its own provider rows into the group's slot, so
 * the wire contract, human gate and error copy above stay cloud-owned while
 * every row is the shared ProviderRow (logo · name · masked key · chevron →
 * the unchanged KeyBody).
 */
import { useCallback, useEffect, useState } from "react";
import { Modal, useToast } from "../../components/ui";
import { Button } from "../../components/primitives";
import { KeyBody, ProvidersGroup, type ProviderRowsSlot } from "../../pages/settings/SettingsPage";
import { StatusLine, settingsErrText } from "../../pages/settings/settingsUi";
import { DefaultBadge, KeyDetail, PROVIDER_DOCS, ProviderRow, RuntimesGroup } from "../../pages/settings/providerRows";
import { useGrantAuthority } from "../../pages/settings/grantAuthority";
import { AgentKeyToggle, agentEntryOf, providerUnsetCopy, type AgentKeyEntry } from "../../pages/settings/AgentKeyToggle";
import { errorDetailText } from "../../api/client";
import { useSnapshot } from "../../state/SnapshotProvider";
import { fetchMe, memActor, type Me } from "../identity";
import "./settings-cards.css";

/* ---- view-model (port of settings-key-state.js keyState) ------------------ */
interface PkKeyResp {
  provider: string;
  name: string;
  configured?: boolean;
  masked?: string | null;
  source?: string | null;
  stored?: boolean;
  use_for_agents?: boolean;
  agent_runtime?: string | null;
}
interface PkVM {
  provider: string;
  name: string;
  mode: "db" | "env" | "none";
  configured: boolean;
  masked: string | null;
  editable: boolean; // env keys are managed outside the portal
  canClear: boolean; // only a DB-stored key can be removed here
  agent: AgentKeyEntry | null; // "Use for agent runs" (migration 071); null on an older portal
}
export function pkKeyState(data: PkKeyResp): PkVM {
  const src = data.source === "db" || data.source === "env" ? data.source : null;
  const configured = src != null || data.configured === true;
  const mode = src === "db" ? "db" : src === "env" ? "env" : "none";
  return {
    provider: data.provider,
    name: data.name,
    mode,
    configured,
    masked: data.masked || null,
    editable: mode !== "env",
    canClear: mode === "db",
    agent: agentEntryOf(data.provider, data),
  };
}

interface PkTest { ok: boolean; detail?: string | null }

/* raw fetch with status passthrough — port of the vanilla api() helper (the
 * error copy interpolates res.status, so exceptions won't do). */
interface PkRes { ok: boolean; status: number; body: Record<string, unknown> | null }
async function pkApi(method: string, path: string, body?: unknown): Promise<PkRes> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    const r = await fetch(path, init);
    let j: PkRes["body"] = null;
    try { j = (await r.json()) as PkRes["body"]; } catch { /* empty body */ }
    return { ok: r.ok, status: r.status, body: j };
  } catch { return { ok: false, status: 0, body: null }; }
}

/** A failed key call in words: the server's detail, else the status meaning
 * (never a bare "(403)"). Pure, tested. */
export function pkErrText(res: PkRes): string {
  const d = res.body && (res.body as { detail?: unknown }).detail;
  const t = d != null ? errorDetailText(d) : "";
  return t || settingsErrText({ status: res.status });
}

/* ---- the section: the shared Models & providers groups -------------------- */
export function ProviderKeysSection() {
  const { cid } = useSnapshot();
  const renderOthers = useCallback(
    (slot: ProviderRowsSlot) => <CloudProviderKeyRows {...slot} />,
    [],
  );
  return (
    <>
      <RuntimesGroup />
      <ProvidersGroup cid={cid} renderOthers={renderOthers} />
    </>
  );
}

/* ---- the non-Anthropic provider rows (cloud wiring) ------------------------ */
function CloudProviderKeyRows({ reload, onKeys, defaults }: ProviderRowsSlot) {
  const { snap, cid } = useSnapshot();
  const toast = useToast();
  const [pkeys, setPkeys] = useState<PkVM[] | null>(null); // null until loaded
  const [pkErr, setPkErr] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({}); // provider -> mutation in flight
  const [tests, setTests] = useState<Record<string, PkTest | null>>({}); // last test verdict
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // typed keys — the 3s poll never clobbers them
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [clearing, setClearing] = useState<string | null>(null); // provider pending Remove confirm
  const [me, setMe] = useState<Me | null>(null);

  // Collab v1: resolve the acting identity once per page load — the shared
  // single-flighted fetchMe (src/cloud/identity.ts, vanilla data.js parity).
  useEffect(() => {
    if (!cid) return;
    let alive = true;
    void fetchMe(cid).then((m) => { if (alive) setMe(m); });
    return () => { alive = false; };
  }, [cid]);

  const load = useCallback(async () => {
    if (!cid) return;
    setPkErr(false);
    const res = await pkApi("GET", "/api/containers/" + encodeURIComponent(cid) + "/settings/provider-keys");
    const body = res.body as { keys?: PkKeyResp[] } | null;
    if (res.ok && body && Array.isArray(body.keys)) {
      // Anthropic has its own dedicated card; render every OTHER available provider here.
      setPkeys(body.keys.filter((k) => k.provider !== "anthropic").map(pkKeyState));
    } else {
      setPkeys(null);
      setPkErr(true);
    }
  }, [cid]);

  useEffect(() => { void load(); }, [load, reload]);
  useEffect(() => { onKeys(pkeys); }, [pkeys, onKeys]);

  // PR #315 human gate — vanilla requireHuman() wording, actor via the shared
  // cloud acting helpers (trusted lane: the resolved member or nothing).
  // Parity e2e-permissions-15 / MP-PERM-VIEWER: keys need owner or manage_keys
  // (the server's enforce_grant); the reason sits once at the section top.
  const auth = useGrantAuthority("manage_keys");
  const locked = !auth.can;
  const who = locked ? null : memActor(me, snap);
  const requireHuman = (verb: string): boolean => {
    if (who) return true;
    if (locked && auth.reason) { toast(auth.reason, "warn"); return false; }
    toast("Pick an acting human to " + verb + " the key", "warn");
    return false;
  };

  const pkUrl = (provider: string, suffix = "") =>
    "/api/containers/" + encodeURIComponent(cid || "") +
    "/settings/provider-keys/" + encodeURIComponent(provider) + suffix;

  const doSave = async (p: string) => {
    const v = (drafts[p] || "").trim();
    if (!v || busy[p]) return;
    if (!requireHuman("save")) return;
    setBusy((b) => ({ ...b, [p]: true }));
    const res = await pkApi("PUT", pkUrl(p), { api_key: v, actor_agent_id: who ? who.id : null });
    setBusy((b) => ({ ...b, [p]: false }));
    if (res.ok) {
      toast("API key saved.", "ok");
      setTests((t) => ({ ...t, [p]: null }));
      setDrafts((d) => ({ ...d, [p]: "" }));
      setReveal((r) => ({ ...r, [p]: false }));
      void load();
    } else {
      // keep the typed value — a transient failure never loses it
      toast("Couldn't save the key — " + pkErrText(res) + ". Your input is preserved.", "danger");
    }
  };

  const doTest = async (p: string) => {
    if (busy[p]) return;
    const v = (drafts[p] || "").trim();
    if (!requireHuman("test")) return;
    setBusy((b) => ({ ...b, [p]: true }));
    setTests((t) => ({ ...t, [p]: null }));
    // Send the pasted key if present, else test the stored key (omit api_key).
    const res = await pkApi(
      "POST",
      pkUrl(p, "/test"),
      v ? { api_key: v, actor_agent_id: who ? who.id : null } : { actor_agent_id: who ? who.id : null },
    );
    setBusy((b) => ({ ...b, [p]: false }));
    setTests((t) => ({
      ...t,
      [p]: res.ok && res.body
        ? { ok: !!(res.body as { ok?: boolean }).ok, detail: (res.body as { detail?: string }).detail }
        : { ok: false, detail: "Test failed — " + pkErrText(res) + "." },
    }));
  };

  const doClear = (p: string) => {
    if (busy[p]) return;
    if (!requireHuman("remove")) return;
    setClearing(p);
  };

  const doClearConfirmed = async (p: string) => {
    setBusy((b) => ({ ...b, [p]: true }));
    const res = await pkApi("DELETE", pkUrl(p), { actor_agent_id: who ? who.id : null });
    setBusy((b) => ({ ...b, [p]: false }));
    setClearing(null);
    if (res.ok) {
      toast("API key removed.", "ok");
      setTests((t) => ({ ...t, [p]: null }));
      void load();
    } else {
      toast("Couldn't remove the key — " + pkErrText(res) + ".", "danger");
    }
  };

  const row = (k: PkVM) => {
    const p = k.provider;
    const tr = tests[p];
    return (
      <ProviderRow
        key={p}
        id={p}
        brand={p}
        name={k.name}
        detail={<KeyDetail mode={k.mode} masked={k.masked} />}
        detailTone={k.mode === "none" ? "warn" : undefined}
        badge={defaults.has(p) ? <DefaultBadge tip="The shipped default provider for Embodent's helpers" /> : null}
        docsHref={PROVIDER_DOCS[p] || null}
      >
        <div className="pk-card" data-provider={p}>
          <KeyBody
            vm={k}
            name={k.name}
            provider={p}
            unsetCopy={providerUnsetCopy(p)}
            draft={drafts[p] || ""}
            onDraft={(v) => {
              setDrafts((d) => ({ ...d, [p]: v }));
              setTests((t) => ({ ...t, [p]: null }));
            }}
            reveal={!!reveal[p]}
            onReveal={() => setReveal((r) => ({ ...r, [p]: !r[p] }))}
            busy={!!busy[p]}
            ids={{ input: "pk-input-" + p, reveal: "pk-reveal-" + p, save: "pk-save-" + p, test: "pk-test-" + p, clear: "pk-clear-" + p }}
            onSave={() => void doSave(p)}
            onTest={() => void doTest(p)}
            onClear={() => doClear(p)}
            testResult={tr || null}
            locked={locked}
            inRow
          />
          <AgentKeyToggle cid={cid} provider={p} entry={k.agent} />
        </div>
      </ProviderRow>
    );
  };

  const clearingName = clearing ? (pkeys || []).find((k) => k.provider === clearing)?.name || "provider" : "";

  return (
    <>
      {/* rows sit inside the group's #providerKeys list, after the Anthropic
          KeyCard row; loading renders nothing (the Anthropic row already says
          "Checking…"), an error keeps its Retry. */}
      {pkErr ? (
        <div className="mp-pad">
          <StatusLine
            tone="err"
            action={<Button size="sm" variant="ghost" icon="refresh" id="pkRetry" onClick={() => void load()}>Retry</Button>}
          >
            Couldn&#39;t load provider keys.
          </StatusLine>
        </div>
      ) : (pkeys || []).map(row)}
      {clearing && (
        <Modal
          title={"Remove " + clearingName + " API key"}
          danger
          primary="Remove key"
          desc="Deletes the stored key for this provider from this workspace. If ORCHA_LLM_API_KEY is set in the environment, the client falls back to it."
          onPrimary={() => void doClearConfirmed(clearing)}
          onClose={() => setClearing(null)}
        />
      )}
    </>
  );
}
