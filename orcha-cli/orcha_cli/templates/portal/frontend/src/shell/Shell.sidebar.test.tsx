/**
 * Collapsible sidebar (icon rail) — port of the cloud vanilla contract
 * (app-shell.js sidebarCollapsed/toggleSidebar + shell.css). Same localStorage
 * key ("orcha:sidebar", "collapsed" | "expanded"), same data-sidebar="collapsed"
 * attribute on <html>, so returning users keep their preference and cloud's
 * shell.css collapse rules (if any) keep applying unmodified.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { HomePage } from "../pages/home/HomePage";

const RAW_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(RAW_SNAPSHOT);
    return json({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <HomePage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const toggle = () => screen.getByRole("button", { name: /collapse sidebar|expand sidebar/i });

describe("Shell collapsible sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-sidebar");
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute("data-sidebar");
  });

  it("defaults expanded: no attribute, no persisted key", async () => {
    mount();
    await screen.findByText("Ship the feature", { exact: false }).catch(() => {});
    expect(document.documentElement.getAttribute("data-sidebar")).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });

  it("clicking the toggle collapses: sets data-sidebar and persists the vanilla key/value", async () => {
    mount();
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    fireEvent.click(toggle());
    expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
    expect(localStorage.getItem("orcha:sidebar")).toBe("collapsed");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("clicking again expands: removes the attribute and persists 'expanded'", async () => {
    mount();
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    fireEvent.click(toggle()); // collapse
    fireEvent.click(toggle()); // expand
    expect(document.documentElement.getAttribute("data-sidebar")).toBeNull();
    expect(localStorage.getItem("orcha:sidebar")).toBe("expanded");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });

  it("restores collapsed state on mount from the persisted vanilla key", async () => {
    localStorage.setItem("orcha:sidebar", "collapsed");
    mount();
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("nav links keep their hrefs and title tooltips when collapsed (still navigable)", async () => {
    localStorage.setItem("orcha:sidebar", "collapsed");
    mount();
    const agentsLink = await screen.findByRole("link", { name: /agents/i });
    expect(agentsLink).toHaveAttribute("href", "#/agents");
    expect(agentsLink).toHaveAttribute("title");
  });

  it("nav links carry no title tooltip when expanded (labels are visible text)", async () => {
    mount();
    const agentsLink = await screen.findByRole("link", { name: /agents/i });
    expect(agentsLink).not.toHaveAttribute("title");
  });

  it("counts render as a dot-style badge, not hidden entirely, in the DOM when collapsed", async () => {
    localStorage.setItem("orcha:sidebar", "collapsed");
    mount();
    // .ncount stays in the DOM (CSS hides it via display:none on the collapsed
    // rail); the attn-mini bell+count chip is the collapsed substitute that
    // stays visible and deep-links to the action queue.
    await waitFor(() => expect(document.querySelector(".attn-mini")).toBeTruthy());
    const mini = document.querySelector(".attn-mini")!;
    expect(mini.querySelector(".n")).toBeTruthy();
    expect(mini.getAttribute("href")).toBe("#/");
  });
});
