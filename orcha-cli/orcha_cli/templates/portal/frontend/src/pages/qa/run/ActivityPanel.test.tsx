/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QaAuthority } from "../authority";
import { PortRoot } from "../map/kit";
import { ActivityPanel } from "./ActivityPanel";
import type { RunLogEntry, RunNow } from "./runLog";
import type { RunLog } from "./useRunLog";

const auth = { can: true, human: { id: "h1" }, reason: null } as unknown as QaAuthority;
const entry = (id: string, level: RunLogEntry["level"], text: string, detail?: string): RunLogEntry => ({ id, at: "2026-11-05T10:00:00Z", level, kind: "x", text, detail });
const log = (o: Partial<RunLog> = {}): RunLog => ({ entries: [], now: null, live: true, truncated: false, sessionId: null, platform: null, lastOkAt: Date.now(), refresh: vi.fn(), ...o });
const waiting: RunNow = { state: "waiting", level: "wait", text: "Waiting for iPhone 17 Pro · held by another tool", since: "2026-11-05T10:00:00Z", session_id: "s1", device: "iPhone 17 Pro", free_device: "iPad Pro 13-inch (M5)" };
const show = (l: RunLog, a = auth) => render(<PortRoot refresh={() => undefined}><ActivityPanel log={l} auth={a} /></PortRoot>);

describe("ActivityPanel", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("tells wait, warn and error lines apart, each with its time", () => {
    const { container } = show(log({ entries: [entry("a", "info", "Picked up"), entry("b", "wait", "Waiting", "Held by Xcode"), entry("c", "warn", "Slow"), entry("d", "error", "Failed")] }));
    expect([...container.querySelectorAll("[data-level]")].slice(1).map((e) => e.getAttribute("data-level"))).toEqual(["info", "wait", "warn", "error"]);
    expect(container.querySelectorAll("time")).toHaveLength(4);
    expect(screen.getByText("Held by Xcode")).toBeTruthy();
    expect(screen.getByLabelText("Error")).toBeTruthy();
  });

  it("offers the free device and Cancel on a held device, and acts on them", async () => {
    const l = log({ now: waiting });
    show(l);
    expect(screen.getByRole("status").textContent).toContain("Waiting for iPhone 17 Pro · held by another tool ·");
    fireEvent.click(screen.getByText("Use iPad Pro"));
    await waitFor(() => expect(l.refresh).toHaveBeenCalled());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/qa/sessions/s1/use-device");
    expect(JSON.parse(init.body)).toEqual({ device: "iPad Pro 13-inch (M5)", actor_agent_id: "h1" });
    fireEvent.click(document.querySelector("[data-run-cancel]") as HTMLElement);
    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2));
    expect(JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1].body).status).toBe("cancelled");
  });

  it("offers nothing to someone who cannot act, or when nothing is free but Cancel", () => {
    show(log({ now: waiting }), { ...auth, can: false } as QaAuthority);
    expect(document.querySelector("[data-run-cancel]")).toBeNull();
    cleanup();
    show(log({ now: { ...waiting, free_device: undefined } }));
    expect(screen.queryByText(/^Use /)).toBeNull();
    expect(document.querySelector("[data-run-cancel]")).toBeTruthy();
  });

  it("follows new lines until the person scrolls up, then counts them", () => {
    const first = [entry("a", "info", "One")];
    const { container, rerender } = show(log({ entries: first }));
    const box = container.querySelector("[data-activity-lines]") as HTMLElement;
    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(box, "clientHeight", { configurable: true, value: 200 });
    const next = log({ entries: [...first, entry("b", "info", "Two")] });
    rerender(<PortRoot refresh={() => undefined}><ActivityPanel log={next} auth={auth} /></PortRoot>);
    expect(box.scrollTop).toBe(1000);
    box.scrollTop = 100;
    act(() => { fireEvent.scroll(box); });
    const later = log({ entries: [...next.entries, entry("c", "info", "Three")] });
    rerender(<PortRoot refresh={() => undefined}><ActivityPanel log={later} auth={auth} /></PortRoot>);
    expect(box.scrollTop).toBe(100);
    fireEvent.click(screen.getByText("1 new line"));
    expect(box.scrollTop).toBe(1000);
  });

  it("is never empty: before the first read it says what is known, and slow is said calmly", () => {
    show(log({ lastOkAt: null }));
    expect(screen.getAllByText(/Reading what this run is doing/).length).toBeGreaterThan(0);
    cleanup();
    show(log({ lastOkAt: Date.now() - 60_000 }));
    expect(screen.getByText(/Embodent is slow to answer · last update 1:00 ago/)).toBeTruthy();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });
});
