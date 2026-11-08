import { useCallback, useEffect, useRef, useState } from "react";
import { getJSON, sendJSON } from "../../../api/client";
import { startPollLoop, wakeOnReturn } from "../runs/live/poll-loop";
import { mergeAccepted, parseOnboardingMap, type FoundSheet, type MapAction, type OnboardingMap } from "./contract";
import { clearDraft } from "./state";
import { mapBeat } from "./flow";

/** How often the snapshot is re-read while a phase runs. */
export const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 20_000;

/** `GET C/onboarding`: the fields the tab reads itself. */
export interface OnboardingRow {
  phase?: string;
  state?: string;
  found?: FoundSheet | null;
  phases?: unknown;
  error?: string | null;
  /** What the map part below was read at: send it back as `since`, and a read that changes nothing leaves that part out. */
  snapshot_version?: string;
  snapshot_unchanged?: boolean;
  /** Where the first run belongs when the screens are left out. */
  first_run_screen?: { screen_id: string; first_run: unknown } | null;
}

const MAP_KEYS = ["screens", "edges", "files", "gaps", "summary"] as const;

/** The heavy part of the last full read, kept so polls need not carry it. */
export interface HeldSnapshot { version: string; part: Record<string, unknown> }

/** A read folded with what is held: the whole row to show, and what to hold from here. */
export function foldSnapshot(held: HeldSnapshot | null, row: OnboardingRow): { row: OnboardingRow; held: HeldSnapshot | null } {
  const body = row as OnboardingRow & Record<string, unknown>;
  if (!row.snapshot_unchanged) {
    const part = Object.fromEntries(MAP_KEYS.map((k) => [k, body[k]]));
    return { row, held: row.snapshot_version ? { version: row.snapshot_version, part } : null };
  }
  if (!held) return { row, held };
  const first = row.first_run_screen;
  const screens = first && Array.isArray(held.part.screens)
    ? (held.part.screens as { id?: string }[]).map((s) => (s.id === first.screen_id ? { ...s, first_run: first.first_run } : s))
    : held.part.screens;
  return { row: { ...row, ...held.part, screens } as OnboardingRow, held };
}

export type MapLoad =
  | { kind: "loading" }
  | { kind: "ready"; map: OnboardingMap }
  /** The route is not there (an older portal). */
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function onboardingUrl(cid: string): string {
  return `/api/containers/${encodeURIComponent(cid)}/qa/onboarding`;
}

/** The onboarding's row, for the tab to decide where to open (a route that isn't there rejects).
 * Only the row: this is read often, and the map behind it is large. */
export const getOnboardingRow = (cid: string, signal?: AbortSignal) => getJSON<OnboardingRow>(`${onboardingUrl(cid)}?fields=row`, signal);

/** "Run onboarding again": back to Connect, the picks kept on the row until the next scan. */
export function restartOnboarding(cid: string, actor: string | null) {
  clearDraft(cid);
  return sendJSON<unknown>("POST", onboardingUrl(cid), { action: "restart", actor_agent_id: actor });
}

/** Something is still coming: a phase runs, or the map is between its code and tests beats
 * (a backend moving from one to the next may show neither running for a moment). */
export function expectingMore(map: OnboardingMap): boolean {
  if (Object.values(map.phases).some((p) => p.state === "running")) return true;
  const beat = mapBeat(map);
  return beat === "code" || beat === "tests";
}

function errOf(e: unknown): { status?: number; message: string } {
  const x = e as { status?: number; detail?: string; message?: string };
  return { status: x?.status, message: x?.detail || x?.message || "Something went wrong" };
}

/**
 * The project's onboarding, kept current: read once, then every few seconds while a phase runs
 * (the portal has no change feed for it). `act` posts an action and folds what the route
 * answers into the snapshot on screen.
 */
export function useOnboardingMap(cid: string | null) {
  const [load, setLoad] = useState<MapLoad>({ kind: "loading" });
  const [busy, setBusy] = useState<MapAction | null>(null);
  const seq = useRef(0);
  const held = useRef<{ cid: string; snapshot: HeldSnapshot } | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!cid) return;
    const mine = ++seq.current;
    try {
      const have = held.current?.cid === cid ? held.current.snapshot : null;
      const url = have ? `${onboardingUrl(cid)}?since=${encodeURIComponent(have.version)}` : onboardingUrl(cid);
      const read = await getJSON<OnboardingRow>(url, signal);
      if (mine !== seq.current) return;
      const { row, held: next } = foldSnapshot(have, read);
      held.current = next ? { cid, snapshot: next } : null;
      const map = parseOnboardingMap({ ...row, project_id: cid });
      if (!map) {
        setLoad((l) => (l.kind === "ready" ? l : { kind: "error", message: "The map did not load." }));
        return;
      }
      setLoad({ kind: "ready", map });
    } catch (e) {
      if (mine !== seq.current || signal?.aborted) return;
      const { status, message } = errOf(e);
      if (status === 404) setLoad((l) => (l.kind === "ready" ? l : { kind: "missing" }));
      else setLoad((l) => (l.kind === "ready" ? l : { kind: "error", message }));
    }
  }, [cid]);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  const isRunning = load.kind === "ready" && expectingMore(load.map);
  // One read at a time. On a timer a slow portal never showed a thing: each read that came back had
  // been overtaken by a newer one (`seq`), so the page stayed on what it read first.
  useEffect(() => {
    if (!isRunning) return;
    const loop = startPollLoop({
      initialDelayMs: POLL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
      retryMs: POLL_MS,
      hiddenMs: POLL_MS * 6,
      run: async (signal) => { await refresh(signal); return POLL_MS; },
    });
    const off = wakeOnReturn(loop);
    return () => { off(); loop.stop(); };
  }, [isRunning, refresh]);

  const act = useCallback(
    async (action: MapAction, options?: object, actor?: string | null): Promise<string | null> => {
      if (!cid) return "The project is not ready yet.";
      setBusy(action);
      try {
        const body = await sendJSON<unknown>("POST", onboardingUrl(cid), { action, ...(options ? { options } : {}), actor_agent_id: actor ?? null });
        // The phases move now, the full snapshot follows.
        seq.current += 1;
        setLoad((l) => {
          const map = mergeAccepted(l.kind === "ready" ? l.map : null, { project_id: cid, ...(body as object) });
          return map ? { kind: "ready", map } : l;
        });
        void refresh();
        return null;
      } catch (e) {
        const { status, message } = errOf(e);
        if (status === 404) {
          setLoad((l) => (l.kind === "ready" ? l : { kind: "missing" }));
          return null;
        }
        return message;
      } finally {
        setBusy(null);
      }
    },
    [cid, refresh],
  );

  return { load, map: load.kind === "ready" ? load.map : null, busy, act, refresh };
}
