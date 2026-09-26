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
import { useCallback, useEffect, useState } from "react";
import { Avatar, Icon, Modal, useToast } from "../../components/ui";
import { hue } from "../../lib/format";
import { Shell } from "../../shell/Shell";
import { useSnapshot } from "../../state/SnapshotProvider";
import {
  actingGrant, actingOwner, fetchMe, memActor, viewerRole, type ActingHumanRec, type Me,
} from "../identity";
import { PremiumGate } from "../shared/PremiumGate";
import { usePlan } from "../shared/plan";

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

/* ---- faces (app-ui.js ghAvatar/face parity) ------------------------------ */
// GitHub member avatar: the github.com/<login>.png image over the deterministic
// letter tile (which stays visible when the img errors out). Circular via .av.human.
function GhAvatar({ login, size }: { login: string; size?: string }) {
  const h = hue(login);
  const grad = `linear-gradient(140deg, hsl(${h} 70% 62%), hsl(${(h + 38) % 360} 72% 54%))`;
  const cls = "av gh" + (size ? " " + size : "") + " human";
  const init = (login || "?").trim().charAt(0).toUpperCase();
  return (
    <span className={cls} style={{ background: grad }}>
      {init}
      <img
        className="gh-face"
        src={`https://github.com/${encodeURIComponent(login)}.png?size=96`}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => e.currentTarget.remove()}
      />
    </span>
  );
}
function MemberFace({ m }: { m: Member }) {
  return m.github_login ? <GhAvatar login={m.github_login} /> : <Avatar alias={m.alias} kind="human" />;
}

/* ---- acting identity: the shared cloud /api/me layer (src/cloud/identity.ts
 * — fetchMe + memActor/actingOwner/actingGrant/viewerRole) gates every
 * affordance below, exactly as the local copies here did before the module
 * was extracted for the extensions.ts identity/accountMenu seams. ---------- */

/* ---- page-scoped CSS: the settings-card + members rules the vanilla page
 * pulled from pages/settings.css, carried over verbatim so the standalone
 * /members page styles identically without that stylesheet. ---------------- */
const MEMBERS_CSS = `
  .set-wrap { max-width: 760px; }
  .set-intro { margin: 2px 2px 20px; }
  .set-intro h1 { font-size: 20px; font-weight: 740; letter-spacing: -.02em; }
  .set-intro p { color: var(--muted); font-size: 13px; margin-top: 5px; line-height: 1.55; max-width: 64ch; }
  .set-card .card-b { padding: 18px 20px; }
  .set-card .lead { color: var(--muted); font-size: 12.5px; line-height: 1.55; margin: -2px 0 16px; }

  .sc-banner { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; border-radius: 12px;
    border: 1px solid var(--border); background: var(--surface-2); margin-bottom: 16px; }
  .sc-banner .bt { display: flex; align-items: center; gap: 9px; font-size: 13px; line-height: 1.45; }
  .sc-banner .bt svg { width: 17px; height: 17px; flex: none; }
  .sc-banner.warn { background: var(--warn-soft); border-color: var(--warn-line); }
  .sc-banner.warn .bt svg { color: var(--warn); }
  .sc-inp { flex: 1; min-width: 0; background: var(--surface-2); border: 1px solid var(--border-2); border-radius: 10px;
    color: var(--text); font: 13px "JetBrains Mono", ui-monospace, monospace; padding: 10px 12px; outline: none; }
  .sc-inp::placeholder { color: var(--faint); font-family: Inter, system-ui, sans-serif; }
  .sc-inp:focus { border-color: var(--accent-line); box-shadow: var(--ring); }
  .sc-hint { font-size: 11.5px; color: var(--faint); min-height: 16px; margin: 7px 2px 0; line-height: 1.4; }

  /* collab v1: Members card — avatar + login rows, role/pending chips, invite bar */
  .mem-list { display: flex; flex-direction: column; }
  .mem-row { display: flex; align-items: center; gap: 11px; padding: 10px 2px; }
  .mem-row + .mem-row { border-top: 1px solid var(--border); }
  .mem-name { font-size: 13.5px; font-weight: 640; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; display: flex; align-items: center; gap: 7px; }
  .mem-you { color: var(--faint); font-size: 10.5px; letter-spacing: .06em;
    text-transform: uppercase; font-weight: 650; }
  .mem-sub { color: var(--muted); font-size: 11.5px; margin-top: 1px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .mem-acts { display: flex; align-items: center; gap: 6px; flex: none; }
  .mem-invite { display: flex; align-items: center; gap: 8px; margin-top: 14px;
    padding-top: 14px; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .mem-role-sel { flex: 0 0 110px; }
  /* access model: per-member grant chips + the owner-only Permissions expander */
  .mem-grants { color: var(--accent); border-color: var(--accent-line); }
  .mem-perms { display: flex; flex-direction: column; gap: 7px; margin: 2px 0 10px;
    padding: 12px 14px; border: 1px dashed var(--border); border-radius: 11px; }
  .mem-perms .btn { align-self: flex-start; margin-top: 4px; }
  .mem-grant { display: flex; align-items: center; gap: 9px; font-size: 12.5px;
    color: var(--text-2); cursor: pointer; }
  .mem-grant input { accent-color: var(--accent); }
  .mem-restricted { margin-top: 12px; }
`;

/* ---- the members card ---------------------------------------------------- */
interface RowCtx { canManage: boolean; isOwner: boolean; meId: string | null; ownerCount: number }

function MembersCard() {
  const { snap, cid } = useSnapshot();
  const toast = useToast();
  const plan = usePlan();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openPerms, setOpenPerms] = useState<Set<string>>(new Set());
  const [permsDraft, setPermsDraft] = useState<Record<string, string[]>>({});
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
      setErr(true);
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
    setForcedGate({ upgradeUrl: d.upgrade_url || "https://orcha.nursoftai.com/#pricing" });
    return true;
  };

  /* ---- mutations (server re-validates every gate) ----------------------- */
  const doInvite = async () => {
    const login = inviteLogin.trim();
    if (!login || busy || !cid) return;
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
      toast("Invite failed (" + res.status + ")" + (res.body && res.body.detail ? ": " + res.body.detail : ""), "danger");
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
    if (res.ok) { toast("Role updated — " + to + ".", "ok"); void load(); }
    else {
      toast("Role change failed (" + res.status + ")" + (res.body && res.body.detail ? ": " + res.body.detail : ""), "danger");
      void load(); // reset the select to the server truth
    }
  };

  const doGrants = async (aid: string) => {
    if (busy || !cid) return;
    const h = requireActor();
    if (!h) return;
    const grants = permsDraft[aid] || [];
    setBusy(true);
    const res = await memApi("PATCH", memUrl(cid, "/" + encodeURIComponent(aid)), {
      grants: grants, actor_agent_id: h.id,
    });
    setBusy(false);
    if (catchPremium402(res)) return;
    if (res.ok) { toast("Permissions saved.", "ok"); void load(); }
    else toast("Permissions change failed (" + res.status + ")" + (res.body && res.body.detail ? ": " + res.body.detail : ""), "danger");
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
    else toast("Remove failed (" + res.status + ")" + (res.body && res.body.detail ? ": " + res.body.detail : ""), "danger");
  };

  const togglePerms = (m: Member) => {
    const aid = String(m.agent_id);
    setOpenPerms((prev) => {
      const next = new Set(prev);
      if (next.has(aid)) next.delete(aid);
      else next.add(aid);
      return next;
    });
    setPermsDraft((prev) => (aid in prev ? prev : { ...prev, [aid]: m.grants || [] }));
  };
  const toggleGrant = (aid: string, g: string) => {
    setPermsDraft((prev) => {
      const cur = prev[aid] || [];
      return { ...prev, [aid]: cur.indexOf(g) >= 0 ? cur.filter((x) => x !== g) : [...cur, g] };
    });
  };

  /* ---- render ----------------------------------------------------------- */
  // Belt-and-braces: a 402 from a mutation trumps everything else — the
  // server just told us, authoritatively, that this plan can't do this.
  if (forcedGate) {
    return <PremiumGate feature="members" title="Members" pitch={MEMBERS_PITCH} upgradeUrl={forcedGate.upgradeUrl} />;
  }
  // Plan gating (contract item 7): solo renders the paywall INSTEAD of the
  // roster+invite UI — invite/role/grant affordances never render. `plan ===
  // null` is the brief in-flight window before usePlan() resolves; we hold
  // rendering (a beat of blank card body) rather than flash the real roster
  // and then yank it away, or flash the gate for a paying team customer.
  if (plan && plan.plan === "solo") {
    return <PremiumGate feature="members" title="Members" pitch={MEMBERS_PITCH} upgradeUrl={plan.upgrade_url} />;
  }
  if (err) {
    return (
      <div className="sc-banner warn">
        <div className="bt"><Icon name="alert" cls="" /><span>Couldn&#39;t load members.</span></div>
        <button className="btn sm" id="memRetry" type="button" onClick={() => void load()}>Retry</button>
      </div>
    );
  }
  if (!members || !plan) return <div className="none">Loading members…</div>;

  // Roster privacy: the server sent only your own membership — render it as a
  // card plus the explanation (no invite bar, no roster, no controls).
  if (restricted) {
    const m = members[0];
    if (!m) return <div className="none">No membership found.</div>;
    return (
      <>
        <div className="mem-row">
          <MemberFace m={m} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="mem-name">{m.github_login || m.alias}<span className="mem-you">you</span></div>
          </div>
          {m.pending && <span className="tag mem-pending">pending</span>}
          <span className={"tag role-" + m.member_role}>{m.member_role}</span>
        </div>
        <div className="sc-hint mem-restricted">
          Your membership on this project. The full member list is visible to owners and to
          members with the members permission.
        </div>
      </>
    );
  }

  const isOwner = actingOwner(me, snap);
  const canManage = !busy && !viewerRole(me) && (isOwner || actingGrant(me, snap, "manage_members"));
  const ctx: RowCtx = {
    canManage,
    isOwner,
    meId: me?.identity?.agent_id ?? null,
    ownerCount: members.filter((m) => m.member_role === "owner").length,
  };

  return (
    <>
      <div className="mem-list">
        {members.length ? members.map((m) => {
          const login = m.github_login;
          const grants = m.grants || [];
          const you = ctx.meId && String(ctx.meId) === String(m.agent_id);
          // NEVER offer demote/remove on the LAST owner's row (the backend 400s
          // both); owner rows are only manageable by another OWNER (server
          // carve-out mirrored).
          const lastOwner = m.member_role === "owner" && ctx.ownerCount <= 1;
          const rowManageable = ctx.canManage && !lastOwner && (m.member_role !== "owner" || ctx.isOwner);
          const permsOpen = rowManageable && ctx.isOwner && m.member_role !== "owner"
            && openPerms.has(String(m.agent_id));
          return (
            <div key={m.agent_id}>
              <div className="mem-row">
                <MemberFace m={m} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="mem-name">{login || m.alias}{you && <span className="mem-you">you</span>}</div>
                  {login && login !== m.alias && <div className="mem-sub">{m.alias}</div>}
                </div>
                {m.pending && <span className="tag mem-pending">pending</span>}
                {grants.length > 0 && m.member_role !== "owner" && (
                  <span className="tag mem-grants" title={grants.join(", ")}>+{grants.length}</span>
                )}
                <span className={"tag role-" + m.member_role}>{m.member_role}</span>
                {rowManageable && (
                  <span className="mem-acts">
                    {/* Promoting TO owner (and touching an owner row at all) is
                        owner-only server-side, so the option only renders where
                        the actor could succeed. */}
                    <select
                      className="sc-inp mem-role-sel"
                      title="Project role"
                      value={m.member_role}
                      onChange={(e) => void doRole(m.agent_id, e.target.value)}
                    >
                      {ctx.isOwner && <option value="owner">owner</option>}
                      <option value="member">member</option>
                      <option value="viewer">viewer</option>
                    </select>
                    {ctx.isOwner && m.member_role !== "owner" && (
                      <button className="btn sm ghost" type="button" title="Granular permissions"
                        onClick={() => togglePerms(m)}>Permissions</button>
                    )}
                    <button className="iconbtn" title="Remove access" onClick={() => setRemoving(m)}>
                      <Icon name="x" cls="" />
                    </button>
                  </span>
                )}
              </div>
              {permsOpen && (
                <div className="mem-perms">
                  <div className="sc-hint">
                    Extra permissions on top of the {m.member_role} role (viewers stay read-only
                    regardless — only the roster grant affects them).
                  </div>
                  {MEM_GRANTS.map(([g, label]) => (
                    <label className="mem-grant" key={g}>
                      <input
                        type="checkbox"
                        checked={(permsDraft[String(m.agent_id)] || []).indexOf(g) >= 0}
                        onChange={() => toggleGrant(String(m.agent_id), g)}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                  <button className="btn sm" type="button" onClick={() => void doGrants(m.agent_id)}>
                    Save permissions
                  </button>
                </div>
              )}
            </div>
          );
        }) : <div className="none">No human members yet.</div>}
      </div>
      {canManage && (
        <>
          <div className="mem-invite">
            <input
              id="memLogin"
              className="sc-inp"
              spellCheck={false}
              autoComplete="off"
              placeholder="GitHub username to invite…"
              maxLength={39}
              value={inviteLogin}
              onChange={(e) => setInviteLogin(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void doInvite(); }}
            />
            <select
              id="memRole"
              className="sc-inp mem-role-sel"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
            >
              <option value="member">member</option>
              <option value="viewer">viewer</option>
              {isOwner && <option value="owner">owner</option>}
            </select>
            <button className="btn sm" id="memInvite" type="button" onClick={() => void doInvite()}>
              <Icon name="plus" cls="" />Invite
            </button>
          </div>
          <div className="sc-hint">
            Invited members appear as <b>pending</b> until they first sign in. The cloud front
            door (perimeter allowlist) follows this roster — a background sync applies invites
            and removals within a couple of minutes.
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
  return (
    <>
      <style>{MEMBERS_CSS}</style>
      <div className="card set-card">
        <div className="card-h"><h2>Members</h2></div>
        <div className="card-b">
          <div className="lead">
            Who&#39;s on this project. Members map verified GitHub identities to this workspace;
            owners can invite collaborators, change roles, and assign task reviewers. Cloud
            access itself (the perimeter allowlist) is synced separately.
          </div>
          <div id="membersCard">
            <MembersCard />
          </div>
        </div>
      </div>
    </>
  );
}

/* ---- the page (kept routed at /members; renders the same section) -------- */
export function MembersPage() {
  const { snap } = useSnapshot();
  return (
    <Shell page="members" title="Members" ctx={snap?.container?.name}>
      <div className="set-wrap">
        <div className="set-intro">
          <h1>Members</h1>
          <p>Who&#39;s on this project — the collab roster mapping verified GitHub identities to this workspace.</p>
        </div>
        <MembersSection />
      </div>
    </Shell>
  );
}
