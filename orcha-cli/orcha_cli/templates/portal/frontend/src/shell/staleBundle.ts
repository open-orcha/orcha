/**
 * #297: a native portal serves its hashed bundles from the installed orcha-cli, and
 * `orcha serve` restarts the portal when that install changes. A page opened before
 * the update still points at the old lazy chunks, which no longer exist — navigating
 * to a not-yet-loaded page would fail. Vite reports that as `vite:preloadError`;
 * reload once to pick up the current shell instead of showing a broken page.
 * At most one reload per RELOAD_GUARD_MS so a chunk that is truly missing can't loop.
 */
const KEY = "orcha:stale-bundle-reload";
export const RELOAD_GUARD_MS = 30 * 1000;

function lastReload(): number {
  try { return Number(sessionStorage.getItem(KEY)) || 0; } catch { return 0; }
}

function markReload(now: number): void {
  try { sessionStorage.setItem(KEY, String(now)); } catch { /* storage blocked: the guard is best-effort */ }
}

export function installStaleBundleReload(win: Window = window, now: () => number = Date.now): void {
  win.addEventListener("vite:preloadError", (event) => {
    const t = now();
    if (t - lastReload() < RELOAD_GUARD_MS) return; // just reloaded: let the error surface
    event.preventDefault();
    markReload(t);
    win.location.reload();
  });
}
