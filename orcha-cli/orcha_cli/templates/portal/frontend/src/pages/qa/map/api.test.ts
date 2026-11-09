import { afterEach, describe, expect, it, vi } from "vitest";
import { getFullMap } from "./api";
import { adaptMap } from "./adapt";

afterEach(() => vi.unstubAllGlobals());

describe("getFullMap", () => {
  it("keeps each source's summary, so the header can say what was read", async () => {
    const body = { features: [], nodes: [], edges: [], last_build: null, sources: { code: { at: "2026-11-05T10:00:00Z", screens: 12 } } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })));
    const map = await getFullMap("c1", "ios");
    expect(adaptMap(map, "c1", "ios").sources.code?.screens).toBe(12);
  });
});
