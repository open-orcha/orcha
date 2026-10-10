/**
 * The index.html pre-paint boot resolves <html data-theme> BEFORE any
 * stylesheet or bundle loads (no flash of the wrong theme). This executes the
 * real inline script from index.html against a matrix of stored choices, OS
 * appearance and desktop hosts, and checks it agrees with shell/theme.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostThemeMode, readThemePref, resolveTheme, WINDOW_TONE, type ResolvedTheme } from "./theme";

const indexHtml = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
// parse index.html with the DOM rather than a regex: the inline (src-less) boot script and
// the pre-paint <style>, however their tags are cased or spaced
const indexDoc = new DOMParser().parseFromString(indexHtml, "text/html");
const inline = indexDoc.querySelector("script:not([src])")!.textContent!;
const style = indexDoc.querySelector("style")!.textContent!;

const html = () => document.documentElement;
const origMatchMedia = window.matchMedia;
function run(stored: string | null, osLight: boolean, host?: unknown) {
  localStorage.clear();
  if (stored != null) localStorage.setItem("orcha:theme", stored);
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("light") ? osLight : !osLight, media: q })) as unknown as typeof window.matchMedia;
  if (host) (window as unknown as { orchaHost: unknown }).orchaHost = host;
  html().removeAttribute("data-theme");
  new Function(inline)();
}

beforeEach(() => { delete (window as unknown as { orchaHost?: unknown }).orchaHost; });
afterEach(() => {
  window.matchMedia = origMatchMedia;
  delete (window as unknown as { orchaHost?: unknown }).orchaHost;
  localStorage.clear();
});

describe("index.html pre-paint theme boot", () => {
  const cases: [string | null, boolean, ResolvedTheme][] = [
    [null, true, "dark"], // never chosen → Dark (the shipped look)
    [null, false, "dark"],
    ["dark", true, "dark"],
    ["light", false, "light"],
    ["auto", true, "light"],
    ["auto", false, "dark"],
    ["system", true, "light"],
    ["garbage", true, "dark"],
  ];
  for (const [stored, osLight, want] of cases) {
    it(`stored=${stored} os=${osLight ? "light" : "dark"} → ${want}`, () => {
      run(stored, osLight);
      expect(html().getAttribute("data-theme")).toBe(want);
      expect(html().style.colorScheme).toBe(want);
      // the runtime module resolves the same way
      expect(resolveTheme(readThemePref(), osLight ? "light" : "dark")).toBe(want);
    });
  }

  it("paints the window tone inline (matches theme.ts WINDOW_TONE)", () => {
    run("light", false);
    expect(html().style.backgroundColor).toBe("rgb(244, 244, 245)"); // #F4F4F5
    expect(WINDOW_TONE.light).toBe("#F4F4F5");
    run("dark", false);
    expect(html().style.backgroundColor).toBe("rgb(14, 15, 16)"); // #0E0F10
  });

  it("desktop host with 'theme': follows the OS (driven by nativeTheme), ignoring the stored choice", () => {
    const host = { version: 1, capabilities: ["sidebar", "theme"] };
    run("dark", true, host);
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(hostThemeMode()).toBe("managed");
  });

  it("an older (sidebar-only) desktop host stays dark", () => {
    run("light", true, { version: 1, capabilities: ["sidebar"] });
    expect(html().getAttribute("data-theme")).toBe("dark");
  });

  it("the <html> element ships no forced-dark inline style; the pre-paint CSS has both window tones", () => {
    expect(indexHtml).not.toMatch(/<html[^>]*style=/);
    expect(style).toMatch(/html, body \{ background: #0E0F10; color: #EEEFF1;/);
    expect(style).toMatch(/html\[data-theme="light"\], html\[data-theme="light"\] body \{ background: #F4F4F5; color: #1C1D1F; \}/);
  });

  it("still boots the sidebar rail from storage (the other pre-paint job)", () => {
    localStorage.setItem("orcha:sidebar", "collapsed");
    new Function(inline)();
    expect(html().getAttribute("data-sidebar")).toBe("collapsed");
    html().removeAttribute("data-sidebar");
  });
});
