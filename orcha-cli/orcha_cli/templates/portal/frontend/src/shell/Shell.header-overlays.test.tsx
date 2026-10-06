/**
 * Fix round 1 (header-overlays): project section TAB BAR under the header
 * (directive D1), execution popover (unknown level named, switch semantics),
 * notification-center copy, offline copy and palette payload text (D4).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { Shell, autonomyLabel, ncFallbackLabel, staleMessage } from "./Shell";
import { centerCurrentTab, isProjectSectionPage, tabCountText } from "./ProjectTabs";
import { payloadSummary, projectStatusLabel } from "./search/builtin";

const rawSnap = (autonomy_level = "plan") => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level, wakes_enabled: true },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "lead", kind: "ai", status: "working" },
  ],
  tasks: [
    { id: "t1", title: "One", status: "in_progress" },
    { id: "t2", title: "Two", status: "completed" },
    { id: "t3", title: "Three", status: "pending" },
  ],
  requests: [],
});

function stubFetch(level = "plan") {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(level));
    return json({});
  }) as unknown as typeof fetch;
}

function mount(page: string, title: string, path = "/tasks") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Shell page={page} title={title}><div>body</div></Shell>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("project tab bar (D1)", () => {
  it("renders every project section as a link under the header, the current one marked", async () => {
    stubFetch();
    mount("tasks", "Tasks");
    const nav = await screen.findByRole("navigation", { name: /sections$/ });
    const links = within(nav).getAllByRole("link");
    const labels = links.map((a) => a.querySelector(".v2-ptab-label")?.textContent);
    expect(labels.slice(0, 6)).toEqual(["Overview", "Tasks", "Routines", "Agents", "Org", "Requests"]);
    expect(labels).toContain("Activity");
    const cur = links.filter((a) => a.getAttribute("aria-current") === "page");
    expect(cur).toHaveLength(1);
    expect(cur[0].getAttribute("href")).toBe("/tasks");
    // URLs are the existing section routes (deep links unchanged)
    expect(links[0].getAttribute("href")).toBe("/");
  });

  it("no visible counts (Linear-style); the labelled count stays in the tooltip + accessible name", async () => {
    stubFetch();
    mount("tasks", "Tasks");
    await waitFor(() => expect(document.querySelector('[data-section="tasks"]')?.getAttribute("title")).toMatch(/^Tasks · 2 open tasks/));
    expect(document.querySelectorAll(".v2-ptab-count")).toHaveLength(0);
    const tasks = document.querySelector('[data-section="tasks"]')!;
    expect(tasks.querySelector(".v2-sr")?.textContent).toContain("2 open tasks");
    expect(tasks.querySelector(".v2-ptab-label")?.textContent).toBe("Tasks");
    // no count where it is not meaningful
    expect(document.querySelector('[data-section="code"]')?.getAttribute("title")).toBeNull();
  });

  it("centres the current tab when the strip overflows", () => {
    const strip = document.createElement("div");
    const tab = document.createElement("a");
    tab.setAttribute("aria-current", "page");
    strip.appendChild(tab);
    Object.defineProperties(strip, { scrollWidth: { value: 800 }, clientWidth: { value: 200 }, offsetLeft: { value: 0 } });
    Object.defineProperties(tab, { offsetLeft: { value: 500 }, offsetWidth: { value: 60 } });
    centerCurrentTab(strip);
    expect(strip.scrollLeft).toBe(430); // 500 - (200 - 60) / 2
    const fits = document.createElement("div");
    Object.defineProperties(fits, { scrollWidth: { value: 200 }, clientWidth: { value: 200 } });
    centerCurrentTab(fits);
    expect(fits.scrollLeft).toBe(0);
  });

  it("arrow keys move focus along the bar", async () => {
    stubFetch();
    mount("tasks", "Tasks");
    const nav = await screen.findByRole("navigation", { name: /sections$/ });
    const links = within(nav).getAllByRole("link");
    links[1].focus();
    fireEvent.keyDown(links[1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(links[2]);
    fireEvent.keyDown(links[2], { key: "Home" });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(links[links.length - 1]);
  });

  it("is not shown on non-project pages", async () => {
    stubFetch();
    mount("settings", "Settings", "/settings");
    await waitFor(() => expect(document.getElementById("topbar")).toBeTruthy());
    expect(document.querySelector(".v2-ptabs")).toBeNull();
    expect(isProjectSectionPage("needs")).toBe(false);
    expect(isProjectSectionPage("home")).toBe(true);
  });

  it("caps large counts", () => {
    expect(tabCountText(12)).toBe("12");
    expect(tabCountText(1500)).toBe("999+");
  });
});

describe("execution controls", () => {
  it("names an unknown / legacy level (tooltip + one muted popover line), never in the chip", async () => {
    stubFetch("supervised");
    mount("tasks", "Tasks");
    await waitFor(() => expect(document.getElementById("execBtn")?.getAttribute("title")).toContain("Autonomy: set on server (supervised)"));
    expect(document.getElementById("execBtn")!.textContent).not.toContain("Custom");
    fireEvent.click(document.getElementById("execBtn")!);
    const dlg = await screen.findByRole("dialog", { name: "Execution controls" });
    expect(dlg.textContent).toContain("Level set on server: supervised");
    expect(dlg.querySelector(".v2-exec-note, .v2-exec-custom")).toBeNull(); // explainer is an ⓘ tooltip (+ SR text)
    expect(autonomyLabel("pr")).toEqual({ label: "Build to PR", known: true });
    expect(autonomyLabel("")).toEqual({ label: "Custom (unset)", known: false });
  });

  it("the notifier is a switch with its consequence as a description", async () => {
    stubFetch();
    mount("tasks", "Tasks");
    await waitFor(() => expect(document.getElementById("execBtn")).toBeTruthy());
    fireEvent.click(document.getElementById("execBtn")!);
    const sw = await screen.findByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(document.getElementById(sw.getAttribute("aria-describedby")!)?.textContent).not.toMatch(/^On\b/); // the switch says On; the line says what's observed (m1)
    expect(sw.querySelector(".v2-switch-track")).toBeTruthy();
  });
});

describe("copy helpers (D4)", () => {
  it("unknown notification types get a generic label, never the raw type", () => {
    expect(ncFallbackLabel("task")).toBe("Task update");
    expect(ncFallbackLabel("request")).toBe("Request update");
    expect(ncFallbackLabel(undefined)).toBe("Notification");
  });

  it("offline copy never includes URLs or status codes", () => {
    expect(staleMessage(true, "10:13")).toBe("Can't reach Embodent · showing data from 10:13");
    expect(staleMessage(false, null)).toBe("Can't reach Embodent · no project data loaded");
  });

  it("payloadSummary picks a human field and never returns JSON", () => {
    expect(payloadSummary({ question: "Ship it?" })).toBe("Ship it?");
    expect(payloadSummary({ summary: "API shape", extra: { a: 1 } })).toBe("API shape");
    expect(payloadSummary('{"summary":"From a string"}')).toBe("From a string");
    expect(payloadSummary({ a: 1, b: [2] })).toBe("");
    expect(payloadSummary("plain text")).toBe("plain text");
    expect(payloadSummary(null)).toBe("");
    expect(payloadSummary({ detail: { title: "Nested" } })).toBe("");
    expect(payloadSummary({ body: { text: "Nested body" } })).toBe("Nested body");
  });

  it("project status reads in sentence case", () => {
    expect(projectStatusLabel("active")).toMatch(/^A/);
    expect(projectStatusLabel(null)).toBe("Unknown status");
  });
});
