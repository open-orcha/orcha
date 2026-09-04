/**
 * AppearanceSection — theme writes orcha:theme + queues the debounced
 * /api/prefs PUT (mig 040), the skin picker applies/persists the data-skin
 * attribute live, and bootAppearance restores it at app boot. fetch is
 * stubbed; matches foundation.test.ts style.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prefs from "../projects/prefs";
import { AppearanceSection, applySkin, bootAppearance } from "./AppearanceSection";

// static/styles/skin-gold.css — resolved relative to the frontend/ package
// root (process.cwd() under vitest), four levels up to the portal root.
const GOLD_CSS_PATH = path.resolve(
  process.cwd(),
  "../static/styles/skin-gold.css",
);

interface Call { url: string; method: string; body: unknown }

function stubFetch(): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ prefs: {} }), // server prefs ACTIVE (trusted + mapped)
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("AppearanceSection (theme + skin apply mechanics)", () => {
  beforeEach(() => {
    localStorage.clear();
    prefs._resetForTests();
    document.documentElement.removeAttribute("data-skin");
    document.documentElement.setAttribute("data-theme", "auto");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("theme pick writes orcha:theme, sets data-theme, and queues the prefs PUT", async () => {
    const calls = stubFetch();
    await prefs.sync(); // once-per-load boot sync — activates the server mirror
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("radio", { name: "dark" }));
    // the open shell's contract: localStorage key + data-theme on <html>, instantly
    expect(localStorage.getItem("orcha:theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // mig 040: the debounced (800ms) PUT mirrors the FULL local set
    await waitFor(() => {
      const put = calls.find((c) => c.url === "/api/prefs" && c.method === "PUT");
      expect(put).toBeTruthy();
      expect(put!.body).toEqual({ prefs: { theme: "dark" } });
    }, { timeout: 2500 });
  });

  it("skin pick applies data-skin live (classic = no attribute), persists, and rides the prefs PUT", async () => {
    const calls = stubFetch();
    await prefs.sync();
    render(<AppearanceSection />);
    fireEvent.click(document.querySelector('.skin-tile[data-skin="minimal"]')!);
    expect(document.documentElement.getAttribute("data-skin")).toBe("minimal");
    expect(localStorage.getItem("orcha:skin")).toBe("minimal");
    fireEvent.click(document.querySelector('.skin-tile[data-skin="classic"]')!);
    // "classic" = the shipped look — attribute REMOVED, not set (vanilla applySkin)
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
    expect(localStorage.getItem("orcha:skin")).toBe("classic");
    await waitFor(() => {
      const put = calls.find((c) => c.url === "/api/prefs" && c.method === "PUT");
      expect(put).toBeTruthy();
      expect(put!.body).toEqual({ prefs: { skin: "classic" } });
    }, { timeout: 2500 });
  });

  it("prefs inactive (self-host / trust off): writes stay localStorage-only, no PUT", () => {
    const calls = stubFetch(); // NOT synced — queue stays inactive
    applySkin("swiss");
    expect(document.documentElement.getAttribute("data-skin")).toBe("swiss");
    expect(localStorage.getItem("orcha:skin")).toBe("swiss");
    expect(calls.filter((c) => c.method === "PUT").length).toBe(0);
  });

  it("gold tile applies data-skin=\"gold\" live and persists (fourth skin tile)", async () => {
    const calls = stubFetch();
    await prefs.sync();
    render(<AppearanceSection />);
    expect(document.querySelector('.skin-tile[data-skin="gold"]')).toBeTruthy();
    fireEvent.click(document.querySelector('.skin-tile[data-skin="gold"]')!);
    expect(document.documentElement.getAttribute("data-skin")).toBe("gold");
    expect(localStorage.getItem("orcha:skin")).toBe("gold");
    await waitFor(() => {
      const put = calls.find((c) => c.url === "/api/prefs" && c.method === "PUT");
      expect(put).toBeTruthy();
      expect(put!.body).toEqual({ prefs: { skin: "gold" } });
    }, { timeout: 2500 });
  });

  it("skin-gold.css defines the [data-skin=\"gold\"] token override (CSS-presence check)", () => {
    const css = readFileSync(GOLD_CSS_PATH, "utf8");
    expect(css).toContain('[data-skin="gold"]');
    // the desktop app's own amber accent (desktop/src/renderer/src/styles.css
    // --color-accent) — the whole point of this skin is matching it exactly.
    expect(css).toContain("#f0b94b");
  });

  it("bootAppearance restores the persisted skin at app boot (pre-paint parity)", () => {
    stubFetch();
    localStorage.setItem("orcha:skin", "swiss");
    bootAppearance();
    expect(document.documentElement.getAttribute("data-skin")).toBe("swiss");
    document.documentElement.removeAttribute("data-skin");
    localStorage.setItem("orcha:skin", "classic");
    bootAppearance();
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
  });
});
