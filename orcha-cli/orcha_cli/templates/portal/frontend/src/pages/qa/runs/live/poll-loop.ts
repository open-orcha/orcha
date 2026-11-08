/**
 * A self-rescheduling poll that cannot stall: the recording page's two loops (the recording
 * row and the live frame) run on it.
 *
 * The loops it replaces stopped for good in three ways: a request that never settled (a
 * busy server, a browser out of connections to the host) kept the loop waiting on it with
 * nothing left to schedule the next read; the live-frame loop ignored every wake while that
 * read was "busy"; and a hidden tab skipped every read, even while it was being driven
 * (automation clicks a background tab, and inputs keep arriving), so the page froze on the
 * old frame and spinners until a reload. Here:
 * - every poll gets an `AbortSignal` and is abandoned after `timeoutMs` whether or not `run`
 *   honours the signal, and the loop goes on after `retryMs`;
 * - one poll runs at a time; a `wake` that lands while one is in flight runs the next as soon
 *   as it ends (never lost, never overlapping);
 * - a hidden tab keeps polling, only no more often than every `hiddenMs`;
 * - each poll abandoned in a row doubles the next one's time limit (up to `maxTimeoutMs`),
 *   and a poll that answers resets it (D109). With a fixed limit, a server that took longer
 *   than `timeoutMs` to answer every read (a dev server compiling under load) had each read
 *   abandoned just before it would have answered, forever: the recording page sat on
 *   "Waiting for a device" while the recording had long started.
 */

export interface PollLoopOptions {
  /** One poll. Resolves with how long to wait before the next one (ms). */
  run: (signal: AbortSignal) => Promise<number>;
  /** A poll that has not settled by then is aborted and counted as failed. */
  timeoutMs: number;
  /** The wait after a failed or abandoned poll. */
  retryMs: number;
  /** The longest a poll is given after several were abandoned in a row (default 8 x `timeoutMs`). */
  maxTimeoutMs?: number;
  /** While the tab is hidden, polls are at least this far apart (a wake still polls at once). */
  hiddenMs: number;
  /** When the first poll runs (default at once). */
  initialDelayMs?: number;
  isHidden?: () => boolean;
}

export interface PollLoop {
  /** Poll within `ms` (default at once), sooner than the scheduled one if that is later. */
  wake: (ms?: number) => void;
  stop: () => void;
}

const documentHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

class Abandoned extends Error {}

export function startPollLoop({
  run,
  timeoutMs,
  retryMs,
  hiddenMs,
  initialDelayMs = 0,
  isHidden = documentHidden,
  maxTimeoutMs = timeoutMs * 8,
}: PollLoopOptions): PollLoop {
  let limit = timeoutMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = Infinity;
  let inFlight = false;
  // A wake that arrived during a poll: the delay it asked for, applied once the poll ends.
  let wokenDuring: number | null = null;
  let current: AbortController | null = null;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    const wait = Math.max(0, ms);
    dueAt = Date.now() + wait;
    timer = setTimeout(tick, wait);
  };

  async function tick() {
    timer = null;
    dueAt = Infinity;
    if (stopped || inFlight) return;
    inFlight = true;
    const controller = new AbortController();
    current = controller;
    let giveUp: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let next: number;
    try {
      const abandoned = new Promise<never>((_, reject) => {
        giveUp = setTimeout(() => {
          timedOut = true;
          reject(new Abandoned());
          controller.abort();
        }, limit);
      });
      const delay = await Promise.race([run(controller.signal), abandoned]);
      next = Number.isFinite(delay) ? delay : retryMs;
      limit = timeoutMs;
    } catch {
      next = retryMs;
      // Timed out, whether the abandon or `run` honouring the abort rejected first.
      if (timedOut) limit = Math.min(Math.max(maxTimeoutMs, timeoutMs), limit * 2);
    } finally {
      if (giveUp !== null) clearTimeout(giveUp);
      inFlight = false;
      current = null;
    }
    if (stopped) return;
    if (isHidden()) next = Math.max(next, hiddenMs);
    if (wokenDuring !== null) {
      next = Math.min(next, wokenDuring);
      wokenDuring = null;
    }
    schedule(next);
  }

  schedule(initialDelayMs);

  return {
    wake(ms = 0) {
      if (stopped) return;
      if (inFlight) {
        wokenDuring = wokenDuring === null ? ms : Math.min(wokenDuring, ms);
        return;
      }
      if (Date.now() + ms < dueAt) schedule(ms);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      current?.abort();
    },
  };
}

/** Poll at once when the person comes back: a hidden tab's timers run late, a laptop's stop. */
export function wakeOnReturn(loop: PollLoop): () => void {
  const wake = () => { if (document.visibilityState !== "hidden") loop.wake(); };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  return () => {
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
  };
}
