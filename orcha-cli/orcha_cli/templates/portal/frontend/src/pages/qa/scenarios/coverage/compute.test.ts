import { describe, expect, it } from "vitest";
import type { QaFeature, QaNode } from "../../qaApi";
import type { Scenario } from "../adapt";
import { areaState, computeCoverage, depth, edgeKinds, headline, weakestPlatform } from "./compute";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const scenario = (over: Partial<Scenario> = {}): Scenario =>
  ({ id: "s1", name: "Sign in", category: null, persona: null, description: null, criteria: ["a", "b"], status: "validated", status_reason: null, depends_on: [], position: null, tags: [], target_kind: "ios", data: {}, needs: [], checks: { criteria: {}, scenario: [] }, source: "walk", walk_id: null, session_id: null, task_id: null, validated_by_agent_id: null, validated_at: null, created_at: null, updated_at: null, outcome: null, checked_at: null, pending: 0, ...over }) as Scenario;
const feature = (key: string, name: string): QaFeature => ({ id: key, key, name, summary: null, entry: null, paths: [], source: "code", last_explored_at: null });
const node = (key: string, feature_key: string | null, platform: QaNode["platform"] = "ios"): QaNode => ({ id: key, platform, kind: "screen", key, label: key, feature_key, state: "declared", blocked_kind: null, blocked_reason: null, sources: [], frame_id: null, last_seen_at: null });

describe("coverage from stored data", () => {
  it("names edge cases and scores depth", () => {
    expect(edgeKinds(scenario({ name: "Wrong password shows an error" }))).toEqual(["error", "invalid"]);
    expect(depth([scenario()]).score).toBe(1.2);
    expect(depth([scenario()]).happy_only).toBe(true);
    expect(depth([scenario()], { total: 2, hit: 1 })).toMatchObject({ screens: 2, screens_covered: 1 });
  });

  it("reads a recent failure as failing, a deep passing area as strong", () => {
    const fail = scenario({ outcome: "fail", checked_at: "2026-11-04T00:00:00Z" });
    expect(areaState([fail], NOW).state).toBe("failing");
    expect(areaState([], NOW).state).toBe("untested");
    const deep = scenario({ name: "Errors, offline, denied and invalid", criteria: Array(12).fill("x"), outcome: "pass", checked_at: "2026-11-04T00:00:00Z" });
    expect(areaState([deep, { ...deep, id: "s2" }, { ...deep, id: "s3" }], NOW).state).toBe("strong");
  });

  it("links by category, tag and walked screen, and leaves a draft out of the state", () => {
    const report = computeCoverage({
      now: NOW,
      features: [feature("auth", "Sign in"), feature("pay", "Payments"), feature("home", "Home")],
      nodes: [node("LoginView", "auth"), node("PayView", "pay"), node("HomeView", "home"), node("Stray", null)],
      scenarios: [
        scenario({ id: "s1", category: "Sign in" }),
        scenario({ id: "s2", tags: ["screen:PayView"], outcome: "fail", checked_at: "2026-11-05T11:00:00Z" }),
        scenario({ id: "s3", status: "draft", category: "Home" }),
      ],
      screens: [{ id: "screen:ios:PayView", scenarios: [{ id: "s2", origin: "drafted" }] }, { id: "screen:ios:LoginView", scenarios: [] }],
    });
    const by = new Map(report.areas.map((a) => [a.key, a]));
    expect(by.get("auth")).toMatchObject({ state: "thin", linked: 1, map: { screens: 1, covered: 0, uncovered: ["LoginView"] } });
    expect(by.get("pay")).toMatchObject({ state: "failing", recent: true, last: { ios: { outcome: "fail" } } });
    expect(by.get("home")).toMatchObject({ state: "untested", drafts: 1 });
    expect(report.headline).toBe("2 of 3 areas tested. 1 never tested. 1 failing.");
    expect(report.unmapped_screens).toEqual([{ label: "Stray", visits: 0 }]);
    expect(report.rollup.ios).toMatchObject({ covered: 2, total: 3, ran: 1 });
  });

  it("words the headline and names a weakest platform only for a real gap", () => {
    expect(headline(0, 0, 0, 0, null)).toBe("No feature areas mapped yet.");
    const r = (covered: number) => ({ covered, total: 9, failing: 0, passing: 0, ran: 0, share: 0 });
    expect(weakestPlatform({ ios: r(6), android: r(1) })).toBe("android");
    expect(weakestPlatform({ ios: r(2), android: r(1) })).toBeNull();
    expect(weakestPlatform({ ios: r(2) })).toBeNull();
  });
});
