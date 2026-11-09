/**
 * "Send to Quality when finished": the platform and device a task goes to Quality on when its
 * agent finishes it. `useOnDoneDraft` holds the choice, `OnDoneFields` shows it (the Create task
 * form and the dialog share it), and `OnDoneRow` is the switch on a task.
 */
import { ConditionsField } from "../conditions/ConditionsField";
import { cleanConditions, type Conditions } from "../conditions/conditions";
import { useMemo, useState } from "react";
import "../map/utilities.css";
import "../map/port.css";
import { Button, Dialog, Segmented, Tooltip } from "../../../components/primitives";
import { useToast } from "../../../components/ui";
import { useActingAuthority } from "../../../state/SnapshotProvider";
import { qaAuthority } from "../authority";
import { Switch } from "../map/kit/switch";
import { DeviceField } from "../onboarding/device-field";
import { deviceValue, pickerRows, rowForKey, rowForValue } from "../onboarding/device-picker";
import { rememberDevice, rememberedDevice } from "../onboarding/remembered-device";
import { useLiveDevices } from "../onboarding/use-live-devices";
import { errText, useLoad } from "../parts";
import { listTargets, PLATFORMS, type Platform } from "../qaApi";
import { platformWord } from "../qaWords";
import { DEFAULT_QA_SETTINGS, getQaSettings } from "./api";
import { onDoneWords, setTaskOnDone, type QaOnDone } from "./on-done";

export type OnDoneDraft = ReturnType<typeof useOnDoneDraft>;

/** The choice being made: platform (default the project's), and the device on it. */
export function useOnDoneDraft(cid: string, initial: QaOnDone | null, active: boolean) {
  const targets = useLoad((s) => listTargets(cid, s), [cid]);
  const settingsRes = useLoad((s) => getQaSettings(cid, s), [cid]);
  const settings = settingsRes.data ?? DEFAULT_QA_SETTINGS;
  const ready = PLATFORMS.filter((p) => (targets.data ?? []).some((t) => t.platform === p && t.app_id));
  const [chosen, setChosen] = useState<Platform | null>(initial?.platform ?? null);
  const [conditions, setConditions] = useState<Conditions | null>(initial?.conditions ?? null);
  const platform: Platform | null = chosen && ready.includes(chosen) ? chosen
    : settings.default_platform && ready.includes(settings.default_platform) ? settings.default_platform : ready[0] ?? null;
  const live = useLiveDevices(cid, active && !!platform);
  const rows = useMemo(() => pickerRows(live.devices), [live.devices]);
  const [keys, setKeys] = useState<Partial<Record<Platform, string>>>({});
  const untouched = !!platform && keys[platform] === undefined;
  const saved = untouched && platform === (initial?.platform ?? platform) ? initial?.device ?? null : null;
  const key = !platform ? "" : keys[platform] ?? (saved ? rowForValue(rows, platform, saved)?.key ?? "" : rememberedDevice(cid, platform));
  const row = rowForKey(rows, key);
  const device = row ? deviceValue(row.device) : saved;
  return {
    cid, ready, loaded: !!targets.data, settings, platform, live, deviceKey: key,
    device, missing: saved && !row && !live.loading ? saved : null, physical: Boolean(row?.physical), conditions, setConditions,
    setPlatform: (p: Platform) => setChosen(p),
    pickDevice: (k: string) => {
      if (!platform) return;
      setKeys((m) => ({ ...m, [platform]: k }));
      rememberDevice(cid, platform, k);
    },
    choice: (): Omit<QaOnDone, "enabled"> => ({ platform, device, kind: null, conditions: cleanConditions(conditions) }),
    words: () => onDoneWords({ platform, device, conditions }, settings.default_platform),
  };
}

export function OnDoneFields({ d }: { d: OnDoneDraft }) {
  if (!d.platform) return <p className="qa-hint">Set the app under Quality first.</p>;
  return (
    <div className="qa-form" data-on-done-fields>
      {d.ready.length > 1 ? (
        <div className="qa-field">
          <span className="qa-label">Platform</span>
          <Segmented size="sm" label="Platform to test on" value={d.platform} onChange={(k) => d.setPlatform(k as Platform)} items={d.ready.map((p) => ({ key: p, label: platformWord(p) }))} />
        </div>
      ) : null}
      <DeviceField live={d.live} platform={d.platform} pickKey={d.deviceKey} onPick={d.pickDevice} missing={d.missing} rememberPick maxHeight={240} />
      <ConditionsField value={d.conditions} onChange={d.setConditions} platform={d.platform} physical={d.physical} />
    </div>
  );
}

/** The switch on a task. Off: never (or, when the project sends nothing by itself, as the project says). */
export function OnDoneRow({ cid, taskId, value, onChange }: { cid: string; taskId: string; value: QaOnDone | null; onChange: (v: QaOnDone | null) => void }) {
  const auth = qaAuthority(useActingAuthority());
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = useOnDoneDraft(cid, value, editing);
  const on = value?.enabled === true;
  if (!d.loaded || !d.ready.length) return null;

  const save = async (enabled: boolean | null) => {
    setBusy(true);
    setErr(null);
    try {
      onChange(await setTaskOnDone(taskId, auth.human?.id ?? null, enabled ? { ...d.choice(), enabled } : { platform: null, device: null, kind: null, conditions: null, enabled }));
      setEditing(false);
      if (enabled) toast("This task goes to Quality when its agent finishes it", "ok");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  // Off where the project sends tasks by itself means "not this one"; else it clears the choice.
  const off = () => void save(d.settings.trigger === "manual" ? null : false);
  const sw = <Switch checked={on} disabled={!auth.can || busy} aria-label="Send to Quality when finished" onCheckedChange={(next) => (next ? setEditing(true) : off())} />;
  return (
    <div className="qa-taskqa-row qa-on-done" data-on-done={on ? "on" : value?.enabled === false ? "off" : "default"}>
      <span className="qa-port qa-on-done-sw">{auth.can ? sw : <Tooltip label={auth.reason || "Only a person can choose this"} placement="bottom">{sw}</Tooltip>}</span>
      <span className="qa-taskqa-t">Send to Quality when finished</span>
      <span className="qa-muted" data-on-done-words>
        {on ? onDoneWords(value!, d.settings.default_platform) : value?.enabled === false ? "Off for this task" : d.settings.trigger === "always" ? "On for every task in this project" : null}
      </span>
      {on && auth.can ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Change</Button> : null}
      {err ? <span className="qa-error" role="alert">{err}</span> : null}
      {editing ? (
        <Dialog title="Send to Quality when finished" size="md" onClose={() => setEditing(false)}
          description="When the agent finishes this task, Quality tests it here and the result comes back to the task. A person still accepts the task."
          footer={<>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={!d.platform} onClick={() => void save(true)}>Save</Button>
          </>}>
          <OnDoneFields d={d} />
        </Dialog>
      ) : null}
    </div>
  );
}
