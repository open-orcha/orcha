/**
 * Members — React port of the cloud settings-members module
 * (static/modules/settings-members.js + the settings.html Members card).
 *
 * In the vanilla portal this was a Settings-page section; the open React base
 * has no Settings section-extension point yet, so it ships as its own page at
 * /members (registered in src/extensions.ts). Markup/class names mirror the
 * vanilla card so the cloud CSS styles it identically.
 *
 * Wire contract (backend UNCHANGED — portal_backend/member_routes.py):
 *   GET    /api/containers/{cid}/members -> {members:[{agent_id, alias,
 *          github_login, member_role, grants, pending}], restricted:bool}
 *   POST   .../members {github_login, role, actor_agent_id}      (owner-or-manage_members)
 *   PATCH  .../members/{aid} {role, actor_agent_id}              (owner-or-manage_members;
 *          to/from owner stays owner-only)
 *   PATCH  .../members/{aid} {grants:[...], actor_agent_id}      (owner-only)
 *   DELETE .../members/{aid} {actor_agent_id}                    (owner-or-manage_members;
 *          removing an owner stays owner-only)
 *
 * The acting identity comes from GET /api/me?cid=… (identity_routes.py) exactly
 * as data.js resolved it; management affordances key off actingGrant("manage_members"),
 * the owner-only extras (role→owner, the Permissions expander, owner removal) off
 * actingOwner(). ROSTER PRIVACY: a non-manage_members member receives ONLY their
 * own row plus restricted:true — the card renders their membership + a note.
 * The LAST owner's row never offers demote/remove (the backend 400s both).
 * actor_agent_id rides every mutation as the trust-off fallback actor; with a
 * trusted proxy identity the server resolves the actor from the header instead.
 *
 * PLAN GATING (Orcha Cloud local run addendum — docs/orcha-cloud-local-run.md):
 * local run is the free solo tier. Under solo, this page renders PremiumGate
 * INSTEAD of the roster+invite UI (GET /api/plan, src/cloud/shared/plan.ts);
 * the nav entry to /members stays visible (entry point = visible), and every
 * mutation route 402s server-side regardless of what the client believes
 * (member_routes.py's require_feature("members") first check) — a 402
 * arriving from any mutation swaps straight to the gate as a belt-and-braces
 * fallback. GET (roster) stays open on both plans.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Icon, Modal, useToast } from "../../components/ui";
import { Avatar, Button, Chip, IconButton, Menu, Popover, Tooltip } from "../../components/primitives";
import { HelpTip, StatusLine } from "../../pages/settings/settingsUi";
import { useSnapshot } from "../../state/SnapshotProvider";
import {
  actingGrant, actingOwner, fetchMe, memActor, viewerRole, type ActingHumanRec, type Me,
} from "../identity";
import { PremiumGate } from "../shared/PremiumGate";
import { usePlan } from "../shared/plan";
import "../settings/settings-cards.css";
import "./members.css";

/* ---- wire shapes -------------------------------------------------------- */
export interface Member {
  agent_id: string;
  alias: string;
  github_login: string | null;
  member_role: string; // owner | member | viewer
  grants: string[] | null;
  pending: boolean;
}

// The grantable permissions (mirror identity_routes.GRANTS) + human labels.
const MEM_GRANTS: [string, string][] = [
  ["manage_keys", "API keys & model settings"],
  ["manage_members", "Members — invite, remove, see the roster"],
  ["manage_repo", "GitHub repo binding"],
  ["manage_autonomy", "Autonomy, notifier & wake switches"],
  ["manage_agents", "Agents — create, edit, retire"],
  ["assign_reviewers", "Assign task reviewers"],
];

const ROLE_LABEL: Record<string, string> = { owner: "Owner", member: "Member", viewer: "Viewer" };
export function roleLabel(r: string): string { return ROLE_LABEL[r] || r; }
export function grantLabel(g: string): string {
  const hit = MEM_GRANTS.find(([k]) => k === g);
  return hit ? hit[1] : g;
}

/* ---- raw fetch with status passthrough (vanilla memApi parity: the 409
 * invite path and detail surfacing depend on reading status + body). Also
 * carries the plan-gating 402 detail shape ({premium, message, upgrade_url})
 * — portal_backend/plan_routes.require_feature's HTTPException(402, …) body,
 * which member_routes.py raises as the FIRST check on every mutation. ----- */
interface Premium402 { premium?: string; message?: string; upgrade_url?: string }
interface MemRes { ok: boolean; status: number; body: ({ detail?: string | Premium402 } & Record<string, unknown>) | null }
async function memApi(method: string, path: string, body?: unknown): Promise<MemRes> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    const r = await fetch(path, init);
    let j: MemRes["body"] = null;
    try { j = (await r.json()) as MemRes["body"]; } catch { /* empty body */ }
    return { ok: r.ok, status: r.status, body: j };
  } catch { return { ok: false, status: 0, body: null }; }
}

// Belt-and-braces: true when a mutation response is the plan-gating 402
// shape (server truth wins even if the client believed it was on team —
// e.g. a stale plan fetch, or ORCHA_PLAN flipped mid-session).
function isPremium402(res: MemRes): boolean {
  const d = res.body?.detail;
  return res.status === 402 && !!d && typeof d === "object" && "premium" in d;
}

/** GitHub's username rule — the same pattern the backend's MemberCreate validates. */
export const GH_LOGIN_RE = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;

/**
 * A member mutation's failure as plain words (pure, tested) — never a bare
 * status code and never "[object Object]": a string detail as is; FastAPI's
 * 422 array (a github_login pattern miss reads as an invalid username, any
 * other entry by its .msg); an object detail by its .message; no answer at
 * all is "Couldn't reach the server."
 */
export function memErrText(res: { status: number; body: { detail?: unknown } | null }): string {
  const d = res.body ? res.body.detail : undefined;
  if (typeof d === "string" && d.trim()) return d.trim();
  if (Array.isArray(d)) {
    const items = d.filter((x) => x && typeof x === "object") as { type?: unknown; loc?: unknown; msg?: unknown }[];
    if (items.some((x) => x.type === "string_pattern_mismatch" && Array.isArray(x.loc) && x.loc.indexOf("github_login") >= 0)) {
      return "That isn't a valid GitHub username.";
    }
    const msgs = items.map((x) => (typeof x.msg === "string" ? x.msg : "")).filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  }
  if (d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string") {
    return (d as { message: string }).message;
  }
  if (!res.status) return "Couldn't reach the server.";
  if (res.status >= 500) return "Embodent hit an error — try again.";
  return "The server refused the change.";
}

function memUrl(cid: string, suffix = ""): string {
  return "/api/containers/" + encodeURIComponent(cid) + "/members" + suffix;
}

// The feature pitch shown on the paywall (contract item 7: invite teammates,
// roles, granular grants, GitHub-verified identity).
const MEMBERS_PITCH = [
  "Invite teammates by GitHub username",
  "Roles: owner, member, viewer",
  "Granular per-member permission grants",
  "GitHub-verified identity for every collaborator",
];

/* ---- faces: the shared D7 Avatar (round; the github.com/<login>.png image
 * over the deterministic initial, which stays when the image fails). The
 * name is printed right beside it, so the avatar is decorative. ----------- */
function MemberFace({ m }: { m: Member }) {
  return <Avatar alias={m.github_login || m.alias} ghLogin={m.github_login} kind="human" size={24} decorative className="mem-av" />;
}

/** Tooltip on a member's name: GitHub login and Orcha alias, each once. */
export function identityTip(m: Pick<Member, "github_login" | "alias">): string {
  if (m.github_login && m.github_login !== m.alias) return "@" + m.github_login + " · alias " + m.alias;
  return m.github_login ? "@" + m.github_login : m.alias;
}

/** Role / state chips (D8: rounded-full, 1px border, small dot). */
function RoleChip({ role }: { role: string }) {
  return <Chip size="sm" dot={role === "owner" ? "accent" : "neutral"} className={"tag role-" + role}>{roleLabel(role)}</Chip>;
}
function PendingChip() {
  return <Chip size="sm" dot="info" className="tag mem-pending" title="Invited — pending until they first sign in">pending</Chip>;
}

/**
 * RoleMenu — the Linear ghost dropdown for a role (text + chevron, no box
 * until hover), replacing the native <select> and its OS caret. The Menu
 * primitive gives roving focus, Esc-to-close + focus return, and marks the
 * current role with a trailing check (menuitemradio + aria-checked).
 */
export function RoleMenu({ value, roles, onPick, label, id, className, disabled }: {
  value: string; roles: string[]; onPick: (role: string) => void; label: string; id?: string; className?: string; disabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        id={id}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label + ": " + roleLabel(value)}
        data-role={value}
        disabled={disabled}
        className={"v2-btn v2-btn-ghost v2-btn-sm v2-menubtn mem-role-sel mem-role-btn" + (className ? " " + className : "")}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="v2-btn-label">{roleLabel(value)}</span>
        <Icon name="chev" cls="v2-ico v2-btn-ico v2-btn-ico-r" />
      </button>
      <Menu
        anchor={ref}
        open={open}
        onClose={() => setOpen(false)}
        label={label}
        placement="bottom-start"
        items={roles.map((r) => ({
          label: roleLabel(r),
          checked: r === value,
          onSelect: () => { if (r !== value) onPick(r); },
        }))}
      />
    </>
  );
}

/** Grants that change anything for a role: a viewer stays read-only whatever
 *  it holds (every write refuses the role), so only the roster-visibility
 *  grant (manage_members, honoured on reads — identity_routes.has_grant) has
 *  an effect for them. Members get the whole list. */
export function grantsForRole(role: string): [string, string][] {
  return role === "viewer" ? MEM_GRANTS.filter(([g]) => g === "manage_members") : MEM_GRANTS;
}

/**
 * PermsButton — ONE control for a member's extra grants (D12: the count lives
 * in the button, never a separate "+N permissions" chip beside it). It opens a
 * compact Popover checklist with Save / Cancel instead of an inline block.
 */
export function PermsButton({ name, role, grants, busy, onSave }: {
  name: string; role: string; grants: string[]; busy: boolean; onSave: (next: string[]) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(grants);
  const toggle = () => { if (!open) setDraft(grants); setOpen((o) => !o); };
  const options = grantsForRole(role);
  const close = () => setOpen(false);
  const dirty = draft.length !== grants.length || draft.some((g) => grants.indexOf(g) < 0);
  const n = grants.length;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="v2-btn v2-btn-ghost v2-btn-sm mem-perm-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={"Permissions for " + name + (n ? ": " + n + " extra" : ": none extra")}
        title={n ? grants.map(grantLabel).join(", ") : "Granular permissions"}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={toggle}
      >
        <span className="v2-btn-label">Permissions{n ? <span className="mem-perm-n"> · {n}</span> : null}</span>
        <Icon name="chev" cls="v2-ico v2-btn-ico v2-btn-ico-r" />
      </button>
      <Popover anchor={ref} open={open} onClose={close} role="dialog" label={"Permissions for " + name} placement="bottom-end" className="mem-perms-pop" trap>
        <div className="mem-perms">
          {role === "viewer" ? (
            <div className="mem-perms-h">
              Viewers are read-only
              <HelpTip label="permissions">A viewer can never change anything, so only seeing the full roster applies. Make them a member to grant the rest.</HelpTip>
            </div>
          ) : (
            <div className="mem-perms-h">
              Extra permissions on top of {role}
              <HelpTip label="permissions">Viewers stay read-only regardless — only the roster grant affects them.</HelpTip>
            </div>
          )}
          {options.map(([g, label]) => (
            <label className="mem-grant" key={g}>
              <input
                type="checkbox"
                className="v2-checkbox"
                checked={draft.indexOf(g) >= 0}
                onChange={() => setDraft((cur) => (cur.indexOf(g) >= 0 ? cur.filter((x) => x !== g) : [...cur, g]))}
              />
              <span>{label}</span>
            </label>
          ))}
          <div className="mem-perms-acts">
            <Button size="sm" variant="ghost" onClick={() => { close(); ref.current?.focus(); }}>Cancel</Button>
            <Button
              size="sm" variant={dirty ? "primary" : "secondary"} disabled={!dirty || busy}
              onClick={() => { onSave(draft); close(); ref.current?.focus(); }}
            >
              Save
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}

/* ---- acting identity: the shared cloud /api/me layer (src/cloud/identity.ts
 * — fetchMe + memActor/actingOwner/actingGrant/viewerRole) gates every
 * affordance below, exactly as the local copies here did before the module
 * was extracted for the extensions.ts identity/accountMenu seams. ---------- */

/* ---- the members card ---------------------------------------------------- */
interface RowCtx { canManage: boolean; isOwner: boolean; meId: string | null; ownerCount: number }

/**
 * Why a row's Remove is unavailable, or null when it may be offered (pure,
 * tested). Authority (brief §3): you can never remove your own access from
 * here, and the LAST owner can never be removed (the backend 400s it).
 */
export function removeBlockedReason(m: Pick<Member, "agent_id" | "member_role">, ctx: Pick<RowCtx, "meId" | "ownerCount">): string | null {
  if (ctx.meId != null && String(ctx.meId) === String(m.agent_id)) return "You can't remove yourself";
  if (m.member_role === "owner" && ctx.ownerCount <= 1) return "A project needs at least one owner";
  return null;
}

function MembersCard() {
  const { snap, cid } = useSnapshot();
  const toast = useToast();
  const plan = usePlan();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [restricted, setRestricted] = useState(false);
  // "forbidden": the server said you're not a member (403) — Retry can't help (S1)
  const [err, setErr] = useState<false | "error" | "forbidden">(false);
  const [busy, setBusy] = useState(false);
  const [inviteLogin, setInviteLogin] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [removing, setRemoving] = useState<Member | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  // Belt-and-braces (contract item 7): a 402 with the plan-gating detail shape
  // arriving from ANY mutation swaps straight to the gate, even if `plan`
  // believed we were on team (stale fetch, or ORCHA_PLAN flipped mid-session
  // on the server) — the server's answer always wins over the client's guess.
  const [forcedGate, setForcedGate] = useState<{ upgradeUrl: string } | null>(null);

  // Collab v1: resolve the acting identity once per page load — the shared
  // single-flighted fetchMe (src/cloud/identity.ts, vanilla data.js parity).
  // Failures resolve to {identity:null, trusted:false} — the self-host state,
  // where the local acting human gates affordances.
  useEffect(() => {
    if (!cid) return;
    let alive = true;
    void fetchMe(cid).then((m) => { if (alive) setMe(m); });
    return () => { alive = false; };
  }, [cid]);

  const load = useCallback(async () => {
    if (!cid) return;
    setErr(false);
    const res = await memApi("GET", memUrl(cid));
    const body = res.body as { members?: Member[]; restricted?: boolean } | null;
    if (res.ok && body && Array.isArray(body.members)) {
      setMembers(body.members);
      setRestricted(!!body.restricted);
    } else {
      setMembers(null);
      setRestricted(false);
      setErr(res.status === 403 ? "forbidden" : "error");
    }
  }, [cid]);

  useEffect(() => { void load(); }, [load]);

  const actor = () => memActor(me, snap);
  const requireActor = (): ActingHumanRec | null => {
    const h = actor();
    if (!h) toast("Pick an acting human first.", "warn");
    return h;
  };

  // Belt-and-braces (contract item 7): a 402 from ANY mutation means the
  // server disagrees with what we rendered — swap to the gate immediately
  // rather than surfacing a confusing generic error toast. Returns true when
  // it handled the response (caller should stop).
  const catchPremium402 = (res: MemRes): boolean => {
    if (!isPremium402(res)) return false;
    const d = res.body?.detail as Premium402;
    setForcedGate({ upgradeUrl: d.upgrade_url || "https://orcha.quantallabs.ai" });
    return true;
  };

  /* ---- mutations (server re-validates every gate) ----------------------- */
  const doInvite = async () => {
    const login = inviteLogin.trim();
    if (!login || busy || !cid || !GH_LOGIN_RE.test(login)) return;
    const h = requireActor();
    if (!h) return;
    setBusy(true);
    const res = await memApi("POST", memUrl(cid), {
      github_login: login,
      role: inviteRole || "member",
      actor_agent_id: h.id,
    });
    setBusy(false);
    if (catchPremium402(res)) return;
    if (res.ok) {
      toast("Invited " + login + " — pending until they first sign in.", "ok");
      setInviteLogin("");
      void load();
    } else if (res.status === 409) {
      toast(login + " is already a member.", "warn");
    } else {
      toast("Couldn't invite " + login + ": " + memErrText(res), "danger");
    }
  };

  const doRole = async (aid: string, to: string) => {
    if (busy || !cid) return;
    const h = requireActor();
    if (!h) return;
    setBusy(true);
    const res = await memApi("PATCH", memUrl(cid, "/" + encodeURIComponent(aid)), {
      role: to, actor_agent_id: h.id,
    });
    setBusy(false);
    if (catchPremium402(res)) return;
    if (res.ok) { toast("Role updated — " + roleLabel(to) + ".", "ok"); void load(); }
    else {
      toast("Couldn't change the role: " + memErrText(res), "danger");
      void load(); // reset the role menu to the server truth
    }
  };

  const doGrants = async (aid: string, grants: string[]) => {
    if (busy || !cid) return;
    const h = requireActor();
    if (!h) return;
    setBusy(true);
    const res = await memApi("PATCH", memUrl(cid, "/" + encodeURIComponent(aid)), {
      grants: grants, actor_agent_id: h.id,
    });
    setBusy(false);
    if (catchPremium402(res)) return;
    if (res.ok) { toast("Permissions saved.", "ok"); void load(); }
    else toast("Couldn't save permissions: " + memErrText(res), "danger");
  };

  const doRemove = async (m: Member) => {
    if (busy || !cid) return;
    const h = requireActor();
    if (!h) return;
    const name = m.github_login || m.alias;
    setBusy(true);
    const res = await memApi("DELETE", memUrl(cid, "/" + encodeURIComponent(m.agent_id)), {
      actor_agent_id: h.id,
    });
    setBusy(false);
    if (catchPremium402(res)) return;
    if (res.ok) { toast("Removed " + name + ".", "ok"); void load(); }
    else toast("Couldn't remove " + name + ": " + memErrText(res), "danger");
  };

  /* ---- render ----------------------------------------------------------- */
  // Belt-and-braces: a 402 from a mutation trumps everything else — the
  // server just told us, authoritatively, that this plan can't do this.
  if (forcedGate) {
    return <PremiumGate feature="members" title="Members" hideTitle pitch={MEMBERS_PITCH} upgradeUrl={forcedGate.upgradeUrl} />;
  }
  // Plan gating (contract item 7): solo renders the paywall INSTEAD of the
  // roster+invite UI — invite/role/grant affordances never render. `plan ===
  // null` is the brief in-flight window before usePlan() resolves; we hold
  // rendering (a beat of blank card body) rather than flash the real roster
  // and then yank it away, or flash the gate for a paying team customer.
  if (plan && plan.plan === "solo") {
    return <PremiumGate feature="members" title="Members" hideTitle pitch={MEMBERS_PITCH} upgradeUrl={plan.upgrade_url} />;
  }
  if (err === "forbidden") {
    return <StatusLine tone="warn" id="memForbidden">You&#39;re not a member of this project.</StatusLine>;
  }
  if (err) {
    return (
      <StatusLine
        tone="err"
        action={<Button size="sm" variant="ghost" icon="refresh" id="memRetry" onClick={() => void load()}>Retry</Button>}
      >
        Couldn&#39;t load members.
      </StatusLine>
    );
  }
  if (!members || !plan) return <StatusLine tone="muted">Loading members…</StatusLine>;

  // Roster privacy: the server sent only your own membership — render it as a
  // card plus the explanation (no invite bar, no roster, no controls).
  if (restricted) {
    const m = members[0];
    if (!m) return <p className="set-note">No membership found.</p>;
    return (
      <>
        <div className="mem-list">
          <div className="mem-row">
            <MemberFace m={m} />
            <div className="mem-who">
              <div className="mem-name">
                <span className="mem-name-t" title={identityTip(m)}>{m.github_login || m.alias}</span>
                <span className="mem-you">you</span>
              </div>
            </div>
            <span className="mem-meta">
              {m.pending && <PendingChip />}
              <RoleChip role={m.member_role} />
            </span>
          </div>
        </div>
        <div className="sc-hint mem-restricted">
          Your membership on this project. The full member list is visible to owners and to
          members with the members permission.
        </div>
      </>
    );
  }

  const isOwner = actingOwner(me, snap);
  // `busy` is NOT part of the authority: an in-flight mutation disables the
  // controls in place (aria-busy) instead of collapsing the card (MEM-BUSY).
  const canManage = !viewerRole(me) && (isOwner || actingGrant(me, snap, "manage_members"));
  const ctx: RowCtx = {
    canManage,
    isOwner,
    meId: me?.identity?.agent_id ?? null,
    ownerCount: members.filter((m) => m.member_role === "owner").length,
  };
  const inviteTrim = inviteLogin.trim();
  const inviteBad = !!inviteTrim && !GH_LOGIN_RE.test(inviteTrim);
  const inviteOk = !!inviteTrim && !inviteBad;
  const inviteHint = !inviteTrim ? "Type a GitHub username first" : inviteBad ? "That isn't a valid GitHub username" : "";
  // A read-only viewer (or a member without the Members permission) sees why
  // nothing is editable instead of controls silently missing.
  const readOnlyNote = !canManage
    ? viewerRole(me)
      ? "You\u2019re a viewer — only owners and members with the Members permission can manage access."
      : "Only owners and members with the Members permission can invite people or change roles."
    : null;

  return (
    <>
      {readOnlyNote && <p className="set-note mem-readonly" id="memReadOnly">{readOnlyNote}</p>}
      <div className="mem-cols" aria-hidden="true">
        <span className="mem-col-name">Member</span>
        <span className="mem-col-count">{members.length} {members.length === 1 ? "person" : "people"}</span>
        {canManage ? <span className="mem-col-role">Role</span> : null}
        {canManage && isOwner ? <span className="mem-col-perms">Permissions</span> : null}
        {canManage ? <span className="mem-col-x" /> : null}
      </div>
      <div className="mem-list" role="list" aria-label="Project members">
        {members.length ? members.map((m) => {
          const login = m.github_login;
          const name = login || m.alias;
          const grants = m.grants || [];
          const you = ctx.meId && String(ctx.meId) === String(m.agent_id);
          // NEVER offer demote/remove on the LAST owner's row (the backend 400s
          // both); owner rows are only manageable by another OWNER (server
          // carve-out mirrored).
          const lastOwner = m.member_role === "owner" && ctx.ownerCount <= 1;
          const rowManageable = ctx.canManage && !lastOwner && (m.member_role !== "owner" || ctx.isOwner);
          const canPerms = rowManageable && ctx.isOwner && m.member_role !== "owner";
          const removeBlocked = removeBlockedReason(m, ctx);
          // the grant count shows once: inside the Permissions button when you
          // can edit it, else as this read-only chip
          const grantChip = !canPerms && grants.length > 0 && m.member_role !== "owner" ? (
            <Chip size="sm" className="tag mem-grants" title={grants.map(grantLabel).join(", ")}>
              +{grants.length} {grants.length === 1 ? "permission" : "permissions"}
            </Chip>
          ) : null;
          return (
            <div key={m.agent_id} role="listitem" className="mem-item">
              <div className="mem-row">
                <MemberFace m={m} />
                <div className="mem-who">
                  <div className="mem-name">
                    <span className="mem-name-t" title={identityTip(m)}>{name}</span>
                    {you && <span className="mem-you">you</span>}
                  </div>
                  {/* ONE name per row (D12): the GitHub login; the Orcha
                      alias lives in the name's tooltip, never a second
                      truncated label beside it */}
                </div>
                <span className="mem-meta">
                  {m.pending && <PendingChip />}
                  {/* read-only card: the facts sit together at the row's end */}
                  {!ctx.canManage && grantChip}
                  {!ctx.canManage && <RoleChip role={m.member_role} />}
                </span>
                {ctx.canManage && <span className="mem-break" aria-hidden="true" />}
                {ctx.canManage && (
                  /* MEM-V1: when the card is editable EVERY row uses the same
                     grid (role · permissions · remove), so a row you can't edit
                     shows its role chip IN the Role column, never beside the name */
                  <span className="mem-acts" aria-busy={busy || undefined}>
                    {rowManageable ? (
                      /* Promoting TO owner (and touching an owner row at all) is
                         owner-only server-side, so the option only renders where
                         the actor could succeed. */
                      <RoleMenu
                        className="is-compact is-ghost"
                        label={"Project role for " + name}
                        value={m.member_role}
                        roles={ctx.isOwner ? ["owner", "member", "viewer"] : ["member", "viewer"]}
                        onPick={(r) => void doRole(m.agent_id, r)}
                        disabled={busy}
                      />
                    ) : (
                      <span className="mem-role-slot"><RoleChip role={m.member_role} /></span>
                    )}
                    {/* fixed slot so every row's controls line up (owners only —
                        the Permissions column exists only for them) */}
                    {ctx.isOwner && (
                      <span className="mem-perm-slot">
                        {canPerms ? (
                          <PermsButton
                            name={name} role={m.member_role} grants={grants} busy={busy}
                            onSave={(next) => void doGrants(m.agent_id, next)}
                          />
                        ) : grantChip}
                      </span>
                    )}
                    {!ctx.isOwner && grantChip}
                    <span className="mem-x-slot">
                      {!rowManageable ? null : removeBlocked ? (
                        /* never an enabled Remove on your own row (or the last
                           owner's); the reason is the tooltip */
                        <Tooltip label={removeBlocked} placement="left">
                          <IconButton
                            icon="x" size="sm" className="mem-remove is-blocked" label={"Remove access for " + name}
                            title="" aria-disabled="true" data-remove-blocked=""
                            onClick={(e) => e.preventDefault()}
                          />
                        </Tooltip>
                      ) : (
                        <IconButton
                          icon="x" size="sm" className="mem-remove" label={"Remove access for " + name} title="Remove access"
                          disabled={busy}
                          onClick={() => setRemoving(m)}
                        />
                      )}
                    </span>
                  </span>
                )}
              </div>
            </div>
          );
        }) : <p className="set-note">No human members yet.</p>}
      </div>
      {canManage && (
        <>
          <div className="mem-invite">
            <input
              id="memLogin"
              className="sc-inp"
              aria-label="GitHub username to invite"
              aria-invalid={inviteBad || undefined}
              aria-describedby={inviteBad ? "memLoginHint" : undefined}
              spellCheck={false}
              autoComplete="off"
              placeholder="GitHub username to invite…"
              maxLength={39}
              value={inviteLogin}
              onChange={(e) => setInviteLogin(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void doInvite(); }}
            />
            <RoleMenu
              id="memRole"
              className="is-ghost"
              label="Role for the invite"
              value={inviteRole}
              roles={isOwner ? ["member", "viewer", "owner"] : ["member", "viewer"]}
              onPick={setInviteRole}
              disabled={busy}
            />
            <Button
              size="sm" variant={inviteOk ? "primary" : "secondary"} icon="plus" id="memInvite"
              disabled={!inviteOk || busy}
              busy={busy}
              title={inviteHint || undefined}
              onClick={() => void doInvite()}
            >
              Invite
            </Button>
          </div>
          {inviteBad && (
            <div className="sc-hint mem-hint mem-login-bad" id="memLoginHint" role="status">
              GitHub usernames use letters, numbers and single hyphens (up to 39 characters).
            </div>
          )}
          <div className="sc-hint mem-hint">
            Invites stay <b>pending</b> until they first sign in.
            <HelpTip label="invites">
              The cloud front door (perimeter allowlist) follows this roster — a background sync applies invites and removals within a couple of minutes.
            </HelpTip>
          </div>
        </>
      )}
      {removing && (
        <Modal
          title={"Remove access for " + (removing.github_login || removing.alias) + "?"}
          desc="They lose access to this workspace: the member mapping is retired (their history and messages are kept), any task naming them as reviewer reverts to anyone, and the cloud front door drops them on the next allowlist sync."
          danger
          primary="Remove access"
          onPrimary={() => { const m = removing; setRemoving(null); void doRemove(m); }}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}

/* ---- the settings section (vanilla settings.html Members card, verbatim
 * title + lead) — registered on Extensions.settingsSections so Members lives
 * as a Settings tab exactly where the vanilla page kept it (Collaboration).
 * Carries its own <style> so the card renders identically here and on the
 * standalone /members page (identical rules are idempotent when doubled). -- */
export function MembersSection() {
  // The surrounding page / settings section supplies the one title + one
  // description; this group is just the roster (no repeated "Members" h2).
  return (
    <div className="card set-card mem-card">
      <div className="card-b is-flush">
        <div id="membersCard">
          <MembersCard />
        </div>
      </div>
    </div>
  );
}

/* ---- /members: ONE home for the roster ------------------------------------
 * The standalone page duplicated Settings › Members & access one to one
 * (review r1). The route stays (old links, bookmarks, the palette) and
 * redirects — keeping ?cid and any other query — to the Settings section,
 * which renders this same MembersSection (roster, invites, roles, grants,
 * removal, plan gate). Nothing is dropped; only the duplicate page is. */
export function membersRedirectTarget(search: string): string {
  return "/settings" + (search || "") + "#tab=members";
}
export function MembersPage() {
  const { search } = useLocation();
  return <Navigate to={membersRedirectTarget(search)} replace />;
}
