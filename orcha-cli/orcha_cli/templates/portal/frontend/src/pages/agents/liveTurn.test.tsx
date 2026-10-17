import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  _resetRunStreamHub,
  emptyLiveTurn,
  liveTurnView,
  reduceLiveTurn,
  useLiveTurn,
  useRunActivity,
} from "./runlog";

/* a controllable EventSource: tests push real-shaped run-stream frames */
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
  fail() { this.readyState = 2; this.onerror?.(); }
}
const open = () => FakeES.all.filter((e) => !e.closed);

// the exact shapes the daemon's feed stores (notifier_run_feed.compact_stream_events)
const SID = { session_id: "s1", parent_tool_use_id: null };
const delta = (text: string, index = 0) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } }, ...SID, orcha_coalesced: 1 });
const toolStart = (id: string, name: string, index = 1) => JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name } }, ...SID });
const thinkStart = () => JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } }, ...SID });
const asstText = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, ...SID });
const asstTool = (id: string, name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, ...SID });
const toolResult = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...SID });

const flushFrames = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
};

beforeEach(() => {
  FakeES.all = [];
  _resetRunStreamHub();
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
});
afterEach(() => {
  cleanup();
  _resetRunStreamHub();
  vi.useRealTimers();
});

describe("reduceLiveTurn (pure)", () => {
  it("streams text from deltas, lets the complete block supersede them, and turns narration before a tool into a step", () => {
    const m = emptyLiveTurn();
    let seq = 0;
    const feed = (line: string, at = 1000 + seq) => reduceLiveTurn(m, { seq: ++seq, line }, at);
    feed(delta("Let me check "));
    expect(liveTurnView(m).text).toBe("Let me check ");
    feed(delta("the tests."));
    expect(liveTurnView(m).text).toBe("Let me check the tests.");
    feed(asstText("Let me check the tests."));
    expect(liveTurnView(m).text).toBe("Let me check the tests.");
    // a tool starts: the narration becomes a text step, the reply starts over
    feed(toolStart("tu1", "Bash"));
    let v = liveTurnView(m);
    expect(v.text).toBe("");
    expect(v.steps.map((s) => [s.kind, s.label])).toEqual([
      ["text", "Let me check the tests."],
      ["tool", "Running a command"],
    ]);
    // the complete tool_use upgrades that SAME step's label (no duplicate)
    feed(asstTool("tu1", "Bash", { command: "npm test", description: "Run the unit tests" }));
    feed(toolResult("tu1"));
    v = liveTurnView(m);
    expect(v.steps.map((s) => s.label)).toEqual(["Let me check the tests.", "Run the unit tests"]);
    expect(v.activity).toBe("Run the unit tests");
    // the final answer streams after the last tool
    feed(thinkStart());
    feed(delta("All 42 tests pass."));
    v = liveTurnView(m);
    expect(v.text).toBe("All 42 tests pass.");
    expect(v.steps[v.steps.length - 1].kind).toBe("think");
    expect(v.done).toBe(false);
    reduceLiveTurn(m, { done: true, status: "exited" });
    expect(liveTurnView(m).done).toBe(true);
    expect(liveTurnView(m).text).toBe("All 42 tests pass."); // the reply stays for the hand-off
    expect(liveTurnView(m).startedAt).toBe(1000);
    expect(liveTurnView(m).status).toBe("exited"); // C9b: the terminal status is kept
  });

  it("C9b: keeps a killed run's terminal status; a stream_timeout is not an end", () => {
    const m = emptyLiveTurn();
    reduceLiveTurn(m, { done: true, status: "stream_timeout" });
    expect(liveTurnView(m).status).toBeNull();
    reduceLiveTurn(m, { done: true, status: "killed" });
    expect(liveTurnView(m)).toMatchObject({ done: true, status: "killed" });
  });

  it("never lets a subagent's text into the reply, and ignores lifecycle lines", () => {
    const m = emptyLiveTurn();
    reduceLiveTurn(m, { seq: 1, line: JSON.stringify({ type: "system", subtype: "init", cwd: "/w" }) });
    reduceLiveTurn(m, { seq: 2, line: JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub says hi" } }, parent_tool_use_id: "tu9" }) });
    reduceLiveTurn(m, { seq: 3, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "sub block" }] }, parent_tool_use_id: "tu9" }) });
    reduceLiveTurn(m, { seq: 4, line: JSON.stringify({ type: "result", subtype: "success", result: "x" }) });
    const v = liveTurnView(m);
    expect(v.text).toBe("");
    expect(v.steps).toEqual([]);
  });

  it("a stream_timeout is not the end of the run", () => {
    const m = emptyLiveTurn();
    reduceLiveTurn(m, { done: true, status: "stream_timeout" });
    expect(liveTurnView(m).done).toBe(false);
  });
});

describe("useLiveTurn (EventSource)", () => {
  it("grows the reply as deltas arrive, shares ONE stream with the activity hook, and stops at done", async () => {
    const { result } = renderHook(() => ({ turn: useLiveTurn("a1", "r1"), act: useRunActivity("a1", "r1") }));
    expect(open()).toHaveLength(1); // one shared EventSource for both consumers
    expect(open()[0].url).toBe("/api/agents/a1/runs/r1/stream");
    const es = open()[0];
    await act(async () => { es.push({ seq: 1, line: delta("Hel") }); });
    await flushFrames();
    expect(result.current.turn.text).toBe("Hel");
    await act(async () => {
      es.push({ seq: 2, line: delta("lo, ") });
      es.push({ seq: 3, line: delta("world") });
    });
    await flushFrames();
    expect(result.current.turn.text).toBe("Hello, world");
    expect(result.current.turn.startedAt).not.toBeNull();
    await act(async () => { es.push({ seq: 4, done: true, status: "exited" }); });
    await flushFrames();
    expect(result.current.turn.done).toBe(true);
    expect(result.current.act.ended).toBe(true);
    expect(es.closed).toBe(true);
  });

  it("is reconnect-safe: resumes after the last seq and drops replayed lines", async () => {
    const { result } = renderHook(() => useLiveTurn("a1", "r2"));
    const first = open()[0];
    await act(async () => {
      first.push({ seq: 1, line: delta("one ") });
      first.push({ seq: 2, line: delta("two ") });
      // the server's 30-min cap: reconnect, not the end of the run
      first.push({ seq: 3, done: true, status: "stream_timeout" });
    });
    const second = open()[0];
    expect(second).not.toBe(first);
    expect(second.url).toBe("/api/agents/a1/runs/r2/stream?after_seq=2");
    await act(async () => {
      second.push({ seq: 2, line: delta("two ") }); // overlap replay → dropped
      second.push({ seq: 3, line: delta("three") });
    });
    await flushFrames();
    expect(result.current.text).toBe("one two three");
    expect(result.current.done).toBe(false);
  });

  it("reopens a stream the browser gave up on (CLOSED), resuming after the last seq", async () => {
    vi.useFakeTimers();
    renderHook(() => useLiveTurn("a1", "r3"));
    const first = open()[0];
    act(() => { first.push({ seq: 1, line: delta("x") }); });
    act(() => { first.fail(); });
    expect(open()).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(1100); });
    expect(open()).toHaveLength(1);
    expect(open()[0].url).toBe("/api/agents/a1/runs/r3/stream?after_seq=1");
  });

  it("a late subscriber gets the buffered reply at once (no second stream)", async () => {
    const a = renderHook(() => useLiveTurn("a1", "r4"));
    const es = open()[0];
    await act(async () => { es.push({ seq: 1, line: delta("buffered") }); });
    const b = renderHook(() => useLiveTurn("a1", "r4"));
    await flushFrames();
    expect(open()).toHaveLength(1);
    expect(b.result.current.text).toBe("buffered");
    expect(a.result.current.text).toBe("buffered");
  });

  it("with no run it is idle and opens nothing", () => {
    const { result } = renderHook(() => useLiveTurn("a1", null));
    expect(FakeES.all).toHaveLength(0);
    expect(result.current).toEqual({ text: "", steps: [], activity: null, done: false, startedAt: null, status: null });
  });
});
