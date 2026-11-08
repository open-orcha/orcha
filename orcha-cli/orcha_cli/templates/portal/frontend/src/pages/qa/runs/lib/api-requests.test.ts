import { describe, expect, it } from "vitest";
import {
  checkText,
  countByKind,
  filterRequests,
  groupChecks,
  pathOf,
  prettyBody,
  statusLabel,
  statusTone,
  toApiRequestRow,
  toRequestCheckRow,
  type ApiRequestRow,
} from "./api-requests";

function row(over: Partial<ApiRequestRow>): ApiRequestRow {
  return {
    seq: 1,
    at_ms: 0,
    scenario: null,
    scenario_id: null,
    method: "GET",
    url: "https://api.shop.test/api/items",
    status: 200,
    failed: false,
    request_body: null,
    ...over,
  };
}

const ROWS = [
  row({ seq: 1 }),
  row({ seq: 2, method: "POST", url: "https://api.shop.test/api/checkout?x=1", status: 500 }),
  row({ seq: 3, url: "https://api.shop.test/api/feed", status: null, failed: true }),
  row({ seq: 4, kind: "document", url: "https://api.shop.test/api/me", status: 401 }),
];

describe("api requests", () => {
  it("normalises DB rows (SQLite 0/1, numeric strings, nulls)", () => {
    expect(toApiRequestRow({ seq: "3", at_ms: "120", status: null, failed: 1, method: "GET", url: "u" })).toMatchObject({
      seq: 3,
      at_ms: 120,
      status: null,
      failed: true,
        scenario: null,
    });
    expect(toRequestCheckRow({ seq: 1, ok: 0, text: "✗ x" })).toEqual({ seq: 1, scenario: null, scenario_id: null, ok: false, text: "✗ x" });
    expect(toRequestCheckRow({ seq: 2, ok: true, text: null }).ok).toBe(true);
  });

  it("filters by kind and path", () => {
    expect(filterRequests(ROWS, "all", "").map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(filterRequests(ROWS, "fetch", "").map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(filterRequests(ROWS, "document", "").map((r) => r.seq)).toEqual([4]);
    expect(filterRequests(ROWS, "failed", "").map((r) => r.seq)).toEqual([2, 3, 4]);
    expect(filterRequests(ROWS, "all", "CHECK").map((r) => r.seq)).toEqual([2]);
    expect(filterRequests(ROWS, "all", "post").map((r) => r.seq)).toEqual([2]);
    expect(filterRequests(ROWS, "document", "checkout")).toEqual([]);
    expect(countByKind(ROWS)).toEqual({ all: 4, fetch: 3, document: 1, failed: 3 });
  });

  it("tones and labels statuses", () => {
    expect([200, 304, 404, 503].map((status) => statusTone({ status, failed: false }))).toEqual(["ok", "redirect", "client", "server"]);
    expect(statusTone({ status: null, failed: true })).toBe("failed");
    expect(statusTone({ status: null, failed: false })).toBe("pending");
    expect(statusLabel({ status: null, failed: true })).toBe("failed");
    expect(statusLabel({ status: null, failed: false })).toBe("–");
    expect(statusLabel({ status: 201, failed: false })).toBe("201");
  });

  it("paths, bodies and check text", () => {
    expect(pathOf("https://a.test/api/x?page=2")).toBe("/api/x?page=2");
    expect(pathOf("not a url")).toBe("not a url");
    expect(pathOf(null)).toBe("");
    expect(prettyBody('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true });
    expect(prettyBody("a=1&b=2")).toEqual({ text: "a=1&b=2", json: false });
    expect(prettyBody(null)).toEqual({ text: "", json: false });
    expect(checkText("✓ POST /api/x: sent 1x")).toBe("POST /api/x: sent 1x");
  });

  it("groups checks by scenario in report order", () => {
    const groups = groupChecks([
      { seq: 3, scenario: "Browse", scenario_id: null, ok: true, text: "✓ c" },
      { seq: 1, scenario: "Pay", scenario_id: "sc-1", ok: true, text: "✓ a" },
      { seq: 2, scenario: "Pay", scenario_id: "sc-1", ok: false, text: "✗ b" },
    ]);
    expect(groups.map((g) => [g.scenario, g.checks.map((c) => c.seq), g.failed])).toEqual([
      ["Pay", [1, 2], 1],
      ["Browse", [3], 0],
    ]);
  });

});
