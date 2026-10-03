/**
 * Command-palette provider registry (docs/orcha-v2-architecture.md §6).
 * Providers are READ-ONLY and return real data for the CURRENT project
 * (except the Projects group). Built-ins live in ./builtin.ts; a domain agent
 * registers an extra provider (e.g. F's Files provider) from its own module via
 * an import in src/extensions.ts.
 */
import type { Agent, Snapshot } from "../../types";
import type { ProjectRow } from "../../state/projects";

export type SearchGroup = "Recent" | "Actions" | "Navigate" | "Projects" | "Tasks" | "Requests" | "Agents" | "Files";
export const GROUP_ORDER: SearchGroup[] = ["Recent", "Actions", "Navigate", "Projects", "Tasks", "Requests", "Agents", "Files"];

/** Linear's create key: a bare "c" opens the New task composer (chrome.tsx). */
export const CREATE_TASK_KEY = "C";

export interface SearchResult {
  id: string; // unique within its group
  group: SearchGroup;
  label: string;
  detail?: string;
  /** SPA destination (same-origin path). Cmd/Ctrl+Enter opens it in a new tab. */
  href?: string;
  /** full-navigation destination (project switch) */
  hardHref?: string;
  /** imperative action (no URL) */
  run?: () => void;
  /** close the palette after `run` (actions that do not open their own UI) */
  closeOnRun?: boolean;
  icon?: string;
  /** project rows: name for a round initial avatar (distinct from section icons) */
  avatar?: string;
  /** seed for the project avatar palette slot (the container id) — D13 parity with the sidebar */
  avatarSeed?: string | null;
  status?: string; // renders a StatusDot
  disabledReason?: string; // shown instead of executing (permission / capability)
  /** single-key hotkey that runs the same action outside the palette (e.g. "C" for New task) */
  shortcut?: string;
}

export interface SearchContext {
  snap: Snapshot | null;
  cid: string | null;
  multi: boolean;
  projectName: string | null;
  projects: ProjectRow[] | null;
  actingHuman: Agent | null;
  /** why nobody may act (pending identity / viewer / non-member / no human) */
  actingReason?: string | null;
  embedded: boolean;
  openExecutionControls: () => void;
  /** Shell-owned New task composer over the current route (absent → navigate to COMPOSE_HREF) */
  openCompose?: () => void;
  signal: AbortSignal;
}

export interface SearchProvider {
  id: string;
  group: SearchGroup;
  /** minimum query length before this provider runs (default 0) */
  minQuery?: number;
  /** results cap for this group (default 6) */
  limit?: number;
  search(q: string, ctx: SearchContext): SearchResult[] | Promise<SearchResult[]>;
}

const registry = new Map<string, SearchProvider>();

export function registerSearchProvider(p: SearchProvider): () => void {
  registry.set(p.id, p);
  return () => { if (registry.get(p.id) === p) registry.delete(p.id); };
}

export function searchProviders(): SearchProvider[] {
  return Array.from(registry.values());
}

/* ---- matching ------------------------------------------------------------- */
/** Score a candidate against a query: 0 = no match; higher = better. All
 *  whitespace-separated terms must match somewhere in the haystack. */
export function matchScore(q: string, ...fields: (string | null | undefined)[]): number {
  const query = q.trim().toLowerCase();
  if (!query) return 1;
  const hay = fields.filter(Boolean).map((f) => String(f).toLowerCase());
  if (!hay.length) return 0;
  const primary = hay[0];
  let score = 0;
  for (const term of query.split(/\s+/)) {
    let best = 0;
    hay.forEach((h, i) => {
      const at = h.indexOf(term);
      if (at < 0) return;
      const s = (i === 0 ? 3 : 1) + (at === 0 ? 2 : /\W/.test(h[at - 1] || "") ? 1 : 0);
      if (s > best) best = s;
    });
    if (!best) return 0;
    score += best;
  }
  if (primary === query) score += 5;
  return score;
}

/** Run every provider, isolating failures to an inline error row per group. */
export async function runProviders(
  q: string,
  ctx: SearchContext,
  providers: SearchProvider[] = searchProviders(),
): Promise<{ results: SearchResult[]; errors: { group: SearchGroup; message: string }[] }> {
  const results: SearchResult[] = [];
  const errors: { group: SearchGroup; message: string }[] = [];
  await Promise.all(
    providers.map(async (p) => {
      if (q.trim().length < (p.minQuery ?? 0)) return;
      try {
        const r = await p.search(q, ctx);
        if (ctx.signal.aborted) return;
        results.push(...r.slice(0, p.limit ?? 6).map((x) => ({ ...x, group: x.group || p.group })));
      } catch (e) {
        if (ctx.signal.aborted) return;
        errors.push({ group: p.group, message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
  results.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return { results, errors };
}

/* ---- recent destinations (project-scoped: key carries the cid) ------------ */
const RECENT_MAX = 6;
function recentKey(cid: string | null) { return "orcha:v2:search:" + (cid || "_") + ":recent"; }
export function recentResults(cid: string | null): SearchResult[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(cid)) || "[]") as { label: string; href: string; detail?: string }[];
    return Array.isArray(v)
      ? v.filter((x) => x && typeof x.href === "string" && x.href.startsWith("/")).slice(0, RECENT_MAX)
        .map((x, i) => ({ id: "recent-" + i, group: "Recent" as const, label: x.label, detail: x.detail, href: x.href, icon: "clock" }))
      : [];
  } catch { return []; }
}
export function rememberRecent(cid: string | null, r: SearchResult): void {
  if (!r.href || r.group === "Projects" || r.group === "Actions") return;
  try {
    const cur = JSON.parse(localStorage.getItem(recentKey(cid)) || "[]") as { label: string; href: string; detail?: string }[];
    const next = [{ label: r.label, href: r.href, detail: r.detail }, ...(Array.isArray(cur) ? cur : []).filter((x) => x.href !== r.href)].slice(0, RECENT_MAX);
    localStorage.setItem(recentKey(cid), JSON.stringify(next));
  } catch { /* private mode */ }
}
