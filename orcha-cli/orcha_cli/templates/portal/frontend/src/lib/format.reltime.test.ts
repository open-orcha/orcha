import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadlineLabel, relTime } from "./format";

const NOW = Date.parse("2026-09-28T10:00:00Z");
const at = (secs: number) => new Date(NOW + secs * 1000).toISOString();

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe("relTime — past and future", () => {
  it("formats the past as before", () => {
    expect(relTime(at(-2))).toBe("just now");
    expect(relTime(at(-30))).toBe("30s ago");
    expect(relTime(at(-5 * 60))).toBe("5m ago");
    expect(relTime(at(-3 * 3600))).toBe("3h ago");
    expect(relTime(at(-2 * 86400))).toBe("2d ago");
  });
  it("formats the future as 'in …' (never 'just now' for a later expiry)", () => {
    expect(relTime(at(30 * 60))).toBe("in 30m");
    expect(relTime(at(2 * 3600 + 5))).toBe("in 2h");
    expect(relTime(at(3 * 86400))).toBe("in 3d");
  });
  it("invalid input renders a dash, never NaN", () => {
    expect(relTime("not a date")).toBe("—");
    expect(relTime(undefined)).toBe("—");
  });
});

describe("deadlineLabel", () => {
  it("future deadlines are not overdue", () => {
    expect(deadlineLabel(at(30 * 60))).toEqual({ text: "in 30m", overdue: false });
  });
  it("past deadlines read as overdue", () => {
    expect(deadlineLabel(at(-2 * 3600))).toEqual({ text: "overdue by 2h", overdue: true });
    expect(deadlineLabel(at(-1))).toEqual({ text: "expired just now", overdue: true });
  });
  it("no deadline → null", () => {
    expect(deadlineLabel(null)).toBeNull();
    expect(deadlineLabel("garbage")).toBeNull();
  });
});
