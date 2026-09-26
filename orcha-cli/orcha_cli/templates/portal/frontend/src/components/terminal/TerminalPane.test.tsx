/**
 * S3 §3b pairing tests — stubbed fetch + a fake window.Terminal (xterm) global
 * + a fake WebSocket. Covers: the ISS-84 (#244) preflight pre-gate blocking on
 * {installed:false} with the corrective install prompt; the §3b lease guards
 * (live → guard toast, resident → hand-off modal → preempt=1 pair); and the
 * happy path (gate passes → the terminal container renders and the stubbed
 * xterm attaches + the bridge ws URL matches the vanilla contract exactly).
 */
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../ui";
import { SnapshotProvider, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import * as OrchaTerm from "./orchaTerm";
import { usePairing } from "./TerminalPane";

/* ---------- fakes ---------------------------------------------------------- */
class FakeTerminal {
  static instances: FakeTerminal[] = [];
  cols = 80;
  rows = 24;
  open = vi.fn();
  write = vi.fn();
  dispose = vi.fn();
  loadAddon = vi.fn();
  onData = vi.fn();
  onResize = vi.fn();
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
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
}

interface StubOpts {
  embodiment?: string;
  preflight?: unknown; // body of GET <bridge-http-base>/preflight?agent_id=…
}
let calls: string[] = [];

function stubFetch(opts: StubOpts = {}) {
  calls = [];
  const RAW = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
      { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "idle", model: "claude-sonnet-4-6", embodiment: opts.embodiment ?? "idle" },
    ],
    tasks: [],
    requests: [],
  };
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push(url);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(RAW);
    // bridge base discovery (terminal.js contract): GET /api/terminal/config -> {ws_url}
    if (url === "/api/terminal/config") return json({ ws_url: "ws://127.0.0.1:9999" });
    // ISS-84 preflight on the bridge's http base derived from the ws base
    if (url.includes("/preflight")) {
      if (opts.preflight === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return json(opts.preflight);
    }
    return json({});
  }) as unknown as typeof fetch;
}

/* ---------- harness: the same surface Conversation.tsx consumes ----------- */
function Paired({ agent }: { agent: Agent }) {
  const pairing = usePairing(agent);
  return (
    <div>
      <button id="convPair" onClick={pairing.togglePair}>
        {pairing.paired ? "Terminal paired" : "Pair in terminal"}
      </button>
      <div className="term-slot" id="convTermSlot">
        {pairing.termSlot}
      </div>
      {pairing.overlays}
    </div>
  );
}
function Harness() {
  const { snap } = useSnapshot();
  const agent = snap?.agents.find((a) => a.alias === "forge") ?? null;
  if (!agent) return <div>loading…</div>;
  return <Paired agent={agent} />;
}
function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <Harness />
      </SnapshotProvider>
    </ToastProvider>,
  );
}
async function clickPair() {
  const btn = await screen.findByText("Pair in terminal");
  fireEvent.click(btn);
}

describe("TerminalPane pairing (§3b + ISS-84 gate, vanilla conversation.js parity)", () => {
  beforeEach(() => {
    OrchaTerm._resetForTests();
    FakeTerminal.instances = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    window.Terminal = FakeTerminal as unknown as Window["Terminal"];
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    OrchaTerm._resetForTests();
    cleanup();
    delete window.Terminal;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preflight {installed:false} BLOCKS pairing with the corrective install prompt", async () => {
    stubFetch({ preflight: { runtime: "claude", installed: false, install_hint: "brew install claude-code" } });
    const { container } = mount();
    await clickPair();
    // the pre-gate modal names the runtime product and carries the bridge hint
    await screen.findByText("Claude Code isn't installed");
    expect(screen.getByText("brew install claude-code")).toBeInTheDocument();
    expect(screen.getByText("Copy install hint")).toBeInTheDocument();
    // pairing was blocked: no terminal container, no xterm attach, no bridge ws
    expect(container.querySelector(".term")).toBeNull();
    expect(FakeTerminal.instances.length).toBe(0);
    expect(FakeWebSocket.instances.length).toBe(0);
    // the probe hit the bridge's http base derived from the discovered ws base
    expect(calls).toContain("http://127.0.0.1:9999/preflight?agent_id=a1");
  });

  it("a live-lease agent (embodiment 'live' held elsewhere) triggers the §3b guard — no pair", async () => {
    stubFetch({ embodiment: "live", preflight: { installed: true } });
    const { container } = mount();
    await clickPair();
    await screen.findByText("forge already holds a live session"); // guard toast
    expect(container.querySelector(".term")).toBeNull();
    expect(FakeWebSocket.instances.length).toBe(0);
    // no gate probe either — the guard fires before gateThenPair
    expect(calls.some((u) => u.includes("/preflight"))).toBe(false);
  });

  it("a resident lease raises the §3b hand-off modal; confirming pairs with preempt=1", async () => {
    stubFetch({ embodiment: "resident", preflight: { installed: true } });
    mount();
    await clickPair();
    await screen.findByText("Hand off the live conversation?");
    fireEvent.click(screen.getByText("Hand off & pair"));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    expect(FakeWebSocket.instances[0].url).toBe(
      "ws://127.0.0.1:9999/terminal?agent_id=a1&actor_agent_id=h1&preempt=1",
    );
  });

  it("successful gate renders the terminal container and attaches the (stubbed) xterm", async () => {
    stubFetch({ preflight: { runtime: "claude", installed: true } });
    const { container } = mount();
    await clickPair();
    // the docked panel (vanilla termShell markup) renders
    await waitFor(() => expect(container.querySelector(".term")).toBeTruthy());
    expect(container.querySelector("#termBody")).toBeTruthy();
    expect(screen.getByText("forge@orcha — pair session")).toBeInTheDocument();
    // xterm attached into the .term-xterm wrap inside the body host
    expect(FakeTerminal.instances.length).toBe(1);
    const term = FakeTerminal.instances[0];
    expect(term.open).toHaveBeenCalledTimes(1);
    const wrap = term.open.mock.calls[0][0] as HTMLElement;
    expect(wrap.className).toBe("term-xterm");
    expect(container.querySelector("#termBody")!.contains(wrap)).toBe(true);
    // the bridge ws URL matches the vanilla contract exactly (no preempt flag)
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    expect(FakeWebSocket.instances[0].url).toBe("ws://127.0.0.1:9999/terminal?agent_id=a1&actor_agent_id=h1");
    // bridge status frame 'connected' → the pairtag goes live
    act(() => {
      FakeWebSocket.instances[0].readyState = 1;
      FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "status", state: "connected" }) });
    });
    await screen.findByText("live · paired as forge");
    // and the pair button flips to the paired state
    expect(screen.getByText("Terminal paired")).toBeInTheDocument();
  });
});
