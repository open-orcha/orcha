/**
 * Settings' owner-or-grant AFFORDANCE gate (parity e2e-permissions-15,
 * MP-PERM-VIEWER, EX-12). The server stays the enforcer
 * (identity_routes.enforce_grant):
 *   - keys (llm-key, provider-keys, incl. /test) and PUT settings/models → manage_keys
 *   - POST …/worktrees (and every other execution write)               → manage_autonomy
 *   - PUT …/limits (the agent limit — it gates agent creation)         → manage_agents
 *   - PUT …/review-routing (who verifies finished work, mig 057)       → assign_reviewers
 * Under the trusted lane only an owner or a holder of the grant may write; a
 * viewer / non-member never. Trust off (no identity) keeps the permissive
 * lane: any acting human may act, as the server allows.
 *
 * The acting authority (who, or why nobody — pending, viewer, non-member,
 * offline, no human picked) comes from useActingAuthority, so every card
 * says the same reason the rest of the app does.
 */
import type { Identity } from "../../extensions";
import { useActingAuthority, useSnapshot, type ActingAuthority } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";

export type SettingsGrant = "manage_keys" | "manage_autonomy" | "manage_agents" | "assign_reviewers";

export const SETTINGS_GRANT_REASON: Record<SettingsGrant, string> = {
  manage_keys: "Requires the owner role or the API keys permission (manage_keys)",
  manage_autonomy: "Requires the owner role or the Autonomy permission (manage_autonomy)",
  manage_agents: "Requires the owner role or the Agents permission (manage_agents)",
  assign_reviewers: "Requires the owner role or the Reviewers permission (assign_reviewers)",
};
/** When nobody acts and the authority carries no reason (open build, no humans). */
export const NO_HUMAN_SETTINGS_REASON = "Pick an acting human first (sidebar, bottom-left) — changes are recorded under a human.";

export interface GrantAuthority {
  /** may write */
  can: boolean;
  /** the acting human to attribute the write to (null when !can) */
  human: Agent | null;
  /** identity still resolving — don't show a refusal yet */
  pending: boolean;
  /** why not (null when can) — user-facing, no codes */
  reason: string | null;
}

/** Pure verdict (unit-tested). */
export function grantAuthority(a: ActingAuthority, identity: Identity | null, grant: SettingsGrant): GrantAuthority {
  if (a.pending) return { can: false, human: null, pending: true, reason: a.reason };
  if (!a.human) return { can: false, human: null, pending: false, reason: a.reason || NO_HUMAN_SETTINGS_REASON };
  if (identity && identity.member_role !== "owner" && (identity.grants || []).indexOf(grant) < 0) {
    return { can: false, human: null, pending: false, reason: SETTINGS_GRANT_REASON[grant] };
  }
  return { can: true, human: a.human, pending: false, reason: null };
}

export function useGrantAuthority(grant: SettingsGrant): GrantAuthority {
  const { identity } = useSnapshot();
  return grantAuthority(useActingAuthority(), identity, grant);
}
