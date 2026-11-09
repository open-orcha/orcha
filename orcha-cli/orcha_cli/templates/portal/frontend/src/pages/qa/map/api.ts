/** The map as the page reads it: `getMap`'s reader plus what it does not carry (each source's summary). */
import { getJSON } from "../../../api/client";
import { normalizeMap, type Platform, type QaMap } from "../qaApi";

export async function getFullMap(cid: string, platform: Platform, signal?: AbortSignal): Promise<QaMap> {
  const raw = await getJSON<unknown>(`/api/containers/${encodeURIComponent(cid)}/qa/map?platform=${encodeURIComponent(platform)}`, signal);
  const sources = raw && typeof raw === "object" ? (raw as { sources?: unknown }).sources : undefined;
  return { ...normalizeMap(raw), sources } as QaMap;
}
