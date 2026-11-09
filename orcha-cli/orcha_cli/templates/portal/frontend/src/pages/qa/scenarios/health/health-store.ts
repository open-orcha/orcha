/**
 * Client-side cache of stored health flags for the badge. Every badge on screen asks for its
 * scenario; the asks of one render are batched into one request, so a list of 200 rows costs one
 * request, not 200. The Health board seeds and updates the cache after an action.
 */
import { useEffect, useSyncExternalStore } from "react";
import { scenarioFlags } from "../api";
import { parseFlag, type HealthFlag } from "./types";

const MAX_IDS = 150;
const cache = new Map<string, HealthFlag[]>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let pending = new Set<string>();
let scheduled = false;
/** The project the asks are for: one page shows one project. */
let project = "";

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function flush(): Promise<void> {
  scheduled = false;
  const ids = [...pending];
  pending = new Set();
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const chunk = ids.slice(i, i + MAX_IDS);
    try {
      const flags = await scenarioFlags(project, chunk);
      const by = new Map<string, HealthFlag[]>(chunk.map((id) => [id, []]));
      for (const raw of flags) {
        const f = parseFlag(raw);
        if (f && by.has(f.scenario_id)) by.get(f.scenario_id)!.push(f);
      }
      for (const [id, flags] of by) cache.set(id, flags);
    } catch {
      // A failed lookup leaves the badge quiet; the next mount asks again.
    } finally {
      for (const id of chunk) inflight.delete(id);
    }
  }
  notify();
}

/** Ask for `id`'s flags (batched with every other ask of this tick). */
export function requestFlags(cid: string, id: string): void {
  project = cid;
  if (cache.has(id) || inflight.has(id)) return;
  inflight.add(id);
  pending.add(id);
  if (!scheduled) {
    scheduled = true;
    setTimeout(() => void flush(), 0);
  }
}

/** Replace the cached flags of these scenarios (the board after a load or an action). */
export function seedFlags(entries: Iterable<[string, HealthFlag[]]>): void {
  for (const [id, flags] of entries) cache.set(id, flags);
  notify();
}

/** Forget everything (tests). */
export function resetHealthStore(): void {
  cache.clear();
  inflight.clear();
  pending = new Set();
  scheduled = false;
  notify();
}

/** The cached flags of `id` (undefined until loaded). Fetches when `enabled`. */
export function useStoredFlags(cid: string, id: string, enabled: boolean): HealthFlag[] | undefined {
  const flags = useSyncExternalStore(
    subscribe,
    () => cache.get(id),
    () => undefined,
  );
  useEffect(() => {
    if (enabled) requestFlags(cid, id);
  }, [cid, id, enabled]);
  return flags;
}
