import { DevicePicker } from "./device-picker-view";
import { Field, Input, PlatformIcon, PLATFORM_NAMES } from "./ui";
import type { TargetKind } from "./types";
import { enabledTargets, type DeviceOption, type SetField, type WizardState } from "./state";

/**
 * One device per enabled platform, picked in the device picker: this machine's booted simulators,
 * running emulators and the browser sizes, running ones first, searchable, grouped by platform.
 * Orcha reuses what is running and never creates a device. A portal that cannot see the machine
 * (a container portal) takes a name instead.
 */
export function DeviceStep({ state, set, devices, loading, available }: {
  state: WizardState;
  set: SetField;
  devices: DeviceOption[];
  loading?: boolean;
  available: boolean;
}) {
  const kinds = [...new Set(enabledTargets(state).map((t) => t.kind))];

  function setDeviceKey(kind: TargetKind, key: string) {
    set("deviceKeys", { ...state.deviceKeys, [kind]: key });
  }

  const typed = kinds.filter((k) => k !== "web");
  if (!available && typed.length) {
    return (
      <div className="flex flex-col gap-3" data-onboarding-devices>
        {typed.map((k) => (
          <Field key={k} label={<span className="inline-flex items-center gap-1.5"><PlatformIcon kind={k} /> {PLATFORM_NAMES[k]}</span>} hint={k === "ios" ? "Left empty: any booted simulator." : "Left empty: any running emulator."}>
            <Input value={state.deviceKeys[k]} placeholder={k === "ios" ? "iPhone 17 Pro" : "Pixel_9_Pro"} onChange={(e) => setDeviceKey(k, e.target.value)} data-dictation="off" />
          </Field>
        ))}
        {kinds.includes("web") ? <DevicePicker devices={devices} kinds={["web"]} selected={state.deviceKeys} onSelect={setDeviceKey} hideSummary maxHeight={200} /> : null}
      </div>
    );
  }
  return <DevicePicker devices={devices} kinds={kinds} selected={state.deviceKeys} onSelect={(kind, key) => setDeviceKey(kind, key)} loading={loading} maxHeight={460} />;
}
