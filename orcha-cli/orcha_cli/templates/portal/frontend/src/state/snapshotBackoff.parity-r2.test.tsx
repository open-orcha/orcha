/**
 * Parity round 2 (e2e-scope-live extra): an ANSWERED 4xx snapshot (403 not a
 * member / 404 unknown project) must not keep the 3 s poll + 3 s EventSource
 * reconnect hammering the cid. The provider backs off to ANSWERED_BACKOFF_MS;
 * a 5xx/network outage keeps the fast cadence; an explicit refresh() still
 * runs immediately so an invite accepted later recovers.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANSWERED_BACKOFF_MS, SnapshotProvider, _setActingAuth, _setActingIdentity, useSnapshot } from "./SnapshotProvider";

let esCount = 0;
class FakeES {
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor() {
    esCount++;
    // the backend refuses the stream the same way it refused the snapshot
    setTimeout(() => this.onerror?.(), 10);
  }
  close() {}
}

let refreshFn: (() => Promise<void>) | null = null;
function Probe() {
  refreshFn = useSnapshot().refresh;
  return null;
}

function stub(status: number) {
  window.history.replaceState(null, "", "/tasks?cid=c1");
  const f = vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/containers/c1")) {
      return { ok: false, status, json: async () => ({ detail: "nope" }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ([]) } as unknown as Response;
  });
  vi.stubGlobal("fetch", f);
  vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
  return () => f.mock.calls.filter((c) => /^\/api\/containers\/c1(\?|$)/.test(String(c[0]))).length;
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
  esCount = 0;
});

describe("SnapshotProvider backs off after an answered 4xx", () => {
  for (const status of [403, 404]) {
    it(`${status}: no 3 s poll / stream reconnect storm`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      const snapCalls = stub(status);
      render(<SnapshotProvider pollMs={3000}><Probe /></SnapshotProvider>);
      await tick(12_000);
      expect(snapCalls()).toBe(1); // the first ask only (it was 5 before)
      expect(esCount).toBe(1); // no 3 s reconnects
      await tick(ANSWERED_BACKOFF_MS);
      expect(snapCalls()).toBe(2); // still re-checks, slowly
      expect(esCount).toBe(2);
      // an explicit refresh (Retry / after accepting an invite) is not throttled
      await act(async () => { await refreshFn!(); });
      expect(snapCalls()).toBe(3);
    });
  }

  it("5xx outage keeps the fast cadence", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const snapCalls = stub(503);
    render(<SnapshotProvider pollMs={3000}><Probe /></SnapshotProvider>);
    await tick(12_000);
    expect(snapCalls()).toBeGreaterThanOrEqual(4);
    expect(esCount).toBeGreaterThanOrEqual(3);
  });
});
