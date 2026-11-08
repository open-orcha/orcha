import { useEffect, useMemo, useRef, useState } from "react";
import { getSession, listFlows, type QaFlow, type SessionDetail } from "../../qaApi";
import { usePolled } from "../../runs/live/use-polled";
import { listSteps, type QaStep } from "../api";
import { liveStateOf } from "../adapt";
import type { LiveState } from "./model";

/** How often a running session is read again. */
export const LIVE_POLL_MS = 2_500;
const FLOW_EVERY_READS = 4;

export interface SessionLive {
  detail: SessionDetail | null;
  steps: QaStep[];
  flows: QaFlow[] | null;
  live: LiveState | null;
  error: string | null;
  /** Read it again now (after an action). */
  reload: () => void;
}

/**
 * The session's live state: its row with everything under it, and its steps, read again every
 * few seconds while it runs and once more whenever the page refreshes. A failed read keeps what
 * is on screen, and is tried again: a slow read is waited for, never restarted (`usePolled`).
 */
export function useSessionLive(cid: string, id: string, nonce: number): SessionLive {
  const [flows, setFlows] = useState<QaFlow[] | null>(null);
  const [tick, setTick] = useState(0);
  const lastSteps = useRef<{ id: string; steps: QaStep[] }>({ id, steps: [] });
  const read = usePolled(
    async (signal) => {
      const [d, s] = await Promise.all([getSession(id, signal), listSteps(id, signal).catch(() => null)]);
      return { detail: d, steps: s };
    },
    id,
    nonce + tick,
    LIVE_POLL_MS,
    (r) => r.detail.session.status === "running",
  );
  const detail = read.data?.detail ?? null;
  if (lastSteps.current.id !== id) lastSteps.current = { id, steps: [] };
  if (read.data?.steps) lastSteps.current.steps = read.data.steps;
  const steps = lastSteps.current.steps;
  const running = detail?.session.status === "running";
  const platform = detail?.session.platform ?? null;

  // The flow queue: read with every few reads of the session while it runs, and once when it opens ended.
  const round = running ? Math.floor(read.reads / FLOW_EVERY_READS) : -1;
  useEffect(() => {
    if (!platform) return;
    const ctl = new AbortController();
    void listFlows(cid, platform, ctl.signal).then((f) => setFlows(f), () => {});
    return () => ctl.abort();
  }, [cid, platform, round]);

  const live = useMemo(() => (detail ? liveStateOf(detail, steps, flows) : null), [detail, steps, flows]);
  return { detail, steps, flows, live, error: read.error, reload: () => setTick((n) => n + 1) };
}
