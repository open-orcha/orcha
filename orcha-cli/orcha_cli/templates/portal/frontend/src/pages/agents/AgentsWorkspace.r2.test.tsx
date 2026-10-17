/**
 * Agent workspace — Linear polish round 2 (review findings):
 *  - an unknown ?agent= says "No agent named …" — never silently opens another agent
 *  - a failed agent whose newest finished run is clean still shows the newest FAILED
 *    run's reason ("Last failure …"), not "No failure reason recorded"
 *  - Runs tab: only the running run is expanded; finished runs are one line each,
 *    outcomes capitalised, a failure reason rides the row
 *  - persona preview: markdown headings never run into the sentence before them
 *  - conversation: a running run suppresses "No agent runtime yet"; the in-thread
 *    line is dropped when the header already says "No runtime"
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AgentsPage, plainPrompt } from "./AgentsPage";
import { Conversation } from "./Conversation";
import type { Agent } from "../../types";

const fresh = () => new Date().toISOString();
const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const stale = () => ago(30);
let SCAN = fresh();
const snap = () => ({
  container: { id: "c1", name: "Orcha", status: "active", last_wake_scan_at: SCAN },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner" },
    { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "failed", model: "claude-opus-5", prompt_preview: "# Role\nYou are the lead.\n## Responsibilities\n- Break work down" },
    { id: "a2", alias: "scout", kind: "ai", role: "Researcher", status: "idle", model: null, prompt_preview: "" },
  ],
  tasks: [],
  requests: [],
});
let RUNS: unknown[] = [];
let TURNS: unknown[] = [];
const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
function stubFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snap());
    if (url === "/api/models") return jsonRes({ models: [], default: "claude-opus-5" });
    if (url === "/api/reasoning-efforts") return jsonRes({ efforts: [] });
    if (url.includes("/persona")) return jsonRes({ system_prompt: "" });
    if (url.includes("/runs")) return jsonRes({ runs: RUNS });
    if (url.includes("/conversation")) return jsonRes({ conversation: { id: "cv1", status: "active" }, turns: TURNS, presence: "idle", presence_reason: null });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(path: string, el: React.ReactNode = <AgentsPage />) {
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

beforeEach(() => {
  RUNS = [];
  TURNS = [];
  SCAN = fresh();
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

describe("plainPrompt", () => {
  it("joins a heading as its own clause instead of running it into the previous sentence", () => {
    const s = plainPrompt("You are the lead for orcha-web.\n\n## Responsibilities\n- Break incoming work into tasks.");
    expect(s).toBe("You are the lead for orcha-web. · Responsibilities: Break incoming work into tasks.");
    expect(s).not.toMatch(/orcha-web\. Responsibilities/);
  });
  it("a leading heading gets no separator; an empty prompt stays empty", () => {
    expect(plainPrompt("# Role\nYou build.")).toBe("Role: You build.");
    expect(plainPrompt("")).toBe("");
  });
});

describe("agent workspace r2", () => {
  it("an unknown ?agent= shows 'No agent named …' — it never auto-selects another agent", async () => {
    const { container } = mount("/agents?agent=ghost");
    await screen.findByText(/No agent named “ghost”/);
    expect(container.querySelector(".ahead")).toBeNull();
  });

  it("failed agent: falls back to the newest FAILED run's reason when the newest finished run is clean", async () => {
    RUNS = [
      { run_id: "r-ok", status: "completed", exit_code: 0, started_at: ago(70), ended_at: ago(60), agent_id: "a1" },
      { run_id: "r-bad", status: "failed", exit_code: 1, started_at: ago(200), ended_at: ago(190), agent_id: "a1", kill_reason: "ENOENT .env.local" },
    ];
    const { container } = mount("/agents?agent=forge&tab=conversation");
    await waitFor(() => expect(container.querySelector(".ag-fail")?.textContent).toContain("Last failure"));
    expect(container.querySelector(".ag-fail")!.textContent).not.toContain("No failure reason recorded");
  });

  it("Runs tab: only the running run is expanded; finished runs are one line with a capitalised outcome", async () => {
    RUNS = [
      { run_id: "r-live", status: "running", started_at: ago(4), agent_id: "a2", output: "" },
      { run_id: "r-done", status: "completed", exit_code: 0, started_at: ago(70), ended_at: ago(61), agent_id: "a2", output: "Done." },
      { run_id: "r-kill", status: "killed", exit_code: 137, started_at: ago(400), ended_at: ago(355), agent_id: "a2", kill_reason: "stopped by kedar (timeout)" },
    ];
    const { container } = mount("/agents?agent=scout&tab=runs");
    await waitFor(() => expect(container.querySelectorAll(".runs-feed .run").length).toBe(3));
    const [live, done, kill] = Array.from(container.querySelectorAll<HTMLElement>(".runs-feed .run"));
    // wave-4: the expanded log is the shared Activity RunLogView (.act-log)
    expect(live.querySelector(".act-log")).toBeTruthy();
    expect(done.querySelector(".act-log")).toBeNull();
    expect(kill.querySelector(".act-log")).toBeNull();
    expect(done.querySelector(".run-h")!.textContent).not.toMatch(/^completed/);
    expect(done.querySelector(".run-h")!.textContent).toMatch(/Completed/);
    // the failure reason is on the row itself (one line)
    expect(kill.querySelector(".run-h .run-reason")?.textContent).toContain("Stopped by kedar");
    // a finished run expands on demand
    fireEvent.click(within(done).getByRole("button", { name: /Expand run/ }));
    await waitFor(() => expect(done.querySelector(".act-log")?.textContent).toContain("Done."));
  });

  it("persona preview flattens the snapshot's raw markdown (headings as their own clause)", async () => {
    const { container } = mount("/agents?agent=forge&tab=config");
    await waitFor(() => expect(container.querySelector(".persona-pre")?.textContent).toContain("Role: You are the lead. · Responsibilities: Break work down"));
  });
});

describe("conversation runtime line (r2)", () => {
  const agent = { id: "a2", alias: "scout", kind: "ai", role: "Researcher", status: "idle" } as Agent;
  it("stale wake scan + no run → the 'No agent runtime yet' line shows", async () => {
    SCAN = stale();
    const { container } = mount("/agents", <Conversation agent={agent} />);
    await waitFor(() => expect(container.querySelector("#convWakes .conv-wakes")).toBeTruthy());
  });
  it("stale wake scan but a run is RUNNING → no 'No agent runtime yet' beside 'Working'", async () => {
    SCAN = stale();
    const { container } = mount("/agents", <Conversation agent={agent} runRunning />);
    await waitFor(() => expect(container.querySelector("#convPresence")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("#convWakes .conv-wakes")).toBeNull();
  });
  it("the header already says 'No runtime' → the in-thread line is not repeated", async () => {
    SCAN = stale();
    const { container } = mount("/agents", <Conversation agent={agent} statusShown="noruntime" />);
    await waitFor(() => expect(container.querySelector("#convPresence")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("#convWakes .conv-wakes")).toBeNull();
  });
});
