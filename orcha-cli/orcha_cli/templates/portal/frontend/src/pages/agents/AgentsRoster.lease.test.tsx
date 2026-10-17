/**
 * Integration r2: the roster tells status once, but an IDLE agent that still
 * holds an embodiment lease (a backgrounded live terminal, ISS-71) keeps a
 * findable lease badge in the status slot.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Agent, Snapshot } from "../../types";
import { AgentsRoster } from "./AgentsRoster";

const ag = (over: Partial<Agent>): Agent => ({ id: over.alias!, alias: "x", kind: "ai", status: "idle", role: "dev", ...over } as Agent);

function mount(agents: Agent[]) {
  return render(
    <MemoryRouter>
      <AgentsRoster agents={agents} selAlias={null} onSelect={() => {}} rosterRef={{ current: null }} q="" onQ={() => {}} />
    </MemoryRouter>,
  );
}

describe("roster lease badge", () => {
  it("idle + live lease → one 'live' badge; working → the status word only", () => {
    const { container } = mount([
      ag({ alias: "term", status: "idle", embodiment: "live" } as Partial<Agent>),
      ag({ alias: "busy", status: "working", embodiment: "resident" } as Partial<Agent>),
      ag({ alias: "calm", status: "idle" }),
    ]);
    const row = (a: string) => container.querySelector(`[data-alias="${a}"]`)!;
    expect(row("term").querySelector(".rlive.live")?.textContent).toBe("live");
    expect(row("busy").querySelector(".rlive")).toBeNull();
    expect(row("busy").querySelector(".rword")?.getAttribute("title")).toMatch(/live conversation/);
    expect(row("calm").querySelector(".rlive, .rword")).toBeNull();
    expect(screen.getAllByText("live")).toHaveLength(1);
  });
});

describe("agentWord = agentPresence() label (one presence function on every surface)", () => {
  const fresh = { container: { id: "c1", last_wake_scan_at: new Date().toISOString() } } as unknown as Snapshot;
  const stale = { container: { id: "c1", last_wake_scan_at: new Date(Date.now() - 3600_000).toISOString() } } as unknown as Snapshot;
  const paused = { container: { id: "c1", last_wake_scan_at: new Date().toISOString(), wakes_enabled: false } } as unknown as Snapshot;
  const A = (x: Partial<Agent>) => ({ id: "a", alias: "a", kind: "ai", status: "idle", active_run: null, ...x }) as unknown as Agent;
  it("attention states are never overridden by a live run; failed wins; idle says nothing", async () => {
    const { agentWord } = await import("./agentModel");
    expect(agentWord(A({ status: "awaiting_human", active_run: { run_id: "r" } } as Partial<Agent>), fresh)).toBe("Needs you");
    expect(agentWord(A({ status: "blocked", active_run: { run_id: "r" } } as Partial<Agent>), paused)).toBe("Blocked");
    expect(agentWord(A({ status: "failed", active_run: { run_id: "r" } } as Partial<Agent>), fresh)).toBe("Failed");
    expect(agentWord(A({ status: "idle", active_run: { run_id: "r" } } as Partial<Agent>), fresh)).toBe("Working");
    expect(agentWord(A({ status: "idle" }), fresh)).toBeNull();
  });
  it("project-wide states: shown for an agent claiming work, silent for idle ones", async () => {
    const { agentWord } = await import("./agentModel");
    // r3 parity: a working agent reads Working everywhere (the scanner-offline note is its tooltip)
    expect(agentWord(A({ status: "working" }), stale)).toBe("Working");
    // requests EXTRA: waiting on a request answer is the agent's own fact (like awaiting_human /
    // blocked) — a stale scan or a project pause never hides it
    expect(agentWord(A({ status: "awaiting_request" }), stale)).toBe("Waiting");
    expect(agentWord(A({ status: "idle" }), stale)).toBeNull();
    expect(agentWord(A({ status: "awaiting_request" }), paused)).toBe("Waiting");
    expect(agentWord(A({ status: "awaiting_human" }), stale)).toBe("Needs you");
    expect(agentWord(A({ status: "idle" }), paused)).toBeNull();
  });
  it("parity: for every agent the word equals the workspace header's agentPresence label (or it is idle/project-wide)", async () => {
    const { agentWord } = await import("./agentModel");
    const { agentPresence } = await import("./presence");
    for (const snap of [fresh, stale, paused]) {
      for (const status of ["idle", "working", "awaiting_human", "awaiting_request", "blocked", "failed", "terminated"]) {
        for (const active_run of [null, { run_id: "r" }]) {
          const a = A({ status, active_run } as Partial<Agent>);
          const w = agentWord(a, snap);
          const p = agentPresence(a, { snap });
          if (w !== null) expect(w, status).toBe(p.label);
          else expect(["idle", "noruntime", "paused"], status).toContain(p.k);
        }
      }
    }
  });
});
