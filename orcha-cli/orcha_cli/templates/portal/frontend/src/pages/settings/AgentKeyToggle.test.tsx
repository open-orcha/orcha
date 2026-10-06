/**
 * AgentKeyToggle — "Use for agent runs" on the Anthropic / OpenAI key rows
 * (migration 071). Pure view-state + the rendered switch: hidden for a key the
 * backend says can't serve an agent runtime, disabled until a key is stored,
 * the exact human-gated PUT body, and a clear "On" state once it flips.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AGENT_KEY_CAPTION, AgentKeyToggle, agentEntryOf, agentKeyView, providerUnsetCopy, type AgentKeyEntry } from "./AgentKeyToggle";

interface Call { url: string; method: string; body: unknown }

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

function stubFetch(putStatus = 200): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
    if (url.endsWith("/agent-use") && method === "PUT") {
      if (putStatus >= 400) return json({ detail: "store an API key for this provider first" }, putStatus);
      const b = JSON.parse(String(init!.body));
      return json({ provider: url.split("/").slice(-2)[0], use_for_agents: b.use_for_agents, agent_runtime: "codex" });
    }
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount(provider: string, entry: AgentKeyEntry | null) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <AgentKeyToggle cid="c1" provider={provider} entry={entry} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const sw = () => screen.getByRole("switch", { name: "Use for agent runs" });

describe("agentKeyView", () => {
  it("off with a stored key → movable, says the CLI login is used", () => {
    const v = agentKeyView({ provider: "openai", stored: true, use_for_agents: false, agent_runtime: "codex" }, true);
    expect(v.on).toBe(false);
    expect(v.disabledReason).toBeNull();
    expect(v.stateText).toMatch(/^Off — Codex runs use the CLI's own Claude\/ChatGPT login/);
  });
  it("on → a clear On state naming the runtime", () => {
    const v = agentKeyView({ provider: "anthropic", stored: true, use_for_agents: true, agent_runtime: "claude" }, true);
    expect(v.on).toBe(true);
    expect(v.stateText).toBe("On — Claude Code runs on this project bill this API key.");
  });
  it("no stored key → disabled with the reason", () => {
    const v = agentKeyView({ provider: "openai", stored: false, use_for_agents: false, agent_runtime: "codex" }, true);
    expect(v.disabledReason).toBe("Save a key on this project first.");
  });
  it("no manage_keys authority → locked", () => {
    expect(agentKeyView({ provider: "openai", stored: true, agent_runtime: "codex" }, false).disabledReason).toBe("locked");
  });
  it("OpenAI's empty-row copy points at Codex agent runs", () => {
    expect(providerUnsetCopy("openai")).toMatch(/Codex agents on the OpenAI API/);
    expect(providerUnsetCopy("xai")).toMatch(/Use-cases on this provider/);
  });
});

describe("agentEntryOf", () => {
  it("null against an older portal (no agent_runtime)", () => {
    expect(agentEntryOf("anthropic", { configured: true } as never)).toBeNull();
  });
  it("normalises the GET slice", () => {
    expect(agentEntryOf("openai", { stored: true, use_for_agents: true, agent_runtime: "codex" })).toEqual({
      provider: "openai", stored: true, use_for_agents: true, agent_runtime: "codex",
    });
  });
});

describe("AgentKeyToggle", () => {
  beforeEach(() => { localStorage.clear(); }); // the only human (h1) acts
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders nothing for a key that can't serve an agent runtime, or an older portal", () => {
    stubFetch();
    const a = mount("xai", { provider: "xai", stored: true, agent_runtime: null });
    expect(a.container.querySelector(".ak-row")).toBeNull();
    cleanup();
    const b = mount("anthropic", null);
    expect(b.container.querySelector(".ak-row")).toBeNull();
  });

  it("shows the switch + caption, off by default", async () => {
    stubFetch();
    mount("openai", { provider: "openai", stored: true, use_for_agents: false, agent_runtime: "codex" });
    expect(sw()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(AGENT_KEY_CAPTION)).toBeInTheDocument();
    expect(AGENT_KEY_CAPTION).toBe("Agents on this project bill this API key instead of a Claude/ChatGPT subscription.");
  });

  it("flipping on PUTs {use_for_agents:true, actor_agent_id} and shows the On state", async () => {
    const calls = stubFetch();
    mount("openai", { provider: "openai", stored: true, use_for_agents: false, agent_runtime: "codex" });
    await waitFor(() => expect(sw()).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(sw());
    await waitFor(() => expect(sw()).toHaveAttribute("aria-checked", "true"));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/containers/c1/settings/provider-keys/openai/agent-use");
    expect(put.body).toEqual({ use_for_agents: true, actor_agent_id: "h1" });
    expect(document.querySelector(".ak-row")).toHaveAttribute("data-agent-key", "on");
    expect(document.querySelector(".ak-state.is-on")!.textContent).toBe("On — Codex runs on this project bill this API key.");
  });

  it("flipping off PUTs use_for_agents:false", async () => {
    const calls = stubFetch();
    mount("anthropic", { provider: "anthropic", stored: true, use_for_agents: true, agent_runtime: "claude" });
    expect(sw()).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(sw()).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(sw());
    await waitFor(() => expect(sw()).toHaveAttribute("aria-checked", "false"));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ use_for_agents: false, actor_agent_id: "h1" });
  });

  it("no stored key → the switch is disabled and never PUTs", async () => {
    const calls = stubFetch();
    mount("anthropic", { provider: "anthropic", stored: false, use_for_agents: false, agent_runtime: "claude" });
    expect(sw()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(sw());
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(sw()).toHaveAttribute("aria-checked", "false");
  });

  it("a refused PUT keeps the previous state", async () => {
    stubFetch(409);
    mount("openai", { provider: "openai", stored: true, use_for_agents: false, agent_runtime: "codex" });
    await waitFor(() => expect(sw()).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(sw());
    await waitFor(() => expect(screen.getByText(/Couldn't change agent billing/)).toBeInTheDocument());
    expect(sw()).toHaveAttribute("aria-checked", "false");
  });
});
