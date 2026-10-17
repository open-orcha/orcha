import { describe, expect, it } from "vitest";
import { fmtDuration, matchesState, mergeRuns, parseStateFilter, runDuration, runElapsed, runOutcome, wakeLabel, type WorkerRun } from "./runModel";
import { filterEvents, projectEvents } from "./events";
import type { OrchaRequest, Task } from "../../types";

const run = (o: Partial<WorkerRun>): WorkerRun => ({ run_id: "r", status: "exited", ...o }) as WorkerRun;

describe("runOutcome — exact statuses, never merged", () => {
  it("running is its own bucket", () => {
    expect(runOutcome(run({ status: "running" }))).toMatchObject({ bucket: "running", label: "Running" });
  });
  it("a clean exit is 'finished' but labelled Exited (not completed / verified)", () => {
    const o = runOutcome(run({ status: "exited", exit_code: 0 }));
    expect(o).toMatchObject({ bucket: "finished", label: "Exited · exit 0", reason: null });
    expect(o.label).not.toMatch(/complete|verified/i);
  });
  it("a non-zero exit is a failure with the exit code as the reason", () => {
    expect(runOutcome(run({ status: "exited", exit_code: 2 }))).toMatchObject({ bucket: "failed", label: "Exited · exit 2", reason: "non-zero exit code 2" });
  });
  it("a human stop is 'Stopped' (cancelled glyph), a watchdog kill is 'Killed' with its cause", () => {
    const stop = runOutcome(run({ status: "killed", kill_reason: JSON.stringify({ cause: "human_stop" }) }));
    expect(stop).toMatchObject({ label: "Stopped", dot: "cancelled", reason: "stopped by a human" });
    const wd = runOutcome(run({ status: "killed", kill_reason: JSON.stringify({ cause: "stalled" }) }));
    expect(wd).toMatchObject({ label: "Killed", dot: "failed", reason: "watchdog: stalled (no output)" });
    expect(runOutcome(run({ status: "killed", kill_reason: "not json" })).reason).toBe("killed (no reason recorded)");
  });
  it("rate_limited / orphaned / failed keep distinct labels; unknown statuses are shown verbatim, never as success", () => {
    expect(runOutcome(run({ status: "rate_limited" })).label).toBe("Rate limited");
    expect(runOutcome(run({ status: "orphaned" })).label).toBe("Orphaned");
    expect(runOutcome(run({ status: "failed", exit_code: 1 }))).toMatchObject({ label: "Failed", reason: "exit 1" });
    expect(runOutcome(run({ status: "frobnicated" }))).toMatchObject({ bucket: "failed", label: "frobnicated" });
  });
  it("state filters map onto the buckets; unknown filter values fall back to all", () => {
    expect(matchesState(run({ status: "running" }), "running")).toBe(true);
    expect(matchesState(run({ status: "exited", exit_code: 0 }), "failed")).toBe(false);
    expect(matchesState(run({ status: "killed" }), "failed")).toBe(true);
    expect(parseStateFilter("bogus")).toBe("all");
    expect(parseStateFilter("finished")).toBe("finished");
  });
});

describe("durations and labels", () => {
  it("formats durations; unknown is null, not 0", () => {
    expect(fmtDuration(42_000)).toBe("42s");
    expect(fmtDuration(190_000)).toBe("3m 10s");
    expect(fmtDuration(3_900_000)).toBe("1h 5m");
    expect(fmtDuration(null)).toBeNull();
    expect(fmtDuration(-5)).toBeNull();
  });
  it("runDuration uses ended − started, or now − started while running; finished without an end is unknown", () => {
    const s = "2026-09-28T10:00:00Z";
    expect(runDuration(run({ started_at: s, ended_at: "2026-09-28T10:02:00Z" }), 0)).toBe("2m");
    expect(runDuration(run({ status: "running", started_at: s }), Date.parse(s) + 30_000)).toBe("30s");
    expect(runDuration(run({ status: "exited", started_at: s, ended_at: null }), Date.now())).toBeNull();
  });
  it("wakeLabel humanizes the wake event verbatim", () => {
    expect(wakeLabel(run({ wake_event: "request_answered" }))).toBe("Request answered");
    expect(wakeLabel(run({ wake_kind: "tmux" }))).toBe("live tab");
  });
  it("mergeRuns de-duplicates by run id and sorts newest first", () => {
    const a = run({ run_id: "a", started_at: "2026-09-28T10:00:00Z" });
    const b = run({ run_id: "b", started_at: "2026-09-28T11:00:00Z" });
    expect(mergeRuns([[a, b], [a]]).map((r) => r.run_id)).toEqual(["b", "a"]);
  });
});

describe("project events (snapshot-derived, never fabricated)", () => {
  const tasks = [
    { id: "t1", title: "Fix login", message_summary: { count: 1, last: { body: "done?", author_alias: "forge", at: "2026-09-28T10:00:00Z", is_human: false } }, thread: [] },
    { id: "t2", title: "No msgs", message_summary: { count: 0, last: null }, thread: [] },
  ] as unknown as Task[];
  const requests = [
    { id: "r1", type: "question", from: "scout", to: "forge", payload: "which db?", response: "postgres", created_at: "2026-09-28T09:00:00Z", responded_at: "2026-09-28T11:00:00Z", task_link: { task_id: "t1" } },
  ] as unknown as OrchaRequest[];
  it("emits task last-messages and request create/answer rows, newest first, with exact links", () => {
    const ev = projectEvents(tasks, requests);
    expect(ev.map((e) => e.kind)).toEqual(["answer", "message", "request"]);
    expect(ev[1].href).toBe("/tasks?task=t1");
    expect(ev[0].href).toBe("/requests?req=r1");
  });
  it("filters by agent alias and by task", () => {
    const ev = projectEvents(tasks, requests);
    expect(filterEvents(ev, "scout", null).map((e) => e.kind)).toEqual(["request"]);
    expect(filterEvents(ev, null, "t1")).toHaveLength(3);
    expect(filterEvents(ev, null, "t2")).toHaveLength(0);
  });
});

import { rawStatusDiffers, reasonTone } from "./runModel";
import { payloadLine as payloadTitle } from "./events";

describe("run presentation helpers", () => {
  it("tones a human stop as muted, a rate limit as warn, real failures as danger", () => {
    expect(reasonTone({ status: "killed", kill_reason: JSON.stringify({ cause: "human_stop" }) })).toBe("muted");
    expect(reasonTone({ status: "rate_limited", kill_reason: null })).toBe("warn");
    expect(reasonTone({ status: "killed", kill_reason: JSON.stringify({ cause: "stalled" }) })).toBe("danger");
  });
  it("hides the raw status only when the label already says it", () => {
    expect(rawStatusDiffers({ status: "running", exit_code: null, kill_reason: null })).toBe(false);
    expect(rawStatusDiffers({ status: "rate_limited", exit_code: null, kill_reason: null })).toBe(false);
    expect(rawStatusDiffers({ status: "exited", exit_code: 0, kill_reason: null })).toBe(false);
    expect(rawStatusDiffers({ status: "killed", exit_code: null, kill_reason: JSON.stringify({ cause: "human_stop" }) })).toBe(true);
  });
});

describe("payloadLine (events)", () => {
  it("never returns JSON or [object Object]", () => {
    expect(payloadTitle({ question: "Ship?" })).toBe("Ship?");
    expect(payloadTitle({ summary: "API shape", x: { y: 1 } })).toBe("API shape");
    expect(payloadTitle('{"title":"From string"}')).toBe("From string");
    expect(payloadTitle({ count: 2, ok: true, nested: { a: 1 } })).toBe("count: 2 · ok: true");
    expect(payloadTitle(null)).toBe("");
  });
});

describe("runElapsed (running rows' single time fact)", () => {
  const start = "2026-09-28T10:00:00Z";
  const t = (m: number) => Date.parse(start) + m * 60000;
  it("is coarse live elapsed for running runs only", () => {
    expect(runElapsed({ status: "running", started_at: start } as never, t(0.5))).toBe("<1m");
    expect(runElapsed({ status: "running", started_at: start } as never, t(8.7))).toBe("8m");
    expect(runElapsed({ status: "running", started_at: start } as never, t(72))).toBe("1h 12m");
    expect(runElapsed({ status: "exited", started_at: start } as never, t(8))).toBeNull();
    expect(runElapsed({ status: "running" } as never, t(8))).toBeNull();
  });
});
