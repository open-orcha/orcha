import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function reducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A number that travels to `value`: on mount from `from` (the baseline's figure, so the headline
 * climbs from where coverage started), later from whatever it showed (a fresh measurement). The
 * server render and the first client render show the real value, so screen readers and tests
 * never read a half-way figure; under reduced motion it simply swaps.
 */
export function useTween(value: number | null, { from = 0, duration = 1000, delay = 0 }: { from?: number | null; duration?: number; delay?: number } = {}): number | null {
  const [shown, setShown] = useState(value);
  const last = useRef<number | null>(null);
  // Layout effect: the first climb starts before the browser paints the final figure.
  useLayoutEffect(() => {
    if (value === null) {
      last.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the figure went unknown: show that at once
      setShown(null);
      return;
    }
    const prev = last.current;
    const start = prev ?? from ?? 0;
    last.current = value;
    if (start === value || reducedMotion()) {
      setShown(value);
      return;
    }
    setShown(start);
    let raf = 0;
    let done = false;
    const t0 = performance.now() + delay;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - t0) / duration));
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(start + (value - start) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else done = true;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Interrupted (Strict Mode's mount, mount again): the next run climbs from the same start.
      if (!done) last.current = prev;
      setShown(value);
    };
    // `from` and the timings only shape the first climb.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return shown;
}

/** True once the element has been on screen (and stays true): plays a chart's entrance when it
 * is seen, not while it is below the fold. */
export function useSeen<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no observer (tests, old engines): treat as seen
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        setSeen(true);
        io.disconnect();
      }
    }, { rootMargin: "0px 0px -10% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** Whether the element is on screen now (pauses loops and playback when it scrolls away). */
export function useOnScreen<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, on];
}
