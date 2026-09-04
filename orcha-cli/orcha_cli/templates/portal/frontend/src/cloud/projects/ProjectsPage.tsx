/**
 * The /projects landing — React port of static/projects.html +
 * pages/projects-state.js + pages/projects-boot.js (the access-model hub).
 *
 * Data: GET /api/containers → {containers:[{id, name, description, status,
 *   github_repo, agents, tasks, needs_you, member_count, members|null, ...}]} —
 *   already MEMBERSHIP-FILTERED server-side under the trusted proxy lane, and
 *   `members` is null wherever roster privacy applies. Every card's actions are
 *   cid-scoped: Open navigates to /?cid=<id> (full href — that IS project
 *   switching), and the QR button opens the pairing modal AGAINST THAT PROJECT
 *   (GET /api/containers/<cid>/pairing).
 *
 * The PROJECTS hub sits ABOVE any single project, so it renders its own light
 * chrome (brand + account + theme) instead of the project sidebar/topbar —
 * deliberately NOT the <Shell>.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getJSON } from "../../api/client";
import { Icon, OrcaMark, useToast } from "../../components/ui";
import { RepoBadge } from "../github/RepoBadge";
import "../github/connectRepo.css";
import { CloudIcon } from "./icons";
import { Face, GhAvatar } from "./avatars";
import { PairingModal, type PairingIdentity } from "./PairingModal";
import { NewProjectModal } from "./NewProjectModal";
import * as prefs from "./prefs";
import "./projects.css";

export interface ProjMember { alias: string; github_login: string | null; member_role?: string | null }
export interface ProjContainer {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  github_repo?: string | null;
  agents?: number;
  tasks?: number;
  needs_you?: number;
  member_count?: number | null;
  members?: ProjMember[] | null;
}
interface Me { identity: PairingIdentity | null; trusted?: boolean }

/* one member-avatar strip, privacy-aware: named avatars only when the server
 * sent the roster; otherwise a plain "N members" count. */
function ProjMembers({ c }: { c: ProjContainer }) {
  const n = c.member_count != null ? Number(c.member_count) : null;
  if (Array.isArray(c.members) && c.members.length) {
    const shown = c.members.slice(0, 5);
    const extra = c.members.length - shown.length;
    return (
      <span className="pmembers" title={c.members.map((m) => m.github_login || m.alias).join(", ")}>
        {shown.map((m, i) => <Face key={i} rec={{ kind: "human", alias: m.alias || "?", github_login: m.github_login }} size="sm" />)}
        {extra > 0 && <span className="more">+{extra}</span>}
      </span>
    );
  }
  if (n != null) return <span className="pmembers"><span className="more">{n} member{n === 1 ? "" : "s"}</span></span>;
  return null;
}

/* per-user default star (mig 040) — rendered ONLY when server prefs are active,
 * so self-host/trust-off keeps the pre-040 card. Toggleable: clicking the
 * starred card's star clears the mark. Persisted via prefs (localStorage
 * immediately + debounced PUT); repainted in place, no refetch. */
function DefStar({ cid, defCid, onToggle }: { cid: string; defCid: string | null; onToggle: (next: string | null) => void }) {
  const on = defCid != null && String(defCid) === String(cid);
  return (
    <button
      className={"defstar" + (on ? " on" : "")}
      type="button"
      data-def-cid={cid}
      aria-pressed={on ? "true" : "false"}
      title={on ? "Default project — click to unset" : "Make this your default project"}
      onClick={() => onToggle(on ? null : cid)}
    >
      <svg viewBox="0 0 20 20" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
        <path d="M10 2.8l2.2 4.5 4.9.7-3.6 3.5.9 4.9-4.4-2.3-4.4 2.3.9-4.9L3 8l4.9-.7z" />
      </svg>
    </button>
  );
}

function ProjectCard({ c, stars, defCid, onStar, onPair }: {
  c: ProjContainer;
  stars: boolean;
  defCid: string | null;
  onStar: (next: string | null) => void;
  onPair: (c: ProjContainer) => void;
}) {
  const needs = Number(c.needs_you || 0);
  const openHref = "/?cid=" + encodeURIComponent(c.id);
  return (
    <div className="pcard" data-proj-card={c.id}>
      <div className="ph">
        <span className={"pdot" + (c.status === "active" ? " on" : "")} />
        <span className="pname">{c.name}</span>
        {stars && <DefStar cid={c.id} defCid={defCid} onToggle={onStar} />}
        {needs > 0 && <span className="needs" title="Verifications + requests waiting on a human">Needs you · {needs}</span>}
      </div>
      <div className="pdesc">{c.description || "No description yet."}</div>
      {c.github_repo && (
        <RepoBadge repo={c.github_repo} workspaceName={c.name} className="prepo" />
      )}
      <div className="pstats">
        <span><b>{Number(c.agents || 0)}</b> agent{Number(c.agents) === 1 ? "" : "s"}</span>
        <span><b>{Number(c.tasks || 0)}</b> task{Number(c.tasks) === 1 ? "" : "s"}</span>
        <ProjMembers c={c} />
      </div>
      <div className="pfoot">
        {/* full href navigation on purpose — that's how project switching works */}
        <a className="btn sm" href={openHref}><Icon name="arrow" cls="" />Open</a>
        <span className="grow" />
        <button
          className="btn sm ghost" type="button"
          data-pair-cid={c.id} data-pair-name={c.name}
          title="Pair a phone to this project"
          onClick={() => onPair(c)}
        >
          <CloudIcon name="phone" cls="" />Pair phone
        </button>
      </div>
    </div>
  );
}

/* The New-project modal lives in NewProjectModal.tsx — shared with the topbar
 * ProjectSwitcher (same POST additional=true contract; on success we land
 * INSIDE the new project). */

/* top chrome: brand · account (viewer identity if resolved) · theme toggle */
function ProjTop({ me }: { me: Me | null }) {
  const toast = useToast();
  const [, tick] = useState(0);
  const cycleTheme = () => {
    // GH #239: cycle from the RESOLVED theme so one click always changes it.
    let cur = "auto";
    try { cur = localStorage.getItem("orcha:theme") || "auto"; } catch { /* private mode */ }
    let resolved = cur;
    if (cur !== "dark" && cur !== "light") {
      try { resolved = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch { resolved = "dark"; }
    }
    const next = resolved === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("orcha:theme", next); } catch { /* private mode */ }
    prefs.queuePut();
    toast("Theme · " + next, "ok");
    tick((n) => n + 1);
  };
  const ident = me && me.identity;
  return (
    <>
      <a className="brand" href="/projects"><span className="mark"><OrcaMark /></span>
        <span className="word">Orcha</span></a>
      <span className="grow" />
      {ident && ident.github_login && (
        <span className="acct"><GhAvatar login={ident.github_login} size="sm" />{ident.github_login}</span>
      )}
      <button className="iconbtn" id="projTheme" title="Theme — click to cycle" onClick={cycleTheme}>
        <Icon name="sun" cls="sun" /><Icon name="moon" cls="moon" />
      </button>
    </>
  );
}

export function ProjectsPage() {
  const [list, setList] = useState<ProjContainer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [stars, setStars] = useState(false);
  const [defCid, setDefCid] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pairing, setPairing] = useState<{ cid: string; name: string } | null>(null);
  const meFetched = useRef(false);

  const load = useCallback(async () => {
    // Per-user prefs (mig 040): kick the once-per-load /api/prefs sync alongside
    // the list fetch (single-flight — the 15s refresh re-await is instant). The
    // hub needs it settled before painting so the default stars render honestly
    // (and self-host, where prefs resolve null, paints NO stars at all).
    const prefsReady = prefs.sync();
    let containers: ProjContainer[] = [];
    try {
      const d = await getJSON<{ containers?: ProjContainer[] }>("/api/containers");
      containers = (d && d.containers) || [];
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      return;
    }
    setLoadError(null);
    // Identity for the account chip: any project's cid works for /api/me; use
    // the first listed (or skip the chip on an empty stack).
    if (containers.length && !meFetched.current) {
      meFetched.current = true;
      try {
        setMe(await getJSON<Me>("/api/me?cid=" + encodeURIComponent(containers[0].id)));
      } catch { /* chip stays hidden */ }
    }
    try { await prefsReady; } catch { /* inactive */ }
    setStars(prefs.active());
    setDefCid(prefs.defaultCid());
    setList(containers);
  }, []);

  useEffect(() => {
    void load();
    // Light refresh so counts/needs-you stay honest while the tab sits open.
    const iv = setInterval(() => void load(), 15000);
    return () => clearInterval(iv);
  }, [load]);

  const onStar = (next: string | null) => {
    prefs.setDefaultCid(next);
    setDefCid(next);
  };

  const sub = list && !list.length
    ? "No memberships yet — create a project or ask an owner for an invite."
    : "Everything you're a member of on this Orcha.";

  return (
    <div className="proj-app">
      <header className="proj-top" id="projTop">
        {(list != null || loadError != null) && <ProjTop me={me} />}
      </header>
      <main className="proj-main">
        <div className="proj-head">
          <h1>Projects</h1>
          <p className="sub" id="projSub">{sub}</p>
        </div>
        <div className="proj-grid" id="projGrid">
          {loadError != null ? (
            <div className="proj-empty"><div className="t1">Couldn't load projects</div><div>{loadError}</div></div>
          ) : list == null ? (
            <div className="none" style={{ padding: 30 }}>Loading projects…</div>
          ) : (
            <>
              {list.length ? (
                (() => {
                  // Favorites first: the starred project(s) pin to their own
                  // section at the top; everything else under "All projects".
                  const favs = stars ? list.filter((c) => c.id === defCid) : [];
                  const rest = favs.length ? list.filter((c) => c.id !== defCid) : list;
                  const card = (c: ProjContainer) => (
                    <ProjectCard
                      key={c.id} c={c} stars={stars} defCid={defCid} onStar={onStar}
                      onPair={(p) => setPairing({ cid: p.id, name: p.name })}
                    />
                  );
                  return (
                    <>
                      {favs.length > 0 && (
                        <>
                          <div className="proj-sect">★ Favorites</div>
                          {favs.map(card)}
                          <div className="proj-sect">All projects</div>
                        </>
                      )}
                      {rest.map(card)}
                    </>
                  );
                })()
              ) : (
                <div className="proj-empty">
                  <div className="t1">No projects yet</div>
                  <div>You're not a member of any project on this Orcha — create one, or ask an owner for an invite.</div>
                </div>
              )}
              <div
                className="pcard new" id="projNew" role="button" tabIndex={0} title="Create a project"
                onClick={() => setCreating(true)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCreating(true); } }}
              >
                <span className="plus">+</span><span>New project</span>
              </div>
            </>
          )}
        </div>
      </main>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      {pairing && (
        <PairingModal
          cid={pairing.cid}
          name={pairing.name}
          identity={me && me.trusted ? me.identity : null}
          onClose={() => setPairing(null)}
        />
      )}
    </div>
  );
}
