/**
 * Per-user cosmetic preferences — port of the subset of modules/app-prefs.js the
 * /projects hub consumes (sync / active / defaultCid / setDefaultCid).
 *
 * localStorage stays the source the page paints from; this module keeps it in
 * sync with GET/PUT /api/prefs. prefs null (self-host / trust-off / unmapped)
 * deactivates the module entirely — pure-localStorage behavior, no network on
 * writes. prefs non-null: SERVER WINS on sync (mirror into localStorage), and
 * local writes queue a debounced PUT of the FULL local set (whole-bag replace
 * server-side, so omitting a key IS unsetting it). COSMETIC ONLY.
 */

const DEBOUNCE_MS = 800;
/** Fired on window after a server bag was applied to localStorage / <html>, so
 *  live UI holding a copy in React state (the sidebar rail, the theme) re-reads
 *  it and never disagrees with <html data-sidebar> / <html data-theme>. */
export const PREFS_APPLIED_EVENT = "orcha:prefs-applied";
const DEF_CID_KEY = "orcha:defaultCid";

let _active = false;
let _syncPromise: Promise<Record<string, string> | null> | null = null;
let _timer: ReturnType<typeof setTimeout> | null = null;

function lsGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k: string, v: string | null | undefined): void {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, String(v));
  } catch { /* private mode */ }
}

// The full local cosmetic set — what a write-through PUTs.
export function localPrefs(): Record<string, string> {
  const p: Record<string, string> = {};
  const theme = lsGet("orcha:theme"); if (theme) p.theme = theme;
  const skin = lsGet("orcha:skin"); if (skin) p.skin = skin;
  const sidebar = lsGet("orcha:sidebar"); if (sidebar) p.sidebar = sidebar;
  const def = lsGet(DEF_CID_KEY); if (def) p.default_cid = def;
  return p;
}

// SERVER WINS: mirror into localStorage for the next load and apply the
// sidebar attribute now. The theme is applied by shell/theme.ts, which
// listens for PREFS_APPLIED_EVENT (no import cycle). The retired skin is
// still mirrored (read-tolerant) but never applied.
function applyServer(prefs: Record<string, string>): void {
  const d = document.documentElement;
  if (prefs.theme) lsSet("orcha:theme", prefs.theme);
  if (prefs.skin) lsSet("orcha:skin", prefs.skin);
  if (prefs.sidebar) {
    lsSet("orcha:sidebar", prefs.sidebar);
    if (prefs.sidebar === "collapsed") d.setAttribute("data-sidebar", "collapsed");
    else d.removeAttribute("data-sidebar");
  }
  if (prefs.default_cid != null) lsSet(DEF_CID_KEY, prefs.default_cid);
  try { window.dispatchEvent(new CustomEvent(PREFS_APPLIED_EVENT)); } catch { /* no window */ }
}

export function sync(): Promise<Record<string, string> | null> {
  if (typeof fetch !== "function") return Promise.resolve(null);
  if (_syncPromise) return _syncPromise; // once per page load (single-flight)
  _syncPromise = fetch("/api/prefs")
    .then((r) => (r.ok ? r.json() : { prefs: null }))
    .then((d: { prefs?: Record<string, string> | null }) => {
      const prefs = d && d.prefs;
      if (prefs == null) { _active = false; return null; }
      _active = true;
      applyServer(prefs);
      return prefs;
    })
    .catch(() => { _active = false; return null; });
  return _syncPromise;
}

function flush(): void {
  _timer = null;
  if (!_active) return;
  fetch("/api/prefs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefs: localPrefs() }),
  }).catch(() => { /* cosmetic: a lost mirror self-heals on the next write */ });
}

export function queuePut(): void {
  if (!_active) return; // self-host/untrusted: localStorage only
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(flush, DEBOUNCE_MS);
}

/* default project star (the /projects hub) — toggleable, localStorage-first.
 * null clears the mark. */
export function setDefaultCid(cid: string | null): void {
  lsSet(DEF_CID_KEY, cid);
  queuePut();
}
export function defaultCid(): string | null { return lsGet(DEF_CID_KEY); }
export function active(): boolean { return _active; }

// test hook: reset module state between vitest cases (fresh single-flight).
export function _resetForTests(): void {
  _active = false;
  _syncPromise = null;
  if (_timer) clearTimeout(_timer);
  _timer = null;
}
