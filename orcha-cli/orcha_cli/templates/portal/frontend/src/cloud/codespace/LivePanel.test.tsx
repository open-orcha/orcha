/**
 * LivePanel — lists running runs from the snapshot's per-agent active_run
 * (no new backend endpoint — see liveEdits.ts's module doc), consumes the
 * EXISTING run stream via a stubbed EventSource, and extracts Edit/Write/
 * MultiEdit tool events into patch cards. "Raise hand" reports the run's
 * agent + clicked line back to the caller.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { LivePanel } from "./LivePanel";

/* ---- a minimal fake EventSource — jsdom has none; useRunStream feature-
   detects it, so tests that need a LIVE stream provide their own (no house
   precedent for this exists yet — TasksPage/SettingsPage tests instead rely
   on the graceful "no EventSource" degrade). Captures every instance so the
   test can push {seq,line} frames straight into onmessage. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {}
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const AGENTS_RUNNING: Agent[] = [
  {
    id: "a1", alias: "forge", kind: "ai", status: "working",
    active_run: { run_id: "r1", started_at: "2026-08-01T00:00:00Z" },
  } as Agent,
];
const AGENTS_IDLE: Agent[] = [
  { id: "a1", alias: "forge", kind: "ai", status: "idle", active_run: null } as Agent,
];

function stubFetch(agents: Agent[]) {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1")) {
      return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents, tasks: [], requests: [] });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

function mount(agents: Agent[], onRaiseHand = vi.fn()) {
  return {
    onRaiseHand,
    ...render(
      <ToastProvider>
        <SnapshotProvider>
          <LivePanel cid="c1" agents={agents} onJumpToLine={vi.fn()} onRaiseHand={onRaiseHand} />
        </SnapshotProvider>
      </ToastProvider>,
    ),
  };
}

describe("LivePanel", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); FakeEventSource.instances = []; });

  it("shows an empty state when no agents are running", async () => {
    stubFetch(AGENTS_IDLE);
    mount(AGENTS_IDLE);
    expect(await screen.findByText(/no agents are running right now/i)).toBeInTheDocument();
  });

  it("lists a running agent from the snapshot's active_run", async () => {
    stubFetch(AGENTS_RUNNING);
    mount(AGENTS_RUNNING);
    expect(await screen.findByText("forge")).toBeInTheDocument();
  });

  it("selecting a running agent streams edits and renders per-file patch cards", async () => {
    (global as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
    stubFetch(AGENTS_RUNNING);
    mount(AGENTS_RUNNING);
    fireEvent.click(await screen.findByText("forge"));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/agents/a1/runs/r1/stream");

    const toolLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "src/a.ts", content: "hello\nworld" } }] },
    });
    FakeEventSource.instances[0].emit({ seq: 1, line: toolLine });

    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("+hello")).toBeInTheDocument();
    expect(screen.getByText("+world")).toBeInTheDocument();
  });

  it("raise-hand button reports the run's agent id + clicked patch line", async () => {
    (global as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
    stubFetch(AGENTS_RUNNING);
    const onRaiseHand = vi.fn();
    mount(AGENTS_RUNNING, onRaiseHand);
    fireEvent.click(await screen.findByText("forge"));

    const toolLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "b.ts", old_string: "x", new_string: "y" } }] },
    });
    FakeEventSource.instances[0].emit({ seq: 1, line: toolLine });

    await screen.findByText("b.ts");
    const raiseBtn = screen.getAllByText("raise hand")[0];
    fireEvent.click(raiseBtn);
    expect(onRaiseHand).toHaveBeenCalledWith("a1", 1);
  });
});
