/** Map the app, live: the change feed applied to the map, the screens a crawl reveals, and what
 * the live chip says. */
import { describe, expect, it } from "vitest";
import { RENTALS_MAP_JSON } from "./fixture";
import { applyMapChanges, revealedScreens, screensSeenIn, timeLeft, type MapChange } from "./live-reveal";
import { blockedText, parseAppMap, type AppMap } from "./types";
import { whyNotSeen } from "./model";

type RawNode = Record<string, unknown> & { key: string; evidence?: object };

/** The rentals map with a row id on every node (`row-<key>`), as the builder prints it now. */
function rentals(patch: (nodes: RawNode[]) => RawNode[] = (n) => n): AppMap {
  const nodes: RawNode[] = (RENTALS_MAP_JSON.nodes as RawNode[]).map((n) => ({ ...n, row_id: `row-${n.key}` }));
  return parseAppMap({ ...RENTALS_MAP_JSON, nodes: patch(nodes) });
}

const seenBy = (runId: string, at: string) => ({ code: [], tests: [], live: { runs: 1, last_run_id: runId, last_seen_at: at } });

/** The crawl reaches Map search, then Profile (newer), and a screen the code never declared. */
function afterCrawl(): AppMap {
  return rentals((nodes) => [
    ...nodes.map((n) => {
      if (n.key === "map-search") return { ...n, state: "seen", evidence: seenBy("run-crawl", "2026-10-21T09:04:10Z") };
      if (n.key === "profile") return { ...n, state: "seen", evidence: seenBy("run-crawl", "2026-10-21T09:05:30Z") };
      return n;
    }),
    {
      ...nodes[0],
      id: "screen:filters",
      row_id: "row-filters",
      key: "filters",
      label: "Filters",
      state: "seen",
      evidence: seenBy("run-crawl", "2026-10-21T09:04:50Z"),
    },
  ]);
}

const change = (table: string, op: MapChange["op"], row_id: string): MapChange => ({ table, op, row_id });

describe("applyMapChanges", () => {
  it("shows the fresh map and reveals the screens newly seen or new, the latest seen as newest", () => {
    const prev = rentals();
    const next = afterCrawl();
    const r = applyMapChanges(prev, [change("app_map_nodes", "UPDATE", "row-map-search"), change("app_map_nodes", "INSERT", "row-filters")], next);
    expect(r.map).toBe(next);
    expect(r.revealed).toEqual(["screen:map-search", "screen:profile", "screen:filters"]);
    expect(r.newest).toBe("screen:profile");
  });

  it("reveals nothing for a screen that was already seen or is still declared", () => {
    const prev = afterCrawl();
    const r = applyMapChanges(prev, [change("app_map_edges", "INSERT", "e99")], afterCrawl());
    expect(r.revealed).toEqual([]);
    expect(r.newest).toBeNull();
    expect(revealedScreens(rentals(), rentals())).toEqual([]);
  });

  it("applies the deletes it can without a fresh map, and the edges that touched them go too", () => {
    const prev = rentals();
    const r = applyMapChanges(prev, [change("app_map_nodes", "DELETE", "row-inbox"), change("app_map_edges", "DELETE", prev.edges[0].id)], null);
    expect(r.map.nodes.some((n) => n.id === "screen:inbox")).toBe(false);
    expect(r.map.edges.some((e) => e.from === "screen:inbox" || e.to === "screen:inbox")).toBe(false);
    expect(r.map.edges.some((e) => e.id === prev.edges[0].id)).toBe(false);
    expect(r.map.edges).toHaveLength(prev.edges.length - 3);
    expect(r.revealed).toEqual([]);
    // Nothing to drop: the same map back.
    expect(applyMapChanges(prev, [change("app_map_nodes", "UPDATE", "row-listings")], null).map).toBe(prev);
  });
});

describe("the live chip", () => {
  it("counts the screens the crawl's run saw", () => {
    expect(screensSeenIn(afterCrawl(), "run-crawl")).toBe(3);
    expect(screensSeenIn(afterCrawl(), null)).toBe(0);
  });

  it("counts the time left down to zero, and has none before the clock starts", () => {
    const start = "2026-10-21T09:00:00Z";
    expect(timeLeft(20, start, Date.parse("2026-10-21T09:13:48Z"))).toBe("6:12");
    expect(timeLeft(10, start, Date.parse("2026-10-21T09:30:00Z"))).toBe("0:00");
    expect(timeLeft(20, null, Date.now())).toBeNull();
  });

});

describe("a blocked screen's kind", () => {
  it("reads the crawl's dead end and says its kind with the reason", () => {
    const map = rentals((nodes) =>
      nodes.map((n) =>
        n.key === "inbox"
          ? { ...n, blocked_reason: "No conversation with an agent exists yet", evidence: { ...n.evidence, crawl: { reason: "No conversation with an agent exists yet", kind: "needs_data", run_id: "run-crawl", at: "2026-10-21T09:06:00Z" } } }
          : n,
      ),
    );
    const inbox = map.nodes.find((n) => n.id === "screen:inbox")!;
    expect(inbox.row_id).toBe("row-inbox");
    expect(inbox.evidence.crawl).toEqual({ reason: "No conversation with an agent exists yet", kind: "needs_data", run_id: "run-crawl", at: "2026-10-21T09:06:00Z" });
    expect(blockedText(inbox)).toBe("Needs data: No conversation with an agent exists yet");
    expect(whyNotSeen(inbox)).toBe("Needs data: No conversation with an agent exists yet");
    // A reason that already says it, no kind, or `other`: the reason alone.
    expect(blockedText({ ...inbox, blocked_reason: "Needs data to exist", evidence: { ...inbox.evidence, crawl: { ...inbox.evidence.crawl!, reason: null } } })).toBe("Needs data to exist");
    expect(blockedText({ ...inbox, evidence: { ...inbox.evidence, crawl: { ...inbox.evidence.crawl!, kind: "other" } } })).toBe("No conversation with an agent exists yet");
    expect(blockedText({ ...inbox, blocked_reason: null, evidence: { ...inbox.evidence, crawl: { reason: null, kind: "paywall", run_id: null, at: null } } })).toBe("Behind a paywall");
    expect(rentals().nodes.find((n) => n.id === "screen:inbox")?.evidence.crawl).toBeNull();
  });
});
