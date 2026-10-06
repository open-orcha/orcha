/**
 * Settings › Voice — dictation for every text field.
 *
 *  - Dictation (this device): engine (Auto · Cloud · On-device · Off),
 *    language, AI clean-up, the shortcut. Saved instantly in this browser
 *    (dictation/prefs.ts) — the microphone and engine belong to the machine.
 *  - Speech providers (this project): OpenAI / Deepgram / Groq keys, sealed
 *    server-side like the model keys (PUT/DELETE …/settings/voice-keys/{p});
 *    owner-or-manage_keys, exactly like Models & providers.
 *  - On-device model: Moonshine (English) or Whisper (multilingual), one-time
 *    download with progress, WebGPU when the machine has it.
 *  - Microphone test: a live level meter and a field to try dictation in.
 *  - Privacy: audio is never stored.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { sendJSON } from "../../../api/client";
import { Button, Chip, Segmented } from "../../../components/primitives";
import { useToast } from "../../../components/ui";
import { startCapture, type Capture } from "../../../dictation/audio";
import { DEVICE_MODELS, deviceSupported, loadDeviceModel, pickEngine, resolveDeviceModel, type VoiceStatus } from "../../../dictation/engines";
import { fetchVoiceStatus, invalidateVoiceStatus, VOICE_STATUS_EVENT } from "../../../dictation/api";
import { LANGUAGES, SHORTCUTS, VOICE_PREFS_EVENT, isMacPlatform, readVoicePrefs, shortcutLabel, writeVoicePrefs, type VoicePrefs } from "../../../dictation/prefs";
import { useGrantAuthority } from "../grantAuthority";
import { SecretInput, SettingRow, SettingRows, SettingsGroup, StatusLine, settingsErrText } from "../settingsUi";
import "./voice.css";

function useVoicePrefs(): [VoicePrefs, (p: Partial<VoicePrefs>) => void] {
  const [p, setP] = useState<VoicePrefs>(() => readVoicePrefs());
  useEffect(() => {
    const on = () => setP(readVoicePrefs());
    window.addEventListener(VOICE_PREFS_EVENT, on);
    return () => window.removeEventListener(VOICE_PREFS_EVENT, on);
  }, []);
  return [p, (patch) => setP(writeVoicePrefs(patch))];
}

function useVoiceStatus(cid: string | null): [VoiceStatus | null, boolean, () => void] {
  const [s, setS] = useState<VoiceStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!cid) { setLoaded(true); return; }
    let live = true;
    fetchVoiceStatus(cid, n > 0).then((d) => { if (live) { setS(d); setLoaded(true); } });
    return () => { live = false; };
  }, [cid, n]);
  useEffect(() => {
    const on = () => setN((x) => x + 1);
    window.addEventListener(VOICE_STATUS_EVENT, on);
    return () => window.removeEventListener(VOICE_STATUS_EVENT, on);
  }, []);
  return [s, loaded, () => setN((x) => x + 1)];
}

function Switch({ on, label, onChange, disabled, id }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean; id?: string }) {
  return (
    <button
      type="button" role="switch" id={id}
      className={"set-switch" + (on ? " on" : "")}
      aria-checked={on} aria-label={label} aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onChange(!on); }}
    >
      <span className="set-switch-knob" />
    </button>
  );
}

export function engineSummary(prefs: VoicePrefs, status: VoiceStatus | null, device: boolean): string {
  const pick = pickEngine(prefs, status, device);
  if (!pick.engine) return pick.reason || "Not available";
  if (pick.engine === "cloud") {
    const id = prefs.provider === "auto" ? status?.default_provider : prefs.provider;
    const name = status?.providers.find((p) => p.provider === id)?.name || "your speech provider";
    return `Streaming through ${name} — words appear as you speak.`;
  }
  return `On this device with ${DEVICE_MODELS[resolveDeviceModel(prefs)].label.split(" (")[0]} — audio never leaves your computer.`;
}

export function VoiceSection({ cid }: { cid: string | null }) {
  const [prefs, setPrefs] = useVoicePrefs();
  const [status, loaded] = useVoiceStatus(cid);
  const device = deviceSupported();
  const mac = isMacPlatform();
  return (
    <>
      <SettingsGroup settab="voice" title="Dictation" flush lead="Talk instead of typing, in any text field. Saved on this device.">
        <SettingRows label="Dictation settings">
          <SettingRow label="Engine" desc={loaded ? <span id="voiceEngineSummary">{engineSummary(prefs, status, device)}</span> : null}>
            <Segmented
              label="Dictation engine"
              size="sm"
              value={prefs.engine}
              onChange={(k) => setPrefs({ engine: k as VoicePrefs["engine"] })}
              items={[
                { key: "auto", label: "Auto", title: "Cloud when this project has a speech key, otherwise on-device" },
                { key: "cloud", label: "Cloud" },
                { key: "device", label: "On-device", disabled: !device },
                { key: "off", label: "Off" },
              ]}
            />
          </SettingRow>
          <SettingRow label="Language" desc="Automatic works for most people; pick one to improve accuracy.">
            <select className="sc-inp voice-select" id="voiceLanguage" aria-label="Dictation language" value={prefs.language} onChange={(e) => setPrefs({ language: e.target.value })}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </SettingRow>
          <SettingRow
            label="AI clean-up"
            desc={
              status && !status.cleanup_available
                ? "Needs a model key in Models & providers. Until then you get the raw words."
                : "Fixes punctuation, drops filler words and turns spoken lists into bullets. Never adds content; Undo restores your exact words."
            }
          >
            <Switch id="voiceCleanup" on={prefs.cleanup} label="AI clean-up" onChange={(v) => setPrefs({ cleanup: v })} />
          </SettingRow>
          <SettingRow label="Shortcut" desc={<>Hold to talk and release to insert, or tap to start and tap again to finish. <kbd className="voice-kbd">esc</kbd> cancels.</>}>
            <select className="sc-inp voice-select" id="voiceShortcut" aria-label="Dictation shortcut" value={prefs.shortcut} onChange={(e) => setPrefs({ shortcut: e.target.value as VoicePrefs["shortcut"] })}>
              {SHORTCUTS.map((s) => <option key={s.key} value={s.key}>{mac ? s.mac : s.other}</option>)}
            </select>
          </SettingRow>
        </SettingRows>
      </SettingsGroup>

      <SpeechProvidersGroup cid={cid} status={status} prefs={prefs} setPrefs={setPrefs} />
      <DeviceModelGroup prefs={prefs} setPrefs={setPrefs} supported={device} />
      <MicTestGroup shortcut={shortcutLabel(prefs.shortcut)} />

      <SettingsGroup settab="voice" title="Privacy">
        <p className="voice-privacy" id="voicePrivacy">
          Audio is never stored. With a cloud provider, your voice streams through this portal to that provider and is
          discarded as soon as the words come back; the key stays on the server. On-device dictation never sends audio
          anywhere. AI clean-up sends only the finished text to your model provider.
        </p>
      </SettingsGroup>
    </>
  );
}

function SpeechProvidersGroup({ cid, status, prefs, setPrefs }: { cid: string | null; status: VoiceStatus | null; prefs: VoicePrefs; setPrefs: (p: Partial<VoicePrefs>) => void }) {
  const auth = useGrantAuthority("manage_keys");
  const configured = (status?.providers || []).filter((p) => p.configured);
  return (
    <SettingsGroup
      settab="voice" title="Speech providers" flush
      lead="Keys for cloud dictation on this project. Stored encrypted; never sent to the browser."
      action={status ? <Chip size="sm">{configured.length + " connected"}</Chip> : null}
    >
      {!auth.can && !auth.pending && auth.reason ? (
        <div className="set-lock-note"><StatusLine tone="muted" icon="shield">View-only — {auth.reason}</StatusLine></div>
      ) : null}
      <SettingRows label="Speech providers">
        {(status?.providers || []).map((p) => (
          <ProviderKeyRow key={p.provider} cid={cid} p={p} canEdit={auth.can} actor={auth.human?.id || null} />
        ))}
        {configured.length > 1 ? (
          <SettingRow label="Use" desc="Auto picks the first connected provider in this list.">
            <select className="sc-inp voice-select" id="voiceProvider" aria-label="Cloud speech provider" value={prefs.provider} onChange={(e) => setPrefs({ provider: e.target.value as VoicePrefs["provider"] })}>
              <option value="auto">Auto</option>
              {configured.map((p) => <option key={p.provider} value={p.provider}>{p.name}</option>)}
            </select>
          </SettingRow>
        ) : null}
      </SettingRows>
      {!status && cid ? <div className="voice-pad"><StatusLine tone="muted">Couldn't load speech providers.</StatusLine></div> : null}
    </SettingsGroup>
  );
}

function ProviderKeyRow({ cid, p, canEdit, actor }: { cid: string | null; p: VoiceStatus["providers"][number]; canEdit: boolean; actor: string | null }) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const base = cid ? `/api/containers/${encodeURIComponent(cid)}/settings/voice-keys/${p.provider}` : "";
  const save = async () => {
    if (!cid || !actor || !draft.trim()) return;
    setBusy(true);
    try {
      await sendJSON("PUT", base, { actor_agent_id: actor, api_key: draft.trim() });
      setDraft(""); setEditing(false);
      invalidateVoiceStatus();
      toast(`${p.name} key saved`, "ok");
    } catch (e) {
      toast(`Couldn't save the ${p.name} key: ${settingsErrText(e)}`, "danger");
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!cid || !actor) return;
    setBusy(true);
    try {
      await sendJSON("DELETE", base, { actor_agent_id: actor });
      invalidateVoiceStatus();
      toast(`${p.name} key removed`, "ok");
    } catch (e) {
      toast(`Couldn't remove the ${p.name} key: ${settingsErrText(e)}`, "danger");
    } finally { setBusy(false); }
  };
  const showField = canEdit && (editing || !p.configured) && p.source !== "env";
  return (
    <SettingRow
      label={<>{p.name}{p.streaming ? null : <span className="voice-tag">no live text</span>}</>}
      desc={p.note}
      stack={showField}
      className="voice-prov"
    >
      <div className="voice-prov-ctl" data-provider={p.provider}>
        {p.configured ? (
          <StatusLine
            tone={p.source === "env" ? "env" : "ok"}
            masked={p.masked || null}
            action={canEdit && p.source !== "env" ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)} disabled={busy}>{editing ? "Cancel" : "Replace"}</Button>
                <Button size="sm" variant="ghost" onClick={remove} disabled={busy}>Remove</Button>
              </>
            ) : null}
          >
            {p.source === "env" ? "Set in the environment" : "Connected"}
          </StatusLine>
        ) : !canEdit ? <span className="voice-muted">Not connected</span> : null}
        {showField ? (
          <div className="voice-key-row">
            <SecretInput
              value={draft} onChange={setDraft} placeholder={`${p.name} API key`} label={`${p.name} API key`}
              reveal={reveal} onToggleReveal={() => setReveal((r) => !r)}
            />
            <Button size="sm" variant="primary" onClick={save} disabled={busy || !draft.trim()}>Save</Button>
          </div>
        ) : null}
      </div>
    </SettingRow>
  );
}

function DeviceModelGroup({ prefs, setPrefs, supported }: { prefs: VoicePrefs; setPrefs: (p: Partial<VoicePrefs>) => void; supported: boolean }) {
  const [progress, setProgress] = useState<{ label: string; f: number | null } | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const gpu = typeof navigator !== "undefined" && !!(navigator as Navigator & { gpu?: unknown }).gpu;
  const model = resolveDeviceModel(prefs);
  const download = async () => {
    setState("loading");
    try {
      await loadDeviceModel(model, (label, f) => setProgress({ label, f }));
      setState("ready");
    } catch {
      setState("error");
    }
  };
  return (
    <SettingsGroup settab="voice" title="On-device model" flush lead={supported ? `Runs in this browser (WebAssembly${gpu ? "; Whisper uses the GPU" : ""}). Downloads once, then works offline.` : "This browser can't run on-device dictation."}>
      <SettingRows label="On-device model">
        <SettingRow label="Model" desc={DEVICE_MODELS[model].size + " one-time download."}>
          <select className="sc-inp voice-select" id="voiceDeviceModel" aria-label="On-device model" value={prefs.deviceModel} disabled={!supported} onChange={(e) => setPrefs({ deviceModel: e.target.value as VoicePrefs["deviceModel"] })}>
            <option value="auto">Auto (by language)</option>
            <option value="moonshine">{DEVICE_MODELS.moonshine.label}</option>
            <option value="whisper">{DEVICE_MODELS.whisper.label}</option>
          </select>
        </SettingRow>
        <SettingRow
          label="Download"
          desc={state === "loading" && progress ? `${progress.label}${progress.f != null ? ` · ${Math.round(progress.f * 100)}%` : "…"}` : state === "ready" ? "Ready on this device." : state === "error" ? "The download failed. Check your connection and try again." : "Optional — it also downloads the first time you dictate."}
        >
          {state === "loading" ? (
            <progress className="voice-progress" max={1} value={progress?.f ?? undefined} aria-label="Model download progress" />
          ) : (
            <Button size="sm" variant="secondary" onClick={download} disabled={!supported || state === "ready"}>{state === "ready" ? "Downloaded" : "Download now"}</Button>
          )}
        </SettingRow>
      </SettingRows>
    </SettingsGroup>
  );
}

function MicTestGroup({ shortcut }: { shortcut: string }) {
  const [level, setLevel] = useState(0);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cap = useRef<Capture | null>(null);
  const stop = useCallback(() => { cap.current?.stop(); cap.current = null; setOn(false); setLevel(0); }, []);
  useEffect(() => stop, [stop]);
  const start = async () => {
    setErr(null);
    try {
      cap.current = await startCapture({ onFrame: () => undefined, onLevel: setLevel });
      setOn(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const [sample, setSample] = useState("");
  return (
    <SettingsGroup settab="voice" title="Microphone test" flush lead="Check the level, then try dictating into the box.">
      <SettingRows label="Microphone test">
        <SettingRow label="Input level" desc={err || (on ? "Speak normally — the bar should move into the middle." : "Starts your microphone until you stop it.")}>
          <div className="voice-meter-row">
            <span className="voice-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
              <span className="voice-meter-fill" style={{ transform: `scaleX(${level})` }} />
            </span>
            <Button size="sm" variant="secondary" id="voiceMicTest" onClick={on ? stop : start}>{on ? "Stop" : "Test microphone"}</Button>
          </div>
        </SettingRow>
        <SettingRow label="Try it" desc={`Click the mic in the box, or press ${shortcut}.`} stack>
          <textarea className="sc-inp voice-try" id="voiceTry" aria-label="Dictation test" placeholder="Say something…" rows={3} value={sample} onChange={(e) => setSample(e.target.value)} />
        </SettingRow>
      </SettingRows>
    </SettingsGroup>
  );
}
