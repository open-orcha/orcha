import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveDevices, type LiveDevices } from "./use-live-devices";

const seen: { now: LiveDevices | null } = { now: null };
function Probe({ active }: { active: boolean }) {
  seen.now = useLiveDevices("c1", active);
  return null;
}

const iphone = { kind: "ios", name: "iPhone 17 Pro", udid: "A", state: "booted" };
const ipad = { kind: "ios", name: "iPad Pro 13-inch (M5)", udid: "B", state: "booted" };
let answer: () => Response;
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
const names = () => seen.now?.devices.map((o) => (o.device as { name: string }).name) ?? [];
const WEB = ["Desktop browser (1280×800)", "Mobile browser (390×844)"];

beforeEach(() => {
  vi.useFakeTimers();
  global.fetch = vi.fn(async () => answer()) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the wizard's devices stay current (#454)", () => {
  it("a simulator booted while the page is open shows up", async () => {
    answer = () => json({ devices: [iphone], available: true });
    render(<Probe active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(names()).toEqual(["iPhone 17 Pro", ...WEB]);
    answer = () => json({ devices: [iphone, ipad], available: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(names()).toEqual(["iPhone 17 Pro", "iPad Pro 13-inch (M5)", ...WEB]);
  });

  it("reads once when the picker cannot show", async () => {
    answer = () => json({ devices: [], available: true });
    render(<Probe active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("a failed read keeps the list", async () => {
    answer = () => json({ devices: [iphone], available: true });
    render(<Probe active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    answer = () => json({ detail: "no" }, 500);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(names()).toEqual(["iPhone 17 Pro", ...WEB]);
    expect(seen.now?.available).toBe(true);
  });

  it("a portal that cannot see the machine says so, and the browser sizes stay", async () => {
    answer = () => json({ devices: [], available: false });
    render(<Probe active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(seen.now?.available).toBe(false);
    expect(names()).toEqual(WEB);
  });
});
