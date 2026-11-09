/** "Play the app": the tour's steps (area by area, only what runs have seen, the moves the flows
 * name) and the camera's track. */
import { describe, expect, it } from "vitest";
import juniper from "./juniper.fixture.json";
import { filterAtlas, NO_FILTERS, shapesOf, shownPlatforms } from "./model";
import { areaStart, cameraAt, playScale, playSteps, shotsOf, STEP_GAP, stepWidth, stepWords, trackOf } from "./play";
import { parseAtlas } from "./types";

const atlas = parseAtlas(juniper);
const rows = filterAtlas(atlas, NO_FILTERS);
const plats = shownPlatforms(atlas, NO_FILTERS);
const steps = playSteps(atlas, rows, plats, shapesOf(atlas));

describe("playSteps", () => {
  it("walks the areas in order, each title card before its screens, and ends", () => {
    expect(steps[0]).toMatchObject({ kind: "area", index: 1 });
    expect(steps.filter((s) => s.kind === "area").map((s) => (s.kind === "area" ? s.area.key : ""))).toEqual(["browse", "products", "checkout", "account"]);
    expect(steps.at(-1)).toMatchObject({ kind: "end", screens: 12, areas: 4 });
    const screens = steps.filter((s) => s.kind === "screen");
    expect(screens.map((s) => (s.kind === "screen" ? s.n : 0))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("leaves out what no run has seen: a never seen screen, an area with none", () => {
    const ids = steps.flatMap((s) => (s.kind === "screen" ? [s.screen.id] : []));
    expect(ids).not.toContain("screen:/checkout/done");
    expect(steps.some((s) => s.kind === "area" && s.area.key === "support")).toBe(false);
    // The reviews are only on the web: one shot.
    const reviews = steps.find((s) => s.kind === "screen" && s.screen.id === "screen:/products/*/reviews");
    expect(reviews && reviews.kind === "screen" ? reviews.shots.map((x) => x.platform) : []).toEqual(["web"]);
  });

  it("names the move from the screen before when a flow joins them, and invents none", () => {
    const search = steps.find((s) => s.kind === "screen" && s.screen.id === "screen:search");
    expect(search && search.kind === "screen" ? search.move : "x").toBe("Tap Search");
    const first = steps.find((s) => s.kind === "screen");
    expect(first && first.kind === "screen" ? first.move : "x").toBeNull();
    const products = steps.find((s) => s.kind === "screen" && s.screen.id === "screen:/products");
    // Search does not lead to the product list: no words on that arrow.
    expect(products && products.kind === "screen" ? products.move : "x").toBeNull();
  });

  it("keeps a look taken behind a sign-in off the tour, and follows the platforms picked", () => {
    const s = atlas.screens.find((x) => x.id === "screen:cart")!;
    const gated = { ...s, variants: { ...s.variants, web: { ...s.variants.web!, signin_only: true } } };
    expect(shotsOf(gated, ["ios", "android", "web"]).map((x) => x.platform)).toEqual(["ios", "android"]);
    const phones = playSteps(atlas, rows, ["ios"]);
    expect(phones.every((x) => x.kind !== "screen" || x.shots.every((sh) => sh.platform === "ios"))).toBe(true);
    expect(playSteps(atlas, [], plats)).toEqual([]);
  });
});

describe("the camera", () => {
  it("lays the steps along one track and centres the one on screen", () => {
    const scale = playScale(600, steps.flatMap((s) => (s.kind === "screen" ? s.shots : [])));
    expect(scale).toBeGreaterThan(2);
    const track = trackOf(steps, scale);
    expect(track.x[1]).toBe(track.w[0] + STEP_GAP);
    expect(track.length).toBe(track.x.at(-1)! + track.w.at(-1)!);
    const cam = cameraAt(track, 1, 1400);
    expect(track.x[1] + cam + track.w[1] / 2).toBeCloseTo(700, 0);
    expect(stepWidth(steps[0], scale)).toBe(360);
    expect(areaStart(steps, "checkout")).toBe(steps.findIndex((s) => s.kind === "area" && s.area.key === "checkout"));
  });

  it("says each step in words for a screen reader", () => {
    expect(stepWords(steps[0], 12)).toBe("Browse: 2 of 2 screens seen live.");
    const search = steps.find((s) => s.kind === "screen" && s.screen.id === "screen:search")!;
    expect(stepWords(search, 12)).toBe("Screen 2 of 12: Search, in Browse. Tap Search.");
    expect(stepWords(steps.at(-1)!, 12)).toBe("The end of the tour: 12 screens in 4 areas.");
  });
});
