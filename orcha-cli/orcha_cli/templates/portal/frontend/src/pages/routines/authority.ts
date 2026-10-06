/**
 * Who may create / edit / run / delete routines — the AFFORDANCE mirror of the server
 * gate (routine_routes: identity_routes.require_grant(..., "manage_agents")):
 *   - an owner, or a member holding `manage_agents`;
 *   - viewers and non-members never (read-only);
 *   - trust off (no identity): the acting human, as the server allows.
 * The server stays the enforcer; this only decides what the UI offers and why not.
 */
import type { Identity } from "../../extensions";
import type { ActingAuthority } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";

export const ROUTINE_GRANT_REASON = "Requires the owner role or the Agents permission (manage_agents)";
export const NO_HUMAN_REASON = "Pick an acting human first (sidebar, bottom-left) — changes are recorded under a human.";

export interface RoutineAuthority {
  can: boolean;
  human: Agent | null;
  reason: string | null;
}

export function routineAuthority(a: ActingAuthority, identity: Identity | null): RoutineAuthority {
  if (a.pending) return { can: false, human: null, reason: a.reason || "Checking who you are…" };
  if (!a.human) return { can: false, human: null, reason: a.reason || NO_HUMAN_REASON };
  if (identity && identity.member_role !== "owner" && (identity.grants || []).indexOf("manage_agents") < 0) {
    return { can: false, human: null, reason: identity.member_role === "viewer" ? "Viewers can't change routines (read-only)" : ROUTINE_GRANT_REASON };
  }
  return { can: true, human: a.human, reason: null };
}
