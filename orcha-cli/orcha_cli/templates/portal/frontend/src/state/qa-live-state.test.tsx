/**
 * V2 QA (findings 7/8/9) — live-state regressions beyond qa-authority.test.tsx:
 *  - a hung poll request never piles up a second one per tick;
 *  - a hung snapshot GET is aborted after SNAPSHOT_TIMEOUT_MS and surfaces as an error;
 *  - a stale FAILURE that lands after a newer success never hides the newer data;
 *  - /api/me trust is scoped to the cid it answered for;
 *  - a viewer member is read-only end to end through the provider.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensions, type Identity } from "../extensions";
import { fetchMe, lastTrusted, resetIdentity } from "../cloud/identity";
import {
  SNAPSHOT_TIMEOUT_MS,
  SnapshotProvider,
  _setActingAuth,
  _setActingIdentity,
  actingHuman,
  useActingAuthority,
  useSnapshot,
} from "./SnapshotProvider";
import { useAttention } from "./attention";

const raw = (name: string) => ({
  container: { id: "c1", name, status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "owner", kind: "human", status: "idle" },
    { id: "h2", alias: "viewer", kind: "human", status: "idle" },
  ],
  tasks: [{ id: "t1", title: "Verify", status: "needs_verification", assignees: [] }],
  requests: [{ id: "r1", type: "info", status: "open", requester_id: "a1", target_id: null, payload: "q" }],
});
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const containers = () => Promise.resolve(ok([{ id: "c1", status: "active" }]));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete extensions.identity;
  delete extensions.identityTrusted;
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
  resetIdentity();
});
beforeEach(() => localStorage.clear());

function Probe({ out }: { out: string[] }) {
  const { snap, error } = useSnapshot();
  out.push(`${snap?.container?.name ?? "null"}|${error ?? "ok"}`);
  return null;
}

describe("SnapshotProvider poll hygiene", () => {
  it("a hung poll request is not joined by another one every tick", async () => {
    let snapshotCalls = 0;
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/containers") return containers();
      if (String(input).startsWith("/api/containers/")) snapshotCalls++;
      return new Promise<Response>(() => {}); // never answers
    }) as unknown as typeof fetch;
    render(<SnapshotProvider pollMs={20}><Probe out={[]} /></SnapshotProvider>);
    await waitFor(() => expect(snapshotCalls).toBe(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); }); // ~10 ticks
    expect(snapshotCalls).toBe(1);
  });

  it("a hung snapshot GET is aborted after SNAPSHOT_TIMEOUT_MS and reported", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let signal: AbortSignal | undefined;
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/containers") return containers();
      const sig = init?.signal ?? undefined;
      if (String(input).startsWith("/api/containers/")) signal = sig; // the snapshot GET (not /api/me)
      return new Promise<Response>((_res, rej) => {
        sig?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    render(<SnapshotProvider pollMs={60_000}><Probe out={out} /></SnapshotProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS + 10); });
    expect(signal!.aborted).toBe(true);
    expect(out[out.length - 1]).toBe("null|request timed out");
  });

  it("an older FAILURE landing after a newer success does not overwrite it", async () => {
    const pending: Array<{ res: (r: Response) => void; rej: (e: Error) => void }> = [];
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/containers") return containers();
      return new Promise<Response>((res, rej) => { pending.push({ res, rej }); });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    let refresh: (() => Promise<void>) | null = null;
    function Grab() { refresh = useSnapshot().refresh; return null; }
    render(<SnapshotProvider pollMs={60_000}><Grab /><Probe out={out} /></SnapshotProvider>);
    await waitFor(() => expect(pending.length).toBe(1));
    let p2: Promise<void> | null = null;
    act(() => { p2 = refresh!(); });
    await waitFor(() => expect(pending.length).toBe(2));
    await act(async () => { pending[1].res(ok(raw("NEW"))); await p2; });
    await waitFor(() => expect(out[out.length - 1]).toBe("NEW|ok"));
    await act(async () => { pending[0].rej(new Error("boom")); await new Promise((r) => setTimeout(r, 10)); });
    expect(out[out.length - 1]).toBe("NEW|ok");
    expect(out.some((l) => l.includes("boom"))).toBe(false);
  });
});

describe("identity trust is scoped to its cid", () => {
  it("a late /api/me for a previous cid does not set trust for the current one", async () => {
    const answers: Record<string, (b: unknown) => void> = {};
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const cid = new URL(String(input), "http://x").searchParams.get("cid")!;
      return new Promise<Response>((res) => { answers[cid] = (b) => res(ok(b)); });
    }) as unknown as typeof fetch;
    const pA = fetchMe("A");
    const pB = fetchMe("B"); // project switched while A is in flight
    answers.B({ identity: null, trusted: false });
    await pB;
    answers.A({ identity: { agent_id: "h1", member_role: "owner" }, trusted: true });
    await pA;
    expect(lastTrusted("B")).toBe(false);
    expect(lastTrusted("A")).toBe(false); // A is no longer the last answered cid
  });
  it("the current cid's trust is reported", async () => {
    global.fetch = vi.fn(async () => ok({ identity: null, trusted: true })) as unknown as typeof fetch;
    await fetchMe("C");
    expect(lastTrusted("C")).toBe(true);
    expect(lastTrusted("D")).toBe(false);
  });
});

describe("viewer role through the provider (finding 9)", () => {
  it("a viewer member resolves to no actor, a reason, and a zero Needs-you count", async () => {
    extensions.identity = async () => ({ agent_id: "h2", member_role: "viewer" }) as Identity;
    extensions.identityTrusted = () => true;
    global.fetch = vi.fn((input: RequestInfo | URL) =>
      String(input) === "/api/containers" ? containers() : Promise.resolve(ok(raw("P"))),
    ) as unknown as typeof fetch;
    const out: string[] = [];
    let last: ReturnType<typeof useSnapshot>["snap"] = null;
    function V() {
      const { snap } = useSnapshot();
      last = snap;
      const a = useActingAuthority();
      const at = useAttention();
      out.push(`${snap ? "snap" : "null"}|${a.human?.alias ?? "none"}|${a.readOnly}|${at.count}|${a.reason ?? ""}`);
      return null;
    }
    render(<SnapshotProvider pollMs={60_000}><V /></SnapshotProvider>);
    await waitFor(() => expect(out[out.length - 1]).toBe("snap|none|true|0|Your role is viewer (read-only)"));
    // legacy module-level callers (pages using actingHuman(snap)) agree
    expect(last).not.toBeNull();
    expect(actingHuman(last)).toBeNull();
    expect(out.some((l) => /\|owner\||\|viewer\|/.test(l))).toBe(false); // never shown acting as anyone
  });
});
