import { useEffect, useState } from "react";

/** `Date.now()`, re-read every second while `active`: running phases tick their elapsed time. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

const FOLLOW_THRESHOLD_PX = 24;

/** The list is scrolled to its foot (within a few pixels): a tail keeps following. */
export function isAtBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
