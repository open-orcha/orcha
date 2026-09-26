/**
 * S1/S5 presence behavioral tests, ported from the pytest node harnesses that
 * used to eval static/conversation.js (tests/test_s1_conversation.py
 * test_presence_derived_from_agent_status + tests/test_s5_presence_queued.py):
 * the REAL Conversation component against a stubbed fetch —
 *   - busy presence + a pending human turn → the honest "queued" notice
 *     (carrying the opaque presence_reason) + a busy pill, never fake
 *     "thinking…" dots (req b178e687);
 *   - working presence + pending → the animated thinking dots;
 *   - presence field ABSENT → derive from agent.status (the pre-contract
 *     degrade, req 6de81ae3), and an agent reply clears the durable
 *     pending-reply indicator (req 1ccab87e);
 *   - unknown future presence enum → idle (forward-compat) — queued, not dots;
 *   - the full agent.status → pill map (S1 presenceOf);
 *   - review P2 (PR #128): a stale in-flight load for agent A must never paint
 *     agent B's panel (keyed remount = the mount-token guard).
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation } from "./Conversation";

// Conversation keeps a module-level per-agent cache (ISS-68) — every scenario
// uses its OWN cache-cold agent id so no case sees the prior case's state.
const AI = (id: string, status: string) => ({ id, alias: "Frame-" + id, kind: "ai", role: "Builder", status });
const RAW_SNAPSHOT = {
  // last_wake_scan_at: a live daemon serves this project's wakes — these
  // scenarios exercise the SERVED indicator matrix (the wakes-not-served
  // honesty rule has its own suite: Conversation.honesty.test.tsx).
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: new Date().toISOString() },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    AI("q1", "idle"), AI("q2", "idle"), AI("q3", "working"), AI("q4", "idle"),
    // S1 status-map agents
    AI("m1", "working"), AI("m2", "needs_verification"), AI("m3", "awaiting_request"), AI("m4", "idle"), AI("m5", "terminated"),
    // stale-race agents
    AI("ra", "idle"), AI("rb", "working"),
  ],
  tasks: [],
  requests: [],
};
const agentOf = (id: string) => RAW_SNAPSHOT.agents.find((a) => a.id === id) as unknown as Agent;

const humanTurn = [{ seq: 1, role: "human", content: "hi", author_agent_id: "h1" }];
const agentReplied = humanTurn.concat([{ seq: 2, role: "agent", content: "hey", author_agent_id: "q3" }]);

const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;

// per-agent load payloads for GET /api/agents/{aid}/conversation?limit=
const PAYLOADS: Record<string, unknown> = {
  // 1) busy + pending human turn — the read payload carries the committed
  //    presence contract (top-level presence + opaque presence_reason)
  q1: { conversation: { id: "cv-q1", status: "active" }, turns: humanTurn, presence: "busy", presence_reason: "busy with 'Fix reset flow' — queued" },
  // 2) working + pending
  q2: { conversation: { id: "cv-q2", status: "active" }, turns: humanTurn, presence: "working" },
  // 3) field ABSENT -> derive from agent.status (q3 is "working"); agent replied last
  q3: { conversation: { id: "cv-q3", status: "active" }, turns: agentReplied },
  // 4) unknown future enum + pending human turn
  q4: { conversation: { id: "cv-q4", status: "active" }, turns: humanTurn, presence: "frobnicate" },
  // stale race: ra's load is HELD OPEN (busy + reason); rb loads working+pending
  ra: { conversation: { id: "cv-ra", status: "active" }, turns: humanTurn, presence: "busy", presence_reason: "RA is busy — queued" },
  rb: { conversation: { id: "cv-rb", status: "active" }, turns: humanTurn, presence: "working" },
};

let holds: Record<string, () => void> = {};
function stubFetch(opts?: { hold?: string[] }) {
  holds = {};
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(RAW_SNAPSHOT);
    const m = url.match(/\/api\/agents\/([^/]+)\/conversation\?limit=/);
    if (m) {
      const payload = PAYLOADS[m[1]] ?? { conversation: null, turns: [] };
      if (opts?.hold?.includes(m[1])) {
        return new Promise<Response>((res) => { holds[m[1]] = () => res(jsonRes(payload)); });
      }
      return jsonRes(payload);
    }
    if (url.includes("/turns")) return jsonRes({ turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}

function mount(agent: Agent) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        {/* keyed per agent, mirroring AgentsPage's key={a.id} remount */}
        <Conversation key={agent.id} agent={agent} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const pill = (c: HTMLElement) => c.querySelector("#convPresence") as HTMLElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("S5 presence — queued vs thinking vs fallback (vanilla conversation.js parity)", () => {
  it("busy + a pending human turn shows the honest queued notice (with reason) + busy pill, never fake thinking dots", async () => {
    stubFetch();
    const { container } = mount(agentOf("q1"));
    await waitFor(() => expect(pill(container).className).toContain("p-busy"));
    expect(pill(container).textContent).toContain("busy");
    const queued = container.querySelector(".conv-queued");
    expect(queued).toBeTruthy();
    expect(queued!.textContent).toContain("Fix reset flow"); // the opaque reason, verbatim
    expect(container.querySelector(".conv-thinking")).toBeNull(); // busy must NOT show fake dots
  });

  it("working + a pending human turn shows the animated thinking dots, not a queued notice", async () => {
    stubFetch();
    const { container } = mount(agentOf("q2"));
    await waitFor(() => expect(pill(container).className).toContain("p-working"));
    expect(container.querySelector(".conv-thinking")).toBeTruthy();
    expect(container.querySelector(".conv-queued")).toBeNull();
  });

  it("absent presence falls back to agent.status; an agent reply clears the pending indicator", async () => {
    stubFetch();
    const { container } = mount(agentOf("q3")); // status: working, no presence field
    await waitFor(() => expect(container.textContent).toContain("hey")); // load landed
    expect(pill(container).className).toContain("p-working"); // derived from agent.status
    // agent replied last -> the durable indicator is gone (neither dots nor queued)
    expect(container.querySelector(".conv-thinking")).toBeNull();
    expect(container.querySelector(".conv-queued")).toBeNull();
  });

  it("an unknown future presence enum (frobnicate) degrades to idle — a pending turn shows queued, not dots", async () => {
    stubFetch();
    const { container } = mount(agentOf("q4"));
    await waitFor(() => expect(container.querySelector(".conv-queued")).toBeTruthy());
    expect(pill(container).className).toContain("p-idle");
    expect(pill(container).textContent).toContain("idle");
    // no reason supplied -> the generic honest fallback line
    expect(container.querySelector(".conv-queued")!.textContent).toContain("is busy with another task");
    expect(container.querySelector(".conv-thinking")).toBeNull();
  });
});

describe("S1 presenceOf — the agent.status → pill map (no presence contract)", () => {
  it.each([
    ["m1", "p-working", "working"],
    ["m2", "p-replied", "replied"],
    ["m3", "p-waking", "waiting"],
    ["m4", "p-idle", "idle"],
    ["m5", "p-offline", "offline"],
  ])("agent %s derives %s (%s)", async (aid, cls, label) => {
    stubFetch();
    const { container } = mount(agentOf(aid as string));
    await waitFor(() => expect(pill(container).className).toContain(cls as string));
    expect(pill(container).textContent).toContain(label as string);
  });
});

describe("S5 review P2 (PR #128) — stale response isolation", () => {
  it("a stale in-flight load for agent A never paints agent B's panel (busy pill / queued reason stay A's)", async () => {
    stubFetch({ hold: ["ra"] });
    // mount A -> its load (busy + reason) HANGS in flight
    const first = mount(agentOf("ra"));
    // switch to B before A's response resolves (keyed remount = teardown)
    first.unmount();
    const second = mount(agentOf("rb"));
    await waitFor(() => expect(pill(second.container).className).toContain("p-working"));
    // now A's stale busy response resolves — it must be dropped, not painted onto B
    holds["ra"]?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(pill(second.container).className).toContain("p-working");
    expect(pill(second.container).className).not.toContain("p-busy");
    expect(second.container.textContent).not.toContain("RA is busy");
    expect(second.container.querySelector(".conv-queued")).toBeNull();
    // B shows its own working/thinking indicator
    expect(second.container.querySelector(".conv-thinking")).toBeTruthy();
  });
});
