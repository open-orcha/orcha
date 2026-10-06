/**
 * C9b — a stopped / failed conversation run that posted no reply shows its outcome as
 * the turn's terminal state ("Stopped after 3 sec"), never "Worked for" and never
 * fake thinking dots; the human turn reads "delivered".
 * (fixture shared with Conversation.live.test.tsx)
 *  - the reply in progress renders from the run's own stream (text deltas, tool steps)
 *    with a caret, under "Working… Ns";
 *  - when the run ends the block freezes as "Worked for …" and the durable turn then
 *    takes its place (one block, never both, never a gap);
 *  - Send paints the optimistic bubble and clears the composer in the same event;
 *  - typing in the composer never touches the thread DOM (composer state is isolated).
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation, endedReplylessRuns } from "./Conversation";
import { _resetRunStreamHub } from "./runlog";

const RAW_AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
  { id: "lv1", alias: "atlas", kind: "ai", role: "Architect", status: "working" },
  { id: "lv4", alias: "atlasB", kind: "ai", role: "Architect", status: "awaiting_request" },
  { id: "lv2", alias: "iris", kind: "ai", role: "Builder", status: "idle" },
  { id: "lv3", alias: "juno", kind: "ai", role: "Builder", status: "idle" },
];
const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

class FakeES {
  static all: FakeES[] = [];
  url: string;
  readyState = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) { this.url = url; FakeES.all.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  push(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
const tails = (rid: string) => FakeES.all.filter((e) => e.url.includes("/runs/" + rid + "/stream") && !e.closed);
const push = (rid: string, o: unknown) => tails(rid).forEach((e) => e.push(o));
const line = (o: unknown) => JSON.stringify(o);

let runs: unknown[] = [];
let turns: unknown[] = [];
let extraTurns: unknown[] = [];
function stubFetch(opts: { holdPost?: boolean } = {}) {
  const snapshot = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: new Date().toISOString(), wakes_enabled: true },
    agents: RAW_AGENTS, tasks: [], requests: [],
  };
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
    if (url.includes("/conversation?limit=")) return jsonRes({ conversation: { id: "cvL", status: "active" }, turns });
    if (/\/api\/agents\/[^/]+\/runs$/.test(url)) return jsonRes({ runs });
    if (/\/turns$/.test(url) && init?.method === "POST") {
      if (opts.holdPost) return new Promise<Response>(() => {});
      return jsonRes({ turn: { id: "tNew", seq: 99, role: "human", content: "hi", created_at: new Date().toISOString() } });
    }
    if (url.includes("/turns?after_seq=")) return jsonRes({ turns: extraTurns });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(id: string, runRunning = true) {
  const agent = RAW_AGENTS.find((a) => a.id === id) as unknown as Agent;
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <Conversation key={agent.id} agent={agent} runRunning={runRunning} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  FakeES.all = [];
  _resetRunStreamHub();
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  extraTurns = [];
  try { sessionStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});


const HUMAN_STOP = JSON.stringify({ cause: "human_stop" });

describe("C9b stopped run with no reply", () => {
  it("freezes the live block as 'Stopped after N sec' when the stream reports killed", async () => {
    turns = [{ seq: 1, id: "t1", role: "human", content: "Stop test B", author_agent_id: "h1", created_at: ago(5_000) }];
    runs = [{ run_id: "rS", status: "running", started_at: ago(3_000), conversation_id: "cvL", lane: "conversation" }];
    stubFetch();
    const { container } = mount("lv1");
    await waitFor(() => expect(tails("rS").length).toBeGreaterThan(0));
    await act(async () => {
      push("rS", { seq: 1, line: line({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 30" } }] } }) });
      await new Promise((r) => setTimeout(r, 30));
    });
    runs = [{ run_id: "rS", status: "killed", exit_code: 143, kill_reason: HUMAN_STOP, started_at: ago(3_000), ended_at: new Date().toISOString(), conversation_id: "cvL", lane: "conversation" }];
    await act(async () => { push("rS", { seq: 2, done: true, status: "killed" }); await new Promise((r) => setTimeout(r, 40)); });
    await waitFor(() => expect(container.querySelector(".conv-live.is-settled")).toBeTruthy());
    const frozen = container.querySelector(".conv-live.is-settled") as HTMLElement;
    expect(frozen.querySelector(".v2-worked-label")!.textContent).toMatch(/^Stopped after \d sec$/);
    expect(container.querySelector(".conv-thinking")).toBeNull();
  });

  it("after the settle window / on reload: an outcome row, no thinking dots, turn 'delivered'", async () => {
    turns = [{ seq: 1, id: "t1", role: "human", content: "Stop test B", author_agent_id: "h1", created_at: ago(60_000) }];
    runs = [{ run_id: "rK", status: "killed", exit_code: 143, kill_reason: HUMAN_STOP, started_at: ago(58_000), ended_at: ago(55_000), conversation_id: "cvL", lane: "conversation" }];
    stubFetch();
    const { container } = mount("lv4", false);
    await waitFor(() => expect(container.querySelector(".conv-ended-run")).toBeTruthy());
    const row = container.querySelector(".conv-ended-run") as HTMLElement;
    expect(row.querySelector(".v2-worked-label")!.textContent).toBe("Stopped after 3 sec");
    expect(row.textContent).toContain("stopped by a human");
    expect(container.querySelector(".conv-thinking")).toBeNull();
    expect(container.querySelector(".conv-indicator")).toBeNull();
    expect(container.querySelector(".turn.human .dlv")!.textContent).toBe("delivered");
  });

  it("endedReplylessRuns: one row per unanswered human turn; answered / referenced runs skipped", () => {
    const T = (i: number, role: string, at: number, run_id?: string) => ({ seq: i, id: "x" + i, role, content: "", created_at: new Date(at).toISOString(), run_id });
    const R = (id: string, at: number, status = "killed") => ({ run_id: id, status, started_at: new Date(at).toISOString() });
    const base = Date.parse("2026-09-29T10:00:00Z");
    const tt = [T(1, "human", base), T(2, "human", base + 10_000), T(3, "agent", base + 15_000), T(4, "human", base + 20_000), T(5, "agent", base + 25_000, "rRef")] as any;
    const out = endedReplylessRuns(tt, [R("rA", base + 1000), R("rA2", base + 2000), R("rB", base + 11_000), R("rRef", base + 21_000), R("rLive", base + 21_000, "running")] as any, null);
    // turn 1 (idx 0) unanswered: newest run rA2 wins; turn 2 answered by t3; turn 4 answered by the referenced run
    expect(out.map((o) => [String(o.run.run_id), o.afterIdx])).toEqual([["rA2", 0]]);
    expect(endedReplylessRuns(tt, [R("rA2", base + 2000)] as any, "rA2")).toEqual([]);
  });
});
