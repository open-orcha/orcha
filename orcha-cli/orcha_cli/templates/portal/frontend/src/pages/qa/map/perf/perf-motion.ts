import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

/**
 * Motion helpers of the performance views: reduced motion, on-screen, a real-time clock
 * for the stopwatch scenes, a tweened number and a FLIP reorder for ranked rows. Each one rests
 * on the finished frame under `prefers-reduced-motion` and stops when it is off screen.
 */

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeReduced(cb: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}

/** Whether the viewer asked for less motion (false on the server, so the first frame matches). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/** Whether `ref` is on screen (and the tab visible). True where there is no observer (tests). */
export function useInView<T extends Element>(ref: RefObject<T | null>, threshold = 0.15): boolean {
  const [inView, setInView] = useState(true);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, threshold]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return inView && visible;
}

/**
 * A real-time clock for a stopwatch scene: once played, `ms` runs from 0 to `endMs` at `rate`
 * (1 is real time), then stops on `endMs`. `replay()` starts it over. Before its first play it
 * waits at 0; under reduced motion (and where there are no animation frames) it rests on the
 * end. It renders on animation frames only while it runs, and holds while `active` is false
 * (the scene off screen), going on from where it was.
 */
export function usePlayClock(endMs: number, { autoPlay = true, rate = 1, active = true }: { autoPlay?: boolean; rate?: number; active?: boolean } = {}) {
  const reduced = useReducedMotion();
  const [ms, setMs] = useState(0);
  const [take, setTake] = useState(autoPlay ? 1 : 0);
  const [running, setRunning] = useState(false);
  const from = useRef(0);

  const frames = typeof requestAnimationFrame !== "undefined";
  useEffect(() => {
    if (reduced || take === 0 || !frames || !active || from.current >= endMs) return;
    let raf = 0;
    let start: number | null = null;
    const startAt = from.current;
    const tick = (now: number) => {
      if (start === null) {
        start = now;
        setRunning(true);
      }
      const t = Math.min(endMs, startAt + (now - start) * rate);
      from.current = t;
      setMs(t);
      if (t < endMs) raf = requestAnimationFrame(tick);
      else setRunning(false);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setRunning(false);
    };
  }, [take, endMs, rate, reduced, active, frames]);

  const replay = useCallback(() => {
    from.current = 0;
    setMs(0);
    setTake((n) => n + 1);
  }, []);
  return { ms: reduced || (!frames && take > 0) ? endMs : take === 0 ? 0 : ms, running: running && !reduced, replay, reduced, started: take > 0 };
}

/**
 * FLIP for a ranked list: when a re-read moves rows, each one slides from where it was to its new
 * place (transform only). Rows carry `data-flip=<key>` inside the container `ref`.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, order: string) {
  const reduced = useReducedMotion();
  const last = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rows = [...el.querySelectorAll<HTMLElement>("[data-flip]")];
    const now = new Map(rows.map((r) => [r.dataset.flip ?? "", r.offsetTop]));
    if (!reduced && last.current.size) {
      for (const r of rows) {
        const before = last.current.get(r.dataset.flip ?? "");
        const after = now.get(r.dataset.flip ?? "");
        if (before === undefined || after === undefined || before === after) continue;
        r.animate([{ transform: `translateY(${before - after}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
      }
    }
    last.current = now;
  }, [ref, order, reduced]);
}
