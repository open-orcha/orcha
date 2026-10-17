/**
 * Settings › Interface › Appearance: the System / Light / Dark picker.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prefs from "../../cloud/projects/prefs";
import { InterfaceSection, themeStorageNote } from "./InterfaceSection";
import { _resetThemeForTests, initTheme } from "../../shell/theme";

const html = () => document.documentElement;
const origMatchMedia = window.matchMedia;
let osLight = false;
const listeners = new Set<() => void>();

beforeEach(() => {
  localStorage.clear();
  prefs._resetForTests();
  _resetThemeForTests();
  osLight = false;
  listeners.clear();
  window.matchMedia = vi.fn(() => ({
    get matches() { return osLight; }, media: "",
    addEventListener: (_: string, f: () => void) => listeners.add(f),
    removeEventListener: (_: string, f: () => void) => listeners.delete(f),
  })) as unknown as typeof window.matchMedia;
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ prefs: null }) })) as unknown as typeof fetch;
  html().setAttribute("data-theme", "dark");
  initTheme();
});
afterEach(() => {
  cleanup();
  _resetThemeForTests();
  window.matchMedia = origMatchMedia;
  delete (window as unknown as { orchaHost?: unknown }).orchaHost;
  vi.restoreAllMocks();
});

describe("ThemePicker", () => {
  it("three radios with previews; Dark checked by default", () => {
    render(<InterfaceSection />);
    // scoped: the Plan usage group below adds its own Providers radiogroup
    const radios = within(screen.getByRole("radiogroup", { name: "Theme" })).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    expect(document.querySelectorAll(".set-theme-pv")).toHaveLength(4); // System = light + dark split
    expect(document.querySelector("#setThemeStore")).toHaveTextContent("Saved in this browser");
  });

  it("clicking Light applies instantly and persists", () => {
    render(<InterfaceSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("orcha:theme")).toBe("light");
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  });

  it("System follows the OS live and the control stays on System", () => {
    render(<InterfaceSection />);
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(localStorage.getItem("orcha:theme")).toBe("auto");
    expect(html().getAttribute("data-theme")).toBe("dark");
    act(() => { osLight = true; listeners.forEach((f) => f()); });
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  });

  it("arrow keys move the selection (roving radiogroup)", () => {
    render(<InterfaceSection />);
    const dark = screen.getByRole("radio", { name: "Dark" });
    fireEvent.keyDown(dark, { key: "ArrowLeft" });
    expect(localStorage.getItem("orcha:theme")).toBe("light");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Light" }), { key: "Home" });
    expect(localStorage.getItem("orcha:theme")).toBe("auto");
  });

  it("inside the desktop app (host owns the theme) the picker is read-only and says where to change it", () => {
    (window as unknown as { orchaHost: unknown }).orchaHost = { version: 1, capabilities: ["sidebar", "theme"], send() {}, on() { return () => {}; } };
    render(<InterfaceSection />);
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
    expect(screen.getByText(/Set by the Embodent app/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(localStorage.getItem("orcha:theme")).toBeNull();
  });

  it("themeStorageNote", () => {
    expect(themeStorageNote(true, null)).toBe("Saved to your account");
    expect(themeStorageNote(false, null)).toBe("Saved in this browser");
    expect(themeStorageNote(false, "dark")).toMatch(/dark only/);
  });
});
