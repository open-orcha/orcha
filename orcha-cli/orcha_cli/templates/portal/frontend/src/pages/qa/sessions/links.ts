/** Where a session's links go: the session, compare, and the run page at a step. */
import { qaHref } from "../parts";

/** The platform in the address, kept across a link. */
function platformNow(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("platform");
}

/** The tab in the address: a session opened from Runs stays in Runs, one from Exploration there. */
export function sessionsView(): "sessions" | null {
  if (typeof window === "undefined" || window.location.pathname !== "/qa") return "sessions";
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "sessions" || view === "requests" ? "sessions" : null;
}

export function explorationHref(id: string): string {
  return qaHref({ view: sessionsView(), platform: platformNow(), session: id });
}

export function compareHref(a: string, b: string): string {
  return qaHref({ view: sessionsView(), platform: platformNow(), sub: "compare", a, b });
}

/** The run page, at a step when one is named. */
export function runHref(id: string, step?: number | null): string {
  return qaHref({ view: "sessions", platform: platformNow(), session: id, sub: "run", step: step != null ? String(step) : null });
}
