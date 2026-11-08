import { useCallback, useEffect, useRef, useState } from "react";
import { startPollLoop } from "./poll-loop";
import {
  LIVE_ABSENT_MS,
  LIVE_FAST_MS,
  LIVE_TIMEOUT_MS,
  liveMetaPath,
  nextLiveDelay,
  parseLiveMeta,
  sameLiveMeta,
  type LiveFrame,
  type LiveMeta,
} from "./recording-live";

/** Image URL of a live frame: the path, made unique per frame so the browser loads it again. */
export function liveFrameSrc(frame: LiveFrame): string {
  return `${frame.path}?v=${frame.n}`;
}

/** Resolves once the frame has loaded (or failed to), or as soon as `signal` aborts. */
function preload(next: LiveFrame, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const img = new Image();
    const abandon = () => {
      img.onload = img.onerror = null;
      img.src = "";
      resolve();
    };
    const done = () => {
      signal.removeEventListener("abort", abandon);
      resolve();
    };
    img.onload = done;
    img.onerror = done;
    signal.addEventListener("abort", abandon, { once: true });
    img.src = liveFrameSrc(next);
  });
}

/**
 * The newest live frame of a running session (`recording-live.ts`), swapped in only once it has
 * loaded, so the screen never blanks. While `enabled`, it reads the session's live state every
 * `LIVE_FAST_MS` while frames keep coming and backs off while the screen is still; `wake()`
 * (called on every input) reads it again at once, or right after a read in flight.
 *
 * The loop is `startPollLoop`: a read or a frame load that hangs is abandoned after
 * `LIVE_TIMEOUT_MS` and the loop goes on, so the screen can't stay frozen on an old frame
 * until a reload; a hidden tab keeps reading, every `LIVE_ABSENT_MS`.
 */
export function useLiveFrame(
  runId: string | null,
  enabled: boolean,
  initial: LiveFrame | null,
): { frame: LiveFrame | null; meta: LiveMeta | null; wake: () => void } {
  const [frame, setFrame] = useState<LiveFrame | null>(initial);
  const [meta, setMeta] = useState<LiveMeta | null>(null);
  const wakeRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled || !runId) return;
    const id = runId;
    let delay = LIVE_FAST_MS;
    let last: LiveFrame | null = null;

    async function read(signal: AbortSignal): Promise<{ changed: boolean; present: boolean }> {
      const res = await fetch(`${liveMetaPath(id)}?t=${Date.now()}`, { cache: "no-store", signal });
      if (!res.ok) return { changed: false, present: false };
      const raw = (await res.json().catch(() => null)) as LiveMeta | null;
      if (raw && !signal.aborted) setMeta((prev) => (sameLiveMeta(prev, raw) ? prev : raw));
      const next = parseLiveMeta(id, raw);
      if (!next) return { changed: false, present: false };
      if (last && next.n === last.n && next.cmdSeq === last.cmdSeq) return { changed: false, present: true };
      if (!last || next.n !== last.n) await preload(next, signal);
      if (signal.aborted) return { changed: false, present: true };
      last = next;
      setFrame(next);
      return { changed: true, present: true };
    }

    const loop = startPollLoop({
      run: async (signal) => {
        const { changed, present } = await read(signal);
        delay = nextLiveDelay(delay, changed, present);
        return delay;
      },
      timeoutMs: LIVE_TIMEOUT_MS,
      retryMs: LIVE_ABSENT_MS,
      hiddenMs: LIVE_ABSENT_MS,
    });

    wakeRef.current = () => {
      delay = LIVE_FAST_MS;
      loop.wake(0);
    };
    // A tab shown again catches up at once.
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") wakeRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      wakeRef.current = () => {};
      loop.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, runId]);

  const wake = useCallback(() => wakeRef.current(), []);
  return { frame: enabled ? frame : null, meta, wake };
}
