/** Blank captures (an Android app in secure mode, FLAG_SECURE, is captured solid black; a screen
 * caught before it drew is one plain colour): the atlas keeps the look without its picture and the
 * page says why where the picture would be, on an atlas shaped like Nyumbani's home (an iPhone in
 * light beside a Pixel 9a whose app hides itself from screenshots). */
import { describe, expect, it } from "vitest";
import { blankWords, capturing, fitting, missingWords, passProgress, seenCell, shadePairs, viewAtlas, wipeWords } from "./model";
import { parseAtlas, type AtlasSeen } from "./types";

const iphone: Partial<AtlasSeen> = {
  platform: "ios",
  device: "iPhone 17 Pro",
  form: "phone",
  appearance: "light",
  set_appearance: "light",
  orientation: "portrait",
  w: 1206,
  h: 2622,
  frame_url: "/api/artifacts/qa-runs/e52ed912/frames/0017.jpg",
  at: "2026-10-28T06:15:27Z",
  state: "loaded",
};
// The Pixel's look as the atlas reads it now: seen, no picture, and why.
const pixel: Partial<AtlasSeen> = {
  platform: "android",
  device: "Pixel 9a",
  form: "phone",
  appearance: "light",
  set_appearance: "light",
  orientation: "portrait",
  w: 1080,
  h: 2424,
  frame_url: null,
  at: "2026-10-28T06:04:53Z",
  state: "loaded",
  blank: "flag_secure",
};

const nyumbani = () =>
  parseAtlas({
    project_id: "p1",
    platforms: ["ios", "android"],
    devices: { ios: { kind: "phone" }, android: { kind: "phone" } },
    coverage: [{ form: "phone", platforms: { ios: ["light"] } }],
    areas: [{ key: "browse", name: "Browse", screens: ["screen:home"] }],
    screens: [
      {
        id: "screen:home",
        name: "Home",
        area: "browse",
        platforms: ["ios", "android"],
        variants: {
          ios: { seen: true, frame_url: iphone.frame_url, device: { kind: "phone", w: 1206, h: 2622, name: "iPhone 17 Pro", form: "phone", appearance: "light" } },
          android: { seen: true, frame_url: null, blank: "flag_secure", device: { kind: "phone", w: 1080, h: 2424, name: "Pixel 9a", form: "phone", appearance: "light" } },
        },
        seen_on: [iphone, pixel],
        states: [{ state: "loaded", label: "Loaded", platforms: ["ios", "android"], frame_url: iphone.frame_url, blank: null }],
        similarity: {
          badge: "same",
          score: 1,
          reasons: ["Reads the same on iOS and Android", "The Android app hides this screen from screenshots, so Embodent compares the words only"],
          pairs: [{ a: "ios", b: "android", score: 1, badge: "same", reasons: [], match: "same", fair: true, words: "iPhone 17 Pro vs Pixel 9a, both light", looks: { a: iphone, b: pixel } }],
        },
      },
    ],
  });

describe("a blank capture", () => {
  it("is read as seen with no picture, and why", () => {
    const home = nyumbani().screens[0];
    expect(home.variants.android?.blank).toBe("flag_secure");
    expect(home.variants.android?.seen).toBe(true);
    expect(home.variants.ios?.blank).toBeUndefined();
    expect(home.seen_on.find((l) => l.platform === "android")?.blank).toBe("flag_secure");
    expect(home.similarity?.pairs[0].looks?.b.blank).toBe("flag_secure");
    // A look with a picture is never blank, whatever an older or newer reader says.
    const odd = parseAtlas({ project_id: "p", screens: [{ id: "s", variants: { android: { seen: true, frame_url: "/x.jpg", blank: "uniform" } }, seen_on: [{ platform: "android", frame_url: "/x.jpg", blank: "uniform" }] }] });
    expect(odd.screens[0].variants.android?.blank).toBeUndefined();
    expect(odd.screens[0].seen_on[0].blank).toBeNull();
    // Unknown words are dropped.
    const other = parseAtlas({ project_id: "p", screens: [{ id: "s", variants: { android: { seen: true, frame_url: null, blank: "smudged" } } }] });
    expect(other.screens[0].variants.android?.blank).toBeUndefined();
  });

  it("says why where the picture would be, claiming only what Embodent checked", () => {
    expect(blankWords("flag_secure", "android")).toEqual({
      title: "The Android app hides this screen from screenshots",
      line: "The app turns on secure mode (FLAG_SECURE), so every screenshot of it is black. Embodent still read its words.",
      short: "Hidden from screenshots",
    });
    // Only one colour: no word of secure mode, which nothing checked.
    const plain = blankWords("uniform", "ios");
    expect(plain.title).toBe("The screenshot came back blank");
    expect(`${plain.title} ${plain.line} ${plain.short}`).not.toMatch(/secure|FLAG_SECURE|hides/i);
    expect(plain.line).toContain("Embodent still read its words");
    expect(wipeWords("flag_secure", "android")).toBe("The Android app hides this screen from screenshots, so there is nothing to wipe across. Embodent compares their words.");
    expect(wipeWords("uniform", "android")).toBe("Android's screenshot came back blank, so there is nothing to wipe across. Embodent compares their words.");
    // Plain words: no em dash, no "AI".
    for (const w of [blankWords("flag_secure", "android"), plain]) expect(Object.values(w).join(" ")).not.toMatch(/—|\bAI\b/);
  });

  it("keeps its cell in Seen on, never wipes from light to dark, and says the other appearance was seen", () => {
    const home = nyumbani().screens[0];
    expect(seenCell(home, "android", { form: "phone", appearance: "light" })?.blank).toBe("flag_secure");
    expect(seenCell(home, "android", { form: "phone", appearance: "light" }, true)).toBeNull();
    expect(missingWords(home, "android", { form: "phone", appearance: "dark" })).toBe("Seen on an Android phone in light only");
    // A dark picture beside the blank light look is no light and dark pair.
    const dark = { ...pixel, appearance: "dark" as const, blank: null, frame_url: "/api/artifacts/qa-runs/6526fba0/frames/0004.jpg" };
    expect(shadePairs({ seen_on: [...home.seen_on, dark] as AtlasSeen[] }, ["android"])).toEqual([]);
  });

  it("fits the device and appearance filters it was seen in, and says why there", () => {
    const at = nyumbani();
    const home = at.screens[0];
    expect(fitting(home, "android", { devices: ["phone"], appearances: ["light"] })?.blank).toBe("flag_secure");
    const light = viewAtlas(at, { devices: ["phone"], appearances: ["light"] }).screens[0].variants.android;
    expect(light?.blank).toBe("flag_secure");
    expect(light?.unfit).toBeUndefined();
    // Never seen in dark: the filter says so.
    const dark = viewAtlas(at, { devices: [], appearances: ["dark"] }).screens[0].variants.android;
    expect(dark?.unfit).toBe("Not seen on Android in dark yet");
  });

  it("counts as captured for a running pass", () => {
    const at = nyumbani();
    const running = { ...at, refresh: { ...at.refresh, state: "running", targets: ["screen:home"], platform: "android" as const } };
    expect(capturing(running).size).toBe(0);
    expect(passProgress(running)).toEqual({ seen: 1, total: 1 });
  });
});
