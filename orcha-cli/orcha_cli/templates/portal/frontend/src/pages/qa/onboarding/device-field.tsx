/**
 * "Device" on a form: the words that say what the pick means, and the device picker. Used by a
 * run's options and a workflow's Quality step, so both offer the same devices the same way.
 */
import { useMemo } from "react";
import { DevicePicker } from "./device-picker-view";
import { pickerRows, rowForKey, type PickerRow } from "./device-picker";
import type { LiveDevices } from "./use-live-devices";
import type { Platform } from "../qaApi";
import { platformWord } from "../qaWords";

const HINT: Record<Platform, string> = {
  ios: "this Mac's simulators and phones",
  android: "this Mac's emulators and phones",
  web: "this Mac's browser",
};

export function usePickedRow(live: LiveDevices, key: string): PickerRow | null {
  const rows = useMemo(() => pickerRows(live.devices), [live.devices]);
  return rowForKey(rows, key);
}

export function DeviceField({ live, platform, pickKey, onPick, rememberPick, missing, maxHeight = 320 }: {
  live: LiveDevices;
  platform: Platform;
  /** The picked row's key; "" is Default. */
  pickKey: string;
  onPick: (key: string) => void;
  /** The pick is kept for this project and platform. */
  rememberPick?: boolean;
  /** A device saved earlier that this Mac does not list now. */
  missing?: string | null;
  maxHeight?: number;
}) {
  const hint = platform === "web"
    ? "The browser size the run uses."
    : `Default lets the agent pick. Local is ${HINT[platform]}.${rememberPick ? ` Embodent remembers your pick for this project on ${platformWord(platform)}.` : ""}`;
  return (
    <div className="qa-field" data-qa-device-field={platform}>
      <span className="qa-label">Device</span>
      <span className="qa-hint">{hint}</span>
      {missing ? <span className="qa-hint" data-qa-device-missing>{missing} is not on this Mac now. Pick another, or the run stops and says so.</span> : null}
      <DevicePicker devices={live.devices} kinds={[platform]} loading={live.loading} selected={{ [platform]: pickKey }} onSelect={(_kind, key) => onPick(key)} maxHeight={maxHeight} hideSummary />
    </div>
  );
}
