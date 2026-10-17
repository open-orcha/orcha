/**
 * Cmd/Ctrl+K "Files" provider (docs/orcha-v2-architecture.md §6, parity C-03).
 *
 * Real, current-project results only: file NAMES from the bound repository via
 * the existing browse search (`GET /api/containers/{cid}/github/browse/search
 * ?mode=names&ref=HEAD&q=` — member-read, same endpoint Code Space and the
 * GitHub browser already use). Each hit opens the file in Code Space
 * (`/code?path=`; the palette adds `?cid=` on multi-project stacks).
 *
 * Honest states, per the palette contract:
 *   - no project / no repo connected  -> no Files group at all (nothing to search)
 *   - rate limit / GitHub error       -> throws, so the palette shows
 *                                        "Files search unavailable: <reason>"
 * Debounced 250 ms and abandoned when the palette aborts (ctx.signal) so fast
 * typing never fans out a request per keystroke or paints stale results.
 */
import { registerSearchProvider, type SearchContext, type SearchResult } from "../../shell/search/providers";
import { fetchSearch } from "../github/browse/browseApi";
import type { BrowseSearchPayload } from "../github/browse/browseTypes";

export const FILES_DEBOUNCE_MS = 250;
export const FILES_LIMIT = 8;

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(!signal.aborted); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function searchFiles(q: string, ctx: Pick<SearchContext, "cid" | "signal">): Promise<SearchResult[]> {
  const query = q.trim();
  if (!ctx.cid || query.length < 2) return [];
  if (!(await wait(FILES_DEBOUNCE_MS, ctx.signal))) return [];
  const res = await fetchSearch(ctx.cid, "HEAD", query, "names");
  if (ctx.signal.aborted) return [];
  if (!res.ok) {
    if (res.error.kind === "not_connected" || res.error.kind === "local_source") return [];
    if (res.error.kind === "rate_limited") throw new Error("GitHub rate limit or missing access");
    throw new Error(res.error.detail || "couldn't reach the repository");
  }
  const payload: BrowseSearchPayload = res.data;
  const rows = Array.isArray(payload.results) ? payload.results : [];
  return rows
    .filter((r) => !("type" in r) || r.type === "file")
    .filter((r) => pathMatches(r.path, query))
    .slice(0, FILES_LIMIT)
    .map((r) => {
      const slash = r.path.lastIndexOf("/");
      return {
        id: "file:" + r.path,
        group: "Files" as const,
        label: slash < 0 ? r.path : r.path.slice(slash + 1),
        detail: slash < 0 ? undefined : r.path.slice(0, slash),
        href: "/code?path=" + encodeURIComponent(r.path),
        icon: "code",
      };
    });
}

/**
 * Client-side relevance guard (screen review: "front" returned unrelated
 * Shell.tsx / Sidebar.tsx): a hit must contain every whitespace-separated
 * query token in its path (case-insensitive). Exported for tests.
 */
export function pathMatches(path: string, query: string): boolean {
  const hay = path.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
}

let registered = false;
/** Idempotent — safe to call from any module that wants Files search on. */
export function registerFilesSearch(): void {
  if (registered) return;
  registered = true;
  registerSearchProvider({ id: "files", group: "Files", minQuery: 2, limit: FILES_LIMIT, search: searchFiles });
}

registerFilesSearch();
