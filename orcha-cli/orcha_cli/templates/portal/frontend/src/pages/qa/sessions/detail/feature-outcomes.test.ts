// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { FeatureOutcome } from "../explorations";
import { featureOutcomeCount, featureOutcomeDetail, featureOutcomeTitle, FeatureOutcomes } from "./feature-outcomes";

afterEach(cleanup);

const FEATURES: FeatureOutcome[] = [
  { key: "feed", name: "Feed", outcome: "explored", checked: ["Post an empty caption", "Post a long caption"], left: [], findings: 2, worst: "major" },
  { key: "profile", name: "Profile", outcome: "partly", checked: ["Change the display name"], left: ["Upload a big avatar"], findings: 0, note: "No upload button" },
  { key: "search", name: "Search", outcome: "not_reached", checked: [], left: [], findings: 0 },
];

describe("FeatureOutcomes", () => {
  it("reports each target feature on its own, in the order picked, honestly", () => {
    render(createElement(FeatureOutcomes, { features: FEATURES }));
    const cards = [...document.querySelectorAll("[data-feature-outcome]")];
    expect(cards.map((c) => [c.getAttribute("data-feature"), c.getAttribute("data-feature-outcome")])).toEqual([
      ["feed", "explored"],
      ["profile", "partly"],
      ["search", "not_reached"],
    ]);
    expect(cards[0].textContent).toContain("Checked: Post an empty caption, Post a long caption");
    expect(cards[0].textContent).toContain("2 issues");
    expect(cards[1].textContent).toContain("Partly explored");
    expect(cards[1].textContent).toContain("Left: Upload a big avatar");
    expect(cards[1].textContent).toContain("No upload button");
    expect(cards[2].textContent).toContain("Not reached");
    expect(cards[2].textContent).toContain("No mission or finding of this run names it.");
    expect(featureOutcomeCount(FEATURES)).toBe("1 of 3 explored");
  });

  it("says what it produced without contradicting itself: one feature by name and how far, more by count", () => {
    expect(featureOutcomeTitle([FEATURES[1]])).toBe("Profile, partly explored");
    expect(featureOutcomeDetail([FEATURES[1]])).toBe("1 thing checked there");
    expect(featureOutcomeTitle([FEATURES[2]])).toBe("Search, not reached");
    expect(featureOutcomeDetail([FEATURES[2]])).toBe("Nothing checked there");
    expect(featureOutcomeTitle(FEATURES)).toBe("3 features");
    expect(featureOutcomeDetail(FEATURES)).toBe("1 explored · 1 partly explored · 1 not reached");
  });

  it("counts the flows walked in a feature, with their outcomes, and the ones still queued", () => {
    const entry: FeatureOutcome = {
      key: "entry-manual-log",
      name: "Add entry / manual log",
      outcome: "partly",
      checked: [],
      left: [],
      findings: 2,
      worst: "minor",
      walked: [
        { name: "Log a nap with a quick duration", status: "passed" },
        { name: "Edit a saved feeding and see the change", status: "failed" },
        { name: "Add manual entry", status: "failed" },
      ],
      flows_left: 25,
    };
    expect(featureOutcomeTitle([entry])).toBe("Add entry / manual log, partly explored");
    expect(featureOutcomeDetail([entry])).toBe("3 flows walked there: 1 passed, 2 failed");
    render(createElement(FeatureOutcomes, { features: [entry] }));
    const card = document.querySelector("[data-feature='entry-manual-log']")!;
    expect(card.querySelector("[data-feature-walked]")?.textContent).toContain("Edit a saved feeding and see the change");
    expect(card.textContent).toContain("25 more flows still queued for the next run.");
    expect(card.textContent).toContain("2 issues");
    expect(card.textContent).not.toContain("No mission or finding of this run names it.");
  });
});
