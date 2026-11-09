/** What took each look (#438): the device and appearance filters, the frame each look is drawn in,
 * the "Seen on" matrix, the light and dark wipes, the chips and the coverage line, on a small atlas
 * shaped like Snugly's (iPhone, iPad and Pixel looks, light and dark) and Nyumbani's (with the web). */
import { describe, expect, it } from "vitest";
import {
  chipWords,
  coverageWords,
  filterAtlas,
  fitting,
  keeps,
  lookKind,
  missingWords,
  NO_FILTERS,
  seenCell,
  seenRows,
  shadePairs,
  shapesOf,
  shortDevice,
  slotFit,
  unfitWords,
  usualForms,
  viewAtlas,
} from "./model";
import { parseAtlas, type AtlasSeen } from "./types";

const look = (platform: "ios" | "android" | "web", device: string, form: "phone" | "tablet" | "desktop", appearance: "light" | "dark", at: string): Partial<AtlasSeen> => ({
  platform,
  device,
  form,
  appearance,
  set_appearance: appearance,
  orientation: form === "desktop" ? "landscape" : "portrait",
  w: form === "tablet" ? 2064 : form === "desktop" ? 1280 : 1206,
  h: form === "tablet" ? 2752 : form === "desktop" ? 800 : 2622,
  frame_url: `/api/artifacts/qa-runs/${platform}-${form}-${appearance}.jpg`,
  at,
  build: null,
  run_id: null,
  state: "loaded",
});

const iphoneLight = look("ios", "iPhone 17 Pro", "phone", "light", "2026-10-28T16:56:00Z");
const iphoneDark = look("ios", "iPhone 17 Pro", "phone", "dark", "2026-10-28T15:24:00Z");
const ipad = look("ios", "iPad Pro 13-inch (M5)", "tablet", "light", "2026-10-28T06:41:00Z");
const pixel = look("android", "Pixel 9a", "phone", "light", "2026-10-28T13:18:00Z");
const device = (l: Partial<AtlasSeen>) => ({ kind: l.form, landscape: false, w: l.w, h: l.h, name: l.device, form: l.form, appearance: l.appearance, set_appearance: l.appearance, orientation: l.orientation });

const snugly = parseAtlas({
  project_id: "p1",
  platforms: ["ios", "android"],
  devices: { ios: { kind: "phone" }, android: { kind: "phone" } },
  coverage: [
    { form: "phone", platforms: { ios: ["light", "dark"], android: ["light"] } },
    { form: "tablet", platforms: { ios: ["light"] } },
  ],
  areas: [{ key: "today", name: "Today", screens: ["screen:dashboard", "screen:manual"] }],
  screens: [
    {
      id: "screen:dashboard",
      name: "Dashboard",
      area: "today",
      platforms: ["ios", "android"],
      variants: {
        ios: { seen: true, frame_url: iphoneLight.frame_url, device: device(iphoneLight) },
        android: { seen: true, frame_url: pixel.frame_url, device: device(pixel) },
      },
      seen_on: [iphoneLight, iphoneDark, ipad, pixel],
      similarity: {
        badge: "different",
        score: 0.29,
        pairs: [{ a: "ios", b: "android", score: 0.29, badge: "different", reasons: [], match: "same", fair: true, words: "iPhone 17 Pro vs Pixel 9a, both light", looks: { a: iphoneLight, b: pixel } }],
      },
    },
    {
      id: "screen:manual",
      name: "Manual log entry",
      area: "today",
      platforms: ["ios", "android"],
      variants: {
        ios: { seen: true, frame_url: iphoneDark.frame_url, device: device(iphoneDark) },
        android: { seen: true, frame_url: pixel.frame_url, device: device(pixel) },
      },
      seen_on: [iphoneDark, pixel],
      similarity: {
        badge: "unchecked",
        score: null,
        reasons: ["iOS was only seen in dark, Android only in light, so Embodent does not compare them yet"],
        pairs: [{ a: "ios", b: "android", score: null, badge: "unchecked", reasons: ["iOS was only seen in dark, Android only in light, so Embodent does not compare them yet"], match: "appearance", fair: false, words: "iPhone 17 Pro in dark vs Pixel 9a in light" }],
      },
    },
  ],
});

describe("what took each look", () => {
  it("parses pairs that say what they compare, and an older atlas's pairs as fair", () => {
    const [dash, manual] = snugly.screens;
    expect(dash.similarity?.pairs[0]).toMatchObject({ match: "same", fair: true, words: "iPhone 17 Pro vs Pixel 9a, both light" });
    expect(dash.similarity?.pairs[0].looks?.b.device).toBe("Pixel 9a");
    expect(manual.similarity?.pairs[0]).toMatchObject({ fair: false, score: null });
    const old = parseAtlas({ project_id: "p", screens: [{ id: "s", similarity: { badge: "same", pairs: [{ a: "ios", b: "android", score: 0.9, badge: "same" }] } }] });
    expect(old.screens[0].similarity?.pairs[0]).toMatchObject({ fair: true, match: null, looks: null });
    expect(old.screens[0].seen_on).toEqual([]);
    expect(old.coverage).toEqual([]);
  });

  it("says each look's device in a chip, short on a small frame", () => {
    expect(chipWords(iphoneDark as AtlasSeen, "ios")).toBe("iPhone 17 Pro · Dark · Portrait");
    expect(chipWords(look("web", "Chromium 1280×800", "desktop", "light", "t") as AtlasSeen, "web")).toBe("Chromium 1280×800 · Light");
    expect(shortDevice("iPad Pro 13-inch (M5)")).toBe("iPad Pro");
    expect(shortDevice("Pixel 9a")).toBe("Pixel 9a");
  });

  it("keeps only screens seen on the device and in the appearance picked, each frame that look", () => {
    const f = { ...NO_FILTERS, devices: ["tablet" as const] };
    expect(snugly.screens.map((s) => keeps(s, f))).toEqual([true, false]);
    const view = viewAtlas(snugly, f);
    const dash = view.screens[0];
    expect(dash.variants.ios?.frame_url).toBe(ipad.frame_url);
    expect(dash.variants.ios?.device?.name).toBe("iPad Pro 13-inch (M5)");
    expect(dash.variants.android?.frame_url).toBeNull();
    expect(dash.variants.android?.unfit).toBe("Not seen on an Android tablet yet");
    // The columns take the kind picked, so every card in a row is an iPad.
    expect(shapesOf(view)).toEqual({ ios: "tablet", android: "tablet" });
    expect(filterAtlas(view, f).flatMap((r) => r.screens.map((s) => s.name))).toEqual(["Dashboard"]);
    // Dark: the iPhone's dark look; no filter: the very same atlas.
    const dark = { ...NO_FILTERS, appearances: ["dark" as const] };
    expect(fitting(snugly.screens[0], "ios", dark)?.frame_url).toBe(iphoneDark.frame_url);
    expect(unfitWords("android", dark)).toBe("Not seen on Android in dark yet");
    expect(viewAtlas(snugly, NO_FILTERS)).toBe(snugly);
  });

  it("draws a look in the frame of the device that took it, fitted to its column", () => {
    expect(lookKind("ios", { kind: "tablet", landscape: false })).toBe("tablet");
    expect(lookKind("ios", { kind: "tablet", landscape: true })).toBe("tabletWide");
    expect(lookKind("web", { kind: "phone", landscape: false })).toBe("browser");
    expect(lookKind("ios", null)).toBeNull();
    expect(slotFit("phone", "phone")).toBe(1);
    // An iPad (162 wide) in a phone's column (104 wide) shrinks; a phone in an iPad's never grows.
    expect(slotFit("phone", "tablet")).toBeCloseTo(104 / 162);
    expect(slotFit("tablet", "phone")).toBe(1);
  });

  it("lays out Seen on: each kind of device in light and dark, saying what is missing", () => {
    const dash = snugly.screens[0];
    expect(seenRows(snugly, dash).map((r) => r.label)).toEqual(["Phone · Light", "Phone · Dark", "Tablet · Light", "Tablet · Dark"]);
    expect(seenCell(dash, "ios", { form: "tablet", appearance: "light" })?.device).toBe("iPad Pro 13-inch (M5)");
    expect(seenCell(dash, "android", { form: "tablet", appearance: "light" })).toBeNull();
    expect(missingWords(dash, "android", { form: "tablet", appearance: "light" })).toBe("Not seen on an Android tablet yet");
    expect(missingWords(dash, "android", { form: "phone", appearance: "dark" })).toBe("Seen on an Android phone in light only");
    expect(missingWords(dash, "ios", { form: "tablet", appearance: "dark" })).toBe("Seen on an iPad in light only");
    expect(missingWords({ seen_on: [] }, "web", { form: "phone", appearance: "light" })).toBe("Not seen in a phone-sized browser yet");
    // An Android desktop is not a cell to fill: blank, unless the atlas has seen one.
    expect(usualForms(snugly, "android")).toEqual(["phone", "tablet"]);
    expect(usualForms(snugly, "web")).toEqual(["phone", "desktop"]);
  });

  it("offers a light and dark wipe on the same device", () => {
    const pairs = shadePairs(snugly.screens[0], ["ios", "android"]);
    expect(pairs.map((x) => [x.platform, x.form, x.device])).toEqual([["ios", "phone", "iPhone 17 Pro"]]);
    expect(pairs[0].light.frame_url).toBe(iphoneLight.frame_url);
    expect(pairs[0].dark.frame_url).toBe(iphoneDark.frame_url);
  });

  it("says which devices and appearances the atlas covers", () => {
    expect(coverageWords(snugly)).toBe("Phones: iOS in light and dark, Android in light. Tablets: iPad only, light.");
    expect(
      coverageWords({
        platforms: ["ios", "android"],
        coverage: [
          { form: "phone", platforms: { ios: ["light", "dark"], android: ["light", "dark"] } },
          { form: "tablet", platforms: { ios: ["light"] } },
        ],
      }),
    ).toBe("Phones: iOS and Android, light and dark. Tablets: iPad only, light.");
    expect(coverageWords({ platforms: ["ios"], coverage: [] })).toBe("");
  });
});
