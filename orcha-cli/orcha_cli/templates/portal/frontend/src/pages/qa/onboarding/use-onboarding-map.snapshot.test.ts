/** A poll leaves the map out while its version stands: what the page holds fills the gap. */
import { describe, expect, it } from "vitest";
import { foldSnapshot, getOnboardingRow, onboardingUrl, type OnboardingRow } from "./use-onboarding-map";

const full = { state: "running", snapshot_version: "v1", screens: [{ id: "a" }, { id: "b" }], edges: [], files: [], gaps: [{ screen_id: "a" }], summary: { screens: 2 } } as OnboardingRow;

describe("foldSnapshot", () => {
  it("holds the map part of a full read", () => {
    const { row, held } = foldSnapshot(null, full);
    expect(row).toBe(full);
    expect(held?.version).toBe("v1");
    expect(held?.part.screens).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("fills a poll from what it holds, and the poll's own state stands", () => {
    const { held } = foldSnapshot(null, full);
    const { row } = foldSnapshot(held, { state: "done", snapshot_version: "v1", snapshot_unchanged: true } as OnboardingRow);
    expect(row.state).toBe("done");
    expect((row as unknown as { screens: unknown[] }).screens).toHaveLength(2);
    expect((row as unknown as { gaps: unknown[] }).gaps).toEqual([{ screen_id: "a" }]);
  });

  it("puts the first run on its screen and leaves what it holds alone", () => {
    const { held } = foldSnapshot(null, full);
    const { row, held: after } = foldSnapshot(held, { snapshot_version: "v1", snapshot_unchanged: true, first_run_screen: { screen_id: "b", first_run: { status: "running" } } } as OnboardingRow);
    expect((row as unknown as { screens: { first_run?: unknown }[] }).screens[1].first_run).toEqual({ status: "running" });
    expect((after?.part.screens as { first_run?: unknown }[])[1].first_run).toBeUndefined();
  });

  it("a new version replaces what it holds", () => {
    const { held } = foldSnapshot(null, full);
    const next = foldSnapshot(held, { ...full, snapshot_version: "v2", screens: [{ id: "c" }] } as OnboardingRow);
    expect(next.held?.version).toBe("v2");
    expect(next.held?.part.screens).toEqual([{ id: "c" }]);
  });
});

describe("the row alone", () => {
  it("asks for the row, not the map", () => {
    expect(onboardingUrl("c1")).toBe("/api/containers/c1/qa/onboarding");
    expect(String(getOnboardingRow)).toContain("fields=row");
  });
});
