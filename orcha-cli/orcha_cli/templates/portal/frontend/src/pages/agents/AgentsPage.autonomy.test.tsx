/**
 * #64 per-agent autonomy override UI (mig 043 + the mig-039 affordance gates)
 * — the tripwire teeth (cloud tests/test_iss64_autonomy_override.py):
 *   - explicit-null Inherit chip: "Inherit" PATCHes autonomy_override: null
 *     (clear-to-inherit), a level chip PATCHes the exact enum value;
 *   - the effective_autonomy badge: the desc always names the EFFECTIVE level;
 *   - the enforced lock glyph: an enforcing container parks the chips and says
 *     so (🔒), never misreading the live state;
 *   - gating: owner / manage_autonomy grant may edit; viewers and ungranted
 *     members see the state read-only (chips disabled);
 *   - graceful absence: an open backend that omits the exposure fields renders
 *     NO override control.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
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
        <MemoryRouter initialEntries={["/agents?agent=forge"]}>
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
const chips = (c: HTMLElement) => Array.from(seg(c)?.querySelectorAll("button") ?? []) as HTMLButtonElement[];
const patchCalls = () => calls.filter((c) => c.url === "/api/agents/a1" && c.init?.method === "PATCH");

describe("#64 per-agent autonomy override segment (mig 043 + mig 039 gates)", () => {
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

  it("renders the four chips + the EFFECTIVE badge; Inherit lit on a null override (open trust-off: acting human may edit)", async () => {
    stubFetch(CLOUD_SNAPSHOT());
    const { container } = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(seg(container)).toBeTruthy());
    expect(chips(container).map((b) => b.textContent)).toEqual(["Inherit", "Plan-only", "Build to PR", "Full"]);
    const on = seg(container)!.querySelector("button.on");
    expect(on?.textContent).toBe("Inherit"); // explicit-null inherit state
    // the desc names the server-computed EFFECTIVE level
    expect(container.textContent).toContain("Effective: Plan-only — inherits the container level");
    chips(container).forEach((b) => expect(b.disabled).toBe(false)); // trust off → permissive affordance
  });

  it("graceful absence: an open backend without the exposure fields renders NO override control", async () => {
    stubFetch(OPEN_SNAPSHOT);
    const { container } = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(container.querySelector("#awakeSeg")).toBeTruthy()); // controls card is up …
    expect(seg(container)).toBeNull(); // … but no override segment
    expect(container.textContent).not.toContain("autonomy override");
  });

  it("a level chip PATCHes the exact vanilla body to /api/agents/{id}", async () => {
    stubFetch(CLOUD_SNAPSHOT());
    const { container } = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(seg(container)).toBeTruthy());
    fireEvent.click(chips(container).find((b) => b.textContent === "Full")!);
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(patchCalls()[0].init!.body).toBe(JSON.stringify({ actor_agent_id: "h1", autonomy_override: "full" }));
    // optimistic: the badge names the overridden effective level immediately
    expect(container.textContent).toContain("Effective: Full — per-agent override");
  });

  it("the Inherit chip PATCHes an EXPLICIT null (clear-to-inherit, never omitted)", async () => {
    stubFetch(CLOUD_SNAPSHOT({ a1_override: "full", a1_effective: "full" }));
    const { container } = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(seg(container)).toBeTruthy());
    expect(seg(container)!.querySelector("button.on")?.textContent).toBe("Full");
    expect(container.textContent).toContain("Effective: Full — per-agent override");
    fireEvent.click(chips(container).find((b) => b.textContent === "Inherit")!);
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    // the body carries the null EXPLICITLY — the backend's model_fields_set clear
    expect(patchCalls()[0].init!.body).toBe(JSON.stringify({ actor_agent_id: "h1", autonomy_override: null }));
    expect(String(patchCalls()[0].init!.body)).toContain('"autonomy_override":null');
  });

  it("re-clicking the active chip is a no-op (no PATCH)", async () => {
    stubFetch(CLOUD_SNAPSHOT());
    const { container } = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(seg(container)).toBeTruthy());
    fireEvent.click(chips(container).find((b) => b.textContent === "Inherit")!);
    await new Promise((r) => setTimeout(r, 20));
    expect(patchCalls()).toHaveLength(0);
  });

  it("enforced container: chips park disabled and the desc carries the lock glyph + honest copy", async () => {
    stubFetch(CLOUD_SNAPSHOT({ enforced: true, a1_override: "full", a1_effective: "plan" }));
    const { container } = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(seg(container)).toBeTruthy());
    chips(container).forEach((b) => expect(b.disabled).toBe(true));
    // the parked override stays visible; the effective level is the container's
    expect(seg(container)!.querySelector("button.on")?.textContent).toBe("Full");
    expect(container.textContent).toContain("Effective: Plan-only — 🔒 container enforces its level for all agents (override ignored)");
  });

  it("mig 039 gating: a viewer sees the state read-only (chips disabled)", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "viewer" }) as Identity;
    stubFetch(CLOUD_SNAPSHOT());
    const { container } = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(seg(container)).toBeTruthy());
    await waitFor(() => expect(chips(container).every((b) => b.disabled)).toBe(true));
    // still SEES the current override + effective level
    expect(container.textContent).toContain("Effective: Plan-only");
  });

  it("mig 039 gating: a member without manage_autonomy is read-only; WITH the grant may edit; owners always may", async () => {
    // ungranted member
    extensions.identity = async () => ({ agent_id: "h1", member_role: "member", grants: ["manage_agents"] }) as Identity;
    stubFetch(CLOUD_SNAPSHOT());
    let view = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(seg(view.container)).toBeTruthy());
    await waitFor(() => expect(chips(view.container).every((b) => b.disabled)).toBe(true));
    view.unmount();
    _setActingIdentity(null);

    // manage_autonomy holder
    extensions.identity = async () => ({ agent_id: "h1", member_role: "member", grants: ["manage_autonomy"] }) as Identity;
    stubFetch(CLOUD_SNAPSHOT());
    view = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(seg(view.container)).toBeTruthy());
    await waitFor(() => expect(chips(view.container).every((b) => !b.disabled)).toBe(true));
    view.unmount();
    _setActingIdentity(null);

    // owner (implicitly holds every grant)
    extensions.identity = async () => ({ agent_id: "h1", member_role: "owner" }) as Identity;
    stubFetch(CLOUD_SNAPSHOT());
    view = mount();
    await screen.findByText("Roster · 2");
    await waitFor(() => expect(seg(view.container)).toBeTruthy());
    await waitFor(() => expect(chips(view.container).every((b) => !b.disabled)).toBe(true));
  });
});
