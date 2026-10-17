/**
 * Code Space write gate (wave4 review, "viewer still sees working write
 * controls"). Every Code Space write — worktree save / commit / push and the
 * GitHub-mode propose — goes through the backend's `trusted_actor`, which
 * refuses a viewer and a trusted non-member (403). This hook only gates the
 * AFFORDANCES so the UI never offers a write the server will refuse; trust off
 * (self-host) and members/owners are unaffected. Offline also blocks (every
 * write would fail), matching useActingAuthority.
 */
import { useActingAuthority } from "../../state/SnapshotProvider";

/** null → writes allowed; otherwise the human reason shown as the tooltip. */
export function useCodeWriteBlock(): string | null {
  const a = useActingAuthority();
  if (a.pending) return a.reason || "Resolving your identity…";
  if (a.readOnly) return a.reason || "View-only";
  return null;
}
