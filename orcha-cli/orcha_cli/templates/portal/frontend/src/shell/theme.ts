/**
 * Appearance — System / Light / Dark (Settings › Interface › Appearance, ⌘K).
 *
 * Preference vocabulary is the one the portal has always stored, so older
 * values keep meaning what they meant:
 *   localStorage `orcha:theme` = "auto" (System) | "light" | "dark"
 *   /api/prefs bag key `theme` = the same value (cosmetic, per identity)
 * Nothing stored → DEFAULT_THEME_PREF ("dark": the look V2 shipped with, so an
 * upgrade never flips anyone's screen; System and Light are one click away).
 *
 * <html data-theme> only ever holds the RESOLVED theme ("light" | "dark") —
 * never "auto" — so every CSS rule keys off one attribute and the legacy
 * [data-theme="auto"] blocks in open-base/tokens.css never match.
 *
 * Desktop: when a v1 orchaHost declares the "theme" capability, the Embodent
 * desktop app owns the theme. It drives Electron's nativeTheme.themeSource,
 * which is what `prefers-color-scheme` reports inside the embedded view, so
 * the portal simply follows System there (live) and ignores its own stored
 * choice. An older desktop (no "theme" capability) has dark-only chrome, so
 * the embedded portal stays dark to match it.
 *
 * index.html runs the SAME resolution inline before first paint (no flash);
 * keep resolvePrePaint in sync with that script (theme.prepaint.test.ts
 * executes the real inline script against this module's rules).
 */
import { useEffect, useState } from "react";
import { PREFS_APPLIED_EVENT, queuePut } from "../cloud/projects/prefs";

export type ThemePref = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "orcha:theme";
export const DEFAULT_THEME_PREF: ThemePref = "dark";
/** Fired on window whenever the applied theme may have changed (detail = resolved). */
export const THEME_CHANGED_EVENT = "orcha:theme-changed";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** Window/canvas tone per theme — must equal --v2-window in v2-tokens.css. */
export const WINDOW_TONE: Record<ResolvedTheme, string> = { dark: "#0E0F10", light: "#F4F4F5" };

export const THEME_LABEL: Record<ThemePref, string> = { auto: "System", light: "Light", dark: "Dark" };

/** Coerce any stored value to a preference ("system" is accepted as "auto"). */
export function normalizePref(v: unknown): ThemePref {
  if (v === "light" || v === "dark" || v === "auto") return v;
  if (v === "system") return "auto";
  return DEFAULT_THEME_PREF;
}

/** The user's own stored choice (ignores the desktop host). */
export function readThemePref(): ThemePref {
  try { return normalizePref(localStorage.getItem(THEME_KEY)); } catch { return DEFAULT_THEME_PREF; }
}

interface HostLike { version?: unknown; capabilities?: unknown }
/** "managed" = a desktop host owns the theme; "dark" = an embedding host that predates it. */
export function hostThemeMode(): "managed" | "dark" | null {
  if (typeof window === "undefined") return null;
  const h = (window as unknown as { orchaHost?: HostLike }).orchaHost;
  if (!h || h.version !== 1 || !Array.isArray(h.capabilities)) return null;
  if (h.capabilities.includes("theme")) return "managed";
  if (h.capabilities.includes("sidebar")) return "dark";
  return null;
}

/** The preference actually in force: the host's (System / Dark) when embedded, else the user's. */
export function effectivePref(): ThemePref {
  const host = hostThemeMode();
  if (host === "managed") return "auto";
  if (host === "dark") return "dark";
  return readThemePref();
}

export function systemTheme(): ResolvedTheme {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(LIGHT_QUERY).matches
      ? "light" : "dark";
  } catch { return "dark"; }
}

export function resolveTheme(pref: ThemePref, system: ResolvedTheme = systemTheme()): ResolvedTheme {
  return pref === "auto" ? system : pref;
}

/** The theme currently painted (what <html data-theme> says). */
export function currentTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** Paint a resolved theme onto <html> (+ color-scheme, theme-color meta). Idempotent. */
export function applyTheme(resolved: ResolvedTheme = resolveTheme(effectivePref())): ResolvedTheme {
  if (typeof document === "undefined") return resolved;
  const d = document.documentElement;
  const before = d.getAttribute("data-theme");
  d.setAttribute("data-theme", resolved);
  d.removeAttribute("data-skin"); // skins stay retired
  d.style.colorScheme = resolved;
  d.style.backgroundColor = WINDOW_TONE[resolved];
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute("content", WINDOW_TONE[resolved]);
  const cs = document.querySelector('meta[name="color-scheme"]');
  if (cs) cs.setAttribute("content", resolved);
  if (before !== resolved) {
    try { window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: resolved })); } catch { /* no window */ }
  }
  return resolved;
}

/** Save a choice (localStorage + account prefs when signed in) and apply it now. */
export function setThemePref(pref: ThemePref): ResolvedTheme {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode */ }
  queuePut(); // server-wins bag: no-op for self-host / trust-off (localStorage only)
  const r = applyTheme();
  // a same-resolved change (Dark → System while the OS is dark) still has to
  // refresh the Settings control and palette label
  try { window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: r })); } catch { /* no window */ }
  return r;
}

let _wired = false;
let _mql: MediaQueryList | null = null;
const _onSystem = () => { if (effectivePref() === "auto") applyTheme(); };
const _onPrefs = () => applyTheme(); // server bag landed in localStorage (prefs.sync)
const _onStorage = (e: StorageEvent) => { if (e.key === THEME_KEY) applyTheme(); }; // another tab

/**
 * Apply the theme before the first React render (index.html already did it
 * pre-paint) and keep it live: OS appearance changes (System), a server prefs
 * bag arriving, and changes made in another tab.
 */
export function initTheme(): ResolvedTheme {
  const r = applyTheme();
  if (_wired || typeof window === "undefined") return r;
  _wired = true;
  try {
    _mql = typeof window.matchMedia === "function" ? window.matchMedia(LIGHT_QUERY) : null;
    if (_mql) {
      if (typeof _mql.addEventListener === "function") _mql.addEventListener("change", _onSystem);
      else if (typeof (_mql as MediaQueryList & { addListener?: (f: () => void) => void }).addListener === "function") {
        (_mql as MediaQueryList & { addListener: (f: () => void) => void }).addListener(_onSystem);
      }
    }
  } catch { _mql = null; }
  window.addEventListener(PREFS_APPLIED_EVENT, _onPrefs);
  window.addEventListener("storage", _onStorage);
  return r;
}

/** test hook */
export function _resetThemeForTests(): void {
  if (typeof window !== "undefined") {
    window.removeEventListener(PREFS_APPLIED_EVENT, _onPrefs);
    window.removeEventListener("storage", _onStorage);
    try { _mql?.removeEventListener?.("change", _onSystem); } catch { /* old API */ }
  }
  _mql = null;
  _wired = false;
}

/* ---- React ---------------------------------------------------------------- */

/** Live { pref, resolved, managed } for UI (Settings control, palette label). */
export function useTheme(): { pref: ThemePref; resolved: ResolvedTheme; managed: "managed" | "dark" | null } {
  const read = () => ({ pref: effectivePref(), resolved: currentTheme(), managed: hostThemeMode() });
  const [s, set] = useState(read);
  useEffect(() => {
    const on = () => set(read());
    window.addEventListener(THEME_CHANGED_EVENT, on);
    window.addEventListener(PREFS_APPLIED_EVENT, on);
    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, on);
      window.removeEventListener(PREFS_APPLIED_EVENT, on);
    };
  }, []);
  return s;
}
