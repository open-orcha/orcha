import { useEffect, useRef } from "react";

const still = () => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A number that counts up from zero when it first appears and glides from its old value to a new
 * one when it changes (the atlas filling in: "18 seen live" becomes 19 as a screenshot lands).
 * The server render, the first client render and a screen reader always have the real value; the
 * motion writes the text node React rendered (no render per frame) and always ends on the value.
 * A change mid-glide glides on from the number shown. Reduced motion, or no `matchMedia` (a test
 * DOM): the value, at once.
 */
export function Num({ value, className, duration = 820, delay = 0 }: { value: number; className?: string; duration?: number; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  /** The number on screen when the last glide stopped (null before the first). */
  const from = useRef<number | null>(null);

  useEffect(() => {
    const node = ref.current?.firstChild;
    const start = from.current ?? 0;
    if (!node || node.nodeType !== Node.TEXT_NODE || start === value || still()) {
      from.current = value;
      return;
    }
    let shown = start;
    const write = (v: number) => {
      shown = v;
      node.nodeValue = String(v);
    };
    const t0 = performance.now() + delay;
    const span = from.current === null ? duration : Math.min(duration, 640);
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - t0) / span));
      write(Math.round(start + (value - start) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    write(start);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = shown;
      node.nodeValue = String(value);
    };
  }, [value, duration, delay]);

  return (
    <span ref={ref} className={className}>
      {String(value)}
    </span>
  );
}
