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

// D9 Configuration: model + reasoning effort are compact dropdowns (MenuButton) whose
// trigger always shows the CURRENT value; the options live in a role=menu popover.
function pick(container: HTMLElement, id: string): HTMLButtonElement {
  return (container.querySelector(id) as HTMLElement).querySelector("button") as HTMLButtonElement;
}
function openPick(container: HTMLElement, id: string): HTMLElement {
  fireEvent.click(pick(container, id));
  return screen.getByRole("menu");
}
const itemLabels = (menu: HTMLElement) => within(menu).getAllByRole("menuitemradio").map((m) => m.querySelector(".v2-menu-label")?.textContent);
// the model control is a grouped listbox popover (ModelPicker.tsx), not a menu
function openModels(container: HTMLElement): HTMLElement {
  fireEvent.click(pick(container, "#modelSeg"));
  return screen.getByRole("listbox", { name: "Models" });
}
const modelLabels = (list: HTMLElement) =>
  within(list).getAllByRole("option").map((o) => Array.from(o.querySelector(".mpk-name")!.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""));

// D9: bare /agents is the board; the roster + workspace is the list view
function mount(initialPath = "/agents?view=list") {
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
    const { container } = mount("/agents?tab=config");
    await screen.findByText("Roster · 3");
    // forge (a1) is selected; its model is sonnet — pick Opus from the model dropdown
    await waitFor(() => expect(container.querySelector("#modelSeg button")).toBeTruthy());
    expect(pick(container, "#modelSeg").textContent).toContain("Sonnet 5");
    const menu = openModels(container);
    fireEvent.click(within(menu).getByText("Opus 5"));
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/agents/a1/model" && c.init?.method === "POST");
      expect(call).toBeTruthy();
      expect(call!.init!.body).toBe(JSON.stringify({ model: "claude-opus-5" }));
    });
  });

  it("D9 header: the model + effort chip shows the agent's REAL current values, status once, one meta line", async () => {
    const { container } = mount("/agents?view=list&agent=forge");
    await screen.findByText("Roster · 3");
    const head = container.querySelector(".ahead") as HTMLElement;
    const chip = head.querySelector(".ag-model") as HTMLElement;
    expect(chip.textContent).toBe("Sonnet 5 · High");
    expect(chip.getAttribute("title")).toContain("claude-sonnet-5");
    // ONE status pill (review blocker: header glyph + lease badge + conversation chip disagreed)
    expect(head.querySelectorAll("#agentPresence").length).toBe(1);
    expect(head.querySelector(".rlive")).toBeNull(); // the lease rides in the pill's tooltip
    expect(container.querySelectorAll(".agents-detail .conv-h").length).toBe(0); // no conversation header band
    expect(head.querySelector(".role")?.textContent).toContain("Builder");
    // the conversation bar carries no second identity row
    expect(container.querySelector(".conv-h .who, .conv-h .v2-av")).toBeNull();
  });

  it("D9 Tasks tab: Linear rows (priority, short id, status glyph, title) under collapsible band headers", async () => {
    RAW_SNAPSHOT.tasks = [
      { id: "t1aaaaaa-0001", title: "Wire the board", status: "in_progress", priority: 1, assignees: ["forge"], created_at: new Date().toISOString() },
      { id: "t2bbbbbb-0002", title: "Write docs", status: "ready", priority: 3, assignees: ["forge"], created_at: new Date().toISOString() },
    ] as never[];
    try {
      const { container } = mount("/agents?view=list&agent=forge&tab=tasks");
      await screen.findByText("Roster · 3");
      const panel = await waitFor(() => container.querySelector("#agtab-panel-tasks") as HTMLElement);
      const bands = Array.from(panel.querySelectorAll(".v2-group-h")).map((h) => h.textContent);
      expect(bands[0]).toContain("Active");
      expect(bands[1]).toContain("Other tasks");
      const row = panel.querySelector('.ag-trow[href="/tasks?task=t1aaaaaa-0001"]') as HTMLElement;
      expect(row.querySelector(".v2-prio")).toBeTruthy();
      expect(row.querySelector(".ag-trow-id")?.textContent).toBe("t1aaaaaa");
      expect(row.querySelector(".v2-si-wrap")?.textContent).toContain("In progress");
    } finally {
      RAW_SNAPSHOT.tasks = [];
    }
  });

  it("auto-wake PATCH carries the acting-human id (#300)", async () => {
    mount("/agents?tab=config");
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
    expect(pair.title).toBe("Pair in terminal — a live session as forge");
    // D16: a compact circular icon in the conversation panel header (tooltip names it)
    expect(pair.getAttribute("aria-label")).toBe("Pair in terminal");
    expect(pair.closest(".conv-head")).toBeTruthy();
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
      const { container } = mount("/agents?tab=config");
      await screen.findByText("Roster · 3");
      const seg = await waitFor(() => {
        const el = container.querySelector("#effortSeg");
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(seg).toBeTruthy();
      const menu = openPick(container, "#effortSeg");
      expect(itemLabels(menu)).toEqual(["Default", "Low", "Medium", "High", "Extra-high"]);
    });

    it("highlights the agent's current reasoning_effort", async () => {
      stubFetch(EFFORTS);
      const { container } = mount("/agents?tab=config");
      await screen.findByText("Roster · 3");
      // forge (a1) has reasoning_effort: "high"
      const seg = await waitFor(() => {
        const el = container.querySelector("#effortSeg");
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      // the trigger shows the current value; the menu checks it
      expect(seg.getAttribute("data-effort")).toBe("high");
      expect(pick(container, "#effortSeg").textContent).toContain("High");
      const menu = openPick(container, "#effortSeg");
      const checked = within(menu).getAllByRole("menuitemradio").filter((m) => m.getAttribute("aria-checked") === "true");
      expect(checked.map((m) => m.textContent)).toEqual(["High"]);
    });

    it("posts the curated effort id on click", async () => {
      stubFetch(EFFORTS);
      const { container } = mount("/agents?tab=config");
      await screen.findByText("Roster · 3");
      await waitFor(() => expect(container.querySelector("#effortSeg button")).toBeTruthy());
      fireEvent.click(within(openPick(container, "#effortSeg")).getByText("Medium"));
      await waitFor(() => {
        const call = calls.find((c) => c.url === "/api/agents/a1/reasoning-effort" && c.init?.method === "POST");
        expect(call).toBeTruthy();
        expect(call!.init!.body).toBe(JSON.stringify({ reasoning_effort: "medium" }));
      });
    });

    it("posts null for the Default chip (clears back to the runtime default)", async () => {
      stubFetch(EFFORTS);
      const { container } = mount("/agents?tab=config");
      await screen.findByText("Roster · 3");
      await waitFor(() => expect(container.querySelector("#effortSeg button")).toBeTruthy());
      fireEvent.click(within(openPick(container, "#effortSeg")).getByText("Default"));
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

  it("contains Fable 5.1, Opus 5.5, Sonnet 5.5 and GPT-6 Astra alongside the current model families", async () => {
    stubFetch(); // /api/models returns { models: [] } — the seed stays in effect
    const { container } = mount("/agents?tab=config");
    await screen.findByText("Roster · 3");
    expect(container.querySelector("#modelSeg")).toBeTruthy();
    // ONE list: every runtime's models, grouped (not only the active runtime's)
    const all = modelLabels(openModels(container));
    expect(all).toContain("Fable 5.1");
    expect(all).toContain("Opus 5.5");
    expect(all).toContain("Sonnet 5.5");
    expect(all).toContain("Opus 5");
    expect(all).toContain("GPT-6 Astra");
    expect(all).not.toContain("Opus 4.8");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Models" })).toBeNull());

    // the Codex provider segment opens the picker on the Codex group
    fireEvent.click(within(container.querySelector("#modelRuntimeSeg") as HTMLElement).getByText("Codex"));
    const combo = await screen.findByRole("combobox");
    const act = document.getElementById(combo.getAttribute("aria-activedescendant") || "");
    expect(act?.closest("[data-runtime]")?.getAttribute("data-runtime")).toBe("codex");
    const ids = calls.filter((c) => c.url === "/api/agents/a1/model");
    expect(ids).toEqual([]); // sanity: no accidental POSTs from render
  });

  it("filters reasoning-effort chips to the selected model", async () => {
    stubFetch();
    const { container } = mount("/agents?tab=config");
    await screen.findByText("Roster · 3");
    const efforts = () => {
      const labels = itemLabels(openPick(container, "#effortSeg"));
      fireEvent.keyDown(document, { key: "Escape" });
      return labels;
    };
    expect(efforts()).toContain("Maximum");
    expect(efforts()).not.toContain("Ultra");

    // a Codex model from a Claude agent is a provider switch: confirm inline first
    fireEvent.click(within(openModels(container)).getByText("GPT-5.6 Sol"));
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(efforts()).toContain("Ultra"));

    fireEvent.click(within(openModels(container)).getByText("GPT-6 Astra")); // same runtime now: no confirm
    await waitFor(() => expect(efforts()).not.toContain("Ultra"));
    expect(efforts()).toContain("Maximum");
  });
});

describe("V2 agent workspace tabs (?tab=)", () => {
  beforeEach(() => {
    stubFetch();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

  it("an AI agent gets Conversation · Runs · Tasks · Requests · Memory · Configuration; Conversation is the default", async () => {
    const { container } = mount("/agents?agent=forge");
    await screen.findByText("Roster · 3");
    expect(tabNames()).toEqual(["Conversation", "Runs", "Tasks0", "Requests0", "Memory", "Configuration"]);
    expect(screen.getByRole("tab", { name: /Conversation/ })).toHaveAttribute("aria-selected", "true");
    const conv = container.querySelector("#agtab-panel-conversation") as HTMLElement;
    expect(conv.hidden).toBe(false);
    expect(conv.querySelector("#convWrap #convInput")).toBeTruthy();
    expect(container.querySelector("#modelSeg")).toBeNull(); // controls live in Configuration
  });

  it("honors ?tab= from a deep link (sidebar live-agent rows link tab=conversation / runs)", async () => {
    const { container } = mount("/agents?agent=forge&tab=memory");
    await screen.findByText("Roster · 3");
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
    expect(container.querySelector("#agtab-panel-conversation") as HTMLElement).toHaveProperty("hidden", true);
    await screen.findByText(/No digest yet/);
  });

  it("switching tabs keeps the conversation MOUNTED (hidden) so a typed draft survives", async () => {
    const { container } = mount("/agents?agent=forge");
    await screen.findByText("Roster · 3");
    const input = container.querySelector("#convInput") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "half-typed thought" } });
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    await waitFor(() => expect(container.querySelector("#modelSeg")).toBeTruthy());
    expect((container.querySelector("#agtab-panel-conversation") as HTMLElement).hidden).toBe(true);
    // same textarea node, same value — never unmounted
    expect(container.querySelector("#convInput")).toBe(input);
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    expect((container.querySelector("#convInput") as HTMLTextAreaElement).value).toBe("half-typed thought");
  });

  it("a human gets no Conversation/Runs tabs and defaults to Tasks; unknown ?tab= falls back", async () => {
    mount("/agents?agent=kedar&tab=runs");
    await screen.findByText("Roster · 3");
    // humans are the authority, not workers: no memory digest or wake/model controls either
    expect(tabNames()).toEqual(["Tasks0", "Requests0"]);
    expect(screen.getByRole("tab", { name: /Tasks/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("No tasks assigned to or reviewed by kedar.")).toBeInTheDocument();
  });

  it("the header and the Runs tab share ONE /runs read (opening the tab never refetches)", async () => {
    mount("/agents?agent=forge");
    await screen.findByText("Roster · 3");
    await waitFor(() => expect(calls.some((c) => c.url === "/api/agents/a1/runs")).toBe(true));
    const before = calls.filter((c) => c.url === "/api/agents/a1/runs").length;
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    await screen.findByText(/No worker runs yet/);
    expect(calls.filter((c) => c.url === "/api/agents/a1/runs").length).toBe(before);
  });

  it("roster groups AI agents and humans and shows each agent's real status label", async () => {
    const { container } = mount();
    await screen.findByText("Roster · 3");
    // D8 band headers: title + muted count
    const bands = Array.from(container.querySelectorAll(".roster-card .v2-group-h")).map((e) => e.textContent?.replace(/\s+/g, " ").trim());
    expect(bands.some((t) => /AI agents\s*2/.test(t || ""))).toBe(true);
    expect(bands.some((t) => /Humans\s*1/.test(t || ""))).toBe(true);
    const forgeRow = container.querySelector('[data-alias="forge"]') as HTMLElement;
    expect(forgeRow.querySelector("[data-status]")?.getAttribute("data-status")).toBe("working");
    // no wake-scan stamp in this fixture: r3 parity — a working agent reads "Working" on the
    // roster exactly like the header; the scanner-offline fact is the word's tooltip
    expect(forgeRow.querySelector(".rword")?.textContent).toBe("Working");
    expect(forgeRow.querySelector(".rword")?.getAttribute("title")).toMatch(/No host runtime/);
  });
});
