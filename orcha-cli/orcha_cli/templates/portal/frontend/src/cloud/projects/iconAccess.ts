/**
 * D14: who may change a project's icon — the AFFORDANCE gate mirroring the
 * server's `PUT /api/containers/{cid}/icon` (container_control_routes.py:
 * `enforce_grant(..., "manage_autonomy")`): under the trusted proxy lane only
 * an owner or a `manage_autonomy` holder; viewers and non-members are refused;
 * trust off (self-host) stays open. The server remains the enforcer — this
 * only disables the "Change icon…" entry points with the reason, so nobody
 * picks an icon that silently snaps back (parity e2e-permissions-7 / SG-09).
 *
 * `iconAccessFor(cid)` reads `/api/me?cid=` directly (NOT identity.fetchMe:
 * that single-slot cache belongs to the CURRENT project's identity and must
 * not be evicted by a hub row asking about another project). One answer per
 * cid is kept for the page's life; a failed read fails OPEN (the picker then
 * reports the server's refusal).
 */
import type { Me } from "../identity";
import { registerTestReset } from "../../lib/testResets";

export interface IconAccess { allowed: boolean; reason: string | null }

export const ICON_REASON_NON_MEMBER = "You're not a member of this project (view-only)";
export const ICON_REASON_VIEWER = "Your role is viewer (read-only)";
export const ICON_REASON_GRANT = "Requires the owner role or the Autonomy permission (manage_autonomy)";

/** Pure verdict from a resolved /api/me envelope. */
export function iconAccess(me: Me | null | undefined): IconAccess {
  if (!me || !me.trusted) return { allowed: true, reason: null }; // trust off: open, as the server
  const id = me.identity;
  if (!id) return { allowed: false, reason: ICON_REASON_NON_MEMBER };
  if (id.member_role === "owner") return { allowed: true, reason: null };
  if (id.member_role === "viewer") return { allowed: false, reason: ICON_REASON_VIEWER };
  if ((id.grants || []).includes("manage_autonomy")) return { allowed: true, reason: null };
  return { allowed: false, reason: ICON_REASON_GRANT };
}

const cache = new Map<string, Promise<IconAccess>>();

export function iconAccessFor(cid: string): Promise<IconAccess> {
  let p = cache.get(cid);
  if (!p) {
    p = fetch("/api/me?cid=" + encodeURIComponent(cid))
      .then(async (r) => {
        if (!r.ok) return iconAccess(null);
        const d = (await r.json().catch(() => null)) as { identity?: Me["identity"]; trusted?: boolean } | null;
        return iconAccess({ identity: (d && d.identity) || null, trusted: !!(d && d.trusted) });
      })
      .catch(() => {
        cache.delete(cid); // no verdict: ask again next time
        return iconAccess(null);
      });
    cache.set(cid, p);
  }
  return p;
}

/** test seam */
export function resetIconAccess(): void { cache.clear(); }
registerTestReset(resetIconAccess);
