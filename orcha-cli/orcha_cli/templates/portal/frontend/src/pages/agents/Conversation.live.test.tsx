/**
 * Live chat — the conversation streams like a terminal:
 *  - the reply in progress renders from the run's own stream (text deltas, tool steps)
 *    with a caret, under "Working… Ns";
 *  - when the run ends the block freezes as "Worked for …" and the durable turn then
 *    takes its place (one block, never both, never a gap);
 *  - Send paints the optimistic bubble and clears the composer in the same event;
 *  - typing in the composer never touches the thread DOM (composer state is isolated).
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation } from "./Conversation";
import { _resetRunStreamHub } from "./runlog";

const RAW_AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
  { id: "lv1", alias: "atlas", kind: "ai", role: "Architect", status: "working" },
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
function mount(id: string) {
  const agent = RAW_AGENTS.find((a) => a.id === id) as unknown as Agent;
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <Conversation key={agent.id} agent={agent} runRunning />
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

describe("live reply", () => {
  it("streams the reply from the run's own stream, freezes on end, and is replaced by the durable turn", async () => {
    turns = [{ seq: 1, id: "t1", role: "human", content: "Why so slow?", author_agent_id: "h1", created_at: ago(20_000) }];
    runs = [{ run_id: "rL", status: "running", started_at: ago(15_000), conversation_id: "cvL", lane: "conversation" }];
    stubFetch();
    const { container } = mount("lv1");
    await waitFor(() => expect(tails("rL").length).toBeGreaterThan(0));
    await act(async () => {
      push("rL", { seq: 1, line: line({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/w/src/config.ts" } }] } }) });
      push("rL", { seq: 2, line: line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Two things " } } }) });
      push("rL", { seq: 3, line: line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "make it **slow**." } } }) });
      await new Promise((r) => setTimeout(r, 60));
    });
    const live = container.querySelector(".conv-live.conv-working") as HTMLElement;
    expect(live).toBeTruthy();
    expect(live.querySelector(".conv-shimmer")!.textContent).toBe("Working…");
    expect(live.querySelector(".lt-step")!.textContent).toContain("Reading config.ts");
    // rendered with the turn's own markdown renderer (bold, no literal markers) + a caret
    const text = live.querySelector(".lt-text") as HTMLElement;
    expect(text.textContent).toBe("Two things make it slow.");
    expect(text.querySelector("strong")!.textContent).toBe("slow");
    // the caret is an EMPTY inline glued right after the last character (same parent as the
    // last text node): zero layout width, so it can never wrap onto a line of its own
    const caret = text.querySelector(".lt-caret") as HTMLElement;
    expect(caret).toBeTruthy();
    expect(caret.childNodes).toHaveLength(0);
    expect(caret.textContent).toBe("");
    expect(caret.getAttribute("aria-hidden")).toBe("true");
    const prev = caret.previousSibling as Text;
    expect(prev.nodeType).toBe(Node.TEXT_NODE);
    expect(prev.data.endsWith(".")).toBe(true);
    expect(caret.nextSibling).toBeNull();
    // no dots indicator alongside the live reply
    expect(container.querySelector(".conv-thinking")).toBeNull();

    // the run ends: the block freezes in place (no caret, "Worked for …"), nothing vanishes
    await act(async () => { push("rL", { seq: 4, done: true, status: "exited" }); await new Promise((r) => setTimeout(r, 40)); });
    await waitFor(() => expect(container.querySelector(".conv-live.is-settled")).toBeTruthy());
    const frozen = container.querySelector(".conv-live.is-settled") as HTMLElement;
    expect(frozen.querySelector(".v2-worked-label")!.textContent).toMatch(/^Worked for 1\d sec$/);
    expect(frozen.querySelector(".lt-text")!.textContent).toBe("Two things make it slow.");
    expect(frozen.querySelector(".lt-caret")).toBeNull();

    // the durable turn lands (fast settle poll): it replaces the frozen block — never both
    runs = [{ run_id: "rL", status: "exited", started_at: ago(15_000), ended_at: new Date().toISOString(), conversation_id: "cvL", lane: "conversation" }];
    extraTurns = [{ seq: 2, id: "t2", role: "agent", content: "Two things make it **slow**.", author_agent_id: "lv1", run_id: "rL", created_at: new Date().toISOString() }];
    await waitFor(() => expect(container.querySelector(".conv-live")).toBeNull(), { timeout: 4000 });
    const agentTurns = container.querySelectorAll(".turn.agent:not(.conv-indicator)");
    expect(agentTurns).toHaveLength(1);
    expect(agentTurns[0].textContent).toContain("Two things make it slow.");
    expect(agentTurns[0].querySelector(".v2-worked-label")!.textContent).toMatch(/^Worked for/);
  });
});

describe("instant send + isolated composer", () => {
  it("paints the optimistic bubble and clears the composer in the same event", async () => {
    turns = [];
    runs = [];
    stubFetch({ holdPost: true });
    const { container } = mount("lv2");
    await waitFor(() => expect(container.querySelector("#convInput")).toBeTruthy());
    await waitFor(() => expect(container.querySelector(".conv-empty")?.textContent).toMatch(/No messages yet/));
    const input = container.querySelector("#convInput") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "ship it" } });
    act(() => { fireEvent.click(container.querySelector("#convSend")!); });
    // no await: same event
    expect(container.querySelector(".turn.pending .tx")!.textContent).toBe("ship it");
    expect((container.querySelector("#convInput") as HTMLTextAreaElement).value).toBe("");
    expect(container.querySelector(".turn.pending .dlv")!.textContent).toBe("sending…");
  });

  it("typing in the composer never touches the thread DOM", async () => {
    turns = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, id: "k" + i, role: i % 2 ? "agent" : "human", content: "turn " + i, author_agent_id: i % 2 ? "lv3" : "h1", created_at: ago((20 - i) * 60_000) }));
    runs = [];
    stubFetch();
    const { container } = mount("lv3");
    await waitFor(() => expect(container.querySelectorAll(".turn").length).toBeGreaterThan(5));
    const list = container.querySelector("#convList") as HTMLElement;
    const before = Array.from(list.querySelectorAll(".turn"));
    const muts: MutationRecord[] = [];
    const mo = new MutationObserver((m) => muts.push(...m));
    mo.observe(list, { childList: true, subtree: true, characterData: true, attributes: true });
    const input = container.querySelector("#convInput") as HTMLTextAreaElement;
    for (const v of ["h", "he", "hel", "hell", "hello"]) fireEvent.change(input, { target: { value: v } });
    await new Promise((r) => setTimeout(r, 0));
    mo.disconnect();
    expect(muts).toHaveLength(0);
    expect(Array.from(list.querySelectorAll(".turn"))).toEqual(before);
    expect(input.value).toBe("hello");
  });
});
