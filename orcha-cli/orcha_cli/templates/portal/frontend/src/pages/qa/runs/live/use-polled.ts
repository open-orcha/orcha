/**
 * One read, repeated while it matters, that a slow server cannot stop.
 *
 * The pages it replaces restarted their read on a timer, and restarting aborted the read in flight.
 * With answers slower than the timer (12 s against 2.5 s on a loaded machine) every read was aborted
 * before it landed, and the page stayed on its last good answer for good, the session long finished.
 * Here one read runs at a time on `startPollLoop`: it gets the time it needs, is retried when it
 * fails, and a person coming back to the tab reads at once.
 */
import { useEffect, useRef, useState } from "react";
import { errText } from "../../parts";
import { startPollLoop, wakeOnReturn } from "./poll-loop";

/** A read may take this long before it is abandoned. Each abandoned one doubles it (see `startPollLoop`). */
export const READ_TIMEOUT_MS = 20_000;
const RETRY_MS = 4_000;
const HIDDEN_MS = 20_000;
/** A failure is news only when it repeats: one lost read on a busy machine is nothing. */
export const FAILURES_TO_SHOW = 3;
const ANSWERED = new Set([400, 401, 403, 404, 410, 422]);

export interface Polled<T> {
  data: T | null;
  error: string | null;
  status: number | null;
  /** How many reads landed: something to hang a slower read on. */
  reads: number;
}

interface State<T> extends Polled<T> { key: string }

/**
 * `load` read at once and again every `everyMs` while `goesOn(data)`. `key` names what is read: a
 * new key starts clean. A new `nonce` reads again now, whether or not it goes on. A failed read
 * keeps what is on screen.
 */
export function usePolled<T>(load: (signal: AbortSignal) => Promise<T>, key: string, nonce: number, everyMs: number, goesOn: (data: T) => boolean): Polled<T> {
  const [state, setState] = useState<State<T>>({ data: null, error: null, status: null, reads: 0, key: "" });
  const latest = useRef({ load, goesOn });
  latest.current = { load, goesOn };

  useEffect(() => {
    let alive = true;
    let failures = 0;
    const failed = (error: string, status: number | null, now: boolean) => {
      failures += 1;
      if (alive && (now || failures >= FAILURES_TO_SHOW)) setState((s) => ({ ...s, data: s.key === key ? s.data : null, error, status, key }));
    };
    const loop = startPollLoop({
      timeoutMs: READ_TIMEOUT_MS,
      retryMs: RETRY_MS,
      hiddenMs: HIDDEN_MS,
      run: async (signal) => {
        let data: T;
        try {
          data = await latest.current.load(signal);
        } catch (e) {
          if (!alive) throw e;
          if (signal.aborted) {
            failed("Embodent is slow to answer. Still trying.", null, false);
            throw e;
          }
          const status = (e as { status?: number })?.status ?? null;
          const final = status != null && ANSWERED.has(status);
          failed(errText(e), status, final);
          if (final) loop.stop();
          throw e;
        }
        if (!alive) return everyMs;
        failures = 0;
        setState((s) => ({ data, error: null, status: null, reads: (s.key === key ? s.reads : 0) + 1, key }));
        if (!latest.current.goesOn(data)) loop.stop();
        return everyMs;
      },
    });
    const off = wakeOnReturn(loop);
    return () => {
      alive = false;
      off();
      loop.stop();
    };
  }, [key, nonce, everyMs]);

  return state.key === key ? state : { data: null, error: null, status: null, reads: 0 };
}
