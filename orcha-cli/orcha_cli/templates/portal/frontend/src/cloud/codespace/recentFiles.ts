/**
 * Recently-viewed files — localStorage, namespaced per project (cid), read by
 * the no-file landing state (CodeSpaceLanding.tsx) and the header's "Recent
 * files" dropdown (CodeSpacePage.tsx). Recorded on every file open
 * (selectFile/navigateToSymbol/navigateToThread — anywhere ?path= changes to
 * a real file), same `orcha:` localStorage-key convention and try/catch
 * private-mode guard as shell/Shell.tsx's theme persistence and
 * cloud/projects/prefs.ts.
 *
 * Pure read/write helpers, no React — kept alongside codespaceTypes.ts's
 * "pure types + tiny pure helpers" convention so it's trivially unit-testable
 * without mounting anything.
 */

export interface RecentFileEntry {
  path: string;
  viewedAt: string; // ISO timestamp
}

const MAX_ENTRIES = 20;

function storageKey(cid: string): string {
  return "orcha:cs:recentFiles:" + cid;
}

export function loadRecentFiles(cid: string): RecentFileEntry[] {
  if (!cid) return [];
  try {
    const raw = localStorage.getItem(storageKey(cid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentFileEntry => e && typeof e.path === "string" && typeof e.viewedAt === "string",
    );
  } catch {
    return []; // private mode / corrupt JSON — degrade to "no recents", never throw
  }
}

// Record a file open: moves the path to the front (de-duped) with a fresh
// timestamp, capped at MAX_ENTRIES. Returns the updated list so callers can
// paint immediately without a re-read.
export function recordFileView(cid: string, path: string): RecentFileEntry[] {
  if (!cid || !path) return loadRecentFiles(cid);
  const existing = loadRecentFiles(cid).filter((e) => e.path !== path);
  const next = [{ path, viewedAt: new Date().toISOString() }, ...existing].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(storageKey(cid), JSON.stringify(next));
  } catch {
    /* private mode — in-memory return still lets the current render paint */
  }
  return next;
}
