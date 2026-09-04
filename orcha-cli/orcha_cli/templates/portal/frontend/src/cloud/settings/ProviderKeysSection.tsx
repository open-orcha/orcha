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
 */
import { useCallback, useEffect, useState } from "react";
import { Icon, Modal, useToast } from "../../components/ui";
import { KeyCard } from "../../pages/settings/SettingsPage";
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
}
interface PkVM {
  provider: string;
  name: string;
  mode: "db" | "env" | "none";
  configured: boolean;
  masked: string | null;
  editable: boolean; // env keys are managed outside the portal
  canClear: boolean; // only a DB-stored key can be removed here
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

/* ---- the section (renders its own settings card) -------------------------- */
export function ProviderKeysSection() {
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

  useEffect(() => { void load(); }, [load]);

  // PR #315 human gate — vanilla requireHuman() wording, actor via the shared
  // cloud acting helpers (trusted lane: the resolved member or nothing).
  const who = memActor(me, snap);
  const requireHuman = (verb: string): boolean => {
    if (who) return true;
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
      toast("Couldn't save the key (" + res.status + "). Your input is preserved.", "danger");
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
        : { ok: false, detail: "Test failed (" + res.status + ")." },
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
      toast("Couldn't remove the key (" + res.status + ").", "danger");
    }
  };

  const card = (k: PkVM) => {
    const p = k.provider;
    const has = (drafts[p] || "").trim().length > 0;
    const isBusy = !!busy[p];
    const tr = tests[p];
    const banner =
      k.mode === "db" ? (
        <div className="sc-banner ok">
          <div className="bt">
            <Icon name="check" cls="" />
            <span><b>{k.name} API key configured</b> — stored encrypted on this workspace.</span>
          </div>
          <code className="masked">{k.masked || "sk-…"}</code>
        </div>
      ) : k.mode === "env" ? (
        <div className="sc-banner ok">
          <div className="bt">
            <Icon name="shield" cls="" />
            <span><b>Using <code>ORCHA_LLM_API_KEY</code> from the environment</b> — it takes precedence; read-only here.</span>
          </div>
          <code className="masked">{k.masked || "sk-…"}</code>
        </div>
      ) : (
        <div className="sc-banner warn">
          <div className="bt">
            <Icon name="bell" cls="" />
            <span><b>No {k.name} API key configured.</b> Use-cases set to {k.name} are off until you add one.</span>
          </div>
        </div>
      );
    const editor = k.editable ? (
      <>
        <div className="sc-row">
          <input
            id={"pk-input-" + p}
            className="sc-inp"
            type={reveal[p] ? "text" : "password"}
            spellCheck={false}
            autoComplete="off"
            placeholder={k.mode === "db" ? "Paste a new key to replace…" : "Paste " + k.name + " API key…"}
            value={drafts[p] || ""}
            onChange={(e) => {
              const v = e.target.value;
              setDrafts((d) => ({ ...d, [p]: v }));
              setTests((t) => ({ ...t, [p]: null }));
            }}
          />
          <button
            className="iconbtn" id={"pk-reveal-" + p} type="button" title="Show / hide"
            onClick={() => setReveal((r) => ({ ...r, [p]: !r[p] }))}
          >
            <Icon name="search" cls="" />
          </button>
        </div>
        <div className="sc-acts">
          <button className="btn sm" id={"pk-save-" + p} disabled={isBusy || !has} onClick={() => void doSave(p)}>
            <Icon name="check" cls="" />{k.mode === "db" ? "Replace key" : "Save key"}
          </button>
          <button
            className="btn sm ghost" id={"pk-test-" + p}
            disabled={isBusy || (!has && !k.configured)}
            onClick={() => void doTest(p)}
          >
            <Icon name="spark" cls="" />Test
          </button>
          {k.canClear && (
            <button className="btn sm danger" id={"pk-clear-" + p} onClick={() => doClear(p)}>
              <Icon name="x" cls="" />Remove
            </button>
          )}
        </div>
      </>
    ) : (
      <>
        <div className="sc-acts">
          <button className="btn sm ghost" id={"pk-test-" + p} disabled={isBusy} onClick={() => void doTest(p)}>
            <Icon name="spark" cls="" />Test stored key
          </button>
        </div>
        <div className="sc-hint">
          To change an environment key, update <code>ORCHA_LLM_API_KEY</code> and relaunch with <code>orcha up</code>.
        </div>
      </>
    );
    return (
      <div className="pk-card" data-provider={p} key={p}>
        {banner}
        {editor}
        {tr && (
          <div className={"sc-result " + (tr.ok ? "ok" : "err")}>
            <Icon name={tr.ok ? "check" : "x"} cls="" />
            <span>{tr.ok ? "Key is valid — " + k.name + " accepted it." : tr.detail || "Key was rejected."}</span>
          </div>
        )}
      </div>
    );
  };

  const content = pkErr ? (
    <div className="sc-banner err">
      <div className="bt">
        <Icon name="x" cls="" />
        <span>Couldn&#39;t load provider keys.</span>
      </div>
      <button className="btn sm ghost" id="pkRetry" onClick={() => void load()}>Retry</button>
    </div>
  ) : !pkeys ? (
    <div className="sc-banner muted">
      <div className="bt">
        <Icon name="clock" cls="" />
        <span>Checking provider keys…</span>
      </div>
    </div>
  ) : !pkeys.length ? (
    <div className="sc-hint">No additional providers are available yet.</div>
  ) : (
    pkeys.map(card)
  );

  return (
    <>
      {/* Anthropic first — the open KeyCard re-homed here (settings.html kept
          the Anthropic card alongside the other key cards; card markup + lead
          verbatim from the open General-tab copy this replaces). */}
      <div className="card set-card">
        <div className="card-h"><h2>Anthropic API key</h2></div>
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

      <div className="card set-card">
      <div className="card-h"><h2>xAI / Grok API key</h2></div>
      <div className="card-b">
        <div className="lead">
          Stored encrypted on this workspace and used when a use-case is set to xAI (Grok) —
          wake triage, onboarding proposal, image-to-text, digest curation. As above,{" "}
          <code>ORCHA_LLM_API_KEY</code> takes precedence when present.
        </div>
        <div id="providerKeys">{content}</div>
      </div>
      {clearing && (
        <Modal
          title="Remove API key"
          danger
          primary="Remove key"
          desc="Deletes the stored key for this provider from this workspace. If ORCHA_LLM_API_KEY is set in the environment, the client falls back to it."
          onPrimary={() => void doClearConfirmed(clearing)}
          onClose={() => setClearing(null)}
        />
      )}
      </div>
    </>
  );
}
