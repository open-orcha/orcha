/**
 * Settings › Notifications (mig 063) — what reaches YOU, and where.
 *
 *   Status        Pause all (1 h / until tomorrow / until I turn it back on) · Mute this project
 *   What you get  [This project | All projects]  presets · category × channel matrix
 *                 (scope per category: All / Only mine / Off; one switch per channel)
 *   Quiet hours   a local time range + time zone — holds desktop / mobile / Slack, keeps in-app
 *
 * Every change saves instantly (optimistic), and a failed save is undone and
 * explained in plain words. The server decides delivery (notification_prefs.
 * should_notify) on every path; the Needs-you queue never reads these settings.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, useToast } from "../../../components/ui";
import { Button, Chip, IconButton, MenuButton, Segmented, Tooltip } from "../../../components/primitives";
import { identitySelfHuman, useActingAuthority, useSnapshot } from "../../../state/SnapshotProvider";
import { HelpTip, SettingRow, SettingRows, SettingsGroup } from "../settingsUi";
import {
  PAUSE_LABEL, fetchPrefs, isLocked, localTimeZone, matchingPreset, pauseFor, pauseText,
  prefsErrText, putDefaults, putProject, timeZones, withEffective,
  type ChannelKey, type PartialRule, type PauseChoice, type PrefsPayload, type QuietHours, type Rule, type Rules, type Scope,
} from "./notificationPrefs";
import "./notifications.css";

type Mode = "project" | "defaults";

export const SAFETY_LINE = "Muting only silences alerts. Anything that needs your decision still waits in Needs you.";

export function NotificationsSection({ cid }: { cid: string | null }) {
  const { snap, identity } = useSnapshot();
  const authority = useActingAuthority();
  const self = identitySelfHuman(snap, identity);
  const selfId = self?.id ?? null;
  const toast = useToast();
  const [data, setData] = useState<PrefsPayload | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("project");
  const confirmed = useRef<PrefsPayload | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!cid || !selfId) return;
    setLoadErr(null);
    try {
      const d = await fetchPrefs(cid, selfId);
      confirmed.current = d;
      setData(d);
    } catch (e) {
      setLoadErr("Couldn't load your notification settings — " + prefsErrText(e) + ".");
    }
  }, [cid, selfId]);
  useEffect(() => { void load(); }, [load]);

  if (!cid) return null;
  if (!selfId) {
    return (
      <p className="nf-note" id="nfNoMember">
        <Icon name="info" cls="v2-ico" />
        {authority.pending ? "Resolving your identity…" : "Notification settings belong to members of this project."}
      </p>
    );
  }
  if (loadErr) {
    return (
      <p className="nf-note is-err" role="alert">
        <Icon name="alert" cls="v2-ico" />{loadErr}
        <Button size="sm" variant="ghost" onClick={() => void load()}>Retry</Button>
      </p>
    );
  }
  if (!data) return <p className="nf-note">Loading…</p>;

  const cat = data.catalog;
  const shownChannels = cat.channels.filter((c) => data.channels[c.key]?.available);
  const hiddenChannels = cat.channels.filter((c) => !data.channels[c.key]?.available);
  const rules: Rules = mode === "project" ? data.effective.rules : data.defaults.rules;
  const overrides = Object.keys(data.project.rules).filter((k) => cat.categories.some((c) => c.key === k));
  const preset = matchingPreset(cat, rules);

  /** Optimistic write: show `next` now, send, reconcile with the server's answer. */
  const save = async (next: PrefsPayload, send: () => Promise<PrefsPayload>, done?: string) => {
    const my = ++seq.current;
    setData(withEffective(next));
    try {
      const res = await send();
      confirmed.current = res;
      if (my === seq.current) setData(res);
      setSaveErr(null);
      if (done) toast(done, "ok");
    } catch (e) {
      const msg = "Couldn't save — " + prefsErrText(e) + ". Your change was undone.";
      if (my === seq.current && confirmed.current) setData(confirmed.current);
      setSaveErr(msg);
      toast(msg, "danger");
    }
  };

  const writeRule = (key: string, rule: Rule) => {
    if (mode === "project") {
      const projectRules: Record<string, PartialRule> = { ...data.project.rules, [key]: rule };
      void save({ ...data, project: { ...data.project, rules: projectRules } }, () => putProject(cid, selfId, { rules: projectRules }));
    } else {
      const defaults: Rules = { ...data.defaults.rules, [key]: rule };
      void save({ ...data, defaults: { ...data.defaults, rules: defaults } }, () => putDefaults(cid, selfId, { rules: defaults }));
    }
  };
  const setScope = (key: string, scope: Scope) => {
    const r = rules[key];
    if (r.scope !== scope) writeRule(key, { scope, channels: { ...r.channels } });
  };
  const setChannel = (key: string, ch: ChannelKey, on: boolean) => {
    const r = rules[key];
    writeRule(key, { scope: r.scope, channels: { ...r.channels, [ch]: on } });
  };
  const resetCategory = (key: string) => {
    const projectRules = { ...data.project.rules };
    delete projectRules[key];
    void save({ ...data, project: { ...data.project, rules: projectRules } }, () => putProject(cid, selfId, { rules: projectRules }));
  };
  const useDefaultsHere = () => {
    void save({ ...data, project: { ...data.project, rules: {} } }, () => putProject(cid, selfId, { rules: {} }), "This project follows your defaults again.");
  };
  const applyPreset = (key: string) => {
    const p = cat.presets.find((x) => x.key === key);
    if (!p) return;
    if (mode === "project") {
      void save({ ...data, project: { ...data.project, rules: p.rules } }, () => putProject(cid, selfId, { rules: p.rules }), p.label + " — applied to this project.");
    } else {
      void save({ ...data, defaults: { ...data.defaults, rules: p.rules } }, () => putDefaults(cid, selfId, { rules: p.rules }), p.label + " — applied to all projects.");
    }
  };
  const setPause = (choice: PauseChoice | null) => {
    const pause = choice ? pauseFor(choice) : null;
    void save(
      { ...data, defaults: { ...data.defaults, pause } },
      () => putDefaults(cid, selfId, { pause }),
      choice ? "Notifications paused." : "Notifications are back on.",
    );
  };
  const setMuted = (muted: boolean) => {
    void save(
      { ...data, project: { ...data.project, muted } },
      () => putProject(cid, selfId, { muted }),
      muted ? "This project is muted." : "This project is unmuted.",
    );
  };
  const setQuiet = (quiet: QuietHours | null) => {
    void save({ ...data, defaults: { ...data.defaults, quiet_hours: quiet } }, () => putDefaults(cid, selfId, { quiet_hours: quiet }));
  };

  const pauseLine = pauseText(data.defaults.pause);
  const quiet = data.defaults.quiet_hours;
  const projectName = snap?.container?.name || "this project";

  return (
    <div className="nf" id="nfSection">
      <p className="nf-note nf-safety" id="nfSafety">
        <Icon name="shield" cls="v2-ico" />{SAFETY_LINE}
      </p>
      {saveErr ? <p className="nf-note is-err" role="alert" id="nfSaveErr"><Icon name="alert" cls="v2-ico" />{saveErr}</p> : null}

      <SettingsGroup title="Status" flush>
        <SettingRows>
          <SettingRow
            label="Pause all notifications"
            id="nfPauseL"
            desc={<span id="nfPauseD">{pauseLine ?? "Everything is on."}</span>}
          >
            {pauseLine ? (
              <Button size="sm" icon="bell" id="nfResume" onClick={() => setPause(null)}>Resume</Button>
            ) : (
              <MenuButton
                size="sm" icon="pause" value="Pause…" menuLabel="Pause notifications" placement="bottom-end" className="nf-pause-btn"
                items={(Object.keys(PAUSE_LABEL) as PauseChoice[]).map((k) => ({ label: PAUSE_LABEL[k], onSelect: () => setPause(k) }))}
              />
            )}
          </SettingRow>
          <SettingRow
            label="Mute this project"
            id="nfMuteL"
            desc={"Stop alerts from " + projectName + " on every channel."}
          >
            <Switch on={data.project.muted} label="Mute this project" id="nfMute" onChange={setMuted} />
          </SettingRow>
        </SettingRows>
      </SettingsGroup>

      <SettingsGroup
        title="What you're notified about"
        lead={mode === "project" ? "For " + projectName + ". Categories you haven't changed here follow your defaults." : "Your defaults — every project that doesn't override them."}
        help={<>“Only mine” means assigned to you, your requests, your reviews, or work by an agent you manage.</>}
        action={
          <Segmented
            size="sm" label="Edit settings for" value={mode} className="nf-mode"
            items={[{ key: "project", label: "This project" }, { key: "defaults", label: "All projects" }]}
            onChange={(k) => setMode(k as Mode)}
          />
        }
        flush
      >
        <div className="nf-toolbar">
          <div className="nf-presets" role="group" aria-label="Presets">
            {cat.presets.map((p) => (
              <Tooltip key={p.key} label={p.description} placement="bottom">
                <button
                  type="button" className={"nf-preset" + (preset === p.key ? " on" : "")}
                  aria-pressed={preset === p.key} data-preset={p.key}
                  onClick={() => applyPreset(p.key)}
                >
                  {p.label}
                </button>
              </Tooltip>
            ))}
          </div>
          {mode === "project" && overrides.length ? (
            <span className="nf-override-sum" id="nfOverrideSum">
              <Chip>{overrides.length === 1 ? "1 category overridden here" : overrides.length + " categories overridden here"}</Chip>
              <Button size="sm" variant="ghost" onClick={useDefaultsHere}>Use defaults</Button>
            </span>
          ) : mode === "defaults" && overrides.length ? (
            <span className="nf-override-sum" id="nfOverrideSum">
              <Chip>{projectName} overrides {overrides.length}</Chip>
            </span>
          ) : null}
        </div>
        <table className="nf-matrix" aria-label="Notification rules">
          <thead>
            <tr>
              <th scope="col" className="nf-c-cat">Category</th>
              <th scope="col" className="nf-c-scope">Notify me about</th>
              {shownChannels.map((c) => <th scope="col" key={c.key} className="nf-c-ch">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {cat.categories.map((c) => {
              const r = rules[c.key];
              if (!r) return null;
              const overridden = mode === "project" && overrides.indexOf(c.key) >= 0;
              return (
                <tr key={c.key} data-cat={c.key} className={r.scope === "off" ? "is-off" : undefined}>
                  <th scope="row" className="nf-c-cat">
                    <span className="nf-cat-l">{c.label}</span>
                    <span className="nf-cat-d">{c.description}</span>
                    {overridden ? (
                      <span className="nf-ov">
                        <Chip>This project</Chip>
                        <IconButton icon="refresh" size="sm" variant="ghost" label={"Use your default for " + c.label} onClick={() => resetCategory(c.key)} />
                      </span>
                    ) : null}
                  </th>
                  <td className="nf-c-scope">
                    <Segmented
                      size="sm" label={c.label + " — notify me about"} value={r.scope}
                      items={cat.scopes.map((s) => ({ key: s.key, label: s.label }))}
                      onChange={(k) => setScope(c.key, k as Scope)}
                    />
                  </td>
                  {shownChannels.map((ch) => {
                    const lock = isLocked(cat, c.key, ch.key);
                    return (
                      <td key={ch.key} className="nf-c-ch" data-ch={ch.key}>
                        <span className="nf-ch-l" aria-hidden="true">{ch.label}</span>
                        {lock ? (
                          <Tooltip label={lock} placement="left">
                            <span className="nf-lock" tabIndex={0} aria-label={c.label + " — " + ch.label + ": always on. " + lock}>
                              <Icon name="lock" cls="v2-ico" />
                            </span>
                          </Tooltip>
                        ) : (
                          <Switch
                            on={!!r.channels[ch.key]} label={c.label + " — " + ch.label}
                            disabled={r.scope === "off"} disabledReason="Turn this category on first"
                            onChange={(on) => setChannel(c.key, ch.key, on)}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {hiddenChannels.length ? (
          <p className="nf-hidden" id="nfHiddenChannels">
            {hiddenChannels.map((c) => c.label).join(" and ")} {hiddenChannels.length === 1 ? "isn't" : "aren't"} set up here.
            <HelpTip label="hidden channels">{hiddenChannels.map((c) => data.channels[c.key]?.reason).filter(Boolean).join(" ")}</HelpTip>
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Quiet hours" flush>
        <SettingRows>
          <SettingRow
            label="Quiet hours"
            id="nfQuietL"
            desc="Desktop, mobile and Slack stay silent (they are not sent later); the in-app bell keeps collecting."
          >
            <Switch
              on={!!quiet} label="Quiet hours" id="nfQuiet"
              onChange={(on) => setQuiet(on ? { start: "22:00", end: "07:00", tz: localTimeZone() } : null)}
            />
          </SettingRow>
          {quiet ? (
            <SettingRow label="From – to" id="nfQuietRange">
              <span className="nf-quiet">
                <input
                  type="time" className="nf-time" aria-label="Quiet hours start" value={quiet.start}
                  onChange={(e) => { if (e.target.value && e.target.value !== quiet.end) setQuiet({ ...quiet, start: e.target.value }); }}
                />
                <span className="nf-dash" aria-hidden="true">–</span>
                <input
                  type="time" className="nf-time" aria-label="Quiet hours end" value={quiet.end}
                  onChange={(e) => { if (e.target.value && e.target.value !== quiet.start) setQuiet({ ...quiet, end: e.target.value }); }}
                />
                <select
                  className="nf-tz" aria-label="Time zone" value={quiet.tz}
                  onChange={(e) => setQuiet({ ...quiet, tz: e.target.value })}
                >
                  {timeZones(quiet.tz).map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
                </select>
              </span>
            </SettingRow>
          ) : null}
        </SettingRows>
      </SettingsGroup>
    </div>
  );
}

function Switch({ on, label, onChange, disabled, disabledReason, id }: {
  on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean; disabledReason?: string; id?: string;
}) {
  return (
    <button
      type="button" role="switch" id={id}
      className={"set-switch nf-switch" + (on ? " on" : "")}
      aria-checked={on} aria-label={label} aria-disabled={disabled || undefined}
      title={disabled ? disabledReason : undefined}
      onClick={() => { if (!disabled) onChange(!on); }}
    >
      <span className="set-switch-knob" />
    </button>
  );
}
