/**
 * OrchaTerm engine behavioral tests — the Vitest port of the pytest node
 * harnesses from tests/test_s3_embedded_terminal.py (the `__TERMJS__`
 * substitution sims), driving the REAL engine (./orchaTerm) with a fake
 * WebSocket class + a fake window.Terminal (xterm):
 *   - the Forge PTY frame protocol (b960aceb v1): /api/terminal/config
 *     discovery → the contract ws URL; {stdin|resize} client frames;
 *     {stdout|status} server frames; explicit close → close-now 4001.
 *   - ISS-71: detach keeps the socket OPEN and the session registered;
 *     reattach re-docks the SAME xterm wrap and reuses the SAME socket
 *     instance (no new WebSocket).
 *   - ISS-67: a never-connected transport close (1006) retries with BOUNDED
 *     backoff (fake timers) then connects; the attempt budget is finite;
 *     policy closes (4403/4409/…) NEVER retry — they tear down at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as OrchaTerm from "./orchaTerm";
import type { TermFrameInfo } from "./orchaTerm";

/* ---------- fakes ---------------------------------------------------------- */
class FakeTerminal {
  static instances: FakeTerminal[] = [];
  cols = 80;
  rows = 24;
  parent: HTMLElement | null = null;
  written: string[] = [];
  dataCb: ((d: string) => void) | null = null;
  resizeCb: ((s: { cols: number; rows: number }) => void) | null = null;
  dispose = vi.fn();
  loadAddon = vi.fn();
  open(p: HTMLElement) {
    this.parent = p;
  }
  write(s: string) {
    this.written.push(s);
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
  }
  onResize(cb: (s: { cols: number; rows: number }) => void) {
    this.resizeCb = cb;
  }
  constructor(public options?: unknown) {
    FakeTerminal.instances.push(this);
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  closeCalls: [number | undefined, string | undefined][] = [];
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close(code?: number, reason?: string) {
    this.closeCalls.push([code, reason]);
    this.readyState = 3;
  }
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
}

let fetchCalls: string[] = [];
function stubFetch() {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url === "/api/terminal/config") {
        return { ok: true, status: 200, json: async () => ({ ws_url: "ws://127.0.0.1:9999" }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
}

/* ---------- helpers -------------------------------------------------------- */
type Evt = { s: string; i: TermFrameInfo };
const frame = (obj: object) => ({ data: JSON.stringify(obj) });
const lastWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
// discovery + connect is a pure microtask chain (no timers) — flush it
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("OrchaTerm engine (vanilla terminal.js contract, node-harness parity)", () => {
  beforeEach(() => {
    OrchaTerm._resetForTests();
    FakeTerminal.instances = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    window.Terminal = FakeTerminal as unknown as Window["Terminal"];
    stubFetch();
  });
  afterEach(() => {
    OrchaTerm._resetForTests();
    delete window.Terminal;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("speaks the Forge PTY frame protocol over the discovered bridge socket", async () => {
    const events: Evt[] = [];
    const host = document.createElement("div");
    OrchaTerm.open(host, "a1", { humanId: "h1", preempt: true, onState: (s, i) => events.push({ s, i: i || {} }) });
    await flush();
    // discovered the bridge base, then built the v1 contract URL (host-side, query ids)
    expect(fetchCalls).toContain("/api/terminal/config");
    const ws = lastWs();
    expect(ws).toBeTruthy();
    expect(ws.url).toBe("ws://127.0.0.1:9999/terminal?agent_id=a1&actor_agent_id=h1&preempt=1");
    // the xterm attached into the .term-xterm wrap docked in the host
    const term = FakeTerminal.instances[0];
    expect(host.children.length).toBe(1);
    expect(term.parent).toBe(host.children[0]);
    // server 'connected' status surfaces via onState
    ws.readyState = 1;
    ws.onopen?.();
    ws.onmessage?.(frame({ type: "status", state: "connected" }));
    expect(events.some((e) => e.s === "connected")).toBe(true);
    expect(OrchaTerm.isConnected("a1")).toBe(true);
    // stdout is written to the terminal
    ws.onmessage?.(frame({ type: "stdout", data: "hello" }));
    expect(term.written).toContain("hello");
    // a keystroke becomes a stdin frame; a resize becomes a resize frame
    term.dataCb?.("x");
    term.resizeCb?.({ cols: 120, rows: 40 });
    expect(ws.sent).toContainEqual({ type: "stdin", data: "x" });
    expect(ws.sent).toContainEqual({ type: "resize", cols: 120, rows: 40 });
    // explicit close → the bridge's close-now code 4001 (snapshot + release NOW)
    OrchaTerm.close("a1");
    expect(ws.closeCalls[0]).toEqual([4001, "user-close"]);
    ws.onclose?.({ code: 1000 });
    expect(events.some((e) => e.s === "closed" && e.i.code === 1000)).toBe(true);
    expect(OrchaTerm.hasSession("a1")).toBe(false);
  });

  it("ISS-71: detach keeps the socket open; reattach re-docks the same wrap and reuses the same socket", async () => {
    const hostA = document.createElement("div");
    OrchaTerm.open(hostA, "a1", { humanId: "h1", onState: () => {} });
    await flush();
    const sock = lastWs();
    const wrap = hostA.children[0];
    expect(wrap).toBeTruthy();
    expect(OrchaTerm.hasSession("a1")).toBe(true);
    sock.readyState = 1;
    sock.onmessage?.(frame({ type: "status", state: "connected" }));
    expect(OrchaTerm.isConnected("a1")).toBe(true);
    expect(OrchaTerm.liveAgentIds()).toContain("a1");
    // NAV AWAY → detach: the xterm leaves the DOM but the socket STAYS OPEN
    OrchaTerm.detach("a1");
    expect(hostA.children.length).toBe(0);
    expect(sock.readyState).toBe(1);
    expect(sock.closeCalls.length).toBe(0);
    expect(OrchaTerm.hasSession("a1")).toBe(true);
    // NAV BACK → reattach: SAME xterm element re-docked, NO new WebSocket
    const hostB = document.createElement("div");
    const events: Evt[] = [];
    OrchaTerm.open(hostB, "a1", { humanId: "h1", onState: (s, i) => events.push({ s, i: i || {} }) });
    expect(hostB.children[0]).toBe(wrap);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(events.some((e) => e.s === "connected" && e.i.reattached)).toBe(true);
    // explicit close → ends it
    OrchaTerm.close("a1");
    sock.onclose?.({ code: 1000 });
    expect(OrchaTerm.hasSession("a1")).toBe(false);
  });

  it("ISS-67: a never-connected transport close (1006) retries with backoff, then connects", async () => {
    vi.useFakeTimers();
    const events: Evt[] = [];
    const host = document.createElement("div");
    OrchaTerm.open(host, "a1", { humanId: "h1", onState: (s, i) => events.push({ s, i: i || {} }) });
    await flush();
    const sock1 = lastWs();
    expect(sock1).toBeTruthy();
    // abnormal close before ever reaching 'connected' (the bridge is still booting)
    sock1.onclose?.({ code: 1006 });
    // must NOT hard-fail: no 'closed', and progressive bridge-starting state instead
    expect(events.some((e) => e.s === "closed")).toBe(false);
    expect(events.some((e) => e.s === "connecting" && e.i.bridgeStarting && e.i.attempt === 1)).toBe(true);
    expect(FakeWebSocket.instances.length).toBe(1); // the retry waits out the backoff first
    // BACKOFF then RETRY: a NEW socket after the first 300ms backoff
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeWebSocket.instances.length).toBe(2);
    const sock2 = lastWs();
    expect(sock2).not.toBe(sock1);
    // the retry CONNECTS — 'connected' surfaces; no 'closed' was ever emitted
    sock2.readyState = 1;
    sock2.onmessage?.(frame({ type: "status", state: "connected" }));
    expect(OrchaTerm.isConnected("a1")).toBe(true);
    expect(events.some((e) => e.s === "closed")).toBe(false);
  });

  it("ISS-67: the retry budget is BOUNDED — exhausting it hard-fails with 'closed'", async () => {
    vi.useFakeTimers();
    const events: Evt[] = [];
    const host = document.createElement("div");
    OrchaTerm.open(host, "a1", { humanId: "h1", onState: (s, i) => events.push({ s, i: i || {} }) });
    await flush();
    // 5 retriable closes consume the whole attempt budget (backoff 300…2500ms)
    for (const delay of [300, 700, 1200, 2000, 2500]) {
      lastWs().onclose?.({ code: 1006 });
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(FakeWebSocket.instances.length).toBe(6); // initial + 5 retries
    expect(events.some((e) => e.s === "closed")).toBe(false);
    lastWs().onclose?.({ code: 1006 }); // budget spent → a real end
    expect(events.some((e) => e.s === "closed" && e.i.code === 1006)).toBe(true);
    expect(OrchaTerm.hasSession("a1")).toBe(false);
  });

  it("ISS-67: policy closes (4409 busy / 4403 denied) NEVER retry — 'closed' propagates at once", async () => {
    vi.useFakeTimers();
    for (const code of [4409, 4403]) {
      const events: Evt[] = [];
      const host = document.createElement("div");
      const aid = "agent-" + code;
      OrchaTerm.open(host, aid, { humanId: "h1", onState: (s, i) => events.push({ s, i: i || {} }) });
      await flush();
      const before = FakeWebSocket.instances.length;
      lastWs().onclose?.({ code });
      expect(events.some((e) => e.s === "closed" && e.i.code === code)).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000); // plenty of backoff room — nothing may fire
      expect(FakeWebSocket.instances.length).toBe(before); // no retry socket
      expect(OrchaTerm.hasSession(aid)).toBe(false);
    }
  });
});
