/**
 * D5 app frame: inset raised panel, ONE header area (crumb + D1 project tabs +
 * circular tools), the page-toolbar slot and the PageChrome building blocks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { HEADER_DENSITY_STEPS, Shell, headerDensity } from "./Shell";
import { CircleIconButton, FilterPills, PageHeader, PageToolbar, Pager, scrollMainTo } from "./PageChrome";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: true },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [{ id: "t1", title: "One", status: "in_progress" }],
  requests: [],
};

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
}

function mount(ui: React.ReactElement, path = "/tasks") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

beforeEach(() => { localStorage.clear(); stubFetch(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("D5 frame — one header area", () => {
  it("renders the project tabs INSIDE the header (not a second bar) and the panel scope", async () => {
    mount(<Shell page="tasks" title="Tasks"><div>body</div></Shell>);
    const header = await waitFor(() => { const h = document.getElementById("topbar"); expect(h).toBeTruthy(); return h!; });
    await waitFor(() => expect(header.querySelector(".v2-ptabs")).toBeTruthy());
    expect(header.classList.contains("has-tabs")).toBe(true);
    const panel = document.querySelector(".v2-main")!;
    expect(panel.getAttribute("data-v2-surface")).toBe("panel");
    // exactly one header block above the scrolling content
    expect(panel.querySelectorAll(".v2-panel-top > header").length).toBe(1);
    expect(panel.querySelector(".v2-panel-top + .ncenter, .v2-panel-top ~ #main")).toBeTruthy();
  });

  it("keeps the full trail in the Breadcrumb nav and never echoes the open object in the header (D12)", async () => {
    mount(<Shell page="tasks" title="Tasks" crumbs={[{ label: "Fix the race", title: "Fix the race in the scheduler" }]}><div /></Shell>);
    const nav = await screen.findByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(nav.textContent).toContain("Orcha"));
    expect(nav.textContent).toContain("Tasks");
    expect(nav.textContent).toContain("Fix the race");
    expect(document.querySelector(".v2-header-obj")).toBeNull();
    // the only visible crumb on a tabbed page is the project (avatar + name)
    expect(document.querySelector("#topbar .v2-header-pname")?.textContent).toBe("Orcha");
    // the project crumb links to the overview and carries its name as the tooltip
    const proj = within(nav).getByRole("link", { name: "Orcha" });
    expect(proj.getAttribute("href")).toBe("/");
  });

  it("non-project pages have no tabs and no object echo", async () => {
    mount(<Shell page="settings" title="Settings"><div /></Shell>, "/settings");
    await waitFor(() => expect(document.getElementById("topbar")).toBeTruthy());
    const header = document.getElementById("topbar")!;
    expect(header.classList.contains("has-tabs")).toBe(false);
    expect(header.querySelector(".v2-header-obj")).toBeNull();
  });

  it("renders the page toolbar slot under the header and the flush content option", async () => {
    mount(
      <Shell page="tasks" title="Tasks" flush toolbar={<PageToolbar label="Task filters"><span>pills</span></PageToolbar>}>
        <div>body</div>
      </Shell>,
    );
    const bar = await screen.findByRole("toolbar", { name: "Task filters" });
    expect(bar.closest(".v2-toolbar-slot")?.parentElement?.classList.contains("v2-panel-top")).toBe(true);
    const main = document.getElementById("main")!;
    expect(main.classList.contains("is-flush")).toBe(true);
    expect(main.contains(bar)).toBe(false); // the toolbar never scrolls away with the content
    expect(main.getAttribute("tabindex")).toBe("-1"); // skip-link / programmatic focus target
  });

  it("the execution chip shows ONE state word; the level lives in its label/tooltip", async () => {
    mount(<Shell page="tasks" title="Tasks"><div /></Shell>);
    await waitFor(() => expect(document.getElementById("execBtn")).toBeTruthy());
    const btn = document.getElementById("execBtn")!;
    expect(btn.textContent).not.toContain("Plan-only");
    expect(btn.getAttribute("aria-label")).toMatch(/^Execution — .* · Autonomy: Plan-only$/);
    expect(btn.getAttribute("title")).toBe(btn.getAttribute("aria-label"));
  });

  it("never renders a second header row, a pause bar or a paused chip", async () => {
    mount(<Shell page="tasks" title="Tasks"><div /></Shell>);
    await waitFor(() => expect(document.getElementById("topbar")).toBeTruthy());
    expect(document.getElementById("pausebar")).toBeNull();
    expect(document.querySelector(".v2-paused-chip")).toBeNull();
    expect(document.getElementById("topbar")!.className).toMatch(/\bis-d-(full|compact|tight|overflow)\b/);
  });
});

describe("headerDensity — one row, density steps instead of wrapping", () => {
  it("steps full → compact → tight → overflow as the tabbed panel narrows", () => {
    const [full, compact, tight] = HEADER_DENSITY_STEPS.tabbed;
    expect(headerDensity(1176, true)).toBe("full"); // 1440 viewport
    expect(headerDensity(full, true)).toBe("full");
    expect(headerDensity(full - 1, true)).toBe("compact");
    expect(headerDensity(compact, true)).toBe("compact");
    expect(headerDensity(compact - 1, true)).toBe("tight");
    expect(headerDensity(836, true)).toBe("tight"); // 1100 viewport
    expect(headerDensity(tight - 1, true)).toBe("overflow");
    expect(headerDensity(390, true)).toBe("overflow");
  });
  it("pages without tabs keep more room; unknown width is full", () => {
    expect(headerDensity(900, false)).toBe("full");
    expect(headerDensity(700, false)).toBe("compact");
    expect(headerDensity(520, false)).toBe("tight");
    expect(headerDensity(390, false)).toBe("overflow");
    expect(headerDensity(null, true)).toBe("full");
  });
});

describe("PageChrome", () => {
  it("PageToolbar is a named toolbar with pills left and actions right", () => {
    render(
      <PageToolbar label="Agent filters" end={<CircleIconButton icon="sliders" label="Display options" />}>
        <FilterPills label="Show" value="all" onChange={() => {}} items={[{ key: "all", label: "All tasks" }, { key: "active", label: "Active", count: 3 }]} />
      </PageToolbar>,
    );
    const bar = screen.getByRole("toolbar", { name: "Agent filters" });
    expect(bar.classList.contains("v2-filterbar")).toBe(true);
    const btn = within(bar).getByRole("button", { name: "Display options" });
    expect(btn.className).toMatch(/v2-iconbtn-circle/);
    expect(btn.className).toMatch(/v2-iconbtn-outline/);
    expect(within(bar).getByRole("radio", { name: /All tasks/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("Pager shows 1-based position and disables the ends", () => {
    const prev = vi.fn(), next = vi.fn();
    render(<Pager index={0} total={84} onPrev={prev} onNext={next} noun="task" />);
    expect(screen.getByRole("group", { name: "task 1 of 84" }).textContent).toContain("1 / 84");
    expect((screen.getByRole("button", { name: "Previous task" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next task" }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("Pager renders nothing for an item outside the list", () => {
    const { container } = render(<Pager index={-1} total={3} />);
    expect(container.firstChild).toBeNull();
  });

  it("PageHeader renders glyph · id · title (h1, tooltip) · trailing · actions", () => {
    render(<PageHeader id="ORC-12" title="Faster app launch" trailing={<span>☆</span>} actions={<CircleIconButton icon="link" label="Copy link" />} />);
    const h = screen.getByRole("heading", { level: 1, name: "Faster app launch" });
    expect(h.getAttribute("title")).toBe("Faster app launch");
    expect(document.querySelector(".v2-pagehead-id")?.textContent).toBe("ORC-12");
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("scrollMainTo falls back to the window when #main is not a scroller", () => {
    const spy = vi.fn();
    const orig = window.scrollTo;
    window.scrollTo = spy as unknown as typeof window.scrollTo;
    try {
      scrollMainTo(0);
      expect(spy).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    } finally { window.scrollTo = orig; }
  });
});

describe("v2-shell.css frame rules", () => {
  const css = readFileSync(resolve(__dirname, "../../../static/styles/v2-shell.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel: RegExp) => css.split("}").filter((r) => sel.test(r.split("{")[0])).join("}");

  it("the panel is inset, bordered, rounded and clipped; only #main scrolls", () => {
    const main = rule(/(^|\n)\.v2-main\s*$/);
    expect(main).toMatch(/margin:\s*var\(--v2-frame-gap\)/);
    expect(main).toMatch(/border:\s*1px solid/);
    expect(main).toMatch(/border-radius:\s*var\(--v2-panel-radius/);
    expect(main).toMatch(/overflow:\s*hidden/);
    expect(rule(/(^|\n)\.v2-content\s*$/)).toMatch(/overflow-y:\s*auto/);
  });

  it("the project tabs are no longer a separate sticky bar", () => {
    const tabs = rule(/(^|\n)\.v2-ptabs\s*$/);
    expect(tabs).not.toMatch(/position:\s*sticky/);
    expect(tabs).not.toMatch(/border-bottom/);
  });

  it("the palette's active row has no coloured stripe (D3)", () => {
    const active = rule(/\.v2-palette-row\.is-active\s*$/);
    expect(active).toMatch(/box-shadow:\s*none/);
    expect(active).not.toMatch(/--v2-accent/);
  });
});
