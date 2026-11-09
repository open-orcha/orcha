import { describe, expect, it } from "vitest";
import { callsOfAction, runPerfOf, timingsOf, type RunPerfRead } from "./api";

const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 10, 0, s)).toISOString();
const sample = (run: string, value: number, metric = "settle") => ({ run_id: run, screen_key: "Home", screen_label: "Home", platform: "web", device: "desktop", device_class: "desktop", metric, value, step_seq: 1, noise: null, created_at: at(10) });
const read = (over: Partial<RunPerfRead> = {}): RunPerfRead => ({
  session: { status: "done", platform: "web", device_name: "desktop", started_at: at(0) },
  samples: [sample("s1", 3000)] as RunPerfRead["samples"],
  history: [sample("a", 400), sample("b", 500), sample("c", 600)] as RunPerfRead["history"],
  frames: { Home: "/api/qa/frames/f1" },
  steps: [
    { seq: 1, kind: "tap", duration_ms: 2000, timing: { appear_ms: 3000, settle_ms: 2000, settled: "changed" }, screen_key: null, at: at(4) },
    { seq: 2, kind: "screen", duration_ms: null, timing: null, screen_key: "Home", at: at(5) },
  ],
  requests: [{ at_ms: 2500, method: "GET", url: "https://a.test/x", status: 200, duration_ms: 900 }],
  settings: null,
  ...over,
});

describe("the run's timings", () => {
  it("times each action from when it was sent, with the screen it led to and its calls", () => {
    const [row] = timingsOf(read());
    expect(row).toMatchObject({ seq: 1, at_ms: 2000, appear_ms: 3000, settle_ms: 2000, screen: "Home" });
    expect(row.calls?.[0]).toMatchObject({ method: "GET", ms: 900, start_ms: 500 });
  });

  it("leaves a poll out of what an action waited on", () => {
    expect(callsOfAction([{ at_ms: 10, method: "GET", url: "/s", status: 200, duration_ms: 40000 }], 0, 100, 500)).toEqual([]);
  });

  it("compares a screen with its usual and says when it was slower, with its frame", () => {
    const doc = runPerfOf(read());
    expect(doc.state).toBe("done");
    expect(doc.screens[0].frame).toBe("/api/qa/frames/f1");
    expect(doc.screens[0].cells.settle?.baseline?.median).toBe(500);
    expect(doc.findings).toHaveLength(1);
    expect(doc.findings[0]).toMatchObject({ screen_key: "Home", reason: "regression" });
    expect(doc.screens[0].slowCalls[0].ms).toBe(900);
  });

  it("calls a finished run with no samples none, and shows a running one its actions", () => {
    expect(runPerfOf(read({ samples: [], steps: [], requests: [] })).state).toBe("none");
    const live = runPerfOf(read({ session: { ...read().session, status: "running" } }));
    expect(live.state).toBe("live");
    expect(live.live).toHaveLength(1);
  });
});
