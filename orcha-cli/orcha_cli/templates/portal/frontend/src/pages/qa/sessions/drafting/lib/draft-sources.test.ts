import { describe, expect, it } from "vitest";
import {
  passWaitsForDevice,
  canStartChoice,
  choiceForRequest,
  choiceSources,
  clock,
  combinedPhase,
  defaultDraftChoice,
  draftChoiceOptions,
  explorationKindsLine,
  explorationPassLine,
  explorationPassStage,
  explorationsLine,
  explorationTag,
  followUpRecord,
  isRecentExploration,
  passLeadsStatus,
  startLabel,
  type ExplorationPassRequest,
  type ExplorationSummary,
} from "./draft-sources";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const fleet: ExplorationSummary = {
  count: 9,
  latest: "2026-10-03T12:00:00Z",
  latestKind: "web",
  reports: 5,
  kinds: [
    { kind: "ios", count: 5, latest: "2026-09-18T19:22:29Z" },
    { kind: "web", count: 4, latest: "2026-10-03T12:00:00Z" },
  ],
};
const none: ExplorationSummary = { count: 0, latest: null };

describe("default choice", () => {
  it("past explorations when one is at most 7 days old", () => {
    expect(defaultDraftChoice({ hasRepo: true, explorations: fleet, hasTarget: true, now: NOW })).toBe("past");
    expect(isRecentExploration("2026-09-28T12:00:00Z", NOW)).toBe(true);
    expect(isRecentExploration("2026-09-28T11:59:00Z", NOW)).toBe(false);
  });

  it("a new exploration when the newest is older and there is a platform", () => {
    const old = { ...fleet, latest: "2026-09-18T19:22:29Z" };
    expect(defaultDraftChoice({ hasRepo: true, explorations: old, hasTarget: true, now: NOW })).toBe("new");
    expect(defaultDraftChoice({ hasRepo: true, explorations: none, hasTarget: true, now: NOW })).toBe("new");
    expect(defaultDraftChoice({ hasRepo: false, explorations: none, hasTarget: true, now: NOW })).toBe("new");
  });

  it("code only without a platform; still loading reads as no explorations", () => {
    expect(defaultDraftChoice({ hasRepo: true, explorations: none, hasTarget: false, now: NOW })).toBe("code");
    expect(defaultDraftChoice({ hasRepo: true, explorations: null, hasTarget: false, now: NOW })).toBe("code");
    expect(defaultDraftChoice({ hasRepo: false, explorations: { ...fleet, latest: "2026-01-01T00:00:00Z" }, hasTarget: false, now: NOW })).toBe("past");
  });
});

describe("what exists", () => {
  it("summarises the explorations", () => {
    expect(explorationsLine(fleet)).toBe("9 explorations (5 reports) · last Oct 3 on Web");
    expect(explorationsLine({ count: 1, latest: "2026-10-03T12:00:00Z", latestKind: "ios", reports: 1 })).toBe(
      "1 exploration (1 report) · last Oct 3 on iOS",
    );
    expect(explorationsLine(none)).toBe("No explorations yet");
    expect(explorationsLine(null)).toBe("Checking explorations…");
    expect(explorationKindsLine(fleet)).toBe("iOS 5 · Web 4");
    expect(explorationKindsLine({ ...fleet, kinds: [fleet.kinds![0]] })).toBeNull();
  });

  it("offers the three options, disabling what cannot run", () => {
    const opts = draftChoiceOptions({ hasRepo: true, explorations: fleet, hasTarget: true });
    expect(opts.map((o) => [o.value, o.label, o.disabled])).toEqual([
      ["code", "Code only", false],
      ["past", "Code + past explorations", false],
      ["new", "Code + a new exploration", false],
    ]);
    expect(opts[1].detail).toBe("9 explorations (5 reports) · last Oct 3 on Web. The newest three are read.");

    const empty = draftChoiceOptions({ hasRepo: true, explorations: none, hasTarget: false });
    expect(empty[1]).toMatchObject({ disabled: true, detail: "No explorations yet" });
    expect(empty[2]).toMatchObject({ disabled: true, detail: "Add a platform to the project first." });

    const noRepo = draftChoiceOptions({ hasRepo: false, explorations: fleet, hasTarget: true });
    expect(noRepo.map((o) => o.label)).toEqual(["Code only", "Past explorations", "A new exploration"]);
    expect(noRepo[0].disabled).toBe(true);
  });

  it("maps a choice to the drafting queued now and its button", () => {
    expect(choiceSources("code", true)).toBe("code");
    expect(choiceSources("past", true)).toBe("both");
    expect(choiceSources("past", false)).toBe("exploration");
    expect(choiceSources("new", true)).toBe("code");
    expect(choiceSources("new", false)).toBeNull();
    expect(startLabel("new", true)).toBe("Draft and explore");
    expect(startLabel("new", false)).toBe("Explore, then draft");
    expect(canStartChoice("past", { hasRepo: true, explorations: none, hasTarget: true })).toBe(false);
    expect(canStartChoice("new", { hasRepo: false, explorations: none, hasTarget: true })).toBe(true);
    expect(canStartChoice("code", { hasRepo: false, explorations: fleet, hasTarget: true })).toBe(false);
    expect(choiceForRequest("both", false)).toBe("past");
    expect(choiceForRequest("code", true)).toBe("new");
    expect(choiceForRequest(null, false)).toBe("code");
  });
});

function exp(over: Partial<ExplorationPassRequest> = {}): ExplorationPassRequest {
  return {
    id: "e1",
    status: "running",
    created_at: "2026-10-05T11:50:00Z",
    started_at: "2026-10-05T11:57:50Z",
    minutes: 5,
    run_id: "r1",
    error: null,
    target_kind: "web",
    locator: "https://fleet.test",
    summary: null,
    ...over,
  };
}

const line = (e: ExplorationPassRequest, followUp = null as Parameters<typeof explorationPassLine>[0]["followUp"], drafted = 0) =>
  explorationPassLine({ e, followUp, projectName: "FleetMate", screens: 3, drafted, now: NOW });

describe("the new exploration on the page", () => {
  it("reads the worker's follow-up record", () => {
    expect(followUpRecord({ follow_up: { status: "queued", request_id: "f1" } })).toEqual({ status: "queued", request_id: "f1" });
    expect(followUpRecord(JSON.stringify({ follow_up: { status: "skipped", reason: "budget" } }))).toEqual({ status: "skipped", reason: "budget" });
    expect(followUpRecord({ follow_up: { status: "waiting", reason: "the others" } })).toEqual({ status: "waiting", reason: "the others" });
    expect(followUpRecord({ drafted: 3 })).toBeNull();
    expect(followUpRecord("nope")).toBeNull();
  });

  it("one of several platforms that finished first waits for the others before drafting", () => {
    const done = exp({ status: "completed", target_kind: "android", summary: { follow_up: { status: "waiting", reason: "" } } });
    expect(explorationPassStage(done, null)).toBe("handoff");
    expect(line(done)).toBe("Exploration on Android finished · drafting once the other platforms finish…");
  });

  it("walks queued → exploring → handoff → drafting → done", () => {
    expect(explorationPassStage(exp({ status: "queued" }), null)).toBe("queued");
    expect(explorationPassStage(exp(), null)).toBe("exploring");
    expect(explorationPassStage(exp({ status: "completed" }), null)).toBe("handoff");
    const queued = exp({ status: "completed", summary: { follow_up: { status: "queued", request_id: "f1" } } });
    expect(explorationPassStage(queued, null)).toBe("drafting");
    expect(explorationPassStage(queued, { id: "f1", status: "running", error: null })).toBe("drafting");
    expect(explorationPassStage(queued, { id: "f1", status: "completed", error: null })).toBe("done");
    expect(explorationPassStage(queued, { id: "f1", status: "failed", error: "x" })).toBe("draft-failed");
  });

  it("failed, cancelled and skipped explorations draft nothing", () => {
    expect(explorationPassStage(exp({ status: "failed" }), null)).toBe("failed");
    expect(explorationPassStage(exp({ status: "cancelled" }), null)).toBe("cancelled");
    expect(
      explorationPassStage(exp({ status: "completed", summary: { follow_up: { status: "skipped", reason: "r" } } }), null),
    ).toBe("skipped");
  });

  it("says where it is in one line", () => {
    expect(line(exp())).toBe("Exploring FleetMate on Web · 3 screens · 2:10 of 5:00");
    expect(line(exp({ started_at: "2026-10-05T11:50:00Z" }))).toBe("Exploring FleetMate on Web · 3 screens · 5:00 of 5:00");
    expect(line(exp({ status: "queued" }))).toBe("Exploration of FleetMate on Web queued, waiting for an agent");
    // Another run holds its phone: it waits for that device, as its own page says.
    const busy = exp({
      status: "queued",
      target_kind: "ios",
      device: "iPhone 17 Pro",
      waiting_reason: "worker_busy",
    });
    expect(line(busy)).toBe("Exploration of FleetMate on iOS waiting for iPhone 17 Pro: it starts as soon as that device is free");
    expect(passWaitsForDevice(busy)).toBe(true);
    expect(passWaitsForDevice({ ...busy, waiting_reason: "no_worker" })).toBe(false);
    expect(passWaitsForDevice({ ...busy, target_kind: "web" })).toBe(false);
    expect(line(exp({ cancel_requested_at: "2026-10-05T11:59:00Z" }))).toBe("Stopping the exploration…");
    expect(line(exp({ status: "completed" }))).toBe("Exploration finished · queueing the drafting from it…");
    const queued = exp({ status: "completed", summary: { follow_up: { status: "queued", request_id: "f1" } } });
    expect(line(queued)).toBe("Drafting from the new exploration…");
    expect(line(queued, { id: "f1", status: "running", error: null }, 2)).toBe("Drafting from the new exploration… 2 drafted");
    expect(line(queued, { id: "f1", status: "completed", error: null, summary: { drafted: 4 } })).toBe(
      "Drafted from the new exploration · 4 more",
    );
    expect(line(queued, { id: "f1", status: "completed", error: null, summary: { drafted: 0 } })).toBe(
      "Drafted from the new exploration · nothing new",
    );
    expect(line(exp({ status: "failed", error: "no device" }))).toBe("Exploration failed: no device · nothing was drafted from it");
    expect(line(exp({ status: "cancelled" }))).toBe("Exploration cancelled · nothing was drafted from it");
    expect(line(exp({ status: "completed", summary: { follow_up: { status: "skipped", reason: "Over budget." } } }))).toBe("Over budget.");
    expect(clock(61_000)).toBe("1:01");
    expect(explorationTag(exp())).toBe("from exploration Oct 5");
  });

  it("combines the drafting from code with the exploration into one page phase", () => {
    expect(combinedPhase("running", null)).toBe("running");
    expect(combinedPhase("running", "exploring")).toBe("running");
    expect(combinedPhase("completed", "exploring")).toBe("running");
    expect(combinedPhase("completed", "drafting")).toBe("running");
    expect(combinedPhase("completed", "done")).toBe("completed");
    expect(combinedPhase("completed", "failed")).toBe("completed");
    expect(combinedPhase("idle", "queued")).toBe("queued");
    expect(combinedPhase("idle", "handoff")).toBe("running");
    expect(combinedPhase("idle", "done")).toBe("completed");
    expect(combinedPhase("idle", "skipped")).toBe("failed");
    expect(combinedPhase("idle", "cancelled")).toBe("cancelled");
    expect(passLeadsStatus("running", "exploring")).toBe(false);
    expect(passLeadsStatus("completed", "drafting")).toBe(true);
    expect(passLeadsStatus("completed", "done")).toBe(false);
    expect(passLeadsStatus("failed", "exploring")).toBe(false);
    expect(passLeadsStatus("idle", "failed")).toBe(true);
  });
});

describe("an exploration that ended or hasn't started (D8, D14)", () => {
  it("stops reading 'Exploring' once its run ended, even while the request wraps up", () => {
    const ended = exp({ run: { status: "completed", blockers: 0, blockerTitle: null } });
    expect(explorationPassStage(ended, null)).toBe("handoff");
    expect(line(ended)).toBe("Exploration ended · wrapping up…");
    // Still running on the device: unchanged.
    expect(explorationPassStage(exp({ run: { status: "running", blockers: 0, blockerTitle: null } }), null)).toBe("exploring");
  });

  it("leads with the blocker that ended it", () => {
    const crashed = exp({
      status: "completed",
      summary: { follow_up: { status: "skipped", reason: "No screens to draft from." } },
      run: { status: "completed", blockers: 1, blockerTitle: "App crashes at launch" },
    });
    expect(line(crashed)).toBe("Exploration ended: App crashes at launch (1 blocker) · No screens to draft from.");
  });

});

