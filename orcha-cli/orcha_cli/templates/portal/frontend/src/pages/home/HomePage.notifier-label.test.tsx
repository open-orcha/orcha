/**
 * GH #148/#149: the notifier (wakes_enabled + last_wake_scan_at) is stated
 * truthfully and independently of autonomy_level.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { HomePage } from "./HomePage";

const rawSnap = (wakesEnabled: boolean, lastScan: string | null | undefined = new Date().toISOString()) => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: wakesEnabled, last_wake_scan_at: lastScan },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
});

function stubFetch(wakesEnabled: boolean, lastScan?: string | null) {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(wakesEnabled, lastScan === undefined ? new Date().toISOString() : lastScan));
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

// D12: the notifier state + autonomy are shown by the header's Execution chip;
// the Overview no longer repeats them as ctxbar stats. The empty-project
// checklist (step 4) still states the notifier truthfully (three states from
// last_wake_scan_at; never "running" without a recent wake scan).
const step4 = () => document.querySelector("#onbCta li[data-notifier]") as HTMLElement | null;

describe("HomePage notifier truthfulness (GH #148/#149)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("does not duplicate the header's Notifier / Autonomy facts in the summary", async () => {
    stubFetch(true);
    mount();
    await waitFor(() => expect(document.getElementById("ctxbar")).toBeTruthy());
    const ctxbar = document.getElementById("ctxbar")!;
    expect(ctxbar.textContent).not.toMatch(/Notifier|Autonomy|Plan-only/);
  });

  it("running: a recent wake scan marks the step done", async () => {
    stubFetch(true);
    mount();
    await waitFor(() => expect(step4()).toBeTruthy());
    expect(step4()!.dataset.notifier).toBe("running");
    expect(step4()!.classList.contains("done")).toBe(true);
    expect(step4()!.textContent).toMatch(/wake service checked this project/);
  });

  it("wakes enabled but no wake service ever seen is NOT running", async () => {
    stubFetch(true, null);
    mount();
    await waitFor(() => expect(step4()).toBeTruthy());
    expect(step4()!.dataset.notifier).toBe("none");
    expect(step4()!.classList.contains("done")).toBe(false);
    expect(step4()!.textContent).toMatch(/No wake service is serving this project yet/);
  });

  it("wakes enabled with a stale wake-scan stamp says agents are not being woken", async () => {
    stubFetch(true, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    mount();
    await waitFor(() => expect(step4()).toBeTruthy());
    expect(step4()!.dataset.notifier).toBe("stale");
    expect(step4()!.textContent).toMatch(/not being woken right now/);
  });

  it("paused when wakes_enabled is false", async () => {
    stubFetch(false);
    mount();
    await waitFor(() => expect(step4()).toBeTruthy());
    expect(step4()!.dataset.notifier).toBe("paused");
    expect(step4()!.textContent).toMatch(/Wakes are paused/);
  });
});
