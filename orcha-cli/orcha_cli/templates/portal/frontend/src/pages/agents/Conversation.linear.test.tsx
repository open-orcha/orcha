/**
 * D9 — the agent conversation reads like Linear's agent panel (images 10/16):
 * the human's turns are right-aligned bubbles, the agent's turns are plain text
 * with a "Worked for … ▸" disclosure for their run and a "Changed N files +a −d"
 * card ONLY when the run captured a real diff. Unknown run data never renders a
 * made-up duration or a zero diff.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent, Run } from "../../types";
import { Conversation } from "./Conversation";
import { RunChanges, runWorkedLabel } from "./runlog";

const RAW_AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
  { id: "w1", alias: "wren", kind: "ai", role: "Builder", status: "idle" },
];
const agent = RAW_AGENTS[1] as unknown as Agent;
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,3 @@", " const a = 1;", "+const b = 2;",
  "diff --git a/src/b.css b/src/b.css", "--- a/src/b.css", "+++ b/src/b.css", "@@ -1 +1 @@", "-x: 1;", "+x: 2;",
].join("\n");
const t0 = Date.parse("2026-09-28T10:00:00Z");
const RUNS = [
  { run_id: "run-ok", status: "completed", started_at: new Date(t0).toISOString(), ended_at: new Date(t0 + 10_000).toISOString(), diff: DIFF },
  { run_id: "run-nodiff", status: "completed", started_at: new Date(t0).toISOString(), ended_at: new Date(t0 + 125_000).toISOString(), diff: null },
];
const TURNS = [
  { seq: 1, role: "human", content: "Fix the dimmed rows and open a PR", author_agent_id: "h1", created_at: new Date(t0).toISOString() },
  { seq: 2, role: "agent", content: "Pushed a fix.", author_agent_id: "w1", created_at: new Date(t0 + 20_000).toISOString(), run_id: "run-ok" },
  { seq: 3, role: "agent", content: "Nothing to change here.", author_agent_id: "w1", created_at: new Date(t0 + 30_000).toISOString(), run_id: "run-nodiff" },
  { seq: 4, role: "agent", content: "Older run.", author_agent_id: "w1", created_at: new Date(t0 + 40_000).toISOString(), run_id: "run-gone" },
];
const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
let runsCalls = 0;
function stubFetch() {
  runsCalls = 0;
  const snapshot = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: new Date().toISOString(), wakes_enabled: true },
    agents: RAW_AGENTS, tasks: [], requests: [],
  };
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
    if (url.includes("/conversation?limit=")) return jsonRes({ conversation: { id: "cv-w1", status: "active" }, turns: TURNS });
    if (url.endsWith("/api/agents/w1/runs")) {
      runsCalls++;
      return jsonRes({ runs: RUNS });
    }
    if (url.includes("/turns")) return jsonRes({ turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount() {
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

describe("runWorkedLabel (the 'Worked for …' line)", () => {
  it("uses the run's own start/end stamps", () => {
    expect(runWorkedLabel(RUNS[0] as Run, Date.now())).toEqual({ ms: 10_000, running: false });
  });
  it("names a failed / stopped run instead of 'Worked for'", () => {
    const r = { run_id: "x", status: "failed", exit_code: 1, started_at: new Date(t0).toISOString(), ended_at: new Date(t0 + 5_000).toISOString() } as Run;
    expect(runWorkedLabel(r, Date.now()).label).toBe("Failed after 5 sec");
  });
  it("unknown run → a plain 'Work log' line, never a made-up duration", () => {
    expect(runWorkedLabel(null, Date.now())).toEqual({ ms: null, running: false, label: "Work log" });
    const noStamps = { run_id: "y", status: "completed" } as Run;
    expect(runWorkedLabel(noStamps, Date.now()).ms).toBeNull();
  });
  it("a running run counts up from its start", () => {
    const r = { run_id: "z", status: "running", started_at: new Date(t0).toISOString() } as Run;
    expect(runWorkedLabel(r, t0 + 7_000)).toEqual({ ms: 7_000, running: true });
  });
});

describe("RunChanges (the 'Changed N files' card)", () => {
  it("counts files and lines from the real diff, and Preview expands the diff viewer", () => {
    const { container } = render(<RunChanges run={RUNS[0] as Run} />);
    const card = container.querySelector(".v2-changes") as HTMLElement;
    expect(card.textContent).toContain("2 files");
    expect(within(card).getByLabelText("2 lines added").textContent).toBe("+2");
    expect(within(card).getByLabelText("1 lines removed").textContent).toBe("−1");
    expect(container.querySelector(".run-changes-diff")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
    expect(container.querySelector(".run-changes-diff")).toBeTruthy();
  });
  it("renders nothing without a captured diff (never a zero card, never an invented PR)", () => {
    expect(render(<RunChanges run={RUNS[1] as Run} />).container.innerHTML).toBe("");
    expect(render(<RunChanges run={null} />).container.innerHTML).toBe("");
  });
});

describe("Linear agent-panel thread", () => {
  it("human turn = right bubble; agent turns = plain text with Worked-for + Changed card from real run data", async () => {
    stubFetch();
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("Pushed a fix."));
    // the thread is a labelled log
    expect(screen.getByRole("log", { name: "Conversation with wren" })).toBeTruthy();
    // the human's message is a user bubble
    const human = container.querySelector(".turn.human") as HTMLElement;
    expect(human.classList.contains("v2-msg-user")).toBe(true);
    expect(human.textContent).toContain("Fix the dimmed rows");
    // runs are fetched once for the referenced run ids
    await waitFor(() => expect(container.textContent).toContain("Worked for 10 sec"));
    expect(runsCalls).toBe(1);
    const agentTurns = Array.from(container.querySelectorAll(".turn.agent")) as HTMLElement[];
    expect(agentTurns).toHaveLength(3);
    // the diff run shows the Changed card; the diff-less run does not; the unknown run is a plain Work log
    expect(agentTurns[0].querySelector(".v2-changes")?.textContent).toContain("2 files");
    expect(agentTurns[1].textContent).toContain("Worked for 2 min 5 sec");
    expect(agentTurns[1].querySelector(".v2-changes")).toBeNull();
    expect(agentTurns[2].textContent).toContain("Work log");
    // D16: no author line on agent turns (the panel is the agent's); each run turn
    // trails its relative time after the duration, the absolute time in its tooltip
    expect(agentTurns.filter((t) => t.querySelector(".v2-msg-h")).length).toBe(0);
    const meta = agentTurns[0].querySelector(".v2-worked-meta time") as HTMLElement;
    expect(meta.getAttribute("title")).toBe(new Date(t0 + 20_000).toLocaleString());
  });

  it("the composer sends from a circular, named button and offers the skills palette", async () => {
    stubFetch();
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("Pushed a fix."));
    const send = container.querySelector("#convSend") as HTMLButtonElement;
    expect(send.getAttribute("aria-label")).toBe("Send message");
    expect(send.classList.contains("is-idle")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Insert a Embodent skill" }));
    expect((container.querySelector("#convInput") as HTMLTextAreaElement).value).toBe("/");
    expect(container.querySelector("#convSlash")).toBeTruthy();
  });
});
