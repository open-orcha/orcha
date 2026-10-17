/**
 * Appearance: theme resolution (System / Light / Dark), live OS changes,
 * persistence (localStorage + the server-wins /api/prefs bag) and the desktop
 * host contract (shell/theme.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prefs from "../cloud/projects/prefs";
import {
  _resetThemeForTests, applyTheme, currentTheme, DEFAULT_THEME_PREF, effectivePref, hostThemeMode, initTheme,
  normalizePref, readThemePref, resolveTheme, setThemePref, THEME_CHANGED_EVENT, WINDOW_TONE,
} from "./theme";

/** A controllable prefers-color-scheme: light query. */
function mockSystem(light: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: light,
    media: "(prefers-color-scheme: light)",
    addEventListener: (_: string, f: (e: { matches: boolean }) => void) => listeners.add(f),
    removeEventListener: (_: string, f: (e: { matches: boolean }) => void) => listeners.delete(f),
  };
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return {
    set(v: boolean) { mql.matches = v; listeners.forEach((f) => f({ matches: v })); },
    listeners,
  };
}

interface Call { url: string; method: string; body?: string }
function stubFetch(serverPrefs: Record<string, string> | null): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method || "GET", body: init?.body as string | undefined });
    return { ok: true, status: 200, json: async () => ({ prefs: serverPrefs }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const html = () => document.documentElement;
const origMatchMedia = window.matchMedia;

beforeEach(() => {
  localStorage.clear();
  prefs._resetForTests();
  _resetThemeForTests();
  html().setAttribute("data-theme", "dark");
  delete (window as unknown as { orchaHost?: unknown }).orchaHost;
});
afterEach(() => {
  _resetThemeForTests();
  window.matchMedia = origMatchMedia;
  delete (window as unknown as { orchaHost?: unknown }).orchaHost;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resolution", () => {
  it("normalizes stored values; unknown/absent → the Dark default", () => {
    expect(DEFAULT_THEME_PREF).toBe("dark");
    expect(normalizePref("light")).toBe("light");
    expect(normalizePref("auto")).toBe("auto");
    expect(normalizePref("system")).toBe("auto");
    expect(normalizePref("sepia")).toBe("dark");
    expect(normalizePref(null)).toBe("dark");
    expect(readThemePref()).toBe("dark");
  });
  it("System follows the OS; Light/Dark are fixed", () => {
    expect(resolveTheme("auto", "light")).toBe("light");
    expect(resolveTheme("auto", "dark")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });
  it("applyTheme paints data-theme, color-scheme, the window tone and theme-color meta", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
    html().setAttribute("data-skin", "gold");
    applyTheme("light");
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(html().style.colorScheme).toBe("light");
    expect(meta.getAttribute("content")).toBe(WINDOW_TONE.light);
    expect(html().hasAttribute("data-skin")).toBe(false); // skins stay retired
    applyTheme("dark");
    expect(currentTheme()).toBe("dark");
    expect(meta.getAttribute("content")).toBe(WINDOW_TONE.dark);
    meta.remove();
  });
});

describe("live System", () => {
  it("System re-resolves when the OS appearance changes; an explicit choice ignores it", () => {
    const sys = mockSystem(false);
    localStorage.setItem("orcha:theme", "auto");
    const seen: string[] = [];
    window.addEventListener(THEME_CHANGED_EVENT, (e) => seen.push((e as CustomEvent).detail));
    expect(initTheme()).toBe("dark");
    sys.set(true);
    expect(currentTheme()).toBe("light");
    sys.set(false);
    expect(currentTheme()).toBe("dark");
    expect(seen).toEqual(["light", "dark"]);
    setThemePref("light");
    sys.set(false);
    expect(currentTheme()).toBe("light");
  });
  it("initTheme wires its listeners once", () => {
    const sys = mockSystem(false);
    initTheme(); initTheme(); initTheme();
    expect(sys.listeners.size).toBe(1);
  });
  it("a change made in another tab (storage event) applies here", () => {
    mockSystem(false);
    initTheme();
    localStorage.setItem("orcha:theme", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "orcha:theme", newValue: "light" }));
    expect(currentTheme()).toBe("light");
  });
});

describe("persistence", () => {
  it("self-host / trust-off: setThemePref writes localStorage only (no PUT)", async () => {
    vi.useFakeTimers();
    mockSystem(false);
    const calls = stubFetch(null);
    await prefs.sync();
    setThemePref("light");
    expect(localStorage.getItem("orcha:theme")).toBe("light");
    expect(currentTheme()).toBe("light");
    vi.advanceTimersByTime(2000);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
  it("signed in: setThemePref queues a PUT of the whole bag with the new theme", async () => {
    vi.useFakeTimers();
    mockSystem(false);
    localStorage.setItem("orcha:sidebar", "collapsed");
    const calls = stubFetch({});
    await prefs.sync();
    setThemePref("auto");
    vi.advanceTimersByTime(2000);
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toBeTruthy();
    expect(JSON.parse(put!.body!).prefs).toMatchObject({ theme: "auto", sidebar: "collapsed" });
  });
  it("server wins on load: the bag's theme overrides localStorage and is applied", async () => {
    mockSystem(false);
    localStorage.setItem("orcha:theme", "dark");
    initTheme();
    stubFetch({ theme: "light" });
    await prefs.sync();
    expect(localStorage.getItem("orcha:theme")).toBe("light");
    expect(currentTheme()).toBe("light");
  });
});

describe("desktop host", () => {
  it("a host with the 'theme' capability owns the theme: follow System, ignore the stored choice", () => {
    mockSystem(true);
    localStorage.setItem("orcha:theme", "dark");
    (window as unknown as { orchaHost: unknown }).orchaHost = { version: 1, capabilities: ["sidebar", "theme"], send() {}, on() { return () => {}; } };
    expect(hostThemeMode()).toBe("managed");
    expect(effectivePref()).toBe("auto");
    expect(initTheme()).toBe("light");
  });
  it("an older embedding host (sidebar only) is dark-only chrome: stay dark", () => {
    mockSystem(true);
    localStorage.setItem("orcha:theme", "light");
    (window as unknown as { orchaHost: unknown }).orchaHost = { version: 1, capabilities: ["sidebar"], send() {}, on() { return () => {}; } };
    expect(hostThemeMode()).toBe("dark");
    expect(initTheme()).toBe("dark");
  });
  it("no host (web): the user's choice", () => {
    mockSystem(true);
    localStorage.setItem("orcha:theme", "light");
    expect(hostThemeMode()).toBeNull();
    expect(effectivePref()).toBe("light");
  });
});
