/**
 * Settings → Integrations › Verdikt (mig 058) — per-project handoff to a
 * Verdikt QA agent (github: Husseinovich/verdikt).
 *
 *   GET  /api/containers/{cid}/verdikt        settings (members read)
 *   PUT  /api/containers/{cid}/verdikt        save (owner or manage_repo)
 *   POST /api/containers/{cid}/verdikt/test   connection check (owner or manage_repo)
 *
 * Fields: on/off, Verdikt URL (the site, e.g. http://localhost:3100 or the Mac
 * app's :31100), Verdikt project slug, what to test (web URL / iOS bundle id /
 * Android package), when (manual button only / automatically when a task
 * that touched UI files reaches verification / on every verification) and the
 * timeout. The integrator mounts <VerdiktSettingsSection cid={cid} /> in the
 * Integrations tab; <VerdiktSettingsGroup> is the prop-driven core (tested).
 *
 * Preview (mig 064, web targets): a command the host notifier runs in the
 * task's worktree to build + serve the change on a free port ({port},
 * {worktree}, {branch}), a ready-check path, a start timeout and a time limit.
 * Verdikt then tests that preview instead of whatever runs at the URL.
 * "Open Verdikt" opens the project in Verdikt's own UI
 * (GET /api/containers/{cid}/verdikt/open, a browser-reachable redirect).
 *
 * Auto-fix (mig 068): "When Verdikt fails, send it back to the agent
 * automatically" (off by default) + Max attempts (default 3, 1–10). It only
 * takes effect while Verdikt runs automatically (When = UI changes / every
 * task); with "Only when someone presses Run in Verdikt" both controls are
 * disabled and say why. A pass never completes a task — a person verifies.
 */
import { useEffect, useState } from "react";
import { Button, ButtonLink, Segmented } from "../../../components/primitives";
import { useActingAuthority, useSnapshot } from "../../../state/SnapshotProvider";
import { SettingRow, SettingRows, SettingsGroup, StatusLine } from "../settingsUi";
import type { VerdiktSettings } from "../../tasks/evidence/evidenceTypes";

export const VERDIKT_GRANT_REASON = "Requires the owner role or the Repository permission (manage_repo)";

interface TestResult {
  reachable: boolean;
  ok: boolean;
  worker_online: boolean | null;
  project_found: boolean | null;
  project: { slug: string; name: string } | null;
  projects: { slug: string; name: string; archived: boolean }[];
  error: string | null;
}

const KIND_LABEL: Record<VerdiktSettings["target_kind"], { label: string; ph: string; desc: string }> = {
  web: { label: "Web", ph: "http://localhost:3000", desc: "The URL Verdikt opens in Chromium" },
  ios: { label: "iOS", ph: "com.example.MyApp", desc: "Bundle id of the app installed on the simulator" },
  android: { label: "Android", ph: "com.example.app", desc: "Package installed on the emulator/device" },
};

const WHEN: { key: VerdiktSettings["trigger_mode"]; label: string }[] = [
  { key: "manual", label: "Only when someone presses Run in Verdikt" },
  { key: "ui_changes", label: "Automatically when a task that changed UI files awaits verification" },
  { key: "always", label: "Automatically for every task that awaits verification" },
];

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; d: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let d = {};
    try { d = await r.json(); } catch { /* empty */ }
    return { ok: r.ok, status: r.status, d };
  } catch {
    return { ok: false, status: 0, d: { detail: "the portal could not be reached" } };
  }
}
function det(d: { detail?: unknown }): string {
  const x = d?.detail;
  if (typeof x === "string") return x;
  if (Array.isArray(x) && x[0]?.msg) return String(x[0].msg);
  return "";
}

export interface VerdiktSettingsGroupProps {
  cid: string | null;
  /** acting human allowed to write (owner / manage_repo); null → read-only with `reason` */
  actorId: string | null;
  reason?: string | null;
}

export function VerdiktSettingsGroup({ cid, actorId, reason }: VerdiktSettingsGroupProps) {
  const [saved, setSaved] = useState<VerdiktSettings | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [form, setForm] = useState<VerdiktSettings | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  // an older backend without the Verdikt routes (or a non-settings answer): no section at all
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!cid) return;
    let live = true;
    call("GET", "/api/containers/" + encodeURIComponent(cid) + "/verdikt").then((r) => {
      if (!live) return;
      const d = r.d as Partial<VerdiktSettings> | null;
      const shaped = !!d && typeof d === "object" && typeof d.enabled === "boolean" && !!d.target_kind && d.target_kind in KIND_LABEL;
      if (r.ok && shaped) {
        setSaved(r.d as VerdiktSettings);
        setForm(r.d as VerdiktSettings);
        setLoadErr(null);
      } else if (r.ok || (r.status === 404 && det(r.d) === "Not Found")) setUnsupported(true);
      else setLoadErr((r.status ? "HTTP " + r.status : "Not loaded") + (det(r.d) ? " — " + det(r.d) : ""));
    });
    return () => { live = false; };
  }, [cid]);

  const locked = !actorId;
  const set = <K extends keyof VerdiktSettings>(k: K, v: VerdiktSettings[K]) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setMsg(null);
  };
  const dirty = !!form && !!saved && JSON.stringify(pick(form)) !== JSON.stringify(pick(saved));

  const save = async () => {
    if (!cid || !form || locked) return;
    setBusy("save");
    const r = await call("PUT", "/api/containers/" + encodeURIComponent(cid) + "/verdikt", { ...pick(form), actor_agent_id: actorId });
    setBusy(null);
    if (r.ok) {
      setSaved(r.d as VerdiktSettings);
      setForm(r.d as VerdiktSettings);
      setMsg({ tone: "ok", text: "Saved." });
    } else setMsg({ tone: "err", text: "Not saved — " + (det(r.d) || "HTTP " + r.status) });
  };
  const runTest = async () => {
    if (!cid || !form || locked) return;
    setBusy("test");
    setTest(null);
    const r = await call("POST", "/api/containers/" + encodeURIComponent(cid) + "/verdikt/test", {
      actor_agent_id: actorId, base_url: form.base_url || undefined, verdikt_project: form.verdikt_project || undefined,
    });
    setBusy(null);
    if (r.ok) setTest(r.d as TestResult);
    else setMsg({ tone: "err", text: "Check failed — " + (det(r.d) || "HTTP " + r.status) });
  };

  const lead = "Hand a task's definition of done to Verdikt; its verdicts, screenshots and report land in the task's evidence.";
  if (unsupported) return null;
  if (loadErr) {
    return (
      <SettingsGroup settab="github-access" title="Verdikt" lead={lead}>
        <StatusLine tone="err">Verdikt settings could not be loaded — {loadErr}</StatusLine>
      </SettingsGroup>
    );
  }
  if (!form) {
    return <SettingsGroup settab="github-access" title="Verdikt" lead={lead}><div className="set-rowi-d">Loading…</div></SettingsGroup>;
  }
  const kind = KIND_LABEL[form.target_kind];
  const previewSupported = !!saved && "preview_command" in saved;
  const autofixSupported = !!saved && "autofix_enabled" in saved;
  const autofixApplies = form.trigger_mode !== "manual";
  return (
    <SettingsGroup
      settab="github-access"
      title="Verdikt"
      lead={lead}
      help="Embodent creates one Verdikt scenario per task (its UI-checkable definition-of-done lines become the acceptance criteria; the task, changed files, branch and PR go in its description) and queues a run. Results are polled back. A Verdikt verdict is evidence — the human still accepts or rejects the task."
      flush
      id="verdiktSettings"
    >
      <SettingRows label="Verdikt settings">
        <SettingRow label="Status" desc={saved?.enabled ? (saved.configured ? "On" : "On — incomplete") : "Off"}>
          <label className="vk-switch">
            <input type="checkbox" checked={form.enabled} disabled={locked || !!busy} aria-label="Enable Verdikt" onChange={(e) => set("enabled", e.target.checked)} />
            <span>{form.enabled ? "Enabled" : "Disabled"}</span>
          </label>
        </SettingRow>
        <SettingRow label="Verdikt URL" desc="The Verdikt site (dev: http://localhost:3100 · Mac app: http://localhost:31100)">
          <input className="sc-inp vk-inp" id="vkUrl" aria-label="Verdikt URL" placeholder="http://localhost:3100" value={form.base_url || ""} disabled={locked || !!busy}
            onChange={(e) => set("base_url", e.target.value)} />
        </SettingRow>
        <SettingRow label="Verdikt project" desc="The project slug in Verdikt">
          <input className="sc-inp vk-inp" id="vkProject" aria-label="Verdikt project" placeholder="my-app" list="vkProjects" value={form.verdikt_project || ""} disabled={locked || !!busy}
            onChange={(e) => set("verdikt_project", e.target.value)} />
          <datalist id="vkProjects">{(test?.projects || []).map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}</datalist>
        </SettingRow>
        <SettingRow label="What to test" desc={kind.desc}>
          <div className="vk-target">
            <Segmented size="sm" label="Target kind" value={form.target_kind}
              items={(Object.keys(KIND_LABEL) as VerdiktSettings["target_kind"][]).map((k) => ({ key: k, label: KIND_LABEL[k].label, disabled: locked }))}
              onChange={(k) => set("target_kind", k as VerdiktSettings["target_kind"])} />
            <input className="sc-inp vk-inp" aria-label="Target" placeholder={kind.ph} value={form.target_locator || ""} disabled={locked || !!busy}
              onChange={(e) => set("target_locator", e.target.value)} />
          </div>
        </SettingRow>
        <SettingRow label="When" desc="Never blocks verification — the human still decides">
          <select className="vk-sel" aria-label="When to run Verdikt" value={form.trigger_mode} disabled={locked || !!busy} onChange={(e) => set("trigger_mode", e.target.value as VerdiktSettings["trigger_mode"])}>
            {WHEN.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </SettingRow>
        <SettingRow label="Timeout" desc="A run with no result after this long is marked timed out">
          <span className="vk-timeout">
            <input className="sc-inp vk-num" type="number" min={1} max={240} aria-label="Timeout minutes" value={form.timeout_minutes} disabled={locked || !!busy}
              onChange={(e) => set("timeout_minutes", Math.max(1, Math.min(240, Number(e.target.value) || 30)))} />
            <span className="set-rowi-d">min</span>
          </span>
        </SettingRow>
      </SettingRows>
      {autofixSupported ? (
        <>
          <div className="vk-sub" id="verdiktAutofix">
            <div className="vk-sub-h">Auto-fix</div>
            <div className="set-rowi-d">
              When an automatic Verdikt run fails, Embodent sends the task back to its agent with the failed criteria, the
              screenshots and the report, then checks the rework again — until it passes or a limit is hit. A pass never
              completes the task: a person still verifies it.
            </div>
          </div>
          <SettingRows label="Auto-fix">
            <SettingRow label="Send failures back" desc={autofixApplies ? "Off by default. Stops on a pass, the attempt limit, no progress, anything that isn't a fail, or when a person steps in"
              : "Only works when Verdikt runs automatically — set When above to UI changes or every task"}>
              <label className="vk-switch" data-testid="vk-autofix">
                <input type="checkbox" checked={!!form.autofix_enabled} disabled={locked || !!busy || !autofixApplies}
                  aria-label="When Verdikt fails, send it back to the agent automatically"
                  onChange={(e) => set("autofix_enabled", e.target.checked)} />
                <span>When Verdikt fails, send it back to the agent automatically</span>
              </label>
            </SettingRow>
            <SettingRow label="Max attempts" desc="Verdikt checks per loop, the first one included (1 = report only, never send back)">
              <span className="vk-timeout">
                <input className="sc-inp vk-num" type="number" min={1} max={10} aria-label="Max attempts" value={form.autofix_max_attempts ?? 3}
                  disabled={locked || !!busy || !autofixApplies || !form.autofix_enabled}
                  onChange={(e) => set("autofix_max_attempts", Math.max(1, Math.min(10, Math.round(Number(e.target.value)) || 3)))} />
              </span>
            </SettingRow>
          </SettingRows>
        </>
      ) : null}
      {previewSupported && form.target_kind === "web" ? (
        <>
          <div className="vk-sub" id="verdiktPreview">
            <div className="vk-sub-h">Preview</div>
            <div className="set-rowi-d">
              Build and serve the task's own branch before Verdikt tests it. The notifier runs this on the machine with the
              agent worktrees, in the task's worktree, as its own user. Verdikt is handed <span className="vk-code">http://127.0.0.1:{"{port}"}</span>,
              so its worker must run on that machine too. Leave it empty and Verdikt tests the URL above.
            </div>
          </div>
          <SettingRows label="Preview">
          <SettingRow label="Preview command" desc="Placeholders: {port} {worktree} {branch}. One line; chain steps with &&">
            <input className="sc-inp vk-inp vk-cmd" aria-label="Preview command" placeholder="npm ci && npm run build && npx serve -l {port} dist"
              value={form.preview_command || ""} disabled={locked || !!busy} spellCheck={false}
              onChange={(e) => set("preview_command", e.target.value)} />
          </SettingRow>
          <SettingRow label="Ready check" desc="A path polled on the preview until it answers">
            <input className="sc-inp vk-inp vk-path" aria-label="Ready check path" placeholder="/" value={form.preview_ready_path ?? "/"} disabled={locked || !!busy}
              onChange={(e) => set("preview_ready_path", e.target.value)} />
          </SettingRow>
          <SettingRow label="Start timeout" desc="Fail the preview if it isn't ready by then">
            <span className="vk-timeout">
              <input className="sc-inp vk-num" type="number" min={5} max={900} aria-label="Preview start timeout seconds" value={form.preview_timeout_seconds ?? 120}
                disabled={locked || !!busy} onChange={(e) => set("preview_timeout_seconds", Math.max(5, Math.min(900, Number(e.target.value) || 120)))} />
              <span className="set-rowi-d">s</span>
            </span>
          </SettingRow>
          <SettingRow label="Stop after" desc="The notifier stops a preview after this long, even if the run is still going">
            <span className="vk-timeout">
              <input className="sc-inp vk-num" type="number" min={5} max={480} aria-label="Preview time limit minutes" value={form.preview_ttl_minutes ?? 60}
                disabled={locked || !!busy} onChange={(e) => set("preview_ttl_minutes", Math.max(5, Math.min(480, Number(e.target.value) || 60)))} />
              <span className="set-rowi-d">min</span>
            </span>
          </SettingRow>
          </SettingRows>
        </>
      ) : null}
      {test ? (
        <div className="vk-test" data-testid="verdikt-test">
          <StatusLine tone={test.ok ? "ok" : "err"}>
            {test.ok
              ? `Connected${test.worker_online ? " · worker online" : " · no worker online (runs will wait)"}${test.project ? " · project “" + test.project.name + "” found" : ""}`
              : test.error || "Not connected"}
          </StatusLine>
        </div>
      ) : null}
      <div className="vk-actions">
        {locked ? <span className="set-rowi-d vk-why">{reason || VERDIKT_GRANT_REASON}</span> : msg ? (
          <span className={"set-rowi-d vk-msg" + (msg.tone === "err" ? " vk-err" : "")} role={msg.tone === "err" ? "alert" : "status"}>{msg.text}</span>
        ) : <span />}
        <span className="v2-grow" />
        {saved?.base_url && cid ? (
          <ButtonLink size="sm" variant="ghost" icon="ext" href={"/api/containers/" + encodeURIComponent(cid) + "/verdikt/open"} target="_blank" rel="noreferrer"
            data-act="verdikt-open" title="Open this project in Verdikt's own UI">Open Verdikt</ButtonLink>
        ) : null}
        <Button size="sm" variant="secondary" data-act="verdikt-test" disabled={locked || !!busy || !form.base_url} busy={busy === "test"} onClick={() => void runTest()}>Test connection</Button>
        <Button size="sm" variant="primary" data-act="verdikt-save" disabled={locked || !!busy || !dirty} busy={busy === "save"} onClick={() => void save()}>Save</Button>
      </div>
      <style>{VK_CSS}</style>
    </SettingsGroup>
  );
}

function pick(s: VerdiktSettings) {
  const base = {
    enabled: s.enabled, base_url: s.base_url || null, verdikt_project: s.verdikt_project || null, target_kind: s.target_kind,
    target_locator: s.target_locator || null, trigger_mode: s.trigger_mode, timeout_minutes: s.timeout_minutes,
  };
  // auto-fix fields only when the backend knows them (mig 068)
  const af = "autofix_enabled" in s ? { autofix_enabled: !!s.autofix_enabled, autofix_max_attempts: s.autofix_max_attempts ?? 3 } : {};
  // preview fields only when the backend knows them (mig 064); an older one never sees them
  if (!("preview_command" in s)) return { ...base, ...af };
  return {
    ...base,
    ...af,
    preview_command: (s.preview_command || "").trim() || null,
    preview_ready_path: (s.preview_ready_path || "").trim() || "/",
    preview_timeout_seconds: s.preview_timeout_seconds ?? 120,
    preview_ttl_minutes: s.preview_ttl_minutes ?? 60,
  };
}

const VK_CSS = String.raw`
  #verdiktSettings .vk-inp { width: 260px; max-width: 100%; }
  #verdiktSettings .vk-num { width: 72px; }
  #verdiktSettings .vk-target { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  #verdiktSettings .vk-sel { height: 28px; max-width: 320px; border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control, 6px);
    background: var(--v2-surface); color: var(--v2-text); font: inherit; font-size: 13px; padding: 0 6px; }
  #verdiktSettings .vk-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--v2-text-2); cursor: pointer; }
  #verdiktSettings .vk-timeout { display: inline-flex; align-items: center; gap: 6px; }
  #verdiktSettings .vk-actions { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--v2-border); }
  #verdiktSettings .vk-actions .v2-grow { flex: 1; }
  #verdiktSettings .vk-test { padding: 4px 14px 0; }
  #verdiktSettings .vk-err { color: var(--v2-danger); }
  #verdiktSettings .vk-cmd { width: 420px; font-family: var(--v2-font-mono); font-size: 12px; }
  #verdiktSettings .vk-path { width: 160px; font-family: var(--v2-font-mono); font-size: 12px; }
  #verdiktSettings .vk-sub { padding: var(--v2-space-3) var(--v2-space-4) var(--v2-space-1); border-top: 1px solid var(--v2-border); }
  #verdiktSettings .vk-sub-h { font-size: 13px; font-weight: var(--v2-fw-medium, 500); color: var(--v2-text); margin-bottom: 2px; }
  #verdiktSettings .vk-code { font-family: var(--v2-font-mono); font-size: 12px; }
`;

/** The mounted section: resolves the acting human + authority from the snapshot. */
export function VerdiktSettingsSection({ cid }: { cid: string | null }) {
  const a = useActingAuthority();
  const { identity } = useSnapshot();
  let actorId: string | null = a.human ? String(a.human.id) : null;
  let reason: string | null = a.reason || null;
  if (actorId && identity && identity.member_role !== "owner" && (identity.grants || []).indexOf("manage_repo") < 0) {
    actorId = null;
    reason = VERDIKT_GRANT_REASON;
  }
  return <VerdiktSettingsGroup cid={cid} actorId={actorId} reason={reason} />;
}
