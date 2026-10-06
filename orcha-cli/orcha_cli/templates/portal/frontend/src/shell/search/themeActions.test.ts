/** ⌘K: "Switch to light/dark theme" + "Use system theme". */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { themeActions } from "./builtin";
import { _resetThemeForTests } from "../theme";

const html = () => document.documentElement;
beforeEach(() => { localStorage.clear(); _resetThemeForTests(); html().setAttribute("data-theme", "dark"); });
afterEach(() => { delete (window as unknown as { orchaHost?: unknown }).orchaHost; });

describe("palette theme actions", () => {
  it("dark → offers light, runs it, closes the palette; then offers dark", () => {
    const [toggle, sys] = themeActions();
    expect(toggle.label).toBe("Switch to light theme");
    expect(toggle.closeOnRun).toBe(true);
    expect(sys.label).toBe("Use system theme");
    toggle.run!();
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("orcha:theme")).toBe("light");
    expect(themeActions()[0].label).toBe("Switch to dark theme");
  });
  it("'Use system theme' stores auto and is not offered again", () => {
    themeActions()[1].run!();
    expect(localStorage.getItem("orcha:theme")).toBe("auto");
    expect(themeActions().map((r) => r.id)).toEqual(["theme-toggle"]);
  });
  it("inside the desktop app the rows explain instead of acting", () => {
    (window as unknown as { orchaHost: unknown }).orchaHost = { version: 1, capabilities: ["sidebar", "theme"] };
    for (const r of themeActions()) expect(r.disabledReason).toMatch(/Embodent app/);
  });
  it("is matched by the Actions provider for 'theme'", async () => {
    const { searchProviders } = await import("./providers");
    const { installBuiltinProviders } = await import("./builtin");
    installBuiltinProviders();
    const actions = searchProviders().find((p) => p.id === "actions")!;
    const res = await actions.search("theme", { snap: null, cid: null, multi: false, projectName: null, projects: null, actingHuman: null, embedded: false, openExecutionControls: () => {}, signal: new AbortController().signal });
    expect(res.map((r) => r.label)).toContain("Switch to light theme");
  });
});
