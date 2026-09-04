/**
 * Agents page port tests: roster renders from a stubbed snapshot, the ?agent=
 * deep link selects, and a human-gated mutation posts the exact vanilla body.
 */
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";

interface Call {
  url: string;
  init?: RequestInit;
}
let calls: Call[] = [];

const RAW_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    {
      id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "working",
      model: "claude-sonnet-5", wake_enabled: true, auto_wake_interval_secs: null,
      prompt_preview: "You are Forge.", embodiment: "idle", reasoning_effort: "high",
    },
    { id: "a2", alias: "scout", kind: "ai", role: "Researcher", status: "idle", model: "claude-opus-5" },
  ],
  tasks: [],
  requests: [],
};

function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

function stubFetch(efforts: { id: string; name: string }[] = []) {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(RAW_SNAPSHOT);
    if (url === "/api/models") return jsonRes({ models: [] }); // keep the seeded curated list
    if (url === "/api/reasoning-efforts") return jsonRes({ efforts }); // stubbed per-test; [] keeps the seeded curated list
    if (url.includes("/digest")) return jsonRes({ digest: null });
    if (url.includes("/runs")) return jsonRes({ runs: [] });
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    if (url.includes("/persona")) return jsonRes({ system_prompt: "full prompt" });
    return jsonRes({});
  }) as unknown as typeof fetch;
}

function mount(initialPath = "/agents") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="*" element={<AgentsPage />} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("AgentsPage (vanilla agents.html parity)", () => {
  beforeEach(() => {
    stubFetch();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup(); // vitest globals are off, so RTL's auto-cleanup never registers
    vi.restoreAllMocks();
  });

  it("renders the roster from a stubbed snapshot and selects the first AI agent", async () => {
    const { container } = mount();
    // roster header + all three agents
    await screen.findByText("Roster · 3");
    const roster = container.querySelector(".roster-card") as HTMLElement;
    expect(roster).toBeTruthy();
    expect(within(roster).getByText("kedar")).toBeInTheDocument();
    expect(within(roster).getByText("forge")).toBeInTheDocument();
    expect(within(roster).getByText("scout")).toBeInTheDocument();
    // default selection = first non-human agent (forge): roster row marked .sel
    const sel = roster.querySelector(".rrow.sel");
    expect(sel).toBeTruthy();
    expect(sel!.textContent).toContain("forge");
    // detail header shows the selected agent
    const h1 = container.querySelector(".ahead .who h1");
    expect(h1?.textContent).toContain("forge");
  });

  it("deep link ?agent= selects that agent (ISS-38)", async () => {
        const { container } = mount("/agents?agent=scout");
    await screen.findByText("Roster · 3");
    const roster = container.querySelector(".roster-card") as HTMLElement;
    const sel = roster.querySelector(".rrow.sel");
    expect(sel).toBeTruthy();
    expect(sel!.textContent).toContain("scout");
    const h1 = container.querySelector(".ahead .who h1");
    expect(h1?.textContent).toContain("scout");
  });

  it("roster click swaps the detail pane to the clicked agent", async () => {
    const { container } = mount();
    await screen.findByText("Roster · 3");
    const roster = container.querySelector(".roster-card") as HTMLElement;
    fireEvent.click(within(roster).getByText("scout"));
    await waitFor(() => {
      const h1 = container.querySelector(".ahead .who h1");
      expect(h1?.textContent).toContain("scout");
    });
    expect(roster.querySelector(".rrow.sel")?.textContent).toContain("scout");
  });

  it("model switch POSTs the exact vanilla body to /api/agents/{id}/model", async () => {
    mount();
    await screen.findByText("Roster · 3");
    // forge (a1) is selected; its model is sonnet — click the Opus chip
    const btn = await screen.findByTitle("Opus 5");
    fireEvent.click(btn);
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/agents/a1/model" && c.init?.method === "POST");
      expect(call).toBeTruthy();
      expect(call!.init!.body).toBe(JSON.stringify({ model: "claude-opus-5" }));
    });
  });

  it("auto-wake PATCH carries the acting-human id (#300)", async () => {
    mount();
    await screen.findByText("Roster · 3");
    fireEvent.click(await screen.findByText("15m"));
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/agents/a1/auto-wake" && c.init?.method === "PATCH");
      expect(call).toBeTruthy();
      expect(call!.init!.body).toBe(JSON.stringify({ actor_agent_id: "h1", interval_secs: 900 }));
    });
  });

  it("the live-terminal affordance is the REAL pairing control (classic fallback gone)", async () => {
    const { container } = mount();
    await screen.findByText("Roster · 3");
    const pair = container.querySelector("#convPair") as HTMLButtonElement;
    expect(pair).toBeTruthy();
    expect(pair.disabled).toBe(false); // live pairing, no longer a disabled stub
    expect(pair.title).toBe("Pair in a live terminal as forge");
    expect(pair.textContent).toContain("Pair in terminal");
    expect(screen.queryByText("Classic portal")).toBeNull(); // the vanilla-page pointer is deleted
  });

  describe("reasoning-effort control (GH #51)", () => {
    const EFFORTS = [
      { id: "low", name: "Low" },
      { id: "medium", name: "Medium" },
      { id: "high", name: "High" },
      { id: "xhigh", name: "Extra-high" },
    ];

    it("renders options from a stubbed /api/reasoning-efforts, plus a Default entry", async () => {
      stubFetch(EFFORTS);
      const { container } = mount();
      await screen.findByText("Roster · 3");
      const seg = await waitFor(() => {
        const el = container.querySelector("#effortSeg");
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(within(seg).getByText("Default")).toBeInTheDocument();
      expect(within(seg).getByText("Low")).toBeInTheDocument();
      expect(within(seg).getByText("Medium")).toBeInTheDocument();
      expect(within(seg).getByText("High")).toBeInTheDocument();
      expect(within(seg).getByText("Extra-high")).toBeInTheDocument();
    });

    it("highlights the agent's current reasoning_effort", async () => {
      stubFetch(EFFORTS);
      const { container } = mount();
      await screen.findByText("Roster · 3");
      // forge (a1) has reasoning_effort: "high"
      const seg = await waitFor(() => {
        const el = container.querySelector("#effortSeg");
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      const onBtn = seg.querySelector("button.on") as HTMLButtonElement;
      expect(onBtn).toBeTruthy();
      expect(onBtn.textContent).toBe("High");
      expect(onBtn.getAttribute("data-effort")).toBe("high");
      expect(onBtn.getAttribute("aria-pressed")).toBe("true");
    });

    it("posts the curated effort id on click", async () => {
      stubFetch(EFFORTS);
      mount();
      await screen.findByText("Roster · 3");
      const btn = await screen.findByText("Medium");
      fireEvent.click(btn);
      await waitFor(() => {
        const call = calls.find((c) => c.url === "/api/agents/a1/reasoning-effort" && c.init?.method === "POST");
        expect(call).toBeTruthy();
        expect(call!.init!.body).toBe(JSON.stringify({ reasoning_effort: "medium" }));
      });
    });

    it("posts null for the Default chip (clears back to the runtime default)", async () => {
      stubFetch(EFFORTS);
      mount();
      await screen.findByText("Roster · 3");
      const btn = await screen.findByText("Default");
      fireEvent.click(btn);
      await waitFor(() => {
        const call = calls.find((c) => c.url === "/api/agents/a1/reasoning-effort" && c.init?.method === "POST");
        expect(call).toBeTruthy();
        expect(call!.init!.body).toBe(JSON.stringify({ reasoning_effort: null }));
      });
    });
  });
});

describe("SEED_MODELS fallback list (model catalog refresh)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("contains Fable 5.1 and GPT-6 Astra alongside the current model families", async () => {
    stubFetch(); // /api/models returns { models: [] } — the seed stays in effect
    const { container } = mount();
    await screen.findByText("Roster · 3");
    const seg = container.querySelector("#modelSeg") as HTMLElement;
    expect(seg).toBeTruthy();
    expect(within(seg).getByTitle("Fable 5.1")).toBeInTheDocument();
    expect(within(seg).getByTitle("Opus 5")).toBeInTheDocument();
    expect(within(seg).queryByTitle("Opus 4.8")).toBeNull();

    fireEvent.click(screen.getByText("Codex"));
    expect(within(seg).getByTitle("GPT-6 Astra")).toBeInTheDocument();
    const ids = calls.filter((c) => c.url === "/api/agents/a1/model");
    expect(ids).toEqual([]); // sanity: no accidental POSTs from render
  });

  it("filters reasoning-effort chips to the selected model", async () => {
    stubFetch();
    const { container } = mount();
    await screen.findByText("Roster · 3");
    const effortSeg = container.querySelector("#effortSeg") as HTMLElement;
    expect(within(effortSeg).getByText("Maximum")).toBeInTheDocument();
    expect(within(effortSeg).queryByText("Ultra")).toBeNull();

    fireEvent.click(screen.getByText("Codex"));
    fireEvent.click(within(container.querySelector("#modelSeg") as HTMLElement).getByTitle("GPT-5.6 Sol"));
    await waitFor(() => expect(within(effortSeg).getByText("Ultra")).toBeInTheDocument());

    fireEvent.click(within(container.querySelector("#modelSeg") as HTMLElement).getByTitle("GPT-6 Astra"));
    await waitFor(() => expect(within(effortSeg).queryByText("Ultra")).toBeNull());
    expect(within(effortSeg).getByText("Maximum")).toBeInTheDocument();
  });
});
