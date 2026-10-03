/** Backend request 3: without proxy login, each project's `needs_you` is scoped to
 *  the acting-human pick, sent as `?acting=<cid>:<human id>,…`. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetProjectsForTests, actingQuery, refreshProjects } from "./projects";

beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("project list acting picks", () => {
  it("no picks → the bare list URL", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ containers: [] }) }) as unknown as Response);
    global.fetch = f as unknown as typeof fetch;
    expect(actingQuery()).toBe("");
    await refreshProjects();
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("/api/containers");
  });
  it("each project's saved acting human rides along; junk keys are skipped", async () => {
    localStorage.setItem("orcha:actingHuman:c2", "h9");
    localStorage.setItem("orcha:actingHuman:c1", "h1");
    localStorage.setItem("orcha:actingHuman:_", "h0");
    localStorage.setItem("orcha:actingHuman:c3", "bad id;");
    expect(actingQuery()).toBe("?acting=" + encodeURIComponent("c1:h1,c2:h9"));
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ containers: [] }) }) as unknown as Response);
    global.fetch = f as unknown as typeof fetch;
    await refreshProjects();
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("/api/containers?acting=c1%3Ah1%2Cc2%3Ah9");
  });
});
