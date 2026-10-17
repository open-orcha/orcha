/**
 * Agent-status parity with the backend's additive snapshot facts
 * (container_snapshot_routes.py): `running_run` (what /runs reports running,
 * not lease-gated), `container.runtime_served` (server DB clock) and the
 * explicit pause fields. The roster / board (snapshot only) must read the same
 * word the workspace header reads from /runs.
 */
import { describe, expect, it } from "vitest";
import { mapSnapshot } from "../../api/client";
import { notifierState } from "../../lib/notifier";
import { agentPresence, projectServed, STALE_RUN_NOTE, SCANNER_OFFLINE_NOTE } from "./presence";
import type { Agent, Run, Snapshot } from "../../types";

const OLD = new Date(Date.now() - 10 * 60_000).toISOString();
const FRESH = new Date().toISOString();

function snap(container: Record<string, unknown>, agent: Record<string, unknown>): { s: Snapshot; a: Agent } {
  const s = mapSnapshot({
    container: { id: "c1", status: "active", wakes_enabled: true, ...container },
    agents: [{ id: "a1", alias: "mira", kind: "ai", status: "idle", ...agent }],
    tasks: [], requests: [],
  });
  return { s, a: s.agents[0] };
}

describe("snapshot mapping keeps the new facts", () => {
  it("maps running_run + pause fields on agents; the container passes runtime_served / icon through", () => {
    const { s, a } = snap(
      { runtime_served: false, wake_scan_age_secs: 600, icon: { kind: "emoji", value: "🚀" } },
      { running_run: { run_id: "r1", lease_live: false }, wakes_paused: true, wakes_paused_reason: "project_wakes_off", pause_stops_running_run: false },
    );
    expect(a.running_run).toEqual({ run_id: "r1", lease_live: false });
    expect(a.wakes_paused).toBe(true);
    expect(a.wakes_paused_reason).toBe("project_wakes_off");
    expect(a.pause_stops_running_run).toBe(false);
    expect(s.container?.runtime_served).toBe(false);
    expect(s.container?.icon).toEqual({ kind: "emoji", value: "🚀" });
  });
  it("an older backend without the fields leaves them undefined (old rules apply)", () => {
    const { a } = snap({}, {});
    expect("running_run" in a).toBe(false);
    expect("wakes_paused" in a).toBe(false);
  });
});

describe("presence parity", () => {
  it("running_run reads Working on the roster before /runs loads — same as the header with /runs", () => {
    const { s, a } = snap({ last_wake_scan_at: FRESH, runtime_served: true }, { running_run: { run_id: "r1", lease_live: true } });
    const roster = agentPresence(a, { snap: s });
    const header = agentPresence({ ...a, running_run: undefined }, { snap: s, runs: [{ run_id: "r1", status: "running" } as unknown as Run] });
    expect(roster.label).toBe("Working");
    expect(header.label).toBe(roster.label);
  });
  it("a lapsed lease adds a may-be-stale note", () => {
    const { s, a } = snap({ runtime_served: true, last_wake_scan_at: FRESH }, { running_run: { run_id: "r1", lease_live: false } });
    const p = agentPresence(a, { snap: s });
    expect(p.label).toBe("Working");
    expect(p.reason).toContain(STALE_RUN_NOTE);
  });
  it("runtime_served (server clock) wins over the browser-clock stamp", () => {
    // stamp looks fresh to the browser, but the server says nothing serves the project
    const off = snap({ last_wake_scan_at: FRESH, runtime_served: false }, {});
    expect(projectServed(off.s)).toBe(false);
    expect(agentPresence(off.a, { snap: off.s }).label).toBe("No runtime");
    expect(notifierState(off.s.container)).toBe("stale");
    // stamp looks old to a skewed browser clock, but the server says it is served
    const on = snap({ last_wake_scan_at: OLD, runtime_served: true }, {});
    expect(projectServed(on.s)).toBe(true);
    expect(agentPresence(on.a, { snap: on.s }).label).toBe("Idle");
    expect(notifierState(on.s.container)).toBe("running");
  });
  it("a paused agent with a run in flight stays Working; the pause reason is in the tooltip", () => {
    const { s, a } = snap(
      { runtime_served: true, last_wake_scan_at: FRESH, wakes_enabled: false },
      { running_run: { run_id: "r1", lease_live: true }, wakes_paused: true, wakes_paused_reason: "project_wakes_off", pause_stops_running_run: false },
    );
    const p = agentPresence(a, { snap: s });
    expect(p.label).toBe("Working");
    expect(p.reason).toMatch(/Wakes are paused for this project\. The current run keeps going/);
    expect(p.reason).not.toContain(SCANNER_OFFLINE_NOTE);
  });
  it("an idle agent whose own wakes are off reads Paused", () => {
    const { s, a } = snap({ runtime_served: true, last_wake_scan_at: FRESH }, { wakes_paused: true, wakes_paused_reason: "agent_wakes_off" });
    expect(agentPresence(a, { snap: s }).label).toBe("Paused");
  });
});
