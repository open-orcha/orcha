/**
 * Live changes on the live "Working…" row: the row carries the same button as the
 * header (fed by the workspace's ONE poller via LiveChangesContext) — only for the
 * running run it speaks for, never after that run ends. Also: the Stop button's
 * contrast styling is a filled circle (not the near-invisible outline).
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation } from "./Conversation";
import { LiveChangesContext, type LiveChangesCtx } from "./liveChangesContext";

const RAW_AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
  { id: "w1", alias: "wren", kind: "ai", role: "Builder", status: "working" },
];
const agent = RAW_AGENTS[1] as unknown as Agent;
const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
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
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const TURNS = [{ seq: 1, id: "t1", role: "human", content: "Run the tests", author_agent_id: "h1", created_at: ago(90_000) }];
function stubFetch() {
  const snapshot = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: new Date().toISOString(), wakes_enabled: true },
    agents: RAW_AGENTS, tasks: [], requests: [],
  };
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(snapshot);
    if (url.includes("/conversation?limit=")) return jsonRes({ conversation: { id: "cv1", status: "active" }, turns: TURNS });
    if (url.endsWith("/api/agents/w1/runs")) return jsonRes({ runs: [{ run_id: "r-live", status: "running", started_at: ago(70_000), conversation_id: "cv1", lane: "conversation" }] });
    if (url.includes("/turns")) return jsonRes({ turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(ctx: LiveChangesCtx | null) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <LiveChangesContext.Provider value={ctx}>
          <Conversation key={agent.id} agent={agent} runRunning />
        </LiveChangesContext.Provider>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
beforeEach(() => {
  FakeES.all = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Working… row — Live changes", () => {
  it("shows the button with the real counts for the running run and opens the panel", async () => {
    const open = vi.fn();
    const { container } = mount({ runId: "r-live", live: true, summary: { files: 3, additions: 42, deletions: 7 }, isOpen: false, open });
    await waitFor(() => expect(container.querySelector(".conv-working")).toBeTruthy());
    const btn = container.querySelector(".conv-working .conv-live-changes") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toBe("Live changes — 3 files +42 −7");
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledTimes(1);
    // the run ends → the row freezes as "Worked for …" and the live button leaves with it
    const tails = FakeES.all.filter((e) => e.url.includes("/runs/r-live/stream") && !e.closed);
    await act(async () => { tails.forEach((e) => e.push({ seq: 2, done: true, status: "exited" })); });
    await waitFor(() => expect(container.querySelector(".conv-working")).toBeNull());
    expect(container.querySelector(".conv-live-changes")).toBeNull();
  });

  it("no button when the context speaks for a different run, or there is none", async () => {
    const { container } = mount({ runId: "other", live: true, summary: null, isOpen: false, open: () => {} });
    await waitFor(() => expect(container.querySelector(".conv-working")).toBeTruthy());
    expect(container.querySelector(".conv-live-changes")).toBeNull();
    cleanup();
    const again = mount(null);
    await waitFor(() => expect(again.container.querySelector(".conv-working")).toBeTruthy());
    expect(again.container.querySelector(".conv-live-changes")).toBeNull();
  });
});

describe("visual nits (CSS contract)", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");
  it("the composer Stop is a filled high-contrast circle, not the ~1:1 outline", () => {
    const css = read("./agents.css");
    const rule = css.match(/\.conv \.conv-composer \.conv-stop \{[^}]*\}/)![0];
    expect(rule).toContain("background: var(--v2-text)");
    expect(rule).not.toContain("--v2-hover-solid");
  });
  it("a disabled primary button drops the filled primary style (viewer 'Approve plan')", () => {
    const css = read("../../../../static/styles/v2-primitives.css");
    const rule = css.match(/\.v2-btn-primary:disabled:not\(\[aria-busy="true"\]\), \.v2-btn-primary\[aria-disabled="true"\] \{[^}]*\}/)![0];
    expect(rule).toContain("background: var(--v2-btn-secondary-bg)");
    expect(rule).toContain("opacity: 1");
  });
});
