/**
 * Agent workspace — Linear polish round 1 (review findings):
 *  - ONE presence value (header pill) derived from failed status → running run →
 *    runtime → paused → conversation presence → agent status; never "Working"
 *    beside "No active run" beside "1 running".
 *  - a finished run's "Worked for …" paints its captured output (no endless
 *    "Waiting for output…"); plain log lines carry no "log" label; a finished log
 *    has no trailing run-complete echo; a plain-string kill_reason is kept.
 *  - Tasks tab: a plan awaiting approval sits in a "Needs you" band with a chip.
 *  - Requests tab: escalated is counted apart from open.
 *  - Configuration: never "No persona set" beside a full prompt.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent, Snapshot } from "../../types";
import { AgentsPage } from "./AgentsPage";
import { agentPresence, humanizeModelId } from "./presence";
import { WorkLogStream, appendLine, killReasonText, runReasonText } from "./runlog";

const fresh = () => new Date().toISOString();
const stale = () => new Date(Date.now() - 30 * 60 * 1000).toISOString();
const ag = (x: Partial<Agent>): Agent => ({ id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "idle", ...x }) as Agent;
const snapOf = (c: Record<string, unknown>) => ({ container: { id: "c1", ...c } }) as unknown as Snapshot;

describe("agentPresence — one status, strongest real signal first", () => {
  it("a running worker run wins over a stale conversation presence and a not-live snapshot run field", () => {
    const p = agentPresence(ag({ status: "idle" }), { snap: snapOf({ last_wake_scan_at: fresh() }), runs: [{ run_id: "r1", status: "running" }], conv: { presence: "idle", reason: null } });
    expect(p.label).toBe("Working");
  });
  it("r3 parity: a working agent with no host runtime reads 'Working' (scanner-offline note in the tooltip) on every path", () => {
    const snap = snapOf({ last_wake_scan_at: stale() });
    const withRuns = agentPresence(ag({ status: "working" }), { snap, runs: [{ run_id: "r1", status: "running" }] });
    const snapOnly = agentPresence(ag({ status: "working" }), { snap });
    const noRuns = agentPresence(ag({ status: "working" }), { snap, runs: [] });
    for (const p of [withRuns, snapOnly, noRuns]) {
      expect(p.label).toBe("Working");
      expect(p.reason).toContain("No host runtime");
    }
  });
  it("an idle agent with no host runtime → 'No runtime'", () => {
    const p = agentPresence(ag({ status: "idle" }), { snap: snapOf({ last_wake_scan_at: stale() }), runs: [] });
    expect(p.k).toBe("noruntime");
    expect(p.reason).toContain("no agent runtime");
  });
  it("wakes paused → 'Paused' with the reason as the tooltip", () => {
    const p = agentPresence(ag({ status: "idle" }), { snap: snapOf({ last_wake_scan_at: fresh(), wakes_enabled: false }), runs: [] });
    expect(p.label).toBe("Paused");
  });
  it("a stopped conversation keeps its presence_reason (it used to be dropped)", () => {
    const p = agentPresence(ag({ status: "idle" }), { snap: snapOf({ last_wake_scan_at: fresh() }), runs: [], conv: { presence: "stopped", reason: "Wakes are paused for this agent" } });
    expect(p.label).toBe("Paused");
    expect(p.reason).toBe("Wakes are paused for this agent");
  });
  it("failed wins, carrying the failure reason", () => {
    const p = agentPresence(ag({ status: "failed" }), { snap: snapOf({ last_wake_scan_at: fresh() }), runs: [{ run_id: "r1", status: "running" }], failReason: "Exited with code 1" });
    expect(p.label).toBe("Failed");
    expect(p.reason).toBe("Exited with code 1");
  });
  it("awaiting_human with nothing running → 'Needs you'", () => {
    expect(agentPresence(ag({ status: "awaiting_human" }), { snap: snapOf({ last_wake_scan_at: fresh() }), runs: [] }).label).toBe("Needs you");
  });
});

describe("humanizeModelId", () => {
  it("reads legacy ids as product names", () => {
    expect(humanizeModelId("claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(humanizeModelId("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(humanizeModelId("gpt-4o")).toBe("GPT-4o");
    expect(humanizeModelId("mystery")).toBe("mystery");
  });
});

describe("run log honesty", () => {
  afterEach(() => cleanup());
  it("a finished run's work log paints its captured output (never 'Waiting for output…' forever)", () => {
    const { container } = render(<WorkLogStream agentId="a1" runId="r2" run={{ run_id: "r2", status: "completed", exit_code: 0, output: "Reading files\nDone." }} />);
    const log = container.querySelector(".log") as HTMLElement;
    expect(log.textContent).toContain("Reading files");
    expect(log.textContent).toContain("Done.");
    expect(log.textContent).not.toContain("run-complete"); // the header states the outcome once
  });
  it("a stream that can't open falls back to 'Log unavailable' instead of waiting forever", () => {
    const { container } = render(<WorkLogStream agentId="a1" runId="r3" run={null} />);
    expect(container.querySelector(".log")?.textContent).toContain("Log unavailable");
  });
  it("plain log lines carry no 'log' type label and no caret; a detail line keeps both", () => {
    const el = document.createElement("div");
    appendLine(el, { type: "narrate", label: "log", text: "hello" });
    appendLine(el, { type: "tool", label: "tool", text: "Bash · ls", detail: "ls -la" });
    const [plain, tool] = Array.from(el.querySelectorAll(".ln"));
    expect(plain.classList.contains("is-plain")).toBe(true);
    expect(plain.querySelector(".ty")?.textContent).toBe("");
    expect(plain.querySelector(".gut")?.textContent).toBe("");
    expect(tool.querySelector(".ty")?.textContent).toBe("tool");
    expect(tool.querySelector(".gut")?.textContent).toBe("›");
  });
  it("a plain-string kill_reason is kept (not 'no reason recorded'); a JSON cause still maps", () => {
    expect(killReasonText("stopped by hussein (timeout exceeded 45m budget)")).toBe("stopped by hussein (timeout exceeded 45m budget)");
    expect(runReasonText({ status: "killed", kill_reason: "stopped by hussein (timeout exceeded 45m budget)" })).toBe("Stopped by hussein (timeout exceeded 45m budget)");
    expect(runReasonText({ status: "killed", kill_reason: JSON.stringify({ cause: "stalled" }) })).toMatch(/stalled/);
    expect(runReasonText({ status: "completed", exit_code: 0 })).toBe("");
  });
});

/* ---------- page-level ---------- */
const PLAN_TASK = { id: "t-plan-0001", title: "Plan: migrate billing", status: "in_progress", priority: 2, assignees: ["forge"], plan_message: { body: "1. a\n2. b" }, plan_decision: null, created_at: fresh() };
const WORK_TASK = { id: "t-work-0002", title: "Build the thing", status: "in_progress", priority: 2, assignees: ["forge"], created_at: fresh() };
const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: fresh() },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner" },
    { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "working", model: "claude-opus-5", prompt_preview: "" },
    { id: "a2", alias: "scout", kind: "ai", role: "Researcher", status: "idle", model: null, prompt_preview: "" },
  ],
  tasks: [PLAN_TASK, WORK_TASK],
  requests: [
    { id: "r1", type: "review", status: "escalated", escalated: true, priority: 1, requester_id: "a2", target_id: "a1", payload: { summary: "Blocked on creds" }, created_at: fresh() },
    { id: "r2", type: "question", status: "open", priority: 1, requester_id: "h1", target_id: "a1", payload: { question: "ETA?" }, created_at: fresh() },
  ],
};
let RUNS: unknown[] = [];
function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}
function stubFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (url === "/api/models") return jsonRes({ models: [], default: "claude-opus-5" });
    if (url === "/api/reasoning-efforts") return jsonRes({ efforts: [] });
    if (url.includes("/a1/persona")) return jsonRes({ system_prompt: "## Role\n- You build things." });
    if (url.includes("/a2/persona")) return jsonRes({ system_prompt: "" });
    if (url.includes("/runs")) return jsonRes({ runs: RUNS });
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(path: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={<AgentsPage />} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("agent workspace page", () => {
  beforeEach(() => {
    RUNS = [];
    stubFetch();
    localStorage.clear();
    sessionStorage.clear();
    try {
      window.scrollTo = () => {};
    } catch { /* jsdom */ }
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("the header status and the meta line read the SAME run list as the Runs tab", async () => {
    RUNS = [{ run_id: "run-1", status: "running", task_id: "t-work-0002", started_at: fresh(), agent_id: "a1" }];
    const { container } = mount("/agents?agent=forge");
    await screen.findByText("Roster · 3");
    await waitFor(() => expect(container.querySelector(".ahead .role a[href='/tasks?task=t-work-0002']")).toBeTruthy());
    expect(container.querySelector("#agentPresence")?.textContent).toBe("Working");
    expect(container.querySelector(".ahead")?.textContent).not.toContain("No active run");
  });

  it("Tasks tab: a plan awaiting approval leads in a 'Needs you' band with a 'Plan waiting' chip", async () => {
    const { container } = mount("/agents?agent=forge&tab=tasks");
    await screen.findByText("Roster · 3");
    const panel = await waitFor(() => container.querySelector("#agtab-panel-tasks") as HTMLElement);
    const bands = Array.from(panel.querySelectorAll(".v2-group-h")).map((h) => h.textContent || "");
    expect(bands[0]).toContain("Needs you");
    expect(bands[1]).toContain("Active");
    const row = panel.querySelector('.ag-trow[href="/tasks?task=t-plan-0001"]') as HTMLElement;
    expect(row.querySelector(".ag-need")?.textContent).toBe("Plan waiting");
  });

  it("Requests tab: an escalated request is counted as escalated, not open, and is labelled", async () => {
    const { container } = mount("/agents?agent=forge&tab=requests");
    await screen.findByText("Roster · 3");
    const panel = await waitFor(() => container.querySelector("#agtab-panel-requests") as HTMLElement);
    expect(panel.querySelector(".ag-toolbar")?.textContent).toContain("1 open · 1 escalated");
    expect(panel.querySelector(".rq-esc")?.textContent).toBe("Escalated");
  });

  it("Configuration: an empty prompt_preview defers to /persona — never 'No persona set' beside a full prompt", async () => {
    const { container } = mount("/agents?agent=forge&tab=config");
    await screen.findByText("Roster · 3");
    await waitFor(() => expect(container.querySelector(".persona-pre")?.textContent).toContain("Role: You build things."));
    expect(container.textContent).not.toContain("No persona set");
    expect(container.querySelector("#personaExpandBtn")).toBeTruthy();
  });

  it("Configuration: a truly empty persona says so and offers no 'Show full prompt'", async () => {
    const { container } = mount("/agents?agent=scout&tab=config");
    await screen.findByText("Roster · 3");
    await screen.findByText(/No persona set/);
    expect(container.querySelector("#personaExpandBtn")).toBeNull();
  });

  it("a human's header: the authority note is the Human chip's tooltip and the id lives in a ⋯ menu", async () => {
    const { container } = mount("/agents?agent=kedar");
    await screen.findByText("Roster · 3");
    const head = await waitFor(() => container.querySelector(".ahead") as HTMLElement);
    expect(head.querySelector(".ag-kind")?.getAttribute("title")).toMatch(/human authority/i);
    expect(container.querySelector(".ag-human-note")).toBeNull();
    expect(head.querySelector(".role")?.textContent).not.toMatch(/ago·/);
    expect(head.querySelector(".ag-more-menu")).toBeTruthy();
    expect(head.querySelector(".role .mono")).toBeNull();
  });
});
