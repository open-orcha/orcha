import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLiveRun } from "./use-live-run";

describe("useLiveRun", () => {
  it("is live while the polled status runs and marks activity when rows grow", () => {
    const { result, rerender } = renderHook(({ status, n }) => useLiveRun(status, n), { initialProps: { status: "running" as const as "running" | "completed", n: 1 } });
    expect(result.current.isLive).toBe(true);
    const before = result.current.lastActivityAt;
    act(() => rerender({ status: "running", n: 1 }));
    expect(result.current.lastActivityAt).toBe(before);
    act(() => rerender({ status: "completed", n: 2 }));
    expect(result.current.isLive).toBe(false);
  });
});
