/**
 * plan.ts — fetch-once module cache, and the fail-open contract (a fetch
 * error/non-OK response resolves to {plan:"team"} — a transient blip must
 * never paywall a paying Team customer; see the file-level comment in
 * plan.ts for the full rationale).
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPlan, resetPlan, usePlan } from "./plan";

function jsonResponse(data: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => data } as unknown as Response;
}

describe("fetchPlan", () => {
  afterEach(() => {
    resetPlan();
    vi.restoreAllMocks();
  });

  it("resolves the wire shape on success", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ plan: "solo", features: { members: false }, upgrade_url: "https://x/upgrade" }),
    );
    const p = await fetchPlan();
    expect(p).toEqual({ plan: "solo", features: { members: false }, upgrade_url: "https://x/upgrade" });
  });

  it("fetches exactly once per page load — a second call reuses the cached promise", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ plan: "team", features: { members: true }, upgrade_url: "https://x/upgrade" }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    await fetchPlan();
    await fetchPlan();
    await fetchPlan();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resetPlan() drops the cache so a fresh call re-fetches", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ plan: "solo", features: { members: false }, upgrade_url: "https://x/upgrade" }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    await fetchPlan();
    resetPlan();
    await fetchPlan();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fail-open: a network error resolves to {plan:'team', features:{members:true}}", async () => {
    global.fetch = vi.fn(async () => { throw new Error("network down"); });
    const p = await fetchPlan();
    expect(p.plan).toBe("team");
    expect(p.features).toEqual({ members: true });
    expect(p.upgrade_url).toBe("https://orcha.nursoftai.com/#pricing");
  });

  it("fail-open: a non-OK response (5xx) resolves to team", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ detail: "boom" }, 500));
    const p = await fetchPlan();
    expect(p.plan).toBe("team");
  });

  it("fail-open: a malformed body (bad plan value) resolves to team", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ plan: "enterprise", features: {} }));
    const p = await fetchPlan();
    expect(p.plan).toBe("team");
  });
});

describe("usePlan", () => {
  afterEach(() => {
    resetPlan();
    vi.restoreAllMocks();
  });

  it("starts null, then resolves to the fetched plan", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ plan: "solo", features: { members: false }, upgrade_url: "https://x/upgrade" }),
    );
    const { result } = renderHook(() => usePlan());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.plan).toBe("solo"));
  });
});
