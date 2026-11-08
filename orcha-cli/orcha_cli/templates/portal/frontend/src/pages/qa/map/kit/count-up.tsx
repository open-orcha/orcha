
import { useLayoutEffect, useRef, useState } from "react";

const NUMBER = /\d+(?:\.\d+)?/g;

/** `text` with every number in it scaled by `t` (0..1), keeping each number's decimals. */
export function scaleNumbers(text: string, t: number): string {
  return text.replace(NUMBER, (m) => {
    const decimals = m.includes(".") ? m.split(".")[1].length : 0;
    const v = Number(m) * t;
    return decimals ? v.toFixed(decimals) : String(Math.round(v));
  });
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A stat that counts up to its value when it appears: every number inside `value` ("84",
 * "100%", "0 / 1", "21s") climbs from zero together over `duration`, easing out. The server
 * render and the first client render are the final text (no hydration mismatch, and tests and
 * screen readers always see the real value); the count runs only in the browser, and not at all
 * under reduced motion. Text without digits ("—") is shown as is. When `value` changes later
 * (a live refresh) it simply swaps, without replaying — even when that lands mid-count.
 */
export function CountUp({ value, duration = 900, delay = 0, className }: { value: string; duration?: number; delay?: number; className?: string }) {
  const [shown, setShown] = useState(value);
  // The value the count started from, and whether it ran to the end. Only an interrupted count
  // of that same value plays again (Strict Mode's mount/unmount/mount in development); any
  // other value is a live refresh and swaps in at once. Restarting on every interruption made a
  // stat that refreshed mid-count (a live page refreshes about once a second during a run)
  // drop back to zero and climb again, over and over.
  const startedWith = useRef<string | null>(null);
  const finished = useRef(false);

  useLayoutEffect(() => {
    const first = startedWith.current === null;
    if (first) startedWith.current = value;
    const replay = !finished.current && startedWith.current === value;
    if (!replay || !/\d/.test(value) || prefersReducedMotion()) {
      if (first || !replay) finished.current = true;
      setShown(value);
      return;
    }
    setShown(scaleNumbers(value, 0));
    let raf = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(p >= 1 ? value : scaleNumbers(value, eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else finished.current = true;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, delay]);

  return <span className={className}>{shown}</span>;
}
