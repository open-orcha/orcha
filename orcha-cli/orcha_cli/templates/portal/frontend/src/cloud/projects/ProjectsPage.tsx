/**
 * /projects — "All projects", the project manager (Orcha V2; parity R-02,
 * P-01…P-03), laid out as a Linear "Initiatives" table (D5/D10/D12): an inset
 * panel header (page title · refresh · New project), a filter-pill row
 * (All · Active · Inactive + a circular filter button that expands), muted
 * column headers, and one calm row per project. It renders INSIDE the V2
 * frame (the persistent sidebar is the one navigation hierarchy) and carries
 * no project chrome of its own.
 *
 * Data: the shared project store (state/projects.ts — GET /api/containers,
 * refreshed on mount, on Refresh and every 15 s while this hub is open and the
 * tab visible — the old hub's cadence; the sidebar alone keeps 60 s; the same
 * list the sidebar shows). The list is MEMBERSHIP-FILTERED server-side under the trusted proxy
 * lane, and `members` is null wherever roster privacy applies.
 *
 * Per row (one fixed-height line): project icon (D14 — the user's emoji/glyph,
 * default a neutral cube, never initials) + name (another project =
 * the sidebar's scope switch, projectSwitchHref → full navigation to
 * /?cid=<id>, which IS project switching; the current project = in-app route;
 * the whole row is the link target), a non-active status chip, the objective
 * trailing the name muted (only when one exists), repository (GitHub mark
 * linking to github.com in a new tab, or the Local chip), wake-service health
 * chip (Waking / Stale / —), "Needs
 * you" (`needs_you`: the server's attention_counts.py — the SAME rule as the
 * portal's selectAttention: plans, verifications and requests you can act on;
 * missing ⇒ "—" + "unavailable", never 0), AI agents
 * (agents − human members; people are Members), tasks ("done / total" with a
 * ring only when the server sends tasks_done), members
 * (privacy-aware), the per-user default star (only when server prefs are
 * active), and a ⋯ menu: Open, Add to / Remove from favorites (local, shared
 * with the sidebar's Favorites), Change icon… (D14 picker), Pair phone (cid-scoped QR), Project settings.
 * New project → the shared NewProjectModal (POST additional=true).
 * Name / Needs you / Agents / Tasks headers sort (first dir → flipped →
 * back to your pinned/manual order); unknown figures always sink.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AvatarStack, Button, Chip, EmptyState, HealthChip, Menu, Skeleton, Tooltip,
  type Health, type MenuItemSpec,
} from "../../components/primitives";
import { IconButton, ListGroup } from "../../components/primitives";
import { ButtonLink } from "../../components/primitives/Button";
import { ProjectIcon } from "../../components/primitives/ProjectIcon";
import { ProjectIconPicker } from "../../components/primitives/EmojiPicker";
import { Icon } from "../../components/ui";
import { relTime } from "../../lib/format";
import { projectSwitchHref } from "../../lib/scope";
import { WAKE_WINDOW_MS } from "../../lib/notifier";
import { useChrome } from "../../shell/chrome";
import { CircleIconButton, FilterPills, PageToolbar } from "../../shell/PageChrome";
import { useSnapshot } from "../../state/SnapshotProvider";
import { useAttention } from "../../state/attention";
import {
  HUB_REFRESH_MS, orderProjects, pinnedProjects, togglePinned, useProjectPrefsVersion, useProjects, useProjectsPoll,
  type ProjectRow,
} from "../../state/projects";
import { RepoBadge } from "../github/RepoBadge";
import { isLocalRepo } from "../github/connectRepo";
import "../github/connectRepo.css";
import { SIGN_OUT_HREF, fetchMe, type Me } from "../identity";
import { useProxySession } from "../../state/session";
import { GitHubMark } from "./icons";
import { PairingModal } from "./PairingModal";
import { NewProjectModal } from "./NewProjectModal";
import { iconAccessFor, type IconAccess } from "./iconAccess";
import { projectStatusMeta } from "./projectStatus";
import * as prefs from "./prefs";
import "./projects.css";

export interface ProjMember { alias: string; github_login: string | null; member_role?: string | null }
export interface ProjContainer extends ProjectRow {
  name: string;
  member_count?: number | null;
  members?: ProjMember[] | null;
  /** completed tasks — rendered as "done / total" ONLY when the server sends it (never inferred) */
  tasks_done?: number | null;
  /** AI-only agent count, when the server sends it (else derived: agents − member_count) */
  ai_agents?: number | null;
}

/** Opening another project = the sidebar's scope switch (full navigation with
 *  ?cid=, landing on its Overview — no in-memory state crosses projects). */
export const openHref = (cid: string) => projectSwitchHref(cid, "/", "");
export const settingsHref = (cid: string) => "/settings?cid=" + encodeURIComponent(cid);

/**
 * The server's `needs_you` is computed by portal_backend/attention_counts.py
 * with the SAME rule as the portal's attention selector (plans + verifications
 * + requests the acting human can act on), so the column carries the sidebar's
 * name and number.
 */
export const NEEDS_COLUMN = "Needs you";
export const NEEDS_MEASURE = "Plan approvals, verifications and requests waiting on you — the same count as the sidebar.";
/** The hub's own re-fetch cadence while open (old hub parity, SH-116) — owned by state/projects. */
export { HUB_REFRESH_MS };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * AI agents only (humans are Members, not Agents — the Overview's "7 agents ·
 * 2 people"). The server's `agents` counts every live agent row, humans
 * included, and `member_count` is exactly the live humans among them, so the
 * difference is the AI count. Unknown member_count ⇒ null (never a guess).
 */
export function aiAgentCount(c: { agents?: number | null; member_count?: number | null; ai_agents?: number | null }): number | null {
  if (c.ai_agents != null) return Number(c.ai_agents);
  if (c.agents == null || c.member_count == null) return null;
  return Math.max(0, Number(c.agents) - Number(c.member_count));
}

/** Initiatives-style progress ring (done / total); empty ring when total is 0. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 5.25, circ = 2 * Math.PI * r;
  const f = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <svg className="ptasks-ring" viewBox="0 0 14 14" aria-hidden="true" data-progress={Math.round(f * 100)}>
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" />
      {f > 0 ? (
        <circle
          cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          strokeDasharray={`${f * circ} ${circ}`} transform="rotate(-90 7 7)"
        />
      ) : null}
    </svg>
  );
}

/** Members cell, privacy-aware: named avatars only when the server sent the roster. */
function ProjMembers({ c }: { c: ProjContainer }) {
  const n = c.member_count != null ? Number(c.member_count) : null;
  if (Array.isArray(c.members) && c.members.length) {
    return (
      <AvatarStack
        className="pmembers" size={20} max={4} label="Members"
        actors={c.members.map((m) => ({ alias: m.alias || m.github_login || "?", kind: "human", ghLogin: m.github_login }))}
      />
    );
  }
  if (n != null) {
    return <span className="pmembers-n" title="Roster is private — member count only">{plural(n, "member")}</span>;
  }
  return <span className="pcell-none" title="The server did not report members for this project">—</span>;
}

/* per-user default star (mig 040) — rendered ONLY when server prefs are active. */
function DefStar({ cid, name, defCid, onToggle }: { cid: string; name: string; defCid: string | null; onToggle: (next: string | null) => void }) {
  const on = defCid != null && String(defCid) === String(cid);
  return (
    <button
      className={"defstar" + (on ? " on" : "")}
      type="button"
      data-def-cid={cid}
      aria-pressed={on ? "true" : "false"}
      aria-label={on ? `${name} is your default project — unset` : `Make ${name} your default project`}
      title={on ? "Default project — click to unset" : "Make this your default project"}
      onClick={() => onToggle(on ? null : cid)}
    >
      <svg viewBox="0 0 20 20" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
        <path d="M10 2.8l2.2 4.5 4.9.7-3.6 3.5.9 4.9-4.4-2.3-4.4 2.3.9-4.9L3 8l4.9-.7z" />
      </svg>
    </button>
  );
}

/**
 * Pending decisions, the server's attention count (see NEEDS_MEASURE). Zero and
 * unavailable read differently: a muted "0" vs a muted "—" whose tooltip and
 * screen-reader text say the figure is unavailable (never a fake 0).
 * Linear-calm: the number is neutral; only the small dot carries colour.
 */
export function NeedsCell({ n }: { n: number | null | undefined }) {
  if (n == null) {
    return (
      <span className="pneeds unknown" title="The server did not report pending decisions for this project">
        <span aria-hidden="true">—</span><span className="v2-sr">Pending decisions unavailable</span>
      </span>
    );
  }
  if (!n) {
    return (
      <span className="pneeds zero" title="Nothing waiting on you">
        0<span className="v2-sr"> waiting on you</span>
      </span>
    );
  }
  return (
    <span className="pneeds" title={`${n} decision${n === 1 ? "" : "s"} waiting on you`}>
      <span className="pneeds-dot" aria-hidden="true" />{n}<span className="v2-sr"> waiting on you</span>
    </span>
  );
}

/** Status only when it says something: an active project shows none (labels: ./projectStatus). */
export const isActiveProject = (c: { status?: string | null }) => !c.status || c.status === "active";

export type WakeKind = "waking" | "stale" | "none";
/**
 * Wake-service health from the daemon's per-tick stamp (`last_wake_scan_at`),
 * judged at the moment the list was FETCHED (`asOf`) so a 60 s-old list never
 * turns a live service "stale" on its own. Same window as the header's
 * notifier state (lib/notifier WAKE_WINDOW_MS).
 */
export function wakeHealth(at: string | null | undefined, asOf: number = Date.now()): { kind: WakeKind; health: Health | null; label: string; title: string } {
  const t = at ? Date.parse(at) : NaN;
  if (!at || !Number.isFinite(t)) {
    return { kind: "none", health: null, label: "No wake service", title: "No wake service seen — agents here are not being woken (portal-only)" };
  }
  const when = new Date(t).toLocaleString();
  const ago = relTime(at);
  if (asOf - t <= WAKE_WINDOW_MS) {
    return { kind: "waking", health: "on_track", label: "Waking", title: `Wake service is checking this project · last scan ${ago} (${when})` };
  }
  return { kind: "stale", health: "at_risk", label: "Stale · " + ago.replace(/ ago$/, ""), title: `Wake service hasn't scanned this project since ${ago} (${when})` };
}

function WakeCell({ at, asOf }: { at: string | null | undefined; asOf: number }) {
  const w = wakeHealth(at, asOf);
  if (!w.health) {
    // "—" (with the fact in the tooltip + SR text) instead of repeating a sentence on every row
    return (
      <span className="pwake is-none" title={w.title} data-wake="none">
        <span aria-hidden="true">—</span><span className="v2-sr">{w.label}</span>
      </span>
    );
  }
  return (
    <span className="pwake" data-wake={w.kind}>
      <HealthChip health={w.health} label={w.label} title={w.title} />
    </span>
  );
}

/** Repository cell: a GitHub binding is the GitHub mark + owner/name (UI font); a local binding keeps RepoBadge's Local chip. */
function RepoCell({ repo, name }: { repo: string | null | undefined; name: string }) {
  if (!repo) return <span className="pcell-none" title="No repository or folder bound">—</span>;
  if (isLocalRepo(repo)) return <RepoBadge repo={repo} workspaceName={name} className="prepo" />;
  const slug = repo.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return (
    <a
      className="prepo is-gh" data-repo-kind="github" href={`https://github.com/${slug}`}
      target="_blank" rel="noreferrer" title={`Open ${slug} on GitHub`}
    >
      <GitHubMark cls="prepo-ico" />
      <span className="prepo-name">{slug}</span>
      <span className="v2-sr"> (opens GitHub in a new tab)</span>
    </a>
  );
}

function ProjectRowView({ c, stars, defCid, pinned, current, asOf, onStar, onPair, liveNeeds }: {
  c: ProjContainer; stars: boolean; defCid: string | null; pinned: boolean;
  /** the project this tab is already scoped to — opening it is an in-app route change, not a reload */
  current: boolean;
  asOf: number;
  onStar: (next: string | null) => void; onPair: (c: ProjContainer) => void;
  /** the current project's LIVE attention count (the sidebar's number, D12 one fact) — null = use the list's */
  liveNeeds?: number | null;
}) {
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  // D14 icon gate (server: owner or manage_autonomy) — asked when the menu opens
  const [iconAcc, setIconAcc] = useState<IconAccess | null>(null);
  useEffect(() => {
    if (!menu || iconAcc) return;
    let alive = true;
    void iconAccessFor(c.id).then((a) => { if (alive) setIconAcc(a); });
    return () => { alive = false; };
  }, [menu, iconAcc, c.id]);
  const anchor = useRef<HTMLButtonElement | null>(null);
  // every item iconed (aligned labels); settings set apart
  const items: (MenuItemSpec | "separator")[] = [
    { label: "Open", icon: "arrow", href: openHref(c.id) },
    { label: pinned ? "Remove from favorites" : "Add to favorites", icon: "pin", onSelect: () => togglePinned(c.id) },
    // D14: the same per-user icon store the sidebar and the desktop read
    {
      label: "Change icon…", icon: "pencil", onSelect: () => setPicking(true),
      ...(iconAcc && !iconAcc.allowed ? { disabled: true, disabledReason: iconAcc.reason ?? undefined } : {}),
    },
    { label: "Pair phone…", icon: "phone", onSelect: () => onPair(c) },
    // the default star also lives here, so phones (where only a set star shows) can set it
    ...(stars ? [{
      label: defCid != null && String(defCid) === String(c.id) ? "Unset default project" : "Make default project",
      icon: "star", onSelect: () => onStar(defCid != null && String(defCid) === String(c.id) ? null : c.id),
    } as MenuItemSpec] : []),
    "separator",
    { label: "Project settings", icon: "sliders", href: settingsHref(c.id) },
  ];
  const agents = Number(c.agents ?? 0);
  const ai = aiAgentCount(c);
  const tasks = Number(c.tasks ?? 0);
  const done = c.tasks_done != null ? Number(c.tasks_done) : null;
  const statusMeta = !isActiveProject(c) ? projectStatusMeta(c.status) : null;
  const statusWord = statusMeta?.label ?? null;
  const wake = wakeHealth(c.last_wake_scan_at, asOf);
  // phone-width meta line (aria-hidden: the same facts are in the cells for AT)
  const meta = [
    ai != null ? plural(ai, "agent") : plural(agents, "agent"),
    done != null ? `${done} / ${tasks} tasks` : plural(tasks, "task"),
    wake.kind === "waking" ? "waking" : wake.kind === "stale" ? "wakes stale" : "no wake service",
  ].join(" · ");
  return (
    <li className={"proj-row" + (statusWord ? " is-inactive" : "")} role="row" data-proj-card={c.id} data-current={current ? "" : undefined}>
      <div className="pcell pcell-name" role="cell">
        {/* D14: the user's project icon (emoji / glyph), default a neutral cube — never initials */}
        <ProjectIcon cid={c.id} size={18} className="prow-av" />
        <div className="prow-main">
          <div className="prow-top">
            {/* The link's hit area covers the whole row (::after); controls sit above it.
                Another project = full navigation to /?cid= (that IS project switching —
                no state crosses, like the sidebar); the project this tab is already
                scoped to = in-app route change (no reload, sidebar keeps its state). */}
            {current ? (
              <Link className="pname" to="/" title={c.name}>{c.name}</Link>
            ) : (
              <a className="pname" href={openHref(c.id)} title={c.name}>{c.name}</a>
            )}
            {statusWord ? <Chip size="sm" dot={statusMeta?.tone ?? "neutral"} className="pstatus">{statusWord}</Chip> : null}
            {/* one fixed-height line (D12): the objective trails the name, muted, ellipsized */}
            {c.description ? <span className="pdesc" title={c.description}>{c.description}</span> : null}
          </div>
          <div className="prow-meta" aria-hidden="true">{meta}</div>
        </div>
      </div>
      <div className="pcell pcell-repo" role="cell"><RepoCell repo={c.github_repo} name={c.name} /></div>
      <div className="pcell pcell-wake" role="cell"><WakeCell at={c.last_wake_scan_at} asOf={asOf} /></div>
      <div className="pcell pcell-needs" role="cell"><NeedsCell n={liveNeeds ?? c.needs_you} /></div>
      {ai != null ? (
        <div className="pcell pcell-num pcell-agents" role="cell" title="AI agents in this project (people are counted under Members; retired agents excluded)">
          {ai}<span className="v2-sr"> {ai === 1 ? "AI agent" : "AI agents"}</span>
        </div>
      ) : (
        <div className="pcell pcell-num pcell-agents" role="cell" title="Agents in this project, AI and human — the server did not say how many are people">
          {agents}<span className="v2-sr"> {agents === 1 ? "agent" : "agents"} (AI and human)</span>
        </div>
      )}
      <div
        className="pcell pcell-num pcell-tasks" role="cell"
        title={done != null ? `${done} of ${tasks} tasks completed (excluding the root task)` : "Tasks in this project (excluding the root task)"}
      >
        {done != null ? <><ProgressRing done={done} total={tasks} /><span className="ptasks-done">{done}</span><span className="ptasks-sep"> / </span>{tasks}</> : tasks}
        <span className="v2-sr"> {tasks === 1 ? "task" : "tasks"}</span>
      </div>
      <div className="pcell pcell-members" role="cell"><ProjMembers c={c} /></div>
      <div className="pcell prow-acts" role="cell">
        {stars && <DefStar cid={c.id} name={c.name} defCid={defCid} onToggle={onStar} />}
        <IconButton
          ref={anchor} icon="more" size="sm" className="pmore" label={`${c.name} actions`} title="Project actions"
          aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}
        />
        <Menu anchor={anchor} open={menu} onClose={() => setMenu(false)} items={items} label={`${c.name} actions`} placement="bottom-end" />
        {picking ? (
          <ProjectIconPicker cid={c.id} name={c.name} anchor={anchor} open={picking} onClose={() => setPicking(false)} placement="bottom-end" />
        ) : null}
      </div>
    </li>
  );
}

type SortKey = "name" | "needs" | "agents" | "tasks";
type SortDir = "asc" | "desc";
export interface ProjSort { key: SortKey; dir: SortDir }
/** Numbers sort biggest-first on the first click, names A→Z. */
const FIRST_DIR: Record<SortKey, SortDir> = { name: "asc", needs: "desc", agents: "desc", tasks: "desc" };
/** Click cycle per column: first direction → flipped → back to your order (pins + manual order). */
export function nextSort(cur: ProjSort | null, key: SortKey): ProjSort | null {
  if (!cur || cur.key !== key) return { key, dir: FIRST_DIR[key] };
  if (cur.dir === FIRST_DIR[key]) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return null;
}
const sortValue = (c: ProjContainer, key: SortKey): number | string | null => {
  if (key === "name") return (c.name || "").toLowerCase();
  if (key === "needs") return c.needs_you == null ? null : Number(c.needs_you);
  if (key === "agents") return aiAgentCount(c) ?? (c.agents == null ? null : Number(c.agents));
  return c.tasks == null ? null : Number(c.tasks);
};
/** Stable sort; unknown values ("—") always sink to the bottom in either direction. */
export function sortProjects<T extends ProjContainer>(rows: T[], sort: ProjSort | null): T[] {
  if (!sort) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows.map((c, i) => [c, i] as const).sort(([a, ia], [b, ib]) => {
    const va = sortValue(a, sort.key), vb = sortValue(b, sort.key);
    if (va == null || vb == null) return va == null && vb == null ? ia - ib : va == null ? 1 : -1;
    const d = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return d * sign || ia - ib;
  }).map(([c]) => c);
}

function SortHead({ k, label, sort, onSort, children }: {
  k: SortKey; label: string; sort: ProjSort | null; onSort: (k: SortKey) => void; children?: ReactNode;
}) {
  const on = sort?.key === k ? sort.dir : null;
  return (
    <span
      className={"pcell pcell-" + (k === "name" ? "name" : k === "needs" ? "needs" : "num")}
      role="columnheader" aria-sort={on === "asc" ? "ascending" : on === "desc" ? "descending" : "none"}
    >
      <button
        type="button" className={"proj-sort" + (on ? " is-on" : "")} data-sort-key={k} aria-pressed={on ? "true" : "false"}
        aria-label={`Sort by ${label}` + (on ? (on === "asc" ? ", ascending" : ", descending") : "")}
        onClick={() => onSort(k)}
      >
        {children ?? label}
        <svg className="proj-sort-ico" viewBox="0 0 12 12" aria-hidden="true" data-dir={on ?? "none"}>
          <path
            d={on === "asc" ? "M3.5 7.25 6 4.75l2.5 2.5" : on === "desc" ? "M3.5 4.75 6 7.25l2.5-2.5" : "M3.5 4.75 6 2.25l2.5 2.5M3.5 7.25 6 9.75l2.5-2.5"}
            fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>
    </span>
  );
}

/** Muted Initiatives-style column headers; Name / Needs you / Agents / Tasks sort on click. */
function ColumnHeads({ sort, onSort }: { sort: ProjSort | null; onSort: (k: SortKey) => void }) {
  return (
    <div className="proj-cols" role="row">
      <SortHead k="name" label="Name" sort={sort} onSort={onSort} />
      <span className="pcell pcell-repo" role="columnheader">Repository</span>
      <span className="pcell pcell-wake" role="columnheader">
        <Tooltip label="Wake service health: Waking = scanned in the last 2 minutes; Stale = not scanned since; — = no wake service seen." placement="bottom">
          <span className="proj-col-help" tabIndex={-1}>Wakes <Icon name="help" cls="v2-ico" /></span>
        </Tooltip>
      </span>
      <SortHead k="needs" label={NEEDS_COLUMN} sort={sort} onSort={onSort}>
        <Tooltip label={NEEDS_MEASURE} placement="bottom">
          <span className="proj-col-help">{NEEDS_COLUMN} <Icon name="help" cls="v2-ico" /></span>
        </Tooltip>
      </SortHead>
      <SortHead k="agents" label="Agents" sort={sort} onSort={onSort} />
      <SortHead k="tasks" label="Tasks" sort={sort} onSort={onSort} />
      <span className="pcell pcell-members" role="columnheader">Members</span>
      <span className="pcell prow-acts" role="columnheader"><span className="v2-sr">Actions</span></span>
    </div>
  );
}

/**
 * Filter field as a D5 circular icon button that expands into a rounded
 * field (Linear keeps the filter row to pills + circles). It stays open while
 * it holds text; Esc clears and closes; at phone width the open field covers
 * the pill row instead of clipping it.
 */
function ProjectSearch({ q, setQ }: { q: string; setQ: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const shown = open || q !== "";
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  if (!shown) {
    return <CircleIconButton icon="search" label="Filter projects" title="Filter projects" onClick={() => setOpen(true)} id="projFilterBtn" />;
  }
  return (
    <label className="proj-search is-open">
      <span className="v2-sr">Filter projects</span>
      <Icon name="search" cls="v2-ico proj-search-ico" />
      <input
        ref={input} id="projFilter" className="proj-filter" type="search" placeholder="Filter by name, repo…"
        value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setQ(""); setOpen(false); }
        }}
        onBlur={() => { if (!q) setOpen(false); }}
      />
      <button
        type="button" className="proj-search-x" aria-label="Clear filter"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { setQ(""); setOpen(false); }}
      >
        <Icon name="x" cls="v2-ico" />
      </button>
    </label>
  );
}

/** Panel header (D5): page title left; refresh + the ONE primary action right. */
function ProjectsHeader({ onNew, onRefresh, loading, fetchedAt }: {
  onNew: () => void; onRefresh: () => void; loading: boolean; fetchedAt: number | null;
}) {
  const chrome = useChrome();
  useEffect(() => { document.title = "All projects · Embodent"; }, []);
  const updated = fetchedAt ? new Date(fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <header className="v2-header topbar proj-head" id="projTop">
      {chrome && !chrome.embedded ? (
        <IconButton
          icon="menu" label="Open navigation" className="v2-hamburger" id="v2Hamburger"
          aria-expanded={chrome.drawerOpen} aria-controls="sidebar" onClick={() => chrome.setDrawerOpen(true)}
        />
      ) : null}
      <h1 className="proj-title"><Icon name="grid" cls="v2-ico proj-title-ico" />All projects</h1>
      <div className="v2-grow" />
      <span className="v2-sr" aria-live="polite">{updated ? "Updated " + updated : ""}</span>
      <div className="v2-header-tools">
        <CircleIconButton
          icon="refresh" label="Refresh project list" busy={loading} onClick={onRefresh}
          title={updated ? `Refresh · updated ${updated}` : "Refresh project list"}
        />
        <div className="v2-header-primary">
          <Button variant="primary" size="sm" icon="plus" onClick={onNew} id="projNew">New project</Button>
        </div>
      </div>
    </header>
  );
}

type Scope = "all" | "active" | "inactive";

export function ProjectsPage() {
  const { list, error, fetchedAt, loading, refresh } = useProjects();
  useProjectPrefsVersion(); // re-render on local pin/order changes
  const [me, setMe] = useState<Me | null>(null);
  const [stars, setStars] = useState(false);
  const [defCid, setDefCid] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pairing, setPairing] = useState<{ cid: string; name: string } | null>(null);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [sort, setSort] = useState<ProjSort | null>(null);
  const meFor = useRef<string | null>(null);
  // the project this tab is scoped to (null on a single-project / unscoped mount)
  const { cid: currentCid, snap } = useSnapshot();
  // D12 one fact: the current project's row shows the sidebar's live number
  // (shared selector, optimistic decisions applied) — the server's needs_you
  // only for the other projects (and while the live count is unknown).
  const attention = useAttention();
  const liveNeeds = snap && currentCid != null && String(snap.container?.id ?? currentCid) === String(currentCid)
    && !attention.readOnly ? attention.count : null;

  // explicit open → fresh list; then every HUB_REFRESH_MS while the tab is
  // visible (the shared store's 60 s timer stays the sidebar's cadence)
  useEffect(() => { void refresh(); }, [refresh]);
  useProjectsPoll(HUB_REFRESH_MS);

  // Per-user prefs (mig 040): stars render only once the sync says prefs are
  // active, so self-host (prefs null) never paints a star.
  useEffect(() => {
    let alive = true;
    void prefs.sync().then(() => { if (!alive) return; setStars(prefs.active()); setDefCid(prefs.defaultCid()); });
    return () => { alive = false; };
  }, []);

  // Identity for the pairing modal (trusted lane): any listed project's cid works.
  const firstCid = list && list.length ? list[0].id : null;
  useEffect(() => {
    if (!firstCid || meFor.current === firstCid) return;
    meFor.current = firstCid;
    let alive = true;
    void fetchMe(firstCid).then((m) => { if (alive) setMe(m); }).catch(() => { /* no identity */ });
    return () => { alive = false; };
  }, [firstCid]);

  const pins = pinnedProjects();
  const all = useMemo(
    () => orderProjects((list ?? []) as ProjectRow[]) as ProjContainer[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, pins.join(",")],
  );
  const activeN = all.filter(isActiveProject).length;
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sortProjects(all.filter((c) =>
      (scope === "all" || (scope === "active") === isActiveProject(c))
      && (!needle || [c.name, c.description, c.github_repo].some((v) => (v || "").toLowerCase().includes(needle)))), sort);
  }, [all, q, scope, sort]);

  const onStar = (next: string | null) => { prefs.setDefaultCid(next); setDefCid(next); };
  const pinnedRows = rows.filter((c) => pins.includes(c.id));
  const otherRows = rows.filter((c) => !pins.includes(c.id));
  const row = (c: ProjContainer) => (
    <ProjectRowView
      key={c.id} c={c} stars={stars} defCid={defCid} pinned={pins.includes(c.id)}
      onStar={onStar} onPair={(p) => setPairing({ cid: p.id, name: p.name })}
      current={currentCid != null && String(currentCid) === String(c.id)} asOf={asOf}
      liveNeeds={currentCid != null && String(currentCid) === String(c.id) ? liveNeeds : null}
    />
  );
  const asOf = fetchedAt ?? Date.now();
  const loaded = list != null && list.length > 0;
  // parity r3: zero memberships = no project to ask /api/me about, so the sidebar's
  // account menu can't offer Sign out — the empty state does, when a sign-in exists
  const signedIn = useProxySession(list != null && list.length === 0);
  // the "All projects N" pill already says the total — the text count only appears while a text filter narrows it
  const searching = q.trim() !== "";

  const toolbar = loaded ? (
    <PageToolbar
      label="Project filters"
      end={<>
        <span className="proj-count" id="projSub" aria-live="polite">
          {searching && rows.length ? `${rows.length} of ${plural(all.length, "project")}` : ""}
        </span>
        <ProjectSearch q={q} setQ={setQ} />
      </>}
    >
      <FilterPills
        label="Project scope" value={scope} onChange={(k) => setScope(k as Scope)}
        items={[
          { key: "all", label: "All projects", count: all.length },
          { key: "active", label: "Active", count: activeN },
          { key: "inactive", label: "Inactive", count: all.length - activeN, title: "Completed, archived, paused, provisioning or failed projects" },
        ]}
      />
    </PageToolbar>
  ) : null;

  return (
    <div className="v2-main main proj-app" data-v2-surface="panel">
      <div className="v2-panel-top">
        <ProjectsHeader onNew={() => setCreating(true)} onRefresh={() => void refresh()} loading={loading} fetchedAt={fetchedAt} />
        {toolbar ? <div className="v2-toolbar-slot">{toolbar}</div> : null}
      </div>
      <main className={"v2-content content proj-main" + (loaded ? " is-flush" : "")} id="main" tabIndex={-1}>
        {list == null && error ? (
          <EmptyState
            tone="danger" title="Couldn't load projects" body={error}
            action={<Button onClick={() => void refresh()}>Retry</Button>}
          />
        ) : list == null ? (
          <Skeleton lines={6} label="Loading projects" />
        ) : !list.length ? (
          <EmptyState
            title="No projects yet"
            body="You're not a member of any project on this Embodent — create one, or ask an owner for an invite."
            action={<>
              <Button variant="secondary" onClick={() => setCreating(true)}>New project</Button>
              {signedIn ? <ButtonLink variant="ghost" href={SIGN_OUT_HREF} className="proj-signout">Sign out</ButtonLink> : null}
            </>}
          />
        ) : (
          <>
            <span className="v2-sr" id="projMeasure">{NEEDS_MEASURE}</span>
            {error ? (
              <p className="proj-stale" role="status">
                Couldn&#39;t refresh ({error}) — showing the list from {fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : "earlier"}.
              </p>
            ) : null}
            {!rows.length ? (
              <p className="proj-none" role="status">
                <span>{q.trim() ? <>No project matches “{q.trim()}”.</> : scope === "inactive" ? "No inactive projects." : "No active projects."}</span>
                {q.trim() || scope !== "all" ? (
                  <button type="button" className="proj-none-clear" id="projClear" onClick={() => { setQ(""); setScope("all"); }}>
                    {q.trim() ? "Clear filter" : "Show all projects"}
                  </button>
                ) : null}
              </p>
            ) : (
              <div className={"proj-table" + (stars ? " has-stars" : "")} role="table" aria-label="All projects" aria-describedby="projMeasure">
                <ColumnHeads sort={sort} onSort={(k) => setSort((cur) => nextSort(cur, k))} />
                {pinnedRows.length > 0 ? (
                  <>
                    <ListGroup
                      id="favorites" title="Favorites" count={pinnedRows.length} level={2} storageKey="orcha:v2:projGroups"
                      glyph={<Icon name="pin" cls="v2-ico" />}
                    >
                      <ul className="proj-list" role="rowgroup" aria-label="Favorite projects" aria-describedby="projMeasure">{pinnedRows.map(row)}</ul>
                    </ListGroup>
                    {otherRows.length > 0 ? (
                      <ListGroup
                        id="projects" title="Projects" count={otherRows.length} level={2} storageKey="orcha:v2:projGroups"
                        glyph={<Icon name="grid" cls="v2-ico" />}
                      >
                        <ul className="proj-list" role="rowgroup" id="projGrid" aria-label="Projects" aria-describedby="projMeasure">{otherRows.map(row)}</ul>
                      </ListGroup>
                    ) : null}
                  </>
                ) : (
                  <ul className="proj-list" role="rowgroup" id="projGrid" aria-label="Projects" aria-describedby="projMeasure">{otherRows.map(row)}</ul>
                )}
              </div>
            )}
          </>
        )}
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
