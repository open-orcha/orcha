import { describe, expect, it } from "vitest";
import {
  countsLine,
  currentWalk,
  dataPairs,
  evidenceTally,
  finishedWalks,
  flowOutcomeNote,
  normalizeAppModel,
  parseFlowRow,
  parseWalkRow,
  personaName,
  queueCounts,
  queueOrder,
  railSteps,
  rankModelWorkflows,
  reasonChips,
  failedWalkWhy,
  flowPill,
  flowWalked,
  stoppedWalk,
  unwalkedCopy,
  unwalkedQueue,
  walkHeadline,
  walkPosition,
  type DraftingFlow,
  type FlowWalk,
} from "./workflows";

const flow = (over: Partial<DraftingFlow> = {}): DraftingFlow => ({
  id: "f1",
  session_id: "s",
  project_id: "p",
  flow_key: "log-a-bottle-feed",
  name: "Log a bottle feed",
  persona: "new-parent",
  criticality: "critical",
  steps: [{ text: "Open Today" }, { text: "Tap Add new entry" }, { text: "Choose Feeding" }, { text: "Pick Bottle, 120 ml" }, { text: "Save" }],
  data: { baby: "Zawadi", amount: "120 ml" },
  code_ref: null,
  source: "both",
  rank: 1,
  score: 75,
  rank_reasons: ["never walked", "critical"],
  status: "walking",
  target_kind: "ios",
  claimed_by: null,
  walk_id: "w1",
  created_at: "2026-10-27T20:00:00Z",
  updated_at: "2026-10-27T20:00:00Z",
  ...over,
});

const walk = (over: Partial<FlowWalk> = {}): FlowWalk =>
  parseWalkRow({
    id: "w1",
    session_id: "s",
    flow_id: "f1",
    project_id: "p",
    flow_key: "log-a-bottle-feed",
    status: "walking",
    steps: JSON.stringify([
      { index: 1, text: "Open Today", reached: true, result: "Today for Zawadi", checked: ["Add new entry shown"] },
      { index: 2, text: "Tap Add new entry", reached: true, result: "Add Entry sheet" },
    ]),
    finding_ids: "[]",
    data_used: "{}",
    started_at: "2026-10-27T20:01:00Z",
    finished_at: null,
    updated_at: "2026-10-27T20:02:00Z",
    ...over,
  });

describe("the walk in progress", () => {
  it("says which step is being walked: the first one not reported yet", () => {
    const w = walk();
    expect(walkPosition(flow(), w)).toEqual({ at: 3, total: 5 });
    expect(walkHeadline("Log a bottle feed", walkPosition(flow(), w))).toBe("Walking: Log a bottle feed, step 3 of 5");
  });

  it("lays out the rail: reported steps done or missed, one step now, the rest next", () => {
    const rail = railSteps(flow(), walk());
    expect(rail.map((s) => s.state)).toEqual(["done", "done", "now", "next", "next"]);
    expect(rail[0].report?.checked).toEqual(["Add new entry shown"]);
    const failed = railSteps(flow(), walk({ status: "failed", steps: [{ index: 1, text: "Open Today", reached: false }] as never }));
    expect(failed.map((s) => s.state)).toEqual(["missed", "next", "next", "next", "next"]);
  });

  it("keeps a step the explorer reported beyond the flow's own list", () => {
    const rail = railSteps(flow({ steps: [{ text: "Open Today" }] }), walk());
    expect(rail).toHaveLength(2);
    expect(rail[1].text).toBe("Tap Add new entry");
  });

  it("picks the newest walking walk, and lists finished ones newest first", () => {
    const a = walk({ id: "a", started_at: "2026-10-27T20:01:00Z" });
    const b = walk({ id: "b", started_at: "2026-10-27T20:05:00Z" });
    const done1 = walk({ id: "d1", status: "passed", finished_at: "2026-10-27T19:00:00Z" });
    const done2 = walk({ id: "d2", status: "failed", finished_at: "2026-10-27T19:30:00Z" });
    expect(currentWalk([a, b, done1])?.id).toBe("b");
    expect(currentWalk([done1])).toBeNull();
    expect(finishedWalks([a, done1, done2]).map((w) => w.id)).toEqual(["d2", "d1"]);
  });
});

describe("the queue", () => {
  it("names rank reasons in words, without plain criticality or repeats", () => {
    expect(reasonChips(["never walked", "critical", "changed 3 days ago", "normal", "never walked +40"])).toEqual([
      { label: "Never walked", tone: "new" },
      { label: "Critical", tone: "critical" },
      { label: "Changed 3 days ago", tone: "changed" },
    ]);
    expect(reasonChips(["failed recently", "covered by nothing", "found by both sources"]).map((c) => c.label)).toEqual([
      "Failed recently",
      "Covered by nothing",
      "Found in code and model",
    ]);
  });

  it("says a walked flow's queue-time reasons as history, never next to its outcome as now", () => {
    // Snugly 725d7ccd: "Passed" beside "Never walked" and "Covered by nothing" (QA 2026-10-28).
    const reasons = ["never walked", "high", "covered by nothing", "failed recently"];
    expect(reasonChips(reasons, { walked: flowWalked("passed") }).map((c) => c.label)).toEqual(["First walk", "High value", "Had no scenario", "Failed before"]);
    expect(reasonChips(reasons, { walked: flowWalked("queued") }).map((c) => c.label)).toEqual(["Never walked", "High value", "Covered by nothing", "Failed recently"]);
    expect(flowWalked("walking")).toBe(false);
    expect(flowWalked("skipped")).toBe(false);
    expect(flowWalked("unreachable")).toBe(true);
  });

  it("orders by rank, unranked last, and counts what was walked", () => {
    const flows = [flow({ id: "c", rank: 0, name: "Zzz", status: "queued" }), flow({ id: "b", rank: 2, status: "passed" }), flow({ id: "a", rank: 1, status: "failed" })];
    expect(queueOrder(flows).map((f) => f.id)).toEqual(["a", "b", "c"]);
    const c = queueCounts([...flows, flow({ status: "unreachable" }), flow({ status: "walking" })]);
    expect(c).toMatchObject({ total: 5, walked: 3, passed: 1, failed: 1, unreachable: 1, queued: 1, walking: 1 });
    expect(countsLine(c)).toBe("3 of 5 walked: 1 passed, 1 failed, 1 unreachable");
    expect(countsLine(queueCounts([]))).toBe("No flows yet");
  });

  it("names personas from the model, else in words; data as short pairs", () => {
    expect(personaName("new-parent", [{ key: "new-parent", name: "New parent" }])).toBe("New parent");
    expect(personaName("night_caregiver")).toBe("Night caregiver");
    expect(personaName(null)).toBeNull();
    expect(dataPairs({ baby: "Zawadi", amount_ml: 120, nested: { a: 1 }, empty: "" })).toEqual(["baby: Zawadi", "amount ml: 120"]);
  });
});

describe("a failed walk that reached every step", () => {
  // Snugly 725d7ccd "Edit a saved feeding": 4 of 4 steps reached, 10 checks held, and failed on
  // stale values the detail showed at step 3 (finding from evidence 2).
  const step = (index: number, finding_id: number | null = null) => ({ index, text: `Step ${index}`, reached: true, result: null, checked: ["a"], finding_id, screen_id: null, frame: null, seq: null, at: null });
  const failed = { status: "failed" as const, reason: "Event detail shows stale values right after Update Feeding", steps: [step(1), step(2), step(3, 2), step(4)] };

  it("says what it found and on which step", () => {
    const why = failedWalkWhy(failed, 1, 0);
    expect(why.problems).toBe("1 problem found");
    expect(why.step?.index).toBe(3);
    expect(failedWalkWhy(failed, 2, 0).problems).toBe("2 problems found");
    expect(failedWalkWhy({ ...failed, steps: [step(1)] }, 0, 0)).toEqual({ problems: "1 problem found", step: null });
  });

  it("leaves a missed step and a passed walk as they were", () => {
    expect(failedWalkWhy({ ...failed, steps: [step(1), { ...step(2), reached: false }] }, 1, 0)).toEqual({ problems: null, step: null });
    expect(failedWalkWhy({ ...failed, status: "passed" }, 0, 0)).toEqual({ problems: null, step: null });
  });
});

describe("the App model", () => {
  it("fills in what a model left out and ranks workflows by what matters", () => {
    const m = normalizeAppModel(
      JSON.stringify({
        purpose: "Snugly helps parents log a baby's day.",
        workflows: [
          { key: "timeline", name: "See today's timeline", criticality: "normal", status: "passed" },
          { key: "feed", name: "Log a bottle feed", criticality: "critical", evidence: { screens: ["Today", "Add Entry"], tests: [{ file: "a.swift", title: "t" }] } },
          { key: "edit", name: "Edit a baby's profile", criticality: "critical", status: "failed" },
        ],
      }),
    );
    expect(m?.personas).toEqual([]);
    expect(rankModelWorkflows(m!.workflows).map((w) => w.key)).toEqual(["edit", "feed", "timeline"]);
    const feed = m!.workflows.find((w) => w.key === "feed")!;
    expect(feed.status).toBe("unwalked");
    expect(evidenceTally(feed.evidence)).toEqual([
      { kind: "screens", count: 2 },
      { kind: "tests", count: 1 },
    ]);
    expect(normalizeAppModel("{}")).toBeNull();
    expect(normalizeAppModel("not json")).toBeNull();
  });
});

describe("a queue nobody walked", () => {
  const queued = [flow({ id: "a", status: "queued" }), flow({ id: "b", status: "queued" }), flow({ id: "c", status: "queued" })];

  it("is told only once the exploration ended with flows queued and no walk reaching an outcome", () => {
    // Slate, 2026-10-28: 3 flows queued, the explorer never joined the session.
    expect(unwalkedQueue(queued, [], false, false)).toEqual({ waiting: 3, stopped: 0, joined: false });
    expect(unwalkedQueue(queued, [], true, false)).toBeNull(); // still running: the queue may yet be walked
    expect(unwalkedQueue([], [], false, false)).toBeNull(); // nothing was queued: the page says that instead
    expect(unwalkedQueue([...queued, flow({ id: "d", status: "passed" })], [walk({ status: "passed" })], false, true)).toBeNull();
    expect(unwalkedQueue(queued, [walk({ status: "unreachable" })], false, true)).toBeNull();
    // A walk begun and stopped is not a walked flow.
    expect(unwalkedQueue(queued, [walk({ status: "abandoned" })], false, true)).toEqual({ waiting: 3, stopped: 1, joined: true });
    expect(unwalkedQueue(queued, [], false, undefined)?.joined).toBeNull();
  });

  it("says plainly what happened, never that the pairing ran", () => {
    const never = unwalkedCopy({ waiting: 3, stopped: 0, joined: false });
    expect(never.title).toBe("The explorer did not walk the flow queue");
    expect(never.body).toBe("3 flows were queued for it, but the explorer never joined the drafting session, so it never saw them and explored on its own.");
    expect(never.after).toBe("This report's findings come from that exploring, and no walk became a draft scenario.");
    expect(unwalkedCopy({ waiting: 1, stopped: 0, joined: true }).body).toBe("1 flow was queued for it, and the explorer explored on its own instead of walking it.");
    expect(unwalkedCopy({ waiting: 2, stopped: 1, joined: true }).body).toBe(
      "2 flows were queued for it. The explorer began one walk and stopped before the end, and explored on its own otherwise.",
    );
    for (const c of [never, unwalkedCopy({ waiting: 2, stopped: 2, joined: null })]) {
      expect(`${c.title} ${c.body} ${c.after}`).not.toMatch(/\bAI\b|\u2014|walked end to end/);
    }
  });
});

describe("a flow's outcome on the queue", () => {
  it("keeps what to check and which step is the outcome", () => {
    const row = parseFlowRow({
      ...flow(),
      steps: JSON.stringify([
        { text: "Navigate to baby management", check: 'The "My Children" heading is shown', start: "Open the app with demo data" },
        { text: 'Enter "Amani" in the name field' },
        { text: 'Check: "Amani" is shown', check: '"Amani" is shown', outcome: true },
      ]),
    } as unknown as Record<string, unknown>);
    expect(row.steps[0].check).toBe('The "My Children" heading is shown');
    expect(row.steps[2]).toMatchObject({ outcome: true, check: '"Amani" is shown' });
    expect(row.steps[1].outcome).toBeUndefined();
    expect(flowOutcomeNote(row)).toBeNull();
  });

  it("says when the walk must do what the name promises, and when the steps only open screens", () => {
    const named = flow({
      steps: [
        { text: "Open Settings" },
        { text: "Do what the flow's name says and check it worked: add child and verify in list", outcome: true, from_name: true },
      ],
    });
    expect(flowOutcomeNote(named)).toMatchObject({ kind: "named", label: "Outcome from its name" });
    const screens = flow({ steps: [{ text: "Open Main tab" }, { text: "Open Settings" }, { text: "Navigate to Baby management" }] });
    expect(flowOutcomeNote(screens)).toMatchObject({ kind: "screens", label: "Screens only" });
    expect(flowOutcomeNote(flow())).toBeNull();
    expect(flowOutcomeNote(flow({ steps: [] }))).toBeNull();
  });
});

describe("a walk cut off when the exploration ended", () => {
  it("never shows a flow walking once the exploration ended: cut off, or queued again", () => {
    expect(flowPill(flow(), walk(), true)).toBe("walking");
    expect(flowPill(flow(), walk(), false)).toBe("cut_off");
    // The worker queued the flow again when it stopped the walk: it says so, not just "Queued".
    expect(flowPill(flow({ status: "queued" }), walk({ status: "abandoned" }), false)).toBe("requeued");
    expect(flowPill(flow({ status: "queued", walk_id: null }), undefined, false)).toBe("queued");
    expect(flowPill(flow({ status: "passed" }), walk({ status: "passed" }), false)).toBe("passed");
  });

  it("lands a walk still marked walking with the finished ones once the exploration ended", () => {
    const open = walk();
    expect(finishedWalks([open], true)).toEqual([]);
    const ended = finishedWalks([open], false);
    expect(ended.map((w) => w.status)).toEqual(["abandoned"]);
    expect(currentWalk([open])?.id).toBe("w1");
  });

  it("says a walk the time ran out on was cut off by time, from today's reason and the older wording", () => {
    const cut = {
      word: "Cut off by time",
      why: "The exploration's time ran out before this walk finished. The flow is queued again for the next exploration.",
    };
    expect(stoppedWalk("cut off by time: the exploration's time ran out before the walk finished")).toEqual(cut);
    // Slate's third flow on 2026-10-28, stopped by a worker from before.
    expect(stoppedWalk("the explorer ended (completed) before finishing the walk")).toEqual(cut);
    expect(stoppedWalk("the explorer ran out of time")).toEqual(cut);
    expect(stoppedWalk("the exploration was stopped before the walk finished").why).toBe(
      "The exploration was stopped before this walk finished. The flow is queued again for the next exploration.",
    );
    expect(stoppedWalk("the explorer ended (failed) before finishing the walk").why).toMatch(/^The exploration failed before this walk finished\./);
    expect(stoppedWalk(null)).toEqual({ word: "Cut off", why: "The exploration ended before this walk finished." });
    expect(stoppedWalk("emulator gone")).toEqual({ word: "Stopped", why: "Emulator gone." });
  });
});
