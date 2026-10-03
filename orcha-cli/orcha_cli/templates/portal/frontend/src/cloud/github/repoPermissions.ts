/**
 * Who may connect / change a project's repository binding.
 *
 * The server is the enforcer: PUT /api/containers/{cid}/github calls
 * enforce_grant(..., "manage_repo") (owner, or a member holding the
 * manage_repo grant; viewers and non-members get 403). This helper only
 * gates the AFFORDANCE, so a caller who would be refused sees why before
 * trying (parity e2e-permissions-16). Trust off (no identity) stays
 * permissive, the same as the backend's trust-off fallback.
 */
import type { Identity } from "../../extensions";
import type { ActingAuthority } from "../../state/SnapshotProvider";

export const MANAGE_REPO_REASON = "Requires the owner role or the manage_repo permission";

export function repoConnectBlockedReason(
  authority: Pick<ActingAuthority, "pending" | "readOnly" | "reason">,
  identity: Identity | null,
): string | null {
  if (authority.pending) return authority.reason || "Resolving your identity…";
  if (authority.readOnly) return authority.reason || "View-only";
  if (identity && identity.member_role !== "owner" && !(identity.grants || []).includes("manage_repo")) {
    return MANAGE_REPO_REASON;
  }
  return null;
}

/** Human copy for a failed PUT /github — never "[object Object]" or a bare
 *  status code (D4). A string detail is the server's own honest sentence. */
export function bindErrorText(status: number, detail: unknown): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (status === 0) return "Couldn't reach Embodent. Check your connection and try again.";
  if (status === 403) return "You don't have permission to change this project's repository.";
  if (status === 422) return "That repository name isn't valid.";
  return "Something went wrong. Try again.";
}
