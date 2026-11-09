/** What the two levels of Quality's navigation show and where each of their tabs goes. */
import { describe, expect, it } from "vitest";
import { normalizeOverview } from "./qaApi";
import { qaSubLevel, qaTabBadges, qaViewOf } from "./SubNav";

describe("qaSubLevel", () => {
  it("is there for Runs, and nowhere else", () => {
    expect(["exploration", "scenarios", "onboarding", "run"].map((v) => qaSubLevel(v))).toEqual([null, null, null, null]);
    expect(qaSubLevel("sessions")?.items.map((i) => i.key)).toEqual(["sessions", "requests"]);
    expect(qaSubLevel("requests")?.items.every((i) => i.icon)).toBe(true);
  });

  it("reads the current item from the view", () => {
    expect(qaSubLevel("sessions")?.value).toBe("sessions");
    expect(qaSubLevel("requests")?.value).toBe("requests");
  });

  it("opens an item, and leaves a view alone when it is already there", () => {
    expect(qaSubLevel("requests")?.open("requests")).toBeNull();
    // All runs is also the way back from a run's page
    expect(qaSubLevel("sessions")?.open("sessions")).toMatchObject({ view: "sessions", sub: null, session: null });
  });
});

describe("qaViewOf", () => {
  it("keeps the views that exist", () => {
    for (const v of ["exploration", "scenarios", "sessions", "requests", "onboarding", "run"]) expect(qaViewOf(v)).toBe(v);
  });

  it("lands an address of a removed view on one of the three tabs, never a blank page", () => {
    expect(qaViewOf(null)).toBe("exploration");
    for (const v of ["overview", "map", "targets", "anything"]) expect(qaViewOf(v)).toBe("exploration");
    expect(qaViewOf("triage")).toBe("sessions");
  });
});

describe("qaTabBadges", () => {
  const overview = (ios: object, web: object = {}) => normalizeOverview({ platforms: { ios, web } });

  it("shows nothing before the overview arrives, or when nothing waits", () => {
    expect(qaTabBadges(null, 0)).toEqual({});
    expect(qaTabBadges(overview({ scenarios: { validated: 4 }, open_findings: 2 }), 0)).toEqual({});
  });

  it("counts drafts on every platform and says where", () => {
    expect(qaTabBadges(overview({ scenarios: { draft: 2 } }, { scenarios: { draft: 1 } }), 0).scenarios).toEqual({ n: 3, says: "3 drafts to review: 2 on iOS, 1 on Web" });
    expect(qaTabBadges(overview({ scenarios: { draft: 1 } }), 0).scenarios).toEqual({ n: 1, says: "1 draft to review" });
  });

  it("marks a run going as live", () => {
    expect(qaTabBadges(null, 1).sessions).toEqual({ n: 1, says: "1 run going", tone: "live" });
  });
});
