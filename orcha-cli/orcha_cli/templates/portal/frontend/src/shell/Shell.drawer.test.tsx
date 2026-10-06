/**
 * QA: the ≤ 900 px navigation drawer is not a reverse keyboard trap —
 * closed: inert + aria-hidden (off-screen controls take no Tab focus);
 * open: role=dialog aria-modal, focus moves to Close, main area inert;
 * Escape closes and returns focus to the hamburger (aria-expanded tracks it).
 * Also: Move up / Move down are disabled at the list edges (no dead items).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { HomePage } from "../pages/home/HomePage";

const raw = {
  container: { id: "c1", name: "Website", status: "active", autonomy_level: "plan", wakes_enabled: true },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [], requests: [],
};
function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json({ containers: [{ id: "c1", name: "Website", status: "active" }, { id: "c2", name: "API", status: "active" }] });
    if (url.startsWith("/api/containers/c1")) return json(raw);
    return json({});
  }) as unknown as typeof fetch;
}
function mockNarrow(narrow: boolean) {
  window.matchMedia = vi.fn((q: string) => ({
    matches: narrow && q.includes("max-width: 900px"), media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
function mount() {
  return render(<ToastProvider><SnapshotProvider><HashRouter><HomePage /></HashRouter></SnapshotProvider></ToastProvider>);
}

const origMM = window.matchMedia;
beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); stubFetch(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.matchMedia = origMM; document.documentElement.removeAttribute("data-drawer"); });

describe("narrow drawer", () => {
  it("closed drawer is inert; open drawer is a modal dialog; Escape returns focus to the hamburger", async () => {
    mockNarrow(true);
    mount();
    await screen.findAllByText("Website");
    const aside = document.getElementById("sidebar")!;
    await waitFor(() => expect(aside.hasAttribute("inert")).toBe(true));
    expect(aside.getAttribute("aria-hidden")).toBe("true");
    const burger = screen.getByRole("button", { name: "Open navigation" });
    expect(burger.getAttribute("aria-expanded")).toBe("false");
    expect(burger.getAttribute("aria-controls")).toBe("sidebar");
    burger.focus();
    fireEvent.click(burger);
    await waitFor(() => expect(aside.getAttribute("role")).toBe("dialog"));
    expect(aside.getAttribute("aria-modal")).toBe("true");
    expect(aside.hasAttribute("inert")).toBe(false);
    expect(burger.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Close navigation"));
    expect(document.querySelector(".v2-main")!.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(aside.hasAttribute("inert")).toBe(true));
    expect(document.activeElement).toBe(burger);
    expect(document.querySelector(".v2-main")!.hasAttribute("inert")).toBe(false);
  });

  it("wide layouts never mark the sidebar inert", async () => {
    mockNarrow(false);
    mount();
    await screen.findAllByText("Website");
    expect(document.getElementById("sidebar")!.hasAttribute("inert")).toBe(false);
  });

  it("Move up is disabled for the first project and Move down for the last", async () => {
    mockNarrow(false);
    mount();
    await waitFor(() => expect(document.querySelectorAll(".v2-sb-proj").length).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Website actions" }));
    const up = await screen.findByRole("menuitem", { name: /Move up/ });
    expect(up.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: /Move down/ }).getAttribute("aria-disabled")).not.toBe("true");
  });
});
