/**
 * The project (container) list for the V2 sidebar + command palette
 * (docs/orcha-v2-architecture.md §4). ONE module-level store, fetched from
 * GET /api/containers once on first subscribe, on explicit refresh, and every
 * 60 s while anything is subscribed — never per row and never on the 3 s
 * snapshot cadence. Only the SELECTED project has live snapshot data; other
 * rows show the list's `status` and `needs_you` stamped with the fetch time.
 *
 * Local-only organisation (no backend semantics): pinned projects and a manual
 * order live in localStorage under the non-project UI keys
 * `orcha:v2:pinnedProjects` / `orcha:v2:projectOrder` (per origin).
 */
import { useEffect, useSyncExternalStore } from "react";
import { getJSON } from "../api/client";
import { applyContainerIcons } from "../cloud/projects/projectIcons";

export interface ProjectRow {
  id: string;
  name?: string | null;
  description?: string | null;
  status?: string | null;
  github_repo?: string | null;
  agents?: number | null;
  tasks?: number | null;
  /** the portal's "Needs you" rule, computed server-side for THIS viewer
   *  (portal_backend/attention_counts.py mirrors state/attention.ts selectAttention) */
  needs_you?: number | null;
  needs_you_breakdown?: { plan: number; verify: number; request: number } | null;
  last_wake_scan_at?: string | null;
  created_at?: string | null;
  /** mig 050 (D14): the project's icon (null = default glyph); read via cloud/projects/projectIcons */
  icon?: unknown;
  /** parity r2 (additive): up to 3 AI agents working RIGHT NOW (backend's snapshot rule),
   *  so the sidebar can nest a non-selected project's agents without loading its snapshot */
  live_agents?: RemoteLiveAgent[] | null;
  /** how many qualified before the backend's cap */
  live_agents_total?: number | null;
}

export interface RemoteLiveAgent {
  alias: string;
  status?: string | null;
  task_title?: string | null;
  started_at?: string | null;
  last_active?: string | null;
}

export interface ProjectsState {
  list: ProjectRow[] | null; // null = never loaded
  error: string | null;
  fetchedAt: number | null;
  loading: boolean;
}

export const PROJECTS_REFRESH_MS = 60_000;
const PIN_KEY = "orcha:v2:pinnedProjects";
const ORDER_KEY = "orcha:v2:projectOrder";

let state: ProjectsState = { list: null, error: null, fetchedAt: null, loading: false };
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let reqSeq = 0;

function emit(next: Partial<ProjectsState>) {
  state = { ...state, ...next };
  subs.forEach((f) => f());
}

export function getProjectsState(): ProjectsState {
  return state;
}

const ACTING_PREFIX = "orcha:actingHuman:";
/**
 * `?acting=<cid>:<human id>,…` — the acting-human pick per project (the same
 * localStorage slot state/SnapshotProvider.tsx setActingHuman writes), so each
 * row's `needs_you` counts the decisions THAT human can make. Trust-off only:
 * under a trusted sign-in the server ignores it (the login decides).
 */
export function actingQuery(): string {
  const picks: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(ACTING_PREFIX)) continue;
      const cid = k.slice(ACTING_PREFIX.length);
      const aid = localStorage.getItem(k);
      if (cid && cid !== "_" && aid && /^[\w-]+$/.test(cid) && /^[\w-]+$/.test(aid)) picks.push(cid + ":" + aid);
    }
  } catch { /* private mode */ }
  return picks.length ? "?acting=" + encodeURIComponent(picks.sort().join(",")) : "";
}

/** Single-flighted fetch; a late response from an older request is dropped. */
export function refreshProjects(): Promise<void> {
  if (inflight) return inflight;
  const seq = ++reqSeq;
  emit({ loading: true });
  inflight = getJSON<unknown>("/api/containers" + actingQuery())
    .then((d) => {
      if (seq !== reqSeq) return;
      const arr = Array.isArray(d)
        ? (d as ProjectRow[])
        : ((d as { containers?: ProjectRow[] } | null)?.containers ?? []);
      applyContainerIcons(arr);
      emit({ list: arr.map((r) => ({ ...r, id: String(r.id) })), error: null, fetchedAt: Date.now(), loading: false });
    })
    .catch((e) => {
      if (seq !== reqSeq) return;
      emit({ error: e instanceof Error ? e.message : String(e), loading: false });
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Re-fetch only while something shows the list (e.g. after the acting pick changed). */
export function refreshProjectsIfWatched(): void {
  if (subs.size > 0) void refreshProjects();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) {
    if (state.list == null && !inflight) void refreshProjects();
    timer = setInterval(() => { void refreshProjects(); }, PROJECTS_REFRESH_MS);
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

/** React binding; `refresh` re-fetches now (explicit open/refresh). */
export function useProjects(): ProjectsState & { refresh: () => Promise<void> } {
  const s = useSyncExternalStore(subscribe, getProjectsState, getProjectsState);
  return { ...s, refresh: refreshProjects };
}

/* ---- local pin / order prefs --------------------------------------------- */
function readIds(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}
function writeIds(key: string, ids: string[]) {
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* private mode */ }
  prefSubs.forEach((f) => f());
}
const prefSubs = new Set<() => void>();
let prefVersion = 0;
prefSubs.add(() => { prefVersion++; });

export function pinnedProjects(): string[] { return readIds(PIN_KEY); }
export function projectOrder(): string[] { return readIds(ORDER_KEY); }

export function togglePinned(id: string): void {
  const p = pinnedProjects();
  writeIds(PIN_KEY, p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
}

/** Sort: pinned first (pin order), then local manual order, then server order. */
export function orderProjects(list: ProjectRow[], pinned = pinnedProjects(), order = projectOrder()): ProjectRow[] {
  const serverIdx = new Map(list.map((r, i) => [r.id, i]));
  const rank = (r: ProjectRow): [number, number, number] => {
    const pi = pinned.indexOf(r.id);
    const oi = order.indexOf(r.id);
    return [pi >= 0 ? 0 : 1, pi >= 0 ? pi : oi >= 0 ? oi : Number.MAX_SAFE_INTEGER, serverIdx.get(r.id) ?? 0];
  };
  return [...list].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
}

/** Can `id` move up / down within its group (pinned or unpinned)? Same rule
 *  as moveProject, so the menu never offers a move that would no-op. */
export function moveBounds(list: ProjectRow[], id: string): { up: boolean; down: boolean } {
  const pinned = pinnedProjects();
  const ordered = orderProjects(list, pinned);
  const isPinned = pinned.includes(id);
  const group = ordered.filter((r) => pinned.includes(r.id) === isPinned).map((r) => r.id);
  const i = group.indexOf(id);
  return { up: i > 0, down: i >= 0 && i < group.length - 1 };
}

/** Move a project one step up/down within its group (pinned or unpinned). */
export function moveProject(list: ProjectRow[], id: string, dir: -1 | 1): void {
  const pinned = pinnedProjects();
  const ordered = orderProjects(list, pinned);
  const isPinned = pinned.includes(id);
  const group = ordered.filter((r) => pinned.includes(r.id) === isPinned).map((r) => r.id);
  const i = group.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= group.length) return;
  [group[i], group[j]] = [group[j], group[i]];
  if (isPinned) writeIds(PIN_KEY, group);
  else writeIds(ORDER_KEY, group);
}

function subscribePrefs(cb: () => void): () => void {
  prefSubs.add(cb);
  return () => prefSubs.delete(cb);
}
/** Re-render on local pin/order changes (value is a change counter). */
export function useProjectPrefsVersion(): number {
  return useSyncExternalStore(subscribePrefs, () => prefVersion, () => prefVersion);
}

/** Keep the list warm while a component is mounted (e.g. palette open). */
export function useProjectsRefreshOnMount(active: boolean): void {
  useEffect(() => { if (active) void refreshProjects(); }, [active]);
}

/** SH-116: the All projects hub re-fetches every 15 s (the old hub's cadence);
 *  the always-mounted sidebar keeps the slower PROJECTS_REFRESH_MS. */
export const HUB_REFRESH_MS = 15_000;

/**
 * Poll the project list every `ms` while the calling view is mounted and the
 * tab is visible (a hidden tab skips ticks; it refreshes on becoming visible).
 * Rides the single-flighted refreshProjects, so it never doubles a request.
 */
export function useProjectsPoll(ms: number = HUB_REFRESH_MS, active = true): void {
  useEffect(() => {
    if (!active || !(ms > 0)) return;
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const iv = setInterval(() => { if (visible()) void refreshProjects(); }, ms);
    const onVis = () => { if (visible()) void refreshProjects(); };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
    };
  }, [ms, active]);
}

/** test hook */
export function _resetProjectsForTests(): void {
  state = { list: null, error: null, fetchedAt: null, loading: false };
  if (timer) clearInterval(timer);
  timer = null;
  inflight = null;
  reqSeq++;
  subs.clear();
}
