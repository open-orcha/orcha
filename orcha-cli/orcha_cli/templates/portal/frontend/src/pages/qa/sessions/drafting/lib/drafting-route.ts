/**
 * The state the drafting page shows, derived from its session rather than kept in component
 * state, so leaving the page and coming back resumes exactly where the agent is.
 */
import type { DraftSources } from "./types";

export type DraftingPhase = "idle" | "starting" | "queued" | "running" | "completed" | "failed" | "cancelled";

const KNOWN = new Set<DraftingPhase>(["queued", "running", "completed", "failed", "cancelled"]);

/** No request yet → idle; a request whose status is not known yet → starting. */
export function draftingPhase(requestId: string | null, status: string | null): DraftingPhase {
  if (!requestId) return "idle";
  return status && KNOWN.has(status as DraftingPhase) ? (status as DraftingPhase) : "starting";
}

/** Still with the agent (or waiting for one): the page streams, Stop is offered. */
export function isOpenPhase(phase: DraftingPhase): boolean {
  return phase === "queued" || phase === "running" || phase === "starting";
}

/** The one-line progress shown at the top (and asserted by e2e: "Done — 3 drafted"). */
export function progressLine({
  phase,
  sources,
  draftCount,
  drafted,
  error,
  stopping = false,
}: {
  phase: DraftingPhase;
  sources: DraftSources;
  /** Drafts loaded so far (streams in while running). */
  draftCount: number;
  /** The final count, falling back to `draftCount`. */
  drafted: number;
  error: string | null;
  stopping?: boolean;
}): string {
  if (stopping && (phase === "running" || phase === "queued")) return "Stopping…";
  switch (phase) {
    case "queued":
      return "Waiting for an agent…";
    case "running": {
      // Reading until the first draft lands, drafting after: never "Reading…" with drafts
      // landing under it.
      const what = sources === "code" ? "the repo" : sources === "exploration" ? "the explorations" : "the repo and explorations";
      return draftCount > 0 ? `Drafting from ${what}… ${draftCount} drafted` : `Reading ${what}… ${draftCount} drafted`;
    }
    case "completed":
      return `Done. ${drafted} drafted`;
    case "failed":
      return `Drafting failed: ${error ?? "unknown error"}`;
    case "cancelled":
      return "Stopped. Drafts written before the stop stay for review";
    default:
      return "Starting…";
  }
}

/** The quiet rail across the top of the page. */
export const DRAFTING_STEPS = ["Read", "Draft", "Review", "Run"] as const;

/**
 * Which step of the rail is current, from data only: reading until the first draft lands,
 * drafting while more stream in, review once the agent is done, run once something is
 * accepted and nothing is left undecided.
 */
export function draftingStep({
  phase,
  draftCount,
  accepted,
}: {
  phase: DraftingPhase;
  draftCount: number;
  accepted: number;
}): number {
  if (phase === "idle") return 0;
  if (isOpenPhase(phase)) return draftCount === 0 ? 0 : 1;
  if (draftCount === 0) return phase === "completed" ? 2 : 0;
  return accepted > 0 && accepted >= draftCount ? 3 : 2;
}

/** The sources a session read: a session that did not say read code. */
export function requestSources(sources: string | null | undefined, repoUrl: string | null): DraftSources {
  if (sources === "code" || sources === "exploration" || sources === "both") return sources;
  return repoUrl ? "code" : "exploration";
}
