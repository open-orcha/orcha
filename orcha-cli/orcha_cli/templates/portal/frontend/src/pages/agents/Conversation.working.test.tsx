/**
 * D16 — the live "AI working" row and the Linear panel chrome:
 *  - shown ONLY while a run is running on THIS conversation (never for a task run),
 *    with a live elapsed timer from the run's real start and the current activity
 *    taken from the run's own stream (never invented); gone the moment it ends;
 *  - the human turn reads "delivered" once that run started after it was saved;
 *  - the circular send becomes a circular Stop while the run is live and the field is empty;
 *  - the "turn-based" boilerplate lives behind a help icon; Pair in terminal is a header icon.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation } from "./Conversation";
import { activityText, formatElapsed } from "./runlog";

const RAW_AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
  { id: "w1", alias: "wren", kind: "ai", role: "Builder", status: "working" },
];
const agent = RAW_AGENTS[1] as unknown as Agent;
const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;

/* a controllable EventSource: tests push stream frames into the live run */
class FakeES {
  static all: FakeES[] = [];
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) { this.url = url; FakeES.all.push(this); }
  close() { this.closed = true; }
  push(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}

let runs: unknown[] = [];
function stubFetch(turns: unknown[]) {
  const snapshot = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: new Date().toISOString(), wakes_enabled: true },
    agents: RAW_AGENTS, tasks: [], requests: [],
  };
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
    if (url.includes("/conversation?limit=")) return jsonRes({ conversation: { id: "cv1", status: "active" }, turns });
    if (url.endsWith("/api/agents/w1/runs")) return jsonRes({ runs });
    if (url.includes("/turns")) return jsonRes({ turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(runRunning = true) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <Conversation key={agent.id} agent={agent} runRunning={runRunning} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  FakeES.all = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("formatElapsed / activityText", () => {
  it("formats a live timer", () => {
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(63_000)).toBe("1m 03s");
    expect(formatElapsed(3_840_000)).toBe("1h 04m");
    expect(formatElapsed(null)).toBeNull();
  });
  it("derives the activity only from real tool calls / narration", () => {
    expect(activityText({ type: "tool", label: "tool", text: "Bash", detail: JSON.stringify({ command: "npm test", description: "Run the unit tests" }) })).toBe("Run the unit tests");
    expect(activityText({ type: "tool", label: "tool", text: "Read", detail: JSON.stringify({ file_path: "/w/src/app.ts" }) })).toBe("Reading app.ts");
    expect(activityText({ type: "tool", label: "tool", text: "Bash", detail: JSON.stringify({ command: "pytest -q" }) })).toBe("Running pytest -q");
    expect(activityText({ type: "narrate", label: "narration", text: "Checking the claim loop.\nmore" })).toBe("Checking the claim loop.");
    // thinking, tool results and lifecycle never become an activity
    expect(activityText({ type: "think", label: "thinking", text: "(thinking)" })).toBeNull();
    expect(activityText({ type: "result", label: "tool result", text: "tool result" })).toBeNull();
    expect(activityText({ type: "boot", label: "wake", text: "wake start" })).toBeNull();
  });
});

describe("live working row", () => {
  const TURNS = [{ seq: 1, id: "t1", role: "human", content: "Run the tests", author_agent_id: "h1", created_at: ago(90_000) }];

  it("shows Working… + timer + streamed activity for a run on this conversation, and leaves when it ends", async () => {
    runs = [{ run_id: "r-live", status: "running", started_at: ago(70_000), conversation_id: "cv1", lane: "conversation" }];
    stubFetch(TURNS);
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".conv-working")).toBeTruthy());
    const row = container.querySelector(".conv-working") as HTMLElement;
    expect(row.querySelector(".conv-shimmer")!.textContent).toBe("Working…");
    expect(row.querySelector(".conv-elapsed")!.textContent).toMatch(/^1m 1\ds$/);
    // no dots indicator alongside it
    expect(container.querySelector(".conv-thinking")).toBeNull();
    // nothing said yet → no activity line (never invented)
    expect(row.querySelector(".conv-activity")).toBeNull();
    // (jsdom has no ResizeObserver, so the collapsed work log also streams — push to every tail)
    const tails = () => FakeES.all.filter((e) => e.url.includes("/runs/r-live/stream") && !e.closed);
    expect(tails().length).toBeGreaterThan(0);
    const es = { push: (o: unknown) => tails().forEach((e) => e.push(o)) };
    await act(async () => {
      es.push({ seq: 1, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test", description: "Run the unit tests" } }] } }) });
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(container.querySelector(".conv-activity")!.textContent).toBe("Run the unit tests");
    // the human turn was picked up by that run
    expect(container.querySelector(".turn.human .dlv")!.textContent).toBe("delivered");
    // empty field + live run → circular Stop instead of Send; typing brings Send back
    expect(container.querySelector("#convStop")).toBeTruthy();
    expect(container.querySelector(".conv-composer.has-stop")).toBeTruthy();
    fireEvent.change(container.querySelector("#convInput")!, { target: { value: "also lint" } });
    expect(container.querySelector("#convStop")).toBeNull();
    // the stream reports the run finished → "Working…" is gone on the next frame; the
    // block freezes in place as "Worked for …" until its durable turn replaces it
    await act(async () => { es.push({ seq: 2, done: true, status: "exited" }); });
    await waitFor(() => expect(container.querySelector(".conv-working")).toBeNull());
    expect(container.querySelector(".conv-shimmer")).toBeNull();
    expect(container.querySelector(".conv-live.is-settled .v2-worked-label")!.textContent).toMatch(/^Worked for 1 min 1\d sec$/);
    expect(container.querySelector("#convStop")).toBeNull();
  });

  it("attaches Working… under the turn its live run already posted, not below newer turns", async () => {
    runs = [{ run_id: "r-owned", status: "running", started_at: ago(70_000), conversation_id: "cv1", lane: "conversation" }];
    stubFetch([
      ...TURNS,
      { seq: 2, id: "t2", role: "agent", content: "On it — running the suite now.", author_agent_id: "w1", run_id: "r-owned", created_at: ago(60_000) },
      { seq: 3, id: "t3", role: "human", content: "also lint please", author_agent_id: "h1", created_at: ago(10_000) },
    ]);
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("also lint please"));
    await waitFor(() => expect(container.querySelector(".conv-working")).toBeTruthy());
    const row = container.querySelector(".conv-working")!;
    const humans = container.querySelectorAll(".turn.human");
    const last = humans[humans.length - 1];
    // the row sits BEFORE the newer human turn (document order), i.e. under its own turn
    expect(row.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll(".conv-working")).toHaveLength(1);
  });

  it("never shows Working… for a TASK run (not this conversation's turn)", async () => {
    runs = [{ run_id: "r-task", status: "running", started_at: ago(70_000), task_id: "t9", conversation_id: null, lane: "work", wake_event: "task_assigned" }];
    stubFetch(TURNS);
    const { container } = mount();
    await waitFor(() => expect((global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).endsWith("/runs"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".conv-working")).toBeNull();
    expect(container.querySelector("#convStop")).toBeNull();
  });

  it("header: help icon carries the turn-based note; Pair in terminal + maximize are header icons", async () => {
    runs = [];
    stubFetch(TURNS);
    const { container } = mount(false);
    await waitFor(() => expect(container.querySelector(".turn.human")).toBeTruthy());
    const head = container.querySelector(".conv-head") as HTMLElement;
    expect(head.textContent).toContain("wren");
    expect(head.querySelector("#convPair")).toBeTruthy();
    expect(head.querySelector("#convMax")).toBeTruthy();
    expect(head.querySelector(".v2-help")!.getAttribute("aria-label")).toBe("How this conversation works");
    // the boilerplate is not a visible footnote anywhere, nor stuffed into Send's tooltip
    expect(container.textContent).not.toMatch(/Turn-based/);
    expect(container.querySelector("#convSend")!.getAttribute("title")).not.toMatch(/Turn-based/);
  });
});
