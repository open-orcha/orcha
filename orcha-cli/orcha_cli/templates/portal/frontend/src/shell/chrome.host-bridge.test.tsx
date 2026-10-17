/**
 * QA #12 — desktop host bridge wiring in ChromeProvider:
 *  - `route` reports the RESOLVED cid on multi-container stacks (the ?cid= pin
 *    is a raw replaceState react-router never observes), re-sent once it
 *    resolves;
 *  - a host `navigate` within the resolved container SPA-navigates, while one
 *    naming ANOTHER container is a full document load (the provider resolves
 *    cid once, so an SPA navigate would mix project X's URL with Y's data).
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import type { HostToPortal, PortalToHost } from "../state/host";
import { ChromeProvider } from "./chrome";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: true },
  agents: [], tasks: [], requests: [],
};

let sent: PortalToHost[];
let listener: ((m: HostToPortal) => void) | null;

function installHost() {
  sent = [];
  listener = null;
  (window as unknown as { orchaHost: unknown }).orchaHost = {
    version: 1,
    capabilities: ["sidebar"],
    project: "p",
    send: (m: PortalToHost) => { sent.push(m); },
    on: (cb: (m: HostToPortal) => void) => { listener = cb; return () => { listener = null; }; },
  };
}

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }, { id: "c2", status: "stopped" }]);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
}

function Probe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/tasks"]}>
          <ChromeProvider framed>
            <Probe />
          </ChromeProvider>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const routes = () => sent.filter((m): m is Extract<PortalToHost, { type: "route" }> => m.type === "route");

describe("ChromeProvider host bridge (QA #12)", () => {
  beforeEach(() => { localStorage.clear(); installHost(); stubFetch(); window.history.replaceState(null, "", "/tasks"); });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as unknown as { orchaHost?: unknown }).orchaHost;
    document.documentElement.removeAttribute("data-embed");
  });

  it("route messages carry the resolved cid once it resolves on a multi-container stack", async () => {
    mount();
    expect(sent[0]).toEqual({ type: "ready", version: 1 });
    await waitFor(() => expect(routes().at(-1)?.search).toBe("?cid=c1"));
    expect(routes().at(-1)?.path).toBe("/tasks");
  });

  it("navigate within the resolved container is SPA; another container's path is a full load", async () => {
    const assign = vi.fn();
    const origLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...origLocation, assign, search: origLocation.search, href: origLocation.href } });
    try {
      mount();
      await waitFor(() => expect(routes().at(-1)?.search).toBe("?cid=c1"));
      act(() => { listener?.({ type: "navigate", path: "/requests?cid=c1&req=r1" }); });
      await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/requests?cid=c1&req=r1"));
      expect(assign).not.toHaveBeenCalled();

      act(() => { listener?.({ type: "navigate", path: "/tasks?cid=c2" }); });
      expect(assign).toHaveBeenCalledWith("/tasks?cid=c2");
      expect(screen.getByTestId("loc").textContent).toBe("/requests?cid=c1&req=r1"); // router untouched
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: origLocation });
    }
  });
});
