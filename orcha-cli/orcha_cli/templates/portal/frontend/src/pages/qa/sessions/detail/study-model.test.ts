import { describe, expect, it } from "vitest";
import type { StudyManifest } from "../explorations";
import {
  chooseScene,
  countLabel,
  discoveredSections,
  featureChips,
  isSectionLabel,
  missingRepoLine,
  pageOutline,
  readState,
  sourceRows,
} from "./study-model";

const M = (sources: StudyManifest["sources"], repo = false): StudyManifest => ({ version: 1, repo, bytes: 1, sources });

describe("the Study face's choices", () => {
  it("picks the scene from the manifest, the platform and whether a screen has arrived", () => {
    const past = M([{ kind: "memory", count: 1, items: [{ name: "n" }] }]);
    expect(chooseScene({ manifest: M([], true), platform: "web", hasScreen: false })).toBe("code");
    expect(chooseScene({ manifest: M([]), platform: "web", hasScreen: false })).toBe("site");
    expect(chooseScene({ manifest: M([]), platform: "android", hasScreen: true })).toBe("device");
    expect(chooseScene({ manifest: past, platform: "ios", hasScreen: false })).toBe("timeline");
    expect(chooseScene({ manifest: past, platform: "ios", hasScreen: true })).toBe("device");
    expect(chooseScene({ manifest: null, platform: "desktop", hasScreen: false })).toBe("site");
    expect(missingRepoLine(M([]), "site", "desktop")).toBe("No repository linked: studying the running app");
    expect(missingRepoLine(M([], true), "code", "web")).toBeNull();
    expect(missingRepoLine(null, "site", "web")).toBeNull();
  });

  it("outlines a page: navigation in reading order without the chrome, links, and its sentences", () => {
    const o = pageOutline({
      seq: 1,
      url: "https://www.dribbble.com/shots",
      title: "Shots",
      anchors: ["Sign up", "Popular", "Close", "Start Your Project Brief Today Now", "Recent"],
      texts: ["Recent", "Popular", "Discover the world's top designers", "Sign up"],
      frame_path: null,
    });
    expect(o.address).toBe("dribbble.com/shots");
    expect(o.nav).toEqual(["Recent", "Popular"]);
    expect(o.links).toEqual(["Sign up", "Close", "Start Your Project Brief Today Now"]);
    expect(o.texts).toEqual(["Discover the world's top designers"]);
    expect(isSectionLabel("Log in")).toBe(false);
    expect(isSectionLabel("Hire Talent")).toBe(true);
    // A phone screen has no title: its first non-control text names it.
    expect(pageOutline({ seq: 2, url: null, title: null, anchors: ["Add"], texts: ["Add", "Recent Activity"], frame_path: null }).title).toBe("Recent Activity");
    const screens = [
      { seq: 1, url: null, title: null, anchors: ["Trips", "Expenses"], texts: [], frame_path: null },
      { seq: 2, url: null, title: null, anchors: ["expenses", "Payroll"], texts: [], frame_path: null },
    ];
    expect(discoveredSections(screens)).toEqual(["Trips", "Expenses", "Payroll"]);
  });

  it("fills the Features row from targets, then the briefing, then the feature map, then the site", () => {
    const map = M([{ kind: "features", count: 2, items: [{ name: "Expenses", key: "expenses" }, { name: "Trips", key: "trips" }] }]);
    const screens = [{ seq: 1, url: "https://x", title: null, anchors: ["Pricing"], texts: [], frame_path: null }];
    const e = { targets: [] as string[], charter: [], briefing: null, study: null };
    expect(featureChips({ ...e, targets: ["trips"], study: map }, screens)).toEqual({ chips: [{ key: "trips", name: "Trips" }], origin: "targets" });
    expect(featureChips({ ...e, study: map }, screens).origin).toBe("feature_map");
    expect(featureChips(e, screens)).toEqual({ chips: [{ key: "Pricing", name: "Pricing" }], origin: "site" });
    expect(featureChips(e, [])).toEqual({ chips: [], origin: "none" });
  });

  it("rows: only sources with something in them, real names, the opened ones lit", () => {
    const m = M([
      { kind: "scenarios", count: 3, items: [{ name: "Owner logs an expense" }] },
      { kind: "memory", count: 1, items: [{ name: "Expenses tab is second", detail: "app_map" }] },
      { kind: "tests", count: 5, files: 2, items: [{ name: "rejects 0", path: "web/expenses.test.ts" }] },
    ]);
    const read = readState(m, [{ kind: "memory", ref: "Expenses tab is second" }], ["/repo/web/expenses.test.ts"]);
    const rows = sourceRows(m, read, ["tests"]);
    expect(rows.map((r) => [r.kind, r.count, r.more])).toEqual([
      ["scenarios", "3 scenarios", 2],
      ["memory", "1 note", 0],
    ]);
    expect(rows[1].chips[0].lit).toBe(true);
    expect(rows[0].chips[0].lit).toBe(false);
    expect(sourceRows(m, read)[2].chips[0].lit).toBe(true);
    expect(sourceRows(null, read)).toEqual([]);
    expect(countLabel({ kind: "tests", count: 1, files: 1 })).toBe("1 test in 1 file");
  });
});
