/**
 * The project-icon PICKER's gate (D14 addendum: `PUT /api/containers/{cid}/icon`).
 *
 * The verdict itself is cloud/projects/iconAccess (owner / manage_autonomy under
 * the trusted lane; viewers and non-members refused; trust off open — the same
 * rule the server enforces and the "Change icon…" entry points disable on).
 * The picker re-checks it so that however it was opened, someone who can't
 * change the icon is told why instead of being offered a grid whose every pick
 * would be refused and snap back. The server stays the enforcer.
 *
 * For the CURRENT project it reads the live snapshot identity (and goes
 * read-only offline, like every other write) and yields the acting human's id
 * so a trust-off save is attributed to that human in the audit log, not
 * "system" (parity SG-10). Other projects ask /api/me?cid= via iconAccessFor.
 */
import { useEffect, useState } from "react";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import { iconAccess, iconAccessFor } from "../../cloud/projects/iconAccess";

export interface IconAuthority {
  /** the picker may save */
  canEdit: boolean;
  /** still resolving who you are on this project (the server decides meanwhile) */
  pending: boolean;
  /** why it can't (null when canEdit) — user-facing, no codes or URLs */
  reason: string | null;
  /** actor to attribute the write to (trust-off lane); null lets the server derive it */
  actorId: string | null;
}

export const ICON_REASON_OFFLINE = "Offline — reconnect to make changes";
export const ICON_REASON_UNVERIFIED = "Couldn't confirm who you are yet (retrying)";

const OPEN: IconAuthority = { canEdit: true, pending: false, reason: null, actorId: null };
const PENDING: IconAuthority = { canEdit: false, pending: true, reason: null, actorId: null };
const deny = (reason: string | null): IconAuthority => ({ canEdit: false, pending: false, reason, actorId: null });

export function useProjectIconAuthority(cid: string, enabled = true): IconAuthority {
  const { snap, identity, identityTrusted, identityPending, identityUnverified, connection } = useSnapshot();
  const current = !!snap?.container?.id && snap.container.id === cid;
  const [other, setOther] = useState<{ cid: string; a: IconAuthority } | null>(null);

  useEffect(() => {
    if (current || !enabled || !cid) return;
    let live = true;
    void iconAccessFor(cid).then((v) => { if (live) setOther({ cid, a: v.allowed ? OPEN : deny(v.reason) }); });
    return () => { live = false; };
  }, [cid, current, enabled]);

  if (current) {
    if (identityPending) return PENDING;
    if (identityUnverified) return deny(ICON_REASON_UNVERIFIED);
    if (connection === "offline") return deny(ICON_REASON_OFFLINE);
    const v = iconAccess({ identity: identity ?? null, trusted: !!identityTrusted });
    if (!v.allowed) return deny(v.reason);
    const h = identity ? null : actingHuman(snap); // trusted lane: the server derives the actor
    return { ...OPEN, actorId: h ? String(h.id) : null };
  }
  if (!enabled) return OPEN;
  return other && other.cid === cid ? other.a : PENDING;
}
