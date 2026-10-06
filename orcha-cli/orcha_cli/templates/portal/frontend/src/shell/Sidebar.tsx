/**
 * V2 persistent project sidebar — Linear layout (docs/orcha-v2-architecture.md §8,
 * Linear directives D1/D3/D5/D6/D7).
 *
 * Top → bottom (sits directly on the darkest canvas, no border — D5):
 *   1. Workspace row: Orcha mark + "Orcha ⌄" switcher (menu: acting identity,
 *      account items, All projects, New project, Settings, Help, collapse) and
 *      two CIRCULAR 28 px buttons — Search (⌘K, #globalSearch) and Compose
 *      (New task → /tasks?new=1; disabled with the reason when no acting human
 *      can act — the UI never impersonates a human).
 *   2. Inbox-style top items: Needs you (shared attention selector, current
 *      project) · All projects · Settings.
 *   3. "Favorites ▾" — pinned projects (local-only pin; the ⋯ menu adds/removes).
 *   4. "Projects ▾ +" — one row per project (D14 Orca tree): the project's
 *      chosen ICON (containers.icon via cloud/projects/projectIcons; neutral
 *      cube glyph when unset — never initials; status badge when not active),
 *      name, labeled attention count, ⋯ menu (favorite / change icon / local
 *      order / pair / settings). Clicking opens its Overview. Children, from
 *      real API data only: the primary checkout (any project), the branches
 *      shown agents work on, and the selected project's live agents (D11):
 *      status glyph, alias, ONE muted fragment (task · presence label from
 *      agents/presence.ts), capped at 3 with "+N more".
 *   6. Footer: plan usage (only when Settings › Interface › Plan usage is on;
 *      shell/PlanUsageRow) · acting identity (round avatar) · Help (circular) · rail toggle.
 * Section collapse state persists in `orcha:v2:sbSections` (SB_SECTIONS_KEY).
 *
 * Product directive D1: the sidebar does NOT repeat per-project sections
 * (Overview/Tasks/Agents/…); those live in the project tab bar under the
 * header (shell/nav.ts `projectSections()` is the one source).
 *
 * Counts are always labeled with what they measure: attention ≠ open work ≠
 * agent count. The current project's row shows the nav's attention count (one
 * selector); other projects' numbers come from GET /api/containers
 * `needs_you` as of the last fetch; a missing field is "unavailable"
 * (renders nothing), never 0.
 *
 * Width: 248 px default, 200–360 px resizable (orcha:v2:sidebarWidth → the
 * inline --v2-sidebar-user-w; CSS derives --v2-sidebar-w from it so the
 * collapsed rail rule always wins), and a 56 px icon rail when collapsed
 * (legacy orcha:sidebar + <html data-sidebar>; `[` toggles it, like Linear).
 * Below 900 px it becomes a drawer (<html data-drawer="open">).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Icon, OrcaMark } from "../components/ui";
import { Avatar as V2Avatar, actorKey } from "../components/primitives/Avatar";
import { ProjectIcon } from "../components/primitives/ProjectIcon";
import { ProjectIconPicker } from "../components/primitives/EmojiPicker";
import { useProjectIconAuthority } from "../components/primitives/projectIconAuthority";
import { StatusGlyph } from "../components/primitives/StatusIcon";
import { Button } from "../components/primitives/Button";
import { Menu, type MenuItemSpec } from "../components/primitives/Menu";
import { Tooltip } from "../components/primitives/Tooltip";
import { extensions } from "../extensions";
import { SIGN_OUT_HREF, fetchMe } from "../cloud/identity";
import { useProxySession } from "../state/session";
import { PairingModal } from "../cloud/projects/PairingModal";
import * as prefs from "../cloud/projects/prefs";
import { NewProjectModal } from "../cloud/projects/NewProjectModal";
import { attentionLabel, selectAttention, useAttention, type Attention } from "../state/attention";
import { trapTab, focusables, isEditingTarget, isEditorOrTerminal } from "../components/primitives/focus";
import {
  moveBounds,
  moveProject,
  pinnedProjects,
  togglePinned,
  useProjectPrefsVersion,
  useProjects,
  type ProjectRow,
} from "../state/projects";
import { snapshotErrorKind, useActingAuthority, useSnapshot } from "../state/SnapshotProvider";
import type { Snapshot } from "../types";
import { projectSwitchHref, switchProject } from "../lib/scope";
import { relTime } from "../lib/format";
import { agentPresence } from "../pages/agents/presence";
import { useChrome } from "./chrome";
import { PlanUsageRow } from "./PlanUsageRow";
import { projectAgents, remoteProjectAgents, type ProjectAgentRow } from "./liveAgents";
import { COMPOSE_HREF, GLOBAL_SECTIONS, HELP_HREF, NEEDS_ICON, RAIL_TOGGLE_KEY, agentPaletteSlots, projectSections, sidebarProjectRows } from "./nav";
import { NEEDS_HREF } from "./optionalPages";
import { isSectionHidden, useProjectMode } from "../lib/projectMode";

/* ---- width / collapse prefs ---------------------------------------------- */
export const SIDEBAR_KEY = "orcha:sidebar";
export const SIDEBAR_W_KEY = "orcha:v2:sidebarWidth";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 360;
/** D14: 264 px so the Orca tree (branch → agent rows) reads without cramped text */
export const SIDEBAR_DEFAULT = 264;
/** inline custom property carrying the user's dragged width (never the rail) */
export const SIDEBAR_USER_VAR = "--v2-sidebar-user-w";
/** per-section collapse state ({favorites, projects}: true = collapsed) */
export const SB_SECTIONS_KEY = "orcha:v2:sbSections";

export function sidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === "collapsed"; } catch { return false; }
}
export function setSidebarCollapsed(collapsed: boolean, persist = true): void {
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded"); } catch { /* private mode */ }
  const d = document.documentElement;
  if (collapsed) d.setAttribute("data-sidebar", "collapsed");
  else d.removeAttribute("data-sidebar");
  // signed-in cloud users: mirror the choice into the server prefs bag, or the
  // next load's prefs.sync (server wins) silently undoes it (IF-RAIL-COLLAPSE).
  // No-op on self-host / trust-off (prefs inactive → localStorage only).
  if (persist) prefs.queuePut();
}
export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}
function readWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_W_KEY);
    return v == null ? SIDEBAR_DEFAULT : clampSidebarWidth(Number(v));
  } catch { return SIDEBAR_DEFAULT; }
}
/**
 * The user width lives in its own variable so it can never override the
 * collapsed rail (QA blocker: an inline --v2-sidebar-w beat
 * html[data-sidebar=collapsed] and the "rail" stayed 248 px wide).
 */
export function applyWidth(w: number, persist: boolean) {
  const s = document.documentElement.style;
  s.removeProperty("--v2-sidebar-w"); // legacy inline value from older builds
  s.setProperty(SIDEBAR_USER_VAR, w + "px");
  if (persist) try { localStorage.setItem(SIDEBAR_W_KEY, String(w)); } catch { /* private mode */ }
}

export type SidebarSection = "favorites" | "projects";
export function readSections(): Partial<Record<SidebarSection, boolean>> {
  try {
    const v = JSON.parse(localStorage.getItem(SB_SECTIONS_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
function useSectionState(): [Partial<Record<SidebarSection, boolean>>, (k: SidebarSection) => void] {
  const [s, set] = useState(readSections);
  const toggle = useCallback((k: SidebarSection) => {
    set((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      try { localStorage.setItem(SB_SECTIONS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);
  return [s, toggle];
}

/**
 * ONE attention definition everywhere (review N1: the nav said 8, the current
 * project row 6, other pages 5). The project row uses the SAME selector as the
 * "Needs you" nav, the Overview band and the header bell (state/attention
 * `selectAttention`): plan approvals included, reviews / requests assigned to
 * another human excluded. Returns null without a snapshot (unknown ≠ 0).
 * Other projects' rows show the server's GET /api/containers `needs_you`.
 */
export function projectNeedsYou(snap: Snapshot | null, actingHumanId: string | null = null): number | null {
  if (!snap) return null;
  return selectAttention(snap, actingHumanId).count;
}

/* D11/D14: per-project tree disclosure, remembered (id → true = collapsed,
 * false = explicitly open). Default: the selected project open, the others
 * closed (their caret appears once a checkout is known). */
export const SB_PROJ_AGENTS_KEY = "orcha:v2:sbProjAgents";
/** D11 cap — the same in the drawer (one tree at every width; wave-4 review) */
const PROJECT_AGENTS_CAP = 3;
function useProjectAgentsOpen(id: string, defaultOpen = true): [boolean, () => void] {
  // the stored choice (true = collapsed) wins; otherwise the default is read
  // at RENDER time — the row mounts before the scope resolves, and the
  // selected project must still open once it is known to be selected
  const read = (): boolean | undefined => {
    try {
      const v = (JSON.parse(localStorage.getItem(SB_PROJ_AGENTS_KEY) || "{}") || {})[id];
      return typeof v === "boolean" ? v : undefined;
    } catch { return undefined; }
  };
  const [closed, setClosed] = useState(read);
  const open = closed === undefined ? defaultOpen : !closed;
  const toggle = useCallback(() => {
    const next = open; // collapsed after this toggle ⇔ it was open
    setClosed(next);
    try {
      const m = JSON.parse(localStorage.getItem(SB_PROJ_AGENTS_KEY) || "{}") || {};
      m[id] = next;
      localStorage.setItem(SB_PROJ_AGENTS_KEY, JSON.stringify(m));
    } catch { /* private mode */ }
  }, [id, open]);
  return [open, toggle];
}

/* session memory so a remount (no-frame fallback) keeps the scroll position */
let scrollMemo = 0;

function statusLabel(s: string | null | undefined): string {
  if (!s) return "Status unknown";
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}
function timeLabel(ms: number | null): string {
  if (!ms) return "";
  try { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}
/** Badge text: counts are capped so they never squeeze the project name. */
export function capCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}
/** Compact age for single-line rows: "5m ago" → "5m" is NOT done — the words stay (tests + clarity). */
function shortAgo(iso: string | null | undefined): string {
  return iso ? relTime(iso) : "";
}

/* ---- small inline glyphs not in the shared Icon set ----------------------- */
function ComposeGlyph() {
  return (
    <svg className="v2-ico" viewBox="0 0 20 20" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3" />
      <path d="M14.2 3.3a1.5 1.5 0 0 1 2.1 2.1L10.5 11.2 8 12l.8-2.5z" />
    </svg>
  );
}
function Caret({ open }: { open: boolean }) {
  return (
    <svg className={"v2-sb-caret" + (open ? "" : " is-closed")} viewBox="0 0 10 10" width={9} height={9} aria-hidden="true">
      <path d="M2 3.5h6L5 7z" fill="currentColor" />
    </svg>
  );
}

/* ---- D14: Orca-style project tree (branch / checkout rows → agents) -------
 * Built ONLY from data the backend already exposes — nothing is invented:
 *   · primary checkout: GET /api/containers/{cid}/code/worktree/branch
 *     ({available, branch, remote}; local-bound projects only)
 *   · an agent's branch: its latest worker run's `branch`
 *     (GET /api/agents/{id}/runs?limit=1 — worker_runs.branch, the worktree branch)
 *   · a PR on a branch: GET /api/containers/{cid}/github/pulls → `head` === branch
 *   · the repo line: the project's `github_repo` (or the checkout's origin remote)
 * A non-primary branch row appears only when a SHOWN agent works on it; agents
 * with no known branch nest directly under the project (D11 rules unchanged:
 * live / relevant agents only, cap, "+N more").                              */
export interface CheckoutInfo { branch: string; primary: boolean; repo: string | null; pr: { number: number; url: string } | null }
export interface CheckoutNode { checkout: CheckoutInfo; agents: ProjectAgentRow[] }
export interface ProjectTree { checkouts: CheckoutNode[]; loose: ProjectAgentRow[]; more: number; hasChildren: boolean }

/** owner/name from a git remote URL (https or ssh); null when it isn't one. */
export function repoFromRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function buildProjectTree(opts: {
  primary: { branch: string; repo: string | null } | null;
  agents: ProjectAgentRow[];
  more: number;
  /** agent alias → its run branch (undefined = not loaded / unknown) */
  branchOf: Map<string, string | null | undefined>;
  repo: string | null;
  prs?: Map<string, { number: number; url: string }>;
  /** the project runs every agent in the main checkout (container.worktrees_disabled) */
  mainCheckoutOnly?: boolean;
}): ProjectTree {
  const { primary, agents, more, branchOf, repo, prs, mainCheckoutOnly } = opts;
  const pr = (b: string) => prs?.get(b) ?? null;
  const nodes = new Map<string, CheckoutNode>();
  if (primary) nodes.set(primary.branch, { checkout: { branch: primary.branch, primary: true, repo: primary.repo ?? repo, pr: pr(primary.branch) }, agents: [] });
  const loose: ProjectAgentRow[] = [];
  for (const a of agents) {
    const b = branchOf.get(a.alias);
    const branch = b || (mainCheckoutOnly && primary ? primary.branch : null);
    if (!branch) { loose.push(a); continue; }
    let n = nodes.get(branch);
    if (!n) { n = { checkout: { branch, primary: false, repo, pr: pr(branch) }, agents: [] }; nodes.set(branch, n); }
    n.agents.push(a);
  }
  const checkouts = [...nodes.values()].sort((x, y) => Number(y.checkout.primary) - Number(x.checkout.primary));
  return { checkouts, loose, more, hasChildren: checkouts.length > 0 || loose.length > 0 };
}

/**
 * Middle ellipsis for branch names (wave-4 review): the head yields, the tail
 * stays, so "feat/dark-tokens-and-collapsed-rail" reads "feat/dark-t…collapsed-rail"
 * instead of "feat/dark-tokens-…". The tail is the longest separator-led
 * suffix of ≤ 16 chars (else the last 12); names ≤ 18 chars are not split.
 * head + tail === branch.
 */
export function splitBranch(branch: string): [string, string] {
  if (branch.length <= 18) return [branch, ""];
  // the longest suffix that starts at a separator and is ≤ 16 chars
  let at = -1;
  for (let i = branch.length - 1; i > 0; i--) {
    if (branch.length - i > 16) break;
    if ("/-_.".includes(branch[i])) at = i;
  }
  if (at < 0 || branch.length - at < 4) at = branch.length - 12;
  return [branch.slice(0, at), branch.slice(at)];
}

/** Compact right-aligned age ("now", "5m", "3h", "2d") — the desktop's format. */
export function compactAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

const TREE_TTL_MS = 5 * 60_000;
type Cached<T> = { at: number; v: T; p?: Promise<T> };
const primaryCache = new Map<string, Cached<{ branch: string; repo: string | null } | null>>();
const pullsCache = new Map<string, Cached<Map<string, { number: number; url: string }>>>();
const runBranchCache = new Map<string, Cached<string | null>>();
/** test hook */
export function _resetTreeCachesForTests(): void { primaryCache.clear(); pullsCache.clear(); runBranchCache.clear(); }

function getJson(url: string): Promise<unknown> {
  if (typeof fetch !== "function") return Promise.resolve(null);
  try {
    return Promise.resolve(fetch(url, { headers: { Accept: "application/json" } }))
      .then((r) => (r && r.ok ? r.json() : null)).catch(() => null);
  } catch { return Promise.resolve(null); }
}
/** Tiny TTL cache + single-flight; `bump` re-renders the caller when a value lands. */
function cached<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>, fallback: T, bump: () => void, ttl = TREE_TTL_MS): T {
  const c = cache.get(key);
  if (c && (c.p || Date.now() - c.at < ttl)) {
    if (c.p) void c.p.then(bump);
    return c.v;
  }
  const entry: Cached<T> = { at: Date.now(), v: c ? c.v : fallback };
  entry.p = load().then((v) => { entry.v = v; entry.at = Date.now(); entry.p = undefined; return v; });
  cache.set(key, entry);
  void entry.p.then(bump);
  return entry.v;
}

function useTreeData(cid: string, enabled: boolean, row: ProjectRow, agents: ProjectAgentRow[]) {
  const [, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const bump = useCallback(() => { if (alive.current) setTick((t) => t + 1); }, []);
  const repoField = row.github_repo && row.github_repo !== "local" ? row.github_repo : null;
  const primary = enabled
    ? cached(primaryCache, cid, () => getJson(`/api/containers/${encodeURIComponent(cid)}/code/worktree/branch`).then((d) => {
      const b = d as { available?: boolean; branch?: string | null; remote?: string | null } | null;
      return b && b.available && b.branch ? { branch: b.branch, repo: repoFromRemote(b.remote) } : null;
    }), null, bump)
    : null;
  const branchOf = new Map<string, string | null | undefined>();
  if (enabled) {
    for (const a of agents) {
      const id = a.agent.id;
      if (!id) continue;
      const key = `${id}:${a.agent.active_run?.run_id ?? a.status}`;
      branchOf.set(a.alias, cached(runBranchCache, key, () => getJson(`/api/agents/${encodeURIComponent(id)}/runs?limit=1`).then((d) => {
        const r = (d as { runs?: { branch?: string | null }[] } | null)?.runs?.[0];
        return r && typeof r.branch === "string" && r.branch ? r.branch : null;
      }), null, bump, 60_000));
    }
  }
  const hasBranch = !!primary || [...branchOf.values()].some(Boolean);
  const prs = enabled && repoField && hasBranch
    ? cached(pullsCache, cid, () => getJson(`/api/containers/${encodeURIComponent(cid)}/github/pulls`).then((d) => {
      const m = new Map<string, { number: number; url: string }>();
      for (const p of ((d as { pulls?: { head?: string | null; number?: number; html_url?: string }[] } | null)?.pulls ?? [])) {
        if (p.head && typeof p.number === "number" && p.html_url && !m.has(p.head)) m.set(p.head, { number: p.number, url: p.html_url });
      }
      return m;
    }), new Map(), bump)
    : undefined;
  return { primary, branchOf, prs, repo: repoField };
}

/* ---- project row glyphs ---------------------------------------------------- */
function BranchGlyph() {
  return (
    <svg className="v2-sb-br-ico" viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 2.6-2.4 3.2-5.6 4.4" />
    </svg>
  );
}
function BranchName({ branch }: { branch: string }) {
  const [head, tail] = splitBranch(branch);
  return (
    <span className="v2-sb-br-name">
      <span className="v2-sb-br-head">{head}</span>
      {tail ? <span className="v2-sb-br-tail">{tail}</span> : null}
    </span>
  );
}
function PrGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="12.5" r="1.5" />
      <path d="M4 5v6M12 11V6.5A2 2 0 0 0 10 4.5H7.5M9 3 7.5 4.5 9 6" />
    </svg>
  );
}

/* ---- acting identity ------------------------------------------------------- */
/**
 * Why there is no snapshot, told apart from a real outage (brief §3: missing ≠
 * disconnected ≠ unknown). The provider's error carries the HTTP status
 * ("<url> → 403"); a 401/403/404 answer means Orcha is reachable.
 */
export type NoSnapReason = "no-project" | "not-member" | "not-found" | "offline" | null;
export function noSnapReason(o: { snap: unknown; cid: string | null; error: string | null; connection: string; identityTrusted: boolean; hasIdentity: boolean }): NoSnapReason {
  if (o.snap) return null;
  if (o.error === "no container found") return "no-project"; // zero projects: nothing to load
  if (!o.cid) return null; // still resolving the scope
  // PS-30: share the SnapshotProvider classifier — a 400 / 422 (malformed cid)
  // is "project not found", never "identity unknown (offline)".
  const kind = o.error ? snapshotErrorKind(o.error) : null;
  if (kind === "forbidden") return "not-member";
  if (kind === "not_found") return "not-found";
  if (o.identityTrusted && !o.hasIdentity) return "not-member";
  return o.connection === "offline" ? "offline" : null;
}

function useWho() {
  const { identity, connection, snap, cid, error, identityTrusted } = useSnapshot();
  const authority = useActingAuthority();
  const who = authority.human;
  const why = noSnapReason({ snap, cid, error, connection, identityTrusted, hasIdentity: !!identity });
  const label = who ? who.alias : identity ? identity.alias || identity.github_login || "account" : null;
  const gh = who ? who.github_login : identity?.github_login;
  // SH-077 / SH-123: a signed-in non-member (or an unknown project) is NOT offline
  const noSnapText = why === "not-member" ? "not a member"
    : why === "not-found" ? "project not found"
      : why === "no-project" ? "no project open"
        : why === "offline" ? "identity unknown (offline)" : null;
  const whoText = authority.pending
    ? "resolving identity…"
    : authority.unverified && !label
      ? "identity unconfirmed (retrying)"
      : label
        ? label + (authority.readOnly ? " · view-only" : "")
        : noSnapText ?? (authority.readOnly ? "view-only" : "no human registered");
  const title = authority.pending
    ? "Resolving your identity — actions stay disabled until it answers"
    : !label && why === "not-member"
      ? "You're signed in but not a member of this project — ask an owner for an invite; actions are disabled"
      : !label && why === "not-found"
        ? "This project wasn't found — it may have been removed; actions are disabled"
        : !label && why === "no-project"
          ? "No project is open — pick or create one in All projects"
          : authority.readOnly
            ? `${label ? label + " — " : ""}${authority.reason ?? "view-only"}; actions are disabled`
            : label ? `Acting as ${label} — the human authority on this project`
              : why === "offline" ? "Identity unknown while offline — actions are disabled" : "No human registered — actions are disabled";
  return { authority, label, gh, whoText, title, identity, why };
}

/** Footer identity row: round avatar + who + "acting as"/"viewing as"; opens the account menu when extensions provide one. */
function AccountButton({ collapsed }: { collapsed: boolean }) {
  const { authority, label, whoText, title, identity } = useWho();
  const { snap } = useSnapshot();
  // D13: the acting human takes the SAME palette slot as on the Agents board /
  // roster (all of snap.agents in snapshot order), so one person is one colour
  const slot = useMemo(() => (label ? agentPaletteSlots(snap).get(actorKey(label)) : undefined), [snap, label]);
  const baseItems = extensions.accountMenu ? extensions.accountMenu(identity) : [];
  // parity r3: zero memberships = no cid = no /api/me, so the menu above can't
  // know there is a sign-in — yet Sign out must stay reachable. Ask the proxy.
  const { list: projectList } = useProjects();
  const noProjects = !!extensions.accountMenu && !baseItems.length && projectList != null && projectList.length === 0;
  const session = useProxySession(noProjects);
  const items = noProjects && session ? [{ label: "Sign out", href: SIGN_OUT_HREF, danger: true }] : baseItems;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const body = (
    <>
      {/* D13 (review r3): ONE source for the acting identity — the palette-seeded
          circle on every project, never a GitHub identicon on some and a letter on others */}
      {label ? <V2Avatar alias={label} kind="human" size={20} palette={slot} decorative /> : <span className="v2-av-empty" aria-hidden="true" />}
      {!collapsed && (
        <span className="v2-sb-acct-text">
          {label && !authority.pending ? (
            <span className="v2-sb-acct-lbl">{authority.readOnly ? "Viewing as" : "Acting as"}</span>
          ) : null}
          <span className="v2-sb-acct-who" id="actingWho">
            {authority.pending
              ? <span className="v2-muted">resolving identity…</span>
              : label
                ? <>{label}{authority.readOnly ? <span className="v2-muted"> · view-only</span> : null}</>
                : <span className="v2-muted">{whoText}</span>}
          </span>
        </span>
      )}
    </>
  );
  if (!items.length) {
    return (
      <Tooltip label={title} placement={collapsed ? "right" : "top"}>
        <div className="v2-sb-acct" aria-label={title} tabIndex={collapsed ? 0 : undefined}>{body}</div>
      </Tooltip>
    );
  }
  return (
    <>
      <Tooltip label={collapsed ? `${title} · account menu` : title} placement={collapsed ? "right" : "top"}>
        <button ref={ref} type="button" className="v2-sb-acct is-button" aria-label={`Account: ${whoText}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {body}
        </button>
      </Tooltip>
      <Menu
        anchor={ref} open={open} onClose={() => setOpen(false)} label="Account" placement={collapsed ? "right-start" : "bottom-start"}
        items={items.map((it) => ({ label: it.label, href: it.href, onSelect: it.onClick, danger: it.danger }))}
      />
    </>
  );
}

/* ---- workspace switcher (Linear "Linear ⌄") -------------------------------- */
function WorkspaceSwitcher({ collapsed, onToggleRail, onNewProject }: { collapsed: boolean; onToggleRail: () => void; onNewProject: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const { authority, label, whoText, title } = useWho();
  const identityLine = authority.pending || !label
    ? whoText.charAt(0).toUpperCase() + whoText.slice(1)
    : (authority.readOnly ? "Viewing as " : "Acting as ") + whoText;
  const items: (MenuItemSpec | "separator")[] = [
    { label: identityLine, icon: "person", disabled: true, disabledReason: title },
    "separator",
    { label: "All projects", icon: "grid", href: "/projects" },
    { label: "New project…", icon: "plus", onSelect: onNewProject },
    { label: "Settings", icon: "settings", href: "/settings" },
    { label: "Help & docs", icon: "help", href: HELP_HREF },
    "separator",
    { label: collapsed ? "Expand sidebar" : "Collapse sidebar", icon: "sidebar", hint: RAIL_TOGGLE_KEY, onSelect: onToggleRail },
  ];
  return (
    <>
      <Tooltip label="Embodent workspace" placement={collapsed ? "right" : "bottom"} disabled={!collapsed}>
        <button
          ref={ref} type="button" className="v2-sb-switch" aria-haspopup="menu" aria-expanded={open}
          aria-label="Embodent workspace menu" onClick={() => setOpen((v) => !v)}
        >
          <span className="v2-sb-mark"><OrcaMark /></span>
          {!collapsed && <span className="v2-sb-word">Embodent</span>}
          {!collapsed && <Icon name="chev" cls="v2-ico v2-chev" />}
        </button>
      </Tooltip>
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} items={items} label="Embodent workspace" placement={collapsed ? "right-start" : "bottom-start"} />
    </>
  );
}

/* ---- project row ------------------------------------------------------------ */
function ProjectMenu({ row, rows, selected, anchor, open, onClose, onPair, onChangeIcon }: {
  row: ProjectRow; rows: ProjectRow[]; selected: boolean; anchor: RefObject<HTMLButtonElement | null>;
  open: boolean; onClose: () => void; onPair: () => void; onChangeIcon: () => void;
}) {
  const pinned = pinnedProjects().includes(row.id);
  const can = moveBounds(rows, row.id);
  // D14 / e2e-permissions-7: the icon write is owner / manage_autonomy only
  // (trust off open) — say so here instead of offering a pick that 403s.
  // While the other project's /api/me is in flight the item stays enabled
  // (the picker re-checks and shows the reason).
  const iconAuth = useProjectIconAuthority(row.id, open);
  const iconBlocked = !iconAuth.pending && !iconAuth.canEdit;
  const items: (MenuItemSpec | "separator")[] = [
    { label: "Open overview", icon: "home", href: selected ? "/" : projectSwitchHref(row.id, "/", "") },
    { label: pinned ? "Remove from favorites" : "Add to favorites", icon: "pin", onSelect: () => togglePinned(row.id) },
    { label: "Change icon…", icon: "spark", onSelect: onChangeIcon,
      disabled: iconBlocked, disabledReason: iconBlocked ? iconAuth.reason || "You can't change this project's icon" : undefined },
    { label: "Move up", icon: "arrow-up", onSelect: () => moveProject(rows, row.id, -1),
      disabled: !can.up, disabledReason: !can.up ? `Already first${pinned ? " among favorites" : ""}` : undefined },
    { label: "Move down", icon: "arrow-down", onSelect: () => moveProject(rows, row.id, 1),
      disabled: !can.down, disabledReason: !can.down ? `Already last${pinned ? " among favorites" : ""}` : undefined },
    "separator",
    { label: "Pair phone…", icon: "phone", onSelect: onPair },
    { label: "Project settings", icon: "settings", href: selected ? "/settings" : undefined, onSelect: selected ? undefined : () => switchProject(row.id, "/settings") },
  ];
  return <Menu anchor={anchor} open={open} onClose={onClose} items={items} label={`${row.name || "Project"} actions`} placement="bottom-end" />;
}

function ProjectItem({ row, rows, selected, fetchedAt, collapsed, attention, offline, agentSlots, agentCap = PROJECT_AGENTS_CAP }: {
  row: ProjectRow; rows: ProjectRow[]; selected: boolean; fetchedAt: number | null; collapsed: boolean;
  /** nested live-agent cap (D11: 3) */
  agentCap?: number;
  /** D13 agent palette for the current project (same slots as the Agents board) */
  agentSlots?: Map<string, number>;
  /** the shared selector result, computed ONCE by <Sidebar> (only the selected row uses it) */
  attention: Attention | null;
  offline: boolean;
}) {
  const { snap } = useSnapshot();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [pairing, setPairing] = useState<{ identity: { github_login?: string | null } | null } | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  // (the pairing dialog moves focus into itself on open — PairingModal)
  const name = row.name || (selected ? snap?.container?.name : null) || (offline ? "Project unavailable" : "Untitled project");
  // D11: the project's live agents nest under its row. Only the selected
  // project has a snapshot, so only it can show them (never invented).
  // Parity r2: another project's working agents come from the list's
  // `live_agents` (backend applies the snapshot's rule) — still never invented.
  const remote = !selected && !collapsed && (row.live_agents?.length ?? 0) > 0
    ? remoteProjectAgents(row.live_agents, row.live_agents_total, agentCap)
    : null;
  const live = selected && !collapsed ? projectAgents(snap, agentCap, shortAgo) : remote;
  const [open, toggleOpen] = useProjectAgentsOpen(row.id, selected);
  // D14: branch / checkout rows from real API data. The selected project
  // loads at once; another project probes its primary checkout the first time
  // its row is hovered / focused (then the 5-min cache keeps it), so a caret
  // appears whenever it has children without N background requests per page.
  const [probe, setProbe] = useState(() => primaryCache.has(row.id));
  const wake = () => { if (!probe && !selected && !collapsed) setProbe(true); };
  // remote rows have no agent id → no per-agent run-branch lookups (they sit loose)
  const tree = useTreeData(row.id, !collapsed && (selected || probe), row, selected ? live?.rows ?? [] : []);
  const t = live || tree.primary
    ? buildProjectTree({
      primary: tree.primary, agents: live?.rows ?? [], more: live?.more ?? 0, branchOf: tree.branchOf,
      repo: tree.repo, prs: tree.prs, mainCheckoutOnly: !!snap?.container?.worktrees_disabled,
    })
    : null;
  const hasChildren = !!t?.hasChildren;
  // only the selected project's mode is read (one fetch); General hides the Code link
  const rowMode = useProjectMode(selected ? row.id : null).mode;
  const codeHref = projectSections().some((x) => x.key === "code") && !isSectionHidden("code", rowMode) ? "/code" : null;

  // ONE definition (N1): the current row shows exactly the nav's attention
  // count (shared selector, optimistic decisions applied); other rows show the
  // server's per-project count as of the last list fetch.
  const live_n = selected && attention && !attention.readOnly ? attention.count : null;
  const partial = selected && !!attention?.partial;
  const n = live_n ?? row.needs_you;
  let countEl: ReactNode = null;
  let countText: string | null = null; // rail dot (the number stays in the tooltip)
  let countSummary = ""; // accessible name + tooltip
  if (selected && attention?.readOnly) {
    countSummary = "view-only: no decisions here are yours to make";
  } else if (n == null) {
    countSummary = "pending decisions unavailable for this project";
    // a missing measure renders NOTHING in the count column (never a bare "–"
    // or a fake 0); the marker keeps the unavailable state inspectable.
    countEl = <span className="v2-sb-attn is-unknown" aria-hidden="true" data-unavailable="" />;
  } else if (n > 0) {
    countText = capCount(n) + (partial && n <= 99 ? "+" : "");
    const asOf = live_n == null && fetchedAt ? " · as of " + timeLabel(fetchedAt) : "";
    countSummary = `${n}${partial ? "+" : ""} decision${n === 1 ? "" : "s"} waiting on you${asOf}`;
    countEl = <span className="v2-sb-attn" aria-hidden="true">{countText}</span>;
  }

  const rawStatus = row.status ?? (selected ? snap?.container?.status : null);
  const statusText = statusLabel(rawStatus);
  const onOverview = selected && location.pathname === "/";
  const a11yName = `${name}, ${statusText}${countSummary ? ", " + countSummary : ""}${selected ? ", current project" : ""}`;
  const tip = (
    <span className="v2-sb-tip">
      <strong>{name}</strong>
      <span className="v2-sb-tip-meta">{statusText}{selected ? " · current project" : " · switch project"}</span>
      {countSummary ? <span className="v2-sb-tip-meta">{countSummary.charAt(0).toUpperCase() + countSummary.slice(1)}</span> : null}
    </span>
  );
  const inner = (
    <>
      <ProjectIcon cid={row.id} size={collapsed ? 20 : 18} status={rawStatus} badge={collapsed && countText ? countText : null} className="v2-sb-picon" />
      {!collapsed && <span className="v2-sb-proj-name">{name}</span>}
    </>
  );

  const agentRow = (a: ProjectAgentRow) => {
    // one presence function (agents/presence.ts) on every surface: the label
    // here reads exactly what the agent workspace header reads. Another
    // project's row has no snapshot here — its label is the list's own state.
    // VD-09: awaiting_request (no running run) is the roster's neutral "Waiting" here too.
    const remoteWaiting = !selected && a.state === "working" && a.fragment === "waiting" && a.status === "awaiting_request";
    const p = selected ? agentPresence(a.agent, { snap })
      : remoteWaiting ? { k: "waiting", label: "Waiting" }
      : { k: a.state === "review" ? "needs" : "working", label: a.state === "review" ? "Needs review" : "Working" };
    const st = p.label;
    const attn = p.k === "needs" || p.k === "blocked" || p.k === "failed";
    // review F15: a WORKING agent shows its task (or "working"), never an age
    const task = a.agent.active_run?.task_title || a.agent.current_task?.title || null;
    const fragment = attn ? p.label.toLowerCase() : remoteWaiting ? "waiting" : a.state === "working" ? task || "working" : a.fragment;
    const tipMeta = fragment.toLowerCase() === st.toLowerCase() ? st : `${st} · ${fragment}`;
    const glyphStatus = remoteWaiting ? a.status : a.state === "working" ? "in_progress" : a.status;
    const ago = compactAgo(a.agent.active_run?.started_at || a.agent.last_active);
    const agentBody = (
      <>
        <StatusGlyph status={glyphStatus} size={12} className="v2-sb-agent-glyph" />
        <V2Avatar alias={a.alias} kind="ai" size={16} palette={selected ? agentSlots?.get(actorKey(a.alias)) : undefined} decorative className="v2-sb-agent-av" />
        <span className="v2-sb-agent-name">{a.alias}</span>
        <span className="v2-sb-agent-task">{fragment}</span>
        {ago ? <span className="v2-sb-agent-age" aria-hidden="true">{ago}</span> : null}
      </>
    );
    return (
      <li key={a.alias}>
        <Tooltip label={<span className="v2-sb-tip"><strong>{a.alias}</strong><span className="v2-sb-tip-meta">{tipMeta}</span></span>} placement="right" delay={600}>
          {selected ? (
            <Link
              to={"/agents?agent=" + encodeURIComponent(a.alias) + "&tab=conversation"}
              className={"v2-sb-agent is-" + a.state + (a.alias.length > 12 ? " has-long-name" : "")} data-v2-navrow=""
              aria-label={`${a.alias}, ${tipMeta.replace(" · ", ", ")}`}
            >{agentBody}</Link>
          ) : (
            // another project: full navigation switches project (no state crosses)
            <a
              href={"/agents?cid=" + encodeURIComponent(row.id) + "&agent=" + encodeURIComponent(a.alias) + "&tab=conversation"}
              className={"v2-sb-agent is-" + a.state + (a.alias.length > 12 ? " has-long-name" : "")} data-v2-navrow=""
              aria-label={`${a.alias} in ${name}, ${tipMeta.replace(" · ", ", ")}`}
            >{agentBody}</a>
          )}
        </Tooltip>
      </li>
    );
  };
  const checkoutRow = (node: CheckoutNode, i: number) => {
    const c = node.checkout;
    // D12: the repo is one fact — shown once, under the first (primary)
    // checkout, and only when it isn't the project's own repo (then the row
    // above already says it and the branch name gets the width)
    const repoLine = i === 0 && c.repo && c.repo !== tree.repo ? c.repo : null;
    const title = `${c.branch}${c.primary ? " — primary checkout" : ""}${c.repo ? " · " + c.repo : ""}`;
    const body = (
      <>
        <BranchGlyph />
        <span className="v2-sb-br-text">
          <span className="v2-sb-br-line">
            <BranchName branch={c.branch} />
            {c.primary ? <span className="v2-sb-br-badge">primary</span> : null}
          </span>
          {repoLine ? <span className="v2-sb-br-repo">{repoLine}</span> : null}
        </span>
      </>
    );
    return (
      <li key={"b:" + c.branch} className="v2-sb-br">
        <div className="v2-sb-br-row">
          <Tooltip label={title} placement="right" delay={600}>
            {c.primary && codeHref
              ? <Link to={codeHref} className="v2-sb-br-main" data-v2-navrow="" aria-label={`${title}, open Code`}>{body}</Link>
              : <div className="v2-sb-br-main" aria-label={title} role="group">{body}</div>}
          </Tooltip>
          {c.pr ? (
            <Tooltip label={`Pull request #${c.pr.number} (opens GitHub)`} placement="right">
              <a className="v2-sb-br-pr" href={c.pr.url} target="_blank" rel="noreferrer" aria-label={`Pull request #${c.pr.number} for ${c.branch}`}>
                <PrGlyph />
              </a>
            </Tooltip>
          ) : null}
        </div>
        {node.agents.length ? <ul className="v2-sb-tree-agents">{node.agents.map(agentRow)}</ul> : null}
      </li>
    );
  };

  return (
    <li className={"v2-sb-proj" + (selected ? " is-selected" : "") + (hasChildren && open ? " has-tree" : "")} data-proj={row.id}
      onPointerEnter={wake} onFocusCapture={wake}>
      <div className="v2-sb-proj-row">
        {!collapsed && (
          <span className="v2-sb-gutter">
            {hasChildren ? (
              <button
                type="button" className="v2-sb-proj-caret" aria-expanded={open}
                aria-controls={`sb-pa-${row.id}`} aria-label={`${open ? "Hide" : "Show"} ${!t?.checkouts.length ? "live agents" : selected || live?.rows.length ? "branches and live agents" : "branches"} in ${name}`}
                onClick={toggleOpen}
              >
                <Caret open={open} />
              </button>
            ) : null}
          </span>
        )}
        <Tooltip label={tip} placement="right" delay={collapsed ? 200 : 700}>
          {selected ? (
            <Link
              to="/" className="v2-sb-proj-link" aria-label={a11yName}
              aria-current={onOverview ? "page" : "true"} data-v2-navrow=""
            >{inner}</Link>
          ) : (
            // full navigation switches project (no state crosses) → its Overview
            <a className="v2-sb-proj-link" href={projectSwitchHref(row.id, "/", "")} aria-label={a11yName} data-v2-navrow="">{inner}</a>
          )}
        </Tooltip>
        {!collapsed && countEl}
        {!collapsed && (
          <button ref={menuRef} type="button" className="v2-sb-more" aria-haspopup="menu" aria-expanded={menuOpen || iconOpen}
            aria-label={`${name} actions`} onClick={() => setMenuOpen((v) => !v)}>
            <Icon name="more" cls="v2-ico" />
          </button>
        )}
      </div>
      {hasChildren && open && t ? (
        <ul className="v2-sb-tree v2-sb-proj-agents" id={`sb-pa-${row.id}`} aria-label={!t.checkouts.length ? `Live agents in ${name}` : selected || live?.rows.length ? `Branches and live agents in ${name}` : `Branches in ${name}`}>
          {/* agents with no known branch belong to the PROJECT: they sit
              directly under its row, before the branch groups, so they never
              read as children of the last branch (wave-4 review) */}
          {t.loose.map(agentRow)}
          {t.checkouts.map(checkoutRow)}
          {t.more > 0 ? (
            <li>
              {selected
                ? <Link to="/agents" className="v2-sb-viewall" data-v2-navrow="">+{t.more} more</Link>
                : <a href={"/agents?cid=" + encodeURIComponent(row.id)} className="v2-sb-viewall" data-v2-navrow="">+{t.more} more</a>}
            </li>
          ) : null}
        </ul>
      ) : null}
      <ProjectMenu
        row={row} rows={rows} selected={selected} anchor={menuRef} open={menuOpen} onClose={() => setMenuOpen(false)}
        onPair={() => { void fetchMe(row.id).then((m) => setPairing({ identity: m.trusted ? m.identity : null })); }}
        onChangeIcon={() => { setMenuOpen(false); setIconOpen(true); }}
      />
      {iconOpen ? (
        <ProjectIconPicker cid={row.id} name={name} anchor={menuRef} open={iconOpen} onClose={() => setIconOpen(false)} placement="bottom-end" />
      ) : null}
      {pairing && <PairingModal cid={row.id} name={name} identity={pairing.identity} onClose={() => { setPairing(null); menuRef.current?.focus(); }} />}
    </li>
  );
}

/* ---- section header (Linear "Workspace ▾" band) ------------------------------- */
function SectionHead({ id, label, open, onToggle, collapsedRail, meta, action }: {
  id: string; label: string; open: boolean; onToggle: () => void; collapsedRail: boolean; meta?: ReactNode; action?: ReactNode;
}) {
  if (collapsedRail) return <div className="v2-sb-h is-rail">{action}</div>;
  return (
    <div className="v2-sb-h">
      <button type="button" className="v2-sb-h-btn" id={id} aria-expanded={open} onClick={onToggle}>
        <span>{label}</span>
        <Caret open={open} />
      </button>
      <span className="v2-grow" />
      {meta}
      {action}
    </div>
  );
}


/* ---- narrow-width drawer detection (matches the 900 px CSS breakpoint) ---- */
const DRAWER_MQ = "(max-width: 900px)";
function useDrawerMode(): boolean {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DRAWER_MQ).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DRAWER_MQ);
    const on = () => setM(mq.matches);
    on();
    if (mq.addEventListener) mq.addEventListener("change", on);
    else mq.addListener?.(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", on); else mq.removeListener?.(on); };
  }, []);
  return m;
}

/** the hamburger only exists visually in drawer mode (display:none above 900 px) */
function hamburgerShown(el: HTMLElement | null): el is HTMLElement {
  if (!el) return false;
  const narrow = typeof window.matchMedia === "function" ? window.matchMedia(DRAWER_MQ).matches : true;
  return narrow && getComputedStyle(el).display !== "none";
}

/** A rail-aware nav row: label visible when expanded, tooltip + sr label in the rail. */
function RailLabel({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return <span className={collapsed ? "v2-sr" : "v2-grow"}>{children}</span>;
}

/* ---- the sidebar ------------------------------------------------------------ */
export function Sidebar() {
  const chrome = useChrome();
  const { snap, cid, connection } = useSnapshot();
  const authority = useActingAuthority();
  const location = useLocation();
  const navigate = useNavigate();
  const attention = useAttention();
  const { list, error, fetchedAt, loading, refresh } = useProjects();
  const prefV = useProjectPrefsVersion(); // re-render on pin / reorder
  const [railPref, setCollapsed] = useState(sidebarCollapsed);
  // the rail preference never applies inside the narrow-width drawer
  const collapsed = railPref && !chrome?.drawerOpen;
  const [width, setWidth] = useState(readWidth);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sections, toggleSection] = useSectionState();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ x: number; w: number; id: number } | null>(null);
  const drawerMode = useDrawerMode();
  const drawerOpen = !!chrome?.drawerOpen;
  const drawerClosed = drawerMode && !drawerOpen;
  const offline = connection === "offline";
  const locKey = location.pathname + location.search;
  const locRef = useRef(locKey);
  locRef.current = locKey;

  // Narrow-width drawer = a modal dialog while open (QA): focus moves in, Tab
  // is trapped, the main area is inert. On close, focus goes where the user
  // is: back to the hamburger for a plain dismiss (Escape / Close / scrim),
  // to the main area after picking a destination, and it is left alone when
  // the window grew past 900 px (the sidebar is then a normal column).
  useEffect(() => {
    if (!drawerMode || !drawerOpen) return;
    const main = document.querySelector<HTMLElement>(".v2-frame-main, .v2-main");
    main?.setAttribute("inert", "");
    const aside = asideRef.current;
    const close = aside?.querySelector<HTMLElement>(".v2-sb-drawer-close");
    (close || focusables(aside)[0] || aside)?.focus();
    const openedAt = locRef.current;
    return () => {
      main?.removeAttribute("inert");
      const burger = document.getElementById("v2Hamburger");
      const navigated = locRef.current !== openedAt;
      const ae = document.activeElement as HTMLElement | null;
      const focusLost = !ae || ae === document.body || !!(aside && aside.contains(ae));
      if (!focusLost) return;
      if (navigated) {
        // #main is what scrolls on wide layouts, so keyboard scrolling works from there
        const target = document.getElementById("main") || document.querySelector<HTMLElement>(".v2-main") || main;
        if (target) {
          if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
          target.focus({ preventScroll: true });
        }
      } else if (hamburgerShown(burger)) {
        burger.focus();
      }
    };
  }, [drawerMode, drawerOpen]);
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    if (drawerClosed) { el.setAttribute("inert", ""); el.setAttribute("aria-hidden", "true"); }
    else { el.removeAttribute("inert"); el.removeAttribute("aria-hidden"); }
  }, [drawerClosed]);
  const onDrawerKey = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    if (drawerMode && drawerOpen) trapTab(e, asideRef.current);
  }, [drawerMode, drawerOpen]);

  useEffect(() => { setSidebarCollapsed(railPref, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // a server prefs bag applied after mount (prefs.sync: server wins) rewrites
  // orcha:sidebar + <html data-sidebar>; follow it so the toggle's state never
  // disagrees with the rail on screen (IF-RAIL-COLLAPSE).
  useEffect(() => {
    const on = () => setCollapsed(sidebarCollapsed());
    window.addEventListener(prefs.PREFS_APPLIED_EVENT, on);
    return () => window.removeEventListener(prefs.PREFS_APPLIED_EVENT, on);
  }, []);
  useEffect(() => { applyWidth(width, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // restore / remember scroll across remounts
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = scrollMemo;
    return () => { if (el) scrollMemo = el.scrollTop; };
  }, []);

  const toggleRef = useRef<() => void>(() => {});
  const toggle = () => {
    const next = !railPref;
    // keep the page where it is: the column change reflows the main area and
    // the browser's scroll anchoring otherwise jumps the content (QA minor)
    const y = window.scrollY;
    setSidebarCollapsed(next);
    setCollapsed(next);
    requestAnimationFrame?.(() => { if (Math.abs(window.scrollY - y) > 1) window.scrollTo({ top: y }); });
  };
  toggleRef.current = toggle;

  // "[" toggles the rail (Linear), never while typing / in editors / in the drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== RAIL_TOGGLE_KEY || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as Element | null;
      if (isEditingTarget(t) || isEditorOrTerminal(t)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      e.preventDefault();
      toggleRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ---- resize: pointer-captured drag that always ends (up/cancel/lost) ---- */
  const endDrag = (persist: boolean) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("v2-resizing");
    if (persist) setWidth((w) => { applyWidth(w, true); return w; });
  };
  useEffect(() => () => { document.body.classList.remove("v2-resizing"); }, []);
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return; // primary only (jsdom may omit button)
    e.preventDefault(); // no text selection / native drag (dragstart → pointercancel)
    drag.current = { x: e.clientX, w: width, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / detached */ }
    setDragging(true);
    document.body.classList.add("v2-resizing");
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    if (e.buttons === 0 && e.pointerType === "mouse") { endDrag(true); return; } // released outside, missed pointerup
    const w = clampSidebarWidth(d.w + (e.clientX - d.x));
    setWidth(w);
    applyWidth(w, false);
  };

  const onResizeKey = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 40 : 12;
    let w = width;
    if (e.key === "ArrowLeft") w -= step;
    else if (e.key === "ArrowRight") w += step;
    else if (e.key === "Home") w = SIDEBAR_MIN;
    else if (e.key === "End") w = SIDEBAR_MAX;
    else return;
    e.preventDefault();
    const c = clampSidebarWidth(w);
    setWidth(c);
    applyWidth(c, true);
  };

  // arrow keys move between nav rows (links/buttons flagged data-v2-navrow)
  const onNavKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const t = e.target as HTMLElement;
    if (!t.hasAttribute("data-v2-navrow")) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-v2-navrow]"));
    const i = rows.indexOf(t);
    const j = e.key === "ArrowDown" ? i + 1 : i - 1;
    if (j < 0 || j >= rows.length) return;
    e.preventDefault();
    rows[j].focus();
  };

  // rows: the list when loaded; before that (or when it fails) at least the
  // current project from the snapshot so the sidebar is never empty/wrong.
  const curName = snap?.container?.name ?? null;
  const curStatus = snap?.container?.status ?? null;
  const rows: ProjectRow[] = useMemo(
    () => sidebarProjectRows(list, cid, curName, curStatus),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, cid, curName, curStatus, prefV],
  );
  const pinnedIds = new Set(pinnedProjects());
  const favRows = rows.filter((r) => pinnedIds.has(r.id));
  const restRows = rows.filter((r) => !pinnedIds.has(r.id));

  const needsLabel = attentionLabel(attention);
  const projectName = snap?.container?.name || "this project";
  const needsTitle = attention.readOnly
    ? "Needs you — view-only: no decisions in this project are yours to make"
    : attention.count == null
      ? offline ? "Needs you — unavailable while offline" : "Needs you — loading"
      : `${needsLabel} decision${attention.count === 1 ? "" : "s"} waiting on you in ${projectName}${attention.partial ? " (counted from the first 1000 tasks/requests)" : ""}`;
  const onNeeds = location.pathname === NEEDS_HREF;
  const needsBadge = attention.count ? (attention.count > 99 ? "99+" : needsLabel) : null;
  const isCur = (href: string) => location.pathname === href;
  const [projectsSec, settingsSec] = [GLOBAL_SECTIONS.find((s) => s.key === "projects")!, GLOBAL_SECTIONS.find((s) => s.key === "settings")!];

  // compose = New task in the current project; never impersonates a human
  const composeBlocked = !cid
    ? "Open a project first"
    : authority.pending
      ? "Resolving your identity…"
      : !authority.human || authority.readOnly
        ? authority.reason || "Pick an acting human first — actions never impersonate a human"
        : null;
  const composeLabel = composeBlocked ? `New task — ${composeBlocked}` : `New task in ${projectName}`;

  // D13: agents take the Agents board's slots (all agents, snapshot order)
  const agentSlots = useMemo(() => agentPaletteSlots(snap), [snap]);
  const renderRows = (list: ProjectRow[], label: string) => (
    <ul className="v2-sb-projects" aria-label={label}>
      {list.map((r) => (
        <ProjectItem key={r.id} agentCap={PROJECT_AGENTS_CAP} row={r} rows={rows} selected={r.id === cid} fetchedAt={fetchedAt} collapsed={collapsed} attention={r.id === cid ? attention : null} offline={offline} agentSlots={r.id === cid ? agentSlots : undefined} />
      ))}
    </ul>
  );
  const favOpen = !sections.favorites;
  const projOpen = !sections.projects;
  const newProjectBtn = (
    <Tooltip label="New project" placement={collapsed ? "right" : "bottom"}>
      <button type="button" className="v2-sb-add" aria-label="New project" onClick={() => setCreating(true)}>
        <Icon name="plus" cls="v2-ico" />
      </button>
    </Tooltip>
  );

  return (
    <aside
      ref={asideRef}
      className={"v2-sidebar sidebar" + (dragging ? " is-resizing" : "")} id="sidebar" aria-label="Embodent navigation"
      onKeyDown={(e) => { onDrawerKey(e); onNavKey(e); }}
      {...(drawerMode && drawerOpen ? { role: "dialog", "aria-modal": true } : {})}
    >
      <div className="v2-sb-top">
        <WorkspaceSwitcher collapsed={collapsed} onToggleRail={toggle} onNewProject={() => setCreating(true)} />
        {!collapsed && <span className="v2-grow" />}
        <Tooltip label="Search" shortcut="⌘K" placement={collapsed ? "right" : "bottom"}>
          <button type="button" className="v2-sb-circle v2-sb-search" id="globalSearch" onClick={() => chrome?.openPalette()} aria-label="Search" aria-keyshortcuts="Meta+K Control+K /" data-v2-navrow="">
            <Icon name="search" cls="v2-ico" />
          </button>
        </Tooltip>
        <Tooltip label={composeLabel} placement={collapsed ? "right" : "bottom"}>
          <button
            type="button" className="v2-sb-circle v2-sb-compose is-bordered" aria-label={composeLabel}
            aria-disabled={composeBlocked ? true : undefined}
            onClick={() => { if (!composeBlocked) { chrome?.setDrawerOpen(false); if (chrome) chrome.openCompose(); else navigate(COMPOSE_HREF); } }}
          >
            <ComposeGlyph />
          </button>
        </Tooltip>
        {chrome?.drawerOpen && (
          <button type="button" className="v2-sb-drawer-close" aria-label="Close navigation" onClick={() => chrome.setDrawerOpen(false)}>
            <Icon name="x" cls="v2-ico" />
          </button>
        )}
      </div>

      <nav className="v2-sb-nav" aria-label="Workspace">
        <Tooltip label={needsTitle} disabled={!collapsed}>
          <Link
            to={NEEDS_HREF} className={"v2-sb-link v2-sb-needs" + (onNeeds ? " is-current" : "")} aria-label={needsTitle}
            aria-current={onNeeds ? "page" : undefined} data-v2-navrow=""
          >
            <Icon name={NEEDS_ICON} cls="v2-ico" />
            {!collapsed && <span className="v2-grow">Needs you</span>}
            {needsBadge ? <span className="v2-sb-needs-n has" aria-hidden="true">{needsBadge}</span> : null}
          </Link>
        </Tooltip>
        <Tooltip label={projectsSec.label} disabled={!collapsed}>
          <Link to={projectsSec.href} className={"v2-sb-link" + (isCur(projectsSec.href) ? " is-current" : "")} aria-current={isCur(projectsSec.href) ? "page" : undefined} data-v2-navrow="">
            <Icon name={projectsSec.icon} cls="v2-ico" /><RailLabel collapsed={collapsed}>{projectsSec.label}</RailLabel>
          </Link>
        </Tooltip>
        <Tooltip label={settingsSec.label} disabled={!collapsed}>
          <Link to={settingsSec.href} className={"v2-sb-link" + (isCur(settingsSec.href) ? " is-current" : "")} aria-current={isCur(settingsSec.href) ? "page" : undefined} data-v2-navrow="">
            <Icon name={settingsSec.icon} cls="v2-ico" /><RailLabel collapsed={collapsed}>{settingsSec.label}</RailLabel>
          </Link>
        </Tooltip>
      </nav>

      <div className="v2-sb-scroll" ref={scrollRef}>
        {favRows.length > 0 && (
          <section className="v2-sb-sec" aria-labelledby="sb-fav-h">
            <SectionHead id="sb-fav-h" label="Favorites" open={favOpen || collapsed} onToggle={() => toggleSection("favorites")} collapsedRail={collapsed} />
            {(favOpen || collapsed) && renderRows(favRows, "Favorite projects")}
          </section>
        )}
        <section className="v2-sb-sec" aria-labelledby="sb-proj-h">
          <SectionHead id="sb-proj-h" label="Projects" open={projOpen || collapsed} onToggle={() => toggleSection("projects")} collapsedRail={collapsed} action={newProjectBtn} />
          {error && !collapsed ? (
            <div className="v2-sb-note is-error" role="status">
              Project list unavailable. <Button variant="link" size="sm" onClick={() => void refresh()} disabled={loading}>Retry</Button>
            </div>
          ) : null}
          {(projOpen || collapsed) && renderRows(restRows, "Projects")}
          {(projOpen || collapsed) && list != null && !collapsed && restRows.length === 0 && favRows.length > 0 ? (
            <div className="v2-sb-note">All projects are in Favorites</div>
          ) : null}
          {list == null && !error && !collapsed ? <div className="v2-sb-note">Loading projects…</div> : null}
          {(projOpen || collapsed) && list != null && !collapsed && rows.length === 0 ? (
            <div className="v2-sb-note">No projects you&#39;re a member of</div>
          ) : null}
        </section>
      </div>

      <PlanUsageRow collapsed={collapsed} />
      <div className="v2-sb-foot">
        <AccountButton collapsed={collapsed} />
        {!collapsed && <span className="v2-grow" />}
        <Tooltip label="Help & docs (opens in a new tab)" placement={collapsed ? "right" : "top"}>
          <a href={HELP_HREF} target="_blank" rel="noreferrer" className="v2-sb-circle v2-sb-help" aria-label="Help & docs (opens in a new tab)">
            <Icon name="help" cls="v2-ico" />
          </a>
        </Tooltip>
        <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} shortcut={RAIL_TOGGLE_KEY} placement={collapsed ? "right" : "top"}>
          <button
            className="v2-sb-circle v2-sb-toggle sb-toggle" id="sbToggle" type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed} aria-keyshortcuts={RAIL_TOGGLE_KEY}
            onClick={toggle}
          >
            <Icon name="sidebar" cls="v2-ico" />
          </button>
        </Tooltip>
      </div>
      {!collapsed && (
        <div
          className="v2-sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={width} tabIndex={0}
          draggable={false}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={() => endDrag(true)}
          onPointerCancel={() => endDrag(true)}
          onLostPointerCapture={() => endDrag(true)}
          onDragStart={(e) => e.preventDefault()}
          onKeyDown={onResizeKey}
          onDoubleClick={() => { setWidth(SIDEBAR_DEFAULT); applyWidth(SIDEBAR_DEFAULT, true); }}
        />
      )}
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </aside>
  );
}
