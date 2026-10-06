/**
 * Round 3 integration: the cross-file requests from the round-2 fixers, each
 * pinned so the shared primitive stays the one source.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useRef, useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Dialog } from "./components/primitives/Dialog";
import { Menu, inAppHref } from "./components/primitives/Menu";
import { FilesChanged } from "./components/FilesChanged";
import { healthFromFailures } from "./components/primitives";
import { runHealth } from "./cloud/metrics/MetricsPage";
import { rowPaletteSlots, projectPaletteSlots as cloudSlots } from "./cloud/projects/palette";
import { projectPaletteSlots as navSlots, sidebarProjectRows } from "./shell/nav";
import { paletteRows, projectPaletteSlots as shellSlots } from "./shell/projectPalette";
import type { ProjectRow } from "./state/projects";

afterEach(cleanup);

const STYLES = resolve(__dirname, "../../static/styles");
const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

describe("Menu inside a Dialog", () => {
  function Harness({ onDialogClose }: { onDialogClose: () => void }) {
    const ref = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    return (
      <Dialog title="New task" onClose={onDialogClose}>
        <button ref={ref} type="button" onClick={() => setOpen(true)}>Priority</button>
        <Menu anchor={ref} open={open} onClose={() => setOpen(false)} label="Priority" items={[{ label: "High" }, { label: "Low" }]} />
      </Dialog>
    );
  }
  it("Escape closes only the menu (never the dialog) and returns focus to the anchor", () => {
    let closed = 0;
    render(<Harness onDialogClose={() => closed++} />);
    const anchor = screen.getByRole("button", { name: "Priority" });
    fireEvent.click(anchor);
    const item = document.activeElement as HTMLElement;
    expect(item.textContent).toContain("High");
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(closed).toBe(0);
    expect(document.activeElement).toBe(anchor);
    // a second Escape (focus back in the dialog) is the dialog's
    fireEvent.keyDown(anchor, { key: "Escape" });
    expect(closed).toBe(1);
  });
});

describe("Menu href items route in-app", () => {
  function Where() { const l = useLocation(); return <output data-testid="where">{l.pathname + l.search}</output>; }
  function Harness() {
    const ref = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    return (
      <>
        <button ref={ref} type="button" onClick={() => setOpen(true)}>More</button>
        <Menu anchor={ref} open={open} onClose={() => setOpen(false)} label="More" items={[{ label: "Runs", href: "/agents?agent=lead&tab=runs" }]} />
        <Where />
      </>
    );
  }
  it("a same-project link navigates through the router (no reload)", () => {
    render(<MemoryRouter initialEntries={["/agents"]}><Routes><Route path="*" element={<Harness />} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const link = screen.getByRole("menuitem", { name: /Runs/ });
    const notPrevented = fireEvent.click(link, { button: 0 });
    expect(notPrevented).toBe(false); // the browser's full navigation was prevented
    expect(screen.getByTestId("where").textContent).toBe("/agents?agent=lead&tab=runs");
  });
  it("inAppHref keeps project switches and external links as full navigations", () => {
    window.history.replaceState(null, "", "/tasks?cid=c1");
    expect(inAppHref("/agents?cid=c1")).toBe("/agents?cid=c1");
    expect(inAppHref("/settings")).toBe("/settings");
    expect(inAppHref("/?cid=c2")).toBeNull(); // another project → full load
    expect(inAppHref("https://github.com/x")).toBeNull();
    expect(inAppHref("//evil.example/x")).toBeNull();
    window.history.replaceState(null, "", "/");
  });
});

describe("shared primitives replace local shims", () => {
  it("FilesChanged hideSummary drops the count line but keeps the maximize control", () => {
    const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const { container, rerender } = render(<FilesChanged diff={diff} />);
    expect(container.querySelector(".dfv-n")?.textContent).toMatch(/1 file changed/);
    rerender(<FilesChanged diff={diff} hideSummary />);
    expect(container.querySelector(".dfv-n")).toBeNull();
    expect(container.querySelector(".dfv-max")).not.toBeNull();
  });

  it("one v2 checkbox: the primitive exists and the local copies are gone", () => {
    const css = readFileSync(resolve(STYLES, "v2-primitives.css"), "utf8");
    expect(css).toMatch(/\.v2-checkbox \{/);
    expect(read("cloud/codespace/codespace.css")).not.toMatch(/\.cs-changes-row-check\s*\{/);
    expect(read("pages/onboarding/pageCss.ts")).not.toMatch(/rt-kick input:checked/);
    expect(read("cloud/codespace/ChangesTab.tsx")).toMatch(/className="v2-checkbox/);
    expect(read("pages/onboarding/OnboardingPage.tsx")).toMatch(/className="v2-checkbox/);
  });

  it("Metrics health = the HealthChip primitive's rule", () => {
    for (const [ok, total] of [[70, 71], [44, 48], [15, 22], [0, 0], [81, 100]]) {
      expect(runHealth({ runs: total, ok_runs: ok, failed_runs: total - ok }).health).toBe(healthFromFailures(total - ok, total));
    }
  });

  it("Needs and Requests use the Composer's one key hint (no page copies) and the shared roster palette", () => {
    const needs = read("pages/needs/NeedsPage.tsx");
    expect(needs).not.toMatch(/nd-keyhint/);
    expect(needs).toMatch(/\bkeyHint\b/);
    expect(needs).not.toMatch(/assignPalette\(/);
    expect(read("pages/requests/RequestsPage.tsx")).not.toMatch(/assignPalette\(/);
  });

  it("Code Space renders the shared RepoNotConnected (one copy for one condition)", () => {
    expect(read("cloud/codespace/CodeSpacePage.tsx")).toMatch(/<RepoNotConnected /);
  });
});

describe("D13: ONE project palette assignment", () => {
  const rows: ProjectRow[] = ["orcha-web", "billing-service", "mobile", "empty-sandbox", "legacy", "docs", "infra", "search"].map((n, i) => ({ id: "p" + i, name: n, status: "active", needs_you: 0 }));
  it("cloud, nav and shell helpers are the same map", () => {
    const core = rowPaletteSlots(rows);
    expect(new Set(core.values()).size).toBe(rows.length);
    expect([...navSlots(rows)]).toEqual([...core]);
    expect([...shellSlots(rows)]).toEqual([...core]);
    expect([...cloudSlots(rows, null, [], [])]).toEqual([...core]);
    expect([...navSlots(sidebarProjectRows(rows.slice(1), "p0", "orcha-web"), "p0", "orcha-web").entries()].find(([k]) => k === "p0")?.[1])
      .toBe(shellSlots(paletteRows(rows.slice(1), { id: "p0", name: "orcha-web", status: null, needs_you: null })).get("p0"));
  });
});
