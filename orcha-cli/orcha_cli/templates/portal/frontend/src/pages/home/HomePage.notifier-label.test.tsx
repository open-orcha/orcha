/**
 * GH #148/#149: the ctxbar stat that reflects wakes_enabled is relabeled from
 * "Autonomy" to "Notifier" (vanilla parity: static/pages/home-state.js — the
 * label is Notifier, driven by wakes_enabled, autonomy_level is untouched).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { HomePage } from "./HomePage";

const rawSnap = (wakesEnabled: boolean) => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: wakesEnabled },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
});

function stubFetch(wakesEnabled: boolean) {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(wakesEnabled));
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

describe("HomePage ctxbar stat — Notifier label (GH #148/#149)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("labels the wakes_enabled stat 'Notifier', not 'Autonomy'", async () => {
    stubFetch(true);
    mount();
    await waitFor(() => expect(document.getElementById("ctxbar")).toBeTruthy());
    const ctxbar = document.getElementById("ctxbar")!;
    expect(screen.queryByText("Autonomy", { selector: ".ctxbar .l" })).toBeNull();
    const labels = Array.from(ctxbar.querySelectorAll(".stat .l")).map((n) => n.textContent);
    expect(labels).toContain("Notifier");
  });

  it("shows Running when wakes_enabled is true", async () => {
    stubFetch(true);
    mount();
    await waitFor(() => expect(document.getElementById("ctxbar")).toBeTruthy());
    const stat = Array.from(document.querySelectorAll("#ctxbar .stat")).find((s) => s.textContent?.includes("Notifier"))!;
    expect(stat.querySelector(".n")?.textContent).toBe("Running");
  });

  it("shows Paused when wakes_enabled is false", async () => {
    stubFetch(false);
    mount();
    await waitFor(() => expect(document.getElementById("ctxbar")).toBeTruthy());
    const stat = Array.from(document.querySelectorAll("#ctxbar .stat")).find((s) => s.textContent?.includes("Notifier"))!;
    expect(stat.querySelector(".n")?.textContent).toBe("Paused");
  });
});
