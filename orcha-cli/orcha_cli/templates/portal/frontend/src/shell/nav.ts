/**
 * The V2 section map — one source for the project TAB BAR (under the
 * breadcrumb header; the sidebar no longer repeats per-project sections —
 * product directive D1), the header breadcrumbs and the palette's Navigate
 * group (arch §2, §8). Every destination has a UNIQUE icon (rail/palette
 * legibility; unit-tested).
 */
import { extensions } from "../extensions";
import { openWorkCounts } from "../state/attention";
import { orderProjects, type ProjectRow } from "../state/projects";
import { rosterPaletteSlots } from "../components/primitives/Avatar";
import { rowPaletteSlots } from "../cloud/projects/palette";
import type { Snapshot } from "../types";
import { ACTIVITY_HREF } from "./optionalPages";

export interface Section {
  key: string; // matches the Shell `page` prop
  label: string;
  href: string;
  icon: string;
}

const CORE: Section[] = [
  { key: "home", label: "Overview", href: "/", icon: "home" },
  { key: "tasks", label: "Tasks", href: "/tasks", icon: "tasks" },
  { key: "routines", label: "Routines", href: "/routines", icon: "routines" },
  { key: "agents", label: "Agents", href: "/agents", icon: "agents" },
  { key: "org", label: "Org", href: "/org", icon: "org" },
  { key: "requests", label: "Requests", href: "/requests", icon: "requests" },
];

// Brief §4 order: Overview, Tasks, Routines, Agents, Org, Requests, Code, GitHub, Activity, Metrics.
const RANK: Record<string, number> = { home: 0, tasks: 1, routines: 1.5, agents: 2, org: 2.5, requests: 3, code: 4, github: 5, activity: 6, metrics: 7 };

export function projectSections(): Section[] {
  const ext = extensions.nav.map((n) => ({ key: n.key, label: n.label, href: n.href, icon: n.ico }));
  const activity: Section = { key: "activity", label: "Activity", href: ACTIVITY_HREF, icon: "pulse" };
  const all = [...CORE, ...ext, activity];
  return all.sort((a, b) => (RANK[a.key] ?? 50) - (RANK[b.key] ?? 50));
}

/** Non-project destinations (palette Navigate group + sidebar footer). */
export const GLOBAL_SECTIONS: Section[] = [
  { key: "projects", label: "All projects", href: "/projects", icon: "grid" },
  { key: "settings", label: "Settings", href: "/settings", icon: "settings" },
];

export const SETTINGS_TABS: { key: string; label: string }[] = [
  { key: "general", label: "General" },
  { key: "execution", label: "Execution" },
  { key: "provider-keys", label: "Models & providers" },
  { key: "github-access", label: "Integrations" },
  { key: "members", label: "Members & access" },
  { key: "pairing", label: "Devices & pairing" },
  { key: "interface", label: "Interface" },
];

export function sectionLabel(page: string): string | null {
  const s = [...projectSections(), ...GLOBAL_SECTIONS].find((x) => x.key === page);
  if (s) return s.label;
  if (page === "needs") return "Needs you";
  if (page === "members") return "Members";
  return null;
}

/** Sidebar "Needs you" entry icon (distinct from the header notification bell). */
export const NEEDS_ICON = "inbox";

/**
 * Sidebar compose button (Linear's "new issue" pencil-square): opens the New
 * task composer in the current project. Same destination as the palette's
 * "New task" action; disabled (with the reason) when no acting human can act.
 */
export const COMPOSE_HREF = "/tasks?new=1";

/** Key that toggles the sidebar rail (Linear uses "["); ignored while typing / in editors. */
export const RAIL_TOGGLE_KEY = "[";

export interface SectionCount {
  /** null = unknown (render nothing / "?"), never a fake 0 */
  n: number | null;
  /** what the number measures, e.g. "open tasks (not completed or cancelled)" */
  title: string;
}

/**
 * Counts shown next to a project section (tab bar), labeled with what they
 * measure. Only where meaningful: open tasks, open requests, agents (AI +
 * human). Other sections carry no count.
 */
export function sectionCounts(snap: Snapshot | null): Record<string, SectionCount> {
  const open = openWorkCounts(snap);
  const agents = snap ? snap.agents.length : null;
  // a11y (parity r3): the title follows the number — "1 open task", not "1 open tasks"
  const one = (n: number | null) => n === 1;
  return {
    tasks: { n: open.tasks, title: (one(open.tasks) ? "open task" : "open tasks") + " (not completed or cancelled)" },
    requests: { n: open.requests, title: one(open.requests) ? "open request" : "open requests" },
    agents: { n: agents, title: (one(agents) ? "agent" : "agents") + " (AI + human)" },
  };
}

/** Is `href` (a section href) the current location? Overview matches "/" only. */
export function isSectionCurrent(href: string, pathname: string): boolean {
  const path = href.split("?")[0];
  return path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(path + "/");
}

/** Help destination: the project's public docs (the open-orcha README, as linked from the root README). */
export const HELP_HREF = "https://github.com/open-orcha/orcha#readme";

/* ---- D13: ONE avatar palette per list, shared by every surface ------------
 * Review (cross-file D13): the sidebar, header, ⌘K palette, Needs and the
 * All-projects table each hashed their own list, so the same project / agent
 * got different colours on one screen. These helpers are the single source:
 * every surface that shows a project or agent avatar takes its slot here.   */

/**
 * The project list exactly as the sidebar shows it: the loaded list in the
 * user's order (favorites first). Before the list loads, the current project
 * stands in so the sidebar is never empty. Once it HAS loaded, a current cid
 * it doesn't contain is prepended only when the snapshot proved the project
 * exists (its name is known — e.g. created after the last list fetch): a
 * removed / unknown id (404) or a project the viewer isn't a member of (403;
 * the list is filtered to their projects) must not get a phantom, highlighted
 * "Project unavailable" row (wave-4 Not-found review).
 */
export function sidebarProjectRows(list: ProjectRow[] | null, cid: string | null, currentName?: string | null, currentStatus?: string | null): ProjectRow[] {
  const current: ProjectRow | null = cid ? { id: cid, name: currentName ?? null, status: currentStatus ?? null, needs_you: null } : null;
  let rows: ProjectRow[] = list ? orderProjects(list) : current ? [current] : [];
  if (list && current && currentName && !list.some((r) => r.id === cid)) rows = [current, ...rows];
  return rows;
}

/** Collision-free palette slot per project id for rows in sidebar order —
 *  delegates to the ONE core assignment (cloud/projects/palette rowPaletteSlots). */
export function projectPaletteSlots(rows: ProjectRow[], currentId?: string | null, currentName?: string | null): Map<string, number> {
  return rowPaletteSlots(rows.map((r) => ({ id: r.id, name: r.name || (r.id === currentId ? currentName || "" : "") })));
}

/** The shared project palette hook (single implementation lives in cloud/projects/palette). */
export { useProjectPalette } from "../cloud/projects/palette";

/** Collision-free palette slot per agent alias for a project: ALL of snap.agents in
 *  snapshot order (the Agents board / roster / requests order) → actorKey → slot. */
export function agentPaletteSlots(snap: Snapshot | null): Map<string, number> {
  return rosterPaletteSlots(snap?.agents) ?? new Map();
}
