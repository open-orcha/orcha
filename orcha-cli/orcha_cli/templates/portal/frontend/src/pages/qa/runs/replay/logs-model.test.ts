import { describe, expect, it } from "vitest";
import type { RunLog } from "../types";
import {
  detailSuffix,
  errorCount,
  errorCountsByStep,
  filterLogs,
  initialLogFilters,
  logsInStepRange,
  mergeLogs,
  orderLogs,
  logTimeMs,
} from "./logs-model";

// `actionRangeToStepSeqRange` lives in `./model`, which pulls in a runtime `@/lib/common/format`
// import that this project's vitest config (no path-alias plugin; `@/` is erased only in
// type-only imports elsewhere) can't resolve — so its own action-number -> steps.seq mapping
// is inlined here rather than imported, to keep this suite import-light. The correlation
// logic itself (matching a finding's step range against `run_logs.step_seq`) is what
// `logsInStepRange` below actually exercises.
function actionRangeToStepSeqRange(
  actionSeqs: readonly number[],
  from: number | null | undefined,
  to: number | null | undefined,
): [number, number] | null {
  if (from == null && to == null) return null;
  const a = actionSeqs[(from ?? to ?? 1) - 1];
  const b = actionSeqs[(to ?? from ?? 1) - 1];
  if (a == null || b == null) return null;
  return a <= b ? [a, b] : [b, a];
}

function log(overrides: Partial<RunLog>): RunLog {
  return {
    seq: 1,
    step_seq: null,
    at_ms: 0,
    source: "console",
    level: "error",
    text: "boom",
    detail: null,
    ...overrides,
  };
}

describe("filterLogs", () => {
  it("filters by level, source and text", () => {
    const logs = [
      log({ seq: 1, level: "error", source: "console", text: "TypeError" }),
      log({ seq: 2, level: "warn", source: "network", text: "slow request" }),
      log({ seq: 3, level: "error", source: "network", text: "500 on /api/orders" }),
    ];
    expect(filterLogs(logs, { level: "error", source: "", query: "" }).map((l) => l.seq)).toEqual([1, 3]);
    expect(filterLogs(logs, { level: "", source: "network", query: "" }).map((l) => l.seq)).toEqual([2, 3]);
    expect(filterLogs(logs, { level: "", source: "", query: "orders" }).map((l) => l.seq)).toEqual([3]);
    expect(filterLogs(logs, { level: "", source: "", query: "TYPEERROR" }).map((l) => l.seq)).toEqual([1]);
  });

  it("combines level, source and search, and ignores a blank search", () => {
    const logs = [
      log({ seq: 1, level: "error", source: "console", text: "TypeError" }),
      log({ seq: 2, level: "warn", source: "network", text: "slow request" }),
      log({ seq: 3, level: "error", source: "network", text: "500 on /api/orders" }),
      log({ seq: 4, level: "error", source: "device", text: "orders view crashed" }),
    ];
    expect(filterLogs(logs, { level: "error", source: "network", query: "" }).map((l) => l.seq)).toEqual([3]);
    expect(filterLogs(logs, { level: "error", source: "", query: "orders" }).map((l) => l.seq)).toEqual([3, 4]);
    expect(filterLogs(logs, { level: "", source: "", query: "   " }).map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(filterLogs(logs, { level: "debug", source: "", query: "" })).toEqual([]);
  });
});

describe("live tail helpers", () => {
  const logs = [log({ seq: 1, level: "info" }), log({ seq: 3, level: "error" }), log({ seq: 2, level: "warn" })];

  it("opens on errors for a finished run and on everything while live", () => {
    expect(initialLogFilters(logs, false).level).toBe("error");
    expect(initialLogFilters(logs, true).level).toBe("");
    expect(initialLogFilters([log({ level: "info" })], false).level).toBe("");
  });

  it("orders oldest first while live and newest first after", () => {
    expect(orderLogs(logs, true).map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(orderLogs(logs, false).map((l) => l.seq)).toEqual([3, 2, 1]);
  });

  it("merges streamed rows by seq, newer copy winning", () => {
    const base = [log({ seq: 1, text: "a" }), log({ seq: 2, text: "b" })];
    expect(mergeLogs(base, [])).toBe(base);
    const merged = mergeLogs(base, [log({ seq: 3, text: "c" }), log({ seq: 2, text: "b2" })]);
    expect(merged.map((l) => `${l.seq}${l.text}`)).toEqual(["1a", "2b2", "3c"]);
  });
});

describe("errorCount / errorCountsByStep", () => {
  it("counts only error-level entries, keyed by step_seq", () => {
    const logs = [
      log({ seq: 1, level: "error", step_seq: 5 }),
      log({ seq: 2, level: "error", step_seq: 5 }),
      log({ seq: 3, level: "warn", step_seq: 5 }),
      log({ seq: 4, level: "error", step_seq: 7 }),
      log({ seq: 5, level: "error", step_seq: null }),
    ];
    expect(errorCount(logs)).toBe(4);
    const byStep = errorCountsByStep(logs);
    expect(byStep.get(5)).toBe(2);
    expect(byStep.get(7)).toBe(1);
    expect(byStep.has(undefined as unknown as number)).toBe(false);
  });
});

describe("detailSuffix", () => {
  it("renders a status and a dedupe count", () => {
    expect(detailSuffix(log({ detail: { status: 500 } }))).toBe(" · 500");
    expect(detailSuffix(log({ detail: { count: 12 } }))).toBe(" · ×12");
    expect(detailSuffix(log({ detail: { status: 500, count: 3 } }))).toBe(" · 500 · ×3");
    expect(detailSuffix(log({ detail: null }))).toBe("");
    expect(detailSuffix(log({ detail: { count: 1 } }))).toBe("");
  });
});

describe("logsInStepRange", () => {
  it("keeps only logs whose step_seq falls in [from, to]", () => {
    const logs = [
      log({ seq: 1, step_seq: 2 }),
      log({ seq: 2, step_seq: 4 }),
      log({ seq: 3, step_seq: 6 }),
      log({ seq: 4, step_seq: null }),
    ];
    expect(logsInStepRange(logs, 3, 5).map((l) => l.seq)).toEqual([2]);
    expect(logsInStepRange(logs, null, null)).toEqual([]);
  });
});

describe("actionRangeToStepSeqRange (correlation: findings use action numbers, logs use raw seq)", () => {
  it("maps an action-number range to the raw steps.seq range", () => {
    // actionSeqs[i] is the raw steps.seq of the (i+1)-th action (screen steps excluded).
    const actionSeqs = [2, 4, 6, 9, 11];
    expect(actionRangeToStepSeqRange(actionSeqs, 2, 4)).toEqual([4, 9]);
    expect(actionRangeToStepSeqRange(actionSeqs, 3, 3)).toEqual([6, 6]);
    expect(actionRangeToStepSeqRange(actionSeqs, null, null)).toBeNull();
  });

  it("composes with logsInStepRange to find a finding's correlated logs", () => {
    const actionSeqs = [2, 4, 6, 9, 11];
    const logs = [
      log({ seq: 1, step_seq: 4 }),
      log({ seq: 2, step_seq: 6 }),
      log({ seq: 3, step_seq: 11 }), // outside the finding's range
    ];
    const range = actionRangeToStepSeqRange(actionSeqs, 2, 3); // -> steps.seq [4, 6]
    expect(range).toEqual([4, 6]);
    const correlated = range ? logsInStepRange(logs, range[0], range[1]) : [];
    expect(correlated.map((l) => l.seq)).toEqual([1, 2]);
  });
});

describe("logTimeMs (#171)", () => {
  const steps = new Map([[3, 21_000], [4, 0]]);
  it("uses the row's own offset from session start", () => {
    expect(logTimeMs(log({ at_ms: 20_950, step_seq: 3 }), steps)).toBe(20_950);
  });
  it("falls back to its step's time for a row written with 0", () => {
    expect(logTimeMs(log({ at_ms: 0, step_seq: 3 }), steps)).toBe(21_000);
  });
  it("is unknown rather than a false 0:00", () => {
    expect(logTimeMs(log({ at_ms: 0, step_seq: null }), steps)).toBeNull();
    expect(logTimeMs(log({ at_ms: 0, step_seq: 4 }), steps)).toBeNull();
  });
});
