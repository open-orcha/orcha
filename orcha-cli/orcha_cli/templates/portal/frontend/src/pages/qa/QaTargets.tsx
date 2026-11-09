/**
 * Apps (targets): per platform, the app agents test.
 *   iOS / Android — bundle id / package, name, an optional build to install, the
 *                   simulator or emulator to use, and sign-in hints.
 *   Web           — the start URL, name, the browser viewport (Desktop 1280×800 or
 *                   Mobile 390×844), and sign-in hints plus the other sites agents may
 *                   visit ("Allowed: https://…" lines in the notes).
 * Detected apps come from the onboarding's scan: nobody types a bundle id unless detection
 * failed, so the form sits behind Edit. "Run onboarding again" reads the folder afresh.
 * Editing is human-only (the server enforces); everyone else reads.
 */
import { useState } from "react";
import { Button, EmptyState, Segmented, Skeleton, Tooltip } from "../../components/primitives";
import { useToast } from "../../components/ui";
import { relTime } from "../../lib/format";
import type { QaAuthority } from "./authority";
import { listTargets, PLATFORMS, saveTarget, viewportWord, WEB_VIEWPORTS, type Platform, type QaTarget } from "./qaApi";
import { platformWord } from "./qaWords";
import { errText, Kv, PlatformIcon, useAgentAlias, useLoad } from "./parts";
import type { QaNav } from "./QaPage";
import { QaSettingsCard } from "./requests/QaSettingsCard";
import { getOnboardingRow, restartOnboarding } from "./onboarding/use-onboarding-map";
import type { FoundSheet } from "./onboarding/contract";

interface Hint { id: string; idLabel: string; build: string | null; deviceLabel: string; device: string; notesLabel: string; notes: string; notesHint: string }
const MOBILE_NOTES_HINT = "Never put a password here — say where agents find it.";
const HINTS: Record<Platform, Hint> = {
  ios: {
    id: "com.example.app", idLabel: "Bundle id", build: "Path to a .app built for the simulator (optional)",
    deviceLabel: "Simulator", device: "iPhone 17 Pro, then the iPad",
    notesLabel: "Sign-in notes", notes: "Which test account to use and where its details live", notesHint: MOBILE_NOTES_HINT,
  },
  android: {
    id: "com.example.app", idLabel: "Package", build: "Path to an .apk (optional)",
    deviceLabel: "Emulator", device: "First connected emulator",
    notesLabel: "Sign-in notes", notes: "Which test account to use and where its details live", notesHint: MOBILE_NOTES_HINT,
  },
  web: {
    id: "https://staging.example.com", idLabel: "Start URL", build: null,
    deviceLabel: "Browser", device: "desktop",
    notesLabel: "Sign-in notes and allowed sites",
    notes: "Which test account to use and where its details live.\nAllowed: https://auth.example.com",
    notesHint: "Agents stay on this site. To let them visit another one (sign-in, payments), add a line like “Allowed: https://auth.example.com”. Never put a password here.",
  },
};

/** "Allowed: https://a.com, https://b.com" lines in a web target's notes → the sites, and the rest of the notes. */
export function allowedSites(notes: string | null | undefined): { sites: string[]; rest: string } {
  const sites: string[] = [];
  const rest: string[] = [];
  for (const line of (notes ?? "").split("\n")) {
    const m = /^\s*allowed\s*:\s*(.+)$/i.exec(line);
    if (m) sites.push(...m[1].split(/[\s,]+/).map((x) => x.trim()).filter(Boolean));
    else rest.push(line);
  }
  return { sites, rest: rest.join("\n").trim() };
}

export function QaTargets({ cid, nav, auth }: { cid: string; nav: QaNav; auth: QaAuthority }) {
  const toast = useToast();
  const res = useLoad((s) => listTargets(cid, s), [cid], nav.nonce);
  const row = useLoad((s) => getOnboardingRow(cid, s), [cid], nav.nonce);
  const again = async () => {
    try {
      await restartOnboarding(cid, auth.human?.id ?? null);
      nav.set({ view: "onboarding", settings: null });
    } catch (e) {
      toast("Couldn't start the onboarding — " + errText(e), "danger", { sticky: true });
    }
  };
  if (res.error && !res.data) {
    return <EmptyState tone="danger" title="Couldn't load the apps" body={res.error} action={<Button size="sm" onClick={nav.refresh}>Retry</Button>} />;
  }
  if (!res.data) return <div className="qa-pad"><Skeleton lines={4} label="Loading the apps" /></div>;
  const targets = res.data;
  const found = row.data?.found ?? null;
  const againBtn = <Button size="sm" icon="refresh" disabled={!auth.can} onClick={() => void again()}>Run onboarding again</Button>;
  return (
    <div className="qa-pad qa-targets">
      <div className="qa-apps-h">
        <p className="qa-muted qa-lead">The app agents test on each platform. Mobile apps run on an already booted simulator or emulator — never a new one. Web apps open in a fresh browser for each session.</p>
        {auth.can ? againBtn : <Tooltip label={auth.reason || "Only a person can run the onboarding"} placement="bottom">{againBtn}</Tooltip>}
      </div>
      <div className="qa-cards">
        {PLATFORMS.map((p) => (
          <TargetCard key={p} cid={cid} platform={p} target={targets.find((t) => t.platform === p) ?? null} detected={detectedApp(found, p)} auth={auth} onSaved={nav.refresh} />
        ))}
      </div>
      <QaSettingsCard cid={cid} auth={auth} nonce={nav.nonce} />
    </div>
  );
}

/** What the scan found for a platform: its id or URL, its stack and folder. */
export function detectedApp(found: FoundSheet | null | undefined, platform: Platform): { id: string; stack: string | null; path: string | null } | null {
  const p = found?.platforms?.find((x) => x.kind === platform);
  const id = p?.app_id || (platform === "web" ? found?.environments?.[0]?.base_url : undefined);
  return id ? { id, stack: p?.stack ?? null, path: p?.path ?? null } : null;
}

type Draft = { app_id: string; app_name: string; build_path: string; device_name: string; notes: string };
const toDraft = (t: QaTarget | null, platform: Platform): Draft => ({
  app_id: t?.app_id ?? "", app_name: t?.app_name ?? "", build_path: t?.build_path ?? "",
  device_name: t?.device_name ?? (platform === "web" ? "desktop" : ""), notes: t?.notes ?? "",
});
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function TargetCard({ cid, platform, target, detected, auth, onSaved }: {
  cid: string; platform: Platform; target: QaTarget | null;
  /** Found in the project folder, not set yet. */
  detected: { id: string; stack: string | null; path: string | null } | null;
  auth: QaAuthority; onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const by = useAgentAlias(target?.updated_by_agent_id);
  const h = HINTS[platform];
  const web = platform === "web";
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft((d) => (d ? { ...d, [k]: e.target.value } : d));

  const save = async () => {
    if (!draft) return;
    const id = draft.app_id.trim();
    if (!id) { setErr(web ? "Add the start URL — agents open the site there." : `Add the ${h.idLabel.toLowerCase()} — agents launch the app by it.`); return; }
    if (web && !/^https?:\/\/[^\s/]+/i.test(id)) { setErr("The start URL begins with http:// or https://."); return; }
    setBusy(true);
    setErr(null);
    try {
      await saveTarget(cid, platform, auth.human?.id ?? null, {
        app_id: id, app_name: orNull(draft.app_name), build_path: web ? null : orNull(draft.build_path),
        device_name: orNull(draft.device_name), notes: orNull(draft.notes),
      });
      toast(`${platformWord(platform)} app saved.`, "ok");
      setDraft(null);
      onSaved();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const useDetected = async () => {
    if (!detected) return;
    setBusy(true);
    try {
      await saveTarget(cid, platform, auth.human?.id ?? null, { app_id: detected.id, app_name: null, build_path: null, device_name: web ? "desktop" : null, notes: null });
      toast(`${platformWord(platform)} app saved.`, "ok");
      onSaved();
    } catch (e) {
      toast("Couldn't save the app — " + errText(e), "danger", { sticky: true });
    } finally {
      setBusy(false);
    }
  };

  const editBtn = (
    <Button size="sm" variant={target?.app_id || detected ? "ghost" : "secondary"} icon="pencil" disabled={!auth.can} onClick={() => { setErr(null); setDraft({ ...toDraft(target, platform), app_id: target?.app_id ?? detected?.id ?? "" }); }}>
      Edit
    </Button>
  );
  const allowed = web ? allowedSites(target?.notes) : null;

  return (
    <section className="qa-card" aria-label={platformWord(platform) + " app"}>
      <header className="qa-card-h">
        <PlatformIcon platform={platform} cls="v2-ico qa-card-ico" />
        <div className="qa-card-t">
          <h2 className="qa-card-title">{platformWord(platform)}</h2>
          <div className="qa-card-sub">{target?.app_id ? target.app_name || target.app_id : detected ? "Detected, not set yet" : "No app set"}</div>
        </div>
        {!draft ? (auth.can ? editBtn : <Tooltip label={auth.reason || "Only a person can change the app"} placement="bottom">{editBtn}</Tooltip>) : null}
      </header>
      {draft ? (
        <form className="qa-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="qa-field"><span className="qa-label">{h.idLabel}</span>
            <input className="qa-input qa-mono" value={draft.app_id} placeholder={h.id} onChange={set("app_id")} autoFocus data-dictation="off" spellCheck={false} /></label>
          <label className="qa-field"><span className="qa-label">Name</span>
            <input className="qa-input" value={draft.app_name} placeholder="Shown in Quality" onChange={set("app_name")} /></label>
          {h.build ? (
            <label className="qa-field"><span className="qa-label">Build to install</span>
              <input className="qa-input qa-mono" value={draft.build_path} placeholder={h.build} onChange={set("build_path")} data-dictation="off" spellCheck={false} /></label>
          ) : null}
          {web ? (
            <div className="qa-field">
              <span className="qa-label">Browser</span>
              <Segmented size="sm" label="Browser viewport" value={draft.device_name === "mobile" ? "mobile" : "desktop"}
                onChange={(k) => setDraft((d) => (d ? { ...d, device_name: k } : d))}
                items={WEB_VIEWPORTS.map((v) => ({ key: v.key, label: `${v.label} (${v.size})` }))} />
            </div>
          ) : (
            <label className="qa-field"><span className="qa-label">{h.deviceLabel}</span>
              <input className="qa-input" value={draft.device_name} placeholder={h.device} onChange={set("device_name")} /></label>
          )}
          <label className="qa-field"><span className="qa-label">{h.notesLabel}</span>
            <textarea className="qa-input qa-textarea" value={draft.notes} placeholder={h.notes} onChange={set("notes")} />
            <span className="qa-hint">{h.notesHint}</span></label>
          {err ? <p className="qa-error" role="alert">{err}</p> : null}
          <div className="qa-actions">
            <Button size="sm" variant="primary" type="submit" busy={busy}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </form>
      ) : target?.app_id ? (
        <Kv items={web ? [
          [h.idLabel, <span className="qa-mono">{target.app_id}</span>],
          ["Browser", viewportWord(target.device_name)],
          ["Allowed sites", allowed!.sites.length ? <span className="qa-mono">{allowed!.sites.join(", ")}</span> : "This site only"],
          ["Sign-in notes", allowed!.rest || null],
          ["Updated", target.updated_at ? `${relTime(target.updated_at)}${by ? " by " + by : ""}` : null],
        ] : [
          [h.idLabel, <span className="qa-mono">{target.app_id}</span>],
          ["Build to install", target.build_path ? <span className="qa-mono">{target.build_path}</span> : "Uses the installed app"],
          [h.deviceLabel, target.device_name || h.device],
          ["Sign-in notes", target.notes],
          ["Updated", target.updated_at ? `${relTime(target.updated_at)}${by ? " by " + by : ""}` : null],
        ]} />
      ) : detected ? (
        <div className="qa-detected" data-detected-app={platform}>
          <Kv items={[
            ["Found in the project", <span className="qa-mono">{detected.id}</span>],
            ["Built with", detected.stack],
            ["Folder", detected.path ? <span className="qa-mono">{detected.path}</span> : null],
          ]} />
          <div className="qa-actions">
            <Button size="sm" variant="primary" busy={busy} disabled={!auth.can} onClick={() => void useDetected()}>Use this app</Button>
          </div>
        </div>
      ) : (
        <p className="qa-muted qa-card-note">
          {web ? "No website found in the project. Use Edit to set the start URL by hand." : `No ${platformWord(platform)} app found in the project. Use Edit to set the ${h.idLabel.toLowerCase()} by hand.`}
        </p>
      )}
      {!auth.can && !draft ? <p className="qa-muted qa-gate">{auth.reason}</p> : null}
    </section>
  );
}
