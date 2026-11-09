import { describe, expect, it } from "vitest";
import type { PrepEvent } from "./theater-model";
import type { Step } from "../types";
import type { CharterItem } from "../../sessions/explorations";
import {
  budgetShare,
  elapsedAgainstBudget,
  groupTimeline,
  initialTheaterTab,
  macroPhaseOf,
  macroPhases,
  resolveTab,
  tailJump,
  tailOnScroll,
  tailStart,
  tailUnseen,
} from "./theater-model";

function step(seq: number, kind: Step["kind"] = "tap"): Step {
  return { seq, at_ms: seq * 1000, kind, args: {}, result: null, screen_hash: null, foreground: null, frame_path: null };
}

function ev(phase: string, status: PrepEvent["status"], message = ""): PrepEvent {
  return { ts: "2026-10-16T10:00:00Z", phase, status, message } as PrepEvent;
}

describe("tab selection", () => {
  it("opens the pane on Overview and the page on the run's default", () => {
    expect(initialTheaterTab({ variant: "pane", defaultTab: "scenarios" })).toBe("overview");
    expect(initialTheaterTab({ variant: "page", defaultTab: "scenarios" })).toBe("scenarios");
    expect(initialTheaterTab({ variant: "page", defaultTab: "steps" })).toBe("steps");
  });

  it("opens a live run on Steps, page or pane, unless ?tab= says otherwise", () => {
    expect(initialTheaterTab({ variant: "page", defaultTab: "scenarios", live: true })).toBe("steps");
    expect(initialTheaterTab({ variant: "pane", defaultTab: "scenarios", live: true })).toBe("steps");
    expect(initialTheaterTab({ variant: "page", tabParam: "scenarios", defaultTab: "scenarios", live: true })).toBe("scenarios");
  });

  it("lets ?tab= win and sends ?step= to Steps", () => {
    expect(initialTheaterTab({ variant: "page", tabParam: "logs", stepParam: 4, defaultTab: "scenarios" })).toBe("logs");
    expect(initialTheaterTab({ variant: "page", stepParam: 4, defaultTab: "scenarios" })).toBe("steps");
    expect(initialTheaterTab({ variant: "pane", stepParam: 0, defaultTab: "scenarios" })).toBe("steps");
    expect(initialTheaterTab({ variant: "page", tabParam: "nope", defaultTab: "steps" })).toBe("steps");
  });

  it("falls back to Overview when the asked tab is not offered", () => {
    expect(resolveTab("map", ["overview", "steps"])).toBe("overview");
    expect(resolveTab("steps", ["overview", "steps"])).toBe("steps");
    expect(resolveTab("video", ["steps", "logs"])).toBe("steps");
  });
});

describe("running phases", () => {
  it("maps worker phases onto the five", () => {
    expect(macroPhaseOf(ev("waiting_device", "running"))).toBe("claimed");
    expect(macroPhaseOf(ev("install", "running"))).toBe("prepare");
    expect(macroPhaseOf(ev("steps", "running"))).toBe("testing");
    expect(macroPhaseOf(ev("finishing", "running", "Judging criteria and writing the report"))).toBe("judging");
    expect(macroPhaseOf(ev("finishing", "running", "Report written; syncing results, evidence and video"))).toBe("syncing");
  });

  it("marks earlier phases done and the latest running", () => {
    const rows = macroPhases([ev("claimed", "done"), ev("device", "done"), ev("steps", "running", "Step 4")], {
      live: true,
      hasSteps: true,
      finished: false,
    });
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "running", "pending", "pending"]);
    expect(rows[2].message).toBe("Step 4");
  });

  it("shows a failed phase as failed", () => {
    const rows = macroPhases([ev("claimed", "done"), ev("build", "failed", "Build failed")], { live: false, hasSteps: false, finished: true });
    expect(rows[1].status).toBe("failed");
  });

  it("infers testing from steps when the worker wrote no timeline", () => {
    const rows = macroPhases([], { live: true, hasSteps: true, finished: false });
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "running", "pending", "pending"]);
    expect(macroPhases([], { live: true, hasSteps: false, finished: false })[0].status).toBe("running");
  });

  it("formats elapsed against the budget", () => {
    expect(elapsedAgainstBudget(252_000, 10)).toBe("4:12 of 10 min");
    expect(elapsedAgainstBudget(5_000, null)).toBe("0:05");
    expect(elapsedAgainstBudget(null, 10)).toBeNull();
    expect(budgetShare(300_000, 10)).toBe(0.5);
    expect(budgetShare(900_000, 10)).toBe(1);
    expect(budgetShare(1000, null)).toBeNull();
  });
});

describe("timeline grouping", () => {
  // Steps 1..8, screens at odd seqs: actions are 2, 4, 6, 8 (action numbers 1..4).
  const steps = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => step(n, n % 2 ? "screen" : "tap"));
  const actionSeqs = [2, 4, 6, 8];

  it("groups a scenario run by criterion window, the scenario heading its first group", () => {
    const groups = groupTimeline({
      steps,
      actionSeqs,
      scenarios: [
        {
          scenario_id: "s1",
          name: "Sign in",
          outcome: "fail",
          criteria: [
            { text: "Form shows", outcome: "pass", from_step: 1, to_step: 2 },
            { text: "Welcome shows", outcome: "fail", from_step: 3, to_step: 4 },
          ],
        },
      ],
    })!;
    expect(groups.map((g) => [g.title, g.subtitle, g.steps.map((s) => s.seq)])).toEqual([
      ["Getting ready", null, [1]],
      ["Sign in", "Form shows", [2, 3, 4, 5]],
      ["Sign in", "Welcome shows", [6, 7, 8]],
    ]);
    expect(groups.map((g) => g.leads)).toEqual([true, true, false]);
    expect(groups[2].outcome).toBe("fail");
  });

  it("groups an exploration by charter mission", () => {
    const charter = [
      { id: "m2", title: "Checkout", why: "", lens: "works", status: "covered", step_seq: 5 },
      { id: "m1", title: "Browse", why: "", lens: "works", status: "bug", step_seq: 2 },
      { id: "m3", title: "Never reached", why: "", lens: "works", status: "planned" },
    ] as CharterItem[];
    const groups = groupTimeline({ steps, actionSeqs, charter })!;
    expect(groups.map((g) => [g.title, g.steps.length, g.outcome])).toEqual([
      ["Getting ready", 1, null],
      ["Browse", 3, "bug"],
      ["Checkout", 4, "covered"],
    ]);
  });

  it("is null when there is nothing to group by", () => {
    expect(groupTimeline({ steps, actionSeqs })).toBeNull();
    expect(groupTimeline({ steps: [], actionSeqs: [], scenarios: [] })).toBeNull();
    expect(groupTimeline({ steps, actionSeqs, scenarios: [{ scenario_id: "s", name: "S", outcome: null, criteria: [{ text: "x" }] }] })).toBeNull();
  });
});

describe("live tail", () => {
  it("follows until the reader scrolls up, then counts new lines", () => {
    let s = tailStart(10);
    expect(tailUnseen(s, 13)).toBe(0);
    s = tailOnScroll(s, false, 13);
    expect(s.following).toBe(false);
    expect(tailUnseen(s, 13)).toBe(0);
    expect(tailUnseen(s, 16)).toBe(3);
    // Scrolling while paused stays paused and keeps the count.
    expect(tailOnScroll(s, false, 16)).toBe(s);
  });

  it("resumes at the bottom or on Jump to latest", () => {
    const paused = { following: false, seenCount: 4 };
    expect(tailOnScroll(paused, true, 9)).toEqual({ following: true, seenCount: 9 });
    expect(tailUnseen(tailJump(9), 12)).toBe(0);
    const following = tailStart(3);
    expect(tailOnScroll(following, true, 5)).toBe(following);
  });
});

describe("logTail", () => {
  it("shows the app's own logs when it logged any, newest three, oldest first", async () => {
    const { logTail } = await import("./theater-model");
    const app = [4, 1, 3, 2].map((seq) => ({ seq, source: "console", text: `line ${seq}`, level: seq === 4 ? "error" : "info" }));
    expect(logTail(app, [{ ts: "t", src: "agent", text: "Step 1 · tap" }]).map((l) => l.text)).toEqual(["line 2", "line 3", "line 4"]);
    expect(logTail(app, []).at(-1)?.level).toBe("error");
  });

  it("falls back to the run's own log when the app logged nothing (a crawl on an app with no console)", async () => {
    const { logTail } = await import("./theater-model");
    const run = [181, 182, 183, 184].map((n) => ({ ts: `11:45:${n - 170}`, src: "agent", text: `Step ${n} · tap` }));
    const tail = logTail([], run);
    expect(tail.map((l) => l.text)).toEqual(["Step 182 · tap", "Step 183 · tap", "Step 184 · tap"]);
    expect(tail[0].label).toBe("agent");
    expect(new Set(tail.map((l) => l.key)).size).toBe(3);
    expect(logTail([], [])).toEqual([]);
  });
});
