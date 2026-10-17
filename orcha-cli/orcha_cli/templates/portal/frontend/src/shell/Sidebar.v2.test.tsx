/**
 * V2 sidebar round-1 fixes: Tooltip primitive, unique destination icons,
 * count/initial helpers, drawer focus after navigating.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip, placeTooltip } from "../components/primitives/Tooltip";
import { hasIcon, ToastProvider } from "../components/ui";
import { GLOBAL_SECTIONS, NEEDS_ICON, projectSections, sectionCounts, isSectionCurrent } from "./nav";
import { capCount } from "./Sidebar";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { HomePage } from "../pages/home/HomePage";

if (typeof window.PointerEvent === "undefined") {
  class PE extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; }
  }
  (window as unknown as { PointerEvent: typeof PE }).PointerEvent = PE;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Tooltip primitive", () => {
  it("shows a role=tooltip on hover after the delay, describes the trigger, hides on leave and Escape", async () => {
    vi.useFakeTimers();
    render(<Tooltip label="Tasks · 40 open" delay={300}><button type="button">T</button></Tooltip>);
    const btn = screen.getByRole("button", { name: "T" });
    fireEvent.pointerEnter(btn, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => { vi.advanceTimersByTime(310); });
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("Tasks · 40 open");
    expect(btn.getAttribute("aria-describedby")).toBe(tip.id);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(btn, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(310); });
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.pointerLeave(btn, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows immediately on keyboard focus and hides on blur; only one tooltip at a time", () => {
    render(
      <>
        <Tooltip label="First" delay={0}><button type="button">A</button></Tooltip>
        <Tooltip label="Second"><button type="button">B</button></Tooltip>
      </>,
    );
    const a = screen.getByRole("button", { name: "A" });
    const b = screen.getByRole("button", { name: "B" });
    act(() => { a.focus(); });
    expect(screen.getByRole("tooltip").textContent).toBe("First");
    act(() => { a.blur(); });
    // A hovered by the pointer while B takes keyboard focus → only B's tooltip remains
    fireEvent.pointerEnter(a, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip").textContent).toBe("First");
    act(() => { b.focus(); });
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip").textContent).toBe("Second");
    act(() => { b.blur(); });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("touch never opens it; disabled renders the child untouched", () => {
    render(<Tooltip label="x" disabled><button type="button" aria-describedby="own">D</button></Tooltip>);
    const d = screen.getByRole("button", { name: "D" });
    fireEvent.focus(d);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(d.getAttribute("aria-describedby")).toBe("own");
  });

  it("placement flips when it would leave the viewport and clamps to the margin", () => {
    const anchor = { top: 100, left: 1380, right: 1420, bottom: 136, width: 40, height: 36 };
    const r = placeTooltip(anchor, { width: 120, height: 24 }, { width: 1440, height: 900 }, "right");
    expect(r.placement).toBe("left");
    expect(r.left).toBe(1380 - 8 - 120);
    expect(r.top).toBe(106);
    const l = placeTooltip({ top: 4, left: 8, right: 48, bottom: 40, width: 40, height: 36 }, { width: 100, height: 60 }, { width: 1440, height: 900 }, "right");
    expect(l.placement).toBe("right");
    expect(l.top).toBe(8); // clamped
  });
});

describe("destination icons", () => {
  it("every project section and global destination has a distinct, drawable icon", () => {
    const icons = [...projectSections(), ...GLOBAL_SECTIONS].map((s) => s.icon).concat(NEEDS_ICON);
    for (const i of icons) expect(hasIcon(i), i).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
    // the notification bell stays distinct from Needs you; Metrics ≠ Activity; All projects ≠ Overview
    expect(NEEDS_ICON).not.toBe("bell");
  });

  it("the glyphs other screens asked for exist", () => {
    for (const n of ["alert", "eye", "eye-off", "arrow-left", "arrow-up", "arrow-down", "phone", "chart", "grid", "inbox", "git", "github", "help", "pin", "more"]) {
      expect(hasIcon(n), n).toBe(true);
    }
  });
});

describe("nav helpers", () => {
  it("sectionCounts labels what each number measures; unknown before the first snapshot", () => {
    expect(sectionCounts(null).tasks.n).toBeNull();
    expect(sectionCounts(null).tasks.title).toMatch(/open tasks/);
  });
  it("isSectionCurrent: Overview only on '/', others by path prefix", () => {
    expect(isSectionCurrent("/", "/")).toBe(true);
    expect(isSectionCurrent("/", "/tasks")).toBe(false);
    expect(isSectionCurrent("/tasks", "/tasks")).toBe(true);
    expect(isSectionCurrent("/code", "/code/src")).toBe(true);
  });
});

describe("sidebar helpers", () => {
  it("capCount caps at 99+", () => {
    expect(capCount(7)).toBe("7");
    expect(capCount(99)).toBe("99");
    expect(capCount(128)).toBe("99+");
  });
  it("D14: the sidebar no longer exports an initials helper (projects use their icon)", async () => {
    const mod = await import("./Sidebar");
    expect("projectInitials" in mod).toBe(false);
  });
});

describe("narrow drawer focus after picking a destination", () => {
  const origMM = window.matchMedia;
  beforeEach(() => {
    localStorage.clear();
    _resetProjectsForTests();
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return json({ containers: [{ id: "c1", name: "Website", status: "active" }] });
      if (url.startsWith("/api/containers/c1")) return json({ container: { id: "c1", name: "Website", status: "active" }, agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }], tasks: [], requests: [] });
      return json({});
    }) as unknown as typeof fetch;
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes("max-width: 900px"), media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => { window.matchMedia = origMM; document.documentElement.removeAttribute("data-drawer"); window.location.hash = ""; });

  it("moves focus to the main area (not the hamburger) when a nav link closed the drawer", async () => {
    render(<ToastProvider><SnapshotProvider><HashRouter><HomePage /></HashRouter></SnapshotProvider></ToastProvider>);
    await screen.findAllByText("Website");
    const burger = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(burger);
    const aside = document.getElementById("sidebar")!;
    await waitFor(() => expect(aside.getAttribute("role")).toBe("dialog"));
    const settings = screen.getAllByRole("link", { name: "Settings" }).find((a) => aside.contains(a))!;
    settings.focus();
    fireEvent.click(settings);
    await waitFor(() => expect(aside.hasAttribute("inert")).toBe(true));
    expect(document.activeElement).not.toBe(burger);
    // #main (the panel scroller on wide layouts) — keyboard scrolling works from there
    expect((document.activeElement as HTMLElement).id).toBe("main");
  });
});
