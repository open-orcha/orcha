/**
 * SH-116: the All projects hub re-fetches every 15 s (the old hub's cadence)
 * via useProjectsPoll, while the sidebar keeps PROJECTS_REFRESH_MS (60 s).
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_REFRESH_MS, PROJECTS_REFRESH_MS, _resetProjectsForTests, useProjectsPoll } from "./projects";

let calls = 0;
beforeEach(() => {
  calls = 0;
  _resetProjectsForTests();
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => { calls++; return { ok: true, status: 200, json: async () => [] } as unknown as Response; }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetProjectsForTests();
});

function Hub({ active = true }: { active?: boolean }) {
  useProjectsPoll(HUB_REFRESH_MS, active);
  return null;
}

describe("useProjectsPoll", () => {
  it("hub cadence is 15 s; the sidebar stays at 60 s", () => {
    expect(HUB_REFRESH_MS).toBe(15_000);
    expect(PROJECTS_REFRESH_MS).toBe(60_000);
  });
  it("re-fetches /api/containers every 15 s while mounted, and stops on unmount", async () => {
    const r = render(<Hub />);
    expect(calls).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(calls).toBe(2);
    r.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(calls).toBe(2);
  });
  it("inactive → no polling", async () => {
    render(<Hub active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(calls).toBe(0);
  });
});
