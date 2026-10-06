/**
 * Parity round 2 (agents) regression tests — one per fixed item:
 *   e2e-permissions-30  a viewer's "Pair in terminal" is disabled up front with the reason
 *   EXTRA (owner-flows) the header gate callout speaks for the latest decision / a live gate,
 *                       never the first in-progress plan task in list order
 *   EXTRA (permissions) every locked per-agent autonomy override chip carries its own reason
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, _setActingIdentity } from "../../state/SnapshotProvider";
import type { Agent, Snapshot, Task } from "../../types";
import { AgentsPage, OVR_ENFORCED_REASON, pickGatePlan } from "./AgentsPage";
import { Conversation } from "./Conversation";

const fresh = () => new Date().toISOString();
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const PLAN_MSG = (who: string, at = ago(30)) => ({ body: "My plan: do the thing", author_alias: who, at });

const T = (id: string, extra: Record<string, unknown>) => ({
  id: id.padEnd(8, "0") + "-aaaa-4bbb-8ccc-000000000000",
  title: "Task " + id,
  status: "in_progress",
  priority: 50,
  assignees: ["forge"],
  created_at: ago(120),
  ...extra,
});

const SNAP = (tasks: unknown[], container: Record<string, unknown> = {}) => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: fresh(), runtime_served: true, ...container },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner" },
    { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "idle", model: "claude-opus-5", effective_autonomy: "plan", autonomy_override: null },
  ],
  tasks,
  requests: [],
});

const jsonRes = (d: unknown, status = 200) => ({ ok: status < 400, status, json: async () => d }) as Response;
function stubFetch(snapshot: unknown) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
    if (url === "/api/models") return jsonRes({ models: [] });
    if (url.includes("/digest")) return jsonRes({ digest: null });
    if (url.endsWith("/runs")) return jsonRes({ runs: [] });
    if (url.includes("/conversation")) return jsonRes({ conversation: { id: "cv1", status: "active" }, turns: [{ seq: 1, role: "human", content: "hi", author_agent_id: "h1" }] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(path: string, el = <AgentsPage />) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={el} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const asIdentity = (id: Partial<Identity>) => {
  extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", ...id }) as Identity;
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete extensions.identity;
  _setActingIdentity(null);
});

describe("e2e-permissions-30: Pair in terminal for a viewer", () => {
  const forge = SNAP([]).agents[1] as unknown as Agent;

  it("viewer: #convPair is disabled up front and its tooltip names the viewer reason", async () => {
    asIdentity({ member_role: "viewer" });
    stubFetch(SNAP([]));
    const { container } = mount("/agents", <Conversation agent={forge} />);
    await waitFor(() => expect((container.querySelector("#convPair") as HTMLButtonElement).disabled).toBe(true));
    const pair = container.querySelector("#convPair") as HTMLButtonElement;
    expect(pair.getAttribute("aria-disabled")).toBe("true");
    expect(pair.getAttribute("title")).toContain("viewer");
    // Maximize is a view-only affordance and stays usable
    expect((container.querySelector("#convMax") as HTMLButtonElement).disabled).toBe(false);
  });

  it("owner: #convPair stays enabled with the pairing tooltip", async () => {
    asIdentity({ member_role: "owner" });
    stubFetch(SNAP([]));
    const { container } = mount("/agents", <Conversation agent={forge} />);
    await waitFor(() => expect(container.querySelector("#convInput") as HTMLTextAreaElement).toBeTruthy());
    await waitFor(() => expect((container.querySelector("#convInput") as HTMLTextAreaElement).disabled).toBe(false));
    const pair = container.querySelector("#convPair") as HTMLButtonElement;
    expect(pair.disabled).toBe(false);
    expect(pair.getAttribute("aria-disabled")).toBeNull();
    expect(pair.getAttribute("title")).toContain("Pair in terminal");
  });
});

describe("EXTRA: the gate callout speaks for the latest decision / a live gate", () => {
  const staleApproved = T("aaaa0001", { title: "Fix double-charge", plan_message: PLAN_MSG("forge", ago(90)), plan_decision: { decision: "approve", actor: "kedar", at: ago(80) }, thread: [{ from: "kedar", body: "[verification rejected] Still double-charges", at: ago(40), is_human: true }] });
  const olderApproved = T("aaaa0002", { title: "Older approved plan", plan_message: PLAN_MSG("forge", ago(70)), plan_decision: { decision: "approve", actor: "kedar", at: ago(60) } });
  const newerRejected = T("aaaa0003", { title: "Newer rejected plan", plan_message: PLAN_MSG("forge", ago(30)), plan_decision: { decision: "reject", actor: "kedar", at: ago(10), reason: "Too broad" } });
  const livePlan = T("aaaa0004", { title: "Live plan", plan_message: PLAN_MSG("forge", ago(5)) });
  const verify = T("aaaa0005", { title: "Awaiting verification", status: "needs_verification" });

  it("pickGatePlan: newest decision wins; a decision superseded by a rejected verification is skipped", () => {
    const snap = SNAP([]) as unknown as Snapshot;
    const r = pickGatePlan(snap, [staleApproved, olderApproved, newerRejected] as unknown as Task[]);
    expect(r.live).toBeNull();
    expect(r.decided?.title).toBe("Newer rejected plan");
    expect(pickGatePlan(snap, [staleApproved] as unknown as Task[]).decided).toBeNull();
    // a rejection OLDER than the decision does not supersede it
    const reApproved = { ...staleApproved, plan_decision: { decision: "approve", actor: "kedar", at: ago(20) } };
    expect(pickGatePlan(snap, [reApproved] as unknown as Task[]).decided?.title).toBe("Fix double-charge");
  });

  it("pickGatePlan: an undecided plan awaiting a human is the live gate, whatever its list position", () => {
    const snap = SNAP([]) as unknown as Snapshot;
    const r = pickGatePlan(snap, [staleApproved, olderApproved, livePlan] as unknown as Task[]);
    expect(r.live?.title).toBe("Live plan");
  });

  it("renders the newest decision, not the first plan task in list order", async () => {
    asIdentity({ member_role: "owner" });
    stubFetch(SNAP([staleApproved, olderApproved, newerRejected]));
    const { container } = mount("/agents?agent=forge&tab=tasks");
    await waitFor(() => expect(container.querySelector(".gatecard.decided")).toBeTruthy());
    const card = container.querySelector(".gatecard.decided")!;
    expect(card.textContent).toContain("Plan rejected");
    expect(card.textContent).toContain("Newer rejected plan");
    expect(card.textContent).not.toContain("Fix double-charge");
  });

  it("a live verify gate outranks a quiet decided-plan note", async () => {
    asIdentity({ member_role: "owner" });
    stubFetch(SNAP([olderApproved, verify]));
    const { container } = mount("/agents?agent=forge&tab=tasks");
    await waitFor(() => expect(container.textContent).toContain("Task awaiting verification"));
    expect(container.querySelector(".gatecard.decided")).toBeNull();
  });
});

describe("EXTRA: locked autonomy override chips carry their own reason", () => {
  it("member without manage_autonomy: every override chip is disabled and titled with the grant reason", async () => {
    asIdentity({ member_role: "member", grants: [] });
    stubFetch(SNAP([]));
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(container.querySelectorAll("#autOvrSeg button").length).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelector("#autOvrSeg button")!.getAttribute("title")).toContain("manage_autonomy"));
    Array.from(container.querySelectorAll<HTMLButtonElement>("#autOvrSeg button")).forEach((b) => {
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("title")).toContain("manage_autonomy");
    });
  });

  it("viewer: the chips name the viewer reason", async () => {
    asIdentity({ member_role: "viewer" });
    stubFetch(SNAP([]));
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(container.querySelector("#autOvrSeg button")?.getAttribute("title")).toContain("viewer"));
  });

  it("enforced project: the chips say the override is ignored (even for the owner)", async () => {
    asIdentity({ member_role: "owner" });
    stubFetch(SNAP([], { autonomy_enforced: true }));
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(container.querySelector("#autOvrSeg button")?.getAttribute("title")).toBe(OVR_ENFORCED_REASON));
  });

  it("owner on an unenforced project: chips are enabled with no lock title", async () => {
    asIdentity({ member_role: "owner" });
    stubFetch(SNAP([]));
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(Array.from(container.querySelectorAll<HTMLButtonElement>("#autOvrSeg button")).some((b) => !b.disabled)).toBe(true));
    expect(container.querySelector("#autOvrSeg button")!.getAttribute("title")).toBeNull();
  });
});
