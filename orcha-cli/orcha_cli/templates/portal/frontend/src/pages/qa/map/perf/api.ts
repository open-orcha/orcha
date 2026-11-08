/**
 * Screen timings as the pages read them. `GET C/perf` answers the window's samples, read from the
 * steps sessions recorded (`qa_perf.py`); the ranking is `buildSlowest`, here on the page.
 */
import { getJSON, sendJSON } from "../../../../api/client";
import { buildSlowest, countNoise, type PerfSampleRow, type RunningTimings, type SlowestResponse } from "./perf";
import { normalisePerfSettings, type PerfChange, type PerfSettings } from "./perf-settings";

interface PerfRead {
  samples: PerfSampleRow[];
  /** `<platform>:<screen key>`: its map node and the frame the map last saw it by. */
  screens: Record<string, { node: string; frame: string | null }>;
  running: RunningTimings[];
  platforms: string[];
  days: number;
  settings: unknown;
}

const base = (cid: string) => `/api/containers/${encodeURIComponent(cid)}/qa/perf`;

export async function loadSlowest(cid: string, days: number, platform: string | null, signal?: AbortSignal): Promise<SlowestResponse> {
  const q = new URLSearchParams({ days: String(days), ...(platform ? { platform } : {}) });
  const read = await getJSON<PerfRead>(`${base(cid)}?${q}`, signal);
  const settings = normalisePerfSettings(read.settings);
  const screens = buildSlowest(read.samples, [], settings);
  for (const s of screens) {
    const known = read.screens[`${s.platform}:${s.key}`];
    s.frame = known?.frame ?? null;
    s.node = known?.node ?? null;
  }
  return { screens, platforms: read.platforms, days: read.days, settings, noise: countNoise(read.samples), total_samples: read.samples.length, running: read.running };
}

export const getPerfSettings = (cid: string, signal?: AbortSignal): Promise<PerfSettings> =>
  getJSON<unknown>(`${base(cid)}/settings`, signal).then(normalisePerfSettings);

export const savePerfSettings = (cid: string, change: PerfChange, actor: string | null): Promise<PerfSettings> =>
  sendJSON<unknown>("PUT", `${base(cid)}/settings`, { actor_agent_id: actor, change }).then(normalisePerfSettings);
