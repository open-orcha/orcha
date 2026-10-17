/**
 * AppearanceSection (legacy settings key `appearance`) — renders Settings ›
 * Interface, whose Appearance group is the System / Light / Dark picker:
 *  - bootAppearance() runs the once-per-load /api/prefs sync; a server theme
 *    WINS and is applied (shell/theme.ts listens for the prefs-applied event);
 *  - the retired skin is never applied: data-skin stays off, the stored value
 *    is kept (never deleted) and disclosed as "kept on file".
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prefs from "../projects/prefs";
import { AppearanceSection, bootAppearance } from "./AppearanceSection";
import { legacyNote } from "../../pages/settings/InterfaceSection";
import { _resetThemeForTests, initTheme } from "../../shell/theme";

interface Call { url: string; method: string }

function stubFetch(serverPrefs: Record<string, string> | null): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method || "GET" });
    return { ok: true, status: 200, json: async () => ({ prefs: serverPrefs }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("AppearanceSection — Interface with the Appearance picker", () => {
  beforeEach(() => {
    localStorage.clear();
    prefs._resetForTests();
    _resetThemeForTests();
    document.documentElement.removeAttribute("data-skin");
    document.documentElement.setAttribute("data-theme", "dark");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); _resetThemeForTests(); });

  it("renders the Theme radiogroup (System / Light / Dark) and no skin picker", () => {
    stubFetch(null);
    render(<AppearanceSection />);
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(Array.from(group.querySelectorAll('[role="radio"]')).map((r) => r.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true"); // default
    expect(document.querySelector("#legacyAppearance")).toBeNull(); // nothing stored → no note
    expect(document.querySelector("#skinGrid")).toBeNull();
    expect(document.querySelector(".skin-tile")).toBeNull();
    expect(document.querySelector('.set-keys[aria-label="Keyboard shortcuts"]')).not.toBeNull();
  });

  it("bootAppearance syncs /api/prefs: the server theme wins and applies; the skin never does", async () => {
    localStorage.setItem("orcha:skin", "gold");
    localStorage.setItem("orcha:theme", "dark");
    initTheme();
    const calls = stubFetch({ theme: "light", skin: "swiss" });
    bootAppearance();
    await act(async () => { await prefs.sync(); });
    expect(calls.some((c) => c.url === "/api/prefs" && c.method === "GET")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
    // stored values are kept (server wins on sync), not deleted
    expect(localStorage.getItem("orcha:skin")).toBe("swiss");
    expect(localStorage.getItem("orcha:theme")).toBe("light");
  });

  it("discloses a stored retired skin as kept on file (the theme is live, so not disclosed)", () => {
    stubFetch(null);
    localStorage.setItem("orcha:theme", "light");
    localStorage.setItem("orcha:skin", "gold");
    render(<AppearanceSection />);
    expect(screen.getByText(/\(Gold design\) is kept on file but no longer changes the look/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    // reading it did not mutate storage
    expect(localStorage.getItem("orcha:theme")).toBe("light");
    expect(localStorage.getItem("orcha:skin")).toBe("gold");
  });

  it("legacyNote: only a non-classic skin needs disclosure", () => {
    expect(legacyNote({ theme: "dark", skin: null })).toBeNull();
    expect(legacyNote({ theme: "dark", skin: "classic" })).toBeNull();
    expect(legacyNote({ theme: "auto", skin: null })).toBeNull();
    expect(legacyNote({ theme: "light", skin: null })).toBeNull();
    expect(legacyNote({ theme: "dark", skin: "swiss" })).toMatch(/Swiss design/);
  });
});
