import { describe, expect, it } from "vitest";
import type { BoardEvent, DraftingSession, ScenarioEvidence } from "./types";
import {
  artifactUrl,
  correctionsByIndex,
  evidenceByDraft,
  evidenceCounts,
  evidenceTitle,
  feedItems,
  filmstrip,
  explorerDevice,
  latestPlan,
  sessionLine,
  type SessionExplorer,
} from "./drafting-board";

function ev(seq: number, over: Partial<BoardEvent>): BoardEvent {
  return {
    id: `e${seq}`,
    session_id: "s1",
    seq,
    author: "explorer",
    kind: "screen",
    title: "Routines",
    body: null,
    screenshot_path: null,
    scenario_id: null,
    created_at: `2026-10-07T12:00:0${seq}.000Z`,
    ...over,
  };
}

function row(over: Partial<ScenarioEvidence>): ScenarioEvidence {
  return {
    id: Math.random().toString(36),
    scenario_id: "d1",
    session_id: "s1",
    criterion_index: 0,
    status: "verified",
    screenshot_path: null,
    run_id: null,
    step: null,
    screen_name: null,
    route: null,
    matched: null,
    code_ref: null,
    source: "session",
    ...over,
  };
}

describe("feedItems", () => {
  it("reads the board as a conversation between the drafter and the explorer", () => {
    const items = feedItems([
      ev(1, { author: "drafter", kind: "request", title: "Open Routines", body: { flow: null, look_only: null } }),
      ev(2, {
        kind: "screen",
        title: "New routine dialog",
        body: { named: true, name: "New routine dialog", summary: 'Dialog "New routine" · 3 fields · buttons: Create routine, Cancel' },
        screenshot_path: "r1/frames/0007.jpg",
      }),
      ev(3, { kind: "answer", title: 'The primary button is "Create routine"', screenshot_path: "r1/frames/0007.jpg" }),
      ev(4, {
        author: "drafter",
        kind: "correction",
        title: "Revised 'Create a routine' (Save → Create routine)",
        body: { reason: null },
      }),
      ev(5, { author: "system", kind: "status", title: "Explorer finished: 4 screens posted" }),
    ]);
    expect(items.map((i) => [i.actor, i.to, i.text])).toEqual([
      ["Drafter", "Explorer", "Open Routines"],
      ["Explorer", null, "found 'New routine dialog'"],
      ["Explorer", null, 'The primary button is "Create routine"'],
      ["Drafter", null, "revised 'Create a routine' (Save → Create routine)"],
      [null, null, "Explorer finished: 4 screens posted"],
    ]);
    expect(items[1].detail).toBe("3 fields · buttons: Create routine, Cancel");
    expect(items[1].thumb).toBe("/api/qa/frames/r1%2Fframes%2F0007.jpg");
    expect(items[3].detail).toBe("corrected from screen");
    expect(items[0].thumb).toBeNull();
  });

  it("says reached for a screen posted on its own, and keeps the newest", () => {
    const many = Array.from({ length: 5 }, (_, i) => ev(i + 1, { title: `Screen ${i}`, body: { named: false } }));
    const items = feedItems(many, 3);
    expect(items.map((i) => i.text)).toEqual(["reached Screen 2", "reached Screen 3", "reached Screen 4"]);
  });
});

describe("evidence", () => {
  const rows = [
    row({ criterion_index: 0, status: "verified", screenshot_path: "r1/frames/0007.jpg", screen_name: "New routine dialog", step: 7 }),
    row({ criterion_index: 1, status: "unconfirmed", screenshot_path: "r1/frames/0003.jpg", screen_name: "Routines" }),
    row({ criterion_index: 2, status: "verified", screenshot_path: "r1/frames/0007.jpg", screen_name: "New routine dialog" }),
    row({ criterion_index: 3, status: "code_only", code_ref: "app/routines/new.tsx:40" }),
  ];

  it("builds one filmstrip frame per screen, verified first", () => {
    const film = filmstrip(rows);
    expect(film.map((f) => [f.path, f.criteria, f.verified])).toEqual([
      ["r1/frames/0007.jpg", [0, 2], true],
      ["r1/frames/0003.jpg", [1], false],
    ]);
    expect(film[0].url).toBe(artifactUrl("r1/frames/0007.jpg"));
  });

  it("counts statuses and explains each badge", () => {
    expect(evidenceCounts(rows)).toEqual({ verified: 2, unconfirmed: 1, code_only: 1 });
    expect(evidenceTitle(rows[0])).toBe("Seen on New routine dialog (step 7)");
    expect(evidenceTitle(rows[3])).toBe("No screen to check it against · from app/routines/new.tsx:40");
  });

  it("keeps the newest correction of each criterion and groups by draft", () => {
    const corrections = [
      ev(1, { author: "drafter", kind: "correction", scenario_id: "d1", body: { changes: [{ index: 0, before: "a", after: "b" }] } }),
      ev(2, {
        author: "drafter",
        kind: "correction",
        scenario_id: "d1",
        body: { changes: [{ index: 0, before: "b", after: "c" }], screen_name: "New routine dialog" },
      }),
    ];
    const byIndex = correctionsByIndex(corrections);
    expect(byIndex.get(0)).toMatchObject({ before: "b", after: "c", screenName: "New routine dialog" });
    const grouped = evidenceByDraft(rows, corrections);
    expect(grouped.get("d1")?.rows).toHaveLength(4);
    expect(grouped.get("d1")?.corrections.get(0)?.after).toBe("c");
  });
});

describe("plan and session line", () => {
  it("reads the newest plan", () => {
    const flows = latestPlan([
      ev(1, { kind: "plan", author: "drafter", body: { flows: [{ name: "Old", status: "found" }] } }),
      ev(2, { kind: "plan", author: "drafter", body: { flows: [{ name: "Create a routine", status: "drafted" }] } }),
    ]);
    expect(flows.map((f) => f.name)).toEqual(["Create a routine"]);
  });

  it("says what the two agents are doing", () => {
    const base = { status: "live", explorer_status: "running", deadline_at: "2026-10-07T12:10:00.000Z", note: null } as DraftingSession;
    expect(sessionLine(base, Date.parse("2026-10-07T12:05:30.000Z"))).toBe("Exploring the app · 4:30 left");
    expect(sessionLine({ ...base, status: "code_only", note: "The explorer stopped (no device)." }, 0)).toBe("The explorer stopped (no device).");
    expect(sessionLine(null, 0)).toBeNull();
  });
});

describe("the session line while the explorer waits for its device", () => {
  // Slate on 2026-10-28: the drafter finished 43 s in, the explorer queued behind a busy iPhone.
  const slate = {
    status: "finished",
    explorer_status: "queued",
    pairing: "workflow",
    deadline_at: "2026-10-29T03:51:00.286Z",
    explorer_joined_at: null,
    note: null,
  } as DraftingSession;
  const iphone: SessionExplorer = { id: "x", status: "queued", device: "iPhone 17 Pro", target_kind: "ios" };
  const at = Date.parse("2026-10-29T03:45:00.000Z");

  it("names the device the explorer waits for, never that the session is over", () => {
    expect(sessionLine(slate, at, [iphone])).toBe("Drafter done · the explorer is waiting for iPhone 17 Pro");
    expect(sessionLine({ ...slate, status: "live" }, at, [iphone])).toBe("Drafter reading the code · explorer waiting for iPhone 17 Pro");
    expect(sessionLine({ ...slate, status: "live" }, at, [{ ...iphone, device: null }])).toBe("Drafter reading the code · explorer waiting for an iOS device");
    // Started on its device, not joined yet: a workflow pairing still joins it late (#462).
    expect(sessionLine(slate, at, [{ ...iphone, status: "running" }])).toBe("Drafter done · the explorer is starting on iPhone 17 Pro");
  });

  it("says Drafted together only once the explorer really joined", () => {
    const joined = { ...slate, explorer_status: "running", explorer_joined_at: "2026-10-29T03:46:42.594Z", deadline_at: "2026-10-29T03:56:42.594Z" } as DraftingSession;
    const walking = [{ ...iphone, status: "running" }];
    expect(sessionLine(joined, Date.parse("2026-10-29T03:50:42.594Z"), walking)).toBe("Drafter done · explorer walking the flow queue · 6:00 left");
    const done = { ...joined, explorer_status: "finished" } as DraftingSession;
    expect(sessionLine(done, at, [{ ...iphone, status: "completed" }])).toBe("Explored and drafted.");
    // Never joined, now ended: drafted from the code, not together.
    expect(sessionLine({ ...slate, explorer_status: "finished" } as DraftingSession, at, [{ ...iphone, status: "completed" }])).toBe(
      "Drafted from the code: the explorer did not join the session.",
    );
    // A classic explorer running on its own after the drafter.
    expect(sessionLine({ ...slate, pairing: "classic" } as DraftingSession, at, [{ ...iphone, status: "running" }])).toBe(
      "Drafter done · the explorer explores on its own",
    );
  });

  it("words a device by its name, else its kind", () => {
    expect(explorerDevice({ device: " Pixel 9a ", target_kind: "android" })).toBe("Pixel 9a");
    expect(explorerDevice({ device: null, target_kind: "web" })).toBe("a browser");
    expect(explorerDevice(null)).toBe("a device");
  });
});
