/**
 * Conversation honesty — the wakesServed signal (port of vanilla
 * conversation-render.js indicatorBubble + renderWakesBanner over
 * app-data.js wakesServed, mig 037):
 *   - a container with NO fresh last_wake_scan_at stamp (portal-only project —
 *     nothing serves its wakes) must NEVER show fake "thinking…" dots: the
 *     pending indicator is the honest "queued until a runtime exists" notice
 *     and a persistent (non-dismissible) banner sits over the thread;
 *   - a fresh stamp (a bound workspace's daemon polls) → the normal indicator
 *     matrix (dots while working) and NO banner;
 *   - cold-start honesty: with wakes served but no agent turn yet, the dots
 *     say "starting…" with the session-boot note, never a seconds-away read.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation } from "./Conversation";

// Conversation keeps a module-level per-agent cache (ISS-68) — every scenario
// uses its OWN cache-cold agent id so no case sees the prior case's state.
const AI = (id: string) => ({ id, alias: "Frame-" + id, kind: "ai", role: "Builder", status: "idle" });
const AGENT_IDS = ["w1", "w2", "w3", "w4", "w5"];
const RAW_AGENTS = [{ id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" }].concat(AGENT_IDS.map(AI));
const agentOf = (id: string) => RAW_AGENTS.find((a) => a.id === id) as unknown as Agent;

const humanTurn = [{ seq: 1, role: "human", content: "hi", author_agent_id: "h1" }];

const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;

// per-agent load payloads for GET /api/agents/{aid}/conversation?limit=
const PAYLOADS: Record<string, unknown> = {
  w1: { conversation: { id: "cv-w1", status: "active" }, turns: humanTurn, presence: "working" }, // unserved × pending
  w2: { conversation: { id: "cv-w2", status: "active" }, turns: [] }, // unserved × not pending
  w3: { conversation: { id: "cv-w3", status: "active" }, turns: humanTurn, presence: "working" }, // served × pending
  w4: { conversation: { id: "cv-w4", status: "active" }, turns: [] }, // served × not pending
  w5: { conversation: { id: "cv-w5", status: "active" }, turns: humanTurn, presence: "working" }, // served, cold start
};

// wakesServed derives from containers.last_wake_scan_at (mig 037): a stamp
// within ~2 minutes means a host-side daemon serves this project's wakes.
function stubFetch(opts: { served: boolean }) {
  const container: Record<string, unknown> = { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" };
  if (opts.served) container.last_wake_scan_at = new Date().toISOString();
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

describe("conversation honesty — wakesServed × pending matrix (vanilla parity)", () => {
  it("wakes NOT served + pending turn: honest queued notice with the runtime copy — never thinking dots (even while presence says working)", async () => {
    stubFetch({ served: false });
    const { container } = mount(agentOf("w1"));
    await waitFor(() => expect(container.querySelector(".conv-queued")).toBeTruthy());
    expect(container.querySelector(".conv-queued")!.textContent).toContain(
      "Message queued — this project has no agent runtime yet. It is delivered once a workspace binds on the host.",
    );
    expect(container.querySelector(".conv-thinking")).toBeNull(); // dots would be a lie
  });

  it("wakes NOT served: the persistent banner sits over the thread (pending or not)", async () => {
    stubFetch({ served: false });
    const { container } = mount(agentOf("w2"));
    await waitFor(() => expect(container.querySelector("#convWakes .conv-wakes")).toBeTruthy());
    const banner = container.querySelector("#convWakes .conv-wakes")!;
    expect(banner.textContent).toContain("No agent runtime yet");
    expect(banner.textContent).toContain("This project has no agent runtime yet — messages will queue until a workspace binds on the host.");
    // no pending turn -> no indicator bubble, but the banner stays
    expect(container.querySelector(".conv-queued")).toBeNull();
    expect(container.querySelector(".conv-thinking")).toBeNull();
  });

  it("wakes served + pending + working: the normal thinking dots, and NO banner", async () => {
    stubFetch({ served: true });
    const { container } = mount(agentOf("w3"));
    await waitFor(() => expect(container.querySelector(".conv-thinking")).toBeTruthy());
    expect(container.querySelector(".conv-queued")).toBeNull();
    expect(container.querySelector("#convWakes .conv-wakes")).toBeNull();
  });

  it("wakes served + no pending turn: no banner, no indicator", async () => {
    stubFetch({ served: true });
    const { container } = mount(agentOf("w4"));
    await waitFor(() => expect(container.textContent).toContain("No messages yet"));
    expect(container.querySelector("#convWakes .conv-wakes")).toBeNull();
    expect(container.querySelector(".conv-queued")).toBeNull();
    expect(container.querySelector(".conv-thinking")).toBeNull();
  });

  it("cold-start honesty: no agent turn yet → the dots say starting… with the session-boot note", async () => {
    stubFetch({ served: true });
    const { container } = mount(agentOf("w5"));
    await waitFor(() => expect(container.querySelector(".conv-thinking")).toBeTruthy());
    expect(container.textContent).toContain("starting…");
    expect(container.querySelector(".conv-coldnote")!.textContent).toContain("starting the agent’s session — the first reply can take a minute");
  });
});
