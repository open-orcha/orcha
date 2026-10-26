/** Historical project/agent autonomy never exposes an editing surface. */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, _setActingIdentity } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";

interface Call {
  url: string;
  init?: RequestInit;
}
let calls: Call[] = [];

// cloud-shaped snapshot: mig-043 exposure fields on container + agents
const CLOUD_SNAPSHOT = (over?: { enforced?: boolean; a1_override?: string | null; a1_effective?: string }) => ({
  container: {
    id: "c1", name: "Orcha", status: "active", autonomy_level: "plan",
    autonomy_enforced: over?.enforced ?? false,
  },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    {
      id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "working",
      model: "claude-sonnet-4-6", wake_enabled: true, auto_wake_interval_secs: null,
      prompt_preview: "You are Forge.", embodiment: "idle",
      autonomy_override: over?.a1_override ?? null,
      effective_autonomy: over?.a1_effective ?? "plan",
    },
  ],
  tasks: [],
  requests: [],
});

// open-shaped snapshot: NO mig-043 fields anywhere
const OPEN_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "working", model: "claude-sonnet-4-6" },
  ],
  tasks: [],
  requests: [],
};

function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

function stubFetch(snapshot: unknown) {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
    if (url === "/api/models") return jsonRes({ models: [] });
    if (url.includes("/digest")) return jsonRes({ digest: null });
    if (url.includes("/runs")) return jsonRes({ runs: [] });
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/agents?agent=forge&tab=config"]}>
          <Routes>
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="*" element={<AgentsPage />} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const seg = (c: HTMLElement) => c.querySelector("#autOvrSeg") as HTMLElement | null;
const patchCalls = () => calls.filter((c) => c.url === "/api/agents/a1" && c.init?.method === "PATCH");

describe("historical per-agent autonomy is read-only", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete extensions.identity; // never leak the identity seam across tests
    _setActingIdentity(null);
  });

  it.each([undefined, "owner", "member", "viewer"])("never exposes legacy authority to a %s reader", async (role) => {
    if (role) extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: role, grants: ["manage_autonomy"] }) as Identity;
    stubFetch(CLOUD_SNAPSHOT({ enforced: true, a1_override: "full", a1_effective: "full" }));
    const { container } = mount();
    await screen.findByText(/Autonomy is set on each task/);
    expect(seg(container)).toBeNull();
    expect(container.textContent).not.toContain("Effective: Full");
    expect(container.querySelector("#awakeSeg")).not.toBeNull();
    expect(patchCalls()).toEqual([]);
  });
  it("an older server still retains ordinary wake and model controls", async () => {
    stubFetch(OPEN_SNAPSHOT); const { container } = mount();
    await waitFor(() => expect(container.querySelector("#awakeSeg")).not.toBeNull());
    expect(seg(container)).toBeNull();
    expect(container.querySelector("#modelSeg")).not.toBeNull();
    expect(patchCalls()).toEqual([]);
  });
});
