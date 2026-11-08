// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { areaFocus, DraftTestsAction, draftDecision, exploreKind, type DraftArea } from "./draft-action";
import { withPage } from "./test-wrap";
import type { AppMap, AppMapNode, NodeState } from "./types";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const run = () => {};
const DAY = 86_400_000;

function node(id: string, state: NodeState, seenDaysAgo: number | null, over: Partial<AppMapNode> = {}): AppMapNode {
  return {
    id,
    row_id: null,
    kind: "screen",
    key: id,
    label: id,
    feature: "listings",
    state,
    blocked_reason: null,
    frame_url: null,
    evidence: {
      code: [],
      tests: [],
      live: seenDaysAgo == null ? null : { runs: 1, last_run_id: "r", last_seen_at: new Date(NOW - seenDaysAgo * DAY).toISOString() },
      crawl: null,
    },
    detail: {
      route: `/${id}`,
      platform: "web",
      anchors: [],
      actions: [],
      method: null,
      pattern: null,
      side: null,
      statuses: [],
      body_keys: [],
      handler: null,
      store: null,
      fields: [],
      framework: null,
      skipped: false,
      skip_reason: null,
      unlinked: null,
    },
    ...over,
  };
}

function mapOf(nodes: AppMapNode[]): Pick<AppMap, "project_id" | "features" | "nodes"> {
  return { project_id: "p1", features: [{ key: "listings", name: "Listings", summary: null, screens: nodes.length, seen: 0, coverage: "untested" }], nodes };
}


afterEach(cleanup);

describe("draftDecision", () => {
  it("only explores and drafts where nothing has reached the area", () => {
    expect(draftDecision([node("a", "declared", null), node("b", "blocked", null)], NOW)).toEqual({ exploreOnly: true, primary: "explore" });
    // Seen once, but no run's evidence of it: nothing on a device backs it.
    expect(draftDecision([node("a", "seen", null)], NOW)).toEqual({ exploreOnly: true, primary: "explore" });
    expect(draftDecision([], NOW)).toEqual({ exploreOnly: true, primary: "explore" });
  });

  it("offers both once explored, exploring again first when the newest evidence is over 7 days old", () => {
    expect(draftDecision([node("a", "seen", 2), node("b", "declared", null)], NOW)).toEqual({ exploreOnly: false, primary: "draft" });
    expect(draftDecision([node("a", "seen", 9)], NOW)).toEqual({ exploreOnly: false, primary: "explore" });
    expect(draftDecision([node("a", "seen", 9), node("b", "seen", 1)], NOW)).toEqual({ exploreOnly: false, primary: "draft" });
  });
});

describe("DraftTestsAction", () => {
  function labels(area: DraftArea, nodes: AppMapNode[], draftLabel?: string) {
    render(withPage(createElement(DraftTestsAction, { map: mapOf(nodes), area, now: NOW, draftLabel }), { run }));
    return [...document.querySelectorAll("[data-map-draft-action] button")].map((a) => a.textContent?.trim());
  }

  it("says Explore and draft alone where nothing was reached", () => {
    const n = node("screen:x", "declared", null);
    expect(labels({ kind: "node", node: n }, [n])).toEqual(["Explore and draft"]);
  });

  it("offers both where it was explored, the recent drafting first", () => {
    const n = node("screen:x", "seen", 1);
    expect(labels({ kind: "node", node: n }, [n])).toEqual(["Draft from what we've seen", "Explore and draft"]);
  });

  it("puts Explore and draft first where the last exploration is stale", () => {
    expect(labels({ kind: "gaps" }, [node("a", "seen", 20)], "Draft the gaps")).toEqual(["Explore and draft", "Draft the gaps"]);
  });
});

describe("what an area's session is told", () => {
  const screen = (id: string, state: string) => ({ id, kind: "screen", state, label: id, detail: {}, evidence: {} }) as never;

  it("names the screen by its route, the feature by its name", () => {
    expect(areaFocus({ features: [] }, { kind: "node", node: { label: "Cart", detail: { route: "/cart" } } as never })).toBe("/cart");
    expect(areaFocus({ features: [{ key: "orders", name: "Orders" }] as never }, { kind: "feature", key: "orders" })).toBe("Orders");
    expect(areaFocus({ features: [] }, { kind: "gaps" })).toBeNull();
  });

  it("crawls the whole app while most of the map is unseen", () => {
    expect(exploreKind({ nodes: [screen("a", "declared"), screen("b", "declared"), screen("c", "seen")] }, { kind: "gaps" })).toBe("map");
    expect(exploreKind({ nodes: [screen("a", "seen"), screen("b", "seen"), screen("c", "declared")] }, { kind: "gaps" })).toBe("explore");
    expect(exploreKind({ nodes: [] }, { kind: "feature", key: "x" })).toBe("explore");
  });
});
