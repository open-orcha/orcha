import { useEffect, useState } from "react";
import { getJSON } from "../../../api/client";
import { WEB_VIEWPORTS } from "../qaApi";
import type { DeviceOption } from "./state";
import type { WorkerDevice } from "./types";

/** How often the list is read while the picker can show it. */
const POLL_MS = 5000;

/** The browser sizes: always there, on any portal. */
export const WEB_OPTIONS: DeviceOption[] = WEB_VIEWPORTS.map((v) => ({
  device: { kind: "web", name: `${v.label} browser (${v.size})`, viewport: v.key, size: v.size },
  online: true,
}));

export interface LiveDevices {
  devices: DeviceOption[];
  /** The first read has not answered yet. */
  loading: boolean;
  /** This portal can see the machine's devices (a container portal cannot: names are typed). */
  available: boolean;
}

/**
 * The devices the wizard offers, kept current like New Run's picker (#454): read once, then every
 * few seconds while `active`, so a phone plugged in or a simulator booted while the page is open
 * shows up. `everything`: paired phones and stopped devices too, not only what can run this moment.
 * Picks are keys (udid, serial), never positions, so they survive a refresh. A failed read keeps
 * the list.
 */
export function useLiveDevices(cid: string, active: boolean, everything = true): LiveDevices {
  const [got, setGot] = useState<{ devices: WorkerDevice[]; available: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      getJSON<{ devices?: WorkerDevice[]; available?: boolean }>(`/api/containers/${encodeURIComponent(cid)}/qa/devices${everything ? "?all=true" : ""}`).then(
        (d) => {
          if (live) setGot({ devices: d.devices ?? [], available: d.available !== false });
        },
        () => {
          if (live) setFailed(true);
        },
      );
    void read();
    if (!active) return () => { live = false; };
    const t = setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [cid, active, everything]);
  return {
    devices: [...(got?.devices ?? []).map((device) => ({ device, online: true })), ...WEB_OPTIONS],
    loading: !got && !failed,
    available: got ? got.available : !failed,
  };
}
