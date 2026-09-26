/**
 * ORCHA CLOUD — the /api/me identity layer (React port of the vanilla
 * data.js fetchMe + app-data.js acting-identity accessors).
 *
 * Wire contract (backend UNCHANGED — portal_backend/identity_routes.py):
 *   GET /api/me?cid=<cid> -> { identity: {agent_id, alias, github_login,
 *       member_role, avatar_url, grants} | null, trusted: bool }
 * No cid -> no call (vanilla data.js resolves {identity:null, trusted:false}
 * without touching the network). Any failure — 401/404, network error, bad
 * JSON — fails OPEN to {identity:null, trusted:false}: the self-host state,
 * where every consumer falls back to the pre-collab local-human behavior.
 *
 * Trust semantics (vanilla comment, preserved verbatim in spirit):
 *   identity null + trusted FALSE = untrusted header / trust env off — legacy
 *   behavior, self-hosters see no change.
 *   identity null + trusted TRUE  = the verified GitHub user is NOT a member
 *   of THIS project — the honest VIEWER state: they can look but never act,
 *   and must never inherit another member's identity (least of all the
 *   project's default human).
 *
 * Like vanilla's _mePromise, the fetch is single-flighted per cid for the
 * page's lifetime — /api/me also runs the server-side first-sign-in binding
 * rule, which is idempotent, so one ask is enough.
 */
import type { AccountMenuItem, Identity } from "../extensions";
import { actingHuman } from "../state/SnapshotProvider";
import type { Snapshot } from "../types";

/* ---- wire shapes -------------------------------------------------------- */
// The wire identity is the seam's Identity plus the viewer's own grants set
// (mig 039: /api/me carries it so affordance gating needs no extra call).
export interface CloudIdentity extends Identity {
  grants?: string[] | null;
}
export interface Me {
  identity: CloudIdentity | null;
  trusted: boolean;
}

/* ---- GET /api/me, single-flighted per cid ------------------------------- */
let _cache: { cid: string; promise: Promise<Me> } | null = null;
let _last: Me | null = null; // last resolved envelope (accountMenu reads trusted)

export function fetchMe(cid: string | null): Promise<Me> {
  if (!cid) return Promise.resolve({ identity: null, trusted: false });
  if (!_cache || _cache.cid !== cid) {
    const promise = fetch("/api/me?cid=" + encodeURIComponent(cid))
      .then(async (r) => {
        if (!r.ok) return { identity: null, trusted: false }; // 401/404 fail open
        const d = (await r.json()) as { identity?: CloudIdentity | null; trusted?: boolean } | null;
        return { identity: (d && d.identity) || null, trusted: !!(d && d.trusted) };
      })
      .catch((): Me => ({ identity: null, trusted: false }))
      .then((me) => {
        _last = me;
        return me;
      });
    _cache = { cid, promise };
  }
  return _cache.promise;
}

// The Extensions.identity seam: just the resolved identity (the trusted flag
// stays a cloud-internal detail, consulted via the cached envelope).
export function fetchIdentity(cid: string | null): Promise<Identity | null> {
  return fetchMe(cid).then((me) => me.identity);
}

// Test/page-teardown hook: drop the single-flight cache so a fresh mount
// re-asks (mirrors the vanilla "once per page load" scope).
export function resetIdentity(): void {
  _cache = null;
  _last = null;
}

/* ---- acting-identity accessors (app-data.js parity) ---------------------- *
 * All take the resolved Me + the snapshot explicitly (React style — no D.*
 * global). Semantics are line-for-line the vanilla accessors.               */
type Snap = Snapshot | null;
export interface ActingHumanRec {
  id: string;
  alias: string;
  member_role?: string | null;
}

// The snapshot human the identity binds to (app-data.js identityHuman).
export function identityHuman(me: Me | null, snap: Snap): ActingHumanRec | null {
  const id = me?.identity;
  if (!id || !id.agent_id) return null;
  const h = (snap?.agents ?? []).find(
    (a) => a.kind === "human" && String(a.id) === String(id.agent_id),
  );
  return h ? (h as unknown as ActingHumanRec) : null;
}

// The real human authority (app-data.js actingHuman): with the TRUSTED proxy
// lane live, the resolved member (or nothing) is the ONLY possible actor — a
// signed-in non-member must never fall through to the local/default human.
// Trust off keeps the pre-collab pick (persisted acting human / first human).
export function memActor(me: Me | null, snap: Snap): ActingHumanRec | null {
  if (me?.trusted) return identityHuman(me, snap);
  const bound = identityHuman(me, snap);
  if (bound) return bound;
  const h = actingHuman(snap);
  return h ? (h as unknown as ActingHumanRec) : null;
}

// Owner check for owner-gated affordances (app-data.js actingOwner): with an
// identity its member_role decides; without one (trust off) the acting human's
// snapshot member_role decides — permissive when the field is absent (old
// snapshot in flight), mirroring the backend's trust-off fallback.
export function actingOwner(me: Me | null, snap: Snap): boolean {
  const id = me?.identity;
  if (id) return id.member_role === "owner";
  const h = memActor(me, snap);
  return !!(h && (h.member_role === "owner" || h.member_role == null));
}

// Access model (mig 039, app-data.js actingGrant): does the acting identity
// hold a permission grant? Owners implicitly hold everything; members need it
// in their grants list. The server stays the enforcer — this only gates
// AFFORDANCES.
export function actingGrant(me: Me | null, snap: Snap, grant: string): boolean {
  const id = me?.identity;
  if (id) {
    if (id.member_role === "owner") return true;
    return (id.grants || []).indexOf(grant) >= 0;
  }
  return actingOwner(me, snap);
}

// The read-only states (app-data.js viewerOnly / viewerRole / actingReadOnly).
export function viewerOnly(me: Me | null): boolean {
  return !!(me?.trusted && !me.identity);
}
export function viewerRole(me: Me | null): boolean {
  return !!(me?.identity && me.identity.member_role === "viewer");
}
export function actingReadOnly(me: Me | null): boolean {
  return viewerOnly(me) || viewerRole(me);
}

/* ---- the account menu (app-shell.js actingMenuHtml parity) ---------------- *
 * The portal sits behind oauth2-proxy; GET /oauth2/sign_out clears the proxy
 * session (Caddy proxies the path) and rd= sends the signed-out user to the
 * public landing page. Full <a href> navigation on purpose — no fetch, the
 * proxy owns the redirect. The vanilla menu's head (login + "role · GitHub",
 * or "Not a member · viewing only") is rendered by the shell from the Identity
 * object itself; the one actionable row is Sign out (danger-styled on hover:
 * shell.css .pm-row.signout).                                                */
export const SIGN_OUT_HREF = "/oauth2/sign_out?rd=%2Fwelcome";

export function accountMenu(identity: Identity | null): AccountMenuItem[] {
  const signOut: AccountMenuItem = { label: "Sign out", href: SIGN_OUT_HREF, danger: true };
  if (identity && identity.github_login) return [signOut];
  // Viewer (trusted sign-in, non-member): there is still a proxy session to
  // clear — sign out must stay reachable (vanilla wireActingChip).
  if (!identity && _last?.trusted) return [signOut];
  // Self-host / trust off: no proxy session — no menu, the chip stays
  // informational exactly as before collab.
  return [];
}
