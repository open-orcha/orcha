/**
 * Who may take the human-only QA decisions — approve / pause / retire a scenario,
 * accept or dismiss a suggestion, edit targets, file or dismiss a finding.
 * The AFFORDANCE mirror of the server gate (qa_routes: a human actor; viewers read):
 *   - identity still resolving → wait;
 *   - read-only (viewer, non-member, offline) → never, with the reason;
 *   - no acting human → pick one first;
 *   - otherwise the acting human.
 * The server stays the enforcer; this only decides what the UI offers and why not.
 */
import type { ActingAuthority } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";

export const QA_NO_HUMAN_REASON = "Pick an acting human first (sidebar, bottom-left) — QA decisions are recorded under a human.";

export interface QaAuthority {
  can: boolean;
  human: Agent | null;
  reason: string | null;
}

export function qaAuthority(a: ActingAuthority): QaAuthority {
  if (a.pending) return { can: false, human: null, reason: a.reason || "Checking who you are…" };
  if (a.readOnly) return { can: false, human: null, reason: a.reason || "View-only" };
  if (!a.human || a.human.kind !== "human") return { can: false, human: null, reason: a.reason || QA_NO_HUMAN_REASON };
  return { can: true, human: a.human, reason: null };
}
