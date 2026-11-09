import { useLayoutEffect, useState } from "react";

/**
 * The frame's height cap measured, not guessed: where the frame starts on screen plus the rows
 * below it. The run theater stacks more chrome above the player (run title, chips, batch bar,
 * tabs, the Steps/Video switch) than the fixed reserves assumed, and a tall phone ran off the
 * bottom of the pane. Falls back to the fixed reserve until measured.
 */
export function useMeasuredReserve(fallback: number, below: number) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [reserve, setReserve] = useState(fallback);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      if (Number.isFinite(top)) setReserve(Math.max(fallback, Math.round(top + below)));
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(document.documentElement);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [el, fallback, below]);
  return [setEl, reserve] as const;
}
