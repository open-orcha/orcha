/**
 * CloudHome — the access-model "/" gate (vanilla homeBoot parity): a bare "/"
 * on a multi-project stack redirects to /projects; the single-project case and
 * any ?cid= deep link render the open HomePage without bouncing.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { CloudHome } from "./homeGate";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

function stubFetch(nContainers: number) {
  const list = Array.from({ length: nContainers }, (_, i) => ({ id: "c" + (i + 1), status: "active" }));
  const json = (data: unknown) =>
    ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json({ containers: list });
    if (url.startsWith("/api/containers/")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
}

function mount(initialEntry: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/" element={<CloudHome />} />
            <Route path="/projects" element={<div data-testid="projects-probe">projects landing</div>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("CloudHome (vanilla home-boot redirect decision)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("bare '/' on a multi-project stack redirects to /projects (replace)", async () => {
    stubFetch(2);
    mount("/");
    expect(await screen.findByTestId("projects-probe")).toBeInTheDocument();
  });

  it("0 projects also goes to the hub (empty state beats a load-error toast)", async () => {
    stubFetch(0);
    mount("/");
    expect(await screen.findByTestId("projects-probe")).toBeInTheDocument();
  });

  it("bare '/' on the single-project case renders the open HomePage", async () => {
    stubFetch(1);
    mount("/");
    // HomePage's action queue renders — no bounce to the hub
    expect(await screen.findByText("✓ Nothing needs you right now.")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-probe")).not.toBeInTheDocument();
  });

  it("a cid-carrying '/' never bounces, even multi-project", async () => {
    stubFetch(3);
    mount("/?cid=c2");
    expect(await screen.findByText("✓ Nothing needs you right now.")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-probe")).not.toBeInTheDocument();
  });
});
