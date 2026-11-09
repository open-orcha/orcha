/**
 * Pure helpers for the draft review deck (generate-scenarios card-by-card
 * review): which card to land on, and how a draft's status maps to the dot
 * strip's fill state. Kept side-effect free so they are easy to unit test.
 */
import type { ScenarioStatus } from "../../../qaApi";

/** Dot fill state shown in the header strip (spec: filled/hollow/red/current). */
export type DotState = "accepted" | "draft" | "removed";

/** A draft's dot state from its status; "removed" only applies to ids no longer
 * present in `drafts` (the caller tracks those separately — see `dotStateFor`). */
export function dotState(status: ScenarioStatus): DotState {
  return status === "validated" ? "accepted" : "draft";
}

/**
 * Index of the next undecided (still-draft) card after `from`, wrapping once
 * to the start; null when every card is decided (accepted) or there are none.
 * Used by "Accept" to auto-advance and by "Accept remaining" to know if any
 * work is left.
 */
export function nextUndecidedIndex(
  statuses: readonly ScenarioStatus[],
  from: number,
): number | null {
  const n = statuses.length;
  if (n === 0) return null;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (statuses[i] !== "validated") return i;
  }
  return null;
}

/** Clamp an index into `[0, length - 1]`, or 0 for an empty list. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

/** A project's scenarios still waiting for review (status `draft`), oldest first. */
export function waitingDrafts<T extends { status: ScenarioStatus; created_at: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.status === "draft").sort((a, b) => a.created_at.localeCompare(b.created_at));
}
