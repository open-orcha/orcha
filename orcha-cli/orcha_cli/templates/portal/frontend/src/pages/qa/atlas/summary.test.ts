/** The atlas header's summary: one bar of every screen, what each platform holds, and the honest
 * words for how the atlas counts beside the App map and Coverage. */
import { describe, expect, it } from "vitest";
import folio from "./folio.fixture.json";
import juniper from "./juniper.fixture.json";
import { countedWords, listWords, share, summarize } from "./summary";
import { parseAtlas } from "./types";

const atlas = parseAtlas(juniper);

describe("summarize", () => {
  it("splits every screen once by what is known about its platforms", () => {
    const s = summarize(atlas);
    expect(s.parts.map((p) => [p.key, p.n])).toEqual([
      ["same", 6],
      ["differs", 4],
      ["missing", 3],
      ["unchecked", 2],
    ]);
    // The parts are every screen, none twice.
    expect(s.parts.reduce((n, p) => n + p.n, 0)).toBe(atlas.counts.screens);
    expect(s.parts.find((p) => p.key === "differs")!.label).toBe("differ");
  });

  it("says what each platform holds and what is not matched yet", () => {
    const s = summarize(atlas);
    expect(s.platforms.map((p) => [p.platform, p.on, p.seen])).toEqual([
      ["ios", 14, 11],
      ["android", 13, 10],
      ["web", 14, 12],
    ]);
    const unmatched = summarize(parseAtlas({ ...juniper, screens: juniper.screens.map((x) => ({ ...x, presence: { ...x.presence, android: "unknown" } })) }));
    expect(unmatched.platforms.find((p) => p.platform === "android")).toMatchObject({ on: 0, unknown: true });
  });

  it("splits a one-platform atlas by seen live and not seen yet", () => {
    const one = parseAtlas({ project_id: "p", platforms: ["web"], counts: { screens: 5, seen: 3, never_seen: 2 }, screens: [] });
    expect(summarize(one).parts.map((p) => [p.key, p.n, p.label])).toEqual([
      ["seen", 3, "seen live"],
      ["unseen", 2, "not seen yet"],
    ]);
  });
});

describe("countedWords", () => {
  it("says a screen counts once across its platforms, and squares it with the App map's count", () => {
    const { line, note } = countedWords(atlas);
    expect(line).toBe("Each counted once across iOS, Android and Web");
    // 15 screens join 28 map nodes: a screen on two platforms is two there.
    const nodes = atlas.screens.reduce((n, s) => n + s.nodes.length, 0);
    expect(nodes).toBe(28);
    expect(note).toContain("The App map and Coverage count each platform's own screen apart: 28 in all.");
    expect(note).toMatch(/^\d+ screens are on more than one platform and count once here\./);
  });

  it("names the two platforms when only two hold screens, the way Nyumbani reads (169 here, 199 there)", () => {
    const mk = (i: number, both: boolean) => ({
      id: `screen:s${i}`,
      nodes: both ? [`screen:a${i}`, `screen:/a${i}`] : [`screen:a${i}`],
      variants: { ios: { seen: i === 0 }, ...(both ? { web: {} } : {}) },
      presence: { ios: i === 0 ? "seen" : "unseen", android: "unknown", web: both ? "unseen" : "absent" },
    });
    const a = parseAtlas({ project_id: "p", platforms: ["ios", "android", "web"], counts: { screens: 4 }, screens: [mk(0, true), mk(1, true), mk(2, false), mk(3, false)] });
    const { note } = countedWords(a);
    expect(note).toBe("2 screens are on both iOS and Web and count once here. The App map and Coverage count each platform's own screen apart: 6 in all.");
  });

  it("says nothing more when every screen is one map screen", () => {
    const one = parseAtlas({ project_id: "p", platforms: ["web"], counts: { screens: 1 }, screens: [{ id: "screen:/", nodes: ["screen:/"], variants: { web: { seen: true } } }] });
    expect(countedWords(one)).toEqual({ line: null, note: null });
    expect(countedWords(parseAtlas(folio)).line).toBe("Each counted once across iOS, Android and Web");
  });
});

describe("words and shares", () => {
  it("lists platforms and rounds shares honestly", () => {
    expect(listWords(["iOS"])).toBe("iOS");
    expect(listWords(["iOS", "Web"])).toBe("iOS and Web");
    expect(listWords(["iOS", "Android", "Web"])).toBe("iOS, Android and Web");
    expect(share(0, 10)).toBe(0);
    expect(share(1, 1000)).toBe(1); // something there is never 0%
    expect(share(999, 1000)).toBe(99); // one short is never 100%
    expect(share(19, 169)).toBe(11);
    expect(share(5, 5)).toBe(100);
  });
});
