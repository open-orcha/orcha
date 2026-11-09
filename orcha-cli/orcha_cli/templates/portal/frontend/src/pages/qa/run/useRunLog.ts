/**
 * A run's timeline, kept current: a single read at a time every few seconds while the run is alive
 * and once when it is over. Each read asks only for what is new; a slow or failed one keeps every
 * line on screen and is tried again.
 */
import { useEffect, useRef, useState } from "react";
import { startPollLoop, wakeOnReturn } from "../runs/live/poll-loop";
import { getRunLog, mergeEntries, type RunLogAnswer, type RunLogEntry, type RunLogTarget, type RunNow } from "./runLog";

export const RUN_LOG_POLL_MS = 3_000;
const READ_TIMEOUT_MS = 20_000;
const RETRY_MS = 5_000;
const HIDDEN_MS = 20_000;

export interface RunLog {
  entries: RunLogEntry[];
  now: RunNow | null;
  live: boolean;
  truncated: boolean;
  /** The session of this run, once there is one. */
  sessionId: string | null;
  platform: string | null;
  /** When a read last landed. */
  lastOkAt: number | null;
  /** Read again now (after an action). */
  refresh: () => void;
}

type Held = Omit<RunLog, "refresh">;
const EMPTY: Held = { entries: [], now: null, live: true, truncated: false, sessionId: null, platform: null, lastOkAt: null };

/** `restart`: a change reads again from the start, for a run that was over and goes on (Run again). */
export function useRunLog(target: RunLogTarget, restart?: unknown): RunLog {
  const { taskId = null, sessionId = null } = target;
  const key = `${taskId ?? ""}:${sessionId ?? ""}`;
  const [held, setHeld] = useState<{ key: string; log: Held }>({ key, log: EMPTY });
  const wake = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!taskId && !sessionId) return;
    let alive = true;
    let cursor: string | null = null;
    const loop = startPollLoop({
      timeoutMs: READ_TIMEOUT_MS,
      retryMs: RETRY_MS,
      hiddenMs: HIDDEN_MS,
      run: async (signal) => {
        let got: RunLogAnswer;
        try {
          got = await getRunLog({ taskId, sessionId }, cursor, signal);
        } catch (e) {
          if ((e as { status?: number })?.status === 404) loop.stop(); // an older portal, or a run that is gone
          throw e;
        }
        if (!alive) return RUN_LOG_POLL_MS;
        cursor = got.cursor;
        setHeld((h) => {
          const was = h.key === key ? h.log : EMPTY;
          return {
            key,
            log: {
              entries: mergeEntries(was.entries, got.entries ?? []),
              now: got.now ?? null,
              live: got.live,
              truncated: was.truncated || got.truncated,
              sessionId: got.session_id ?? null,
              platform: got.platform ?? null,
              lastOkAt: Date.now(),
            },
          };
        });
        if (!got.live) loop.stop();
        return RUN_LOG_POLL_MS;
      },
    });
    wake.current = () => loop.wake();
    const off = wakeOnReturn(loop);
    return () => {
      alive = false;
      off();
      loop.stop();
    };
  }, [key, taskId, sessionId, restart]);

  const log = held.key === key ? held.log : EMPTY;
  return { ...log, refresh: () => wake.current() };
}
