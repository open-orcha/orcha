import { describe, expect, it } from "vitest";
import { coverageSteps } from "./coverage-states";
import { fogStyle, paintFog } from "../../map/fog-paint";

describe("coverage steps", () => {
  it("names the work without numbers on the first load", () => {
    expect(coverageSteps().map((s) => s.label)).toEqual([
      "Reading scenarios",
      "Reading runs and explorations",
      "Matching scenarios to feature areas",
      "Mapping areas",
    ]);
  });

  it("uses the last report's real counts on Recompute", () => {
    expect(coverageSteps({ scenarios: 37, links: 134, areas: 31 }).map((s) => s.label)).toEqual([
      "Reading 37 scenarios",
      "Reading runs and explorations",
      "Matching 134 links to feature areas",
      "Mapping 31 areas",
    ]);
    expect(coverageSteps({ scenarios: 1, links: 1, areas: 1 })[0].label).toBe("Reading 1 scenario");
  });
});

describe("painted fog", () => {
  it("keeps the theme's haze and cloud strengths", () => {
    expect(fogStyle(false, "#b9bdc8", false)).toEqual({ color: "#b9bdc8", haze: 0.45, banks: 1, blur: 11 });
    expect(fogStyle(true, "#6f7a93", true)).toEqual({ color: "#6f7a93", haze: 0.26, banks: 0.8, blur: 7 });
  });

  it("paints nothing without a size", async () => {
    expect(await paintFog([{ x: 0, y: 0, w: 10, h: 10, fog: 1 }], 0, 100, fogStyle(false, "#000", false))).toBeNull();
  });
});
