/**
 * Built-in palette providers — real data only: the live snapshot for the
 * CURRENT project (tasks, requests, agents), the project list (switching is a
 * full ?cid= navigation), the section map, and permission-aware actions.
 */
import { payloadTitle } from "../../components/primitives/Payload";
import { CREATE_TASK_KEY, matchScore, registerSearchProvider, type SearchProvider, type SearchResult } from "./providers";
import { COMPOSE_HREF, GLOBAL_SECTIONS, NEEDS_ICON, SETTINGS_TABS, projectSections } from "../nav";
import { HAS_NEEDS_PAGE, NEEDS_HREF } from "../optionalPages";
import { projectSwitchHref } from "../../lib/scope";
import { projectModeState, sectionsForMode } from "../../lib/projectMode";
import { statusMeta } from "../../lib/status";
import { currentTheme, effectivePref, hostThemeMode, setThemePref } from "../theme";

/** The ⌘K theme rows (pure over the current theme state; tested). Switching
 *  sets an explicit Light/Dark choice; "Use system theme" is offered unless it
 *  is already the choice. Inside the desktop app the host owns the theme. */
export function themeActions(): SearchResult[] {
  const managed = hostThemeMode();
  const reason = managed === "managed"
    ? "The Embodent app sets the theme — change it in the app's Settings › Appearance"
    : managed === "dark" ? "This version of the Embodent app is dark only" : undefined;
  const next = currentTheme() === "dark" ? "light" : "dark";
  const rows: SearchResult[] = [{
    id: "theme-toggle", group: "Actions", label: `Switch to ${next} theme`,
    detail: "Appearance · theme", icon: next === "light" ? "sun" : "moon",
    run: () => { setThemePref(next); }, closeOnRun: true, disabledReason: reason,
  }];
  if (effectivePref() !== "auto") {
    rows.push({ id: "theme-system", group: "Actions", label: "Use system theme", detail: "Appearance · follow your device's light or dark setting",
      icon: "settings", run: () => { setThemePref("auto"); }, closeOnRun: true, disabledReason: reason });
  }
  return rows;
}

function byScore<T>(items: T[], score: (x: T) => number, limit: number): T[] {
  return items
    .map((x) => ({ x, s: score(x) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.x);
}

/**
 * One line of human text for a request payload — never raw JSON / "{...}" /
 * "[object Object]" (directive D4). Delegates to the shared Payload
 * primitive's `payloadTitle`; kept as a named export for existing callers.
 */
export function payloadSummary(p: unknown): string {
  const t = payloadTitle(p);
  if (t || p == null || typeof p !== "object") return t;
  // the shared helper reads top-level strings only: also look one level into
  // the descriptive fields ({ body: { text } })
  if (Array.isArray(p)) {
    for (const x of p) { const s = payloadSummary(x); if (s) return s; }
    return "";
  }
  const o = p as Record<string, unknown>;
  for (const k of NESTED_KEYS) {
    const v = o[k];
    if (v && typeof v === "object") { const s = payloadSummary(v); if (s) return s; }
  }
  return "";
}
const NESTED_KEYS = ["summary", "question", "title", "subject", "message", "body", "text", "description", "prompt", "reason"];

/** All string leaves of a payload (search haystack; never shown). */
function payloadHaystack(p: unknown, depth = 0): string {
  if (p == null || depth > 3) return "";
  if (typeof p === "string") return p;
  if (typeof p === "number" || typeof p === "boolean") return String(p);
  if (Array.isArray(p)) return p.map((x) => payloadHaystack(x, depth + 1)).join(" ");
  if (typeof p === "object") return Object.values(p as Record<string, unknown>).map((x) => payloadHaystack(x, depth + 1)).join(" ");
  return "";
}

/** Project status in the sidebar's sentence case ("Active", "Needs attention"). */
export function projectStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown status";
  const known = statusMeta(status).l;
  const s = known && known !== status ? known : status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const typeLabel = (t: string | null | undefined) => {
  const s = String(t || "request").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const actions: SearchProvider = {
  id: "actions",
  group: "Actions",
  limit: 8,
  search(q, ctx) {
    const noHuman = ctx.actingHuman ? undefined : (ctx.actingReason || "Pick an acting human first — actions never impersonate a human");
    const all: SearchResult[] = [
      { id: "new-task", group: "Actions", label: "New task", detail: "Create a task in " + (ctx.projectName || "this project"), ...(ctx.openCompose ? { run: ctx.openCompose } : { href: COMPOSE_HREF }), icon: "plus", shortcut: CREATE_TASK_KEY, disabledReason: noHuman },
      { id: "needs", group: "Actions", label: "Go to Needs you", detail: HAS_NEEDS_PAGE ? "Decisions waiting on you" : "Overview action queue", href: NEEDS_HREF, icon: NEEDS_ICON },
      { id: "exec", group: "Actions", label: "Execution controls", detail: "Wakes on/off and autonomy level", run: ctx.openExecutionControls, icon: "execution", disabledReason: ctx.snap?.container ? undefined : "No project loaded" },
      ...themeActions(),
      ...SETTINGS_TABS.map((t) => ({ id: "settings-" + t.key, group: "Actions" as const, label: "Settings: " + t.label, href: "/settings#tab=" + t.key, icon: "settings" })),
    ];
    if (!q.trim()) return all.slice(0, 3);
    return byScore(all, (r) => matchScore(q, r.label, r.detail), 8);
  },
};

const navigate: SearchProvider = {
  id: "navigate",
  group: "Navigate",
  limit: 10,
  search(q, ctx) {
    const secs = [...sectionsForMode(projectSections(), projectModeState(ctx.cid).mode), ...(ctx.embedded ? [] : GLOBAL_SECTIONS)];
    const all: SearchResult[] = secs.map((s) => ({ id: s.key, group: "Navigate", label: s.label, href: s.href, icon: s.icon }));
    if (!q.trim()) return all;
    return byScore(all, (r) => matchScore(q, r.label), 10);
  },
};

const projects: SearchProvider = {
  id: "projects",
  group: "Projects",
  limit: 8,
  search(q, ctx) {
    if (ctx.embedded) return []; // desktop host owns cross-project switching
    const list = ctx.projects ?? [];
    const rows = q.trim() ? byScore(list, (p) => matchScore(q, p.name, p.github_repo, p.description), 8) : list.slice(0, 5);
    return rows.map((p) => ({
      id: p.id,
      group: "Projects" as const,
      label: p.name || p.id,
      detail: (p.id === ctx.cid ? "Current · " : "") + projectStatusLabel(p.status),
      hardHref: p.id === ctx.cid ? undefined : projectSwitchHref(p.id),
      href: p.id === ctx.cid ? "/" : undefined,
      avatar: p.name || p.id,
      avatarSeed: p.id,
    }));
  },
};

const tasks: SearchProvider = {
  id: "tasks",
  group: "Tasks",
  minQuery: 1,
  limit: 8,
  search(q, ctx) {
    const list = ctx.snap?.tasks ?? [];
    const term = q.trim().replace(/^#/, "").toLowerCase();
    const hits = byScore(list, (t) => {
      const id = String(t.id).toLowerCase();
      if (term.length >= 4 && id.startsWith(term)) return 20;
      return matchScore(q.replace(/^#/, ""), t.title, t.assignee, t.description);
    }, 8);
    return hits.map((t) => ({
      id: String(t.id),
      group: "Tasks" as const,
      label: t.title || String(t.id),
      detail: "#" + String(t.id).slice(0, 8) + (t.assignee ? " · " + t.assignee : ""),
      href: "/tasks?task=" + encodeURIComponent(String(t.id)),
      status: t.status,
    }));
  },
};

const requests: SearchProvider = {
  id: "requests",
  group: "Requests",
  minQuery: 1,
  limit: 6,
  search(q, ctx) {
    const list = ctx.snap?.requests ?? [];
    const hits = byScore(list, (r) => matchScore(q, r.title || payloadSummary(r.payload), payloadHaystack(r.payload), r.type, r.from, r.to), 6);
    return hits.map((r) => {
      const text = (r.title || payloadSummary(r.payload)).replace(/\s+/g, " ").trim();
      const route = [r.from, r.to].filter(Boolean).join(" → ");
      return {
        id: String(r.id),
        group: "Requests" as const,
        label: text ? (text.length > 90 ? text.slice(0, 89) + "…" : text) : typeLabel(r.type),
        detail: typeLabel(r.type) + (route ? " · " + route : ""),
        href: "/requests?req=" + encodeURIComponent(String(r.id)),
        status: r.status,
      };
    });
  },
};

const agents: SearchProvider = {
  id: "agents",
  group: "Agents",
  minQuery: 1,
  limit: 6,
  search(q, ctx) {
    const list = ctx.snap?.agents ?? [];
    const hits = byScore(list, (a) => matchScore(q, a.alias, a.role, a.model), 6);
    return hits.map((a) => ({
      id: String(a.id),
      group: "Agents" as const,
      label: a.alias,
      detail: (a.kind === "human" ? "Human" : "AI") + (a.role && a.role !== "—" ? " · " + a.role : ""),
      href: "/agents?agent=" + encodeURIComponent(a.alias),
      status: a.status,
    }));
  },
};

let installed = false;
/** Idempotent: registers the built-in providers once. */
export function installBuiltinProviders(): void {
  if (installed) return;
  installed = true;
  [actions, navigate, projects, tasks, requests, agents].forEach(registerSearchProvider);
}
