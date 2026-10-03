/**
 * V2 truthful delivery (Agent E, brief §5): a human turn the server owns is
 * "sent · awaiting reply" only while something can actually pick it up;
 * otherwise it reads "saved · queued" with the honest reason (paused wakes,
 * no runtime, busy). Once the agent's own turn lands, the human turn carries
 * no delivery label — the agent turn IS the response. Paused wakes never show
 * thinking dots for an idle agent.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation } from "./Conversation";

const AI = (id: string) => ({ id, alias: "Dlv-" + id, kind: "ai", role: "Builder", status: "idle" });
const IDS = ["d1", "d2", "d3"];
const RAW_AGENTS = [{ id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" }].concat(IDS.map(AI));
const agentOf = (id: string) => RAW_AGENTS.find((a) => a.id === id) as unknown as Agent;
const human = { seq: 1, role: "human", content: "ping", author_agent_id: "h1" };
const reply = { seq: 2, role: "agent", content: "pong", author_agent_id: "d3" };

const PAYLOADS: Record<string, unknown> = {
  d1: { conversation: { id: "cv-d1", status: "active" }, turns: [human] }, // idle agent, wakes paused
  d2: { conversation: { id: "cv-d2", status: "active" }, turns: [human], presence: "working" }, // working
  d3: { conversation: { id: "cv-d3", status: "active" }, turns: [human, reply] }, // replied
};
const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;

function stubFetch(opts: { paused: boolean }) {
  const container: Record<string, unknown> = {
    id: "c1", name: "Orcha", status: "active", autonomy_level: "plan",
    last_wake_scan_at: new Date().toISOString(), wakes_enabled: !opts.paused,
  };
  const snapshot = { container, agents: RAW_AGENTS, tasks: [], requests: [] };
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
    const m = url.match(/\/api\/agents\/([^/]+)\/conversation\?limit=/);
    if (m) return jsonRes(PAYLOADS[m[1]] ?? { conversation: null, turns: [] });
    if (url.includes("/turns")) return jsonRes({ turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(agent: Agent) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <Conversation key={agent.id} agent={agent} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("conversation delivery states", () => {
  it("wakes paused + idle agent: the turn is 'saved' and the ONE tail note says queued with the pause reason — never thinking dots", async () => {
    stubFetch({ paused: true });
    const { container } = mount(agentOf("d1"));
    await waitFor(() => expect(container.querySelector(".conv-queued")).toBeTruthy());
    expect(container.querySelector(".conv-queued")!.textContent).toContain("Wakes are paused for this project");
    expect(container.querySelector(".conv-thinking")).toBeNull();
    // r2 (D12): the tail note already says "queued" + why — the turn only says "saved"
    expect(container.querySelector(".turn.human .dlv")!.textContent).toBe("saved");
    expect((container.textContent!.match(/queued/g) || []).length).toBe(1);
  });

  it("an agent actively working: the turn is 'sent · awaiting reply' and the dots show", async () => {
    stubFetch({ paused: false });
    const { container } = mount(agentOf("d2"));
    await waitFor(() => expect(container.querySelector(".conv-thinking")).toBeTruthy());
    expect(container.querySelector(".turn.human .dlv")!.textContent).toBe("sent · awaiting reply");
  });

  it("after the agent's reply lands, the human turn carries no delivery label and no indicator shows", async () => {
    stubFetch({ paused: false });
    const { container } = mount(agentOf("d3"));
    await waitFor(() => expect(container.textContent).toContain("pong"));
    expect(container.querySelector(".turn.human .dlv")).toBeNull();
    expect(container.querySelector(".conv-queued")).toBeNull();
    expect(container.querySelector(".conv-thinking")).toBeNull();
  });
});
