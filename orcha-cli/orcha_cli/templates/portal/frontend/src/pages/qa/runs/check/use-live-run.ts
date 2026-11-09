import { useEffect, useRef, useState } from "react";
import type { RunStatus, ScenarioResult, Step } from "../types";

export interface LiveRunState {
  /** Rows the page already passes in: the run page polls one document. */
  liveSteps: Step[];
  liveResults: Map<string, ScenarioResult>;
  /** True until the document reports a non-`running` status. */
  isLive: boolean;
  /**
   * `Date.now()` (client wall clock) of the last step or result seen, or of mount if none has
   * arrived yet (the stall banner).
   */
  lastActivityAt: number;
}

const NO_STEPS: Step[] = [];
const NO_RESULTS = new Map<string, ScenarioResult>();

/** Follows a polled run: live while its status is `running`, active whenever its rows grow. */
export function useLiveRun(status: RunStatus, activity: number): LiveRunState {
  const [lastActivityAt, setLastActivityAt] = useState(() => Date.now());
  const seen = useRef(activity);
  useEffect(() => {
    if (activity === seen.current) return;
    seen.current = activity;
    setLastActivityAt(Date.now());
  }, [activity]);
  return { liveSteps: NO_STEPS, liveResults: NO_RESULTS, isLive: status === "running", lastActivityAt };
}

const TICK_MS = 250;

/**
 * Elapsed ms since `startedAt`, ticking on its own (not just when a new step
 * arrives) so the live counter keeps moving between steps. Returns `null`
 * while `active` is false or `startedAt` is unknown.
 *
 * Implementation note: `Date.now()` is impure, so it's never read during
 * render — only inside the interval callback, which stores the result as
 * state. The effect itself only starts/clears the interval; it never calls
 * setState synchronously in its own body (both rules the React Compiler /
 * react-hooks lint enforce).
 */
export function useElapsedMs(
  startedAt: string | null,
  active: boolean,
): number | null {
  const key = active && startedAt ? startedAt : null;
  const [state, setState] = useState<{
    key: string | null;
    now: number | null;
  }>(() => ({
    key,
    now: key ? Date.now() : null,
  }));

  useEffect(() => {
    if (!key) return;
    const id = setInterval(() => setState({ key, now: Date.now() }), TICK_MS);
    return () => clearInterval(id);
  }, [key]);

  if (!key) return null;
  const started = new Date(key).getTime();
  if (Number.isNaN(started)) return null;
  // Briefly (until the first tick, ≤TICK_MS later) `state` may still belong to a
  // different key (or hold the lazy-init value) — show 0 rather than nothing.
  const now = state.key === key ? state.now : null;
  return Math.max(0, (now ?? started) - started);
}

const STALE_TICK_MS = 10_000;

/**
 * Minutes since `lastActivityAt` (client wall clock), ticking on its own so the "No
 * activity for N min" banner keeps advancing between steps rather than freezing at the
 * value it had when the last one arrived. Returns `null` while `active` is false.
 */
export function useStaleMinutes(
  lastActivityAt: number,
  active: boolean,
): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), STALE_TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;
  return Math.max(0, Math.floor((now - lastActivityAt) / 60_000));
}
