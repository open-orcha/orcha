/* @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURES_TO_SHOW, usePolled } from "./use-polled";

const POLL = 2_500;
const after = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("usePolled", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("a server slower than the poll still lands: the read in flight is never restarted", async () => {
    let n = 0;
    const load = vi.fn(async () => {
      const mine = ++n;
      await new Promise((r) => setTimeout(r, 12_000));
      return { steps: mine * 10, running: mine < 3 };
    });
    const { result } = renderHook(() => usePolled(load, "s1", 0, POLL, (d) => d.running));
    await after(0);
    expect(load).toHaveBeenCalledTimes(1);
    await after(11_000);
    expect(load).toHaveBeenCalledTimes(1); // the timer of old started a new read every 2.5 s, aborting this one
    await after(1_000);
    expect(result.current.data?.steps).toBe(10);
    await after(40_000);
    expect(result.current.data).toEqual({ steps: 30, running: false }); // it reached the end of the run
    expect(load).toHaveBeenCalledTimes(3); // and stopped there
  });

  it("recovers from failures under load, and keeps what is on screen", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ steps: 2, running: true })
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ steps: 54, running: false });
    const { result } = renderHook(() => usePolled(load, "s1", 0, POLL, (d: { running: boolean }) => d.running));
    await after(0);
    await after(POLL);
    expect(result.current.data).toEqual({ steps: 2, running: true });
    expect(result.current.error).toBeNull();
    await after(30_000);
    expect(result.current.data).toEqual({ steps: 54, running: false });
  });

  it("a hidden tab keeps reading, and coming back reads at once", async () => {
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const load = vi.fn(async () => ({ running: true }));
    renderHook(() => usePolled(load, "s1", 0, POLL, (d) => d.running));
    await after(0);
    await after(POLL);
    const seen = load.mock.calls.length;
    expect(seen).toBeLessThanOrEqual(2);
    hidden.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(load.mock.calls.length).toBeGreaterThan(seen);
    hidden.mockRestore();
  });

  it("an error shows only when it repeats, and a refusal at once and for good", async () => {
    const load = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePolled(load, "a", 0, POLL, () => true));
    await after(0);
    expect(result.current.error).toBeNull();
    await after(4_000 * FAILURES_TO_SHOW);
    expect(result.current.error).toBe("boom");
    cleanup();
    const refused = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
    const second = renderHook(() => usePolled(refused, "b", 0, POLL, () => true));
    await after(0);
    expect(second.result.current.status).toBe(404);
    await after(30_000);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("a new nonce reads again after the run ended, and a new key starts clean", async () => {
    const load = vi.fn(async () => ({ running: false }));
    const { result, rerender } = renderHook(({ k, n }) => usePolled(load, k, n, POLL, (d) => d.running), { initialProps: { k: "a", n: 0 } });
    await after(0);
    expect(load).toHaveBeenCalledTimes(1);
    rerender({ k: "a", n: 1 });
    await after(0);
    expect(load).toHaveBeenCalledTimes(2);
    rerender({ k: "b", n: 1 });
    expect(result.current.data).toBeNull();
  });
});
